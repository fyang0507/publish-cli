import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadWatchConfig, type TriageConfig, type WatchConfig } from "../config.js";
import { filterByLanguage, parseAllowedLanguages } from "../langFilter.js";
import type { XPost } from "../x/reader.js";
import { collapseThreads } from "../x/thread.js";
import { triagePosts, type TriagedPost } from "../x/triage.js";

/**
 * `publish x watch` — borrowed-reach watch loop for the X channel.
 *
 * Flow:
 *   1. Load + validate watch.yaml (loadWatchConfig(--config)) and merge in
 *      repeatable --query / --x-list flags (flags ADD to config).
 *   2. A BrowserReader reads THROUGH the logged-in browser (capturing X's own
 *      GraphQL responses) — fetchSearch(query) per query and fetchListTimeline(id)
 *      per List, up to per_origin_limit. A List reads all its members in ONE fetch,
 *      so it's the scale path for the account side; there is no per-account origin
 *      (N profile loads don't scale and read as bot traffic — build a List with
 *      `publish x create-watch-list`). A login (headful with --inspect) happens
 *      only if the persisted profile isn't authed.
 *   3. Dedupe against the SeenStore (src/db.ts); only NEW post ids proceed.
 *   4. Triage each new post with the cheap Gemini model (config.TRIAGE_MODEL /
 *      watch.yaml triage_model, minimal thinking) -> {postId, score, reason,
 *      suggestedAngle}. The free-text persona/rubric comes from watch.yaml but the
 *      CALLING agent owns it — supply per-run with --persona, or skip triage
 *      entirely with --no-triage to judge the raw candidates itself.
 *   5. Emit ranked candidates: human text by default, machine JSON with --json.
 *      Mark surfaced posts as seen.
 */
export function registerWatchCommand(x: Command): void {
  x
    .command("watch")
    .description("Watch X: poll queries/lists, dedupe, triage, rank candidates")
    .option("--query <q...>", "Search query to monitor (repeatable; merges with watch.yaml)")
    .option("--x-list <id...>", "X List id to monitor (repeatable; merges with watch.yaml). One fetch covers all its members.")
    .option("--config <path>", "Path to watch.yaml (defaults to ./watch.yaml)")
    // Language allow-list (issue #28): drop wrong-audience posts BEFORE triage so
    // they don't burn classifier/drafting tokens. Overrides watch.yaml
    // allowed_languages for this run; `--languages all` disables a configured filter.
    .option(
      "--languages <codes>",
      "Restrict candidates to these languages (comma-separated, e.g. en,zh). Overrides watch.yaml allowed_languages; use 'all' to disable filtering.",
    )
    // Triage ownership (issue #6): the calling agent supplies the reply-worthiness
    // RUBRIC per run as FREE TEXT. It can't live as a committed default in this
    // public repo, so --persona is a caller-supplied input, not an override of a
    // value the repo ships. The scoring baseline (fit/timeliness/unique_value, each
    // DEFINED in the prompt) is fixed; nuance goes in the persona prose, where the
    // caller can define its own criteria unambiguously. Durable infra (model,
    // min_score, batch_size) lives in config.
    .option("--persona <text>", "Triage rubric for this run: who is replying / what's worth a reply (falls back to watch.yaml)")
    // Long self-contained rubrics (issue #15) don't survive shell quoting; load
    // from a file instead (issue #17). Mutually exclusive with --persona.
    .option("--persona-from <path>", "Load the triage rubric from a file (mutually exclusive with --persona)")
    .option("--no-triage", "Skip Gemini triage; emit the raw deduped posts + metadata for the caller to judge")
    // Cheap, browser-free config check for scheduled jobs (issue #16): validate
    // watch.yaml + merged flags, print the resolved settings, exit before any read.
    .option("--validate-config", "Validate config + flags, print the resolved watch settings, then exit (no browser, no reads)")
    .option("--inspect", "Headful browser if a (re-)login is needed, so a human can calibrate")
    // Output shape (issue #18): text (default human summary), json (machine), or
    // markdown (reviewable digest). --json is kept as an alias for --format json.
    .option("--format <fmt>", "Output format: text | json | markdown (md). Default text")
    .option("--json", "Alias for --format json (machine JSON)")
    .option("--out <file>", "Write output to a file instead of stdout")
    .action(async (opts: WatchXOptions) => {
      try {
        await runWatchX(opts);
      } catch (err) {
        // Config-validation and "nothing to watch" errors are user-actionable —
        // print the message and exit non-zero rather than dumping a stack trace.
        console.error((err as Error).message);
        process.exit(1);
      }
    });
}

interface WatchXOptions {
  query?: string[];
  xList?: string[];
  config?: string;
  languages?: string;
  persona?: string;
  personaFrom?: string;
  /** commander sets this to `false` when --no-triage is passed (default true). */
  triage?: boolean;
  validateConfig?: boolean;
  inspect?: boolean;
  format?: string;
  json?: boolean;
  out?: string;
}

type OutputFormat = "text" | "json" | "markdown";

/**
 * Resolve the output shape from --format (text|json|markdown|md) with --json as a
 * back-compat alias for `json`. --format wins if both are given; unknown values
 * throw a user-actionable error.
 */
function resolveFormat(opts: WatchXOptions): OutputFormat {
  const raw = opts.format?.trim().toLowerCase();
  if (raw) {
    if (raw === "text") return "text";
    if (raw === "json") return "json";
    if (raw === "markdown" || raw === "md") return "markdown";
    throw new Error(`Unknown --format "${opts.format}" (expected: text | json | markdown).`);
  }
  return opts.json === true ? "json" : "text";
}

/**
 * The final triage rubric: --persona-from <file> OR --persona <text> OR the
 * watch.yaml value. The two flags are mutually exclusive (issue #17) — passing
 * both is a caller error, not a silent precedence rule.
 */
function resolvePersona(opts: WatchXOptions, cfg: WatchConfig): string {
  if (opts.persona !== undefined && opts.personaFrom !== undefined) {
    throw new Error("Pass only one of --persona or --persona-from, not both.");
  }
  if (opts.personaFrom !== undefined) {
    const file = resolve(opts.personaFrom);
    try {
      return readFileSync(file, "utf-8").trim();
    } catch (err) {
      throw new Error(`Could not read --persona-from file (${file}): ${(err as Error).message}`);
    }
  }
  return opts.persona ?? cfg.triage.persona;
}

/** Write emitted output to --out <file> when set, else stdout. */
function writeOutput(text: string, opts: WatchXOptions): void {
  const body = text.endsWith("\n") ? text : text + "\n";
  if (opts.out) {
    const file = resolve(opts.out);
    writeFileSync(file, body, "utf-8");
    console.error(`Wrote ${file}`);
    return;
  }
  process.stdout.write(body);
}

async function runWatchX(opts: WatchXOptions): Promise<void> {
  // Resolve the output shape up front so a bad --format fails before any work.
  const format = resolveFormat(opts);

  // loadWatchConfig validates watch.yaml (when present) and throws a per-field
  // error on anything malformed — before we open the browser.
  const cfg = loadWatchConfig(opts.config);

  // Flags ADD to (don't replace) watch.yaml; dedupe the merged lists.
  const queries = dedupeStrings([...cfg.queries, ...(opts.query ?? [])]);
  const lists = dedupeStrings([...cfg.lists, ...(opts.xList ?? [])].map((l) => l.replace(/^@/, "")));

  // Triage ownership (issue #6): the CALLER supplies the reply-worthiness rubric
  // (free-text persona) each run; batch_size / min_score come from config. The
  // rubric can come inline (--persona), from a file (--persona-from, issue #17),
  // or from watch.yaml.
  const triageConfig: TriageConfig = {
    ...cfg.triage,
    persona: resolvePersona(opts, cfg),
  };
  // commander's --no-triage sets opts.triage === false (default true/undefined).
  const triageEnabled = opts.triage !== false;

  // Language filter (issue #28): a per-run --languages OVERRIDES watch.yaml
  // allowed_languages (not additive — it's a constraint, like --persona), and
  // `--languages all` clears it. Empty = no filter. Normalized once here so both
  // the filter and --validate-config report the same resolved set.
  const allowedLanguages =
    opts.languages !== undefined
      ? parseAllowedLanguages(opts.languages)
      : parseAllowedLanguages(cfg.allowed_languages);

  // Validation-only path (issue #16): everything above already parsed + validated
  // config and merged flags. Print the resolved settings and exit BEFORE opening
  // the browser or touching the seen store, so scheduled jobs can vet a config
  // change cheaply. Run this before the "nothing to watch" guard so an empty
  // origin set still reports (and flags it as a warning).
  if (opts.validateConfig === true) {
    writeOutput(formatResolvedConfig(cfg, queries, lists, allowedLanguages, triageConfig, triageEnabled, format), opts);
    return;
  }

  if (queries.length === 0 && lists.length === 0) {
    throw new Error(
      "Nothing to watch: provide --query/--x-list or populate queries/lists in watch.yaml. " +
        "To watch accounts, build an X List first with `publish x create-watch-list`.",
    );
  }

  // Surface a blank rubric so a degraded (generic-persona) triage run is visible
  // rather than silent — the persona ships empty in the public repo by design.
  if (triageEnabled && !triageConfig.persona?.trim()) {
    console.error(
      "notice: no triage persona/rubric set (flag --persona or watch.yaml triage.persona) — scoring with a generic default.",
    );
  }

  // Reads run THROUGH the logged-in browser session — X gates HTTP reads behind
  // a per-request transaction-id only its own page JS can mint, so we let the
  // real browser make the calls and capture its GraphQL responses. A (headful,
  // if --inspect) login happens only if the persisted profile isn't authed.
  const { BrowserReader } = await import("../x/reader.js");
  const reader = new BrowserReader({ inspect: opts.inspect });
  await reader.init();

  try {
    // Pull from every origin, tolerating per-origin failures so one bad query
    // doesn't abort the whole poll.
    const pulled: XPost[] = [];
    const errors: string[] = [];
    for (const q of queries) {
      try {
        pulled.push(...(await reader.fetchSearch(q, cfg.per_origin_limit)));
      } catch (err) {
        errors.push(`search "${q}": ${(err as Error).message}`);
      }
    }
    // Lists are the account-side origin: one fetch covers all members, so N
    // watched accounts cost one page load instead of N (build a List with
    // `publish x create-watch-list`). There is no per-account origin by design.
    for (const listId of lists) {
      try {
        pulled.push(...(await reader.fetchListTimeline(listId, cfg.per_origin_limit)));
      } catch (err) {
        errors.push(`list ${listId}: ${(err as Error).message}`);
      }
    }

    // Collapse threads BEFORE dedupe (issue: replies were landing mid-thread).
    // One (conversation, author) -> one candidate whose id is the right reply
    // target (thread ROOT for a self-thread) and whose text is the truncated
    // thread. This runs pre-dedupe so the seen-key is the root, not a mid-thread
    // id, and so a thread surfaces once. Zero extra reads — see collapseThreads.
    const collapsed = collapseThreads(pulled, { maxThreadChars: cfg.max_thread_chars });

    // Dedupe within this poll (a candidate can match multiple origins) and against
    // the persistent seen-store; only NEW candidates proceed to triage.
    const { SeenStore } = await import("../db.js");
    const store = new SeenStore();
    try {
      const seenThisPoll = new Set<string>();
      const newPosts = collapsed.filter((p) => {
        if (seenThisPoll.has(p.id)) return false;
        seenThisPoll.add(p.id);
        return !store.hasSeen(p.id);
      });

      // Language filter (issue #28): drop candidates KNOWN to be outside the
      // allow-list BEFORE triage, so wrong-audience posts never reach the
      // classifier/drafting models. Runs after thread-collapse, so a self-thread
      // is judged by its ROOT/reply-target language (base.lang); untagged posts
      // are kept (see langFilter.ts). Empty allow-list = pass-through.
      const { kept, filtered: langFiltered } = filterByLanguage(newPosts, allowedLanguages);

      // Drift guard: `legacy.lang` is where X puts the tweet language TODAY, but X
      // does migrate fields out of `legacy` over time (it already moved the
      // author's screen_name/name into `core`). If a filter is active yet NOT ONE
      // pulled post carried a language code, the field has almost certainly moved —
      // the filter is silently inert (fails open → everything kept, wrong-language
      // posts return). Surface that loudly rather than pass them through in silence.
      if (allowedLanguages.length > 0 && pulled.length > 0 && pulled.every((p) => !p.lang?.trim())) {
        errors.push(
          "language filter active but NO pulled post carried a language code — X likely moved the `lang` field; the filter is currently INERT (all posts kept). Re-calibrate the lang extraction in src/x/reader.ts.",
        );
      }

      const stats: PollStats = {
        newCount: newPosts.length,
        pulledCount: pulled.length,
        langFilteredCount: langFiltered.length,
        allowedLanguages,
        errors,
      };

      // Mark everything we surfaced (the full new set — including language-filtered
      // and below-min_score) as seen so the next poll only shows fresh items. A
      // language-filtered post is a DECIDED post (not a candidate), same tier as a
      // below-threshold one, so it must not resurface.
      const markAllSeen = () => {
        for (const p of newPosts) store.markSeen(p.id, p.origin);
      };

      if (!triageEnabled) {
        // --no-triage (issue #6): hand the raw deduped posts to the caller so it
        // can judge them itself with full context. No score/ranking. Still respects
        // the language filter — wrong-audience posts aren't the caller's job either.
        markAllSeen();
        writeOutput(emitRaw(kept, stats, format), opts);
        return;
      }

      const triaged = await triagePosts(
        kept,
        triageConfig,
        cfg.triage_model,
        undefined,
        triageConfig.batch_size,
      );

      // Gate on min_score (config is 0-100; triage scores are 0-1).
      const minScore01 = (triageConfig.min_score ?? 0) / 100;
      const candidates = triaged.filter((t) => t.triage.score >= minScore01);

      markAllSeen();

      writeOutput(emit(candidates, stats, format), opts);
    } finally {
      store.close();
    }
  } finally {
    await reader.close();
  }
}

interface PollStats {
  pulledCount: number;
  newCount: number;
  /** New posts dropped by the language allow-list (0 when no filter is active). */
  langFilteredCount: number;
  /** The resolved, normalized language allow-list (empty = no filter). */
  allowedLanguages: string[];
  errors: string[];
}

/**
 * One-line, comma-prefixed summary of language filtering for human output —
 * empty string when no filter is active, so default runs read unchanged.
 */
function langSummary(stats: PollStats): string {
  if (stats.allowedLanguages.length === 0) return "";
  return `, ${stats.langFilteredCount} language-filtered`;
}

/** Human note explaining a language filter dropped posts (for empty-candidate runs). */
function langFilterNote(stats: PollStats): string | undefined {
  if (stats.allowedLanguages.length === 0 || stats.langFilteredCount === 0) return undefined;
  return `${stats.langFilteredCount} post(s) dropped by language filter (allowed: ${stats.allowedLanguages.join(", ")}).`;
}

function emit(candidates: TriagedPost[], stats: PollStats, format: OutputFormat): string {
  if (format === "json") {
    const payload = {
      pulled: stats.pulledCount,
      new: stats.newCount,
      languageFiltered: stats.langFilteredCount,
      allowedLanguages: stats.allowedLanguages,
      candidates: candidates.map((c) => ({
        id: c.post.id,
        // `id` IS the reply target (root for a self-thread); surface it explicitly
        // so the caller passes the right id to `publish x reply --to`.
        replyTargetId: c.post.id,
        url: c.post.url,
        author: c.post.authorHandle,
        text: c.post.text,
        createdAt: c.post.createdAt,
        origin: c.post.origin,
        metrics: c.post.metrics,
        thread: c.post.thread,
        score: c.triage.score,
        reason: c.triage.reason,
        suggestedAngle: c.triage.suggestedAngle,
      })),
      errors: stats.errors,
    };
    return JSON.stringify(payload, null, 2);
  }

  if (format === "markdown") {
    const md: string[] = [];
    md.push("# X watch — reply candidates");
    md.push("");
    const langPart = stats.allowedLanguages.length ? ` · **Language-filtered:** ${stats.langFilteredCount}` : "";
    md.push(
      `**Pulled:** ${stats.pulledCount} · **New:** ${stats.newCount}${langPart} · **Candidates:** ${candidates.length}`,
    );
    if (stats.errors.length > 0) {
      md.push("");
      md.push("## Warnings");
      for (const e of stats.errors) md.push(`- ⚠️ ${e}`);
    }
    if (candidates.length === 0) {
      md.push("");
      md.push("_No follow-up candidates this poll._");
      const note = langFilterNote(stats);
      if (note) md.push(`_${note}_`);
    } else {
      candidates.forEach((c, i) => {
        const score = Math.round(c.triage.score * 100);
        md.push("");
        md.push(`## ${i + 1}. [${score}/100] [@${c.post.authorHandle}](${c.post.url}) · \`${c.post.origin}\``);
        md.push("");
        md.push(quoteBlock(c.post.text));
        md.push("");
        md.push(`- **Reply target:** \`${c.post.id}\` — ${c.post.url}`);
        const threadNote = describeThread(c.post);
        if (threadNote) md.push(`- **Thread:** ${stripBrackets(threadNote)}`);
        if (c.triage.reason) md.push(`- **Why:** ${c.triage.reason}`);
        if (c.triage.suggestedAngle) md.push(`- **Angle:** ${c.triage.suggestedAngle}`);
      });
    }
    return md.join("\n");
  }

  const lines: string[] = [];
  lines.push(
    `Watch X: pulled ${stats.pulledCount} post(s), ${stats.newCount} new${langSummary(stats)}, ${candidates.length} candidate(s) above threshold.`,
  );
  if (stats.errors.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const e of stats.errors) lines.push(`  ! ${e}`);
  }

  if (candidates.length === 0) {
    lines.push("");
    lines.push("No follow-up candidates this poll.");
    const note = langFilterNote(stats);
    if (note) lines.push(note);
  } else {
    candidates.forEach((c, i) => {
      const score = Math.round(c.triage.score * 100);
      lines.push("");
      lines.push(`${i + 1}. [${score}/100] @${c.post.authorHandle}  (${c.post.origin})`);
      lines.push(`   ${truncate(c.post.text, 200)}`);
      lines.push(`   ${c.post.url}`);
      const threadNote = describeThread(c.post);
      if (threadNote) lines.push(`   ${threadNote}`);
      if (c.triage.reason) lines.push(`   why: ${c.triage.reason}`);
      if (c.triage.suggestedAngle) lines.push(`   angle: ${c.triage.suggestedAngle}`);
    });
  }

  return lines.join("\n");
}

/**
 * Emit the raw deduped posts with NO triage verdicts (issue #6 --no-triage):
 * just the posts + metadata so the calling agent judges them itself. Mirrors
 * emit()'s human/JSON split but omits score/ranking/reason/angle.
 */
function emitRaw(posts: XPost[], stats: PollStats, format: OutputFormat): string {
  if (format === "json") {
    const payload = {
      pulled: stats.pulledCount,
      new: stats.newCount,
      languageFiltered: stats.langFilteredCount,
      allowedLanguages: stats.allowedLanguages,
      triaged: false,
      posts: posts.map((p) => ({
        id: p.id,
        replyTargetId: p.id,
        url: p.url,
        author: p.authorHandle,
        text: p.text,
        createdAt: p.createdAt,
        origin: p.origin,
        metrics: p.metrics,
        thread: p.thread,
      })),
      errors: stats.errors,
    };
    return JSON.stringify(payload, null, 2);
  }

  if (format === "markdown") {
    const md: string[] = [];
    md.push("# X watch — new posts (triage skipped)");
    md.push("");
    const langPart = stats.allowedLanguages.length ? ` · **Language-filtered:** ${stats.langFilteredCount}` : "";
    md.push(`**Pulled:** ${stats.pulledCount} · **New:** ${stats.newCount}${langPart}`);
    if (stats.errors.length > 0) {
      md.push("");
      md.push("## Warnings");
      for (const e of stats.errors) md.push(`- ⚠️ ${e}`);
    }
    if (posts.length === 0) {
      md.push("");
      md.push("_No new posts this poll._");
      const note = langFilterNote(stats);
      if (note) md.push(`_${note}_`);
    } else {
      posts.forEach((p, i) => {
        md.push("");
        md.push(`## ${i + 1}. [@${p.authorHandle}](${p.url}) · \`${p.origin}\``);
        md.push("");
        md.push(quoteBlock(p.text));
        md.push("");
        md.push(`- **Reply target:** \`${p.id}\` — ${p.url}`);
        const threadNote = describeThread(p);
        if (threadNote) md.push(`- **Thread:** ${stripBrackets(threadNote)}`);
      });
    }
    return md.join("\n");
  }

  const lines: string[] = [];
  lines.push(
    `Watch X: pulled ${stats.pulledCount} post(s), ${stats.newCount} new${langSummary(stats)} (triage skipped — raw posts for caller to judge).`,
  );
  if (stats.errors.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const e of stats.errors) lines.push(`  ! ${e}`);
  }

  if (posts.length === 0) {
    lines.push("");
    lines.push("No new posts this poll.");
    const note = langFilterNote(stats);
    if (note) lines.push(note);
  } else {
    posts.forEach((p, i) => {
      lines.push("");
      lines.push(`${i + 1}. @${p.authorHandle}  (${p.origin})`);
      lines.push(`   ${truncate(p.text, 200)}`);
      lines.push(`   ${p.url}`);
      const threadNote = describeThread(p);
      if (threadNote) lines.push(`   ${threadNote}`);
    });
  }

  return lines.join("\n");
}

/**
 * One-line human note for a collapsed-thread candidate (omitted for plain
 * standalone tweets, which carry no `thread` block). Makes the reply target
 * explicit: a self-thread points at the root/head, otherwise at this tweet.
 */
function describeThread(p: XPost): string | undefined {
  const t = p.thread;
  if (!t) return undefined;
  const target = t.isSelfThread ? "reply targets thread root" : "reply targets this tweet";
  const parts = [`thread: ${t.size} tweet(s) captured`];
  if (t.truncated) parts.push("text truncated");
  if (t.isSelfThread) parts.push("self-thread");
  parts.push(target);
  return `[${parts.join(" · ")}]`;
}

/**
 * Render the resolved watch settings for --validate-config (issue #16): config
 * merged with flags, so the caller sees EXACTLY what a real run would use. Flags
 * a config that resolves to zero origins (the "nothing to watch" case) instead of
 * erroring, since validation should report the shape, not refuse it.
 */
function formatResolvedConfig(
  cfg: WatchConfig,
  queries: string[],
  lists: string[],
  allowedLanguages: string[],
  triage: TriageConfig,
  triageEnabled: boolean,
  format: OutputFormat,
): string {
  const warnings: string[] = [];
  if (queries.length === 0 && lists.length === 0) {
    warnings.push("no queries or lists resolved — a real run would exit with \"nothing to watch\".");
  }
  if (triageEnabled && !triage.persona.trim()) {
    warnings.push("no triage persona/rubric — a real run would score with a generic default.");
  }

  if (format === "json") {
    return JSON.stringify(
      {
        valid: true,
        resolved: {
          triage_model: cfg.triage_model,
          queries,
          lists,
          per_origin_limit: cfg.per_origin_limit,
          max_thread_chars: cfg.max_thread_chars,
          allowed_languages: allowedLanguages,
          triage_enabled: triageEnabled,
          triage: {
            persona: triage.persona,
            min_score: triage.min_score,
            batch_size: triage.batch_size,
          },
        },
        warnings,
      },
      null,
      2,
    );
  }

  const personaLine = triage.persona.trim()
    ? `${triage.persona.trim().length}-char rubric set`
    : "(blank — generic default)";
  const lines = [
    "Watch config OK. Resolved settings:",
    `  triage_model:     ${cfg.triage_model}`,
    `  queries (${queries.length}):     ${queries.length ? queries.map((q) => JSON.stringify(q)).join(", ") : "(none)"}`,
    `  lists (${lists.length}):       ${lists.length ? lists.join(", ") : "(none)"}`,
    `  per_origin_limit: ${cfg.per_origin_limit}`,
    `  max_thread_chars: ${cfg.max_thread_chars}`,
    `  allowed_langs:    ${allowedLanguages.length ? allowedLanguages.join(", ") : "(all — no filter)"}`,
    `  triage:           ${triageEnabled ? "enabled" : "disabled (--no-triage)"}`,
    `    persona:        ${personaLine}`,
    `    min_score:      ${triage.min_score}`,
    `    batch_size:     ${triage.batch_size}`,
  ];
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of warnings) lines.push(`  ! ${w}`);
  }
  return lines.join("\n");
}

/** Render text as a markdown blockquote (each line prefixed with `> `). */
function quoteBlock(s: string): string {
  const flat = s.replace(/\r/g, "").trim() || "(no text)";
  return flat
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

/** Strip the surrounding `[...]` from describeThread()'s note for markdown reuse. */
function stripBrackets(note: string): string {
  return note.replace(/^\[/, "").replace(/\]$/, "");
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = raw.trim();
    if (v === "" || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

import { Command } from "commander";
import { loadWatchConfig, type TriageConfig } from "../config.js";
import { SeenStore } from "../db.js";
import { BrowserReader, type XPost } from "../x/reader.js";
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
    // Triage ownership (issue #6): the calling agent supplies the reply-worthiness
    // RUBRIC per run as FREE TEXT. It can't live as a committed default in this
    // public repo, so --persona is a caller-supplied input, not an override of a
    // value the repo ships. The scoring baseline (fit/timeliness/unique_value, each
    // DEFINED in the prompt) is fixed; nuance goes in the persona prose, where the
    // caller can define its own criteria unambiguously. Durable infra (model,
    // min_score, batch_size) lives in config.
    .option("--persona <text>", "Triage rubric for this run: who is replying / what's worth a reply (falls back to watch.yaml)")
    .option("--no-triage", "Skip Gemini triage; emit the raw deduped posts + metadata for the caller to judge")
    .option("--inspect", "Headful browser if a (re-)login is needed, so a human can calibrate")
    .option("--json", "Emit machine JSON instead of the human-readable summary")
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
  persona?: string;
  /** commander sets this to `false` when --no-triage is passed (default true). */
  triage?: boolean;
  inspect?: boolean;
  json?: boolean;
}

async function runWatchX(opts: WatchXOptions): Promise<void> {
  // loadWatchConfig validates watch.yaml (when present) and throws a per-field
  // error on anything malformed — before we open the browser.
  const cfg = loadWatchConfig(opts.config);

  // Flags ADD to (don't replace) watch.yaml; dedupe the merged lists.
  const queries = dedupeStrings([...cfg.queries, ...(opts.query ?? [])]);
  const lists = dedupeStrings([...cfg.lists, ...(opts.xList ?? [])].map((l) => l.replace(/^@/, "")));

  if (queries.length === 0 && lists.length === 0) {
    throw new Error(
      "Nothing to watch: provide --query/--x-list or populate queries/lists in watch.yaml. " +
        "To watch accounts, build an X List first with `publish x create-watch-list`.",
    );
  }

  // Triage ownership (issue #6): the CALLER supplies the reply-worthiness rubric
  // (free-text persona) each run; batch_size / min_score come from config.
  const triageConfig: TriageConfig = {
    ...cfg.triage,
    persona: opts.persona ?? cfg.triage.persona,
  };
  // commander's --no-triage sets opts.triage === false (default true/undefined).
  const triageEnabled = opts.triage !== false;

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

    // Dedupe within this poll (a post can match multiple origins) and against
    // the persistent seen-store; only NEW posts proceed to triage.
    const store = new SeenStore();
    try {
      const seenThisPoll = new Set<string>();
      const newPosts = pulled.filter((p) => {
        if (seenThisPoll.has(p.id)) return false;
        seenThisPoll.add(p.id);
        return !store.hasSeen(p.id);
      });

      const stats: PollStats = { newCount: newPosts.length, pulledCount: pulled.length, errors };

      // Mark everything we surfaced (the full new set) as seen so the next poll
      // only shows fresh items, even for posts that fell below min_score /
      // regardless of whether triage ran.
      const markAllSeen = () => {
        for (const p of newPosts) store.markSeen(p.id, p.origin);
      };

      if (!triageEnabled) {
        // --no-triage (issue #6): hand the raw deduped posts to the caller so it
        // can judge them itself with full context. No score/ranking.
        markAllSeen();
        emitRaw(newPosts, stats, opts.json === true);
        return;
      }

      const triaged = await triagePosts(
        newPosts,
        triageConfig,
        cfg.triage_model,
        undefined,
        triageConfig.batch_size,
      );

      // Gate on min_score (config is 0-100; triage scores are 0-1).
      const minScore01 = (triageConfig.min_score ?? 0) / 100;
      const candidates = triaged.filter((t) => t.triage.score >= minScore01);

      markAllSeen();

      emit(candidates, stats, opts.json === true);
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
  errors: string[];
}

function emit(candidates: TriagedPost[], stats: PollStats, asJson: boolean): void {
  if (asJson) {
    const payload = {
      pulled: stats.pulledCount,
      new: stats.newCount,
      candidates: candidates.map((c) => ({
        id: c.post.id,
        url: c.post.url,
        author: c.post.authorHandle,
        text: c.post.text,
        createdAt: c.post.createdAt,
        origin: c.post.origin,
        metrics: c.post.metrics,
        score: c.triage.score,
        reason: c.triage.reason,
        suggestedAngle: c.triage.suggestedAngle,
      })),
      errors: stats.errors,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  const lines: string[] = [];
  lines.push(
    `Watch X: pulled ${stats.pulledCount} post(s), ${stats.newCount} new, ${candidates.length} candidate(s) above threshold.`,
  );
  if (stats.errors.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const e of stats.errors) lines.push(`  ! ${e}`);
  }

  if (candidates.length === 0) {
    lines.push("");
    lines.push("No follow-up candidates this poll.");
  } else {
    candidates.forEach((c, i) => {
      const score = Math.round(c.triage.score * 100);
      lines.push("");
      lines.push(`${i + 1}. [${score}/100] @${c.post.authorHandle}  (${c.post.origin})`);
      lines.push(`   ${truncate(c.post.text, 200)}`);
      lines.push(`   ${c.post.url}`);
      if (c.triage.reason) lines.push(`   why: ${c.triage.reason}`);
      if (c.triage.suggestedAngle) lines.push(`   angle: ${c.triage.suggestedAngle}`);
    });
  }

  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * Emit the raw deduped posts with NO triage verdicts (issue #6 --no-triage):
 * just the posts + metadata so the calling agent judges them itself. Mirrors
 * emit()'s human/JSON split but omits score/ranking/reason/angle.
 */
function emitRaw(posts: XPost[], stats: PollStats, asJson: boolean): void {
  if (asJson) {
    const payload = {
      pulled: stats.pulledCount,
      new: stats.newCount,
      triaged: false,
      posts: posts.map((p) => ({
        id: p.id,
        url: p.url,
        author: p.authorHandle,
        text: p.text,
        createdAt: p.createdAt,
        origin: p.origin,
        metrics: p.metrics,
      })),
      errors: stats.errors,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  const lines: string[] = [];
  lines.push(
    `Watch X: pulled ${stats.pulledCount} post(s), ${stats.newCount} new (triage skipped — raw posts for caller to judge).`,
  );
  if (stats.errors.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const e of stats.errors) lines.push(`  ! ${e}`);
  }

  if (posts.length === 0) {
    lines.push("");
    lines.push("No new posts this poll.");
  } else {
    posts.forEach((p, i) => {
      lines.push("");
      lines.push(`${i + 1}. @${p.authorHandle}  (${p.origin})`);
      lines.push(`   ${truncate(p.text, 200)}`);
      lines.push(`   ${p.url}`);
    });
  }

  process.stdout.write(lines.join("\n") + "\n");
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

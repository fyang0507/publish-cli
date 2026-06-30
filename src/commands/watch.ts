import { Command } from "commander";
import { loadWatchConfig } from "../config.js";
import { SeenStore } from "../db.js";
import { BrowserReader, type XPost } from "../x/reader.js";
import { triagePosts, type TriagedPost } from "../x/triage.js";

/**
 * `publish watch x` — borrowed-reach watch loop for the X channel.
 *
 * Flow:
 *   1. Load watch.yaml (loadWatchConfig(--config)) and merge in repeatable
 *      --query / --account flags (flags ADD to config).
 *   2. An AgentTwitterReader reads via the cached harvested cookies (HTTP, no
 *      browser) — fetchSearch(query) per query and fetchUserTimeline(handle) per
 *      account, up to per_origin_limit. A login (headful with --inspect) happens
 *      only if the cookie cache is missing/unusable.
 *   3. Dedupe against the SeenStore (src/db.ts); only NEW post ids proceed.
 *   4. Triage each new post with the cheap Gemini model (config.TRIAGE_MODEL /
 *      watch.yaml triage_model, minimal thinking) -> {postId, score, reason,
 *      suggestedAngle}.
 *   5. Emit ranked candidates: human text by default, machine JSON with --json.
 *      Mark surfaced posts as seen.
 */
export function registerWatchCommand(program: Command): void {
  const watch = program
    .command("watch")
    .description("Watch channels for borrowed-reach follow-up opportunities");

  watch
    .command("x")
    .description("Watch X: poll queries/accounts, dedupe, triage, rank candidates")
    .option("--query <q...>", "Search query to monitor (repeatable; merges with watch.yaml)")
    .option("--account <handle...>", "Account handle to monitor (repeatable; merges with watch.yaml)")
    .option("--config <path>", "Path to watch.yaml (defaults to ./watch.yaml)")
    .option("--inspect", "Headful browser if a (re-)login is needed, so a human can calibrate")
    .option("--json", "Emit machine JSON instead of the human-readable summary")
    .action(async (opts: WatchXOptions) => {
      await runWatchX(opts);
    });
}

interface WatchXOptions {
  query?: string[];
  account?: string[];
  config?: string;
  inspect?: boolean;
  json?: boolean;
}

async function runWatchX(opts: WatchXOptions): Promise<void> {
  const cfg = loadWatchConfig(opts.config);

  // Flags ADD to (don't replace) watch.yaml; dedupe the merged lists.
  const queries = dedupeStrings([...cfg.queries, ...(opts.query ?? [])]);
  const accounts = dedupeStrings([...cfg.accounts, ...(opts.account ?? [])].map((a) => a.replace(/^@/, "")));

  if (queries.length === 0 && accounts.length === 0) {
    throw new Error(
      "Nothing to watch: provide --query/--account or populate queries/accounts in watch.yaml.",
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
    for (const handle of accounts) {
      try {
        pulled.push(...(await reader.fetchUserTimeline(handle, cfg.per_origin_limit)));
      } catch (err) {
        errors.push(`timeline @${handle}: ${(err as Error).message}`);
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

      const triaged = await triagePosts(newPosts, cfg.triage, cfg.triage_model);

      // Gate on min_score (config is 0-100; triage scores are 0-1).
      const minScore01 = (cfg.triage.min_score ?? 0) / 100;
      const candidates = triaged.filter((t) => t.triage.score >= minScore01);

      // Mark everything we surfaced (the full new set) as seen so the next poll
      // only shows fresh items, even for posts that fell below min_score.
      for (const p of newPosts) store.markSeen(p.id, p.origin);

      emit(candidates, { newCount: newPosts.length, pulledCount: pulled.length, errors }, opts.json === true);
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

import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config.js";
import { BrowserReader, type XPost } from "../x/reader.js";

/**
 * `publish x history` — read the operator's OWN published posts and replies.
 *
 * WHY: an agent running a multi-day campaign (publishing variations of a theme
 * over several days) needs visibility into what it has ALREADY put live, so it
 * doesn't repeat itself. There is no local record of what's been published (this
 * tool only ever stages drafts; a human posts them), so the source of truth is
 * X itself — we read the operator's own profile timeline live.
 *
 * Pure reader: never posts, never drafts, writes no local state. Reflects what is
 * actually LIVE on X — drafts staged-but-not-yet-posted are (by design) invisible
 * until a human posts them.
 *
 * Flow:
 *   1. Resolve the handle (--handle, else X_USERNAME).
 *   2. A BrowserReader reads THROUGH the logged-in browser (capturing X's own
 *      profile GraphQL responses), keeping only tweets the operator authored
 *      (reposts / others' quoted tweets are dropped).
 *   3. Classify post vs reply, apply --include / --since filters, sort newest
 *      first, emit (text / json / markdown).
 */
export function registerHistoryCommand(x: Command): void {
  x
    .command("history")
    .description("Read your OWN published posts + replies from X (avoid repeating a campaign). Never posts.")
    .option("--handle <handle>", "Profile to read (without @); defaults to X_USERNAME")
    .option("--limit <n>", "Max items to return (default 50)", "50")
    .option("--include <what>", "Which items: posts | replies | all (default all)", "all")
    .option("--since <iso>", "Drop items older than this date (ISO 8601, e.g. 2026-07-01)")
    .option("--format <fmt>", "Output format: text | json | markdown (md). Default text")
    .option("--json", "Alias for --format json (machine JSON)")
    .option("--out <file>", "Write output to a file instead of stdout")
    .option("--inspect", "Headful browser if a (re-)login is needed, so a human can calibrate")
    .action(async (opts: HistoryOptions) => {
      try {
        await runHistory(opts);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });
}

interface HistoryOptions {
  handle?: string;
  limit?: string;
  include?: string;
  since?: string;
  format?: string;
  json?: boolean;
  out?: string;
  inspect?: boolean;
}

type OutputFormat = "text" | "json" | "markdown";
type IncludeMode = "posts" | "replies" | "all";

/** One published item, normalized for emit. */
interface HistoryItem {
  post: XPost;
  type: "post" | "reply";
  /** A reply to the operator's own tweet (self-thread continuation). */
  selfThread: boolean;
}

/**
 * Resolve the output shape from --format (text|json|markdown|md) with --json as a
 * back-compat alias for `json` (mirrors `watch`). --format wins if both are given.
 */
function resolveFormat(opts: HistoryOptions): OutputFormat {
  const raw = opts.format?.trim().toLowerCase();
  if (raw) {
    if (raw === "text") return "text";
    if (raw === "json") return "json";
    if (raw === "markdown" || raw === "md") return "markdown";
    throw new Error(`Unknown --format "${opts.format}" (expected: text | json | markdown).`);
  }
  return opts.json === true ? "json" : "text";
}

function resolveInclude(opts: HistoryOptions): IncludeMode {
  const raw = (opts.include ?? "all").trim().toLowerCase();
  if (raw === "posts" || raw === "replies" || raw === "all") return raw;
  throw new Error(`Unknown --include "${opts.include}" (expected: posts | replies | all).`);
}

function resolveLimit(opts: HistoryOptions): number {
  const n = Number.parseInt((opts.limit ?? "50").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--limit must be a positive integer, got "${opts.limit}".`);
  }
  return n;
}

/** Parse --since into a comparable epoch ms, or undefined when unset. */
function resolveSince(opts: HistoryOptions): number | undefined {
  if (opts.since === undefined) return undefined;
  const t = new Date(opts.since.trim()).getTime();
  if (Number.isNaN(t)) {
    throw new Error(`--since is not a valid date: "${opts.since}" (use ISO 8601, e.g. 2026-07-01).`);
  }
  return t;
}

/** Write emitted output to --out <file> when set, else stdout. */
function writeOutput(text: string, opts: HistoryOptions): void {
  const body = text.endsWith("\n") ? text : text + "\n";
  if (opts.out) {
    const file = resolve(opts.out);
    writeFileSync(file, body, "utf-8");
    console.error(`Wrote ${file}`);
    return;
  }
  process.stdout.write(body);
}

async function runHistory(opts: HistoryOptions): Promise<void> {
  const format = resolveFormat(opts);
  const include = resolveInclude(opts);
  const limit = resolveLimit(opts);
  const since = resolveSince(opts);

  const handle = (opts.handle ?? env.X_USERNAME).replace(/^@/, "").trim();
  if (!handle) {
    throw new Error(
      "No handle to read: pass --handle <name> or set X_USERNAME in .env.",
    );
  }

  // Reads run THROUGH the logged-in browser session (same mechanism as `watch`);
  // a headful login happens only if the persisted profile isn't authed.
  const reader = new BrowserReader({ inspect: opts.inspect });
  await reader.init();

  try {
    // Push the --include type filter INTO the reader so `--limit` counts matching
    // items (not the newest `limit` raw items then mostly dropped — a silent
    // undercount). --since stays a post-filter: items are newest-first, so a date
    // floor just trims the tail and can't hide matches within the window. Fetch
    // the /with_replies tab unless the caller wants originals only.
    const { posts, sawTimeline } = await reader.fetchUserTimeline(handle, limit, {
      withReplies: include !== "posts",
      match: includePredicate(include),
    });

    // Distinguish a FAILED read from a genuinely empty timeline. Both yield 0
    // posts, but only a failed read leaves sawTimeline false (no such profile /
    // suspended / logged out). Returning "0 items" for a failed read would let a
    // campaign agent conclude "nothing published yet" and repeat itself — the exact
    // failure this feature exists to prevent — so fail loudly instead.
    if (!sawTimeline) {
      throw new Error(
        `Could not read @${handle}'s timeline — X returned no usable profile data. The handle ` +
          `may not exist or be suspended, the session may be logged out (try --inspect to ` +
          `re-login), or X may have rate-limited/errored the request (transient — retry later). ` +
          `NOT treating this as an empty history.`,
      );
    }

    const items: HistoryItem[] = posts
      .map((p) => ({ post: p, ...classify(p) }))
      .filter((it) => sinceMatches(since, it.post.createdAt));

    // Newest first — the most-recent published items are what a campaign agent
    // needs to compare against.
    items.sort((a, b) => epoch(b.post.createdAt) - epoch(a.post.createdAt));

    writeOutput(emit(items, handle, include, format), opts);
  } finally {
    await reader.close();
  }
}

/**
 * Classify a captured tweet. A reply to the operator's OWN tweet (replyToUserId ===
 * authorId) is a self-thread continuation — the operator's own thread body, not a
 * reply to someone else — so it counts as a "post". Only replies to OTHER users are
 * "reply". This keeps `--include posts` from hiding the operator's own threads.
 */
function classify(p: XPost): { type: "post" | "reply"; selfThread: boolean } {
  const isReply = p.replyToStatusId != null;
  const selfThread = isReply && p.replyToUserId != null && p.replyToUserId === p.authorId;
  return { type: isReply && !selfThread ? "reply" : "post", selfThread };
}

/**
 * The reader-side `match` predicate for an --include mode (undefined for `all`, so
 * nothing extra is filtered). Uses the same classify() as the emit path so the
 * count the reader stops at matches what the caller sees.
 */
function includePredicate(include: IncludeMode): ((p: XPost) => boolean) | undefined {
  if (include === "all") return undefined;
  const want = include === "posts" ? "post" : "reply";
  return (p) => classify(p).type === want;
}

/** True if createdAt is at/after `since` (or no filter). Undated items are kept. */
function sinceMatches(since: number | undefined, createdAt: string): boolean {
  if (since === undefined) return true;
  const t = epoch(createdAt);
  if (Number.isNaN(t)) return true; // undated / unparseable — keep rather than silently drop
  return t >= since;
}

function epoch(iso: string): number {
  return new Date(iso).getTime();
}

function emit(
  items: HistoryItem[],
  handle: string,
  include: IncludeMode,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        handle,
        include,
        count: items.length,
        items: items.map((it) => ({
          id: it.post.id,
          url: it.post.url,
          type: it.type,
          selfThread: it.selfThread,
          text: it.post.text,
          createdAt: it.post.createdAt,
          conversationId: it.post.conversationId,
          // Present whenever there's a parent tweet — a reply to someone OR a
          // self-thread continuation (which classifies as a "post").
          replyTo: replyTargetUrl(it.post),
          metrics: it.post.metrics,
        })),
      },
      null,
      2,
    );
  }

  if (format === "markdown") {
    const md: string[] = [];
    md.push(`# X history — @${handle} (${include})`);
    md.push("");
    md.push(`**${items.length}** item(s).`);
    if (items.length === 0) {
      md.push("");
      md.push("_No matching published items._");
    } else {
      items.forEach((it, i) => {
        md.push("");
        md.push(`## ${i + 1}. [${it.type}${it.selfThread ? " · self-thread" : ""}] ${it.post.createdAt}`);
        md.push("");
        md.push(quoteBlock(it.post.text));
        md.push("");
        md.push(`- ${it.post.url}`);
        const rtMd = replyTargetUrl(it.post);
        if (rtMd) {
          md.push(`- **In reply to:** ${rtMd}`);
        }
      });
    }
    return md.join("\n");
  }

  const lines: string[] = [];
  lines.push(`X history — @${handle} (${include}): ${items.length} item(s).`);
  if (items.length === 0) {
    lines.push("");
    lines.push("No matching published items.");
  } else {
    items.forEach((it, i) => {
      lines.push("");
      const tag = it.type === "reply" ? "reply" : it.selfThread ? "post·self-thread" : "post";
      lines.push(`${i + 1}. [${tag}] ${it.post.createdAt}`);
      lines.push(`   ${truncate(it.post.text, 200)}`);
      lines.push(`   ${it.post.url}`);
      const rt = replyTargetUrl(it.post);
      if (rt) lines.push(`   in reply to: ${rt}`);
    });
  }
  return lines.join("\n");
}

/** The parent-tweet URL for an item that has one (a reply or self-thread), else undefined. */
function replyTargetUrl(p: XPost): string | undefined {
  return p.replyToStatusId ? `https://x.com/i/status/${p.replyToStatusId}` : undefined;
}

/** Render text as a markdown blockquote (each line prefixed with `> `). */
function quoteBlock(s: string): string {
  const flat = s.replace(/\r/g, "").trim() || "(no text)";
  return flat
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

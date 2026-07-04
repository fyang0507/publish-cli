import { Command } from "commander";

/**
 * `publish reddit search "<query>"` — read-only BREADTH candidate-subreddit list
 * (REDDIT_DESIGN §2). Facts only, no LLM ranking: it exists to feed `inspect`
 * when the agent can't already name candidates (§1.1). Returns a shallow hit per
 * subreddit ({name, subscribers, over18, submissionType, publicDescription}).
 *
 * Human report by default; `--json` emits a structured array for the agent. The
 * reader is lazy-imported so `--help` never pulls in Playwright / the session.
 */
interface RedditSearchOptions {
  limit?: number;
  includeNsfw?: boolean;
  json?: boolean;
  inspect?: boolean;
}

/** 2,900,000 rather than 2900000 for the human report. */
function fmtCount(n: number | undefined): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : "?";
}

function renderHit(h: import("../reddit/reader.js").SubredditSearchHit): string {
  const meta = [
    `${fmtCount(h.subscribers)} subs`,
    `submissions: ${h.submissionType}`,
    h.over18 ? "over18" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const desc = h.publicDescription ? `\n    ${h.publicDescription}` : "";
  return `r/${h.name}  (${meta})${desc}`;
}

export function registerRedditSearchCommand(reddit: Command): void {
  reddit
    .command("search <query>")
    .description("List candidate subreddits for a topic (facts only, no LLM)")
    .option("--limit <n>", "Cap results (default 25)", (v) => parseInt(v, 10), 25)
    .option("--include-nsfw", "Include over-18 subreddits (default: excluded)")
    .option("--json", "Machine-readable output (default: human report)")
    .option(
      "--inspect",
      "Force a headful browser (reads run logged-out; no login required). Reads also auto-retry headful on a 403 block; set REDDIT_READS_HEADFUL=1 to start headful.",
    )
    .action(async (query: string, opts: RedditSearchOptions) => {
      const { withReadFallback } = await import("../reddit/reader.js");

      let hits: import("../reddit/reader.js").SubredditSearchHit[] = [];
      let failed: string | null = null;
      let retriedHeadful = false;
      try {
        // Headless→headful fallback (design #4): Reddit 403-blocks headless Chrome's
        // fingerprint on some networks; reads are login-free so a headful retry needs
        // no human. Throws (RedditReadBlockedError) if even headful is walled.
        const run = await withReadFallback({ inspect: opts.inspect }, (reader) =>
          reader.search(query, { limit: opts.limit, includeNsfw: opts.includeNsfw }),
        );
        hits = run.value;
        retriedHeadful = run.retriedHeadful;
      } catch (err) {
        // e.g. RedditReadBlockedError — report the block, don't pretend "0 found".
        failed = (err as Error).message;
      }

      if (retriedHeadful) {
        console.error(
          "note: the headless read was 403-blocked on this network; retried with a headful browser (set REDDIT_READS_HEADFUL=1 to skip the doomed first attempt).",
        );
      }
      if (failed) {
        console.error(`✗ reddit search failed: ${failed}`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(hits, null, 2));
      } else if (hits.length === 0) {
        console.log(`No subreddits found for "${query}".`);
      } else {
        console.log(
          `${hits.length} candidate subreddit${hits.length === 1 ? "" : "s"} for "${query}":\n`,
        );
        console.log(hits.map(renderHit).join("\n\n"));
      }
      process.exit(0);
    });
}

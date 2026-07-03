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
    .option("--inspect", "Headful browser (first login / selector calibration)")
    .action(async (query: string, opts: RedditSearchOptions) => {
      const { BrowserRedditReader } = await import("../reddit/reader.js");
      const reader = new BrowserRedditReader({ inspect: opts.inspect });

      let hits: import("../reddit/reader.js").SubredditSearchHit[] = [];
      try {
        await reader.init();
        hits = await reader.search(query, {
          limit: opts.limit,
          includeNsfw: opts.includeNsfw,
        });
      } finally {
        await reader.close();
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

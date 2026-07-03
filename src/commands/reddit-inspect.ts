import { Command } from "commander";

/**
 * `publish reddit inspect <sub>...` — read-only DEPTH report of each named
 * subreddit's full posting contract (REDDIT_DESIGN §2). Facts only, no LLM
 * ranking: the CLI reports; the consuming agent judges where to post (§1.1).
 *
 * For each subreddit the reader merges four reads (about / rules / flairs /
 * post_requirements) plus a one-line verdict and a best-effort karma/age note
 * (§4.1 — hard gates are AutoMod-enforced and only surface authoritatively at
 * `draft` time). Private/quarantined subs degrade to a note, not a hard error.
 *
 * Human report by default; `--json` emits a structured array for the agent.
 * The reader is lazy-imported so `--help` never pulls in Playwright / the
 * session module.
 */
interface RedditInspectOptions {
  json?: boolean;
  inspect?: boolean;
}

/** 2,900,000 rather than 2900000 for the human report. */
function fmtCount(n: number | undefined): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : "?";
}

/** Human-readable block for one subreddit's contract. */
function renderContract(c: import("../reddit/reader.js").SubredditContract): string {
  const { about, rules, flairs, postRequirements: pr, verdict } = c;
  const lines: string[] = [];

  lines.push(`=== r/${about.name} ===`);
  if (about.title) lines.push(about.title);

  lines.push(
    [
      `subscribers: ${fmtCount(about.subscribers)}`,
      `active: ${fmtCount(about.activeUsers)}`,
      `type: ${about.subredditType}`,
      `submissions: ${about.submissionType}`,
      `over18: ${about.over18 ? "yes" : "no"}`,
      about.quarantined ? "quarantined: yes" : undefined,
    ]
      .filter(Boolean)
      .join("  |  "),
  );

  // Verdict — the one-line judgment the agent acts on.
  const flairPart = verdict.flairRequired
    ? `flair REQUIRED${verdict.availableFlairs.length ? ` (${verdict.availableFlairs.join(", ")})` : ""}`
    : verdict.availableFlairs.length
      ? `flair optional (${verdict.availableFlairs.join(", ")})`
      : "flair not used";
  lines.push(
    `Verdict: self-posts ${verdict.selfPostsAllowed ? "allowed" : "NOT allowed"}; ${flairPart}`,
  );
  if (verdict.titleRegexNote) lines.push(`  title: ${verdict.titleRegexNote}`);
  if (verdict.karmaAgeNote) lines.push(`  karma/age (best-effort): ${verdict.karmaAgeNote}`);
  for (const note of verdict.notes) lines.push(`  note: ${note}`);
  if (verdict.degraded) lines.push(`  [degraded: ${verdict.degraded}]`);

  // Posting contract (the machine-declared requirements).
  const contractBits: string[] = [`flair required: ${pr.isFlairRequired ? "yes" : "no"}`];
  if (pr.titleRegexes.length) contractBits.push(`title regex: ${pr.titleRegexes.join(" , ")}`);
  if (pr.titleRequiredStrings.length)
    contractBits.push(`title must include: ${pr.titleRequiredStrings.join(", ")}`);
  if (pr.titleBlacklistedStrings.length)
    contractBits.push(`title must NOT include: ${pr.titleBlacklistedStrings.join(", ")}`);
  if (pr.bodyMinLength !== undefined || pr.bodyMaxLength !== undefined)
    contractBits.push(`body: ${pr.bodyMinLength ?? 0}–${pr.bodyMaxLength ?? "∞"} chars`);
  if (pr.bodyRestrictionPolicy) contractBits.push(`body policy: ${pr.bodyRestrictionPolicy}`);
  lines.push(`Posting contract: ${contractBits.join(" | ")}`);
  if (pr.guidelinesText) lines.push(`Guidelines: ${pr.guidelinesText}`);

  // Flairs.
  lines.push(
    flairs.length ? `Flairs: ${flairs.map((f) => f.text).join(", ")}` : "Flairs: (none)",
  );

  // Rules.
  if (rules.length) {
    lines.push("Rules:");
    rules.forEach((r, i) => {
      lines.push(`  ${i + 1}. ${r.shortName}${r.description ? ` — ${r.description}` : ""}`);
    });
  }

  if (about.publicDescription) lines.push(`Description: ${about.publicDescription}`);

  return lines.join("\n");
}

export function registerRedditInspectCommand(reddit: Command): void {
  reddit
    .command("inspect <subreddits...>")
    .description("Report each named subreddit's full posting contract (facts only, no LLM)")
    .option("--json", "Machine-readable output (default: human report)")
    .option("--inspect", "Headful browser (first login / selector calibration)")
    .action(async (subreddits: string[], opts: RedditInspectOptions) => {
      const { BrowserRedditReader } = await import("../reddit/reader.js");
      const reader = new BrowserRedditReader({ inspect: opts.inspect });

      type ContractResult =
        | { subreddit: string; contract: import("../reddit/reader.js").SubredditContract }
        | { subreddit: string; error: string };

      const results: ContractResult[] = [];
      try {
        await reader.init();
        for (const name of subreddits) {
          const sub = name.replace(/^\/?r\//i, "").trim();
          try {
            const contract = await reader.inspectSubreddit(sub);
            results.push({ subreddit: sub, contract });
          } catch (err) {
            // One bad name must not abort the whole run (§9 graceful degrade).
            results.push({ subreddit: sub, error: (err as Error).message });
          }
        }
      } finally {
        await reader.close();
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            results.map((r) => ("contract" in r ? r.contract : { subreddit: r.subreddit, error: r.error })),
            null,
            2,
          ),
        );
      } else {
        const blocks = results.map((r) =>
          "contract" in r
            ? renderContract(r.contract)
            : `=== r/${r.subreddit} ===\n  ✗ could not inspect: ${r.error}`,
        );
        console.log(blocks.join("\n\n"));
      }

      const anyError = results.some((r) => "error" in r);
      process.exit(anyError ? 1 : 0);
    });
}

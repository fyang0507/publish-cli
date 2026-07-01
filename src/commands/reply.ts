import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateContent, renderForInspection } from "../x/content.js";

/**
 * `publish reply x` — stage a NATIVE X REPLY draft targeted at an existing tweet
 * (issue #8). Closes the watcher -> publisher loop: the watcher surfaces a
 * borrowed-reach opportunity (a tweet id/url), and this command turns Fred's
 * canonical base markdown into a reply that sits ONE CLICK from posting.
 *
 * HARD BOUNDARY (same as `draft x`): this NEVER posts. It opens a reply-targeted
 * composer (https://x.com/compose/post?in_reply_to=<id>), types the generated
 * reply (single tweet by default; a thread if the content overflows), and SAVES
 * IT AS A NATIVE DRAFT via the same close->Save flow. A human takes the last click.
 *
 * Flow:
 *   1. Resolve --to (a status URL or a raw tweet id) to a numeric tweet id.
 *   2. Read the canonical base markdown (--from) and DETERMINISTICALLY generate a
 *      tweet (default; --long raises the cap) — reusing src/x/content.ts.
 *   3. --dry-run: generate + print ONLY; do NOT touch the browser.
 *   4. Otherwise: drive the persistent logged-in profile to stage the reply draft.
 */

interface ReplyXOptions {
  to: string;
  from: string;
  long?: boolean;
  dryRun?: boolean;
  inspect?: boolean;
}

export function registerReplyCommand(program: Command): void {
  const reply = program
    .command("reply")
    .description("Generate channel REPLY drafts targeted at an existing post");

  reply
    .command("x")
    .description("Stage a NATIVE X reply draft targeted at a tweet — never posts")
    .requiredOption("--to <id|url>", "Target tweet: a status URL or a raw numeric id")
    .requiredOption("--from <base.md>", "Path to the canonical base markdown for the reply")
    .option("--long", "Raise the reply limit to the Premium long-post cap (default up to 25000)")
    .option("--dry-run", "Only generate content; do not open the browser")
    .option("--inspect", "Headful browser so a human can watch/calibrate selectors")
    .action(async (opts: ReplyXOptions) => {
      const fromPath = resolve(opts.from);
      if (!existsSync(fromPath)) {
        console.error(`Base markdown not found: ${fromPath}`);
        process.exit(2);
      }

      // Resolve/validate the target id up front so a bad --to fails fast (even in
      // --dry-run). Import lazily so --dry-run/--help don't pull in Playwright.
      const { extractTweetId } = await import("../x/draftPoster.js");
      let replyToId: string;
      try {
        replyToId = extractTweetId(opts.to);
      } catch (err) {
        console.error(`Invalid --to: ${(err as Error).message}`);
        process.exit(2);
        return;
      }

      const md = readFileSync(fromPath, "utf-8");

      // DETERMINISTIC generation. A reply is a single tweet by default; if the
      // content overflows the limit, fall back to a thread so nothing is dropped.
      const tweet = await generateContent(md, { format: "tweet", long: opts.long });
      const overflowed = tweet.warnings.some((w) => /leading segment/i.test(w));
      const content = overflowed
        ? await generateContent(md, { format: "thread", long: opts.long })
        : tweet;
      if (overflowed) {
        console.log(
          `[note] Reply content exceeds the single-post limit — staging it as a ${content.thread?.length ?? 0}-post reply thread.`,
        );
      }

      console.log(`Replying to tweet ${replyToId}:\n`);
      console.log(renderForInspection(content));

      if (opts.dryRun) {
        console.log(`\n[dry-run] No browser touched. Would stage the above as a reply to ${replyToId}.`);
        process.exit(0);
      }

      const { stageReplyDraft } = await import("../x/draftPoster.js");
      try {
        const result = await stageReplyDraft(content, opts.to, { inspect: opts.inspect });
        const count = result.format === "thread" ? `${result.posts} posts` : "1 reply";
        console.log(
          `\n✓ Staged a NATIVE X reply draft (${result.format}, ${count}) to ${result.replyToId}. NEVER posted.\n` +
            `  verified in Unsent/Drafts: ${result.verified ? "yes" : "unconfirmed"}\n` +
            `  ${result.note}`,
        );
        process.exit(0);
      } catch (err) {
        console.error(`\n✗ Failed to stage the X reply draft: ${(err as Error).message}`);
        console.error(
          "  Composer selectors may need live calibration — re-run with --inspect to watch the DOM.",
        );
        process.exit(1);
      }
    });
}

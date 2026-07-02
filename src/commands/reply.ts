import { Command } from "commander";
import { generateContent, renderForInspection } from "../x/content.js";
import { resolveContentInput } from "./contentInput.js";
import { ReplyLedger } from "../db.js";

/**
 * `publish x reply` — stage a NATIVE X REPLY draft targeted at an existing tweet
 * (issue #8). Closes the watcher -> publisher loop: the watcher surfaces a
 * borrowed-reach opportunity (a tweet id/url), and this command turns the
 * operator's canonical base markdown into a reply that sits ONE CLICK from posting.
 *
 * HARD BOUNDARY (same as `draft`): this NEVER posts. It opens a reply-targeted
 * composer (https://x.com/compose/post?in_reply_to=<id>), types the generated
 * reply (single tweet by default; a thread if the content overflows), and SAVES
 * IT AS A NATIVE DRAFT via the same close->Save flow. A human takes the last click.
 *
 * Flow:
 *   1. Resolve --to (a status URL or a raw tweet id) to a numeric tweet id.
 *   2. Resolve the reply content — inline via --text, or from a canonical
 *      markdown file via --from (exactly one) — and DETERMINISTICALLY generate a
 *      tweet (default; --long raises the cap) — reusing src/x/content.ts.
 *   3. --dry-run: generate + print ONLY; do NOT touch the browser.
 *   4. Otherwise: drive the persistent logged-in profile to stage the reply draft.
 */

interface ReplyXOptions {
  to: string;
  from?: string;
  text?: string;
  long?: boolean;
  dryRun?: boolean;
  inspect?: boolean;
  force?: boolean;
}

export function registerReplyCommand(x: Command): void {
  x
    .command("reply")
    .description("Stage a NATIVE X reply draft targeted at a tweet — never posts")
    .requiredOption("--to <id|url>", "Target tweet: a status URL or a raw numeric id")
    .option("--text <content>", "Reply content inline (exactly one of --text / --from)")
    .option("--from <base.md>", "Path to the canonical base markdown ('-' = stdin)")
    .option("--long", "Raise the reply limit to the Premium long-post cap (default up to 25000)")
    .option("--dry-run", "Only generate content; do not open the browser")
    .option("--inspect", "Headful browser so a human can watch/calibrate selectors")
    .option("--force", "Re-stage even if a reply to this tweet was already recorded in the ledger")
    .action(async (opts: ReplyXOptions) => {
      // Resolve content (inline --text or --from file/stdin) up front so a usage
      // error fails fast before we touch the browser or the ledger.
      const md = resolveContentInput(opts);

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

      // WRITE-DEDUP (issue #10): a reply is a write, so it gets its own
      // idempotency guarantee independent of the read-path SeenStore. Refuse to
      // re-stage a reply to a tweet already in the ledger unless --force. In
      // --dry-run we only WARN (nothing is staged, so nothing to prevent).
      const ledger = new ReplyLedger();
      const prior = ledger.find(replyToId);
      if (prior && !opts.force) {
        if (opts.dryRun) {
          console.log(
            `[note] A reply to ${replyToId} was already staged at ${prior.stagedAt} ` +
              `(status: ${prior.status}). A real run would refuse without --force.\n`,
          );
        } else {
          ledger.close();
          console.error(
            `✗ Already staged a reply to ${replyToId} at ${prior.stagedAt} (status: ${prior.status}).\n` +
              "  Refusing to stage a duplicate reply. Re-run with --force to override.",
          );
          process.exit(2);
          return;
        }
      }

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
        ledger.close();
        console.log(`\n[dry-run] No browser touched. Would stage the above as a reply to ${replyToId}.`);
        process.exit(0);
      }

      const { stageReplyDraft } = await import("../x/draftPoster.js");
      try {
        const result = await stageReplyDraft(content, opts.to, { inspect: opts.inspect });
        // Record in the ledger ONLY after a successful stage, so a crash before
        // this point leaves the tweet re-stageable (idempotent at the action).
        ledger.record(result.replyToId, {
          status: result.verified ? "staged" : "staged-unverified",
        });
        ledger.close();
        const count = result.format === "thread" ? `${result.posts} posts` : "1 reply";
        console.log(
          `\n✓ Staged a NATIVE X reply draft (${result.format}, ${count}) to ${result.replyToId}. NEVER posted.\n` +
            `  verified in Unsent/Drafts: ${result.verified ? "yes" : "unconfirmed"}\n` +
            `  ${result.note}`,
        );
        process.exit(0);
      } catch (err) {
        ledger.close();
        console.error(`\n✗ Failed to stage the X reply draft: ${(err as Error).message}`);
        console.error(
          "  Composer selectors may need live calibration — re-run with --inspect to watch the DOM.",
        );
        process.exit(1);
      }
    });
}

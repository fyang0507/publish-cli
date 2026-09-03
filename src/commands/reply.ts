import { Command } from "commander";
import {
  generateContent,
  renderForInspection,
  type GeneratedContent,
} from "../x/content.js";
import {
  extractTweetId,
  isLocalValidationError,
} from "../capabilities/validation.js";
import { resolveContentInputDetails, splitLeadingFrontmatter } from "./contentInput.js";

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
 *   3. --dry-run: generate + print ONLY; do NOT open the reply ledger or touch
 *      browser/profile/database state. Duplicate-ledger preflight is deferred.
 *   4. Otherwise: check the reply ledger, then drive the persistent logged-in
 *      profile to stage the reply draft when the target is not a duplicate (or
 *      --force explicitly overrides it).
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
    .option("--from <base.md>", "Canonical markdown ('-' = stdin); strips leading mapping/empty YAML frontmatter")
    .option("--long", "Use the local 25,000-code-point guard for Premium long replies; X acceptance is server-authoritative")
    .option("--dry-run", "Locally validate syntax/content, generate, and render; skips browser and duplicate ledger")
    .option("--inspect", "Headful browser so a human can watch/calibrate selectors")
    .option("--force", "Real runs only: re-stage even if a reply to this tweet was already recorded in the ledger")
    .addHelpText(
      "after",
      "\nFile/stdin frontmatter:\n" +
        "  A leading empty or YAML mapping block between --- delimiters is metadata only and is removed.\n" +
        "  Metadata keys are ignored; reply text comes only from the normalized Markdown body.\n" +
        "  BOM and LF/CRLF/lone-CR delimiters are recognized; mapping-intent malformed or unterminated metadata exits 2.\n" +
        "  Valid scalar/sequence blocks and thematic-break prose remain literal Markdown apart from a leading transport BOM.\n" +
        "  Inline --text is always literal and is never interpreted as frontmatter.\n" +
        "\nDry-run behavior:\n" +
        "  --dry-run skips the duplicate ledger and all browser/profile/database state.\n" +
        "  Target ID/URL validation is syntax-only; existence, visibility, and reply eligibility remain unverified until a real run reaches X.\n" +
        "  A real run still checks the ledger and may refuse a recorded target unless --force is supplied.\n",
    )
    .action(async (opts: ReplyXOptions) => {
      // Resolve content (inline --text or --from file/stdin) up front so a usage
      // error fails fast before we touch the browser or the ledger.
      let md: string;
      let sourceLineOffset = 0;
      try {
        const input = resolveContentInputDetails(opts);
        md = input.markdown;
        if (input.kind !== "text") {
          const sourceName = input.kind === "stdin"
            ? "stdin (--from -)"
            : (input.sourcePath ?? "--from input");
          const split = splitLeadingFrontmatter(md, sourceName, {
            policy: "mapping-only",
            preserveBodyLineEndings: true,
          });
          md = split.body;
          sourceLineOffset = split.bodyLineOffset;
        }
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        console.error(error.message);
        process.exit(2);
      }

      // Resolve/validate the target id in the dependency-light validation layer.
      let replyToId: string;
      try {
        replyToId = extractTweetId(opts.to);
      } catch (err) {
        console.error(`Invalid --to: ${(err as Error).message}`);
        process.exit(2);
        return;
      }

      // DETERMINISTIC generation. A reply is a single tweet by default; if the
      // content overflows the limit, fall back to a thread so nothing is dropped.
      let content: GeneratedContent;
      let overflowed = false;
      try {
        content = await generateContent(md, {
          format: "tweet",
          long: opts.long,
          sourceLineOffset,
        });
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        if (error.problem.code !== "x_text_too_long") {
          console.error(error.message);
          process.exit(2);
        }
        overflowed = true;
        try {
          content = await generateContent(md, {
            format: "thread",
            long: opts.long,
            sourceLineOffset,
          });
        } catch (threadError) {
          if (!isLocalValidationError(threadError)) throw threadError;
          console.error(threadError.message);
          process.exit(2);
        }
      }
      if (overflowed) {
        console.log(
          `[note] Reply content exceeds the single-post limit — generated a ${content.thread?.length ?? 0}-post reply thread without truncating the normalized reply prose.`,
        );
      }

      console.log(`Replying to tweet ${replyToId}:\n`);
      console.log(renderForInspection(content));

      // A valid dry-run is deliberately state-free. In particular, return
      // BEFORE importing db.js: that module loads better-sqlite3 and constructing
      // ReplyLedger creates profile/data-repository directories plus publish.db.
      // The real run below remains authoritative for duplicate prevention.
      if (opts.dryRun) {
        console.log(
          `\n[dry-run] Local content validation and generation passed for syntactically valid reply target ${replyToId}. No draft was staged.\n` +
            "  No browser opened; no profile, data-repository, or SQLite runtime state was read or written.\n" +
            "  Target ID/URL syntax was validated locally. Target existence, visibility, and reply eligibility were not " +
            "verified; X remains authoritative for those checks during a real run.\n" +
            "  Duplicate-ledger preflight was skipped. A real run checks the ledger before staging and may " +
            "refuse a recorded target unless --force is explicitly supplied.",
        );
        process.exit(0);
      }

      // WRITE-DEDUP (issue #10): validation above completes before durable state
      // is opened. Refuse an intentional duplicate unless --force.
      const { ReplyLedger } = await import("../db.js");
      const ledger = new ReplyLedger();
      const prior = ledger.find(replyToId);
      if (prior && !opts.force) {
        ledger.close();
        console.error(
          `✗ Already staged a reply to ${replyToId} at ${prior.stagedAt} (status: ${prior.status}).\n` +
            "  Refusing to stage a duplicate reply. Re-run with --force to override.",
        );
        process.exit(2);
        return;
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

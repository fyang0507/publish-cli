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
import type { ReplyLedgerEntry } from "../db.js";
import type { StageReplyResult } from "../x/draftPoster.js";

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

export interface ReplyLedgerPort {
  find(targetTweetId: string): ReplyLedgerEntry | undefined;
  record(
    targetTweetId: string,
    opts?: { status?: string; draftRef?: string | null },
  ): void;
  close(): void;
}

export interface ReplyRealRunDependencies {
  openLedger(): Promise<ReplyLedgerPort>;
  loadStageReplyDraft(): Promise<(
    content: GeneratedContent,
    targetIdOrUrl: string,
    opts: { inspect?: boolean },
  ) => Promise<StageReplyResult>>;
}

export interface ReplyRealRunInput {
  content: GeneratedContent;
  targetIdOrUrl: string;
  replyToId: string;
  inspect?: boolean;
  force?: boolean;
}

export interface ReplyRealRunOutcome {
  kind:
    | "duplicate"
    | "ledger_preflight_failed"
    | "stage_runtime_failed"
    | "stage_result_inconclusive"
    | "native_stage_failed"
    | "ledger_persistence_failed"
    | "staged";
  exitCode: 0 | 1 | 2;
  stream: "stdout" | "stderr";
  message: string;
}

function duplicateOutcome(prior: ReplyLedgerEntry): ReplyRealRunOutcome {
  return {
    kind: "duplicate",
    exitCode: 2,
    stream: "stderr",
    message:
      `✗ Already staged a reply to ${prior.targetTweetId} at ${prior.stagedAt} (status: ${prior.status}).\n` +
      "  Refusing to stage a duplicate reply. Re-run with --force to override.",
  };
}

function ledgerPreflightFailure(phase: "open" | "find"): ReplyRealRunOutcome {
  const action = phase === "open" ? "open" : "read";
  return {
    kind: "ledger_preflight_failed",
    exitCode: 1,
    stream: "stderr",
    message:
      `\n✗ Could not ${action} the X reply duplicate ledger. No native staging was attempted.\n` +
      "  Repair the local durable state before retrying; the duplicate guard could not run.",
  };
}

function nativeStageFailure(error: unknown): ReplyRealRunOutcome {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    kind: "native_stage_failed",
    exitCode: 1,
    stream: "stderr",
    message:
      `\n✗ Failed to stage the X reply draft: ${detail}\n` +
      "  Composer selectors may need live calibration — re-run with --inspect to watch the DOM.",
  };
}

function stageRuntimeFailure(): ReplyRealRunOutcome {
  return {
    kind: "stage_runtime_failed",
    exitCode: 1,
    stream: "stderr",
    message:
      "\n✗ Could not initialize the X reply staging runtime. No native staging was attempted.\n" +
      "  Verify the local installation and runtime dependencies before retrying.",
  };
}

function stageResultInconclusive(replyToId: string): ReplyRealRunOutcome {
  return {
    kind: "stage_result_inconclusive",
    exitCode: 1,
    stream: "stderr",
    message:
      `\n✗ X reply staging returned no usable result for target ${replyToId} (NEVER posted).\n` +
      "  The native draft may exist, and no reply-ledger record was written.\n" +
      "  Do not retry automatically. Before any retry, compare X Unsent/Drafts manually in the same CLI-owned profile.",
  };
}

function ledgerPersistenceFailure(
  result: StageReplyResult,
  phase: "record" | "close",
): ReplyRealRunOutcome {
  const draftState = result.verified
    ? "The native draft was verified in X Unsent/Drafts"
    : "The native draft may exist";
  const ledgerState = phase === "record"
    ? "its reply-ledger record could not be confirmed"
    : "the reply ledger did not close cleanly after its record was written";
  const failureKind = phase === "record" ? "persistence" : "cleanup";
  return {
    kind: "ledger_persistence_failed",
    exitCode: 1,
    stream: "stderr",
    message:
      `\n✗ X reply ledger ${failureKind} failed after the native staging flow returned for target ${result.replyToId} (NEVER posted).\n` +
      `  ${draftState}, but ${ledgerState}.\n` +
      "  Do not retry automatically. Before any retry, compare X Unsent/Drafts manually in the same CLI-owned profile.",
  };
}

function stagedOutcome(result: StageReplyResult): ReplyRealRunOutcome {
  const count = result.format === "thread" ? `${result.posts} posts` : "1 reply";
  return {
    kind: "staged",
    exitCode: 0,
    stream: "stdout",
    message:
      `\n✓ Staged a NATIVE X reply draft (${result.format}, ${count}) to ${result.replyToId}. NEVER posted.\n` +
      `  verified in Unsent/Drafts: ${result.verified ? "yes" : "unconfirmed"}\n` +
      `  ${result.note}`,
  };
}

function withLedgerCloseFailure(outcome: ReplyRealRunOutcome): ReplyRealRunOutcome {
  if (outcome.kind === "staged") {
    throw new Error("A staged outcome requires its StageReplyResult before close-failure classification.");
  }
  if (outcome.kind === "ledger_persistence_failed") {
    return {
      ...outcome,
      message: `${outcome.message}\n  Closing the reply ledger also failed; cleanup was attempted once and was not retried.`,
    };
  }
  if (outcome.kind === "duplicate") {
    const duplicateFact = outcome.message.split("\n", 1)[0];
    return {
      ...outcome,
      exitCode: 1,
      message:
        `${duplicateFact}\n` +
        "  No new native staging was attempted, but the reply ledger failed to close.\n" +
        "  Repair the local durable state before any retry; do not bypass an unhealthy ledger with --force.",
    };
  }
  if (outcome.kind === "native_stage_failed") {
    const stageFact = outcome.message.split("\n").slice(0, 2).join("\n");
    return {
      ...outcome,
      message:
        `${stageFact}\n` +
        "  The reply ledger also failed to close after the native staging failure.\n" +
        "  Repair durable state before retrying. Use --inspect later only if the native error specifically indicates composer selector drift.",
    };
  }
  return {
    ...outcome,
    exitCode: 1,
    message: `${outcome.message}\n  The reply ledger also failed to close; repair durable state before retrying.`,
  };
}

/**
 * Run the stateful portion of `publish x reply` behind injected ledger and X
 * ports. The command's validation/render-only dry-run returns before calling
 * this seam, preserving #57's zero-state and dependency-light boundary.
 */
export async function executeReplyRealRun(
  input: ReplyRealRunInput,
  deps: ReplyRealRunDependencies,
): Promise<ReplyRealRunOutcome> {
  let ledger: ReplyLedgerPort;
  try {
    ledger = await deps.openLedger();
  } catch {
    return ledgerPreflightFailure("open");
  }

  let outcome: ReplyRealRunOutcome | undefined;
  let stageResult: StageReplyResult | undefined;
  let closeFailed = false;
  try {
    let prior: ReplyLedgerEntry | undefined;
    try {
      prior = ledger.find(input.replyToId);
    } catch {
      outcome = ledgerPreflightFailure("find");
    }

    if (!outcome && prior && !input.force) {
      outcome = duplicateOutcome(prior);
    }

    if (!outcome) {
      let stageReplyDraft:
        | Awaited<ReturnType<ReplyRealRunDependencies["loadStageReplyDraft"]>>
        | undefined;
      try {
        stageReplyDraft = await deps.loadStageReplyDraft();
      } catch {
        outcome = stageRuntimeFailure();
      }

      if (!outcome && typeof stageReplyDraft !== "function") {
        outcome = stageRuntimeFailure();
      } else if (stageReplyDraft) {
        try {
          const result = await stageReplyDraft(input.content, input.targetIdOrUrl, {
            inspect: input.inspect,
          });
          if (result) stageResult = result;
          else outcome = stageResultInconclusive(input.replyToId);
        } catch (error) {
          outcome = nativeStageFailure(error);
        }
      }
    }

    if (!outcome && stageResult) {
      try {
        // Attempt durable write-dedup only after the native staging flow returns.
        ledger.record(stageResult.replyToId, {
          status: stageResult.verified ? "staged" : "staged-unverified",
        });
        outcome = stagedOutcome(stageResult);
      } catch {
        outcome = ledgerPersistenceFailure(stageResult, "record");
      }
    }
  } finally {
    try {
      ledger.close();
    } catch {
      closeFailed = true;
    }
  }

  if (!outcome) return stageResultInconclusive(input.replyToId);
  if (!closeFailed) return outcome;
  if (stageResult && outcome.kind === "staged") {
    return ledgerPersistenceFailure(stageResult, "close");
  }
  return withLedgerCloseFailure(outcome);
}

const productionReplyRealRunDependencies: ReplyRealRunDependencies = {
  async openLedger() {
    const { ReplyLedger } = await import("../db.js");
    return new ReplyLedger();
  },
  async loadStageReplyDraft() {
    const { stageReplyDraft } = await import("../x/draftPoster.js");
    return stageReplyDraft;
  },
};

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
        "  A real run still checks the ledger and may refuse a recorded target unless --force is supplied.\n" +
        "\nReal-run ledger recovery:\n" +
        "  If native staging returns but reply-ledger record/close fails, exit 1; the draft may exist.\n" +
        "  Before any retry, compare X Unsent/Drafts manually in the same CLI-owned profile.\n" +
        "  --inspect and selector calibration cannot repair a reply-ledger failure.\n",
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

      const outcome = await executeReplyRealRun(
        {
          content,
          targetIdOrUrl: opts.to,
          replyToId,
          inspect: opts.inspect,
          force: opts.force,
        },
        productionReplyRealRunDependencies,
      );
      if (outcome.stream === "stdout") console.log(outcome.message);
      else console.error(outcome.message);
      process.exit(outcome.exitCode);
    });
}

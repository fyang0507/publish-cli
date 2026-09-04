import { Command } from "commander";
import {
  resolveContentInputDetails,
  splitLeadingFrontmatter,
  type ContentInputOptions,
} from "./contentInput.js";
import {
  generateSelfPost,
  prepareRedditSelfPost,
  preflightSelfPost,
  validateRedditFrontmatter,
  type GeneratedSelfPost,
} from "../reddit/content.js";
import {
  isLocalValidationError,
  LocalValidationError,
  type LocalValidationProblem,
} from "../capabilities/validation.js";
import type { StageDraftResult } from "../reddit/draftPoster.js";
import {
  TerminalOutputBudget,
  TerminalProjectionError,
  createClosedSnapshotContext,
  emitTerminalOutput,
  isTerminalProjectionError,
  projectTerminalText,
  renderTerminalBlock,
  renderTerminalErrorMessage,
  renderTerminalInline,
  snapshotBoolean,
  snapshotBoundedString,
  snapshotClosedRecord,
  terminalProjectionFailureMessage,
} from "../terminalOutput.js";
import {
  createDryRunReceipt,
  createLocalInputFailureReceipt,
  createTransportReceipt,
  emitTransportReceipt,
  NO_ASSETS,
  NOT_REACHED_LIVE_VALIDATION,
  PASSED_LOCAL_VALIDATION,
  type TransportReceipt,
} from "../transportReceipt.js";

/**
 * `publish reddit draft` — owned-content publisher for the Reddit channel
 * (REDDIT_DESIGN §2 / §5). Stages a NATIVE self-post DRAFT ("Save Draft") and
 * STOPS THERE. It MUST NOT publish/Post (the send-gate is future scope,
 * PRODUCT_SPEC §5, not built here).
 *
 * Flow:
 *   1. Resolve the body — inline --text, or a canonical base markdown via --from
 *      ('-' = stdin). Exactly one of the two (shared resolveContentInput; exit 2
 *      on usage errors). Reddit is long-form, so --from is the primary path.
 *   2. DETERMINISTIC generation (src/reddit/content.ts; plain code, no LLM):
 *      title (≤300) + Markdown body kept ~verbatim (≤~40k). --subreddit/--title/
 *      --flair may come from --from frontmatter, with the flags overriding.
 *   3. --dry-run: stop after deterministic local validation — no browser or live
 *      subreddit preflight.
 *   4. Real run only: reader-backed SUBREDDIT PREFLIGHT (§4) fetches the target's
 *      about + flairs + post_requirements through the authenticated context.
 *      Violations → exit 1 before composer staging.
 *   5. Otherwise: drive the composer and SAVE A NATIVE DRAFT — never Post. An
 *      eligibility block (karma/age/approved-submitters/ban; §4.1) is reported
 *      plainly rather than failing opaquely, and never falls through to Post.
 *
 * There is intentionally NO --media (self-post only this phase, §8).
 */
interface RedditDraftOptions extends ContentInputOptions {
  subreddit?: string;
  title?: string;
  flair?: string;
  nsfw?: boolean;
  spoiler?: boolean;
  dryRun?: boolean;
  inspect?: boolean;
  json?: boolean;
}

export interface RedditStageCommandOutcome {
  exitCode: 0 | 1;
  stream: "stdout" | "stderr";
  message: string;
  saveStatus: "not_attempted" | "delivery_unknown" | "unconfirmed" | "toast_confirmed";
  platformTouched: true;
  blocked: boolean;
  flair: string | null;
}

/** Keep save-confirmation truth and exit semantics independent of browser code. */
export function classifyRedditStageResult(
  value: StageDraftResult,
  expectedSubreddit?: string,
): RedditStageCommandOutcome {
  const context = createClosedSnapshotContext();
  const result = snapshotClosedRecord(
    value,
    ["kind", "saveStatus", "saved", "verified", "subreddit", "note"],
    ["flair", "blocked"],
    context,
    (reader) => {
      if (reader.read("kind") !== "self") throw new TerminalProjectionError();
      const saveStatus = reader.read("saveStatus");
      if (saveStatus !== "not_attempted" && saveStatus !== "delivery_unknown" && saveStatus !== "unconfirmed" && saveStatus !== "toast_confirmed") {
        throw new TerminalProjectionError();
      }
      const saved = snapshotBoolean(reader.read("saved"));
      const verified = snapshotBoolean(reader.read("verified"));
      const subreddit = snapshotBoundedString(reader.read("subreddit"), 25_000_000, context);
      if (expectedSubreddit !== undefined && subreddit !== expectedSubreddit) {
        throw new TerminalProjectionError();
      }
      const note = snapshotBoundedString(reader.read("note"), 25_000_000, context);
      const flair = reader.has("flair") && reader.read("flair") !== undefined
        ? snapshotBoundedString(reader.read("flair"), 25_000_000, context)
        : undefined;
      const blocked = reader.has("blocked") && reader.read("blocked") !== undefined
        ? snapshotBoundedString(reader.read("blocked"), 25_000_000, context)
        : undefined;
      return Object.freeze({
        kind: "self" as const,
        saveStatus,
        saved,
        verified,
        subreddit,
        ...(reader.has("flair") ? { flair } : {}),
        ...(reader.has("blocked") ? { blocked } : {}),
        note,
      });
    },
  );
  if (
    (result.saveStatus === "not_attempted" && (result.saved || result.verified)) ||
    ((result.saveStatus === "delivery_unknown" || result.saveStatus === "unconfirmed") &&
      (!result.saved || result.verified)) ||
    (result.saveStatus === "toast_confirmed" && (!result.saved || !result.verified)) ||
    (result.blocked !== undefined && result.saveStatus !== "not_attempted")
  ) {
    throw new TerminalProjectionError();
  }
  const safeSubreddit = renderTerminalInline(projectTerminalText(
    expectedSubreddit ?? result.subreddit,
    { lineMode: "inline" },
  ));
  const safeNote = renderTerminalInline(projectTerminalText(result.note, { lineMode: "inline" }));
  if (result.blocked) {
    const blocked = renderTerminalInline(projectTerminalText(result.blocked, { lineMode: "inline" }));
    return {
      exitCode: 1, stream: "stderr", message: `\n✗ ${blocked}`,
      saveStatus: result.saveStatus, platformTouched: true, blocked: true, flair: result.flair ?? null,
    };
  }
  if (result.saveStatus === "not_attempted" || !result.saved) {
    return {
      exitCode: 1,
      stream: "stderr",
      message:
        `\n✗ No Reddit draft was confirmed for r/${safeSubreddit} (NEVER posted).\n` +
        `  ${safeNote}`,
      saveStatus: result.saveStatus,
      platformTouched: true,
      blocked: false,
      flair: result.flair ?? null,
    };
  }
  if (result.saveStatus === "delivery_unknown" || result.saveStatus === "unconfirmed" || !result.verified) {
    return {
      exitCode: 1,
      stream: "stderr",
      message:
        `\n✗ Reddit draft state for r/${safeSubreddit} is UNCONFIRMED (NEVER posted).\n` +
        `  ${safeNote}`,
      saveStatus: result.saveStatus,
      platformTouched: true,
      blocked: false,
      flair: result.flair ?? null,
    };
  }
  return {
    exitCode: 0,
    stream: "stdout",
    message:
      `\n✓ Staged a NATIVE Reddit draft (self-post) to r/${safeSubreddit}. NEVER posted.\n` +
      "  verified by Draft saved toast: yes\n" +
      (result.flair
        ? `  flair: ${renderTerminalInline(projectTerminalText(result.flair, { lineMode: "inline" }))}\n`
        : "") +
      `  ${safeNote}`,
    saveStatus: result.saveStatus,
    platformTouched: true,
    blocked: false,
    flair: result.flair ?? null,
  };
}

export function receiptForRedditStageOutcome(
  outcome: RedditStageCommandOutcome,
  warnings: readonly string[] = [],
): Readonly<TransportReceipt> {
  const verified = outcome.saveStatus === "toast_confirmed" && outcome.exitCode === 0;
  // A non-blocked not_attempted result is returned only after the composer was
  // populated and the explicit Save Draft affordance could not be resolved.
  // Preserve the existing duplicate-risk boundary: absence of a click is not
  // proof that Reddit retained no draft/composer state.
  const preparedComposerUncertain = outcome.saveStatus === "not_attempted" && !outcome.blocked;
  const draftPossible = preparedComposerUncertain ||
    outcome.saveStatus === "delivery_unknown" || outcome.saveStatus === "unconfirmed";
  return createTransportReceipt({
    channel: "reddit",
    action: "draft",
    format: "self_post",
    mode: "real",
    validation: {
      local: PASSED_LOCAL_VALIDATION,
      live: outcome.blocked
        ? { status: "failed", problems: [], notes: ["The live composer surfaced an eligibility block."] }
        : verified
          ? { status: "passed", problems: [], notes: [] }
          : {
              status: "failed",
              problems: [],
              notes: [
                "The authenticated subreddit preflight passed, but the native save was not positively confirmed.",
              ],
            },
    },
    warnings,
    gotchas: draftPossible
      ? ["A Reddit draft may exist. Compare DRAFTS in the same CLI-owned profile and do not blindly restage because another attempt can duplicate it."]
      : [],
    assets: NO_ASSETS,
    platformTouched: outcome.platformTouched,
    terminalState: verified
      ? "native_draft_verified"
      : draftPossible
        ? "native_draft_possible"
        : outcome.blocked ? "platform_rejected" : "no_native_draft",
    verification: {
      status: verified ? "verified" : "unverified",
      strength: verified ? "platform_signal" : "none",
      nativeReference: null,
    },
    remoteResidue: draftPossible
      ? [
        ...(preparedComposerUncertain ? [{
          kind: "composer" as const,
          state: "prepared_composer_save_not_attempted",
          assetIndex: null,
          reference: null,
          retryRisk: "duplicate" as const,
        }] : []),
        {
          kind: "native_draft",
          state: outcome.saveStatus,
          assetIndex: null,
          reference: null,
          retryRisk: "duplicate",
        }]
      : [],
    error: verified ? null : {
      source: "platform",
      stage: outcome.blocked ? "composer_eligibility" : "save_draft",
      code: outcome.blocked ? "reddit_eligibility_blocked" : `reddit_${outcome.saveStatus}`,
      httpStatus: null,
      sanitizedMessage: outcome.blocked
        ? "Reddit blocked this draft in the live composer."
        : "Reddit did not provide positive save confirmation for this attempt.",
      classification: outcome.saveStatus === "delivery_unknown" ? "unknown" : "known",
      retryable: null,
      inputRelated: outcome.blocked ? null : false,
      suggestedCorrection: draftPossible
        ? "Inspect Reddit DRAFTS manually in the same CLI-owned profile before deciding whether a separate retry is safe."
        : outcome.blocked
          ? "Review the subreddit eligibility requirements before a separate attempt."
          : "Calibrate the Save Draft affordance before a separate attempt.",
    },
    exit: {
      class: verified ? "success" : "runtime_or_platform_failure",
      code: outcome.exitCode,
    },
  });
}

export function registerRedditDraftCommand(reddit: Command): void {
  reddit
    .command("draft")
    .description("Stage a NATIVE Reddit self-post draft from inline text or a markdown file — never posts")
    .option("--subreddit <name>", "Target subreddit (or from --from frontmatter)")
    .option("--title <title>", "Post title, ≤300 chars (or from frontmatter / markdown H1)")
    .option("--text <content>", "Body content inline (exactly one of --text / --from)")
    .option(
      "--from <base.md>",
      "Canonical markdown file ('-' = stdin); accepts frontmatter keys subreddit/title/flair",
    )
    .option("--flair <id|text>", "Flair template id, or text matched to a template")
    .option("--nsfw", "Mark the post NSFW (flag-only; not accepted in frontmatter)")
    .option("--spoiler", "Mark the post as a spoiler (flag-only; not accepted in frontmatter)")
    .option("--dry-run", "Generate and validate locally; skips live subreddit preflight and composer")
    .option("--inspect", "Headful browser so a human can watch/calibrate selectors")
    .option("--json", "Emit one versioned machine-readable transport receipt")
    .addHelpText(
      "after",
      "\nFile/stdin frontmatter:\n" +
        "  Accepted keys: subreddit, title, flair (string values). Flags override metadata.\n" +
        "  Empty --subreddit/--title values reject; empty --flair intentionally clears metadata.\n" +
        "  Empty mappings are accepted; unsupported/malformed mapping metadata exits 2.\n" +
        "  BOM and LF/CRLF/lone-CR delimiters are recognized; unterminated metadata exits 2.\n" +
        "  For an unclosed opener, only the first substantive block establishes mapping intent.\n" +
        "  Valid scalar/sequence blocks remain literal Markdown. Inline --text is always literal.\n" +
        "\nMarkdown portability:\n" +
        "  Use 4-space-indented code for old/new Reddit portability. Tables should use outer pipes.\n" +
        "  Inline body images are not uploaded or verified by this text-only draft command.\n" +
        "  Real runs require the Draft saved toast to be absent before the one Save Draft click.\n" +
        "  If a fresh toast is not observed, exit 1 and compare DRAFTS manually in the same\n" +
        "  CLI-owned profile. Never blindly retry (duplicate risk; no draft idempotency ledger).\n",
    )
    .action(async (opts: RedditDraftOptions) => {
      const output = new TerminalOutputBudget();
      const emit = (stream: "stdout" | "stderr", message: string) =>
        emitTerminalOutput(output, stream, message);
      const emitLocalFailure = (problem: LocalValidationProblem, message: string) => {
        emitTransportReceipt(createLocalInputFailureReceipt({
          channel: "reddit",
          action: "draft",
          format: "self_post",
          mode: opts.dryRun ? "dry_run" : "real",
          problem,
          message,
        }), { json: !!opts.json, budget: output });
      };
      let md: string;
      let frontmatter = {};
      let bodyLineOffset = 0;
      try {
        const input = resolveContentInputDetails(opts);
        md = input.markdown;
        if (input.kind !== "text") {
          const sourceName = input.kind === "stdin" ? "stdin (--from -)" : (input.sourcePath ?? "--from input");
          const split = splitLeadingFrontmatter(md, sourceName, {
            policy: "mapping-only",
            preserveBodyLineEndings: true,
          });
          md = split.body;
          frontmatter = validateRedditFrontmatter(split.data, sourceName);
          bodyLineOffset = split.bodyLineOffset;
        }
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        emitLocalFailure(error.problem, error.message);
        process.exit(2);
      }

      // DETERMINISTIC generation (no LLM). Throws on missing / oversized title —
      // treat as a usage error (exit 2), same tier as resolveContentInput.
      let post: GeneratedSelfPost;
      let inspection: string;
      try {
        const prepared = prepareRedditSelfPost(generateSelfPost(md, {
          subreddit: opts.subreddit,
          title: opts.title,
          flair: opts.flair,
          nsfw: opts.nsfw,
          spoiler: opts.spoiler,
          frontmatter,
          bodyLineOffset,
        }));
        post = prepared.post;
        inspection = prepared.inspection;
      } catch (error) {
        if (!isLocalValidationError(error) && !isTerminalProjectionError(error)) throw error;
        if (isLocalValidationError(error)) emitLocalFailure(error.problem, error.message);
        else emitLocalFailure({
          phase: "local", code: "terminal_projection_failed", field: "text",
          actual: "unsafe_or_oversized", expected: "bounded Unicode-scalar terminal evidence",
          unit: "utf16_code_units",
        }, terminalProjectionFailureMessage());
        process.exit(2);
      }

      // Always show the generated post + advisory flags to the operator.
      try {
        if (!opts.json) emit("stdout", inspection);
      } catch {
        emitLocalFailure({
          phase: "local", code: "terminal_projection_failed", field: "text",
          actual: "unsafe_or_oversized", expected: "bounded Unicode-scalar terminal evidence",
          unit: "utf16_code_units",
        }, terminalProjectionFailureMessage());
        process.exit(2);
      }

      const subreddit = post.subreddit;
      if (!subreddit) {
        const error = new LocalValidationError(
          "No target subreddit. Provide --subreddit <name> or a `subreddit:` frontmatter key.",
          {
            code: "reddit_subreddit_missing",
            field: "target",
            actual: null,
            expected: "non-empty --subreddit or subreddit frontmatter",
            unit: null,
          },
        );
        emitLocalFailure(error.problem, error.message);
        process.exit(2);
      }
      let terminalSubreddit: string;
      try {
        terminalSubreddit = renderTerminalInline(projectTerminalText(subreddit, { lineMode: "inline" }));
      } catch {
        emitLocalFailure({
          phase: "local", code: "terminal_projection_failed", field: "target",
          actual: "unsafe_or_oversized", expected: "bounded Unicode-scalar subreddit",
          unit: "utf16_code_units",
        }, terminalProjectionFailureMessage());
        process.exit(2);
      }

      // --dry-run is BROWSER-FREE: stop after deterministic generation + the local
      // advisories already printed above. The reader-backed subreddit preflight (§4)
      // needs the authenticated browser context, so it is intentionally deferred to
      // the real run — dry-run never launches a browser or requires credentials.
      if (opts.dryRun) {
        emitTransportReceipt(createDryRunReceipt({
          channel: "reddit",
          action: "draft",
          format: "self_post",
          warnings: post.warnings,
          gotchas: [
            "The authenticated subreddit rules/flair/title/body/type preflight was skipped.",
            "Inline body images are not uploaded or verified by this text-only command.",
          ],
          liveNotes: ["The authenticated subreddit preflight and native composer were intentionally skipped."],
        }), { json: !!opts.json, budget: output });
        process.exit(0);
      }

      let finalReceipt: Readonly<TransportReceipt> | null = null;
      let closeSession: (() => Promise<void>) | null = null;
      let platformTouched = false;
      let stageInvoked = false;
      try {
        const readerModule = await import("../reddit/reader.js");
        const sessionModule = await import("../reddit/session.js");
        const { env } = await import("../config.js");
        closeSession = sessionModule.closeSession;
        const headful = !!opts.inspect || env.REDDIT_READS_HEADFUL;
        const reader = new readerModule.BrowserRedditReader({ inspect: headful });
        platformTouched = true;
        await reader.init();

        const [about, flairs, postRequirements] = await Promise.all([
          reader.fetchAbout(subreddit),
          reader.fetchFlairs(subreddit),
          reader.fetchPostRequirements(subreddit),
        ]);
        const preflight = preflightSelfPost(post, { about, postRequirements, flairs });

        if (!preflight.ok) {
          finalReceipt = createTransportReceipt({
            channel: "reddit", action: "draft", format: "self_post", mode: "real",
            validation: {
              local: PASSED_LOCAL_VALIDATION,
              live: { status: "failed", problems: [], notes: preflight.violations },
            },
            warnings: [...post.warnings, ...preflight.warnings],
            gotchas: [], assets: NO_ASSETS, platformTouched: true,
            terminalState: "platform_rejected",
            verification: { status: "unverified", strength: "none", nativeReference: null },
            remoteResidue: [],
            error: {
              source: "platform", stage: "subreddit_preflight", code: "reddit_preflight_rejected",
              httpStatus: null, sanitizedMessage: "The live subreddit preflight rejected this draft.",
              classification: "known", retryable: null, inputRelated: null,
              suggestedCorrection: "Review the structured live-validation notes and correct the input without an automatic retry.",
            },
            exit: { class: "runtime_or_platform_failure", code: 1 },
          });
        } else {
          const { stageDraft } = await import("../reddit/draftPoster.js");
          stageInvoked = true;
          const result = await stageDraft(post, {
            inspect: headful,
            flairId: preflight.resolvedFlair?.id,
            flairText: preflight.resolvedFlair?.text,
          });
          const outcome = classifyRedditStageResult(result, subreddit);
          finalReceipt = receiptForRedditStageOutcome(
            outcome,
            [...post.warnings, ...preflight.warnings],
          );
        }
      } catch {
        const nativeStateUnknown = stageInvoked;
        finalReceipt = createTransportReceipt({
          channel: "reddit", action: "draft", format: "self_post", mode: "real",
          validation: {
            local: PASSED_LOCAL_VALIDATION,
            live: platformTouched
              ? { status: "failed", problems: [], notes: ["The live Reddit operation did not complete."] }
              : NOT_REACHED_LIVE_VALIDATION,
          },
          warnings: post.warnings,
          gotchas: nativeStateUnknown
            ? ["A native Reddit draft may exist. Compare DRAFTS in the same CLI-owned profile and do not blindly retry."]
            : [],
          assets: NO_ASSETS,
          platformTouched,
          terminalState: nativeStateUnknown ? "native_draft_possible" : "no_native_draft",
          verification: { status: "unverified", strength: "none", nativeReference: null },
          remoteResidue: nativeStateUnknown
            ? [{ kind: "native_draft", state: "stage_result_unknown", assetIndex: null, reference: null, retryRisk: "duplicate" }]
            : [],
          error: {
            source: platformTouched ? "platform" : "runtime",
            stage: stageInvoked ? "native_stage_result" : "reddit_runtime_initialization",
            code: stageInvoked ? "reddit_stage_result_unknown" : "reddit_runtime_unavailable",
            httpStatus: null,
            sanitizedMessage: stageInvoked
              ? "Reddit staging was invoked but did not produce a usable closed result."
              : "The Reddit runtime or live preflight could not complete.",
            classification: "unknown", retryable: null, inputRelated: null,
            suggestedCorrection: nativeStateUnknown
              ? "Inspect Reddit DRAFTS manually in the same CLI-owned profile before deciding whether a separate retry is safe."
              : "Resolve the runtime or live preflight failure before a separate attempt.",
          },
          exit: { class: "runtime_or_platform_failure", code: 1 },
        });
      } finally {
        if (closeSession !== null) {
          try {
            await closeSession();
          } catch {
            if (finalReceipt?.exit.code === 0) {
              finalReceipt = createTransportReceipt({
                channel: "reddit", action: "draft", format: "self_post", mode: "real",
                validation: finalReceipt.validation,
                warnings: finalReceipt.warnings,
                gotchas: ["The native draft verified, but the local browser-session cleanup did not complete."],
                assets: finalReceipt.assets,
                platformTouched: true,
                terminalState: "native_draft_verified",
                verification: finalReceipt.verification,
                remoteResidue: [{ kind: "local_state", state: "session_cleanup_failed", assetIndex: null, reference: null, retryRisk: "duplicate" }],
                error: {
                  source: "runtime", stage: "session_cleanup", code: "reddit_session_cleanup_failed",
                  httpStatus: null, sanitizedMessage: "The Reddit draft verified, but session cleanup failed.",
                  classification: "known", retryable: false, inputRelated: false,
                  suggestedCorrection: "Do not restage; review the existing native draft and repair session cleanup separately.",
                },
                exit: { class: "runtime_or_platform_failure", code: 1 },
              });
            }
          }
        }
      }

      emitTransportReceipt(finalReceipt!, { json: !!opts.json, budget: output });
      process.exit(finalReceipt!.exit.code);
    });
}

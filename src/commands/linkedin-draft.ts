import { Command } from "commander";
import { resolve } from "node:path";
import {
  generatePost,
  prepareLinkedInPost,
  snapshotLinkedInGeneratedPost,
  type GeneratedPost,
} from "../linkedin/content.js";
import type { StagePostOptions, StagePostResult } from "../linkedin/draftPoster.js";
import {
  createLinkedInMediaStageEvidence,
  LINKEDIN_DRAFT_SAVE_MECHANISM,
  snapshotLinkedInDraftStageError,
  snapshotLinkedInDraftStageResult,
  type LinkedInDraftSaveFailurePhase,
  type LinkedInDraftSavePhase,
  type LinkedInDraftStageProgress,
  type LinkedInMediaStageEvidence,
} from "../linkedin/saveProgress.js";
import {
  isLocalValidationError,
  validateLinkedInMedia,
  type LocalValidationProblem,
  type LinkedInMediaValidationResult,
} from "../capabilities/validation.js";
import { resolveContentInputDetails, splitLeadingFrontmatter } from "./contentInput.js";
import {
  TerminalOutputBudget,
  finalizeTerminalDocument,
  isTerminalProjectionError,
  projectTerminalText,
  renderTerminalInline,
  terminalProjectionFailureMessage,
} from "../terminalOutput.js";
import {
  createDryRunReceipt,
  createTransportReceipt,
  emitTransportReceipt,
  NOT_REACHED_LIVE_VALIDATION,
  PASSED_LOCAL_VALIDATION,
  type ReceiptAsset,
  type TransportReceipt,
} from "../transportReceipt.js";

/**
 * `publish linkedin draft` — owned-content publisher for the LinkedIn channel.
 * Creates a NATIVE feed-post DRAFT on LinkedIn and STOPS THERE. It MUST NOT
 * publish/Post (the send-gate is documented future scope, PRODUCT_SPEC §5, and is
 * not built here).
 *
 * Flow:
 *   1. Resolve the content — inline via --text (the primary, ergonomic path for a
 *      short-to-medium post), or from a canonical base markdown file via --from
 *      ('-' reads stdin). Exactly one of the two.
 *   2. DETERMINISTIC generation (src/linkedin/content.ts; plain code, no LLM):
 *      single post, 3,000 UTF-16 code-unit cap (over cap → reject before browser
 *      access), above-the-fold hook advisory, markdown → plain text,
 *      emoji passthrough, code/link advisories, optional Unicode-bold (--bold).
 *   3. --dry-run: generate + print the inspection ONLY; no browser.
 *   4. Otherwise: session.getBrowserContext() (the persistent logged-in LinkedIn
 *      profile), open the share composer, type the post, attach any --media, and
 *      SAVE AS A NATIVE DRAFT — never Post.
 *
 * There is intentionally NO --format (a LinkedIn post is one format) and NO --long
 * (a single 3,000 UTF-16 code-unit cap).
 */

interface LinkedInDraftOptions {
  text?: string;
  from?: string;
  media?: string[];
  bold?: boolean;
  dryRun?: boolean;
  inspect?: boolean;
  json?: boolean;
}

export interface LinkedInDraftRealRunInput {
  readonly post: GeneratedPost;
  readonly inspect?: boolean;
  readonly media: readonly string[];
}

export interface LinkedInDraftRealRunDependencies {
  loadStagePost(): Promise<(
    content: GeneratedPost,
    options?: StagePostOptions,
  ) => Promise<StagePostResult>>;
}

export interface LinkedInDraftRealRunOutcome {
  readonly kind: "input_rejected" | "stage_runtime_failed" | "save_incomplete" | "staged";
  readonly savePhase: LinkedInDraftSavePhase;
  readonly saveMechanism: typeof LINKEDIN_DRAFT_SAVE_MECHANISM;
  readonly exitCode: 0 | 1 | 2;
  readonly stream: "stdout" | "stderr";
  readonly message: string;
  readonly platformTouched: boolean;
  readonly composerModified: boolean;
  readonly media: readonly LinkedInMediaStageEvidence[];
}

function linkedInInputRejected(): LinkedInDraftRealRunOutcome {
  return {
    kind: "input_rejected",
    savePhase: "save_not_attempted",
    saveMechanism: LINKEDIN_DRAFT_SAVE_MECHANISM,
    exitCode: 2,
    stream: "stderr",
    platformTouched: false,
    composerModified: false,
    media: Object.freeze([]),
    message: "\n✗ LinkedIn staging input failed local snapshot validation. No browser was touched. NEVER posted.",
  };
}

function linkedInBeforeSaveFailure(
  kind: "stage_runtime_failed" | "save_incomplete",
  progress: LinkedInDraftStageProgress,
): LinkedInDraftRealRunOutcome {
  return {
    kind,
    savePhase: "save_not_attempted",
    saveMechanism: LINKEDIN_DRAFT_SAVE_MECHANISM,
    exitCode: 1,
    stream: "stderr",
    ...progress,
    message:
      "\n✗ LinkedIn draft staging stopped before the native Save as draft action was invoked. NEVER posted.\n" +
      "  No native Save as draft action was invoked by this attempt.\n" +
      (progress.composerModified
        ? "  The composer may retain changed text or media state. Open feed/?shareActive=true in the exact CLI-owned LinkedIn profile (or choose Start a post on the feed) and inspect it before retrying."
        : "  Resolve the local runtime or composer problem before a separate retry; --inspect may help calibrate selectors."),
  };
}

function linkedInUncertainSaveOutcome(
  savePhase: Exclude<LinkedInDraftSaveFailurePhase, "save_not_attempted">,
  progress: LinkedInDraftStageProgress,
): LinkedInDraftRealRunOutcome {
  const phase = savePhase === "save_delivery_unknown"
    ? "The Save as draft click may have reached LinkedIn, but delivery is unknown."
    : "The Save as draft action returned, but the complete intended text was not positively verified after reopen.";
  return {
    kind: "save_incomplete",
    savePhase,
    saveMechanism: LINKEDIN_DRAFT_SAVE_MECHANISM,
    exitCode: 1,
    stream: "stderr",
    ...progress,
    message:
      `\n✗ ${phase} A native LinkedIn draft may exist. NEVER posted.\n` +
      "  Before any retry, open feed/?shareActive=true in the exact same CLI-owned LinkedIn profile, or choose Start a post on the feed, and compare the restored composer.\n" +
      "  If a matching draft exists or the comparison is uncertain, do not retry.\n" +
      "  Only after that comparison may --inspect help diagnose selector drift; it is secondary and is not evidence that no draft exists.",
  };
}

function linkedInStagedOutcome(
  progress: LinkedInDraftStageProgress,
  hasLinks: boolean,
): LinkedInDraftRealRunOutcome {
  const mediaSet = progress.media.filter((item) => item.set === true).length;
  return {
    kind: "staged",
    savePhase: "verified",
    saveMechanism: LINKEDIN_DRAFT_SAVE_MECHANISM,
    exitCode: 0,
    stream: "stdout",
    ...progress,
    message:
      "\n✓ Staged a NATIVE LinkedIn draft (post). NEVER posted.\n" +
      "  complete intended text verified after reopening the composer: yes\n" +
      `  media file-setting calls returned: ${mediaSet}; attachment and persistence remain unverified. Verify every image, order, crop, and link preview manually.\n` +
      (hasLinks
        ? "  Links: add intended body URL(s) as the FIRST COMMENT after human publication; a first comment cannot be pre-saved in this draft."
        : "  Review the restored native draft manually before posting."),
  };
}

function resolvedMediaProgress(
  count: number,
  set: boolean | null,
  platformTouched: boolean,
  composerModified: boolean,
): LinkedInDraftStageProgress {
  return Object.freeze({
    platformTouched,
    composerModified,
    media: createLinkedInMediaStageEvidence(count, set),
  });
}

function snapshotMediaPaths(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const paths: string[] = [];
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 || lengthDescriptor.value > 100
    ) {
      return null;
    }
    const count = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== count + 1 ||
      !keys.includes("length") ||
      Array.from({ length: count }, (_, index) => String(index)).some((key) => !keys.includes(key))
    ) {
      return null;
    }
    for (let index = 0; index < count; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
      paths.push(descriptor.value);
    }
  } catch {
    return null;
  }
  return paths;
}

/**
 * Execute only the real LinkedIn staging boundary. The loader rejection and the
 * invoked poster's rejection/result are deliberately separate evidence seams.
 */
export async function executeLinkedInDraftRealRun(
  input: LinkedInDraftRealRunInput,
  deps: LinkedInDraftRealRunDependencies,
): Promise<LinkedInDraftRealRunOutcome> {
  let post: GeneratedPost;
  let media: string[];
  let inspect: boolean | undefined;
  try {
    post = snapshotLinkedInGeneratedPost(input.post);
    const mediaSnapshot = snapshotMediaPaths(input.media);
    const inspectSnapshot = input.inspect;
    if ((inspectSnapshot !== undefined && typeof inspectSnapshot !== "boolean") || mediaSnapshot === null) {
      return linkedInInputRejected();
    }
    inspect = inspectSnapshot;
    media = mediaSnapshot;
  } catch {
    return linkedInInputRejected();
  }
  const untouched = resolvedMediaProgress(media.length, false, false, false);

  let stagePost: Awaited<ReturnType<LinkedInDraftRealRunDependencies["loadStagePost"]>>;
  try {
    stagePost = await deps.loadStagePost();
  } catch {
    return linkedInBeforeSaveFailure("stage_runtime_failed", untouched);
  }
  if (typeof stagePost !== "function") {
    return linkedInBeforeSaveFailure("stage_runtime_failed", untouched);
  }

  let returned: StagePostResult;
  try {
    returned = await stagePost(post, { inspect, media });
  } catch (error) {
    const stageError = snapshotLinkedInDraftStageError(error, media.length);
    if (stageError === null) {
      // The poster was invoked. Untyped rejection cannot prove Save was absent.
      return linkedInUncertainSaveOutcome(
        "save_delivery_unknown",
        resolvedMediaProgress(media.length, null, true, true),
      );
    }
    return stageError.savePhase === "save_not_attempted"
      ? linkedInBeforeSaveFailure("save_incomplete", stageError)
      : linkedInUncertainSaveOutcome(stageError.savePhase, stageError);
  }

  const result = snapshotLinkedInDraftStageResult(returned, media.length);
  if (result === null) {
    // Returned data is observation, not phase-bearing control flow. A malformed
    // value after invocation cannot downgrade the outcome to no-draft.
    return linkedInUncertainSaveOutcome(
      "save_delivery_unknown",
      resolvedMediaProgress(media.length, null, true, true),
    );
  }
  return result.savePhase === "verified"
    ? linkedInStagedOutcome(result, post.linkFlags.length > 0)
    : linkedInUncertainSaveOutcome("save_delivered_unverified", result);
}

function receiptAssetsFromStage(
  media: readonly LinkedInMediaStageEvidence[],
): readonly ReceiptAsset[] {
  return media.map((item) => ({
    index: item.index,
    role: "media" as const,
    requested: true,
    resolved: true,
    set: item.set,
    uploaded: null,
    observed: item.observed,
    verified: item.verified,
    remoteReference: null,
  }));
}

function requestedMediaAssets(
  count: number,
  resolved: boolean | null = null,
): readonly ReceiptAsset[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > 100) return [];
  return Array.from({ length: count }, (_, index) => ({
    index,
    role: "media" as const,
    requested: true,
    resolved,
    set: false,
    uploaded: null,
    observed: null,
    verified: null,
    remoteReference: null,
  }));
}

function validatedMediaAssets(
  result: LinkedInMediaValidationResult,
): readonly ReceiptAsset[] {
  return result.items.map((item, index) => ({
    index,
    role: "media" as const,
    requested: true,
    resolved: item.valid,
    set: false,
    uploaded: null,
    observed: null,
    verified: null,
    remoteReference: null,
  }));
}

function linkedInLocalFailureMessage(problem: LocalValidationProblem): string {
  switch (problem.code) {
    case "linkedin_text_too_long":
      return `LinkedIn post is ${problem.actual} UTF-16 code units; the cap is 3000. No browser was touched.`;
    case "linkedin_text_empty_after_conversion":
      return "LinkedIn post is empty after Markdown-to-plain-text conversion. No browser was touched.";
    case "linkedin_raw_html_unsupported":
      return "LinkedIn Markdown contains parser-confirmed raw HTML and cannot be converted faithfully; no browser was touched.";
    case "linkedin_nul_not_supported":
      return "LinkedIn post input contains the unsupported U+0000 control character. No browser was touched.";
    case "malformed_frontmatter":
      return "LinkedIn frontmatter is malformed YAML. No browser was touched.";
    case "unterminated_frontmatter":
      return "LinkedIn frontmatter has no closing --- delimiter. No browser was touched.";
    case "content_source_not_regular_file":
      return "LinkedIn --from source is not a regular file. No browser was touched.";
    default:
      return "LinkedIn input failed local validation. No browser was touched.";
  }
}

export function createLinkedInLocalFailureReceipt(input: {
  readonly mode: "dry_run" | "real";
  readonly problems: readonly LocalValidationProblem[];
  readonly message: string;
  readonly assets?: readonly ReceiptAsset[];
}): Readonly<TransportReceipt> {
  const problems = input.problems.length > 0
    ? input.problems
    : [{
        phase: "local" as const,
        code: "linkedin_local_validation_failed",
        field: "source" as const,
        actual: null,
        expected: "valid LinkedIn draft input",
        unit: null,
      }];
  return createTransportReceipt({
    channel: "linkedin",
    action: "draft",
    format: "post",
    mode: input.mode,
    validation: {
      local: { status: "failed", problems, notes: [] },
      live: NOT_REACHED_LIVE_VALIDATION,
    },
    warnings: [],
    gotchas: [],
    assets: input.assets ?? [],
    platformTouched: false,
    terminalState: "input_rejected",
    verification: { status: "not_applicable", strength: "none", nativeReference: null },
    remoteResidue: [],
    error: {
      source: "local",
      stage: "local_validation",
      code: problems[0].code,
      httpStatus: null,
      sanitizedMessage: input.message,
      classification: "known",
      retryable: false,
      inputRelated: true,
      suggestedCorrection: "Correct the structured local validation problem before a separate attempt. No browser was touched.",
    },
    exit: { class: "invalid_caller_input", code: 2 },
  });
}

export function receiptForLinkedInDraftOutcome(
  outcome: LinkedInDraftRealRunOutcome,
  warnings: readonly string[] = [],
): Readonly<TransportReceipt> {
  const verified = outcome.kind === "staged" && outcome.savePhase === "verified";
  const localInvalid = outcome.kind === "input_rejected";
  const nativeDraftPossible = outcome.savePhase === "save_delivery_unknown" ||
    outcome.savePhase === "save_delivered_unverified";
  const terminalState = localInvalid
    ? "input_rejected" as const
    : verified
      ? "native_draft_verified" as const
      : outcome.savePhase === "save_delivered_unverified"
        ? "native_draft_unverified" as const
        : outcome.savePhase === "save_delivery_unknown"
          ? "native_draft_possible" as const
          : "no_native_draft" as const;
  const gotchas: string[] = [];
  if (outcome.media.length > 0) {
    gotchas.push(
      "A returned Playwright file-setting call proves only set state; LinkedIn UI attachment, order, crop, and native-draft persistence remain unverified.",
    );
  }
  if (nativeDraftPossible) {
    gotchas.push(
      "Before retrying, open feed/?shareActive=true in the exact CLI-owned LinkedIn profile, or choose Start a post on the feed, and compare the restored composer. Do not retry if it matches or remains uncertain.",
    );
  } else if (outcome.exitCode !== 0 && outcome.composerModified) {
    gotchas.push(
      "The composer may retain changed text or media state; inspect feed/?shareActive=true in the exact CLI-owned LinkedIn profile before retrying.",
    );
  }
  const remoteResidue = [];
  if (nativeDraftPossible) {
    remoteResidue.push({
      kind: "native_draft" as const,
      state: outcome.savePhase,
      assetIndex: null,
      reference: null,
      retryRisk: "duplicate" as const,
    });
  }
  if (outcome.exitCode !== 0 && outcome.composerModified) {
    remoteResidue.push({
      kind: "composer" as const,
      state: "composer_residue_unknown",
      assetIndex: null,
      reference: null,
      retryRisk: "unknown" as const,
    });
  }
  const error = outcome.exitCode === 0 ? null : {
    source: localInvalid
      ? "local" as const
      : outcome.platformTouched
        ? "platform" as const
        : "runtime" as const,
    stage: localInvalid
      ? "staging_input_snapshot"
      : outcome.kind === "stage_runtime_failed"
        ? "staging_runtime_load"
        : outcome.savePhase,
    code: localInvalid
      ? "linkedin_staging_input_invalid"
      : outcome.kind === "stage_runtime_failed"
        ? "linkedin_staging_runtime_unavailable"
        : `linkedin_${outcome.savePhase}`,
    httpStatus: null,
    sanitizedMessage: localInvalid
      ? "The closed LinkedIn staging input failed local validation."
      : outcome.kind === "stage_runtime_failed"
        ? "The LinkedIn staging runtime could not be initialized."
        : outcome.savePhase === "save_not_attempted"
          ? "LinkedIn staging stopped before the native Save as draft action was invoked."
          : "The LinkedIn native draft outcome was not positively verified.",
    classification: outcome.savePhase === "save_delivery_unknown" ? "unknown" as const : "known" as const,
    retryable: null,
    inputRelated: localInvalid ? true : null,
    suggestedCorrection: nativeDraftPossible
      ? "Inspect the restored composer through feed/?shareActive=true or Start a post in the exact CLI-owned LinkedIn profile before deciding whether a separate retry is safe. Never retry blindly."
      : outcome.composerModified
        ? "Inspect the possibly modified composer in the exact CLI-owned LinkedIn profile before a separate retry."
        : localInvalid
          ? "Regenerate a valid closed LinkedIn staging request before retrying."
          : "Resolve the local runtime or calibrated composer failure before a separate retry.",
  };
  return createTransportReceipt({
    channel: "linkedin",
    action: "draft",
    format: "post",
    mode: "real",
    validation: {
      local: localInvalid
        ? {
            status: "failed",
            problems: [{
              phase: "local",
              code: "linkedin_staging_input_invalid",
              field: "source",
              actual: "invalid_closed_snapshot",
              expected: "a valid immutable LinkedIn staging request",
              unit: null,
            }],
            notes: [],
          }
        : PASSED_LOCAL_VALIDATION,
      live: verified
        ? { status: "passed", problems: [], notes: [] }
        : outcome.platformTouched
          ? { status: "failed", problems: [], notes: ["Native text persistence was not positively verified."] }
          : NOT_REACHED_LIVE_VALIDATION,
    },
    warnings,
    gotchas,
    assets: receiptAssetsFromStage(outcome.media),
    platformTouched: outcome.platformTouched,
    terminalState,
    verification: {
      status: verified ? "verified" : localInvalid || !outcome.platformTouched ? "not_applicable" : "unverified",
      strength: verified ? "exact_content_reopen" : "none",
      nativeReference: null,
    },
    remoteResidue,
    error,
    exit: {
      class: outcome.exitCode === 0
        ? "success"
        : outcome.exitCode === 2
          ? "invalid_caller_input"
          : "runtime_or_platform_failure",
      code: outcome.exitCode,
    },
  });
}

const productionLinkedInDraftRealRunDependencies: LinkedInDraftRealRunDependencies = {
  async loadStagePost() {
    const { stagePost } = await import("../linkedin/draftPoster.js");
    return stagePost;
  },
};

/** Commander collector for the repeatable --media flag. */
function collectMedia(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function renderMediaValidation(result: LinkedInMediaValidationResult): string {
  if (result.items.length === 0) return "";
  const lines = ["", "── local media validation (caller order) ──"];
  for (const [index, item] of result.items.entries()) {
    lines.push(
      `${index + 1}. ${renderTerminalInline(projectTerminalText(item.path, { lineMode: "inline" }))}`,
      `   ${item.contentType}; ${item.width}x${item.height}; ${item.sizeBytes} bytes; aspect ${item.aspectRatio?.toFixed(4)}`,
    );
  }
  lines.push(
    "   locally verified: readable file, magic/header type, extension match, dimensions, bytes, order",
    `   server-authoritative/unverified: ${result.unverifiedConstraints.join(", ")}`,
  );
  return finalizeTerminalDocument(lines);
}

export function registerLinkedInDraftCommand(linkedin: Command): void {
  linkedin
    .command("draft")
    .description("Stage a NATIVE LinkedIn post draft from inline text or a markdown file — never posts")
    .option("--text <content>", "Post content inline; leading --- is literal (exactly one of --text / --from)")
    .option("--from <base.md>", "Canonical markdown ('-' = stdin); strips a leading YAML mapping/empty frontmatter block")
    .option("--media <path>", "Validated local image to attach (repeatable, in order); Markdown images never attach files", collectMedia, [])
    .option("--bold", "Opt-in Unicode math-bold for **emphasis** (accessibility caveat — see output)")
    .option("--dry-run", "Only generate the post; do not open the browser")
    .option("--inspect", "Headful browser so a human can watch/calibrate selectors")
    .option("--json", "Emit one versioned machine-readable transport receipt")
    .addHelpText(
      "after",
      "\nMarkdown conversion:\n" +
        "  One deterministic CommonMark/GFM parse owns plain text and evidence.\n" +
        "  Inline, full/collapsed/shortcut reference, bare, and autolinks resolve to\n" +
        "  visible parser-normalized labels/destinations; character references decode\n" +
        "  once, definitions disappear, and duplicate HTTP(S) destinations produce one\n" +
        "  first-seen advisory.\n" +
        "  Parser-confirmed raw HTML exits 2 before profile/browser access. Link/image\n" +
        "  syntax inside code stays inert. Image evidence uses normalized alt text.\n" +
        "  Empty conversion errors name only omitted code, images, definitions,\n" +
        "  thematic breaks, or whitespace. Run publish linkedin info for the full contract.\n" +
        "\nNative-save outcome:\n" +
        "  Only a returned Save as draft action followed by a full intended-text match\n" +
        "  after reopening the composer is success. A rejected Save click has unknown\n" +
        "  delivery; a settle/reopen failure or negative match is delivered but unverified.\n" +
        "  Both uncertain states exit 1 because a native draft may exist. Before retrying,\n" +
        "  open feed/?shareActive=true in the exact same CLI-owned LinkedIn profile, or\n" +
        "  choose Start a post on the feed, and compare the restored composer.\n" +
        "  --inspect is secondary diagnosis after comparison and cannot prove absence.\n",
    )
    .action(async (opts: LinkedInDraftOptions) => {
      const output = new TerminalOutputBudget();
      const mode = opts.dryRun ? "dry_run" as const : "real" as const;
      const emitReceipt = (receipt: Readonly<TransportReceipt>): void => {
        emitTransportReceipt(receipt, { json: !!opts.json, budget: output });
      };
      const rawMediaCount = Array.isArray(opts.media) ? opts.media.length : 0;
      if (rawMediaCount > 100) {
        emitReceipt(createLinkedInLocalFailureReceipt({
          mode,
          problems: [{
            phase: "local",
            code: "linkedin_media_receipt_limit_exceeded",
            field: "media",
            actual: rawMediaCount,
            expected: "at most 100 ordered media inputs per transport operation",
            unit: "items",
          }],
          message: "LinkedIn media input exceeds the finite transport-receipt evidence budget.",
        }));
        process.exit(2);
      }
      const unresolvedAssets = requestedMediaAssets(rawMediaCount);
      let md: string;
      let sourceLineOffset = 0;
      try {
        const input = resolveContentInputDetails(opts);
        md = input.markdown;
        if (input.kind !== "text") {
          const split = splitLeadingFrontmatter(
            md,
            input.sourcePath ?? "stdin (--from -)",
          );
          md = split.body;
          sourceLineOffset = split.bodyLineOffset;
        }
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        emitReceipt(createLinkedInLocalFailureReceipt({
          mode,
          problems: [error.problem],
          message: linkedInLocalFailureMessage(error.problem),
          assets: unresolvedAssets,
        }));
        process.exit(2);
      }

      // Resolve + validate media before content generation or any platform import.
      const media = (opts.media ?? []).map((m) => resolve(m));
      Object.freeze(media);
      const mediaValidation = validateLinkedInMedia(media);
      const localAssets = validatedMediaAssets(mediaValidation);
      if (!mediaValidation.valid) {
        emitReceipt(createLinkedInLocalFailureReceipt({
          mode,
          problems: mediaValidation.problems,
          message: "One or more LinkedIn media inputs failed local validation.",
          assets: localAssets,
        }));
        process.exit(2);
      }

      // DETERMINISTIC generation (no LLM).
      let post;
      let inspection: string;
      try {
        const prepared = prepareLinkedInPost(generatePost(md, { bold: opts.bold, sourceLineOffset }));
        post = prepared.post;
        inspection = prepared.inspection;
      } catch (error) {
        if (!isLocalValidationError(error) && !isTerminalProjectionError(error)) throw error;
        const problem: LocalValidationProblem = isLocalValidationError(error)
          ? error.problem
          : {
              phase: "local",
              code: "terminal_projection_failed",
              field: "text",
              actual: "unsafe_or_oversized",
              expected: "bounded Unicode-scalar content",
              unit: "utf16_code_units",
            };
        emitReceipt(createLinkedInLocalFailureReceipt({
          mode,
          problems: [problem],
          message: isTerminalProjectionError(error)
            ? terminalProjectionFailureMessage()
            : linkedInLocalFailureMessage(problem),
          assets: localAssets,
        }));
        process.exit(2);
      }

      // Always show the generated post + advisory flags to the operator.
      let mediaReport: string;
      try {
        mediaReport = opts.json ? "" : renderMediaValidation(mediaValidation);
        if (!opts.json) {
          output.consume(inspection);
          if (mediaReport) output.consume(mediaReport);
        }
      } catch {
        emitReceipt(createLinkedInLocalFailureReceipt({
          mode,
          problems: [{
            phase: "local",
            code: "terminal_projection_failed",
            field: "text",
            actual: "unsafe_or_oversized",
            expected: "bounded Unicode-scalar terminal evidence",
            unit: "utf16_code_units",
          }],
          message: terminalProjectionFailureMessage(),
          assets: localAssets,
        }));
        process.exit(2);
      }
      if (!opts.json) {
        console.log(inspection);
        if (mediaReport) console.log(mediaReport);
      }

      if (opts.dryRun) {
        emitReceipt(createDryRunReceipt({
          channel: "linkedin",
          action: "draft",
          format: "post",
          warnings: post.warnings,
          gotchas: localAssets.length > 0
            ? ["Media was locally resolved only; no chooser/input, LinkedIn UI, or native draft was touched."]
            : [],
          assets: localAssets,
          liveNotes: ["LinkedIn dry-run intentionally skipped browser access and native staging."],
        }));
        process.exit(0);
      }

      const outcome = await executeLinkedInDraftRealRun(
        { post, inspect: opts.inspect, media },
        productionLinkedInDraftRealRunDependencies,
      );
      emitReceipt(receiptForLinkedInDraftOutcome(outcome, post.warnings));
      process.exit(outcome.exitCode);
    });
}

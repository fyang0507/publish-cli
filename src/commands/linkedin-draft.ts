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
  LINKEDIN_DRAFT_SAVE_MECHANISM,
  snapshotLinkedInDraftStageError,
  snapshotLinkedInDraftStageResult,
  type LinkedInDraftSaveFailurePhase,
  type LinkedInDraftSavePhase,
} from "../linkedin/saveProgress.js";
import {
  isLocalValidationError,
  validateLinkedInMedia,
  type LinkedInMediaValidationResult,
} from "../capabilities/validation.js";
import { resolveContentInputDetails, splitLeadingFrontmatter } from "./contentInput.js";
import {
  TerminalOutputBudget,
  emitTerminalOutput,
  finalizeTerminalDocument,
  isTerminalProjectionError,
  projectTerminalText,
  renderTerminalBlock,
  renderTerminalErrorMessage,
  renderTerminalInline,
  terminalProjectionFailureMessage,
} from "../terminalOutput.js";

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
  readonly kind: "stage_runtime_failed" | "save_incomplete" | "staged";
  readonly savePhase: LinkedInDraftSavePhase;
  readonly saveMechanism: typeof LINKEDIN_DRAFT_SAVE_MECHANISM;
  readonly exitCode: 0 | 1;
  readonly stream: "stdout" | "stderr";
  readonly message: string;
}

function linkedInBeforeSaveFailure(
  kind: "stage_runtime_failed" | "save_incomplete",
): LinkedInDraftRealRunOutcome {
  return {
    kind,
    savePhase: "save_not_attempted",
    saveMechanism: LINKEDIN_DRAFT_SAVE_MECHANISM,
    exitCode: 1,
    stream: "stderr",
    message:
      "\n✗ LinkedIn draft staging stopped before the native Save as draft action was invoked. NEVER posted.\n" +
      "  No native Save as draft action was invoked by this attempt.\n" +
      "  Resolve the local runtime or composer problem before a separate retry; --inspect may help calibrate selectors.",
  };
}

function linkedInUncertainSaveOutcome(
  savePhase: Exclude<LinkedInDraftSaveFailurePhase, "save_not_attempted">,
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
    message:
      `\n✗ ${phase} A native LinkedIn draft may exist. NEVER posted.\n` +
      "  Before any retry, manually compare LinkedIn Drafts in the exact same CLI-owned LinkedIn profile used by this run.\n" +
      "  If a matching draft exists or the comparison is uncertain, do not retry.\n" +
      "  Only after that comparison may --inspect help diagnose selector drift; it is secondary and is not evidence that no draft exists.",
  };
}

function linkedInStagedOutcome(
  mediaAttached: number,
  hasLinks: boolean,
): LinkedInDraftRealRunOutcome {
  return {
    kind: "staged",
    savePhase: "verified",
    saveMechanism: LINKEDIN_DRAFT_SAVE_MECHANISM,
    exitCode: 0,
    stream: "stdout",
    message:
      "\n✓ Staged a NATIVE LinkedIn draft (post). NEVER posted.\n" +
      "  complete intended text verified after reopening the composer: yes\n" +
      `  media attached: ${mediaAttached}; verify every image, order, crop, and link preview manually.\n` +
      (hasLinks
        ? "  Links: add intended body URL(s) as the FIRST COMMENT after human publication; a first comment cannot be pre-saved in this draft."
        : "  Review the restored native draft manually before posting."),
  };
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
  let expectedMediaAttached: number;
  let inspect: boolean | undefined;
  try {
    post = snapshotLinkedInGeneratedPost(input.post);
    if (
      (input.inspect !== undefined && typeof input.inspect !== "boolean") ||
      !Array.isArray(input.media) ||
      input.media.some((path) => typeof path !== "string")
    ) {
      return linkedInBeforeSaveFailure("stage_runtime_failed");
    }
    inspect = input.inspect;
    media = [...input.media];
    expectedMediaAttached = media.length;
  } catch {
    return linkedInBeforeSaveFailure("stage_runtime_failed");
  }

  let stagePost: Awaited<ReturnType<LinkedInDraftRealRunDependencies["loadStagePost"]>>;
  try {
    stagePost = await deps.loadStagePost();
  } catch {
    return linkedInBeforeSaveFailure("stage_runtime_failed");
  }
  if (typeof stagePost !== "function") {
    return linkedInBeforeSaveFailure("stage_runtime_failed");
  }

  let returned: StagePostResult;
  try {
    returned = await stagePost(post, { inspect, media });
  } catch (error) {
    const stageError = snapshotLinkedInDraftStageError(error);
    if (stageError === null) {
      // The poster was invoked. Untyped rejection cannot prove Save was absent.
      return linkedInUncertainSaveOutcome("save_delivery_unknown");
    }
    return stageError.savePhase === "save_not_attempted"
      ? linkedInBeforeSaveFailure("save_incomplete")
      : linkedInUncertainSaveOutcome(stageError.savePhase);
  }

  const result = snapshotLinkedInDraftStageResult(returned, expectedMediaAttached);
  if (result === null) {
    // Returned data is observation, not phase-bearing control flow. A malformed
    // value after invocation cannot downgrade the outcome to no-draft.
    return linkedInUncertainSaveOutcome("save_delivery_unknown");
  }
  return result.savePhase === "verified"
    ? linkedInStagedOutcome(result.mediaAttached, post.linkFlags.length > 0)
    : linkedInUncertainSaveOutcome("save_delivered_unverified");
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
        "  manually compare LinkedIn Drafts in the exact same CLI-owned LinkedIn profile.\n" +
        "  --inspect is secondary diagnosis after comparison and cannot prove absence.\n",
    )
    .action(async (opts: LinkedInDraftOptions) => {
      const output = new TerminalOutputBudget();
      const emit = (stream: "stdout" | "stderr", message: string) =>
        emitTerminalOutput(output, stream, message);
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
        try {
          emit("stderr", renderTerminalErrorMessage(error.message));
        } catch {
          console.error(terminalProjectionFailureMessage());
        }
        process.exit(2);
      }

      // Resolve + validate media before content generation or any platform import.
      const media = (opts.media ?? []).map((m) => resolve(m));
      Object.freeze(media);
      const mediaValidation = validateLinkedInMedia(media);
      if (!mediaValidation.valid) {
        try {
          emit(
            "stderr",
            renderTerminalBlock(projectTerminalText(mediaValidation.errors.join("\n"), { lineMode: "block" })),
          );
        } catch {
          console.error(terminalProjectionFailureMessage());
        }
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
        if (isTerminalProjectionError(error)) {
          console.error(terminalProjectionFailureMessage());
        } else {
          try {
            emit("stderr", renderTerminalErrorMessage(error.message));
          } catch {
            console.error(terminalProjectionFailureMessage());
          }
        }
        process.exit(2);
      }

      // Always show the generated post + advisory flags to the operator.
      let mediaReport: string;
      try {
        mediaReport = renderMediaValidation(mediaValidation);
        output.consume(inspection);
        if (mediaReport) output.consume(mediaReport);
      } catch {
        console.error(terminalProjectionFailureMessage());
        process.exit(2);
      }
      console.log(inspection);
      if (mediaReport) console.log(mediaReport);

      if (opts.dryRun) {
        emit("stdout", "\n[dry-run] No browser touched. (Post printed above, no draft staged.)");
        process.exit(0);
      }

      const outcome = await executeLinkedInDraftRealRun(
        { post, inspect: opts.inspect, media },
        productionLinkedInDraftRealRunDependencies,
      );
      emit(outcome.stream, outcome.message);
      process.exit(outcome.exitCode);
    });
}

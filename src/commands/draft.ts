import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { isProxy } from "node:util/types";
import { dirname, basename, extname, join, resolve } from "node:path";
import {
  generateContent,
  prepareXTerminalContent,
  renderXArtifactInspection,
  renderXLinkFlag,
  type GeneratedContent,
  type XFormat,
} from "../x/content.js";
import {
  renderXArticleCodeLinkAdvisory,
  renderXArticleCodeAdvisoryDetailLine,
  sameXArticleCodeAdvisories,
  sameXArticleCodeLinkAdvisories,
  type ArticleCodeBlockFlag,
  type ArticleCodeLinkAdvisory,
} from "../x/codeAdvisory.js";
import {
  type LocalValidationProblem,
} from "../capabilities/validation.js";
import { resolveContentInputDetails, splitLeadingFrontmatter } from "./contentInput.js";
import {
  isXDraftRowEvidenceCompatible,
  isXDraftReturnedSavePhase,
  snapshotXArticleDraftHandoff,
  snapshotXDraftRowEvidence,
  snapshotXDraftStageError,
  X_ARTICLE_CODE_BLOCK_COUNT_LIMIT,
  type XArticleDraftHandoff,
  type XDraftRowEvidence,
  type XDraftSaveMechanism,
  type XDraftSavePhase,
} from "../x/saveProgress.js";
import type { StageDraftOptions, StageDraftResult } from "../x/draftPoster.js";
import { snapshotXNonArticleStageResult } from "../x/nonArticleStageResultSnapshot.js";
import {
  normalizeXArticleStageSnapshotFailure,
  snapshotXArticleStageInput,
  snapshotXContentFormat,
  snapshotXNonArticleExecuteRequest,
  type XArticleStageSnapshot,
  type XNonArticleStageSnapshot,
  type XArticleStageSnapshotFailure,
} from "../x/articleStageSnapshot.js";
import {
  TerminalOutputBudget,
  emitTerminalOutput,
  projectTerminalText,
  renderTerminalErrorMessage,
  renderTerminalInline,
  terminalProjectionFailureMessage,
} from "../terminalOutput.js";
import {
  createDryRunReceipt,
  createLocalInputFailureReceipt,
  createPreStageRuntimeFailureReceipt,
  createTransportReceipt,
  emitTransportReceipt,
  NO_ASSETS,
  NOT_REACHED_LIVE_VALIDATION,
  PASSED_LOCAL_VALIDATION,
  type ReceiptAsset,
  type TransportReceipt,
} from "../transportReceipt.js";
import { classifyXPreStageFailure } from "./xPreStageFailure.js";
import {
  renderXDraftDiagnostic,
  snapshotXDraftDiagnosticForPhase,
  xDraftDiagnosticCorrection,
  type XDraftDiagnostic,
} from "../x/stageDiagnostic.js";
import {
  preloadXArticleCover,
  snapshotXArticleCoverPreload,
  type XArticleCoverPreload,
} from "../x/articleCover.js";
import {
  emptyXArticleBodyImagePreloadSet,
  preloadXArticleBodyImages,
  snapshotXArticleBodyImagePreloadSet,
  xArticleBodyImagePreloadsMatchBlocks,
  type XArticleBodyImagePreloadSet,
} from "../x/articleBodyImages.js";

/**
 * `publish x draft` — owned-content publisher for the X channel. Creates a
 * NATIVE DRAFT on X and STOPS THERE. It MUST NOT publish/Post (the send-gate is
 * documented as future scope, PRODUCT_SPEC §5, and is not built here).
 *
 * Flow:
 *   1. Resolve the content — inline via --text (tweet/thread only), or from a
 *      canonical base markdown file via --from under publish/<date>-<slug>/.
 *   2. DETERMINISTIC content generation (src/x/content.ts; plain code, no LLM for
 *      formatting): tweet (char-validated; default 280, --long up to 25000),
 *      thread (hook-first numbered split each within limit), or article markdown.
 *      Code blocks are flagged (screenshot on X) and links surfaced with notes.
 *   3. --dry-run: generate content ONLY, write an artifact next to --from (only
 *      when --from was given; --text has no file), print it, no browser.
 *   4. Otherwise: session.getBrowserContext() (the persistent logged-in profile),
 *      open the X composer, type the content (thread: add each post; article: use
 *      the Articles composer), and SAVE AS A NATIVE DRAFT — never Post.
 *   5. Report the bounded native Save/verification outcome (or, with --dry-run,
 *      where content was written).
 */

const VALID_FORMATS: readonly XFormat[] = ["tweet", "thread", "article"];

interface DraftXOptions {
  from?: string;
  text?: string;
  cover?: string;
  format: string;
  long?: boolean;
  dryRun?: boolean;
  inspect?: boolean;
  json?: boolean;
}

export interface XDraftRealRunInput {
  content: GeneratedContent;
  inspect?: boolean;
  basePath?: string;
  cover?: Readonly<XArticleCoverPreload>;
  bodyImages?: Readonly<XArticleBodyImagePreloadSet>;
}

export interface XDraftRealRunDependencies {
  loadStageDraft(): Promise<(
    content: GeneratedContent,
    opts: StageDraftOptions,
  ) => Promise<StageDraftResult>>;
}

export interface XDraftRealRunOutcome {
  kind: "stage_runtime_failed" | "save_incomplete" | "staged";
  savePhase: XDraftSavePhase;
  /** Null only when an untrusted content discriminant cannot be classified safely. */
  saveMechanism: XDraftSaveMechanism | null;
  exitCode: 0 | 1 | 2;
  stream: "stdout" | "stderr";
  message: string;
  draftRowEvidence: XDraftRowEvidence | null;
  articleHandoff: XArticleDraftHandoff | null;
  platformTouched: boolean;
  nativeReference: string | null;
  diagnostic?: Readonly<XDraftDiagnostic> | null;
}

function unclassifiedSnapshotFailure(
  reason: XArticleStageSnapshotFailure,
): XDraftRealRunOutcome {
  return {
    kind: "save_incomplete",
    savePhase: "save_not_attempted",
    saveMechanism: null,
    exitCode: 2,
    stream: "stderr",
    draftRowEvidence: null,
    articleHandoff: null,
    platformTouched: false,
    nativeReference: null,
    message:
      "\n✗ X draft staging stopped before any native Save/Create action was invoked. NEVER posted.\n" +
      `  Local X staging input snapshot validation failed closed before format/mechanism classification (reason=${reason}).\n` +
      "  No saved-draft outcome is claimed. Correct the local input structure before a separate retry.",
  };
}

function nativeDraftLocation(format: GeneratedContent["format"]): string {
  return format === "article" ? "X Articles → Drafts" : "X Unsent/Drafts";
}

function beforeSaveFailure(
  format: GeneratedContent["format"],
  snapshotFailure?: XArticleStageSnapshotFailure,
  platformTouched = false,
  diagnostic: Readonly<XDraftDiagnostic> | null = null,
): XDraftRealRunOutcome {
  const mechanism = format === "article" ? "Article Create/autosave" : "composer Save";
  return {
    kind: "save_incomplete",
    savePhase: "save_not_attempted",
    saveMechanism: format === "article" ? "article_create_autosave" : "composer_close_save",
    exitCode: snapshotFailure ? 2 : 1,
    stream: "stderr",
    draftRowEvidence: null,
    articleHandoff: null,
    platformTouched,
    nativeReference: null,
    diagnostic,
    message:
      `\n✗ X ${format} draft staging stopped before the native ${mechanism} action was invoked. NEVER posted.\n` +
      (snapshotFailure
        ? `  Local X staging input snapshot validation failed closed (reason=${snapshotFailure}).\n`
        : "") +
      (diagnostic
        ? `  ${renderXDraftDiagnostic(diagnostic)}\n  ${xDraftDiagnosticCorrection(diagnostic)}`
        : "  No saved-draft outcome is claimed. Verify the local runtime and browser flow before a separate retry."),
  };
}

function bodyImageInspectRequired(): XDraftRealRunOutcome {
  return {
    kind: "save_incomplete",
    savePhase: "save_not_attempted",
    saveMechanism: "article_create_autosave",
    exitCode: 2,
    stream: "stderr",
    draftRowEvidence: null,
    articleHandoff: null,
    platformTouched: false,
    nativeReference: null,
    message:
      "\n✗ X article draft staging stopped before native Create/autosave. NEVER posted.\n" +
      "  Body-image Articles currently require --inspect because the calibrated native Media input is created only in the headed editor flow.\n" +
      "  No runtime, profile, browser, artifact, or native draft action was invoked.",
  };
}

function uncertainSaveOutcome(
  format: GeneratedContent["format"],
  phase: "save_delivery_unknown" | "save_delivered_unverified",
  draftRowEvidence: XDraftRowEvidence | null = null,
  articleHandoff: XArticleDraftHandoff | null = null,
  nativeReference: string | null = null,
  diagnostic: Readonly<XDraftDiagnostic> | null = null,
): XDraftRealRunOutcome {
  const location = nativeDraftLocation(format);
  const fact = phase === "save_delivery_unknown"
    ? "The native Save/autosave action was invoked, but delivery is unknown"
    : "The native Save/autosave action returned, but persistence was not verified";
  return {
    kind: "save_incomplete",
    savePhase: phase,
    saveMechanism: format === "article" ? "article_create_autosave" : "composer_close_save",
    exitCode: 1,
    stream: "stderr",
    draftRowEvidence,
    articleHandoff,
    platformTouched: true,
    nativeReference,
    diagnostic,
    message:
      `\n✗ ${fact} for the X ${format} draft. NEVER posted.\n` +
      (diagnostic ? `  ${renderXDraftDiagnostic(diagnostic)}\n` : "") +
      (format !== "article" && draftRowEvidence?.status === "unverified"
        ? "  The calibrated scoped-row evidence did not show one exact full-content visible-multiset addition.\n"
        : "") +
      (format === "article" &&
          phase === "save_delivered_unverified" &&
          articleHandoff !== null
        ? `${renderArticleHandoff(articleHandoff)}\n`
        : "") +
      `  A native draft may exist. Before any retry, compare ${location} manually in the exact CLI-owned profile used by this run.\n` +
      "  Do not retry automatically. Selector calibration and --inspect cannot prove whether the draft persisted.",
  };
}

function renderArticleHandoff(handoff: XArticleDraftHandoff): string {
  const count = handoff.codeBlockCount;
  const countLabel = count === "many" ? `>${X_ARTICLE_CODE_BLOCK_COUNT_LIMIT}` : String(count);
  const heroAction = handoff.cover.verified === true
    ? "hosted cover persisted after canonical draft reopen"
    : handoff.cover.set === true
      ? "exact preloaded cover set; persistence not verified"
      : handoff.cover.set === null
        ? "exact preloaded cover delivery unknown after the native set operation rejected"
      : `exact preloaded cover not set (${handoff.cover.setPhase})`;
  const lines = [
    "  Article body input mode=rich_html paste for native conversion; this fact alone does not prove persistence.",
    `  heroAction=${heroAction}. codeBlockCount=${countLabel}.`,
  ];
  if (count === "many" || count > 0) {
    lines.push(
      `  ${count === "many" ? `More than ${X_ARTICLE_CODE_BLOCK_COUNT_LIMIT}` : count} code block${count === 1 ? "" : "s"} NOT auto-formatted; the code text was intentionally excluded. Add ${count === 1 ? "it" : "them"} with Insert → Code or as screenshots.`,
    );
    lines.push("  Complete bounded code-advisory evidence:");
    for (const advisory of handoff.codeAdvisories) {
      lines.push(renderXArticleCodeAdvisoryDetailLine(advisory));
    }
    if (handoff.codeLinkAdvisories.length > 0) {
      lines.push("  Bounded inert link advisories derived from excluded code:");
      for (const advisory of handoff.codeLinkAdvisories) {
        lines.push(renderXArticleCodeLinkAdvisory(advisory));
      }
    }
  }
  const cover = handoff.cover;
  lines.push(
    `  Cover input: explicit ${cover.contentType}; ${cover.width}x${cover.height}; exact 5:2; the CLI stages bytes unchanged; X may resize its hosted cover.`,
    `  Cover evidence: requested=yes; resolved=yes; set=${cover.set === null ? "unknown" : cover.set ? "yes" : "no"}; uploaded=unknown; observed=${cover.observed ? "yes" : "no"}; verified=${cover.verified === null ? "unknown" : cover.verified ? "yes" : "no"}; apply=${cover.applyPhase}.`,
  );
  if (cover.verified !== true) {
    lines.push(
      "  HERO PERSISTENCE UNVERIFIED: inspect the captured Article draft in the exact CLI-owned profile before any retry.",
    );
  }
  if (handoff.bodyImages.length > 0) {
    lines.push(`  Body image occurrences: ${handoff.bodyImages.length}; ordered native insertion evidence:`);
    for (const image of handoff.bodyImages) {
      lines.push(
        `  body_image[${image.occurrenceIndex}] block=${image.blockIndex}; ${image.contentType}; ${image.width}x${image.height}; ` +
        `set=${image.set === null ? "unknown" : image.set ? "yes" : "no"}; uploaded=unknown; ` +
        `observed=${image.observed ? "yes" : "no"}; verified=${image.verified === null ? "unknown" : image.verified ? "yes" : "no"}.`,
      );
    }
  }
  return lines.join("\n");
}

function stagedOutcome(result: StageDraftResult): XDraftRealRunOutcome {
  const count = result.format === "thread"
    ? `${result.posts} posts`
    : result.format === "article"
      ? "1 article"
      : "1 tweet";
  if (result.saveMechanism === "article_create_autosave") {
    return {
      kind: "staged",
      savePhase: "verified",
      saveMechanism: result.saveMechanism,
      exitCode: 0,
      stream: "stdout",
      draftRowEvidence: result.draftRowEvidence,
      articleHandoff: result.articleHandoff,
      platformTouched: true,
      nativeReference: result.nativeReference ?? null,
      message:
        `\n✓ Staged a NATIVE X draft (${result.format}, ${count}). NEVER posted.\n` +
        "  persistence verified by reopening the captured canonical Article edit URL: yes\n" +
        `${renderArticleHandoff(result.articleHandoff)}\n` +
        "  Review the Article content and cover manually in X Articles → Drafts before publishing.",
    };
  }
  return {
    kind: "staged",
    savePhase: "verified",
    saveMechanism: result.saveMechanism,
    exitCode: 0,
    stream: "stdout",
    draftRowEvidence: result.draftRowEvidence,
    articleHandoff: null,
    platformTouched: true,
    nativeReference: null,
    message:
      `\n✓ Native X Save action returned (${result.format}, ${count}). NEVER posted.\n` +
      "  scoped-row observation: positive\n" +
      `  full intended ${result.format === "thread" ? "first thread-row" : "tweet"} text observed in one calibrated X Unsent draft row: yes\n` +
      "  visible scoped row multiset changed by exactly that one full-text value: yes\n" +
      "  stable native row id: unavailable; full-list completeness and causality: unproven (visible scoped rows only)\n" +
      "  Review every saved row manually before posting.",
  };
}

function bodyImageHandoffMatchesPreloads(
  handoff: XArticleDraftHandoff,
  preloads: Readonly<XArticleBodyImagePreloadSet>,
): boolean {
  return handoff.bodyImages.length === preloads.occurrences.length &&
    handoff.bodyImages.every((image, offset) => {
      const preload = preloads.occurrences[offset];
      return preload !== undefined &&
        image.occurrenceIndex === preload.occurrenceIndex &&
        image.blockIndex === preload.blockIndex &&
        image.contentType === preload.bytes.contentType &&
        image.width === preload.bytes.width &&
        image.height === preload.bytes.height &&
        image.sourceSha256 === preload.bytes.sourceSha256;
    });
}

export async function executeXDraftRealRun(
  input: XDraftRealRunInput,
  deps: XDraftRealRunDependencies,
): Promise<XDraftRealRunOutcome> {
  let callerContent: GeneratedContent;
  let format: GeneratedContent["format"];
  if (typeof input !== "object" || input === null) {
    return unclassifiedSnapshotFailure("not_plain_object");
  }
  try {
    if (isProxy(input)) return unclassifiedSnapshotFailure("proxy_object");
    if (Array.isArray(input)) return unclassifiedSnapshotFailure("not_plain_object");
    if (Object.getPrototypeOf(input) !== Object.prototype) {
      return unclassifiedSnapshotFailure("not_plain_object");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, "content");
    if (!descriptor || !descriptor.enumerable) {
      return unclassifiedSnapshotFailure("unexpected_property");
    }
    // #98 permits one Article content-slot observation. Non-Article accessors
    // are rejected by the complete request snapshot below after this sole read.
    callerContent = ("value" in descriptor
      ? descriptor.value
      : Reflect.get(input, "content")) as GeneratedContent;
  } catch {
    return unclassifiedSnapshotFailure("property_read_failed");
  }
  try {
    format = snapshotXContentFormat(callerContent);
  } catch (error) {
    return unclassifiedSnapshotFailure(normalizeXArticleStageSnapshotFailure(error));
  }

  let stageContent: GeneratedContent;
  let nonArticleSnapshot: XNonArticleStageSnapshot | null = null;
  let expectedArticleCodeBlockCount: number | "many" | null = null;
  let expectedArticleCodeAdvisories: readonly ArticleCodeBlockFlag[] | null = null;
  let expectedArticleCodeLinkAdvisories:
    readonly Readonly<ArticleCodeLinkAdvisory>[] | null = null;
  let expectedArticleCover: Readonly<XArticleCoverPreload> | null = null;
  let expectedArticleBodyImages: Readonly<XArticleBodyImagePreloadSet> =
    emptyXArticleBodyImagePreloadSet();
  let expectedArticleImageBlocks: XArticleStageSnapshot["imageBlocks"] = Object.freeze([]);
  try {
    if (format === "article") {
      const snapshot = snapshotXArticleStageInput(callerContent, format);
      stageContent = snapshot.content;
      expectedArticleCodeBlockCount = snapshot.receiptCodeBlockCount;
      expectedArticleCodeAdvisories = snapshot.codeAdvisories;
      expectedArticleCodeLinkAdvisories = snapshot.codeLinkAdvisories;
      expectedArticleImageBlocks = snapshot.imageBlocks;
    } else {
      nonArticleSnapshot = snapshotXNonArticleExecuteRequest(
        input,
        callerContent,
        format,
      );
      stageContent = nonArticleSnapshot.content;
    }
  } catch (error) {
    return beforeSaveFailure(
      format,
      normalizeXArticleStageSnapshotFailure(error),
    );
  }

  // Article retains its separately reviewed #98 content boundary and adds one
  // process-branded, immutable cover-byte snapshot. Non-Article options were
  // copied as part of the complete request snapshot above.
  let inspect: boolean | undefined;
  let basePath: string | undefined;
  if (format === "article") {
    try {
      const inspectDescriptor = Object.getOwnPropertyDescriptor(input, "inspect");
      const coverDescriptor = Object.getOwnPropertyDescriptor(input, "cover");
      const bodyImagesDescriptor = Object.getOwnPropertyDescriptor(input, "bodyImages");
      if (
        (inspectDescriptor && (!inspectDescriptor.enumerable || !("value" in inspectDescriptor))) ||
        !coverDescriptor || !coverDescriptor.enumerable || !("value" in coverDescriptor) ||
        (bodyImagesDescriptor &&
          (!bodyImagesDescriptor.enumerable || !("value" in bodyImagesDescriptor)))
      ) return beforeSaveFailure(format, "unexpected_property");
      inspect = inspectDescriptor?.value;
      expectedArticleCover = snapshotXArticleCoverPreload(coverDescriptor.value);
      const bodyImagesValue = bodyImagesDescriptor?.value ?? emptyXArticleBodyImagePreloadSet();
      const bodyImages = snapshotXArticleBodyImagePreloadSet(bodyImagesValue);
      if (bodyImages === null) return beforeSaveFailure(format, "invalid_value");
      expectedArticleBodyImages = bodyImages;
    } catch {
      return beforeSaveFailure(format, "property_read_failed");
    }
    if (
      (inspect !== undefined && typeof inspect !== "boolean") ||
      expectedArticleCover === null ||
      !xArticleBodyImagePreloadsMatchBlocks(
        expectedArticleBodyImages,
        stageContent.article!.blocks,
      )
    ) {
      return beforeSaveFailure(format, "invalid_value");
    }
  } else {
    inspect = nonArticleSnapshot!.inspect;
    basePath = nonArticleSnapshot!.basePath;
  }

  // Live calibration showed that X creates the attributable body-media input
  // only in the headed editor. Enforce that local requirement before loading
  // browser code or touching a persistent profile.
  if (
    format === "article" &&
    expectedArticleImageBlocks.length > 0 &&
    inspect !== true
  ) {
    return bodyImageInspectRequired();
  }
  // One final immutable Article request owns every value that may cross the
  // dynamic staging-loader boundary. Both content and cover are already
  // detached from caller paths/objects at this point.
  const articleRequestSnapshot = format === "article"
    ? Object.freeze({
        content: stageContent,
        cover: expectedArticleCover!,
        bodyImages: expectedArticleBodyImages,
        inspect,
        stageOptions: Object.freeze({
          inspect,
          cover: expectedArticleCover!,
          bodyImages: expectedArticleBodyImages,
        }),
      })
    : null;

  let stageDraft: Awaited<ReturnType<XDraftRealRunDependencies["loadStageDraft"]>>;
  try {
    stageDraft = await deps.loadStageDraft();
  } catch {
    return {
      kind: "stage_runtime_failed",
      savePhase: "save_not_attempted",
      saveMechanism: format === "article"
        ? "article_create_autosave"
        : "composer_close_save",
      exitCode: 1,
      stream: "stderr",
      draftRowEvidence: null,
      articleHandoff: null,
      platformTouched: false,
      nativeReference: null,
      message:
        "\n✗ Could not initialize the X draft staging runtime. No native Save/autosave action was invoked. NEVER posted.\n" +
        "  Verify the local installation and runtime dependencies before a separate retry.",
    };
  }
  if (typeof stageDraft !== "function") {
    return {
      kind: "stage_runtime_failed",
      savePhase: "save_not_attempted",
      saveMechanism: format === "article"
        ? "article_create_autosave"
        : "composer_close_save",
      exitCode: 1,
      stream: "stderr",
      draftRowEvidence: null,
      articleHandoff: null,
      platformTouched: false,
      nativeReference: null,
      message:
        "\n✗ Could not initialize the X draft staging runtime. No native Save/autosave action was invoked. NEVER posted.\n" +
        "  Verify the local installation and runtime dependencies before a separate retry.",
    };
  }

  let returned: StageDraftResult;
  try {
    const stageOptions: StageDraftOptions = nonArticleSnapshot
      ? nonArticleSnapshot.stageOptions
      : articleRequestSnapshot!.stageOptions;
    returned = await stageDraft(
      articleRequestSnapshot?.content ?? stageContent,
      stageOptions,
    );
  } catch (error) {
    // Only a rejection from the staging promise itself can carry typed phase
    // evidence. Once the promise resolves, result inspection is a separate,
    // untrusted boundary and can never downgrade uncertainty.
    const stageError = snapshotXDraftStageError(error);
    if (stageError) {
      const expectedMechanism = format === "article"
        ? "article_create_autosave"
        : "composer_close_save";
      if (stageError.saveMechanism !== expectedMechanism) {
        return uncertainSaveOutcome(format, "save_delivery_unknown");
      }
      return stageError.savePhase === "save_not_attempted"
        ? beforeSaveFailure(format, undefined, true, stageError.diagnostic)
        : uncertainSaveOutcome(format, stageError.savePhase, null, null, null, stageError.diagnostic);
    }
    // Once the staging function was invoked, an untyped exception carries no
    // reliable Save boundary. Conservatively assume delivery may have happened.
    return uncertainSaveOutcome(format, "save_delivery_unknown");
  }

  let result: StageDraftResult;
  try {
    if (nonArticleSnapshot) {
      const closedResult = snapshotXNonArticleStageResult(
        returned,
        nonArticleSnapshot.format,
        nonArticleSnapshot.expectedPosts,
      );
      if (closedResult === null) {
        return uncertainSaveOutcome(format, "save_delivery_unknown");
      }
      result = closedResult;
    } else {
      if (typeof returned !== "object" || returned === null) {
        return uncertainSaveOutcome(format, "save_delivery_unknown");
      }
      // Article retains its independently reviewed #98 handoff boundary.
      const candidate = {
        format: returned.format,
        posts: returned.posts,
        saveMechanism: returned.saveMechanism,
        savePhase: returned.savePhase,
        draftRowEvidence: snapshotXDraftRowEvidence(returned.draftRowEvidence),
        articleHandoff: snapshotXArticleDraftHandoff(
          (returned as StageDraftResult & { articleHandoff?: unknown }).articleHandoff,
        ),
        nativeReference: (() => {
          const descriptor = Object.getOwnPropertyDescriptor(returned, "nativeReference");
          if (!descriptor) return null;
          if (!("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "string") {
            throw new Error("Invalid Article native reference.");
          }
          try {
            const parsed = new URL(descriptor.value);
            return parsed.protocol === "https:" && parsed.hostname === "x.com" &&
                parsed.username === "" && parsed.password === "" && parsed.port === "" &&
                /^\/compose\/articles\/edit\/\d+$/.test(parsed.pathname) &&
                `${parsed.origin}${parsed.pathname}` === descriptor.value
              ? descriptor.value
              : null;
          } catch {
            return null;
          }
        })(),
      };
      if (
        candidate.format !== format ||
        candidate.posts !== 1 ||
        candidate.saveMechanism !== "article_create_autosave" ||
        !isXDraftReturnedSavePhase(candidate.savePhase) ||
        candidate.draftRowEvidence === null ||
        candidate.articleHandoff === null ||
        candidate.articleHandoff.codeBlockCount !== expectedArticleCodeBlockCount ||
        expectedArticleCodeAdvisories === null ||
        expectedArticleCodeLinkAdvisories === null ||
        !sameXArticleCodeAdvisories(
          candidate.articleHandoff.codeAdvisories,
          expectedArticleCodeAdvisories,
        ) ||
        !sameXArticleCodeLinkAdvisories(
          candidate.articleHandoff.codeLinkAdvisories,
          expectedArticleCodeLinkAdvisories,
        ) ||
        candidate.articleHandoff.cover.selection !== expectedArticleCover!.selection ||
        candidate.articleHandoff.cover.contentType !== expectedArticleCover!.contentType ||
        candidate.articleHandoff.cover.width !== expectedArticleCover!.width ||
        candidate.articleHandoff.cover.height !== expectedArticleCover!.height ||
        candidate.articleHandoff.cover.ratio !== expectedArticleCover!.ratio ||
        candidate.articleHandoff.cover.sourceSha256 !== expectedArticleCover!.sourceSha256 ||
        !bodyImageHandoffMatchesPreloads(
          candidate.articleHandoff,
          expectedArticleBodyImages,
        ) ||
        (candidate.savePhase === "verified" &&
          (candidate.articleHandoff.cover.verified !== true ||
            candidate.articleHandoff.bodyImages.some((image) => image.verified !== true) ||
            candidate.nativeReference === null)) ||
        !isXDraftRowEvidenceCompatible(
          candidate.saveMechanism,
          candidate.savePhase,
          candidate.draftRowEvidence,
        )
      ) {
        return uncertainSaveOutcome(format, "save_delivery_unknown");
      }
      result = {
        ...candidate,
        // Render only the pre-loader frozen evidence after the returned handoff
        // proved exact correspondence. Never trust post-await caller strings.
        articleHandoff: Object.freeze({
          ...candidate.articleHandoff,
          codeAdvisories: expectedArticleCodeAdvisories,
          codeLinkAdvisories: expectedArticleCodeLinkAdvisories,
        }),
      } as StageDraftResult;
    }
  } catch {
    // A resolved result is untrusted data, not phase-bearing control flow.
    // Throwing top-level or nested getters therefore always mean uncertainty.
    return uncertainSaveOutcome(format, "save_delivery_unknown");
  }

  return result.savePhase === "verified"
    ? stagedOutcome(result)
    : uncertainSaveOutcome(
        result.format,
        "save_delivered_unverified",
        result.draftRowEvidence,
        result.saveMechanism === "article_create_autosave" ? result.articleHandoff : null,
        result.saveMechanism === "article_create_autosave" ? result.nativeReference ?? null : null,
      );
}

function xArticleAssets(
  outcome: XDraftRealRunOutcome,
  inputCover: Readonly<XArticleCoverPreload> | null,
  inputBodyImages: Readonly<XArticleBodyImagePreloadSet> = emptyXArticleBodyImagePreloadSet(),
): readonly ReceiptAsset[] {
  const cover = outcome.articleHandoff?.cover;
  const bodyAssets: ReceiptAsset[] = outcome.articleHandoff
    ? outcome.articleHandoff.bodyImages.map((image) => ({
        index: image.occurrenceIndex,
        role: "body_image" as const,
        requested: image.requested,
        resolved: image.resolved,
        set: image.set,
        uploaded: image.uploaded,
        observed: image.observed,
        verified: image.verified,
        remoteReference: null,
      }))
    : inputBodyImages.occurrences.map((occurrence) => ({
        index: occurrence.occurrenceIndex,
        role: "body_image" as const,
        requested: true,
        resolved: true,
        set: outcome.platformTouched ? null : false,
        uploaded: outcome.platformTouched ? null : false,
        observed: outcome.platformTouched ? null : false,
        verified: outcome.platformTouched ? null : false,
        remoteReference: null,
      }));
  if (!cover) {
    if (inputCover === null) return bodyAssets;
    return [{
      index: 0,
      role: "cover",
      requested: true,
      resolved: true,
      set: outcome.platformTouched ? null : false,
      uploaded: outcome.platformTouched ? null : false,
      observed: outcome.platformTouched ? null : false,
      verified: outcome.platformTouched ? null : false,
      remoteReference: null,
    }, ...bodyAssets];
  }
  return [{
    index: 0,
    role: "cover",
    requested: cover.requested,
    resolved: cover.resolved,
    set: cover.set,
    uploaded: cover.uploaded,
    observed: cover.observed,
    verified: cover.verified,
    remoteReference: null,
  }, ...bodyAssets];
}

function xArticleGotchas(outcome: XDraftRealRunOutcome): readonly string[] {
  const handoff = outcome.articleHandoff;
  if (handoff === null) return [];
  const gotchas: string[] = [];
  const applyPhaseFact = handoff.cover.applyPhase === "not_attempted"
    ? "X Article cover Apply phase=not_attempted: no Apply click was invoked."
    : handoff.cover.applyPhase === "delivery_unknown"
      ? "X Article cover Apply phase=delivery_unknown: one exact Apply click was invoked once and its promise rejected; delivery is unknown and no retry was attempted."
      : "X Article cover Apply phase=returned: one exact Apply click promise fulfilled.";
  gotchas.push(applyPhaseFact);
  const count = handoff.codeBlockCount;
  if (count === "many" || count > 0) {
    const countLabel = count === "many"
      ? `More than ${X_ARTICLE_CODE_BLOCK_COUNT_LIMIT}`
      : String(count);
    gotchas.push(
      `${countLabel} X Article code block${count === 1 ? " was" : "s were"} intentionally excluded from the native rich-HTML input; add ${count === 1 ? "it" : "them"} manually with Insert → Code or as ${count === 1 ? "a screenshot" : "screenshots"}.`,
    );
  }
  if (handoff.cover.verified !== true) {
    gotchas.push(
      "The hosted X Article cover was not positively observed after reopening the captured edit URL; compare the native draft in the exact CLI-owned profile and do not retry blindly.",
    );
  } else if (
    outcome.kind === "staged" &&
    outcome.savePhase === "verified" &&
    handoff.cover.applyPhase !== "returned"
  ) {
    gotchas.push(
      "Independent two-sided canonical persistence proved the same hosted cover and full title/body without claiming Apply returned.",
    );
  }
  if (handoff.bodyImages.some((image) => image.verified !== true)) {
    gotchas.push(
      "One or more X Article body-image occurrences were not positively observed in order after reopening the captured edit URL; compare the exact native draft before any retry.",
    );
  }
  return gotchas;
}

export function receiptForXDraftOutcome(
  outcome: XDraftRealRunOutcome,
  format: XFormat,
  warnings: readonly string[] = [],
  inputCover: Readonly<XArticleCoverPreload> | null = null,
  inputBodyImages: Readonly<XArticleBodyImagePreloadSet> = emptyXArticleBodyImagePreloadSet(),
): Readonly<TransportReceipt> {
  if (isProxy(outcome)) {
    throw new Error("The X draft outcome cannot be inspected safely.");
  }
  const verified = outcome.kind === "staged" && outcome.savePhase === "verified";
  const saveMayExist = outcome.savePhase === "save_delivery_unknown" ||
    outcome.savePhase === "save_delivered_unverified";
  const localInvalid = outcome.exitCode === 2;
  const diagnosticDescriptor = Object.getOwnPropertyDescriptor(outcome, "diagnostic");
  const diagnostic = snapshotXDraftDiagnosticForPhase(
    diagnosticDescriptor && "value" in diagnosticDescriptor ? diagnosticDescriptor.value : null,
    outcome.savePhase,
    outcome.saveMechanism,
  );
  const terminalState = localInvalid
    ? "input_rejected" as const
    : verified
      ? "native_draft_verified" as const
      : outcome.savePhase === "save_delivered_unverified"
        ? "native_draft_unverified" as const
        : outcome.savePhase === "save_delivery_unknown"
          ? "native_draft_possible" as const
          : "no_native_draft" as const;
  const error = outcome.exitCode === 0 ? null : {
    source: localInvalid ? "local" as const : outcome.kind === "stage_runtime_failed" ? "runtime" as const : "platform" as const,
    stage: localInvalid
      ? "staging_input_snapshot"
      : outcome.savePhase ?? "staging_runtime",
    code: localInvalid
      ? "x_staging_input_invalid"
      : outcome.kind === "stage_runtime_failed"
        ? "x_staging_runtime_unavailable"
        : `x_${outcome.savePhase}`,
    httpStatus: null,
    sanitizedMessage: localInvalid
      ? "The closed X staging input failed local validation."
      : outcome.kind === "stage_runtime_failed"
        ? "The X staging runtime could not be initialized."
        : diagnostic
          ? `${renderXDraftDiagnostic(diagnostic)} The X native draft outcome was not positively verified.`
          : "The X native draft outcome was not positively verified.",
    classification: outcome.savePhase === "save_delivery_unknown" ? "unknown" as const : "known" as const,
    retryable: null,
    inputRelated: localInvalid ? true : null,
    suggestedCorrection: saveMayExist
      ? "Compare the native draft manually in the exact CLI-owned X profile before deciding whether a separate retry is safe. Never retry blindly."
      : localInvalid
        ? "Regenerate a valid closed staging request before retrying."
        : diagnostic
          ? xDraftDiagnosticCorrection(diagnostic)
          : "Resolve the local runtime or calibrated composer failure before a separate retry.",
  };
  return createTransportReceipt({
    channel: "x",
    action: "draft",
    format,
    mode: "real",
    validation: {
      local: localInvalid
        ? {
            status: "failed",
            problems: [{
              phase: "local",
              code: "x_staging_input_invalid",
              field: "text",
              actual: "invalid_closed_snapshot",
              expected: "a valid immutable X staging input",
              unit: null,
            }],
            notes: [],
          }
        : PASSED_LOCAL_VALIDATION,
      live: verified
        ? { status: "passed", problems: [], notes: [] }
        : outcome.platformTouched
          ? { status: "failed", problems: [], notes: ["Native persistence was not positively verified."] }
          : NOT_REACHED_LIVE_VALIDATION,
    },
    warnings,
    gotchas: [
      ...(saveMayExist
        ? ["A native draft may exist; use same-profile manual comparison and do not retry blindly."]
        : []),
      ...xArticleGotchas(outcome),
    ],
    assets: xArticleAssets(outcome, inputCover, inputBodyImages),
    platformTouched: outcome.platformTouched,
    terminalState,
    verification: {
      status: verified ? "verified" : localInvalid ? "not_applicable" : "unverified",
      strength: verified
        ? format === "article" ? "exact_content_reopen" : "scoped_row_delta"
        : "none",
      nativeReference: outcome.nativeReference,
    },
    remoteResidue: saveMayExist
      ? [{
          kind: "native_draft",
          state: outcome.savePhase,
          assetIndex: null,
          reference: outcome.nativeReference,
          retryRisk: "duplicate",
        }]
      : outcome.platformTouched && outcome.savePhase === "save_not_attempted"
        ? [{
            kind: "composer",
            state: "composer_residue_unknown",
            assetIndex: null,
            reference: null,
            retryRisk: "unknown",
          }]
        : [],
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

const productionXDraftRealRunDependencies: XDraftRealRunDependencies = {
  async loadStageDraft() {
    const { stageDraft } = await import("../x/draftPoster.js");
    return stageDraft;
  },
};

/** Build the dry-run artifact path next to the base file. */
function artifactPath(fromPath: string, format: XFormat): string {
  const dir = dirname(fromPath);
  const stem = basename(fromPath, extname(fromPath));
  const ext = format === "article" ? "md" : "txt";
  return join(dir, `${stem}.x-${format}.${ext}`);
}

/** The bytes we write to disk for --dry-run inspection. */
function artifactBody(content: GeneratedContent): string {
  if (content.format === "article" && content.article) {
    // Keep the Article Markdown byte-clean. In particular, appending an HTML
    // comment after an EOF-closed fence would make that comment part of the code
    // payload. Inspection facts are written to a separate text receipt.
    return content.article.markdown;
  }
  // tweet/thread artifact = the full inspection render (text + flags + warnings).
  return `${renderXArtifactInspection(content)}\n`;
}

function renderFlagsBlock(content: GeneratedContent): string {
  let safeContent = content;
  try {
    const format = snapshotXContentFormat(content);
    if (format === "article") {
      safeContent = snapshotXArticleStageInput(content, format).content;
    }
  } catch {
    return "[Article inspection receipt failed closed: local snapshot validation failed; no caller evidence rendered.]";
  }
  const out: string[] = [];
  if (safeContent.format === "article" && safeContent.article) {
    out.push(
      `ARTICLE NATIVE RICH-HTML EXCLUDED CODE BLOCK COUNT: ${safeContent.article.codeBlockCount}`,
    );
  }
  for (const f of safeContent.codeFlags) {
    out.push(safeContent.format === "article"
      ? renderXArticleCodeAdvisoryDetailLine(f as ArticleCodeBlockFlag)
      : `CODE BLOCK #${f.index}${f.lang ? ` [${f.lang}]` : ""} (line ${f.sourceLine}) → screenshot on X: ${f.preview}`);
  }
  for (const f of safeContent.linkFlags) {
    out.push(f.advisorySource === "excluded_article_code"
      ? renderXArticleCodeLinkAdvisory(f)
      : `LINK ${f.url}${f.text ? ` (${f.text})` : ""} — ${f.note}`);
  }
  for (const w of safeContent.warnings) out.push(`WARNING: ${w}`);
  return out.join("\n");
}

function articleInspectionArtifactPath(fromPath: string): string {
  const dir = dirname(fromPath);
  const stem = basename(fromPath, extname(fromPath));
  return join(dir, `${stem}.x-article.inspection.txt`);
}

function xArticleCoverAsset(
  requested: boolean,
  resolved: boolean,
): readonly ReceiptAsset[] {
  return [{
    index: 0,
    role: "cover",
    requested,
    resolved,
    set: false,
    uploaded: false,
    observed: false,
    verified: false,
    remoteReference: null,
  }];
}

function xArticleLocalAssets(
  coverRequested: boolean,
  coverResolved: boolean,
  bodyImageCount = 0,
  bodyImagesResolved = false,
): readonly ReceiptAsset[] {
  return [
    ...xArticleCoverAsset(coverRequested, coverResolved),
    ...Array.from({ length: bodyImageCount }, (_, offset): ReceiptAsset => ({
      index: offset + 1,
      role: "body_image",
      requested: true,
      resolved: bodyImagesResolved,
      set: false,
      uploaded: false,
      observed: false,
      verified: false,
      remoteReference: null,
    })),
  ];
}

export function registerDraftCommand(x: Command): void {
  x
    .command("draft")
    .description("Stage a NATIVE X draft (tweet/thread/article) from a canonical base markdown — never posts")
    .requiredOption("--format <format>", "Required: tweet | thread | article")
    .option("--text <content>", "Content inline (tweet/thread only; exactly one of --text / --from)")
    .option("--from <base.md>", "Canonical markdown ('-' = stdin); strips leading mapping/empty YAML frontmatter")
    .option("--cover <path>", "Required for Article: prepared exact-5:2 JPEG, PNG, or WebP; never transformed")
    .option("--long", "Use the local 25,000-code-point guard for Premium long posts; X acceptance is server-authoritative")
    .option("--dry-run", "Only generate content; do not open the browser")
    .option("--inspect", "Headful browser; required for a real Article containing body images")
    .option("--json", "Emit one versioned machine-readable transport receipt")
    .addHelpText(
      "after",
      "\nFile/stdin frontmatter:\n" +
        "  A leading empty or YAML mapping block between --- delimiters is metadata only and is removed.\n" +
        "  Metadata keys are ignored; an Article title comes from the normalized Markdown body.\n" +
        "  BOM and LF/CRLF/lone-CR delimiters are recognized; mapping-intent malformed or unterminated metadata exits 2.\n" +
        "  Valid scalar/sequence blocks and thematic-break prose remain literal Markdown apart from a leading transport BOM.\n" +
        "  Inline --text is always literal and is never interpreted as frontmatter.\n" +
        "\nArticle native authoring:\n" +
        "  The native editor exposes exactly two heading levels, Heading and Subheading, represented by ATX H1/H2 body headings. H3-H6 and Setext headings reject locally.\n" +
        "  Inline backtick-code styling is unsupported and rejects locally; use a top-level fenced block and complete its explicit manual handoff during human review.\n" +
        "\nTweet/thread code-block transport:\n" +
        "  Every parser-confirmed top-level backtick/tilde fenced block becomes an exact numbered [code block #N → screenshot] placeholder; #1 counts as 29 twitter-text weighted characters normally and 28 Unicode code points with --long.\n" +
        "  Literal caller transport prose matching the reserved [code block #N → screenshot] syntax exits 2 locally before platform/state access; occurrences inside transformed code or an omitted heading do not collide.\n" +
        "  Each replacement emits a screenshot advisory plus a code_block fidelity warning with its inclusive original line range, closure, bounded terminal-safe info/preview, and LF-normalized source SHA-256.\n" +
        "  Openers/closers allow 0–3 leading spaces; a closer needs the same marker at least as long plus only trailing spaces or tabs. Backtick info cannot contain a backtick.\n" +
        "  Mixed-marker pseudo-closers remain payload, and a valid unclosed top-level fence is transformed through end of input.\n" +
        "  Indented/ordinary fence-like prose stays literal. Parser exceptions, unmappable source-token boundaries, and parser-confirmed quote/list-nested fences exit 2 locally with bounded evidence before platform/state access.\n" +
        "  URLs inside transformed code are not link flags, and the optional voice pass is skipped when code is transformed. The CLI does not attach the required screenshot/image; add and verify it during human review.\n" +
        "\nArticle code-block handoff:\n" +
        "  A valid top-level backtick/tilde fence with 0–3 leading spaces may close explicitly or at end of input. EOF-closed Article code preserves its LF-normalized payload, including trailing spaces and blank/whitespace-only lines, in article.blocks and the clean Markdown dry-run artifact.\n" +
        "  Every recognized top-level Article fenced block has one advisory, is excluded from the native rich-HTML paste, and is counted in verified and unverified handoff receipts for manual Insert → Code or screenshot review.\n" +
        "  Each complete advisory reports original/canonical line ranges, physical line count, fence/closure/EOF-terminal-LF facts, terminal-safe NFC info (80 code points) and deindented preview (120 code points), explicit truncation booleans, and SHA-256 of the exact LF-normalized opener-through-closer source slice. EOF identity includes a caller terminal LF; explicit identity excludes only the separator LF after its closer.\n" +
        "  Controls, format/bidi characters, and line/paragraph separators use atomic visible \\u{...} evidence; unpaired surrogates reject before hashing, while valid astral pairs remain supported. Canonical Markdown and ArticleBlock.text stay exact after line-ending normalization.\n" +
        "  Terminal inspection replaces each excluded fence with its block number and digest. File-backed Article dry-runs put the excluded-code count and bounded advisories in a separate .x-article.inspection.txt receipt; only the clean .x-article.md artifact retains raw code, so inspection metadata cannot become EOF-fenced code payload.\n" +
        "  Excluded-code link advisories carry block provenance, explicit truncation facts, and safe URL/label projections bounded to 512/240 code points; they never suppress or alter an exact active prose href. More than 10000 code blocks or 1000000 UTF-16 code units of complete rendered code/code-link evidence exits 2 locally rather than dropping identity facts.\n" +
        "  Run `publish x info` for the owned Article Markdown support matrix and stop conditions.\n" +
        "\nArticle body images:\n" +
        "  Use one local Markdown image token with empty alt text and no title attribute as the complete top-level paragraph: ![](diagram.png) or an empty-alt resolved reference such as ![][diagram]. Nonempty-alt, mixed/nested, titled, remote, data, blob, file-URL, missing, or ambiguous-reference images exit 2 locally before artifacts or staging-runtime/profile/browser access; native alt editing is not calibrated. Fenced and fully escaped image-looking text is not an asset.\n" +
        "  File-backed relative image paths resolve against the Markdown file's directory. Stdin-relative paths resolve against one working-directory snapshot taken at invocation; absolute local paths are accepted. Each unique regular file is opened once and validated as GIF/JPEG/PNG/WebP by magic, matching extension, and positive dimensions. Exact immutable bytes are staged without cropping, resizing, recompression, conversion, or an invented X limit.\n" +
        "  A real image-bearing Article requires --inspect. Images are inserted in Markdown order through one newly created exact Add Media → Media file input per occurrence. Each target is set once; a missing/ambiguous target, rejected delivery, or absent/ambiguous ordered observation stops later images without fallback or automatic retry. Observation accepts only the exact noneditable native Media atom and excludes only that atom's UI text. X may rewrite uploaded bytes: a same-origin blob preview must be nonempty with a valid digest, positive byte count, expected available MIME, and exact dimensions. Its first positive native digest is domain-bound and must remain stable; source digest and size remain requested-input evidence. Hosted URL identity is separately domain-bound, so identity-kind transitions fail closed. Positive persistence requires the same ordered identity kind, digest, and dimensions before and after reopening the same canonical draft URL; preview URLs are never emitted.\n" +
        "\nArticle cover input:\n" +
        "  Article requires one explicit --cover path; tweet and thread reject that flag. The CLI reads one regular JPEG/PNG/WebP once, verifies its header, matching extension, readable dimensions, and exact 5:2 ratio before staging-runtime/profile/browser access.\n" +
        "  The detached validated bytes are staged unchanged. The CLI never scans neighboring files and never crops, resizes, compresses, or converts the cover.\n" +
        "\nArticle staging snapshot:\n" +
        "  Before loading the staging runtime, profile, or browser, the real Article path validates and freezes one closed title/Markdown/block/run/link/image/code-count plus exact cover and ordered body-image byte snapshots, then pre-renders its native text segments.\n" +
        "  It reparses canonical Markdown with the same Article parser and requires the complete code block/advisory/code-link/body-image sets to correspond before any sink. Malformed, accessor/proxy, cyclic, sparse/oversized, count-inconsistent, or unsafe-active-href Article structures exit 2 locally with save_not_attempted; runtime and native Save/autosave failures retain exit 1 semantics.\n" +
        "  If the root format cannot be classified safely, the local exit-2 failure is a typed generic save_not_attempted boundary and names no Article or composer save mechanism. Active inline hrefs require exact safe absolute HTTP(S); supported percent bytes remain exact and are not decoded by safety validation. URL-looking advisories from excluded code are bounded but never become active anchors.\n" +
        "\nNative-save outcome:\n" +
        "  Tweet/thread staging invokes the close→Save action; Article staging invokes Create/autosave.\n" +
        "  Tweet/thread success requires one calibrated native Unsent row whose full text exactly matches the intended tweet or first thread row, plus a visible scoped-row multiset equal to the read-only pre-Save baseline plus that one value.\n" +
        "  Matching background/page text, a prefix, a pre-existing identical visible row, duplicate matches, unreadable rows, or other visible-row changes remain unverified. The evidence has no stable native row id and does not prove full-list completeness or causality.\n" +
        "  Article success requires one unique title/body editor root, a clean pre-set cover/dialog baseline, one direct returned set on its calibrated same-parent cover input, and authoritative native persistence: a unique above-title hosted cover with positive bounded exact-5:2 natural dimensions before canonical reopen, matching full title/body after reopen, and the same hosted cover identity, rendered box relative to the title, and natural dimensions afterward. X may resize the hosted cover; source dimensions and digest remain requested-input evidence, while the CLI stages the original bytes unchanged. When one exact Apply control is observable it is clicked once; Apply provenance remains not_attempted, delivery_unknown, or returned and is never retried or rewritten. A complete native-state proof may close not_attempted or delivery_unknown without claiming Apply returned. An immediate post-Create URL is provisional; a missing/invalid late sample or conflicting positive samples are never used for navigation or verification.\n" +
        "  A returned Article outcome reports bounded body/code facts, distinct cover requested/resolved/set/uploaded/observed/verified evidence at asset index 0, and occurrence-ordered body-image evidence at indexes 1 onward. A stopped image run retains truthful partial set/observed/verified facts. A rejected native cover or body-image input set leaves set unknown because delivery may have occurred; the CLI never retries or uses another upload route. The receipt uses the frozen pre-loader evidence only after exact returned-handoff comparison.\n" +
        "  A rejected Save/Create action has unknown delivery; a returned action without a positive reopen match is unverified. Both exit 1 because a draft may exist.\n" +
        "  Before retrying an unknown/unverified save, compare X Unsent/Drafts or X Articles → Drafts manually in the exact CLI-owned profile used by that run.\n" +
        "  Never retry automatically. --inspect and selector calibration do not prove persistence.\n",
    )
    .action(async (opts: DraftXOptions) => {
      // One invocation-owned base for stdin-relative Article assets. Never read
      // cwd again after parsing or across an await boundary.
      const invocationCwd = process.cwd();
      const output = new TerminalOutputBudget();
      const emit = (stream: "stdout" | "stderr", message: string) =>
        emitTerminalOutput(output, stream, message);
      const emitLocalFailure = (
        problem: LocalValidationProblem,
        message: string,
        assets: readonly ReceiptAsset[] = NO_ASSETS,
      ) => {
        emitTransportReceipt(createLocalInputFailureReceipt({
          channel: "x",
          action: "draft",
          format: VALID_FORMATS.includes(opts.format as XFormat) ? opts.format : "unknown",
          mode: opts.dryRun ? "dry_run" : "real",
          problem,
          message,
          assets,
        }), { json: !!opts.json, budget: output });
      };
      const format = opts.format as XFormat;
      if (!VALID_FORMATS.includes(format)) {
        emitLocalFailure({
          phase: "local",
          code: "x_format_invalid",
          field: "source",
          actual: "unsupported_format",
          expected: VALID_FORMATS.join(" | "),
          unit: null,
        }, `Invalid --format. Expected one of: ${VALID_FORMATS.join(" | ")}.`);
        process.exit(2);
      }
      const stopForPreStageFailure = (
        error: unknown,
        stage: string,
        code: string,
        assets: readonly ReceiptAsset[] = NO_ASSETS,
      ): never => {
        const classified = classifyXPreStageFailure(error);
        if (classified.kind === "local_validation") {
          let problem: LocalValidationProblem | null = null;
          let message: string | null = null;
          try {
            problem = classified.error.problem;
            message = classified.error.message;
          } catch {
            // A hostile wrapper around a branded error is an unknown runtime failure.
          }
          if (problem !== null && typeof message === "string") {
            emitLocalFailure(problem, message, assets);
            process.exit(2);
          }
        } else if (classified.kind === "terminal_projection") {
          emitLocalFailure({
            phase: "local",
            code: "terminal_projection_failed",
            field: "text",
            actual: "unsafe_or_oversized",
            expected: "bounded Unicode-scalar content",
            unit: "utf16_code_units",
          }, terminalProjectionFailureMessage());
          process.exit(2);
        }

        emitTransportReceipt(createPreStageRuntimeFailureReceipt({
          action: "draft",
          format,
          mode: opts.dryRun ? "dry_run" : "real",
          stage,
          code,
        }), { json: !!opts.json, budget: output });
        process.exit(1);
      };

      if (format !== "article" && opts.cover !== undefined) {
        emitLocalFailure({
          phase: "local",
          code: "x_cover_non_article_unsupported",
          field: "media",
          actual: "--cover",
          expected: "omit --cover for tweet and thread drafts",
          unit: null,
        }, "--cover is supported only with --format article.", xArticleCoverAsset(true, false));
        process.exit(2);
      }

      let articleCover: Readonly<XArticleCoverPreload> | null = null;
      if (format === "article") {
        if (opts.cover === undefined) {
          emitLocalFailure({
            phase: "local",
            code: "x_article_cover_missing",
            field: "media",
            actual: null,
            expected: "--cover <prepared-5:2.jpg|png|webp>",
            unit: null,
          }, "X Article requires an explicit --cover path.", xArticleCoverAsset(false, false));
          process.exit(2);
        }
        try {
          articleCover = preloadXArticleCover(opts.cover);
        } catch (error) {
          return stopForPreStageFailure(
            error,
            "cover_preload",
            "x_article_cover_preload_runtime_failed",
            xArticleCoverAsset(true, false),
          );
        }
      }
      const preloadedCoverAssets = articleCover === null
        ? NO_ASSETS
        : xArticleCoverAsset(true, true);

      // Articles are long-form structured markdown (headings, blocks, inline
      // runs) — no business on a command line. Require a file for that format.
      if (format === "article" && opts.text !== undefined) {
        emitLocalFailure({
          phase: "local",
          code: "x_article_inline_text_unsupported",
          field: "source",
          actual: "--text",
          expected: "--from <base.md> for an X Article",
          unit: null,
        }, "--text is for tweet/thread only. Use --from <base.md> for --format article.", preloadedCoverAssets);
        process.exit(2);
      }

      let md: string;
      let sourceLineOffset = 0;
      let articleImageBaseDirectory = invocationCwd;
      try {
        const input = resolveContentInputDetails(opts, invocationCwd);
        md = input.markdown;
        if (input.kind === "file" && input.sourcePath !== undefined) {
          articleImageBaseDirectory = dirname(input.sourcePath);
        }
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
        return stopForPreStageFailure(
          error,
          "content_input",
          "x_content_input_runtime_failed",
          preloadedCoverAssets,
        );
      }
      // A real file base path (not stdin) is used only to place the --dry-run
      // artifact. Cover selection is always explicit and independent.
      const basePath = opts.from && opts.from !== "-" ? resolve(opts.from) : undefined;

      // DETERMINISTIC generation. No LLM voice pass by default (formatting,
      // splitting, and char-fit must stay reproducible).
      let content: GeneratedContent;
      let inspection: string;
      try {
        const prepared = prepareXTerminalContent(
          await generateContent(md, { format, long: opts.long, sourceLineOffset }),
        );
        content = prepared.content;
        inspection = prepared.inspection;
      } catch (error) {
        return stopForPreStageFailure(
          error,
          "content_generation",
          "x_content_generation_runtime_failed",
          preloadedCoverAssets,
        );
      }

      let articleBodyImages = emptyXArticleBodyImagePreloadSet();
      if (format === "article") {
        const bodyImageCount = content.article!.blocks.reduce(
          (count, block) => count + (block.kind === "image" ? 1 : 0),
          0,
        );
        try {
          articleBodyImages = preloadXArticleBodyImages(
            content.article!.blocks,
            articleImageBaseDirectory,
          );
        } catch (error) {
          return stopForPreStageFailure(
            error,
            "body_image_preload",
            "x_article_body_image_preload_runtime_failed",
            xArticleLocalAssets(true, true, bodyImageCount, false),
          );
        }
      }
      const preloadedArticleAssets = format === "article"
        ? xArticleLocalAssets(
            true,
            true,
            articleBodyImages.occurrences.length,
            true,
          )
        : NO_ASSETS;

      let dryRunArtifacts: {
        contentPath: string;
        contentBody: string;
        inspectionPath?: string;
        inspectionBody?: string;
        receipt: string;
      } | null = null;
      let dryRunNoArtifactReceipt: string | null = null;
      // Project caller paths and reserve the complete pre-runtime transcript
      // before exposing content or writing any artifact.
      try {
        if (!opts.json) output.consume(inspection);
        if (opts.dryRun && basePath) {
          const contentPath = artifactPath(basePath, format);
          const terminalContentPath = renderTerminalInline(projectTerminalText(
            contentPath,
            { lineMode: "inline" },
          ));
          if (format === "article") {
            const inspectionPath = articleInspectionArtifactPath(basePath);
            const terminalInspectionPath = renderTerminalInline(projectTerminalText(
              inspectionPath,
              { lineMode: "inline" },
            ));
            const receipt =
              `\n[dry-run] No browser touched. Clean content written to:\n  ${terminalContentPath}\n` +
              `Inspection receipt written to:\n  ${terminalInspectionPath}`;
            if (!opts.json) output.consume(receipt);
            dryRunArtifacts = {
              contentPath,
              contentBody: artifactBody(content),
              inspectionPath,
              inspectionBody: `${renderFlagsBlock(content)}\n`,
              receipt,
            };
          } else {
            const receipt = `\n[dry-run] No browser touched. Content written to:\n  ${terminalContentPath}`;
            if (!opts.json) output.consume(receipt);
            dryRunArtifacts = {
              contentPath,
              contentBody: artifactBody(content),
              receipt,
            };
          }
        } else if (opts.dryRun) {
          if (!opts.json) {
            dryRunNoArtifactReceipt =
              "\n[dry-run] No browser touched. (No base file — content printed above, no artifact written.)";
            output.consume(dryRunNoArtifactReceipt);
          }
        }
      } catch (error) {
        return stopForPreStageFailure(
          error,
          "terminal_preparation",
          "x_terminal_preparation_runtime_failed",
          preloadedArticleAssets,
        );
      }
      if (!opts.json) console.log(inspection);
      if (dryRunNoArtifactReceipt !== null) console.log(dryRunNoArtifactReceipt);

      if (opts.dryRun) {
        // Write an artifact only when there's a base file to write beside it;
        // inline --text (and stdin) have nowhere to anchor, so print-only.
        if (dryRunArtifacts) {
          try {
            writeFileSync(dryRunArtifacts.contentPath, dryRunArtifacts.contentBody, "utf-8");
          } catch {
            emitTransportReceipt(createTransportReceipt({
              channel: "x", action: "draft", format, mode: "dry_run",
              validation: { local: PASSED_LOCAL_VALIDATION, live: NOT_REACHED_LIVE_VALIDATION },
              warnings: content.warnings,
              gotchas: ["The requested local artifact may be absent, partial, or replaced."],
              assets: preloadedArticleAssets,
              platformTouched: false,
              terminalState: "unknown",
              verification: { status: "not_applicable", strength: "local_only", nativeReference: null },
              remoteResidue: [{ kind: "artifact", state: "write_failed_or_partial", assetIndex: null, reference: null, retryRisk: "none" }],
              error: {
                source: "runtime", stage: "artifact_write", code: "x_artifact_write_failed", httpStatus: null,
                sanitizedMessage: "The local X dry-run artifact write failed.", classification: "known",
                retryable: null, inputRelated: false,
                suggestedCorrection: "Inspect the requested local artifact path before a separate write attempt.",
              },
              exit: { class: "runtime_or_platform_failure", code: 1 },
            }), { json: !!opts.json, budget: output });
            process.exit(1);
          }
          if (dryRunArtifacts.inspectionPath && dryRunArtifacts.inspectionBody !== undefined) {
            try {
              writeFileSync(dryRunArtifacts.inspectionPath, dryRunArtifacts.inspectionBody, "utf-8");
            } catch {
              emitTransportReceipt(createTransportReceipt({
                channel: "x", action: "draft", format, mode: "dry_run",
                validation: { local: PASSED_LOCAL_VALIDATION, live: NOT_REACHED_LIVE_VALIDATION },
                warnings: content.warnings,
                gotchas: ["The clean content artifact exists, but the inspection receipt may be absent, partial, or replaced."],
                assets: preloadedArticleAssets,
                platformTouched: false,
                terminalState: "unknown",
                verification: { status: "not_applicable", strength: "local_only", nativeReference: null },
                remoteResidue: [{ kind: "artifact", state: "content_written_inspection_failed", assetIndex: null, reference: null, retryRisk: "none" }],
                error: {
                  source: "runtime", stage: "inspection_artifact_write", code: "x_inspection_artifact_write_failed", httpStatus: null,
                  sanitizedMessage: "The local X Article inspection receipt write failed after the content artifact returned.", classification: "known",
                  retryable: null, inputRelated: false,
                  suggestedCorrection: "Inspect both local artifact paths before a separate write attempt.",
                },
                exit: { class: "runtime_or_platform_failure", code: 1 },
              }), { json: !!opts.json, budget: output });
              process.exit(1);
            }
          }
          if (!opts.json) console.log(dryRunArtifacts.receipt);
        }
        emitTransportReceipt(createDryRunReceipt({
          channel: "x",
          action: "draft",
          format,
          warnings: content.warnings,
          gotchas: format === "article" && content.article?.codeBlockCount
            ? ["Article code blocks require manual Insert → Code or screenshot handling."]
            : [],
          assets: preloadedArticleAssets,
        }), { json: !!opts.json, budget: output });
        process.exit(0);
      }

      const outcome = await executeXDraftRealRun(
        format === "article"
          ? {
              content,
              inspect: opts.inspect,
              cover: articleCover!,
              bodyImages: articleBodyImages,
            }
          : { content, inspect: opts.inspect, basePath },
        productionXDraftRealRunDependencies,
      );
      emitTransportReceipt(receiptForXDraftOutcome(
        outcome,
        format,
        content.warnings,
        articleCover,
        articleBodyImages,
      ), {
        json: !!opts.json,
        budget: output,
      });
      process.exit(outcome.exitCode);
    });
}

import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { isProxy } from "node:util/types";
import { dirname, basename, extname, join, resolve } from "node:path";
import {
  generateContent,
  renderForInspection,
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
import { isLocalValidationError } from "../capabilities/validation.js";
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
  type XNonArticleStageSnapshot,
  type XArticleStageSnapshotFailure,
} from "../x/articleStageSnapshot.js";

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
  format: string;
  long?: boolean;
  dryRun?: boolean;
  inspect?: boolean;
}

export interface XDraftRealRunInput {
  content: GeneratedContent;
  inspect?: boolean;
  basePath?: string;
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
    message:
      `\n✗ X ${format} draft staging stopped before the native ${mechanism} action was invoked. NEVER posted.\n` +
      (snapshotFailure
        ? `  Local X staging input snapshot validation failed closed (reason=${snapshotFailure}).\n`
        : "") +
      "  No saved-draft outcome is claimed. Verify the local runtime and browser flow before a separate retry.",
  };
}

function uncertainSaveOutcome(
  format: GeneratedContent["format"],
  phase: "save_delivery_unknown" | "save_delivered_unverified",
  draftRowEvidence: XDraftRowEvidence | null = null,
  articleHandoff: XArticleDraftHandoff | null = null,
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
    message:
      `\n✗ ${fact} for the X ${format} draft. NEVER posted.\n` +
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
  const heroAction = handoff.cover.status === "missing"
    ? "no supported cover selected"
    : handoff.cover.status === "upload_incomplete"
      ? "upload action incomplete; attachment unconfirmed"
      : "upload action returned; attachment and persistence unverified";
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
  if (cover.status === "missing") {
    lines.push(
      "  HERO IMAGE MISSING: no supported cover was selected. Add a 5:2 JPG, PNG, or WebP cover and verify it manually.",
    );
  } else {
    if (cover.ratio === "outside_5_2") {
      lines.push(
        `  HERO IMAGE RATIO: selected image is ${cover.width}x${cover.height} (ratio ${(cover.width / cover.height).toFixed(3)}). X may require crop/edit; verify it manually.`,
      );
    } else if (cover.ratio === "unknown") {
      lines.push("  HERO IMAGE RATIO UNVERIFIED: image dimensions were unavailable; verify X's crop/edit result manually.");
    }
    if (cover.status === "upload_incomplete") {
      lines.push("  HERO UPLOAD INCOMPLETE: the selected cover could not be confirmed attached. Attach and verify it manually.");
    } else if (cover.crop === "unverified") {
      lines.push("  HERO CROP UNVERIFIED: a crop/apply confirmation was not observed. Confirm the intended crop manually.");
    } else {
      lines.push("  Hero upload and crop/apply actions returned; cover persistence remains manual-review evidence only.");
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
    message:
      `\n✓ Native X Save action returned (${result.format}, ${count}). NEVER posted.\n` +
      "  scoped-row observation: positive\n" +
      `  full intended ${result.format === "thread" ? "first thread-row" : "tweet"} text observed in one calibrated X Unsent draft row: yes\n` +
      "  visible scoped row multiset changed by exactly that one full-text value: yes\n" +
      "  stable native row id: unavailable; full-list completeness and causality: unproven (visible scoped rows only)\n" +
      "  Review every saved row manually before posting.",
  };
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
  try {
    if (format === "article") {
      const snapshot = snapshotXArticleStageInput(callerContent, format);
      stageContent = snapshot.content;
      expectedArticleCodeBlockCount = snapshot.receiptCodeBlockCount;
      expectedArticleCodeAdvisories = snapshot.codeAdvisories;
      expectedArticleCodeLinkAdvisories = snapshot.codeLinkAdvisories;
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

  // Article retains its separately reviewed #98 option boundary. Non-Article
  // options were copied as part of the complete request snapshot above.
  let inspect: boolean | undefined;
  let basePath: string | undefined;
  if (format === "article") {
    try {
      inspect = input.inspect;
      basePath = input.basePath;
    } catch {
      return beforeSaveFailure(format, "property_read_failed");
    }
    if (
      (inspect !== undefined && typeof inspect !== "boolean") ||
      (basePath !== undefined && (typeof basePath !== "string" || basePath.length > 1_000_000))
    ) {
      return beforeSaveFailure(format, "invalid_value");
    }
  } else {
    inspect = nonArticleSnapshot!.inspect;
    basePath = nonArticleSnapshot!.basePath;
  }

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
      message:
        "\n✗ Could not initialize the X draft staging runtime. No native Save/autosave action was invoked. NEVER posted.\n" +
        "  Verify the local installation and runtime dependencies before a separate retry.",
    };
  }

  let returned: StageDraftResult;
  try {
    const stageOptions: StageDraftOptions = nonArticleSnapshot
      ? nonArticleSnapshot.stageOptions
      : { inspect, basePath };
    returned = await stageDraft(stageContent, stageOptions);
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
        ? beforeSaveFailure(format)
        : uncertainSaveOutcome(format, stageError.savePhase);
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
      );
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
  return `${renderForInspection(content)}\n`;
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

export function registerDraftCommand(x: Command): void {
  x
    .command("draft")
    .description("Stage a NATIVE X draft (tweet/thread/article) from a canonical base markdown — never posts")
    .requiredOption("--format <format>", "Required: tweet | thread | article")
    .option("--text <content>", "Content inline (tweet/thread only; exactly one of --text / --from)")
    .option("--from <base.md>", "Canonical markdown ('-' = stdin); strips leading mapping/empty YAML frontmatter")
    .option("--long", "Use the local 25,000-code-point guard for Premium long posts; X acceptance is server-authoritative")
    .option("--dry-run", "Only generate content; do not open the browser")
    .option("--inspect", "Headful browser so a human can watch/calibrate selectors")
    .addHelpText(
      "after",
      "\nFile/stdin frontmatter:\n" +
        "  A leading empty or YAML mapping block between --- delimiters is metadata only and is removed.\n" +
        "  Metadata keys are ignored; an Article title comes from the normalized Markdown body.\n" +
        "  BOM and LF/CRLF/lone-CR delimiters are recognized; mapping-intent malformed or unterminated metadata exits 2.\n" +
        "  Valid scalar/sequence blocks and thematic-break prose remain literal Markdown apart from a leading transport BOM.\n" +
        "  Inline --text is always literal and is never interpreted as frontmatter.\n" +
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
        "\nArticle staging snapshot:\n" +
        "  Before loading the staging runtime, profile, or browser, the real Article path validates and freezes one closed title/Markdown/block/run/link/code-count snapshot and pre-renders its native HTML/plain inputs.\n" +
        "  It reparses canonical Markdown with the same Article parser and requires the complete code block/advisory/code-link sets to correspond before any sink. Malformed, accessor/proxy, cyclic, sparse/oversized, count-inconsistent, or unsafe-active-href Article structures exit 2 locally with save_not_attempted; runtime and native Save/autosave failures retain exit 1 semantics.\n" +
        "  If the root format cannot be classified safely, the local exit-2 failure is a typed generic save_not_attempted boundary and names no Article or composer save mechanism. Active inline hrefs require exact safe absolute HTTP(S); supported percent bytes remain exact and are not decoded by safety validation. URL-looking advisories from excluded code are bounded but never become active anchors.\n" +
        "\nNative-save outcome:\n" +
        "  Tweet/thread staging invokes the close→Save action; Article staging invokes Create/autosave.\n" +
        "  Tweet/thread success requires one calibrated native Unsent row whose full text exactly matches the intended tweet or first thread row, plus a visible scoped-row multiset equal to the read-only pre-Save baseline plus that one value.\n" +
        "  Matching background/page text, a prefix, a pre-existing identical visible row, duplicate matches, unreadable rows, or other visible-row changes remain unverified. The evidence has no stable native row id and does not prove full-list completeness or causality.\n" +
        "  Article success instead requires matching the title and, when present, body prefix after reopening the captured canonical edit URL.\n" +
        "  A returned Article outcome reports bounded body-input, excluded-code count, complete digest/truncation evidence, bounded code-link provenance/truncation evidence, and cover selection/upload/ratio/crop action facts whether verified or unverified; those facts do not prove cover attachment or persistence. The receipt uses the frozen pre-loader evidence only after exact returned-handoff comparison.\n" +
        "  A rejected Save/Create action has unknown delivery; a returned action without a positive reopen match is unverified. Both exit 1 because a draft may exist.\n" +
        "  Before retrying an unknown/unverified save, compare X Unsent/Drafts or X Articles → Drafts manually in the exact CLI-owned profile used by that run.\n" +
        "  Never retry automatically. --inspect and selector calibration do not prove persistence.\n",
    )
    .action(async (opts: DraftXOptions) => {
      const format = opts.format as XFormat;
      if (!VALID_FORMATS.includes(format)) {
        console.error(`Invalid --format "${opts.format}". Expected one of: ${VALID_FORMATS.join(" | ")}.`);
        process.exit(2);
      }

      // Articles are long-form structured markdown (headings, blocks, inline
      // runs) — no business on a command line. Require a file for that format.
      if (format === "article" && opts.text !== undefined) {
        console.error("--text is for tweet/thread only. Use --from <base.md> for --format article.");
        process.exit(2);
      }

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
      // A real file base path (not stdin) — used to locate an article's hero
      // asset and to place the --dry-run artifact. Undefined for --text/stdin.
      const basePath = opts.from && opts.from !== "-" ? resolve(opts.from) : undefined;

      // DETERMINISTIC generation. No LLM voice pass by default (formatting,
      // splitting, and char-fit must stay reproducible).
      let content: GeneratedContent;
      try {
        content = await generateContent(md, { format, long: opts.long, sourceLineOffset });
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        console.error(error.message);
        process.exit(2);
      }

      // Always show the generated content + advisory flags to the operator.
      console.log(renderForInspection(content));

      if (opts.dryRun) {
        // Write an artifact only when there's a base file to write beside it;
        // inline --text (and stdin) have nowhere to anchor, so print-only.
        if (basePath) {
          const outPath = artifactPath(basePath, format);
          writeFileSync(outPath, artifactBody(content), "utf-8");
          if (format === "article") {
            const inspectionPath = articleInspectionArtifactPath(basePath);
            writeFileSync(inspectionPath, `${renderFlagsBlock(content)}\n`, "utf-8");
            console.log(
              `\n[dry-run] No browser touched. Clean content written to:\n  ${outPath}\n` +
              `Inspection receipt written to:\n  ${inspectionPath}`,
            );
          } else {
            console.log(`\n[dry-run] No browser touched. Content written to:\n  ${outPath}`);
          }
        } else {
          console.log("\n[dry-run] No browser touched. (No base file — content printed above, no artifact written.)");
        }
        process.exit(0);
      }

      const outcome = await executeXDraftRealRun(
        { content, inspect: opts.inspect, basePath },
        productionXDraftRealRunDependencies,
      );
      if (outcome.stream === "stdout") console.log(outcome.message);
      else console.error(outcome.message);
      process.exit(outcome.exitCode);
    });
}

import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { dirname, basename, extname, join, resolve } from "node:path";
import {
  generateContent,
  renderForInspection,
  type GeneratedContent,
  type XFormat,
} from "../x/content.js";
import { isLocalValidationError } from "../capabilities/validation.js";
import { resolveContentInputDetails, splitLeadingFrontmatter } from "./contentInput.js";
import {
  isXDraftRowEvidenceCompatible,
  isXDraftReturnedSavePhase,
  isXDraftStageError,
  snapshotXArticleDraftHandoff,
  snapshotXDraftRowEvidence,
  X_ARTICLE_CODE_BLOCK_COUNT_LIMIT,
  type XArticleDraftHandoff,
  type XDraftRowEvidence,
  type XDraftSaveMechanism,
  type XDraftSavePhase,
} from "../x/saveProgress.js";
import type { StageDraftOptions, StageDraftResult } from "../x/draftPoster.js";

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
  saveMechanism: XDraftSaveMechanism;
  exitCode: 0 | 1;
  stream: "stdout" | "stderr";
  message: string;
  draftRowEvidence: XDraftRowEvidence | null;
  articleHandoff: XArticleDraftHandoff | null;
}

function nativeDraftLocation(format: GeneratedContent["format"]): string {
  return format === "article" ? "X Articles → Drafts" : "X Unsent/Drafts";
}

function beforeSaveFailure(format: GeneratedContent["format"]): XDraftRealRunOutcome {
  const mechanism = format === "article" ? "Article Create/autosave" : "composer Save";
  return {
    kind: "save_incomplete",
    savePhase: "save_not_attempted",
    saveMechanism: format === "article" ? "article_create_autosave" : "composer_close_save",
    exitCode: 1,
    stream: "stderr",
    draftRowEvidence: null,
    articleHandoff: null,
    message:
      `\n✗ X ${format} draft staging stopped before the native ${mechanism} action was invoked. NEVER posted.\n` +
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

/** Stateful X draft boundary; dry-run returns before this seam is called. */
export async function executeXDraftRealRun(
  input: XDraftRealRunInput,
  deps: XDraftRealRunDependencies,
): Promise<XDraftRealRunOutcome> {
  let stageDraft: Awaited<ReturnType<XDraftRealRunDependencies["loadStageDraft"]>>;
  try {
    stageDraft = await deps.loadStageDraft();
  } catch {
    return {
      kind: "stage_runtime_failed",
      savePhase: "save_not_attempted",
      saveMechanism: input.content.format === "article"
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
      saveMechanism: input.content.format === "article"
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

  let result: StageDraftResult;
  try {
    const returned = await stageDraft(input.content, {
      inspect: input.inspect,
      basePath: input.basePath,
    });
    if (typeof returned !== "object" || returned === null) {
      return uncertainSaveOutcome(input.content.format, "save_delivery_unknown");
    }
    // Snapshot each untrusted port field once while exceptions are guarded.
    // A proxy/stateful getter must not pass validation and later change the
    // human receipt or manufacture a verified outcome.
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
      candidate.format !== input.content.format ||
      candidate.posts !== (input.content.format === "thread"
        ? (input.content.thread?.length ?? 0)
        : 1) ||
      candidate.saveMechanism !== (input.content.format === "article"
        ? "article_create_autosave"
        : "composer_close_save") ||
      !isXDraftReturnedSavePhase(candidate.savePhase) ||
      candidate.draftRowEvidence === null ||
      (candidate.saveMechanism === "article_create_autosave" &&
        candidate.articleHandoff === null) ||
      !isXDraftRowEvidenceCompatible(
        candidate.saveMechanism,
        candidate.savePhase,
        candidate.draftRowEvidence,
      )
    ) {
      return uncertainSaveOutcome(input.content.format, "save_delivery_unknown");
    }
    result = candidate as StageDraftResult;
  } catch (error) {
    if (isXDraftStageError(error)) {
      const expectedMechanism = input.content.format === "article"
        ? "article_create_autosave"
        : "composer_close_save";
      if (error.saveMechanism !== expectedMechanism) {
        return uncertainSaveOutcome(input.content.format, "save_delivery_unknown");
      }
      return error.savePhase === "save_not_attempted"
        ? beforeSaveFailure(input.content.format)
        : uncertainSaveOutcome(input.content.format, error.savePhase);
    }
    // Once the staging function was invoked, an untyped exception carries no
    // reliable Save boundary. Conservatively assume delivery may have happened.
    return uncertainSaveOutcome(input.content.format, "save_delivery_unknown");
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
    // Article artifact = the publishable markdown, with flags appended as an
    // HTML comment so the markdown itself stays clean.
    const flags = renderFlagsBlock(content);
    return flags ? `${content.article.markdown}\n\n<!--\n${flags}\n-->\n` : `${content.article.markdown}\n`;
  }
  // tweet/thread artifact = the full inspection render (text + flags + warnings).
  return `${renderForInspection(content)}\n`;
}

function renderFlagsBlock(content: GeneratedContent): string {
  const out: string[] = [];
  for (const f of content.codeFlags) {
    out.push(`CODE BLOCK #${f.index}${f.lang ? ` [${f.lang}]` : ""} (line ${f.sourceLine}) → screenshot on X: ${f.preview}`);
  }
  for (const f of content.linkFlags) {
    out.push(`LINK ${f.url}${f.text ? ` (${f.text})` : ""} — ${f.note}`);
  }
  for (const w of content.warnings) out.push(`WARNING: ${w}`);
  return out.join("\n");
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
        "\nNative-save outcome:\n" +
        "  Tweet/thread staging invokes the close→Save action; Article staging invokes Create/autosave.\n" +
        "  Tweet/thread success requires one calibrated native Unsent row whose full text exactly matches the intended tweet or first thread row, plus a visible scoped-row multiset equal to the read-only pre-Save baseline plus that one value.\n" +
        "  Matching background/page text, a prefix, a pre-existing identical visible row, duplicate matches, unreadable rows, or other visible-row changes remain unverified. The evidence has no stable native row id and does not prove full-list completeness or causality.\n" +
        "  Article success instead requires matching the title and, when present, body prefix after reopening the captured canonical edit URL.\n" +
        "  A returned Article outcome reports bounded body-input, excluded-code, and cover selection/upload/ratio/crop action facts whether verified or unverified; those facts do not prove cover attachment or persistence.\n" +
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
          console.log(`\n[dry-run] No browser touched. Content written to:\n  ${outPath}`);
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

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
  isXDraftReturnedSavePhase,
  isXDraftStageError,
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
 *   5. Report: draft staged on X (or, with --dry-run, where content was written).
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
}

function nativeDraftLocation(format: GeneratedContent["format"]): string {
  return format === "article" ? "X Articles → Drafts" : "X Unsent/Drafts";
}

function verificationEvidenceLabel(format: GeneratedContent["format"]): string {
  return format === "article"
    ? "by reopening the canonical Article edit URL"
    : "in X Unsent/Drafts";
}

function beforeSaveFailure(format: GeneratedContent["format"]): XDraftRealRunOutcome {
  const mechanism = format === "article" ? "Article Create/autosave" : "composer Save";
  return {
    kind: "save_incomplete",
    savePhase: "save_not_attempted",
    saveMechanism: format === "article" ? "article_create_autosave" : "composer_close_save",
    exitCode: 1,
    stream: "stderr",
    message:
      `\n✗ X ${format} draft staging stopped before the native ${mechanism} action was invoked. NEVER posted.\n` +
      "  No saved-draft outcome is claimed. Verify the local runtime and browser flow before a separate retry.",
  };
}

function uncertainSaveOutcome(
  format: GeneratedContent["format"],
  phase: "save_delivery_unknown" | "save_delivered_unverified",
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
    message:
      `\n✗ ${fact} for the X ${format} draft. NEVER posted.\n` +
      `  A native draft may exist. Before any retry, compare ${location} manually in the exact CLI-owned profile used by this run.\n` +
      "  Do not retry automatically. Selector calibration and --inspect cannot prove whether the draft persisted.",
  };
}

function stagedOutcome(result: StageDraftResult): XDraftRealRunOutcome {
  const count = result.format === "thread"
    ? `${result.posts} posts`
    : result.format === "article"
      ? "1 article"
      : "1 tweet";
  return {
    kind: "staged",
    savePhase: "verified",
    saveMechanism: result.saveMechanism,
    exitCode: 0,
    stream: "stdout",
    message:
      `\n✓ Staged a NATIVE X draft (${result.format}, ${count}). NEVER posted.\n` +
      `  verified ${verificationEvidenceLabel(result.format)}: yes\n` +
      `  ${result.note}`,
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
      note: returned.note,
      saveMechanism: returned.saveMechanism,
      savePhase: returned.savePhase,
    };
    if (
      candidate.format !== input.content.format ||
      candidate.posts !== (input.content.format === "thread"
        ? (input.content.thread?.length ?? 0)
        : 1) ||
      typeof candidate.note !== "string" ||
      candidate.saveMechanism !== (input.content.format === "article"
        ? "article_create_autosave"
        : "composer_close_save") ||
      !isXDraftReturnedSavePhase(candidate.savePhase)
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
    : uncertainSaveOutcome(result.format, "save_delivered_unverified");
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
        "  Success requires observing a normalized prefix of the intended tweet or first thread post on the exact X Unsent/Drafts route, or matching the Article title and, when present, body prefix.\n" +
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

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
import { resolveContentInput } from "./contentInput.js";

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
    .option("--from <base.md>", "Path to the canonical base markdown ('-' = stdin)")
    .option("--long", "Use the local 25,000-code-point guard for Premium long posts; X acceptance is server-authoritative")
    .option("--dry-run", "Only generate content; do not open the browser")
    .option("--inspect", "Headful browser so a human can watch/calibrate selectors")
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
      try {
        md = resolveContentInput(opts);
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
        content = await generateContent(md, { format, long: opts.long });
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

      // Real run: stage a native draft on X. Import the poster lazily so --dry-run
      // (and `--help`) never pull in Playwright / the session module.
      const { stageDraft } = await import("../x/draftPoster.js");

      try {
        const result = await stageDraft(content, { inspect: opts.inspect, basePath });
        const count =
          result.format === "thread"
            ? `${result.posts} posts`
            : result.format === "article"
              ? "1 article"
              : "1 tweet";
        console.log(
          `\n✓ Staged a NATIVE X draft (${result.format}, ${count}). NEVER posted.\n` +
            `  verified in Unsent/Drafts: ${result.verified ? "yes" : "unconfirmed"}\n` +
            `  ${result.note}`,
        );
        process.exit(0);
      } catch (err) {
        console.error(`\n✗ Failed to stage the X draft: ${(err as Error).message}`);
        console.error(
          "  Composer selectors may need live calibration — re-run with --inspect to watch the DOM.",
        );
        process.exit(1);
      }
    });
}

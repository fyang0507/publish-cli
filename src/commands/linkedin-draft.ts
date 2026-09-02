import { Command } from "commander";
import { resolve } from "node:path";
import { generatePost, renderPostForInspection } from "../linkedin/content.js";
import {
  isLocalValidationError,
  validateLinkedInMedia,
  type LinkedInMediaValidationResult,
} from "../capabilities/validation.js";
import { resolveContentInputDetails, splitLeadingFrontmatter } from "./contentInput.js";

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

/** Commander collector for the repeatable --media flag. */
function collectMedia(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function renderMediaValidation(result: LinkedInMediaValidationResult): string {
  if (result.items.length === 0) return "";
  const lines = ["", "── local media validation (caller order) ──"];
  for (const [index, item] of result.items.entries()) {
    lines.push(
      `${index + 1}. ${item.path}`,
      `   ${item.contentType}; ${item.width}x${item.height}; ${item.sizeBytes} bytes; aspect ${item.aspectRatio?.toFixed(4)}`,
    );
  }
  lines.push(
    "   locally verified: readable file, magic/header type, extension match, dimensions, bytes, order",
    `   server-authoritative/unverified: ${result.unverifiedConstraints.join(", ")}`,
  );
  return lines.join("\n");
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
    .action(async (opts: LinkedInDraftOptions) => {
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
        console.error(error.message);
        process.exit(2);
      }

      // Resolve + validate media before content generation or any platform import.
      const media = (opts.media ?? []).map((m) => resolve(m));
      const mediaValidation = validateLinkedInMedia(media);
      if (!mediaValidation.valid) {
        for (const error of mediaValidation.errors) console.error(error);
        process.exit(2);
      }

      // DETERMINISTIC generation (no LLM).
      let post;
      try {
        post = generatePost(md, { bold: opts.bold, sourceLineOffset });
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        console.error(error.message);
        process.exit(2);
      }

      // Always show the generated post + advisory flags to the operator.
      console.log(renderPostForInspection(post));
      const mediaReport = renderMediaValidation(mediaValidation);
      if (mediaReport) console.log(mediaReport);

      if (opts.dryRun) {
        console.log("\n[dry-run] No browser touched. (Post printed above, no draft staged.)");
        process.exit(0);
      }

      // Real run: stage a native draft on LinkedIn. Import the poster lazily so
      // --dry-run (and `--help`) never pull in Playwright / the session module.
      const { stagePost } = await import("../linkedin/draftPoster.js");

      try {
        const result = await stagePost(post, { inspect: opts.inspect, media });
        console.log(
          `\n✓ Staged a NATIVE LinkedIn draft (post). NEVER posted.\n` +
            `  verified in drafts: ${result.verified ? "yes" : "unconfirmed"}\n` +
            `  ${result.note}`,
        );
        process.exit(0);
      } catch (err) {
        console.error(`\n✗ Failed to stage the LinkedIn draft: ${(err as Error).message}`);
        console.error(
          "  Composer selectors may need live calibration — re-run with --inspect to watch the DOM.",
        );
        process.exit(1);
      }
    });
}

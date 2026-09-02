import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { generatePost, renderPostForInspection } from "../linkedin/content.js";
import { resolveContentInput } from "./contentInput.js";

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
 *      single post, 3,000 UTF-16 code-unit cap (over cap → leading segment + warning, never
 *      silent truncation), above-the-fold hook advisory, markdown → plain text,
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

export function registerLinkedInDraftCommand(linkedin: Command): void {
  linkedin
    .command("draft")
    .description("Stage a NATIVE LinkedIn post draft from inline text or a markdown file — never posts")
    .option("--text <content>", "Post content inline (the primary path; exactly one of --text / --from)")
    .option("--from <base.md>", "Path to a canonical base markdown ('-' = stdin)")
    .option("--media <path>", "Image to attach (repeatable; attached in order)", collectMedia, [])
    .option("--bold", "Opt-in Unicode math-bold for **emphasis** (accessibility caveat — see output)")
    .option("--dry-run", "Only generate the post; do not open the browser")
    .option("--inspect", "Headful browser so a human can watch/calibrate selectors")
    .action(async (opts: LinkedInDraftOptions) => {
      const md = resolveContentInput(opts);

      // Resolve + validate media paths up front (setInputFiles needs real files).
      const media = (opts.media ?? []).map((m) => resolve(m));
      for (const m of media) {
        if (!existsSync(m)) {
          console.error(`Media file not found: ${m}`);
          process.exit(2);
        }
      }

      // DETERMINISTIC generation (no LLM).
      const post = generatePost(md, { bold: opts.bold });

      // Always show the generated post + advisory flags to the operator.
      console.log(renderPostForInspection(post));

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

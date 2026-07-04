import { Command } from "commander";
import { resolveContentInput, type ContentInputOptions } from "./contentInput.js";
import {
  generateSelfPost,
  renderSelfPostForInspection,
  preflightSelfPost,
  type GeneratedSelfPost,
} from "../reddit/content.js";

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
 *   3. Reader-backed SUBREDDIT PREFLIGHT (§4): fetch the target's about + flairs
 *      + post_requirements through the authenticated browser context and validate
 *      the post against the declared contract. Violations → exit 1, never a draft
 *      the subreddit would reject. Runs for BOTH --dry-run and real runs so the
 *      operator sees identical violations.
 *   4. --dry-run: stop after preflight — no composer touched.
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
}

export function registerRedditDraftCommand(reddit: Command): void {
  reddit
    .command("draft")
    .description("Stage a NATIVE Reddit self-post draft from inline text or a markdown file — never posts")
    .option("--subreddit <name>", "Target subreddit (or from --from frontmatter)")
    .option("--title <title>", "Post title, ≤300 chars (or from frontmatter / markdown H1)")
    .option("--text <content>", "Body content inline (exactly one of --text / --from)")
    .option("--from <base.md>", "Path to a canonical base markdown ('-' = stdin); the primary path")
    .option("--flair <id|text>", "Flair template id, or text matched to a template")
    .option("--nsfw", "Mark the post NSFW")
    .option("--spoiler", "Mark the post as a spoiler")
    .option("--dry-run", "Generate + preflight-validate only; do not open the composer")
    .option("--inspect", "Headful browser so a human can watch/calibrate selectors")
    .action(async (opts: RedditDraftOptions) => {
      const md = resolveContentInput(opts);

      // DETERMINISTIC generation (no LLM). Throws on missing / oversized title —
      // treat as a usage error (exit 2), same tier as resolveContentInput.
      let post: GeneratedSelfPost;
      try {
        post = generateSelfPost(md, {
          subreddit: opts.subreddit,
          title: opts.title,
          flair: opts.flair,
          nsfw: opts.nsfw,
          spoiler: opts.spoiler,
        });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(2);
      }

      // Always show the generated post + advisory flags to the operator.
      console.log(renderSelfPostForInspection(post));

      const subreddit = post.subreddit;
      if (!subreddit) {
        console.error(
          "\nNo target subreddit. Provide --subreddit <name> or a `subreddit:` frontmatter key.",
        );
        process.exit(2);
      }

      // --dry-run is BROWSER-FREE: stop after deterministic generation + the local
      // advisories already printed above. The reader-backed subreddit preflight (§4)
      // needs the authenticated browser context, so it is intentionally deferred to
      // the real run — dry-run never launches a browser or requires credentials.
      if (opts.dryRun) {
        console.log(
          `\n[dry-run] Deterministic generation + local validation passed for r/${subreddit}. ` +
            `No browser launched, no draft staged.\n` +
            `  Note: the reader-backed subreddit-rules preflight (flair/title/body/type contract) ` +
            `requires the authenticated browser and is skipped in --dry-run. Re-run without --dry-run ` +
            `to validate against the live subreddit contract before staging.`,
        );
        process.exit(0);
      }

      // From here on the shared Reddit session may be opened; run closeSession()
      // exactly once at the end (reader + composer share getBrowserContext).
      const { BrowserRedditReader } = await import("../reddit/reader.js");
      const { closeSession } = await import("../reddit/session.js");
      const { env } = await import("../config.js");

      // The preflight reads hit Reddit's headless-403 fingerprint wall on the same
      // hosts as inspect/search (design #4), so honor REDDIT_READS_HEADFUL here too —
      // otherwise `draft` would fail preflight on a host where reads were made to
      // work. (No silent headless→headful auto-retry mid-draft: the composer shares
      // this session, so we pick the mode up front instead.)
      const headful = !!opts.inspect || env.REDDIT_READS_HEADFUL;

      let exitCode = 0;
      try {
        const reader = new BrowserRedditReader({ inspect: headful });
        await reader.init();

        // Reader-backed preflight (§4) — the same reads the composer would need.
        const [about, flairs, postRequirements] = await Promise.all([
          reader.fetchAbout(subreddit),
          reader.fetchFlairs(subreddit),
          reader.fetchPostRequirements(subreddit),
        ]);
        const preflight = preflightSelfPost(post, { about, postRequirements, flairs });

        for (const w of preflight.warnings) console.log(`  advisory: ${w}`);

        if (!preflight.ok) {
          console.error(`\n✗ Preflight failed for r/${subreddit}:`);
          for (const v of preflight.violations) console.error(`  - ${v}`);
          exitCode = 1;
        } else {
          // Real run: stage a native draft. Preflight already ran; pass the
          // resolved flair id straight through to the composer.
          const { stageDraft } = await import("../reddit/draftPoster.js");
          const result = await stageDraft(post, {
            inspect: headful,
            flairId: preflight.resolvedFlair?.id,
            flairText: preflight.resolvedFlair?.text,
          });

          if (result.blocked) {
            // Eligibility block (§4.1) — reported plainly, draft NOT staged.
            console.error(`\n✗ ${result.blocked}`);
            exitCode = 1;
          } else if (!result.saved) {
            // The "Save Draft" affordance never resolved — the poster bailed rather
            // than guess another button (never falls through to Post). Nothing was
            // staged, so this is a FAILURE, not a green ✓ (would otherwise read as a
            // success to any agent keying on the ✓ / exit code).
            console.error(
              `\n✗ Could NOT stage a draft to r/${result.subreddit} — nothing was saved (NEVER posted).\n` +
                `  ${result.note}`,
            );
            exitCode = 1;
          } else {
            console.log(
              `\n✓ Staged a NATIVE Reddit draft (self-post) to r/${result.subreddit}. NEVER posted.\n` +
                `  verified in drafts: ${result.verified ? "yes" : "unconfirmed"}\n` +
                (result.flair ? `  flair: ${result.flair}\n` : "") +
                `  ${result.note}`,
            );
          }
        }
      } catch (err) {
        console.error(`\n✗ Failed to stage the Reddit draft: ${(err as Error).message}`);
        console.error(
          "  Composer/reader selectors may need live calibration — re-run with --inspect to watch the DOM.",
        );
        exitCode = 1;
      } finally {
        await closeSession();
      }

      process.exit(exitCode);
    });
}

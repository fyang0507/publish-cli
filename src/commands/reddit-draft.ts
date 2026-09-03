import { Command } from "commander";
import {
  resolveContentInputDetails,
  splitLeadingFrontmatter,
  type ContentInputOptions,
} from "./contentInput.js";
import {
  generateSelfPost,
  renderSelfPostForInspection,
  preflightSelfPost,
  validateRedditFrontmatter,
  type GeneratedSelfPost,
} from "../reddit/content.js";
import { isLocalValidationError, LocalValidationError } from "../capabilities/validation.js";
import type { StageDraftResult } from "../reddit/draftPoster.js";

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
 *   3. --dry-run: stop after deterministic local validation — no browser or live
 *      subreddit preflight.
 *   4. Real run only: reader-backed SUBREDDIT PREFLIGHT (§4) fetches the target's
 *      about + flairs + post_requirements through the authenticated context.
 *      Violations → exit 1 before composer staging.
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

export interface RedditStageCommandOutcome {
  exitCode: 0 | 1;
  stream: "stdout" | "stderr";
  message: string;
}

/** Keep save-confirmation truth and exit semantics independent of browser code. */
export function classifyRedditStageResult(result: StageDraftResult): RedditStageCommandOutcome {
  if (result.blocked) {
    return { exitCode: 1, stream: "stderr", message: `\n✗ ${result.blocked}` };
  }
  if (result.saveStatus === "not_attempted" || !result.saved) {
    return {
      exitCode: 1,
      stream: "stderr",
      message:
        `\n✗ No Reddit draft was confirmed for r/${result.subreddit} (NEVER posted).\n` +
        `  ${result.note}`,
    };
  }
  if (result.saveStatus === "unconfirmed" || !result.verified) {
    return {
      exitCode: 1,
      stream: "stderr",
      message:
        `\n✗ Reddit draft state for r/${result.subreddit} is UNCONFIRMED (NEVER posted).\n` +
        `  ${result.note}`,
    };
  }
  return {
    exitCode: 0,
    stream: "stdout",
    message:
      `\n✓ Staged a NATIVE Reddit draft (self-post) to r/${result.subreddit}. NEVER posted.\n` +
      "  verified by Draft saved toast: yes\n" +
      (result.flair ? `  flair: ${result.flair}\n` : "") +
      `  ${result.note}`,
  };
}

export function registerRedditDraftCommand(reddit: Command): void {
  reddit
    .command("draft")
    .description("Stage a NATIVE Reddit self-post draft from inline text or a markdown file — never posts")
    .option("--subreddit <name>", "Target subreddit (or from --from frontmatter)")
    .option("--title <title>", "Post title, ≤300 chars (or from frontmatter / markdown H1)")
    .option("--text <content>", "Body content inline (exactly one of --text / --from)")
    .option(
      "--from <base.md>",
      "Canonical markdown file ('-' = stdin); accepts frontmatter keys subreddit/title/flair",
    )
    .option("--flair <id|text>", "Flair template id, or text matched to a template")
    .option("--nsfw", "Mark the post NSFW (flag-only; not accepted in frontmatter)")
    .option("--spoiler", "Mark the post as a spoiler (flag-only; not accepted in frontmatter)")
    .option("--dry-run", "Generate and validate locally; skips live subreddit preflight and composer")
    .option("--inspect", "Headful browser so a human can watch/calibrate selectors")
    .addHelpText(
      "after",
      "\nFile/stdin frontmatter:\n" +
        "  Accepted keys: subreddit, title, flair (string values). Flags override metadata.\n" +
        "  Empty --subreddit/--title values reject; empty --flair intentionally clears metadata.\n" +
        "  Empty mappings are accepted; unsupported/malformed mapping metadata exits 2.\n" +
        "  BOM and LF/CRLF/lone-CR delimiters are recognized; unterminated metadata exits 2.\n" +
        "  For an unclosed opener, only the first substantive block establishes mapping intent.\n" +
        "  Valid scalar/sequence blocks remain literal Markdown. Inline --text is always literal.\n" +
        "\nMarkdown portability:\n" +
        "  Use 4-space-indented code for old/new Reddit portability. Tables should use outer pipes.\n" +
        "  Inline body images are not uploaded or verified by this text-only draft command.\n" +
        "  Real runs require the Draft saved toast to be absent before the one Save Draft click.\n" +
        "  If a fresh toast is not observed, exit 1 and compare DRAFTS manually in the same\n" +
        "  CLI-owned profile. Never blindly retry (duplicate risk; no draft idempotency ledger).\n",
    )
    .action(async (opts: RedditDraftOptions) => {
      let md: string;
      let frontmatter = {};
      let bodyLineOffset = 0;
      try {
        const input = resolveContentInputDetails(opts);
        md = input.markdown;
        if (input.kind !== "text") {
          const sourceName = input.kind === "stdin" ? "stdin (--from -)" : (input.sourcePath ?? "--from input");
          const split = splitLeadingFrontmatter(md, sourceName, {
            policy: "mapping-only",
            preserveBodyLineEndings: true,
          });
          md = split.body;
          frontmatter = validateRedditFrontmatter(split.data, sourceName);
          bodyLineOffset = split.bodyLineOffset;
        }
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        console.error(error.message);
        process.exit(2);
      }

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
          frontmatter,
          bodyLineOffset,
        });
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        console.error(error.message);
        process.exit(2);
      }

      // Always show the generated post + advisory flags to the operator.
      console.log(renderSelfPostForInspection(post));

      const subreddit = post.subreddit;
      if (!subreddit) {
        const error = new LocalValidationError(
          "No target subreddit. Provide --subreddit <name> or a `subreddit:` frontmatter key.",
          {
            code: "reddit_subreddit_missing",
            field: "target",
            actual: null,
            expected: "non-empty --subreddit or subreddit frontmatter",
            unit: null,
          },
        );
        console.error(`\n${error.message}`);
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

          const outcome = classifyRedditStageResult(result);
          if (outcome.stream === "stderr") console.error(outcome.message);
          else console.log(outcome.message);
          exitCode = outcome.exitCode;
        }
      } catch (err) {
        console.error(`\n✗ Failed to stage the Reddit draft: ${(err as Error).message}`);
        console.error(
          "  Native draft state is not confirmed. Compare Reddit DRAFTS manually in the same " +
            "CLI-owned profile before any retry; another attempt can duplicate an existing draft " +
            "because Reddit has no draft idempotency ledger. Use --inspect only after that check " +
            "if selector calibration is still needed.",
        );
        exitCode = 1;
      } finally {
        await closeSession();
      }

      process.exit(exitCode);
    });
}

/**
 * LinkedIn draft poster — drives the persistent, already-logged-in LinkedIn
 * browser profile (session.getBrowserContext()) to stage a NATIVE FEED-POST DRAFT
 * and STOP THERE.
 *
 * HARD BOUNDARY: this module MUST NEVER click Post / publish. It opens the share
 * composer, types the generated post, optionally attaches media, and SAVES IT AS A
 * DRAFT via LinkedIn's own "Save as draft" affordance — so the result sits one
 * click from publishing, and a human takes that click. There is intentionally NO
 * code path that locates or clicks the Post button; it appears in
 * LI_COMPOSER_SELECTORS (./selectors.ts) ONLY as a documented FORBIDDEN selector, exactly as X's
 * tweetButton does in src/x/draftPoster.ts. The send action is future scope behind
 * the SEND-GATE (PRODUCT_SPEC §5). The one Discard click allowed is on a draft the
 * composer restored, before any new text is typed (./composer.ts, #137).
 *
 * REUSE: the tolerant/optional locator primitives and the contenteditable typing
 * helper are channel-agnostic and imported from ../x/draftPoster.js
 * (tolerantLocator / optionalLocator / typeText). X's saveAsDraft is NOT reused —
 * it is hard-bound to X's close→confirmationSheet selectors — so LinkedIn's
 * close→"Save as draft" flow is implemented here against LI_COMPOSER_SELECTORS,
 * mirroring X's "don't guess another button" safeguard.
 *
 * SELECTOR DRIFT — READ THIS: every selector in LI_COMPOSER_SELECTORS is
 * BEST-EFFORT and NEEDS LIVE CALIBRATION against the current linkedin.com composer
 * DOM. LinkedIn's composer/media/drafts affordances drift like X's. Run
 * `publish linkedin draft ... --inspect` (headful) to watch the flow and
 * recalibrate. Nothing here is trustworthy until verified live (AGENTS.md).
 *
 * The session module is the SINGLE authenticator — we never log in here; we only
 * borrow its persistent context.
 */

import type { BrowserContext, Page, Locator } from "playwright";
import { getBrowserContext, type EnsureSessionOptions } from "./session.js";
import { optionalLocator, typeText } from "../x/draftPoster.js";
import { snapshotLinkedInGeneratedPost, type GeneratedPost } from "./content.js";
import { dismissPreviewCard, startEmptyComposer, verifyDraftSaved } from "./composer.js";
import { LI_COMPOSER_SELECTORS } from "./selectors.js";
import {
  createLinkedInMediaStageEvidence,
  LINKEDIN_DRAFT_SAVE_MECHANISM,
  linkedInDraftStageError,
  runLinkedInDraftSaveFlow,
  type LinkedInDraftSaveFlowResult,
  type LinkedInDraftStageProgress,
  type LinkedInDraftStageResult,
} from "./saveProgress.js";

export interface StagePostOptions extends EnsureSessionOptions {
  /** Headful + slower so a human can watch/calibrate. Maps to --inspect. */
  inspect?: boolean;
  /** Absolute paths to image files to attach, in order (repeatable --media). */
  media?: string[];
}

export type StagePostResult = LinkedInDraftStageResult;

/**
 * Resolve the composer's file input WITHOUT a visibility gate.
 *
 * WHY: LinkedIn (like virtually every site) renders its media input[type=file]
 * hidden. optionalLocator/tolerantLocator wait for state:"visible", so they would
 * time out on a hidden input and never reach setInputFiles — even though
 * setInputFiles works fine on hidden inputs. Here we wait for state:"attached"
 * instead, so we can drive the hidden input directly. Returns null if none of the
 * candidate selectors attach within the budget.
 */
async function resolveHiddenFileInput(page: Page): Promise<Locator | null> {
  const candidates = LI_COMPOSER_SELECTORS.mediaFileInput;
  const per = Math.max(1500, Math.floor(5_000 / candidates.length));
  for (const sel of candidates) {
    const locator = sel.startsWith("//") ? page.locator(`xpath=${sel}`) : page.locator(sel);
    try {
      await locator.first().waitFor({ state: "attached", timeout: per });
      return locator.first();
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Hand media files to the open composer. LinkedIn feed images are ratio-flexible,
 * so (unlike X's 5:2 hero) there is NO ratio gate. A returned setInputFiles call
 * proves only that the requested files were set on the chooser/input. It does not
 * prove that LinkedIn rendered, attached, ordered, cropped, or persisted them.
 *
 * Two robust paths (mirrors X's uploadHeroImage), neither of which depends on the
 * file input being VISIBLE:
 *   1. Click the visible "Add media" button and capture the OS file chooser via
 *      page.waitForEvent("filechooser"), then chooser.setFiles(media).
 *   2. Fall back to resolving the hidden input[type=file] with a state:"attached"
 *      wait (NOT visible) and calling setInputFiles directly.
 */
export interface LinkedInMediaSetDependencies {
  acquireChooser(page: Page): Promise<{ setFiles(paths: string[]): Promise<void> } | null>;
  resolveFileInput(page: Page): Promise<{ setInputFiles(paths: string[]): Promise<void> } | null>;
  finishSelection(page: Page): Promise<void>;
}

const productionLinkedInMediaSetDependencies: LinkedInMediaSetDependencies = {
  async acquireChooser(page) {
    const mediaBtn = await optionalLocator(page, LI_COMPOSER_SELECTORS.mediaButton, 3_000);
    if (!mediaBtn) return null;
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 5_000 }),
        mediaBtn.click(),
      ]);
      return chooser;
    } catch {
      // No file-setting call was invoked, so the hidden-input path remains safe.
      return null;
    }
  },
  resolveFileInput(page) {
    return resolveHiddenFileInput(page);
  },
  async finishSelection(page) {
    const next = await optionalLocator(page, LI_COMPOSER_SELECTORS.mediaNextButton, 5_000);
    if (next) await next.click().catch(() => {});
    await page.waitForTimeout(750);
  },
};

export async function setComposerMedia(
  page: Page,
  media: string[],
  updateSetState: (state: boolean | null) => void,
  deps: LinkedInMediaSetDependencies = productionLinkedInMediaSetDependencies,
): Promise<boolean> {
  if (media.length === 0) return true;

  // Path 1: acquire the visible button's chooser. Fallback is safe only when
  // acquisition fails before any file-setting call is invoked.
  const chooser = await deps.acquireChooser(page);
  if (chooser) {
    updateSetState(null);
    try {
      await chooser.setFiles(media);
    } catch {
      // The rejected call may already have taken effect. Preserve unknown set
      // state and never attempt the hidden input automatically.
      return false;
    }
    updateSetState(true);
    await deps.finishSelection(page);
    return true;
  }

  // Path 2: drive the hidden input[type=file] directly. setInputFiles works on
  // hidden inputs; we just must NOT gate the lookup on visibility.
  const fileInput = await deps.resolveFileInput(page);
  if (!fileInput) return false;

  try {
    // The input accepts multiple files; set them all in order in one call.
    updateSetState(null);
    await fileInput.setInputFiles(media);
    updateSetState(true);
  } catch {
    return false;
  }

  await deps.finishSelection(page);

  return true;
}

/**
 * Save the current composer as a draft WITHOUT posting.
 *
 * Flow: click the composer Close → LinkedIn raises "Save this post as a draft?" →
 * click "Save as draft". The Save click is its own delivery boundary: a
 * rejected promise may still mean LinkedIn received the click.
 *
 * SAFEGUARD (mirrors X's saveAsDraft): if the "Save as draft" affordance does not
 * resolve, we do NOT guess at another button — a wrong click could Discard or
 * Post. We bail and leave it to a human.
 */
export interface SaveAsDraftLinkedInDependencies {
  locateClose(page: Page): Promise<Locator | null>;
  locateSave(page: Page): Promise<Locator | null>;
  settle(page: Page): Promise<void>;
}

const productionSaveAsDraftLinkedInDependencies: SaveAsDraftLinkedInDependencies = {
  locateClose(page) {
    return optionalLocator(page, LI_COMPOSER_SELECTORS.closeComposerButton, 5_000);
  },
  locateSave(page) {
    return optionalLocator(page, LI_COMPOSER_SELECTORS.saveDraftButton, 5_000);
  },
  async settle(page) {
    await page.waitForTimeout(750);
  },
};

export async function saveAsDraftLinkedIn(
  page: Page,
  verify: () => Promise<boolean>,
  deps: SaveAsDraftLinkedInDependencies = productionSaveAsDraftLinkedInDependencies,
): Promise<LinkedInDraftSaveFlowResult<string>> {
  let save: Locator | undefined;
  return runLinkedInDraftSaveFlow({
    async beforeSave() {
      const close = await deps.locateClose(page);
      if (!close) throw new Error("Close control unavailable.");
      await close.click();

      const candidate = await deps.locateSave(page);
      if (!candidate) {
        // Never guess another button: a wrong click could discard or Post.
        throw new Error("Save as draft control unavailable.");
      }
      save = candidate;
    },
    async deliverSave() {
      if (!save) throw new Error("Save as draft control was not prepared.");
      await save.click();
    },
    async afterSave() {
      await deps.settle(page);
      return {
        verified: await verify(),
        value: 'the close→"Save as draft" dialog',
      };
    },
  });
}

/**
 * Stage `content` as a NATIVE LinkedIn feed-post DRAFT using the persistent
 * logged-in profile. NEVER posts. Returns a result describing what was staged +
 * a best-effort verification that the draft landed.
 */
export async function stagePost(
  content: GeneratedPost,
  opts: StagePostOptions = {},
): Promise<StagePostResult> {
  // Preserve the public generated-DTO seam: malformed caller structures fail
  // locally before any session/profile work and retain TerminalProjectionError.
  content = snapshotLinkedInGeneratedPost(content);
  const text = content.text;
  if (!text.trim()) throw new Error("No content to stage (empty LinkedIn post).");
  const media = [...(opts.media ?? [])];
  let mediaEvidence = createLinkedInMediaStageEvidence(media.length);
  let platformTouched = false;
  let composerModified = false;
  const progress = (): LinkedInDraftStageProgress => Object.freeze({
    platformTouched,
    composerModified,
    media: mediaEvidence,
  });
  const updateMediaSetState = (set: boolean | null): void => {
    mediaEvidence = createLinkedInMediaStageEvidence(media.length, set);
  };

  let page: Page | undefined;
  try {
    try {
      // The session call itself may touch the persistent browser profile before
      // rejecting, so mark the platform boundary before awaiting it.
      platformTouched = true;
      const ctx = (await getBrowserContext({ inspect: opts.inspect, force: opts.force })) as BrowserContext;
      page = await ctx.newPage();
      // LinkedIn AUTO-RESTORES the most recent saved draft into the composer
      // (verified live). Discard it so every run types one clean post. From the
      // Discard click on, a rejection may leave changed native state; the
      // receipt must retain that unknown residue.
      const editor = await startEmptyComposer(page, () => {
        composerModified = true;
      });
      await editor.click();
      composerModified = true;
      await typeText(page, editor, text);
      if (media.length > 0) await dismissPreviewCard(page);

      const allMediaSet = await setComposerMedia(page, media, updateMediaSetState);
      if (!allMediaSet) {
        throw new Error("LinkedIn did not accept every requested media file-setting call.");
      }
      // Let a link preview or image upload finish before Save: LinkedIn
      // sometimes rejected a Save made while one was loading (live 2026-10).
      if (media.length > 0 || /https?:\/\//iu.test(text)) await page.waitForTimeout(3_000);
    } catch (error) {
      throw linkedInDraftStageError(error, "save_not_attempted", progress());
    }

    let saved: LinkedInDraftSaveFlowResult<string>;
    try {
      saved = await saveAsDraftLinkedIn(
        page,
        () => verifyDraftSaved(page as Page, text),
      );
    } catch (error) {
      throw linkedInDraftStageError(error, "save_delivery_unknown", progress());
    }

    return {
      format: "post",
      saveMechanism: LINKEDIN_DRAFT_SAVE_MECHANISM,
      savePhase: saved.savePhase,
      verified: saved.savePhase === "verified",
      ...progress(),
    };
  } finally {
    // Close only the page we opened; leave the persistent context alive so the
    // session stays warm for subsequent commands.
    await page?.close().catch(() => {});
  }
}

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
 * LI_COMPOSER_SELECTORS ONLY as a documented FORBIDDEN selector, exactly as X's
 * tweetButton does in src/x/draftPoster.ts. The send action is future scope behind
 * the SEND-GATE (PRODUCT_SPEC §5).
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
import { tolerantLocator, optionalLocator, typeText } from "../x/draftPoster.js";
import { snapshotLinkedInGeneratedPost, type GeneratedPost } from "./content.js";
import {
  LINKEDIN_DRAFT_SAVE_MECHANISM,
  linkedInDraftStageError,
  runLinkedInDraftSaveFlow,
  type LinkedInDraftSaveFlowResult,
  type LinkedInDraftStageResult,
} from "./saveProgress.js";

/**
 * Centralized composer/draft/media selectors. EVERY entry NEEDS LIVE CALIBRATION.
 * Each value is an ordered list of candidate strategies; lookups try them in order
 * until one resolves within the timeout (see tolerantLocator()).
 */
export const LI_COMPOSER_SELECTORS = {
  // Opening the share composer directly. The shareActive query param opens the
  // "Start a post" modal on the feed. BEST-EFFORT.
  shareUrl: "https://www.linkedin.com/feed/?shareActive=true",
  feedUrl: "https://www.linkedin.com/feed/",

  // Fallback entry point: the "Start a post" trigger on the feed, if the
  // shareActive URL doesn't auto-open the modal. BEST-EFFORT.
  startPostTrigger: [
    'button[aria-label*="Start a post"]',
    "button.share-box-feed-entry__trigger",
    'div.share-box-feed-entry__trigger',
    '//span[normalize-space()="Start a post"]/ancestor::*[@role="button"][1]',
  ],

  // The composer's contenteditable text area. CALIBRATED LIVE 2026-07: LinkedIn's
  // composer is now a TipTap/ProseMirror editor — div.ProseMirror[contenteditable]
  // with role="textbox". (The old Quill `div.ql-editor` is gone.) Reached by
  // navigating to shareUrl (feed/?shareActive=true), which opens the composer
  // overlay; NOTE /sharing/compose is a 404 as a direct URL.
  editor: [
    'div.ProseMirror[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[data-placeholder][contenteditable="true"]',
  ],

  // ---- Media (optional; images, ratio-flexible — NO 5:2 gate) ----
  // CALIBRATED LIVE 2026-07: the media control is button[aria-label="Photo"]
  // (capital P — CSS attribute matching is case-sensitive, so the old
  // [aria-label*="photo"] missed it). Clicking it opens the OS file chooser (there
  // is NO visible input[type=file] in the composer), so attachMedia's filechooser
  // path is the primary one; the hidden-input path is a fallback.
  mediaButton: [
    'button[aria-label="Photo"]',
    'button[aria-label*="Add media"]',
    'button[aria-label*="photo" i]',
  ],
  mediaFileInput: [
    'input[type="file"][accept*="image"]',
    "input.share-creation-state__file-input",
    'input[type="file"]',
  ],
  // The media editor dialog raises a "Next"/"Done" affordance to return to the
  // composer with the image(s) attached. BEST-EFFORT.
  mediaNextButton: [
    'button[aria-label="Next"]',
    'button[aria-label="Done"]',
    '//button[normalize-space()="Next"]',
    '//button[normalize-space()="Done"]',
  ],
  // A rendered image thumbnail inside the composer — a signal media attached.
  mediaAttachedSignal: [
    'div.share-images',
    "img.share-creation-state__preview-image",
    'div[data-test-id*="media"]',
  ],

  // ---- Save as draft (the ONLY save path — never Post) ----
  // Closing the composer with content raises LinkedIn's "Save this post as a
  // draft?" dialog. We click Close, then the dialog's "Save as draft". Both are
  // centralized. HIGHEST-RISK selectors — a mis-click must NEVER fall through to
  // Post (mirror X's saveAsDraft safeguard: if the Save affordance doesn't
  // resolve, do NOT guess another button — bail and leave it to a human).
  // CALIBRATED LIVE 2026-07: the composer close control is button[aria-label="Dismiss"].
  closeComposerButton: [
    'button[aria-label="Dismiss"]',
    'button[aria-label="Close"]',
    '//button[@aria-label="Dismiss"]',
  ],
  // CALIBRATED LIVE 2026-07: closing a non-empty composer raises a dialog with two
  // TEXT buttons — "Save as draft" and "Discard" (NO aria-labels), so match by
  // text. The old aria-label="Save as draft" never matched.
  saveDraftButton: [
    'button:has-text("Save as draft"):visible',
    '//button[normalize-space()="Save as draft"]',
    '//span[normalize-space()="Save as draft"]/ancestor::button[1]',
  ],
  // The "Discard" affordance in the SAME dialog — listed so we are explicit about
  // what we must NEVER click (it throws the post away). CALIBRATED: text-only button.
  // discard (FORBIDDEN): 'button:has-text("Discard")' / //button[normalize-space()="Discard"]

  // ---- Draft verification ----
  // CALIBRATED LIVE 2026-07: LinkedIn has no drafts-list URL or labelled "drafts"
  // control. Instead, REOPENING the share composer (shareUrl) AUTO-RESTORES the
  // most recent saved draft into the editor — so verification just reopens the
  // composer and matches the staged text inside the editor (see verifyDraftSaved).

  // The PUBLISH/POST button — listed ONLY so we are explicit about what we must
  // NEVER click. Nothing in this module ever locates+clicks it. CALIBRATED LIVE
  // 2026-07: it is a text button matched by //button[normalize-space()="Post"].
  // post (FORBIDDEN): //button[normalize-space()="Post"] / 'button[aria-label="Post"]'
} as const;

export interface StagePostOptions extends EnsureSessionOptions {
  /** Headful + slower so a human can watch/calibrate. Maps to --inspect. */
  inspect?: boolean;
  /** Absolute paths to image files to attach, in order (repeatable --media). */
  media?: string[];
}

export type StagePostResult = LinkedInDraftStageResult;

const OPEN_TIMEOUT = 15_000;

/** Platform select-all modifier for keyboard shortcuts (Cmd on macOS, Ctrl else). */
function modifier(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control";
}

/**
 * Open the LinkedIn share composer and return the focused editor locator. Tries
 * the shareActive URL first, then the feed's "Start a post" trigger.
 */
async function openComposer(page: Page): Promise<Locator> {
  await page.goto(LI_COMPOSER_SELECTORS.shareUrl, { waitUntil: "domcontentloaded" });

  let editor = await optionalLocator(page, LI_COMPOSER_SELECTORS.editor, 8_000);
  if (editor) return editor;

  // Fallback: click the feed's "Start a post" trigger to raise the modal.
  const trigger = await optionalLocator(page, LI_COMPOSER_SELECTORS.startPostTrigger, 6_000);
  if (trigger) await trigger.click();

  editor = await tolerantLocator(page, LI_COMPOSER_SELECTORS.editor, "LinkedIn share composer editor", OPEN_TIMEOUT);
  return editor;
}

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
 * Attach media files to the open composer. LinkedIn feed images are ratio-flexible,
 * so (unlike X's 5:2 hero) there is NO ratio gate. Returns the number of files
 * attached (0 if the control didn't resolve). Best-effort — degrades gracefully
 * and never throws.
 *
 * Two robust paths (mirrors X's uploadHeroImage), neither of which depends on the
 * file input being VISIBLE:
 *   1. Click the visible "Add media" button and capture the OS file chooser via
 *      page.waitForEvent("filechooser"), then chooser.setFiles(media).
 *   2. Fall back to resolving the hidden input[type=file] with a state:"attached"
 *      wait (NOT visible) and calling setInputFiles directly.
 */
async function attachMedia(page: Page, media: string[]): Promise<number> {
  if (media.length === 0) return 0;

  // Path 1: click the visible media button and capture the file chooser. This is
  // the most robust path because it never touches the (hidden) input's visibility.
  const mediaBtn = await optionalLocator(page, LI_COMPOSER_SELECTORS.mediaButton, 3_000);
  if (mediaBtn) {
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 5_000 }),
        mediaBtn.click(),
      ]);
      await chooser.setFiles(media);
      const next1 = await optionalLocator(page, LI_COMPOSER_SELECTORS.mediaNextButton, 5_000);
      if (next1) await next1.click().catch(() => {});
      await page.waitForTimeout(750);
      return media.length;
    } catch {
      // File chooser didn't fire (clicking the button may just reveal a hidden
      // input in this layout) — fall through to the hidden-input path below.
    }
  }

  // Path 2: drive the hidden input[type=file] directly. setInputFiles works on
  // hidden inputs; we just must NOT gate the lookup on visibility.
  const fileInput = await resolveHiddenFileInput(page);
  if (!fileInput) return 0;

  try {
    // The input accepts multiple files; set them all in order in one call.
    await fileInput.setInputFiles(media);
  } catch {
    return 0;
  }

  // The media editor dialog raises a Next/Done affordance to return to the
  // composer with the image(s) attached. Optional — some flows attach inline.
  const next = await optionalLocator(page, LI_COMPOSER_SELECTORS.mediaNextButton, 5_000);
  if (next) await next.click().catch(() => {});
  await page.waitForTimeout(750);

  // Confirm a preview rendered; if not, still report the count we set.
  return media.length;
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

/** Preserve only browser line-ending and Unicode normalizations for equality. */
function normalizeReopenedDraftText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

export function sameLinkedInReopenedDraftText(
  actualText: string,
  expectedText: string,
): boolean {
  return normalizeReopenedDraftText(actualText) === normalizeReopenedDraftText(expectedText);
}

/**
 * Verify a draft was ACTUALLY saved by requiring the complete reopened editor
 * text to equal the complete intended text after only CR/LF and NFC
 * normalization. Prefixes, substrings, case folds, and whitespace collapse are
 * not positive evidence.
 *
 * CALIBRATED LIVE 2026-07: LinkedIn has no drafts-list URL, but REOPENING the
 * share composer (shareUrl) AUTO-RESTORES the most recent saved draft into the
 * editor. So we reopen the composer, read the editor's own text, and require the
 * full staged text to appear there (scoped to the editor, not the whole page, so
 * the feed behind the modal can't false-positive). A clean negative observation
 * returns false; navigation or observation failures throw and become
 * `save_delivered_unverified` at the save-flow boundary.
 */
export async function verifyDraftSaved(page: Page, expectedText: string): Promise<boolean> {
  const expected = normalizeReopenedDraftText(expectedText);
  if (!expected) return false;
  await page.goto(LI_COMPOSER_SELECTORS.shareUrl, { waitUntil: "domcontentloaded" });
  const editor = await optionalLocator(page, LI_COMPOSER_SELECTORS.editor, 15_000);
  if (!editor) return false;

  // The composer restores the draft asynchronously — poll the editor text.
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const text = await editor.innerText();
    if (sameLinkedInReopenedDraftText(text, expected)) return true;
    await page.waitForTimeout(500);
  }
  return false;
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
  const media = opts.media ?? [];

  let page: Page | undefined;
  try {
    let mediaAttached: number;
    try {
      const ctx = (await getBrowserContext({ inspect: opts.inspect, force: opts.force })) as BrowserContext;
      page = await ctx.newPage();
      const editor = await openComposer(page);
      await editor.click();
      // LinkedIn AUTO-RESTORES the most recent saved draft into the composer editor
      // (verified live). Clear it so every run types one clean post.
      await editor.press(`${modifier()}+a`);
      await editor.press("Backspace");
      await typeText(page, editor, text);

      mediaAttached = await attachMedia(page, media);
      if (mediaAttached !== media.length) {
        throw new Error("LinkedIn did not attach every requested media file.");
      }
    } catch (error) {
      throw linkedInDraftStageError(error, "save_not_attempted");
    }

    const saved = await saveAsDraftLinkedIn(
      page,
      () => verifyDraftSaved(page as Page, text),
    );

    return {
      format: "post",
      saveMechanism: LINKEDIN_DRAFT_SAVE_MECHANISM,
      savePhase: saved.savePhase,
      verified: saved.savePhase === "verified",
      mediaAttached,
    };
  } finally {
    // Close only the page we opened; leave the persistent context alive so the
    // session stays warm for subsequent commands.
    await page?.close().catch(() => {});
  }
}

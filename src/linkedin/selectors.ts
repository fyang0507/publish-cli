/**
 * LinkedIn composer selectors. EVERY entry NEEDS LIVE CALIBRATION against the
 * current linkedin.com composer DOM; see the drift note in draftPoster.ts.
 */

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
  // CALIBRATED LIVE 2026-10 (#137): the control is now labelled "Media".
  mediaButton: [
    'dialog[data-testid="dialog"] button[aria-label="Media"]',
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
  // Candidate preview selectors retained for future live calibration. They are
  // intentionally unused here: a generic preview is not attributable evidence
  // for every caller-ordered image and must not promote `set` to `observed`.
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
  // CALIBRATED LIVE 2026-10 (#137): the composer is dialog[data-testid="dialog"]
  // and its close control is that dialog's own Dismiss button. A link-preview
  // card in the composer has a Dismiss button too, so the dialog scope comes first.
  closeComposerButton: [
    'dialog[data-testid="dialog"] > button[aria-label="Dismiss"]',
    'button[aria-label="Dismiss"]',
    'button[aria-label="Close"]',
  ],
  // CALIBRATED LIVE 2026-10 (#137): the link-preview card in the composer. A
  // saved draft keeps the first card it got: dismissing it in the composer does
  // not survive Save. While a card is attached the composer renders no Media control.
  previewCard: '[componentkey="ShareBoxpreviewCard"]',
  // CALIBRATED LIVE 2026-07: closing a non-empty composer raises a dialog with two
  // TEXT buttons — "Save as draft" and "Discard" (NO aria-labels), so match by
  // text. The old aria-label="Save as draft" never matched.
  saveDraftButton: [
    'button:has-text("Save as draft"):visible',
    '//button[normalize-space()="Save as draft"]',
    '//span[normalize-space()="Save as draft"]/ancestor::button[1]',
  ],
  // The "Discard" affordance in the SAME dialog. It is used only on a draft the
  // composer RESTORED before any new text is typed (#137): clearing that draft in
  // place would carry its link-preview card into the new draft. It is never
  // clicked once the new text is in the composer. CALIBRATED: text-only button.
  discardDraftButton: '//button[normalize-space()="Discard"]',

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

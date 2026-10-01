/**
 * The LinkedIn share composer's state: opening it, starting from an empty
 * composer, the link-preview card, and verifying a saved draft by reopening it.
 * Nothing here locates or clicks Post.
 */

import type { Locator, Page } from "playwright";
import { optionalLocator, tolerantLocator } from "../x/draftPoster.js";
import { LI_COMPOSER_SELECTORS } from "./selectors.js";

const OPEN_TIMEOUT = 15_000;

/**
 * Navigate to the share composer. LinkedIn navigates by itself after Save as
 * draft and after Discard, which aborts a navigation already in flight
 * (net::ERR_ABORTED, live 2026-10); retry that abort twice, a second apart.
 */
async function gotoComposer(page: Page): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.goto(LI_COMPOSER_SELECTORS.shareUrl, { waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || !error.message.includes("net::ERR_ABORTED")) throw error;
      await page.waitForTimeout(1_000);
    }
  }
}

/**
 * Open the LinkedIn share composer and return the focused editor locator. Tries
 * the shareActive URL first, then the feed's "Start a post" trigger.
 */
export async function openComposer(page: Page): Promise<Locator> {
  await gotoComposer(page);

  let editor = await optionalLocator(page, LI_COMPOSER_SELECTORS.editor, 8_000);
  if (editor) return editor;

  // Fallback: click the feed's "Start a post" trigger to raise the modal.
  const trigger = await optionalLocator(page, LI_COMPOSER_SELECTORS.startPostTrigger, 6_000);
  if (trigger) await trigger.click();

  editor = await tolerantLocator(page, LI_COMPOSER_SELECTORS.editor, "LinkedIn share composer editor", OPEN_TIMEOUT);
  return editor;
}

/** Preserve only browser line-ending and Unicode normalizations for equality. */
function normalizeReopenedDraftText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

const HTTP_URL_RE = /https?:\/\/\S+/gu;
const URL_TRAILING_PUNCTUATION_RE = /[.,;:!?'")\]]+$/u;
/** LinkedIn rewrites every link in a saved draft to its own shortener (#137). */
const LINKEDIN_SHORT_LINK_SOURCE = "https://lnkd\\.in/[A-Za-z0-9_-]+";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Full-text equality after CR/LF and NFC normalization, where each HTTP(S)
 * link in the intended text may come back as a `https://lnkd.in/<code>` short
 * link. Every other character must match exactly.
 */
export function sameLinkedInReopenedDraftText(
  actualText: string,
  expectedText: string,
): boolean {
  const actual = normalizeReopenedDraftText(actualText);
  const expected = normalizeReopenedDraftText(expectedText);
  if (actual === expected) return true;
  let pattern = "";
  let cursor = 0;
  for (const match of expected.matchAll(HTTP_URL_RE)) {
    const url = match[0].replace(URL_TRAILING_PUNCTUATION_RE, "");
    if (!/^https?:\/\/./u.test(url)) continue;
    pattern += `${escapeRegExp(expected.slice(cursor, match.index))}` +
      `(?:${escapeRegExp(url)}|${LINKEDIN_SHORT_LINK_SOURCE})`;
    cursor = match.index + url.length;
  }
  if (cursor === 0) return false;
  pattern += escapeRegExp(expected.slice(cursor));
  return new RegExp(`^${pattern}$`, "u").test(actual);
}

/**
 * Dismiss the link-preview card LinkedIn generates for a link in the new text.
 * The composer renders no Photo control while a card is attached, so this runs
 * only when media is requested, after typing and before the media is set. The
 * card appears asynchronously; no card within three seconds means none.
 */
export async function dismissPreviewCard(page: Page): Promise<void> {
  const dismiss = page
    .locator(`${LI_COMPOSER_SELECTORS.previewCard} button[aria-label="Dismiss"]`)
    .filter({ visible: true });
  try {
    await dismiss.first().waitFor({ state: "visible", timeout: 3_000 });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return;
    throw error;
  }
  if ((await dismiss.count()) !== 1) throw new Error("Link-preview card is ambiguous.");
  await dismiss.click();
  await dismiss.waitFor({ state: "detached", timeout: 5_000 });
}

/** True when the composer holds restored text or a restored link-preview card. */
async function restoredDraftPresent(page: Page, editor: Locator): Promise<boolean> {
  const card = page.locator(LI_COMPOSER_SELECTORS.previewCard).filter({ visible: true });
  const deadline = Date.now() + 2_000;
  for (;;) {
    if ((await editor.innerText()).trim() !== "" || (await card.count()) > 0) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(250);
  }
}

export interface StartEmptyComposerDependencies {
  open(page: Page): Promise<Locator>;
  restored(page: Page, editor: Locator): Promise<boolean>;
  locateClose(page: Page): Promise<Locator | null>;
  /** The Discard button of the Save as draft confirmation, or null unless exactly that dialog is shown. */
  locateDiscard(page: Page): Promise<Locator | null>;
  wait(page: Page, milliseconds: number): Promise<void>;
}

const productionStartEmptyComposerDependencies: StartEmptyComposerDependencies = {
  open: openComposer,
  restored: restoredDraftPresent,
  locateClose(page) {
    return optionalLocator(page, LI_COMPOSER_SELECTORS.closeComposerButton, 5_000);
  },
  async locateDiscard(page) {
    const discard = page.locator(`xpath=${LI_COMPOSER_SELECTORS.discardDraftButton}`).filter({ visible: true });
    const save = page.locator(LI_COMPOSER_SELECTORS.saveDraftButton[0]);
    try {
      await discard.first().waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      return null;
    }
    return (await discard.count()) === 1 && (await save.count()) === 1 ? discard : null;
  },
  async wait(page, milliseconds) {
    await page.waitForTimeout(milliseconds);
  },
};

/**
 * Open the composer and make sure it is empty. Reopening the composer restores
 * the last saved draft, and its link-preview card stays attached to whatever is
 * saved next even when the text is cleared or the card dismissed (#137). A
 * restored draft is therefore discarded through its own close → Discard
 * confirmation before any new text is typed; the new Save would replace it
 * anyway. `beforeDiscard` runs before the click, which changes native state.
 * Nothing after the click goes near Discard again.
 */
export async function startEmptyComposer(
  page: Page,
  beforeDiscard: () => void,
  deps: StartEmptyComposerDependencies = productionStartEmptyComposerDependencies,
): Promise<Locator> {
  const editor = await deps.open(page);
  if (!(await deps.restored(page, editor))) return editor;

  const close = await deps.locateClose(page);
  if (!close) throw new Error("Close control unavailable.");
  await close.click();
  const discard = await deps.locateDiscard(page);
  // Never guess another button: anything but the expected confirmation stops here.
  if (!discard) throw new Error("Restored-draft Discard confirmation unavailable.");
  beforeDiscard();
  await discard.click();

  // A discarded draft can still be restored for a few seconds (live 2026-10):
  // reopen until the composer comes back empty. Saving a draft that gets a
  // link-preview card failed ("We encountered a problem sharing your post")
  // when it followed a Discard too closely; after ten seconds it saved.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await deps.wait(page, 1_000);
    const fresh = await deps.open(page);
    if (!(await deps.restored(page, fresh))) {
      await deps.wait(page, 10_000);
      return fresh;
    }
  }
  throw new Error("Composer still holds a draft after Discard.");
}

export interface ReopenDraftDependencies {
  /** Reopen the composer and return its editor, or null when it doesn't open. */
  reopen(page: Page): Promise<Locator | null>;
  wait(page: Page, milliseconds: number): Promise<void>;
  now(): number;
}

const productionReopenDraftDependencies: ReopenDraftDependencies = {
  async reopen(page) {
    await gotoComposer(page);
    return optionalLocator(page, LI_COMPOSER_SELECTORS.editor, 15_000);
  },
  async wait(page, milliseconds) {
    await page.waitForTimeout(milliseconds);
  },
  now: () => Date.now(),
};

const REOPEN_ATTEMPTS = 5;

/**
 * Verify a draft was ACTUALLY saved by requiring the complete reopened editor
 * text to equal the complete intended text after only CR/LF and NFC
 * normalization, with LinkedIn's lnkd.in short links accepted in place of the
 * intended links. Prefixes, substrings, case folds, and whitespace collapse are
 * not positive evidence.
 *
 * CALIBRATED LIVE 2026-07: LinkedIn has no drafts-list URL, but REOPENING the
 * share composer (shareUrl) AUTO-RESTORES the most recent saved draft into the
 * editor. CALIBRATED LIVE 2026-10 (#137): a newly created draft can take more
 * than six seconds to restore, so a composer that stays empty is reopened, up to
 * five times. Restored text that doesn't match is a clean negative and returns
 * false; navigation or observation failures throw and become
 * `save_delivered_unverified` at the save-flow boundary.
 */
export async function verifyDraftSaved(
  page: Page,
  expectedText: string,
  deps: ReopenDraftDependencies = productionReopenDraftDependencies,
): Promise<boolean> {
  const expected = normalizeReopenedDraftText(expectedText);
  if (!expected) return false;
  for (let attempt = 0; attempt < REOPEN_ATTEMPTS; attempt += 1) {
    const editor = await deps.reopen(page);
    if (!editor) return false;
    // The composer restores the draft asynchronously — poll the editor text.
    const deadline = deps.now() + 6_000;
    let text = "";
    for (;;) {
      text = await editor.innerText();
      if (sameLinkedInReopenedDraftText(text, expected)) return true;
      if (deps.now() >= deadline) break;
      await deps.wait(page, 500);
    }
    if (text.trim() !== "") return false;
  }
  return false;
}

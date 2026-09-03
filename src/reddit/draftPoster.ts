/**
 * Reddit draft poster — drives the persistent, already-logged-in Reddit browser
 * profile (session.getBrowserContext()) to stage a NATIVE SELF-POST DRAFT via
 * Reddit's own "Save Draft" affordance and STOP THERE.
 *
 * HARD BOUNDARY: this module MUST NEVER click Post / publish. It opens the
 * self-post composer for the target subreddit, switches to Markdown mode, types
 * the generated title + Markdown body, selects a flair if one was resolved, sets
 * the nsfw/spoiler toggles, and SAVES IT AS A DRAFT via "Save Draft" — so the
 * result sits one click from publishing, and a human takes that click. There is
 * intentionally NO code path that locates or clicks the Post button; it appears
 * in REDDIT_COMPOSER_SELECTORS ONLY as a documented FORBIDDEN selector, exactly
 * as X's tweetButton and LinkedIn's Post do. The send action is future scope
 * behind the SEND-GATE (PRODUCT_SPEC §5).
 *
 * REUSE: the tolerant/optional locator primitives and the contenteditable typing
 * helper are channel-agnostic and imported from ../x/draftPoster.js
 * (tolerantLocator / optionalLocator / typeText). X's saveAsDraft is NOT reused —
 * it is hard-bound to X's close→confirmationSheet selectors — so Reddit's
 * "Save Draft" flow is implemented here against REDDIT_COMPOSER_SELECTORS,
 * mirroring LinkedIn's "don't guess another button" safeguard.
 *
 * ELIGIBILITY (design §4.1): driving the composer is what actually reveals whether
 * the operator can post to a sub (karma/age gates are AutoMod-enforced and NOT in
 * the JSON contract). If the composer surfaces a karma / account-age /
 * approved-submitter / ban / restricted block, stageDraft STOPS and returns a
 * plain "can't post to r/<sub>: <reason>" (StageDraftResult.blocked) — it never
 * proceeds toward Post.
 *
 * SELECTOR DRIFT — READ THIS: every selector in REDDIT_COMPOSER_SELECTORS is
 * BEST-EFFORT and NEEDS LIVE CALIBRATION against the current reddit.com composer
 * DOM. Reddit's self-post tab, Markdown-mode toggle, title/body editors, flair
 * picker, nsfw/spoiler toggles, and especially the "Save Draft" affordance drift
 * like X's / LinkedIn's. Run `publish reddit draft ... --inspect` (headful) to
 * watch the flow and recalibrate. Nothing here is trustworthy until verified live
 * (AGENTS.md "Verify live").
 *
 * The session module is the SINGLE authenticator — we never log in here; we only
 * borrow its persistent context.
 */

import type { BrowserContext, Page, Locator } from "playwright";
import { getBrowserContext, type EnsureSessionOptions } from "./session.js";
import { tolerantLocator, optionalLocator, typeText } from "../x/draftPoster.js";
import type { GeneratedSelfPost } from "./content.js";

/**
 * Centralized composer / flair / toggle / save / verify selectors. EVERY entry
 * NEEDS LIVE CALIBRATION. Each value is an ordered list of candidate strategies;
 * lookups try them in order until one resolves within the timeout (see
 * tolerantLocator()). Mirrors X_COMPOSER_SELECTORS / LI_COMPOSER_SELECTORS.
 */
export const REDDIT_COMPOSER_SELECTORS = {
  // The self-post submit page for a subreddit. NEEDS LIVE CALIBRATION: the
  // self-post tab may need an explicit click if the page opens on a different
  // post type (see selfPostTab below).
  submitUrl: (sub: string) => `https://www.reddit.com/r/${sub}/submit`,

  // Reddit's transient "Draft saved" confirmation toast — usable only as a fresh
  // absent-before / visible-after signal for this attempt.
  // RE-CALIBRATED LIVE 2026-07-04: reopening the composer-header "Drafts" modal
  // right after saving shows a STALE list (the just-saved draft has NOT propagated —
  // the header still reads the pre-save count), so matching the staged title there
  // races and always reported "unconfirmed". This toast fires the moment Reddit
  // accepts the save; we capture it right after the click when it is freshest.
  // Text-exact so it can't collide with the "Save Draft" button. NEEDS LIVE
  // CALIBRATION.
  saveConfirmToast: [
    '//*[normalize-space()="Draft saved"]',
    ':text-is("Draft saved")',
    '[role="status"]:has-text("Draft saved")',
  ],

  // The "Post" / text self-post tab within the composer, in case the submit page
  // does not default to it. BEST-EFFORT / NEEDS LIVE CALIBRATION.
  selfPostTab: [
    'button[role="tab"]:has-text("Text"):visible',
    '//button[@role="tab"][normalize-space()="Text"]',
    '//*[@role="tab"][contains(normalize-space(),"Post")]',
  ],

  // "Toolbar has hydrated" signal. RE-CALIBRATED LIVE 2026-07-04: the body
  // formatting toolbar collapses its right-hand controls into a "More options" (…)
  // overflow at ≤~1280px, and its buttons carry TEXT (not aria-label) — the old
  // `button[aria-label*="Bold"]` matched 0 and this silently no-op'd. Wait for the
  // overflow (…) button, or a text-labelled Bold, as the ready signal. NEEDS LIVE
  // CALIBRATION.
  rteToolbarReady: ['button[aria-label="More options"]:visible', 'button:has-text("Bold"):visible'],
  // The body toolbar's "More options" (…) overflow button — the overflow that holds
  // the "Switch to Markdown" control. RE-CALIBRATED LIVE 2026-07-04: exactly one
  // such button in the composer; renders once the body is focused. NEEDS LIVE
  // CALIBRATION.
  composerMoreOptions: ['button[aria-label="More options"]:visible'],
  // Switch the body editor into Markdown mode so the typed body is treated as
  // Markdown (Reddit's editor defaults to the rich "fancy pants" mode, which
  // renders markdown syntax literally). RE-CALIBRATED LIVE 2026-07-04: after the …
  // overflow opens, this is a VISIBLE `rpl-menu-item[role="menuitem"]` labelled
  // "Switch to Markdown" — NOT a <button> (the only <button aria-label="Switch to
  // Markdown"> is a permanently-`hidden` responsive copy, which is why the old
  // button-scoped selectors + tolerantLocator's .first() locked onto the hidden
  // node and timed out). Match the menuitem by role/text. BEST-EFFORT / NEEDS LIVE
  // CALIBRATION.
  markdownToggle: [
    '[role="menuitem"]:has-text("Switch to Markdown")',
    'rpl-menu-item:has-text("Switch to Markdown")',
    '//*[@role="menuitem"][contains(normalize-space(),"Switch to Markdown")]',
  ],
  // Confirms the switch ACTUALLY engaged. CALIBRATED LIVE 2026-07-04: in Markdown
  // mode the reverse toggle reads "Switch to Rich Text Editor" and the body becomes
  // a plain `<textarea placeholder="Body text (optional)">` (the rich div[name=body]
  // goes hidden). Either signal confirms. NEEDS LIVE CALIBRATION.
  markdownConfirm: [
    '[aria-label="Switch to Rich Text Editor"]',
    '[role="menuitem"]:has-text("Switch to Rich Text Editor")',
    'textarea[placeholder*="Body text" i]:visible',
  ],

  // The title input. NEEDS LIVE CALIBRATION.
  titleInput: [
    'textarea[name="title"]',
    'textarea[placeholder*="Title" i]',
    'input[name="title"]',
    'faceplate-textarea-input[name="title"] textarea',
    '//textarea[contains(@placeholder,"Title")]',
  ],

  // The self-post body editor. CALIBRATED LIVE 2026-07-03 against the new
  // www.reddit.com <shreddit-composer>: the body is a NAME-SCOPED contenteditable
  // `div[role="textbox"][name="body"]` (aria-label "Post body text field") in BOTH
  // rich and markdown views — NOT a <textarea>. typeText handles contenteditable.
  // Lead with the name/aria-scoped, VISIBLE selectors: a generic
  // `div[contenteditable="true"][role="textbox"]` matches TWO nodes whose FIRST is
  // hidden, and tolerantLocator's .first() would grab the hidden one and time out
  // waiting for it to become visible. The <textarea> variants are older-UI /
  // markdown-mode fallbacks. NEEDS LIVE CALIBRATION.
  bodyEditor: [
    'div[role="textbox"][name="body"]',
    'div[name="body"]',
    'div[aria-label="Post body text field" i]',
    'textarea[name="body"]',
    'textarea[placeholder*="body" i]',
    '//div[@role="textbox"][@name="body"]',
  ],
  // The body target AFTER switching to Markdown mode. CALIBRATED LIVE 2026-07-04:
  // Markdown mode swaps the rich `div[name="body"]` (which goes hidden) for a plain
  // `<textarea placeholder="Body text (optional)">` (its `name` attr is null, so we
  // match on placeholder). stageDraft leads body resolution with these when the
  // Markdown switch succeeded, so typing doesn't stall waiting out the now-hidden
  // rich div. NEEDS LIVE CALIBRATION.
  bodyEditorMarkdown: [
    'textarea[placeholder*="Body text" i]:visible',
    'textarea[placeholder*="body" i]:visible',
    'textarea[name="body"]:visible',
  ],

  // Open the flair picker. NEEDS LIVE CALIBRATION.
  flairButton: [
    'button:has-text("Add flair"):visible',
    'button:has-text("Flair"):visible',
    'button[aria-label*="flair" i]',
    '//button[contains(normalize-space(),"flair")]',
  ],
  // Expand the modal to show the full flair list. CALIBRATED LIVE 2026-07-03: the
  // new composer's flair modal shows a subset until "View all flairs" is clicked;
  // radios below the fold aren't checkable until then.
  flairViewAll: ['button:has-text("View all flairs"):visible'],
  // A flair option row inside the open modal. CALIBRATED LIVE 2026-07-03: the new
  // composer renders each flair as a VISUALLY-HIDDEN `faceplate-radio-input
  // [role="radio"][name="flairId"]` whose `value` is the template id and whose
  // TEXT is the flair label. selectFlair() selects it via .check() (a plain
  // .click() fails — the radio is not "visible"), preferring the accessible name
  // (text) because the composer radio `value` ids can differ from the link_flair
  // ids. These CSS fallbacks target the value-scoped radio. NEEDS LIVE CALIBRATION.
  flairOption: [
    'faceplate-radio-input[name="flairId"]',
    'span[role="button"][data-flair-id]',
    'li[role="option"]',
    'button[role="radio"]',
  ],
  // Confirm the chosen flair and close the modal. CALIBRATED LIVE 2026-07-03: the
  // new composer modal's confirm button is exactly "Add" (NOT "Apply"/"Done") —
  // and it MUST be text-EXACT so it doesn't match "Add flair and tags" /
  // "Add community to favorites". Leaving the modal open lets it intercept the
  // Save Draft click. NEEDS LIVE CALIBRATION.
  flairApply: [
    'button:text-is("Add"):visible',
    'button:text-is("Apply"):visible',
    'button:text-is("Done"):visible',
    '//button[normalize-space()="Add"]',
    '//button[normalize-space()="Apply"]',
  ],
  // Dismiss the flair modal WITHOUT applying (used when selection fails, so the
  // modal can't intercept Save Draft). NEEDS LIVE CALIBRATION.
  flairCancel: [
    'button:text-is("Cancel"):visible',
    '//button[normalize-space()="Cancel"]',
    'button[aria-label*="Close" i]:visible',
  ],

  // NSFW / spoiler mark toggles. Clicked only when the post is flagged. Both are
  // idempotent-guarded (we read aria-pressed/checked before clicking). NEEDS LIVE
  // CALIBRATION.
  nsfwToggle: [
    'button[aria-label*="NSFW" i]',
    'button:has-text("NSFW"):visible',
    '//button[contains(normalize-space(),"NSFW")]',
  ],
  spoilerToggle: [
    'button[aria-label*="Spoiler" i]',
    'button:has-text("Spoiler"):visible',
    '//button[contains(normalize-space(),"Spoiler")]',
  ],

  // ---- Save Draft (the ONLY save path — never Post) ----
  // HIGHEST-RISK selectors — a mis-click must NEVER fall through to Post (mirror
  // LinkedIn's saveAsDraftLinkedIn safeguard: if the Save-Draft affordance doesn't
  // resolve, do NOT guess another button — bail and leave it to a human).
  // NEEDS LIVE CALIBRATION.
  saveDraftButton: [
    'button:has-text("Save Draft"):visible',
    'button[aria-label*="Save Draft" i]',
    '//button[normalize-space()="Save Draft"]',
    '//span[normalize-space()="Save Draft"]/ancestor::button[1]',
  ],

  // ---- Eligibility block (design §4.1) ----
  // Notices the composer/gateway surfaces when the operator can't post to the sub:
  // insufficient karma, account too new, approved-submitters-only, banned, or
  // restricted. If ANY of these resolve, stageDraft stops and returns .blocked —
  // it never proceeds toward Post. NEEDS LIVE CALIBRATION (wording drifts).
  // Every entry is scoped to a LEAF element (no child elements, `not(*)`) so
  // normalize-space() reflects that element's OWN text — NOT text aggregated from
  // all descendants. Without `not(*)`, an unanchored `//*[contains(...)]` matches
  // <html>/<body> (they contain every word on the page), and optionalLocator's
  // .first() then resolves the root as a "block" — falsely refusing to draft on
  // nearly every sub whose page chrome mentions "karma"/"post"/"restricted". The
  // karma clause additionally requires a posting/requirement cue in the SAME leaf
  // so an incidental karma counter (e.g. "1.2k karma") doesn't trip it. This
  // biases toward false-NEGATIVE (safe: the composer + "Save Draft" path stays the
  // authoritative gate, and never-posts is unaffected) over false-positive.
  eligibilityBlockSignal: [
    '//*[not(*)][contains(translate(normalize-space(),"KARMA","karma"),"karma")][contains(normalize-space(),"post") or contains(normalize-space(),"require") or contains(normalize-space(),"need") or contains(normalize-space(),"enough") or contains(normalize-space(),"must") or contains(normalize-space(),"at least")]',
    '//*[not(*)][contains(normalize-space(),"too new") or contains(normalize-space(),"account age") or contains(normalize-space(),"account is too")]',
    '//*[not(*)][contains(normalize-space(),"approved") and contains(normalize-space(),"submitter")]',
    '//*[not(*)][contains(normalize-space(),"banned from")]',
    '//*[not(*)][contains(normalize-space(),"restricted") and contains(normalize-space(),"post")]',
    '//*[not(*)][contains(normalize-space(),"You don\'t have permission") or contains(normalize-space(),"not allowed to post")]',
  ],

  // The PUBLISH/POST button — listed ONLY so we are explicit about what we must
  // NEVER click. Nothing in this module ever locates+clicks it. FORBIDDEN, mirrors
  // X's tweetButton and LinkedIn's Post.
  // post (FORBIDDEN): 'button:has-text("Post"):visible' / //button[normalize-space()="Post"] / 'button[aria-label="Post"]'
} as const;

export interface StageDraftOptions extends EnsureSessionOptions {
  /** Headful + slower so a human can watch/calibrate. Maps to --inspect. */
  inspect?: boolean;
  /**
   * The resolved flair template id (from preflightSelfPost().resolvedFlair) to
   * select in the composer. When absent, no flair is selected.
   */
  flairId?: string;
  /**
   * The resolved flair template TEXT (from preflightSelfPost().resolvedFlair).
   * Preferred for selection — the composer's radio `value` ids can differ from the
   * link_flair ids, but the visible label text is stable.
   */
  flairText?: string;
}

export interface StageDraftResult {
  kind: "self";
  /**
   * Explicit save-confirmation state. `unconfirmed` means exactly one save click
   * occurred without a fresh absent-before / visible-after toast transition;
   * callers must require manual inspection and must not retry blindly. This is
   * deliberately smaller than the versioned receipt planned in issue #34.
   */
  saveStatus: "not_attempted" | "unconfirmed" | "toast_confirmed";
  /**
   * Whether the "Save Draft" affordance resolved and was clicked. FALSE means the
   * CLI did not click a save control and no native draft was confirmed; it does
   * not claim the platform's autosave/native state. The caller MUST treat this as
   * a failure, not a success. Distinct from `verified` below.
   */
  saved: boolean;
  /** Whether the toast was absent before and visible after the one save click. */
  verified: boolean;
  /** The target subreddit (without the r/ prefix). */
  subreddit: string;
  /** The flair id selected in the composer, when one was applied. */
  flair?: string;
  /**
   * Set when the composer surfaced an eligibility block — a plain message like
   * "can't post to r/foo: insufficient karma". stageDraft returns this before
   * title/body/save actions; no native draft is confirmed and it never proceeds
   * toward Post.
   */
  blocked?: string;
  /** Human-readable note about how the draft was saved / what to check. */
  note: string;
}

const OPEN_TIMEOUT = 15_000;

/** Platform select-all modifier for keyboard shortcuts (Cmd on macOS, Ctrl else). */
function modifier(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control";
}

/** Normalize whitespace/case for tolerant text matching. */
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Open the self-post composer for `sub` and return the focused title input.
 * Navigates to the submit URL, ensures the text self-post tab is active, then
 * resolves the title input.
 */
async function openComposer(page: Page, sub: string): Promise<Locator> {
  await page.goto(REDDIT_COMPOSER_SELECTORS.submitUrl(sub), { waitUntil: "domcontentloaded" });

  // If the submit page opens on a non-text post type, click the Text/self tab.
  const tab = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.selfPostTab, 4_000);
  if (tab) await tab.click().catch(() => {});

  const title = await tolerantLocator(
    page,
    REDDIT_COMPOSER_SELECTORS.titleInput,
    `Reddit self-post title input for r/${sub}`,
    OPEN_TIMEOUT,
  );
  return title;
}

/**
 * Classify an eligibility-block notice's raw text into a plain reason. Falls back
 * to a trimmed snippet of the notice itself so the operator sees what Reddit
 * actually said.
 */
function classifyBlockReason(raw: string): string {
  const t = normalizeForMatch(raw);
  if (t.includes("karma")) return "insufficient karma";
  if (t.includes("too new") || t.includes("account age") || t.includes("account is too")) {
    return "account too new";
  }
  if (t.includes("approved") && t.includes("submitter")) return "approved submitters only";
  if (t.includes("banned")) return "you are banned from this subreddit";
  if (t.includes("restricted")) return "subreddit is restricted";
  const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 140);
  return snippet || "the composer blocked posting (reason unclear)";
}

/**
 * Detect an eligibility block in the open composer (design §4.1). Returns a plain
 * "can't post to r/<sub>: <reason>" message when a block is present, else null.
 * Best-effort — a short lookup so a clean composer isn't delayed.
 */
async function detectEligibilityBlock(page: Page, sub: string): Promise<string | null> {
  const signal = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.eligibilityBlockSignal, 3_000);
  if (!signal) return null;
  const raw = (await signal.innerText().catch(() => "")) || "";
  return `can't post to r/${sub}: ${classifyBlockReason(raw)}`;
}

/**
 * Switch the body editor into Markdown mode so the typed body is treated as
 * Markdown rather than rendered literally by the rich editor. RE-CALIBRATED LIVE
 * 2026-07-04 for the <shreddit-composer>: focus the body (so its toolbar mounts) →
 * open the "More options" (…) overflow → click the "Switch to Markdown"
 * `rpl-menu-item` → CONFIRM the switch engaged (reverse toggle now reads "Switch to
 * Rich Text Editor" and/or a Markdown `<textarea>` is visible). The switch is NOT
 * sticky (reverts to rich mode on every fresh composer), so we do it each draft.
 *
 * Prior versions failed because (a) the toggle is a `rpl-menu-item`, not a
 * <button>, and the only matching <button> is a permanently-hidden responsive copy
 * that tolerantLocator's `.first()` locked onto and timed out on; (b) the "toolbar
 * ready" signal keyed on a non-existent aria-labelled Bold button. Both fixed.
 *
 * Best-effort throughout: if the body/menu/toggle doesn't resolve, we close any
 * menu we opened and return false — the caller then types into the rich editor and
 * emits an advisory. We only return true when the switch is CONFIRMED. NEVER throws.
 */
async function switchToMarkdownMode(page: Page): Promise<boolean> {
  // Focus the body so its formatting toolbar (and the … overflow) mounts.
  const body = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.bodyEditor, 6_000);
  if (body) await body.click().catch(() => {});
  // Wait for the toolbar overflow to hydrate before probing the menu.
  await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.rteToolbarReady, 5_000);

  for (let attempt = 0; attempt < 3; attempt++) {
    // The toggle may already be exposed (wide viewport / menu still open); else
    // open the … overflow that holds it.
    let toggle = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.markdownToggle, 1_200);
    if (!toggle) {
      const more = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.composerMoreOptions, 2_500);
      if (more) {
        await more.click().catch(() => {});
        await page.waitForTimeout(400);
        toggle = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.markdownToggle, 2_500);
      }
    }
    if (toggle) {
      await toggle.click().catch(() => {});
      await page.waitForTimeout(600);
      // Only claim success once the mode ACTUALLY flipped — guards against a
      // no-op click on a stale/misparsed node.
      const confirmed = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.markdownConfirm, 2_500);
      if (confirmed) return true;
    }
    // Close any menu we opened but couldn't use, then retry against jitter.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }
  return false;
}

/** Dismiss the flair modal without applying, so it can't intercept Save Draft. */
async function dismissFlairModal(page: Page): Promise<void> {
  const cancel = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.flairCancel, 2_000);
  if (cancel) await cancel.click().catch(() => {});
  await page.waitForTimeout(200);
}

/**
 * Select a flair template in the composer's flair modal. CALIBRATED LIVE
 * 2026-07-03 for the new <shreddit-composer>: open "Add flair and tags" → expand
 * "View all flairs" → SELECT the flair (the flair is a visually-hidden
 * faceplate-radio-input, so we .check() it — a plain .click() fails on "not
 * visible" — preferring the accessible NAME/text, since the composer radio `value`
 * ids can differ from the link_flair ids) → confirm with "Add". If selection
 * fails, the modal is DISMISSED (Cancel) so it can't intercept the Save Draft
 * click (drafts still save without a flair). Returns true iff a flair was applied.
 */
async function selectFlair(page: Page, flair: { id?: string; text?: string }): Promise<boolean> {
  const flairBtn = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.flairButton, 4_000);
  if (!flairBtn) return false;
  await flairBtn.click().catch(() => {});
  await page.waitForTimeout(400);

  // The modal shows a subset until "View all flairs" expands it (below-fold radios
  // aren't checkable until then). Best-effort.
  const viewAll = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.flairViewAll, 2_500);
  if (viewAll) {
    await viewAll.click().catch(() => {});
    await page.waitForTimeout(400);
  }

  // Select: prefer the accessible radio BY TEXT (most robust across id namespaces),
  // then fall back to the value-scoped radio, checking it (not clicking).
  let selected = false;
  if (flair.text) {
    const byText = page.getByRole("radio", { name: flair.text, exact: false }).first();
    try {
      await byText.check({ timeout: 4_000 });
      selected = true;
    } catch {
      /* fall through */
    }
  }
  if (!selected && flair.id) {
    const byVal = page.locator(`faceplate-radio-input[value="${flair.id}"]`).first();
    try {
      await byVal.check({ timeout: 3_000 });
      selected = true;
    } catch {
      try {
        await byVal.click({ force: true, timeout: 2_000 });
        selected = true;
      } catch {
        /* fall through */
      }
    }
  }

  if (!selected) {
    // Couldn't pick the flair — CLOSE the modal so it doesn't cover Save Draft.
    await dismissFlairModal(page);
    return false;
  }

  // Confirm — the new composer modal's confirm button is exactly "Add". This click
  // is what COLLAPSES the flair section; skipping it leaves the section overlaying
  // and intercepting the Save Draft click. Match by ACCESSIBLE NAME (calibrated
  // live 2026-07-03): a CSS `:text-is("Add")` does NOT match this button, and
  // `:has-text("Add")` would wrongly also match "Add flair and tags". Try Add,
  // then Apply/Done for other subs' modals; fall back to the CSS flairApply list.
  let confirmed = false;
  for (const name of ["Add", "Apply", "Done"]) {
    const btn = page.getByRole("button", { name, exact: true }).first();
    try {
      if ((await btn.count()) > 0) {
        await btn.click({ timeout: 3_000 });
        confirmed = true;
        break;
      }
    } catch {
      /* try the next label */
    }
  }
  if (!confirmed) {
    const apply = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.flairApply, 2_000);
    if (apply) await apply.click().catch(() => {});
  }
  await page.waitForTimeout(400);
  return true;
}

/**
 * Set an idempotent mark toggle (nsfw / spoiler) ON. Reads aria-pressed/checked
 * first so a second run doesn't toggle it back off. Best-effort — never throws.
 */
async function setToggleOn(page: Page, candidates: readonly string[]): Promise<boolean> {
  const toggle = await optionalLocator(page, candidates, 3_000);
  if (!toggle) return false;
  const pressed =
    (await toggle.getAttribute("aria-pressed").catch(() => null)) ??
    (await toggle.getAttribute("aria-checked").catch(() => null));
  if (pressed === "true") return true; // already on — don't flip it off
  await toggle.click().catch(() => {});
  await page.waitForTimeout(200);
  return true;
}

/**
 * Save the current composer as a draft WITHOUT posting.
 *
 * SAFEGUARD (mirrors LinkedIn's saveAsDraftLinkedIn): if the "Save Draft"
 * affordance does not resolve, we do NOT guess at another button — a wrong click
 * could Post. We bail without clicking and leave it to a human. There is NO fall
 * through to Post.
 */
export async function saveDraftReddit(
  page: Page,
  locate: typeof optionalLocator = optionalLocator,
  probeToast: (
    page: Page,
    candidates: readonly string[],
  ) => Promise<RedditToastPreclickState> = probeVisibleLocatorNow,
): Promise<{
  clicked: boolean;
  confirmed: boolean;
  toastBeforeClick: RedditToastPreclickState;
}> {
  const save = await locate(page, REDDIT_COMPOSER_SELECTORS.saveDraftButton, 6_000);
  if (!save) {
    // The "Save Draft" affordance didn't appear — do NOT guess another button
    // (a wrong click could post). Bail. NEVER fall through to Post.
    return { clicked: false, confirmed: false, toastBeforeClick: "not_checked" };
  }
  // A toast already visible cannot prove causality for this click. Snapshot its
  // absence first; confirmation requires an absent-before / visible-after edge.
  const toastBeforeClick = await probeToast(page, REDDIT_COMPOSER_SELECTORS.saveConfirmToast);
  await save.click();
  // Probe the "Draft saved" toast right after the click. Only an absent-before /
  // visible-after transition is attributed to this attempt; the drafts modal can
  // show a stale list too (see saveConfirmToast). Missing/ambiguous evidence means
  // unconfirmed, never that we should retry or guess another button.
  const toast = await locate(page, REDDIT_COMPOSER_SELECTORS.saveConfirmToast, 6_000);
  return {
    clicked: true,
    confirmed: toastBeforeClick === "absent" && !!toast,
    toastBeforeClick,
  };
}

export type RedditToastPreclickState = "not_checked" | "absent" | "present" | "inconclusive";

/** Zero-wait visibility snapshot used to rule out stale or unknowable evidence. */
async function probeVisibleLocatorNow(
  page: Page,
  candidates: readonly string[],
): Promise<RedditToastPreclickState> {
  let inconclusive = false;
  for (const selector of candidates) {
    try {
      const matches = selector.startsWith("//")
        ? page.locator(`xpath=${selector}`)
        : page.locator(selector);
      const count = await matches.count();
      for (let index = 0; index < count; index += 1) {
        if (await matches.nth(index).isVisible()) return "present";
      }
    } catch {
      // A failed probe is not evidence of absence. Keep checking for a definite
      // visible stale node, but fail closed if none of the remaining checks find one.
      inconclusive = true;
    }
  }
  return inconclusive ? "inconclusive" : "absent";
}

/** Describe the three save outcomes without turning a click into a confirmed save. */
export function describeRedditSaveAttempt(
  subreddit: string,
  clicked: boolean,
  confirmed: boolean,
  toastBeforeClick: RedditToastPreclickState = "not_checked",
): string {
  if (!clicked) {
    return (
      `Could not resolve the "Save Draft" affordance (NEEDS CALIBRATION), so the CLI did not ` +
      "click a save control. No native draft was confirmed; NEVER auto-posted. Compare Reddit " +
      "DRAFTS manually in the same CLI-owned profile before deciding any next action. Do not " +
      "rerun automatically or blindly: Reddit has no draft idempotency ledger and another " +
      "attempt could duplicate an existing draft."
    );
  }
  if (!confirmed) {
    const evidence = toastBeforeClick === "present"
      ? "A visible \"Draft saved\" node already existed before the click, so the post-click signal could not be attributed to this attempt."
      : toastBeforeClick === "inconclusive"
        ? "The CLI could not establish that \"Draft saved\" was absent before the click, so later toast visibility could not be attributed to this attempt."
        : "Reddit's transient \"Draft saved\" toast was not observed after the click.";
    return (
      `Clicked "Save Draft" exactly once for r/${subreddit}. ${evidence} Draft state is ` +
      "UNCONFIRMED. Compare Reddit DRAFTS manually in the same CLI-owned profile; do not rerun " +
      "automatically or blindly because Reddit has no draft idempotency ledger and another " +
      "attempt could duplicate an existing draft."
    );
  }
  return (
    `Reddit's "Draft saved" toast was absent before and visible after one "Save Draft" click for r/${subreddit}. ` +
    "Open Reddit Drafts to review and post manually."
  );
}

/**
 * Stage `post` as a NATIVE Reddit self-post DRAFT using the persistent logged-in
 * profile. NEVER posts. Runs the eligibility check first (design §4.1) — if the
 * composer surfaces a block, returns { blocked } without staging. Otherwise types
 * the title + Markdown body, selects the resolved flair, sets nsfw/spoiler, and
 * saves via "Save Draft", then captures the transient acceptance toast.
 *
 * Live preflight (§4) is run by the real command before this function; stageDraft
 * consumes the already-resolved opts.flairId. Local-only --dry-run never enters.
 */
export async function stageDraft(
  post: GeneratedSelfPost,
  opts: StageDraftOptions = {},
): Promise<StageDraftResult> {
  const sub = post.subreddit?.trim();
  if (!sub) throw new Error("No target subreddit to stage a Reddit draft (post.subreddit is empty).");
  if (!post.title.trim()) throw new Error("No title to stage (empty Reddit self-post title).");

  const ctx = (await getBrowserContext({ inspect: opts.inspect, force: opts.force })) as BrowserContext;
  const page = await ctx.newPage();
  try {
    const titleInput = await openComposer(page, sub);

    // ELIGIBILITY CHECK (§4.1): if the composer surfaces a karma/age/approved-
    // submitter/ban/restricted block, STOP — never proceed toward Post.
    const block = await detectEligibilityBlock(page, sub);
    if (block) {
      return {
        kind: "self",
        saveStatus: "not_attempted",
        saved: false,
        verified: false,
        subreddit: sub,
        blocked: block,
        note: `${block}. No native draft was confirmed. NEVER auto-posted.`,
      };
    }

    // Switch to raw-Markdown mode BEFORE typing the body so the Markdown is kept
    // verbatim rather than re-interpreted by the rich editor.
    const markdown = await switchToMarkdownMode(page);

    // Title.
    await titleInput.click();
    await titleInput.press(`${modifier()}+a`);
    await titleInput.press("Backspace");
    await typeText(page, titleInput, post.title);

    // Body. When the Markdown switch succeeded, the rich div[name="body"] is hidden
    // and the body is a plain <textarea> — lead with the Markdown-mode selectors so
    // typing doesn't stall waiting out the now-hidden rich editor.
    if (post.body.trim()) {
      const bodyCandidates = markdown
        ? [...REDDIT_COMPOSER_SELECTORS.bodyEditorMarkdown, ...REDDIT_COMPOSER_SELECTORS.bodyEditor]
        : REDDIT_COMPOSER_SELECTORS.bodyEditor;
      const bodyEditor = await tolerantLocator(
        page,
        bodyCandidates,
        `Reddit self-post body editor for r/${sub}`,
        OPEN_TIMEOUT,
      );
      await bodyEditor.click();
      await bodyEditor.press(`${modifier()}+a`);
      await bodyEditor.press("Backspace");
      await typeText(page, bodyEditor, post.body);
    }

    // Flair (only when a resolved template was passed in). Prefer text selection.
    let flairApplied: string | undefined;
    if (opts.flairId || opts.flairText) {
      const ok = await selectFlair(page, { id: opts.flairId, text: opts.flairText });
      if (ok) flairApplied = opts.flairText ?? opts.flairId;
    }

    // Marks.
    if (post.nsfw) await setToggleOn(page, REDDIT_COMPOSER_SELECTORS.nsfwToggle);
    if (post.spoiler) await setToggleOn(page, REDDIT_COMPOSER_SELECTORS.spoilerToggle);

    // Save Draft (never Post; bail if the affordance doesn't resolve). The
    // "Draft saved" toast (captured inside saveDraftReddit) is the verification.
    const {
      clicked: saved,
      confirmed: verified,
      toastBeforeClick,
    } = await saveDraftReddit(page);

    const noteParts: string[] = [
      describeRedditSaveAttempt(sub, saved, verified, toastBeforeClick),
    ];
    if (!markdown) {
      noteParts.push(
        "Could NOT switch the composer to Markdown mode THIS RUN (the toggle normally engages — this is a rare fallback; the composer DOM may have drifted) — the body was entered in the RICH editor, so Markdown syntax (**bold**, lists, fenced code) will render LITERALLY. Before posting, open the draft and use the body toolbar's “… → Switch to Markdown” so it renders as intended.",
      );
    }
    if (flairApplied) noteParts.push(`flair applied: ${flairApplied}.`);
    else if (opts.flairId || opts.flairText)
      noteParts.push(
        `flair "${opts.flairText ?? opts.flairId}" requested but the picker did not resolve — the modal was dismissed so the draft could still save; set the flair manually before posting.`,
      );
    if (post.codeFlags.length) {
      noteParts.push(
        "Code blocks: old Reddit does not support fenced blocks; use 4-space indentation for old/new portability and inspect the native draft.",
      );
    }
    if (post.linkFlags.length) {
      noteParts.push("Links present in the body — Reddit keeps inline links, no first-comment workaround needed.");
    }

    return {
      kind: "self",
      saveStatus: !saved ? "not_attempted" : verified ? "toast_confirmed" : "unconfirmed",
      saved,
      verified,
      subreddit: sub,
      flair: flairApplied,
      note: noteParts.join(" "),
    };
  } finally {
    // Close only the page we opened; leave the persistent context alive so the
    // session stays warm for subsequent commands.
    await page.close().catch(() => {});
  }
}

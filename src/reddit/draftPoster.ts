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
 * (CLAUDE.md "Verify live").
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

  // The drafts list. Reopened after saving to VERIFY the draft actually landed.
  // BEST-EFFORT — Reddit exposes drafts under the submit/composer surface; the
  // exact URL/route NEEDS LIVE CALIBRATION.
  draftsUrl: "https://www.reddit.com/submit?type=TEXT",

  // The "Post" / text self-post tab within the composer, in case the submit page
  // does not default to it. BEST-EFFORT / NEEDS LIVE CALIBRATION.
  selfPostTab: [
    'button[role="tab"]:has-text("Text"):visible',
    '//button[@role="tab"][normalize-space()="Text"]',
    '//*[@role="tab"][contains(normalize-space(),"Post")]',
  ],

  // A stable member of the body RTE formatting toolbar, used only as a "toolbar
  // has hydrated" signal (the toolbar mounts a few seconds after the composer, and
  // looking for the Markdown toggle before then silently fails). CALIBRATED LIVE
  // 2026-07-03. NEEDS LIVE CALIBRATION.
  rteToolbarReady: ['button[aria-label*="Bold" i]:visible', 'button:has-text("Bold"):visible'],
  // The body toolbar's "More options" (…) overflow button — one place the "Switch
  // to Markdown" control lives (at other viewports it is an inline toolbar
  // button). CALIBRATED LIVE 2026-07-03; renders once the body is focused.
  // NEEDS LIVE CALIBRATION.
  composerMoreOptions: ['button[aria-label*="More options" i]:visible'],
  // Switch the body editor into Markdown mode so the typed body is treated as
  // Markdown (Reddit's editor defaults to the rich/WYSIWYG mode, which renders
  // markdown syntax literally). CALIBRATED LIVE 2026-07-03: this is a MENU ITEM
  // inside composerMoreOptions (opened after focusing the body), not a top-level
  // button. The body stays the same div[name="body"] element in either mode, so
  // switching never breaks body typing. BEST-EFFORT / NEEDS LIVE CALIBRATION.
  markdownToggle: [
    'button:has-text("Switch to Markdown"):visible',
    '//button[contains(normalize-space(),"Switch to Markdown")]',
    'button[aria-label*="Switch to Markdown" i]',
    'button:has-text("Markdown Mode"):visible',
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
  /** Whether the post-save verification matched the staged title/leading body. */
  verified: boolean;
  /** The target subreddit (without the r/ prefix). */
  subreddit: string;
  /** The flair id selected in the composer, when one was applied. */
  flair?: string;
  /**
   * Set (draft NOT staged) when the composer surfaced an eligibility block — a
   * plain message like "can't post to r/foo: insufficient karma". stageDraft
   * returns this rather than throwing, and never proceeds toward Post.
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
 * Markdown rather than rendered literally by the rich editor. CALIBRATED LIVE
 * 2026-07-03 for the new <shreddit-composer>: focus the body (so its toolbar
 * renders) → open the "More options" (…) overflow menu → click "Switch to
 * Markdown". The body stays the SAME div[name="body"] element in either mode, so
 * this never breaks the subsequent body typing.
 *
 * Best-effort throughout: if the body/menu/toggle doesn't resolve (viewport,
 * hydration, or the composer is already in Markdown mode), we close any menu we
 * opened and return false — the caller then types into the rich editor and emits
 * an advisory. NEVER throws.
 */
async function switchToMarkdownMode(page: Page): Promise<boolean> {
  // The RTE formatting toolbar hydrates a few seconds AFTER the composer mounts,
  // and interacting before it does can suppress it. Wait for a stable toolbar
  // member ("Bold") to appear FIRST — looking for the toggle too early was why
  // this silently no-op'd. Best-effort: continue even if Bold never resolves.
  await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.rteToolbarReady, 5_000);

  // Path 1: at some viewports the toggle is an inline toolbar button.
  let toggle = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.markdownToggle, 1_500);
  if (toggle) {
    await toggle.click().catch(() => {});
    await page.waitForTimeout(400);
    return true;
  }

  // Path 2: otherwise it lives in the body toolbar's "More options" (…) overflow
  // menu, which renders once the body is focused. Retry against hydration jitter;
  // close any menu we open but don't use. Kept SHORT — Reddit's new composer
  // hydrates this toggle unreliably, so we do not want to stall a working draft
  // waiting on a control that may never mount (the caller degrades gracefully).
  const body = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.bodyEditor, 4_000);
  if (body) await body.click().catch(() => {});
  for (let attempt = 0; attempt < 2; attempt++) {
    const more = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.composerMoreOptions, 3_000);
    if (more) {
      await more.click().catch(() => {});
      await page.waitForTimeout(400);
      toggle = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.markdownToggle, 2_500);
      if (toggle) {
        await toggle.click().catch(() => {});
        await page.waitForTimeout(400);
        return true;
      }
      await page.keyboard.press("Escape").catch(() => {});
    }
    await page.waitForTimeout(700);
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
 * could Post. We bail (return null) and leave it to a human. There is NO fall
 * through to Post.
 */
async function saveDraftReddit(page: Page): Promise<boolean> {
  const save = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.saveDraftButton, 6_000);
  if (!save) {
    // The "Save Draft" affordance didn't appear — do NOT guess another button
    // (a wrong click could post). Bail. NEVER fall through to Post.
    return false;
  }
  await save.click();
  await page.waitForTimeout(1_000);
  return true;
}

/**
 * Verify a draft was ACTUALLY saved by reopening the drafts list and matching the
 * staged title + leading body (ports the X/LinkedIn "match the staged item, don't
 * trust a blind success" hardening — the same false-positive trap). Non-fatal —
 * returns false (unconfirmed) if inconclusive; never throws.
 */
async function verifyDraftSaved(page: Page, title: string, body: string): Promise<boolean> {
  const titleNeedle = normalizeForMatch(title).slice(0, 60);
  const bodyNeedle = normalizeForMatch(body).slice(0, 40);
  if (!titleNeedle) return false;
  try {
    await page.goto(REDDIT_COMPOSER_SELECTORS.draftsUrl, { waitUntil: "domcontentloaded" });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const pageText = normalizeForMatch((await page.locator("body").innerText().catch(() => "")) || "");
      // Require the staged title; the leading body is a bonus signal (drafts list
      // may only show titles), so match title AND (body if we had one).
      const titleHit = pageText.includes(titleNeedle);
      const bodyHit = !bodyNeedle || pageText.includes(bodyNeedle);
      if (titleHit && bodyHit) return true;
      await page.waitForTimeout(500);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Stage `post` as a NATIVE Reddit self-post DRAFT using the persistent logged-in
 * profile. NEVER posts. Runs the eligibility check first (design §4.1) — if the
 * composer surfaces a block, returns { blocked } without staging. Otherwise types
 * the title + Markdown body, selects the resolved flair, sets nsfw/spoiler, and
 * saves via "Save Draft", then best-effort verifies the draft landed.
 *
 * Preflight (§4) is run by the command so --dry-run reuses it; stageDraft consumes
 * the already-resolved opts.flairId.
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
        verified: false,
        subreddit: sub,
        blocked: block,
        note: `${block}. No draft was staged. NEVER auto-posted.`,
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

    // Body.
    if (post.body.trim()) {
      const bodyEditor = await tolerantLocator(
        page,
        REDDIT_COMPOSER_SELECTORS.bodyEditor,
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

    // Save Draft (never Post; bail if the affordance doesn't resolve).
    const saved = await saveDraftReddit(page);
    const verified = saved ? await verifyDraftSaved(page, post.title, post.body) : false;

    const noteParts: string[] = [];
    noteParts.push(
      saved
        ? `Saved via "Save Draft" to r/${sub}. Draft is under Reddit's drafts (submit page) — open it to review and post manually.`
        : `Could not resolve the "Save Draft" affordance (NEEDS CALIBRATION) — bailed WITHOUT guessing another button. No draft confirmed; NEVER auto-posted. Check Reddit drafts / re-run with --inspect.`,
    );
    if (!markdown) {
      noteParts.push(
        "Could NOT switch the composer to Markdown mode (Reddit's new composer hydrates that toggle unreliably) — the body was entered in the RICH editor, so Markdown syntax (**bold**, lists, fenced code) will render LITERALLY. Before posting, open the draft and use the body toolbar's “… → Switch to Markdown” so it renders as intended.",
      );
    }
    if (flairApplied) noteParts.push(`flair applied: ${flairApplied}.`);
    else if (opts.flairId || opts.flairText)
      noteParts.push(
        `flair "${opts.flairText ?? opts.flairId}" requested but the picker did not resolve — the modal was dismissed so the draft could still save; set the flair manually before posting.`,
      );
    if (post.codeFlags.length) {
      noteParts.push(
        "Code blocks: confirm fenced code renders on both new and old Reddit (old Reddit needs 4-space indentation for some clients).",
      );
    }
    if (post.linkFlags.length) {
      noteParts.push("Links present in the body — Reddit keeps inline links, no first-comment workaround needed.");
    }

    return {
      kind: "self",
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

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

  // Switch the body editor into raw-Markdown mode (Reddit's rich editor defaults
  // to the fancy/WYSIWYG editor; we want verbatim Markdown). BEST-EFFORT /
  // NEEDS LIVE CALIBRATION — the toggle is a small "Markdown Mode" / "Switch to
  // Markdown Editor" control near the body editor.
  markdownToggle: [
    'button[aria-label*="Markdown" i]',
    'button:has-text("Markdown Mode"):visible',
    'button:has-text("Switch to Markdown"):visible',
    '//button[contains(normalize-space(),"Markdown")]',
  ],

  // The title input. NEEDS LIVE CALIBRATION.
  titleInput: [
    'textarea[name="title"]',
    'textarea[placeholder*="Title" i]',
    'input[name="title"]',
    'faceplate-textarea-input[name="title"] textarea',
    '//textarea[contains(@placeholder,"Title")]',
  ],

  // The Markdown body editor (after markdownToggle switches to raw mode). In
  // Markdown mode Reddit renders a plain <textarea>; in rich mode it is a
  // contenteditable. typeText handles both. NEEDS LIVE CALIBRATION.
  bodyEditor: [
    'textarea[name="body"]',
    'textarea[placeholder*="body" i]',
    'div[contenteditable="true"][role="textbox"]',
    'div[name="body"] div[contenteditable="true"]',
    '//textarea[contains(@placeholder,"Text")]',
  ],

  // Open the flair picker. NEEDS LIVE CALIBRATION.
  flairButton: [
    'button:has-text("Add flair"):visible',
    'button:has-text("Flair"):visible',
    'button[aria-label*="flair" i]',
    '//button[contains(normalize-space(),"flair")]',
  ],
  // A flair option row inside the open picker. selectFlair() ALSO builds
  // id-specific candidates from the resolved flairId at call time (derived, not a
  // new static selector) so the correct template is chosen; these are the generic
  // fallbacks. NEEDS LIVE CALIBRATION.
  flairOption: [
    'span[role="button"][data-flair-id]',
    'li[role="option"]',
    'button[role="radio"]',
    'div.flairselect__option',
  ],
  // Apply/confirm the chosen flair and close the picker. NEEDS LIVE CALIBRATION.
  flairApply: [
    'button:has-text("Apply"):visible',
    'button:has-text("Done"):visible',
    '//button[normalize-space()="Apply"]',
    '//button[normalize-space()="Done"]',
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
  eligibilityBlockSignal: [
    '//*[contains(translate(normalize-space(),"KARMA","karma"),"karma")]',
    '//*[contains(normalize-space(),"too new") or contains(normalize-space(),"account age") or contains(normalize-space(),"account is too")]',
    '//*[contains(normalize-space(),"approved") and contains(normalize-space(),"submitter")]',
    '//*[contains(normalize-space(),"banned from")]',
    '//*[contains(normalize-space(),"restricted") and contains(normalize-space(),"post")]',
    '//*[contains(normalize-space(),"You don\'t have permission") or contains(normalize-space(),"not allowed to post")]',
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
 * Switch the body editor into raw-Markdown mode so the Markdown body is kept
 * verbatim (not re-parsed by the rich editor). Best-effort — if the toggle
 * doesn't resolve (composer may already be in Markdown mode), continue.
 */
async function switchToMarkdownMode(page: Page): Promise<boolean> {
  const toggle = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.markdownToggle, 4_000);
  if (!toggle) return false;
  await toggle.click().catch(() => {});
  await page.waitForTimeout(300);
  return true;
}

/**
 * Select the flair template `flairId` in the composer. Best-effort — opens the
 * picker, prefers an id-specific option (derived from flairId), falls back to the
 * generic option candidates, then applies. Returns true if a flair was applied.
 */
async function selectFlair(page: Page, flairId: string): Promise<boolean> {
  const flairBtn = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.flairButton, 4_000);
  if (!flairBtn) return false;
  await flairBtn.click().catch(() => {});

  // Prefer an option that carries the resolved template id (derived candidates,
  // not new static selectors); fall back to the generic flairOption list.
  const idCandidates = [
    `[data-flair-id="${flairId}"]`,
    `input[value="${flairId}"]`,
    `//*[@data-flair-id="${flairId}"]`,
  ];
  let option = await optionalLocator(page, idCandidates, 4_000);
  if (!option) option = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.flairOption, 4_000);
  if (!option) return false;
  await option.click().catch(() => {});

  const apply = await optionalLocator(page, REDDIT_COMPOSER_SELECTORS.flairApply, 3_000);
  if (apply) await apply.click().catch(() => {});
  await page.waitForTimeout(300);
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

    // Flair (only when a resolved template id was passed in).
    let flairApplied: string | undefined;
    if (opts.flairId) {
      const ok = await selectFlair(page, opts.flairId);
      if (ok) flairApplied = opts.flairId;
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
        "Markdown-mode toggle did not resolve — the body may have been typed into the rich editor; verify Markdown rendered as intended (fenced code renders differently on old Reddit).",
      );
    }
    if (flairApplied) noteParts.push(`flair applied: ${flairApplied}.`);
    else if (opts.flairId) noteParts.push(`flair id ${opts.flairId} requested but the picker did not resolve — set it manually.`);
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

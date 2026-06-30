/**
 * X draft poster — drives the persistent, already-logged-in browser profile
 * (session.getBrowserContext()) to create a NATIVE DRAFT on X and STOP THERE.
 *
 * HARD BOUNDARY: this module MUST NEVER click Post / publish. It opens the
 * composer, types the generated content, and SAVES IT AS A DRAFT (or leaves it
 * unsent), so the result sits one click from publishing — and a human takes that
 * click. There is intentionally no code path that triggers the Post button; the
 * send action is future scope behind the SEND-GATE (PRODUCT_SPEC §5).
 *
 * SELECTOR DRIFT — READ THIS:
 *   Every selector in X_COMPOSER_SELECTORS is BEST-EFFORT and NEEDS LIVE
 *   CALIBRATION against the current x.com composer DOM. X's composer (and its
 *   "Drafts" / "Unsent" affordances and the Articles composer) change frequently.
 *   Each field is a list of candidate strategies tried in order with explicit
 *   waits. Run `publish draft x ... --inspect` (headful) to watch the flow and
 *   recalibrate. Comments below mark exactly which selectors are most fragile.
 *
 * The session module is the SINGLE authenticator — we never log in here; we only
 * borrow its persistent context.
 */

import type { BrowserContext, Page, Locator } from "playwright";
import { getBrowserContext, type EnsureSessionOptions } from "../session.js";
import type { GeneratedContent } from "./content.js";

/**
 * Centralized composer/draft selectors. EVERY entry NEEDS LIVE CALIBRATION.
 * Each value is an ordered list of candidate strategies; lookups try them in
 * order until one resolves within the timeout (see tolerantLocator()).
 */
export const X_COMPOSER_SELECTORS = {
  composeUrl: "https://x.com/compose/post",
  // Articles composer entry point (X Premium "Articles"). VERY likely to drift
  // and may not exist for the account — handled gracefully if absent.
  articleComposeUrl: "https://x.com/compose/articles",
  homeUrl: "https://x.com/home",

  // The main tweet text box. data-testid is the most stable hook X exposes, but
  // it still drifts — keep the role/contenteditable fallbacks.
  tweetTextbox: [
    'div[data-testid="tweetTextarea_0"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[aria-label="Post text"]',
  ],
  // For thread post N (0-based testid suffix that X uses for added posts).
  // tweetTextbox_n(i) builds the per-post selector below.
  // "Add another post" (+) button that appends a new composer row in a thread.
  addPostButton: [
    'button[data-testid="addButton"]',
    'a[data-testid="addButton"]',
    'div[data-testid="addButton"]',
    '//button[.//span[text()="Add"]]',
  ],

  // ---- Draft saving ----
  // X shows a "Drafts" / "Save"/"Unsent" prompt when you try to leave a composer
  // with text. The exact affordances are HIGHLY fragile:
  //   - Some UIs: a "Drafts" button at the top of the composer that opens a menu.
  //   - Some UIs: closing the composer (X button) raises a "Save / Discard" dialog
  //     whose "Save" stores it under Unsent posts.
  // We prefer the explicit "Drafts" control; otherwise fall back to close→Save.
  draftsButton: [
    'button[data-testid="unsentButton"]',
    'a[data-testid="unsentButton"]',
    'div[role="button"][aria-label="Drafts"]',
    '//span[text()="Drafts"]/ancestor::*[@role="button"][1]',
  ],
  closeComposerButton: [
    'button[data-testid="app-bar-close"]',
    'div[data-testid="app-bar-close"]',
    'button[aria-label="Close"]',
    '//div[@aria-label="Close"]',
  ],
  // The "Save" affordance in the close→save confirmationSheet (saves as an
  // Unsent draft). Calibrated: data-testid="confirmationSheetConfirm" (the
  // sibling "Discard" is confirmationSheetCancel — never click it).
  saveDraftButton: [
    '[data-testid="confirmationSheetConfirm"]',
    '//span[text()="Save"]/ancestor::*[@role="button"][1]',
    '//span[text()="Save draft"]/ancestor::*[@role="button"][1]',
  ],

  // ---- Article composer ----
  // articleComposeUrl is the Articles HUB (a list with Drafts/Published tabs),
  // NOT the editor. Reach the editor by clicking a create/"Write" control, which
  // navigates to https://x.com/compose/articles/edit/<id>. CALIBRATED 2026-06:
  //   - aria-label="create" is the persistent create control (always present),
  //   - empty_state_button_text ("Write") only shows when you have no articles.
  articleCreateButton: [
    '[aria-label="create"]',
    '[data-testid="empty_state_button_text"]',
    '//span[normalize-space()="Write"]/ancestor::*[@role="button"][1]',
  ],
  // Editor inputs. CALIBRATED 2026-06: title = twitter-article-title; body =
  // the contenteditable data-testid="composer" (inside composerRichTextInputContainer).
  articleTitleInput: [
    '[data-testid="twitter-article-title"]',
    'div[data-testid="longformRichTextTitleInput"]',
    'div[role="textbox"][aria-label="Title"]',
  ],
  articleBodyInput: [
    'div[data-testid="composer"][contenteditable="true"]',
    '[data-testid="composer"]',
    'div[data-testid="composerRichTextInputContainer"] [contenteditable="true"]',
    'div[data-testid="longformRichTextInput"]',
  ],

  // The PUBLISH/POST button — listed ONLY so we are explicit about what we must
  // NEVER click. Nothing in this module ever locates+clicks it.
  // post (FORBIDDEN): 'button[data-testid="tweetButton"]' / 'button[data-testid="tweetButtonInline"]'
} as const;

/** Per-post textbox selector for the i-th (0-based) post in a thread. */
function tweetTextboxSelectors(i: number): string[] {
  return [
    `div[data-testid="tweetTextarea_${i}"]`,
    // fall back to the n-th generic textbox if the testid index drifts
    `div[role="textbox"][contenteditable="true"] >> nth=${i}`,
  ];
}

const DEFAULT_TIMEOUT = 15_000;

/**
 * Try a list of candidate selectors in order and return the first Locator that
 * becomes visible within the timeout. Supports XPath (strings starting with //)
 * and Playwright CSS/engine selectors. Throws an actionable error listing the
 * tried strategies if none resolve — the comment everywhere is: this is where
 * live calibration happens.
 */
async function tolerantLocator(
  page: Page,
  candidates: readonly string[],
  what: string,
  timeout = DEFAULT_TIMEOUT,
): Promise<Locator> {
  const errors: string[] = [];
  // Give the whole set a shared budget; each candidate gets a slice but we keep
  // a floor so a single fast-failing selector doesn't starve the rest.
  const per = Math.max(1500, Math.floor(timeout / candidates.length));
  for (const sel of candidates) {
    const locator = sel.startsWith("//") ? page.locator(`xpath=${sel}`) : page.locator(sel);
    try {
      await locator.first().waitFor({ state: "visible", timeout: per });
      return locator.first();
    } catch (err) {
      errors.push(`  - ${sel}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(
    `Could not locate ${what} — all candidate selectors failed (NEEDS LIVE CALIBRATION; ` +
      `re-run with --inspect to watch the DOM):\n${errors.join("\n")}`,
  );
}

/** Like tolerantLocator but returns null instead of throwing (optional steps). */
async function optionalLocator(
  page: Page,
  candidates: readonly string[],
  timeout = 4_000,
): Promise<Locator | null> {
  try {
    return await tolerantLocator(page, candidates, "optional element", timeout);
  } catch {
    return null;
  }
}

export interface StageDraftOptions extends EnsureSessionOptions {
  /** Headful + slower so a human can watch/calibrate. Maps to --inspect. */
  inspect?: boolean;
}

export interface StageDraftResult {
  format: GeneratedContent["format"];
  /** Number of composer rows typed (1 for tweet/article, N for a thread). */
  posts: number;
  /** Whether the post-save verification step confirmed an Unsent/draft entry. */
  verified: boolean;
  /** Human-readable note about how the draft was saved / what to check. */
  note: string;
}

/**
 * Stage `content` as a NATIVE DRAFT on X using the persistent logged-in profile.
 * NEVER posts. Returns a result describing what was staged + a best-effort
 * verification that the draft landed in Unsent.
 */
export async function stageDraft(
  content: GeneratedContent,
  opts: StageDraftOptions = {},
): Promise<StageDraftResult> {
  const ctx = (await getBrowserContext({ inspect: opts.inspect, force: opts.force })) as BrowserContext;
  const page = await ctx.newPage();
  try {
    if (content.format === "article") {
      return await stageArticleDraft(page, content);
    }
    return await stageTweetOrThreadDraft(page, content);
  } finally {
    // Close only the page we opened; leave the persistent context alive so the
    // session stays warm for subsequent commands.
    await page.close().catch(() => {});
  }
}

/**
 * Tweet or thread: open the standard composer, type each post (adding rows for
 * thread posts), then SAVE AS DRAFT via the Drafts control or close→Save dialog.
 * NEVER clicks Post.
 */
async function stageTweetOrThreadDraft(
  page: Page,
  content: GeneratedContent,
): Promise<StageDraftResult> {
  const posts =
    content.format === "thread"
      ? (content.thread ?? []).map((p) => p.text)
      : content.tweet
        ? [content.tweet.text]
        : [];

  if (posts.length === 0) {
    throw new Error("No content to stage (empty tweet/thread).");
  }

  await page.goto(X_COMPOSER_SELECTORS.composeUrl, { waitUntil: "domcontentloaded" });

  // First post.
  const firstBox = await tolerantLocator(page, X_COMPOSER_SELECTORS.tweetTextbox, "tweet text box");
  await firstBox.click();
  await typeText(page, firstBox, posts[0]);

  // Remaining posts: click "Add" to append a row, then type into row i.
  for (let i = 1; i < posts.length; i++) {
    const addBtn = await tolerantLocator(
      page,
      X_COMPOSER_SELECTORS.addPostButton,
      `"add another post" button (for thread post ${i + 1})`,
    );
    await addBtn.click();
    const box = await tolerantLocator(
      page,
      tweetTextboxSelectors(i),
      `thread post ${i + 1} text box`,
    );
    await box.click();
    await typeText(page, box, posts[i]);
  }

  const saved = await saveAsDraft(page);
  const verified = await verifyDraftSaved(page);

  return {
    format: content.format,
    posts: posts.length,
    verified,
    note: saved
      ? `Saved via ${saved}. Draft is under X "Unsent" — open the composer's Drafts to review and post manually.`
      : `Attempted to save as draft (path uncertain — NEEDS CALIBRATION). Check X "Unsent"/Drafts manually.`,
  };
}

/**
 * Article: open the Articles composer, fill title + body markdown, then leave it
 * unsent (Articles autosave drafts). NEVER clicks Publish.
 */
async function stageArticleDraft(
  page: Page,
  content: GeneratedContent,
): Promise<StageDraftResult> {
  if (!content.article) throw new Error("No article content to stage.");

  // articleComposeUrl is the Articles HUB, not the editor. Open it, then click a
  // create/"Write" control to enter the editor (/compose/articles/edit/<id>).
  await page.goto(X_COMPOSER_SELECTORS.articleComposeUrl, { waitUntil: "domcontentloaded" });

  const createBtn = await optionalLocator(page, X_COMPOSER_SELECTORS.articleCreateButton, 8_000);
  if (!createBtn) {
    throw new Error(
      "Could not find the 'create article' control on the X Articles hub. This " +
        "account may not have Articles (Premium+) access, or the selector drifted " +
        "(re-run with --inspect to recalibrate articleCreateButton). " +
        `URL: ${X_COMPOSER_SELECTORS.articleComposeUrl}`,
    );
  }
  await createBtn.click();

  // Wait for the editor's Title input to surface (also confirms the editor opened).
  const titleBox = await optionalLocator(page, X_COMPOSER_SELECTORS.articleTitleInput, 12_000);
  if (!titleBox) {
    throw new Error(
      "Clicked the Articles create control but the editor's Title input never " +
        "appeared (selector drift or Articles unavailable; re-run with --inspect). " +
        `URL now: ${page.url()}`,
    );
  }

  await titleBox.click();
  await typeText(page, titleBox, content.article.title);

  const bodyBox = await tolerantLocator(
    page,
    X_COMPOSER_SELECTORS.articleBodyInput,
    "Article body input",
  );
  await bodyBox.click();
  // Articles take rich text; we paste the markdown body verbatim. The human can
  // adjust formatting in X's Articles editor (code blocks still need images).
  await typeText(page, bodyBox, content.article.markdown);

  // Articles autosave as drafts; give autosave a moment. Being in the editor with
  // an article id in the URL is our verification that a draft now exists.
  await page.waitForTimeout(2_500);
  const verified = /\/compose\/articles\/edit\/\d+/.test(page.url());

  return {
    format: "article",
    posts: 1,
    verified,
    note:
      "Article typed into the X Articles editor; X autosaves Article drafts under " +
      "Articles → Drafts. Review and publish manually there. NEVER auto-published.",
  };
}

/** Type into a contenteditable composer box reliably (clear-then-type). */
async function typeText(page: Page, box: Locator, text: string): Promise<void> {
  await box.focus();
  // Use keyboard insertion so X's contenteditable + mention/link auto-handling
  // fires the same input events a human would. type() is intentionally used over
  // fill() because X's composer is a contenteditable, not an <input>.
  await page.keyboard.insertText(text);
  // Small settle so X's character counter / draft state catches up.
  await page.waitForTimeout(250);
}

/**
 * Save the current composer as a draft WITHOUT posting.
 *
 * Calibrated 2026-06 flow: click the composer's close (X / app-bar-close); X
 * raises a confirmationSheetDialog with "Save" (confirmationSheetConfirm) and
 * "Discard" (confirmationSheetCancel); click Save → stored under Unsent.
 *
 * IMPORTANT: we do NOT use the composer's own "Drafts" (unsentButton) control —
 * it OPENS the drafts list, it does not save the current post (verified live).
 * Returns a short label of the path used, or null if the flow didn't resolve.
 */
async function saveAsDraft(page: Page): Promise<string | null> {
  const close = await optionalLocator(page, X_COMPOSER_SELECTORS.closeComposerButton, 5_000);
  if (!close) return null;
  await close.click();

  const save = await optionalLocator(page, X_COMPOSER_SELECTORS.saveDraftButton, 5_000);
  if (!save) {
    // The Save/Discard confirmation didn't appear as expected — do NOT guess at
    // another button (a wrong click could discard or post). Leave it to a human.
    return null;
  }
  await save.click();
  await page.waitForTimeout(750);
  return "the close→Save dialog";
}

/**
 * Best-effort verification that a draft was saved: navigate to the Unsent drafts
 * surface and check that at least one draft entry is present. Non-fatal — returns
 * false (not throws) if verification is inconclusive.
 */
async function verifyDraftSaved(page: Page, _article = false): Promise<boolean> {
  try {
    // The drafts list has no stable direct URL (the /compose/post/unsent route
    // errors). Open a fresh (empty) composer and click its "Drafts" (unsentButton)
    // control to view Unsent posts, then check for at least one row.
    await page.goto(X_COMPOSER_SELECTORS.composeUrl, { waitUntil: "domcontentloaded" });
    const draftsBtn = await optionalLocator(page, X_COMPOSER_SELECTORS.draftsButton, 6_000);
    if (!draftsBtn) return false;
    await draftsBtn.click();
    await page.waitForTimeout(1_500);
    const row = await optionalLocator(
      page,
      ['div[data-testid="cellInnerDiv"]', 'article[data-testid="tweet"]'],
      6_000,
    );
    return row !== null;
  } catch {
    return false;
  }
}

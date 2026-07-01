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
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { getBrowserContext, type EnsureSessionOptions } from "../session.js";
import type { ArticleBlock, GeneratedContent, InlineRun } from "./content.js";

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
  // The REAL native-drafts surface. CALIBRATED (issue #4): the bare
  // /compose/post/unsent route ERRORS; /compose/post/unsent/drafts works and
  // lists the saved Unsent drafts. Used to VERIFY a draft actually landed
  // (matching the staged text) instead of trusting a background-timeline row.
  draftsUrl: "https://x.com/compose/post/unsent/drafts",
  // Reply composer: navigating here opens a composer TARGETED at a reply to the
  // given tweet id (shows "Replying to @handle"). CALIBRATED (issue #8): use the
  // in_reply_to query param; the reply text box is the SAME tweetTextarea_0 as a
  // normal post, and the save flow is the SAME close->Save confirmationSheet.
  replyComposeUrl: (tweetId: string) =>
    `https://x.com/compose/post?in_reply_to=${encodeURIComponent(tweetId)}`,

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

  // ---- Article rich-formatting controls (ALL NEED LIVE CALIBRATION) ----
  // X's Articles editor exposes a floating/inline formatting toolbar. The exact
  // hooks below are BEST-EFFORT guesses and MUST be recalibrated headfully
  // (`--inspect`): open the editor, select text, and read the toolbar buttons'
  // real data-testid / aria-label. Where a stable hook is unknown we fall back
  // to KEYBOARD SHORTCUTS in applyBlockFormat() (bold = Ctrl/Cmd+B), which is
  // the most drift-resistant path.
  articleToolbarBold: [
    '[data-testid="toolBarBold"]',
    'button[aria-label="Bold"]',
    '//button[@aria-label="Bold"]',
  ],
  // Heading buttons: X Articles has ~2 heading styles. Real testids UNKNOWN —
  // NEEDS LIVE CALIBRATION. We keep aria-label guesses and otherwise flatten.
  articleToolbarHeading1: [
    '[data-testid="toolBarHeading1"]',
    'button[aria-label="Heading 1"]',
    'button[aria-label="Big heading"]',
  ],
  articleToolbarHeading2: [
    '[data-testid="toolBarHeading2"]',
    'button[aria-label="Heading 2"]',
    'button[aria-label="Small heading"]',
  ],
  articleToolbarBullet: [
    '[data-testid="toolBarBulletedList"]',
    'button[aria-label="Bulleted list"]',
  ],
  articleToolbarOrdered: [
    '[data-testid="toolBarNumberedList"]',
    'button[aria-label="Numbered list"]',
  ],
  articleToolbarQuote: [
    '[data-testid="toolBarQuote"]',
    'button[aria-label="Quote"]',
  ],
  // Link: X shows a link button that opens a URL input. testids UNKNOWN.
  articleToolbarLink: [
    '[data-testid="toolBarLink"]',
    'button[aria-label="Link"]',
  ],
  articleLinkUrlInput: [
    'input[data-testid="linkUrlInput"]',
    'input[aria-label="URL"]',
    'input[type="url"]',
  ],
  articleLinkConfirm: [
    '[data-testid="linkConfirm"]',
    '//span[text()="Apply"]/ancestor::*[@role="button"][1]',
    '//span[text()="Done"]/ancestor::*[@role="button"][1]',
  ],

  // ---- Article hero / cover image (REQUIRED to publish; 5:2 ratio) ----
  // The cover-image control + hidden file <input>. testids are BEST-EFFORT and
  // NEED LIVE CALIBRATION. We prefer setting the file <input> directly (works
  // even when the visible button is a styled label), falling back to clicking a
  // labelled "Add cover"/"cover" control.
  articleCoverButton: [
    '[data-testid="articleCoverImageButton"]',
    'button[aria-label="Add cover"]',
    'button[aria-label="Add photo"]',
    '//span[contains(normalize-space(),"cover")]/ancestor::*[@role="button"][1]',
  ],
  articleCoverFileInput: [
    'input[data-testid="fileInput"]',
    'input[type="file"]',
  ],
  // The crop/apply dialog X shows after choosing a cover image. testids UNKNOWN.
  articleCoverApply: [
    '[data-testid="applyButton"]',
    '//span[text()="Apply"]/ancestor::*[@role="button"][1]',
    '//span[text()="Save"]/ancestor::*[@role="button"][1]',
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
export async function tolerantLocator(
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
export async function optionalLocator(
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
  /**
   * Absolute path to the canonical base markdown (--from). Used to locate the
   * article's `publish/<slug>/` asset folder for the required 5:2 hero image
   * (issue #5). Ignored for tweet/thread.
   */
  basePath?: string;
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
      return await stageArticleDraft(page, content, opts.basePath);
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

  await typePosts(page, posts);

  const saved = await saveAsDraft(page);
  // Verify the ACTUAL draft landed by matching the first post's leading text
  // (issue #4) — not just "a row exists".
  const verified = await verifyDraftSaved(page, posts[0]);

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
 * Type one or more posts into an ALREADY-OPEN composer: the first into
 * tweetTextarea_0, each subsequent one after clicking "Add another post".
 * Shared by the tweet/thread path and the reply path (issue #8) so the typing +
 * thread-append logic isn't duplicated. Does NOT save or post.
 */
async function typePosts(page: Page, posts: string[]): Promise<void> {
  const firstBox = await tolerantLocator(page, X_COMPOSER_SELECTORS.tweetTextbox, "tweet text box");
  await firstBox.click();
  await typeText(page, firstBox, posts[0]);

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
}

/** Result of staging a reply draft (issue #8). */
export interface StageReplyResult extends StageDraftResult {
  /** The tweet id we targeted the reply at. */
  replyToId: string;
}

export interface StageReplyOptions extends StageDraftOptions {}

/**
 * Extract a numeric tweet id from a full X/Twitter status URL or accept a raw
 * id. Throws on anything that isn't a plausible id. Deterministic + testable.
 * Accepts: https://x.com/user/status/123, https://twitter.com/.../status/123?s=..,
 * /i/web/status/123, or a bare "123".
 */
export function extractTweetId(input: string): string {
  const raw = input.trim();
  if (/^\d{5,25}$/.test(raw)) return raw;
  // status/<id> anywhere in the URL/path.
  const m = raw.match(/status(?:es)?\/(\d{5,25})/);
  if (m) return m[1];
  // Last-ditch: a long digit run in the string.
  const d = raw.match(/(\d{10,25})/);
  if (d) return d[1];
  throw new Error(
    `Could not extract a tweet id from "${input}". Pass a status URL ` +
      "(https://x.com/<user>/status/<id>) or a raw numeric id.",
  );
}

/**
 * Stage a REPLY to `toIdOrUrl` as a NATIVE DRAFT (issue #8). NEVER posts.
 *
 * CALIBRATED (issue #8): navigating to https://x.com/compose/post?in_reply_to=<id>
 * opens a reply-TARGETED composer ("Replying to @handle") whose text box is the
 * same [data-testid="tweetTextarea_0"], and the SAME close→Save confirmationSheet
 * saves it as a native draft (with the reply target preserved). This avoids the
 * permalink [data-testid="mask"] click-interception path.
 *
 * Uses the shared typePosts + saveAsDraft + verifyDraftSaved helpers so the reply
 * path is a thin addition over the tweet/thread path (default single reply;
 * threads supported if the generated content overflows into multiple posts).
 */
export async function stageReplyDraft(
  content: GeneratedContent,
  toIdOrUrl: string,
  opts: StageReplyOptions = {},
): Promise<StageReplyResult> {
  const replyToId = extractTweetId(toIdOrUrl);

  const posts =
    content.format === "thread"
      ? (content.thread ?? []).map((p) => p.text)
      : content.tweet
        ? [content.tweet.text]
        : [];
  if (posts.length === 0) throw new Error("No reply content to stage (empty tweet/thread).");

  const ctx = (await getBrowserContext({ inspect: opts.inspect, force: opts.force })) as BrowserContext;
  const page = await ctx.newPage();
  try {
    await page.goto(X_COMPOSER_SELECTORS.replyComposeUrl(replyToId), { waitUntil: "domcontentloaded" });

    // Sanity: confirm the reply-targeted composer opened. Best-effort — the
    // "Replying to" banner selector is not centralized because the textbox is
    // the real gate; if it's present, we can type.
    const box = await optionalLocator(page, X_COMPOSER_SELECTORS.tweetTextbox, 10_000);
    if (!box) {
      throw new Error(
        "Reply composer text box never appeared for in_reply_to=" +
          `${replyToId} (selector drift, deleted/protected tweet, or not logged in; ` +
          "re-run with --inspect). NEEDS LIVE CALIBRATION if the DOM changed.",
      );
    }

    await typePosts(page, posts);

    const saved = await saveAsDraft(page);
    const verified = await verifyDraftSaved(page, posts[0]);

    return {
      format: content.format,
      posts: posts.length,
      verified,
      replyToId,
      note: saved
        ? `Reply to ${replyToId} saved via ${saved}. It's a NATIVE draft under X "Unsent" ` +
          "(reply target preserved) — review and post manually."
        : `Attempted to save the reply to ${replyToId} as a draft (path uncertain — NEEDS ` +
          'CALIBRATION). Check X "Unsent"/Drafts manually.',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Article (issue #5): open the Articles editor, set the title field, then build
 * the body from STRUCTURED BLOCKS applying REAL editor formatting (headings /
 * bold / lists / links / quotes) rather than typing literal markdown chars, and
 * attach the REQUIRED 5:2 hero image. Leaves it unsent (Articles autosave).
 * NEVER clicks Publish.
 *
 * DETERMINISTIC parts (fully implemented, verifiable): block/heading/inline
 * parsing lives in content.ts; hero-image discovery + 5:2 ratio validation here.
 *
 * BROWSER-INTERACTION parts (BEST-EFFORT, marked "NEEDS LIVE CALIBRATION"):
 * applying toolbar styles and uploading/cropping the cover depend on the live
 * editor DOM, which cannot be exercised at build time. Every such step is
 * centralized in X_COMPOSER_SELECTORS and degrades gracefully (falls back to
 * plain typed text / records a note) instead of clicking anything destructive.
 */
async function stageArticleDraft(
  page: Page,
  content: GeneratedContent,
  basePath?: string,
): Promise<StageDraftResult> {
  if (!content.article) throw new Error("No article content to stage.");
  const notes: string[] = [];

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

  // Build the body block-by-block with REAL formatting (issue #5 req 1 & 2).
  await typeArticleBlocks(page, bodyBox, content.article.blocks, notes);

  // Attach the REQUIRED 5:2 hero image (issue #5 req 3).
  const hero = resolveHeroImage(basePath);
  if (!hero.path) {
    notes.push(
      "HERO IMAGE MISSING: X requires a 5:2 cover image to publish. " +
        (hero.reason ?? "No suitable image found near the base markdown.") +
        " Add a 5:2 image (e.g. hero.jpg / cover.png) in the article's publish/<slug>/ folder.",
    );
  } else if (!hero.ratioOk) {
    notes.push(
      `HERO IMAGE RATIO: found ${hero.path} at ${hero.width}x${hero.height} ` +
        `(ratio ${hero.ratio?.toFixed(3)}), but X requires 5:2 (2.5). ` +
        "NEEDS LIVE CALIBRATION: no image lib is bundled, so cropping/resizing to 5:2 " +
        "is NOT performed automatically — pre-crop the image to 5:2, or add an image " +
        "lib (e.g. sharp) to package.json and wire cropping in resolveHeroImage().",
    );
  } else {
    const uploaded = await uploadHeroImage(page, hero.path, notes);
    if (uploaded) notes.push(`Hero image uploaded from ${hero.path} (5:2, ${hero.width}x${hero.height}).`);
  }

  // Articles autosave as drafts; give autosave a moment. Being in the editor with
  // an article id in the URL is our verification that a draft now exists.
  await page.waitForTimeout(2_500);
  const verified = /\/compose\/articles\/edit\/\d+/.test(page.url());

  return {
    format: "article",
    posts: 1,
    verified,
    note:
      "Article staged in the X Articles editor with structured rich formatting " +
      "(headings/bold/lists/links applied via editor, not literal markdown). " +
      "X autosaves Article drafts under Articles → Drafts; review + publish manually. " +
      "NEVER auto-published." +
      (notes.length ? `\n  - ${notes.join("\n  - ")}` : ""),
  };
}

/**
 * Type the article body block-by-block, applying REAL editor formatting.
 *
 * Strategy per block (BEST-EFFORT; the toolbar hooks NEED LIVE CALIBRATION):
 *   - Type the block's plain text (bold/link marks applied inline where possible).
 *   - Apply a block-level style (heading/list/quote) via the toolbar, else fall
 *     back to a keyboard shortcut, else leave as plain text and record a note.
 *   - Press Enter to start the next block (and reset the style for the next one).
 *
 * We NEVER inject literal `##`/`**` characters. If a formatting control can't be
 * found, the text still lands correctly — only the styling degrades, so the
 * draft is never corrupted. Code blocks are flagged (screenshot), consistent
 * with the tweet/thread handling.
 */
async function typeArticleBlocks(
  page: Page,
  bodyBox: Locator,
  blocks: ArticleBlock[],
  notes: string[],
): Promise<void> {
  let styleWarned = false;
  const warnStyle = (what: string) => {
    if (styleWarned) return;
    styleWarned = true;
    notes.push(
      `RICH FORMATTING (NEEDS LIVE CALIBRATION): could not find the "${what}" toolbar ` +
        "control; that block was left as plain text. Recalibrate the articleToolbar* " +
        "selectors headfully (--inspect) — read the editor toolbar's real testids.",
    );
  };

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    await bodyBox.focus();

    if (block.kind === "code") {
      notes.push(
        `CODE BLOCK #${block.index}${block.lang ? ` [${block.lang}]` : ""}: X can't render ` +
          "code — a screenshot/image must be pasted here manually (flagged, not typed).",
      );
      // Leave a visible placeholder line so the human sees where it goes.
      await typeRuns(page, [{ text: `[code block #${block.index} → paste screenshot]` }]);
      await page.keyboard.press("Enter");
      continue;
    }

    // Type the inline content with bold/italic/link marks applied as we go.
    await typeRuns(page, block.runs);

    // Apply a block-level style AFTER the text exists (select the line, click the
    // toolbar style). Selecting the current line: Home then Shift+End.
    const selectLine = async () => {
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+End");
    };

    if (block.kind === "heading") {
      await selectLine();
      const sel =
        block.level === 1
          ? X_COMPOSER_SELECTORS.articleToolbarHeading1
          : X_COMPOSER_SELECTORS.articleToolbarHeading2;
      const btn = await optionalLocator(page, sel, 2_500);
      if (btn) await btn.click();
      else warnStyle(`heading ${block.level}`);
      await page.keyboard.press("End");
    } else if (block.kind === "subheading") {
      // H3+ flattened to a BOLD lead-in (issue #5 req 2): bold the whole line.
      await selectLine();
      await applyBold(page);
      await page.keyboard.press("End");
    } else if (block.kind === "bullet" || block.kind === "ordered") {
      await selectLine();
      const sel =
        block.kind === "bullet"
          ? X_COMPOSER_SELECTORS.articleToolbarBullet
          : X_COMPOSER_SELECTORS.articleToolbarOrdered;
      const btn = await optionalLocator(page, sel, 2_500);
      if (btn) await btn.click();
      else warnStyle(block.kind === "bullet" ? "bulleted list" : "numbered list");
      await page.keyboard.press("End");
    } else if (block.kind === "quote") {
      await selectLine();
      const btn = await optionalLocator(page, X_COMPOSER_SELECTORS.articleToolbarQuote, 2_500);
      if (btn) await btn.click();
      else warnStyle("quote");
      await page.keyboard.press("End");
    }

    // Next block on a new line (Enter typically also exits a heading/list style).
    if (bi < blocks.length - 1) await page.keyboard.press("Enter");
  }
}

/**
 * Type a sequence of inline runs, applying bold (toggle Ctrl/Cmd+B) and real
 * hyperlinks (via the link toolbar) as REAL formatting. Italic maps to Cmd/Ctrl+I.
 * Inline `code` has no X Articles equivalent — typed as plain text.
 *
 * Bold/italic use keyboard shortcuts (drift-resistant). Links use the toolbar
 * (NEEDS LIVE CALIBRATION); if the link control isn't found we type the visible
 * text and record a note rather than inject a raw URL into prose.
 */
async function typeRuns(page: Page, runs: InlineRun[]): Promise<void> {
  for (const run of runs) {
    if (!run.text) continue;
    if (run.href) {
      // Type the visible label, select it, then apply a real hyperlink.
      await page.keyboard.insertText(run.text);
      // Select the just-typed label: Shift+Left * len (code points).
      const len = [...run.text].length;
      for (let i = 0; i < len; i++) await page.keyboard.press("Shift+ArrowLeft");
      await applyLink(page, run.href);
      // Collapse selection to the end so subsequent text appends after the link.
      await page.keyboard.press("ArrowRight");
      continue;
    }
    // Toggle marks ON, type, then toggle them back OFF so they don't bleed into
    // the next run. Bold = Cmd/Ctrl+B, Italic = Cmd/Ctrl+I (drift-resistant).
    const toggleMarks = async () => {
      if (!run.bold && !run.italic) return;
      await page.keyboard.down(modifier());
      if (run.bold) await page.keyboard.press("KeyB");
      if (run.italic) await page.keyboard.press("KeyI");
      await page.keyboard.up(modifier());
    };
    await toggleMarks();
    await page.keyboard.insertText(run.text);
    await toggleMarks();
    await page.waitForTimeout(30);
  }
}

function modifier(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control";
}

/** Bold the current selection via the standard rich-text shortcut. */
async function applyBold(page: Page): Promise<void> {
  await page.keyboard.press(`${modifier()}+KeyB`);
}

/**
 * Apply a real hyperlink to the current selection. Opens the editor's link
 * control, fills the URL, confirms. NEEDS LIVE CALIBRATION (link toolbar +
 * URL-input + confirm testids are unknown). If the control isn't found the
 * label text is left as-is (no raw URL injected).
 */
async function applyLink(page: Page, href: string): Promise<void> {
  const linkBtn = await optionalLocator(page, X_COMPOSER_SELECTORS.articleToolbarLink, 2_000);
  if (!linkBtn) return; // degrade: keep the label text as plain text
  await linkBtn.click();
  const urlInput = await optionalLocator(page, X_COMPOSER_SELECTORS.articleLinkUrlInput, 2_000);
  if (!urlInput) return;
  await urlInput.fill(href);
  const confirm = await optionalLocator(page, X_COMPOSER_SELECTORS.articleLinkConfirm, 2_000);
  if (confirm) await confirm.click();
  else await page.keyboard.press("Enter");
}

// ---------------------------------------------------------------------------
// Hero image (5:2) — DETERMINISTIC discovery + ratio validation
// ---------------------------------------------------------------------------

interface HeroImage {
  path?: string;
  width?: number;
  height?: number;
  ratio?: number;
  ratioOk?: boolean;
  reason?: string;
}

const HERO_RATIO = 5 / 2; // 2.5
const HERO_RATIO_TOL = 0.02; // allow tiny rounding drift
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
// Prefer explicitly-named hero/cover assets when present.
const HERO_NAME_HINTS = ["hero", "cover", "banner", "og", "5x2", "5-2"];

/**
 * Locate a hero image next to the article's base markdown (its publish/<slug>/
 * folder), preferring names hinting at a cover, and validate the 5:2 ratio by
 * reading the image header (no image lib needed for common formats).
 *
 * Returns a HeroImage describing what was found. Deterministic + verifiable.
 */
function resolveHeroImage(basePath?: string): HeroImage {
  if (!basePath) return { reason: "No base path was provided to locate the article asset folder." };
  const dir = dirname(basePath);
  if (!existsSync(dir)) return { reason: `Article folder not found: ${dir}` };

  let candidates: string[];
  try {
    candidates = readdirSync(dir)
      .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
      .map((f) => join(dir, f))
      .filter((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });
  } catch (err) {
    return { reason: `Could not read article folder ${dir}: ${(err as Error).message}` };
  }
  if (candidates.length === 0) return { reason: `No image files in ${dir}.` };

  // Rank: named-hint images first, then by best 5:2 fit.
  const scored = candidates
    .map((p) => {
      const dims = readImageSize(p);
      const ratio = dims ? dims.width / dims.height : undefined;
      const named = HERO_NAME_HINTS.some((h) => p.toLowerCase().includes(h));
      const ratioOk = ratio !== undefined && Math.abs(ratio - HERO_RATIO) <= HERO_RATIO_TOL;
      return { p, dims, ratio, named, ratioOk };
    })
    .sort((a, b) => {
      if (a.ratioOk !== b.ratioOk) return a.ratioOk ? -1 : 1;
      if (a.named !== b.named) return a.named ? -1 : 1;
      const da = a.ratio === undefined ? Infinity : Math.abs(a.ratio - HERO_RATIO);
      const db = b.ratio === undefined ? Infinity : Math.abs(b.ratio - HERO_RATIO);
      return da - db;
    });

  const best = scored[0];
  if (!best.dims) {
    return {
      path: best.p,
      reason: `Could not read image dimensions for ${best.p} (unsupported header).`,
    };
  }
  return {
    path: best.p,
    width: best.dims.width,
    height: best.dims.height,
    ratio: best.ratio,
    ratioOk: best.ratioOk,
  };
}

/**
 * Read image pixel dimensions from the file header for PNG / JPEG / WEBP without
 * an image library. Returns null if the format/header can't be parsed.
 */
function readImageSize(path: string): { width: number; height: number } | null {
  let buf: Buffer;
  try {
    // Read enough bytes to cover PNG IHDR / JPEG SOF / WEBP VP8 headers.
    const fd = openSync(path, "r");
    buf = Buffer.alloc(65_536);
    const read = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    buf = buf.subarray(0, read);
  } catch {
    return null;
  }
  // PNG: 8-byte sig, then IHDR (width @16, height @20, big-endian).
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan SOF0..SOF3/5..7/9..11/13..15 markers.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      const len = buf.readUInt16BE(off + 2);
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }
  // WEBP: RIFF....WEBP; VP8X/VP8L/VP8 variants.
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const fmt = buf.toString("ascii", 12, 16);
    if (fmt === "VP8X") {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h };
    }
    if (fmt === "VP8 ") {
      const w = buf.readUInt16LE(26) & 0x3fff;
      const h = buf.readUInt16LE(28) & 0x3fff;
      return { width: w, height: h };
    }
    if (fmt === "VP8L") {
      const b = buf.readUInt32LE(21);
      const w = (b & 0x3fff) + 1;
      const h = ((b >> 14) & 0x3fff) + 1;
      return { width: w, height: h };
    }
  }
  return null;
}

/**
 * Upload the (already 5:2-validated) hero image via the editor's cover control.
 *
 * NEEDS LIVE CALIBRATION: the cover button / hidden file input / crop-apply
 * dialog testids are best-effort. We prefer setting the file <input> directly
 * (works for styled labels), then click through any crop/apply dialog with the
 * 5:2 default. Since the source is already 5:2, no in-browser cropping is needed.
 * Returns true if we found a control to attach to; false (with a note) otherwise.
 */
async function uploadHeroImage(page: Page, imagePath: string, notes: string[]): Promise<boolean> {
  // Try the hidden file input first (most reliable for styled upload buttons).
  const fileInput = await optionalLocator(page, X_COMPOSER_SELECTORS.articleCoverFileInput, 2_500);
  if (fileInput) {
    try {
      await fileInput.setInputFiles(imagePath);
    } catch (err) {
      notes.push(`HERO UPLOAD (NEEDS LIVE CALIBRATION): setInputFiles failed: ${(err as Error).message}`);
      return false;
    }
  } else {
    // Fall back to clicking a labelled cover button that opens a file chooser.
    const coverBtn = await optionalLocator(page, X_COMPOSER_SELECTORS.articleCoverButton, 2_500);
    if (!coverBtn) {
      notes.push(
        "HERO UPLOAD (NEEDS LIVE CALIBRATION): could not find the cover-image control " +
          "(articleCoverButton / articleCoverFileInput). Recalibrate headfully (--inspect) " +
          "and attach the 5:2 image manually for now.",
      );
      return false;
    }
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 5_000 }),
        coverBtn.click(),
      ]);
      await chooser.setFiles(imagePath);
    } catch (err) {
      notes.push(`HERO UPLOAD (NEEDS LIVE CALIBRATION): file chooser flow failed: ${(err as Error).message}`);
      return false;
    }
  }

  // Confirm any crop/apply dialog (image already 5:2, so accept the default).
  await page.waitForTimeout(1_000);
  const apply = await optionalLocator(page, X_COMPOSER_SELECTORS.articleCoverApply, 3_000);
  if (apply) {
    await apply.click();
    await page.waitForTimeout(750);
  } else {
    notes.push(
      "HERO CROP (NEEDS LIVE CALIBRATION): no crop/apply dialog matched articleCoverApply — " +
        "if X shows a cropper, confirm the 5:2 crop manually.",
    );
  }
  return true;
}

/** Type into a contenteditable composer box reliably (clear-then-type). */
export async function typeText(page: Page, box: Locator, text: string): Promise<void> {
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
export async function saveAsDraft(page: Page): Promise<string | null> {
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
 * Verify a draft was ACTUALLY saved (issue #4).
 *
 * Previously this opened a composer, clicked "Drafts", and matched ANY
 * `div[data-testid="cellInnerDiv"]` — but that selector ALSO matches the home
 * timeline rendered behind the composer modal, so it false-positived.
 *
 * Hardened path (CALIBRATED, issue #4):
 *   - Navigate to the REAL drafts view https://x.com/compose/post/unsent/drafts
 *     (the bare /compose/post/unsent route errors; the /drafts route works).
 *   - Prove OUR draft exists by matching the STAGED CONTENT's leading text
 *     inside a drafts row — not merely "some row exists".
 *
 * `expectedText` should be the leading text of what we just staged (e.g. the
 * first post / reply body). When provided, verification requires that text to
 * appear. When omitted, we fall back to "at least one drafts row exists" but
 * scoped to the drafts URL (still stronger than the old any-cellInnerDiv check).
 * Non-fatal — returns false (never throws) if inconclusive.
 */
async function verifyDraftSaved(page: Page, expectedText?: string): Promise<boolean> {
  try {
    await page.goto(X_COMPOSER_SELECTORS.draftsUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_500);

    // Scope to drafts rows on this dedicated surface. Because we're on the
    // /drafts URL (not a composer over the timeline), cellInnerDiv here is the
    // drafts list, not the background feed.
    const rows = page.locator('div[data-testid="cellInnerDiv"], article[data-testid="tweet"]');

    if (expectedText && expectedText.trim()) {
      // Match on a leading, stable slice of the staged text (drafts rows may
      // truncate long bodies with an ellipsis, so compare a short prefix).
      const needle = normalizeForMatch(expectedText).slice(0, 60);
      if (!needle) return (await rows.count()) > 0;
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        const count = await rows.count();
        for (let i = 0; i < count; i++) {
          const hay = normalizeForMatch((await rows.nth(i).innerText().catch(() => "")) || "");
          if (hay.includes(needle)) return true;
        }
        await page.waitForTimeout(500);
      }
      return false;
    }

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

/** Normalize whitespace/case for tolerant text matching in the drafts list. */
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

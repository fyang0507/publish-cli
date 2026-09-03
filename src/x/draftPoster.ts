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
 *   waits. Run `publish x draft ... --inspect` (headful) to watch the flow and
 *   recalibrate. Comments below mark exactly which selectors are most fragile.
 *
 * The session module is the SINGLE authenticator — we never log in here; we only
 * borrow its persistent context.
 */

import type { BrowserContext, Page, Locator } from "playwright";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { getBrowserContext, type EnsureSessionOptions } from "../session.js";
import type { ArticleBlock, GeneratedContent, InlineRun } from "./content.js";
import {
  extractTweetId,
  isLivePositiveXArticleCoverPath,
  X_PREMIUM_POST_PLATFORM_MAX_LENGTH,
} from "../capabilities/validation.js";
import {
  isPositiveXDraftRowEvidence,
  runXDraftSaveFlow,
  snapshotXArticleDraftHandoff,
  snapshotXDraftRowEvidence,
  X_ARTICLE_CODE_BLOCK_COUNT_LIMIT,
  X_ARTICLE_IMAGE_DIMENSION_LIMIT,
  X_DRAFT_ROW_OBSERVATION_LIMIT,
  XDraftStageError,
  xDraftStageError,
  xDraftRowEvidenceNotApplicable,
  type XArticleCoverHandoff,
  type XArticleDraftHandoff,
  type XDraftRowEvidence,
  type XDraftRowEvidenceUnverified,
  type XDraftRowObservation,
  type XDraftReturnedSavePhase,
  type XDraftSaveMechanism,
} from "./saveProgress.js";

// Preserve the existing public import while keeping parsing in a browser-free module.
export { extractTweetId } from "../capabilities/validation.js";

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
  // lists the saved Unsent drafts. Issue #89 live-calibrated a unique aria-modal
  // drafts container with native unsentTweet rows and row-scoped tweetText.
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

  // NOTE: the old guessed rich-formatting toolbar/link selectors
  // (articleToolbar* / articleLink*) were REMOVED in the paste-based rewrite
  // (issue #5). The editor accepts rich HTML paste and converts it natively
  // (h1/h2/p/ul/ol/blockquote/a/strong/em/s), so we no longer drive a toolbar.

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

interface StageDraftResultBase {
  format: GeneratedContent["format"];
  /** Number of composer rows typed (1 for tweet/article, N for a thread). */
  posts: number;
  /** Compatibility diagnostic only; command receipts must not render this open prose. */
  note: string;
  /** Native action whose delivery/persistence phase the result describes. */
  saveMechanism: XDraftSaveMechanism;
}

/**
 * A returned result always proves Save returned. Composer verification is a
 * closed phase/evidence pair; Articles deliberately carry no Unsent-row fact.
 */
export type StageDraftResult = StageDraftResultBase & (
  | {
      saveMechanism: "composer_close_save";
      savePhase: "verified";
      draftRowEvidence: Extract<XDraftRowEvidence, { status: "verified" }>;
    }
  | {
      saveMechanism: "composer_close_save";
      savePhase: "save_delivered_unverified";
      draftRowEvidence: Extract<XDraftRowEvidence, { status: "unverified" }>;
    }
  | {
      saveMechanism: "article_create_autosave";
      savePhase: XDraftReturnedSavePhase;
      draftRowEvidence: Extract<XDraftRowEvidence, { status: "not_applicable" }>;
      articleHandoff: XArticleDraftHandoff;
    }
);

/**
 * Stage `content` as a NATIVE DRAFT on X using the persistent logged-in profile.
 * NEVER posts. Composer success requires closed, scoped Unsent-row evidence;
 * Article success retains its separate canonical edit-URL observation.
 */
export async function stageDraft(
  content: GeneratedContent,
  opts: StageDraftOptions = {},
): Promise<StageDraftResult> {
  const mechanism = content.format === "article"
    ? "article_create_autosave"
    : "composer_close_save";
  try {
    const ctx = (await getBrowserContext({ inspect: opts.inspect, force: opts.force })) as BrowserContext;
    const page = await ctx.newPage();
    try {
      if (content.format === "article") {
        return await stageArticleDraft(ctx, page, content, opts.basePath);
      }
      return await stageTweetOrThreadDraft(page, content);
    } finally {
      // Close only the page we opened; leave the persistent context alive so the
      // session stays warm for subsequent commands.
      await page.close().catch(() => {});
    }
  } catch (error) {
    throw xDraftStageError(error, "save_not_attempted", mechanism);
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

  // Read-only baseline on the same page/context. Failure is retained as
  // unverified evidence and never prevents the later Save attempt.
  const baseline = await captureDraftRowBaseline(page, posts[0]);
  await page.goto(X_COMPOSER_SELECTORS.composeUrl, { waitUntil: "domcontentloaded" });

  await typePosts(page, posts);

  const saved = await saveAsDraft(
    page,
    () => verifyDraftSaved(page, posts[0], baseline),
  );

  return saved.savePhase === "verified"
    ? {
        format: content.format,
        posts: posts.length,
        saveMechanism: "composer_close_save",
        savePhase: "verified",
        draftRowEvidence: saved.draftRowEvidence,
        note: `Saved via ${saved.value}. Full intended ${content.format === "thread" ? "first thread-row" : "tweet"} text was observed in one calibrated X Unsent row; review every row and post manually.`,
      }
    : {
        format: content.format,
        posts: posts.length,
        saveMechanism: "composer_close_save",
        savePhase: "save_delivered_unverified",
        draftRowEvidence: saved.draftRowEvidence,
        note: `Save returned via ${saved.value}, but scoped X Unsent row evidence remained unverified.`,
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
export type StageReplyResult = StageDraftResult & {
  /** The tweet id we targeted the reply at. */
  replyToId: string;
};

export interface StageReplyOptions extends StageDraftOptions {}

/**
 * Stage a REPLY to `toIdOrUrl` as a NATIVE DRAFT (issue #8). NEVER posts.
 *
 * CALIBRATED (issue #8): navigating to https://x.com/compose/post?in_reply_to=<id>
 * opens a reply-requested composer ("Replying to @handle") whose text box is the
 * same [data-testid="tweetTextarea_0"], and the SAME close→Save confirmationSheet
 * saves its text as a native draft. Reopening Unsent/Drafts currently observes
 * text persistence only; it does not verify the saved draft's reply-target
 * binding. This avoids the permalink [data-testid="mask"] click-interception path.
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
  try {
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
      const baseline = await captureDraftRowBaseline(page, posts[0]);
      await page.goto(X_COMPOSER_SELECTORS.replyComposeUrl(replyToId), { waitUntil: "domcontentloaded" });

      // Sanity: confirm a composer text box opened for the requested URL. This
      // does not prove its reply-target binding; it is only the pre-Save gate.
      const box = await optionalLocator(page, X_COMPOSER_SELECTORS.tweetTextbox, 10_000);
      if (!box) throw new Error("Reply composer unavailable before Save.");

      await typePosts(page, posts);

      const saved = await saveAsDraft(
        page,
        () => verifyDraftSaved(page, posts[0], baseline),
      );

      return saved.savePhase === "verified"
        ? {
            format: content.format,
            posts: posts.length,
            saveMechanism: "composer_close_save",
            savePhase: "verified",
            draftRowEvidence: saved.draftRowEvidence,
            replyToId,
            note: `The full intended ${content.format === "thread" ? "first reply-thread row" : "reply"} text was observed in one calibrated X Unsent row after ${saved.value}; ` +
              `requested target ${replyToId} was supplied to the composer, but the saved draft's reply-target binding was not verified. Review both manually before posting.`,
          }
        : {
            format: content.format,
            posts: posts.length,
            saveMechanism: "composer_close_save",
            savePhase: "save_delivered_unverified",
            draftRowEvidence: saved.draftRowEvidence,
            replyToId,
            note: `Save returned after staging was requested for target ${replyToId}, but scoped row persistence evidence and the saved draft's reply-target binding were not verified in X "Unsent"/Drafts.`,
          };
    } finally {
      await page.close().catch(() => {});
    }
  } catch (error) {
    throw xDraftStageError(error, "save_not_attempted", "composer_close_save");
  }
}

/**
 * Article (issue #5): PASTE-BASED renderer. The X Articles editor accepts rich
 * HTML paste and converts it natively (VERIFIED empirically 2026-06):
 *   <h1>→Heading, <h2>→Subheading, <p>→paragraph, <ul>/<ol><li>→lists,
 *   <blockquote>→quote, <a href>→link, inline <strong>/<em>/<s>→bold/italic/strike.
 * The ONLY thing paste does NOT convert is code blocks (they land as plain text),
 * so those are EXCLUDED from the paste and surfaced through the closed Article
 * handoff facts instead.
 *
 * Flow: open the hub → click create → wait for the title input → type the title →
 * build an HTML fragment from the structured blocks → write it to the clipboard
 * in-page (text/html + text/plain fallback) → focus the body composer → paste
 * (Meta+V / Ctrl+V) → let the editor convert. Then best-effort attach the 5:2
 * hero image. Leaves it unsent (Articles autosave). NEVER clicks Publish.
 *
 * DETERMINISTIC parts (fully implemented, verifiable at build time): block/inline
 * parsing (content.ts), HTML rendering (htmlFromArticleBlocks), and optional
 * cover discovery + ratio inspection (resolveHeroImage).
 *
 * BROWSER-INTERACTION part still needing live calibration: the 5:2 HERO IMAGE
 * upload (articleCover* selectors + crop/apply dialog) — degrades gracefully.
 */
type GeneratedArticle = NonNullable<GeneratedContent["article"]>;

export interface ArticleDraftStageDependencies {
  openHub(page: Page): Promise<void>;
  locateCreate(page: Page): Promise<Locator | null>;
  currentEditUrl(page: Page): string | null;
  locateTitle(page: Page): Promise<Locator | null>;
  writeTitle(page: Page, title: Locator, value: string): Promise<void>;
  locateBody(page: Page): Promise<Locator | null>;
  writeBody(
    ctx: BrowserContext,
    page: Page,
    body: Locator,
    html: string,
    plain: string,
  ): Promise<void>;
  stageCover(page: Page, basePath: string | undefined): Promise<XArticleCoverHandoff>;
  settle(page: Page): Promise<void>;
  verify(
    page: Page,
    editUrl: string,
    expectedTitle: string,
    expectedBody: string,
  ): Promise<boolean>;
}

export async function stageArticleDraft(
  ctx: BrowserContext,
  page: Page,
  content: GeneratedContent,
  basePath?: string,
  deps: ArticleDraftStageDependencies = productionArticleDraftStageDependencies,
): Promise<StageDraftResult> {
  const article = content.article;
  if (!article) throw new Error("No article content to stage.");
  let createBtn: Locator | undefined;

  const saved = await runXDraftSaveFlow("article_create_autosave", {
    async beforeSave() {
      // articleComposeUrl is the Articles HUB, not the editor. Opening it and
      // locating Create cannot allocate a native draft.
      await deps.openHub(page);
      const candidate = await deps.locateCreate(page);
      if (!candidate) throw new Error("Article create control unavailable.");
      createBtn = candidate;
    },
    async deliverSave() {
      // Create is the first Article action that may allocate an autosaved draft.
      if (!createBtn) throw new Error("Article create control was not prepared.");
      await createBtn.click();
    },
    async afterSave() {
      // Every failure after Create returned is conservatively classified as a
      // delivered-but-unverified autosave outcome by runXDraftSaveFlow.
      const titleBox = await deps.locateTitle(page);
      if (!titleBox) throw new Error("Article editor unavailable after Create.");
      const editUrl = deps.currentEditUrl(page);

      await deps.writeTitle(page, titleBox, article.title);

      const bodyBox = await deps.locateBody(page);
      if (!bodyBox) throw new Error("Article body input unavailable after Create.");

      // Build the body as an HTML fragment the editor converts natively on paste
      // (issue #5). Code blocks are excluded and counted for the closed handoff.
      const { html, codeBlockCount } = htmlFromArticleBlocks(article.blocks);
      const plainFallback = plainTextFromArticleBlocks(article.blocks);

      await deps.writeBody(ctx, page, bodyBox, html, plainFallback);

      // Attach an optional auto-discovered cover. The live-positive set includes
      // exact 5:2 and 1500x620; every tested image opened crop/edit and required
      // Apply, so ratio is advisory and never a local rejection.
      const cover = await deps.stageCover(page, basePath);

      // Let autosave settle, then independently reload the captured edit URL and
      // match the intended title/body. Merely remaining on /edit/<id> is not
      // persistence evidence.
      await deps.settle(page);
      const verified = editUrl !== null && await deps.verify(
        page,
        editUrl,
        article.title,
        plainFallback,
      );
      return {
        verified,
        value: {
          body: "rich_html" as const,
          codeBlockCount: codeBlockCount > X_ARTICLE_CODE_BLOCK_COUNT_LIMIT
            ? "many" as const
            : codeBlockCount,
          cover,
        },
      };
    },
  });

  const articleHandoff = snapshotXArticleDraftHandoff(saved.value);
  if (!articleHandoff) {
    // This is after Create returned; a malformed internal handoff cannot safely
    // become a successful command receipt.
    throw new XDraftStageError("save_delivered_unverified", "article_create_autosave");
  }

  return {
    format: "article",
    posts: 1,
    saveMechanism: "article_create_autosave",
    savePhase: saved.savePhase,
    draftRowEvidence: xDraftRowEvidenceNotApplicable(),
    articleHandoff,
    note: "Closed Article review facts are available in articleHandoff.",
  };
}

export async function stageArticleCover(
  page: Page,
  basePath: string | undefined,
): Promise<XArticleCoverHandoff> {
  const hero = resolveHeroImage(basePath);
  if (!hero.path) {
    return {
      status: "missing",
      ratio: "not_observed",
      width: null,
      height: null,
      crop: "not_observed",
    };
  }
  const dimensions = Number.isInteger(hero.width) && Number.isInteger(hero.height) &&
      (hero.width as number) > 0 && (hero.height as number) > 0 &&
      (hero.width as number) <= X_ARTICLE_IMAGE_DIMENSION_LIMIT &&
      (hero.height as number) <= X_ARTICLE_IMAGE_DIMENSION_LIMIT
    ? { width: hero.width as number, height: hero.height as number }
    : { width: null, height: null };
  const upload = await uploadHeroImage(page, hero.path);
  if (dimensions.width === null) {
    return upload.status === "attached"
      ? { ...upload, ratio: "unknown", width: null, height: null }
      : {
          status: "upload_incomplete",
          ratio: "unknown",
          width: null,
          height: null,
          crop: "not_observed",
        };
  }
  const ratio = hero.ratioOk ? "within_5_2" as const : "outside_5_2" as const;
  return upload.status === "attached"
    ? { ...upload, ratio, ...dimensions }
    : {
        status: "upload_incomplete",
        ratio,
        ...dimensions,
        crop: "not_observed",
      };
}

const productionArticleDraftStageDependencies: ArticleDraftStageDependencies = {
  async openHub(page) {
    await page.goto(X_COMPOSER_SELECTORS.articleComposeUrl, { waitUntil: "domcontentloaded" });
  },
  locateCreate(page) {
    return optionalLocator(page, X_COMPOSER_SELECTORS.articleCreateButton, 8_000);
  },
  currentEditUrl(page) {
    return validatedArticleEditUrl(page.url());
  },
  locateTitle(page) {
    return optionalLocator(page, X_COMPOSER_SELECTORS.articleTitleInput, 12_000);
  },
  async writeTitle(page, title, value) {
    await title.click();
    await typeText(page, title, value);
  },
  locateBody(page) {
    return optionalLocator(page, X_COMPOSER_SELECTORS.articleBodyInput, 12_000);
  },
  async writeBody(ctx, page, body, html, plain) {
    await ctx
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://x.com" })
      .catch(() => {});
    await body.click();
    await body.focus();
    await page.evaluate(
      async ({ html: renderedHtml, plain: renderedPlain }) => {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([renderedHtml], { type: "text/html" }),
            "text/plain": new Blob([renderedPlain], { type: "text/plain" }),
          }),
        ]);
      },
      { html, plain },
    );
    await page.keyboard.press(`${modifier()}+KeyV`);
    await page.waitForTimeout(1_000);
  },
  stageCover: stageArticleCover,
  async settle(page) {
    await page.waitForTimeout(2_500);
  },
  verify: verifyArticleDraftSaved,
};

function validatedArticleEditUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "x.com" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      !/^\/compose\/articles\/edit\/\d+$/.test(parsed.pathname)
    ) return null;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function isExactArticleEditRoute(page: Page, editUrl: string): boolean {
  if (validatedArticleEditUrl(editUrl) !== editUrl) return false;
  try {
    return new URL(page.url()).href === editUrl;
  } catch {
    return false;
  }
}

type ArticleTextObservation =
  | { routeExact: true; text: string }
  | { routeExact: false };

async function locatorTextAtExactArticleRoute(
  page: Page,
  locator: Locator,
  editUrl: string,
): Promise<ArticleTextObservation> {
  if (!isExactArticleEditRoute(page, editUrl)) return { routeExact: false };
  try {
    const text = await locator.inputValue();
    if (!isExactArticleEditRoute(page, editUrl)) return { routeExact: false };
    return { routeExact: true, text };
  } catch {
    if (!isExactArticleEditRoute(page, editUrl)) return { routeExact: false };
    const text = await locator.innerText();
    if (!isExactArticleEditRoute(page, editUrl)) return { routeExact: false };
    return { routeExact: true, text };
  }
}

/** Existing tolerant Article title/body-prefix normalization (issue #82). */
function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function verifyArticleDraftSaved(
  page: Page,
  editUrl: string,
  expectedTitle: string,
  expectedBody: string,
): Promise<boolean> {
  await page.goto(editUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_500);
  if (!isExactArticleEditRoute(page, editUrl)) return false;
  const title = await optionalLocator(page, X_COMPOSER_SELECTORS.articleTitleInput, 8_000);
  if (!isExactArticleEditRoute(page, editUrl) || !title) return false;

  if (!isExactArticleEditRoute(page, editUrl)) return false;
  const body = await optionalLocator(page, X_COMPOSER_SELECTORS.articleBodyInput, 8_000);
  if (!isExactArticleEditRoute(page, editUrl) || !body) return false;

  const expectedTitleText = normalizeForMatch(expectedTitle);
  const expectedBodyPrefix = normalizeForMatch(expectedBody).slice(0, 40);
  if (!expectedTitleText) return false;

  const titleObservation = await locatorTextAtExactArticleRoute(page, title, editUrl);
  if (!titleObservation.routeExact) return false;
  const actualTitle = normalizeForMatch(titleObservation.text);

  const bodyObservation = await locatorTextAtExactArticleRoute(page, body, editUrl);
  if (!bodyObservation.routeExact) return false;
  const actualBody = normalizeForMatch(bodyObservation.text);
  if (!isExactArticleEditRoute(page, editUrl)) return false;
  return actualTitle === expectedTitleText &&
    (expectedBodyPrefix === "" || actualBody.includes(expectedBodyPrefix));
}

// ---------------------------------------------------------------------------
// Article HTML rendering (DETERMINISTIC — the X Articles editor converts this
// HTML fragment to its native blocks on paste, VERIFIED empirically 2026-06).
// ---------------------------------------------------------------------------

/** HTML-escape text for safe embedding in an HTML fragment. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a sequence of inline runs to escaped HTML with bold/italic/link marks.
 *   - bold  → <strong>, italic → <em> (X converts these to styled spans).
 *   - href  → <a href="...">…</a> (X applies a real hyperlink).
 *   - inline `code` → plain text (X Articles has no inline-code style).
 * All text is HTML-escaped; hrefs are attribute-escaped.
 */
function inlineRunsToHtml(runs: InlineRun[]): string {
  let out = "";
  for (const run of runs) {
    if (!run.text) continue;
    let inner = escapeHtml(run.text);
    // Inline code has no X equivalent — leave as plain (escaped) text.
    if (run.bold) inner = `<strong>${inner}</strong>`;
    if (run.italic) inner = `<em>${inner}</em>`;
    if (run.href) inner = `<a href="${escapeHtml(run.href)}">${inner}</a>`;
    out += inner;
  }
  return out;
}

/**
 * Render structured article blocks to an HTML fragment the X Articles editor
 * converts natively on paste (issue #5).
 *
 * Mapping:
 *   - heading level 1              → <h1>
 *   - heading level 2 + subheading → <h2>   (X has exactly two heading levels)
 *   - paragraph                    → <p>
 *   - quote                        → <blockquote>
 *   - consecutive bullet blocks    → a single <ul> of <li>
 *   - consecutive ordered blocks   → a single <ol> of <li>
 *   - code                         → EXCLUDED (paste won't convert it); counted
 *
 * Returns the HTML plus the count of excluded code blocks so the caller can flag
 * "N code blocks not auto-formatted" and tell the human to add them via
 * Insert → Code or a screenshot. Deterministic + build-time verifiable.
 */
export function htmlFromArticleBlocks(blocks: ArticleBlock[]): {
  html: string;
  codeBlockCount: number;
} {
  const parts: string[] = [];
  let codeBlockCount = 0;
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];

    // Group consecutive bullet / ordered blocks into a single list element.
    if (block.kind === "bullet" || block.kind === "ordered") {
      const tag = block.kind === "bullet" ? "ul" : "ol";
      const items: string[] = [];
      while (i < blocks.length && blocks[i].kind === block.kind) {
        const li = blocks[i] as Extract<ArticleBlock, { kind: "bullet" | "ordered" }>;
        items.push(`<li>${inlineRunsToHtml(li.runs)}</li>`);
        i++;
      }
      parts.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    switch (block.kind) {
      case "heading":
        parts.push(`<h${block.level}>${inlineRunsToHtml(block.runs)}</h${block.level}>`);
        break;
      case "subheading":
        // Subheading maps to the second (and last) X heading level, H2.
        parts.push(`<h2>${inlineRunsToHtml(block.runs)}</h2>`);
        break;
      case "paragraph":
        parts.push(`<p>${inlineRunsToHtml(block.runs)}</p>`);
        break;
      case "quote":
        parts.push(`<blockquote>${inlineRunsToHtml(block.runs)}</blockquote>`);
        break;
      case "code":
        // Paste does NOT convert code to a code block on X — exclude it and count
        // it so the caller can surface it (add via Insert → Code / screenshot).
        codeBlockCount++;
        break;
    }
    i++;
  }

  return { html: parts.join("\n"), codeBlockCount };
}

/**
 * Plain-text fallback for the clipboard (used when a surface ignores text/html).
 * Code blocks are excluded here too (consistent with the HTML), since they are
 * surfaced separately for manual insertion.
 */
function plainTextFromArticleBlocks(blocks: ArticleBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === "code") continue;
    const text = block.runs.map((r) => r.text).join("");
    lines.push(text);
  }
  return lines.join("\n\n");
}

function modifier(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control";
}

// ---------------------------------------------------------------------------
// Article cover — deterministic discovery + ratio inspection (never rejection)
// ---------------------------------------------------------------------------

export interface HeroImage {
  path?: string;
  width?: number;
  height?: number;
  ratio?: number;
  ratioOk?: boolean;
  reason?: string;
}

const HERO_RATIO = 5 / 2; // 2.5
const HERO_RATIO_TOL = 0.02; // allow tiny rounding drift
// Prefer explicitly-named hero/cover assets when present.
const HERO_NAME_HINTS = ["hero", "cover", "banner", "og", "5x2", "5-2"];

/**
 * Locate a hero image next to the article's base markdown (its publish/<slug>/
 * folder), preferring names hinting at a cover, and inspect its ratio by reading
 * the image header (no image lib needed for common formats).
 *
 * Returns a HeroImage describing what was found. Deterministic + verifiable.
 */
export function resolveHeroImage(basePath?: string): HeroImage {
  if (!basePath) return { reason: "No base path was provided to locate the article asset folder." };
  const dir = dirname(basePath);
  if (!existsSync(dir)) return { reason: `Article folder not found: ${dir}` };

  let candidates: string[];
  try {
    candidates = readdirSync(dir)
      .filter((f) => isLivePositiveXArticleCoverPath(f))
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

  // Rank: exact 5:2 first, then named hints, then closest ratio, then lexical
  // path. The final key makes selection deterministic when candidates tie.
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
      if (da !== db) return da - db;
      return a.p.localeCompare(b.p);
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
 * Upload the live-positive cover format via the editor's cover control. X owns
 * the crop/edit acceptance step; local ratio inspection never rejects it.
 *
 * NEEDS LIVE CALIBRATION: the cover button / hidden file input / crop-apply
 * dialog testids are best-effort. We prefer setting the file <input> directly
 * (works for styled labels), then click through any crop/apply dialog with the
 * 5:2 default. Since the source is already 5:2, no in-browser cropping is needed.
 * Returns a closed upload/crop fact without exposing a selector, path, or raw error.
 */
async function uploadHeroImage(
  page: Page,
  imagePath: string,
): Promise<Pick<Extract<XArticleCoverHandoff, { status: "attached" }>, "status" | "crop"> | { status: "upload_incomplete" }> {
  // Try the hidden file input first (most reliable for styled upload buttons).
  const fileInput = await optionalLocator(page, X_COMPOSER_SELECTORS.articleCoverFileInput, 2_500);
  if (fileInput) {
    try {
      await fileInput.setInputFiles(imagePath);
    } catch {
      return { status: "upload_incomplete" };
    }
  } else {
    // Fall back to clicking a labelled cover button that opens a file chooser.
    const coverBtn = await optionalLocator(page, X_COMPOSER_SELECTORS.articleCoverButton, 2_500);
    if (!coverBtn) {
      return { status: "upload_incomplete" };
    }
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 5_000 }),
        coverBtn.click(),
      ]);
      await chooser.setFiles(imagePath);
    } catch {
      return { status: "upload_incomplete" };
    }
  }

  // Confirm any crop/apply dialog (image already 5:2, so accept the default).
  await page.waitForTimeout(1_000);
  const apply = await optionalLocator(page, X_COMPOSER_SELECTORS.articleCoverApply, 3_000);
  if (apply) {
    await apply.click();
    await page.waitForTimeout(750);
    return { status: "attached", crop: "applied" };
  }
  return { status: "attached", crop: "unverified" };
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
 * The injected verifier runs only after Save returns. Missing controls are
 * `save_not_attempted`; a rejected Save click is `save_delivery_unknown`; any
 * later error/negative observation is `save_delivered_unverified`.
 */
export interface SaveAsDraftDependencies {
  locateClose(page: Page): Promise<Locator | null>;
  locateSave(page: Page): Promise<Locator | null>;
  settle(page: Page): Promise<void>;
}

const productionSaveAsDraftDependencies: SaveAsDraftDependencies = {
  locateClose(page) {
    return optionalLocator(page, X_COMPOSER_SELECTORS.closeComposerButton, 5_000);
  },
  locateSave(page) {
    return optionalLocator(page, X_COMPOSER_SELECTORS.saveDraftButton, 5_000);
  },
  async settle(page) {
    await page.waitForTimeout(750);
  },
};

export async function saveAsDraft(
  page: Page,
  verify: () => Promise<XDraftRowEvidence>,
  deps: SaveAsDraftDependencies = productionSaveAsDraftDependencies,
): Promise<
  | {
      savePhase: "verified";
      value: "the close→Save dialog";
      draftRowEvidence: Extract<XDraftRowEvidence, { status: "verified" }>;
    }
  | {
      savePhase: "save_delivered_unverified";
      value: "the close→Save dialog";
      draftRowEvidence: Extract<XDraftRowEvidence, { status: "unverified" }>;
    }
> {
  let save: Locator | undefined;
  const flow = await runXDraftSaveFlow("composer_close_save", {
    async beforeSave() {
      const close = await deps.locateClose(page);
      if (!close) throw new Error("Close control unavailable.");
      await close.click();

      const candidate = await deps.locateSave(page);
      if (!candidate) {
        // Do not guess at another button: a wrong click could discard or post.
        throw new Error("Save control unavailable.");
      }
      save = candidate;
    },
    async deliverSave() {
      if (!save) throw new Error("Save control was not prepared.");
      await save.click();
    },
    async afterSave() {
      await deps.settle(page);
      const evidence = snapshotXDraftRowEvidence(await verify());
      const usable = evidence?.status === "verified" || evidence?.status === "unverified"
        ? evidence
        : unavailableDraftRowEvidence("baseline_unavailable");
      return {
        verified: isPositiveXDraftRowEvidence(usable),
        value: usable,
      };
    },
  });

  if (flow.savePhase === "verified" && flow.value.status === "verified") {
    return {
      savePhase: "verified",
      value: "the close→Save dialog",
      draftRowEvidence: flow.value,
    };
  }
  return {
    savePhase: "save_delivered_unverified",
    value: "the close→Save dialog",
    draftRowEvidence: flow.value.status === "unverified"
      ? flow.value
      : unavailableDraftRowEvidence("baseline_unavailable"),
  };
}

/**
 * One opaque pre-Save baseline. The public portion contains only bounded facts;
 * scoped-row fingerprints remain module-private in the WeakMap below.
 */
export interface XDraftRowBaseline {
  readonly kind: "x_unsent_drafts_baseline";
  readonly observation: XDraftRowObservation;
}

interface DraftRowBaselinePrivate {
  expectedFingerprint: string | null;
  rowFingerprints: readonly string[] | null;
}

const draftRowBaselinePrivate = new WeakMap<XDraftRowBaseline, DraftRowBaselinePrivate>();

type DraftRowsAtomicSnapshot =
  | { kind: "route_not_exact" }
  | { kind: "modal_missing" }
  | { kind: "modal_ambiguous"; visibleModalCount: number | "many" }
  | { kind: "rows_missing" }
  | {
      kind: "rows_unreadable";
      rows: "content_missing" | "content_ambiguous" | "count_exceeded" | "text_too_large";
      visibleRowCount: number | "many";
    }
  | { kind: "observed"; texts: readonly string[] };

interface DraftRowsProbeResult {
  observation: XDraftRowObservation;
  rowFingerprints: readonly string[] | null;
}

export interface DraftRowProbeDependencies {
  gotoDrafts(page: Page): Promise<void>;
  wait(page: Page, milliseconds: number): Promise<void>;
  /** One atomic, route-bearing DOM snapshot. The raw value is validated once. */
  snapshot(page: Page): Promise<unknown>;
}

// Premium's local transport guard is measured in Unicode code points. A valid
// 25,000-code-point post can occupy twice as many UTF-16 code units when every
// point is astral, so keep the DOM snapshot bound large enough for that path.
const DRAFT_ROW_TEXT_LIMIT = X_PREMIUM_POST_PLATFORM_MAX_LENGTH * 2;
const DRAFT_ROW_RETRY_COUNT = 13;

const productionDraftRowProbeDependencies: DraftRowProbeDependencies = {
  async gotoDrafts(page) {
    await page.goto(X_COMPOSER_SELECTORS.draftsUrl, { waitUntil: "domcontentloaded" });
  },
  async wait(page, milliseconds) {
    await page.waitForTimeout(milliseconds);
  },
  async snapshot(page) {
    return page.evaluate((limits) => {
      const isVisible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;
      };
      const boundedCount = (value: number): number | "many" =>
        value > limits.rowLimit ? "many" : value;

      if (location.href !== limits.draftsUrl) return { kind: "route_not_exact" };

      // Live-calibrated 2026-09-03. Generic role=dialog produced two nested
      // dialogs, while the aria-modal form uniquely owned the Unsent rows.
      const modals = Array.from(
        document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
      ).filter(isVisible);
      if (modals.length === 0) return { kind: "modal_missing" };
      if (modals.length !== 1) {
        return {
          kind: "modal_ambiguous",
          visibleModalCount: boundedCount(modals.length),
        };
      }

      const rows = Array.from(
        modals[0].querySelectorAll('[data-testid="unsentTweet"]'),
      ).filter(isVisible);
      if (rows.length === 0) return { kind: "rows_missing" };
      if (rows.length > limits.rowLimit) {
        return {
          kind: "rows_unreadable",
          rows: "count_exceeded",
          visibleRowCount: "many",
        };
      }

      const texts: string[] = [];
      for (const row of rows) {
        const content = Array.from(
          row.querySelectorAll('[data-testid="tweetText"]'),
        ).filter(isVisible);
        if (content.length === 0) {
          return {
            kind: "rows_unreadable",
            rows: "content_missing",
            visibleRowCount: rows.length,
          };
        }
        if (content.length !== 1) {
          return {
            kind: "rows_unreadable",
            rows: "content_ambiguous",
            visibleRowCount: rows.length,
          };
        }
        const text = (content[0] as HTMLElement).innerText;
        if (typeof text !== "string" || text.length > limits.textLimit) {
          return {
            kind: "rows_unreadable",
            rows: "text_too_large",
            visibleRowCount: rows.length,
          };
        }
        texts.push(text);
      }
      return { kind: "observed", texts };
    }, {
      draftsUrl: X_COMPOSER_SELECTORS.draftsUrl,
      rowLimit: X_DRAFT_ROW_OBSERVATION_LIMIT,
      textLimit: DRAFT_ROW_TEXT_LIMIT,
    });
  },
};

function notObservedDraftRows(): XDraftRowObservation {
  return {
    outcome: "not_observed",
    route: "not_observed",
    modal: "not_observed",
    rows: "not_observed",
    visibleModalCount: null,
    visibleRowCount: null,
    exactFullTextMatches: null,
  };
}

function routeNotExactDraftRows(): XDraftRowObservation {
  return {
    outcome: "route_not_exact",
    route: "not_exact",
    modal: "not_observed",
    rows: "not_observed",
    visibleModalCount: null,
    visibleRowCount: null,
    exactFullTextMatches: null,
  };
}

function failedDraftRowsProbe(): XDraftRowObservation {
  return {
    outcome: "probe_failed",
    route: "unknown",
    modal: "not_observed",
    rows: "not_observed",
    visibleModalCount: null,
    visibleRowCount: null,
    exactFullTextMatches: null,
  };
}

function normalizeDraftRowText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function fingerprintDraftRow(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function snapshotAtomicDraftRows(value: unknown): DraftRowsAtomicSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const source = value as Record<string, unknown>;
    const kind = source.kind;
    const visibleModalCount = source.visibleModalCount;
    const visibleRowCount = source.visibleRowCount;
    const rows = source.rows;
    const texts = source.texts;
    if (kind === "route_not_exact" || kind === "modal_missing" || kind === "rows_missing") {
      return { kind };
    }
    if (kind === "modal_ambiguous") {
      return (visibleModalCount === "many" ||
          (Number.isInteger(visibleModalCount) &&
            (visibleModalCount as number) >= 2 &&
            (visibleModalCount as number) <= X_DRAFT_ROW_OBSERVATION_LIMIT))
        ? { kind, visibleModalCount: visibleModalCount as number | "many" }
        : null;
    }
    if (kind === "rows_unreadable") {
      const rowKind = rows === "content_missing" ||
        rows === "content_ambiguous" ||
        rows === "count_exceeded" ||
        rows === "text_too_large";
      const countValid = rows === "count_exceeded"
        ? visibleRowCount === "many"
        : Number.isInteger(visibleRowCount) &&
          (visibleRowCount as number) >= 1 &&
          (visibleRowCount as number) <= X_DRAFT_ROW_OBSERVATION_LIMIT;
      return rowKind && countValid
        ? {
            kind,
            rows,
            visibleRowCount: visibleRowCount as number | "many",
          }
        : null;
    }
    if (kind !== "observed" || !Array.isArray(texts)) return null;
    if (texts.length < 1 || texts.length > X_DRAFT_ROW_OBSERVATION_LIMIT) return null;
    const copied: string[] = [];
    for (const item of texts) {
      if (typeof item !== "string" || item.length > DRAFT_ROW_TEXT_LIMIT) return null;
      copied.push(item);
    }
    return { kind, texts: copied };
  } catch {
    return null;
  }
}

function observationFromAtomicSnapshot(
  snapshot: DraftRowsAtomicSnapshot,
  expected: string,
): DraftRowsProbeResult {
  if (snapshot.kind === "route_not_exact") {
    return { observation: routeNotExactDraftRows(), rowFingerprints: null };
  }
  if (snapshot.kind === "modal_missing") {
    return {
      observation: {
        outcome: "modal_missing",
        route: "exact",
        modal: "missing",
        rows: "not_observed",
        visibleModalCount: 0,
        visibleRowCount: null,
        exactFullTextMatches: null,
      },
      rowFingerprints: null,
    };
  }
  if (snapshot.kind === "modal_ambiguous") {
    return {
      observation: {
        outcome: "modal_ambiguous",
        route: "exact",
        modal: "multiple",
        rows: "not_observed",
        visibleModalCount: snapshot.visibleModalCount,
        visibleRowCount: null,
        exactFullTextMatches: null,
      },
      rowFingerprints: null,
    };
  }
  if (snapshot.kind === "rows_missing") {
    return {
      observation: {
        outcome: "rows_missing",
        route: "exact",
        modal: "single_visible",
        rows: "none",
        visibleModalCount: 1,
        visibleRowCount: 0,
        exactFullTextMatches: 0,
      },
      rowFingerprints: null,
    };
  }
  if (snapshot.kind === "rows_unreadable") {
    return {
      observation: {
        outcome: "rows_unreadable",
        route: "exact",
        modal: "single_visible",
        rows: snapshot.rows,
        visibleModalCount: 1,
        visibleRowCount: snapshot.visibleRowCount,
        exactFullTextMatches: null,
      },
      rowFingerprints: null,
    };
  }
  const normalized = snapshot.texts.map(normalizeDraftRowText);
  const exactFullTextMatches = normalized.filter((text) => text === expected).length;
  return {
    observation: {
      outcome: "observed",
      route: "exact",
      modal: "single_visible",
      rows: "all_readable",
      visibleModalCount: 1,
      visibleRowCount: normalized.length,
      exactFullTextMatches,
    },
    rowFingerprints: normalized.map(fingerprintDraftRow),
  };
}

async function probeDraftRows(
  page: Page,
  expected: string,
  deps: DraftRowProbeDependencies,
): Promise<DraftRowsProbeResult> {
  if (!isExactDraftsRoute(page)) {
    return { observation: routeNotExactDraftRows(), rowFingerprints: null };
  }
  try {
    const raw = await deps.snapshot(page);
    if (!isExactDraftsRoute(page)) {
      return { observation: routeNotExactDraftRows(), rowFingerprints: null };
    }
    const snapshot = snapshotAtomicDraftRows(raw);
    return snapshot
      ? observationFromAtomicSnapshot(snapshot, expected)
      : { observation: failedDraftRowsProbe(), rowFingerprints: null };
  } catch {
    return { observation: failedDraftRowsProbe(), rowFingerprints: null };
  }
}

async function openDraftRowsSurface(
  page: Page,
  deps: DraftRowProbeDependencies,
): Promise<XDraftRowObservation | null> {
  try {
    await deps.gotoDrafts(page);
  } catch {
    return failedDraftRowsProbe();
  }
  if (!isExactDraftsRoute(page)) return routeNotExactDraftRows();
  try {
    if (!isExactDraftsRoute(page)) return routeNotExactDraftRows();
    await deps.wait(page, 1_500);
    if (!isExactDraftsRoute(page)) return routeNotExactDraftRows();
  } catch {
    return failedDraftRowsProbe();
  }
  return null;
}

/**
 * Capture the visible, row-scoped multiset before composing. Any failure is a
 * closed negative fact and never prevents the later native Save attempt.
 */
export async function captureDraftRowBaseline(
  page: Page,
  expectedText: string,
  deps: DraftRowProbeDependencies = productionDraftRowProbeDependencies,
): Promise<XDraftRowBaseline> {
  const expected = normalizeDraftRowText(expectedText);
  let result: DraftRowsProbeResult;
  if (!expected) {
    result = { observation: notObservedDraftRows(), rowFingerprints: null };
  } else {
    const openFailure = await openDraftRowsSurface(page, deps);
    result = openFailure
      ? { observation: openFailure, rowFingerprints: null }
      : await probeDraftRows(page, expected, deps);
  }
  const baseline: XDraftRowBaseline = Object.freeze({
    kind: "x_unsent_drafts_baseline" as const,
    observation: Object.freeze({ ...result.observation }),
  });
  draftRowBaselinePrivate.set(baseline, {
    expectedFingerprint: expected ? fingerprintDraftRow(expected) : null,
    rowFingerprints: result.rowFingerprints ? [...result.rowFingerprints] : null,
  });
  return baseline;
}

function unavailableDraftRowEvidence(
  contentMatch: XDraftRowEvidenceUnverified["contentMatch"],
  baseline: XDraftRowObservation = notObservedDraftRows(),
  postSave: XDraftRowObservation = notObservedDraftRows(),
): XDraftRowEvidenceUnverified {
  return {
    status: "unverified",
    method: "unsent_row_full_text_delta",
    contentMatch,
    nativeRowId: "unavailable",
    listCompleteness: "visible_scoped_rows_only",
    baseline,
    postSave,
  };
}

function unavailablePostDraftRowEvidence(
  baseline: XDraftRowObservation,
  postSave: XDraftRowObservation,
): XDraftRowEvidenceUnverified {
  return unavailableDraftRowEvidence(
    baseline.outcome === "observed" ? "post_unavailable" : "baseline_unavailable",
    baseline,
    postSave,
  );
}

function multisetsDifferByExpectedOnly(
  before: readonly string[],
  after: readonly string[],
  expectedFingerprint: string,
): boolean {
  if (after.length !== before.length + 1) return false;
  const counts = new Map<string, number>();
  for (const value of after) counts.set(value, (counts.get(value) ?? 0) + 1);
  const expectedCount = counts.get(expectedFingerprint) ?? 0;
  if (expectedCount !== 1) return false;
  counts.delete(expectedFingerprint);
  for (const value of before) {
    const count = counts.get(value) ?? 0;
    if (count === 0) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return counts.size === 0;
}

function compareDraftRowSnapshots(
  baseline: XDraftRowBaseline,
  post: DraftRowsProbeResult,
  expectedFingerprint: string | null,
): XDraftRowEvidence {
  const baselineState = draftRowBaselinePrivate.get(baseline);
  const baselineObservation = baseline.observation;
  if (!expectedFingerprint || !baselineState?.expectedFingerprint) {
    return unavailableDraftRowEvidence("empty_intended", baselineObservation, post.observation);
  }
  if (
    baselineState.expectedFingerprint !== expectedFingerprint ||
    baselineObservation.outcome !== "observed" ||
    !baselineState.rowFingerprints
  ) {
    return unavailableDraftRowEvidence("baseline_unavailable", baselineObservation, post.observation);
  }
  if (post.observation.outcome !== "observed" || !post.rowFingerprints) {
    return unavailableDraftRowEvidence("post_unavailable", baselineObservation, post.observation);
  }
  if (baselineObservation.exactFullTextMatches !== 0) {
    return unavailableDraftRowEvidence("preexisting_exact", baselineObservation, post.observation);
  }
  if (post.observation.exactFullTextMatches === 0) {
    return unavailableDraftRowEvidence("post_exact_missing", baselineObservation, post.observation);
  }
  if (post.observation.exactFullTextMatches !== 1) {
    return unavailableDraftRowEvidence("post_exact_ambiguous", baselineObservation, post.observation);
  }
  if (!multisetsDifferByExpectedOnly(
    baselineState.rowFingerprints,
    post.rowFingerprints,
    expectedFingerprint,
  )) {
    return unavailableDraftRowEvidence(
      "visible_scoped_multiset_changed",
      baselineObservation,
      post.observation,
    );
  }
  return {
    status: "verified",
    method: "unsent_row_full_text_delta",
    contentMatch: "visible_scoped_multiset_plus_one",
    nativeRowId: "unavailable",
    listCompleteness: "visible_scoped_rows_only",
    baseline: baselineObservation,
    postSave: post.observation,
  };
}

/**
 * Verify the calibrated X Unsent row structure after Save. Positive evidence
 * requires the exact canonical route, one visible aria-modal dialog, readable
 * visible `unsentTweet` rows with one row-scoped `tweetText` each, one exact
 * full intended-content match, and a visible multiset equal to the pre-Save
 * baseline plus that one content value. It does not claim a stable native row
 * id, complete pagination, reply-target identity, or causality.
 */
export async function verifyDraftSaved(
  page: Page,
  expectedText: string,
  baseline: XDraftRowBaseline,
  deps: DraftRowProbeDependencies = productionDraftRowProbeDependencies,
): Promise<XDraftRowEvidence> {
  const expected = normalizeDraftRowText(expectedText);
  const expectedFingerprint = expected ? fingerprintDraftRow(expected) : null;
  const openFailure = await openDraftRowsSurface(page, deps);
  if (openFailure) {
    return expected
      ? unavailablePostDraftRowEvidence(baseline.observation, openFailure)
      : unavailableDraftRowEvidence("empty_intended", baseline.observation, openFailure);
  }

  let finalPost: DraftRowsProbeResult = {
    observation: notObservedDraftRows(),
    rowFingerprints: null,
  };
  for (let attempt = 0; attempt < DRAFT_ROW_RETRY_COUNT; attempt += 1) {
    finalPost = await probeDraftRows(page, expected, deps);
    const evidence = compareDraftRowSnapshots(baseline, finalPost, expectedFingerprint);
    if (evidence.status === "verified") return evidence;
    if (
      evidence.contentMatch === "empty_intended" ||
      evidence.contentMatch === "baseline_unavailable" ||
      evidence.contentMatch === "preexisting_exact" ||
      finalPost.observation.outcome === "route_not_exact" ||
      finalPost.observation.outcome === "probe_failed" ||
      attempt === DRAFT_ROW_RETRY_COUNT - 1
    ) {
      return evidence;
    }
    try {
      if (!isExactDraftsRoute(page)) {
        return unavailablePostDraftRowEvidence(
          baseline.observation,
          routeNotExactDraftRows(),
        );
      }
      await deps.wait(page, 500);
      if (!isExactDraftsRoute(page)) {
        return unavailablePostDraftRowEvidence(
          baseline.observation,
          routeNotExactDraftRows(),
        );
      }
    } catch {
      return unavailablePostDraftRowEvidence(
        baseline.observation,
        failedDraftRowsProbe(),
      );
    }
  }
  return unavailablePostDraftRowEvidence(baseline.observation, finalPost.observation);
}

function isExactDraftsRoute(page: Page): boolean {
  try {
    return new URL(page.url()).href === X_COMPOSER_SELECTORS.draftsUrl;
  } catch {
    return false;
  }
}

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

import type { BrowserContext, ElementHandle, Page, Locator } from "playwright";
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { getBrowserContext, type EnsureSessionOptions } from "../session.js";
import type { GeneratedContent } from "./content.js";
import {
  snapshotXArticleCoverPreload,
  xArticleCoverFilePayload,
  type XArticleCoverPreload,
} from "./articleCover.js";
import {
  normalizeXArticleStageSnapshotFailure,
  snapshotXArticleStageInput,
  snapshotXContentFormat,
  snapshotXNonArticleDirectStageRequest,
  XArticleStageSnapshotError,
  type XArticleStageSnapshot,
  type XNonArticleStageSnapshot,
} from "./articleStageSnapshot.js";
export { htmlFromArticleBlocks } from "./articleStageSnapshot.js";
import {
  extractTweetId,
  X_PREMIUM_POST_PLATFORM_MAX_LENGTH,
} from "../capabilities/validation.js";
import {
  isPositiveXDraftRowEvidence,
  isPositiveXReplyTargetEvidence,
  resolveXReplyTargetEvidence,
  runXDraftSaveFlow,
  snapshotXArticleDraftHandoff,
  snapshotXDraftRowEvidence,
  xReplyTargetEvidenceProbeFailed,
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
  type XReplyTargetEvidence,
} from "./saveProgress.js";

// Preserve the existing public import while keeping parsing in a browser-free module.
export { extractTweetId } from "../capabilities/validation.js";

/**
 * Centralized composer/draft selectors. Candidate arrays use tolerantLocator;
 * the calibrated Article editor/cover selectors are singleton strings whose
 * uniqueness and DOM relationships are checked explicitly below.
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
  // Editor inputs. LIVE-CALIBRATED 2026-09: twitter-article-title belongs to
  // sidebar links and is not editable. The editor has one visible, enabled
  // title textarea and one visible contenteditable body.
  articleTitleInput: 'textarea[placeholder="Add a title"]',
  articleBodyInput: 'div[data-testid="composer"][contenteditable="true"]',

  // NOTE: the old guessed rich-formatting toolbar/link selectors
  // (articleToolbar* / articleLink*) were REMOVED in the paste-based rewrite
  // (issue #5). The editor accepts rich HTML paste and converts it natively
  // (h1/h2/p/ul/ol/blockquote/a/strong/em/s), so we no longer drive a toolbar.

  // ---- Article hero / cover image (REQUIRED to publish; 5:2 ratio) ----
  // LIVE-CALIBRATED 2026-09. The media input has no cover-specific attribute;
  // it is authorized only by its geometry and sibling relationship inside the
  // unique title/body editor root. The button is inspected, never clicked.
  articleMediaButton: 'button[aria-label="Add photos or video"]',
  articleMediaFileInput:
    'input[type="file"][data-testid="fileInput"][accept="image/jpeg,image/png,image/webp"]',
  articleCoverDialog: 'div[role="dialog"][aria-modal="true"]',
  articleCoverApply: '[data-testid="applyButton"]',
  articleCoverPreview: 'img[src^="https://pbs.twimg.com/media/"]',

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
   * Exact validated bytes for the required X Article cover. The CLI preloads
   * this before importing the browser staging runtime. Forbidden for tweet and
   * thread drafts.
   */
  cover?: Readonly<XArticleCoverPreload>;
  /** Legacy non-Article option retained only for the closed snapshot shape. */
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
      /** Non-conflicting exact canonical edit URL recaptured after settle. */
      nativeReference?: string;
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
  let format: GeneratedContent["format"];
  try {
    format = snapshotXContentFormat(content);
  } catch (error) {
    // The discriminant is untrusted, so no specific native mechanism can be
    // claimed before classification. Keep the bounded snapshot error generic.
    throw new XArticleStageSnapshotError(normalizeXArticleStageSnapshotFailure(error));
  }
  const mechanism = format === "article"
    ? "article_create_autosave"
    : "composer_close_save";
  try {
    // Close and pre-render every caller-owned Article value before profile or
    // browser access. The snapshot contains only copied frozen primitives.
    const articleSnapshot = format === "article"
      ? snapshotXArticleStageInput(content, format)
      : null;
    const nonArticleSnapshot = articleSnapshot
      ? null
      : snapshotXNonArticleDirectStageRequest(content, format, opts);
    const stageContent = articleSnapshot?.content ?? nonArticleSnapshot!.content;
    let inspect: boolean | undefined;
    let force: boolean | undefined;
    let articleCover: Readonly<XArticleCoverPreload> | null = null;
    if (articleSnapshot) {
      if (
        typeof opts !== "object" ||
        opts === null ||
        Array.isArray(opts) ||
        isProxy(opts) ||
        Object.getPrototypeOf(opts) !== Object.prototype
      ) {
        throw new XDraftStageError("save_not_attempted", mechanism);
      }
      const keys = Reflect.ownKeys(opts);
      if (keys.some((key) => typeof key !== "string" ||
        (key !== "inspect" && key !== "force" && key !== "cover"))) {
        throw new XDraftStageError("save_not_attempted", mechanism);
      }
      const inspectDescriptor = Object.getOwnPropertyDescriptor(opts, "inspect");
      const forceDescriptor = Object.getOwnPropertyDescriptor(opts, "force");
      const coverDescriptor = Object.getOwnPropertyDescriptor(opts, "cover");
      if (
        (inspectDescriptor && (!("value" in inspectDescriptor) || !inspectDescriptor.enumerable)) ||
        (forceDescriptor && (!("value" in forceDescriptor) || !forceDescriptor.enumerable)) ||
        !coverDescriptor || !("value" in coverDescriptor) || !coverDescriptor.enumerable
      ) {
        throw new XDraftStageError("save_not_attempted", mechanism);
      }
      inspect = inspectDescriptor?.value;
      force = forceDescriptor?.value;
      articleCover = snapshotXArticleCoverPreload(coverDescriptor.value);
      if (
        (inspect !== undefined && typeof inspect !== "boolean") ||
        (force !== undefined && typeof force !== "boolean") ||
        articleCover === null
      ) {
        throw new XDraftStageError("save_not_attempted", mechanism);
      }
    } else {
      inspect = nonArticleSnapshot!.inspect;
      force = nonArticleSnapshot!.force;
    }
    const articleRequestSnapshot = articleSnapshot === null
      ? null
      : Object.freeze({
          content: articleSnapshot,
          cover: articleCover!,
          inspect,
          force,
        });
    const ctx = (await getBrowserContext({
      inspect: articleRequestSnapshot?.inspect ?? inspect,
      force: articleRequestSnapshot?.force ?? force,
    })) as BrowserContext;
    const page = await ctx.newPage();
    try {
      if (articleRequestSnapshot) {
        return await stageArticleSnapshot(
          ctx,
          page,
          articleRequestSnapshot.content,
          articleRequestSnapshot.cover,
        );
      }
      return await stageTweetOrThreadDraft(page, nonArticleSnapshot!);
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
  snapshot: XNonArticleStageSnapshot,
): Promise<StageDraftResult> {
  const { format, posts, intendedFirstPostText } = snapshot;

  if (posts.length === 0) {
    throw new Error("No content to stage (empty tweet/thread).");
  }

  // Read-only baseline on the same page/context. Failure is retained as
  // unverified evidence and never prevents the later Save attempt.
  const baseline = await captureDraftRowBaseline(page, intendedFirstPostText);
  await page.goto(X_COMPOSER_SELECTORS.composeUrl, { waitUntil: "domcontentloaded" });

  await typePosts(page, posts);

  const saved = await saveAsDraft(
    page,
    () => verifyDraftSaved(page, intendedFirstPostText, baseline),
  );

  return saved.savePhase === "verified"
    ? {
        format,
        posts: posts.length,
        saveMechanism: "composer_close_save",
        savePhase: "verified",
        draftRowEvidence: saved.draftRowEvidence,
        note: `Saved via ${saved.value}. Full intended ${format === "thread" ? "first thread-row" : "tweet"} text was observed in one calibrated X Unsent row; review every row and post manually.`,
      }
    : {
        format,
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
async function typePosts(page: Page, posts: readonly string[]): Promise<void> {
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

interface StageReplyResultBase {
  format: GeneratedContent["format"];
  posts: number;
  /** Compatibility diagnostic only; command receipts never render this prose. */
  note: string;
  saveMechanism: "composer_close_save";
  /** Normalized caller-requested target; this is intent, not native proof. */
  replyToId: string;
}

/**
 * Reply results keep content persistence and target identity independent.
 * Overall success requires both positive facts; a returned Save with either
 * fact unverified remains a coherent returned-unverified result.
 */
export type StageReplyResult = StageReplyResultBase & (
  | {
      savePhase: "verified";
      draftRowEvidence: Extract<XDraftRowEvidence, { status: "verified" }>;
      replyTargetEvidence: Extract<XReplyTargetEvidence, { status: "verified" }>;
    }
  | {
      savePhase: "save_delivered_unverified";
      draftRowEvidence: Extract<XDraftRowEvidence, { status: "verified" | "unverified" }>;
      replyTargetEvidence: Extract<XReplyTargetEvidence, { status: "unverified" }>;
    }
);

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
 * Live calibration on 2026-09-03 found no exact target-id signal in the saved
 * row or reopened composer, so production target evidence deliberately remains
 * unverified after content persistence succeeds.
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

      // Do not infer native target identity from the requested compose URL,
      // composer banner, row text, or reopen intent. Production has no target
      // observer until X exposes a live-calibrated exact-id signal.
      let replyTargetEvidence: XReplyTargetEvidence;
      try {
        replyTargetEvidence = await resolveXReplyTargetEvidence(
          saved.draftRowEvidence,
          replyToId,
        );
      } catch {
        // Defensive outer guard: no target-only failure after Save may escape
        // to stageReplyDraft's pre-Save fallback classification.
        replyTargetEvidence = xReplyTargetEvidenceProbeFailed(replyToId);
      }

      if (
        saved.savePhase === "verified" &&
        isPositiveXReplyTargetEvidence(replyTargetEvidence)
      ) {
        return {
          format: content.format,
          posts: posts.length,
          saveMechanism: "composer_close_save",
          savePhase: "verified",
          draftRowEvidence: saved.draftRowEvidence,
          replyTargetEvidence,
          replyToId,
          note: `The full intended ${content.format === "thread" ? "first reply-thread row" : "reply"} text and an exact native target-id binding were observed after ${saved.value}. Review manually before posting.`,
        };
      }
      return {
        format: content.format,
        posts: posts.length,
        saveMechanism: "composer_close_save",
        savePhase: "save_delivered_unverified",
        draftRowEvidence: saved.draftRowEvidence,
        replyTargetEvidence: replyTargetEvidence.status === "unverified"
          ? replyTargetEvidence
          : xReplyTargetEvidenceProbeFailed(replyToId),
        replyToId,
        note: `Save returned after staging was requested for target ${replyToId}, but the closed content and target evidence did not both verify in X Unsent/Drafts.`,
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
 * (Meta+V / Ctrl+V) → let the editor convert. Then attach the exact preloaded
 * 5:2 cover. Leaves it unsent (Articles autosave). NEVER clicks Publish.
 *
 * DETERMINISTIC parts (fully implemented, verifiable at build time): block/inline
 * parsing (content.ts), HTML rendering (htmlFromArticleBlocks), and explicit
 * cover byte/dimension validation (articleCover.ts).
 *
 * BROWSER-INTERACTION: the 5:2 cover target, crop dialog, Apply control, and
 * persisted preview were live-calibrated in 2026-09. Any ambiguity or missing
 * positive evidence keeps the result delivered-but-unverified.
 */
export interface ArticleDraftStageDependencies {
  openHub(page: Page): Promise<void>;
  locateCreate(page: Page): Promise<Locator | null>;
  /** Immediate post-Create URL sample; never authoritative on its own. */
  currentEditUrl(page: Page): string | null;
  /** Post-settle URL sample, with any production polling bounded internally. */
  settledEditUrl(page: Page): Promise<string | null>;
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
  stageCover(
    page: Page,
    cover: Readonly<XArticleCoverPreload>,
  ): Promise<XArticleCoverHandoff>;
  settle(page: Page): Promise<void>;
  verify(
    page: Page,
    editUrl: string,
    expectedTitle: string,
    expectedBody: string,
    expectedCoverWidth: number,
    expectedCoverHeight: number,
  ): Promise<Readonly<{ content: boolean; cover: boolean }>>;
}

export async function stageArticleDraft(
  ctx: BrowserContext,
  page: Page,
  content: GeneratedContent,
  cover: Readonly<XArticleCoverPreload>,
  deps: ArticleDraftStageDependencies = productionArticleDraftStageDependencies,
): Promise<StageDraftResult> {
  let format: GeneratedContent["format"];
  try {
    format = snapshotXContentFormat(content);
    const snapshot = snapshotXArticleStageInput(content, format);
    const copiedCover = snapshotXArticleCoverPreload(cover);
    if (copiedCover === null) {
      throw new XDraftStageError("save_not_attempted", "article_create_autosave");
    }
    return await stageArticleSnapshot(ctx, page, snapshot, copiedCover, deps);
  } catch (error) {
    throw xDraftStageError(error, "save_not_attempted", "article_create_autosave");
  }
}

/** Use only copy-owned primitives from the pre-platform Article snapshot. */
async function stageArticleSnapshot(
  ctx: BrowserContext,
  page: Page,
  snapshot: XArticleStageSnapshot,
  coverInput: Readonly<XArticleCoverPreload>,
  deps: ArticleDraftStageDependencies = productionArticleDraftStageDependencies,
): Promise<StageDraftResult> {
  const title = snapshot.title;
  const html = snapshot.html;
  const plainFallback = snapshot.plain;
  const receiptCodeBlockCount = snapshot.receiptCodeBlockCount;
  const codeAdvisories = snapshot.codeAdvisories;
  const codeLinkAdvisories = snapshot.codeLinkAdvisories;
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
      const provisionalEditUrl = validatedArticleEditUrl(deps.currentEditUrl(page));

      await deps.writeTitle(page, titleBox, title);

      const bodyBox = await deps.locateBody(page);
      if (!bodyBox) throw new Error("Article body input unavailable after Create.");

      await deps.writeBody(ctx, page, bodyBox, html, plainFallback);

      // Hand the exact prevalidated payload to X. No path read or discovery is
      // allowed after the browser boundary.
      const stagedCover = await deps.stageCover(page, coverInput);
      const coverEditUrl = ARTICLE_COVER_EDIT_URLS.get(stagedCover);
      const partialEditUrl = coverEditUrl === undefined
        ? provisionalEditUrl
        : provisionalEditUrl === null || provisionalEditUrl === coverEditUrl
          ? coverEditUrl
          : null;
      const partialValue = {
        nativeReference: partialEditUrl,
        body: "rich_html" as const,
        codeBlockCount: receiptCodeBlockCount,
        codeAdvisories,
        codeLinkAdvisories,
        cover: stagedCover,
      };

      // Let autosave settle, then independently reload the captured edit URL and
      // match the intended title/body. Merely remaining on /edit/<id> is not
      // persistence evidence.
      let settledEditUrl: string | null;
      try {
        await deps.settle(page);
        settledEditUrl = validatedArticleEditUrl(await deps.settledEditUrl(page));
      } catch {
        // The cover handoff already returned after Create. A later read-only
        // settle/route probe cannot erase that progress or make delivery unknown.
        return { verified: false, value: partialValue };
      }
      const editUrl = settledEditUrl !== null &&
          (provisionalEditUrl === null || provisionalEditUrl === settledEditUrl) &&
          (coverEditUrl === undefined || coverEditUrl === settledEditUrl)
        ? settledEditUrl
        : null;
      let reopen: Readonly<{ content: boolean; cover: boolean }> | null = null;
      if (editUrl !== null) {
        try {
          reopen = await deps.verify(
            page,
            editUrl,
            title,
            plainFallback,
            coverInput.width,
            coverInput.height,
          );
        } catch {
          // Reopen verification is read-only. Its rejection leaves the exact
          // staged cover and canonical reference delivered but unverified.
          return {
            verified: false,
            value: { ...partialValue, nativeReference: editUrl },
          };
        }
      }
      const appliedCoverChainComplete = stagedCover.set === true &&
        stagedCover.applyPhase === "returned";
      const finalObserved = appliedCoverChainComplete &&
        (stagedCover.observed || reopen?.cover === true);
      const cover = Object.freeze({
        ...stagedCover,
        // The production verifier proves the same calibrated cover both before
        // navigation and after reopen, so it may repair only a transient early
        // observation miss after the set+Apply chain returned.
        observed: finalObserved,
        verified: reopen === null
          ? null
          : appliedCoverChainComplete && reopen.cover,
      });
      const verified = reopen !== null && reopen.content && cover.verified === true;
      return {
        verified,
        value: {
          nativeReference: editUrl,
          body: "rich_html" as const,
          codeBlockCount: receiptCodeBlockCount,
          codeAdvisories,
          codeLinkAdvisories,
          cover,
        },
      };
    },
  });

  const articleHandoff = snapshotXArticleDraftHandoff({
    body: saved.value.body,
    codeBlockCount: saved.value.codeBlockCount,
    codeAdvisories: saved.value.codeAdvisories,
    codeLinkAdvisories: saved.value.codeLinkAdvisories,
    cover: saved.value.cover,
  });
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
    ...(saved.value.nativeReference === null
      ? {}
      : { nativeReference: saved.value.nativeReference }),
    note: "Closed Article review facts are available in articleHandoff.",
  };
}

export async function stageArticleCover(
  page: Page,
  cover: Readonly<XArticleCoverPreload>,
  deps: ArticleCoverStageDependencies = productionArticleCoverStageDependencies,
): Promise<XArticleCoverHandoff> {
  const safeCover = snapshotXArticleCoverPreload(cover);
  const payload = xArticleCoverFilePayload(safeCover);
  if (safeCover === null || payload === null) {
    throw new Error("Invalid preloaded X Article cover payload.");
  }

  const base = {
    selection: "explicit" as const,
    contentType: safeCover.contentType,
    width: safeCover.width,
    height: safeCover.height,
    ratio: "exact_5_2" as const,
    sourceSha256: safeCover.sourceSha256,
    requested: true as const,
    resolved: true as const,
    uploaded: null,
    observed: false,
    verified: null,
  };

  let set: boolean | null = false;
  let setPhase: XArticleCoverHandoff["setPhase"] = "target_unavailable";
  const target = await deps.resolveTarget(page);
  const editUrl = validatedArticleEditUrl(target?.editUrl);
  const baselineDialogCount = editUrl === null
    ? null
    : await deps.activeDialogCount(page, editUrl);
  const baselineCover = editUrl === null
    ? { status: "invalid" as const }
    : await deps.observeCover(page, editUrl, safeCover.width, safeCover.height);
  if (
    target !== null &&
    editUrl !== null &&
    baselineDialogCount === 0 &&
    baselineCover.status === "none" &&
    await deps.targetStillCalibrated(page, target)
  ) {
    try {
      // The target is an exact ElementHandle whose sibling-to-editor relationship
      // was checked atomically. Never re-resolve it globally and never retry.
      await target.input.setInputFiles(payload);
      set = true;
      setPhase = "set_returned";
    } catch {
      // A rejected setInputFiles call may still have delivered the payload.
      // Preserve uncertainty and do not attempt any alternate upload route.
      set = null;
      setPhase = "set_delivery_unknown";
    }
  }

  if (set !== true) {
    return coverHandoffAtEditUrl({
      ...base,
      set,
      setPhase,
      applyPhase: "not_reached" as const,
    }, editUrl);
  }

  let applyPhase: XArticleCoverHandoff["applyPhase"] = "not_observed";
  let apply: ElementHandle<HTMLElement> | null;
  try {
    await deps.settleAfterSet(page);
    apply = await deps.locateApply(
      page,
      editUrl!,
      safeCover.width,
      safeCover.height,
    );
  } catch {
    // setInputFiles returned. A rejected read-only settle/crop probe cannot
    // erase that known progress, and no alternate upload or Apply is attempted.
    return coverHandoffAtEditUrl({
      ...base,
      set: true,
      setPhase: "set_returned" as const,
      applyPhase,
    }, editUrl);
  }
  if (apply) {
    try {
      await apply.click();
      applyPhase = "returned";
    } catch {
      applyPhase = "failed";
    }
    if (applyPhase === "returned") {
      try {
        await deps.settleAfterApply(page);
      } catch {
        // Apply returned; a later settle rejection is not evidence that it did
        // not take effect. Retain the chain without claiming observation.
        return coverHandoffAtEditUrl({
          ...base,
          set: true,
          setPhase: "set_returned" as const,
          applyPhase,
        }, editUrl);
      }
    }
  }
  let postApplyCover: XArticleCoverObservationResult = { status: "invalid" };
  if (applyPhase === "returned") {
    try {
      const dialogClosed = await deps.activeDialogCount(page, editUrl!) === 0;
      if (dialogClosed) {
        postApplyCover = await deps.observeCover(
          page,
          editUrl!,
          safeCover.width,
          safeCover.height,
        );
      }
    } catch {
      // Post-Apply probes are read-only. Keep the known returned chain and fail
      // closed on observation without repeating either delivery action.
      postApplyCover = { status: "invalid" };
    }
  }
  const observed = postApplyCover.status === "observed" &&
    postApplyCover.observation.naturalWidth === safeCover.width &&
    postApplyCover.observation.naturalHeight === safeCover.height;
  return coverHandoffAtEditUrl({
    ...base,
    set: true,
    setPhase: "set_returned" as const,
    applyPhase,
    observed,
  }, editUrl);
}

export interface XArticleCoverTargetFacts {
  readonly visibleEnabledTitleCount: number;
  readonly visibleBodyCount: number;
  readonly visibleEnabledMediaButtonCount: number;
  readonly exactFileInputCount: number;
  readonly rootMediaButtonCount: number;
  readonly rootFileInputCount: number;
  readonly rootIsEditor: boolean;
  readonly sameImmediateParent: boolean;
  readonly inputEnabled: boolean;
  readonly inputMultiple: boolean;
  readonly buttonStrictlyAboveTitle: boolean;
}

/** Closed structural decision used by the live-calibrated cover target. */
export function isCalibratedXArticleCoverTarget(
  facts: Readonly<XArticleCoverTargetFacts>,
): boolean {
  return facts.visibleEnabledTitleCount === 1 &&
    facts.visibleBodyCount === 1 &&
    facts.visibleEnabledMediaButtonCount === 1 &&
    facts.exactFileInputCount === 1 &&
    facts.rootMediaButtonCount === 1 &&
    facts.rootFileInputCount === 1 &&
    facts.rootIsEditor &&
    facts.sameImmediateParent &&
    facts.inputEnabled &&
    !facts.inputMultiple &&
    facts.buttonStrictlyAboveTitle;
}

export interface XArticleCoverVisualObservation {
  readonly sourceIdentitySha256: string;
  readonly box: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

export type XArticleCoverObservationResult =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{
      status: "observed";
      observation: Readonly<XArticleCoverVisualObservation>;
    }>;

export interface XArticleCoverInputTarget {
  /** Exact DOM node classified in-place; never a page-global re-resolution. */
  readonly input: ElementHandle<HTMLInputElement>;
  readonly editUrl: string;
}

const ARTICLE_COVER_EDIT_URLS = new WeakMap<object, string>();

function coverHandoffAtEditUrl(
  value: XArticleCoverHandoff,
  editUrl: string | null,
): XArticleCoverHandoff {
  const frozen = Object.freeze(value);
  if (editUrl !== null) ARTICLE_COVER_EDIT_URLS.set(frozen, editUrl);
  return frozen;
}

export interface ArticleCoverStageDependencies {
  resolveTarget(page: Page): Promise<Readonly<XArticleCoverInputTarget> | null>;
  targetStillCalibrated(
    page: Page,
    target: Readonly<XArticleCoverInputTarget>,
  ): Promise<boolean>;
  activeDialogCount(page: Page, editUrl: string): Promise<number | null>;
  locateApply(
    page: Page,
    editUrl: string,
    expectedWidth: number,
    expectedHeight: number,
  ): Promise<ElementHandle<HTMLElement> | null>;
  settleAfterSet(page: Page): Promise<void>;
  settleAfterApply(page: Page): Promise<void>;
  observeCover(
    page: Page,
    editUrl: string,
    expectedWidth: number,
    expectedHeight: number,
  ): Promise<XArticleCoverObservationResult>;
}

const productionArticleCoverStageDependencies: ArticleCoverStageDependencies = {
  resolveTarget: resolveCalibratedArticleCoverTarget,
  targetStillCalibrated: isArticleCoverTargetStillCalibrated,
  activeDialogCount: activeArticleCoverDialogCount,
  locateApply: locateCalibratedArticleCoverApply,
  async settleAfterSet(page) {
    await page.waitForTimeout(1_000);
  },
  async settleAfterApply(page) {
    await page.waitForTimeout(750);
  },
  observeCover: observeCalibratedArticleCover,
};

async function articleCoverTargetFacts(
  input: ElementHandle<HTMLInputElement>,
): Promise<Readonly<XArticleCoverTargetFacts> | null> {
  try {
    return await input.evaluate((node, selectors) => {
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0;
      };
      const enabled = (element: Element): boolean =>
        !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true";
      const titles = Array.from(document.querySelectorAll(selectors.title))
        .filter((element) => visible(element) && enabled(element));
      const bodies = Array.from(document.querySelectorAll(selectors.body))
        .filter(visible);
      const buttons = Array.from(document.querySelectorAll(selectors.button))
        .filter((element) => visible(element) && enabled(element));
      const inputs = Array.from(document.querySelectorAll(selectors.input));
      let root: Element | null = null;
      if (titles.length === 1 && bodies.length === 1) {
        root = titles[0];
        while (root !== null && !root.contains(bodies[0])) root = root.parentElement;
      }
      const rootIsEditor = root !== null &&
        root !== document.body &&
        root !== document.documentElement &&
        root.closest("nav,aside") === null;
      const rootButtons = rootIsEditor
        ? buttons.filter((button) => root!.contains(button))
        : [];
      const rootInputs = rootIsEditor
        ? inputs.filter((candidate) => root!.contains(candidate))
        : [];
      const button = rootButtons.length === 1 ? rootButtons[0] : null;
      const title = titles.length === 1 ? titles[0] : null;
      const buttonBox = button?.getBoundingClientRect();
      const titleBox = title?.getBoundingClientRect();
      return {
        visibleEnabledTitleCount: titles.length,
        visibleBodyCount: bodies.length,
        visibleEnabledMediaButtonCount: buttons.length,
        exactFileInputCount: inputs.length,
        rootMediaButtonCount: rootButtons.length,
        rootFileInputCount: rootInputs.length,
        rootIsEditor,
        sameImmediateParent: button !== null &&
          node.parentElement !== null &&
          node.parentElement === button.parentElement,
        inputEnabled: node.isConnected && enabled(node),
        inputMultiple: node.multiple,
        buttonStrictlyAboveTitle: buttonBox !== undefined &&
          titleBox !== undefined &&
          buttonBox.width > 0 &&
          buttonBox.height > 0 &&
          buttonBox.bottom < titleBox.top,
      };
    }, {
      title: X_COMPOSER_SELECTORS.articleTitleInput,
      body: X_COMPOSER_SELECTORS.articleBodyInput,
      button: X_COMPOSER_SELECTORS.articleMediaButton,
      input: X_COMPOSER_SELECTORS.articleMediaFileInput,
    });
  } catch {
    return null;
  }
}

export async function resolveCalibratedArticleCoverTarget(
  page: Page,
): Promise<Readonly<XArticleCoverInputTarget> | null> {
  const editUrl = validatedArticleEditUrl(page.url());
  if (editUrl === null) return null;
  try {
    const candidates = page.locator(X_COMPOSER_SELECTORS.articleMediaFileInput);
    if (await candidates.count() !== 1 || !isExactArticleEditRoute(page, editUrl)) return null;
    const input = await candidates.elementHandle();
    if (input === null || !isExactArticleEditRoute(page, editUrl)) return null;
    const facts = await articleCoverTargetFacts(input as ElementHandle<HTMLInputElement>);
    if (
      facts === null ||
      !isCalibratedXArticleCoverTarget(facts) ||
      !isExactArticleEditRoute(page, editUrl)
    ) {
      await input.dispose().catch(() => {});
      return null;
    }
    return Object.freeze({
      input: input as ElementHandle<HTMLInputElement>,
      editUrl,
    });
  } catch {
    return null;
  }
}

async function isArticleCoverTargetStillCalibrated(
  page: Page,
  target: Readonly<XArticleCoverInputTarget>,
): Promise<boolean> {
  if (!isExactArticleEditRoute(page, target.editUrl)) return false;
  const facts = await articleCoverTargetFacts(target.input);
  return facts !== null &&
    isCalibratedXArticleCoverTarget(facts) &&
    isExactArticleEditRoute(page, target.editUrl);
}

async function visibleElementHandles<T extends Node>(
  handles: readonly ElementHandle<T>[],
): Promise<ElementHandle<T>[]> {
  const visible: ElementHandle<T>[] = [];
  for (const handle of handles) {
    try {
      if (await handle.evaluate((element) => {
        if (!(element instanceof Element)) return false;
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0;
      })) visible.push(handle);
    } catch {
      return [];
    }
  }
  return visible;
}

async function activeArticleCoverDialogCount(
  page: Page,
  editUrl: string,
): Promise<number | null> {
  if (!isExactArticleEditRoute(page, editUrl)) return null;
  try {
    const handles = await page.locator(X_COMPOSER_SELECTORS.articleCoverDialog).elementHandles();
    if (handles.length > 16) return null;
    const visible = await visibleElementHandles(handles);
    return isExactArticleEditRoute(page, editUrl) ? visible.length : null;
  } catch {
    return null;
  }
}

/** Exact crop-image cardinality and caller-dimension gate used before Apply. */
export function isCalibratedXArticleCoverCrop(
  visibleCropImageCount: number,
  naturalWidth: number | null,
  naturalHeight: number | null,
  expectedWidth: number,
  expectedHeight: number,
): boolean {
  return visibleCropImageCount === 1 &&
    Number.isSafeInteger(expectedWidth) &&
    Number.isSafeInteger(expectedHeight) &&
    expectedWidth > 0 &&
    expectedHeight > 0 &&
    naturalWidth === expectedWidth &&
    naturalHeight === expectedHeight;
}

async function locateCalibratedArticleCoverApply(
  page: Page,
  editUrl: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<ElementHandle<HTMLElement> | null> {
  if (
    !isExactArticleEditRoute(page, editUrl) ||
    !Number.isSafeInteger(expectedWidth) ||
    !Number.isSafeInteger(expectedHeight) ||
    expectedWidth <= 0 ||
    expectedHeight <= 0
  ) return null;
  try {
    const dialogHandles = await page
      .locator(X_COMPOSER_SELECTORS.articleCoverDialog)
      .elementHandles();
    const visibleDialogs = await visibleElementHandles(dialogHandles);
    if (visibleDialogs.length !== 1 || !isExactArticleEditRoute(page, editUrl)) return null;
    const cropImages = await visibleDialogs[0].$$("img");
    const visibleCropImages = await visibleElementHandles(cropImages);
    const cropDimensions = visibleCropImages.length === 1
      ? await visibleCropImages[0].evaluate((element) =>
          element instanceof HTMLImageElement
            ? { width: element.naturalWidth, height: element.naturalHeight }
            : null,
        ).catch(() => null)
      : null;
    if (
      !isCalibratedXArticleCoverCrop(
        visibleCropImages.length,
        cropDimensions?.width ?? null,
        cropDimensions?.height ?? null,
        expectedWidth,
        expectedHeight,
      ) ||
      !isExactArticleEditRoute(page, editUrl)
    ) return null;
    const applyHandles = await visibleDialogs[0].$$(X_COMPOSER_SELECTORS.articleCoverApply);
    const eligible: ElementHandle<HTMLElement>[] = [];
    for (const apply of applyHandles) {
      const usable = await apply.evaluate((element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return element.isConnected &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0 &&
          !element.matches(":disabled") &&
          element.getAttribute("aria-disabled") !== "true";
      }).catch(() => false);
      if (usable) eligible.push(apply as ElementHandle<HTMLElement>);
    }
    return eligible.length === 1 && isExactArticleEditRoute(page, editUrl)
      ? eligible[0]
      : null;
  } catch {
    return null;
  }
}

interface RawArticleCoverObservation {
  readonly src: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

function snapshotArticleCoverObservation(
  raw: RawArticleCoverObservation,
  expectedWidth: number,
  expectedHeight: number,
): Readonly<XArticleCoverVisualObservation> | null {
  try {
    const parsed = new URL(raw.src);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "pbs.twimg.com" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      !parsed.pathname.startsWith("/media/") ||
      parsed.pathname.length <= "/media/".length ||
      ![raw.x, raw.y, raw.width, raw.height].every(Number.isFinite) ||
      raw.width < 300 ||
      raw.height <= 0 ||
      raw.width / raw.height < 2 ||
      raw.width / raw.height > 3 ||
      !Number.isSafeInteger(raw.naturalWidth) ||
      !Number.isSafeInteger(raw.naturalHeight) ||
      raw.naturalWidth <= 0 ||
      raw.naturalHeight <= 0 ||
      raw.naturalWidth !== expectedWidth ||
      raw.naturalHeight !== expectedHeight
    ) return null;
    const identity = `${parsed.origin}${parsed.pathname}`;
    return Object.freeze({
      sourceIdentitySha256: createHash("sha256").update(identity).digest("hex"),
      box: Object.freeze({
        x: raw.x,
        y: raw.y,
        width: raw.width,
        height: raw.height,
      }),
      naturalWidth: raw.naturalWidth,
      naturalHeight: raw.naturalHeight,
    });
  } catch {
    return null;
  }
}

export async function observeCalibratedArticleCover(
  page: Page,
  editUrl: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<XArticleCoverObservationResult> {
  if (
    !isExactArticleEditRoute(page, editUrl) ||
    !Number.isSafeInteger(expectedWidth) ||
    !Number.isSafeInteger(expectedHeight) ||
    expectedWidth <= 0 ||
    expectedHeight <= 0
  ) return Object.freeze({ status: "invalid" });
  try {
    const raw = await page.locator(X_COMPOSER_SELECTORS.articleCoverPreview).evaluateAll(
      (nodes, selectors) => {
        const visible = (element: Element): boolean => {
          const style = window.getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.display !== "none" &&
            style.visibility !== "hidden" &&
            box.width > 0 &&
            box.height > 0;
        };
        const enabled = (element: Element): boolean =>
          !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true";
        const titles = Array.from(document.querySelectorAll(selectors.title))
          .filter((element) => visible(element) && enabled(element));
        const bodies = Array.from(document.querySelectorAll(selectors.body))
          .filter(visible);
        let root: Element | null = null;
        if (titles.length === 1 && bodies.length === 1) {
          root = titles[0];
          while (root !== null && !root.contains(bodies[0])) root = root.parentElement;
        }
        const rootIsEditor = root !== null &&
          root !== document.body &&
          root !== document.documentElement &&
          root.closest("nav,aside") === null;
        if (!rootIsEditor) {
          return { validEditor: false, bodyMediaCount: 0, candidates: [] };
        }
        const titleBox = titles[0].getBoundingClientRect();
        const body = bodies[0];
        const bodyMediaCount = body.querySelectorAll(selectors.preview).length;
        const candidates = nodes.flatMap((node) => {
          if (!(node instanceof HTMLImageElement) ||
            !root!.contains(node) ||
            body.contains(node) ||
            !visible(node)) return [];
          const box = node.getBoundingClientRect();
          const ratio = box.width / box.height;
          if (
            box.width < 300 ||
            box.height <= 0 ||
            ratio < 2 ||
            ratio > 3 ||
            box.bottom >= titleBox.top ||
            node.naturalWidth <= 0 ||
            node.naturalHeight <= 0
          ) return [];
          return [{
            src: node.src,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            naturalWidth: node.naturalWidth,
            naturalHeight: node.naturalHeight,
          }];
        });
        return { validEditor: true, bodyMediaCount, candidates };
      },
      {
        title: X_COMPOSER_SELECTORS.articleTitleInput,
        body: X_COMPOSER_SELECTORS.articleBodyInput,
        preview: X_COMPOSER_SELECTORS.articleCoverPreview,
      },
    );
    if (!isExactArticleEditRoute(page, editUrl)) return Object.freeze({ status: "invalid" });
    if (!raw.validEditor || raw.bodyMediaCount !== 0 || raw.candidates.length > 1) {
      return Object.freeze({ status: "invalid" });
    }
    if (raw.candidates.length === 0) return Object.freeze({ status: "none" });
    const observation = snapshotArticleCoverObservation(
      raw.candidates[0],
      expectedWidth,
      expectedHeight,
    );
    return observation === null
      ? Object.freeze({ status: "invalid" })
      : Object.freeze({ status: "observed", observation });
  } catch {
    return Object.freeze({ status: "invalid" });
  }
}

const ARTICLE_COVER_OBSERVATION_POLL_ATTEMPTS = 33;
const ARTICLE_COVER_OBSERVATION_POLL_INTERVAL_MS = 250;

type ArticleCoverObservationPort = (
  page: Page,
  editUrl: string,
  expectedWidth: number,
  expectedHeight: number,
) => Promise<XArticleCoverObservationResult>;

/** At most 33 read-only samples over 8 seconds; never mutates or retries delivery. */
export async function waitForCalibratedArticleCoverObservation(
  page: Page,
  editUrl: string,
  expectedWidth: number,
  expectedHeight: number,
  observe: ArticleCoverObservationPort = observeCalibratedArticleCover,
): Promise<XArticleCoverObservationResult> {
  let last: XArticleCoverObservationResult = Object.freeze({ status: "invalid" });
  for (let attempt = 0; attempt < ARTICLE_COVER_OBSERVATION_POLL_ATTEMPTS; attempt += 1) {
    if (!isExactArticleEditRoute(page, editUrl)) {
      return Object.freeze({ status: "invalid" });
    }
    try {
      const candidate = await observe(page, editUrl, expectedWidth, expectedHeight);
      if (
        candidate.status === "observed" &&
        candidate.observation.naturalWidth === expectedWidth &&
        candidate.observation.naturalHeight === expectedHeight
      ) return candidate;
      last = candidate.status === "none"
        ? Object.freeze({ status: "none" })
        : Object.freeze({ status: "invalid" });
    } catch {
      return Object.freeze({ status: "invalid" });
    }
    if (attempt + 1 < ARTICLE_COVER_OBSERVATION_POLL_ATTEMPTS) {
      try {
        await page.waitForTimeout(ARTICLE_COVER_OBSERVATION_POLL_INTERVAL_MS);
      } catch {
        return Object.freeze({ status: "invalid" });
      }
    }
  }
  return last;
}

export function sameArticleCoverObservation(
  before: Readonly<XArticleCoverVisualObservation>,
  after: Readonly<XArticleCoverVisualObservation>,
): boolean {
  return before.sourceIdentitySha256 === after.sourceIdentitySha256 &&
    before.naturalWidth === after.naturalWidth &&
    before.naturalHeight === after.naturalHeight &&
    before.box.x === after.box.x &&
    before.box.y === after.box.y &&
    before.box.width === after.box.width &&
    before.box.height === after.box.height;
}

async function uniqueVisibleArticleLocator(
  page: Page,
  selector: string,
  timeout: number,
  requireEnabled: boolean,
): Promise<Locator | null> {
  const deadline = Date.now() + timeout;
  try {
    for (;;) {
      const matches = page.locator(selector);
      const count = await matches.count();
      if (count > 64) return null;
      const eligible: Locator[] = [];
      for (let index = 0; index < count; index += 1) {
        const candidate = matches.nth(index);
        if (!await candidate.isVisible()) continue;
        if (requireEnabled && !await candidate.isEnabled()) continue;
        eligible.push(candidate);
        if (eligible.length > 1) return null;
      }
      if (eligible.length === 1) return eligible[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await page.waitForTimeout(Math.min(250, remaining));
    }
  } catch {
    return null;
  }
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
  settledEditUrl(page) {
    return waitForCanonicalArticleEditUrl(page);
  },
  locateTitle(page) {
    return uniqueVisibleArticleLocator(
      page,
      X_COMPOSER_SELECTORS.articleTitleInput,
      12_000,
      true,
    );
  },
  async writeTitle(page, title, value) {
    await title.click();
    await typeText(page, title, value);
  },
  locateBody(page) {
    return uniqueVisibleArticleLocator(
      page,
      X_COMPOSER_SELECTORS.articleBodyInput,
      12_000,
      false,
    );
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
  async verify(
    page,
    editUrl,
    expectedTitle,
    expectedBody,
    expectedCoverWidth,
    expectedCoverHeight,
  ) {
    const beforeReloadCover = await waitForCalibratedArticleCoverObservation(
      page,
      editUrl,
      expectedCoverWidth,
      expectedCoverHeight,
    );
    const content = await verifyArticleDraftSaved(
      page,
      editUrl,
      expectedTitle,
      expectedBody,
    );
    if (!content || !isExactArticleEditRoute(page, editUrl)) {
      return Object.freeze({ content: false, cover: false });
    }
    const afterReloadCover = await waitForCalibratedArticleCoverObservation(
      page,
      editUrl,
      expectedCoverWidth,
      expectedCoverHeight,
    );
    return Object.freeze({
      content: true,
      cover: beforeReloadCover.status === "observed" &&
        afterReloadCover.status === "observed" &&
        sameArticleCoverObservation(
          beforeReloadCover.observation,
          afterReloadCover.observation,
        ) &&
        isExactArticleEditRoute(page, editUrl),
    });
  },
};

function validatedArticleEditUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = new URL(raw);
    const canonical = `${parsed.origin}${parsed.pathname}`;
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "x.com" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      !/^\/compose\/articles\/edit\/\d+$/.test(parsed.pathname) ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      raw !== canonical
    ) return null;
    return canonical;
  } catch {
    return null;
  }
}

const ARTICLE_EDIT_URL_POLL_ATTEMPTS = 21;
const ARTICLE_EDIT_URL_POLL_INTERVAL_MS = 125;

/** Poll for at most 2.5 seconds after the existing autosave settle. */
export async function waitForCanonicalArticleEditUrl(page: Page): Promise<string | null> {
  for (let attempt = 0; attempt < ARTICLE_EDIT_URL_POLL_ATTEMPTS; attempt += 1) {
    let current: string | null = null;
    try {
      current = validatedArticleEditUrl(page.url());
    } catch {
      return null;
    }
    if (current !== null) return current;
    if (attempt + 1 < ARTICLE_EDIT_URL_POLL_ATTEMPTS) {
      await page.waitForTimeout(ARTICLE_EDIT_URL_POLL_INTERVAL_MS);
    }
  }
  return null;
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

async function titleValueAtExactArticleRoute(
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
    return { routeExact: false };
  }
}

async function bodyTextAtExactArticleRoute(
  page: Page,
  locator: Locator,
  editUrl: string,
): Promise<ArticleTextObservation> {
  if (!isExactArticleEditRoute(page, editUrl)) return { routeExact: false };
  try {
    const text = await locator.innerText();
    if (!isExactArticleEditRoute(page, editUrl)) return { routeExact: false };
    return { routeExact: true, text };
  } catch {
    return { routeExact: false };
  }
}

/** Existing tolerant Article title/body whitespace and case normalization (issue #82). */
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
  const title = await uniqueVisibleArticleLocator(
    page,
    X_COMPOSER_SELECTORS.articleTitleInput,
    8_000,
    true,
  );
  if (!isExactArticleEditRoute(page, editUrl) || !title) return false;

  if (!isExactArticleEditRoute(page, editUrl)) return false;
  const body = await uniqueVisibleArticleLocator(
    page,
    X_COMPOSER_SELECTORS.articleBodyInput,
    8_000,
    false,
  );
  if (!isExactArticleEditRoute(page, editUrl) || !body) return false;

  const expectedTitleText = normalizeForMatch(expectedTitle);
  const expectedBodyText = normalizeForMatch(expectedBody);
  if (!expectedTitleText) return false;

  const titleObservation = await titleValueAtExactArticleRoute(page, title, editUrl);
  if (!titleObservation.routeExact) return false;
  const actualTitle = normalizeForMatch(titleObservation.text);

  const bodyObservation = await bodyTextAtExactArticleRoute(page, body, editUrl);
  if (!bodyObservation.routeExact) return false;
  const actualBody = normalizeForMatch(bodyObservation.text);
  if (!isExactArticleEditRoute(page, editUrl)) return false;
  return actualTitle === expectedTitleText &&
    actualBody === expectedBodyText;
}

function modifier(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control";
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

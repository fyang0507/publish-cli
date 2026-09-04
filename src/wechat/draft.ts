/**
 * WeChat article draft orchestration — the "poster" analog for the API-driven
 * WeChat channel (WECHAT_DESIGN §5). There is NO browser here: this ties the
 * deterministic content layer (src/wechat/content.ts) to the API backbone
 * (src/wechat/client.ts) and stages a NATIVE draft in the account's 草稿箱 via
 * `POST /cgi-bin/draft/add`. It STOPS at the draft — it never publishes/broadcasts
 * (the `freepublish/*` and `message/mass/*` families are FORBIDDEN and live only in
 * a boundary comment in client.ts; this module never touches them).
 *
 * Egress ownership stays in ONE place: the command owns createWeChatClient() +
 * client.close(); this function receives the already-bound client so the single
 * EgressHandle (proxy/SSH tunnel) is created and torn down exactly once per run.
 *
 * Upload ordering is deliberate (WECHAT_DESIGN §5): cover FIRST (it is required),
 * then body images, then draft/add. Every completed permanent/CDN upload is
 * retained as residue if a later step fails; no failure may claim it left no work.
 */

import { isProxy } from "node:util/types";
import {
  snapshotWeChatClientFailure,
  type WeChatClient,
} from "./client.js";
import {
  escapeHtmlAttribute,
  snapshotWechatGeneratedArticle,
  type GeneratedArticle,
} from "./content.js";
import { env } from "../config.js";
import { sanitizeServerMessage } from "../capabilities/validation.js";
import { GENERATED_DRAFT_ARRAY_MAX } from "../draftSnapshot.js";
import {
  createClosedSnapshotContext,
  snapshotBoundedString,
  snapshotClosedRecord,
  snapshotDenseArray,
  snapshotSafeInteger,
  TerminalProjectionError,
} from "../terminalOutput.js";

/** The 草稿箱 (draft box) landing spot for the operator's manual review + publish. */
const DRAFT_BOX_URL = "https://mp.weixin.qq.com/ (内容管理 → 草稿箱)";

export interface StageArticleOptions {
  /** `articles[].need_open_comment`; default env.WECHAT_NEED_OPEN_COMMENT. */
  needOpenComment?: number;
  /** `articles[].only_fans_can_comment`; default env.WECHAT_ONLY_FANS_CAN_COMMENT. */
  onlyFansCanComment?: number;
}

export type WeChatDraftStagePhase =
  | "token"
  | "cover_upload"
  | "body_image_upload"
  | "draft_add"
  | "complete";

export interface WeChatUploadedBodyEvidence {
  readonly index: number;
  readonly remoteReference: string;
}

/** Monotonic, path-free evidence captured before every awaited write boundary. */
export interface WeChatDraftStageProgress {
  readonly platformTouched: true;
  readonly phase: WeChatDraftStagePhase;
  readonly bodyImageCount: number;
  readonly tokenAttempted: true;
  readonly tokenReady: boolean;
  readonly coverUploadAttempted: boolean;
  readonly thumbMediaId: string | null;
  readonly bodyUploadAttemptedCount: number;
  readonly uploadedBodyImages: readonly WeChatUploadedBodyEvidence[];
  readonly draftAddAttempted: boolean;
  readonly draftMediaId: string | null;
}

export type WeChatDraftStageFailureKind = "api_rejection" | "delivery_unknown";

export interface WeChatDraftStageErrorSnapshot {
  readonly phase: Exclude<WeChatDraftStagePhase, "complete">;
  readonly failureKind: WeChatDraftStageFailureKind;
  readonly platformCode: string | null;
  readonly httpStatus: number | null;
  readonly sanitizedMessage: string;
  readonly progress: WeChatDraftStageProgress;
}

const MAX_WECHAT_REMOTE_REFERENCE = 8_192;
const WECHAT_DRAFT_STAGE_ERROR_INSTANCES = new WeakSet<object>();

function snapshotNullableReference(value: unknown, context: ReturnType<typeof createClosedSnapshotContext>): string | null {
  if (value === null) return null;
  const reference = snapshotBoundedString(value, MAX_WECHAT_REMOTE_REFERENCE, context);
  if (!reference) throw new TerminalProjectionError();
  return reference;
}

/** Close and verify monotonic progress without reading accessors or proxies. */
export function snapshotWeChatDraftStageProgress(value: unknown): WeChatDraftStageProgress | null {
  try {
    const context = createClosedSnapshotContext();
    return snapshotClosedRecord(
      value,
      [
        "platformTouched", "phase", "bodyImageCount", "tokenAttempted", "tokenReady",
        "coverUploadAttempted", "thumbMediaId", "bodyUploadAttemptedCount",
        "uploadedBodyImages", "draftAddAttempted", "draftMediaId",
      ],
      [],
      context,
      (reader) => {
        if (reader.read("platformTouched") !== true || reader.read("tokenAttempted") !== true) {
          throw new TerminalProjectionError();
        }
        const phase = reader.read("phase");
        if (
          phase !== "token" && phase !== "cover_upload" && phase !== "body_image_upload" &&
          phase !== "draft_add" && phase !== "complete"
        ) throw new TerminalProjectionError();
        const bodyImageCount = snapshotSafeInteger(reader.read("bodyImageCount"));
        const bodyUploadAttemptedCount = snapshotSafeInteger(reader.read("bodyUploadAttemptedCount"));
        if (bodyImageCount > GENERATED_DRAFT_ARRAY_MAX || bodyUploadAttemptedCount > bodyImageCount) {
          throw new TerminalProjectionError();
        }
        const tokenReady = reader.read("tokenReady");
        const coverUploadAttempted = reader.read("coverUploadAttempted");
        const draftAddAttempted = reader.read("draftAddAttempted");
        if (
          typeof tokenReady !== "boolean" || typeof coverUploadAttempted !== "boolean" ||
          typeof draftAddAttempted !== "boolean"
        ) throw new TerminalProjectionError();
        const thumbMediaId = snapshotNullableReference(reader.read("thumbMediaId"), context);
        const draftMediaId = snapshotNullableReference(reader.read("draftMediaId"), context);
        const uploadedBodyImages = snapshotDenseArray(
          reader.read("uploadedBodyImages"),
          GENERATED_DRAFT_ARRAY_MAX,
          context,
          (entry, index) => snapshotClosedRecord(
            entry,
            ["index", "remoteReference"],
            [],
            context,
            (item) => {
              if (item.read("index") !== index) throw new TerminalProjectionError();
              return Object.freeze({
                index,
                remoteReference: snapshotBoundedString(
                  item.read("remoteReference"),
                  MAX_WECHAT_REMOTE_REFERENCE,
                  context,
                ),
              });
            },
          ),
        );
        const phaseCoherent = phase === "token"
          ? !tokenReady && !coverUploadAttempted && thumbMediaId === null &&
            bodyUploadAttemptedCount === 0 && uploadedBodyImages.length === 0 && !draftAddAttempted
          : phase === "cover_upload"
            ? tokenReady && coverUploadAttempted && thumbMediaId === null &&
              bodyUploadAttemptedCount === 0 && uploadedBodyImages.length === 0 && !draftAddAttempted
            : phase === "body_image_upload"
              ? tokenReady && thumbMediaId !== null && bodyImageCount > 0 &&
                bodyUploadAttemptedCount === uploadedBodyImages.length + 1 && !draftAddAttempted
              : phase === "draft_add"
                ? tokenReady && thumbMediaId !== null &&
                  bodyUploadAttemptedCount === bodyImageCount && uploadedBodyImages.length === bodyImageCount &&
                  draftAddAttempted && draftMediaId === null
                : tokenReady && thumbMediaId !== null &&
                  bodyUploadAttemptedCount === bodyImageCount && uploadedBodyImages.length === bodyImageCount &&
                  draftAddAttempted && draftMediaId !== null;
        if (
          uploadedBodyImages.some((entry) => !entry.remoteReference) ||
          uploadedBodyImages.length > bodyUploadAttemptedCount ||
          bodyUploadAttemptedCount > uploadedBodyImages.length + 1 ||
          (!tokenReady && (coverUploadAttempted || thumbMediaId !== null || bodyUploadAttemptedCount > 0 || draftAddAttempted)) ||
          (thumbMediaId !== null && !coverUploadAttempted) ||
          (bodyUploadAttemptedCount > 0 && thumbMediaId === null) ||
          (draftAddAttempted && (thumbMediaId === null || uploadedBodyImages.length !== bodyImageCount)) ||
          (draftMediaId !== null && !draftAddAttempted) ||
          (phase === "complete" && draftMediaId === null) ||
          (phase !== "complete" && draftMediaId !== null) ||
          !phaseCoherent
        ) throw new TerminalProjectionError();
        return Object.freeze({
          platformTouched: true as const,
          phase,
          bodyImageCount,
          tokenAttempted: true as const,
          tokenReady,
          coverUploadAttempted,
          thumbMediaId,
          bodyUploadAttemptedCount,
          uploadedBodyImages,
          draftAddAttempted,
          draftMediaId,
        });
      },
    );
  } catch {
    return null;
  }
}

function closeProgress(value: WeChatDraftStageProgress): WeChatDraftStageProgress {
  const snapshot = snapshotWeChatDraftStageProgress(value);
  if (snapshot === null) throw new TerminalProjectionError();
  return snapshot;
}

/** Content-free typed stage failure carrying only closed progress and redacted API facts. */
export class WeChatDraftStageError extends Error {
  readonly code = "wechat_draft_stage_incomplete";
  readonly phase: Exclude<WeChatDraftStagePhase, "complete">;
  readonly failureKind: WeChatDraftStageFailureKind;
  readonly platformCode: string | null;
  readonly httpStatus: number | null;
  readonly sanitizedMessage: string;
  readonly progress: WeChatDraftStageProgress;

  constructor(snapshot: WeChatDraftStageErrorSnapshot) {
    super(
      snapshot.failureKind === "api_rejection"
        ? "WeChat explicitly rejected the current draft-staging request."
        : "WeChat request delivery or completion evidence is unknown.",
    );
    this.name = "WeChatDraftStageError";
    this.progress = closeProgress(snapshot.progress);
    if (
      this.progress.phase !== snapshot.phase ||
      (snapshot.failureKind !== "api_rejection" && snapshot.failureKind !== "delivery_unknown")
    ) {
      throw new TerminalProjectionError();
    }
    this.phase = snapshot.phase;
    this.failureKind = snapshot.failureKind;
    this.platformCode = snapshot.platformCode !== null &&
        /^(?:\d{1,10}|[a-z][a-z0-9_]{0,63})$/.test(snapshot.platformCode)
      ? snapshot.platformCode
      : null;
    this.httpStatus = snapshot.httpStatus !== null && Number.isSafeInteger(snapshot.httpStatus) &&
        snapshot.httpStatus >= 100 && snapshot.httpStatus <= 599
      ? snapshot.httpStatus
      : null;
    this.sanitizedMessage = sanitizeServerMessage(snapshot.sanitizedMessage) ||
      "WeChat returned no usable failure message.";
    WECHAT_DRAFT_STAGE_ERROR_INSTANCES.add(this);
    Object.freeze(this);
  }
}

export function snapshotWeChatDraftStageError(error: unknown): WeChatDraftStageErrorSnapshot | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return null;
  try {
    if (isProxy(error) || !WECHAT_DRAFT_STAGE_ERROR_INSTANCES.has(error)) return null;
    const read = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (!descriptor || !("value" in descriptor)) throw new TerminalProjectionError();
      return descriptor.value;
    };
    const phase = read("phase");
    const failureKind = read("failureKind");
    const platformCode = read("platformCode");
    const httpStatus = read("httpStatus");
    const sanitizedMessage = read("sanitizedMessage");
    const progress = snapshotWeChatDraftStageProgress(read("progress"));
    if (
      (phase !== "token" && phase !== "cover_upload" && phase !== "body_image_upload" && phase !== "draft_add") ||
      (failureKind !== "api_rejection" && failureKind !== "delivery_unknown") ||
      (platformCode !== null && typeof platformCode !== "string") ||
      (httpStatus !== null && !Number.isSafeInteger(httpStatus)) ||
      typeof sanitizedMessage !== "string" || progress === null || progress.phase !== phase
    ) return null;
    return Object.freeze({
      phase,
      failureKind,
      platformCode,
      httpStatus: httpStatus as number | null,
      sanitizedMessage,
      progress,
    });
  } catch {
    return null;
  }
}

export interface StageArticleResult {
  /** Draft media_id returned by `/cgi-bin/draft/add`. */
  readonly mediaId: string;
  /** Cover permanent-material media_id (the article's `thumb_media_id`). */
  readonly thumbMediaId: string;
  /** Body-image rewrites applied: each local path and the WeChat CDN URL it became. */
  readonly uploadedImages: readonly Readonly<{ local: string; url: string }>[];
  /** Where the operator reviews + (manually) publishes the staged draft. */
  readonly draftBoxUrl: string;
  readonly progress: WeChatDraftStageProgress;
}

/** Close a returned success before command rendering can observe mutable data. */
export function snapshotStageArticleResult(
  value: unknown,
  expectedArticle: GeneratedArticle,
): StageArticleResult | null {
  try {
    const article = snapshotWechatGeneratedArticle(expectedArticle);
    const context = createClosedSnapshotContext();
    return snapshotClosedRecord(
      value,
      ["mediaId", "thumbMediaId", "uploadedImages", "draftBoxUrl", "progress"],
      [],
      context,
      (reader) => {
        const mediaId = snapshotBoundedString(reader.read("mediaId"), MAX_WECHAT_REMOTE_REFERENCE, context);
        const thumbMediaId = snapshotBoundedString(reader.read("thumbMediaId"), MAX_WECHAT_REMOTE_REFERENCE, context);
        const draftBoxUrl = snapshotBoundedString(reader.read("draftBoxUrl"), 500, context);
        if (!mediaId || !thumbMediaId || draftBoxUrl !== DRAFT_BOX_URL) {
          throw new TerminalProjectionError();
        }
        const uploadedImages = snapshotDenseArray(
          reader.read("uploadedImages"),
          GENERATED_DRAFT_ARRAY_MAX,
          context,
          (entry, index) => snapshotClosedRecord(
            entry,
            ["local", "url"],
            [],
            context,
            (image) => Object.freeze({
              local: snapshotBoundedString(image.read("local"), 100_000, context),
              url: snapshotBoundedString(image.read("url"), MAX_WECHAT_REMOTE_REFERENCE, context),
            }),
          ),
        );
        const progress = snapshotWeChatDraftStageProgress(reader.read("progress"));
        if (
          uploadedImages.length !== article.bodyImages.length || progress === null ||
          progress.phase !== "complete" || progress.bodyImageCount !== article.bodyImages.length ||
          progress.draftMediaId !== mediaId || progress.thumbMediaId !== thumbMediaId ||
          uploadedImages.some((entry, index) =>
            !entry.url || entry.local !== article.bodyImages[index]!.src ||
            progress.uploadedBodyImages[index]?.remoteReference !== entry.url)
        ) throw new TerminalProjectionError();
        return Object.freeze({ mediaId, thumbMediaId, uploadedImages, draftBoxUrl, progress });
      },
    );
  } catch {
    return null;
  }
}

/** Rewrite only generated image elements, never matching text/code elsewhere in the article. */
function rewriteGeneratedImageSource(html: string, htmlSrc: string, uploadedUrl: string): string {
  const sourceAttribute = `src="${htmlSrc}"`;
  const replacement = `src="${escapeHtmlAttribute(uploadedUrl)}"`;
  return html.replace(/<img\b[^>]*>/g, (imageTag) =>
    imageTag.includes(sourceAttribute)
      ? imageTag.split(sourceAttribute).join(replacement)
      : imageTag);
}

/**
 * Real-run orchestration. Ordered so progress can identify every completed or
 * uncertain remote artifact:
 *   1) client.ensureToken()
 *   2) thumbMediaId = client.uploadCover(article.coverPath)   // cover first (required)
 *   3) for each article.bodyImages[]: url = client.uploadBodyImage(p); rewrite that <img src> in html
 *   4) client.addDraft({ articles: [ { article_type:"news", ...article, content: rewrittenHtml,
 *                        thumb_media_id, need_open_comment, only_fans_can_comment } ] })
 *   5) return { mediaId, thumbMediaId, uploadedImages, draftBoxUrl }
 * Never calls any FORBIDDEN endpoint (freepublish/*, message/mass/*).
 */
export async function stageArticleDraft(
  client: WeChatClient,
  article: GeneratedArticle,
  opts: StageArticleOptions = {},
): Promise<StageArticleResult> {
  article = snapshotWechatGeneratedArticle(article);
  const needOpenComment = opts.needOpenComment ?? env.WECHAT_NEED_OPEN_COMMENT;
  const onlyFansCanComment = opts.onlyFansCanComment ?? env.WECHAT_ONLY_FANS_CAN_COMMENT;

  let tokenReady = false;
  let coverUploadAttempted = false;
  let thumbMediaId: string | null = null;
  let bodyUploadAttemptedCount = 0;
  const uploadedBodyImages: WeChatUploadedBodyEvidence[] = [];
  let draftAddAttempted = false;

  const progress = (
    phase: WeChatDraftStagePhase,
    draftMediaId: string | null = null,
  ): WeChatDraftStageProgress => closeProgress({
    platformTouched: true,
    phase,
    bodyImageCount: article.bodyImages.length,
    tokenAttempted: true,
    tokenReady,
    coverUploadAttempted,
    thumbMediaId,
    bodyUploadAttemptedCount,
    uploadedBodyImages,
    draftAddAttempted,
    draftMediaId,
  });

  const fail = (
    phase: Exclude<WeChatDraftStagePhase, "complete">,
    error: unknown,
  ): never => {
    const clientFailure = snapshotWeChatClientFailure(error);
    throw new WeChatDraftStageError({
      phase,
      failureKind: clientFailure?.kind ?? "delivery_unknown",
      platformCode: clientFailure?.code ?? null,
      httpStatus: clientFailure?.httpStatus ?? null,
      sanitizedMessage: clientFailure?.sanitizedMessage ??
        "WeChat request delivery or the returned completion evidence is unknown.",
      progress: progress(phase),
    });
  };

  const returnedReference = (value: unknown): string => {
    const context = createClosedSnapshotContext();
    const reference = snapshotBoundedString(value, MAX_WECHAT_REMOTE_REFERENCE, context);
    if (!reference) throw new TerminalProjectionError();
    return reference;
  };

  const runStep = async <T>(
    phase: Exclude<WeChatDraftStagePhase, "complete">,
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      return fail(phase, error);
    }
  };

  // 1) Ensure a valid access token before spending any upload/quota work.
  await runStep("token", async () => returnedReference(await client.ensureToken()));
  tokenReady = true;

  // 2) Cover FIRST — it is required for article_type=news, so a 40164/quota failure
  //    here aborts before any body-image upload (no dangling material).
  coverUploadAttempted = true;
  const uploadedThumbMediaId = await runStep(
    "cover_upload",
    async () => returnedReference(await client.uploadCover(article.coverPath)),
  );
  thumbMediaId = uploadedThumbMediaId;

  // 3) Upload each local body image and rewrite its <img src> to the WeChat CDN URL.
  //    Each bodyImages entry carries the raw parser `src` for receipt identity, the
  //    exact escaped `htmlSrc` emitted into the attribute for matching, and its
  //    resolved filesystem `path` for reading. The uploaded URL is escaped before
  //    insertion as well, so neither caller paths nor API values can break markup.
  let html = article.html;
  const uploadedImages: { local: string; url: string }[] = [];
  for (let index = 0; index < article.bodyImages.length; index += 1) {
    const img = article.bodyImages[index]!;
    bodyUploadAttemptedCount = index + 1;
    const url = await runStep(
      "body_image_upload",
      async () => returnedReference(await client.uploadBodyImage(img.path)),
    );
    html = rewriteGeneratedImageSource(html, img.htmlSrc, url);
    uploadedImages.push(Object.freeze({ local: img.src, url }));
    uploadedBodyImages.push(Object.freeze({ index, remoteReference: url }));
  }

  // 4) Assemble + send the draft/add payload. Optional fields are omitted when empty
  //    so the API sees a clean article object.
  draftAddAttempted = true;
  const mediaId = await runStep("draft_add", async () => returnedReference(await client.addDraft({
      articles: [
        {
          article_type: "news",
          title: article.title,
          ...(article.author ? { author: article.author } : {}),
          ...(article.digest ? { digest: article.digest } : {}),
          content: html,
          ...(article.sourceUrl ? { content_source_url: article.sourceUrl } : {}),
          thumb_media_id: uploadedThumbMediaId,
          need_open_comment: needOpenComment,
          only_fans_can_comment: onlyFansCanComment,
        },
      ],
    })));

  // 5) Report back — the command prints the media_id + the 草稿箱 URL. NEVER published.
  return Object.freeze({
    mediaId,
    thumbMediaId: uploadedThumbMediaId,
    uploadedImages: Object.freeze(uploadedImages),
    draftBoxUrl: DRAFT_BOX_URL,
    progress: progress("complete", mediaId),
  });
}

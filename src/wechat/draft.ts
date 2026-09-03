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
 * then body images, then draft/add — so an IP-allowlist (40164) or quota failure
 * aborts BEFORE partial work, leaving no dangling half-assembled draft.
 */

import type { WeChatClient } from "./client.js";
import { escapeHtmlAttribute, type GeneratedArticle } from "./content.js";
import { env } from "../config.js";

/** The 草稿箱 (draft box) landing spot for the operator's manual review + publish. */
const DRAFT_BOX_URL = "https://mp.weixin.qq.com/ (内容管理 → 草稿箱)";

export interface StageArticleOptions {
  /** `articles[].need_open_comment`; default env.WECHAT_NEED_OPEN_COMMENT. */
  needOpenComment?: number;
  /** `articles[].only_fans_can_comment`; default env.WECHAT_ONLY_FANS_CAN_COMMENT. */
  onlyFansCanComment?: number;
}

export interface StageArticleResult {
  /** Draft media_id returned by `/cgi-bin/draft/add`. */
  mediaId: string;
  /** Cover permanent-material media_id (the article's `thumb_media_id`). */
  thumbMediaId: string;
  /** Body-image rewrites applied: each local path and the WeChat CDN URL it became. */
  uploadedImages: { local: string; url: string }[];
  /** Where the operator reviews + (manually) publishes the staged draft. */
  draftBoxUrl: string;
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
 * Real-run orchestration. Ordered so a 40164/quota failure aborts BEFORE partial
 * work:
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
  const needOpenComment = opts.needOpenComment ?? env.WECHAT_NEED_OPEN_COMMENT;
  const onlyFansCanComment = opts.onlyFansCanComment ?? env.WECHAT_ONLY_FANS_CAN_COMMENT;

  // 1) Ensure a valid access token before spending any upload/quota work.
  await client.ensureToken();

  // 2) Cover FIRST — it is required for article_type=news, so a 40164/quota failure
  //    here aborts before any body-image upload (no dangling material).
  const thumbMediaId = await client.uploadCover(article.coverPath);

  // 3) Upload each local body image and rewrite its <img src> to the WeChat CDN URL.
  //    Each bodyImages entry carries the raw parser `src` for receipt identity, the
  //    exact escaped `htmlSrc` emitted into the attribute for matching, and its
  //    resolved filesystem `path` for reading. The uploaded URL is escaped before
  //    insertion as well, so neither caller paths nor API values can break markup.
  let html = article.html;
  const uploadedImages: { local: string; url: string }[] = [];
  for (const img of article.bodyImages) {
    const url = await client.uploadBodyImage(img.path);
    html = rewriteGeneratedImageSource(html, img.htmlSrc, url);
    uploadedImages.push({ local: img.src, url });
  }

  // 4) Assemble + send the draft/add payload. Optional fields are omitted when empty
  //    so the API sees a clean article object.
  const mediaId = await client.addDraft({
    articles: [
      {
        article_type: "news",
        title: article.title,
        ...(article.author ? { author: article.author } : {}),
        ...(article.digest ? { digest: article.digest } : {}),
        content: html,
        ...(article.sourceUrl ? { content_source_url: article.sourceUrl } : {}),
        thumb_media_id: thumbMediaId,
        need_open_comment: needOpenComment,
        only_fans_can_comment: onlyFansCanComment,
      },
    ],
  });

  // 5) Report back — the command prints the media_id + the 草稿箱 URL. NEVER published.
  return { mediaId, thumbMediaId, uploadedImages, draftBoxUrl: DRAFT_BOX_URL };
}

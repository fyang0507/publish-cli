/**
 * WeChat Official Account article generation — DETERMINISTIC, plain-code
 * transformation of canonical markdown into a native WeChat article draft
 * ({title, author, digest, inline-styled HTML body, cover, body images}). NO LLM
 * is involved in any decision that affects correctness (metadata resolution, char
 * counting, HTML rendering, link→citation rewrite, image collection) so output is
 * reproducible and verifiable — exactly like the X, LinkedIn, and Reddit content
 * generators (src/x/content.ts, src/linkedin/content.ts, src/reddit/content.ts).
 *
 * KEY DIVERGENCE FROM THE OTHER CHANNELS: WeChat article bodies are **rich HTML**
 * (X/LinkedIn emit plain text; Reddit keeps Markdown verbatim). WeChat's editor
 * **strips `<style>` blocks, `<link>` tags, and CSS classes**, so every visual
 * rule MUST be an inline `style="…"` attribute on the element itself. This module
 * therefore hosts the toolkit's one real markdown → inline-styled-HTML renderer
 * (a `marked` renderer override that emits only inline styles). One readable
 * default look; themes/color presets are deferred (WECHAT_DESIGN §8).
 *
 * REUSE: parseBaseMarkdown() is imported from ../x/content.js for deterministic
 * body parsing and leading-H1 title derivation. File/stdin frontmatter is
 * classified by the shared content-input seam before this generator is called,
 * then supplied as an already-parsed mapping. Same reuse posture as
 * LinkedIn/Reddit (by import, never by editing X).
 *
 * WeChat rules (WECHAT_DESIGN §4):
 *   - title: REQUIRED. --title → frontmatter `title` → leading Markdown H1.
 *     WeChat documents 32 字; exact measurement is server-authoritative.
 *   - author: --author → frontmatter `author` → WECHAT_AUTHOR env → "". WeChat
 *     documents 16 字; exact measurement is server-authoritative.
 *   - digest (摘要): --digest → frontmatter `description`/`summary`. WeChat
 *     documents 120 字; exact measurement is server-authoritative. When omitted,
 *     leave it empty so WeChat derives its documented first 54 字.
 *   - cover (封面 / thumb_media_id): --cover → frontmatter `coverImage`/`cover`/
 *     `image`. REQUIRED for article_type=news; unresolved => ERROR.
 *   - source url (阅读原文): --source-url → frontmatter `sourceUrl`/
 *     `contentSourceUrl`. Optional.
 *   - Links: external `<a href>` (host ≠ mp.weixin.qq.com) are, by default,
 *     rewritten to bottom numbered citations (WeChat deactivates most external
 *     links in article bodies). `keepLinks` opts out; mp.weixin.qq.com links are
 *     ALWAYS kept inline.
 *   - Images: local `<img>` paths are collected for upload+rewrite by draft.ts;
 *     remote `http(s)://` images are flagged as a warning and left as-is this phase.
 */

import { parseBaseMarkdown, type LinkFlag } from "../x/content.js";
import { resolve as resolvePath } from "node:path";
import { marked, Renderer } from "marked";
import {
  LocalValidationError,
  WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS,
  assertWechatLocalImage,
  type LocalImageValidationResult,
} from "../capabilities/validation.js";

/** WeChat's own article domain — links here are always kept inline (never cited). */
const WECHAT_HOST = "mp.weixin.qq.com";

/**
 * Flag overrides for generateArticle. Each metadata field falls back to a markdown
 * frontmatter field (see the per-field fallback chains above / in the docstring).
 */
export interface GenerateArticleOptions {
  /** --title → frontmatter `title` → leading H1. REQUIRED (throws if unresolved). */
  title?: string;
  /** --author → frontmatter `author` → env.WECHAT_AUTHOR → "". */
  author?: string;
  /** --digest → frontmatter `description`/`summary`; omission delegates derivation to WeChat. */
  digest?: string;
  /** --cover → frontmatter `coverImage`/`cover`/`image`. REQUIRED (throws if unresolved). */
  cover?: string;
  /** --source-url → frontmatter `sourceUrl`/`contentSourceUrl`. Optional. */
  sourceUrl?: string;
  /** Parsed file/stdin metadata from the shared frontmatter seam. Inline text omits this. */
  frontmatter?: Record<string, unknown>;
  /** false (default) => external links → bottom citations; true => leave inline. */
  keepLinks?: boolean;
  /**
   * Directory that relative cover / body-image paths resolve against — normally the
   * directory of the `--from` markdown file, so `![](./imgs/x.png)` and a frontmatter
   * `coverImage: ./cover.png` load next to the article, not from the process CWD.
   * Defaults to `process.cwd()` (the right base for inline `--text`).
   */
  baseDir?: string;
}

/** A local body image: the verbatim html `src` (for rewrite matching) + its resolved path (for reading). */
export interface BodyImage {
  /** The `<img src>` exactly as it appears in the rendered html (raw markdown value) — draft.ts string-matches on this. */
  src: string;
  /** The resolved local filesystem path (absolute, against `baseDir`) — the client reads this to upload. */
  path: string;
  /** Locally measured header facts; platform acceptance limits remain unknown. */
  validation: LocalImageValidationResult;
}

interface PendingBodyImage {
  src: string;
  path: string;
}

/** Result of a WeChat article generation run. */
export interface GeneratedArticle {
  /** The article title; WeChat's documented 字 boundary is server-authoritative. */
  title: string;
  /** The author ("" when none supplied). */
  author: string;
  /** The explicit digest, or empty so WeChat can derive its documented first 54 字. */
  digest: string;
  /** Inline-styled HTML body. `<img src>` still points at LOCAL paths (draft.ts rewrites). */
  html: string;
  /** Resolved local cover path (absolute) — draft.ts uploads it as thumb_media_id. */
  coverPath: string;
  /** Locally measured cover facts; platform acceptance limits remain unknown. */
  coverValidation: LocalImageValidationResult;
  /** content_source_url (阅读原文), if any. */
  sourceUrl?: string;
  /** LOCAL images referenced by `<img>` in html, first-seen order (draft.ts uploads + rewrites). */
  bodyImages: BodyImage[];
  /** Links surfaced with an informational note (reuses the shared type). */
  linkFlags: LinkFlag[];
  /** Non-fatal advisories (omitted digest, links→citations, remote image found, …). Never silent. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter metadata + markdown helpers (deterministic, dependency-light)
// ---------------------------------------------------------------------------

const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
// Bare URL not already inside a markdown-link's () or a ("...) attribute.
const BARE_URL_RE = /(?<![("])\bhttps?:\/\/[^\s)]+/g;
/** Frontmatter fields WeChat reads (each overridable by a flag). */
interface Frontmatter {
  title?: string;
  author?: string;
  digest?: string;
  cover?: string;
  sourceUrl?: string;
}

/** Read a string field from a parsed frontmatter record, trying several aliases. */
function pickString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/** Preserve the existing WeChat aliases while ignoring unrelated/non-string metadata. */
function normalizeFrontmatter(rec: Record<string, unknown>): Frontmatter {
  return {
    title: pickString(rec, ["title"]),
    author: pickString(rec, ["author"]),
    digest: pickString(rec, ["description", "summary", "digest"]),
    cover: pickString(rec, ["coverImage", "cover", "image"]),
    sourceUrl: pickString(rec, ["sourceUrl", "contentSourceUrl", "source_url"]),
  };
}

/** Return the first non-blank line of the body, if any. */
function firstNonBlankLine(body: string): string | undefined {
  return body.replace(/\r\n?/g, "\n").split("\n").find((l) => l.trim());
}

/** Strip the first leading H1 line (`# ...`), skipping any leading blank lines. */
function stripLeadingH1(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^\s*#\s+.+$/.test(lines[i])) lines.splice(i, 1);
  return lines.join("\n");
}

/** Trim leading/trailing blank lines but keep the internal markdown verbatim. */
function trimBlankEdges(text: string): string {
  return text.replace(/^\n+/, "").replace(/\n+$/, "");
}

/** Is this an external `http(s)://` URL (candidate for citation / remote-image)? */
function isHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

/** Is this a WeChat-native (mp.weixin.qq.com) link (always kept inline)? */
function isWeChatLink(href: string): boolean {
  try {
    return new URL(href).hostname.toLowerCase() === WECHAT_HOST;
  } catch {
    return false;
  }
}

/** HTML-escape text content (`&`, `<`, `>`). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML-escape an attribute value (adds `"`). */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/** Strip HTML tags from a rendered inline fragment (for plain-text citation labels). */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

/**
 * Collect link advisory flags from the body markdown (both `[text](url)` and bare
 * URLs), deduped by URL, with a WeChat-appropriate note. Informational only —
 * generation never fails on a link.
 */
function collectLinkFlags(body: string): LinkFlag[] {
  const flags: LinkFlag[] = [];
  const seen = new Set<string>();
  const note =
    "WeChat deactivates most external links in article bodies (non-whitelisted domains " +
    "are not clickable). By default external links are moved to bottom citations; use " +
    "--keep-links to keep them inline. mp.weixin.qq.com links are always kept inline.";

  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(body)) !== null) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({ url, text: m[1] || undefined, note });
  }

  BARE_URL_RE.lastIndex = 0;
  while ((m = BARE_URL_RE.exec(body)) !== null) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({ url, note });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Inline-styled HTML renderer (marked v18 token-object renderer API)
// ---------------------------------------------------------------------------

/**
 * The single readable default look. EVERY block/inline element carries an inline
 * `style="…"` (no `<style>`, no `class`, no `<link>` — WeChat strips them all).
 */
const S = {
  h1: "font-size:22px;font-weight:700;line-height:1.4;margin:28px 0 16px;color:#1a1a1a;",
  h2: "font-size:20px;font-weight:700;line-height:1.4;margin:26px 0 14px;color:#1a1a1a;",
  h3: "font-size:18px;font-weight:600;line-height:1.4;margin:22px 0 12px;color:#1a1a1a;",
  h4: "font-size:16px;font-weight:600;line-height:1.4;margin:20px 0 10px;color:#1a1a1a;",
  p: "font-size:16px;line-height:1.75;margin:0 0 16px;color:#333333;",
  blockquote:
    "margin:0 0 16px;padding:8px 16px;border-left:4px solid #d0d0d0;background:#f7f7f7;color:#666666;",
  ul: "margin:0 0 16px;padding-left:24px;font-size:16px;line-height:1.75;color:#333333;",
  ol: "margin:0 0 16px;padding-left:24px;font-size:16px;line-height:1.75;color:#333333;",
  li: "margin:4px 0;",
  pre: "margin:0 0 16px;padding:14px 16px;background:#f6f8fa;border-radius:6px;overflow-x:auto;",
  preCode:
    "font-family:Consolas,Menlo,Monaco,'Courier New',monospace;font-size:14px;line-height:1.5;color:#24292e;white-space:pre;",
  code:
    "padding:2px 6px;background:#f2f2f2;border-radius:3px;font-family:Consolas,Menlo,Monaco,'Courier New',monospace;font-size:90%;color:#c7254e;",
  strong: "font-weight:700;",
  em: "font-style:italic;",
  a: "color:#576b95;text-decoration:none;",
  img: "max-width:100%;height:auto;display:block;margin:16px auto;border-radius:4px;",
  sup: "color:#576b95;font-size:75%;",
  citeSection: "margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e5e5;",
  citeHeading: "font-size:14px;font-weight:600;margin:0 0 8px;color:#888888;",
  citeList: "margin:0;padding-left:24px;font-size:13px;line-height:1.7;color:#888888;",
  citeItem: "margin:2px 0;word-break:break-all;",
};

/** A collected bottom citation for an external link. */
interface Citation {
  index: number;
  url: string;
  label: string;
}

/** Mutable state shared across a single render pass (populated by the renderer). */
interface RenderContext {
  keepLinks: boolean;
  /** Base dir for resolving relative local image paths (the markdown file's dir, or cwd). */
  baseDir: string;
  /** Collected during rendering; validated only after marked.parse returns. */
  bodyImages: PendingBodyImage[];
  remoteImages: string[];
  citations: Citation[];
  citeByUrl: Map<string, number>;
}

/**
 * Build a marked Renderer that emits ONLY inline-styled HTML. Methods are
 * `function`s (not arrows) so `this.parser` binds to the active parser for inline/
 * block child rendering. Link/image handling mutates `ctx` (citations, images).
 */
function buildRenderer(ctx: RenderContext): Renderer {
  const r = new Renderer();

  r.heading = function (t) {
    const lvl = Math.min(t.depth, 4);
    const style = lvl === 1 ? S.h1 : lvl === 2 ? S.h2 : lvl === 3 ? S.h3 : S.h4;
    return `<h${t.depth} style="${style}">${this.parser.parseInline(t.tokens)}</h${t.depth}>`;
  };

  r.paragraph = function (t) {
    return `<p style="${S.p}">${this.parser.parseInline(t.tokens)}</p>`;
  };

  r.blockquote = function (t) {
    return `<blockquote style="${S.blockquote}">${this.parser.parse(t.tokens)}</blockquote>`;
  };

  r.list = function (t) {
    const tag = t.ordered ? "ol" : "ul";
    const style = t.ordered ? S.ol : S.ul;
    const startAttr =
      t.ordered && typeof t.start === "number" && t.start !== 1 ? ` start="${t.start}"` : "";
    let body = "";
    for (const item of t.items) body += this.listitem(item);
    return `<${tag}${startAttr} style="${style}">${body}</${tag}>`;
  };

  r.listitem = function (item) {
    return `<li style="${S.li}">${this.parser.parse(item.tokens)}</li>`;
  };

  r.code = function (t) {
    return `<pre style="${S.pre}"><code style="${S.preCode}">${escapeHtml(t.text)}</code></pre>`;
  };

  r.codespan = function (t) {
    return `<code style="${S.code}">${escapeHtml(t.text)}</code>`;
  };

  r.strong = function (t) {
    return `<strong style="${S.strong}">${this.parser.parseInline(t.tokens)}</strong>`;
  };

  r.em = function (t) {
    return `<em style="${S.em}">${this.parser.parseInline(t.tokens)}</em>`;
  };

  r.link = function (t) {
    const label = this.parser.parseInline(t.tokens);
    const href = t.href || "";
    // Kept inline: WeChat-native links always; everything when --keep-links; and
    // any non-http(s) href (relative/anchor/mailto — citations don't apply).
    if (ctx.keepLinks || isWeChatLink(href) || !isHttpUrl(href)) {
      return `<a href="${escapeAttr(href)}" style="${S.a}">${label}</a>`;
    }
    // External link → bottom citation (deduped by URL).
    let n = ctx.citeByUrl.get(href);
    if (n === undefined) {
      n = ctx.citeByUrl.size + 1;
      ctx.citeByUrl.set(href, n);
      ctx.citations.push({ index: n, url: href, label: stripTags(label) });
    }
    return `${label}<sup style="${S.sup}">[${n}]</sup>`;
  };

  r.image = function (t) {
    const href = t.href || "";
    const alt = escapeAttr(t.text ?? "");
    if (isHttpUrl(href)) {
      // Remote image: flagged (a published article would drop it), left as-is.
      ctx.remoteImages.push(href);
      return `<img src="${escapeAttr(href)}" alt="${alt}" style="${S.img}">`;
    }
    // Local image: keep the src VERBATIM in the html so draft.ts can string-match +
    // rewrite it to the uploaded WeChat CDN URL. Collect the raw src PLUS its path
    // resolved against baseDir (the markdown file's dir) so the client reads the file
    // next to the article, not from the process CWD (first-seen order, deduped by
    // src). Do not validate inside a Renderer callback: Marked catches renderer
    // exceptions and appends its own bug-report text, polluting our typed local
    // validation message.
    if (!ctx.bodyImages.some((b) => b.src === href)) {
      const path = resolvePath(ctx.baseDir, href);
      ctx.bodyImages.push({ src: href, path });
    }
    return `<img src="${href}" alt="${alt}" style="${S.img}">`;
  };

  return r;
}

/** Render the trailing numbered citation list appended after the body. */
function renderCitations(citations: Citation[]): string {
  if (citations.length === 0) return "";
  const items = citations
    .map((c) => {
      const prefix = c.label ? `${escapeHtml(c.label)} — ` : "";
      return `<li style="${S.citeItem}">${prefix}${escapeHtml(c.url)}</li>`;
    })
    .join("");
  return (
    `<section style="${S.citeSection}">` +
    `<p style="${S.citeHeading}">References</p>` +
    `<ol style="${S.citeList}">${items}</ol>` +
    `</section>`
  );
}

// ---------------------------------------------------------------------------
// Public API: generation
// ---------------------------------------------------------------------------

/**
 * Generate a WeChat article draft from normalized canonical markdown.
 * Deterministic (no LLM, no network). Applies opts overrides over parsed
 * file/stdin frontmatter, renders the body to inline-styled HTML, and resolves
 * all metadata. The command owns frontmatter classification so inline --text
 * remains literal and malformed input fails before this renderer reads assets.
 *
 * THROWS (usage error; the command maps this to exit 2) on:
 *   - a missing/unresolved title,
 *   - a missing/unresolved cover.
 * WeChat documents title/author/digest limits in 字 without defining a Unicode
 * measurement, so those boundaries remain server-authoritative rather than
 * being guessed as code points.
 */
export function generateArticle(md: string, opts: GenerateArticleOptions = {}): GeneratedArticle {
  const warnings: string[] = [];
  const data = normalizeFrontmatter(opts.frontmatter ?? {});
  const afterFm = md;

  // Reuse the shared parser for the leading-H1 title derivation (like reddit).
  const parsed = parseBaseMarkdown(afterFm);
  const first = firstNonBlankLine(afterFm);
  const leadingH1 = first ? /^\s*#\s+(.+)$/.exec(first) : null;
  const h1Title = leadingH1 ? parsed.title : undefined;

  // --- title (REQUIRED) ---
  const optTitle = opts.title?.trim();
  const fmTitle = data.title?.trim();
  const title = optTitle || fmTitle || h1Title;
  const titleFromH1 = !optTitle && !fmTitle && !!h1Title;
  if (!title) {
    throw new LocalValidationError(
      "WeChat article requires a title: pass --title, add a `title:` frontmatter field, " +
        "or start the markdown with an H1 (`# ...`).",
      {
        code: "wechat_title_missing",
        field: "title",
        actual: null,
        expected: "non-empty --title, title frontmatter, or leading H1",
        unit: null,
      },
    );
  }
  // Relative cover / body-image paths resolve against the markdown file's dir
  // (opts.baseDir), falling back to the process CWD (correct for inline --text).
  const baseDir = opts.baseDir ?? process.cwd();

  // --- cover (REQUIRED) ---
  const coverRaw = (opts.cover ?? data.cover)?.trim();
  if (!coverRaw) {
    throw new LocalValidationError(
      "WeChat article requires a cover image (封面 / thumb_media_id): pass --cover <image.(bmp|png|jpg|jpeg|gif)>, " +
        "or add a `coverImage`/`cover`/`image` frontmatter field.",
      {
        code: "wechat_cover_missing",
        field: "media",
        actual: null,
        expected: "one local BMP, PNG, JPEG, or GIF cover image",
        unit: null,
      },
    );
  }
  const coverPath = resolvePath(baseDir, coverRaw);
  const coverValidation = assertWechatLocalImage(coverPath, "cover");

  // --- author ---
  const author = (opts.author ?? data.author ?? "").trim();

  // --- body markdown (strip a leading H1 only when it was consumed as the title) ---
  const bodyMarkdown = trimBlankEdges(titleFromH1 ? stripLeadingH1(afterFm) : afterFm);

  // --- render body → inline-styled HTML ---
  const ctx: RenderContext = {
    keepLinks: !!opts.keepLinks,
    baseDir,
    bodyImages: [],
    remoteImages: [],
    citations: [],
    citeByUrl: new Map(),
  };
  const renderer = buildRenderer(ctx);
  const bodyHtml = marked.parse(bodyMarkdown, { renderer }) as string;
  // Validate outside Marked's renderer call stack so LocalValidationError text
  // and structured actual/expected/unit evidence pass through unchanged.
  const bodyImages: BodyImage[] = ctx.bodyImages.map((image) => ({
    ...image,
    validation: assertWechatLocalImage(image.path, "body"),
  }));
  const html = bodyHtml + renderCitations(ctx.citations);

  // --- digest (摘要) ---
  const explicitDigest = (opts.digest ?? data.digest)?.trim();
  let digest: string;
  if (explicitDigest) {
    digest = explicitDigest;
  } else {
    digest = "";
    warnings.push(
      "Digest not supplied — leaving it omitted so WeChat can derive the first 54 字 from the body. " +
        "Exact 字 measurement remains server-authoritative.",
    );
  }

  // --- advisories: citations + remote images ---
  if (!opts.keepLinks && ctx.citations.length > 0) {
    warnings.push(
      `${ctx.citations.length} external link(s) were moved to bottom citations (WeChat deactivates ` +
        `most external links in article bodies). Use --keep-links to keep them inline.`,
    );
  }
  if (ctx.remoteImages.length > 0) {
    warnings.push(
      `${ctx.remoteImages.length} remote image(s) (${ctx.remoteImages
        .map((u) => u)
        .join(", ")}) are left as-is — WeChat only serves images it hosts, so a published ` +
        `article would drop them. Reference local image files instead (auto reupload is a follow-up).`,
    );
  }
  const linkFlags = collectLinkFlags(bodyMarkdown);

  return {
    title,
    author,
    digest,
    html,
    coverPath,
    coverValidation,
    sourceUrl: (opts.sourceUrl ?? data.sourceUrl)?.trim() || undefined,
    bodyImages,
    linkFlags,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Public API: inspection dump
// ---------------------------------------------------------------------------

/**
 * Render a GeneratedArticle to a human-readable inspection string (used by
 * --dry-run echo and the draft command's success report). Mirrors X's
 * renderForInspection and Reddit's renderSelfPostForInspection.
 */
export function renderArticleForInspection(a: GeneratedArticle): string {
  const out: string[] = [];
  out.push("format: article (article_type=news)");
  out.push(`title (documented 32 字; server-authoritative measurement): ${a.title}`);
  out.push(`author: ${a.author || "(none)"}`);
  out.push(`digest (documented 120 字; omitted => first 54 字): ${a.digest || "(omitted)"}`);
  out.push("", "── local image validation ──");
  out.push(
    `cover: ${a.coverPath}`,
    `  ${a.coverValidation.contentType}; ${a.coverValidation.width}x${a.coverValidation.height}; ` +
      `${a.coverValidation.sizeBytes} bytes; aspect ${a.coverValidation.aspectRatio?.toFixed(4)}`,
  );
  if (a.sourceUrl) out.push(`source url (阅读原文): ${a.sourceUrl}`);

  if (a.bodyImages.length) {
    out.push("", `── body images (${a.bodyImages.length}, uploaded to WeChat on a real run) ──`);
    for (const img of a.bodyImages) {
      out.push(
        img.src === img.path ? `  ${img.src}` : `  ${img.src}  →  ${img.path}`,
        `    ${img.validation.contentType}; ${img.validation.width}x${img.validation.height}; ` +
          `${img.validation.sizeBytes} bytes; aspect ${img.validation.aspectRatio?.toFixed(4)}`,
      );
    }
  }

  out.push(
    "locally verified: readable file, magic/header type, extension match, dimensions, bytes, caller order",
    `server-authoritative/unverified: ${WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS.join(", ")}`,
  );

  out.push("", "── HTML body (inline-styled; <img src> rewritten on a real run) ──", a.html);

  if (a.linkFlags.length) {
    out.push("", "⚠ LINKS:");
    for (const f of a.linkFlags) {
      out.push(`  ${f.url}${f.text ? ` (${f.text})` : ""}`, `    ${f.note}`);
    }
  }
  if (a.warnings.length) {
    out.push("", "⚠ WARNINGS:");
    for (const w of a.warnings) out.push(`  - ${w}`);
  }
  return out.join("\n");
}

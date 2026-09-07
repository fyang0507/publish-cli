/** Inline-styled WeChat body rendering; caller tokens must pass safety preflight. */
import { resolve as resolvePath } from "node:path";
import { marked, Renderer, type Token } from "marked";
import { escapeHtml, escapeHtmlAttribute, inspectWechatUrl, isWeChatLink } from "./render-safety.js";
import type { ReferenceSection } from "./references.js";

interface PendingBodyImage {
  src: string;
  htmlSrc: string;
  path: string;
}

/** Labels have already been escaped by the inline renderer. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

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
  referenceParagraph: "font-size:13px;line-height:1.7;margin:2px 0;color:#888888;overflow-wrap:anywhere;",
};

/** A collected bottom citation for an external link. */
interface Citation {
  index: number;
  url: string;
  label: string;
}

/** Mutable state shared across a single render pass (populated by the renderer). */
interface RenderContext {
  inBibliography: boolean;
  textLinkCount: number;
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

  // Defense in depth: the preflight rejects every HTML token before this renderer
  // runs. If a future caller bypasses that preflight, raw markup is still emitted
  // only as text rather than as an active element.
  r.html = function (t) {
    return escapeHtml(t.text);
  };

  r.heading = function (t) {
    const lvl = Math.min(t.depth, 4);
    const style = lvl === 1 ? S.h1 : lvl === 2 ? S.h2 : lvl === 3 ? S.h3 : S.h4;
    return `<h${t.depth} style="${style}">${this.parser.parseInline(t.tokens)}</h${t.depth}>`;
  };

  r.paragraph = function (t) {
    return `<p style="${ctx.inBibliography ? S.referenceParagraph : S.p}">${this.parser.parseInline(t.tokens)}</p>`;
  };

  r.blockquote = function (t) {
    return `<blockquote style="${S.blockquote}">${this.parser.parse(t.tokens)}</blockquote>`;
  };

  r.list = function (t) {
    const tag = t.ordered ? "ol" : "ul";
    const style = ctx.inBibliography ? S.citeList : t.ordered ? S.ol : S.ul;
    const startAttr =
      t.ordered && typeof t.start === "number" && t.start !== 1 ? ` start="${t.start}"` : "";
    let body = "";
    for (const item of t.items) {
      // Marked retains only the list's starting number in its structured fields.
      // Preserve each authored number, including gaps, in bibliography lists.
      const number = ctx.inBibliography && t.ordered ? /^\s*(\d+)[.)]\s/.exec(item.raw)?.[1] : undefined;
      const rendered = this.listitem(item);
      body += number === undefined ? rendered : rendered.replace("<li ", `<li value="${Number(number)}" `);
    }
    return `<${tag}${startAttr} style="${style}">${body}</${tag}>`;
  };

  r.listitem = function (item) {
    return `<li style="${ctx.inBibliography ? S.citeItem : S.li}">${this.parser.parse(item.tokens)}</li>`;
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
    // Strip only reference hyperlinks, preserving their already-parsed labels.
    // Reparsing would turn visible www/http labels back into GFM links.
    if (ctx.inBibliography && !ctx.keepLinks) {
      ctx.textLinkCount += 1;
      return label;
    }
    const inspected = inspectWechatUrl(href, "link");
    // Outside references, keep WeChat-native links; everything with --keep-links; and
    // any non-http(s) href (relative/anchor/mailto — citations don't apply).
    if (
      ctx.keepLinks ||
      isWeChatLink(href) ||
      (inspected.kind !== "http" && inspected.kind !== "https")
    ) {
      return `<a href="${escapeHtmlAttribute(href)}" style="${S.a}">${label}</a>`;
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
    const alt = escapeHtmlAttribute(t.text ?? "");
    const inspected = inspectWechatUrl(href, "image");
    if (inspected.kind === "http" || inspected.kind === "https") {
      // Remote image: flagged (a published article would drop it), left as-is.
      ctx.remoteImages.push(href);
      return `<img src="${escapeHtmlAttribute(href)}" alt="${alt}" style="${S.img}">`;
    }
    // Local image: preserve the exact parser href separately from the escaped
    // attribute emitted into HTML. draft.ts matches the escaped identity and reads
    // `path`, so quotes/ampersands cannot create markup and do not break upload or
    // rewrite. First-seen order and raw-source dedupe remain stable.
    const htmlSrc = escapeHtmlAttribute(href);
    if (!ctx.bodyImages.some((b) => b.src === href)) {
      const path = resolvePath(ctx.baseDir, href);
      ctx.bodyImages.push({ src: href, htmlSrc, path });
    }
    return `<img src="${htmlSrc}" alt="${alt}" style="${S.img}">`;
  };

  return r;
}

/** Render the trailing numbered citation list appended after the body. */
function renderCitations(citations: Citation[]): string {
  if (citations.length === 0) return "";
  const items = citations
    .map((c) => {
      // `label` came from parseInline() over preflight-validated tokens: Marked
      // already escaped its text, and stripTags() removed only renderer-owned
      // tags. Emit that safe text exactly once; escaping it again would display
      // entity source such as `&amp;` instead of the caller's ampersand.
      const prefix = c.label ? `${c.label} — ` : "";
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

/** Render around a bounded authored section without changing caller tokens. */
export function renderWechatBody(
  tokens: Token[],
  options: { keepLinks: boolean; baseDir: string },
  references: ReferenceSection | null,
) {
  const ctx: RenderContext = {
    ...options,
    inBibliography: false,
    textLinkCount: 0,
    bodyImages: [],
    remoteImages: [],
    citations: [],
    citeByUrl: new Map(),
  };
  const renderer = buildRenderer(ctx);
  const parse = (part: Token[]) => marked.parser(part, { renderer });
  let html: string;
  if (references) {
    html = parse(tokens.slice(0, references.start));
    ctx.inBibliography = true;
    const heading = marked.Parser.parseInline(references.heading.tokens, { renderer });
    html += `<section style="${S.citeSection}margin-bottom:16px;"><p style="${S.citeHeading}">${heading}</p>`;
    html += parse(tokens.slice(references.start + 1, references.end)) + "</section>";
    ctx.inBibliography = false;
    html += parse(tokens.slice(references.end));
  } else {
    html = parse(tokens);
  }
  html += renderCitations(ctx.citations);
  return { html, bodyImages: ctx.bodyImages, remoteImages: ctx.remoteImages,
    citationCount: ctx.citations.length, textLinkCount: ctx.textLinkCount };
}

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
 *   - author: --author → frontmatter `author` → injected WECHAT_AUTHOR fallback
 *     → "". WeChat
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
import { marked, Renderer, type Token, type Tokens } from "marked";
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
  /** Configured WECHAT_AUTHOR value injected by the command after input validation. */
  authorFallback?: string;
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

/** A local body image with separate caller identity, escaped HTML identity, and resolved filesystem path. */
export interface BodyImage {
  /** The exact href produced by the Markdown parser; used for receipts and upload identity. */
  src: string;
  /** The attribute-escaped href emitted in article HTML; draft.ts matches this exact value. */
  htmlSrc: string;
  /** The resolved local filesystem path (absolute, against `baseDir`) — the client reads this to upload. */
  path: string;
  /** Locally measured header facts; platform acceptance limits remain unknown. */
  validation: LocalImageValidationResult;
}

interface PendingBodyImage {
  src: string;
  htmlSrc: string;
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

/** HTML-escape text content (`&`, `<`, `>`). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML-escape an attribute value (adds `"`). */
export function escapeHtmlAttribute(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

type WechatUrlUsage = "link" | "image" | "source";
type SafeWechatUrlKind = "http" | "https" | "mailto" | "relative" | "fragment";

interface WechatUrlInspection {
  canonical: string;
  kind: SafeWechatUrlKind | null;
  problem:
    | "control_character"
    | "excessive_encoding"
    | "malformed_encoding"
    | "scheme_relative"
    | "invalid"
    | "unsupported_scheme"
    | null;
  actual: string;
}

const URL_NAMED_ENTITY: Readonly<Record<string, string>> = {
  amp: "&",
  bsol: "\\",
  colon: ":",
  newline: "\n",
  sol: "/",
  tab: "\t",
};

const REPORTABLE_URL_SCHEMES = new Set([
  "data",
  "file",
  "http",
  "https",
  "javascript",
  "mailto",
  "vbscript",
]);

/** Keep caller-controlled error evidence bounded and avoid echoing arbitrary schemes. */
function reportedUrlScheme(scheme: string): string {
  return REPORTABLE_URL_SCHEMES.has(scheme) ? scheme : "unsupported_scheme";
}

/** Decode one entity/percent layer for the rejection probe, using strict UTF-8. */
function decodeUrlProbeStep(value: string): { value: string; malformed: boolean } {
  const entitiesDecoded = value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (whole, hex: string | undefined, dec: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? dec ?? "", hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    })
    .replace(/&(amp|bsol|colon|newline|sol|tab);/gi, (whole, name: string) =>
      URL_NAMED_ENTITY[name.toLowerCase()] ?? whole);
  try {
    // Unlike byte-wise String.fromCharCode decoding, decodeURIComponent treats
    // percent triplets as UTF-8: encoded CJK/punctuation remain valid Unicode,
    // while lone continuation bytes, truncated sequences, and malformed `%`
    // syntax fail closed instead of masquerading as C1 controls.
    return { value: decodeURIComponent(entitiesDecoded), malformed: false };
  } catch {
    return { value: entitiesDecoded, malformed: true };
  }
}

/**
 * Repeated decoding closes entity/percent nesting tricks without letting hostile
 * input force an unbounded loop. More than eight changing layers is rejected as
 * ambiguous rather than treated as a relative URL.
 */
function canonicalizeUrlForSafety(raw: string): {
  value: string;
  excessive: boolean;
  malformed: boolean;
} {
  let value = raw.trim();
  for (let i = 0; i < 8; i += 1) {
    const decoded = decodeUrlProbeStep(value);
    if (decoded.malformed) {
      // Malformed percent/UTF-8 in the caller's raw value is invalid. After at
      // least one valid layer, however, an unmatched percent can be the decoded
      // literal represented by `%25` (for example `./100%25-complete`). Stop at
      // that derived text and still run every scheme/control/network/colon probe
      // below; do not misclassify the valid emitted encoding as malformed.
      return i === 0
        ? { value: decoded.value, excessive: false, malformed: true }
        : { value, excessive: false, malformed: false };
    }
    if (decoded.value === value) return { value, excessive: false, malformed: false };
    value = decoded.value;
  }
  const next = decodeUrlProbeStep(value);
  return {
    value,
    excessive: !next.malformed && next.value !== value,
    // This is necessarily a derived ninth-layer value; a malformed next decode
    // means the current terminal percent came from a valid earlier `%25` layer.
    malformed: false,
  };
}

/** Classify a URL/path after security canonicalization; this function never throws. */
function inspectWechatUrl(raw: string, usage: WechatUrlUsage): WechatUrlInspection {
  const controls = /[\u0000-\u001f\u007f-\u009f]/;
  if (controls.test(raw)) {
    return { canonical: "", kind: null, problem: "control_character", actual: "control_character" };
  }
  const emitted = raw.trim();
  if (raw !== emitted) {
    return { canonical: emitted, kind: null, problem: "invalid", actual: "surrounding_whitespace" };
  }
  if (/^[\\/]{2}/.test(emitted)) {
    return { canonical: emitted, kind: null, problem: "scheme_relative", actual: "scheme_relative" };
  }
  // A drive-absolute Windows body-image path is a local asset, not a URI
  // scheme. It still goes through the normal local-file validation below.
  // Double-leading UNC/network paths were rejected immediately above.
  if (usage === "image" && /^[a-z]:[\\/]/i.test(emitted)) {
    return { canonical: emitted, kind: "relative", problem: null, actual: "relative" };
  }

  if (emitted.startsWith("#")) {
    return usage === "link"
      ? { canonical: emitted, kind: "fragment", problem: null, actual: "fragment" }
      : { canonical: emitted, kind: null, problem: "unsupported_scheme", actual: "fragment" };
  }
  const directMatch = /^([a-z][a-z0-9+.-]*):/i.exec(emitted);
  const directScheme = directMatch?.[1].toLowerCase() ?? null;

  // An explicit scheme is evaluated against the exact emitted value. Decoding
  // must never repair an invalid absolute URL or grant it a safe classification.
  if (directScheme) {
    const decodedOnce = decodeUrlProbeStep(emitted);
    if (decodedOnce.malformed) {
      return { canonical: emitted, kind: null, problem: "malformed_encoding", actual: "malformed_encoding" };
    }
    if (controls.test(decodedOnce.value)) {
      return { canonical: emitted, kind: null, problem: "control_character", actual: "control_character" };
    }
    if (directScheme === "mailto") {
      if (usage !== "link" || !emitted.slice(directMatch?.[0].length ?? 0).trim()) {
        return { canonical: emitted, kind: null, problem: "unsupported_scheme", actual: directScheme };
      }
      try {
        if (new URL(emitted).protocol.toLowerCase() !== "mailto:") throw new Error("invalid mailto");
      } catch {
        return { canonical: emitted, kind: null, problem: "invalid", actual: "mailto:invalid" };
      }
      return { canonical: emitted, kind: "mailto", problem: null, actual: directScheme };
    }
    if (directScheme !== "http" && directScheme !== "https") {
      return {
        canonical: emitted,
        kind: null,
        problem: "unsupported_scheme",
        actual: reportedUrlScheme(directScheme),
      };
    }
    // WHATWG URL parsing deliberately repairs inputs such as http:///host and
    // treats backslashes as path separators for special schemes. Those bytes
    // are not the explicit `http(s)://authority` form we promise to emit, so
    // reject them before parsing instead of approving a normalized surrogate.
    if (!/^https?:\/\/[^/?#\\]/i.test(emitted) || emitted.includes("\\")) {
      return { canonical: emitted, kind: null, problem: "invalid", actual: `${directScheme}:invalid` };
    }
    const authority = emitted.slice(emitted.indexOf("://") + 3).split(/[/?#]/, 1)[0];
    if (authority.includes("@")) {
      return { canonical: emitted, kind: null, problem: "invalid", actual: "credentials_unsupported" };
    }
    try {
      const parsed = new URL(emitted);
      if (parsed.protocol.toLowerCase() !== `${directScheme}:` || !parsed.hostname) {
        return { canonical: emitted, kind: null, problem: "invalid", actual: `${directScheme}:invalid` };
      }
    } catch {
      return { canonical: emitted, kind: null, problem: "invalid", actual: `${directScheme}:invalid` };
    }
    return { canonical: emitted, kind: directScheme, problem: null, actual: directScheme };
  }

  // With no explicit scheme, recursively decode only as a rejection probe for
  // an encoded/obfuscated scheme, control byte, fragment, or network-path form.
  const decoded = canonicalizeUrlForSafety(emitted);
  const canonical = decoded.value.trim();
  if (decoded.malformed) {
    return { canonical, kind: null, problem: "malformed_encoding", actual: "malformed_encoding" };
  }
  if (decoded.excessive) {
    return { canonical, kind: null, problem: "excessive_encoding", actual: "excessive_encoding" };
  }
  if (controls.test(canonical)) {
    return { canonical, kind: null, problem: "control_character", actual: "control_character" };
  }
  if (/^[\\/]{2}/.test(canonical)) {
    return { canonical, kind: null, problem: "scheme_relative", actual: "scheme_relative" };
  }
  if (canonical.startsWith("#")) {
    return { canonical, kind: null, problem: "unsupported_scheme", actual: "obfuscated_url" };
  }

  const canonicalColon = canonical.indexOf(":");
  const canonicalPrefix = canonicalColon < 0 ? "" : canonical.slice(0, canonicalColon);
  const compactCanonicalPrefix = canonicalPrefix.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  const canonicalScheme = /^[a-z][a-z0-9+.-]*$/i.test(compactCanonicalPrefix)
    ? compactCanonicalPrefix.toLowerCase()
    : null;
  if (canonicalScheme) {
    if (canonicalScheme !== "http" && canonicalScheme !== "https" && canonicalScheme !== "mailto") {
      return {
        canonical,
        kind: null,
        problem: "unsupported_scheme",
        actual: reportedUrlScheme(canonicalScheme),
      };
    }
    return { canonical, kind: null, problem: "unsupported_scheme", actual: "obfuscated_scheme" };
  }

  // A colon in the first path segment is neither an ordinary relative path nor
  // a syntactically valid explicit scheme (e.g. java\\script: or a format-char
  // smuggling attempt), so fail closed.
  const firstColon = emitted.indexOf(":");
  const firstPathSeparator = emitted.search(/[/?#]/);
  if (firstColon >= 0 && (firstPathSeparator < 0 || firstColon < firstPathSeparator)) {
    return { canonical, kind: null, problem: "invalid", actual: "malformed_scheme" };
  }
  if (usage === "source" || (usage === "image" && !emitted)) {
    return { canonical, kind: null, problem: "invalid", actual: emitted ? "relative" : "empty" };
  }
  return { canonical: emitted, kind: "relative", problem: null, actual: "relative" };
}

function urlExpected(usage: WechatUrlUsage): string {
  if (usage === "source") return "an absolute http:// or https:// URL";
  if (usage === "image") return "an http(s) URL or local filesystem path (not a fragment or scheme-relative URL)";
  return "http, https, mailto, a relative URL, or a fragment";
}

/** Reject one caller URL with structured, bounded actual/expected evidence. */
function assertSafeWechatUrl(raw: string, usage: WechatUrlUsage): WechatUrlInspection {
  const inspected = inspectWechatUrl(raw, usage);
  if (!inspected.problem) return inspected;
  const label = usage === "source" ? "source URL" : `Markdown ${usage} destination`;
  const expected = urlExpected(usage);
  throw new LocalValidationError(
    `Unsafe or unsupported WeChat ${label} (actual: ${inspected.actual}; expected: ${expected}).`,
    {
      code: usage === "source" ? "wechat_source_url_unsafe" : "wechat_url_unsafe",
      field: usage === "source" ? "source" : "body",
      actual: inspected.actual,
      expected,
      unit: null,
    },
  );
}

/** Validate every nested Marked token before rendering or reading any asset. */
function assertSafeWechatTokens(tokens: Token[]): void {
  marked.walkTokens(tokens, (token) => {
    if (token.type === "html") {
      throw new LocalValidationError(
        "Raw HTML is unsupported in WeChat Markdown (actual: raw_html; expected: Markdown syntax, escaped HTML text, or code).",
        {
          code: "wechat_raw_html_unsupported",
          field: "body",
          actual: "raw_html",
          expected: "Markdown syntax, escaped HTML text, or code",
          unit: null,
        },
      );
    }
    if (token.type === "link") {
      assertSafeWechatUrl((token as Tokens.Link).href ?? "", "link");
    } else if (token.type === "image") {
      assertSafeWechatUrl((token as Tokens.Image).href ?? "", "image");
    }
  });
}

/** Is this a WeChat-native (mp.weixin.qq.com) link (always kept inline)? */
function isWeChatLink(href: string): boolean {
  const inspected = inspectWechatUrl(href, "link");
  if (inspected.problem || (inspected.kind !== "http" && inspected.kind !== "https")) return false;
  try {
    return new URL(inspected.canonical).hostname.toLowerCase() === WECHAT_HOST;
  } catch {
    return false;
  }
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
    const inspected = inspectWechatUrl(href, "link");
    // Kept inline: WeChat-native links always; everything when --keep-links; and
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
  // --- author ---
  const author = (opts.author ?? data.author ?? opts.authorFallback ?? "").trim();

  // --- body markdown (strip a leading H1 only when it was consumed as the title) ---
  const bodyMarkdown = trimBlankEdges(titleFromH1 ? stripLeadingH1(afterFm) : afterFm);

  // --- output-safety preflight (MUST precede every filesystem read) ---
  // Resolve the selected source URL with the existing explicit-clear semantics,
  // then validate every nested token in the full normalized source so HTML or an
  // unsafe destination inside a leading H1 consumed as the title cannot evade
  // inspection. The separately lexed body tokens are validated and then rendered
  // unchanged so the final safety decision and body output share one token tree.
  const selectedSourceUrl = opts.sourceUrl ?? data.sourceUrl;
  const sourceUrl = selectedSourceUrl?.trim() ? selectedSourceUrl : undefined;
  if (sourceUrl) assertSafeWechatUrl(sourceUrl, "source");
  assertSafeWechatTokens(marked.lexer(afterFm));
  const bodyTokens = marked.lexer(bodyMarkdown);
  assertSafeWechatTokens(bodyTokens);

  // Asset reads happen only after caller markup and URL destinations are known
  // safe. This keeps an invalid body/source URL from touching even the cover.
  const coverPath = resolvePath(baseDir, coverRaw);
  const coverValidation = assertWechatLocalImage(coverPath, "cover");

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
  const bodyHtml = marked.parser(bodyTokens, { renderer }) as string;
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
    sourceUrl,
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

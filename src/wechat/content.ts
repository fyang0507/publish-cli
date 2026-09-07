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
 * delegates to render.ts for markdown → inline-styled HTML and references.ts
 * for bounded authored-bibliography detection. One readable
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
 *   - Links: hyperlinks inside an authored bibliography render as labels.
 *     Outside it, external links produce generated bottom citations, while
 *     mp.weixin.qq.com links stay inline. `keepLinks` opts out of both transforms.
 *   - Images: local `<img>` paths are collected for upload+rewrite by draft.ts;
 *     remote `http(s)://` images are flagged as a warning and left as-is this phase.
 */

import { parseBaseMarkdown, type LinkFlag } from "../x/content.js";
import { resolve as resolvePath } from "node:path";
import { marked } from "marked";
import { findReferenceSection } from "./references.js";
import { renderWechatBody } from "./render.js";
import {
  assertSafeWechatTokens,
  assertSafeWechatUrl,
} from "./render-safety.js";

import {
  LocalValidationError,
  WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS,
  assertWechatLocalImage,
  type LocalImageValidationResult,
} from "../capabilities/validation.js";
import {
  GENERATED_DRAFT_ARRAY_MAX,
  GENERATED_DRAFT_TEXT_MAX,
  commonAdvisoryText,
  newGeneratedDraftSnapshotContext,
  snapshotGeneratedLinkFlags,
  snapshotGeneratedWarnings,
} from "../draftSnapshot.js";
import {
  TerminalProjectionError,
  finalizeTerminalDocument,
  projectTerminalText,
  renderTerminalBlock,
  renderTerminalInline,
  snapshotBoolean,
  snapshotBoundedString,
  snapshotClosedRecord,
  snapshotDenseArray,
  snapshotFiniteNumber,
  snapshotOptionalString,
  snapshotSafeInteger,
  type ClosedSnapshotContext,
} from "../terminalOutput.js";

export { escapeHtmlAttribute } from "./render-safety.js";

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
  /** Keep safe links inline; default strips reference links and cites external body links. */
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

export interface PreparedWechatArticle {
  readonly article: GeneratedArticle;
  readonly inspection: string;
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
    "are not clickable). Links inside authored references become readable text; " +
    "external body links are moved to bottom citations. Use --keep-links to keep links inline. " +
    "Outside references, mp.weixin.qq.com links are always kept inline.";

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
  const references = findReferenceSection(bodyTokens);

  // Asset reads happen only after caller markup and URL destinations are known
  // safe. This keeps an invalid body/source URL from touching even the cover.
  const coverPath = resolvePath(baseDir, coverRaw);
  const coverValidation = assertWechatLocalImage(coverPath, "cover");

  // --- render body → inline-styled HTML ---
  const rendered = renderWechatBody(bodyTokens, { keepLinks: !!opts.keepLinks, baseDir }, references);
  // Validate outside Marked's renderer call stack so LocalValidationError text
  // and structured actual/expected/unit evidence pass through unchanged.
  const bodyImages: BodyImage[] = rendered.bodyImages.map((image) => ({
    ...image,
    validation: assertWechatLocalImage(image.path, "body"),
  }));
  const html = rendered.html;

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
  if (!opts.keepLinks && rendered.citationCount > 0) {
    warnings.push(
      `${rendered.citationCount} external link(s) were moved to bottom citations (WeChat deactivates ` +
        `most external links in article bodies). Use --keep-links to keep them inline.`,
    );
  }
  if (rendered.textLinkCount > 0) {
    warnings.push(
      `${rendered.textLinkCount} reference hyperlink occurrence(s) were rendered as readable text. ` +
        "Reference numbers and grouped sources were preserved without adding destination URLs or citations. " +
        "Canonical Markdown links are unchanged. " +
        "Use --keep-links to retain safe inline hyperlinks.",
    );
  }
  if (rendered.remoteImages.length > 0) {
    warnings.push(
      `${rendered.remoteImages.length} remote image(s) (${rendered.remoteImages
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

function snapshotNullableFinite(value: unknown): number | null {
  return value === null ? null : snapshotFiniteNumber(value);
}

function snapshotWechatImageValidation(
  value: unknown,
  expectedSurface: "cover" | "body",
  context: ClosedSnapshotContext,
): Readonly<LocalImageValidationResult> {
  return snapshotClosedRecord(
    value,
    [
      "path", "valid", "extension", "contentType", "sizeBytes", "width", "height",
      "aspectRatio", "error", "problem", "surface", "maximumBytes", "unverifiedConstraints",
    ],
    [],
    context,
    (reader) => {
      const path = snapshotBoundedString(reader.read("path"), GENERATED_DRAFT_TEXT_MAX, context);
      if (reader.read("valid") !== true || reader.read("surface") !== expectedSurface) {
        throw new TerminalProjectionError();
      }
      const extension = snapshotBoundedString(reader.read("extension"), 32, context);
      const contentType = reader.read("contentType");
      if (
        contentType !== "image/bmp" && contentType !== "image/gif" &&
        contentType !== "image/jpeg" && contentType !== "image/png" &&
        contentType !== "image/webp"
      ) throw new TerminalProjectionError();
      const sizeBytes = snapshotNullableFinite(reader.read("sizeBytes"));
      const width = snapshotNullableFinite(reader.read("width"));
      const height = snapshotNullableFinite(reader.read("height"));
      const aspectRatio = snapshotNullableFinite(reader.read("aspectRatio"));
      if (
        reader.read("error") !== null || reader.read("problem") !== null ||
        reader.read("maximumBytes") !== null
      ) throw new TerminalProjectionError();
      const constraints = snapshotDenseArray(
        reader.read("unverifiedConstraints"),
        WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS.length,
        context,
        (entry) => snapshotBoundedString(entry, 100, context),
      );
      if (
        constraints.length !== WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS.length ||
        constraints.some((entry, index) => entry !== WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS[index])
      ) throw new TerminalProjectionError();
      return Object.freeze({
        path,
        valid: true,
        extension,
        contentType,
        sizeBytes,
        width,
        height,
        aspectRatio,
        error: null,
        problem: null,
        surface: expectedSurface,
        maximumBytes: null,
        unverifiedConstraints: constraints as typeof WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS,
      });
    },
  );
}

function snapshotWechatBodyImages(
  value: unknown,
  context: ClosedSnapshotContext,
): readonly Readonly<BodyImage>[] {
  return snapshotDenseArray(
    value,
    GENERATED_DRAFT_ARRAY_MAX,
    context,
    (entry) => snapshotClosedRecord(
      entry,
      ["src", "htmlSrc", "path", "validation"],
      [],
      context,
      (reader) => {
        const src = snapshotBoundedString(reader.read("src"), GENERATED_DRAFT_TEXT_MAX, context);
        const htmlSrc = snapshotBoundedString(reader.read("htmlSrc"), GENERATED_DRAFT_TEXT_MAX, context);
        const path = snapshotBoundedString(reader.read("path"), GENERATED_DRAFT_TEXT_MAX, context);
        const validation = snapshotWechatImageValidation(reader.read("validation"), "body", context);
        if (validation.path !== path) throw new TerminalProjectionError();
        return Object.freeze({ src, htmlSrc, path, validation });
      },
    ),
  );
}

/** Closed, recursively frozen generated DTO shared by terminal and transport. */
export function snapshotWechatGeneratedArticle(value: unknown): GeneratedArticle {
  const context = newGeneratedDraftSnapshotContext();
  return snapshotClosedRecord(
    value,
    ["title", "author", "digest", "html", "coverPath", "coverValidation", "bodyImages", "linkFlags", "warnings"],
    ["sourceUrl"],
    context,
    (reader) => {
      const title = snapshotBoundedString(reader.read("title"), GENERATED_DRAFT_TEXT_MAX, context);
      if (!title) throw new TerminalProjectionError();
      const author = snapshotBoundedString(reader.read("author"), GENERATED_DRAFT_TEXT_MAX, context);
      const digest = snapshotBoundedString(reader.read("digest"), GENERATED_DRAFT_TEXT_MAX, context);
      const html = snapshotBoundedString(reader.read("html"), GENERATED_DRAFT_TEXT_MAX, context);
      const coverPath = snapshotBoundedString(reader.read("coverPath"), GENERATED_DRAFT_TEXT_MAX, context);
      const coverValidation = snapshotWechatImageValidation(reader.read("coverValidation"), "cover", context);
      if (coverValidation.path !== coverPath) throw new TerminalProjectionError();
      const sourceUrl = reader.has("sourceUrl")
        ? snapshotOptionalString(reader.read("sourceUrl"), GENERATED_DRAFT_TEXT_MAX, context)
        : undefined;
      const bodyImages = snapshotWechatBodyImages(reader.read("bodyImages"), context);
      const linkFlags = snapshotGeneratedLinkFlags(reader.read("linkFlags"), context);
      const warnings = snapshotGeneratedWarnings(reader.read("warnings"), context);
      return Object.freeze({
        title,
        author,
        digest,
        html,
        coverPath,
        coverValidation,
        ...(reader.has("sourceUrl") ? { sourceUrl } : {}),
        bodyImages,
        linkFlags,
        warnings,
      }) as unknown as GeneratedArticle;
    },
  );
}

function renderWechatArticleSnapshot(a: GeneratedArticle): string {
  const out: string[] = [];
  out.push("format: article (article_type=news)");
  out.push(
    `title (documented 32 字; server-authoritative measurement): ${renderTerminalInline(projectTerminalText(a.title, { lineMode: "inline" }))}`,
  );
  out.push(
    `author: ${a.author ? renderTerminalInline(projectTerminalText(a.author, { lineMode: "inline" })) : "(none)"}`,
  );
  out.push(
    `digest (documented 120 字; omitted => first 54 字): ${a.digest ? renderTerminalInline(projectTerminalText(a.digest, { lineMode: "inline" })) : "(omitted)"}`,
  );
  out.push("", "── local image validation ──");
  out.push(
    `cover: ${renderTerminalInline(projectTerminalText(a.coverPath, { lineMode: "inline" }))}`,
    `  ${a.coverValidation.contentType}; ${a.coverValidation.width}x${a.coverValidation.height}; ` +
      `${a.coverValidation.sizeBytes} bytes; aspect ${a.coverValidation.aspectRatio?.toFixed(4)}`,
  );
  if (a.sourceUrl) {
    out.push(`source url (阅读原文): ${renderTerminalInline(projectTerminalText(a.sourceUrl, { lineMode: "inline" }))}`);
  }

  if (a.bodyImages.length) {
    out.push("", `── body images (${a.bodyImages.length}, uploaded to WeChat on a real run) ──`);
    const images = a.bodyImages.map((img) =>
      (img.src === img.path ? img.src : `${img.src}  →  ${img.path}`) +
      `\n${img.validation.contentType}; ${img.validation.width}x${img.validation.height}; ` +
      `${img.validation.sizeBytes} bytes; aspect ${img.validation.aspectRatio?.toFixed(4)}`
    ).join("\n");
    out.push(renderTerminalBlock(projectTerminalText(images, { lineMode: "block" })));
  }

  out.push(
    "locally verified: readable file, magic/header type, extension match, dimensions, bytes, caller order",
    `server-authoritative/unverified: ${WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS.join(", ")}`,
  );

  out.push(
    "",
    "── HTML body (canonical HTML remains exact; terminal-safe projection below) ──",
    renderTerminalBlock(projectTerminalText(a.html, { lineMode: "block" })),
  );

  const advisorySections = commonAdvisoryText(
    [],
    a.linkFlags,
    a.warnings,
    "",
    "⚠ LINKS:",
  );
  if (advisorySections.length) {
    out.push(
      "",
      "── advisories (terminal-safe projection) ──",
      renderTerminalBlock(projectTerminalText(advisorySections.join("\n"), { lineMode: "block" })),
    );
  }
  return finalizeTerminalDocument(out);
}

export function prepareWechatArticle(value: unknown): Readonly<PreparedWechatArticle> {
  const article = snapshotWechatGeneratedArticle(value);
  const inspection = renderWechatArticleSnapshot(article);
  return Object.freeze({ article, inspection });
}

export function renderArticleForInspection(a: GeneratedArticle): string {
  return prepareWechatArticle(a).inspection;
}

/**
 * X content generation — DETERMINISTIC, plain-code transformation of a canonical
 * base markdown file into X-ready artifacts. NO LLM is involved in any decision
 * that affects correctness (character counting, thread splitting, format
 * selection, code/link flags) so output is reproducible and verifiable.
 *
 * An OPTIONAL LLM "voice pass" (src/gemini.ts) may lightly tailor prose, but it
 * runs BEFORE the deterministic char-fit/splitting and its output is re-validated
 * by the same deterministic code — the LLM never gets to decide whether a tweet
 * fits or where a thread breaks.
 *
 * Three formats:
 *   - tweet:   a single post, char-validated (default 280; --long up to 25000).
 *   - thread:  hook-first ordered split, each post within the limit, numbered.
 *   - article: long-form Article markdown for X's Articles composer.
 *
 * Two cross-cutting concerns surfaced as advisory flags (NOT auto-applied):
 *   - X does NOT render fenced code blocks — each parser-confirmed top-level
 *     block becomes an exact screenshot placeholder plus bounded fidelity
 *     evidence; the human must supply and verify the matching image.
 *   - Links cost reach — every link is surfaced with a placement note (keep it
 *     out of the opening tweet; move to a reply or the end).
 */

import { createHash } from "node:crypto";
import { Marked } from "marked";
import type { GeminiClient } from "../gemini.js";
import type { ThinkingLevel } from "@google/genai";
import {
  X_PREMIUM_POST_PLATFORM_MAX_LENGTH,
  X_STANDARD_POST_MAX_WEIGHTED_LENGTH,
  LocalValidationError,
  countXWeightedLength,
  sliceByMeasuredLength,
  validateXPostText,
  validateXPremiumTransportText,
  type LengthUnit,
} from "../capabilities/validation.js";
import {
  parseXArticleBlocks,
  parseXArticleInlineRuns,
  parseXArticleMarkdown,
} from "./articleMarkdown.js";
import {
  articleMarkdownForTerminal,
  renderXArticleCodeLinkAdvisory,
  renderXArticleCodeAdvisoryDetailLine,
  terminalSafeBoundedCodeEvidence,
  X_CODE_INFO_MAX_CODE_POINTS,
  X_CODE_PREVIEW_MAX_CODE_POINTS,
  type ArticleCodeBlockFlag,
  type CodeBlockFlag,
} from "./codeAdvisory.js";
import {
  snapshotXArticleStageInput,
  snapshotXContentFormat,
} from "./articleStageSnapshot.js";
import {
  X_CODE_BLOCK_FIDELITY_NOTE,
  createXGeneratedContentSnapshotContext,
  renderXNonArticleFidelityWarning,
  snapshotXGeneratedNonArticleContent,
} from "./nonArticleStageSnapshot.js";
import {
  TerminalProjectionError,
  finalizeTerminalDocument,
  projectTerminalText,
  renderTerminalBlock,
  renderTerminalInline,
} from "../terminalOutput.js";

export {
  X_CODE_INFO_MAX_CODE_POINTS,
  X_CODE_PREVIEW_MAX_CODE_POINTS,
} from "./codeAdvisory.js";
export type { ArticleCodeBlockFlag, CodeBlockFlag } from "./codeAdvisory.js";

/** Hard character limits for the X composer. */
export const TWEET_LIMIT_DEFAULT = X_STANDARD_POST_MAX_WEIGHTED_LENGTH;
/** Premium long-post cap. Configurable via generateContent({ longLimit }). */
export const TWEET_LIMIT_LONG = X_PREMIUM_POST_PLATFORM_MAX_LENGTH;

export type XFormat = "tweet" | "thread" | "article";

/**
 * A flagged fenced code block. X won't render code inline, so the human must
 * paste a screenshot/image where this block sits (often an asset already in the
 * canonical folder).
 */
/**
 * Closed fidelity evidence for one parser-confirmed fenced block replaced in
 * X tweet/thread/reply transport text. Source snippets are terminal-safe and
 * bounded; the digest identifies the complete LF-normalized removed segment.
 */
export interface CodeBlockFidelityFlag {
  kind: "code_block";
  index: number;
  placeholder: string;
  sourceStartLine: number;
  sourceEndLine: number;
  sourceLineCount: number;
  fence: "backtick" | "tilde";
  closure: "explicit" | "end_of_input";
  infoString: string | null;
  infoStringTruncated: boolean;
  preview: string;
  previewTruncated: boolean;
  /** Inclusive source lines joined with LF, without a separator after the final line. */
  digestNormalization: "lf_joined_source_lines";
  normalizedSourceSha256: string;
  note: string;
}

/** A surfaced link with a placement recommendation. */
export interface LinkFlag {
  url: string;
  /** Visible link text if it came from a markdown []() link. */
  text?: string;
  /** Human-readable placement guidance. */
  note: string;
  /** Present only when URL-looking text came from Article code excluded from native HTML. */
  advisorySource?: "excluded_article_code";
  /** Source Article code block for a detached, non-active link advisory. */
  codeBlockIndex?: number;
  /** Explicit bounds for caller text projected out of excluded Article code. */
  urlTruncated?: boolean;
  textTruncated?: boolean;
}

/** Shared safe rendering for command stdout and Article dry-run receipts. */
export function renderXLinkFlag(flag: LinkFlag): string {
  try {
    if (
      typeof flag === "object" &&
      flag !== null &&
      Object.getOwnPropertyDescriptor(flag, "advisorySource") !== undefined
    ) {
      return renderXArticleCodeLinkAdvisory(flag);
    }
    return `  ${flag.url}${flag.text ? ` (${flag.text})` : ""}\n    ${flag.note}`;
  } catch {
    return "  [Link advisory failed closed validation; no caller evidence rendered.]";
  }
}

/**
 * A source line intentionally excluded from the tweet/thread prose stream.
 * These are explicit fidelity receipts: the caller must be able to see every
 * normalization that removed caller-supplied content rather than discovering
 * the loss only after opening the staged draft.
 */
export interface ProseOmissionFlag {
  kind: "title_heading" | "section_heading" | "metadata_like" | "markdown_image";
  /** Exact caller-supplied line, without its trailing newline. */
  source: string;
  /** 1-based source line. */
  sourceLine: number;
  note: string;
}

export type XContentFidelityFlag = ProseOmissionFlag | CodeBlockFidelityFlag;

/**
 * An inline text run inside an article block. Rich formatting is expressed as a
 * small, deterministic set of marks so the browser layer can apply REAL editor
 * formatting (bold / links) instead of typing literal markdown characters.
 */
export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Compatibility-only mark; Markdown inline code rejects because staging has no distinct native style. */
  code?: boolean;
  /** Absolute URL if this run is a link; the editor applies a real hyperlink. */
  href?: string;
}

/**
 * A structured article block mapped to the native Articles editor. The
 * generator emits only the closed Markdown subset verified by #96; the
 * `subheading` variant remains for compatibility with already-structured
 * staging inputs and is not produced by the Markdown parser.
 */
export type ArticleBlock =
  | { kind: "heading"; level: 1 | 2; runs: InlineRun[] }
  /** Compatibility-only structured input; Markdown H3+ is rejected locally. */
  | { kind: "subheading"; runs: InlineRun[] }
  | { kind: "paragraph"; runs: InlineRun[] }
  | { kind: "bullet"; runs: InlineRun[] }
  | { kind: "ordered"; runs: InlineRun[] }
  | { kind: "quote"; runs: InlineRun[] }
  /** Fenced code — X can't render code; the human pastes a screenshot here. */
  | { kind: "code"; index: number; lang?: string; text: string };

/** A single post within a thread. */
export interface ThreadPost {
  /** 1-based position in the thread. */
  index: number;
  /** Total posts in the thread (for "n/N" numbering). */
  total: number;
  /** The post text AS IT WILL BE TYPED (already includes the n/N suffix). */
  text: string;
  /** Character count of `text` (must be <= limit). */
  chars: number;
}

/** Result of a content generation run, format-tagged. */
export interface GeneratedContent {
  format: XFormat;
  /** Effective per-post character limit used for validation. */
  limit: number;
  /** tweet: the single post text. */
  tweet?: { text: string; chars: number; unit: LengthUnit };
  /** thread: ordered posts, hook first. */
  thread?: ThreadPost[];
  /**
   * article: long-form content for X's Articles editor.
   *   - title:    the Article title field (the doc's leading H1 / first line).
   *   - markdown: the complete normalized caller Markdown, including the consumed title
   *               line (retained canonically for --dry-run artifacts / audit).
   *   - blocks:   STRUCTURED blocks with real formatting marks — the browser layer
   *               applies these as actual editor styles instead of literal chars.
   */
  article?: {
    title: string;
    markdown: string;
    blocks: ArticleBlock[];
    /** Exact structured blocks excluded from the native rich-HTML paste. */
    codeBlockCount: number;
  };
  /** Code blocks that must become screenshots on X. */
  codeFlags: CodeBlockFlag[];
  /** Links surfaced with placement notes. */
  linkFlags: LinkFlag[];
  /** Source transformations in tweet/thread prose, with closed fidelity evidence. */
  fidelityFlags: XContentFidelityFlag[];
  /** Non-fatal advisories; transport text is never silently shortened. */
  warnings: string[];
}

export interface GenerateOptions {
  format: XFormat;
  /** Original source lines consumed before `md` (for file-backed frontmatter). */
  sourceLineOffset?: number;
  /** Raise the single-tweet limit to the Premium long-post cap. */
  long?: boolean;
  /** Override the long-post cap (defaults to TWEET_LIMIT_LONG). */
  longLimit?: number;
  /**
   * Optional LLM voice pass. When set, the base prose is run through Gemini for
   * light tone tailoring BEFORE deterministic splitting/validation. Disabled by
   * default — the deterministic path is the source of truth.
   */
  voice?: {
    model: string;
    /** Defaults to "minimal" to keep the pass cheap. */
    thinkingLevel?: ThinkingLevel;
    client?: GeminiClient;
  };
}

// ---------------------------------------------------------------------------
// Markdown parsing (lightweight, deterministic — no full md parser needed)
// ---------------------------------------------------------------------------

interface ParsedDoc {
  /** First H1 (`# ...`) or first non-empty line, used as a title. */
  title: string;
  /** Body markdown with the leading title line removed. */
  body: string;
  /** Body with fenced code blocks and front-matter-ish metadata stripped, for prose splitting. */
  prose: string;
  codeFlags: CodeBlockFlag[];
  linkFlags: LinkFlag[];
  proseOmissions: ProseOmissionFlag[];
  codeFidelityFlags: CodeBlockFidelityFlag[];
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL_RE = /(?<![("])\bhttps?:\/\/[^\s)]+/g;

/**
 * Parse the canonical markdown into a title, prose (code-stripped) body, and the
 * code/link advisory flags. Deterministic and dependency-free.
 */
export function parseBaseMarkdown(md: string, sourceLineOffset = 0): ParsedDoc {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const lineOffset = Number.isFinite(sourceLineOffset)
    ? Math.max(0, Math.trunc(sourceLineOffset))
    : 0;

  let title = "";
  const codeFlags: CodeBlockFlag[] = [];
  const proseLines: string[] = [];
  const bodyLines: string[] = [];
  const proseOmissions: ProseOmissionFlag[] = [];

  let inFence = false;
  let fenceMarker = "";
  let codeIndex = 0;
  let titleLineConsumed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE_RE);

    if (!inFence && fence) {
      // Opening fence.
      inFence = true;
      fenceMarker = fence[2];
      codeIndex += 1;
      const lang = fence[3].trim() || undefined;
      const preview = (lines[i + 1] ?? "").trim();
      codeFlags.push({
        index: codeIndex,
        lang,
        preview,
        sourceLine: lineOffset + i + 1,
      });
      bodyLines.push(line);
      // Insert a placeholder in the prose stream so splitting doesn't merge
      // text across a removed code block.
      proseLines.push(`[code block #${codeIndex} → screenshot]`);
      continue;
    }

    if (inFence) {
      bodyLines.push(line);
      // Closing fence uses the same marker family.
      if (fence && fence[2][0] === fenceMarker[0] && fence[2].length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }

    // Title: first H1, else first non-empty line.
    if (!titleLineConsumed) {
      const h1 = line.match(/^#\s+(.+)$/);
      if (h1) {
        title = h1[1].trim();
        titleLineConsumed = true;
        proseOmissions.push({
          kind: "title_heading",
          source: line,
          sourceLine: lineOffset + i + 1,
          note: "Consumed as the document title and omitted from tweet/thread transport text.",
        });
        continue; // drop the title line from body/prose
      }
      if (line.trim() && !title) {
        title = line.trim();
        titleLineConsumed = true;
        // KEEP this line in the PROSE stream: tweet/thread/reply use prose as
        // their content, and a short post/reply may be ONLY this first line —
        // dropping it here produced an EMPTY tweet/reply. The shared parsed
        // body still begins after the consumed title boundary.
        proseLines.push(line);
        continue;
      }
    }

    bodyLines.push(line);

    // From the PROSE stream (used for tweet/thread splitting) drop:
    //   - leading metadata pairs ("Draft: v0.4", "Primary target: ...")
    //   - image-only lines (images become attachments, not body text)
    //   - section headings (bare labels like "Working Thesis" make weak hooks /
    //     thread filler) — they stay in `body` for body-rendering consumers.
    // Everything else flows into the hook-first prose stream.
    // Metadata pairs have a SHORT label key (1-3 words) at the very top, e.g.
    // "Draft: v0.4", "Platforms: X, LinkedIn". Restrict the key to ≤3 words so a
    // normal prose sentence with an early colon ("The pattern I keep hitting: …")
    // is NOT mistaken for metadata and dropped.
    const isMetaPair = /^[A-Z][\w/]*(?: [\w/]+){0,2}:\s+\S/.test(line) && i < 8;
    const isImageOnly = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line);
    const isHeading = /^#{1,6}\s/.test(line);
    if (isMetaPair || isImageOnly || isHeading) {
      const kind: ProseOmissionFlag["kind"] = isMetaPair
        ? "metadata_like"
        : isImageOnly
          ? "markdown_image"
          : "section_heading";
      const note = isMetaPair
        ? "Matched the leading metadata-like Key: value heuristic and was omitted from tweet/thread transport text."
        : isImageOnly
          ? "Markdown images are not transported in X tweet/thread text; supply and verify the intended attachment separately."
          : "Section headings are omitted from the tweet/thread prose stream.";
      proseOmissions.push({
        kind,
        source: line,
        sourceLine: lineOffset + i + 1,
        note,
      });
      continue;
    }
    proseLines.push(line);
  }

  // Collect links from the (non-code) body.
  const linkFlags = collectLinkFlags(bodyLines.join("\n"));

  const joinedBody = bodyLines.join("\n");

  return {
    title: title || "Untitled",
    body: joinedBody.trim(),
    prose: proseLines.join("\n").trim(),
    codeFlags,
    linkFlags,
    proseOmissions,
    codeFidelityFlags: [],
  };
}

interface XCodeTransformSpan {
  startLineIndex: number;
  endLineIndex: number;
  sourceEndOffsetExclusive: number;
  sourceLines: string[];
  codeFlag: CodeBlockFlag;
  fidelityFlag: CodeBlockFidelityFlag;
}

interface MarkedTokenShape {
  type?: unknown;
  raw?: unknown;
  text?: unknown;
  codeBlockStyle?: unknown;
  xFenceSourceLength?: unknown;
  xFenceRemainingSourceLength?: unknown;
  tokens?: unknown;
  items?: unknown;
}

function xCodePlaceholderRegex(): RegExp {
  return /\[code block #[1-9][0-9]* → screenshot\]/g;
}

function codePlaceholder(index: number): string {
  return `[code block #${index} → screenshot]`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asMarkedToken(value: unknown): MarkedTokenShape | null {
  return isObject(value) ? value : null;
}

function isParserConfirmedFence(token: MarkedTokenShape): boolean {
  return token.type === "code" && token.codeBlockStyle !== "indented";
}

function containsNestedParserConfirmedFence(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsNestedParserConfirmedFence);
  const token = asMarkedToken(value);
  if (!token) return false;
  if (isParserConfirmedFence(token)) return true;
  return containsNestedParserConfirmedFence(token.tokens) ||
    containsNestedParserConfirmedFence(token.items);
}

function xCodeMappingError(
  code: "x_code_block_parse_failed" | "x_code_block_source_mapping_failed" |
    "x_nested_code_block_mapping_unsupported" | "x_code_block_placeholder_collision",
  actual: string,
  message: string,
): LocalValidationError {
  return new LocalValidationError(message, {
    code,
    field: "text",
    actual,
    expected: "parser-confirmed, exactly mapped X code-block placeholder transformation",
    unit: null,
  });
}

function closerMatches(line: string, marker: string): boolean {
  const match = line.match(/^( {0,3})(`+|~+)[ \t]*/u);
  return !!match && match[0].length === line.length &&
    match[2][0] === marker[0] && match[2].length >= marker.length;
}

function supportedFenceOpener(line: string): RegExpMatchArray | null {
  // Do not use `.` or a `$` anchor here: JS treats U+2028/U+2029 as line
  // terminators even though Markdown source-line accounting is LF-based.
  const match = line.match(/^( {0,3})(`{3,}|~{3,})([^\n]*)/u);
  if (
    !match || match[0].length !== line.length ||
    (match[2][0] === "`" && match[3].includes("`"))
  ) {
    return null;
  }
  return match;
}

interface StrictFenceToken {
  raw: string;
  lang?: string;
  text: string;
}

/**
 * Marked owns block/container classification, while this tokenizer extension
 * owns the explicitly documented X fence boundary grammar. In particular,
 * CommonMark permits spaces or tabs after a closing fence, and a mixed marker
 * suffix is payload rather than a closer. Returning the exact consumed slice
 * lets the lexer retain its normal list/quote/HTML context without reparsing a
 * growing prefix for every fence-like source line.
 */
function strictFenceToken(src: string): StrictFenceToken | null {
  const firstBreak = src.indexOf("\n");
  const openerLine = firstBreak === -1 ? src : src.slice(0, firstBreak);
  const opener = supportedFenceOpener(openerLine);
  if (!opener) return null;

  const marker = opener[2];
  const contentStart = firstBreak === -1 ? src.length : firstBreak + 1;
  let lineStart = contentStart;
  while (lineStart < src.length) {
    const nextBreak = src.indexOf("\n", lineStart);
    const lineEnd = nextBreak === -1 ? src.length : nextBreak;
    const line = src.slice(lineStart, lineEnd);
    if (closerMatches(line, marker)) {
      const rawEnd = nextBreak === -1 ? lineEnd : nextBreak + 1;
      const raw = src.slice(0, rawEnd);
      const contentEnd = lineStart > contentStart && src[lineStart - 1] === "\n"
        ? lineStart - 1
        : lineStart;
      return {
        raw,
        ...(opener[3].trim() ? { lang: opener[3].trim() } : {}),
        text: src.slice(contentStart, contentEnd),
      };
    }
    if (nextBreak === -1) break;
    lineStart = nextBreak + 1;
  }

  const content = src.slice(contentStart);
  return {
    raw: src,
    ...(opener[3].trim() ? { lang: opener[3].trim() } : {}),
    text: content.endsWith("\n") ? content.slice(0, -1) : content,
  };
}

const xTransportMarkdownParser = new Marked({
  tokenizer: {
    fences(src) {
      const token = strictFenceToken(src);
      if (!token) return false;
      return {
        type: "code",
        ...token,
        // Marked can merge a following one-line whitespace token into `raw`.
        // Retain the exact fence slice length before that bookkeeping so the
        // source-boundary cross-check stays about the fence, not its separator.
        xFenceSourceLength: token.raw.length,
        // Some valid Markdown constructs (for example a duplicate reference
        // definition) are consumed without a top-level token. The remaining
        // root source length therefore provides the exact candidate start;
        // summing sibling token.raw lengths would drift.
        xFenceRemainingSourceLength: src.length,
      };
    },
  },
});

interface XCodeSourceLayout {
  sourceLines: string[];
  lineStartOffsets: number[];
  lineIndexByStartOffset: Map<number, number>;
  physicalLastLineIndex: number;
}

function xCodeSourceLayout(normalized: string): XCodeSourceLayout {
  const sourceLines = normalized.split("\n");
  const lineStartOffsets: number[] = [];
  const lineIndexByStartOffset = new Map<number, number>();
  let offset = 0;
  for (let index = 0; index < sourceLines.length; index += 1) {
    lineStartOffsets.push(offset);
    lineIndexByStartOffset.set(offset, index);
    offset += (sourceLines[index] ?? "").length;
    if (index < sourceLines.length - 1) offset += 1;
  }
  return {
    sourceLines,
    lineStartOffsets,
    lineIndexByStartOffset,
    physicalLastLineIndex: normalized.endsWith("\n")
      ? Math.max(0, sourceLines.length - 2)
      : sourceLines.length - 1,
  };
}

function mapParserConfirmedFence(
  normalized: string,
  layout: XCodeSourceLayout,
  startOffset: number,
  sourceLineOffset: number,
  index: number,
): XCodeTransformSpan {
  const startLineIndex = layout.lineIndexByStartOffset.get(startOffset);
  if (startLineIndex === undefined || startLineIndex > layout.physicalLastLineIndex) {
    throw xCodeMappingError(
      "x_code_block_source_mapping_failed",
      "not_at_line_boundary",
      "A parser-confirmed X code block could not be mapped to an exact source-line boundary. No transport text was generated.",
    );
  }

  const openerLine = layout.sourceLines[startLineIndex] ?? "";
  const opener = supportedFenceOpener(openerLine);
  if (!opener) {
    throw xCodeMappingError(
      "x_code_block_source_mapping_failed",
      "invalid_fence_boundary",
      "A parser-confirmed X code block did not match the supported fenced-block boundary grammar. No transport text was generated.",
    );
  }

  const marker = opener[2];
  let endLineIndex = layout.physicalLastLineIndex;
  let closure: CodeBlockFidelityFlag["closure"] = "end_of_input";
  for (
    let lineIndex = startLineIndex + 1;
    lineIndex <= layout.physicalLastLineIndex;
    lineIndex += 1
  ) {
    if (closerMatches(layout.sourceLines[lineIndex] ?? "", marker)) {
      endLineIndex = lineIndex;
      closure = "explicit";
      break;
    }
  }

  const sourceLines = layout.sourceLines.slice(startLineIndex, endLineIndex + 1);
  const sourceSegment = sourceLines.join("\n");
  const lastContentIndex = closure === "explicit" ? sourceLines.length - 2 : sourceLines.length - 1;
  const rawInfo = opener[3].trim();
  const info = terminalSafeBoundedCodeEvidence(rawInfo, X_CODE_INFO_MAX_CODE_POINTS);
  const rawPreview = lastContentIndex >= 1 ? (sourceLines[1] ?? "").trim() : "";
  const preview = terminalSafeBoundedCodeEvidence(rawPreview, X_CODE_PREVIEW_MAX_CODE_POINTS);
  const rawLang = rawInfo.split(/[ \t]+/u, 1)[0] ?? "";
  const lang = terminalSafeBoundedCodeEvidence(rawLang, X_CODE_INFO_MAX_CODE_POINTS);
  const sourceStartLine = sourceLineOffset + startLineIndex + 1;
  const sourceEndLine = sourceLineOffset + endLineIndex + 1;
  const placeholder = codePlaceholder(index);
  const sourceEndOffsetExclusive = endLineIndex + 1 < layout.lineStartOffsets.length
    ? layout.lineStartOffsets[endLineIndex + 1]
    : normalized.length;

  return {
    startLineIndex,
    endLineIndex,
    sourceEndOffsetExclusive,
    sourceLines,
    codeFlag: {
      index,
      ...(lang.value ? { lang: `${lang.value}${lang.truncated ? "…" : ""}` } : {}),
      preview: `${preview.value}${preview.truncated ? "…" : ""}`,
      sourceLine: sourceStartLine,
    },
    fidelityFlag: {
      kind: "code_block",
      index,
      placeholder,
      sourceStartLine,
      sourceEndLine,
      sourceLineCount: sourceLines.length,
      fence: marker[0] === "`" ? "backtick" : "tilde",
      closure,
      infoString: info.value || null,
      infoStringTruncated: info.truncated,
      preview: preview.value,
      previewTruncated: preview.truncated,
      digestNormalization: "lf_joined_source_lines",
      normalizedSourceSha256: createHash("sha256").update(sourceSegment, "utf8").digest("hex"),
      note: X_CODE_BLOCK_FIDELITY_NOTE,
    },
  };
}

function parserConfirmedXCodeSpans(
  normalized: string,
  sourceLineOffset: number,
): XCodeTransformSpan[] {
  const layout = xCodeSourceLayout(normalized);
  const parserSource = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  let tokens: unknown[];
  try {
    tokens = xTransportMarkdownParser.lexer(parserSource) as unknown[];
  } catch {
    throw xCodeMappingError(
      "x_code_block_parse_failed",
      "parser_failed",
      "The X Markdown parser could not classify fenced code blocks. No transport text was generated.",
    );
  }

  const spans: XCodeTransformSpan[] = [];
  for (const value of tokens) {
    const token = asMarkedToken(value);
    if (!token || typeof token.raw !== "string" || token.raw.length === 0) {
      throw xCodeMappingError(
        "x_code_block_source_mapping_failed",
        "invalid_parser_token_boundary",
        "The X Markdown parser returned an unmappable source token. No transport text was generated.",
      );
    }

    if (isParserConfirmedFence(token)) {
      if (
        typeof token.xFenceSourceLength !== "number" ||
        !Number.isSafeInteger(token.xFenceSourceLength) ||
        token.xFenceSourceLength <= 0 ||
        token.xFenceSourceLength > token.raw.length ||
        typeof token.xFenceRemainingSourceLength !== "number" ||
        !Number.isSafeInteger(token.xFenceRemainingSourceLength) ||
        token.xFenceRemainingSourceLength <= 0 ||
        token.xFenceRemainingSourceLength > parserSource.length
      ) {
        throw xCodeMappingError(
          "x_code_block_source_mapping_failed",
          "unrecognized_fence_token",
          "A parser-confirmed X code block did not carry an exact source-boundary map. No transport text was generated.",
        );
      }
      const tokenStartOffset = parserSource.length - token.xFenceRemainingSourceLength;
      const span = mapParserConfirmedFence(
        normalized,
        layout,
        tokenStartOffset,
        sourceLineOffset,
        spans.length + 1,
      );
      const mappedParserEnd = Math.min(
        tokenStartOffset + token.xFenceSourceLength,
        normalized.length,
      );
      if (mappedParserEnd !== span.sourceEndOffsetExclusive) {
        throw xCodeMappingError(
          "x_code_block_source_mapping_failed",
          "fence_boundary_unmappable",
          "A parser-confirmed X code block could not be mapped to the documented source boundary grammar. No transport text was generated.",
        );
      }
      spans.push(span);
      continue;
    }
    if (
      containsNestedParserConfirmedFence(token.tokens) ||
      containsNestedParserConfirmedFence(token.items)
    ) {
      throw xCodeMappingError(
        "x_nested_code_block_mapping_unsupported",
        "nested_fenced_code",
        "A parser-confirmed fenced code block is nested inside Markdown quote/list structure, whose exact X placeholder mapping is not supported. Move the fence to the top level; no transport text was generated.",
      );
    }
  }
  return spans;
}

/**
 * X tweet/thread/reply parser. Unlike the legacy shared parser retained for
 * sibling channels, every transformed fence must be classified by marked
 * and mapped to an exact top-level source span before it can be replaced.
 */
function parseXTransportMarkdown(md: string, sourceLineOffset = 0): ParsedDoc {
  const normalized = md.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const lineOffset = Number.isFinite(sourceLineOffset)
    ? Math.max(0, Math.trunc(sourceLineOffset))
    : 0;
  const spans = parserConfirmedXCodeSpans(normalized, lineOffset);
  const spanByStartLine = new Map(spans.map((span) => [span.startLineIndex, span]));

  let title = "";
  let titleLineConsumed = false;
  const bodyLines: string[] = [];
  const proseLines: string[] = [];
  const linkLines: string[] = [];
  const proseOmissions: ProseOmissionFlag[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const span = spanByStartLine.get(i);
    if (span) {
      bodyLines.push(...span.sourceLines);
      proseLines.push(span.fidelityFlag.placeholder);
      i = span.endLineIndex;
      continue;
    }

    const line = lines[i] ?? "";
    if (!titleLineConsumed) {
      const h1 = line.match(/^#\s+(.+)$/);
      if (h1) {
        title = h1[1].trim();
        titleLineConsumed = true;
        proseOmissions.push({
          kind: "title_heading",
          source: line,
          sourceLine: lineOffset + i + 1,
          note: "Consumed as the document title and omitted from tweet/thread transport text.",
        });
        continue;
      }
      if (line.trim() && !title) {
        title = line.trim();
        titleLineConsumed = true;
        proseLines.push(line);
        continue;
      }
    }

    bodyLines.push(line);
    linkLines.push(line);
    const isMetaPair = /^[A-Z][\w/]*(?: [\w/]+){0,2}:\s+\S/.test(line) && i < 8;
    const isImageOnly = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line);
    const isHeading = /^#{1,6}\s/.test(line);
    if (isMetaPair || isImageOnly || isHeading) {
      const kind: ProseOmissionFlag["kind"] = isMetaPair
        ? "metadata_like"
        : isImageOnly
          ? "markdown_image"
          : "section_heading";
      const note = isMetaPair
        ? "Matched the leading metadata-like Key: value heuristic and was omitted from tweet/thread transport text."
        : isImageOnly
          ? "Markdown images are not transported in X tweet/thread text; supply and verify the intended attachment separately."
          : "Section headings are omitted from the tweet/thread prose stream.";
      proseOmissions.push({ kind, source: line, sourceLine: lineOffset + i + 1, note });
      continue;
    }
    proseLines.push(line);
  }

  const prose = proseLines.join("\n").trim();
  const placeholders = Array.from(prose.matchAll(xCodePlaceholderRegex()), (match) => match[0]);
  if (
    placeholders.length !== spans.length ||
    placeholders.some((placeholder, index) => placeholder !== spans[index]?.fidelityFlag.placeholder)
  ) {
    throw xCodeMappingError(
      "x_code_block_placeholder_collision",
      "reserved_placeholder_collision",
      "Caller prose conflicts with the reserved X code-block placeholder syntax. Remove the literal placeholder text; no transport text was generated.",
    );
  }

  return {
    title: title || "Untitled",
    body: bodyLines.join("\n").trim(),
    prose,
    codeFlags: spans.map((span) => span.codeFlag),
    linkFlags: collectLinkFlags(linkLines.join("\n")),
    proseOmissions,
    codeFidelityFlags: spans.map((span) => span.fidelityFlag),
  };
}

function collectLinkFlags(text: string): LinkFlag[] {
  const flags: LinkFlag[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({
      url,
      text: m[1] || undefined,
      note: "Links cost reach — keep this OUT of the opening tweet; move it to a reply or the end of the thread.",
    });
  }

  BARE_URL_RE.lastIndex = 0;
  while ((m = BARE_URL_RE.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({
      url,
      note: "Links cost reach — keep this OUT of the opening tweet; move it to a reply or the end of the thread.",
    });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Deterministic splitting helpers
// ---------------------------------------------------------------------------

/** Shared historical helper: Unicode code points, not an X post validator. */
export function countChars(text: string): number {
  return [...text].length;
}

const countXPostChars = countXWeightedLength;
type TextMeasure = (text: string) => number;

/**
 * Greedily pack contiguous source pieces into chunks that each fit within
 * `limit`. Every whitespace byte belongs to exactly one chunk: tabs, single
 * newlines, and repeated blank lines are never normalized while splitting.
 *
 * `reserve` characters are held back from the limit on every chunk to leave room
 * for the " n/N" numbering suffix added later.
 */
function packChunks(
  prose: string,
  limit: number,
  reserve: number,
  measure: TextMeasure = countXPostChars,
): string[] {
  const effective = Math.max(1, limit - reserve);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };

  // Each piece is a non-whitespace run plus its exact following separator,
  // except generated code placeholders: those stay atomic even though their
  // fixed human-readable representation contains spaces. Concatenating chunks
  // after removing numbering still reconstructs `prose` byte-for-byte.
  const pieces = packingPieces(prose);
  for (const piece of pieces) {
    if (measure(current + piece) <= effective) {
      current += piece;
      continue;
    }
    flush();
    if (measure(piece) <= effective) {
      current = piece;
      continue;
    }

    const slices = hardSlice(piece, effective, measure);
    for (const slice of slices.slice(0, -1)) chunks.push(slice);
    const last = slices.at(-1);
    if (last) current = last;
    if (slices.length === 0) {
      throw new Error("Internal X thread packing error: source piece made no progress.");
    }
  }
  flush();
  return chunks;
}

function packingPieces(prose: string): string[] {
  const pieces: string[] = [];
  let cursor = 0;
  for (const match of prose.matchAll(xCodePlaceholderRegex())) {
    const matchIndex = match.index;
    if (matchIndex > cursor) {
      for (const piece of prose.slice(cursor, matchIndex).matchAll(/\S+\s*|\s+/gu)) {
        pieces.push(piece[0]);
      }
    }
    pieces.push(match[0]);
    cursor = matchIndex + match[0].length;
  }
  if (cursor < prose.length) {
    for (const piece of prose.slice(cursor).matchAll(/\S+\s*|\s+/gu)) {
      pieces.push(piece[0]);
    }
  }
  return pieces;
}

/** Hard-slice an over-long token into <=limit weighted pieces without breaking graphemes. */
function hardSlice(token: string, limit: number, measure: TextMeasure): string[] {
  const out: string[] = [];
  let remaining = token;
  while (remaining) {
    const slice = sliceByMeasuredLength(remaining, limit, measure);
    if (!slice) {
      const first = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(remaining))[0]?.segment;
      if (!first) break;
      const measuredLength = measure(first);
      throw new LocalValidationError(
        `One grapheme is ${measuredLength} weighted chars, exceeding the X thread content budget of ${limit}. ` +
          "It cannot be split without changing caller text; no partial thread was generated.",
        {
          code: "x_grapheme_exceeds_thread_budget",
          field: "text",
          actual: measuredLength,
          expected: `<= ${limit}`,
          unit: "twitter_text_weighted",
        },
      );
    }
    out.push(slice);
    remaining = remaining.slice(slice.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Optional LLM voice pass
// ---------------------------------------------------------------------------

async function maybeVoicePass(
  prose: string,
  opts: GenerateOptions,
  protectedPlaceholders: readonly string[],
): Promise<string> {
  if (!opts.voice) return prose;
  // Voice rewriting cannot prove that a placeholder stayed at the exact
  // source position described by its fidelity receipt. Keep the entire
  // deterministic prose canonical whenever any code transform is present.
  if (protectedPlaceholders.length > 0) return prose;
  const client =
    opts.voice.client ?? new (await import("../gemini.js")).GeminiClient();
  const prompt = [
    "Lightly tailor the following prose for posting on X (Twitter).",
    "Keep the author's voice, claims, structure, and ordering intact.",
    "Do NOT add hashtags, emojis, links, or commentary. Do NOT summarize or cut content.",
    "Return ONLY the tailored prose, no preamble.",
    "",
    "---",
    prose,
  ].join("\n");
  try {
    const out = await client.generate(
      opts.voice.model,
      prompt,
      opts.voice.thinkingLevel ?? ("minimal" as ThinkingLevel),
    );
    const trimmed = out.trim();
    if (!trimmed) return prose;
    return xCodePlaceholderRegex().test(trimmed) ? prose : trimmed;
  } catch {
    // Voice pass is advisory — never fail generation on an LLM error.
    return prose;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function fidelityStartLine(flag: XContentFidelityFlag): number {
  return flag.kind === "code_block" ? flag.sourceStartLine : flag.sourceLine;
}

function boundedEvidence(value: string | null, truncated: boolean): string {
  if (value === null) return "none";
  return `${JSON.stringify(value)}${truncated ? " (bounded prefix; truncated)" : ""}`;
}

function renderFailureFidelityEvidence(flag: XContentFidelityFlag): string {
  if (flag.kind !== "code_block") {
    return `line ${flag.sourceLine} [${flag.kind}] ${JSON.stringify(flag.source)}: ${flag.note}`;
  }
  return (
    `lines ${flag.sourceStartLine}-${flag.sourceEndLine} [code_block] ` +
    `placeholder=${JSON.stringify(flag.placeholder)}, closure=${flag.closure}, ` +
    `digest-normalization=${flag.digestNormalization}, ` +
    `LF-normalized-source-sha256=${flag.normalizedSourceSha256}, ` +
    `preview=${boundedEvidence(flag.preview, flag.previewTruncated)}: ${flag.note}`
  );
}

/**
 * Generate X content from canonical base markdown. Deterministic except for the
 * optional voice pass (whose output is re-validated by the same deterministic
 * splitting/char-fit code below).
 */
export async function generateContent(
  md: string,
  opts: GenerateOptions,
): Promise<GeneratedContent> {
  if (opts.format === "article") {
    const parsed = parseXArticleMarkdown(md, opts.sourceLineOffset ?? 0);
    return {
      format: "article",
      limit: Number.POSITIVE_INFINITY,
      article: {
        title: parsed.title,
        markdown: parsed.markdown,
        blocks: parsed.blocks,
        codeBlockCount: parsed.codeBlockCount,
      },
      codeFlags: parsed.codeFlags,
      linkFlags: parsed.linkFlags,
      fidelityFlags: [],
      warnings: [],
    };
  }

  const parsed = parseXTransportMarkdown(md, opts.sourceLineOffset ?? 0);
  const fidelityFlags: XContentFidelityFlag[] =
    [...parsed.proseOmissions, ...parsed.codeFidelityFlags]
      .sort((left, right) => fidelityStartLine(left) - fidelityStartLine(right));
  const warnings = fidelityFlags.map(renderXNonArticleFidelityWarning);

  const tweetLimit = opts.long ? opts.longLimit ?? TWEET_LIMIT_LONG : TWEET_LIMIT_DEFAULT;

  const protectedPlaceholders = parsed.codeFidelityFlags.map((flag) => flag.placeholder);
  const prose = await maybeVoicePass(parsed.prose, opts, protectedPlaceholders);

  const base: GeneratedContent = {
    format: opts.format,
    limit: tweetLimit,
    codeFlags: parsed.codeFlags,
    linkFlags: parsed.linkFlags,
    fidelityFlags,
    warnings,
  };

  const buildWithFidelityEvidence = <T>(build: () => T): T => {
    try {
      return build();
    } catch (error) {
      if (!(error instanceof LocalValidationError) || fidelityFlags.length === 0) throw error;
      const evidence = fidelityFlags
        .map(renderFailureFidelityEvidence)
        .join("\n  ");
      throw new LocalValidationError(
        `${error.message}\nSource fidelity evidence for transformations:\n  ${evidence}`,
        error.problem,
      );
    }
  };

  if (opts.format === "tweet") {
    base.limit = tweetLimit;
    base.tweet = buildWithFidelityEvidence(() => buildTweet(prose, tweetLimit, !!opts.long));
    return base;
  }

  if (opts.format === "thread") {
    base.limit = TWEET_LIMIT_DEFAULT; // threads use the standard per-post limit
    base.thread = buildWithFidelityEvidence(() => buildThread(prose, TWEET_LIMIT_DEFAULT));
    return base;
  }

  throw new Error("Internal X format dispatch error.");
}

function buildTweet(
  prose: string,
  limit: number,
  premiumTransportPolicy: boolean,
): { text: string; chars: number; unit: LengthUnit } {
  const collapsed = prose.trim();
  const validation = premiumTransportPolicy
    ? validateXPremiumTransportText(collapsed, limit)
    : validateXPostText(collapsed, limit);
  if (!collapsed) {
    throw new LocalValidationError("X post text is empty after Markdown normalization.", {
      code: "x_text_empty",
      field: "text",
      actual: 0,
      expected: "> 0",
      unit: validation.unit,
    });
  }
  if (validation.valid) {
    return { text: collapsed, chars: validation.measuredLength, unit: validation.unit };
  }
  const unit = premiumTransportPolicy
    ? "Unicode code points under the local Premium transport policy"
    : "weighted chars";
  throw new LocalValidationError(
    `Base content is ${validation.measuredLength} ${unit} but the X post limit is ${limit}. ` +
      "Use --format thread for a lossless split of the normalized prose or supply shorter text; no partial post was generated.",
    {
      code: "x_text_too_long",
      field: "text",
      actual: validation.measuredLength,
      expected: `<= ${limit}`,
      unit: validation.unit,
    },
  );
}

function buildThread(prose: string, limit: number): ThreadPost[] {
  if (!prose.trim()) {
    throw new LocalValidationError("X thread text is empty after Markdown normalization.", {
      code: "x_text_empty",
      field: "text",
      actual: 0,
      expected: "> 0",
      unit: "twitter_text_weighted",
    });
  }

  // N is unknown until packing, so grow the suffix reserve and repack until the
  // actual " n/N" suffix fits. This preserves every source token even for very
  // large threads instead of trimming the final characters of a row.
  let reserve = 8;
  let chunks: string[];
  for (;;) {
    chunks = packChunks(prose, limit, reserve);
    const total = chunks.length;
    const requiredReserve = countXPostChars(` ${total}/${total}`);
    if (requiredReserve <= reserve) break;
    if (requiredReserve >= limit) {
      throw new LocalValidationError("X thread numbering leaves no room for content.", {
        code: "x_thread_too_many_segments",
        field: "text",
        actual: total,
        expected: `numbering suffix shorter than ${limit} weighted chars`,
        unit: "thread_segments",
      });
    }
    reserve = requiredReserve;
  }

  const total = chunks.length;
  const posts: ThreadPost[] = chunks.map((text, i) => {
    const suffix = ` ${i + 1}/${total}`;
    const body = `${text}${suffix}`;
    if (countXPostChars(body) > limit) {
      throw new Error(`Internal X thread packing error at post ${i + 1}/${total}.`);
    }
    return { index: i + 1, total, text: body, chars: countXPostChars(body) };
  });
  return posts;
}

// ---------------------------------------------------------------------------
// Article structure (deterministic markdown -> editor-mappable blocks)
// ---------------------------------------------------------------------------

/**
 * Compatibility helper for callers that already build structured Article
 * blocks. The #96 Markdown classifier accepts only H1/H2 and rejects H3+ before
 * this helper is involved.
 */
export function mapHeadingLevel(mdLevel: number): 1 | 2 | null {
  if (mdLevel <= 1) return 1;
  if (mdLevel === 2) return 2;
  return null;
}

/** Parse Article inline Markdown through the same CommonMark token path. */
export function parseInlineRuns(text: string): InlineRun[] {
  return parseXArticleInlineRuns(text);
}

/**
 * Parse an Article body through the dedicated CommonMark block classifier.
 * This direct helper does not consume a title; generateContent() owns the
 * complete title/body/canonical-Markdown correspondence.
 */
export function parseArticleBlocks(body: string): ArticleBlock[] {
  return parseXArticleBlocks(body);
}

export interface PreparedXTerminalContent {
  readonly content: GeneratedContent;
  readonly inspection: string;
}

function snapshotXTerminalContent(c: unknown): {
  format: GeneratedContent["format"];
  content: GeneratedContent;
  codeFlags: readonly CodeBlockFlag[];
  articleTerminalMarkdown: string | null;
} {
  const format = snapshotXContentFormat(c as GeneratedContent);
  if (format === "article") {
    const snapshot = snapshotXArticleStageInput(c as GeneratedContent, format);
    if (!snapshot.content.article) throw new TerminalProjectionError();
    return {
      format,
      content: snapshot.content,
      codeFlags: snapshot.codeAdvisories,
      articleTerminalMarkdown: articleMarkdownForTerminal(
        snapshot.content.article.markdown,
        snapshot.codeAdvisories,
      ),
    };
  }
  const content = snapshotXGeneratedNonArticleContent(
    c,
    createXGeneratedContentSnapshotContext(),
  );
  return { format, content, codeFlags: content.codeFlags, articleTerminalMarkdown: null };
}

function renderXTerminalSnapshot(
  format: GeneratedContent["format"],
  content: GeneratedContent,
  codeFlags: readonly CodeBlockFlag[],
  articleTerminalMarkdown: string | null,
): string {
  const out: string[] = [];
  out.push(`format: ${format}`);
  if (Number.isFinite(content.limit)) out.push(`per-post limit: ${content.limit}`);

  if (content.tweet) {
    const unit = content.tweet.unit === "twitter_text_weighted"
      ? "twitter-text weighted chars"
      : "Unicode code points (local Premium transport policy)";
    out.push(
      "",
      "── tweet (terminal-safe projection; every caller line begins with │) ──",
      renderTerminalBlock(projectTerminalText(content.tweet.text, { lineMode: "block" })),
      `[${content.tweet.chars} ${unit}]`,
    );
  }
  if (content.thread) {
    const threadText = content.thread.map((post) =>
      `[${post.index}/${post.total}] (${post.chars} twitter-text weighted chars)\n${post.text}`
    ).join("\n\n");
    out.push(
      "",
      `── thread (${content.thread.length} posts) — terminal-safe projection ──`,
      renderTerminalBlock(projectTerminalText(threadText, { lineMode: "block" })),
    );
  }
  if (content.article) {
    out.push(
      "",
      `── article: ${renderTerminalInline(projectTerminalText(content.article.title, { lineMode: "inline" }))} ──`,
      "── canonical Markdown terminal-safe projection (every caller line begins with │) ──",
      renderTerminalBlock(projectTerminalText(
        articleTerminalMarkdown ?? "[Article Markdown terminal preview unavailable: validation failed closed.]",
        { lineMode: "block" },
      )),
      `[native rich-HTML excluded code blocks: ${content.article.codeBlockCount}]`,
    );
  }

  if (codeFlags.length) {
    out.push("", "⚠ CODE BLOCKS (X won't render code — paste a screenshot/image instead):");
    for (const f of codeFlags) {
      out.push(format === "article"
        ? renderXArticleCodeAdvisoryDetailLine(f as ArticleCodeBlockFlag)
        : `  #${f.index} ${f.lang ? `[${f.lang}] ` : ""}line ${f.sourceLine}: ${f.preview}`);
    }
  }
  if (content.linkFlags.length) {
    const trustedArticleCodeLinks = format === "article"
      ? content.linkFlags.filter((flag) => flag.advisorySource === "excluded_article_code")
      : [];
    const projectedLinks = content.linkFlags.filter(
      (flag) => flag.advisorySource !== "excluded_article_code",
    );
    out.push("", "⚠ LINKS (placement matters for reach):");
    if (projectedLinks.length) {
      const linkText = projectedLinks.map((flag) =>
        `${flag.url}${flag.text ? ` (${flag.text})` : ""}\n${flag.note}`
      ).join("\n");
      out.push(renderTerminalBlock(projectTerminalText(linkText, { lineMode: "block" })));
    }
    for (const flag of trustedArticleCodeLinks) out.push(renderXLinkFlag(flag));
  }
  if (content.warnings.length) {
    out.push("", "⚠ WARNINGS:");
    const trustedCodeWarnings: string[] = [];
    const callerWarnings: string[] = [];
    for (const [index, warning] of content.warnings.entries()) {
      if (content.fidelityFlags[index]?.kind === "code_block") trustedCodeWarnings.push(warning);
      else callerWarnings.push(warning);
    }
    // #59 code warnings are already closed, bounded, and terminal-safe. Keep
    // their reviewed escape/digest wording intact; project non-code omissions.
    for (const warning of trustedCodeWarnings) out.push(`  - ${warning}`);
    if (callerWarnings.length) {
      out.push(renderTerminalBlock(projectTerminalText(callerWarnings.join("\n"), { lineMode: "block" })));
    }
  }
  return finalizeTerminalDocument(out);
}

export function prepareXTerminalContent(c: unknown): Readonly<PreparedXTerminalContent> {
  try {
    const snapshot = snapshotXTerminalContent(c);
    const inspection = renderXTerminalSnapshot(
      snapshot.format,
      snapshot.content,
      snapshot.codeFlags,
      snapshot.articleTerminalMarkdown,
    );
    return Object.freeze({ content: snapshot.content, inspection });
  } catch (error) {
    if (error instanceof TerminalProjectionError) throw error;
    throw new TerminalProjectionError();
  }
}

/**
 * Compatibility renderer for callers. Commands use prepareXTerminalContent so
 * a projection failure is a typed, pre-side-effect gate rather than this marker.
 */
export function renderForInspection(c: GeneratedContent): string {
  try {
    return prepareXTerminalContent(c).inspection;
  } catch {
    return "[Content inspection failed closed: code-advisory validation failed; no caller evidence rendered.]";
  }
}

/** Legacy byte-faithful tweet/thread inspection artifact (never a terminal sink). */
export function renderXArtifactInspection(content: GeneratedContent): string {
  const out: string[] = [];
  out.push(`format: ${content.format}`);
  if (Number.isFinite(content.limit)) out.push(`per-post limit: ${content.limit}`);
  if (content.tweet) {
    const unit = content.tweet.unit === "twitter_text_weighted"
      ? "twitter-text weighted chars"
      : "Unicode code points (local Premium transport policy)";
    out.push("", "── tweet ──", content.tweet.text, `[${content.tweet.chars} ${unit}]`);
  }
  if (content.thread) {
    out.push("", `── thread (${content.thread.length} posts) ──`);
    for (const post of content.thread) {
      out.push("", `[${post.index}/${post.total}] (${post.chars} twitter-text weighted chars)`, post.text);
    }
  }
  if (content.codeFlags.length) {
    out.push("", "⚠ CODE BLOCKS (X won't render code — paste a screenshot/image instead):");
    for (const flag of content.codeFlags) {
      out.push(`  #${flag.index} ${flag.lang ? `[${flag.lang}] ` : ""}line ${flag.sourceLine}: ${flag.preview}`);
    }
  }
  if (content.linkFlags.length) {
    out.push("", "⚠ LINKS (placement matters for reach):");
    for (const flag of content.linkFlags) out.push(renderXLinkFlag(flag));
  }
  if (content.warnings.length) {
    out.push("", "⚠ WARNINGS:");
    for (const warning of content.warnings) out.push(`  - ${warning}`);
  }
  return out.join("\n");
}

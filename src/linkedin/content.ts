/**
 * LinkedIn post generation — DETERMINISTIC, plain-code transformation of canonical
 * markdown (usually inline --text) into a single LinkedIn feed-post. NO LLM is
 * involved in any decision that affects correctness (char counting, overflow
 * rejection, the fold/hook advisory) so output is reproducible and
 * verifiable, exactly like the X content generator (src/x/content.ts).
 *
 * LinkedIn owns one isolated CommonMark/GFM parser for plain-text rendering plus
 * link/image/code evidence. It emits the established shared code-block advisory
 * shape without mixing X prose/link heuristics into LinkedIn conversion.
 *
 * LinkedIn rules (LINKEDIN_DESIGN.md §4):
 *   - Single post, hard cap 3000 UTF-16 code units. Over cap => reject before
 *     browser access; NEVER truncate or emit a partial post.
 *   - Above-the-fold hook advisory: the preview LinkedIn shows before "…see more"
 *     (first ~210 chars or up to the first blank line). Warn if the hook is weak.
 *   - Markdown -> plain text: headings -> plain line, bullets -> "• " prefix,
 *     `**bold**`/`*italic*` -> plain text UNLESS opts.bold (then Unicode math-bold
 *     for bold only — opt-in + flagged for accessibility). Blank-line paragraph
 *     breaks AND single newlines are preserved verbatim (LinkedIn honors both).
 *   - Emoji pass through untouched (first-class).
 *   - Code blocks -> reuse codeFlags, LinkedIn wording (screenshot/document).
 *   - Links -> parser-resolved labels/destinations, with one deduplicated
 *     first-comment advisory per visible HTTP(S) destination.
 *   - Hashtags -> advisory: keep 3–5, at the end.
 */

import { decodeHTMLStrict } from "entities";
import { Marked, type Token, type Tokens } from "marked";
import type { CodeBlockFlag, LinkFlag } from "../x/content.js";
import {
  LINKEDIN_POST_MAX_UTF16_CODE_UNITS,
  LocalValidationError,
  countUtf16CodeUnits,
  sliceByMeasuredLength,
  validateLinkedInPostText,
} from "../capabilities/validation.js";
import {
  GENERATED_DRAFT_ARRAY_MAX,
  GENERATED_DRAFT_TEXT_MAX,
  commonAdvisoryText,
  newGeneratedDraftSnapshotContext,
  snapshotGeneratedCodeFlags,
  snapshotGeneratedLinkFlags,
  snapshotGeneratedWarnings,
} from "../draftSnapshot.js";
import {
  TerminalProjectionError,
  finalizeTerminalDocument,
  projectTerminalText,
  renderTerminalBlock,
  snapshotBoolean,
  snapshotBoundedString,
  snapshotClosedRecord,
  snapshotDenseArray,
  snapshotSafeInteger,
  type ClosedSnapshotContext,
} from "../terminalOutput.js";

/** LinkedIn's live-confirmed feed-post cap, measured in UTF-16 code units. */
export const LINKEDIN_POST_LIMIT = LINKEDIN_POST_MAX_UTF16_CODE_UNITS;
/** Approximate above-the-fold preview length before LinkedIn shows "…see more". */
export const LINKEDIN_FOLD_CHARS = 210;
/** Below this the hook reads as too thin to earn the expand. */
const WEAK_HOOK_MIN_CHARS = 30;

export interface GeneratePostOptions {
  /**
   * Opt-in Unicode math-bold for `**emphasis**`. OFF by default and FLAGGED — it
   * breaks screen readers and search indexing, so it is an explicit operator
   * choice, never a default (§4).
   */
  bold?: boolean;
  /** Source lines stripped before this body (for truthful file/stdin receipts). */
  sourceLineOffset?: number;
}

/** Result of a LinkedIn post generation run. */
export interface GeneratedPost {
  format: "post";
  /** The single hard cap used for validation (LINKEDIN_POST_LIMIT). */
  limit: number;
  /** The post text AS IT WILL BE TYPED into the composer (emoji + newlines intact). */
  text: string;
  /** UTF-16 code-unit count of `text` (must be <= limit). */
  chars: number;
  /** The computed above-the-fold preview (what shows before "…see more"). */
  hook: string;
  /** Whether Unicode math-bold was applied (opts.bold). */
  usedBold: boolean;
  /** Code blocks that can't render on LinkedIn (screenshot/document instead). */
  codeFlags: CodeBlockFlag[];
  /** Links surfaced with first-comment placement notes. */
  linkFlags: LinkFlag[];
  /** Markdown images omitted from the plain-text body; only --media attaches files. */
  imageFlags: MarkdownImageFlag[];
  /** Non-fatal advisories (weak hook, hashtag guidance, bold/image caveats). */
  warnings: string[];
}

export interface MarkdownImageFlag {
  alt?: string;
  source: string;
  sourceLine: number;
}

export interface PreparedLinkedInPost {
  readonly post: GeneratedPost;
  readonly inspection: string;
}

const IMAGE_REPLACEMENT_RE = /\u0000LI_IMAGE_(\d+)\u0000/g;

// Keep this transport independent from process-wide marked defaults or
// extensions. The same closed parser configuration owns rendered text and
// advisory evidence.
const linkedinMarkdown = new Marked({
  gfm: true,
  breaks: false,
  pedantic: false,
});

/** The first-comment placement note attached to every LinkedIn link flag. */
const LINK_NOTE =
  "LinkedIn suppresses reach on body links — post this URL as the FIRST COMMENT after publishing, not in the post body (a first comment can't be pre-saved in a draft).";

function toUnicodeBold(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x41 && code <= 0x5a) out += String.fromCodePoint(0x1d400 + (code - 0x41)); // A-Z
    else if (code >= 0x61 && code <= 0x7a) out += String.fromCodePoint(0x1d41a + (code - 0x61)); // a-z
    else if (code >= 0x30 && code <= 0x39) out += String.fromCodePoint(0x1d7ce + (code - 0x30)); // 0-9
    else out += ch;
  }
  return out;
}

interface ImageReplacement {
  plain: string;
  transport: string;
}

type EmptyOmission =
  | "code blocks"
  | "Markdown images"
  | "link reference definitions"
  | "thematic breaks";

interface LinkedInConversionState {
  readonly codeFlags: CodeBlockFlag[];
  readonly imageFlags: MarkdownImageFlag[];
  readonly imageReplacements: ImageReplacement[];
  readonly linkFlags: LinkFlag[];
  readonly seenLinks: Set<string>;
  readonly omissions: Set<EmptyOmission>;
}

interface LinkedInMarkdownConversion {
  text: string;
  firstLineWasHeading: boolean;
  firstLineWasLink: boolean;
  codeFlags: CodeBlockFlag[];
  imageFlags: MarkdownImageFlag[];
  linkFlags: LinkFlag[];
  omissions: Set<EmptyOmission>;
}

const HEADING_MARKER = "\u0000LI_HEADING\u0000";

function countLineFeeds(value: string): number {
  let count = 0;
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

function rawHtmlUnsupported(count: number): LocalValidationError {
  return new LocalValidationError(
    "LinkedIn Markdown contains parser-confirmed raw HTML, which cannot be converted " +
      "faithfully to plain text. Replace it with plain or escaped text; no browser was touched.",
    {
      code: "linkedin_raw_html_unsupported",
      field: "text",
      actual: count,
      expected: "Markdown without parser-confirmed raw HTML",
      unit: "parser_confirmed_occurrences",
    },
  );
}

function unsupportedMarkdownToken(type: string): LocalValidationError {
  return new LocalValidationError(
    "LinkedIn Markdown contains a parser token that this plain-text transport cannot " +
      "represent faithfully. Replace the construct with plain text; no browser was touched.",
    {
      code: "linkedin_markdown_token_unsupported",
      field: "text",
      actual: type,
      expected: "a supported LinkedIn Markdown token",
      unit: null,
    },
  );
}

function unsupportedHttpDestination(): LocalValidationError {
  return new LocalValidationError(
    "LinkedIn Markdown contains a parser-resolved HTTP(S) destination that cannot " +
      "be represented safely. Encode or replace the URL; no browser was touched.",
    {
      code: "linkedin_link_destination_unsupported",
      field: "text",
      actual: "invalid_http_url",
      expected: "an absolute HTTP(S) URL without raw delimiters or controls",
      unit: null,
    },
  );
}

function isValidatedHttpDestination(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  if (/[\u0000-\u0020\u007f<>"]/u.test(href)) {
    throw unsupportedHttpDestination();
  }
  try {
    const parsed = new URL(href);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname
    ) {
      throw unsupportedHttpDestination();
    }
  } catch (error) {
    if (error instanceof LocalValidationError) throw error;
    throw unsupportedHttpDestination();
  }
  return true;
}

function assertNoRawHtml(tokens: Token[]): void {
  let count = 0;
  linkedinMarkdown.walkTokens(tokens, (token) => {
    if (token.type === "html") count += 1;
  });
  if (count > 0) throw rawHtmlUnsupported(count);
}

function imageMarker(index: number): string {
  return "\u0000LI_IMAGE_" + index + "\u0000";
}

function replaceKnownImageMarkers(
  value: string,
  bold: boolean,
  replacements: readonly ImageReplacement[],
): string {
  return value.replace(IMAGE_REPLACEMENT_RE, (_match, rawIndex: string) => {
    const replacement = replacements[Number(rawIndex)];
    if (!replacement) throw unsupportedMarkdownToken("invalid_image_marker");
    return bold ? replacement.transport : replacement.plain;
  });
}

function renderLinkText(label: string, normalizedLabel: string, href: string): string {
  if (
    !normalizedLabel ||
    normalizedLabel === href ||
    href === "mailto:" + normalizedLabel
  ) {
    return normalizedLabel || href;
  }
  return label + " (" + href + ")";
}

/**
 * Parser-normalized inline rendering. With state omitted this is a pure semantic
 * projection used for link labels and image alt evidence. With state present it
 * also records only visible link/image occurrences in source order.
 */
function renderInlineTokens(
  tokens: Token[],
  bold: boolean,
  replacements: readonly ImageReplacement[] = [],
  state?: LinkedInConversionState,
  startLine = 1,
  unicodeBold = false,
  includeLinkDestinations = true,
): string {
  let out = "";
  let sourceLine = startLine;

  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        if (text.tokens) {
          out += renderInlineTokens(
            text.tokens,
            bold,
            replacements,
            state,
            sourceLine,
            unicodeBold,
            includeLinkDestinations,
          );
        } else {
          const rendered = replaceKnownImageMarkers(
            decodeHTMLStrict(text.text),
            bold,
            replacements,
          );
          out += unicodeBold ? toUnicodeBold(rendered) : rendered;
        }
        break;
      }
      case "escape": {
        const escaped = decodeHTMLStrict((token as Tokens.Escape).text);
        out += unicodeBold ? toUnicodeBold(escaped) : escaped;
        break;
      }
      case "strong": {
        out += renderInlineTokens(
          (token as Tokens.Strong).tokens,
          bold,
          replacements,
          state,
          sourceLine,
          unicodeBold || bold,
          includeLinkDestinations,
        );
        break;
      }
      case "em":
        out += renderInlineTokens(
          (token as Tokens.Em).tokens,
          bold,
          replacements,
          state,
          sourceLine,
          unicodeBold,
          includeLinkDestinations,
        );
        break;
      case "del":
        out += renderInlineTokens(
          (token as Tokens.Del).tokens,
          bold,
          replacements,
          state,
          sourceLine,
          unicodeBold,
          includeLinkDestinations,
        );
        break;
      case "codespan": {
        const code = (token as Tokens.Codespan).text;
        out += unicodeBold ? toUnicodeBold(code) : code;
        break;
      }
      case "br":
        out += "\n";
        break;
      case "checkbox":
        out += (token as Tokens.Checkbox).raw;
        break;
      case "link": {
        const link = token as Tokens.Link;
        const normalizedLabel = renderInlineTokens(
          link.tokens,
          false,
          replacements,
          undefined,
          sourceLine,
          false,
          false,
        );
        const label = renderInlineTokens(
          link.tokens,
          bold,
          replacements,
          state,
          sourceLine,
          unicodeBold,
          false,
        );
        if (!includeLinkDestinations) {
          out += label;
          break;
        }

        const isBare = link.raw === link.text;
        let href = decodeHTMLStrict(link.href);
        let visibleLabel = normalizedLabel;
        let renderedLabel = label;
        let literalSuffix = "";
        if (isBare) {
          literalSuffix = href.match(/>+$/u)?.[0] ?? "";
          if (literalSuffix) {
            href = href.slice(0, -literalSuffix.length);
            if (visibleLabel.endsWith(literalSuffix)) {
              visibleLabel = visibleLabel.slice(0, -literalSuffix.length);
            }
            if (renderedLabel.endsWith(literalSuffix)) {
              renderedLabel = renderedLabel.slice(0, -literalSuffix.length);
            }
          }
        }
        const isHttp = isValidatedHttpDestination(href);
        if (state && isHttp && !state.seenLinks.has(href)) {
          state.seenLinks.add(href);
          state.linkFlags.push({
            url: href,
            text: !isBare && visibleLabel && visibleLabel !== href
              ? visibleLabel
              : undefined,
            note: LINK_NOTE,
          });
        }
        out += (
          isBare
            ? visibleLabel
            : renderLinkText(renderedLabel, visibleLabel, href)
        ) + literalSuffix;
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        const plain = renderInlineTokens(
          image.tokens,
          false,
          replacements,
          undefined,
          sourceLine,
          false,
          false,
        );
        if (!state) {
          out += plain;
          break;
        }
        const transport = renderInlineTokens(
          image.tokens,
          bold,
          replacements,
          undefined,
          sourceLine,
          unicodeBold,
          false,
        );
        const index = state.imageReplacements.push({ plain, transport }) - 1;
        state.imageFlags.push({
          alt: plain || undefined,
          source: decodeHTMLStrict(image.href),
          sourceLine,
        });
        state.omissions.add("Markdown images");
        out += imageMarker(index);
        break;
      }
      case "html":
        throw rawHtmlUnsupported(1);
      default:
        throw unsupportedMarkdownToken(token.type);
    }
    sourceLine += countLineFeeds(token.raw);
  }

  return out;
}

function ensureRawTrailingNewlines(rendered: string, raw: string): string {
  if (!rendered) return "";
  const required = raw.match(/\n+$/)?.[0].length ?? 0;
  const present = rendered.match(/\n+$/)?.[0].length ?? 0;
  return required > present ? rendered + "\n".repeat(required - present) : rendered;
}

function renderTable(
  table: Tokens.Table,
  bold: boolean,
  state: LinkedInConversionState,
  sourceLine: number,
): string {
  const renderRow = (row: Tokens.TableCell[], rowSourceLine: number): string =>
    row.map((cell) =>
      renderInlineTokens(
        cell.tokens,
        bold,
        state.imageReplacements,
        state,
        rowSourceLine,
      )
    ).join(" | ");

  // GFM's delimiter row has no rendered cells, but it still occupies the
  // physical line between the header and the first body row.
  return [
    renderRow(table.header, sourceLine),
    ...table.rows.map((row, rowIndex) => renderRow(row, sourceLine + rowIndex + 2)),
  ].join("\n");
}

function listItemPrefix(list: Tokens.List, item: Tokens.ListItem): string {
  if (!list.ordered) return "• ";
  const marker = item.raw.match(/^ {0,3}(\d{1,9}[.)])(?=[\t \n]|$)/)?.[1];
  if (!marker) throw unsupportedMarkdownToken("ordered_list_item_marker");
  return marker + " ";
}

function renderList(
  list: Tokens.List,
  bold: boolean,
  state: LinkedInConversionState,
  sourceLine: number,
): string {
  const renderedItems: string[] = [];
  let itemLine = sourceLine;

  for (const item of list.items) {
    const body = renderBlockTokens(item.tokens, bold, state, itemLine)
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
    if (body) {
      const lines = body.split("\n");
      lines[0] = listItemPrefix(list, item) + lines[0];
      renderedItems.push(lines.join("\n"));
    }
    itemLine += countLineFeeds(item.raw);
  }

  return ensureRawTrailingNewlines(renderedItems.join("\n"), list.raw);
}

function renderBlockTokens(
  tokens: Token[],
  bold: boolean,
  state: LinkedInConversionState,
  startLine = 1,
): string {
  let out = "";
  let sourceLine = startLine;

  for (const token of tokens) {
    let rendered = "";
    switch (token.type) {
      case "space":
        rendered = token.raw;
        break;
      case "code": {
        const code = token as Tokens.Code;
        if (code.codeBlockStyle === "indented") {
          // Indented CommonMark is ambiguous in LinkedIn plain text. Preserve
          // the caller's literal bytes instead of silently removing prose that
          // the legacy line renderer transported.
          rendered = code.raw;
          break;
        }
        state.omissions.add("code blocks");
        state.codeFlags.push({
          index: state.codeFlags.length + 1,
          ...(code.lang?.trim() ? { lang: code.lang.trim() } : {}),
          preview: (code.text.split("\n")[0] ?? "").trim(),
          sourceLine,
        });
        break;
      }
      case "def":
        state.omissions.add("link reference definitions");
        break;
      case "hr":
        state.omissions.add("thematic breaks");
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        const text = renderInlineTokens(
          heading.tokens,
          bold,
          state.imageReplacements,
          state,
          sourceLine,
        );
        rendered = ensureRawTrailingNewlines(HEADING_MARKER + text, heading.raw);
        break;
      }
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        rendered = ensureRawTrailingNewlines(
          renderInlineTokens(
            paragraph.tokens,
            bold,
            state.imageReplacements,
            state,
            sourceLine,
          ),
          paragraph.raw,
        );
        break;
      }
      case "text": {
        const text = token as Tokens.Text;
        rendered = ensureRawTrailingNewlines(
          text.tokens
            ? renderInlineTokens(
                text.tokens,
                bold,
                state.imageReplacements,
                state,
                sourceLine,
              )
            : replaceKnownImageMarkers(
                decodeHTMLStrict(text.text),
                bold,
                state.imageReplacements,
              ),
          text.raw,
        );
        break;
      }
      case "checkbox":
        rendered = (token as Tokens.Checkbox).raw;
        break;
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        rendered = ensureRawTrailingNewlines(
          renderBlockTokens(quote.tokens, bold, state, sourceLine),
          quote.raw,
        );
        break;
      }
      case "list":
        rendered = renderList(token as Tokens.List, bold, state, sourceLine);
        break;
      case "table":
        rendered = ensureRawTrailingNewlines(
          renderTable(token as Tokens.Table, bold, state, sourceLine),
          token.raw,
        );
        break;
      case "html":
        throw rawHtmlUnsupported(1);
      default:
        throw unsupportedMarkdownToken(token.type);
    }
    out += rendered;
    sourceLine += countLineFeeds(token.raw);
  }

  return out;
}

function markerOnlyLineStarts(value: string): number[] {
  const starts: number[] = [];
  let start = 0;
  while (start <= value.length) {
    const newline = value.indexOf("\n", start);
    const end = newline < 0 ? value.length : newline;
    const line = value.slice(start, end);
    if (
      line.includes("\u0000LI_IMAGE_") &&
      line.replace(IMAGE_REPLACEMENT_RE, "").trim() === ""
    ) {
      starts.push(start);
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return starts;
}

function resolveImageMarkers(
  rendered: string,
  state: LinkedInConversionState,
): string {
  let text = rendered;
  const starts = markerOnlyLineStarts(text);
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const lineStart = starts[index];
    const lineEndIndex = text.indexOf("\n", lineStart);
    const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
    const line = text.slice(lineStart, lineEnd);
    if (line.replace(IMAGE_REPLACEMENT_RE, "").trim() !== "") continue;

    let editEnd = lineEnd;
    if (text[editEnd] === "\n") editEnd += 1;
    const previousLineEnd = lineStart - 1;
    const previousLineStart = text.lastIndexOf("\n", previousLineEnd - 1) + 1;
    const previousLineIsBlank =
      previousLineEnd >= 0 &&
      text.slice(previousLineStart, previousLineEnd).trim() === "";
    const nextLineEnd = text.indexOf("\n", editEnd);
    const nextLineIsBlank =
      editEnd < text.length &&
      text.slice(editEnd, nextLineEnd < 0 ? text.length : nextLineEnd).trim() === "";
    if (previousLineIsBlank && nextLineIsBlank) {
      editEnd = nextLineEnd < 0 ? text.length : nextLineEnd + 1;
    }
    text = text.slice(0, lineStart) + text.slice(editEnd);
  }

  return text.replace(IMAGE_REPLACEMENT_RE, (_match, rawIndex: string) => {
    const replacement = state.imageReplacements[Number(rawIndex)];
    if (!replacement) throw unsupportedMarkdownToken("invalid_image_marker");
    return replacement.transport;
  });
}

function convertLinkedInMarkdown(md: string, bold: boolean): LinkedInMarkdownConversion {
  const tokens = linkedinMarkdown.lexer(md);
  assertNoRawHtml(tokens);
  const state: LinkedInConversionState = {
    codeFlags: [],
    imageFlags: [],
    imageReplacements: [],
    linkFlags: [],
    seenLinks: new Set<string>(),
    omissions: new Set<EmptyOmission>(),
  };
  let rendered = renderBlockTokens(tokens, bold, state);
  rendered = resolveImageMarkers(rendered, state);

  const firstNonBlank = rendered.split("\n").find((line) => line.trim() !== "") ?? "";
  const firstLineWasHeading = firstNonBlank.startsWith(HEADING_MARKER);
  rendered = rendered.replaceAll(HEADING_MARKER, "");
  const text = rendered.replace(/^\n+/, "").replace(/\n+$/, "");
  return {
    text,
    firstLineWasHeading,
    firstLineWasLink: /^https?:\/\//.test(text.trimStart()),
    codeFlags: state.codeFlags,
    imageFlags: state.imageFlags,
    linkFlags: state.linkFlags,
    omissions: state.omissions,
  };
}

/** Compute the above-the-fold preview: up to the first blank line, capped at ~210. */
function computeHook(text: string): string {
  const firstBlock = text.split(/\n\s*\n/)[0] ?? text;
  return countUtf16CodeUnits(firstBlock) <= LINKEDIN_FOLD_CHARS
    ? firstBlock
    : sliceByMeasuredLength(firstBlock, LINKEDIN_FOLD_CHARS, countUtf16CodeUnits);
}

/** Count hashtag tokens (#word), excluding markdown heading markers. */
function countHashtags(text: string): number {
  const matches = text.match(/(?:^|\s)#[A-Za-z0-9_]+/g);
  return matches ? matches.length : 0;
}

/**
 * Generate a LinkedIn post from canonical markdown. Deterministic (no LLM).
 */
export function generatePost(md: string, opts: GeneratePostOptions = {}): GeneratedPost {
  const bold = !!opts.bold;
  const sourceLineOffset = Math.max(0, Math.trunc(opts.sourceLineOffset ?? 0));
  const warnings: string[] = [];
  const nulCount = md.split("\u0000").length - 1;
  if (nulCount > 0) {
    throw new LocalValidationError(
      "LinkedIn post input contains the unsupported U+0000 control character.",
      {
        code: "linkedin_nul_not_supported",
        field: "text",
        actual: nulCount,
        expected: "0 U+0000 code points",
        unit: "occurrences",
      },
    );
  }

  const normalizedMd = md.replace(/\r\n?/g, "\n");
  const conversion = convertLinkedInMarkdown(normalizedMd, bold);

  const linkFlags = conversion.linkFlags;
  const codeFlags = conversion.codeFlags.map((flag) => ({
    ...flag,
    sourceLine: flag.sourceLine + sourceLineOffset,
  }));
  const imageFlags = conversion.imageFlags.map((flag) => ({
    ...flag,
    sourceLine: flag.sourceLine + sourceLineOffset,
  }));

  const {
    text: rendered,
    firstLineWasHeading,
    firstLineWasLink,
  } = conversion;

  if (!rendered.trim()) {
    const causes = conversion.omissions.size > 0
      ? [...conversion.omissions].join(", ")
      : "whitespace";
    throw new LocalValidationError(
      "LinkedIn post is empty after Markdown-to-plain-text conversion. " +
        "The input contained only non-transporting " + causes + ".",
      {
        code: "linkedin_text_empty_after_conversion",
        field: "text",
        actual: 0,
        expected: "> 0 UTF-16 code units of transportable text",
        unit: "utf16_code_units",
      },
    );
  }

  const validation = validateLinkedInPostText(rendered);
  const total = validation.measuredLength;
  if (!validation.valid) {
    throw new LocalValidationError(
      `Post is ${total} UTF-16 code units but LinkedIn's cap is ${LINKEDIN_POST_LIMIT}. ` +
        "Tighten the copy; no partial post was generated.",
      {
        code: "linkedin_text_too_long",
        field: "text",
        actual: total,
        expected: `<= ${LINKEDIN_POST_LIMIT}`,
        unit: validation.unit,
      },
    );
  }
  const text = rendered;

  if (imageFlags.length > 0) {
    warnings.push(
      `${imageFlags.length} Markdown image reference(s) were omitted from the plain-text post body. ` +
        "Only explicit --media files are attached; verify that every intended image was supplied there.",
    );
  }

  const hook = computeHook(text);
  const hookChars = countUtf16CodeUnits(hook.trim());
  if (text && firstLineWasLink) {
    warnings.push(
      "Weak hook: the post opens with a link. LinkedIn's preview shows the first ~210 chars — lead with a claim/story, and move the link to the first comment.",
    );
  }
  if (text && firstLineWasHeading && hookChars < WEAK_HOOK_MIN_CHARS * 2) {
    warnings.push(
      "Weak hook: the post opens with a bare heading label. Above-the-fold space is scarce — open with a concrete line that earns the '…see more' expand.",
    );
  }
  if (text && hookChars < WEAK_HOOK_MIN_CHARS) {
    warnings.push(
      `Weak hook: the above-the-fold preview is only ${hookChars} chars. Put a stronger opening line before the first blank line.`,
    );
  }

  const hashtags = countHashtags(text);
  if (hashtags > 0 && (hashtags < 3 || hashtags > 5)) {
    warnings.push(
      `Hashtags: found ${hashtags}. LinkedIn rewards 3–5 relevant hashtags placed at the END of the post.`,
    );
  }

  if (bold) {
    warnings.push(
      "ACCESSIBILITY: --bold applied Unicode math-bold to **emphasis**. Screen readers and search indexing don't handle these glyphs — use sparingly.",
    );
  }

  return {
    format: "post",
    limit: LINKEDIN_POST_LIMIT,
    text,
    chars: countUtf16CodeUnits(text),
    hook,
    usedBold: bold,
    codeFlags,
    linkFlags,
    imageFlags,
    warnings,
  };
}

function snapshotMarkdownImageFlags(
  value: unknown,
  context: ClosedSnapshotContext,
): readonly Readonly<MarkdownImageFlag>[] {
  return snapshotDenseArray(
    value,
    GENERATED_DRAFT_ARRAY_MAX,
    context,
    (entry) => snapshotClosedRecord(
      entry,
      ["source", "sourceLine"],
      ["alt"],
      context,
      (reader) => {
        const source = snapshotBoundedString(
          reader.read("source"),
          GENERATED_DRAFT_TEXT_MAX,
          context,
        );
        const sourceLine = snapshotSafeInteger(reader.read("sourceLine"), 1);
        const altValue = reader.has("alt") ? reader.read("alt") : undefined;
        const alt = altValue === undefined
          ? undefined
          : snapshotBoundedString(altValue, GENERATED_DRAFT_TEXT_MAX, context);
        return Object.freeze({
          source,
          sourceLine,
          ...(reader.has("alt") ? { alt } : {}),
        });
      },
    ),
  );
}

/** Closed, recursively frozen generated DTO shared by terminal and transport. */
export function snapshotLinkedInGeneratedPost(value: unknown): GeneratedPost {
  const context = newGeneratedDraftSnapshotContext();
  return snapshotClosedRecord(
    value,
    ["format", "limit", "text", "chars", "hook", "usedBold", "codeFlags", "linkFlags", "imageFlags", "warnings"],
    [],
    context,
    (reader) => {
      if (reader.read("format") !== "post") throw new TerminalProjectionError();
      const limit = snapshotSafeInteger(reader.read("limit"), 1);
      if (limit !== LINKEDIN_POST_LIMIT) throw new TerminalProjectionError();
      const text = snapshotBoundedString(reader.read("text"), LINKEDIN_POST_LIMIT, context);
      const chars = snapshotSafeInteger(reader.read("chars"));
      if (chars !== countUtf16CodeUnits(text)) throw new TerminalProjectionError();
      const hook = snapshotBoundedString(reader.read("hook"), LINKEDIN_POST_LIMIT, context);
      if (hook.length > text.length || (hook.length > 0 && !text.startsWith(hook))) {
        throw new TerminalProjectionError();
      }
      const usedBold = snapshotBoolean(reader.read("usedBold"));
      const codeFlags = snapshotGeneratedCodeFlags(reader.read("codeFlags"), context);
      const linkFlags = snapshotGeneratedLinkFlags(reader.read("linkFlags"), context);
      const imageFlags = snapshotMarkdownImageFlags(reader.read("imageFlags"), context);
      const warnings = snapshotGeneratedWarnings(reader.read("warnings"), context);
      return Object.freeze({
        format: "post",
        limit,
        text,
        chars,
        hook,
        usedBold,
        codeFlags,
        linkFlags,
        imageFlags,
        warnings,
      }) as unknown as GeneratedPost;
    },
  );
}

function renderLinkedInPostSnapshot(p: GeneratedPost): string {
  const out: string[] = [];
  out.push(`format: ${p.format}`);
  out.push(`limit: ${p.limit}`);
  if (p.usedBold) out.push("bold: Unicode math-bold applied (--bold)");

  out.push(
    "",
    "── post (terminal-safe projection; every caller line begins with │) ──",
    renderTerminalBlock(projectTerminalText(p.text, { lineMode: "block" })),
    `[${p.chars} UTF-16 code units]`,
  );

  out.push(
    "",
    `── above-the-fold hook (~${LINKEDIN_FOLD_CHARS} chars, before "…see more") ──`,
    renderTerminalBlock(projectTerminalText(p.hook, { lineMode: "block" })),
  );

  const advisorySections = commonAdvisoryText(
    p.codeFlags,
    p.linkFlags,
    p.warnings,
    "⚠ CODE BLOCKS (LinkedIn won't render code — paste a screenshot or attach a document instead):",
    "⚠ LINKS (placement matters for reach):",
  );
  if (advisorySections.length) {
    out.push(
      "",
      "── advisories (terminal-safe projection) ──",
      renderTerminalBlock(projectTerminalText(advisorySections.join("\n"), { lineMode: "block" })),
    );
  }
  if (p.imageFlags.length) {
    const images = p.imageFlags.map((image) =>
      `line ${image.sourceLine}: ${image.source}${image.alt ? ` (alt: ${image.alt})` : ""}`
    ).join("\n");
    out.push(
      "",
      "⚠ MARKDOWN IMAGES (not attachments; pass intended files with --media):",
      renderTerminalBlock(projectTerminalText(images, { lineMode: "block" })),
    );
  }
  return finalizeTerminalDocument(out);
}

export function prepareLinkedInPost(value: unknown): Readonly<PreparedLinkedInPost> {
  const post = snapshotLinkedInGeneratedPost(value);
  const inspection = renderLinkedInPostSnapshot(post);
  return Object.freeze({ post, inspection });
}

/** Human terminal renderer; canonical transport still uses `prepareLinkedInPost().post`. */
export function renderPostForInspection(p: GeneratedPost): string {
  return prepareLinkedInPost(p).inspection;
}

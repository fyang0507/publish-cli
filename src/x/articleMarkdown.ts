import { Lexer, Marked } from "marked";
import { LocalValidationError } from "../capabilities/validation.js";
import type {
  ArticleBlock,
  CodeBlockFlag,
  InlineRun,
  LinkFlag,
} from "./content.js";

const ARTICLE_MARKDOWN_MAX_CODE_UNITS = 10_000_000;
const ARTICLE_TITLE_MAX_CODE_UNITS = 100_000;
const ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS = 1_000_000;
const ARTICLE_MAX_BLOCKS = 50_000;
const ARTICLE_MAX_RUNS_PER_BLOCK = 50_000;
const ARTICLE_MAX_TOTAL_RUNS = 200_000;
const ARTICLE_MAX_FLAGS = 50_000;
const ARTICLE_HREF_MAX_CODE_UNITS = 8_192;
const ARTICLE_STAGE_TEXT_MAX_CODE_UNITS = 20_000_000;

const LINK_NOTE =
  "Links cost reach — keep this OUT of the opening tweet; move it to a reply or the end of the thread.";

const ARTICLE_SUPPORTED_BLOCKS =
  "paragraphs, ATX H1/H2 headings, flat single-paragraph quotes/lists, and top-level fenced code";
const ARTICLE_SUPPORTED_INLINES =
  "plain or escaped text, emphasis, strong emphasis, soft breaks, and title-free HTTP(S) links";

interface ArticleToken {
  type?: unknown;
  raw?: unknown;
  text?: unknown;
  tokens?: unknown;
  items?: unknown;
  depth?: unknown;
  lang?: unknown;
  href?: unknown;
  title?: unknown;
  ordered?: unknown;
  start?: unknown;
  loose?: unknown;
  task?: unknown;
  codeBlockStyle?: unknown;
  xFenceSourceLength?: unknown;
  xFenceTabIndentLineOffset?: unknown;
}

interface PositionedArticleToken {
  token: ArticleToken;
  sourceLine: number;
}

interface InlineMarks {
  bold?: true;
  italic?: true;
  code?: true;
  href?: string;
}

interface ArticleParseContext {
  blockCount: number;
  runCount: number;
}

export interface ParsedXArticleMarkdown {
  title: string;
  /** Full caller Markdown after BOM and line-ending normalization. */
  markdown: string;
  /** Native body blocks. The separately staged title line is not repeated. */
  blocks: ArticleBlock[];
  codeFlags: CodeBlockFlag[];
  linkFlags: LinkFlag[];
  codeBlockCount: number;
}

function articleError(
  code: string,
  actual: string,
  expected: string,
  message: string,
): LocalValidationError {
  return new LocalValidationError(message, {
    code,
    field: "body",
    actual,
    expected,
    unit: null,
  });
}

function unsupportedBlock(type: unknown, sourceLine: number): LocalValidationError {
  const label = typeof type === "string" && /^[a-z0-9_]{1,48}$/iu.test(type)
    ? type
    : "invalid";
  return articleError(
    "x_article_block_unsupported",
    `${label} block at source line ${sourceLine}`,
    ARTICLE_SUPPORTED_BLOCKS,
    `X Article Markdown contains an unsupported ${label} block at source line ${sourceLine}. ` +
      "No artifact or native draft was created.",
  );
}

function unsupportedInline(type: unknown, sourceLine: number): LocalValidationError {
  const label = typeof type === "string" && /^[a-z0-9_]{1,48}$/iu.test(type)
    ? type
    : "invalid";
  return articleError(
    "x_article_inline_unsupported",
    `${label} inline at source line ${sourceLine}`,
    ARTICLE_SUPPORTED_INLINES,
    `X Article Markdown contains an unsupported ${label} inline at source line ${sourceLine}. ` +
      "No artifact or native draft was created.",
  );
}

function asToken(value: unknown): ArticleToken | null {
  return typeof value === "object" && value !== null
    ? value as ArticleToken
    : null;
}

function tokenArray(value: unknown): ArticleToken[] | null {
  if (!Array.isArray(value)) return null;
  const tokens: ArticleToken[] = [];
  for (const entry of value) {
    const token = asToken(entry);
    if (!token) return null;
    tokens.push(token);
  }
  return tokens;
}

function closerMatches(line: string, marker: string): boolean {
  const match = line.match(/^( {0,3})(`+|~+)[ \t]*/u);
  return !!match && match[0].length === line.length &&
    match[2][0] === marker[0] && match[2].length >= marker.length;
}

function supportedFenceOpener(line: string): RegExpMatchArray | null {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})([^\n]*)/u);
  if (
    !match ||
    match[0].length !== line.length ||
    (match[2][0] === "`" && match[3].includes("`"))
  ) {
    return null;
  }
  return match;
}

function trimFenceInfo(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/gu, "");
}

interface StrictFenceToken {
  raw: string;
  lang?: string;
  text: string;
  xFenceTabIndentLineOffset?: number;
}

/** CommonMark removes up to the opener's 0-3 leading spaces per payload line. */
function deindentFencePayload(
  payload: string,
  openerIndent: number,
): Pick<StrictFenceToken, "text" | "xFenceTabIndentLineOffset"> {
  if (openerIndent === 0 || payload.length === 0) return { text: payload };
  let xFenceTabIndentLineOffset: number | undefined;
  const text = payload.split("\n").map((line, index) => {
    let remove = 0;
    while (remove < openerIndent && line.charCodeAt(remove) === 32) remove += 1;
    if (
      remove < openerIndent &&
      line.charCodeAt(remove) === 9 &&
      xFenceTabIndentLineOffset === undefined
    ) {
      xFenceTabIndentLineOffset = index + 1;
    }
    return line.slice(remove);
  }).join("\n");
  return {
    text,
    ...(xFenceTabIndentLineOffset === undefined ? {} : { xFenceTabIndentLineOffset }),
  };
}

/** CommonMark fence grammar with an exact caller-source slice. */
function strictFenceToken(src: string): StrictFenceToken | null {
  const firstBreak = src.indexOf("\n");
  const openerLine = firstBreak === -1 ? src : src.slice(0, firstBreak);
  const opener = supportedFenceOpener(openerLine);
  if (!opener) return null;

  const marker = opener[2];
  const openerIndent = opener[1].length;
  const contentStart = firstBreak === -1 ? src.length : firstBreak + 1;
  let lineStart = contentStart;
  while (lineStart < src.length) {
    const nextBreak = src.indexOf("\n", lineStart);
    const lineEnd = nextBreak === -1 ? src.length : nextBreak;
    if (closerMatches(src.slice(lineStart, lineEnd), marker)) {
      const rawEnd = nextBreak === -1 ? lineEnd : nextBreak + 1;
      const contentEnd = lineStart > contentStart && src[lineStart - 1] === "\n"
        ? lineStart - 1
        : lineStart;
      const lang = trimFenceInfo(opener[3]);
      return {
        raw: src.slice(0, rawEnd),
        ...(lang ? { lang } : {}),
        ...deindentFencePayload(src.slice(contentStart, contentEnd), openerIndent),
      };
    }
    if (nextBreak === -1) break;
    lineStart = nextBreak + 1;
  }

  const content = src.slice(contentStart);
  const lang = trimFenceInfo(opener[3]);
  return {
    raw: src,
    ...(lang ? { lang } : {}),
    // #93 defines EOF payload as the exact LF-normalized bytes after the
    // opener, including a caller-supplied terminal LF.
    ...deindentFencePayload(content, openerIndent),
  };
}

/**
 * Article owns a dedicated parser. Shared parseBaseMarkdown behavior for
 * LinkedIn/WeChat and the separately reviewed X transport mapper stay intact.
 */
const articleParser = new Marked({
  gfm: false,
  tokenizer: {
    fences(src) {
      const token = strictFenceToken(src);
      if (!token) return false;
      return {
        type: "code",
        ...token,
        // Marked can merge following whitespace into raw bookkeeping. Keep the
        // exact fence boundary independently for payload/advisory agreement.
        xFenceSourceLength: token.raw.length,
      };
    },
  },
});

function normalizedArticleMarkdown(source: string, sourceLineOffset = 0): string {
  if (typeof source !== "string") {
    throw articleError(
      "x_article_markdown_invalid",
      "non_string_source",
      "UTF-8 Markdown text",
      "X Article Markdown must be text. No artifact or native draft was created.",
    );
  }
  // The shared file/stdin resolver removes exactly one transport BOM before
  // this function. Do not strip again: a second BOM is caller-owned content.
  const normalized = source.replace(/\r\n?/gu, "\n");
  const nulIndex = normalized.indexOf("\0");
  if (nulIndex !== -1) {
    const sourceLine = sourceLineOffset + countNewlines(normalized.slice(0, nulIndex)) + 1;
    throw articleError(
      "x_article_markdown_nul_unsupported",
      `U+0000 at source line ${sourceLine}`,
      "Article Markdown without U+0000",
      `X Article Markdown contains U+0000 at source line ${sourceLine}, which the native rich-HTML path cannot preserve exactly. ` +
        "No artifact or native draft was created.",
    );
  }
  if (normalized.length > ARTICLE_MARKDOWN_MAX_CODE_UNITS) {
    throw articleError(
      "x_article_markdown_oversized",
      "canonical Markdown exceeds the local structural bound",
      `at most ${ARTICLE_MARKDOWN_MAX_CODE_UNITS} UTF-16 code units`,
      "X Article Markdown exceeds the local structural bound. No artifact or native draft was created.",
    );
  }
  return normalized;
}

function countNewlines(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function isParserTrimmedNonCommonMarkBlankLine(value: string): boolean {
  return value.trim() === "" && !/^[ \t]*$/u.test(value);
}

function validateParagraphWhitespaceBlankSource(
  token: ArticleToken,
  sourceLine: number,
): void {
  if (typeof token.raw !== "string") return;
  const physicalLines = token.raw.split("\n");
  for (let lineIndex = 0; lineIndex < physicalLines.length; lineIndex += 1) {
    const line = physicalLines[lineIndex];
    if (!/^[ \t]+$/u.test(line)) continue;
    const evidenceLine = sourceLine + lineIndex;
    throw articleError(
      "x_article_paragraph_whitespace_blank_unsupported",
      `whitespace-only paragraph boundary at source line ${evidenceLine}`,
      "paragraph and quote boundaries that remain separate CommonMark blank lines",
      `X Article Markdown has a spaces/tabs-only line swallowed into a paragraph at source line ${evidenceLine}. ` +
        "Use a separate empty blank line; no artifact or native draft was created.",
    );
  }
}

function validateBodyAtxHeadingEdges(positioned: PositionedArticleToken[]): void {
  for (const entry of positioned) {
    // Bind the raw-source guard to root prose/heading tokens. Heading-looking
    // bytes inside strict fenced code are payload, while HTML/containers have
    // their own precise unsupported-block boundary.
    if (
      entry.token.type !== "heading" &&
      entry.token.type !== "paragraph"
    ) continue;
    if (typeof entry.token.raw !== "string") continue;

    let lineStart = 0;
    let sourceLine = entry.sourceLine;
    while (lineStart <= entry.token.raw.length) {
      const nextBreak = entry.token.raw.indexOf("\n", lineStart);
      const lineEnd = nextBreak === -1 ? entry.token.raw.length : nextBreak;
      const line = entry.token.raw.slice(lineStart, lineEnd);
      const opener = line.match(/^ {0,3}#{1,6}(?:[ \t]+([\s\S]*)|[ \t]*)$/u);
      if (opener) {
        const semanticSource = (opener[1] ?? "")
          .replace(/[ \t]+#+[ \t]*$/u, "")
          .replace(/[ \t]+$/u, "");
        if (
          semanticSource.trim() !== semanticSource ||
          /^[\p{Cc}\p{Cf}\p{Cs}\p{Z}]/u.test(semanticSource) ||
          /[\p{Cc}\p{Cf}\p{Cs}\p{Z}]$/u.test(semanticSource)
        ) {
          throw articleError(
            "x_article_heading_edge_unsupported",
            `non-representable heading edge at source line ${sourceLine}`,
            "an ATX body heading without caller-owned Unicode whitespace, control, format, or surrogate edge characters",
            `The X Article body heading at source line ${sourceLine} has edge characters the CommonMark/native path cannot preserve exactly. ` +
              "No artifact or native draft was created.",
          );
        }
      }
      if (nextBreak === -1) break;
      lineStart = nextBreak + 1;
      sourceLine += 1;
    }
  }
}

function exactInlineLinkDestination(raw: string): string | null {
  if (!raw.startsWith("[")) return null;
  let labelDepth = 0;
  let labelEnd = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      labelDepth += 1;
      continue;
    }
    if (char === "]") {
      labelDepth -= 1;
      if (labelDepth === 0) {
        labelEnd = index;
        break;
      }
      if (labelDepth < 0) return null;
    }
  }
  if (
    labelEnd < 0 ||
    raw[labelEnd + 1] !== "(" ||
    !raw.endsWith(")")
  ) return null;
  const destination = raw.slice(labelEnd + 2, -1);
  // The supported subset deliberately excludes angle, padded/multiline,
  // titled, and backslash-normalized destination syntax. The exact caller
  // bytes between parentheses must be the href sent to native staging.
  return destination.length > 0 ? destination : null;
}

function validateListSourceBoundaries(positioned: PositionedArticleToken[]): void {
  for (let index = 0; index < positioned.length; index += 1) {
    const entry = positioned[index];
    if (entry.token.type !== "list" || typeof entry.token.raw !== "string") continue;
    const tabOffset = entry.token.raw.indexOf("\t");
    if (tabOffset !== -1) {
      const sourceLine = entry.sourceLine + countNewlines(entry.token.raw.slice(0, tabOffset));
      throw articleError(
        "x_article_list_tab_unsupported",
        `tab in list source at source line ${sourceLine}`,
        "a flat list written with literal spaces and tab-free item text",
        `X Article list source contains a tab at source line ${sourceLine}, which the CommonMark list tokenizer can expand before native staging. ` +
          "Use literal spaces; no artifact or native draft was created.",
      );
    }
    const listPhysicalLines = entry.token.raw.split("\n");
    for (let lineIndex = 1; lineIndex < listPhysicalLines.length; lineIndex += 1) {
      if (!isParserTrimmedNonCommonMarkBlankLine(listPhysicalLines[lineIndex])) continue;
      const sourceLine = entry.sourceLine + lineIndex;
      throw articleError(
        "x_article_list_edge_unsupported",
        `non-representable list edge at source line ${sourceLine}`,
        "a flat list without Unicode whitespace or format separators whose list membership changes during tokenization",
        `X Article list source at line ${sourceLine} has a parser-trimmed Unicode edge or continuation the CommonMark/native path cannot preserve exactly. ` +
          "No artifact or native draft was created.",
      );
    }

    const next = positioned[index + 1];
    if (!next || typeof next.token.raw !== "string") continue;
    // Marked can detach a JS-trimmed Unicode line from the list either on the
    // same physical line or immediately after one consumed LF. Inspect only
    // that next physical segment: a true blank separator is represented first
    // by an empty `space` token and must not taint a later independent block.
    const nextPhysicalSegment = next.token.raw.split("\n", 1)[0] ?? "";
    const trailingTab = nextPhysicalSegment.indexOf("\t");
    if (!entry.token.raw.endsWith("\n") && trailingTab !== -1) {
      throw articleError(
        "x_article_list_tab_unsupported",
        `tab in list source at source line ${next.sourceLine}`,
        "a flat list written with literal spaces and tab-free item text",
        `X Article list source contains a tab at source line ${next.sourceLine}, which the CommonMark list tokenizer can expand before native staging. ` +
          "Use literal spaces; no artifact or native draft was created.",
      );
    }
    if (isParserTrimmedNonCommonMarkBlankLine(nextPhysicalSegment)) {
      throw articleError(
        "x_article_list_edge_unsupported",
        `non-representable list edge at source line ${next.sourceLine}`,
        "a flat list without Unicode whitespace or format separators whose list membership changes during tokenization",
        `X Article list source at line ${next.sourceLine} has a parser-trimmed Unicode edge or continuation the CommonMark/native path cannot preserve exactly. ` +
          "No artifact or native draft was created.",
      );
    }
  }
}

/** Lexer output must account for every body byte exactly once and in order. */
function lexBody(body: string, sourceLineOffset: number): PositionedArticleToken[] {
  let values: unknown[];
  try {
    values = articleParser.lexer(body) as unknown[];
  } catch {
    throw articleError(
      "x_article_markdown_parse_failed",
      "parser_failed",
      "a deterministic CommonMark token tree",
      "The X Article Markdown parser could not classify the body. No artifact or native draft was created.",
    );
  }

  const positioned: PositionedArticleToken[] = [];
  let cursor = 0;
  let sourceLine = sourceLineOffset + 1;
  for (const value of values) {
    const token = asToken(value);
    if (!token || typeof token.raw !== "string" || token.raw.length === 0) {
      throw articleError(
        "x_article_markdown_source_mapping_failed",
        "invalid_root_token_boundary",
        "contiguous root parser tokens covering the exact Article body",
        "The X Article Markdown parser returned an unmappable root token. No artifact or native draft was created.",
      );
    }
    if (body.slice(cursor, cursor + token.raw.length) !== token.raw) {
      throw articleError(
        "x_article_markdown_source_mapping_failed",
        "non_contiguous_root_token",
        "contiguous root parser tokens covering the exact Article body",
        "An X Article Markdown token did not map to the next exact caller-source bytes. No artifact or native draft was created.",
      );
    }
    positioned.push({ token, sourceLine });
    cursor += token.raw.length;
    sourceLine += countNewlines(token.raw);
  }
  if (cursor !== body.length) {
    throw articleError(
      "x_article_markdown_source_mapping_failed",
      "unmapped_trailing_source",
      "contiguous root parser tokens covering the exact Article body",
      "The X Article Markdown parser left canonical caller bytes unmapped. No artifact or native draft was created.",
    );
  }
  validateBodyAtxHeadingEdges(positioned);
  validateListSourceBoundaries(positioned);
  for (const entry of positioned) {
    if (entry.token.type === "paragraph") {
      validateParagraphWhitespaceBlankSource(entry.token, entry.sourceLine);
    }
  }
  return positioned;
}

interface TitleBoundary {
  titleLine: string;
  titleSourceLine: number;
  body: string;
  bodySourceLineOffset: number;
}

/**
 * The product's title convention precedes CommonMark body parsing: consume the
 * first substantive physical line as either one ATX H1 or one plain title.
 * This preserves the documented `Plain title\nBody` form even though CommonMark
 * groups those lines into one paragraph.
 */
function splitTitle(
  markdown: string,
  sourceLineOffset: number,
): TitleBoundary {
  let lineStart = 0;
  let lineIndex = 0;
  while (lineStart <= markdown.length) {
    const nextBreak = markdown.indexOf("\n", lineStart);
    const lineEnd = nextBreak === -1 ? markdown.length : nextBreak;
    const line = markdown.slice(lineStart, lineEnd);
    if (!/^[ \t]*$/u.test(line)) {
      const bodyStart = nextBreak === -1 ? markdown.length : nextBreak + 1;
      return {
        titleLine: line,
        titleSourceLine: sourceLineOffset + lineIndex + 1,
        body: markdown.slice(bodyStart),
        bodySourceLineOffset: sourceLineOffset + lineIndex + 1,
      };
    }
    if (nextBreak === -1) break;
    lineStart = nextBreak + 1;
    lineIndex += 1;
  }
  throw articleError(
    "x_article_title_missing",
    "no substantive source line",
    "a leading one-line ATX H1 or plain-text title",
    "X Article Markdown has no title. No artifact or native draft was created.",
  );
}

function lexTitleBlock(line: string, sourceLine: number): ArticleToken {
  let values: unknown[];
  try {
    values = articleParser.lexer(line) as unknown[];
  } catch {
    throw articleError(
      "x_article_markdown_parse_failed",
      `title parser failed at source line ${sourceLine}`,
      "a one-line ATX H1 or plain-text title",
      `The X Article title at source line ${sourceLine} could not be parsed. No artifact or native draft was created.`,
    );
  }
  const tokens = values.map(asToken).filter((token): token is ArticleToken => token !== null);
  if (tokens.length !== values.length || tokens.length !== 1) {
    throw articleError(
      "x_article_title_unsupported",
      `compound title at source line ${sourceLine}`,
      "a one-line ATX H1 or plain-text title",
      `The X Article title line ${sourceLine} is not representable as one native title. No artifact or native draft was created.`,
    );
  }
  const token = tokens[0];
  const isAtxH1 = token.type === "heading" && token.depth === 1 &&
    /^ {0,3}#(?:[ \t]+|$)/u.test(line);
  if (token.type !== "paragraph" && !isAtxH1) {
    throw articleError(
      "x_article_title_unsupported",
      `${typeof token.type === "string" ? token.type : "invalid"} title at source line ${sourceLine}`,
      "a one-line ATX H1 or plain-text title",
      `The first substantive line ${sourceLine} is not a supported native Article title. No artifact or native draft was created.`,
    );
  }
  return token;
}

function entityLikeTextOffset(value: string): number | null {
  // Marked retains both valid entity references and unknown entity-like names
  // as source spelling. The structured editor model has no decoded/source pair
  // with which to prove exact rendering, so this entire precise spelling class
  // is rejected rather than mislabeling unknown names as valid entities.
  const index = value.search(/&(?:#[0-9]{1,8}|#x[0-9a-f]{1,8}|[a-z][a-z0-9]{1,31});/iu);
  return index === -1 ? null : index;
}

function validateTitleSourceBoundary(
  line: string,
  token: ArticleToken,
  sourceLine: number,
): void {
  let semanticSource = line;
  if (token.type === "heading") {
    const opener = line.match(/^ {0,3}#(?:[ \t]+(.*))?$/u);
    if (!opener) throw unsupportedBlock("title_heading", sourceLine);
    semanticSource = (opener[1] ?? "")
      .replace(/[ \t]+#+[ \t]*$/u, "")
      .replace(/[ \t]+$/u, "");
  }
  // Markdown syntax spacing around an ATX marker was removed above. Any
  // remaining edge whitespace/format character is caller-owned title content
  // which native title entry cannot be proven to preserve exactly.
  if (
    semanticSource.trim() !== semanticSource ||
    /^[\p{Cc}\p{Cf}\p{Cs}\p{Z}]/u.test(semanticSource) ||
    /[\p{Cc}\p{Cf}\p{Cs}\p{Z}]$/u.test(semanticSource)
  ) {
    throw articleError(
      "x_article_title_edge_unsupported",
      `non-representable title edge at source line ${sourceLine}`,
      "a title without caller-owned edge whitespace or format characters",
      `The X Article title at source line ${sourceLine} has edge characters the native title field cannot preserve exactly. ` +
        "No artifact or native draft was created.",
    );
  }
}

function rejectConsumedSetextTitle(
  split: TitleBoundary,
  token: ArticleToken,
): void {
  if (token.type !== "paragraph") return;
  const nextBreak = split.body.indexOf("\n");
  const nextLine = nextBreak === -1 ? split.body : split.body.slice(0, nextBreak);
  if (!/^ {0,3}(?:=+|-+)[ \t]*$/u.test(nextLine)) return;
  throw articleError(
    "x_article_title_unsupported",
    `setext title spanning source lines ${split.titleSourceLine}-${split.titleSourceLine + 1}`,
    "a one-line ATX H1 or plain-text title",
    `The X Article title at source lines ${split.titleSourceLine}-${split.titleSourceLine + 1} uses a Setext underline that the native title/body split cannot preserve. ` +
      "Use a one-line ATX H1 or plain title; no artifact or native draft was created.",
  );
}

function safeActiveHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > ARTICLE_HREF_MAX_CODE_UNITS) {
    return null;
  }
  if (
    value.trim() !== value ||
    /[\p{Cc}\p{Cf}\p{Cs}\p{Z}]/u.test(value) ||
    entityLikeTextOffset(value) !== null
  ) return null;
  const authority = value.match(/^https?:\/\/([^/?#]*)/iu)?.[1];
  if (
    authority === undefined ||
    authority === "" ||
    authority.includes("@") ||
    value.includes("\\")
  ) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname === "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return value;
}

function mergeRuns(runs: InlineRun[]): InlineRun[] {
  const merged: InlineRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.href === run.href &&
      !!previous.bold === !!run.bold &&
      !!previous.italic === !!run.italic &&
      !!previous.code === !!run.code &&
      previous.text.length + run.text.length <= ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS
    ) {
      previous.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function inlineRuns(
  value: unknown,
  sourceLine: number,
  context: ArticleParseContext,
  marks: InlineMarks = {},
): InlineRun[] {
  const tokens = tokenArray(value);
  if (!tokens) throw unsupportedInline("invalid", sourceLine);
  const runs: InlineRun[] = [];
  const push = (
    text: string,
    active: InlineMarks = marks,
    evidenceLine = sourceLine,
  ) => {
    if (!text) return;
    const semanticText = text.replace(/\n/gu, " ");
    if (semanticText.length > ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS) {
      throw articleError(
        "x_article_inline_oversized",
        `inline text exceeds the local bound at source line ${evidenceLine}`,
        `at most ${ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS} UTF-16 code units per run`,
        `X Article inline text at source line ${evidenceLine} exceeds the local structural bound. No artifact or native draft was created.`,
      );
    }
    context.runCount += 1;
    if (context.runCount > ARTICLE_MAX_TOTAL_RUNS) {
      throw articleError(
        "x_article_structure_oversized",
        "too many inline runs",
        `at most ${ARTICLE_MAX_TOTAL_RUNS} inline runs`,
        "X Article Markdown has too many inline runs. No artifact or native draft was created.",
      );
    }
    runs.push({
      text: semanticText,
      ...(active.bold ? { bold: true } : {}),
      ...(active.italic ? { italic: true } : {}),
      ...(active.code ? { code: true } : {}),
      ...(active.href ? { href: active.href } : {}),
    });
  };

  let tokenSourceLine = sourceLine;
  for (const token of tokens) {
    if (typeof token.raw !== "string") throw unsupportedInline("invalid", tokenSourceLine);
    switch (token.type) {
      case "text": {
        const nested = tokenArray(token.tokens);
        if (nested) {
          runs.push(...inlineRuns(nested, tokenSourceLine, context, marks));
        } else if (typeof token.text === "string") {
          const entityOffset = entityLikeTextOffset(token.text);
          if (entityOffset !== null) {
            throw unsupportedInline(
              "entity_like_text",
              tokenSourceLine + countNewlines(token.text.slice(0, entityOffset)),
            );
          }
          push(token.text, marks, tokenSourceLine);
        } else {
          throw unsupportedInline("text", tokenSourceLine);
        }
        break;
      }
      case "escape":
        if (typeof token.text !== "string") throw unsupportedInline("escape", tokenSourceLine);
        push(token.text, marks, tokenSourceLine);
        break;
      case "strong":
        runs.push(...inlineRuns(token.tokens, tokenSourceLine, context, { ...marks, bold: true }));
        break;
      case "em":
        runs.push(...inlineRuns(token.tokens, tokenSourceLine, context, { ...marks, italic: true }));
        break;
      case "codespan":
        // The native Article paste path has no verified inline-code style and
        // its HTML/plain renderers intentionally ignore InlineRun.code. Reject
        // rather than silently flattening this CommonMark semantic.
        throw unsupportedInline("inline_code", tokenSourceLine);
      case "link": {
        if (token.title !== null && token.title !== undefined && token.title !== "") {
          throw unsupportedInline("link_title", tokenSourceLine);
        }
        if (
          typeof token.raw !== "string" ||
          typeof token.text !== "string" ||
          typeof token.href !== "string" ||
          exactInlineLinkDestination(token.raw) !== token.href
        ) {
          throw articleError(
            "x_article_link_unsupported",
            `unsafe or unsupported link at source line ${tokenSourceLine}`,
            "an exact safe absolute HTTP(S) link whose source destination is preserved byte-for-byte",
            `X Article Markdown contains an unsafe or source-normalized active link at source line ${tokenSourceLine}. ` +
              "No artifact or native draft was created.",
          );
        }
        const href = safeActiveHref(token.href);
        if (!href) {
          throw articleError(
            "x_article_link_unsupported",
            `unsafe or unsupported link at source line ${tokenSourceLine}`,
            "an exact safe absolute HTTP(S) link without credentials or raw controls",
            `X Article Markdown contains an unsafe or unsupported active link at source line ${tokenSourceLine}. ` +
              "No artifact or native draft was created.",
          );
        }
        const linked = inlineRuns(token.tokens, tokenSourceLine, context, { ...marks, href });
        if (linked.length === 0) throw unsupportedInline("empty_link", tokenSourceLine);
        runs.push(...linked);
        break;
      }
      case "br":
        throw unsupportedInline("hard_break", tokenSourceLine);
      case "image":
        throw unsupportedInline("image", tokenSourceLine);
      case "html":
        throw unsupportedInline("html", tokenSourceLine);
      default:
        throw unsupportedInline(token.type, tokenSourceLine);
    }
    tokenSourceLine += countNewlines(token.raw);
  }
  if (runs.length > ARTICLE_MAX_RUNS_PER_BLOCK) {
    throw articleError(
      "x_article_structure_oversized",
      `too many inline runs at source line ${sourceLine}`,
      `at most ${ARTICLE_MAX_RUNS_PER_BLOCK} inline runs per block`,
      `X Article block at source line ${sourceLine} has too many inline runs. No artifact or native draft was created.`,
    );
  }
  return mergeRuns(runs);
}

function titleText(token: ArticleToken, sourceLine: number): string {
  const context: ArticleParseContext = { blockCount: 0, runCount: 0 };
  const runs = inlineRuns(token.tokens, sourceLine, context);
  if (runs.some((run) => run.bold || run.italic || run.code || run.href)) {
    throw articleError(
      "x_article_title_formatting_unsupported",
      `formatted title at source line ${sourceLine}`,
      "plain or escaped text in the native Article title",
      `The X Article title at source line ${sourceLine} contains formatting the native title field cannot preserve. ` +
        "No artifact or native draft was created.",
    );
  }
  const title = runs.map((run) => run.text).join("");
  if (!title) {
    throw articleError(
      "x_article_title_missing",
      `empty title at source line ${sourceLine}`,
      "a non-empty native Article title",
      `X Article Markdown produced an empty title at source line ${sourceLine}. No artifact or native draft was created.`,
    );
  }
  if (title.length > ARTICLE_TITLE_MAX_CODE_UNITS) {
    throw articleError(
      "x_article_title_oversized",
      `title exceeds the local bound at source line ${sourceLine}`,
      `at most ${ARTICLE_TITLE_MAX_CODE_UNITS} UTF-16 code units`,
      `The X Article title at source line ${sourceLine} exceeds the local structural bound. No artifact or native draft was created.`,
    );
  }
  return title;
}

function nestedFence(value: unknown): boolean {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0) {
    visited += 1;
    if (visited > ARTICLE_MAX_TOTAL_RUNS) {
      throw articleError(
        "x_article_structure_oversized",
        "nested token graph exceeds the local traversal bound",
        `at most ${ARTICLE_MAX_TOTAL_RUNS} nested token values`,
        "X Article Markdown has an excessively nested token structure. No artifact or native draft was created.",
      );
    }
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
      continue;
    }
    const token = asToken(current);
    if (!token) continue;
    if (token.type === "code" && token.codeBlockStyle !== "indented") return true;
    if (token.items !== undefined) stack.push(token.items);
    if (token.tokens !== undefined) stack.push(token.tokens);
  }
  return false;
}

function classifyArticle<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LocalValidationError) throw error;
    throw articleError(
      "x_article_markdown_classification_failed",
      "bounded token classification failed",
      "a supported Article token tree within the local structural bounds",
      "The X Article Markdown token tree could not be classified within the local structural bounds. " +
        "No artifact or native draft was created.",
    );
  }
}

function codeBlock(
  positioned: PositionedArticleToken,
  index: number,
): { block: Extract<ArticleBlock, { kind: "code" }>; flag: CodeBlockFlag } {
  const { token, sourceLine } = positioned;
  if (token.codeBlockStyle === "indented") {
    throw articleError(
      "x_article_indented_code_unsupported",
      `indented code at source line ${sourceLine}`,
      "a top-level fenced code block with zero to three leading spaces",
      `X Article Markdown contains indented code at source line ${sourceLine}, which the native handoff cannot represent losslessly. ` +
        "Use a top-level fenced block; no artifact or native draft was created.",
    );
  }
  if (
    typeof token.raw !== "string" ||
    typeof token.text !== "string" ||
    typeof token.xFenceSourceLength !== "number" ||
    !Number.isSafeInteger(token.xFenceSourceLength) ||
    token.xFenceSourceLength <= 0 ||
    token.xFenceSourceLength > token.raw.length
  ) {
    throw articleError(
      "x_article_fenced_code_boundary_unsupported",
      `unmapped fenced code at source line ${sourceLine}`,
      "a parser-confirmed top-level fence with an exact source slice",
      `An X Article fenced block at source line ${sourceLine} could not be mapped to an exact supported boundary. ` +
        "No artifact or native draft was created.",
    );
  }
  const fenceRaw = token.raw.slice(0, token.xFenceSourceLength);
  const openerLine = fenceRaw.split("\n", 1)[0] ?? "";
  const opener = supportedFenceOpener(openerLine);
  if (!opener) {
    throw articleError(
      "x_article_fenced_code_boundary_unsupported",
      `invalid fenced code boundary at source line ${sourceLine}`,
      "a parser-confirmed top-level CommonMark fence",
      `An X Article fenced block at source line ${sourceLine} did not match the supported CommonMark boundary. ` +
        "No artifact or native draft was created.",
    );
  }
  if (token.xFenceTabIndentLineOffset !== undefined) {
    if (
      typeof token.xFenceTabIndentLineOffset !== "number" ||
      !Number.isSafeInteger(token.xFenceTabIndentLineOffset) ||
      token.xFenceTabIndentLineOffset <= 0
    ) {
      throw articleError(
        "x_article_fenced_code_boundary_unsupported",
        `invalid fenced code indentation evidence at source line ${sourceLine}`,
        "a parser-confirmed top-level CommonMark fence",
        `An X Article fenced block at source line ${sourceLine} had invalid indentation evidence. ` +
          "No artifact or native draft was created.",
      );
    }
    const tabSourceLine = sourceLine + token.xFenceTabIndentLineOffset;
    throw articleError(
      "x_article_fenced_code_tab_indent_unsupported",
      `tab-indented fenced payload at source line ${tabSourceLine}`,
      "under a space-indented fence, tab-leading payload lines preceded by at least the opener indentation in literal spaces",
      `An X Article fenced-code payload line ${tabSourceLine} begins with a tab before the opener's literal-space indentation can be removed exactly. ` +
        "Use literal spaces before that tab or a zero-space fence; no artifact or native draft was created.",
    );
  }
  const info = trimFenceInfo(opener[3]);
  if (info.length > ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS) {
    throw articleError(
      "x_article_structure_oversized",
      `fence info exceeds the local structural bound at source line ${sourceLine}`,
      `at most ${ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS} UTF-16 code units`,
      `The X Article fence info at source line ${sourceLine} exceeds the local structural bound. ` +
        "No artifact or native draft was created.",
    );
  }
  if (token.text.length > ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS) {
    throw articleError(
      "x_article_code_block_oversized",
      `code payload exceeds the local bound at source line ${sourceLine}`,
      `at most ${ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS} UTF-16 code units per block`,
      `The X Article code block at source line ${sourceLine} exceeds the local structural bound. ` +
        "No artifact or native draft was created.",
    );
  }
  // Preserve the pre-#96 advisory spelling. General terminal-safe
  // lang/preview bounding belongs to the immediately stacked issue #95.
  const preview = (token.text.split("\n", 1)[0] ?? "").trim();
  return {
    block: {
      kind: "code" as const,
      index,
      lang: info || undefined,
      text: token.text,
    },
    flag: {
      index,
      lang: info || undefined,
      preview,
      sourceLine,
    },
  };
}

function flatContainerRuns(
  value: unknown,
  sourceLine: number,
  context: ArticleParseContext,
): InlineRun[] {
  const tokens = tokenArray(value);
  if (!tokens || tokens.length !== 1) throw unsupportedBlock("nested_container", sourceLine);
  const only = tokens[0];
  if (only.type !== "paragraph" && only.type !== "text") {
    throw unsupportedBlock("nested_container", sourceLine);
  }
  validateParagraphWhitespaceBlankSource(only, sourceLine);
  return inlineRuns(only.tokens, sourceLine, context);
}

function addBlock(context: ArticleParseContext, blocks: ArticleBlock[], block: ArticleBlock): void {
  context.blockCount += 1;
  if (context.blockCount > ARTICLE_MAX_BLOCKS) {
    throw articleError(
      "x_article_structure_oversized",
      "too many Article blocks",
      `at most ${ARTICLE_MAX_BLOCKS} Article blocks`,
      "X Article Markdown has too many blocks. No artifact or native draft was created.",
    );
  }
  blocks.push(block);
}

function convertBody(positioned: PositionedArticleToken[]): {
  blocks: ArticleBlock[];
  codeFlags: CodeBlockFlag[];
} {
  const context: ArticleParseContext = { blockCount: 0, runCount: 0 };
  const blocks: ArticleBlock[] = [];
  const codeFlags: CodeBlockFlag[] = [];

  for (const entry of positioned) {
    const { token, sourceLine } = entry;
    if (token.type !== "code" && (nestedFence(token.tokens) || nestedFence(token.items))) {
      throw articleError(
        "x_article_nested_fenced_code_unsupported",
        `nested fenced code in container beginning at source line ${sourceLine}`,
        "top-level fenced code outside quote/list containers",
        `X Article Markdown contains a quote/list-nested fenced block in the container beginning at source line ${sourceLine}. ` +
          "Move the fence to the top level; no artifact or native draft was created.",
      );
    }

    switch (token.type) {
      case "space":
        break;
      case "paragraph": {
        const runs = inlineRuns(token.tokens, sourceLine, context);
        if (runs.length === 0) throw unsupportedBlock("empty_paragraph", sourceLine);
        addBlock(context, blocks, { kind: "paragraph", runs });
        break;
      }
      case "heading": {
        const firstLine = typeof token.raw === "string" ? token.raw.split("\n", 1)[0] ?? "" : "";
        if (!/^ {0,3}#{1,6}(?:[ \t]+|$)/u.test(firstLine)) {
          const isSetext = typeof token.raw === "string" &&
            /(?:^|\n) {0,3}(?:=+|-+)[ \t]*(?:\n|$)/u.test(token.raw);
          throw unsupportedBlock(isSetext ? "setext_heading" : "source_normalized_heading", sourceLine);
        }
        if (token.depth !== 1 && token.depth !== 2) {
          throw unsupportedBlock("heading_level", sourceLine);
        }
        const runs = inlineRuns(token.tokens, sourceLine, context);
        if (runs.length === 0) throw unsupportedBlock("empty_heading", sourceLine);
        addBlock(context, blocks, {
          kind: "heading",
          level: token.depth,
          runs,
        });
        break;
      }
      case "blockquote": {
        const runs = flatContainerRuns(token.tokens, sourceLine, context);
        if (runs.length === 0) throw unsupportedBlock("empty_quote", sourceLine);
        addBlock(context, blocks, { kind: "quote", runs });
        break;
      }
      case "list": {
        if (
          !Array.isArray(token.items) ||
          typeof token.ordered !== "boolean" ||
          token.loose === true ||
          (token.ordered && token.start !== 1)
        ) {
          throw unsupportedBlock(token.ordered && token.start !== 1 ? "ordered_list_start" : "list", sourceLine);
        }
        const listKind = token.ordered ? "ordered" : "bullet";
        if (blocks[blocks.length - 1]?.kind === listKind) {
          // ArticleBlock represents list items, while the renderer groups
          // adjacent items of one kind. Two distinct CommonMark list roots
          // would therefore be silently merged/reset without a boundary fact.
          throw unsupportedBlock("list_boundary", sourceLine);
        }
        let itemSourceLine = sourceLine;
        for (const itemValue of token.items) {
          const item = asToken(itemValue);
          if (!item || typeof item.raw !== "string" || item.task === true || item.loose === true) {
            throw unsupportedBlock("nested_or_task_list", itemSourceLine);
          }
          const runs = flatContainerRuns(item.tokens, itemSourceLine, context);
          if (runs.length === 0) throw unsupportedBlock("empty_list_item", itemSourceLine);
          addBlock(context, blocks, {
            kind: listKind,
            runs,
          });
          itemSourceLine += countNewlines(item.raw);
        }
        break;
      }
      case "code": {
        if (codeFlags.length >= ARTICLE_MAX_FLAGS) {
          throw articleError(
            "x_article_structure_oversized",
            "too many fenced-code advisories",
            `at most ${ARTICLE_MAX_FLAGS} fenced code blocks`,
            "X Article Markdown has too many fenced code blocks. No artifact or native draft was created.",
          );
        }
        const mapped = codeBlock(entry, codeFlags.length + 1);
        addBlock(context, blocks, mapped.block);
        codeFlags.push(mapped.flag);
        break;
      }
      case "html":
      case "hr":
      case "def":
        throw unsupportedBlock(token.type, sourceLine);
      default:
        throw unsupportedBlock(token.type, sourceLine);
    }
  }
  return {
    blocks,
    codeFlags,
  };
}

function bareUrlCandidates(value: string): string[] {
  const urls: string[] = [];
  // Keep the established advisory-only grammar byte-for-byte compatible with
  // the pre-#96 collector. Active links use the stricter structured path.
  for (const match of value.matchAll(/(?<![("])\bhttps?:\/\/[^\s)]+/gu)) {
    const exact = match[0].replace(/[.,;:]+$/u, "");
    if (exact) urls.push(exact);
  }
  return urls;
}

function codeAdvisoryCandidates(value: string): Array<{ url: string; text?: string }> {
  const candidates: Array<{ url: string; text?: string }> = [];
  for (const match of value.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gu)) {
    candidates.push({ url: match[2], ...(match[1] ? { text: match[1] } : {}) });
  }
  for (const url of bareUrlCandidates(value)) candidates.push({ url });
  return candidates;
}

function linkFlags(blocks: ArticleBlock[]): LinkFlag[] {
  const flags: LinkFlag[] = [];
  const seen = new Set<string>();
  const pushBare = (url: string, text?: string) => {
    if (seen.has(url)) return;
    if (url.length > ARTICLE_HREF_MAX_CODE_UNITS) {
      throw articleError(
        "x_article_link_advisory_oversized",
        "URL-looking advisory exceeds the local structural bound",
        `at most ${ARTICLE_HREF_MAX_CODE_UNITS} UTF-16 code units`,
        "An X Article URL-looking advisory exceeds the local structural bound. No artifact or native draft was created.",
      );
    }
    if (text !== undefined && text.length > ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS) {
      throw articleError(
        "x_article_link_advisory_oversized",
        "advisory link label exceeds the local structural bound",
        `at most ${ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS} UTF-16 code units`,
        "An X Article advisory link label exceeds the local structural bound. No artifact or native draft was created.",
      );
    }
    if (flags.length >= ARTICLE_MAX_FLAGS) {
      throw articleError(
        "x_article_structure_oversized",
        "too many link advisories",
        `at most ${ARTICLE_MAX_FLAGS} link advisories`,
        "X Article Markdown has too many link advisories. No artifact or native draft was created.",
      );
    }
    seen.add(url);
    flags.push({ url, ...(text ? { text } : {}), note: LINK_NOTE });
  };
  for (const block of blocks) {
    if (block.kind === "code") {
      // Code is excluded from native HTML/plain input, but URL-looking source
      // still remains a detached advisory fact. It never becomes an active
      // href and therefore does not receive the active-href policy.
      for (const candidate of codeAdvisoryCandidates(`${block.lang ?? ""}\n${block.text}`)) {
        pushBare(candidate.url, candidate.text);
      }
      continue;
    }
    for (let index = 0; index < block.runs.length; index += 1) {
      const run = block.runs[index];
      if (run.href) {
        let label = run.text;
        while (index + 1 < block.runs.length && block.runs[index + 1].href === run.href) {
          index += 1;
          label += block.runs[index].text;
        }
        if (label.length > ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS) {
          throw articleError(
            "x_article_link_advisory_oversized",
            "active link label exceeds the local structural bound",
            `at most ${ARTICLE_BLOCK_TEXT_MAX_CODE_UNITS} UTF-16 code units`,
            "An X Article link label exceeds the local structural bound. No artifact or native draft was created.",
          );
        }
        if (!seen.has(run.href)) {
          if (flags.length >= ARTICLE_MAX_FLAGS) {
            throw articleError(
              "x_article_structure_oversized",
              "too many link advisories",
              `at most ${ARTICLE_MAX_FLAGS} link advisories`,
              "X Article Markdown has too many link advisories. No artifact or native draft was created.",
            );
          }
          seen.add(run.href);
          flags.push({ url: run.href, ...(label ? { text: label } : {}), note: LINK_NOTE });
        }
        continue;
      }
      for (const url of bareUrlCandidates(run.text)) {
        pushBare(url);
      }
    }
  }
  return flags;
}

function normalizedSourceLineOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function validateStageTextBudget(
  markdown: string,
  title: string,
  blocks: ArticleBlock[],
  codeFlags: CodeBlockFlag[],
  flags: LinkFlag[],
): void {
  let total = markdown.length + title.length;
  for (const block of blocks) {
    if (block.kind === "code") {
      total += block.text.length + (block.lang?.length ?? 0);
      continue;
    }
    for (const run of block.runs) total += run.text.length + (run.href?.length ?? 0);
  }
  for (const flag of codeFlags) {
    total += flag.preview.length + (flag.lang?.length ?? 0);
  }
  for (const flag of flags) {
    total += flag.url.length + (flag.text?.length ?? 0) + flag.note.length;
  }
  if (total > ARTICLE_STAGE_TEXT_MAX_CODE_UNITS) {
    throw articleError(
      "x_article_structure_oversized",
      "Article structured text exceeds the local aggregate bound",
      `at most ${ARTICLE_STAGE_TEXT_MAX_CODE_UNITS} copied UTF-16 code units`,
      "X Article structured text exceeds the local aggregate bound. No artifact or native draft was created.",
    );
  }
}

export function parseXArticleMarkdown(
  source: string,
  sourceLineOffset = 0,
): ParsedXArticleMarkdown {
  return classifyArticle(() => {
    const offset = normalizedSourceLineOffset(sourceLineOffset);
    const markdown = normalizedArticleMarkdown(source, offset);
    const split = splitTitle(markdown, offset);
    const titleToken = lexTitleBlock(split.titleLine, split.titleSourceLine);
    rejectConsumedSetextTitle(split, titleToken);
    validateTitleSourceBoundary(split.titleLine, titleToken, split.titleSourceLine);
    const title = titleText(titleToken, split.titleSourceLine);
    const converted = convertBody(lexBody(split.body, split.bodySourceLineOffset));
    const codeBlockCount = converted.blocks.reduce(
      (count, block) => count + (block.kind === "code" ? 1 : 0),
      0,
    );
    if (codeBlockCount !== converted.codeFlags.length) {
      throw articleError(
        "x_article_code_block_accounting_mismatch",
        `${converted.codeFlags.length} advisories; ${codeBlockCount} structured code blocks`,
        "one structured Article code block for every fenced-code advisory",
        "X Article fenced-code parsing produced inconsistent structured facts. No artifact or native draft was created.",
      );
    }
    const flags = linkFlags(converted.blocks);
    validateStageTextBudget(markdown, title, converted.blocks, converted.codeFlags, flags);
    return {
      title,
      markdown,
      blocks: converted.blocks,
      codeFlags: converted.codeFlags,
      linkFlags: flags,
      codeBlockCount,
    };
  });
}

/** Direct helper retained for parser-focused tests and callers with a body only. */
export function parseXArticleBlocks(body: string): ArticleBlock[] {
  return classifyArticle(() => {
    const normalized = normalizedArticleMarkdown(body);
    return convertBody(lexBody(normalized, 0)).blocks;
  });
}

/** Direct helper retained for parser-focused tests. */
export function parseXArticleInlineRuns(text: string): InlineRun[] {
  const normalized = normalizedArticleMarkdown(text);
  let tokens: unknown[];
  try {
    tokens = Lexer.lexInline(normalized, { gfm: false }) as unknown[];
  } catch {
    throw articleError(
      "x_article_markdown_parse_failed",
      "inline_parser_failed",
      "a deterministic CommonMark inline token tree",
      "The X Article inline parser could not classify the text. No artifact or native draft was created.",
    );
  }
  return classifyArticle(() => inlineRuns(tokens, 1, { blockCount: 0, runCount: 0 }));
}

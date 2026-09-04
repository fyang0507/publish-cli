import { isProxy } from "node:util/types";

/** Minimal screenshot advisory shared by the existing channel generators. */
export interface CodeBlockFlag {
  /** 1-based index among code blocks in the source. */
  index: number;
  /** Fence language/info label, if any. */
  lang?: string;
  /** Bounded first-line identification evidence. */
  preview: string;
  /** Exact source line where the parser-confirmed fence opened. */
  sourceLine: number;
}

export const X_CODE_INFO_MAX_CODE_POINTS = 80;
export const X_CODE_PREVIEW_MAX_CODE_POINTS = 120;
export const X_ARTICLE_CODE_LINK_URL_MAX_CODE_POINTS = 512;
export const X_ARTICLE_CODE_LINK_TEXT_MAX_CODE_POINTS = 240;
export const X_ARTICLE_CODE_LINK_NOTE =
  "URL-looking text came from Article code excluded from native rich HTML; this is inert advisory evidence, not an active link.";

/**
 * An Article code advisory is the closed identity retained when its exact
 * payload is deliberately excluded from the native rich-HTML paste.
 */
export interface ArticleCodeBlockFlag extends CodeBlockFlag {
  kind: "article_code_block";
  /** Article flags always carry this key; undefined means no info string. */
  lang: string | undefined;
  /** Inclusive original-input and canonical-Markdown line bounds. */
  sourceEndLine: number;
  sourceLineCount: number;
  markdownStartLine: number;
  markdownEndLine: number;
  fence: "backtick" | "tilde";
  closure: "explicit" | "end_of_input";
  /** True only when the exact hashed fence slice ends in a caller LF. */
  sourceTerminalNewline: boolean;
  /** Same bounded safe info prefix exposed through `lang`, without decoration. */
  infoString: string | null;
  infoStringTruncated: boolean;
  previewTruncated: boolean;
  digestNormalization: "lf_normalized_exact_fence_source";
  /** SHA-256 of opener + payload + explicit closer, preserving an EOF payload LF. */
  normalizedSourceSha256: string;
}

export interface ArticleCodeLinkAdvisory {
  url: string;
  text?: string;
  note: typeof X_ARTICLE_CODE_LINK_NOTE;
  advisorySource: "excluded_article_code";
  codeBlockIndex: number;
  urlTruncated: boolean;
  textTruncated: boolean;
}

/** Complete evidence is retained only while the full receipt remains bounded. */
export const X_ARTICLE_CODE_ADVISORY_COUNT_MAX = 10_000;
export const X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS = 1_000_000;
export const X_ARTICLE_LINK_ADVISORY_COUNT_MAX = 50_000;

const LEGACY_UNSAFE_TERMINAL_EVIDENCE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const ARTICLE_UNSAFE_TERMINAL_EVIDENCE_TEST = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/**
 * Match #59's NFC + visible Unicode-escape representation and code-point
 * bounds. The complete source is identified separately by its digest.
 */
export function terminalSafeBoundedCodeEvidence(
  value: string,
  maximumCodePoints: number,
): { value: string; truncated: boolean } {
  const safe = value.normalize("NFC").replace(
    LEGACY_UNSAFE_TERMINAL_EVIDENCE,
    (character) => {
      const point = character.codePointAt(0) ?? 0;
      return `\\u{${point.toString(16).padStart(2, "0")}}`;
    },
  );
  const codePoints = Array.from(safe);
  return {
    value: codePoints.slice(0, maximumCodePoints).join(""),
    truncated: codePoints.length > maximumCodePoints,
  };
}

/**
 * Article evidence keeps visible escapes atomic. Its digest contract rejects
 * unpaired surrogates separately, so every accepted source has unique UTF-8
 * bytes under the declared LF-normalized hash.
 */
export function terminalSafeBoundedArticleCodeEvidence(
  value: string,
  maximumCodePoints: number,
): { value: string; truncated: boolean } {
  const normalized = value.normalize("NFC");
  let safe = "";
  let used = 0;
  let consumed = 0;
  const characters = Array.from(normalized);
  for (const character of characters) {
    const point = character.codePointAt(0) ?? 0;
    const representation = ARTICLE_UNSAFE_TERMINAL_EVIDENCE_TEST.test(character)
      ? `\\u{${point.toString(16).padStart(2, "0")}}`
      : character;
    const width = Array.from(representation).length;
    if (used + width > maximumCodePoints) break;
    safe += representation;
    used += width;
    consumed += 1;
  }
  return { value: safe, truncated: consumed < characters.length };
}

/** UTF-16 offset of the first unpaired surrogate, or -1. */
export function unpairedSurrogateOffset(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return index;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return index;
  }
  return -1;
}

export function isTerminalSafeBoundedCodeEvidence(
  value: string,
  maximumCodePoints: number,
): boolean {
  if (
    typeof value !== "string" ||
    !Number.isSafeInteger(maximumCodePoints) ||
    maximumCodePoints < 0 ||
    value.length > maximumCodePoints * 2
  ) return false;
  return value.normalize("NFC") === value &&
    !ARTICLE_UNSAFE_TERMINAL_EVIDENCE_TEST.test(value) &&
    Array.from(value).length <= maximumCodePoints;
}

function boundedEvidence(value: string | null, truncated: boolean): string {
  if (value === null) return `none (truncated=${String(truncated)})`;
  return `${JSON.stringify(value)} (truncated=${String(truncated)})`;
}

/** One bounded terminal-safe line used by stdout, dry-run, and save receipts. */
export function renderXArticleCodeAdvisory(value: unknown): string {
  if (!isArticleCodeBlockFlag(value)) {
    return "[Article code advisory failed closed validation; no caller evidence rendered.]";
  }
  const flag = value;
  const sourceLines = flag.sourceLine === flag.sourceEndLine
    ? String(flag.sourceLine)
    : `${flag.sourceLine}-${flag.sourceEndLine}`;
  const markdownLines = flag.markdownStartLine === flag.markdownEndLine
    ? String(flag.markdownStartLine)
    : `${flag.markdownStartLine}-${flag.markdownEndLine}`;
  return (
    `CODE BLOCK #${flag.index} excluded from native rich HTML; ` +
    `sourceLines=${sourceLines}, canonicalMarkdownLines=${markdownLines}, ` +
    `lineCount=${flag.sourceLineCount}, fence=${flag.fence}, closure=${flag.closure}, ` +
    `sourceTerminalNewline=${String(flag.sourceTerminalNewline)}, ` +
    `info=${boundedEvidence(flag.infoString, flag.infoStringTruncated)}, ` +
    `preview=${boundedEvidence(flag.preview, flag.previewTruncated)}, ` +
    `digestNormalization=${flag.digestNormalization}, ` +
    `LF-normalized exact fence source sha256=${flag.normalizedSourceSha256}.`
  );
}

/** Maximum outer framing used for one code-advisory detail line in human sinks. */
export function renderXArticleCodeAdvisoryDetailLine(value: unknown): string {
  return `  ${renderXArticleCodeAdvisory(value)}`;
}

export function articleCodeAdvisoryRenderSize(
  flags: readonly ArticleCodeBlockFlag[],
): number {
  let total = 0;
  for (const flag of flags) {
    // Count the two-space outer prefix shared by current human sinks plus the
    // separating LF, so the bound matches the emitted detailed lines exactly.
    total += renderXArticleCodeAdvisoryDetailLine(flag).length + 1;
  }
  return total;
}

/**
 * Keep canonical Markdown untouched on disk while ensuring excluded code never
 * reaches a terminal. Invalid ranges fail closed to a content-free marker.
 */
export function articleMarkdownForTerminal(
  markdown: string,
  flags: readonly ArticleCodeBlockFlag[],
): string {
  if (flags.length === 0) return markdown;
  let newlineCount = 0;
  for (let offset = markdown.indexOf("\n"); offset !== -1; offset = markdown.indexOf("\n", offset + 1)) {
    newlineCount += 1;
  }
  const physicalLineCount = newlineCount + (markdown.endsWith("\n") ? 0 : 1);
  const out: string[] = [];
  let nextLine = 1;
  let nextSourceOffset = 0;
  let locatedLine = 1;
  let locatedOffset = 0;
  const locateLineStart = (targetLine: number): number | null => {
    while (locatedLine < targetLine) {
      const newlineOffset = markdown.indexOf("\n", locatedOffset);
      if (newlineOffset === -1) return null;
      locatedLine += 1;
      locatedOffset = newlineOffset + 1;
    }
    return locatedLine === targetLine ? locatedOffset : null;
  };
  for (const flag of flags) {
    if (
      !isArticleCodeBlockFlag(flag) ||
      flag.markdownStartLine < nextLine ||
      flag.markdownEndLine > physicalLineCount
    ) {
      return "[Article Markdown terminal preview unavailable: code-advisory ranges failed closed validation.]";
    }
    const blockStartOffset = locateLineStart(flag.markdownStartLine);
    const blockEndLineOffset = locateLineStart(flag.markdownEndLine);
    if (blockStartOffset === null || blockEndLineOffset === null) {
      return "[Article Markdown terminal preview unavailable: code-advisory ranges failed closed validation.]";
    }
    out.push(markdown.slice(nextSourceOffset, blockStartOffset));
    out.push(
      `[X Article code block #${flag.index} excluded from terminal preview; ` +
        `sha256=${flag.normalizedSourceSha256}]`,
    );
    const newlineAfterBlock = markdown.indexOf("\n", blockEndLineOffset);
    nextSourceOffset = newlineAfterBlock === -1 ? markdown.length : newlineAfterBlock;
    nextLine = flag.markdownEndLine + 1;
  }
  out.push(markdown.slice(nextSourceOffset));
  return out.join("");
}

const ARTICLE_FLAG_REQUIRED_KEYS = [
  "kind",
  "index",
  "lang",
  "preview",
  "sourceLine",
  "sourceEndLine",
  "sourceLineCount",
  "markdownStartLine",
  "markdownEndLine",
  "fence",
  "closure",
  "sourceTerminalNewline",
  "infoString",
  "infoStringTruncated",
  "previewTruncated",
  "digestNormalization",
  "normalizedSourceSha256",
] as const;

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function exactBoundedLiteral(value: unknown, expected: string): boolean {
  return typeof value === "string" &&
    value.length === expected.length &&
    value === expected;
}

export function isArticleCodeBlockFlag(value: unknown): value is ArticleCodeBlockFlag {
  if (typeof value !== "object" || value === null) return false;
  try {
    if (isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== ARTICLE_FLAG_REQUIRED_KEYS.length ||
      keys.some((key) => typeof key !== "string" ||
        !(ARTICLE_FLAG_REQUIRED_KEYS as readonly string[]).includes(key))
    ) return false;
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of ARTICLE_FLAG_REQUIRED_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
      descriptors.set(key, descriptor);
    }
    const read = (key: typeof ARTICLE_FLAG_REQUIRED_KEYS[number]): unknown =>
      descriptors.get(key)?.value;
    const kind = read("kind");
    const index = read("index");
    const lang = read("lang");
    const preview = read("preview");
    const sourceLine = read("sourceLine");
    const sourceEndLine = read("sourceEndLine");
    const sourceLineCount = read("sourceLineCount");
    const markdownStartLine = read("markdownStartLine");
    const markdownEndLine = read("markdownEndLine");
    const fence = read("fence");
    const closure = read("closure");
    const sourceTerminalNewline = read("sourceTerminalNewline");
    const infoString = read("infoString");
    const infoStringTruncated = read("infoStringTruncated");
    const previewTruncated = read("previewTruncated");
    const digestNormalization = read("digestNormalization");
    const normalizedSourceSha256 = read("normalizedSourceSha256");
    if (
      !exactBoundedLiteral(kind, "article_code_block") ||
      !positiveSafeInteger(index) ||
      !positiveSafeInteger(sourceLine) ||
      !positiveSafeInteger(sourceEndLine) ||
      !positiveSafeInteger(sourceLineCount) ||
      !positiveSafeInteger(markdownStartLine) ||
      !positiveSafeInteger(markdownEndLine) ||
      sourceEndLine < sourceLine ||
      markdownEndLine < markdownStartLine ||
      sourceLineCount !== sourceEndLine - sourceLine + 1 ||
      sourceLineCount !== markdownEndLine - markdownStartLine + 1 ||
      (typeof fence !== "string" ||
        fence.length > "backtick".length ||
        (fence !== "backtick" && fence !== "tilde")) ||
      (typeof closure !== "string" ||
        closure.length > "end_of_input".length ||
        (closure !== "explicit" && closure !== "end_of_input")) ||
      typeof sourceTerminalNewline !== "boolean" ||
      (closure === "explicit" &&
        (sourceTerminalNewline || sourceLineCount < 2)) ||
      typeof infoStringTruncated !== "boolean" ||
      typeof previewTruncated !== "boolean" ||
      typeof preview !== "string" ||
      !isTerminalSafeBoundedCodeEvidence(preview, X_CODE_PREVIEW_MAX_CODE_POINTS) ||
      !exactBoundedLiteral(
        digestNormalization,
        "lf_normalized_exact_fence_source",
      ) ||
      typeof normalizedSourceSha256 !== "string" ||
      normalizedSourceSha256.length !== 64 ||
      !/^[a-f0-9]{64}$/u.test(normalizedSourceSha256)
    ) return false;
    if (infoString === null) {
      if (lang !== undefined || infoStringTruncated) return false;
    } else if (
      typeof infoString !== "string" ||
      infoString.length === 0 ||
      infoString.length > X_CODE_INFO_MAX_CODE_POINTS * 2 ||
      typeof lang !== "string" ||
      lang.length > X_CODE_INFO_MAX_CODE_POINTS * 2 ||
      !isTerminalSafeBoundedCodeEvidence(infoString, X_CODE_INFO_MAX_CODE_POINTS) ||
      lang !== infoString
    ) return false;
    return true;
  } catch {
    return false;
  }
}

/** Closed copy of URL-looking evidence derived from excluded Article code. */
export function snapshotXArticleCodeLinkAdvisory(
  value: unknown,
): Readonly<ArticleCodeLinkAdvisory> | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    if (isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const required = [
      "url",
      "note",
      "advisorySource",
      "codeBlockIndex",
      "urlTruncated",
      "textTruncated",
    ] as const;
    const allowed = new Set<string>([...required, "text"]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length < required.length ||
      keys.length > allowed.size ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key))
    ) return null;
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      descriptors.set(key, descriptor);
    }
    if (required.some((key) => !descriptors.has(key))) return null;
    const url = descriptors.get("url")?.value;
    const text = descriptors.get("text")?.value;
    const note = descriptors.get("note")?.value;
    const advisorySource = descriptors.get("advisorySource")?.value;
    const codeBlockIndex = descriptors.get("codeBlockIndex")?.value;
    const urlTruncated = descriptors.get("urlTruncated")?.value;
    const textTruncated = descriptors.get("textTruncated")?.value;
    if (
      typeof url !== "string" ||
      !isTerminalSafeBoundedCodeEvidence(url, X_ARTICLE_CODE_LINK_URL_MAX_CODE_POINTS) ||
      !/^https?:\/\/\S+$/u.test(url) ||
      (descriptors.has("text") && text === undefined) ||
      (text !== undefined &&
        (typeof text !== "string" ||
          text.length === 0 ||
          !isTerminalSafeBoundedCodeEvidence(text, X_ARTICLE_CODE_LINK_TEXT_MAX_CODE_POINTS))) ||
      !exactBoundedLiteral(note, X_ARTICLE_CODE_LINK_NOTE) ||
      !exactBoundedLiteral(advisorySource, "excluded_article_code") ||
      !positiveSafeInteger(codeBlockIndex) ||
      typeof urlTruncated !== "boolean" ||
      typeof textTruncated !== "boolean" ||
      (text === undefined && textTruncated)
    ) return null;
    return Object.freeze({
      url,
      ...(text === undefined ? {} : { text }),
      note,
      advisorySource,
      codeBlockIndex,
      urlTruncated,
      textTruncated,
    });
  } catch {
    return null;
  }
}

export function renderXArticleCodeLinkAdvisory(value: unknown): string {
  const flag = snapshotXArticleCodeLinkAdvisory(value);
  if (!flag) {
    return "  [Excluded-code link advisory failed closed validation; no caller evidence rendered.]";
  }
  return (
    `  CODE LINK ADVISORY block=${flag.codeBlockIndex}, ` +
    `url=${JSON.stringify(flag.url)} (truncated=${String(flag.urlTruncated)}), ` +
    `text=${flag.text === undefined ? "none" : JSON.stringify(flag.text)} ` +
    `(truncated=${String(flag.textTruncated)}): ${flag.note}`
  );
}

export function articleCodeLinkAdvisoryRenderSize(
  flags: readonly ArticleCodeLinkAdvisory[],
): number {
  let total = 0;
  for (const flag of flags) total += renderXArticleCodeLinkAdvisory(flag).length + 1;
  return total;
}

/** Strict detached array copy for Article receipt and handoff boundaries. */
export function snapshotXArticleCodeLinkAdvisories(
  value: unknown,
): readonly Readonly<ArticleCodeLinkAdvisory>[] | null {
  try {
    if (!Array.isArray(value)) return null;
    if (isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = value.length;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > X_ARTICLE_LINK_ADVISORY_COUNT_MAX
    ) return null;
    const expectedKeys = new Set<PropertyKey>(["length"]);
    const out: Readonly<ArticleCodeLinkAdvisory>[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      expectedKeys.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      const copied = snapshotXArticleCodeLinkAdvisory(descriptor.value);
      if (!copied) return null;
      out.push(copied);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
      return null;
    }
    if (
      articleCodeLinkAdvisoryRenderSize(out) >
        X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS
    ) return null;
    return Object.freeze(out);
  } catch {
    return null;
  }
}

export function sameXArticleCodeLinkAdvisories(
  left: readonly Readonly<ArticleCodeLinkAdvisory>[],
  right: readonly Readonly<ArticleCodeLinkAdvisory>[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      Object.prototype.hasOwnProperty.call(a, "text") !==
        Object.prototype.hasOwnProperty.call(b, "text") ||
      a.url !== b.url ||
      a.text !== b.text ||
      a.note !== b.note ||
      a.advisorySource !== b.advisorySource ||
      a.codeBlockIndex !== b.codeBlockIndex ||
      a.urlTruncated !== b.urlTruncated ||
      a.textTruncated !== b.textTruncated
    ) return false;
  }
  return true;
}

export interface ArticleCodeLinkSource {
  codeBlockIndex: number;
  infoString: string;
  codeText: string;
}

interface ArticleCodeLinkCandidate {
  url: string;
  text?: string;
}

type ArticleCodeLinkCandidateVisitor = (
  candidate: ArticleCodeLinkCandidate,
) => boolean;

const ARTICLE_CODE_LINK_WHITESPACE = /\s/u;

/**
 * Monotonic state-machine equivalent of
 * /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gu. It retains only the earliest
 * pending match because every candidate in one non-whitespace URL span shares
 * its first closing parenthesis; a successful leftmost match consumes the rest.
 */
function visitArticleCodeMarkdownLinks(
  value: string,
  visit: ArticleCodeLinkCandidateVisitor,
): boolean {
  interface PendingMarkdownLink {
    labelStart: number;
    labelEnd: number;
    urlStart: number;
    urlContentStart: number;
  }

  let labelStart = -1;
  let pending: PendingMarkdownLink | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character === "[") {
      if (labelStart === -1) labelStart = index;
      continue;
    }
    if (character === "]") {
      if (labelStart !== -1 && value[index + 1] === "(") {
        const urlStart = index + 2;
        const urlContentStart = value.startsWith("http://", urlStart)
          ? urlStart + "http://".length
          : value.startsWith("https://", urlStart)
            ? urlStart + "https://".length
            : -1;
        if (urlContentStart !== -1) {
          const candidate = {
            labelStart,
            labelEnd: index,
            urlStart,
            urlContentStart,
          };
          if (pending === null || candidate.labelStart < pending.labelStart) {
            pending = candidate;
          }
        }
      }
      // Every '[' since the preceding ']' shares this first possible close.
      labelStart = -1;
      continue;
    }

    if (character === ")" || ARTICLE_CODE_LINK_WHITESPACE.test(character)) {
      if (
        character === ")" &&
        pending !== null &&
        index > pending.urlContentStart
      ) {
        const text = value.slice(pending.labelStart + 1, pending.labelEnd);
        if (!visit({
          url: value.slice(pending.urlStart, index),
          ...(text ? { text } : {}),
        })) return false;
        // MatchAll resumes after the closing parenthesis of a successful match.
        labelStart = -1;
      }
      pending = null;
    }
  }
  return true;
}

function asciiWordCodeUnit(value: string, index: number): boolean {
  if (index < 0) return false;
  const code = value.charCodeAt(index);
  return (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f;
}

/** Monotonic equivalent of /(?<![("])\bhttps?:\/\/[^\s)]+/gu. */
function visitArticleCodeBareLinks(
  value: string,
  visit: ArticleCodeLinkCandidateVisitor,
): boolean {
  let searchOffset = 0;
  while (searchOffset < value.length) {
    const start = value.indexOf("http", searchOffset);
    if (start === -1) return true;
    const contentStart = value.startsWith("http://", start)
      ? start + "http://".length
      : value.startsWith("https://", start)
        ? start + "https://".length
        : -1;
    const previous = start === 0 ? "" : value[start - 1] ?? "";
    if (
      contentStart === -1 ||
      previous === "(" ||
      previous === '"' ||
      asciiWordCodeUnit(value, start - 1)
    ) {
      searchOffset = start + 1;
      continue;
    }

    let end = contentStart;
    while (
      end < value.length &&
      value[end] !== ")" &&
      !ARTICLE_CODE_LINK_WHITESPACE.test(value[end] ?? "")
    ) end += 1;
    if (end === contentStart) {
      searchOffset = start + 1;
      continue;
    }
    let exactEnd = end;
    while (exactEnd > start && ".,;:".includes(value[exactEnd - 1] ?? "")) {
      exactEnd -= 1;
    }
    if (!visit({ url: value.slice(start, exactEnd) })) return false;
    searchOffset = end;
  }
  return true;
}

function visitArticleCodeLinkCandidates(
  value: string,
  visit: ArticleCodeLinkCandidateVisitor,
): boolean {
  // Preserve the established ordering: every Markdown link first, followed by
  // every bare URL, with source order retained inside each group.
  return visitArticleCodeMarkdownLinks(value, visit) &&
    visitArticleCodeBareLinks(value, visit);
}

/** Deterministic safe projection of exact info/deindented payload link text. */
export function collectXArticleCodeLinkAdvisories(
  sources: readonly ArticleCodeLinkSource[],
): readonly Readonly<ArticleCodeLinkAdvisory>[] | null {
  const flags: Readonly<ArticleCodeLinkAdvisory>[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!positiveSafeInteger(source.codeBlockIndex)) return null;
    const complete = visitArticleCodeLinkCandidates(
      `${source.infoString}\n${source.codeText}`,
      (candidate) => {
      // A serialized tuple is injective for arbitrary JS strings; raw NUL and
      // other caller scalars cannot alias the field boundary before escaping.
      const key = JSON.stringify([
        source.codeBlockIndex,
        candidate.url,
        candidate.text ?? null,
      ]);
      if (seen.has(key)) return true;
      if (flags.length >= X_ARTICLE_LINK_ADVISORY_COUNT_MAX) return false;
      seen.add(key);
      const safeUrl = terminalSafeBoundedArticleCodeEvidence(
        candidate.url,
        X_ARTICLE_CODE_LINK_URL_MAX_CODE_POINTS,
      );
      const safeText = candidate.text === undefined
        ? { value: "", truncated: false }
        : terminalSafeBoundedArticleCodeEvidence(
            candidate.text,
            X_ARTICLE_CODE_LINK_TEXT_MAX_CODE_POINTS,
          );
      flags.push(Object.freeze({
        url: safeUrl.value,
        ...(candidate.text === undefined ? {} : { text: safeText.value }),
        note: X_ARTICLE_CODE_LINK_NOTE,
        advisorySource: "excluded_article_code",
        codeBlockIndex: source.codeBlockIndex,
        urlTruncated: safeUrl.truncated,
        textTruncated: safeText.truncated,
      }));
      return true;
    });
    if (!complete) return null;
  }
  return Object.freeze(flags);
}

/** Strict detached copy for the untrusted resolved-result handoff boundary. */
export function snapshotXArticleCodeAdvisories(
  value: unknown,
): readonly ArticleCodeBlockFlag[] | null {
  try {
    if (!Array.isArray(value)) return null;
    if (isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > X_ARTICLE_CODE_ADVISORY_COUNT_MAX) {
      return null;
    }
    const expectedKeys = new Set<PropertyKey>(["length"]);
    const out: ArticleCodeBlockFlag[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      expectedKeys.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      const entry = descriptor.value;
      if (!isArticleCodeBlockFlag(entry)) return null;
      const copy = Object.freeze({ ...entry });
      if (copy.index !== index + 1) return null;
      out.push(copy);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
      return null;
    }
    if (articleCodeAdvisoryRenderSize(out) > X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS) {
      return null;
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

export function sameXArticleCodeAdvisories(
  left: readonly ArticleCodeBlockFlag[],
  right: readonly ArticleCodeBlockFlag[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    for (const key of ARTICLE_FLAG_REQUIRED_KEYS) {
      if (a[key] !== b[key]) return false;
    }
  }
  return true;
}

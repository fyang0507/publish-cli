import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import type {
  ArticleBlock,
  GeneratedContent,
  InlineRun,
  LinkFlag,
  XFormat,
} from "./content.js";
import { parseXArticleMarkdown } from "./articleMarkdown.js";
import {
  articleCodeAdvisoryRenderSize,
  articleCodeLinkAdvisoryRenderSize,
  collectXArticleCodeLinkAdvisories,
  isTerminalSafeBoundedCodeEvidence,
  sameXArticleCodeAdvisories,
  sameXArticleCodeLinkAdvisories,
  terminalSafeBoundedArticleCodeEvidence,
  unpairedSurrogateOffset,
  X_ARTICLE_CODE_ADVISORY_COUNT_MAX,
  X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS,
  X_ARTICLE_CODE_LINK_TEXT_MAX_CODE_POINTS,
  X_ARTICLE_CODE_LINK_URL_MAX_CODE_POINTS,
  X_ARTICLE_CODE_LINK_NOTE,
  X_CODE_INFO_MAX_CODE_POINTS,
  X_CODE_PREVIEW_MAX_CODE_POINTS,
  type ArticleCodeBlockFlag,
  type ArticleCodeLinkAdvisory,
  type ArticleCodeLinkSource,
} from "./codeAdvisory.js";
import {
  X_ARTICLE_STAGE_TEXT_MAX_CODE_UNITS,
  xArticleStageCopiedTextCodeUnits,
} from "./articleStageTextBudget.js";
import {
  X_ARTICLE_CODE_BLOCK_COUNT_LIMIT,
  XDraftStageError,
} from "./saveProgress.js";
import {
  createXGeneratedContentSnapshotContext,
  snapshotXBoundedString,
  snapshotXGeneratedNonArticleContent,
  snapshotXOptionalBoolean,
  snapshotXPlainRecord,
  type XGeneratedContentSnapshotContext,
  type XSnapshotRecordReader,
} from "./nonArticleStageSnapshot.js";

const MAX_TITLE_CODE_UNITS = 100_000;
const MAX_MARKDOWN_CODE_UNITS = 10_000_000;
const MAX_BLOCKS = 50_000;
const MAX_RUNS_PER_BLOCK = 50_000;
const MAX_TOTAL_RUNS = 200_000;
const MAX_TEXT_CODE_UNITS = 1_000_000;
const MAX_FLAGS = 50_000;
const MAX_WARNINGS = 50_000;
const MAX_URL_CODE_UNITS = 8_192;

export type XArticleStageSnapshotFailure =
  | "not_plain_object"
  | "proxy_object"
  | "unexpected_property"
  | "accessor_property"
  | "property_read_failed"
  | "cyclic_structure"
  | "sparse_array"
  | "oversized_structure"
  | "invalid_value"
  | "unsafe_href"
  | "accounting_mismatch";

const X_ARTICLE_STAGE_SNAPSHOT_FAILURES: ReadonlySet<string> = new Set([
  "not_plain_object",
  "proxy_object",
  "unexpected_property",
  "accessor_property",
  "property_read_failed",
  "cyclic_structure",
  "sparse_array",
  "oversized_structure",
  "invalid_value",
  "unsafe_href",
  "accounting_mismatch",
] satisfies readonly XArticleStageSnapshotFailure[]);

function closedSnapshotFailure(value: unknown): XArticleStageSnapshotFailure {
  return typeof value === "string" && X_ARTICLE_STAGE_SNAPSHOT_FAILURES.has(value)
    ? value as XArticleStageSnapshotFailure
    : "property_read_failed";
}

/** Read an untrusted thrown reason once and retain only the closed local enum. */
export function normalizeXArticleStageSnapshotFailure(
  error: unknown,
): XArticleStageSnapshotFailure {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return "property_read_failed";
  }
  let candidate: unknown;
  try {
    candidate = Reflect.get(error, "reason");
  } catch {
    return "property_read_failed";
  }
  return closedSnapshotFailure(candidate);
}

/** Closed, caller-content-free failure evidence for the pre-platform boundary. */
export class XArticleStageSnapshotError extends XDraftStageError {
  constructor(readonly reason: XArticleStageSnapshotFailure) {
    super("save_not_attempted", null);
    const closedReason = closedSnapshotFailure(reason);
    const message = `X staging input failed closed local snapshot validation (reason=${closedReason}). ` +
      "No browser, profile, native Save/Create action, editor input, or clipboard operation was invoked.";
    Object.defineProperties(this, {
      reason: { value: closedReason, enumerable: true, writable: false, configurable: false },
      message: { value: message, enumerable: false, writable: false, configurable: false },
    });
    this.name = "XArticleStageSnapshotError";
  }
}

export interface XArticleStageSnapshot {
  /** Deep-frozen, detached GeneratedContent passed through the dynamic loader. */
  readonly content: GeneratedContent;
  readonly title: string;
  readonly markdown: string;
  readonly html: string;
  readonly plain: string;
  readonly codeBlockCount: number;
  readonly receiptCodeBlockCount: number | "many";
  readonly codeAdvisories: readonly ArticleCodeBlockFlag[];
  readonly codeLinkAdvisories: readonly Readonly<ArticleCodeLinkAdvisory>[];
}

export interface XNonArticleStageSnapshot {
  readonly content: GeneratedContent;
  readonly format: "tweet" | "thread";
  readonly posts: readonly string[];
  readonly expectedPosts: number;
  readonly intendedFirstPostText: string;
  readonly inspect: boolean | undefined;
  readonly force: boolean | undefined;
  readonly basePath: string | undefined;
  readonly stageOptions: Readonly<{
    inspect: boolean | undefined;
    force?: boolean | undefined;
    basePath: string | undefined;
  }>;
}

interface SnapshotContext {
  readonly active: WeakSet<object>;
  totalRuns: number;
  totalTextCodeUnits: number;
}

interface Reader {
  read(key: string): unknown;
  has(key: string): boolean;
}

function fail(reason: XArticleStageSnapshotFailure): never {
  throw new XArticleStageSnapshotError(reason);
}

/**
 * Classify the caller-owned GeneratedContent union without trusting a mutable
 * property read. Accessor discriminants are observed at most once only to
 * preserve the single-read boundary, then rejected before any runtime load.
 */
export function snapshotXContentFormat(value: unknown): XFormat {
  if (typeof value !== "object" || value === null) {
    fail("not_plain_object");
  }
  let proxy: boolean;
  let array: boolean;
  let prototype: object | null;
  try {
    proxy = isProxy(value);
  } catch {
    fail("proxy_object");
  }
  if (proxy) fail("proxy_object");
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail("proxy_object");
  }
  if (array) fail("not_plain_object");
  if (prototype !== Object.prototype) fail("not_plain_object");

  let descriptor: PropertyDescriptor | undefined;
  let articleDescriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "format");
    articleDescriptor = Object.getOwnPropertyDescriptor(value, "article");
  } catch {
    fail("property_read_failed");
  }
  if (!descriptor || !descriptor.enumerable) {
    fail("unexpected_property");
  }
  if (!("value" in descriptor)) readAccessorOnce(value, "format");
  const format = descriptor.value;
  if (format !== "tweet" && format !== "thread" && format !== "article") {
    fail("invalid_value");
  }
  const hasArticle = articleDescriptor !== undefined;
  if ((format === "article") !== hasArticle) fail("unexpected_property");
  return format;
}

/** Deep-copy the complete generated tweet/thread graph before any runtime seam. */
export function snapshotXNonArticleStageContent(
  value: unknown,
  observedFormat: unknown,
): GeneratedContent {
  if (observedFormat !== "tweet" && observedFormat !== "thread") {
    fail("invalid_value");
  }
  try {
    const content = snapshotXGeneratedNonArticleContent(
      value,
      createXGeneratedContentSnapshotContext(),
    );
    if (content.format !== observedFormat) fail("invalid_value");
    return content;
  } catch {
    fail("invalid_value");
  }
}

function snapshotOptionalBasePath(
  reader: XSnapshotRecordReader,
  context: XGeneratedContentSnapshotContext,
): string | undefined {
  if (!reader.has("basePath")) return undefined;
  const value = reader.read("basePath");
  return value === undefined
    ? undefined
    : snapshotXBoundedString(value, 1_000_000, context);
}

function finishNonArticleStageSnapshot(
  content: GeneratedContent,
  inspect: boolean | undefined,
  force: boolean | undefined,
  basePath: string | undefined,
  includeForce: boolean,
): XNonArticleStageSnapshot {
  if (content.format !== "tweet" && content.format !== "thread") {
    fail("invalid_value");
  }
  const posts = Object.freeze(
    content.format === "thread"
      ? content.thread!.map((row) => row.text)
      : [content.tweet!.text],
  );
  const expectedPosts = posts.length;
  const intendedFirstPostText = posts[0];
  const stageOptions = Object.freeze({
    inspect,
    ...(includeForce ? { force } : {}),
    basePath,
  });
  return Object.freeze({
    content,
    format: content.format,
    posts,
    expectedPosts,
    intendedFirstPostText,
    inspect,
    force,
    basePath,
    stageOptions,
  });
}

/**
 * Snapshot the command-owned non-Article request as one exact graph. The
 * already-observed content identity prevents a second mutable root read.
 */
export function snapshotXNonArticleExecuteRequest(
  value: unknown,
  observedContent: unknown,
  observedFormat: unknown,
): XNonArticleStageSnapshot {
  if (observedFormat !== "tweet" && observedFormat !== "thread") {
    fail("invalid_value");
  }
  const context = createXGeneratedContentSnapshotContext();
  try {
    return snapshotXPlainRecord(
      value,
      ["content"],
      ["inspect", "basePath"],
      context,
      (reader) => {
        const contentValue = reader.read("content");
        if (contentValue !== observedContent) fail("invalid_value");
        const content = snapshotXGeneratedNonArticleContent(contentValue, context);
        if (content.format !== observedFormat) fail("invalid_value");
        const inspect = snapshotXOptionalBoolean(reader, "inspect");
        const basePath = snapshotOptionalBasePath(reader, context);
        return finishNonArticleStageSnapshot(
          content,
          inspect,
          undefined,
          basePath,
          false,
        );
      },
    );
  } catch {
    fail("invalid_value");
  }
}

/** Snapshot direct stageDraft content/options before profile or page access. */
export function snapshotXNonArticleDirectStageRequest(
  contentValue: unknown,
  observedFormat: unknown,
  optionsValue: unknown,
): XNonArticleStageSnapshot {
  if (observedFormat !== "tweet" && observedFormat !== "thread") {
    fail("invalid_value");
  }
  const context = createXGeneratedContentSnapshotContext();
  try {
    const content = snapshotXGeneratedNonArticleContent(contentValue, context);
    if (content.format !== observedFormat) fail("invalid_value");
    return snapshotXPlainRecord(
      optionsValue,
      [],
      ["inspect", "force", "basePath"],
      context,
      (reader) => {
        const inspect = snapshotXOptionalBoolean(reader, "inspect");
        const force = snapshotXOptionalBoolean(reader, "force");
        const basePath = snapshotOptionalBasePath(reader, context);
        return finishNonArticleStageSnapshot(
          content,
          inspect,
          force,
          basePath,
          true,
        );
      },
    );
  } catch {
    fail("invalid_value");
  }
}

function readAccessorOnce(record: object, key: string): never {
  try {
    Reflect.get(record, key);
  } catch {
    fail("property_read_failed");
  }
  fail("accessor_property");
}

function withPlainRecord<T>(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  context: SnapshotContext,
  build: (reader: Reader) => T,
  observed: Readonly<Record<string, unknown>> = {},
): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("not_plain_object");
  }
  let proxy: boolean;
  let prototype: object | null;
  try {
    proxy = isProxy(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail("proxy_object");
  }
  if (proxy) fail("proxy_object");
  if (prototype !== Object.prototype) fail("not_plain_object");
  if (context.active.has(value)) fail("cyclic_structure");
  context.active.add(value);
  try {
    let keys: PropertyKey[];
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      fail("property_read_failed");
    }
    const allowed = new Set([...required, ...optional]);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))
    ) {
      fail("unexpected_property");
    }

    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of keys) {
      if (typeof key !== "string") fail("unexpected_property");
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        fail("property_read_failed");
      }
      if (!descriptor || !descriptor.enumerable) fail("unexpected_property");
      descriptors.set(key, descriptor);
    }

    return build({
      has(key) {
        return descriptors.has(key);
      },
      read(key) {
        const descriptor = descriptors.get(key);
        if (!descriptor) fail("unexpected_property");
        if (!("value" in descriptor)) {
          // The caller may have already read a top-level discriminant once.
          // Never invoke that accessor a second time.
          if (Object.prototype.hasOwnProperty.call(observed, key)) {
            fail("accessor_property");
          }
          return readAccessorOnce(value, key);
        }
        if (
          Object.prototype.hasOwnProperty.call(observed, key) &&
          !Object.is(descriptor.value, observed[key])
        ) {
          fail("invalid_value");
        }
        return descriptor.value;
      },
    });
  } finally {
    context.active.delete(value);
  }
}

function withDenseArray<T>(
  value: unknown,
  maximum: number,
  context: SnapshotContext,
  copy: (entry: unknown, index: number) => T,
): T[] {
  if (typeof value !== "object" || value === null) fail("invalid_value");
  let proxy: boolean;
  let array: boolean;
  let prototype: object | null;
  try {
    proxy = isProxy(value);
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail("proxy_object");
  }
  if (proxy) fail("proxy_object");
  if (!array || prototype !== Array.prototype) fail("invalid_value");
  if (context.active.has(value)) fail("cyclic_structure");
  context.active.add(value);
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : null;
    if (!Number.isSafeInteger(length) || length < 0) fail("invalid_value");
    if (length > maximum) fail("oversized_structure");

    let keys: PropertyKey[];
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      fail("property_read_failed");
    }
    const expected = new Set<PropertyKey>(["length"]);
    for (let index = 0; index < length; index += 1) expected.add(String(index));
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
      fail("sparse_array");
    }

    const out: T[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable) fail("sparse_array");
      if (!("value" in descriptor)) readAccessorOnce(value, key);
      out.push(copy(descriptor.value, index));
    }
    return out;
  } finally {
    context.active.delete(value);
  }
}

function boundedString(
  value: unknown,
  maximum: number,
  context: SnapshotContext,
  countTowardTotal = true,
): string {
  if (typeof value !== "string") fail("invalid_value");
  if (value.length > maximum) fail("oversized_structure");
  if (countTowardTotal) {
    context.totalTextCodeUnits += value.length;
    if (context.totalTextCodeUnits > X_ARTICLE_STAGE_TEXT_MAX_CODE_UNITS) {
      fail("oversized_structure");
    }
  }
  return value;
}

function optionalString(
  reader: Reader,
  key: string,
  maximum: number,
  context: SnapshotContext,
): string | undefined {
  if (!reader.has(key)) return undefined;
  const value = reader.read(key);
  return value === undefined ? undefined : boundedString(value, maximum, context);
}

function positiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail("invalid_value");
  return value as number;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("invalid_value");
  return value as number;
}

function booleanMark(reader: Reader, key: string): boolean | undefined {
  if (!reader.has(key)) return undefined;
  const value = reader.read(key);
  if (typeof value !== "boolean") fail("invalid_value");
  return value;
}

function containsUnsafeUrlText(value: string): boolean {
  if (value.trim() !== value) return true;
  // WHATWG URL parsing removes or encodes raw spacing/control characters.
  // Reject them rather than silently changing caller-visible href bytes.
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Z}]/u.test(value)) {
    return true;
  }
  return false;
}

function safeHref(value: unknown, context: SnapshotContext): string {
  const href = boundedString(value, MAX_URL_CODE_UNITS, context);
  if (containsUnsafeUrlText(href)) fail("unsafe_href");
  const authority = href.match(/^https?:\/\/([^/?#]*)/iu)?.[1];
  if (
    authority === undefined ||
    authority === "" ||
    authority.includes("@") ||
    href.includes("\\")
  ) {
    fail("unsafe_href");
  }
  try {
    const parsed = new URL(href);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname === "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      fail("unsafe_href");
    }
  } catch {
    fail("unsafe_href");
  }
  return href;
}

function snapshotRun(
  value: unknown,
  context: SnapshotContext,
  hrefs: Set<string>,
): InlineRun {
  context.totalRuns += 1;
  if (context.totalRuns > MAX_TOTAL_RUNS) fail("oversized_structure");
  return withPlainRecord(
    value,
    ["text"],
    ["bold", "italic", "code", "href"],
    context,
    (reader) => {
      const text = boundedString(reader.read("text"), MAX_TEXT_CODE_UNITS, context);
      const bold = booleanMark(reader, "bold");
      const italic = booleanMark(reader, "italic");
      const code = booleanMark(reader, "code");
      const href = reader.has("href") ? safeHref(reader.read("href"), context) : undefined;
      if (href) hrefs.add(href);
      return Object.freeze({
        text,
        ...(bold !== undefined ? { bold } : {}),
        ...(italic !== undefined ? { italic } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(href !== undefined ? { href } : {}),
      });
    },
  );
}

interface SnapshotBlocks {
  blocks: ArticleBlock[];
  codeBlocks: Array<Extract<ArticleBlock, { kind: "code" }>>;
  hrefs: Set<string>;
}

function snapshotBlocks(value: unknown, context: SnapshotContext): SnapshotBlocks {
  const codeBlocks: Array<Extract<ArticleBlock, { kind: "code" }>> = [];
  const hrefs = new Set<string>();
  const blocks = withDenseArray(value, MAX_BLOCKS, context, (entry) =>
    withPlainRecord(
      entry,
      ["kind"],
      ["level", "runs", "index", "lang", "text"],
      context,
      (reader): ArticleBlock => {
        const kind = reader.read("kind");
        if (kind === "code") {
          if (
            reader.has("level") ||
            reader.has("runs") ||
            !reader.has("index") ||
            !reader.has("text")
          ) fail("unexpected_property");
          const index = positiveSafeInteger(reader.read("index"));
          const lang = optionalString(reader, "lang", MAX_TEXT_CODE_UNITS, context);
          const text = boundedString(reader.read("text"), MAX_TEXT_CODE_UNITS, context);
          const block = Object.freeze({ kind, index, lang, text });
          codeBlocks.push(block);
          return block;
        }

        if (
          kind !== "heading" &&
          kind !== "subheading" &&
          kind !== "paragraph" &&
          kind !== "bullet" &&
          kind !== "ordered" &&
          kind !== "quote"
        ) fail("invalid_value");
        if (
          reader.has("index") ||
          reader.has("lang") ||
          reader.has("text") ||
          !reader.has("runs")
        ) fail("unexpected_property");
        let level: 1 | 2 | undefined;
        if (kind === "heading") {
          const rawLevel = reader.read("level");
          if (rawLevel !== 1 && rawLevel !== 2) fail("invalid_value");
          level = rawLevel;
        } else if (reader.has("level")) {
          fail("unexpected_property");
        }
        const runs = Object.freeze(
          withDenseArray(reader.read("runs"), MAX_RUNS_PER_BLOCK, context, (run) =>
            snapshotRun(run, context, hrefs)),
        );
        return Object.freeze(
          kind === "heading" ? { kind, level: level as 1 | 2, runs } : { kind, runs },
        ) as ArticleBlock;
      },
    ));
  return { blocks: Object.freeze(blocks) as ArticleBlock[], codeBlocks, hrefs };
}

function snapshotCodeFlags(
  value: unknown,
  context: SnapshotContext,
): readonly ArticleCodeBlockFlag[] {
  const flags = Object.freeze(
    withDenseArray(value, X_ARTICLE_CODE_ADVISORY_COUNT_MAX, context, (entry) =>
      withPlainRecord(
        entry,
        [
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
        ],
        [],
        context,
        (reader): ArticleCodeBlockFlag => {
          if (reader.read("kind") !== "article_code_block") fail("invalid_value");
          const index = positiveSafeInteger(reader.read("index"));
          const rawLang = reader.read("lang");
          const lang = rawLang === undefined
            ? undefined
            : boundedString(
                rawLang,
                X_CODE_INFO_MAX_CODE_POINTS * 2,
                context,
              );
          const preview = boundedString(
            reader.read("preview"),
            X_CODE_PREVIEW_MAX_CODE_POINTS * 2,
            context,
          );
          const sourceLine = positiveSafeInteger(reader.read("sourceLine"));
          const sourceEndLine = positiveSafeInteger(reader.read("sourceEndLine"));
          const sourceLineCount = positiveSafeInteger(reader.read("sourceLineCount"));
          const markdownStartLine = positiveSafeInteger(reader.read("markdownStartLine"));
          const markdownEndLine = positiveSafeInteger(reader.read("markdownEndLine"));
          const fence = reader.read("fence");
          const closure = reader.read("closure");
          const sourceTerminalNewline = reader.read("sourceTerminalNewline");
          const rawInfo = reader.read("infoString");
          const infoString = rawInfo === null
            ? null
            : boundedString(
                rawInfo,
                X_CODE_INFO_MAX_CODE_POINTS * 2,
                context,
              );
          const infoStringTruncated = reader.read("infoStringTruncated");
          const previewTruncated = reader.read("previewTruncated");
          const digestNormalization = reader.read("digestNormalization");
          const normalizedSourceSha256 = boundedString(
            reader.read("normalizedSourceSha256"),
            64,
            context,
          );
          if (
            sourceEndLine < sourceLine ||
            markdownEndLine < markdownStartLine ||
            sourceLineCount !== sourceEndLine - sourceLine + 1 ||
            sourceLineCount !== markdownEndLine - markdownStartLine + 1 ||
            (fence !== "backtick" && fence !== "tilde") ||
            (closure !== "explicit" && closure !== "end_of_input") ||
            typeof sourceTerminalNewline !== "boolean" ||
            (closure === "explicit" &&
              (sourceTerminalNewline || sourceLineCount < 2)) ||
            typeof infoStringTruncated !== "boolean" ||
            typeof previewTruncated !== "boolean" ||
            !isTerminalSafeBoundedCodeEvidence(preview, X_CODE_PREVIEW_MAX_CODE_POINTS) ||
            digestNormalization !== "lf_normalized_exact_fence_source" ||
            !/^[a-f0-9]{64}$/u.test(normalizedSourceSha256) ||
            (infoString === null
              ? lang !== undefined || infoStringTruncated
              : lang !== infoString || infoString.length === 0 ||
                !isTerminalSafeBoundedCodeEvidence(
                  infoString,
                  X_CODE_INFO_MAX_CODE_POINTS,
                ))
          ) fail("invalid_value");
          return Object.freeze({
            kind: "article_code_block",
            index,
            lang,
            preview,
            sourceLine,
            sourceEndLine,
            sourceLineCount,
            markdownStartLine,
            markdownEndLine,
            fence,
            closure,
            sourceTerminalNewline,
            infoString,
            infoStringTruncated,
            previewTruncated,
            digestNormalization: "lf_normalized_exact_fence_source",
            normalizedSourceSha256,
          });
        },
      )),
  ) as readonly ArticleCodeBlockFlag[];
  if (articleCodeAdvisoryRenderSize(flags) > X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS) {
    fail("oversized_structure");
  }
  return flags;
}

function snapshotLinkFlags(value: unknown, context: SnapshotContext): LinkFlag[] {
  return Object.freeze(
    withDenseArray(value, MAX_FLAGS, context, (entry) =>
      withPlainRecord(
        entry,
        ["url", "note"],
        [
          "text",
          "advisorySource",
          "codeBlockIndex",
          "urlTruncated",
          "textTruncated",
        ],
        context,
        (reader): LinkFlag => {
          const codeDerived = reader.has("advisorySource");
          const url = boundedString(
            reader.read("url"),
            codeDerived
              ? X_ARTICLE_CODE_LINK_URL_MAX_CODE_POINTS * 2
              : MAX_URL_CODE_UNITS,
            context,
          );
          const text = optionalString(
            reader,
            "text",
            codeDerived
              ? X_ARTICLE_CODE_LINK_TEXT_MAX_CODE_POINTS * 2
              : MAX_TEXT_CODE_UNITS,
            context,
          );
          const note = boundedString(
            reader.read("note"),
            codeDerived ? X_ARTICLE_CODE_LINK_NOTE.length : MAX_TEXT_CODE_UNITS,
            context,
          );
          if (!codeDerived) {
            if (
              reader.has("codeBlockIndex") ||
              reader.has("urlTruncated") ||
              reader.has("textTruncated")
            ) fail("unexpected_property");
            return Object.freeze({
              url,
              ...(reader.has("text") ? { text } : {}),
              note,
            });
          }
          if (
            reader.read("advisorySource") !== "excluded_article_code" ||
            !reader.has("codeBlockIndex") ||
            !reader.has("urlTruncated") ||
            !reader.has("textTruncated")
          ) fail("invalid_value");
          const codeBlockIndex = positiveSafeInteger(reader.read("codeBlockIndex"));
          const urlTruncated = reader.read("urlTruncated");
          const textTruncated = reader.read("textTruncated");
          if (
            typeof urlTruncated !== "boolean" ||
            typeof textTruncated !== "boolean" ||
            (reader.has("text") && text === undefined) ||
            note !== X_ARTICLE_CODE_LINK_NOTE ||
            !/^https?:\/\/\S+$/u.test(url) ||
            !isTerminalSafeBoundedCodeEvidence(
              url,
              X_ARTICLE_CODE_LINK_URL_MAX_CODE_POINTS,
            ) ||
            (text === undefined
              ? textTruncated
              : text.length === 0 || !isTerminalSafeBoundedCodeEvidence(
                  text,
                  X_ARTICLE_CODE_LINK_TEXT_MAX_CODE_POINTS,
                ))
          ) fail("invalid_value");
          return Object.freeze({
            url,
            ...(reader.has("text") ? { text } : {}),
            note,
            advisorySource: "excluded_article_code",
            codeBlockIndex,
            urlTruncated,
            textTruncated,
          });
        },
      )),
  ) as LinkFlag[];
}

function snapshotWarnings(value: unknown, context: SnapshotContext): string[] {
  return Object.freeze(
    withDenseArray(value, MAX_WARNINGS, context, (entry) =>
      boundedString(entry, MAX_TEXT_CODE_UNITS, context)),
  ) as string[];
}

function verifyCodeCorrespondence(
  blocks: Array<Extract<ArticleBlock, { kind: "code" }>>,
  flags: readonly ArticleCodeBlockFlag[],
  declared: number,
  markdown: string,
): ArticleCodeLinkSource[] {
  if (declared !== blocks.length || flags.length !== blocks.length) {
    fail("accounting_mismatch");
  }
  const markdownLines = markdown.split("\n");
  const physicalLineCount = markdownLines.length - (markdown.endsWith("\n") ? 1 : 0);
  let previousMarkdownEnd = 0;
  let sourceOffset: number | null = null;
  const codeLinkSources: ArticleCodeLinkSource[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const flag = flags[index];
    const nextOffset = flag.sourceLine - flag.markdownStartLine;
    if (
      block.index !== index + 1 ||
      flag.index !== block.index ||
      flag.lang !== block.lang ||
      nextOffset < 0 ||
      !Number.isSafeInteger(nextOffset) ||
      (sourceOffset !== null && nextOffset !== sourceOffset) ||
      flag.markdownStartLine <= previousMarkdownEnd ||
      flag.markdownEndLine > physicalLineCount
    ) {
      fail("accounting_mismatch");
    }
    sourceOffset = nextOffset;
    previousMarkdownEnd = flag.markdownEndLine;
    let digestSource = markdownLines
      .slice(flag.markdownStartLine - 1, flag.markdownEndLine)
      .join("\n");
    if (flag.sourceTerminalNewline) digestSource += "\n";
    if (unpairedSurrogateOffset(digestSource) !== -1) fail("invalid_value");
    const sourceLines = digestSource.endsWith("\n")
      ? digestSource.slice(0, -1).split("\n")
      : digestSource.split("\n");
    const opener = (sourceLines[0] ?? "").match(/^( {0,3})(`{3,}|~{3,})([^\n]*)/u);
    if (!opener || opener[0].length !== (sourceLines[0] ?? "").length) {
      fail("accounting_mismatch");
    }
    const marker = opener[2];
    const family = marker[0] === "`" ? "backtick" : "tilde";
    const closerMatches = (line: string): boolean => {
      const match = line.match(/^( {0,3})(`+|~+)[ \t]*/u);
      return !!match && match[0].length === line.length &&
        match[2][0] === marker[0] && match[2].length >= marker.length;
    };
    if (
      family !== flag.fence ||
      (marker[0] === "`" && opener[3].includes("`")) ||
      (flag.closure === "explicit"
        ? flag.sourceTerminalNewline ||
          sourceLines.length < 2 ||
          !closerMatches(sourceLines[sourceLines.length - 1] ?? "") ||
          sourceLines.slice(1, -1).some(closerMatches)
        : flag.markdownEndLine !== physicalLineCount ||
          flag.sourceTerminalNewline !== markdown.endsWith("\n") ||
          sourceLines.slice(1).some(closerMatches))
    ) fail("accounting_mismatch");
    const rawInfo = opener[3].replace(/^[ \t]+|[ \t]+$/gu, "");
    const openerIndent = opener[1].length;
    const rawPayloadLines = flag.closure === "explicit"
      ? sourceLines.slice(1, -1)
      : sourceLines.slice(1);
    const payloadLines: string[] = [];
    for (const line of rawPayloadLines) {
      let remove = 0;
      while (remove < openerIndent && line.charCodeAt(remove) === 32) remove += 1;
      if (remove < openerIndent && line.charCodeAt(remove) === 9) {
        fail("accounting_mismatch");
      }
      payloadLines.push(line.slice(remove));
    }
    let expectedCodeText = payloadLines.join("\n");
    if (
      flag.closure === "end_of_input" &&
      flag.sourceTerminalNewline &&
      sourceLines.length > 1
    ) expectedCodeText += "\n";
    if (block.text !== expectedCodeText) fail("accounting_mismatch");
    const expectedInfo = terminalSafeBoundedArticleCodeEvidence(
      rawInfo,
      X_CODE_INFO_MAX_CODE_POINTS,
    );
    const rawPreview = (block.text.split("\n", 1)[0] ?? "")
      .replace(/^[ \t]+|[ \t]+$/gu, "");
    const expectedPreview = terminalSafeBoundedArticleCodeEvidence(
      rawPreview,
      X_CODE_PREVIEW_MAX_CODE_POINTS,
    );
    if (
      flag.infoString !== (expectedInfo.value || null) ||
      flag.lang !== (expectedInfo.value || undefined) ||
      flag.infoStringTruncated !== expectedInfo.truncated ||
      flag.preview !== expectedPreview.value ||
      flag.previewTruncated !== expectedPreview.truncated ||
      createHash("sha256").update(digestSource, "utf8").digest("hex") !==
        flag.normalizedSourceSha256
    ) fail("accounting_mismatch");
    codeLinkSources.push({
      codeBlockIndex: flag.index,
      infoString: rawInfo,
      codeText: block.text,
    });
  }
  return codeLinkSources;
}

function verifyCanonicalCodeSet(
  markdown: string,
  blocks: Array<Extract<ArticleBlock, { kind: "code" }>>,
  flags: readonly ArticleCodeBlockFlag[],
  linkFlags: LinkFlag[],
): void {
  const sourceOffset = flags.length === 0
    ? 0
    : flags[0].sourceLine - flags[0].markdownStartLine;
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0) {
    fail("accounting_mismatch");
  }
  try {
    const parsed = parseXArticleMarkdown(markdown, sourceOffset);
    const parsedBlocks = parsed.blocks.filter(
      (block): block is Extract<ArticleBlock, { kind: "code" }> => block.kind === "code",
    );
    if (
      parsed.markdown !== markdown ||
      parsed.codeBlockCount !== blocks.length ||
      parsedBlocks.length !== blocks.length ||
      parsedBlocks.some((block, index) => {
        const actual = blocks[index];
        return actual === undefined ||
          block.index !== actual.index ||
          block.lang !== actual.lang ||
          block.text !== actual.text;
      }) ||
      !sameXArticleCodeAdvisories(parsed.codeFlags, flags) ||
      !sameXArticleLinkFlags(parsed.linkFlags, linkFlags)
    ) fail("accounting_mismatch");
  } catch {
    fail("accounting_mismatch");
  }
}

const LINK_FLAG_OPTIONAL_KEYS = [
  "text",
  "advisorySource",
  "codeBlockIndex",
  "urlTruncated",
  "textTruncated",
] as const;

function sameXArticleLinkFlags(
  left: readonly LinkFlag[],
  right: readonly LinkFlag[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.url !== b.url || a.note !== b.note) return false;
    for (const key of LINK_FLAG_OPTIONAL_KEYS) {
      if (
        Object.prototype.hasOwnProperty.call(a, key) !==
          Object.prototype.hasOwnProperty.call(b, key) ||
        a[key] !== b[key]
      ) return false;
    }
  }
  return true;
}

function verifyLinkCorrespondence(
  hrefs: Set<string>,
  flags: LinkFlag[],
  codeLinkSources: readonly ArticleCodeLinkSource[],
): void {
  const flagged = new Set(
    flags
      .filter((flag) => flag.advisorySource !== "excluded_article_code")
      .map((flag) => flag.url),
  );
  for (const href of hrefs) {
    if (!flagged.has(href)) fail("accounting_mismatch");
  }
  const actualCode = flags.filter(
    (flag): flag is LinkFlag & ArticleCodeLinkAdvisory =>
      flag.advisorySource === "excluded_article_code",
  );
  const firstCode = flags.findIndex(
    (flag) => flag.advisorySource === "excluded_article_code",
  );
  if (
    firstCode !== -1 &&
    flags.slice(firstCode).some(
      (flag) => flag.advisorySource !== "excluded_article_code",
    )
  ) fail("accounting_mismatch");
  const expectedCode = collectXArticleCodeLinkAdvisories(codeLinkSources);
  if (
    expectedCode === null ||
    !sameXArticleCodeLinkAdvisories(expectedCode, actualCode)
  ) {
    fail("accounting_mismatch");
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineRunsToHtml(runs: InlineRun[]): string {
  let out = "";
  for (const run of runs) {
    if (!run.text) continue;
    let inner = escapeHtml(run.text);
    if (run.bold) inner = `<strong>${inner}</strong>`;
    if (run.italic) inner = `<em>${inner}</em>`;
    if (run.href) inner = `<a href="${escapeHtml(run.href)}">${inner}</a>`;
    out += inner;
  }
  return out;
}

/** Render only already validated/copy-owned blocks at staging time. */
export function htmlFromArticleBlocks(blocks: ArticleBlock[]): {
  html: string;
  codeBlockCount: number;
} {
  const parts: string[] = [];
  let codeBlockCount = 0;
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    if (block.kind === "bullet" || block.kind === "ordered") {
      const kind = block.kind;
      const tag = kind === "bullet" ? "ul" : "ol";
      const items: string[] = [];
      while (index < blocks.length && blocks[index].kind === kind) {
        const item = blocks[index] as Extract<ArticleBlock, { kind: "bullet" | "ordered" }>;
        items.push(`<li>${inlineRunsToHtml(item.runs)}</li>`);
        index += 1;
      }
      parts.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    switch (block.kind) {
      case "heading":
        parts.push(`<h${block.level}>${inlineRunsToHtml(block.runs)}</h${block.level}>`);
        break;
      case "subheading":
        parts.push(`<h2>${inlineRunsToHtml(block.runs)}</h2>`);
        break;
      case "paragraph":
        parts.push(`<p>${inlineRunsToHtml(block.runs)}</p>`);
        break;
      case "quote":
        parts.push(`<blockquote>${inlineRunsToHtml(block.runs)}</blockquote>`);
        break;
      case "code":
        codeBlockCount += 1;
        break;
    }
    index += 1;
  }
  return { html: parts.join("\n"), codeBlockCount };
}

export function plainTextFromArticleBlocks(blocks: ArticleBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === "code") continue;
    lines.push(block.runs.map((run) => run.text).join(""));
  }
  return lines.join("\n\n");
}

/**
 * Read every caller-visible Article value once, validate the closed shape, copy
 * primitives into a detached tree, freeze it, and pre-render editor inputs.
 * `observedFormat` is the caller's one already-guarded read of content.format.
 */
export function snapshotXArticleStageInput(
  value: unknown,
  observedFormat: unknown,
): XArticleStageSnapshot {
  const context: SnapshotContext = {
    active: new WeakSet<object>(),
    totalRuns: 0,
    totalTextCodeUnits: 0,
  };

  return withPlainRecord(
    value,
    ["format", "limit", "article", "codeFlags", "linkFlags", "fidelityFlags", "warnings"],
    [],
    context,
    (reader) => {
      if (reader.read("format") !== "article" || observedFormat !== "article") {
        fail("invalid_value");
      }
      if (reader.read("limit") !== Number.POSITIVE_INFINITY) fail("invalid_value");

      const article = withPlainRecord(
        reader.read("article"),
        ["title", "markdown", "blocks", "codeBlockCount"],
        [],
        context,
        (articleReader) => {
          const title = boundedString(
            articleReader.read("title"),
            MAX_TITLE_CODE_UNITS,
            context,
          );
          if (!title) fail("invalid_value");
          const markdown = boundedString(
            articleReader.read("markdown"),
            MAX_MARKDOWN_CODE_UNITS,
            context,
          );
          const copied = snapshotBlocks(articleReader.read("blocks"), context);
          const codeBlockCount = nonNegativeSafeInteger(articleReader.read("codeBlockCount"));
          if (codeBlockCount > MAX_BLOCKS) fail("oversized_structure");
          return { title, markdown, ...copied, codeBlockCount };
        },
      );

      const codeFlags = snapshotCodeFlags(reader.read("codeFlags"), context);
      const linkFlags = snapshotLinkFlags(reader.read("linkFlags"), context);
      const fidelityFlags = withDenseArray(
        reader.read("fidelityFlags"),
        0,
        context,
        () => fail("invalid_value"),
      );
      const warnings = snapshotWarnings(reader.read("warnings"), context);
      if (
        xArticleStageCopiedTextCodeUnits({
          title: article.title,
          markdown: article.markdown,
          blocks: article.blocks,
          codeFlags,
          linkFlags,
          warnings,
        }) !== context.totalTextCodeUnits
      ) fail("accounting_mismatch");
      verifyCanonicalCodeSet(
        article.markdown,
        article.codeBlocks,
        codeFlags,
        linkFlags,
      );
      const codeLinkSources = verifyCodeCorrespondence(
        article.codeBlocks,
        codeFlags,
        article.codeBlockCount,
        article.markdown,
      );
      verifyLinkCorrespondence(article.hrefs, linkFlags, codeLinkSources);
      const codeLinkFlags = Object.freeze(linkFlags.filter(
        (flag): flag is LinkFlag & ArticleCodeLinkAdvisory =>
          flag.advisorySource === "excluded_article_code",
      ));
      if (
        articleCodeAdvisoryRenderSize(codeFlags) +
          articleCodeLinkAdvisoryRenderSize(codeLinkFlags) >
            X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS
      ) fail("oversized_structure");

      const blocks = article.blocks;
      const rendered = htmlFromArticleBlocks(blocks);
      const plain = plainTextFromArticleBlocks(blocks);
      if (rendered.codeBlockCount !== article.codeBlockCount) fail("accounting_mismatch");

      const copiedArticle = Object.freeze({
        title: article.title,
        markdown: article.markdown,
        blocks,
        codeBlockCount: article.codeBlockCount,
      });
      const content = Object.freeze({
        format: "article" as const,
        limit: Number.POSITIVE_INFINITY,
        article: copiedArticle,
        codeFlags,
        linkFlags,
        fidelityFlags: Object.freeze(fidelityFlags),
        warnings,
      }) as unknown as GeneratedContent;
      const receiptCodeBlockCount = article.codeBlockCount > X_ARTICLE_CODE_BLOCK_COUNT_LIMIT
        ? "many" as const
        : article.codeBlockCount;
      return Object.freeze({
        content,
        title: article.title,
        markdown: article.markdown,
        html: rendered.html,
        plain,
        codeBlockCount: article.codeBlockCount,
        receiptCodeBlockCount,
        codeAdvisories: codeFlags,
        codeLinkAdvisories: codeLinkFlags,
      });
    },
    { format: observedFormat },
  );
}

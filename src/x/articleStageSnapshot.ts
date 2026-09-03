import { isProxy } from "node:util/types";
import type {
  ArticleBlock,
  CodeBlockFlag,
  GeneratedContent,
  InlineRun,
  LinkFlag,
  XFormat,
} from "./content.js";
import {
  X_ARTICLE_CODE_BLOCK_COUNT_LIMIT,
  XDraftStageError,
} from "./saveProgress.js";

const MAX_TITLE_CODE_UNITS = 100_000;
const MAX_MARKDOWN_CODE_UNITS = 10_000_000;
const MAX_BLOCKS = 50_000;
const MAX_RUNS_PER_BLOCK = 50_000;
const MAX_TOTAL_RUNS = 200_000;
const MAX_TEXT_CODE_UNITS = 1_000_000;
const MAX_TOTAL_TEXT_CODE_UNITS = 20_000_000;
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

  let keys: PropertyKey[];
  let descriptor: PropertyDescriptor | undefined;
  try {
    keys = Reflect.ownKeys(value);
    descriptor = Object.getOwnPropertyDescriptor(value, "format");
  } catch {
    fail("property_read_failed");
  }
  if (!descriptor || !descriptor.enumerable || !keys.includes("format")) {
    fail("unexpected_property");
  }
  if (!("value" in descriptor)) readAccessorOnce(value, "format");
  const format = descriptor.value;
  if (format !== "tweet" && format !== "thread" && format !== "article") {
    fail("invalid_value");
  }
  const hasArticle = keys.includes("article");
  if ((format === "article") !== hasArticle) fail("unexpected_property");
  return format;
}

/**
 * Detach and freeze the non-Article union root before an awaited loader/profile
 * boundary. Nested tweet/thread values retain their historical transport
 * semantics, while the captured root can no longer flip into Article shape.
 */
export function snapshotXNonArticleStageContent(
  value: unknown,
  observedFormat: unknown,
): GeneratedContent {
  if (observedFormat !== "tweet" && observedFormat !== "thread") {
    fail("invalid_value");
  }
  const context: SnapshotContext = {
    active: new WeakSet<object>(),
    totalRuns: 0,
    totalTextCodeUnits: 0,
  };
  const payloadKey = observedFormat;
  return withPlainRecord(
    value,
    ["format", "limit", payloadKey, "codeFlags", "linkFlags", "fidelityFlags", "warnings"],
    [],
    context,
    (reader) => {
      if (reader.read("format") !== observedFormat) fail("invalid_value");
      return Object.freeze({
        format: observedFormat,
        limit: reader.read("limit"),
        [payloadKey]: reader.read(payloadKey),
        codeFlags: reader.read("codeFlags"),
        linkFlags: reader.read("linkFlags"),
        fidelityFlags: reader.read("fidelityFlags"),
        warnings: reader.read("warnings"),
      }) as GeneratedContent;
    },
    { format: observedFormat },
  );
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
    if (context.totalTextCodeUnits > MAX_TOTAL_TEXT_CODE_UNITS) {
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

function snapshotCodeFlags(value: unknown, context: SnapshotContext): CodeBlockFlag[] {
  return Object.freeze(
    withDenseArray(value, MAX_FLAGS, context, (entry) =>
      withPlainRecord(
        entry,
        ["index", "preview", "sourceLine"],
        ["lang"],
        context,
        (reader): CodeBlockFlag => Object.freeze({
          index: positiveSafeInteger(reader.read("index")),
          lang: optionalString(reader, "lang", MAX_TEXT_CODE_UNITS, context),
          preview: boundedString(reader.read("preview"), MAX_TEXT_CODE_UNITS, context),
          sourceLine: positiveSafeInteger(reader.read("sourceLine")),
        }),
      )),
  ) as CodeBlockFlag[];
}

function snapshotLinkFlags(value: unknown, context: SnapshotContext): LinkFlag[] {
  return Object.freeze(
    withDenseArray(value, MAX_FLAGS, context, (entry) =>
      withPlainRecord(
        entry,
        ["url", "note"],
        ["text"],
        context,
        (reader): LinkFlag => Object.freeze({
          // Link flags are advisory source evidence and may describe URL-looking
          // text inside excluded code. Only InlineRun.href becomes an active
          // editor anchor and therefore receives safeHref validation.
          url: boundedString(reader.read("url"), MAX_URL_CODE_UNITS, context),
          text: optionalString(reader, "text", MAX_TEXT_CODE_UNITS, context),
          note: boundedString(reader.read("note"), MAX_TEXT_CODE_UNITS, context),
        }),
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
  flags: CodeBlockFlag[],
  declared: number,
): void {
  if (declared !== blocks.length || flags.length !== blocks.length) {
    fail("accounting_mismatch");
  }
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const flag = flags[index];
    if (
      block.index !== index + 1 ||
      flag.index !== block.index ||
      flag.lang !== block.lang
    ) {
      fail("accounting_mismatch");
    }
  }
}

function verifyLinkCorrespondence(hrefs: Set<string>, flags: LinkFlag[]): void {
  const flagged = new Set(flags.map((flag) => flag.url));
  for (const href of hrefs) {
    if (!flagged.has(href)) fail("accounting_mismatch");
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
      verifyCodeCorrespondence(article.codeBlocks, codeFlags, article.codeBlockCount);
      verifyLinkCorrespondence(article.hrefs, linkFlags);

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
      });
    },
    { format: observedFormat },
  );
}

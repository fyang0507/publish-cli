import { isProxy } from "node:util/types";
import {
  X_PREMIUM_POST_PLATFORM_MAX_LENGTH,
  X_STANDARD_POST_MAX_WEIGHTED_LENGTH,
  countUnicodeCodePoints,
  countXWeightedLength,
  type LengthUnit,
} from "../capabilities/validation.js";
import {
  X_CODE_INFO_MAX_CODE_POINTS,
  X_CODE_PREVIEW_MAX_CODE_POINTS,
  isTerminalSafeBoundedCodeEvidence,
  type CodeBlockFlag,
} from "./codeAdvisory.js";
import type {
  CodeBlockFidelityFlag,
  GeneratedContent,
  LinkFlag,
  ProseOmissionFlag,
  ThreadPost,
  XContentFidelityFlag,
} from "./content.js";

// A Premium post can contain 25,000 supplementary Unicode code points, which
// occupy at most 50,000 UTF-16 code units. Advisory text is inert but retained
// exactly under one shared finite budget for #59 inspection fidelity.
export const X_NON_ARTICLE_TRANSPORT_CODE_UNITS_MAX = 50_000;
export const X_NON_ARTICLE_ADVISORY_CODE_UNITS_MAX = 10_000_000;
export const X_NON_ARTICLE_ARRAY_ENTRIES_MAX = 10_000;
export const X_CODE_BLOCK_FIDELITY_NOTE =
  "The LF-normalized fenced source segment was replaced by the exact placeholder; provide and verify a screenshot/image before final publication.";

function boundedFidelityEvidence(value: string | null, truncated: boolean): string {
  if (value === null) return "none";
  return `${JSON.stringify(value)}${truncated ? " (bounded prefix; truncated)" : ""}`;
}

/** The one canonical warning generated from a frozen non-Article fidelity fact. */
export function renderXNonArticleFidelityWarning(flag: XContentFidelityFlag): string {
  if (flag.kind !== "code_block") {
    return `Source line ${flag.sourceLine} (${flag.kind}) was omitted: ${JSON.stringify(flag.source)}. ${flag.note}`;
  }
  const lineLabel = flag.sourceStartLine === flag.sourceEndLine
    ? `line ${flag.sourceStartLine}`
    : `lines ${flag.sourceStartLine}-${flag.sourceEndLine}`;
  return (
    `Source ${lineLabel} (code_block) ${flag.sourceLineCount === 1 ? "was" : "were"} replaced by ${JSON.stringify(flag.placeholder)}; ` +
    `fence=${flag.fence}, closure=${flag.closure}, lineCount=${flag.sourceLineCount}, ` +
    `info=${boundedFidelityEvidence(flag.infoString, flag.infoStringTruncated)}, ` +
    `preview=${boundedFidelityEvidence(flag.preview, flag.previewTruncated)}, ` +
    `digestNormalization=${flag.digestNormalization}, ` +
    `LF-normalized source sha256=${flag.normalizedSourceSha256}. ${flag.note}`
  );
}

const MAX_GRAPH_NODES = 100_000;
const INVALID_NON_ARTICLE_SNAPSHOT = Symbol("invalid_non_article_snapshot");

export interface XGeneratedContentSnapshotContext {
  readonly active: WeakSet<object>;
  nodes: number;
  totalTextCodeUnits: number;
}

export interface XSnapshotRecordReader {
  has(key: string): boolean;
  read(key: string): unknown;
}

export function createXGeneratedContentSnapshotContext(): XGeneratedContentSnapshotContext {
  return {
    active: new WeakSet<object>(),
    nodes: 0,
    totalTextCodeUnits: 0,
  };
}

export function failXGeneratedContentSnapshot(): never {
  throw INVALID_NON_ARTICLE_SNAPSHOT;
}

export function snapshotXPlainRecord<T>(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  context: XGeneratedContentSnapshotContext,
  build: (reader: XSnapshotRecordReader) => T,
): T {
  if (typeof value !== "object" || value === null) failXGeneratedContentSnapshot();
  let proxy: boolean;
  let array: boolean;
  let prototype: object | null;
  try {
    proxy = isProxy(value);
  } catch {
    failXGeneratedContentSnapshot();
  }
  // `isProxy` is trap-free even for revoked proxies. Never reflect further on
  // caller-owned proxy identity.
  if (proxy) failXGeneratedContentSnapshot();
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    failXGeneratedContentSnapshot();
  }
  if (
    array ||
    prototype !== Object.prototype ||
    context.active.has(value)
  ) {
    failXGeneratedContentSnapshot();
  }
  context.nodes += 1;
  if (context.nodes > MAX_GRAPH_NODES) failXGeneratedContentSnapshot();

  const allowed = new Set([...required, ...optional]);
  const enumerableKeys = new Set<string>();
  try {
    // Accepted own-enumerable processing in user code is schema-sized, and an
    // inherited or unexpected key fails at its first yielded entry. Engines may
    // cache enumeration keys before yielding them, so this is not a resource
    // guarantee for an already-allocated hostile object.
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        failXGeneratedContentSnapshot();
      }
      if (!allowed.has(key) || enumerableKeys.size >= allowed.size) {
        failXGeneratedContentSnapshot();
      }
      enumerableKeys.add(key);
    }
  } catch {
    failXGeneratedContentSnapshot();
  }
  if (required.some((key) => !enumerableKeys.has(key))) {
    failXGeneratedContentSnapshot();
  }

  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of enumerableKeys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      failXGeneratedContentSnapshot();
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      failXGeneratedContentSnapshot();
    }
    descriptors.set(key, descriptor);
  }
  // JavaScript has no bounded iterator for hidden/symbol own properties. This
  // exact-shape check runs only after accepting the schema-sized enumerable set.
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    failXGeneratedContentSnapshot();
  }
  if (
    ownKeys.length !== enumerableKeys.size ||
    ownKeys.some((key) => typeof key !== "string" || !enumerableKeys.has(key))
  ) {
    failXGeneratedContentSnapshot();
  }

  context.active.add(value);
  try {
    return build({
      has(key) {
        return descriptors.has(key);
      },
      read(key) {
        const descriptor = descriptors.get(key);
        if (!descriptor || !("value" in descriptor)) failXGeneratedContentSnapshot();
        return descriptor.value;
      },
    });
  } finally {
    context.active.delete(value);
  }
}

function snapshotXDenseArray<T>(
  value: unknown,
  maximum: number,
  context: XGeneratedContentSnapshotContext,
  copy: (entry: unknown, index: number) => T,
): readonly T[] {
  if (typeof value !== "object" || value === null) failXGeneratedContentSnapshot();
  let proxy: boolean;
  let array: boolean;
  let prototype: object | null;
  try {
    proxy = isProxy(value);
  } catch {
    failXGeneratedContentSnapshot();
  }
  if (proxy) failXGeneratedContentSnapshot();
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    failXGeneratedContentSnapshot();
  }
  if (
    !array ||
    prototype !== Array.prototype ||
    context.active.has(value)
  ) {
    failXGeneratedContentSnapshot();
  }

  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    failXGeneratedContentSnapshot();
  }
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : null;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    failXGeneratedContentSnapshot();
  }
  const arrayLength = length as number;
  const expectedKeys = new Set<PropertyKey>(["length"]);
  for (let index = 0; index < arrayLength; index += 1) {
    expectedKeys.add(String(index));
  }
  let enumerableCount = 0;
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        failXGeneratedContentSnapshot();
      }
      if (!expectedKeys.has(key) || enumerableCount >= arrayLength) {
        failXGeneratedContentSnapshot();
      }
      enumerableCount += 1;
    }
  } catch {
    failXGeneratedContentSnapshot();
  }
  if (enumerableCount !== arrayLength) failXGeneratedContentSnapshot();

  context.nodes += 1;
  if (context.nodes > MAX_GRAPH_NODES) failXGeneratedContentSnapshot();
  context.active.add(value);
  try {
    const result: T[] = [];
    for (let index = 0; index < arrayLength; index += 1) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      } catch {
        failXGeneratedContentSnapshot();
      }
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        failXGeneratedContentSnapshot();
      }
      result.push(copy(descriptor.value, index));
    }
    let ownKeys: PropertyKey[];
    try {
      ownKeys = Reflect.ownKeys(value);
    } catch {
      failXGeneratedContentSnapshot();
    }
    if (
      ownKeys.length !== expectedKeys.size ||
      ownKeys.some((key) => !expectedKeys.has(key))
    ) {
      failXGeneratedContentSnapshot();
    }
    return Object.freeze(result);
  } finally {
    context.active.delete(value);
  }
}

export function snapshotXBoundedString(
  value: unknown,
  maximum: number,
  context: XGeneratedContentSnapshotContext,
): string {
  if (typeof value !== "string" || value.length > maximum) {
    failXGeneratedContentSnapshot();
  }
  context.totalTextCodeUnits += value.length;
  if (context.totalTextCodeUnits > X_NON_ARTICLE_ADVISORY_CODE_UNITS_MAX) {
    failXGeneratedContentSnapshot();
  }
  return value;
}

export function snapshotXRequiredNonEmptyString(
  value: unknown,
  maximum: number,
  context: XGeneratedContentSnapshotContext,
): string {
  const stringValue = snapshotXBoundedString(value, maximum, context);
  if (stringValue.length === 0) failXGeneratedContentSnapshot();
  return stringValue;
}

function boundedAdvisoryString(
  value: unknown,
  context: XGeneratedContentSnapshotContext,
): string {
  return snapshotXBoundedString(
    value,
    X_NON_ARTICLE_ADVISORY_CODE_UNITS_MAX,
    context,
  );
}

function requiredNonEmptyAdvisoryString(
  value: unknown,
  context: XGeneratedContentSnapshotContext,
): string {
  const stringValue = boundedAdvisoryString(value, context);
  if (stringValue.length === 0) failXGeneratedContentSnapshot();
  return stringValue;
}

function optionalAdvisoryString(
  reader: XSnapshotRecordReader,
  key: string,
  context: XGeneratedContentSnapshotContext,
): string | undefined {
  if (!reader.has(key)) return undefined;
  const value = reader.read(key);
  return value === undefined ? undefined : boundedAdvisoryString(value, context);
}

export function snapshotXOptionalBoolean(
  reader: XSnapshotRecordReader,
  key: string,
): boolean | undefined {
  if (!reader.has(key)) return undefined;
  const value = reader.read(key);
  if (value !== undefined && typeof value !== "boolean") {
    failXGeneratedContentSnapshot();
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") failXGeneratedContentSnapshot();
  return value;
}

function positiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    failXGeneratedContentSnapshot();
  }
  return value as number;
}

function snapshotTweet(
  value: unknown,
  limit: number,
  context: XGeneratedContentSnapshotContext,
): Readonly<{ text: string; chars: number; unit: LengthUnit }> {
  return snapshotXPlainRecord(value, ["text", "chars", "unit"], [], context, (reader) => {
    const text = snapshotXRequiredNonEmptyString(
      reader.read("text"),
      X_NON_ARTICLE_TRANSPORT_CODE_UNITS_MAX,
      context,
    );
    if (text.trim().length === 0 || text.trim() !== text) {
      failXGeneratedContentSnapshot();
    }
    const chars = positiveSafeInteger(reader.read("chars"));
    const unit = reader.read("unit");
    if (
      unit !== "twitter_text_weighted" &&
      unit !== "unicode_code_points_transport_policy"
    ) {
      failXGeneratedContentSnapshot();
    }
    const measured = unit === "twitter_text_weighted"
      ? countXWeightedLength(text)
      : countUnicodeCodePoints(text);
    if (
      chars !== measured ||
      chars > limit ||
      (unit === "twitter_text_weighted"
        ? limit !== X_STANDARD_POST_MAX_WEIGHTED_LENGTH
        : limit !== X_PREMIUM_POST_PLATFORM_MAX_LENGTH)
    ) {
      failXGeneratedContentSnapshot();
    }
    return Object.freeze({ text, chars, unit });
  });
}

function snapshotThread(
  value: unknown,
  limit: number,
  context: XGeneratedContentSnapshotContext,
): readonly ThreadPost[] {
  if (limit !== X_STANDARD_POST_MAX_WEIGHTED_LENGTH) {
    failXGeneratedContentSnapshot();
  }
  const rows = snapshotXDenseArray(
    value,
    X_NON_ARTICLE_ARRAY_ENTRIES_MAX,
    context,
    (entry, position) => snapshotXPlainRecord(
      entry,
      ["index", "total", "text", "chars"],
      [],
      context,
      (reader): ThreadPost => {
        const index = positiveSafeInteger(reader.read("index"));
        const total = positiveSafeInteger(reader.read("total"));
        const text = snapshotXRequiredNonEmptyString(
          reader.read("text"),
          X_NON_ARTICLE_TRANSPORT_CODE_UNITS_MAX,
          context,
        );
        const chars = positiveSafeInteger(reader.read("chars"));
        const suffix = ` ${index}/${total}`;
        if (
          index !== position + 1 ||
          text.length <= suffix.length ||
          !text.endsWith(suffix) ||
          chars !== countXWeightedLength(text) ||
          chars > limit
        ) {
          failXGeneratedContentSnapshot();
        }
        return Object.freeze({ index, total, text, chars });
      },
    ),
  );
  if (rows.length === 0) failXGeneratedContentSnapshot();
  let hasNonWhitespacePayload = false;
  for (const [position, row] of rows.entries()) {
    if (row.total !== rows.length) failXGeneratedContentSnapshot();
    const suffix = ` ${row.index}/${row.total}`;
    const payload = row.text.slice(0, -suffix.length);
    if (
      (position === 0 && payload.trimStart() !== payload) ||
      (position === rows.length - 1 && payload.trimEnd() !== payload)
    ) {
      failXGeneratedContentSnapshot();
    }
    if (/\S/u.test(payload)) hasNonWhitespacePayload = true;
  }
  if (!hasNonWhitespacePayload) failXGeneratedContentSnapshot();
  return rows;
}

function snapshotCodeFlags(
  value: unknown,
  context: XGeneratedContentSnapshotContext,
): readonly CodeBlockFlag[] {
  const flags = snapshotXDenseArray(
    value,
    X_NON_ARTICLE_ARRAY_ENTRIES_MAX,
    context,
    (entry, position) => snapshotXPlainRecord(
      entry,
      ["index", "preview", "sourceLine"],
      ["lang"],
      context,
      (reader): CodeBlockFlag => {
        const index = positiveSafeInteger(reader.read("index"));
        if (index !== position + 1) failXGeneratedContentSnapshot();
        const lang = optionalAdvisoryString(reader, "lang", context);
        const preview = boundedAdvisoryString(reader.read("preview"), context);
        const sourceLine = positiveSafeInteger(reader.read("sourceLine"));
        return Object.freeze({
          index,
          ...(reader.has("lang") ? { lang } : {}),
          preview,
          sourceLine,
        });
      },
    ),
  );
  for (let index = 1; index < flags.length; index += 1) {
    if (flags[index].sourceLine < flags[index - 1].sourceLine) {
      failXGeneratedContentSnapshot();
    }
  }
  return flags;
}

function snapshotLinkFlags(
  value: unknown,
  context: XGeneratedContentSnapshotContext,
): readonly LinkFlag[] {
  return snapshotXDenseArray(
    value,
    X_NON_ARTICLE_ARRAY_ENTRIES_MAX,
    context,
    (entry) => snapshotXPlainRecord(
      entry,
      ["url", "note"],
      ["text"],
      context,
      (reader): LinkFlag => {
        const url = requiredNonEmptyAdvisoryString(reader.read("url"), context);
        const text = optionalAdvisoryString(reader, "text", context);
        const note = boundedAdvisoryString(reader.read("note"), context);
        return Object.freeze({
          url,
          ...(reader.has("text") ? { text } : {}),
          note,
        });
      },
    ),
  );
}

const PROSE_OMISSION_KINDS = new Set<ProseOmissionFlag["kind"]>([
  "title_heading",
  "section_heading",
  "metadata_like",
  "markdown_image",
]);

const FIDELITY_KEYS = [
  "kind",
  "source",
  "sourceLine",
  "note",
  "index",
  "placeholder",
  "sourceStartLine",
  "sourceEndLine",
  "sourceLineCount",
  "fence",
  "closure",
  "infoString",
  "infoStringTruncated",
  "preview",
  "previewTruncated",
  "digestNormalization",
  "normalizedSourceSha256",
] as const;

function hasExactly(
  reader: XSnapshotRecordReader,
  required: readonly string[],
): boolean {
  const requiredSet = new Set(required);
  return FIDELITY_KEYS.every((key) => reader.has(key) === requiredSet.has(key));
}

function snapshotFidelityFlag(
  value: unknown,
  context: XGeneratedContentSnapshotContext,
): XContentFidelityFlag {
  return snapshotXPlainRecord(
    value,
    ["kind", "note"],
    FIDELITY_KEYS.slice(1),
    context,
    (reader) => {
      const kind = reader.read("kind");
      const note = boundedAdvisoryString(reader.read("note"), context);
      if (
        typeof kind === "string" &&
        PROSE_OMISSION_KINDS.has(kind as ProseOmissionFlag["kind"])
      ) {
        if (!hasExactly(reader, ["kind", "source", "sourceLine", "note"])) {
          failXGeneratedContentSnapshot();
        }
        return Object.freeze({
          kind: kind as ProseOmissionFlag["kind"],
          source: boundedAdvisoryString(reader.read("source"), context),
          sourceLine: positiveSafeInteger(reader.read("sourceLine")),
          note,
        });
      }
      if (
        kind !== "code_block" ||
        !hasExactly(
          reader,
          FIDELITY_KEYS.filter((key) => key !== "source" && key !== "sourceLine"),
        )
      ) {
        failXGeneratedContentSnapshot();
      }
      const index = positiveSafeInteger(reader.read("index"));
      const placeholder = boundedAdvisoryString(reader.read("placeholder"), context);
      const sourceStartLine = positiveSafeInteger(reader.read("sourceStartLine"));
      const sourceEndLine = positiveSafeInteger(reader.read("sourceEndLine"));
      const sourceLineCount = positiveSafeInteger(reader.read("sourceLineCount"));
      const fence = reader.read("fence");
      const closure = reader.read("closure");
      const rawInfoString = reader.read("infoString");
      const infoString = rawInfoString === null
        ? null
        : boundedAdvisoryString(rawInfoString, context);
      const infoStringTruncated = booleanValue(reader.read("infoStringTruncated"));
      const preview = boundedAdvisoryString(reader.read("preview"), context);
      const previewTruncated = booleanValue(reader.read("previewTruncated"));
      const digestNormalization = reader.read("digestNormalization");
      const normalizedSourceSha256 = snapshotXBoundedString(
        reader.read("normalizedSourceSha256"),
        64,
        context,
      );
      const infoCodePoints = infoString === null ? 0 : Array.from(infoString).length;
      const previewCodePoints = Array.from(preview).length;
      if (
        placeholder !== `[code block #${index} → screenshot]` ||
        sourceEndLine < sourceStartLine ||
        sourceLineCount !== sourceEndLine - sourceStartLine + 1 ||
        (fence !== "backtick" && fence !== "tilde") ||
        (closure !== "explicit" && closure !== "end_of_input") ||
        note !== X_CODE_BLOCK_FIDELITY_NOTE ||
        (infoString === null
          ? infoStringTruncated
          : infoString.length === 0 ||
            !isTerminalSafeBoundedCodeEvidence(infoString, X_CODE_INFO_MAX_CODE_POINTS) ||
            (infoStringTruncated && infoCodePoints !== X_CODE_INFO_MAX_CODE_POINTS)) ||
        !isTerminalSafeBoundedCodeEvidence(preview, X_CODE_PREVIEW_MAX_CODE_POINTS) ||
        (previewTruncated && previewCodePoints !== X_CODE_PREVIEW_MAX_CODE_POINTS) ||
        digestNormalization !== "lf_joined_source_lines" ||
        !/^[a-f0-9]{64}$/u.test(normalizedSourceSha256)
      ) {
        failXGeneratedContentSnapshot();
      }
      return Object.freeze({
        kind: "code_block",
        index,
        placeholder,
        sourceStartLine,
        sourceEndLine,
        sourceLineCount,
        fence,
        closure,
        infoString,
        infoStringTruncated,
        preview,
        previewTruncated,
        digestNormalization,
        normalizedSourceSha256,
        note,
      }) as CodeBlockFidelityFlag;
    },
  );
}

function snapshotFidelityFlags(
  value: unknown,
  context: XGeneratedContentSnapshotContext,
): readonly XContentFidelityFlag[] {
  const flags = snapshotXDenseArray(
    value,
    X_NON_ARTICLE_ARRAY_ENTRIES_MAX,
    context,
    (entry) => snapshotFidelityFlag(entry, context),
  );
  let previousLine = 0;
  for (const flag of flags) {
    const line = flag.kind === "code_block" ? flag.sourceStartLine : flag.sourceLine;
    if (line < previousLine) failXGeneratedContentSnapshot();
    previousLine = line;
  }
  return flags;
}

function snapshotWarnings(
  value: unknown,
  context: XGeneratedContentSnapshotContext,
): readonly string[] {
  return snapshotXDenseArray(
    value,
    X_NON_ARTICLE_ARRAY_ENTRIES_MAX,
    context,
    (entry) => boundedAdvisoryString(entry, context),
  );
}

function verifyAdvisoryCorrespondence(
  codeFlags: readonly CodeBlockFlag[],
  fidelityFlags: readonly XContentFidelityFlag[],
  warnings: readonly string[],
): void {
  if (warnings.length !== fidelityFlags.length) failXGeneratedContentSnapshot();
  const fidelityCodeFlags = fidelityFlags.filter(
    (flag): flag is CodeBlockFidelityFlag => flag.kind === "code_block",
  );
  if (codeFlags.length !== fidelityCodeFlags.length) failXGeneratedContentSnapshot();
  for (let index = 0; index < codeFlags.length; index += 1) {
    const codeFlag = codeFlags[index];
    const fidelityFlag = fidelityCodeFlags[index];
    const expectedPreview = `${fidelityFlag.preview}${fidelityFlag.previewTruncated ? "…" : ""}`;
    const hasLang = Object.prototype.hasOwnProperty.call(codeFlag, "lang");
    const possibleLangs = new Set<string>();
    if (fidelityFlag.infoString !== null) {
      possibleLangs.add(fidelityFlag.infoString);
      const firstSpace = fidelityFlag.infoString.indexOf(" ");
      if (firstSpace > 0) possibleLangs.add(fidelityFlag.infoString.slice(0, firstSpace));
      for (
        let tab = fidelityFlag.infoString.indexOf("\\u{09}");
        tab > 0;
        tab = fidelityFlag.infoString.indexOf("\\u{09}", tab + 1)
      ) {
        possibleLangs.add(fidelityFlag.infoString.slice(0, tab));
      }
      if (fidelityFlag.infoStringTruncated) {
        possibleLangs.add(`${fidelityFlag.infoString}…`);
      }
    }
    if (
      codeFlag.index !== index + 1 ||
      fidelityFlag.index !== codeFlag.index ||
      fidelityFlag.sourceStartLine !== codeFlag.sourceLine ||
      codeFlag.preview !== expectedPreview ||
      (fidelityFlag.infoString === null
        ? hasLang
        : !hasLang || typeof codeFlag.lang !== "string" || !possibleLangs.has(codeFlag.lang))
    ) {
      failXGeneratedContentSnapshot();
    }
  }
  for (let index = 0; index < warnings.length; index += 1) {
    if (warnings[index] !== renderXNonArticleFidelityWarning(fidelityFlags[index])) {
      failXGeneratedContentSnapshot();
    }
  }
}

/**
 * Deep-copy and freeze a CLI-generated tweet/thread plus its inert advisories.
 * This function is browser-, profile-, database-, and reply-ledger-free.
 */
export function snapshotXGeneratedNonArticleContent(
  value: unknown,
  context: XGeneratedContentSnapshotContext,
): GeneratedContent {
  return snapshotXPlainRecord(
    value,
    ["format", "limit", "codeFlags", "linkFlags", "fidelityFlags", "warnings"],
    ["tweet", "thread", "article"],
    context,
    (reader) => {
      const format = reader.read("format");
      if (format !== "tweet" && format !== "thread") {
        failXGeneratedContentSnapshot();
      }
      const limit = positiveSafeInteger(reader.read("limit"));
      if (limit > X_PREMIUM_POST_PLATFORM_MAX_LENGTH) {
        failXGeneratedContentSnapshot();
      }
      if (
        reader.has(format === "tweet" ? "thread" : "tweet") ||
        reader.has("article") ||
        !reader.has(format)
      ) {
        failXGeneratedContentSnapshot();
      }
      const tweet = format === "tweet"
        ? snapshotTweet(reader.read("tweet"), limit, context)
        : undefined;
      const thread = format === "thread"
        ? snapshotThread(reader.read("thread"), limit, context)
        : undefined;
      const codeFlags = snapshotCodeFlags(reader.read("codeFlags"), context);
      const linkFlags = snapshotLinkFlags(reader.read("linkFlags"), context);
      const fidelityFlags = snapshotFidelityFlags(reader.read("fidelityFlags"), context);
      const warnings = snapshotWarnings(reader.read("warnings"), context);
      verifyAdvisoryCorrespondence(codeFlags, fidelityFlags, warnings);
      return Object.freeze({
        format,
        limit,
        ...(tweet ? { tweet } : {}),
        ...(thread ? { thread } : {}),
        codeFlags,
        linkFlags,
        fidelityFlags,
        warnings,
      }) as unknown as GeneratedContent;
    },
  );
}

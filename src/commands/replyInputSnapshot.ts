import { isProxy } from "node:util/types";
import {
  X_PREMIUM_POST_PLATFORM_MAX_LENGTH,
  X_STANDARD_POST_MAX_WEIGHTED_LENGTH,
  countUnicodeCodePoints,
  countXWeightedLength,
  extractTweetId,
  type LengthUnit,
} from "../capabilities/validation.js";
import type {
  CodeBlockFidelityFlag,
  CodeBlockFlag,
  GeneratedContent,
  LinkFlag,
  ProseOmissionFlag,
  ThreadPost,
  XContentFidelityFlag,
} from "../x/content.js";
import type {
  ReplyLedgerEntry,
  ReplyReservation,
  ReplyReservationClaim,
} from "../db.js";

// A Premium reply can contain 25,000 supplementary Unicode code points, which
// occupy at most 50,000 UTF-16 code units. This separately caps raw storage
// even when weighted URL measurement would otherwise make a long token cheap.
export const X_REPLY_REQUEST_TEXT_CODE_UNITS_MAX = 50_000;
export const X_REPLY_REQUEST_ADVISORY_CODE_UNITS_MAX = 10_000_000;
export const X_REPLY_REQUEST_ARRAY_ENTRIES_MAX = 10_000;

const MAX_TARGET_CODE_UNITS = 8_192;
const MAX_TOTAL_TEXT_CODE_UNITS = X_REPLY_REQUEST_ADVISORY_CODE_UNITS_MAX;
const MAX_GRAPH_NODES = 100_000;

const INVALID_REPLY_REQUEST = Symbol("invalid_reply_request");

interface SnapshotContext {
  readonly active: WeakSet<object>;
  nodes: number;
  totalTextCodeUnits: number;
}

interface RecordReader {
  has(key: string): boolean;
  read(key: string): unknown;
}

export interface XReplyRequestSnapshot {
  readonly content: GeneratedContent;
  readonly targetIdOrUrl: string;
  readonly replyToId: string;
  readonly inspect: boolean | undefined;
  readonly force: boolean | undefined;
  readonly expectedFormat: "tweet" | "thread";
  readonly expectedPosts: number;
  readonly claimOptions: Readonly<{ force: boolean | undefined }>;
  readonly stageOptions: Readonly<{ inspect: boolean | undefined }>;
}

function fail(): never {
  throw INVALID_REPLY_REQUEST;
}

function plainRecord<T>(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  context: SnapshotContext,
  build: (reader: RecordReader) => T,
): T {
  if (typeof value !== "object" || value === null) fail();
  let proxy: boolean;
  let array: boolean;
  let prototype: object | null;
  try {
    proxy = isProxy(value);
  } catch {
    fail();
  }
  // `isProxy` is trap-free even for revoked proxies. Never perform any other
  // reflection once caller-controlled proxy identity is known.
  if (proxy) fail();
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail();
  }
  if (array || prototype !== Object.prototype || context.active.has(value)) fail();
  context.nodes += 1;
  if (context.nodes > MAX_GRAPH_NODES) fail();

  const allowed = new Set([...required, ...optional]);
  const enumerableKeys = new Set<string>();
  try {
    // Accepted own-enumerable processing in user code is schema-sized, and an
    // inherited or unexpected key fails at its first yielded entry. Engines may
    // cache enumeration keys before yielding them, so this is not a resource
    // guarantee for an already-allocated hostile object.
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) fail();
      if (!allowed.has(key) || enumerableKeys.size >= allowed.size) fail();
      enumerableKeys.add(key);
    }
  } catch {
    fail();
  }
  if (required.some((key) => !enumerableKeys.has(key))) fail();

  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of enumerableKeys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail();
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
    descriptors.set(key, descriptor);
  }
  // JavaScript has no bounded iterator for hidden/symbol own properties. This
  // final exact-shape check runs only after validation has accepted the small
  // schema-sized own-enumerable key set and catches hidden/symbol extras.
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  if (
    ownKeys.length !== enumerableKeys.size ||
    ownKeys.some((key) => typeof key !== "string" || !enumerableKeys.has(key))
  ) {
    fail();
  }

  context.active.add(value);
  try {
    return build({
      has(key) {
        return descriptors.has(key);
      },
      read(key) {
        const descriptor = descriptors.get(key);
        if (!descriptor || !("value" in descriptor)) fail();
        return descriptor.value;
      },
    });
  } finally {
    context.active.delete(value);
  }
}

function denseArray<T>(
  value: unknown,
  maximum: number,
  context: SnapshotContext,
  copy: (entry: unknown, index: number) => T,
): readonly T[] {
  if (typeof value !== "object" || value === null) fail();
  let proxy: boolean;
  let array: boolean;
  let prototype: object | null;
  try {
    proxy = isProxy(value);
  } catch {
    fail();
  }
  if (proxy) fail();
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail();
  }
  if (!array || prototype !== Array.prototype || context.active.has(value)) fail();

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : null;
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) {
    fail();
  }
  const arrayLength = length as number;
  const expectedKeys = new Set<PropertyKey>(["length"]);
  for (let index = 0; index < arrayLength; index += 1) expectedKeys.add(String(index));
  let enumerableCount = 0;
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) fail();
      if (!expectedKeys.has(key) || enumerableCount >= arrayLength) fail();
      enumerableCount += 1;
    }
  } catch {
    fail();
  }
  if (enumerableCount !== arrayLength) fail();

  context.nodes += 1;
  if (context.nodes > MAX_GRAPH_NODES) fail();
  context.active.add(value);
  try {
    const result: T[] = [];
    for (let index = 0; index < arrayLength; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
      result.push(copy(descriptor.value, index));
    }
    let ownKeys: PropertyKey[];
    try {
      ownKeys = Reflect.ownKeys(value);
    } catch {
      fail();
    }
    if (ownKeys.length !== expectedKeys.size || ownKeys.some((key) => !expectedKeys.has(key))) {
      fail();
    }
    return Object.freeze(result);
  } finally {
    context.active.delete(value);
  }
}

function boundedString(
  value: unknown,
  maximum: number,
  context: SnapshotContext,
): string {
  if (typeof value !== "string" || value.length > maximum) fail();
  context.totalTextCodeUnits += value.length;
  if (context.totalTextCodeUnits > MAX_TOTAL_TEXT_CODE_UNITS) fail();
  return value;
}

function requiredNonEmptyString(
  value: unknown,
  maximum: number,
  context: SnapshotContext,
): string {
  const stringValue = boundedString(value, maximum, context);
  if (stringValue.length === 0) fail();
  return stringValue;
}

// These values are inert diagnostics: production reply staging reads only the
// copied format and tweet/thread transport text. Preserve their exact bytes for
// #59 inspection fidelity while bounding each value and the complete graph by
// the same finite aggregate budget.
function boundedAdvisoryString(value: unknown, context: SnapshotContext): string {
  return boundedString(value, X_REPLY_REQUEST_ADVISORY_CODE_UNITS_MAX, context);
}

function requiredNonEmptyAdvisoryString(
  value: unknown,
  context: SnapshotContext,
): string {
  const stringValue = boundedAdvisoryString(value, context);
  if (stringValue.length === 0) fail();
  return stringValue;
}

function optionalAdvisoryString(
  reader: RecordReader,
  key: string,
  context: SnapshotContext,
): string | undefined {
  if (!reader.has(key)) return undefined;
  const value = reader.read(key);
  return value === undefined ? undefined : boundedAdvisoryString(value, context);
}

function optionalBoolean(reader: RecordReader, key: string): boolean | undefined {
  if (!reader.has(key)) return undefined;
  const value = reader.read(key);
  if (value !== undefined && typeof value !== "boolean") fail();
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

function positiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail();
  return value as number;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail();
  return value as number;
}

function snapshotTweet(
  value: unknown,
  limit: number,
  context: SnapshotContext,
): Readonly<{ text: string; chars: number; unit: LengthUnit }> {
  return plainRecord(value, ["text", "chars", "unit"], [], context, (reader) => {
    const text = requiredNonEmptyString(
      reader.read("text"),
      X_REPLY_REQUEST_TEXT_CODE_UNITS_MAX,
      context,
    );
    if (text.trim().length === 0 || text.trim() !== text) fail();
    const chars = positiveSafeInteger(reader.read("chars"));
    const unit = reader.read("unit");
    if (
      unit !== "twitter_text_weighted" &&
      unit !== "unicode_code_points_transport_policy"
    ) {
      fail();
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
      fail();
    }
    return Object.freeze({ text, chars, unit });
  });
}

function snapshotThread(
  value: unknown,
  limit: number,
  context: SnapshotContext,
): readonly ThreadPost[] {
  if (limit !== X_STANDARD_POST_MAX_WEIGHTED_LENGTH) fail();
  const rows = denseArray(
    value,
    X_REPLY_REQUEST_ARRAY_ENTRIES_MAX,
    context,
    (entry, index) => plainRecord(
      entry,
      ["index", "total", "text", "chars"],
      [],
      context,
      (reader): ThreadPost => {
        const rowIndex = positiveSafeInteger(reader.read("index"));
        const total = positiveSafeInteger(reader.read("total"));
        const text = requiredNonEmptyString(
          reader.read("text"),
          X_REPLY_REQUEST_TEXT_CODE_UNITS_MAX,
          context,
        );
        const chars = positiveSafeInteger(reader.read("chars"));
        const suffix = ` ${rowIndex}/${total}`;
        if (
          rowIndex !== index + 1 ||
          text.length <= suffix.length ||
          !text.endsWith(suffix) ||
          chars !== countXWeightedLength(text) ||
          chars > limit
        ) {
          fail();
        }
        return Object.freeze({ index: rowIndex, total, text, chars });
      },
    ),
  );
  if (rows.length === 0) fail();
  let hasNonWhitespacePayload = false;
  for (const [position, row] of rows.entries()) {
    if (row.total !== rows.length) fail();
    const suffix = ` ${row.index}/${row.total}`;
    const payload = row.text.slice(0, -suffix.length);
    // buildThread receives globally trimmed prose. Chunk boundaries may retain
    // internal separator whitespace (including an all-whitespace middle row),
    // but the aggregate transport can have no leading or trailing whitespace.
    if (
      (position === 0 && payload.trimStart() !== payload) ||
      (position === rows.length - 1 && payload.trimEnd() !== payload)
    ) {
      fail();
    }
    if (/\S/u.test(payload)) {
      hasNonWhitespacePayload = true;
    }
  }
  if (!hasNonWhitespacePayload) fail();
  return rows;
}

function snapshotCodeFlags(value: unknown, context: SnapshotContext): readonly CodeBlockFlag[] {
  const flags = denseArray(
    value,
    X_REPLY_REQUEST_ARRAY_ENTRIES_MAX,
    context,
    (entry, position) => plainRecord(
      entry,
      ["index", "preview", "sourceLine"],
      ["lang"],
      context,
      (reader): CodeBlockFlag => {
        const index = positiveSafeInteger(reader.read("index"));
        if (index !== position + 1) fail();
        const lang = optionalAdvisoryString(
          reader,
          "lang",
          context,
        );
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
    if (flags[index].sourceLine < flags[index - 1].sourceLine) fail();
  }
  return flags;
}

function snapshotLinkFlags(value: unknown, context: SnapshotContext): readonly LinkFlag[] {
  return denseArray(
    value,
    X_REPLY_REQUEST_ARRAY_ENTRIES_MAX,
    context,
    (entry) => plainRecord(
      entry,
      ["url", "note"],
      ["text"],
      context,
      (reader): LinkFlag => {
        const url = requiredNonEmptyAdvisoryString(reader.read("url"), context);
        const text = optionalAdvisoryString(
          reader,
          "text",
          context,
        );
        const note = boundedAdvisoryString(reader.read("note"), context);
        return Object.freeze({ url, ...(reader.has("text") ? { text } : {}), note });
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

function hasExactly(reader: RecordReader, required: readonly string[]): boolean {
  const requiredSet = new Set(required);
  return FIDELITY_KEYS.every((key) => reader.has(key) === requiredSet.has(key));
}

function snapshotFidelityFlag(
  value: unknown,
  context: SnapshotContext,
): XContentFidelityFlag {
  return plainRecord(value, ["kind", "note"], FIDELITY_KEYS.slice(1), context, (reader) => {
    const kind = reader.read("kind");
    const note = boundedAdvisoryString(reader.read("note"), context);
    if (typeof kind === "string" && PROSE_OMISSION_KINDS.has(kind as ProseOmissionFlag["kind"])) {
      if (!hasExactly(reader, ["kind", "source", "sourceLine", "note"])) fail();
      return Object.freeze({
        kind: kind as ProseOmissionFlag["kind"],
        source: boundedAdvisoryString(reader.read("source"), context),
        sourceLine: positiveSafeInteger(reader.read("sourceLine")),
        note,
      });
    }
    if (kind !== "code_block" || !hasExactly(reader, FIDELITY_KEYS.filter(
      (key) => key !== "source" && key !== "sourceLine",
    ))) {
      fail();
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
    const normalizedSourceSha256 = boundedString(
      reader.read("normalizedSourceSha256"),
      64,
      context,
    );
    if (
      placeholder !== `[code block #${index} → screenshot]` ||
      sourceEndLine < sourceStartLine ||
      sourceLineCount !== sourceEndLine - sourceStartLine + 1 ||
      (fence !== "backtick" && fence !== "tilde") ||
      (closure !== "explicit" && closure !== "end_of_input") ||
      digestNormalization !== "lf_joined_source_lines" ||
      !/^[a-f0-9]{64}$/u.test(normalizedSourceSha256)
    ) {
      fail();
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
  });
}

function snapshotFidelityFlags(
  value: unknown,
  context: SnapshotContext,
): readonly XContentFidelityFlag[] {
  const flags = denseArray(
    value,
    X_REPLY_REQUEST_ARRAY_ENTRIES_MAX,
    context,
    (entry) => snapshotFidelityFlag(entry, context),
  );
  let previousLine = 0;
  for (const flag of flags) {
    const line = flag.kind === "code_block" ? flag.sourceStartLine : flag.sourceLine;
    if (line < previousLine) fail();
    previousLine = line;
  }
  return flags;
}

function snapshotWarnings(value: unknown, context: SnapshotContext): readonly string[] {
  return denseArray(
    value,
    X_REPLY_REQUEST_ARRAY_ENTRIES_MAX,
    context,
    (entry) => boundedAdvisoryString(entry, context),
  );
}

function verifyAdvisoryCorrespondence(
  codeFlags: readonly CodeBlockFlag[],
  fidelityFlags: readonly XContentFidelityFlag[],
  warnings: readonly string[],
): void {
  if (warnings.length !== fidelityFlags.length) fail();
  const fidelityCodeFlags = fidelityFlags.filter(
    (flag): flag is CodeBlockFidelityFlag => flag.kind === "code_block",
  );
  if (codeFlags.length !== fidelityCodeFlags.length) fail();
  for (let index = 0; index < codeFlags.length; index += 1) {
    const codeFlag = codeFlags[index];
    const fidelityFlag = fidelityCodeFlags[index];
    if (
      codeFlag.index !== index + 1 ||
      fidelityFlag.index !== codeFlag.index ||
      fidelityFlag.sourceStartLine !== codeFlag.sourceLine
    ) {
      fail();
    }
  }
}

function snapshotContent(value: unknown, context: SnapshotContext): GeneratedContent {
  return plainRecord(
    value,
    ["format", "limit", "codeFlags", "linkFlags", "fidelityFlags", "warnings"],
    ["tweet", "thread", "article"],
    context,
    (reader) => {
      const format = reader.read("format");
      if (format !== "tweet" && format !== "thread") fail();
      const limit = positiveSafeInteger(reader.read("limit"));
      if (limit > X_PREMIUM_POST_PLATFORM_MAX_LENGTH) fail();
      if (
        reader.has(format === "tweet" ? "thread" : "tweet") ||
        reader.has("article") ||
        !reader.has(format)
      ) {
        fail();
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

/**
 * Snapshot the complete real-run reply request before the ledger is opened.
 * Every returned object is copy-owned and frozen; malformed caller graphs are
 * collapsed to `null` without rendering caller-controlled values.
 */
export function snapshotXReplyRequest(value: unknown): XReplyRequestSnapshot | null {
  const context: SnapshotContext = {
    active: new WeakSet<object>(),
    nodes: 0,
    totalTextCodeUnits: 0,
  };
  try {
    return plainRecord(
      value,
      ["content", "targetIdOrUrl", "replyToId"],
      ["inspect", "force"],
      context,
      (reader) => {
        const targetIdOrUrl = requiredNonEmptyString(
          reader.read("targetIdOrUrl"),
          MAX_TARGET_CODE_UNITS,
          context,
        );
        const replyToId = requiredNonEmptyString(
          reader.read("replyToId"),
          MAX_TARGET_CODE_UNITS,
          context,
        );
        let normalizedTarget: string;
        try {
          normalizedTarget = extractTweetId(targetIdOrUrl);
          if (extractTweetId(replyToId) !== replyToId) fail();
        } catch {
          fail();
        }
        if (normalizedTarget !== replyToId) fail();

        const inspect = optionalBoolean(reader, "inspect");
        const force = optionalBoolean(reader, "force");
        const content = snapshotContent(reader.read("content"), context);
        const expectedFormat = content.format as "tweet" | "thread";
        const expectedPosts = expectedFormat === "thread" ? content.thread!.length : 1;
        const claimOptions = Object.freeze({ force });
        const stageOptions = Object.freeze({ inspect });
        return Object.freeze({
          content,
          targetIdOrUrl,
          replyToId,
          inspect,
          force,
          expectedFormat,
          expectedPosts,
          claimOptions,
          stageOptions,
        });
      },
    );
  } catch {
    return null;
  }
}

function snapshotReservationValue(
  value: unknown,
  expectedTargetId: string,
  context: SnapshotContext,
): Readonly<ReplyReservation> {
  return plainRecord(
    value,
    ["targetTweetId", "reservationId", "reservedAt"],
    [],
    context,
    (reservationReader) => {
      const targetTweetId = requiredNonEmptyString(
        reservationReader.read("targetTweetId"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      const reservationId = requiredNonEmptyString(
        reservationReader.read("reservationId"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      const reservedAt = requiredNonEmptyString(
        reservationReader.read("reservedAt"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      if (targetTweetId !== expectedTargetId) fail();
      return Object.freeze({ targetTweetId, reservationId, reservedAt });
    },
  );
}

function snapshotLedgerEntryValue(
  value: unknown,
  expectedTargetId: string,
  context: SnapshotContext,
): Readonly<ReplyLedgerEntry> {
  return plainRecord(
    value,
    ["targetTweetId", "stagedAt", "status", "draftRef"],
    [],
    context,
    (entryReader) => {
      const targetTweetId = requiredNonEmptyString(
        entryReader.read("targetTweetId"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      const stagedAt = requiredNonEmptyString(
        entryReader.read("stagedAt"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      const status = requiredNonEmptyString(
        entryReader.read("status"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      const rawDraftRef = entryReader.read("draftRef");
      const draftRef = rawDraftRef === null
        ? null
        : boundedString(rawDraftRef, MAX_TARGET_CODE_UNITS, context);
      const stagedAtTime = Date.parse(stagedAt);
      if (
        targetTweetId !== expectedTargetId ||
        (status !== "staged" && status !== "staged-unverified") ||
        !Number.isFinite(stagedAtTime) ||
        new Date(stagedAtTime).toISOString() !== stagedAt
      ) {
        fail();
      }
      return Object.freeze({ targetTweetId, stagedAt, status, draftRef });
    },
  );
}

/**
 * Close-copy the entire synchronous ledger claim. In particular, the #81 owner
 * token that crosses loader/native-stage awaits is detached and target-bound.
 */
export function snapshotXReplyReservationClaim(
  claim: unknown,
  expectedTargetId: string,
): Readonly<ReplyReservationClaim> | null {
  const context: SnapshotContext = {
    active: new WeakSet<object>(),
    nodes: 0,
    totalTextCodeUnits: 0,
  };
  try {
    return plainRecord(
      claim,
      ["kind"],
      ["reservation", "entry", "state"],
      context,
      (claimReader): Readonly<ReplyReservationClaim> => {
        const kind = claimReader.read("kind");
        if (kind === "acquired") {
          if (!claimReader.has("reservation") || claimReader.has("entry") || claimReader.has("state")) {
            fail();
          }
          return Object.freeze({
            kind,
            reservation: snapshotReservationValue(
              claimReader.read("reservation"),
              expectedTargetId,
              context,
            ),
          });
        }
        if (kind === "already_staged") {
          if (!claimReader.has("entry") || claimReader.has("reservation") || claimReader.has("state")) {
            fail();
          }
          return Object.freeze({
            kind,
            entry: snapshotLedgerEntryValue(
              claimReader.read("entry"),
              expectedTargetId,
              context,
            ),
          });
        }
        if (kind === "reservation_blocked") {
          if (!claimReader.has("reservation") || !claimReader.has("state") || claimReader.has("entry")) {
            fail();
          }
          const state = claimReader.read("state");
          if (state !== "active" && state !== "stale" && state !== "ambiguous") fail();
          return Object.freeze({
            kind,
            reservation: snapshotReservationValue(
              claimReader.read("reservation"),
              expectedTargetId,
              context,
            ),
            state,
          });
        }
        fail();
      },
    );
  } catch {
    return null;
  }
}

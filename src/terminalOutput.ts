import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

/**
 * Human-terminal projection is deliberately separate from canonical draft and
 * artifact bytes.  These finite limits bound one caller field and one complete
 * command transcript respectively; fixed command prose uses only the remaining
 * aggregate headroom.
 */
export const TERMINAL_FIELD_MAX_CODE_UNITS = 64_000;
export const TERMINAL_DOCUMENT_MAX_CODE_UNITS = 1_400_000;
// A verified/unverified X Article run intentionally repeats up to the reviewed
// one-million-unit #95 handoff after the initial inspection. Keep that complete
// evidence while placing a finite cap over both emissions plus framing.
export const TERMINAL_COMMAND_MAX_CODE_UNITS = 2_500_000;
export const TERMINAL_INPUT_MAX_CODE_UNITS = 25_000_000;

const TERMINAL_PROJECTION_FAILURE =
  "Terminal output projection failed closed. No caller content was rendered and no artifact or native staging action was attempted.";
const UNSAFE_TERMINAL_SCALAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export class TerminalProjectionError extends Error {
  readonly code = "terminal_projection_failed";

  constructor() {
    super(TERMINAL_PROJECTION_FAILURE);
    this.name = "TerminalProjectionError";
  }
}

export function isTerminalProjectionError(value: unknown): value is TerminalProjectionError {
  return value instanceof TerminalProjectionError;
}

export function terminalProjectionFailureMessage(): string {
  return TERMINAL_PROJECTION_FAILURE;
}

function fail(): never {
  throw new TerminalProjectionError();
}

/** Reject non-Unicode-scalar JS strings before their UTF-8 identity is hashed. */
export function assertUnicodeScalarString(value: string): void {
  for (let offset = 0; offset < value.length; offset += 1) {
    const unit = value.charCodeAt(offset);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (offset + 1 >= value.length) fail();
      const next = value.charCodeAt(offset + 1);
      if (next < 0xdc00 || next > 0xdfff) fail();
      offset += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail();
    }
  }
}

export type TerminalLineMode = "inline" | "block";

export interface TerminalTextProjection {
  readonly kind: "terminal_text_projection_v1";
  readonly lineMode: TerminalLineMode;
  /** Safe display text. LF occurs only in block mode. */
  readonly text: string;
  readonly truncated: boolean;
  readonly originalUtf16CodeUnits: number;
  readonly originalUnicodeScalars: number | null;
  readonly originalUtf8Bytes: number | null;
  readonly digestEncoding: "utf8_exact_unicode_scalar_string" | null;
  readonly digestNormalization: "none" | null;
  readonly sha256: string | null;
}

// This reserve covers the longest possible truncation fact (including inline
// or block framing) for TERMINAL_INPUT_MAX_CODE_UNITS. Keeping it fixed makes
// small-budget truncation deterministic while leaving the final rendered field
// inside the requested maximum.
const TERMINAL_TRUNCATION_METADATA_RESERVE = 256;
const terminalProjectionIdentities = new WeakSet<object>();

function visibleEscape(point: number): string {
  return `\\u{${point.toString(16).padStart(2, "0")}}`;
}

/**
 * Project an exact Unicode-scalar JS string to inert terminal text.
 *
 * - Backslashes are doubled so a literal caller `\\u{...}` cannot be confused
 *   with a control escape emitted by this projector.
 * - LF is the sole retained layout character in block mode; CR, tabs, ANSI
 *   controls, C1/DEL, bidi/format controls, and Zl/Zp become visible escapes.
 * - Inline mode visibly escapes LF as well.
 * - Truncation never splits a scalar or generated escape and carries the exact
 *   UTF-16 size plus SHA-256 of the complete, unnormalised UTF-8 scalar string.
 */
export function projectTerminalText(
  value: unknown,
  options: {
    lineMode: TerminalLineMode;
    maximumCodeUnits?: number;
  },
): Readonly<TerminalTextProjection> {
  if (typeof value !== "string") fail();
  if (value.length > TERMINAL_INPUT_MAX_CODE_UNITS) fail();
  const maximum = options.maximumCodeUnits ?? TERMINAL_FIELD_MAX_CODE_UNITS;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > TERMINAL_FIELD_MAX_CODE_UNITS) {
    fail();
  }
  assertUnicodeScalarString(value);

  // The maximum always bounds the complete rendered field, including framing
  // and a worst-case deterministic truncation fact.
  const contentBudget = Math.max(0, maximum - TERMINAL_TRUNCATION_METADATA_RESERVE);
  let text = "";
  let renderedSize = options.lineMode === "block" ? 2 : 0;
  let truncated = false;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    let rendered: string;
    if (character === "\\") {
      rendered = "\\\\";
    } else if (character === "\n" && options.lineMode === "block") {
      rendered = "\n";
    } else if (character === "\n" || UNSAFE_TERMINAL_SCALAR.test(character)) {
      rendered = visibleEscape(point);
    } else {
      rendered = character;
    }
    const framing = options.lineMode === "block" && rendered === "\n" ? 2 : 0;
    if (renderedSize + rendered.length + framing > contentBudget) {
      truncated = true;
      break;
    }
    text += rendered;
    renderedSize += rendered.length + framing;
  }

  let originalUnicodeScalars: number | null = null;
  let originalUtf8Bytes: number | null = null;
  if (truncated) {
    originalUnicodeScalars = 0;
    for (const _character of value) originalUnicodeScalars += 1;
    originalUtf8Bytes = Buffer.byteLength(value, "utf8");
  }
  const sha256 = truncated
    ? createHash("sha256").update(value, "utf8").digest("hex")
    : null;
  const projection = {
    kind: "terminal_text_projection_v1",
    lineMode: options.lineMode,
    text,
    truncated,
    originalUtf16CodeUnits: value.length,
    originalUnicodeScalars,
    originalUtf8Bytes,
    digestEncoding: truncated ? "utf8_exact_unicode_scalar_string" : null,
    digestNormalization: truncated ? "none" : null,
    sha256,
  } as const;
  const fact = truncationFact(projection);
  const finalRenderedSize = options.lineMode === "inline"
    ? text.length + (fact ? 1 + fact.length : 0)
    : renderedSize + (fact ? 4 + fact.length : 0);
  if (finalRenderedSize > maximum) fail();
  terminalProjectionIdentities.add(projection);
  return Object.freeze(projection);
}

function assertOwnedProjection(value: unknown): asserts value is Readonly<TerminalTextProjection> {
  if (typeof value !== "object" || value === null || !terminalProjectionIdentities.has(value)) fail();
}

function truncationFact(projection: Readonly<TerminalTextProjection>): string {
  if (
    !projection.truncated || projection.sha256 === null ||
    projection.digestEncoding === null || projection.digestNormalization === null
  ) {
    return "";
  }
  return (
    `[terminal projection truncated; originalUtf16CodeUnits=${projection.originalUtf16CodeUnits}; ` +
    `scalars=${projection.originalUnicodeScalars}; utf8Bytes=${projection.originalUtf8Bytes}; ` +
    `digestEncoding=${projection.digestEncoding}; digestNormalization=${projection.digestNormalization}; ` +
    `sha256=${projection.sha256}]`
  );
}

/** One-line caller field. LF and every terminal/layout control are visible. */
export function renderTerminalInline(projection: Readonly<TerminalTextProjection>): string {
  assertOwnedProjection(projection);
  if (projection.lineMode !== "inline") fail();
  const fact = truncationFact(projection);
  return fact ? `${projection.text} ${fact}` : projection.text;
}

/**
 * Multiline caller field. Every caller line is visibly framed, so content that
 * resembles a CLI heading, receipt, or shell prompt cannot become one.
 */
export function renderTerminalBlock(projection: Readonly<TerminalTextProjection>): string {
  assertOwnedProjection(projection);
  if (projection.lineMode !== "block") fail();
  const framed = projection.text.split("\n").map((line) => `│ ${line}`).join("\n");
  const fact = truncationFact(projection);
  return fact ? `${framed}\n└─ ${fact}` : framed;
}

export function renderTerminalErrorMessage(value: unknown): string {
  return finalizeTerminalDocument([
    "Local validation failed:",
    renderTerminalBlock(projectTerminalText(value, { lineMode: "block" })),
  ]);
}

/** Final aggregate guard for a complete human-readable document. */
export function finalizeTerminalDocument(parts: readonly string[]): string {
  let size = Math.max(0, parts.length - 1);
  for (const part of parts) {
    if (typeof part !== "string") fail();
    size += part.length;
    if (size > TERMINAL_DOCUMENT_MAX_CODE_UNITS) fail();
  }
  return parts.join("\n");
}

/** Command-wide stdout+stderr ledger; console.log contributes its trailing LF. */
export class TerminalOutputBudget {
  #used = 0;

  consume(message: string): void {
    if (typeof message !== "string") fail();
    const next = this.#used + message.length + 1;
    if (next > TERMINAL_COMMAND_MAX_CODE_UNITS) fail();
    this.#used = next;
  }

  get usedCodeUnits(): number {
    return this.#used;
  }
}

export function emitTerminalOutput(
  budget: TerminalOutputBudget,
  stream: "stdout" | "stderr",
  message: string,
): void {
  budget.consume(message);
  if (stream === "stdout") console.log(message);
  else console.error(message);
}

export interface ClosedSnapshotContext {
  readonly active: WeakSet<object>;
  nodes: number;
  textCodeUnits: number;
}

export interface ClosedRecordReader {
  has(key: string): boolean;
  read(key: string): unknown;
}

export function createClosedSnapshotContext(): ClosedSnapshotContext {
  return { active: new WeakSet<object>(), nodes: 0, textCodeUnits: 0 };
}

/** Trap-free-enough exact plain-object snapshot seam for generated DTOs. */
export function snapshotClosedRecord<T>(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  context: ClosedSnapshotContext,
  build: (reader: ClosedRecordReader) => T,
): T {
  if (typeof value !== "object" || value === null) fail();
  try {
    if (isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  } catch {
    fail();
  }
  if (context.active.has(value)) fail();
  context.nodes += 1;
  if (context.nodes > 100_000) fail();

  const allowed = new Set([...required, ...optional]);
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  if (
    keys.length > allowed.size ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !keys.includes(key))
  ) fail();

  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key as string);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
    descriptors.set(key as string, descriptor);
  }

  context.active.add(value);
  try {
    return build({
      has: (key) => descriptors.has(key),
      read: (key) => {
        const descriptor = descriptors.get(key);
        if (!descriptor || !("value" in descriptor)) fail();
        return descriptor.value;
      },
    });
  } finally {
    context.active.delete(value);
  }
}

export function snapshotDenseArray<T>(
  value: unknown,
  maximum: number,
  context: ClosedSnapshotContext,
  copy: (entry: unknown, index: number) => T,
): readonly T[] {
  if (typeof value !== "object" || value === null) fail();
  try {
    if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  } catch {
    fail();
  }
  if (context.active.has(value)) fail();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : -1;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) fail();
  const count = length as number;
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  if (
    keys.length !== count + 1 ||
    !keys.includes("length") ||
    keys.some((key) => key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= count))
  ) fail();

  context.nodes += 1;
  if (context.nodes > 100_000) fail();
  context.active.add(value);
  try {
    const copied: T[] = [];
    for (let index = 0; index < count; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
      copied.push(copy(descriptor.value, index));
    }
    return Object.freeze(copied);
  } finally {
    context.active.delete(value);
  }
}

export function snapshotBoundedString(
  value: unknown,
  maximum: number,
  context: ClosedSnapshotContext,
): string {
  if (typeof value !== "string" || value.length > maximum) fail();
  assertUnicodeScalarString(value);
  context.textCodeUnits += value.length;
  if (context.textCodeUnits > TERMINAL_INPUT_MAX_CODE_UNITS) fail();
  return value;
}

export function snapshotOptionalString(
  value: unknown,
  maximum: number,
  context: ClosedSnapshotContext,
): string | undefined {
  return value === undefined ? undefined : snapshotBoundedString(value, maximum, context);
}

export function snapshotSafeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail();
  return value as number;
}

export function snapshotFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail();
  return value;
}

export function snapshotBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import {
  sanitizeServerMessage,
  type LocalValidationProblem,
} from "./capabilities/validation.js";
import { GENERATED_DRAFT_ARRAY_MAX } from "./draftSnapshot.js";
import {
  createClosedSnapshotContext,
  snapshotBoolean,
  snapshotBoundedString,
  snapshotClosedRecord,
  snapshotDenseArray,
  snapshotSafeInteger,
  TerminalOutputBudget,
  finalizeTerminalDocument,
  projectTerminalText,
  renderTerminalBlock,
  renderTerminalInline,
  type ClosedSnapshotContext,
} from "./terminalOutput.js";

export const TRANSPORT_RECEIPT_SCHEMA_VERSION = "publish.transport-receipt/v1" as const;

export type TransportReceiptChannel = "x" | "linkedin" | "reddit" | "wechat";
export type TransportReceiptAction = "draft" | "reply";
export type ValidationStatus = "passed" | "failed" | "skipped" | "not_reached";
export type TransportTerminalState =
  | "dry_run_validated"
  | "native_draft_verified"
  | "native_draft_unverified"
  | "native_draft_possible"
  | "no_native_draft"
  | "input_rejected"
  | "platform_rejected"
  | "local_state_updated"
  | "unknown";

export interface ReceiptValidationProblem {
  readonly phase: "local";
  readonly code: string;
  readonly field: string;
  readonly actual: string | number | null;
  readonly expected: string;
  readonly unit: string | null;
}

export interface ReceiptValidationStage {
  readonly status: ValidationStatus;
  readonly problems: readonly ReceiptValidationProblem[];
  readonly notes: readonly string[];
}

export interface ReceiptAsset {
  /** Stable position in the receipt's asset order; never a filesystem path. */
  readonly index: number;
  readonly role: "cover" | "body_image" | "media";
  readonly requested: boolean;
  readonly resolved: boolean | null;
  /** Handed to a browser file chooser/input. This is not attachment proof. */
  readonly set: boolean | null;
  /** An upload call returned a native identifier or URL. */
  readonly uploaded: boolean | null;
  /** A platform UI/API observation attributable to this run. */
  readonly observed: boolean | null;
  /** Persistence was positively verified. */
  readonly verified: boolean | null;
  readonly remoteReference: string | null;
}

export interface ReceiptRemoteResidue {
  readonly kind: "asset" | "composer" | "native_draft" | "local_state" | "artifact";
  readonly state: string;
  readonly assetIndex: number | null;
  readonly reference: string | null;
  readonly retryRisk: "none" | "duplicate" | "unknown";
}

export interface ReceiptVerification {
  readonly status: "verified" | "unverified" | "not_applicable";
  readonly strength:
    | "none"
    | "local_only"
    | "platform_signal"
    | "scoped_row_delta"
    | "exact_content_reopen"
    | "content_and_target"
    | "native_id_returned";
  readonly nativeReference: string | null;
}

export interface ReceiptListEvidenceSummary {
  /** Count in the exact validated ordered source set. */
  readonly total: number;
  /** Count materialized in the bounded receipt list. */
  readonly listed: number;
  readonly omitted: number;
  /** SHA-256 of the UTF-8 JSON encoding of the exact validated ordered set. */
  readonly fullSetSha256: string;
}

export interface ReceiptEvidenceCounts {
  readonly yes: number;
  readonly no: number;
  readonly unknown: number;
}

export interface ReceiptAssetEvidenceSummary extends ReceiptListEvidenceSummary {
  readonly requested: ReceiptEvidenceCounts;
  readonly resolved: ReceiptEvidenceCounts;
  readonly set: ReceiptEvidenceCounts;
  readonly uploaded: ReceiptEvidenceCounts;
  readonly observed: ReceiptEvidenceCounts;
  readonly verified: ReceiptEvidenceCounts;
}

export interface ReceiptEvidenceSummary {
  readonly warnings: ReceiptListEvidenceSummary;
  readonly gotchas: ReceiptListEvidenceSummary;
  readonly assets: ReceiptAssetEvidenceSummary;
  readonly remoteResidue: ReceiptListEvidenceSummary;
}

export interface ReceiptError {
  readonly source: "command_parser" | "local" | "runtime" | "state" | "platform";
  readonly stage: string;
  readonly code: string | null;
  readonly httpStatus: number | null;
  readonly sanitizedMessage: string;
  readonly classification: "known" | "unknown";
  readonly retryable: boolean | null;
  readonly inputRelated: boolean | null;
  readonly suggestedCorrection: string | null;
}

export interface TransportReceipt {
  readonly schemaVersion: typeof TRANSPORT_RECEIPT_SCHEMA_VERSION;
  readonly channel: TransportReceiptChannel;
  readonly action: TransportReceiptAction;
  readonly format: string;
  readonly mode: "dry_run" | "real" | "recovery";
  readonly validation: {
    readonly local: ReceiptValidationStage;
    readonly live: ReceiptValidationStage;
  };
  readonly warnings: readonly string[];
  readonly gotchas: readonly string[];
  readonly assets: readonly ReceiptAsset[];
  readonly platformTouched: boolean;
  readonly terminalState: TransportTerminalState;
  readonly verification: ReceiptVerification;
  readonly remoteResidue: readonly ReceiptRemoteResidue[];
  readonly evidenceSummary: ReceiptEvidenceSummary;
  readonly published: false;
  readonly error: ReceiptError | null;
  readonly exit: {
    readonly class: "success" | "runtime_or_platform_failure" | "invalid_caller_input";
    readonly code: 0 | 1 | 2;
  };
}

export interface TransportReceiptInput extends Omit<
  TransportReceipt,
  "schemaVersion" | "published" | "evidenceSummary"
> {}

const MAX_RECEIPT_TEXT_CODE_UNITS = 2_000;
const MAX_RECEIPT_SOURCE_TEXT_CODE_UNITS = 25_000_000;
const MAX_RECEIPT_LIST_ITEMS = 100;
// Derive transport source bounds from the already-authoritative generated-draft
// array ceiling. WeChat adds one required cover asset and, after an ambiguous
// draft/add, one possible-native-draft residue to its body-image evidence.
const MAX_RECEIPT_SOURCE_TEXT_LIST_ITEMS = GENERATED_DRAFT_ARRAY_MAX;
const MAX_RECEIPT_SOURCE_ASSET_ITEMS = GENERATED_DRAFT_ARRAY_MAX + 1;
const MAX_RECEIPT_SOURCE_RESIDUE_ITEMS = GENERATED_DRAFT_ARRAY_MAX + 2;

function snapshotReceiptString(value: unknown, context: ClosedSnapshotContext): string {
  return snapshotBoundedString(value, MAX_RECEIPT_SOURCE_TEXT_CODE_UNITS, context);
}

function snapshotNullableReceiptString(
  value: unknown,
  context: ClosedSnapshotContext,
): string | null {
  return value === null ? null : snapshotReceiptString(value, context);
}

function snapshotNullableBoolean(value: unknown): boolean | null {
  return value === null ? null : snapshotBoolean(value);
}

function snapshotValidationProblem(
  value: unknown,
  context: ClosedSnapshotContext,
): ReceiptValidationProblem {
  return snapshotClosedRecord(
    value,
    ["phase", "code", "field", "actual", "expected", "unit"],
    [],
    context,
    (reader) => {
      const phase = reader.read("phase");
      if (phase !== "local") throw new Error("Invalid receipt validation phase.");
      const actualValue = reader.read("actual");
      const actual = actualValue === null
        ? null
        : typeof actualValue === "string"
          ? snapshotReceiptString(actualValue, context)
          : typeof actualValue === "number" && Number.isFinite(actualValue)
            ? actualValue
            : (() => { throw new Error("Invalid receipt validation actual value."); })();
      return {
        phase,
        code: snapshotReceiptString(reader.read("code"), context),
        field: snapshotReceiptString(reader.read("field"), context),
        actual,
        expected: snapshotReceiptString(reader.read("expected"), context),
        unit: snapshotNullableReceiptString(reader.read("unit"), context),
      };
    },
  );
}

function snapshotValidationStage(
  value: unknown,
  context: ClosedSnapshotContext,
): ReceiptValidationStage {
  return snapshotClosedRecord(
    value,
    ["status", "problems", "notes"],
    [],
    context,
    (reader) => ({
      status: snapshotReceiptString(reader.read("status"), context) as ValidationStatus,
      problems: snapshotDenseArray(
        reader.read("problems"),
        MAX_RECEIPT_LIST_ITEMS,
        context,
        (entry) => snapshotValidationProblem(entry, context),
      ),
      notes: snapshotDenseArray(
        reader.read("notes"),
        MAX_RECEIPT_LIST_ITEMS,
        context,
        (entry) => snapshotReceiptString(entry, context),
      ),
    }),
  );
}

function snapshotReceiptAsset(
  value: unknown,
  context: ClosedSnapshotContext,
): ReceiptAsset {
  return snapshotClosedRecord(
    value,
    ["index", "role", "requested", "resolved", "set", "uploaded", "observed", "verified", "remoteReference"],
    [],
    context,
    (reader) => ({
      index: snapshotSafeInteger(reader.read("index")),
      role: snapshotReceiptString(reader.read("role"), context) as ReceiptAsset["role"],
      requested: snapshotBoolean(reader.read("requested")),
      resolved: snapshotNullableBoolean(reader.read("resolved")),
      set: snapshotNullableBoolean(reader.read("set")),
      uploaded: snapshotNullableBoolean(reader.read("uploaded")),
      observed: snapshotNullableBoolean(reader.read("observed")),
      verified: snapshotNullableBoolean(reader.read("verified")),
      remoteReference: snapshotNullableReceiptString(reader.read("remoteReference"), context),
    }),
  );
}

function snapshotReceiptResidue(
  value: unknown,
  context: ClosedSnapshotContext,
): ReceiptRemoteResidue {
  return snapshotClosedRecord(
    value,
    ["kind", "state", "assetIndex", "reference", "retryRisk"],
    [],
    context,
    (reader) => ({
      kind: snapshotReceiptString(reader.read("kind"), context) as ReceiptRemoteResidue["kind"],
      state: snapshotReceiptString(reader.read("state"), context),
      assetIndex: reader.read("assetIndex") === null
        ? null
        : snapshotSafeInteger(reader.read("assetIndex")),
      reference: snapshotNullableReceiptString(reader.read("reference"), context),
      retryRisk: snapshotReceiptString(reader.read("retryRisk"), context) as ReceiptRemoteResidue["retryRisk"],
    }),
  );
}

function snapshotReceiptError(
  value: unknown,
  context: ClosedSnapshotContext,
): ReceiptError | null {
  if (value === null) return null;
  return snapshotClosedRecord(
    value,
    ["source", "stage", "code", "httpStatus", "sanitizedMessage", "classification", "retryable", "inputRelated", "suggestedCorrection"],
    [],
    context,
    (reader) => ({
      source: snapshotReceiptString(reader.read("source"), context) as ReceiptError["source"],
      stage: snapshotReceiptString(reader.read("stage"), context),
      code: snapshotNullableReceiptString(reader.read("code"), context),
      httpStatus: reader.read("httpStatus") === null
        ? null
        : snapshotSafeInteger(reader.read("httpStatus")),
      sanitizedMessage: snapshotReceiptString(reader.read("sanitizedMessage"), context),
      classification: snapshotReceiptString(reader.read("classification"), context) as ReceiptError["classification"],
      retryable: snapshotNullableBoolean(reader.read("retryable")),
      inputRelated: snapshotNullableBoolean(reader.read("inputRelated")),
      suggestedCorrection: snapshotNullableReceiptString(reader.read("suggestedCorrection"), context),
    }),
  );
}

function snapshotTransportReceiptInput(value: unknown): TransportReceiptInput {
  const context = createClosedSnapshotContext();
  return snapshotClosedRecord(
    value,
    [
      "channel", "action", "format", "mode", "validation", "warnings", "gotchas", "assets",
      "platformTouched", "terminalState", "verification", "remoteResidue", "error", "exit",
    ],
    [],
    context,
    (reader) => {
      const validation = snapshotClosedRecord(
        reader.read("validation"),
        ["local", "live"],
        [],
        context,
        (stageReader) => ({
          local: snapshotValidationStage(stageReader.read("local"), context),
          live: snapshotValidationStage(stageReader.read("live"), context),
        }),
      );
      const verification = snapshotClosedRecord(
        reader.read("verification"),
        ["status", "strength", "nativeReference"],
        [],
        context,
        (verificationReader) => ({
          status: snapshotReceiptString(verificationReader.read("status"), context) as ReceiptVerification["status"],
          strength: snapshotReceiptString(verificationReader.read("strength"), context) as ReceiptVerification["strength"],
          nativeReference: snapshotNullableReceiptString(verificationReader.read("nativeReference"), context),
        }),
      );
      const exit = snapshotClosedRecord(
        reader.read("exit"),
        ["class", "code"],
        [],
        context,
        (exitReader) => ({
          class: snapshotReceiptString(exitReader.read("class"), context) as TransportReceipt["exit"]["class"],
          code: snapshotSafeInteger(exitReader.read("code")) as TransportReceipt["exit"]["code"],
        }),
      );
      return {
        channel: snapshotReceiptString(reader.read("channel"), context) as TransportReceiptChannel,
        action: snapshotReceiptString(reader.read("action"), context) as TransportReceiptAction,
        format: snapshotReceiptString(reader.read("format"), context),
        mode: snapshotReceiptString(reader.read("mode"), context) as TransportReceipt["mode"],
        validation,
        warnings: snapshotDenseArray(
          reader.read("warnings"), MAX_RECEIPT_SOURCE_TEXT_LIST_ITEMS, context,
          (entry) => snapshotReceiptString(entry, context),
        ),
        gotchas: snapshotDenseArray(
          reader.read("gotchas"), MAX_RECEIPT_SOURCE_TEXT_LIST_ITEMS, context,
          (entry) => snapshotReceiptString(entry, context),
        ),
        assets: snapshotDenseArray(
          reader.read("assets"), MAX_RECEIPT_SOURCE_ASSET_ITEMS, context,
          (entry) => snapshotReceiptAsset(entry, context),
        ),
        platformTouched: snapshotBoolean(reader.read("platformTouched")),
        terminalState: snapshotReceiptString(reader.read("terminalState"), context) as TransportTerminalState,
        verification,
        remoteResidue: snapshotDenseArray(
          reader.read("remoteResidue"), MAX_RECEIPT_SOURCE_RESIDUE_ITEMS, context,
          (entry) => snapshotReceiptResidue(entry, context),
        ),
        error: snapshotReceiptError(reader.read("error"), context),
        exit,
      };
    },
  );
}

/** Turn any variable receipt string into bounded, terminal-inert evidence. */
export function sanitizeReceiptText(value: string): string {
  return renderTerminalInline(projectTerminalText(value, {
    lineMode: "inline",
    maximumCodeUnits: MAX_RECEIPT_TEXT_CODE_UNITS,
  }));
}

function sanitizeNullable(value: string | null): string | null {
  return value === null ? null : sanitizeReceiptText(value);
}

function assertBooleanOrNull(value: unknown): asserts value is boolean | null {
  if (value !== true && value !== false && value !== null) {
    throw new Error("Invalid receipt evidence state.");
  }
}

function sanitizeAsset(asset: ReceiptAsset): ReceiptAsset {
  if (!Number.isSafeInteger(asset.index) || asset.index < 0) {
    throw new Error("Invalid receipt asset index.");
  }
  if (asset.role !== "cover" && asset.role !== "body_image" && asset.role !== "media") {
    throw new Error("Invalid receipt asset role.");
  }
  assertBooleanOrNull(asset.resolved);
  assertBooleanOrNull(asset.set);
  assertBooleanOrNull(asset.uploaded);
  assertBooleanOrNull(asset.observed);
  assertBooleanOrNull(asset.verified);
  if (asset.set === true && asset.resolved !== true) throw new Error("Unresolved receipt asset cannot be set.");
  if (asset.uploaded === true && asset.resolved !== true) throw new Error("Unresolved receipt asset cannot be uploaded.");
  if (asset.verified === true && asset.observed !== true) throw new Error("Unobserved receipt asset cannot be verified.");
  if (asset.remoteReference !== null && asset.uploaded !== true) {
    throw new Error("Only an uploaded receipt asset can carry a remote reference.");
  }
  return Object.freeze({
    index: asset.index,
    role: asset.role,
    requested: asset.requested,
    resolved: asset.resolved,
    set: asset.set,
    uploaded: asset.uploaded,
    observed: asset.observed,
    verified: asset.verified,
    remoteReference: sanitizeNullable(asset.remoteReference),
  });
}

function sanitizeProblem(problem: ReceiptValidationProblem): ReceiptValidationProblem {
  return Object.freeze({
    phase: "local",
    code: sanitizeReceiptText(problem.code),
    field: sanitizeReceiptText(problem.field),
    actual: typeof problem.actual === "string" ? sanitizeReceiptText(problem.actual) : problem.actual,
    expected: sanitizeReceiptText(problem.expected),
    unit: sanitizeNullable(problem.unit),
  });
}

function sanitizeStage(stage: ReceiptValidationStage): ReceiptValidationStage {
  if (
    stage.status !== "passed" && stage.status !== "failed" &&
    stage.status !== "skipped" && stage.status !== "not_reached"
  ) throw new Error("Invalid receipt validation status.");
  if (!Array.isArray(stage.problems) || !Array.isArray(stage.notes)) {
    throw new Error("Invalid receipt validation evidence.");
  }
  if (stage.problems.length > MAX_RECEIPT_LIST_ITEMS || stage.notes.length > MAX_RECEIPT_LIST_ITEMS) {
    throw new Error("Receipt validation evidence exceeds the finite item budget.");
  }
  return Object.freeze({
    status: stage.status,
    problems: Object.freeze(stage.problems.map(sanitizeProblem)),
    notes: Object.freeze(stage.notes.map(sanitizeReceiptText)),
  });
}

function sanitizeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze(values.map(sanitizeReceiptText));
}

function fullSetSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function summarizeList<T>(
  full: readonly T[],
  listed: readonly T[],
  identity: unknown = full,
): ReceiptListEvidenceSummary {
  return Object.freeze({
    total: full.length,
    listed: listed.length,
    omitted: full.length - listed.length,
    fullSetSha256: fullSetSha256(identity),
  });
}

function evidenceCounts(values: readonly (boolean | null)[]): ReceiptEvidenceCounts {
  return Object.freeze({
    yes: values.filter((value) => value === true).length,
    no: values.filter((value) => value === false).length,
    unknown: values.filter((value) => value === null).length,
  });
}

function summarizeAssets(
  full: readonly ReceiptAsset[],
  listed: readonly ReceiptAsset[],
  identity: unknown = full,
): ReceiptAssetEvidenceSummary {
  return Object.freeze({
    ...summarizeList(full, listed, identity),
    requested: evidenceCounts(full.map((asset) => asset.requested)),
    resolved: evidenceCounts(full.map((asset) => asset.resolved)),
    set: evidenceCounts(full.map((asset) => asset.set)),
    uploaded: evidenceCounts(full.map((asset) => asset.uploaded)),
    observed: evidenceCounts(full.map((asset) => asset.observed)),
    verified: evidenceCounts(full.map((asset) => asset.verified)),
  });
}

/**
 * Close one operation receipt before either renderer observes it. Both human and
 * JSON output therefore consume the same copied, frozen facts.
 */
export function createTransportReceipt(unclosedInput: TransportReceiptInput): Readonly<TransportReceipt> {
  const input = snapshotTransportReceiptInput(unclosedInput);
  if (input.channel !== "x" && input.channel !== "linkedin" && input.channel !== "reddit" && input.channel !== "wechat") {
    throw new Error("Invalid receipt channel.");
  }
  if (input.action !== "draft" && input.action !== "reply") throw new Error("Invalid receipt action.");
  if (input.mode !== "dry_run" && input.mode !== "real" && input.mode !== "recovery") {
    throw new Error("Invalid receipt mode.");
  }
  if (!Array.isArray(input.warnings) || !Array.isArray(input.gotchas) ||
      !Array.isArray(input.assets) || !Array.isArray(input.remoteResidue)) {
    throw new Error("Invalid receipt list evidence.");
  }
  if (input.platformTouched !== true && input.platformTouched !== false) {
    throw new Error("Receipt platformTouched must be a proven boolean.");
  }
  const expectedClass = input.exit.code === 0
    ? "success"
    : input.exit.code === 1
      ? "runtime_or_platform_failure"
      : input.exit.code === 2
        ? "invalid_caller_input"
        : null;
  if (expectedClass === null || input.exit.class !== expectedClass) {
    throw new Error("Contradictory receipt exit class/code.");
  }
  if (input.exit.code === 0 && input.error !== null) {
    throw new Error("Successful receipt cannot carry a failure.");
  }
  if (input.exit.code !== 0 && input.error === null) {
    throw new Error("Failed receipt requires a failure record.");
  }
  if (input.exit.code === 2 && (input.platformTouched || input.terminalState !== "input_rejected")) {
    throw new Error("Invalid caller input must be zero-platform and terminally rejected.");
  }
  if (
    input.exit.code === 0 &&
    input.terminalState !== "dry_run_validated" &&
    input.terminalState !== "native_draft_verified" &&
    input.terminalState !== "local_state_updated"
  ) {
    throw new Error("Successful receipt has no successful terminal state.");
  }
  if (input.exit.code === 0 && input.verification.status === "unverified") {
    throw new Error("Unverified outcome cannot exit successfully.");
  }
  if (
    input.exit.code === 0 &&
    ((input.terminalState === "dry_run_validated" && input.mode !== "dry_run") ||
      (input.terminalState === "native_draft_verified" &&
        (input.mode !== "real" || !input.platformTouched)) ||
      (input.terminalState === "local_state_updated" &&
        (input.mode !== "recovery" || input.platformTouched)))
  ) {
    throw new Error("Successful receipt mode, platform evidence, and terminal state contradict.");
  }
  if (input.mode === "dry_run" && (input.platformTouched || input.terminalState !== "dry_run_validated") && input.exit.code === 0) {
    throw new Error("Successful dry-run must remain platform-free and locally validated.");
  }
  if (input.validation.local.status === "failed" && input.exit.code !== 2) {
    throw new Error("Failed local validation must use the caller-input exit class.");
  }
  if (input.exit.code === 2 && input.validation.local.status !== "failed") {
    throw new Error("Caller-input failure requires failed local validation.");
  }
  if (
    input.exit.code === 2 &&
    (input.error?.source !== "command_parser" && input.error?.source !== "local")
  ) {
    throw new Error("Caller-input failure requires a parser or local-validation source.");
  }
  if (input.validation.local.status === "failed" && input.validation.local.problems.length === 0) {
    throw new Error("Failed local validation requires at least one structured problem.");
  }
  if (input.validation.live.status === "passed" && !input.platformTouched) {
    throw new Error("Passed live validation requires platform contact.");
  }
  const terminalStates: readonly TransportTerminalState[] = [
    "dry_run_validated", "native_draft_verified", "native_draft_unverified",
    "native_draft_possible", "no_native_draft", "input_rejected",
    "platform_rejected", "local_state_updated", "unknown",
  ];
  if (!terminalStates.includes(input.terminalState)) throw new Error("Invalid receipt terminal state.");
  if (
    input.verification.status !== "verified" && input.verification.status !== "unverified" &&
    input.verification.status !== "not_applicable"
  ) throw new Error("Invalid receipt verification status.");
  const strengths: readonly ReceiptVerification["strength"][] = [
    "none", "local_only", "platform_signal", "scoped_row_delta",
    "exact_content_reopen", "content_and_target", "native_id_returned",
  ];
  if (!strengths.includes(input.verification.strength)) throw new Error("Invalid receipt verification strength.");
  if (input.verification.status === "verified" && input.verification.strength === "none") {
    throw new Error("Verified receipt requires positive evidence strength.");
  }
  if (input.terminalState === "native_draft_verified" && input.verification.status !== "verified") {
    throw new Error("Verified native draft requires verified evidence.");
  }
  if (new Set(input.assets.map((asset) => asset.index)).size !== input.assets.length) {
    throw new Error("Receipt asset indexes must be unique.");
  }
  const allWarnings = sanitizeStrings(input.warnings);
  const allGotchas = sanitizeStrings(input.gotchas);
  const allAssets = Object.freeze(input.assets.map(sanitizeAsset));
  const allResidue = Object.freeze(input.remoteResidue.map((entry) => {
    if (entry.kind !== "asset" && entry.kind !== "composer" && entry.kind !== "native_draft" &&
        entry.kind !== "local_state" && entry.kind !== "artifact") {
      throw new Error("Invalid receipt residue kind.");
    }
    if (entry.retryRisk !== "none" && entry.retryRisk !== "duplicate" && entry.retryRisk !== "unknown") {
      throw new Error("Invalid receipt retry risk.");
    }
    if (entry.assetIndex !== null && (!Number.isSafeInteger(entry.assetIndex) || entry.assetIndex < 0)) {
      throw new Error("Invalid remote-residue asset index.");
    }
    return Object.freeze({
      kind: entry.kind,
      state: sanitizeReceiptText(entry.state),
      assetIndex: entry.assetIndex,
      reference: sanitizeNullable(entry.reference),
      retryRisk: entry.retryRisk,
    });
  }));
  const warnings = Object.freeze(allWarnings.slice(0, MAX_RECEIPT_LIST_ITEMS));
  const gotchas = Object.freeze(allGotchas.slice(0, MAX_RECEIPT_LIST_ITEMS));
  const assets = Object.freeze(allAssets.slice(0, MAX_RECEIPT_LIST_ITEMS));
  // Residue is ordered chronologically and terminal uncertainty is commonly
  // appended after many asset entries. Retain both the bounded prefix and the
  // final state-bearing item; the digest identifies every omitted middle item.
  const remoteResidue = Object.freeze(allResidue.length <= MAX_RECEIPT_LIST_ITEMS
    ? [...allResidue]
    : [
        ...allResidue.slice(0, MAX_RECEIPT_LIST_ITEMS - 1),
        allResidue[allResidue.length - 1]!,
      ]);
  const receipt: TransportReceipt = {
    schemaVersion: TRANSPORT_RECEIPT_SCHEMA_VERSION,
    channel: input.channel,
    action: input.action,
    format: sanitizeReceiptText(input.format),
    mode: input.mode,
    validation: Object.freeze({
      local: sanitizeStage(input.validation.local),
      live: sanitizeStage(input.validation.live),
    }),
    warnings,
    gotchas,
    assets,
    platformTouched: input.platformTouched,
    terminalState: input.terminalState,
    verification: Object.freeze({
      status: input.verification.status,
      strength: input.verification.strength,
      nativeReference: sanitizeNullable(input.verification.nativeReference),
    }),
    remoteResidue,
    evidenceSummary: Object.freeze({
      warnings: summarizeList(allWarnings, warnings, input.warnings),
      gotchas: summarizeList(allGotchas, gotchas, input.gotchas),
      assets: summarizeAssets(allAssets, assets, input.assets),
      remoteResidue: summarizeList(allResidue, remoteResidue, input.remoteResidue),
    }),
    published: false,
    error: input.error === null ? null : (() => {
      if (
        input.error.source !== "command_parser" && input.error.source !== "local" &&
        input.error.source !== "runtime" && input.error.source !== "state" &&
        input.error.source !== "platform"
      ) throw new Error("Invalid receipt error source.");
      if (input.error.classification !== "known" && input.error.classification !== "unknown") {
        throw new Error("Invalid receipt error classification.");
      }
      assertBooleanOrNull(input.error.retryable);
      assertBooleanOrNull(input.error.inputRelated);
      if (input.error.httpStatus !== null &&
          (!Number.isSafeInteger(input.error.httpStatus) || input.error.httpStatus < 100 || input.error.httpStatus > 599)) {
        throw new Error("Invalid receipt HTTP status.");
      }
      return Object.freeze({
      source: input.error.source,
      stage: sanitizeReceiptText(input.error.stage),
      code: sanitizeNullable(input.error.code),
      httpStatus: input.error.httpStatus,
      sanitizedMessage: sanitizeReceiptText(sanitizeServerMessage(input.error.sanitizedMessage)),
      classification: input.error.classification,
      retryable: input.error.retryable,
      inputRelated: input.error.inputRelated,
      suggestedCorrection: sanitizeNullable(input.error.suggestedCorrection),
      });
    })(),
    exit: Object.freeze({ ...input.exit }),
  };
  return Object.freeze(receipt);
}

export const PASSED_LOCAL_VALIDATION: ReceiptValidationStage = Object.freeze({
  status: "passed",
  problems: Object.freeze([]),
  notes: Object.freeze([]),
});

export const SKIPPED_LIVE_VALIDATION: ReceiptValidationStage = Object.freeze({
  status: "skipped",
  problems: Object.freeze([]),
  notes: Object.freeze(["Live validation was intentionally skipped." ]),
});

export const NOT_REACHED_LIVE_VALIDATION: ReceiptValidationStage = Object.freeze({
  status: "not_reached",
  problems: Object.freeze([]),
  notes: Object.freeze([]),
});

export const NO_ASSETS: readonly ReceiptAsset[] = Object.freeze([]);

export function failedLocalValidation(problem: LocalValidationProblem): ReceiptValidationStage {
  return Object.freeze({
    status: "failed",
    problems: Object.freeze([sanitizeProblem(problem)]),
    notes: Object.freeze([]),
  });
}

export function createLocalInputFailureReceipt(input: {
  channel: TransportReceiptChannel;
  action: TransportReceiptAction;
  format: string;
  mode: "dry_run" | "real" | "recovery";
  problem: LocalValidationProblem;
  message?: string;
  assets?: readonly ReceiptAsset[];
}): Readonly<TransportReceipt> {
  return createTransportReceipt({
    channel: input.channel,
    action: input.action,
    format: input.format,
    mode: input.mode,
    validation: {
      local: failedLocalValidation(input.problem),
      live: NOT_REACHED_LIVE_VALIDATION,
    },
    warnings: [],
    gotchas: [],
    assets: input.assets ?? NO_ASSETS,
    platformTouched: false,
    terminalState: "input_rejected",
    verification: { status: "not_applicable", strength: "none", nativeReference: null },
    remoteResidue: [],
    error: {
      source: "local",
      stage: "local_validation",
      code: input.problem.code,
      httpStatus: null,
      sanitizedMessage: input.message ?? `Local validation failed for ${input.problem.field}.`,
      classification: "known",
      retryable: false,
      inputRelated: true,
      suggestedCorrection: `Provide ${input.problem.expected}. No platform action was attempted.`,
    },
    exit: { class: "invalid_caller_input", code: 2 },
  });
}

export function createParseFailureReceipt(input: {
  channel: TransportReceiptChannel;
  action: TransportReceiptAction;
  format: string;
  code: string;
}): Readonly<TransportReceipt> {
  return createTransportReceipt({
    channel: input.channel,
    action: input.action,
    format: input.format,
    mode: "real",
    validation: {
      local: {
        status: "failed",
        problems: [{
          phase: "local",
          code: input.code,
          field: "source",
          actual: null,
          expected: "a valid command invocation",
          unit: null,
        }],
        notes: [],
      },
      live: NOT_REACHED_LIVE_VALIDATION,
    },
    warnings: [],
    gotchas: [],
    assets: NO_ASSETS,
    platformTouched: false,
    terminalState: "input_rejected",
    verification: { status: "not_applicable", strength: "none", nativeReference: null },
    remoteResidue: [],
    error: {
      source: "command_parser",
      stage: "argument_parsing",
      code: input.code,
      httpStatus: null,
      sanitizedMessage: "The command invocation did not satisfy the declared option grammar.",
      classification: "known",
      retryable: false,
      inputRelated: true,
      suggestedCorrection: "Correct the command arguments using this command's --help output. No state, browser, or API access occurred.",
    },
    exit: { class: "invalid_caller_input", code: 2 },
  });
}

/** Content-free exit-1 receipt for an unexpected local runtime failure before staging. */
export function createPreStageRuntimeFailureReceipt(input: {
  action: TransportReceiptAction;
  format: string;
  mode: "dry_run" | "real" | "recovery";
  stage: string;
  code: string;
}): Readonly<TransportReceipt> {
  return createTransportReceipt({
    channel: "x",
    action: input.action,
    format: input.format,
    mode: input.mode,
    validation: {
      local: {
        status: "not_reached",
        problems: [],
        notes: ["Local content preparation did not complete."],
      },
      live: NOT_REACHED_LIVE_VALIDATION,
    },
    warnings: [],
    gotchas: ["No native staging function was invoked."],
    assets: NO_ASSETS,
    platformTouched: false,
    terminalState: "no_native_draft",
    verification: { status: "not_applicable", strength: "none", nativeReference: null },
    remoteResidue: [],
    error: {
      source: "runtime",
      stage: input.stage,
      code: input.code,
      httpStatus: null,
      sanitizedMessage: "Local X content preparation failed unexpectedly before native staging.",
      classification: "unknown",
      retryable: null,
      inputRelated: null,
      suggestedCorrection: "Repair or update the local CLI runtime before a separate attempt. No platform action occurred.",
    },
    exit: { class: "runtime_or_platform_failure", code: 1 },
  });
}

export function createDryRunReceipt(input: {
  channel: TransportReceiptChannel;
  action: TransportReceiptAction;
  format: string;
  warnings?: readonly string[];
  gotchas?: readonly string[];
  assets?: readonly ReceiptAsset[];
  liveNotes?: readonly string[];
}): Readonly<TransportReceipt> {
  return createTransportReceipt({
    channel: input.channel,
    action: input.action,
    format: input.format,
    mode: "dry_run",
    validation: {
      local: PASSED_LOCAL_VALIDATION,
      live: {
        status: "skipped",
        problems: [],
        notes: input.liveNotes ?? ["Live validation and native staging were intentionally skipped."],
      },
    },
    warnings: input.warnings ?? [],
    gotchas: input.gotchas ?? [],
    assets: input.assets ?? NO_ASSETS,
    platformTouched: false,
    terminalState: "dry_run_validated",
    verification: { status: "not_applicable", strength: "local_only", nativeReference: null },
    remoteResidue: [],
    error: null,
    exit: { class: "success", code: 0 },
  });
}

function label(value: boolean | null): string {
  return value === null ? "unknown" : value ? "yes" : "no";
}

/** Stable human renderer over the exact same receipt used by --json. */
export function renderTransportReceiptHuman(receipt: Readonly<TransportReceipt>): string {
  const assetCounts = receipt.evidenceSummary.assets;
  const lines = [
    `Transport receipt (${receipt.schemaVersion})`,
    `  channel/action/format: ${receipt.channel}/${receipt.action}/${receipt.format}`,
    `  mode: ${receipt.mode === "dry_run" ? "dry-run" : receipt.mode}`,
    `  validation: local=${receipt.validation.local.status}; live=${receipt.validation.live.status}`,
    `  platform touched: ${label(receipt.platformTouched)}`,
    `  terminal draft state: ${receipt.terminalState}`,
    `  verification: ${receipt.verification.status} (${receipt.verification.strength}); native reference: ${receipt.verification.nativeReference ?? "none"}`,
    `  assets: requested=${assetCounts.requested.yes}; resolved=${assetCounts.resolved.yes}; set=${assetCounts.set.yes}; uploaded=${assetCounts.uploaded.yes}; observed=${assetCounts.observed.yes}; verified=${assetCounts.verified.yes}`,
    `  bounded evidence: warnings total=${receipt.evidenceSummary.warnings.total}, listed=${receipt.evidenceSummary.warnings.listed}, omitted=${receipt.evidenceSummary.warnings.omitted}, sha256=${receipt.evidenceSummary.warnings.fullSetSha256}`,
    `  bounded evidence: gotchas total=${receipt.evidenceSummary.gotchas.total}, listed=${receipt.evidenceSummary.gotchas.listed}, omitted=${receipt.evidenceSummary.gotchas.omitted}, sha256=${receipt.evidenceSummary.gotchas.fullSetSha256}`,
    `  bounded evidence: assets total=${assetCounts.total}, listed=${assetCounts.listed}, omitted=${assetCounts.omitted}, sha256=${assetCounts.fullSetSha256}`,
    `  remote residue: total=${receipt.evidenceSummary.remoteResidue.total}, listed=${receipt.evidenceSummary.remoteResidue.listed}, omitted=${receipt.evidenceSummary.remoteResidue.omitted}, sha256=${receipt.evidenceSummary.remoteResidue.fullSetSha256}`,
    "  published: false",
    `  exit: ${receipt.exit.class} (${receipt.exit.code})`,
  ];
  for (const problem of receipt.validation.local.problems) {
    lines.push(`  local problem: ${problem.code}; field=${problem.field}; actual=${problem.actual ?? "none"}; expected=${problem.expected}${problem.unit ? `; unit=${problem.unit}` : ""}`);
  }
  for (const note of receipt.validation.local.notes) lines.push(`  local validation note: ${note}`);
  for (const note of receipt.validation.live.notes) lines.push(`  live validation note: ${note}`);
  for (const warning of receipt.warnings) lines.push(`  warning: ${warning}`);
  for (const gotcha of receipt.gotchas) lines.push(`  gotcha: ${gotcha}`);
  for (const asset of receipt.assets) {
    lines.push(
      `  asset[${asset.index}] ${asset.role}: requested=${label(asset.requested)}; resolved=${label(asset.resolved)}; set=${label(asset.set)}; uploaded=${label(asset.uploaded)}; observed=${label(asset.observed)}; verified=${label(asset.verified)}; remote reference=${asset.remoteReference ?? "none"}`,
    );
  }
  for (const residue of receipt.remoteResidue) {
    lines.push(`  residue: ${residue.kind}; state=${residue.state}; asset=${residue.assetIndex ?? "none"}; reference=${residue.reference ?? "unavailable"}; retry risk=${residue.retryRisk}`);
  }
  if (receipt.error !== null) {
    lines.push(
      `  error: source=${receipt.error.source}; stage=${receipt.error.stage}; code=${receipt.error.code ?? "unknown"}; http=${receipt.error.httpStatus ?? "unknown"}; classification=${receipt.error.classification}; retryable=${label(receipt.error.retryable)}; inputRelated=${label(receipt.error.inputRelated)}`,
      `  error message: ${receipt.error.sanitizedMessage}`,
    );
    if (receipt.error.suggestedCorrection !== null) {
      lines.push(`  suggested correction: ${receipt.error.suggestedCorrection}`);
    }
  }
  return finalizeTerminalDocument(lines);
}

export function emitTransportReceipt(
  receipt: Readonly<TransportReceipt>,
  options: { readonly json: boolean; readonly budget?: TerminalOutputBudget },
): void {
  const rendered = options.json
    ? JSON.stringify(receipt)
    : renderTransportReceiptHuman(receipt);
  const budget = options.budget ?? new TerminalOutputBudget();
  // Machine receipts always use stdout so the one JSON document is pipeable.
  const stream = options.json || receipt.exit.code === 0 ? "stdout" : "stderr";
  // Draft actions historically terminate with process.exit(), which can drop
  // an asynchronous pipe write once a bounded receipt crosses the pipe buffer.
  // Drain the exact UTF-8 receipt synchronously in either rendering mode.
  budget.consume(rendered);
  const bytes = Buffer.from(`${rendered}\n`, "utf8");
  const fd = stream === "stdout" ? 1 : 2;
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("Could not write the transport receipt.");
    offset += written;
  }
}

export function renderReceiptWarningsBlock(values: readonly string[]): string {
  return renderTerminalBlock(projectTerminalText(values.join("\n"), { lineMode: "block" }));
}

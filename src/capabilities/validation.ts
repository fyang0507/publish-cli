import type { JsonObject } from "./types.js";
import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import {
  countUnicodeCodePoints,
  countUtf16CodeUnits,
  countXWeightedLength,
} from "./measurements.js";

export {
  countUnicodeCodePoints,
  countUtf16CodeUnits,
  countXWeightedLength,
  sliceByMeasuredLength,
} from "./measurements.js";

export const X_STANDARD_POST_MAX_WEIGHTED_LENGTH = 280;
export const X_PREMIUM_POST_PLATFORM_MAX_LENGTH = 25_000;
export const LINKEDIN_POST_MAX_UTF16_CODE_UNITS = 3_000;
export const X_ARTICLE_COVER_POSITIVE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"] as const;
export const WECHAT_COVER_EXTENSIONS = [".bmp", ".png", ".jpg", ".jpeg", ".gif"] as const;
export const WECHAT_BODY_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"] as const;

export type LengthUnit =
  | "twitter_text_weighted"
  | "utf16_code_units"
  | "unicode_code_points_transport_policy";

export interface LengthValidationResult {
  valid: boolean;
  measuredLength: number;
  maximum: number;
  unit: LengthUnit;
}

function lengthResult(
  measuredLength: number,
  maximum: number,
  unit: LengthUnit,
): LengthValidationResult {
  return {
    valid: measuredLength <= maximum,
    measuredLength,
    maximum,
    unit,
  };
}

/** Validate one X post using the official twitter-text v3 weighted semantics. */
export function validateXPostText(
  text: string,
  maximum = X_STANDARD_POST_MAX_WEIGHTED_LENGTH,
): LengthValidationResult {
  return lengthResult(countXWeightedLength(text), maximum, "twitter_text_weighted");
}

/** Validate one LinkedIn personal feed post using live-confirmed UTF-16 units. */
export function validateLinkedInPostText(
  text: string,
  maximum = LINKEDIN_POST_MAX_UTF16_CODE_UNITS,
): LengthValidationResult {
  return lengthResult(countUtf16CodeUnits(text), maximum, "utf16_code_units");
}

/**
 * Existing transport guard for Premium long posts. The platform's 25,000
 * measurement is unresolved; this preserves the pre-registry code-point policy
 * without presenting it as a confirmed X counting rule.
 */
export function validateXPremiumTransportText(
  text: string,
  maximum = X_PREMIUM_POST_PLATFORM_MAX_LENGTH,
): LengthValidationResult {
  return lengthResult(
    countUnicodeCodePoints(text),
    maximum,
    "unicode_code_points_transport_policy",
  );
}

export function isLivePositiveXArticleCoverPath(localPath: string): boolean {
  return (X_ARTICLE_COVER_POSITIVE_EXTENSIONS as readonly string[]).includes(
    extname(localPath).toLowerCase(),
  );
}

export type WeChatImageSurface = "cover" | "body";

export interface LocalImageValidationResult {
  valid: boolean;
  surface: WeChatImageSurface;
  extension: string;
  contentType: string | null;
  sizeBytes: number | null;
  /** Exact platform byte boundaries are unknown and remain server-authoritative. */
  maximumBytes: null;
  error: string | null;
}

function imageContentType(extension: string): string | null {
  if (extension === ".bmp") return "image/bmp";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  return null;
}

/** Shared deterministic preflight used by dry-run generation and API upload. */
export function validateWechatLocalImage(
  localPath: string,
  surface: WeChatImageSurface,
): LocalImageValidationResult {
  const extension = extname(localPath).toLowerCase();
  const allowed = surface === "cover" ? WECHAT_COVER_EXTENSIONS : WECHAT_BODY_IMAGE_EXTENSIONS;
  const maximumBytes = null;

  if (!existsSync(localPath)) {
    return {
      valid: false,
      surface,
      extension,
      contentType: imageContentType(extension),
      sizeBytes: null,
      maximumBytes,
      error: `${surface} image not found: ${localPath}`,
    };
  }
  if (!(allowed as readonly string[]).includes(extension)) {
    return {
      valid: false,
      surface,
      extension,
      contentType: imageContentType(extension),
      sizeBytes: statSync(localPath).size,
      maximumBytes,
      error: `${surface} image must use ${allowed.join("/")} (got "${extension || "no extension"}"): ${localPath}`,
    };
  }
  const sizeBytes = statSync(localPath).size;
  return {
    valid: true,
    surface,
    extension,
    contentType: imageContentType(extension),
    sizeBytes,
    maximumBytes,
    error: null,
  };
}

export function assertWechatLocalImage(
  localPath: string,
  surface: WeChatImageSurface,
): LocalImageValidationResult {
  const result = validateWechatLocalImage(localPath, surface);
  if (!result.valid) throw new Error(result.error ?? `Invalid ${surface} image.`);
  return result;
}

/**
 * Extensible, sanitized representation of server-authoritative validation.
 * Unknown platform errors keep a null code and a caller-sanitized message;
 * raw response bodies, headers, credentials, and unrelated content never belong
 * in this receipt.
 */
export interface ServerValidationReceipt extends JsonObject {
  source: string;
  stage: string;
  phase: "server";
  outcome: "rejected" | "unknown_error";
  code: string | null;
  httpStatus: number | null;
  field: string | null;
  sanitizedMessage: string;
  classified: boolean;
  retryable: boolean | null;
  inputRelated: boolean | null;
  suggestedCorrection: string | null;
  platformTouched: boolean;
  observedState: string | null;
  published: false | null;
  redactedEvidence: JsonObject;
}

export interface ServerValidationReceiptInput {
  source: string;
  stage: string;
  outcome?: "rejected" | "unknown_error";
  code?: string | null;
  httpStatus?: number | null;
  field?: string | null;
  message: string;
  classified?: boolean;
  retryable?: boolean | null;
  inputRelated?: boolean | null;
  suggestedCorrection?: string | null;
  platformTouched: boolean;
  observedState?: string | null;
  published?: false | null;
  redactedEvidence?: JsonObject;
}

/** Bounded defense-in-depth before platform text enters a human/JSON receipt. */
export function sanitizeServerMessage(message: string): string {
  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(access[_-]?token|token|secret|password|cookie|authorization)\b\s*[:=]\s*[^\s&,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 500);
}

export function createServerValidationReceipt(
  input: ServerValidationReceiptInput,
): ServerValidationReceipt {
  return {
    source: input.source,
    stage: input.stage,
    phase: "server",
    outcome: input.outcome ?? "unknown_error",
    code: input.code ?? null,
    httpStatus: input.httpStatus ?? null,
    field: input.field ?? null,
    sanitizedMessage: sanitizeServerMessage(input.message),
    classified: input.classified ?? false,
    retryable: input.retryable ?? null,
    inputRelated: input.inputRelated ?? null,
    suggestedCorrection: input.suggestedCorrection ?? null,
    platformTouched: input.platformTouched,
    observedState: input.observedState ?? null,
    published: input.published ?? null,
    redactedEvidence: input.redactedEvidence ?? {},
  };
}

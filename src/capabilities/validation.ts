import type { JsonObject } from "./types.js";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
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

export type LocalValidationField = "source" | "text" | "title" | "body" | "target" | "media";

export interface LocalValidationProblem {
  phase: "local";
  code: string;
  field: LocalValidationField;
  actual: string | number | null;
  expected: string;
  unit: string | null;
}

export type LocalValidationProblemInput = Omit<LocalValidationProblem, "phase"> & {
  phase?: "local";
};

/** Caller-input failure that every draft command maps to exit 2 before platform access. */
export class LocalValidationError extends Error {
  readonly problem: LocalValidationProblem;

  constructor(message: string, problem: LocalValidationProblemInput) {
    super(message);
    this.name = "LocalValidationError";
    this.problem = { ...problem, phase: "local" };
  }
}

export function isLocalValidationError(error: unknown): error is LocalValidationError {
  return error instanceof LocalValidationError;
}

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

const X_REPLY_ID_PATTERN = "[1-9][0-9]{4,24}";
const X_REPLY_ID_RE = new RegExp(`^${X_REPLY_ID_PATTERN}$`);
const X_REPLY_STATUS_PATH_RE = new RegExp(
  `^/([A-Za-z0-9_]{1,15})/(status|statuses)/(${X_REPLY_ID_PATTERN})/?$`,
);
const X_REPLY_INTERNAL_STATUS_PATH_RE = new RegExp(
  `^/i/status/(${X_REPLY_ID_PATTERN})/?$`,
);
const X_REPLY_WEB_STATUS_PATH_RE = new RegExp(
  `^/i/web/status/(${X_REPLY_ID_PATTERN})/?$`,
);
const X_REPLY_TARGET_EXPECTED =
  "[1-9][0-9]{4,24}, or an HTTPS x.com/twitter.com URL with " +
  "/<handle>/status/<id>, /<handle>/statuses/<id>, /i/status/<id>, or /i/web/status/<id>";

function invalidXReplyTarget(input: string, reason: string): never {
  throw new LocalValidationError(
    `Expected ${X_REPLY_TARGET_EXPECTED}; ${reason}.`,
    {
      code: "x_invalid_reply_target",
      phase: "local",
      field: "target",
      // Never echo a caller-supplied URL: rejected userinfo/query text may
      // contain credentials or other private values. Length + category are
      // bounded evidence for the structured local-input failure.
      actual: input.length === 0
        ? null
        : `rejected_${reason.replace(/[^a-z]+/gi, "_").toLowerCase().slice(0, 48)} (${input.length} code units)`,
      expected: X_REPLY_TARGET_EXPECTED,
      unit: null,
    },
  );
}

/**
 * Parse one exact, trusted X reply target without importing browser or state
 * modules. The allowlist is deliberately closed: expanding hosts or path forms
 * requires evidence that the native X surface emits and accepts them.
 */
export function extractTweetId(input: string): string {
  if (input.length === 0) invalidXReplyTarget(input, "the target is empty");
  if (/\s|\uFEFF/u.test(input)) {
    invalidXReplyTarget(input, "whitespace or a byte-order mark is not allowed");
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(input)) {
    invalidXReplyTarget(input, "control characters are not allowed");
  }
  if (input.includes("\\")) {
    invalidXReplyTarget(input, "backslashes are not allowed");
  }

  if (X_REPLY_ID_RE.test(input)) return input;

  const schemeMatch = input.match(/^https:\/\//i);
  if (!schemeMatch) {
    invalidXReplyTarget(input, "use an exact canonical ID or supported HTTPS URL");
  }

  const authorityStart = schemeMatch[0].length;
  const authorityEndOffset = input.slice(authorityStart).search(/[/?#]/u);
  const authorityEnd = authorityEndOffset === -1
    ? input.length
    : authorityStart + authorityEndOffset;
  const rawAuthority = input.slice(authorityStart, authorityEnd);
  if (!/^(?:x\.com|twitter\.com)$/i.test(rawAuthority)) {
    invalidXReplyTarget(
      input,
      "the URL authority must be the exact apex host x.com or twitter.com without credentials or a port",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    invalidXReplyTarget(input, "the URL is malformed");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    (hostname !== "x.com" && hostname !== "twitter.com")
  ) {
    invalidXReplyTarget(input, "the parsed URL does not match the trusted HTTPS authority");
  }

  const rawPathAndSuffix = input.slice(authorityEnd);
  const suffixOffset = rawPathAndSuffix.search(/[?#]/u);
  const rawPath = suffixOffset === -1
    ? rawPathAndSuffix
    : rawPathAndSuffix.slice(0, suffixOffset);
  if (rawPath.includes("%")) {
    invalidXReplyTarget(input, "percent encoding is not allowed in the status path");
  }
  if (parsed.pathname !== rawPath) {
    invalidXReplyTarget(input, "the status path must not rely on URL normalization");
  }

  const internalMatch = rawPath.match(X_REPLY_INTERNAL_STATUS_PATH_RE) ??
    rawPath.match(X_REPLY_WEB_STATUS_PATH_RE);
  if (internalMatch) return internalMatch[1];

  const handleMatch = rawPath.match(X_REPLY_STATUS_PATH_RE);
  if (!handleMatch) {
    invalidXReplyTarget(input, "the URL path is not an allowed status path");
  }
  return handleMatch[3];
}

export type LocalImageContentType =
  | "image/bmp"
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface LocalImageInspection {
  path: string;
  valid: boolean;
  extension: string;
  contentType: LocalImageContentType | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  error: string | null;
  problem: LocalValidationProblem | null;
}

interface DetectedImage {
  contentType: LocalImageContentType;
  width: number | null;
  height: number | null;
}

const IMAGE_CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, LocalImageContentType>> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function imageContentTypeForExtension(extension: string): LocalImageContentType | null {
  return IMAGE_CONTENT_TYPE_BY_EXTENSION[extension] ?? null;
}

function positiveDimensions(
  contentType: LocalImageContentType,
  width: number,
  height: number,
): DetectedImage {
  return {
    contentType,
    width: width > 0 ? width : null,
    height: height > 0 ? height : null,
  };
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

/** Detect a supported bitmap type and dimensions from its bytes, never its suffix. */
function detectImage(buffer: Buffer): DetectedImage | null {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, pngSignature.length).equals(pngSignature) &&
    buffer.toString("ascii", 12, 16) === "IHDR"
  ) {
    return positiveDimensions("image/png", buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  }

  if (
    buffer.length >= 10 &&
    (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return positiveDimensions("image/gif", buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  }

  if (buffer.length >= 26 && buffer.toString("ascii", 0, 2) === "BM") {
    const dibSize = buffer.readUInt32LE(14);
    if (dibSize >= 12) {
      const width = dibSize === 12 ? buffer.readUInt16LE(18) : Math.abs(buffer.readInt32LE(18));
      const height = dibSize === 12 ? buffer.readUInt16LE(20) : Math.abs(buffer.readInt32LE(22));
      return positiveDimensions("image/bmp", width, height);
    }
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) break;
      const marker = buffer[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 1 >= buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      if (isJpegStartOfFrame(marker) && segmentLength >= 7) {
        return positiveDimensions(
          "image/jpeg",
          buffer.readUInt16BE(offset + 5),
          buffer.readUInt16BE(offset + 3),
        );
      }
      if (marker === 0xda) break;
      offset += segmentLength;
    }
    return { contentType: "image/jpeg", width: null, height: null };
  }

  if (
    buffer.length >= 16 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    const format = buffer.toString("ascii", 12, 16);
    if (format === "VP8X" && buffer.length >= 30) {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
      return positiveDimensions("image/webp", width, height);
    }
    if (
      format === "VP8 " &&
      buffer.length >= 30 &&
      buffer[23] === 0x9d &&
      buffer[24] === 0x01 &&
      buffer[25] === 0x2a
    ) {
      return positiveDimensions(
        "image/webp",
        buffer.readUInt16LE(26) & 0x3fff,
        buffer.readUInt16LE(28) & 0x3fff,
      );
    }
    if (format === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return positiveDimensions(
        "image/webp",
        (bits & 0x3fff) + 1,
        ((bits >>> 14) & 0x3fff) + 1,
      );
    }
    return { contentType: "image/webp", width: null, height: null };
  }

  return null;
}

/**
 * Follow JPEG marker lengths with bounded reads so a large EXIF/XMP segment
 * does not hide the SOF dimensions beyond the initial header buffer. Segment
 * payloads are skipped by offset; at most 4,096 markers / 64 KiB of stray bytes
 * are examined, regardless of the image's total byte size.
 */
function inspectJpegDimensions(
  localPath: string,
  fileSize: number,
): { width: number; height: number } | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(localPath, "r");
    let position = 2;
    let markers = 0;
    let strayByteBudget = 65_536;
    const one = Buffer.alloc(1);
    const lengthBytes = Buffer.alloc(2);

    while (position < fileSize && markers < 4_096 && strayByteBudget > 0) {
      if (readSync(descriptor, one, 0, 1, position) !== 1) return null;
      if (one[0] !== 0xff) {
        position += 1;
        strayByteBudget -= 1;
        continue;
      }

      // JPEG permits repeated 0xff fill bytes before the marker code.
      do {
        position += 1;
        if (position >= fileSize || readSync(descriptor, one, 0, 1, position) !== 1) {
          return null;
        }
      } while (one[0] === 0xff);

      const marker = one[0];
      position += 1;
      markers += 1;
      if (marker === 0x00) continue;
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (position + 2 > fileSize || readSync(descriptor, lengthBytes, 0, 2, position) !== 2) {
        return null;
      }
      const segmentLength = lengthBytes.readUInt16BE(0);
      if (segmentLength < 2 || position + segmentLength > fileSize) return null;
      if (isJpegStartOfFrame(marker) && segmentLength >= 7) {
        const frame = Buffer.alloc(7);
        if (readSync(descriptor, frame, 0, frame.length, position) !== frame.length) return null;
        const height = frame.readUInt16BE(3);
        const width = frame.readUInt16BE(5);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      position += segmentLength;
    }
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The scan result is determined by reads; close errors add no input fact.
      }
    }
  }
  return null;
}

/** Inspect a caller-supplied image using bounded header reads only. */
export function inspectLocalImage(localPath: string): LocalImageInspection {
  const extension = extname(localPath).toLowerCase();
  const failure = (
    code: string,
    error: string,
    actual: string | number | null,
    expected: string,
    unit: string | null,
    values: Partial<Pick<LocalImageInspection, "contentType" | "sizeBytes" | "width" | "height">> = {},
  ): LocalImageInspection => ({
    path: localPath,
    valid: false,
    extension,
    contentType: values.contentType ?? null,
    sizeBytes: values.sizeBytes ?? null,
    width: values.width ?? null,
    height: values.height ?? null,
    aspectRatio:
      values.width && values.height ? values.width / values.height : null,
    error,
    problem: { phase: "local", code, field: "media", actual, expected, unit },
  });

  if (!existsSync(localPath)) {
    return failure(
      "image_not_found",
      `image not found: ${localPath} (actual: missing; expected: readable regular image file)`,
      "missing",
      "readable regular image file",
      null,
    );
  }

  let stat;
  try {
    stat = statSync(localPath);
  } catch {
    return failure(
      "image_stat_failed",
      `image cannot be inspected: ${localPath} ` +
        `(actual: stat failed; expected: readable regular image file)`,
      "stat_failed",
      "readable regular image file",
      null,
    );
  }
  if (!stat.isFile()) {
    return failure(
      "image_not_regular_file",
      `image path is not a regular file: ${localPath} (actual: non-file; expected: regular file)`,
      "non-file",
      "regular file",
      null,
    );
  }

  let descriptor: number | undefined;
  let buffer: Buffer;
  try {
    descriptor = openSync(localPath, "r");
    buffer = Buffer.alloc(Math.min(65_536, Math.max(32, stat.size)));
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    buffer = buffer.subarray(0, bytesRead);
  } catch {
    return failure(
      "image_not_readable",
      `image is not readable: ${localPath} (actual: unreadable; expected: readable file)`,
      "unreadable",
      "readable file",
      null,
      { sizeBytes: stat.size },
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The bounded read already completed; a close failure is not an input fact.
      }
    }
  }

  let detected = detectImage(buffer);
  if (detected?.contentType === "image/jpeg" && detected.width === null) {
    const dimensions = inspectJpegDimensions(localPath, stat.size);
    if (dimensions) {
      detected = positiveDimensions("image/jpeg", dimensions.width, dimensions.height);
    }
  }
  if (!detected) {
    return failure(
      "image_header_invalid",
      `image has an unsupported or invalid header: ${localPath} ` +
        `(actual: unrecognized; expected: BMP, GIF, JPEG, PNG, or WebP magic/header)`,
      "unrecognized",
      "BMP, GIF, JPEG, PNG, or WebP magic/header",
      "content_type",
      { sizeBytes: stat.size },
    );
  }
  if (detected.width === null || detected.height === null) {
    return failure(
      "image_dimensions_unreadable",
      `image dimensions could not be read from its header: ${localPath} ` +
        `(actual: unavailable; expected: positive width and height)`,
      "unavailable",
      "positive width and height",
      "pixels",
      {
        contentType: detected.contentType,
        sizeBytes: stat.size,
      },
    );
  }

  const extensionType = imageContentTypeForExtension(extension);
  if (extensionType !== detected.contentType) {
    return failure(
      "image_extension_mismatch",
      `image extension does not match its detected header: ${localPath} ` +
        `(actual: ${extension || "(none)"}; expected: an extension for ${detected.contentType})`,
      extension || "(none)",
      `an extension for ${detected.contentType}`,
      "content_type",
      {
        contentType: detected.contentType,
        sizeBytes: stat.size,
        width: detected.width,
        height: detected.height,
      },
    );
  }

  return {
    path: localPath,
    valid: true,
    extension,
    contentType: detected.contentType,
    sizeBytes: stat.size,
    width: detected.width,
    height: detected.height,
    aspectRatio: detected.width / detected.height,
    error: null,
    problem: null,
  };
}

export interface LinkedInMediaValidationResult {
  valid: boolean;
  itemCount: number;
  /** Current live evidence has no authoritative maximum count. */
  maximumCount: null;
  items: LocalImageInspection[];
  errors: string[];
  problems: LocalValidationProblem[];
  unverifiedConstraints: readonly [
    "maximum_count",
    "maximum_bytes_per_image",
    "minimum_dimensions",
    "aspect_ratio_range",
    "maximum_pixels",
  ];
}

/** Validate only confirmed LinkedIn desktop inputs; conflicting limits stay unknown. */
export function validateLinkedInMedia(localPaths: readonly string[]): LinkedInMediaValidationResult {
  const allowedTypes = new Set<LocalImageContentType>([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  const items = localPaths.map((localPath): LocalImageInspection => {
    const inspected = inspectLocalImage(localPath);
    if (!inspected.valid || inspected.contentType === null || allowedTypes.has(inspected.contentType)) {
      return inspected;
    }
    return {
      ...inspected,
      valid: false,
      error: `LinkedIn media must be JPEG, PNG, GIF, or WebP ` +
        `(actual: ${inspected.contentType}; expected: image/jpeg, image/png, image/gif, or image/webp): ${localPath}`,
      problem: {
        phase: "local",
        code: "linkedin_media_type_unsupported",
        field: "media",
        actual: inspected.contentType,
        expected: "image/jpeg, image/png, image/gif, or image/webp",
        unit: "content_type",
      },
    };
  });
  const errors = items.flatMap((item) => (item.error ? [item.error] : []));
  const problems = items.flatMap((item) => (item.problem ? [item.problem] : []));
  return {
    valid: errors.length === 0,
    itemCount: items.length,
    maximumCount: null,
    items,
    errors,
    problems,
    unverifiedConstraints: [
      "maximum_count",
      "maximum_bytes_per_image",
      "minimum_dimensions",
      "aspect_ratio_range",
      "maximum_pixels",
    ],
  };
}

export type WeChatImageSurface = "cover" | "body";

export interface LocalImageValidationResult extends LocalImageInspection {
  valid: boolean;
  surface: WeChatImageSurface;
  /** Exact platform byte boundaries are unknown and remain server-authoritative. */
  maximumBytes: null;
  unverifiedConstraints: typeof WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS;
}

export const WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS = [
  "maximum_bytes_per_image",
  "minimum_dimensions",
  "aspect_ratio_range",
  "maximum_pixels",
  "maximum_body_image_count",
] as const;

/** Shared deterministic preflight used by dry-run generation and API upload. */
export function validateWechatLocalImage(
  localPath: string,
  surface: WeChatImageSurface,
): LocalImageValidationResult {
  const inspected = inspectLocalImage(localPath);
  const allowedTypes =
    surface === "cover"
      ? new Set<LocalImageContentType>(["image/bmp", "image/gif", "image/jpeg", "image/png"])
      : new Set<LocalImageContentType>(["image/jpeg", "image/png"]);
  if (inspected.valid && inspected.contentType && !allowedTypes.has(inspected.contentType)) {
    const allowed = surface === "cover" ? WECHAT_COVER_EXTENSIONS : WECHAT_BODY_IMAGE_EXTENSIONS;
    return {
      ...inspected,
      valid: false,
      surface,
      maximumBytes: null,
      unverifiedConstraints: WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS,
      error: `${surface} image must use ${allowed.join("/")} ` +
        `(actual: ${inspected.contentType}; expected: ${allowed.join("/")}): ${localPath}`,
      problem: {
        phase: "local",
        code: "wechat_image_type_unsupported",
        field: "media",
        actual: inspected.contentType,
        expected: allowed.join("/"),
        unit: "content_type",
      },
    };
  }
  return {
    ...inspected,
    surface,
    maximumBytes: null,
    unverifiedConstraints: WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS,
  };
}

export function assertWechatLocalImage(
  localPath: string,
  surface: WeChatImageSurface,
): LocalImageValidationResult {
  const result = validateWechatLocalImage(localPath, surface);
  if (!result.valid) {
    throw new LocalValidationError(
      result.error ?? `Invalid ${surface} image.`,
      result.problem ?? {
        code: "wechat_image_invalid",
        field: "media",
        actual: null,
        expected: `valid ${surface} image`,
        unit: null,
      },
    );
  }
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

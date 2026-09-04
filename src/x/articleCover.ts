import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { extname, resolve } from "node:path";
import {
  detectLocalImageBytes,
  LocalValidationError,
  type LocalImageContentType,
} from "../capabilities/validation.js";

export type XArticleCoverContentType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

/** Internal closed-receipt representation bound, not an asserted X limit. */
export const X_ARTICLE_COVER_DIMENSION_REPRESENTATION_LIMIT = 100_000_000;

/**
 * Copy-owned X Article cover input. The source path is intentionally absent:
 * browser staging receives only the bytes that passed local validation, so a
 * later rename/replacement cannot swap the payload and receipts cannot leak a
 * private filesystem path.
 */
export interface XArticleCoverPreload {
  readonly selection: "explicit";
  readonly fileName: "x-article-cover.jpg" | "x-article-cover.png" | "x-article-cover.webp";
  readonly contentType: XArticleCoverContentType;
  readonly width: number;
  readonly height: number;
  readonly ratio: "exact_5_2";
  readonly sizeBytes: number;
  readonly sourceSha256: string;
  readonly dataBase64: string;
}

export interface XArticleCoverFilePayload {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

const PRELOADED_COVERS = new WeakSet<object>();
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const EXTENSIONS_BY_CONTENT_TYPE: Readonly<Record<XArticleCoverContentType, readonly string[]>> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
};

const FILE_NAME_BY_CONTENT_TYPE: Readonly<Record<XArticleCoverContentType, XArticleCoverPreload["fileName"]>> = {
  "image/jpeg": "x-article-cover.jpg",
  "image/png": "x-article-cover.png",
  "image/webp": "x-article-cover.webp",
};

function coverFailure(
  code: string,
  message: string,
  actual: string | number | null,
  expected: string,
  unit: string | null,
): never {
  throw new LocalValidationError(message, {
    code,
    field: "media",
    actual,
    expected,
    unit,
  });
}

function isSupportedContentType(value: LocalImageContentType): value is XArticleCoverContentType {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

function hasPngSignature(bytes: Buffer): boolean {
  return bytes.length >= PNG_SIGNATURE.length &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/**
 * Check only the PNG container framing needed to trust its header: one first
 * 13-byte IHDR, bounded chunks, at least one IDAT, and a terminal empty IEND.
 * CRC and pixel decoding remain the image decoder/platform's responsibility.
 */
function hasCoherentPngContainer(bytes: Buffer): boolean {
  if (!hasPngSignature(bytes)) return false;
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let sawImageData = false;
  while (offset + 12 <= bytes.length) {
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + chunkLength;
    if (chunkEnd > bytes.length) return false;
    if (chunkIndex === 0) {
      if (chunkType !== "IHDR" || chunkLength !== 13) return false;
    } else if (chunkType === "IHDR") {
      return false;
    }
    if (chunkType === "IDAT") sawImageData = true;
    if (chunkType === "IEND") {
      return chunkLength === 0 && sawImageData && chunkEnd === bytes.length;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  return false;
}

function isBoundedWebpImageChunk(
  bytes: Buffer,
  chunkType: string,
  dataOffset: number,
  chunkSize: number,
): boolean {
  if (chunkType === "VP8 ") {
    return chunkSize >= 10 &&
      bytes[dataOffset + 3] === 0x9d &&
      bytes[dataOffset + 4] === 0x01 &&
      bytes[dataOffset + 5] === 0x2a;
  }
  return chunkType === "VP8L" &&
    chunkSize >= 5 &&
    bytes[dataOffset] === 0x2f;
}

/** Validate RIFF/chunk sizes and the minimally required WebP image framing. */
function hasCoherentWebpContainer(bytes: Buffer): boolean {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) !== bytes.length - 8
  ) return false;

  let offset = 12;
  let chunkIndex = 0;
  let firstChunkType: string | null = null;
  let firstChunkSize = 0;
  let sawImageData = false;
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkSize;
    const paddedEnd = dataEnd + (chunkSize & 1);
    if (dataEnd > bytes.length || paddedEnd > bytes.length) return false;
    if (chunkIndex === 0) {
      firstChunkType = chunkType;
      firstChunkSize = chunkSize;
    }
    if (isBoundedWebpImageChunk(bytes, chunkType, dataOffset, chunkSize)) {
      sawImageData = true;
    }
    offset = paddedEnd;
    chunkIndex += 1;
  }
  if (offset !== bytes.length || firstChunkType === null) return false;
  if (firstChunkType === "VP8X") {
    return firstChunkSize === 10 && sawImageData;
  }
  return isBoundedWebpImageChunk(bytes, firstChunkType, 20, firstChunkSize);
}

function hasWebpSignature(bytes: Buffer): boolean {
  return bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
}

/**
 * Open, read, validate, and detach one explicit cover before any X runtime,
 * profile, page, clipboard, artifact, or native-draft action is reached.
 * There is deliberately no invented byte-size ceiling: X remains authoritative
 * for constraints not established by the issue contract.
 */
export function preloadXArticleCover(localPath: string): Readonly<XArticleCoverPreload> {
  if (typeof localPath !== "string" || localPath.length === 0) {
    return coverFailure(
      "x_article_cover_missing",
      "X Article requires an explicit --cover path.",
      null,
      "--cover <prepared-5:2.jpg|png|webp>",
      null,
    );
  }

  const absolutePath = resolve(localPath);
  let descriptor: number | undefined;
  let bytes: Buffer;
  try {
    try {
      descriptor = openSync(absolutePath, constants.O_RDONLY);
    } catch (error) {
      const code = typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : null;
      if (code === "ENOENT") {
        return coverFailure(
          "x_article_cover_not_found",
          "The requested X Article cover was not found.",
          "missing",
          "a readable regular JPEG, PNG, or WebP file",
          null,
        );
      }
      return coverFailure(
        "x_article_cover_not_readable",
        "The requested X Article cover could not be opened for reading.",
        "unreadable",
        "a readable regular JPEG, PNG, or WebP file",
        null,
      );
    }

    let stat;
    try {
      stat = fstatSync(descriptor);
    } catch {
      return coverFailure(
        "x_article_cover_not_readable",
        "The requested X Article cover could not be inspected.",
        "stat_failed",
        "a readable regular JPEG, PNG, or WebP file",
        null,
      );
    }
    if (!stat.isFile()) {
      return coverFailure(
        "x_article_cover_not_regular_file",
        "The requested X Article cover is not a regular file.",
        "non_file",
        "a readable regular JPEG, PNG, or WebP file",
        null,
      );
    }

    try {
      bytes = readFileSync(descriptor);
    } catch {
      return coverFailure(
        "x_article_cover_not_readable",
        "The requested X Article cover could not be read.",
        "read_failed",
        "a readable regular JPEG, PNG, or WebP file",
        null,
      );
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The detached byte copy already determines the staged payload.
      }
    }
  }

  if (
    (hasPngSignature(bytes) && !hasCoherentPngContainer(bytes)) ||
    (hasWebpSignature(bytes) && !hasCoherentWebpContainer(bytes))
  ) {
    return coverFailure(
      "x_article_cover_container_invalid",
      "The requested X Article cover has a malformed or truncated image container.",
      "incoherent_container",
      "a minimally coherent PNG or WebP container header and chunk sizes",
      "content_type",
    );
  }

  const detected = detectLocalImageBytes(bytes);
  if (detected === null) {
    return coverFailure(
      "x_article_cover_header_invalid",
      "The requested X Article cover has an unsupported or invalid image header.",
      "unrecognized",
      "JPEG, PNG, or WebP magic/header",
      "content_type",
    );
  }
  if (!isSupportedContentType(detected.contentType)) {
    return coverFailure(
      "x_article_cover_type_unsupported",
      "X Article cover input must be JPEG, PNG, or WebP.",
      detected.contentType,
      "image/jpeg, image/png, or image/webp",
      "content_type",
    );
  }
  if (detected.width === null || detected.height === null) {
    return coverFailure(
      "x_article_cover_dimensions_unreadable",
      "The X Article cover dimensions could not be read from its image header.",
      "unavailable",
      "positive width and height",
      "pixels",
    );
  }
  if (
    detected.width > X_ARTICLE_COVER_DIMENSION_REPRESENTATION_LIMIT ||
    detected.height > X_ARTICLE_COVER_DIMENSION_REPRESENTATION_LIMIT
  ) {
    return coverFailure(
      "x_article_cover_dimensions_out_of_range",
      "The X Article cover dimensions exceed the CLI receipt representation range.",
      `${detected.width}:${detected.height}`,
      `each dimension <= ${X_ARTICLE_COVER_DIMENSION_REPRESENTATION_LIMIT}`,
      "pixels",
    );
  }

  const extension = extname(absolutePath).toLowerCase();
  if (!EXTENSIONS_BY_CONTENT_TYPE[detected.contentType].includes(extension)) {
    return coverFailure(
      "x_article_cover_extension_mismatch",
      "The X Article cover extension does not match its detected image header.",
      extension === "" ? "none" : "mismatch",
      EXTENSIONS_BY_CONTENT_TYPE[detected.contentType].join(" or "),
      "content_type",
    );
  }

  if (detected.width * 2 !== detected.height * 5) {
    return coverFailure(
      "x_article_cover_ratio_invalid",
      "The X Article cover must have an exact 5:2 aspect ratio; the CLI never crops or transforms it.",
      `${detected.width}:${detected.height}`,
      "width:height = 5:2 exactly",
      "pixels",
    );
  }

  const snapshot = Object.freeze({
    selection: "explicit" as const,
    fileName: FILE_NAME_BY_CONTENT_TYPE[detected.contentType],
    contentType: detected.contentType,
    width: detected.width,
    height: detected.height,
    ratio: "exact_5_2" as const,
    sizeBytes: bytes.length,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    dataBase64: bytes.toString("base64"),
  });
  PRELOADED_COVERS.add(snapshot);
  return snapshot;
}

/** Accept only snapshots created from a successful local preload in this process. */
export function snapshotXArticleCoverPreload(value: unknown): Readonly<XArticleCoverPreload> | null {
  if (typeof value !== "object" || value === null || !PRELOADED_COVERS.has(value)) return null;
  return value as Readonly<XArticleCoverPreload>;
}

/** Materialize a fresh Playwright payload from immutable validated bytes. */
export function xArticleCoverFilePayload(
  value: unknown,
): Readonly<XArticleCoverFilePayload> | null {
  const snapshot = snapshotXArticleCoverPreload(value);
  if (snapshot === null) return null;
  const buffer = Buffer.from(snapshot.dataBase64, "base64");
  if (
    buffer.length !== snapshot.sizeBytes ||
    createHash("sha256").update(buffer).digest("hex") !== snapshot.sourceSha256
  ) return null;
  return Object.freeze({
    name: snapshot.fileName,
    mimeType: snapshot.contentType,
    buffer,
  });
}

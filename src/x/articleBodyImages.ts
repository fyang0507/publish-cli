import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import {
  detectLocalImageBytes,
  LocalValidationError,
  type LocalImageContentType,
} from "../capabilities/validation.js";
import type { ArticleBlock } from "./content.js";

export type XArticleBodyImageContentType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

/** Internal closed-representation bound, not an asserted X platform limit. */
export const X_ARTICLE_BODY_IMAGE_DIMENSION_REPRESENTATION_LIMIT = 100_000_000;

export interface XArticleBodyImageBytes {
  readonly fileName:
    | "x-article-body.gif"
    | "x-article-body.jpg"
    | "x-article-body.png"
    | "x-article-body.webp";
  readonly contentType: XArticleBodyImageContentType;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly sourceSha256: string;
  readonly dataBase64: string;
}

/** One Markdown occurrence. Duplicate occurrences may share one exact byte snapshot. */
export interface XArticleBodyImagePreload {
  readonly occurrenceIndex: number;
  /** Zero-based index in the frozen Article block sequence. */
  readonly blockIndex: number;
  /** Digest of parser-produced destination bytes; no private path is retained. */
  readonly sourceReferenceSha256: string;
  readonly bytes: Readonly<XArticleBodyImageBytes>;
}

export interface XArticleBodyImagePreloadSet {
  readonly occurrences: readonly Readonly<XArticleBodyImagePreload>[];
}

export interface XArticleBodyImageFilePayload {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

const PRELOADED_BYTE_SNAPSHOTS = new WeakSet<object>();
const PRELOADED_OCCURRENCES = new WeakSet<object>();
const PRELOADED_SETS = new WeakSet<object>();
const EMPTY_PRELOAD_SET: Readonly<XArticleBodyImagePreloadSet> = Object.freeze({
  occurrences: Object.freeze([]),
});
PRELOADED_SETS.add(EMPTY_PRELOAD_SET);

const EXTENSIONS_BY_CONTENT_TYPE: Readonly<Record<XArticleBodyImageContentType, readonly string[]>> = {
  "image/gif": [".gif"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
};

const FILE_NAME_BY_CONTENT_TYPE: Readonly<Record<
  XArticleBodyImageContentType,
  XArticleBodyImageBytes["fileName"]
>> = {
  "image/gif": "x-article-body.gif",
  "image/jpeg": "x-article-body.jpg",
  "image/png": "x-article-body.png",
  "image/webp": "x-article-body.webp",
};

function bodyImageFailure(
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

function supportedContentType(
  value: LocalImageContentType,
): value is XArticleBodyImageContentType {
  return value === "image/gif" || value === "image/jpeg" || value === "image/png" ||
    value === "image/webp";
}

function sourceDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readUniqueBodyImage(
  absolutePath: string,
): Readonly<XArticleBodyImageBytes> {
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
        return bodyImageFailure(
          "x_article_body_image_not_found",
          "A requested X Article body image was not found.",
          "missing",
          "a readable regular GIF, JPEG, PNG, or WebP file",
          null,
        );
      }
      return bodyImageFailure(
        "x_article_body_image_not_readable",
        "A requested X Article body image could not be opened for reading.",
        "unreadable",
        "a readable regular GIF, JPEG, PNG, or WebP file",
        null,
      );
    }

    let stat;
    try {
      stat = fstatSync(descriptor);
    } catch {
      return bodyImageFailure(
        "x_article_body_image_not_readable",
        "A requested X Article body image could not be inspected.",
        "stat_failed",
        "a readable regular GIF, JPEG, PNG, or WebP file",
        null,
      );
    }
    if (!stat.isFile()) {
      return bodyImageFailure(
        "x_article_body_image_not_regular_file",
        "A requested X Article body image is not a regular file.",
        "non_file",
        "a readable regular GIF, JPEG, PNG, or WebP file",
        null,
      );
    }

    try {
      bytes = readFileSync(descriptor);
    } catch {
      return bodyImageFailure(
        "x_article_body_image_not_readable",
        "A requested X Article body image could not be read.",
        "read_failed",
        "a readable regular GIF, JPEG, PNG, or WebP file",
        null,
      );
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The detached exact byte copy owns every later staging decision.
      }
    }
  }

  const detected = detectLocalImageBytes(bytes);
  if (detected === null) {
    return bodyImageFailure(
      "x_article_body_image_header_invalid",
      "A requested X Article body image has an unsupported or invalid image header.",
      "unrecognized",
      "GIF, JPEG, PNG, or WebP magic/header",
      "content_type",
    );
  }
  if (!supportedContentType(detected.contentType)) {
    return bodyImageFailure(
      "x_article_body_image_type_unsupported",
      "X Article body images must be GIF, JPEG, PNG, or WebP.",
      detected.contentType,
      "image/gif, image/jpeg, image/png, or image/webp",
      "content_type",
    );
  }
  if (detected.width === null || detected.height === null) {
    return bodyImageFailure(
      "x_article_body_image_dimensions_unreadable",
      "An X Article body image has unreadable dimensions.",
      "unavailable",
      "positive width and height",
      "pixels",
    );
  }
  if (
    detected.width > X_ARTICLE_BODY_IMAGE_DIMENSION_REPRESENTATION_LIMIT ||
    detected.height > X_ARTICLE_BODY_IMAGE_DIMENSION_REPRESENTATION_LIMIT
  ) {
    return bodyImageFailure(
      "x_article_body_image_dimensions_out_of_range",
      "An X Article body image exceeds the CLI receipt representation range.",
      `${detected.width}:${detected.height}`,
      `each dimension <= ${X_ARTICLE_BODY_IMAGE_DIMENSION_REPRESENTATION_LIMIT}`,
      "pixels",
    );
  }

  const extension = extname(absolutePath).toLowerCase();
  if (!EXTENSIONS_BY_CONTENT_TYPE[detected.contentType].includes(extension)) {
    return bodyImageFailure(
      "x_article_body_image_extension_mismatch",
      "An X Article body image extension does not match its detected image header.",
      extension === "" ? "none" : "mismatch",
      EXTENSIONS_BY_CONTENT_TYPE[detected.contentType].join(" or "),
      "content_type",
    );
  }

  const snapshot = Object.freeze({
    fileName: FILE_NAME_BY_CONTENT_TYPE[detected.contentType],
    contentType: detected.contentType,
    width: detected.width,
    height: detected.height,
    sizeBytes: bytes.length,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    dataBase64: bytes.toString("base64"),
  });
  PRELOADED_BYTE_SNAPSHOTS.add(snapshot);
  return snapshot;
}

function imageBlocks(blocks: readonly ArticleBlock[]): Array<{
  block: Extract<ArticleBlock, { kind: "image" }>;
  blockIndex: number;
}> {
  const images: Array<{
    block: Extract<ArticleBlock, { kind: "image" }>;
    blockIndex: number;
  }> = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (block.kind === "image") images.push({ block, blockIndex });
  }
  return images;
}

/**
 * Resolve and preload every parser-confirmed occurrence before artifacts,
 * runtime loading, profiles, or browser access. Each unique resolved path is
 * opened once. Repeated Markdown occurrences remain distinct ordered records.
 */
export function preloadXArticleBodyImages(
  blocks: readonly ArticleBlock[],
  baseDirectory: string,
): Readonly<XArticleBodyImagePreloadSet> {
  if (typeof baseDirectory !== "string" || !isAbsolute(baseDirectory)) {
    return bodyImageFailure(
      "x_article_body_image_base_invalid",
      "The X Article body-image base directory was not an absolute invocation snapshot.",
      "invalid_base",
      "an absolute file-directory or invocation-CWD snapshot",
      null,
    );
  }

  const unique = new Map<string, Readonly<XArticleBodyImageBytes>>();
  const occurrences: Array<Readonly<XArticleBodyImagePreload>> = [];
  const images = imageBlocks(blocks);
  for (let offset = 0; offset < images.length; offset += 1) {
    const { block, blockIndex } = images[offset];
    if (
      block.index !== offset + 1 ||
      typeof block.source !== "string" ||
      block.source.length === 0 ||
      block.source.includes("\0")
    ) {
      return bodyImageFailure(
        "x_article_body_image_reference_invalid",
        "An X Article body-image reference failed closed local validation.",
        "invalid_reference",
        "one ordered parser-confirmed local filesystem destination",
        null,
      );
    }
    // The parser rejects known URI schemes. Repeat the closed check here so a
    // directly constructed block cannot cross the filesystem boundary.
    if (/^[a-z][a-z0-9+.-]*:/iu.test(block.source) || block.source.startsWith("//")) {
      return bodyImageFailure(
        "x_article_body_image_remote_unsupported",
        "X Article body images must be local files; remote and URI sources are unsupported.",
        "non_local_source",
        "a relative or absolute local filesystem path",
        null,
      );
    }
    const absolutePath = isAbsolute(block.source)
      ? resolve(block.source)
      : resolve(baseDirectory, block.source);
    let bytes = unique.get(absolutePath);
    if (bytes === undefined) {
      bytes = readUniqueBodyImage(absolutePath);
      unique.set(absolutePath, bytes);
    }
    const occurrence = Object.freeze({
      occurrenceIndex: block.index,
      blockIndex,
      sourceReferenceSha256: sourceDigest(block.source),
      bytes,
    });
    PRELOADED_OCCURRENCES.add(occurrence);
    occurrences.push(occurrence);
  }

  const set = Object.freeze({ occurrences: Object.freeze(occurrences) });
  PRELOADED_SETS.add(set);
  return set;
}

/** Accept only the exact aggregate created by this process's local preload. */
export function snapshotXArticleBodyImagePreloadSet(
  value: unknown,
): Readonly<XArticleBodyImagePreloadSet> | null {
  if (typeof value !== "object" || value === null || !PRELOADED_SETS.has(value)) return null;
  return value as Readonly<XArticleBodyImagePreloadSet>;
}

/** Shared branded empty set for legacy/no-body-image Article callers. */
export function emptyXArticleBodyImagePreloadSet(): Readonly<XArticleBodyImagePreloadSet> {
  return EMPTY_PRELOAD_SET;
}

/** Prove a branded preload still corresponds exactly to the frozen image blocks. */
export function xArticleBodyImagePreloadsMatchBlocks(
  value: unknown,
  blocks: readonly ArticleBlock[],
): value is Readonly<XArticleBodyImagePreloadSet> {
  const set = snapshotXArticleBodyImagePreloadSet(value);
  if (set === null) return false;
  const images = imageBlocks(blocks);
  return images.length === set.occurrences.length && images.every(({ block, blockIndex }, offset) => {
    const occurrence = set.occurrences[offset];
    return PRELOADED_OCCURRENCES.has(occurrence) &&
      PRELOADED_BYTE_SNAPSHOTS.has(occurrence.bytes) &&
      occurrence.occurrenceIndex === offset + 1 &&
      occurrence.occurrenceIndex === block.index &&
      occurrence.blockIndex === blockIndex &&
      occurrence.sourceReferenceSha256 === sourceDigest(block.source);
  });
}

/** Materialize a fresh browser payload from the immutable validated bytes. */
export function xArticleBodyImageFilePayload(
  value: unknown,
): Readonly<XArticleBodyImageFilePayload> | null {
  if (typeof value !== "object" || value === null || !PRELOADED_OCCURRENCES.has(value)) return null;
  const occurrence = value as Readonly<XArticleBodyImagePreload>;
  if (!PRELOADED_BYTE_SNAPSHOTS.has(occurrence.bytes)) return null;
  const buffer = Buffer.from(occurrence.bytes.dataBase64, "base64");
  if (
    buffer.length !== occurrence.bytes.sizeBytes ||
    createHash("sha256").update(buffer).digest("hex") !== occurrence.bytes.sourceSha256
  ) return null;
  return Object.freeze({
    name: occurrence.bytes.fileName,
    mimeType: occurrence.bytes.contentType,
    buffer,
  });
}

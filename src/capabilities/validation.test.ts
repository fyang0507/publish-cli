import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inspectLocalImage,
  validateLinkedInMedia,
  validateWechatLocalImage,
} from "./validation.js";

function png(width: number, height: number): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function jpeg(width: number, height: number): Buffer {
  const value = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  return value;
}

function gif(width: number, height: number, version: "87a" | "89a" = "89a"): Buffer {
  const value = Buffer.alloc(10);
  value.write(`GIF${version}`, 0, "ascii");
  value.writeUInt16LE(width, 6);
  value.writeUInt16LE(height, 8);
  return value;
}

function bmp(width: number, height: number): Buffer {
  const value = Buffer.alloc(26);
  value.write("BM", 0, "ascii");
  value.writeUInt32LE(12, 14);
  value.writeUInt16LE(width, 18);
  value.writeUInt16LE(height, 20);
  return value;
}

function webpExtended(width: number, height: number): Buffer {
  const value = Buffer.alloc(30);
  value.write("RIFF", 0, "ascii");
  value.write("WEBP", 8, "ascii");
  value.write("VP8X", 12, "ascii");
  const w = width - 1;
  const h = height - 1;
  value[24] = w & 0xff;
  value[25] = (w >>> 8) & 0xff;
  value[26] = (w >>> 16) & 0xff;
  value[27] = h & 0xff;
  value[28] = (h >>> 8) & 0xff;
  value[29] = (h >>> 16) & 0xff;
  return value;
}

function webpLossy(width: number, height: number): Buffer {
  const value = Buffer.alloc(30);
  value.write("RIFF", 0, "ascii");
  value.write("WEBP", 8, "ascii");
  value.write("VP8 ", 12, "ascii");
  value.set([0x9d, 0x01, 0x2a], 23);
  value.writeUInt16LE(width, 26);
  value.writeUInt16LE(height, 28);
  return value;
}

function webpLossless(width: number, height: number): Buffer {
  const value = Buffer.alloc(25);
  value.write("RIFF", 0, "ascii");
  value.write("WEBP", 8, "ascii");
  value.write("VP8L", 12, "ascii");
  value[20] = 0x2f;
  value.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return value;
}

test("local image inspection trusts magic/header data and reports dimensions", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-image-headers-"));
  try {
    const fixtures: Array<[string, Buffer, string, number, number]> = [
      ["a.png", png(640, 480), "image/png", 640, 480],
      ["b.jpg", jpeg(800, 600), "image/jpeg", 800, 600],
      ["c.gif", gif(320, 240, "87a"), "image/gif", 320, 240],
      ["d.gif", gif(321, 241), "image/gif", 321, 241],
      ["e.bmp", bmp(900, 700), "image/bmp", 900, 700],
      ["f.webp", webpExtended(1200, 500), "image/webp", 1200, 500],
      ["g.webp", webpLossy(1024, 768), "image/webp", 1024, 768],
      ["h.webp", webpLossless(511, 257), "image/webp", 511, 257],
    ];

    for (const [name, bytes, contentType, width, height] of fixtures) {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      const result = inspectLocalImage(path);
      assert.equal(result.valid, true, `${name}: ${result.error}`);
      assert.equal(result.contentType, contentType);
      assert.equal(result.width, width);
      assert.equal(result.height, height);
      assert.equal(result.sizeBytes, bytes.length);
      assert.equal(result.aspectRatio, width / height);
      assert.equal(result.problem, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JPEG dimension scanning skips a maximum-size metadata segment", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-jpeg-large-metadata-"));
  try {
    const path = join(dir, "large-exif.jpg");
    const frameOffset = 65_539;
    const value = Buffer.alloc(frameOffset + jpeg(1234, 777).length - 2);
    value.set([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff], 0);
    jpeg(1234, 777).subarray(2).copy(value, frameOffset);
    writeFileSync(path, value);
    const result = inspectLocalImage(path);
    assert.equal(result.valid, true, result.error ?? "large metadata JPEG rejected");
    assert.equal(result.contentType, "image/jpeg");
    assert.equal(result.width, 1234);
    assert.equal(result.height, 777);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local image inspection rejects missing, non-file, invalid, dimensionless, and spoofed inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-image-invalid-"));
  try {
    const invalid = join(dir, "invalid.png");
    const dimensionless = join(dir, "dimensionless.jpg");
    const spoofed = join(dir, "spoofed.png");
    const noExtension = join(dir, "no-extension");
    const truncatedWebp = join(dir, "truncated.webp");
    writeFileSync(invalid, "not an image");
    writeFileSync(dimensionless, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    writeFileSync(spoofed, gif(100, 50));
    writeFileSync(noExtension, png(100, 50));
    const shortWebp = Buffer.alloc(16);
    shortWebp.write("RIFF", 0, "ascii");
    shortWebp.write("WEBP", 8, "ascii");
    shortWebp.write("VP8X", 12, "ascii");
    writeFileSync(truncatedWebp, shortWebp);

    const checks: Array<[ReturnType<typeof inspectLocalImage>, string]> = [
      [inspectLocalImage(join(dir, "missing.png")), "image_not_found"],
      [inspectLocalImage(dir), "image_not_regular_file"],
      [inspectLocalImage(invalid), "image_header_invalid"],
      [inspectLocalImage(dimensionless), "image_dimensions_unreadable"],
      [inspectLocalImage(spoofed), "image_extension_mismatch"],
      [inspectLocalImage(noExtension), "image_extension_mismatch"],
      [inspectLocalImage(truncatedWebp), "image_dimensions_unreadable"],
    ];
    for (const [result, code] of checks) {
      assert.equal(result.valid, false);
      assert.equal(result.problem?.phase, "local");
      assert.equal(result.problem?.code, code);
      assert.notEqual(result.problem?.actual, undefined);
      assert.ok(result.problem?.expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LinkedIn validates confirmed types/order while leaving conflicting limits unverified", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-linkedin-media-"));
  try {
    const paths: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const path = join(dir, `${String(index).padStart(2, "0")}.png`);
      const dimensions = index === 0
        ? [551, 276]
        : index === 1
          ? [552, 275]
          : index === 2
            ? [8000, 5000]
            : index === 3
              ? [400, 100]
              : index === 4
                ? [300, 500]
                : [640, 480];
      writeFileSync(path, png(dimensions[0], dimensions[1]));
      paths.push(path);
    }
    truncateSync(paths[5], 5 * 1024 * 1024 + 1);

    const result = validateLinkedInMedia(paths);
    assert.equal(result.valid, true);
    assert.equal(result.itemCount, 21);
    assert.equal(result.maximumCount, null);
    assert.deepEqual(result.items.map((item) => item.path), paths);
    assert.equal(result.items[5].sizeBytes, 5 * 1024 * 1024 + 1);
    assert.deepEqual(result.unverifiedConstraints, [
      "maximum_count",
      "maximum_bytes_per_image",
      "minimum_dimensions",
      "aspect_ratio_range",
      "maximum_pixels",
    ]);

    const unsupported = join(dir, "unsupported.bmp");
    writeFileSync(unsupported, bmp(100, 100));
    const rejected = validateLinkedInMedia([unsupported]);
    assert.equal(rejected.valid, false);
    assert.equal(rejected.problems[0].phase, "local");
    assert.equal(rejected.problems[0].code, "linkedin_media_type_unsupported");
    assert.equal(rejected.problems[0].actual, "image/bmp");
    assert.ok(rejected.problems[0].expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WeChat cover/body type checks use detected bytes and keep size limits unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-media-"));
  try {
    const fixtures: Array<[string, Buffer]> = [
      ["cover.bmp", bmp(300, 300)],
      ["cover.gif", gif(300, 300)],
      ["cover.jpg", jpeg(300, 300)],
      ["cover.png", png(300, 300)],
    ];
    for (const [name, bytes] of fixtures) {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      const result = validateWechatLocalImage(path, "cover");
      assert.equal(result.valid, true, result.error ?? name);
      assert.equal(result.maximumBytes, null);
    }

    const bodyJpeg = join(dir, "body.jpg");
    const bodyPng = join(dir, "body.png");
    const bodyGif = join(dir, "body.gif");
    writeFileSync(bodyJpeg, jpeg(640, 480));
    writeFileSync(bodyPng, png(640, 480));
    writeFileSync(bodyGif, gif(640, 480));
    assert.equal(validateWechatLocalImage(bodyJpeg, "body").valid, true);
    assert.equal(validateWechatLocalImage(bodyPng, "body").valid, true);
    const rejected = validateWechatLocalImage(bodyGif, "body");
    assert.equal(rejected.valid, false);
    assert.equal(rejected.problem?.phase, "local");
    assert.equal(rejected.problem?.actual, "image/gif");
    assert.ok(rejected.problem?.expected);
    assert.equal(rejected.problem?.unit, "content_type");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

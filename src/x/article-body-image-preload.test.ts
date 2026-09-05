import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalValidationError } from "../capabilities/validation.js";
import type { ArticleBlock } from "./content.js";
import {
  emptyXArticleBodyImagePreloadSet,
  preloadXArticleBodyImages,
  snapshotXArticleBodyImagePreloadSet,
  xArticleBodyImageFilePayload,
  xArticleBodyImagePreloadsMatchBlocks,
} from "./articleBodyImages.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAUAAAACCAIAAAAfCIEKAAAACXBIWXMAAAABAAAAAQBPJcTWAAAADklEQVR4nGNkQAUsaHwAAIAABtETi70AAAAASUVORK5CYII=",
  "base64",
);

function image(index: number, source: string): Extract<ArticleBlock, { kind: "image" }> {
  return { kind: "image", index, source, alt: `alt-${index}` };
}

function paragraph(text: string): Extract<ArticleBlock, { kind: "paragraph" }> {
  return { kind: "paragraph", runs: [{ text }] };
}

function expectFailure(action: () => unknown, code: string, secret?: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LocalValidationError);
    assert.equal(error.problem.code, code);
    if (secret) {
      assert.doesNotMatch(error.message, new RegExp(secret, "u"));
      assert.doesNotMatch(JSON.stringify(error.problem), new RegExp(secret, "u"));
    }
    return true;
  });
}

test("body image preload opens one unique source snapshot while retaining ordered duplicate occurrences", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-body-preload-"));
  try {
    const source = join(dir, "private-source.png");
    writeFileSync(source, PNG);
    const blocks: ArticleBlock[] = [
      image(1, "private-source.png"),
      paragraph("between"),
      image(2, "private-source.png"),
    ];
    const set = preloadXArticleBodyImages(blocks, dir);
    assert.equal(Object.isFrozen(set), true);
    assert.equal(Object.isFrozen(set.occurrences), true);
    assert.equal(set.occurrences.length, 2);
    assert.equal(set.occurrences[0].blockIndex, 0);
    assert.equal(set.occurrences[1].blockIndex, 2);
    assert.equal(set.occurrences[0].bytes, set.occurrences[1].bytes);
    assert.equal(set.occurrences[0].bytes.contentType, "image/png");
    assert.equal(set.occurrences[0].bytes.width, 5);
    assert.equal(set.occurrences[0].bytes.height, 2);
    assert.equal(xArticleBodyImagePreloadsMatchBlocks(set, blocks), true);

    writeFileSync(source, Buffer.from("replacement"));
    const first = xArticleBodyImageFilePayload(set.occurrences[0]);
    const second = xArticleBodyImageFilePayload(set.occurrences[1]);
    assert.ok(first && second);
    assert.deepEqual(first.buffer, PNG);
    assert.deepEqual(second.buffer, PNG);
    assert.equal(first.name, "x-article-body.png");
    assert.doesNotMatch(JSON.stringify(set), /private-source|publish-x-body-preload/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("body image preload supports the calibrated image-only MIME set without transforms", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-body-types-"));
  try {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 2, 0]);
    writeFileSync(join(dir, "body.gif"), gif);
    const set = preloadXArticleBodyImages([image(1, "body.gif")], dir);
    assert.equal(set.occurrences[0].bytes.contentType, "image/gif");
    assert.equal(set.occurrences[0].bytes.width, 3);
    assert.equal(set.occurrences[0].bytes.height, 2);
    assert.deepEqual(xArticleBodyImageFilePayload(set.occurrences[0])?.buffer, gif);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("body image preload rejects filesystem and byte mismatches with path-free evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-body-invalid-"));
  try {
    mkdirSync(join(dir, "private-dir.png"));
    writeFileSync(join(dir, "private-invalid.png"), Buffer.from("not an image"));
    writeFileSync(join(dir, "private-mismatch.jpg"), PNG);
    for (const [source, code] of [
      ["private-missing.png", "x_article_body_image_not_found"],
      ["private-dir.png", "x_article_body_image_not_regular_file"],
      ["private-invalid.png", "x_article_body_image_header_invalid"],
      ["private-mismatch.jpg", "x_article_body_image_extension_mismatch"],
    ] as const) {
      expectFailure(
        () => preloadXArticleBodyImages([image(1, source)], dir),
        code,
        source,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("direct non-local or structurally inconsistent image blocks fail before filesystem access", () => {
  const base = process.cwd();
  for (const source of [
    "https://example.com/a.png",
    "data:image/png;base64,AAAA",
    "blob:https://example.com/id",
    "file:///private/a.png",
    "//example.com/a.png",
  ]) {
    expectFailure(
      () => preloadXArticleBodyImages([image(1, source)], base),
      "x_article_body_image_remote_unsupported",
    );
  }
  expectFailure(
    () => preloadXArticleBodyImages([image(2, "never-read.png")], base),
    "x_article_body_image_reference_invalid",
  );
});

test("branded preload correspondence rejects block-position or source substitution", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-body-correspond-"));
  try {
    writeFileSync(join(dir, "one.png"), PNG);
    const original: ArticleBlock[] = [paragraph("before"), image(1, "one.png")];
    const set = preloadXArticleBodyImages(original, dir);
    assert.equal(snapshotXArticleBodyImagePreloadSet(set), set);
    assert.equal(snapshotXArticleBodyImagePreloadSet(structuredClone(set)), null);
    assert.equal(
      xArticleBodyImagePreloadsMatchBlocks(set, [image(1, "one.png"), paragraph("before")]),
      false,
    );
    assert.equal(
      xArticleBodyImagePreloadsMatchBlocks(set, [paragraph("before"), image(1, "two.png")]),
      false,
    );
    assert.equal(xArticleBodyImageFilePayload(structuredClone(set.occurrences[0])), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shared empty body-image preload is branded and immutable", () => {
  const empty = emptyXArticleBodyImagePreloadSet();
  assert.equal(snapshotXArticleBodyImagePreloadSet(empty), empty);
  assert.equal(xArticleBodyImagePreloadsMatchBlocks(empty, [paragraph("body")]), true);
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(Object.isFrozen(empty.occurrences), true);
});

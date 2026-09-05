import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeXDraftRealRun, receiptForXDraftOutcome } from "./draft.js";
import { generateContent } from "../x/content.js";
import { preloadXArticleCover } from "../x/articleCover.js";
import { preloadXArticleBodyImages } from "../x/articleBodyImages.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAUAAAACCAIAAAAfCIEKAAAACXBIWXMAAAABAAAAAQBPJcTWAAAADklEQVR4nGNkQAUsaHwAAIAABtETi70AAAAASUVORK5CYII=",
  "base64",
);

test("headless body-image Article exits 2 before dynamic runtime loading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-body-command-"));
  try {
    writeFileSync(join(dir, "cover.png"), PNG);
    writeFileSync(join(dir, "body.png"), PNG);
    const content = await generateContent(
      "# Body image\n\nBefore.\n\n![](body.png)\n\nAfter.\n",
      { format: "article" },
    );
    const cover = preloadXArticleCover(join(dir, "cover.png"));
    const bodyImages = preloadXArticleBodyImages(content.article!.blocks, dir);
    let loaderCalls = 0;
    const outcome = await executeXDraftRealRun(
      { content, cover, bodyImages },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          throw new Error("must not load");
        },
      },
    );
    assert.equal(loaderCalls, 0);
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.savePhase, "save_not_attempted");
    assert.equal(outcome.platformTouched, false);
    assert.match(outcome.message, /require --inspect/u);
    assert.doesNotMatch(outcome.message, /body\.png|publish-x-body-command/u);

    const receipt = receiptForXDraftOutcome(outcome, "article", [], cover, bodyImages);
    assert.equal(receipt.platformTouched, false);
    assert.equal(receipt.assets.length, 2);
    assert.deepEqual(receipt.assets.map((asset) => [asset.index, asset.role]), [
      [0, "cover"],
      [1, "body_image"],
    ]);
    assert.equal(receipt.assets[1].requested, true);
    assert.equal(receipt.assets[1].resolved, true);
    assert.equal(receipt.assets[1].set, false);
    assert.equal(receipt.assets[1].verified, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headed body-image Article crosses the local gate and loads the staging runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-body-command-headed-"));
  try {
    writeFileSync(join(dir, "cover.png"), PNG);
    writeFileSync(join(dir, "body.png"), PNG);
    const content = await generateContent(
      "# Body image\n\n![](body.png)\n",
      { format: "article" },
    );
    const cover = preloadXArticleCover(join(dir, "cover.png"));
    const bodyImages = preloadXArticleBodyImages(content.article!.blocks, dir);
    let loaderCalls = 0;
    const outcome = await executeXDraftRealRun(
      { content, cover, bodyImages, inspect: true },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          throw new Error("bounded runtime sentinel");
        },
      },
    );
    assert.equal(loaderCalls, 1);
    assert.equal(outcome.kind, "stage_runtime_failed");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.platformTouched, false);
    assert.match(outcome.message, /Could not initialize/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { generateContent, type GeneratedContent } from "./content.js";
import {
  articleTextSegments,
  htmlFromArticleBlocks,
  plainTextFromArticleBlocks,
  snapshotXArticleStageInput,
  XArticleStageSnapshotError,
} from "./articleStageSnapshot.js";

const MARKDOWN =
  "# Image snapshot\n\nBefore **bold**.\n\n![](assets/one.png)\n\nAfter [link](https://example.com).\n\n![](assets/one.png)\n";

test("Article snapshot freezes image identity and N+1 ordered text segments", async () => {
  const generated = await generateContent(MARKDOWN, { format: "article" });
  const snapshot = snapshotXArticleStageInput(generated, "article");
  assert.deepEqual(snapshot.imageBlocks, [
    { kind: "image", index: 1, source: "assets/one.png", alt: "" },
    { kind: "image", index: 2, source: "assets/one.png", alt: "" },
  ]);
  assert.equal(snapshot.segments.length, 3);
  assert.deepEqual(snapshot.segments.map((segment) => segment.index), [0, 1, 2]);
  assert.match(snapshot.segments[0].html, /Before <strong>bold<\/strong>\./u);
  assert.equal(snapshot.segments[0].plain, "Before bold.");
  assert.match(snapshot.segments[1].html, /After <a href="https:\/\/example\.com">link<\/a>\./u);
  assert.equal(snapshot.segments[1].plain, "After link.");
  assert.equal(snapshot.segments[2].html, "");
  assert.equal(snapshot.segments[2].plain, "");
  assert.equal(snapshot.plain, "Before bold.\n\nAfter link.");
  assert.equal(snapshot.html.includes("assets/one.png"), false);
  assert.equal(Object.isFrozen(snapshot.imageBlocks), true);
  assert.equal(Object.isFrozen(snapshot.segments), true);
  assert.equal(Object.isFrozen(snapshot.segments[0]), true);
  assert.equal(articleTextSegments(snapshot.content.article!.blocks).length, 3);
  assert.equal(htmlFromArticleBlocks(snapshot.content.article!.blocks).html, snapshot.html);
  assert.equal(plainTextFromArticleBlocks(snapshot.content.article!.blocks), snapshot.plain);
});

test("hostile image source, alt, index, or block-position substitution fails canonical correspondence", async () => {
  const generated = await generateContent(MARKDOWN, { format: "article" });
  const mutations: Array<(content: GeneratedContent) => void> = [
    (content) => {
      const image = content.article!.blocks.find((block) => block.kind === "image");
      if (!image || image.kind !== "image") throw new Error("missing image");
      image.source = "assets/two.png";
    },
    (content) => {
      const image = content.article!.blocks.find((block) => block.kind === "image");
      if (!image || image.kind !== "image") throw new Error("missing image");
      image.alt = "substituted";
    },
    (content) => {
      const image = content.article!.blocks.find((block) => block.kind === "image");
      if (!image || image.kind !== "image") throw new Error("missing image");
      image.index = 2;
    },
    (content) => {
      const blocks = content.article!.blocks;
      const firstImage = blocks.findIndex((block) => block.kind === "image");
      [blocks[firstImage - 1], blocks[firstImage]] = [blocks[firstImage], blocks[firstImage - 1]];
    },
  ];
  for (const mutate of mutations) {
    const hostile = structuredClone(generated) as GeneratedContent;
    mutate(hostile);
    assert.throws(
      () => snapshotXArticleStageInput(hostile, "article"),
      (error: unknown) => error instanceof XArticleStageSnapshotError &&
        error.reason === "accounting_mismatch",
    );
  }
});

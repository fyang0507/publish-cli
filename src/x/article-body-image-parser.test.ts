import test from "node:test";
import assert from "node:assert/strict";
import { LocalValidationError } from "../capabilities/validation.js";
import { parseXArticleBlocks } from "./articleMarkdown.js";

function rejected(body: string, expectedCode?: string): LocalValidationError {
  try {
    parseXArticleBlocks(body);
  } catch (error) {
    assert.ok(error instanceof LocalValidationError);
    if (expectedCode) assert.equal(error.problem.code, expectedCode);
    assert.equal(error.problem.phase, "local");
    assert.match(error.message, /no artifact or native draft was created/i);
    return error;
  }
  assert.fail("expected X Article body Markdown to reject locally");
}

test("top-level empty-alt image paragraphs retain parser destinations, order, and duplicates", () => {
  const blocks = parseXArticleBlocks([
    "Before",
    "",
    "![](./diagram\\(1\\).png)",
    "",
    "Between",
    "",
    "![][Hero   Image]",
    "",
    "![](./diagram\\(1\\).png)",
    "",
    "[hero image]: ../assets/hero.webp",
  ].join("\n"));

  assert.deepEqual(blocks, [
    { kind: "paragraph", runs: [{ text: "Before" }] },
    {
      kind: "image",
      index: 1,
      source: "./diagram(1).png",
      alt: "",
    },
    { kind: "paragraph", runs: [{ text: "Between" }] },
    {
      kind: "image",
      index: 2,
      source: "../assets/hero.webp",
      alt: "",
    },
    {
      kind: "image",
      index: 3,
      source: "./diagram(1).png",
      alt: "",
    },
  ]);
});

test("empty-alt reference images consume only their own definitions", () => {
  assert.deepEqual(
    parseXArticleBlocks([
      "![][first]",
      "",
      "![][second]",
      "",
      "[first]: ./first.png",
      "[second]: ./second.jpg",
    ].join("\n")),
    [
      {
        kind: "image",
        index: 1,
        source: "./first.png",
        alt: "",
      },
      {
        kind: "image",
        index: 2,
        source: "./second.jpg",
        alt: "",
      },
    ],
  );

  const unrelated = rejected(
    "![][id]\n\n[id]: ./used.png\n\n[unused]: ./used.png",
    "x_article_block_unsupported",
  );
  assert.match(unrelated.message, /def block/);
});

test("nonempty image alt text rejects instead of being silently discarded", () => {
  for (const body of [
    "![alt](./image.png)",
    "![alt][image]\n\n[image]: ./image.png",
    "![alt][]\n\n[alt]: ./image.png",
    "![alt]\n\n[alt]: ./image.png",
  ]) {
    const error = rejected(body, "x_article_image_unsupported");
    assert.match(String(error.problem.actual), /non-?empty.*image alt text/i);
  }
});

test("body images reject titles and empty, remote, or URL-backed destinations", () => {
  for (const body of [
    '![alt](./image.png "title")',
    '![alt](./image.png "")',
    '![alt](./image.png\n""\n)',
    "![alt][image]\n\n[image]: ./image.png 'title'",
    '![alt][image]\n\n[image]: ./image.png ""',
    "![alt]()",
    "![alt](http://example.test/image.png)",
    "![alt](HTTPS://example.test/image.png)",
    "![alt](data:image/png;base64,AAAA)",
    "![alt](blob:https://example.test/id)",
    "![alt](file:///private/tmp/image.png)",
    "![alt](//example.test/image.png)",
  ]) {
    rejected(body, "x_article_image_unsupported");
  }
});

test("mixed and nested image tokens remain outside the supported image-block subset", () => {
  for (const body of [
    "before ![](./image.png)",
    "![](./image.png) after",
    "# ![](./image.png)",
    "> ![](./image.png)",
    "- ![](./image.png)",
    "[![](./image.png)](https://example.test)",
  ]) {
    const error = rejected(body, "x_article_inline_unsupported");
    assert.match(error.message, /image inline/);
  }
});

test("fenced and fully escaped image-looking literals are never image assets", () => {
  const blocks = parseXArticleBlocks([
    "```text",
    "![fenced](./not-an-asset.png)",
    "```",
    "",
    "\\!\\[escaped\\]\\(./not-an-asset.png\\)",
  ].join("\n"));

  assert.deepEqual(blocks, [
    {
      kind: "code",
      index: 1,
      lang: "text",
      text: "![fenced](./not-an-asset.png)",
    },
    {
      kind: "paragraph",
      runs: [{ text: "![escaped](./not-an-asset.png)" }],
    },
  ]);
  assert.equal(blocks.some((block) => block.kind === "image"), false);
});

test("ambiguous duplicate reference definitions fail closed", () => {
  rejected(
    "![][same]\n\n[same]: ./one.png\n[same]: ./two.png",
  );
});

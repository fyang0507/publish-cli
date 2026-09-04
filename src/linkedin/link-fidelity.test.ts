import assert from "node:assert/strict";
import test from "node:test";
import { LocalValidationError } from "../capabilities/validation.js";
import { generatePost } from "./content.js";

function localErrorFor(markdown: string): LocalValidationError {
  try {
    generatePost(markdown);
  } catch (error) {
    assert.ok(error instanceof LocalValidationError);
    assert.equal(error.problem.phase, "local");
    return error;
  }
  assert.fail("expected LinkedIn Markdown conversion to fail locally");
}

test("LinkedIn renders inline and all resolved reference-link forms from parser evidence", () => {
  const post = generatePost([
    "Start [Inline label](https://example.com/inline).",
    "[Full label][full]",
    "[Collapsed][]",
    "[Shortcut]",
    "",
    "[full]: https://example.com/full",
    "[collapsed]: https://example.com/collapsed",
    "[shortcut]: https://example.com/shortcut",
  ].join("\n"));

  assert.equal(post.text, [
    "Start Inline label (https://example.com/inline).",
    "Full label (https://example.com/full)",
    "Collapsed (https://example.com/collapsed)",
    "Shortcut (https://example.com/shortcut)",
  ].join("\n"));
  assert.deepEqual(
    post.linkFlags.map(({ url, text }) => ({ url, text })),
    [
      { url: "https://example.com/inline", text: "Inline label" },
      { url: "https://example.com/full", text: "Full label" },
      { url: "https://example.com/collapsed", text: "Collapsed" },
      { url: "https://example.com/shortcut", text: "Shortcut" },
    ],
  );
  assert.equal(post.linkFlags.every((flag) => flag.note.includes("FIRST COMMENT")), true);
  assert.doesNotMatch(post.text, /\[[^\]]+\](?:\[[^\]]*\])?|^\[[^\]]+\]:/m);
});

test("LinkedIn removes definitions nested in lists and quotes without leaking their syntax", () => {
  const post = generatePost([
    "- [List label][list-ref]",
    "",
    "  [list-ref]: https://example.com/list",
    "",
    "> [Quote label][quote-ref]",
    ">",
    "> [quote-ref]: https://example.com/quote",
  ].join("\n"));

  assert.equal(
    post.text,
    "• List label (https://example.com/list)\n\nQuote label (https://example.com/quote)",
  );
  assert.deepEqual(
    post.linkFlags.map((flag) => flag.url),
    ["https://example.com/list", "https://example.com/quote"],
  );
  assert.doesNotMatch(post.text, /list-ref|quote-ref|^>/m);
});

test("LinkedIn normalizes autolinks and deduplicates matching rendered destinations", () => {
  const url = "https://example.com/path?q=1&x=2";
  const post = generatePost([
    `<${url}> ${url} [Inline](${url}) [Reference][same]`,
    "",
    `[same]: ${url}`,
  ].join("\n"));

  assert.equal(
    post.text,
    `${url} ${url} Inline (${url}) Reference (${url})`,
  );
  assert.equal(post.linkFlags.length, 1);
  assert.equal(post.linkFlags[0]?.url, url);
  assert.doesNotMatch(post.text, /https:\/\/[^\s]+>/);
  assert.doesNotMatch(post.linkFlags[0]?.url ?? "", />$/);
});

test("LinkedIn keeps escaped angle syntax literal without flagging its closing delimiter", () => {
  const url = "https://example.com/path";
  const post = generatePost("\\<" + url + ">");

  assert.equal(post.text, "<" + url + ">");
  assert.deepEqual(post.linkFlags.map((flag) => flag.url), [url]);
  assert.doesNotMatch(post.linkFlags[0]?.url ?? "", />$/);

  const encodedDelimiter = generatePost("https://example.com/%3E");
  assert.deepEqual(
    encodedDelimiter.linkFlags.map((flag) => flag.url),
    ["https://example.com/%3E"],
  );
});

test("LinkedIn Unicode bold never mutates a rendered link destination", () => {
  const url = "https://example.com/path";
  const post = generatePost(
    `**[Docs](${url})** and **<${url}>**`,
    { bold: true },
  );

  assert.equal(post.text, `𝐃𝐨𝐜𝐬 (${url}) and ${url}`);
  assert.deepEqual(
    post.linkFlags.map(({ url: href, text }) => ({ url: href, text })),
    [{ url, text: "Docs" }],
  );
  assert.doesNotMatch(post.text, /𝐡𝐭𝐭𝐩𝐬/);
});

test("LinkedIn decodes CommonMark character references before rendering and dedupe", () => {
  const url = "https://example.com/path?a=1&b=2";
  const post = generatePost(
    "&copy; &#169; &#x1F600; " +
      "[Encoded &amp; label](https://example.com/path?a=1&amp;b=2) " +
      url + " ![Alt &copy;](image&amp;one.png) " +
      "\x60&amp;\x60 &notanentity;",
  );

  assert.equal(
    post.text,
    "© © 😀 Encoded & label (" + url + ") " + url +
      " Alt © &amp; &notanentity;",
  );
  assert.deepEqual(
    post.linkFlags.map(({ url: href, text }) => ({ url: href, text })),
    [{ url, text: "Encoded & label" }],
  );
  assert.deepEqual(post.imageFlags, [
    { alt: "Alt ©", source: "image&one.png", sourceLine: 1 },
  ]);
});

test("LinkedIn normalizes escaped and Unicode link labels and image alt evidence", () => {
  const href = "https://例子.测试/路径";
  const post = generatePost(
    `See [你好\\] **bold** \`code\` \\!](${href}) and ` +
      "![图\\] **bold** `code` \\!](image\\(一\\).png).",
  );

  assert.equal(
    post.text,
    `See 你好] bold code ! (${href}) and 图] bold code !.`,
  );
  assert.deepEqual(
    post.linkFlags.map(({ url, text }) => ({ url, text })),
    [{ url: href, text: "你好] bold code !" }],
  );
  assert.deepEqual(post.imageFlags, [
    { alt: "图] bold code !", source: "image(一).png", sourceLine: 1 },
  ]);
  assert.doesNotMatch(post.text, /\\[\]!]|\*\*|`code`/);
});

test("LinkedIn image evidence keeps physical source lines across GFM table delimiters", () => {
  const post = generatePost([
    "| Header ![head](head.png) |",
    "| --- |",
    "| Body ![body](body.png) |",
  ].join("\n"));

  assert.deepEqual(post.imageFlags, [
    { alt: "head", source: "head.png", sourceLine: 1 },
    { alt: "body", source: "body.png", sourceLine: 3 },
  ]);
});

test("LinkedIn image alt projection never exposes a nested link destination", () => {
  const post = generatePost(
    "Before ![see [hidden](https://hidden.example)](image.png) after.",
  );

  assert.equal(post.text, "Before see hidden after.");
  assert.deepEqual(post.imageFlags, [
    { alt: "see hidden", source: "image.png", sourceLine: 1 },
  ]);
  assert.deepEqual(post.linkFlags, []);
  assert.doesNotMatch(post.text, /hidden\.example/);
});

test("LinkedIn treats code spans and fences as terminal false-positive controls", () => {
  const outside = "https://outside.example/path";
  const post = generatePost([
    "Literal `<span>[fake](https://code.example) ![fake](code.png)</span>` stays.",
    "",
    "```md",
    "[fenced](https://fence.example)",
    "![fenced](fenced.png)",
    "```",
    "",
    `[Outside](${outside})`,
  ].join("\n"));

  assert.match(
    post.text,
    /Literal <span>\[fake\]\(https:\/\/code\.example\) !\[fake\]\(code\.png\)<\/span> stays\./,
  );
  assert.doesNotMatch(post.text, /fence\.example|fenced\.png/);
  assert.deepEqual(post.linkFlags.map((flag) => flag.url), [outside]);
  assert.deepEqual(post.imageFlags, []);
});

test("LinkedIn preserves indented code and receipts nested fenced code", () => {
  const indented = generatePost(
    "    [literal](https://code.example) &amp; ![literal](code.png)",
  );
  assert.equal(
    indented.text,
    "    [literal](https://code.example) &amp; ![literal](code.png)",
  );
  assert.deepEqual(indented.codeFlags, []);
  assert.deepEqual(indented.linkFlags, []);
  assert.deepEqual(indented.imageFlags, []);

  const fence = "\x60\x60\x60";
  const nestedFence = generatePost([
    "Before",
    "",
    "> " + fence + "md",
    "> [hidden](https://hidden.example)",
    "> " + fence,
    "",
    "After",
  ].join("\n"));
  assert.equal(nestedFence.text.replace(/\n+/g, "\n"), "Before\nAfter");
  assert.deepEqual(nestedFence.codeFlags, [
    { index: 1, lang: "md", preview: "[hidden](https://hidden.example)", sourceLine: 3 },
  ]);
  assert.deepEqual(nestedFence.linkFlags, []);
});

test("LinkedIn preserves physical ordered-list markers that carry meaning", () => {
  const post = generatePost("3) third\n7) seventh");

  assert.equal(post.text, "3) third\n7) seventh");
});

test("LinkedIn rejects parser-confirmed inline and block HTML", () => {
  const cases = [
    "Before <span>inside</span> after",
    "<div>\n[not-a-link](https://inside.example)\n![not-an-image](inside.png)\n</div>",
  ];

  for (const markdown of cases) {
    const error = localErrorFor(markdown);
    assert.equal(error.problem.code, "linkedin_raw_html_unsupported");
    assert.match(error.message, /parser-confirmed raw HTML/i);
  }
});

test("LinkedIn empty-conversion errors name only the constructs that removed content", () => {
  const causeTerms = [
    "whitespace",
    "link reference definitions",
    "thematic breaks",
    "code blocks",
    "Markdown images",
  ] as const;
  const singleCauseCases = [
    { markdown: " \n\t", cause: "whitespace" },
    { markdown: "[unused]: https://example.com/unused", cause: "link reference definitions" },
    { markdown: "***", cause: "thematic breaks" },
    { markdown: "```text\nonly code\n```", cause: "code blocks" },
    { markdown: "![only image](only.png)", cause: "Markdown images" },
  ] as const;

  for (const { markdown, cause } of singleCauseCases) {
    const error = localErrorFor(markdown);
    assert.equal(error.problem.code, "linkedin_text_empty_after_conversion");
    assert.match(error.message, new RegExp(cause, "i"));
    for (const absent of causeTerms.filter((term) => term !== cause)) {
      assert.doesNotMatch(error.message, new RegExp(absent, "i"));
    }
  }

  const mixed = localErrorFor([
    "[unused]: https://example.com/unused",
    "",
    "***",
    "",
    "```text",
    "only code",
    "```",
    "",
    "![only image](only.png)",
  ].join("\n"));
  assert.equal(mixed.problem.code, "linkedin_text_empty_after_conversion");
  for (const cause of causeTerms.slice(1)) {
    assert.match(mixed.message, new RegExp(cause, "i"));
  }
  assert.doesNotMatch(mixed.message, /whitespace/i);
});

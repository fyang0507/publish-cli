import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveContentInputDetails,
  splitLeadingFrontmatter,
} from "../commands/contentInput.js";
import { generatePost } from "../linkedin/content.js";
import { generateArticle } from "../wechat/content.js";
import {
  REDDIT_BODY_LIMIT,
  REDDIT_TITLE_LIMIT,
  generateSelfPost,
} from "../reddit/content.js";
import { generateContent, renderForInspection } from "../x/content.js";
import { LocalValidationError, extractTweetId } from "./validation.js";

function expectLocalProblem(
  action: () => unknown,
  expected: { code: string; actual?: string | number | null; unit?: string | null },
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LocalValidationError);
    assert.equal(error.problem.phase, "local");
    assert.equal(error.problem.code, expected.code);
    if ("actual" in expected) assert.equal(error.problem.actual, expected.actual);
    if ("unit" in expected) assert.equal(error.problem.unit, expected.unit);
    assert.ok(error.problem.expected);
    return true;
  });
}

test("X single-post boundaries reject overflow without returning a partial tweet", async () => {
  const standard = await generateContent("a".repeat(280), { format: "tweet" });
  assert.equal(standard.tweet?.text, "a".repeat(280));
  assert.equal(standard.tweet?.chars, 280);

  await assert.rejects(
    generateContent("a".repeat(281), { format: "tweet" }),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.deepEqual(error.problem, {
        phase: "local",
        code: "x_text_too_long",
        field: "text",
        actual: 281,
        expected: "<= 280",
        unit: "twitter_text_weighted",
      });
      return true;
    },
  );

  const premium = await generateContent("😀".repeat(25_000), {
    format: "tweet",
    long: true,
  });
  assert.equal(premium.tweet?.text, "😀".repeat(25_000));
  assert.equal(premium.tweet?.chars, 25_000);
  await assert.rejects(
    generateContent("😀".repeat(25_001), { format: "tweet", long: true }),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.equal(error.problem.code, "x_text_too_long");
      assert.equal(error.problem.actual, 25_001);
      assert.equal(error.problem.unit, "unicode_code_points_transport_policy");
      return true;
    },
  );
});

test("X thread numbering grows beyond 999 posts without losing source text", async () => {
  const paragraphs = Array.from(
    { length: 1001 },
    (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(265)}`,
  );
  const source = paragraphs.join("\n\n");
  const generated = await generateContent(source, { format: "thread" });
  const posts = generated.thread ?? [];
  assert.ok(posts.length > 999);
  assert.ok(posts.every((post) => post.chars <= 280));
  assert.ok(posts.at(-1)?.text.endsWith(` ${posts.length}/${posts.length}`));
  const reconstructed = posts
    .map((post) => post.text.replace(/ \d+\/\d+$/, ""))
    .join("");
  assert.equal(reconstructed, source);
});

test("X thread and reply-thread transport preserve exact internal whitespace", async () => {
  const source = `${"A  B\nC\n\n\nD\t\tE ".repeat(30)}tail`;
  const generated = await generateContent(source, { format: "thread" });
  const posts = generated.thread ?? [];
  assert.ok(posts.length > 1);
  assert.equal(
    posts.map((post) => post.text.replace(/ \d+\/\d+$/, "")).join(""),
    source,
  );
});

test("X file-backed mapping frontmatter normalizes before every format without losing source accounting", async () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const source =
      `\ufeff---${newline}` +
      `title: Ignored metadata title${newline}` +
      `private: workflow-only${newline}` +
      `---${newline}` +
      `Visible body${newline}`;
    const split = splitLeadingFrontmatter(source, "x.md", {
      policy: "mapping-only",
      preserveBodyLineEndings: true,
    });
    assert.equal(split.body, `Visible body${newline}`);
    assert.deepEqual(split.data, {
      title: "Ignored metadata title",
      private: "workflow-only",
    });
    assert.equal(split.bodyLineOffset, 4);

    const tweet = await generateContent(split.body, {
      format: "tweet",
      sourceLineOffset: split.bodyLineOffset,
    });
    assert.equal(tweet.tweet?.text, "Visible body");
  }

  for (const empty of [
    "---\n---\nEmpty body",
    "---\r\n{}\r\n---\r\nEmpty body",
    "---\r# comment-only metadata\r---\rEmpty body",
  ]) {
    const split = splitLeadingFrontmatter(empty, "x.md", {
      policy: "mapping-only",
      preserveBodyLineEndings: true,
    });
    assert.equal(split.present, true);
    assert.deepEqual(split.data, {});
    assert.equal((await generateContent(split.body, { format: "tweet" })).tweet?.text, "Empty body");
  }

  const articleInput = splitLeadingFrontmatter(
    "\ufeff---\rtitle: Never the X headline\rworkflow: private\r---\r# Body headline\r\rArticle body",
    "article.md",
    { policy: "mapping-only", preserveBodyLineEndings: true },
  );
  const article = await generateContent(articleInput.body, {
    format: "article",
    sourceLineOffset: articleInput.bodyLineOffset,
  });
  assert.equal(article.article?.title, "Body headline");
  assert.equal(article.article?.markdown, "# Body headline\n\nArticle body");
  assert.doesNotMatch(JSON.stringify(article), /Never the X headline|workflow: private/);

  const offsetInput = splitLeadingFrontmatter(
    "---\nsecret: hidden\n---\n# Visible title\n\n```js\nrun()\n```\n" +
      "## Visible section\nDraft: v1\n![diagram](diagram.png)\nBody",
    "offset.md",
    { policy: "mapping-only", preserveBodyLineEndings: true },
  );
  const offset = await generateContent(offsetInput.body, {
    format: "thread",
    sourceLineOffset: offsetInput.bodyLineOffset,
  });
  assert.equal(offset.fidelityFlags[0]?.sourceLine, 4);
  assert.equal(offset.codeFlags[0]?.sourceLine, 6);
  assert.deepEqual(
    offset.fidelityFlags.map(({ kind, sourceLine }) => ({ kind, sourceLine })),
    [
      { kind: "title_heading", sourceLine: 4 },
      { kind: "section_heading", sourceLine: 9 },
      { kind: "metadata_like", sourceLine: 10 },
      { kind: "markdown_image", sourceLine: 11 },
    ],
  );
});

test("X mapping-only ambiguity preserves thematic source bytes through the shared seam", async () => {
  const ordinaryMarkdown = [
    "\ufeff---\nfalse\n---\nScalar body",
    "\ufeff---\r\n- first\r\n- second\r\n---\r\nSequence body",
    "\ufeff---\r\rA thematic section\r\r---\r\rMore prose",
    "\ufeff---\nKey:value prose\n---\nColon scalar body",
  ];
  for (const source of ordinaryMarkdown) {
    const split = splitLeadingFrontmatter(source, "x.md", {
      policy: "mapping-only",
      preserveBodyLineEndings: true,
    });
    assert.deepEqual(split, {
      body: source.slice(1),
      data: {},
      present: false,
      bodyLineOffset: 0,
    });
  }

  const losslessBody = `${"A  B\r\nC\r\n\r\n\r\nD\t\tE ".repeat(30)}tail`;
  const lossless = splitLeadingFrontmatter(
    `---\r\ntransport: ignored\r\n---\r\n${losslessBody}`,
    "thread.md",
    { policy: "mapping-only", preserveBodyLineEndings: true },
  );
  assert.equal(lossless.body, losslessBody);
  const thread = await generateContent(lossless.body, {
    format: "thread",
    sourceLineOffset: lossless.bodyLineOffset,
  });
  assert.equal(
    (thread.thread ?? []).map((post) => post.text.replace(/ \d+\/\d+$/, "")).join(""),
    losslessBody.replace(/\r\n?/g, "\n"),
    "thread/reply-thread packing loses no bytes after X's pre-existing line-ending normalization",
  );

  const exact = splitLeadingFrontmatter(
    `---\nignored: ${"z".repeat(600)}\n---\n${"汉".repeat(140)}`,
    "weighted.md",
    { policy: "mapping-only", preserveBodyLineEndings: true },
  );
  assert.equal((await generateContent(exact.body, { format: "tweet" })).tweet?.chars, 280);

  const overflow = splitLeadingFrontmatter(
    `---\nignored: ${"z".repeat(600)}\n---\n${"汉".repeat(141)}`,
    "weighted.md",
    { policy: "mapping-only", preserveBodyLineEndings: true },
  );
  await assert.rejects(
    generateContent(overflow.body, { format: "tweet" }),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.equal(error.problem.code, "x_text_too_long");
      assert.equal(error.problem.actual, 282);
      assert.equal(error.problem.expected, "<= 280");
      return true;
    },
  );
});

test("X surfaces every heuristic prose omission with exact fidelity evidence", async () => {
  const source = [
    "# Launch notes",
    "",
    "Update: we shipped the parser today.",
    "",
    "## What changed",
    "",
    "![diagram](./diagram.png)",
    "",
    "The transported body remains intact.",
  ].join("\n");
  const generated = await generateContent(source, { format: "thread" });

  assert.deepEqual(
    generated.fidelityFlags.map(({ kind, sourceLine, source: sourceText }) => ({
      kind,
      sourceLine,
      source: sourceText,
    })),
    [
      { kind: "title_heading", sourceLine: 1, source: "# Launch notes" },
      { kind: "metadata_like", sourceLine: 3, source: "Update: we shipped the parser today." },
      { kind: "section_heading", sourceLine: 5, source: "## What changed" },
      { kind: "markdown_image", sourceLine: 7, source: "![diagram](./diagram.png)" },
    ],
  );
  assert.equal(generated.warnings.length, generated.fidelityFlags.length);
  const inspection = renderForInspection(generated);
  for (const flag of generated.fidelityFlags) {
    assert.match(inspection, new RegExp(`line ${flag.sourceLine}`));
    assert.match(inspection, new RegExp(flag.kind));
    assert.match(inspection, new RegExp(flag.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(
    (generated.thread ?? []).map((post) => post.text.replace(/ \d+\/\d+$/, "")).join(""),
    "The transported body remains intact.",
  );

  const article = await generateContent(source, { format: "article" });
  assert.deepEqual(
    article.fidelityFlags,
    [],
    "tweet/thread omission receipts do not claim X Article image fidelity; issue #5 owns that transport path",
  );
  assert.match(article.article?.markdown ?? "", /!\[diagram\]\(\.\/diagram\.png\)/);
  assert.doesNotMatch(
    JSON.stringify(article.article?.blocks ?? []),
    /diagram\.png/,
    "raw inspection Markdown retains the reference, but Article blocks do not transport it (issue #5)",
  );
  assert.ok(article.warnings.every((warning) => !/was omitted/.test(warning)));

  await assert.rejects(
    generateContent("# Only omitted title", { format: "tweet" }),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.equal(error.problem.code, "x_text_empty");
      assert.match(error.message, /Source fidelity evidence/);
      assert.match(error.message, /line 1 \[title_heading\].*# Only omitted title/);
      return true;
    },
  );
});

test("X rejects a grapheme that cannot fit losslessly in a numbered thread post", async () => {
  const indivisible = `a${"\u0301".repeat(300)}`;
  await assert.rejects(
    generateContent(indivisible, { format: "thread" }),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.equal(error.problem.phase, "local");
      assert.equal(error.problem.code, "x_grapheme_exceeds_thread_budget");
      assert.equal(error.problem.actual, 300);
      assert.equal(error.problem.expected, "<= 272");
      assert.equal(error.problem.unit, "twitter_text_weighted");
      return true;
    },
  );
});

test("X reply target parsing keeps the existing raw/status/statuses grammar", () => {
  assert.equal(extractTweetId("12345"), "12345");
  assert.equal(extractTweetId("https://x.com/user/status/1234567890?s=20"), "1234567890");
  assert.equal(extractTweetId("https://twitter.com/user/statuses/123456789012345"), "123456789012345");
  assert.equal(extractTweetId("prefix 1234567890 suffix"), "1234567890");
  expectLocalProblem(() => extractTweetId("1234"), {
    code: "x_invalid_reply_target",
    actual: "1234",
    unit: null,
  });
});

test("LinkedIn rejects empty/overflow conversion and surfaces real Markdown images only", () => {
  expectLocalProblem(() => generatePost("```js\nalert(1)\n```\n\n![only](only.png)"), {
    code: "linkedin_text_empty_after_conversion",
    actual: 0,
    unit: "utf16_code_units",
  });

  const exact = generatePost("😀".repeat(1500));
  assert.equal(exact.text, "😀".repeat(1500));
  assert.equal(exact.chars, 3000);
  expectLocalProblem(() => generatePost("😀".repeat(1501)), {
    code: "linkedin_text_too_long",
    actual: 3002,
    unit: "utf16_code_units",
  });

  const source = [
    "A useful opening",
    "",
    "![diagram](./diagram.png \"title\")",
    "Inline ![chart](<./chart file.webp>) detail.",
    "![remote](https://example.com/remote.png)",
    "![angle-only](<./angle only.png> 'caption')",
    "Inline code: `![literal](inside-inline-code.png)`.",
    "Escaped: \\![literal](escaped.png).",
    "Balanced: ![balanced](diagram(1).png) end.",
    "Escaped destination: ![escaped-paren](diagram\\(2\\).png) end.",
    "```md",
    "![literal](inside-code.png)",
    "```",
  ].join("\n");
  const post = generatePost(source);
  assert.deepEqual(post.imageFlags, [
    { alt: "diagram", source: "./diagram.png", sourceLine: 3 },
    { alt: "chart", source: "./chart file.webp", sourceLine: 4 },
    { alt: "remote", source: "https://example.com/remote.png", sourceLine: 5 },
    { alt: "angle-only", source: "./angle only.png", sourceLine: 6 },
    { alt: "balanced", source: "diagram(1).png", sourceLine: 9 },
    { alt: "escaped-paren", source: "diagram(2).png", sourceLine: 10 },
  ]);
  assert.doesNotMatch(post.text, /inside-code\.png|angle-only/);
  assert.match(post.text, /Inline code: !\[literal\]\(inside-inline-code\.png\)\./);
  assert.match(post.text, /Escaped: !\[literal\]\(escaped\.png\)\./);
  assert.match(post.text, /Balanced: balanced end\./);
  assert.match(post.text, /Escaped destination: escaped-paren end\./);
  assert.match(post.text, /Inline chart detail\./);
  assert.equal(post.linkFlags.length, 0, "image URLs must not be reported as body links");
});

test("LinkedIn uses CommonMark image parsing without code/escape false positives", () => {
  const source = [
    "Opening 😀 before ![inline](inline.png).",
    "Reference ![ref-alt][img].",
    "Collapsed ![collapsed][].",
    "Shortcut ![shortcut].",
    "Nested ![nest](diagram(one(two)).png) end.",
    "Escaped alt ![a\\]b](escaped-alt.png) end.",
    "Multiline ![multi](",
    "  <./multi file.png>",
    "  \"title\"",
    ") end.",
    "Odd escape: \\![literal](odd.png).",
    "Even escape: \\\\![active](even.png).",
    "Inline code: `![code](code.png)`.",
    "```md",
    "![fenced](fenced.png)",
    "```",
    "![only][only]",
    "",
    "[img]: ./ref.png \"reference\"",
    "[collapsed]: ./collapsed.png",
    "[shortcut]: ./shortcut.png",
    "[only]: ./only.png",
  ].join("\n");

  const post = generatePost(source);
  assert.deepEqual(
    post.imageFlags.map(({ alt, source: imageSource }) => [alt, imageSource]),
    [
      ["inline", "inline.png"],
      ["ref-alt", "./ref.png"],
      ["collapsed", "./collapsed.png"],
      ["shortcut", "./shortcut.png"],
      ["nest", "diagram(one(two)).png"],
      ["a]b", "escaped-alt.png"],
      ["multi", "./multi file.png"],
      ["active", "even.png"],
      ["only", "./only.png"],
    ],
  );
  assert.deepEqual(
    post.imageFlags.map((flag) => flag.sourceLine),
    [1, 2, 3, 4, 5, 6, 7, 12, 17],
  );
  assert.match(post.text, /Odd escape: !\[literal\]\(odd\.png\)\./);
  assert.match(post.text, /Inline code: !\[code\]\(code\.png\)\./);
  assert.doesNotMatch(post.text, /fenced\.png|\[img\]:|\[collapsed\]:|\[shortcut\]:|\[only\]:/);
  assert.doesNotMatch(post.text, /!\[only\]|only\.png/);
  assert.equal(post.linkFlags.length, 0);
});

test("LinkedIn locates parent images before child code and escape tokens", () => {
  expectLocalProblem(() => generatePost("![`run()` flow](flow.png)"), {
    code: "linkedin_text_empty_after_conversion",
    actual: 0,
    unit: "utf16_code_units",
  });

  const post = generatePost(
    "Before ![`run()` flow](flow.png) and ![a \\! bang](bang.png) after.",
  );
  assert.equal(post.text, "Before run() flow and a ! bang after.");
  assert.deepEqual(
    post.imageFlags.map(({ alt, source }) => ({ alt, source })),
    [
      { alt: "`run()` flow", source: "flow.png" },
      { alt: "a \\! bang", source: "bang.png" },
    ],
  );

  const duplicateLiteral = generatePost(
    "`![same](same.png)` then ![same](same.png)",
  );
  assert.equal(duplicateLiteral.text, "![same](same.png) then same");
  assert.deepEqual(duplicateLiteral.imageFlags, [
    { alt: "same", source: "same.png", sourceLine: 1 },
  ]);

  const htmlLiteral = generatePost(
    "Opening\n\n<div>\n![literal](inside-html.png)\n</div>\n\nClosing",
  );
  assert.deepEqual(htmlLiteral.imageFlags, [], "image-looking text in an HTML block is not media");
});

test("LinkedIn surfaces resolved reference-link destinations before definitions are removed", () => {
  const post = generatePost(
    "Check [the docs][reference] before launch.\n\n[reference]: https://example.com/docs\n",
  );
  assert.equal(post.text, "Check [the docs][reference] before launch.");
  assert.deepEqual(
    post.linkFlags.map(({ url, text }) => ({ url, text })),
    [{ url: "https://example.com/docs", text: "the docs" }],
  );
  assert.match(post.linkFlags[0]?.note ?? "", /FIRST COMMENT/);

  const unusedDefinition = generatePost(
    "Body remains.\n\n[unused]: https://example.com/non-rendering-metadata",
  );
  assert.equal(unusedDefinition.text, "Body remains.");
  assert.deepEqual(
    unusedDefinition.linkFlags,
    [],
    "unused CommonMark definitions are non-rendering metadata, not body-link advisories",
  );
});

test("LinkedIn frontmatter offsets keep code and image lines tied to the original source", () => {
  const split = splitLeadingFrontmatter(
    "---\ntitle: Hidden\nowner: operator\n---\nOpening\n\n\n![asset](asset.png)\n\n```js\nrun()\n```\n",
    "post.md",
  );
  assert.equal(split.bodyLineOffset, 4);
  const post = generatePost(split.body, { sourceLineOffset: split.bodyLineOffset });
  assert.deepEqual(post.imageFlags, [
    { alt: "asset", source: "asset.png", sourceLine: 8 },
  ]);
  assert.deepEqual(
    post.codeFlags.map(({ sourceLine, lang }) => ({ sourceLine, lang })),
    [{ sourceLine: 10, lang: "js" }],
  );
});

test("LinkedIn rejects caller NUL bytes instead of colliding with inline-code sentinels", () => {
  expectLocalProblem(() => generatePost("before \u00000\u0000 after"), {
    code: "linkedin_nul_not_supported",
    actual: 2,
    unit: "occurrences",
  });
  expectLocalProblem(() => generatePost("x `code` y \u00000\u0000 z"), {
    code: "linkedin_nul_not_supported",
    actual: 2,
    unit: "occurrences",
  });
});

test("LinkedIn normalizes lone CR before CommonMark offsets and source-line evidence", () => {
  const post = generatePost("```\r![code](code.png)\r```\r\rReal ![real](real.png) here\r");
  assert.equal(post.text, "Real real here");
  assert.deepEqual(post.imageFlags, [
    { alt: "real", source: "real.png", sourceLine: 5 },
  ]);
  assert.equal(post.codeFlags.length, 1);
  assert.doesNotMatch(post.text, /\r|code\.png|!\[real\]/);
});

test("LinkedIn rejects unverified media-only content after Markdown-image removal", () => {
  expectLocalProblem(() => generatePost("![shot](shot.png)"), {
    code: "linkedin_text_empty_after_conversion",
    actual: 0,
    unit: "utf16_code_units",
  });
});

test("LinkedIn image-only removal preserves caller gaps without inflating symmetric blanks", () => {
  const cases = [
    ["A\n![x](y.png)\nB", "A\nB"],
    ["A\n\n![x](y.png)\nB", "A\n\nB"],
    ["A\n![x](y.png)\n\nB", "A\n\nB"],
    ["A\n\n![x](y.png)\n\nB", "A\n\nB"],
    ["![x](y.png)\n\nB", "B"],
    ["A\n\n![x](y.png)", "A"],
    ["A\n\n![one](1.png)\n\n![two](2.png)\n\nB", "A\n\nB"],
    ["A\n![one](1.png)\n![two](2.png)\nB", "A\nB"],
  ] as const;
  for (const [source, expected] of cases) {
    assert.equal(generatePost(source).text, expected, JSON.stringify(source));
  }
});

test("Reddit body/title boundaries use Unicode code points and never shorten", () => {
  const exactBodies = [
    "a".repeat(REDDIT_BODY_LIMIT),
    "汉".repeat(REDDIT_BODY_LIMIT),
    "😀".repeat(REDDIT_BODY_LIMIT),
    "e\u0301".repeat(REDDIT_BODY_LIMIT / 2),
    `${"👨‍👩‍👧‍👦".repeat(5714)}ab`,
  ];
  for (const body of exactBodies) {
    const post = generateSelfPost(body, { title: "Title" });
    assert.equal(post.body, body);
    assert.equal(post.bodyChars, REDDIT_BODY_LIMIT);
    expectLocalProblem(() => generateSelfPost(`${body}x`, { title: "Title" }), {
      code: "reddit_body_too_long",
      actual: REDDIT_BODY_LIMIT + 1,
      unit: "unicode_code_points_transport_policy",
    });
  }

  const exactTitle = "😀".repeat(REDDIT_TITLE_LIMIT);
  assert.equal(generateSelfPost("body", { title: exactTitle }).title, exactTitle);
  expectLocalProblem(() => generateSelfPost("body", { title: `${exactTitle}x` }), {
    code: "reddit_title_too_long",
    actual: REDDIT_TITLE_LIMIT + 1,
    unit: "unicode_code_points_transport_policy",
  });
});

test("file-backed frontmatter is mapping-only while no-frontmatter bytes remain intact", () => {
  assert.deepEqual(splitLeadingFrontmatter("---\ntitle: Hello\ncount: 2\n---\nBody\n", "post.md"), {
    body: "Body\n",
    data: { title: "Hello", count: 2 },
    present: true,
    bodyLineOffset: 4,
  });
  assert.deepEqual(splitLeadingFrontmatter("\ufeffLiteral\n", "post.md"), {
    body: "Literal\n",
    data: {},
    present: false,
    bodyLineOffset: 0,
  });
  for (const newline of ["\n", "\r\n", "\r"]) {
    const bom = newline === "\r\n" ? "\ufeff" : "";
    assert.deepEqual(
      splitLeadingFrontmatter(
        `${bom}---${newline}title: Hidden${newline}---${newline}Body${newline}`,
        "post.md",
      ),
      { body: "Body\n", data: { title: "Hidden" }, present: true, bodyLineOffset: 3 },
    );
    assert.deepEqual(
      splitLeadingFrontmatter(`${bom}---${newline}---${newline}Body${newline}`, "post.md"),
      { body: "Body\n", data: {}, present: true, bodyLineOffset: 2 },
    );
  }
  assert.deepEqual(splitLeadingFrontmatter("---\n  \n# comment only\n---\nBody", "post.md"), {
    body: "Body",
    data: {},
    present: true,
    bodyLineOffset: 4,
  });
  expectLocalProblem(
    () => splitLeadingFrontmatter("---\ntitle: [broken\n---\nBody", "post.md"),
    { code: "malformed_frontmatter", actual: "malformed_yaml", unit: null },
  );
  expectLocalProblem(
    () => splitLeadingFrontmatter("---\ntitle: Leaks\nowner: operator\nBody", "post.md"),
    { code: "unterminated_frontmatter", actual: "missing_closing_delimiter", unit: null },
  );
  expectLocalProblem(
    () => splitLeadingFrontmatter("---\n- item\n---\nBody", "post.md"),
    { code: "invalid_frontmatter_shape", actual: "sequence", unit: null },
  );
  expectLocalProblem(
    () => splitLeadingFrontmatter("---\nfalse\n---\nBody", "post.md"),
    { code: "invalid_frontmatter_shape", actual: "boolean: false", unit: null },
  );
  // File/stdin input reserves a leading delimiter for frontmatter. Treating a
  // valid YAML scalar as ordinary Markdown would make intended metadata leak
  // into a staged draft, so the strict policy deterministically rejects it.
  expectLocalProblem(
    () => splitLeadingFrontmatter("---\n\nA new section\n\n---\n\nMore\n", "post.md"),
    { code: "invalid_frontmatter_shape", unit: null },
  );
});

test("shared content-source failures use structured local validation", () => {
  expectLocalProblem(() => resolveContentInputDetails({}), {
    code: "content_source_missing",
    actual: "neither --text nor --from",
    unit: null,
  });
  expectLocalProblem(
    () => resolveContentInputDetails({ text: "body", from: "post.md" }),
    { code: "content_source_conflict", actual: "both --text and --from", unit: null },
  );
  expectLocalProblem(() => resolveContentInputDetails({ text: "  \n" }), {
    code: "content_text_empty",
    actual: 0,
    unit: null,
  });

  const dir = mkdtempSync(join(tmpdir(), "publish-content-source-"));
  try {
    expectLocalProblem(() => resolveContentInputDetails({ from: dir }), {
      code: "content_source_not_regular_file",
      actual: "non-file",
      unit: null,
    });
    expectLocalProblem(() => resolveContentInputDetails({ from: join(dir, "missing.md") }), {
      code: "content_source_not_found",
      actual: "missing",
      unit: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WeChat required title and cover failures use structured local validation", () => {
  expectLocalProblem(() => generateArticle("Body without H1", { cover: "unused.png" }), {
    code: "wechat_title_missing",
    actual: null,
    unit: null,
  });
  expectLocalProblem(() => generateArticle("# Title\n\nBody"), {
    code: "wechat_cover_missing",
    actual: null,
    unit: null,
  });
});

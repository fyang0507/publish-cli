import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Locator, Page } from "playwright";
import { LocalValidationError } from "../capabilities/validation.js";
import { splitLeadingFrontmatter } from "../commands/contentInput.js";
import { snapshotXArticleStageInput } from "./articleStageSnapshot.js";
import {
  generateContent,
  mapHeadingLevel,
  parseInlineRuns,
  type GeneratedContent,
} from "./content.js";
import {
  stageArticleDraft,
  type ArticleDraftStageDependencies,
} from "./draftPoster.js";

// Construct tilde fences so the public-content scanner does not interpret
// Markdown test literals as shell home-directory spellings.
const TILDE_FENCE = "~".repeat(3);

async function rejectedArticle(
  source: string,
  expectedCode?: string,
  sourceLineOffset = 0,
): Promise<LocalValidationError> {
  try {
    await generateContent(source, { format: "article", sourceLineOffset });
  } catch (error) {
    assert.ok(error instanceof LocalValidationError);
    if (expectedCode) assert.equal(error.problem.code, expectedCode);
    assert.equal(error.problem.phase, "local");
    assert.match(error.message, /no artifact or native draft was created/i);
    assert.ok(error.message.length < 1_000, "local evidence stays bounded");
    return error;
  }
  assert.fail("expected Article Markdown to reject locally");
}

test("canonical Markdown, title, blocks, advisories, and staged inputs share one representation", async () => {
  const source = [
    "# Real Title",
    "",
    "# Section",
    "",
    "## Detail",
    "",
    "Plain **bold** and *italic* plus [plain **bold** tail](https://example.com/a_(b)?q=x%20y).",
    "",
    "> Quote",
    "",
    "1. One",
    "2. Two",
  ].join("\r\n");
  const canonical = source.replace(/\r\n/gu, "\n");
  const content = await generateContent(source, { format: "article" });
  assert.equal(content.article?.title, "Real Title");
  assert.equal(content.article?.markdown, canonical);
  assert.deepEqual(content.article?.blocks.slice(0, 2), [
    { kind: "heading", level: 1, runs: [{ text: "Section" }] },
    { kind: "heading", level: 2, runs: [{ text: "Detail" }] },
  ]);
  assert.deepEqual(content.linkFlags, [{
    url: "https://example.com/a_(b)?q=x%20y",
    text: "plain bold tail",
    note: "Links cost reach — keep this OUT of the opening tweet; move it to a reply or the end of the thread.",
  }]);

  const snapshot = snapshotXArticleStageInput(content, "article");
  assert.equal(snapshot.markdown, canonical);
  assert.equal(snapshot.title, "Real Title");
  assert.equal(snapshot.codeBlockCount, 0);
  assert.equal(
    snapshot.html,
    '<h1>Section</h1>\n<h2>Detail</h2>\n' +
      '<p>Plain <strong>bold</strong> and <em>italic</em> plus ' +
      '<a href="https://example.com/a_(b)?q=x%20y">plain </a>' +
      '<a href="https://example.com/a_(b)?q=x%20y"><strong>bold</strong></a>' +
      '<a href="https://example.com/a_(b)?q=x%20y"> tail</a>.</p>\n' +
      '<blockquote>Quote</blockquote>\n<ol><li>One</li><li>Two</li></ol>',
  );
  assert.equal(
    snapshot.plain,
    "Section\n\nDetail\n\nPlain bold and italic plus plain bold tail.\n\nQuote\n\nOne\n\nTwo",
  );
});

test("plain first-line titles preserve the documented immediate-body boundary", async () => {
  const source = "Plain title\nBody immediately follows\nwith a soft break";
  const content = await generateContent(source, { format: "article" });
  assert.equal(content.article?.title, "Plain title");
  assert.equal(content.article?.markdown, source);
  assert.deepEqual(content.article?.blocks, [{
    kind: "paragraph",
    runs: [{ text: "Body immediately follows with a soft break" }],
  }]);

  const escapedTitle = await generateContent("\\*Literal\\* title\nBody", {
    format: "article",
  });
  assert.equal(escapedTitle.article?.title, "*Literal* title");
  assert.equal(escapedTitle.article?.markdown, "\\*Literal\\* title\nBody");

  const literal = await generateContent(
    "Literal title\nfoo_bar_baz, unmatched *marker, \\*escaped\\*, `` short, and \\``` escaped",
    { format: "article" },
  );
  assert.equal(literal.article?.blocks[0]?.kind, "paragraph");
  assert.equal(
    literal.article?.blocks[0]?.kind === "paragraph"
      ? literal.article.blocks[0].runs.map((run) => run.text).join("")
      : "",
    "foo_bar_baz, unmatched *marker, *escaped*, `` short, and ``` escaped",
  );

  const literalCheckboxAndEntity = await generateContent(
    "Literal title\n- [x] task-like text\n- \\&amp; stays literal",
    { format: "article" },
  );
  assert.deepEqual(literalCheckboxAndEntity.article?.blocks, [
    { kind: "bullet", runs: [{ text: "[x] task-like text" }] },
    { kind: "bullet", runs: [{ text: "&amp; stays literal" }] },
  ]);
});

test("strict top-level fences preserve explicit and EOF payload while pseudo-closers stay payload", async () => {
  const source = [
    "# Fence matrix",
    "",
    "```bad`info",
    "literal invalid opener",
    "",
    "````js",
    "alpha",
    "```",
    TILDE_FENCE,
    "```` trailing text",
    "````",
    "",
    `${TILDE_FENCE}txt`,
    "omega  ",
    "  ",
  ].join("\n");
  const content = await generateContent(source, { format: "article" });
  assert.equal(content.article?.markdown, source);
  assert.equal(content.article?.codeBlockCount, 2);
  assert.deepEqual(
    content.article?.blocks.filter((block) => block.kind === "code"),
    [
      {
        kind: "code",
        index: 1,
        lang: "js",
        text: ["alpha", "```", TILDE_FENCE, "```` trailing text"].join("\n"),
      },
      { kind: "code", index: 2, lang: "txt", text: "omega  \n  " },
    ],
  );
  assert.deepEqual(
    content.codeFlags.map(({ index, lang, sourceLine }) => ({ index, lang, sourceLine })),
    [
      { index: 1, lang: "js", sourceLine: 6 },
      { index: 2, lang: "txt", sourceLine: 13 },
    ],
  );
  assert.equal(
    content.article?.blocks[0]?.kind === "paragraph"
      ? content.article.blocks[0].runs.map((run) => run.text).join("")
      : "",
    "```bad`info literal invalid opener",
  );

  const invalidInfoWithInlineSemantics = await rejectedArticle(
    "# Invalid info\n\n```bad`info\npayload\n```",
    "x_article_inline_unsupported",
  );
  assert.match(invalidInfoWithInlineSemantics.message, /inline_code inline/);

  const explicitTilde = await generateContent(
    `# Explicit tilde\n\n${TILDE_FENCE}py\nprint('exact')\n${TILDE_FENCE}\n`,
    { format: "article" },
  );
  assert.deepEqual(
    explicitTilde.article?.blocks.filter((block) => block.kind === "code"),
    [{ kind: "code", index: 1, lang: "py", text: "print('exact')" }],
  );
  const tildeSnapshot = snapshotXArticleStageInput(explicitTilde, "article");
  assert.equal(tildeSnapshot.codeBlockCount, 1);
  assert.equal(tildeSnapshot.receiptCodeBlockCount, 1);
  assert.equal(tildeSnapshot.html, "");
  assert.equal(tildeSnapshot.plain, "");
});

test("backtick and tilde fence info trim only CommonMark ASCII space and tab", async () => {
  const expectedInfo = "\u00a0language\u00a0";
  for (const marker of ["```", TILDE_FENCE]) {
    const source = `# Info edge\n\n${marker}\t${expectedInfo} \t\ncode\n${marker}`;
    const content = await generateContent(source, { format: "article" });
    assert.deepEqual(
      content.article?.blocks.filter((block) => block.kind === "code"),
      [{ kind: "code", index: 1, lang: expectedInfo, text: "code" }],
    );
    assert.equal(content.codeFlags[0]?.lang, expectedInfo);
    const snapshot = snapshotXArticleStageInput(content, "article");
    assert.equal(
      snapshot.content.article?.blocks.find((block) => block.kind === "code")?.lang,
      expectedInfo,
    );
  }
});

test("ambiguous tab indentation under space-indented fences rejects on its exact line", async () => {
  for (const marker of ["```", TILDE_FENCE]) {
    for (let indent = 1; indent <= 3; indent += 1) {
      for (const closure of ["explicit", "eof"] as const) {
        for (let leadingSpaces = 0; leadingSpaces < indent; leadingSpaces += 1) {
          const source = [
            "# Tab indentation",
            "",
            `${" ".repeat(indent)}${marker}js`,
            `${" ".repeat(leadingSpaces)}\tRAW_TAB_CANARY`,
            ...(closure === "explicit" ? [`${" ".repeat(indent)}${marker}`] : []),
          ].join("\n");
          const error = await rejectedArticle(
            source,
            "x_article_fenced_code_tab_indent_unsupported",
          );
          assert.equal(error.problem.actual, "tab-indented fenced payload at source line 4");
          assert.doesNotMatch(error.message, /RAW_TAB_CANARY/);
        }
      }
    }
  }
});

test("code-source URL advisories remain detached while code never enters native input", async () => {
  const source = [
    "# Code advisories",
    "",
    "Visible [active](https://example.com/body).",
    "",
    "```https://example.com/info",
    "[secret](https://example.com/private)",
    "https://user:secret@example.com/credentialed",
    `https://example.com/\u202eadvisory`,
    "```",
  ].join("\n");
  const content = await generateContent(source, { format: "article" });
  assert.deepEqual(
    content.linkFlags.map((flag) => flag.url),
    [
      "https://example.com/body",
      "https://example.com/private",
      "https://example.com/info",
      "https://user:secret@example.com/credentialed",
      `https://example.com/\u202eadvisory`,
    ],
  );
  const snapshot = snapshotXArticleStageInput(content, "article");
  assert.equal(
    snapshot.html,
    '<p>Visible <a href="https://example.com/body">active</a>.</p>',
  );
  assert.equal(snapshot.plain, "Visible active.");
  assert.doesNotMatch(`${snapshot.html}\n${snapshot.plain}`, /secret|credentialed|advisory|info/);
});

test("heading-like Unicode edges inside fenced payload remain exact excluded code", async () => {
  for (const marker of ["```", TILDE_FENCE]) {
    for (const closure of ["explicit", "eof"] as const) {
      const source = [
        "# Code heading bytes",
        "",
        `${marker}txt`,
        "# \u00a0inside code",
        ...(closure === "explicit" ? [marker] : []),
      ].join("\n");
      const content = await generateContent(source, { format: "article" });
      assert.equal(content.article?.markdown, source);
      assert.equal(content.article?.codeBlockCount, 1);
      assert.deepEqual(content.article?.blocks, [{
        kind: "code",
        index: 1,
        lang: "txt",
        text: "# \u00a0inside code",
      }]);
      assert.deepEqual(
        content.codeFlags.map(({ index, lang, preview, sourceLine }) => ({
          index,
          lang,
          preview,
          sourceLine,
        })),
        [{ index: 1, lang: "txt", preview: "# \u00a0inside code", sourceLine: 3 }],
      );
      const snapshot = snapshotXArticleStageInput(content, "article");
      assert.equal(snapshot.markdown, source);
      assert.equal(snapshot.codeBlockCount, 1);
      assert.equal(snapshot.receiptCodeBlockCount, 1);
      assert.equal(snapshot.html, "");
      assert.equal(snapshot.plain, "");
    }
  }
});

test("nested, HTML-contained, and indented fences reject before any structured result", async () => {
  const nested = [
    "> before\n> ```js\n> hidden\n> ```",
    `- before\n  ${TILDE_FENCE}js\n  hidden\n  ${TILDE_FENCE}\n- after`,
  ];
  for (const body of nested) {
    const error = await rejectedArticle(`# Nested\n\n${body}`, "x_article_nested_fenced_code_unsupported");
    assert.doesNotMatch(error.message, /hidden/);
  }

  for (const body of [
    "    ```js\n    hidden\n    ```",
    `\t${TILDE_FENCE}js\n\thidden\n\t${TILDE_FENCE}`,
  ]) {
    const error = await rejectedArticle(`# Indented\n\n${body}`, "x_article_indented_code_unsupported");
    assert.doesNotMatch(error.message, /hidden/);
  }

  const htmlBlocks = [
    "<script>\n```js\nhidden\n```\n</script>",
    `<!--\n${TILDE_FENCE}js\nhidden\n${TILDE_FENCE}\n-->`,
    "<?xml version=\"1.0\"?>\n```js\nhidden\n```",
    "<!DOCTYPE html>\n```js\nhidden\n```",
    `<![CDATA[\n${TILDE_FENCE}js\nhidden\n${TILDE_FENCE}\n]]>`,
    "<div>\n```js\nhidden\n```\n</div>",
    "<custom-tag>\n```js\nhidden\n```\n</custom-tag>",
  ];
  for (const html of htmlBlocks) {
    const error = await rejectedArticle(`# HTML\n\n${html}`, "x_article_block_unsupported");
    assert.match(error.problem.actual as string, /html block/);
    assert.doesNotMatch(error.message, /hidden/);
  }
});

test("the closed Article matrix rejects semantics the native structure cannot preserve", async () => {
  assert.equal(mapHeadingLevel(1), 1);
  assert.equal(mapHeadingLevel(2), 2);
  for (let level = 3; level <= 6; level += 1) {
    assert.equal(mapHeadingLevel(level), null);
  }

  const cases: Array<[string, string, RegExp]> = [
    ["# T\n\n***", "x_article_block_unsupported", /hr block/],
    ["# T\n\nSection\n---", "x_article_block_unsupported", /setext_heading block/],
    ["Title\n=====\nBody", "x_article_title_unsupported", /Setext underline/],
    ["Title\n-----\nBody", "x_article_title_unsupported", /Setext underline/],
    ["# T\n\n### H3", "x_article_block_unsupported", /heading_level block/],
    ["# T\n\n5. Fifth", "x_article_block_unsupported", /ordered_list_start block/],
    ["# T\n\n- outer\n  - inner", "x_article_block_unsupported", /nested_container block/],
    ["# T\n\n[id]: https://example.com\n\n[id]", "x_article_block_unsupported", /def block/],
    ["# T\n\n- one\n\n- two", "x_article_block_unsupported", /list block/],
    ["# T\n\n- one\n+ two", "x_article_block_unsupported", /list_boundary block/],
    ["# T\n\n1. one\n1) two", "x_article_block_unsupported", /list_boundary block/],
    ["# T\n\n> one\n>\n> two", "x_article_block_unsupported", /nested_container block/],
    ["# T\n\nline  \nnext", "x_article_inline_unsupported", /hard_break inline/],
    ["# T\n\n`inline`", "x_article_inline_unsupported", /inline_code inline/],
    ["# T\n\n![image](body.png)", "x_article_inline_unsupported", /image inline/],
    ["# T\n\nbefore <span>x</span> after", "x_article_inline_unsupported", /html inline/],
    ["# T\n\n[x](https://example.com \"tooltip\")", "x_article_inline_unsupported", /link_title inline/],
    ["# T\n\n[](https://example.com)", "x_article_inline_unsupported", /empty_link inline/],
    ["# T\n\n&amp; and &notanentity;", "x_article_inline_unsupported", /entity_like_text inline/],
    ["# T\n\na\0b", "x_article_markdown_nul_unsupported", /U\+0000 at source line 3/],
    ["# a\0b\nBody", "x_article_markdown_nul_unsupported", /U\+0000 at source line 1/],
    ["# T\n\n[x](javascript:alert(1))", "x_article_link_unsupported", /unsafe or unsupported active link/],
    ["# T\n\n[x](https://user:secret@example.com/x)", "x_article_link_unsupported", /unsafe or unsupported active link/],
    ["# T\n\n[x](https://@example.com/)", "x_article_link_unsupported", /unsafe or unsupported active link/],
    ["# T\n\n[x](https://:@example.com/)", "x_article_link_unsupported", /unsafe or unsupported active link/],
    ["# T\n\n[x](https://example.com\\@evil.test/)", "x_article_link_unsupported", /source-normalized active link/],
    ["# T\n\n[x](https:////evil.test/path)", "x_article_link_unsupported", /unsafe or unsupported active link/],
    [`# T\n\n[x](https://example.com/\u202eevil)`, "x_article_link_unsupported", /unsafe or unsupported active link/],
    [`# T\n\n[x](https://example.com/\ud800)`, "x_article_link_unsupported", /unsafe or unsupported active link/],
    ["# T\n\n[x](https://e.test/?a=1&amp;b=2)", "x_article_link_unsupported", /unsafe or unsupported active link/],
    ["# T\n\n[x](https://example.com/a\\_b)", "x_article_link_unsupported", /source-normalized active link/],
    ["# T\n\n[x](https://example.com/a\\(b\\))", "x_article_link_unsupported", /source-normalized active link/],
    ["# T\n\n<https://example.com/path>", "x_article_link_unsupported", /source-normalized active link/],
    ["# T\n\n[x](<https://example.com/path>)", "x_article_link_unsupported", /source-normalized active link/],
    ["# T\n\n[x]( https://example.com/path )", "x_article_link_unsupported", /source-normalized active link/],
    ["# T\n\n[x](\nhttps://example.com/path\n)", "x_article_link_unsupported", /source-normalized active link/],
  ];
  for (const [source, code, evidence] of cases) {
    const error = await rejectedArticle(source, code);
    assert.match(error.message, evidence, source);
  }
  for (let level = 3; level <= 6; level += 1) {
    const error = await rejectedArticle(
      `# T\n\n${"#".repeat(level)} Heading ${level}`,
      "x_article_block_unsupported",
    );
    assert.match(error.message, /heading_level block/);
  }
});

test("supported active href bytes survive generation and staging without URL normalization", async () => {
  const urls = [
    "https://example.com/50%-off",
    "https://example.com/a%ZZ?q=%0A%09",
    "https://example.com/%E2%80%AEencoded",
  ];
  const source = "# Exact hrefs\n\n" + urls
    .map((url, index) => `[link${index + 1}](${url})`)
    .join(" and ");
  const content = await generateContent(source, { format: "article" });
  assert.deepEqual(content.linkFlags.map((flag) => flag.url), urls);
  const snapshot = snapshotXArticleStageInput(content, "article");
  for (const url of urls) {
    assert.equal(snapshot.html.includes(`href="${url}"`), true, url);
  }

  const escapedLabelSource =
    "# Escaped label\n\n[label\\_escaped](https://example.com/a_(b)?q=x%20y)";
  const escapedLabel = await generateContent(escapedLabelSource, { format: "article" });
  assert.equal(escapedLabel.article?.markdown, escapedLabelSource);
  assert.deepEqual(escapedLabel.article?.blocks, [{
    kind: "paragraph",
    runs: [{
      text: "label_escaped",
      href: "https://example.com/a_(b)?q=x%20y",
    }],
  }]);
  assert.deepEqual(escapedLabel.linkFlags, [{
    url: "https://example.com/a_(b)?q=x%20y",
    text: "label_escaped",
    note: "Links cost reach — keep this OUT of the opening tweet; move it to a reply or the end of the thread.",
  }]);
  const escapedLabelSnapshot = snapshotXArticleStageInput(escapedLabel, "article");
  assert.equal(
    escapedLabelSnapshot.html,
    '<p><a href="https://example.com/a_(b)?q=x%20y">label_escaped</a></p>',
  );
  assert.equal(escapedLabelSnapshot.plain, "label_escaped");
});

test("heading, flat-list, and active-link source edges never rely on parser trimming", async () => {
  const supported = await generateContent(
    [
      "# Exact source edges",
      "",
      "## Heading ##   ",
      "",
      "- alpha\u00a0beta",
      "- gamma",
      "",
      "[link\u00a0label](https://example.com/path)",
    ].join("\n"),
    { format: "article" },
  );
  assert.deepEqual(supported.article?.blocks, [
    { kind: "heading", level: 2, runs: [{ text: "Heading" }] },
    { kind: "bullet", runs: [{ text: "alpha\u00a0beta" }] },
    { kind: "bullet", runs: [{ text: "gamma" }] },
    {
      kind: "paragraph",
      runs: [{ text: "link\u00a0label", href: "https://example.com/path" }],
    },
  ]);
  const supportedSnapshot = snapshotXArticleStageInput(supported, "article");
  assert.equal(
    supportedSnapshot.html,
    '<h2>Heading</h2>\n<ul><li>alpha\u00a0beta</li><li>gamma</li></ul>\n' +
      '<p><a href="https://example.com/path">link\u00a0label</a></p>',
  );
  assert.equal(
    supportedSnapshot.plain,
    "Heading\n\nalpha\u00a0beta\n\ngamma\n\nlink\u00a0label",
  );

  for (const heading of [
    "# \u00a0Heading",
    "## Heading\u00a0",
    "# Heading\ufeff",
    "## Heading\u2028",
    "# Heading\u2029",
    "## Heading\u0007",
  ]) {
    const error = await rejectedArticle(
      `# T\n\n${heading}`,
      "x_article_heading_edge_unsupported",
      10,
    );
    assert.equal(error.problem.actual, "non-representable heading edge at source line 13");
  }

  for (const [source, expectedLine] of [
    ["# T\n\n- alpha\tbeta", 13],
    ["# T\n\n- alpha\n  \tbeta", 14],
    ["# T\n\n- one\n- two\tthree", 14],
  ] as const) {
    const error = await rejectedArticle(
      source,
      "x_article_list_tab_unsupported",
      10,
    );
    assert.equal(error.problem.actual, `tab in list source at source line ${expectedLine}`);
  }

  for (const edge of ["\u000b", "\u000c", "\u00a0", "\u2028", "\u2029", "\ufeff"]) {
    for (const [source, expectedLine] of [
      [`# T\n\n- alpha${edge}`, 13],
      [`# T\n\n- alpha ${edge}`, 13],
      [`# T\n\n- alpha  ${edge}\n`, 13],
      [`# T\n\n- one\n- two ${edge}`, 14],
      [`# T\n\n- alpha\n${edge}\n- beta`, 14],
      [`# T\n\n- alpha\n ${edge}\n- beta`, 14],
      [`# T\n\n- alpha\n  ${edge}\n- beta`, 14],
      [`# T\n\n1. alpha\n${edge}\n2. beta`, 14],
      [`# T\n\n1. alpha\n ${edge}\n2. beta`, 14],
      [`# T\n\n1. alpha\n  ${edge}\n2. beta`, 14],
      [`# T\n\n1. alpha\n   ${edge}\n2. beta`, 14],
      [`# T\n\n- alpha\n  ${edge}`, 14],
      [`# T\n\n- alpha\n ${edge}\n`, 14],
      [`# T\n\n- alpha\n  ${edge}\nbeta`, 14],
      [`# T\n\n- alpha\n \u00a0${edge}\n- beta`, 14],
    ] as const) {
      const error = await rejectedArticle(
        source,
        "x_article_list_edge_unsupported",
        10,
      );
      assert.equal(
        error.problem.actual,
        `non-representable list edge at source line ${expectedLine}`,
      );
    }
  }

  const blankSeparated = await generateContent(
    "# T\n\n- alpha\n\n\u00a0independent paragraph",
    { format: "article" },
  );
  assert.deepEqual(blankSeparated.article?.blocks, [
    { kind: "bullet", runs: [{ text: "alpha" }] },
    { kind: "paragraph", runs: [{ text: "\u00a0independent paragraph" }] },
  ]);
  const blankSeparatedSnapshot = snapshotXArticleStageInput(blankSeparated, "article");
  assert.equal(
    blankSeparatedSnapshot.html,
    "<ul><li>alpha</li></ul>\n<p>\u00a0independent paragraph</p>",
  );
  assert.equal(blankSeparatedSnapshot.plain, "alpha\n\n\u00a0independent paragraph");

  const nonblankUnicodeContinuation = await generateContent(
    "# T\n\n- alpha\n  \u00a0detail",
    { format: "article" },
  );
  assert.deepEqual(nonblankUnicodeContinuation.article?.blocks, [{
    kind: "bullet",
    runs: [{ text: "alpha \u00a0detail" }],
  }]);

  const interruptingTabBlocks = await generateContent(
    "# T\n\n- alpha\n# heading\tinside\n\n> quote\tinside",
    { format: "article" },
  );
  assert.deepEqual(interruptingTabBlocks.article?.blocks, [
    { kind: "bullet", runs: [{ text: "alpha" }] },
    { kind: "heading", level: 1, runs: [{ text: "heading\tinside" }] },
    { kind: "quote", runs: [{ text: "quote\tinside" }] },
  ]);

  for (const edge of ["\u00a0", "\u2028", "\u2029", "\ufeff"]) {
    const error = await rejectedArticle(
      `# T\n\n[x](https://example.com/path${edge})`,
      "x_article_link_unsupported",
      10,
    );
    assert.equal(error.problem.actual, "unsafe or unsupported link at source line 13");
  }
});

test("whitespace-only lines swallowed into supported paragraphs reject on their exact source line", async () => {
  for (const source of [
    "# T\n\nAlpha\n\t\nBeta\n",
    "# T\n\nAlpha\n \t\nBeta",
    "# T\n\nAlpha\n\t \nBeta",
    "# T\n\nAlpha\n\t\n \t\nBeta",
    "# T\n\nAlpha\n\t\n```\ncode\n```",
    "# T\n\nAlpha\n\t\n# Heading",
    "# T\n\nAlpha\n\t\n- item",
    "# T\n\nAlpha\n\t",
    "# T\n\nAlpha\n\t\n",
    "# T\r\n\r\nAlpha\r\n\t\r\nBeta\r\n",
    "# T\r\rAlpha\r\t\rBeta\r",
  ]) {
    const error = await rejectedArticle(
      source,
      "x_article_paragraph_whitespace_blank_unsupported",
      10,
    );
    assert.equal(
      error.problem.actual,
      "whitespace-only paragraph boundary at source line 14",
    );
  }

  for (const source of [
    "# T\n\n> alpha\n> \t\n> beta",
    "# T\r\r> alpha\r>  \t\r> beta",
  ]) {
    const error = await rejectedArticle(
      source,
      "x_article_paragraph_whitespace_blank_unsupported",
      10,
    );
    assert.equal(
      error.problem.actual,
      "whitespace-only paragraph boundary at source line 14",
    );
  }

  for (let spaces = 1; spaces <= 4; spaces += 1) {
    const rootError = await rejectedArticle(
      `# T\n\nAlpha\n${" ".repeat(spaces)}`,
      "x_article_paragraph_whitespace_blank_unsupported",
      10,
    );
    assert.equal(
      rootError.problem.actual,
      "whitespace-only paragraph boundary at source line 14",
    );

    const quoteSource = `# T\n\n> Alpha\n> ${" ".repeat(spaces)}`;
    for (const terminalLf of ["", "\n"] as const) {
      const quoteError = await rejectedArticle(
        `${quoteSource}${terminalLf}`,
        "x_article_paragraph_whitespace_blank_unsupported",
        10,
      );
      assert.equal(
        quoteError.problem.actual,
        "whitespace-only paragraph boundary at source line 14",
      );
    }

    const separateRootBlank = await generateContent(
      `# T\n\nAlpha\n${" ".repeat(spaces)}\n`,
      { format: "article" },
    );
    assert.deepEqual(separateRootBlank.article?.blocks, [{
      kind: "paragraph",
      runs: [{ text: "Alpha" }],
    }]);
  }

  const markerTab = await rejectedArticle(
    "# T\n\n> alpha\n>\t\n> beta",
    "x_article_block_unsupported",
    10,
  );
  assert.equal(markerTab.problem.actual, "nested_container block at source line 13");

  const hardBreak = await rejectedArticle(
    "# T\n\nAlpha  \nBeta",
    "x_article_inline_unsupported",
  );
  assert.equal(hardBreak.problem.actual, "hard_break inline at source line 3");

  const contentSpaces = await generateContent("# T\n\nAlpha  beta", {
    format: "article",
  });
  assert.deepEqual(contentSpaces.article?.blocks, [{
    kind: "paragraph",
    runs: [{ text: "Alpha  beta" }],
  }]);

  const valid = await generateContent(
    [
      "# T",
      "\t",
      "Alpha\tinside",
      "",
      "# heading\tinside",
      "",
      "> quote\tinside",
    ].join("\n"),
    { format: "article" },
  );
  assert.deepEqual(valid.article?.blocks, [
    { kind: "paragraph", runs: [{ text: "Alpha\tinside" }] },
    { kind: "heading", level: 1, runs: [{ text: "heading\tinside" }] },
    { kind: "quote", runs: [{ text: "quote\tinside" }] },
  ]);

  for (const fence of ["```", TILDE_FENCE]) {
    for (const closing of [fence, ""] as const) {
      const source = [
        "# T",
        "\t",
        fence,
        "alpha",
        "\t",
        "beta",
        ...(closing ? [closing] : []),
      ].join("\n");
      const content = await generateContent(source, { format: "article" });
      assert.equal(content.article?.markdown, source);
      assert.deepEqual(content.article?.blocks, [{
        kind: "code",
        index: 1,
        lang: undefined,
        text: "alpha\n\t\nbeta",
      }]);
    }
  }
});

test("direct inline NUL and parser-normalized heading syntax retain precise local evidence", async () => {
  assert.throws(
    () => parseInlineRuns("a\0b"),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.equal(error.problem.code, "x_article_markdown_nul_unsupported");
      assert.equal(error.problem.actual, "U+0000 at source line 1");
      assert.doesNotMatch(error.message, /parse failed|inline_parser_failed/i);
      return true;
    },
  );

  const heading = await rejectedArticle(
    "# T\n\n##\u00a0Heading",
    "x_article_block_unsupported",
    10,
  );
  assert.equal(
    heading.problem.actual,
    "source_normalized_heading block at source line 13",
  );
  assert.doesNotMatch(heading.message, /setext/i);
});

test("title formatting, missing titles, duplicate definitions, and structural excess reject precisely", async () => {
  for (const source of [
    "# **Bold title**\nBody",
    "# [Linked title](https://example.com)\nBody",
  ]) {
    const error = await rejectedArticle(source, "x_article_title_formatting_unsupported");
    assert.match(error.message, /native title field cannot preserve/);
  }
  await rejectedArticle("# `Code title`\nBody", "x_article_inline_unsupported");
  await rejectedArticle("", "x_article_title_missing");
  await rejectedArticle(" \t\n\t", "x_article_title_missing");

  const duplicateDefinition = await rejectedArticle(
    "# T\n\n[a]: https://one.test\n[a]: https://two.test\n\n[a]",
    "x_article_markdown_source_mapping_failed",
  );
  assert.match(duplicateDefinition.message, /next exact caller-source bytes/);

  const oversizedCode = "# T\n\n```txt\n" + "x".repeat(1_000_001);
  await rejectedArticle(oversizedCode, "x_article_code_block_oversized");

  const oversizedAdvisoryUrl = "# T\n\n```txt\nhttps://example.com/" + "x".repeat(8_193);
  await rejectedArticle(oversizedAdvisoryUrl, "x_article_link_advisory_oversized");

  const oversizedFormattedLinkLabel =
    "# T\n\n[" + "a".repeat(600_000) + "**" + "b".repeat(600_000) +
    "**](https://example.com)";
  await rejectedArticle(oversizedFormattedLinkLabel, "x_article_link_advisory_oversized");
});

test("adversarial nesting never escapes the bounded local Article error boundary", async () => {
  for (const source of [
    "# T\n\n" + "> ".repeat(3_000) + "RAW_PRIVATE_CANARY",
    "# T\n\n" + "***".repeat(2_000) + "RAW_PRIVATE_CANARY" + "***".repeat(2_000),
  ]) {
    const error = await rejectedArticle(source);
    assert.doesNotMatch(error.message, /RAW_PRIVATE_CANARY|RangeError|stack/i);
    assert.ok(error.problem.code.startsWith("x_article_markdown_") ||
      error.problem.code === "x_article_block_unsupported" ||
      error.problem.code === "x_article_structure_oversized");
  }
});

test("line-ending, BOM, frontmatter, and nested inline evidence retain original offsets", async () => {
  const raw = "\ufeff---\r\nprivate: hidden\r\n---\r\n# Title\r\n\r\n- okay\r\n- ![x](body.png)";
  const split = splitLeadingFrontmatter(raw, "fixture.md", {
    policy: "mapping-only",
    preserveBodyLineEndings: true,
  });
  assert.equal(split.bodyLineOffset, 3);
  const listError = await rejectedArticle(
    split.body,
    "x_article_inline_unsupported",
    split.bodyLineOffset,
  );
  assert.match(listError.message, /image inline at source line 7/);

  const paragraphError = await rejectedArticle(
    "# Title\n\nVisible\nthen &amp; here",
    "x_article_inline_unsupported",
    10,
  );
  assert.match(paragraphError.message, /entity_like_text inline at source line 14/);

  const doubleBom = splitLeadingFrontmatter("\ufeff\ufeff# Title\nBody", "double-bom.md", {
    policy: "mapping-only",
    preserveBodyLineEndings: true,
  });
  assert.equal(doubleBom.body.startsWith("\ufeff# Title"), true);
  await rejectedArticle(doubleBom.body, "x_article_title_edge_unsupported");
  await rejectedArticle("# Title\ufeff\nBody", "x_article_title_edge_unsupported");
  await rejectedArticle("# \u00a0Title\u00a0\nBody", "x_article_title_edge_unsupported");
});

function stageDependencies(capture: {
  title?: string;
  html?: string;
  plain?: string;
  verifyTitle?: string;
  verifyBody?: string;
}): ArticleDraftStageDependencies {
  const locator = {} as Locator;
  return {
    async openHub() {},
    async locateCreate() { return { async click() {} } as unknown as Locator; },
    currentEditUrl() { return "https://x.com/compose/articles/edit/12345"; },
    async locateTitle() { return locator; },
    async writeTitle(_page, _title, value) { capture.title = value; },
    async locateBody() { return locator; },
    async writeBody(_ctx, _page, _body, html, plain) {
      capture.html = html;
      capture.plain = plain;
    },
    async stageCover() {
      return {
        status: "missing",
        ratio: "not_observed",
        width: null,
        height: null,
        crop: "not_observed",
      };
    },
    async settle() {},
    async verify(_page, _url, title, body) {
      capture.verifyTitle = title;
      capture.verifyBody = body;
      return true;
    },
  };
}

test("consumed H1 followed by H1/H2 stages the exact title and body tuple", async () => {
  const source = "# Native Title\n\n# First body heading\n\n## Second body heading\n\nBody.";
  const content: GeneratedContent = await generateContent(source, { format: "article" });
  const capture: Parameters<typeof stageDependencies>[0] = {};
  const result = await stageArticleDraft(
    {} as BrowserContext,
    {} as Page,
    content,
    undefined,
    stageDependencies(capture),
  );
  assert.equal(result.savePhase, "verified");
  assert.equal(content.article?.markdown, source);
  assert.equal(capture.title, "Native Title");
  assert.equal(
    capture.html,
    "<h1>First body heading</h1>\n<h2>Second body heading</h2>\n<p>Body.</p>",
  );
  assert.equal(capture.plain, "First body heading\n\nSecond body heading\n\nBody.");
  assert.equal(capture.verifyTitle, capture.title);
  assert.equal(capture.verifyBody, capture.plain);
});

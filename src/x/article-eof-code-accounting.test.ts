import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Locator, Page } from "playwright";
import { executeXDraftRealRun } from "../commands/draft.js";
import {
  generateContent,
  parseArticleBlocks,
  renderForInspection,
  type GeneratedContent,
} from "./content.js";
import {
  htmlFromArticleBlocks,
  stageArticleDraft,
  type ArticleDraftStageDependencies,
  type StageDraftResult,
} from "./draftPoster.js";
import type { XArticleCoverHandoff } from "./saveProgress.js";

function missingCover(): XArticleCoverHandoff {
  return {
    status: "missing",
    ratio: "not_observed",
    width: null,
    height: null,
    crop: "not_observed",
  };
}

interface EofFenceCase {
  name: string;
  newline: "\n" | "\r\n" | "\r";
  opener: string;
  lang?: string;
  payloadLines: string[];
  terminalNewline?: boolean;
}

const EOF_FENCE_CASES: EofFenceCase[] = [
  {
    name: "LF backticks preserve multiline, image-looking, and trailing whitespace payload",
    newline: "\n",
    opener: "```ts",
    lang: "ts",
    payloadLines: ["const exact = true;  ", "![not-a-body-image](secret.png)", "  "],
  },
  {
    name: "CRLF tildes preserve multiline payload",
    newline: "\r\n",
    opener: " ~~~ python",
    lang: "python",
    payloadLines: ["first()", "second()"],
  },
  {
    name: "lone-CR backtick opener-only block is empty",
    newline: "\r",
    opener: "  ```json",
    lang: "json",
    payloadLines: [],
  },
  {
    name: "LF tilde empty block with terminal newline is empty",
    newline: "\n",
    opener: "   ~~~",
    payloadLines: [],
    terminalNewline: true,
  },
  {
    name: "CRLF backticks preserve whitespace-only payload and terminal newline",
    newline: "\r\n",
    opener: "```txt",
    lang: "txt",
    payloadLines: [" \t"],
    terminalNewline: true,
  },
];

function eofSource(fixture: EofFenceCase): string {
  const lines = ["# EOF article", "", "Body before code.", "", fixture.opener, ...fixture.payloadLines];
  return lines.join(fixture.newline) + (fixture.terminalNewline ? fixture.newline : "");
}

function expectedPayload(fixture: EofFenceCase): string {
  return fixture.payloadLines.join("\n") +
    (fixture.terminalNewline && fixture.payloadLines.length > 0 ? "\n" : "");
}

test("EOF-closed Article fences preserve exact normalized code and one accounting fact", async () => {
  for (const fixture of EOF_FENCE_CASES) {
    const source = eofSource(fixture);
    const normalized = source.replace(/\r\n?/g, "\n");
    const generated = await generateContent(source, { format: "article" });
    const article = generated.article;
    assert.ok(article, fixture.name);

    assert.equal(article.markdown, normalized, `${fixture.name}: clean Markdown`);
    assert.equal(article.codeBlockCount, 1, `${fixture.name}: generated count`);
    assert.equal(generated.codeFlags.length, 1, `${fixture.name}: advisory count`);
    assert.equal(generated.codeFlags[0]?.index, 1, fixture.name);
    assert.equal(generated.codeFlags[0]?.sourceLine, 5, fixture.name);
    assert.equal(generated.codeFlags[0]?.lang, fixture.lang, fixture.name);

    const code = article.blocks.filter((block) => block.kind === "code");
    assert.equal(code.length, 1, `${fixture.name}: structured count`);
    assert.deepEqual(code[0], {
      kind: "code",
      index: 1,
      lang: fixture.lang,
      text: expectedPayload(fixture),
    });

    const rendered = htmlFromArticleBlocks(article.blocks);
    assert.equal(rendered.codeBlockCount, 1, `${fixture.name}: excluded count`);
    assert.equal(rendered.html, "<p>Body before code.</p>", fixture.name);
    assert.doesNotMatch(rendered.html, /exact|not-a-body-image|secret\.png|first|second/);

    const inspection = renderForInspection(generated);
    assert.match(inspection, /native rich-HTML excluded code blocks: 1/);
    assert.match(inspection, /CODE BLOCKS.*#1/s);

    const direct = parseArticleBlocks(
      ["Body before code.", "", fixture.opener, ...fixture.payloadLines].join(fixture.newline) +
        (fixture.terminalNewline ? fixture.newline : ""),
    );
    assert.deepEqual(
      direct.filter((block) => block.kind === "code"),
      code,
      `${fixture.name}: exported parser line-ending behavior`,
    );
  }
});

test("EOF Article openers retain all valid zero-to-three-space indentation at body start", async () => {
  for (let indent = 0; indent <= 3; indent += 1) {
    const opener = `${" ".repeat(indent)}\`\`\`ts`;
    const source = `# Indented ${indent}\n\n${opener}\nvalue  `;
    const generated = await generateContent(source, { format: "article" });
    assert.equal(generated.article?.markdown, source);
    assert.equal(generated.article?.codeBlockCount, 1);
    assert.deepEqual(
      generated.article?.blocks.filter((block) => block.kind === "code"),
      [{ kind: "code", index: 1, lang: "ts", text: "value  " }],
    );
  }
});

test("an explicit block plus a final EOF block keep mixed and shorter markers inside code", async () => {
  const finalPayload = ["alpha", "```", "~~~", "![still-code](body.png)", "omega  "].join("\n");
  const source = [
    "# Multiple blocks",
    "",
    "Visible before.",
    "",
    "```js",
    "first()",
    "```",
    "",
    "Visible between.",
    "",
    "~~~~txt",
    finalPayload,
  ].join("\n");
  const generated = await generateContent(source, { format: "article" });
  const article = generated.article;
  assert.ok(article);
  assert.equal(article.markdown, source);
  assert.equal(article.codeBlockCount, 2);
  assert.equal(generated.codeFlags.length, 2);
  assert.deepEqual(
    article.blocks.filter((block) => block.kind === "code"),
    [
      { kind: "code", index: 1, lang: "js", text: "first()" },
      { kind: "code", index: 2, lang: "txt", text: finalPayload },
    ],
  );
  assert.deepEqual(generated.fidelityFlags, []);
  assert.deepEqual(generated.warnings, []);
  assert.doesNotMatch(article.markdown, /\[code block #\d+ → screenshot\]/);
  const rendered = htmlFromArticleBlocks(article.blocks);
  assert.equal(rendered.codeBlockCount, 2);
  assert.equal(rendered.html, "<p>Visible before.</p>\n<p>Visible between.</p>");
  assert.doesNotMatch(rendered.html, /first|alpha|still-code|body\.png|omega/);

  // #96 owns broader legacy Article classification (container/HTML fences,
  // invalid info strings, and trailing-text pseudo-closers). This regression
  // only proves #93's EOF flush does not reclassify short/escaped text as fences.
  const ordinary = await generateContent(
    "# Ordinary\n\n`` short\n\\``` escaped\ninline `tick` stays inline",
    { format: "article" },
  );
  assert.equal(ordinary.codeFlags.length, 0);
  assert.equal(ordinary.article?.codeBlockCount, 0);
  assert.equal(ordinary.article?.blocks.some((block) => block.kind === "code"), false);
});

function articleDependencies(
  verified: boolean,
  captured: { html?: string; plain?: string },
): ArticleDraftStageDependencies {
  const locator = {} as Locator;
  const create = { async click() {} } as unknown as Locator;
  return {
    async openHub() {},
    async locateCreate() { return create; },
    currentEditUrl() { return "https://x.com/compose/articles/edit/12345"; },
    async locateTitle() { return locator; },
    async writeTitle() {},
    async locateBody() { return locator; },
    async writeBody(_ctx, _page, _body, html, plain) {
      captured.html = html;
      captured.plain = plain;
    },
    async stageCover() { return missingCover(); },
    async settle() {},
    async verify() { return verified; },
  };
}

async function stageEofArticle(
  content: GeneratedContent,
  verified: boolean,
  captured: { html?: string; plain?: string },
): Promise<StageDraftResult> {
  return stageArticleDraft(
    {} as BrowserContext,
    {} as Page,
    content,
    undefined,
    articleDependencies(verified, captured),
  );
}

test("verified and unverified EOF Article handoffs exclude and report the same code block", async () => {
  const payload = "EXACT_CODE_PAYLOAD  \n![inside-code](body.png)\n  ";
  const content = await generateContent(
    `# Receipt article\n\nVisible body.\n\n\`\`\`ts\n${payload}`,
    { format: "article" },
  );

  for (const verified of [true, false]) {
    const captured: { html?: string; plain?: string } = {};
    const staged = await stageEofArticle(content, verified, captured);
    assert.equal(staged.saveMechanism, "article_create_autosave");
    assert.equal(staged.savePhase, verified ? "verified" : "save_delivered_unverified");
    assert.equal(staged.articleHandoff.codeBlockCount, 1);
    assert.equal(captured.html, "<p>Visible body.</p>");
    assert.equal(captured.plain, "Visible body.");
    assert.doesNotMatch(`${captured.html}\n${captured.plain}`, /EXACT_CODE_PAYLOAD|inside-code|body\.png/);

    const outcome = await executeXDraftRealRun(
      { content },
      { async loadStageDraft() { return async () => staged; } },
    );
    assert.equal(outcome.kind, verified ? "staged" : "save_incomplete");
    assert.equal(outcome.exitCode, verified ? 0 : 1);
    assert.equal(outcome.articleHandoff?.codeBlockCount, 1);
    assert.match(outcome.message, /codeBlockCount=1/);
    assert.match(outcome.message, /1 code block NOT auto-formatted/);
  }
});

test("mismatched or stateful returned Article counts cannot print a false receipt", async () => {
  const content = await generateContent("# Receipt article\n\n```ts\ncode", { format: "article" });
  const staged = await stageEofArticle(content, true, {});
  assert.equal(staged.saveMechanism, "article_create_autosave");

  for (const phase of ["verified", "save_delivered_unverified"] as const) {
    const mismatch = {
      ...staged,
      savePhase: phase,
      articleHandoff: { ...staged.articleHandoff, codeBlockCount: 0 },
    } as StageDraftResult;
    const outcome = await executeXDraftRealRun(
      { content },
      { async loadStageDraft() { return async () => mismatch; } },
    );
    assert.equal(outcome.kind, "save_incomplete");
    assert.equal(outcome.savePhase, "save_delivery_unknown");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.articleHandoff, null);
    assert.doesNotMatch(outcome.message, /codeBlockCount|code block NOT auto-formatted/);
  }

  let countReads = 0;
  const statefulHandoff = { ...staged.articleHandoff } as Record<string, unknown>;
  Object.defineProperty(statefulHandoff, "codeBlockCount", {
    get() {
      countReads += 1;
      return countReads === 1 ? 0 : 1;
    },
  });
  const stateful = {
    ...staged,
    articleHandoff: statefulHandoff,
  } as unknown as StageDraftResult;
  const outcome = await executeXDraftRealRun(
    { content },
    { async loadStageDraft() { return async () => stateful; } },
  );
  assert.equal(countReads, 1);
  assert.equal(outcome.savePhase, "save_delivery_unknown");
  assert.equal(outcome.articleHandoff, null);
  assert.doesNotMatch(outcome.message, /codeBlockCount|code block NOT auto-formatted/);
});

test("every generated Article accounting invariant fails before loading the staging runtime", async () => {
  const content = await generateContent("# Receipt article\n\n```ts\ncode", { format: "article" });
  assert.ok(content.article);

  interface MalformedAccountingFixture {
    name: string;
    makeContent(): {
      generated: GeneratedContent;
      assertReads?(): void;
      privateCanary?: string;
    };
  }

  const fixtures: MalformedAccountingFixture[] = [
    {
      name: "declared count differs from the well-typed structured block count",
      makeContent() {
        return {
          generated: {
            ...content,
            article: { ...content.article!, codeBlockCount: 0 },
          },
        };
      },
    },
    {
      name: "structured count and adjusted declaration differ from advisory count",
      makeContent() {
        return {
          generated: {
            ...content,
            article: { ...content.article!, blocks: [], codeBlockCount: 0 },
          },
        };
      },
    },
    {
      name: "stateful Article getter is snapshotted once",
      makeContent() {
        let reads = 0;
        const generated = { ...content } as GeneratedContent;
        Object.defineProperty(generated, "article", {
          get() {
            reads += 1;
            return reads === 1
              ? { ...content.article!, codeBlockCount: 0 }
              : content.article;
          },
        });
        return {
          generated,
          assertReads() { assert.equal(reads, 1); },
        };
      },
    },
    {
      name: "throwing advisory getter is read once and sanitized",
      makeContent() {
        let reads = 0;
        const privateCanary = "PRIVATE_GENERATED_CONTENT_GETTER_CANARY";
        const generated = { ...content } as GeneratedContent;
        Object.defineProperty(generated, "codeFlags", {
          get() {
            reads += 1;
            throw new Error(privateCanary);
          },
        });
        return {
          generated,
          assertReads() { assert.equal(reads, 1); },
          privateCanary,
        };
      },
    },
  ];

  for (const fixture of fixtures) {
    const prepared = fixture.makeContent();
    let loaderCalls = 0;
    const outcome = await executeXDraftRealRun(
      { content: prepared.generated },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          return async () => assert.fail("staging must not run");
        },
      },
    );

    assert.equal(loaderCalls, 0, fixture.name);
    prepared.assertReads?.();
    assert.equal(outcome.kind, "save_incomplete", fixture.name);
    assert.equal(outcome.exitCode, 2, fixture.name);
    assert.equal(outcome.savePhase, "save_not_attempted", fixture.name);
    assert.equal(outcome.articleHandoff, null, fixture.name);
    assert.match(
      outcome.message,
      /before the native Article Create\/autosave action was invoked/,
      fixture.name,
    );
    assert.doesNotMatch(
      outcome.message,
      /codeBlockCount|code block NOT auto-formatted/,
      fixture.name,
    );
    if (prepared.privateCanary) {
      assert.doesNotMatch(outcome.message, new RegExp(prepared.privateCanary), fixture.name);
    }
  }
});

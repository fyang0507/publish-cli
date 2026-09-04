import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Locator, Page } from "playwright";
import { executeXDraftRealRun } from "../commands/draft.js";
import {
  generateContent,
  type ArticleBlock,
  type GeneratedContent,
  type InlineRun,
} from "./content.js";
import {
  normalizeXArticleStageSnapshotFailure,
  snapshotXArticleStageInput,
  snapshotXContentFormat,
  XArticleStageSnapshotError,
  type XArticleStageSnapshotFailure,
} from "./articleStageSnapshot.js";
import {
  stageArticleDraft,
  stageDraft,
  type ArticleDraftStageDependencies,
} from "./draftPoster.js";
import {
  isXDraftStageError,
  XDraftStageError,
  type XArticleCoverHandoff,
} from "./saveProgress.js";

const RAW_CANARY =
  "PRIVATE_ARTICLE_SNAPSHOT_CANARY selector=[data-secret] cookie=session-secret";

function missingCover(): XArticleCoverHandoff {
  return {
    status: "missing",
    ratio: "not_observed",
    width: null,
    height: null,
    crop: "not_observed",
  };
}

function cloneContent(content: GeneratedContent): GeneratedContent {
  return structuredClone(content);
}

function firstLinkedRun(content: GeneratedContent): InlineRun {
  assert.ok(content.article);
  for (const block of content.article.blocks) {
    if (block.kind === "code") continue;
    const linked = block.runs.find((run) => run.href !== undefined);
    if (linked) return linked;
  }
  throw new Error("fixture has no linked run");
}

interface ArticleCapture {
  events: string[];
  title?: string;
  html?: string;
  plain?: string;
  verify?: { editUrl: string; title: string; body: string };
  coverBasePath?: string;
}

function articleDependencies(
  capture: ArticleCapture,
  options: {
    verified?: boolean;
    editUrl?: unknown;
    mutateAfterSnapshot?: () => void | Promise<void>;
  } = {},
): ArticleDraftStageDependencies {
  const locator = {} as Locator;
  const create = {
    async click() {
      capture.events.push("create:click");
    },
  } as unknown as Locator;
  return {
    async openHub() {
      capture.events.push("hub:open");
      await options.mutateAfterSnapshot?.();
    },
    async locateCreate() {
      capture.events.push("create:locate");
      return create;
    },
    currentEditUrl() {
      capture.events.push("edit:url");
      return (options.editUrl === undefined
        ? "https://x.com/compose/articles/edit/12345"
        : options.editUrl) as string | null;
    },
    async locateTitle() {
      capture.events.push("title:locate");
      return locator;
    },
    async writeTitle(_page, _title, value) {
      capture.events.push("title:write");
      capture.title = value;
    },
    async locateBody() {
      capture.events.push("body:locate");
      return locator;
    },
    async writeBody(_ctx, _page, _body, html, plain) {
      capture.events.push("body:write");
      capture.html = html;
      capture.plain = plain;
    },
    async stageCover(_page, basePath) {
      capture.events.push("cover:stage");
      capture.coverBasePath = basePath;
      return missingCover();
    },
    async settle() {
      capture.events.push("autosave:settle");
    },
    async verify(_page, editUrl, expectedTitle, expectedBody) {
      capture.events.push("edit:verify");
      capture.verify = {
        editUrl,
        title: expectedTitle,
        body: expectedBody,
      };
      return options.verified ?? true;
    },
  };
}

async function expectDirectNotAttempted(
  content: GeneratedContent,
  events: string[],
  basePath?: string,
): Promise<void> {
  await assert.rejects(
    stageArticleDraft(
      {} as BrowserContext,
      {} as Page,
      content,
      basePath,
      articleDependencies({ events }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof XDraftStageError);
      assert.equal(error.savePhase, "save_not_attempted");
      assert.equal(error.saveMechanism, "article_create_autosave");
      assert.doesNotMatch(error.message, /PRIVATE_ARTICLE|data-secret|session-secret/);
      return true;
    },
  );
}

test("Article snapshot is detached, recursively frozen, and pre-renders one closed tuple", async () => {
  const source = [
    "# Snapshot title",
    "",
    "operator's **bold** [safe link](https://example.com/path?q=one#part).",
    "",
    "```ts",
    "SECRET_CODE_PAYLOAD",
    "```",
  ].join("\n");
  const content = await generateContent(source, { format: "article" });
  const snapshot = snapshotXArticleStageInput(content, snapshotXContentFormat(content));

  assert.notEqual(snapshot.content, content);
  assert.notEqual(snapshot.content.article, content.article);
  assert.notEqual(snapshot.content.article?.blocks, content.article?.blocks);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.content), true);
  assert.equal(Object.isFrozen(snapshot.content.article), true);
  assert.equal(Object.isFrozen(snapshot.content.article?.blocks), true);
  assert.equal(snapshot.title, "Snapshot title");
  assert.equal(snapshot.markdown, source);
  assert.equal(snapshot.codeBlockCount, 1);
  assert.equal(snapshot.receiptCodeBlockCount, 1);
  assert.match(snapshot.html, /operator&#39;s/);
  assert.match(snapshot.html, /href="https:\/\/example\.com\/path\?q=one#part"/);
  assert.doesNotMatch(snapshot.html, /SECRET_CODE_PAYLOAD/);
  assert.doesNotMatch(snapshot.plain, /SECRET_CODE_PAYLOAD/);
});

test("valid empty explicit and EOF Article fences survive snapshot accounting", async () => {
  for (const source of [
    "# Empty explicit\n\n```\n```\n",
    "# Empty EOF\n\n~~~",
  ]) {
    const content = await generateContent(source, { format: "article" });
    const snapshot = snapshotXArticleStageInput(content, "article");
    assert.equal(snapshot.codeBlockCount, 1);
    assert.equal(snapshot.receiptCodeBlockCount, 1);
    assert.equal(snapshot.html, "");
    assert.equal(snapshot.plain, "");
  }
});

test("hostile Article shapes fail closed with exit 2 before the staging loader", async () => {
  const base = await generateContent(
    "# Hostile shape\n\n[linked](https://example.com/safe) body.\n\n```ts\ncode\n```",
    { format: "article" },
  );

  const fixtures: Array<{
    name: string;
    prepare(): GeneratedContent;
    expected?: XArticleStageSnapshotFailure;
    assertReads?(): void;
  }> = [];

  {
    let reads = 0;
    fixtures.push({
      name: "stateful format accessor",
      prepare() {
        const content = cloneContent(base);
        Object.defineProperty(content, "format", {
          enumerable: true,
          get() {
            reads += 1;
            return reads === 1 ? "tweet" : "article";
          },
        });
        return content;
      },
      expected: "accessor_property",
      assertReads() { assert.equal(reads, 1); },
    });
  }
  {
    let reads = 0;
    fixtures.push({
      name: "stateful Article accessor",
      prepare() {
        const content = cloneContent(base);
        const article = content.article;
        const mutated = {
          ...article!,
          title: "MUTATED_PRIVATE_ARTICLE_TITLE",
          markdown: "MUTATED_PRIVATE_ARTICLE_BODY",
          blocks: [],
          codeBlockCount: 0,
        };
        Object.defineProperty(content, "article", {
          enumerable: true,
          get() {
            reads += 1;
            return reads === 1 ? article : mutated;
          },
        });
        return content;
      },
      expected: "accessor_property",
      assertReads() { assert.equal(reads, 1); },
    });
  }
  {
    let reads = 0;
    fixtures.push({
      name: "stateful block kind accessor",
      prepare() {
        const content = cloneContent(base);
        const block = content.article!.blocks.find((entry) => entry.kind === "code");
        assert.ok(block);
        Object.defineProperty(block, "kind", {
          enumerable: true,
          get() {
            reads += 1;
            return reads === 1 ? "code" : "paragraph";
          },
        });
        return content;
      },
      expected: "accessor_property",
      assertReads() { assert.equal(reads, 1); },
    });
  }
  {
    let reads = 0;
    fixtures.push({
      name: "stateful run href accessor",
      prepare() {
        const content = cloneContent(base);
        const run = firstLinkedRun(content);
        Object.defineProperty(run, "href", {
          enumerable: true,
          get() {
            reads += 1;
            return reads === 1 ? "https://example.com/safe" : "javascript:alert(1)";
          },
        });
        return content;
      },
      expected: "accessor_property",
      assertReads() { assert.equal(reads, 1); },
    });
  }
  {
    let reads = 0;
    fixtures.push({
      name: "throwing advisory accessor",
      prepare() {
        const content = cloneContent(base);
        Object.defineProperty(content, "codeFlags", {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error(RAW_CANARY);
          },
        });
        return content;
      },
      expected: "property_read_failed",
      assertReads() { assert.equal(reads, 1); },
    });
  }
  fixtures.push(
    {
      name: "proxy root",
      prepare() { return new Proxy(cloneContent(base), {}); },
      expected: "proxy_object",
    },
    {
      name: "cyclic block array",
      prepare() {
        const content = cloneContent(base);
        const block = content.article!.blocks[0];
        if (block.kind === "code") throw new Error("fixture block must contain runs");
        block.runs = content.article!.blocks as unknown as InlineRun[];
        return content;
      },
      expected: "cyclic_structure",
    },
    {
      name: "sparse blocks",
      prepare() {
        const content = cloneContent(base);
        delete content.article!.blocks[0];
        return content;
      },
      expected: "sparse_array",
    },
    {
      name: "oversized blocks",
      prepare() {
        const content = cloneContent(base);
        content.article!.blocks = new Array(50_001);
        return content;
      },
      expected: "oversized_structure",
    },
    {
      name: "unexpected Article union property",
      prepare() {
        const content = cloneContent(base) as GeneratedContent & { tweet?: undefined };
        content.tweet = undefined;
        return content;
      },
      expected: "unexpected_property",
    },
    {
      name: "symbol property",
      prepare() {
        const content = cloneContent(base) as GeneratedContent & Record<PropertyKey, unknown>;
        content[Symbol("private")] = RAW_CANARY;
        return content;
      },
      expected: "unexpected_property",
    },
    {
      name: "non-enumerable property",
      prepare() {
        const content = cloneContent(base);
        Object.defineProperty(content, "privateCanary", { value: RAW_CANARY });
        return content;
      },
      expected: "unexpected_property",
    },
    {
      name: "non-plain root",
      prepare() {
        const content = cloneContent(base);
        Object.setPrototypeOf(content, null);
        return content;
      },
      expected: "not_plain_object",
    },
    {
      name: "accounting mismatch",
      prepare() {
        const content = cloneContent(base);
        content.article!.codeBlockCount = 0;
        return content;
      },
      expected: "accounting_mismatch",
    },
  );

  for (const fixture of fixtures) {
    let loaderCalls = 0;
    const outcome = await executeXDraftRealRun(
      { content: fixture.prepare() },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          return async () => assert.fail("staging must not run");
        },
      },
    );
    fixture.assertReads?.();
    assert.equal(loaderCalls, 0, fixture.name);
    assert.equal(outcome.kind, "save_incomplete", fixture.name);
    assert.equal(outcome.exitCode, 2, fixture.name);
    assert.equal(outcome.savePhase, "save_not_attempted", fixture.name);
    assert.match(outcome.message, new RegExp(`reason=${fixture.expected}`), fixture.name);
    assert.doesNotMatch(outcome.message, /PRIVATE_ARTICLE|data-secret|session-secret/, fixture.name);
  }
});

test("every Article staging field accessor is invoked once then rejected pre-loader", async () => {
  const base = await generateContent(
    "# Getter matrix\n\n## Section\n\n**bold** *italic* `inline` [label](https://example.com/safe)\n\n```ts\ncode preview\n```",
    { format: "article" },
  );

  type Target = {
    record: Record<PropertyKey, unknown>;
    key: string;
  };
  type ProseBlock = Exclude<ArticleBlock, { kind: "code" }>;
  const proseBlock = (content: GeneratedContent): ProseBlock => {
    for (const block of content.article!.blocks) {
      if (
        block.kind !== "code" &&
        block.runs.some((run) => run.bold || run.italic || run.code || run.href)
      ) return block;
    }
    throw new Error("missing prose block");
  };
  const headingBlock = (content: GeneratedContent) => {
    const block = content.article!.blocks.find((entry) => entry.kind === "heading");
    if (!block || block.kind !== "heading") throw new Error("missing heading block");
    return block;
  };
  const codeBlock = (content: GeneratedContent) => {
    const block = content.article!.blocks.find((entry) => entry.kind === "code");
    if (!block || block.kind !== "code") throw new Error("missing code block");
    return block;
  };
  const markedRun = (content: GeneratedContent, mark: "bold" | "italic" | "code") => {
    const run = proseBlock(content).runs.find((entry) => entry[mark] === true);
    if (!run) throw new Error(`missing ${mark} run`);
    return run;
  };

  const targets: Array<[string, (content: GeneratedContent) => Target]> = [
    ["article.title", (content) => ({ record: content.article! as unknown as Record<PropertyKey, unknown>, key: "title" })],
    ["article.markdown", (content) => ({ record: content.article! as unknown as Record<PropertyKey, unknown>, key: "markdown" })],
    ["article.blocks", (content) => ({ record: content.article! as unknown as Record<PropertyKey, unknown>, key: "blocks" })],
    ["article.codeBlockCount", (content) => ({ record: content.article! as unknown as Record<PropertyKey, unknown>, key: "codeBlockCount" })],
    ["block.level", (content) => ({ record: headingBlock(content) as unknown as Record<PropertyKey, unknown>, key: "level" })],
    ["block.runs", (content) => ({ record: proseBlock(content) as unknown as Record<PropertyKey, unknown>, key: "runs" })],
    ["code.index", (content) => ({ record: codeBlock(content) as unknown as Record<PropertyKey, unknown>, key: "index" })],
    ["code.lang", (content) => ({ record: codeBlock(content) as unknown as Record<PropertyKey, unknown>, key: "lang" })],
    ["code.text", (content) => ({ record: codeBlock(content) as unknown as Record<PropertyKey, unknown>, key: "text" })],
    ["run.text", (content) => ({ record: proseBlock(content).runs[0] as unknown as Record<PropertyKey, unknown>, key: "text" })],
    ["run.bold", (content) => ({ record: markedRun(content, "bold") as unknown as Record<PropertyKey, unknown>, key: "bold" })],
    ["run.italic", (content) => ({ record: markedRun(content, "italic") as unknown as Record<PropertyKey, unknown>, key: "italic" })],
    ["run.code", (content) => ({ record: markedRun(content, "code") as unknown as Record<PropertyKey, unknown>, key: "code" })],
    ["run.href", (content) => ({ record: firstLinkedRun(content) as unknown as Record<PropertyKey, unknown>, key: "href" })],
    ["linkFlag.url", (content) => ({ record: content.linkFlags[0] as unknown as Record<PropertyKey, unknown>, key: "url" })],
    ["linkFlag.text", (content) => ({ record: content.linkFlags[0] as unknown as Record<PropertyKey, unknown>, key: "text" })],
    ["linkFlag.note", (content) => ({ record: content.linkFlags[0] as unknown as Record<PropertyKey, unknown>, key: "note" })],
    ["codeFlag.index", (content) => ({ record: content.codeFlags[0] as unknown as Record<PropertyKey, unknown>, key: "index" })],
    ["codeFlag.lang", (content) => ({ record: content.codeFlags[0] as unknown as Record<PropertyKey, unknown>, key: "lang" })],
    ["codeFlag.preview", (content) => ({ record: content.codeFlags[0] as unknown as Record<PropertyKey, unknown>, key: "preview" })],
    ["codeFlag.sourceLine", (content) => ({ record: content.codeFlags[0] as unknown as Record<PropertyKey, unknown>, key: "sourceLine" })],
    ["content.limit", (content) => ({ record: content as unknown as Record<PropertyKey, unknown>, key: "limit" })],
    ["content.linkFlags", (content) => ({ record: content as unknown as Record<PropertyKey, unknown>, key: "linkFlags" })],
    ["content.fidelityFlags", (content) => ({ record: content as unknown as Record<PropertyKey, unknown>, key: "fidelityFlags" })],
    ["content.warnings", (content) => ({ record: content as unknown as Record<PropertyKey, unknown>, key: "warnings" })],
    ["blocks[0]", (content) => ({ record: content.article!.blocks as unknown as Record<PropertyKey, unknown>, key: "0" })],
    ["runs[0]", (content) => ({ record: proseBlock(content).runs as unknown as Record<PropertyKey, unknown>, key: "0" })],
    ["codeFlags[0]", (content) => ({ record: content.codeFlags as unknown as Record<PropertyKey, unknown>, key: "0" })],
    ["linkFlags[0]", (content) => ({ record: content.linkFlags as unknown as Record<PropertyKey, unknown>, key: "0" })],
  ];

  for (const [name, select] of targets) {
    const content = cloneContent(base);
    const { record, key } = select(content);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    assert.ok(descriptor && "value" in descriptor, name);
    const originalValue = descriptor.value;
    let reads = 0;
    Object.defineProperty(record, key, {
      enumerable: true,
      get() {
        reads += 1;
        return originalValue;
      },
    });
    let loaderCalls = 0;
    const outcome = await executeXDraftRealRun(
      { content },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          return async () => assert.fail("staging must not run");
        },
      },
    );
    assert.equal(reads, 1, name);
    assert.equal(loaderCalls, 0, name);
    assert.equal(outcome.exitCode, 2, name);
    assert.equal(outcome.savePhase, "save_not_attempted", name);
    assert.match(outcome.message, /reason=accessor_property/, name);
    assert.doesNotMatch(outcome.message, /Getter matrix|code preview|example\.com/, name);
  }
});

test("nested proxies, sparse arrays, unsafe counts, and extra nested keys fail closed", async () => {
  const base = await generateContent(
    "# Nested matrix\n\n[linked](https://example.com/safe)\n\n```ts\ncode\n```",
    { format: "article" },
  );
  const proseBlock = (content: GeneratedContent) => {
    const block = content.article!.blocks.find((entry) => entry.kind !== "code");
    if (!block) throw new Error("missing prose block");
    return block;
  };
  const codeBlock = (content: GeneratedContent) => {
    const block = content.article!.blocks.find((entry) => entry.kind === "code");
    if (!block || block.kind !== "code") throw new Error("missing code block");
    return block;
  };
  const fixtures: Array<{
    name: string;
    reason: XArticleStageSnapshotFailure;
    mutate(content: GeneratedContent): void;
  }> = [
    {
      name: "blocks array proxy",
      reason: "proxy_object",
      mutate(content) { content.article!.blocks = new Proxy(content.article!.blocks, {}); },
    },
    {
      name: "block object proxy",
      reason: "proxy_object",
      mutate(content) { content.article!.blocks[0] = new Proxy(content.article!.blocks[0], {}); },
    },
    {
      name: "runs array proxy",
      reason: "proxy_object",
      mutate(content) { proseBlock(content).runs = new Proxy(proseBlock(content).runs, {}); },
    },
    {
      name: "run object proxy",
      reason: "proxy_object",
      mutate(content) { proseBlock(content).runs[0] = new Proxy(proseBlock(content).runs[0], {}); },
    },
    {
      name: "code flags array proxy",
      reason: "proxy_object",
      mutate(content) { content.codeFlags = new Proxy(content.codeFlags, {}); },
    },
    {
      name: "code flag object proxy",
      reason: "proxy_object",
      mutate(content) { content.codeFlags[0] = new Proxy(content.codeFlags[0], {}); },
    },
    {
      name: "link flags array proxy",
      reason: "proxy_object",
      mutate(content) { content.linkFlags = new Proxy(content.linkFlags, {}); },
    },
    {
      name: "link flag object proxy",
      reason: "proxy_object",
      mutate(content) { content.linkFlags[0] = new Proxy(content.linkFlags[0], {}); },
    },
    {
      name: "sparse runs",
      reason: "sparse_array",
      mutate(content) { delete proseBlock(content).runs[0]; },
    },
    {
      name: "sparse code flags",
      reason: "sparse_array",
      mutate(content) { delete content.codeFlags[0]; },
    },
    {
      name: "sparse link flags",
      reason: "sparse_array",
      mutate(content) { delete content.linkFlags[0]; },
    },
    {
      name: "NaN declared code count",
      reason: "invalid_value",
      mutate(content) { content.article!.codeBlockCount = Number.NaN; },
    },
    {
      name: "infinite declared code count",
      reason: "invalid_value",
      mutate(content) { content.article!.codeBlockCount = Number.POSITIVE_INFINITY; },
    },
    {
      name: "unsafe declared code count",
      reason: "invalid_value",
      mutate(content) { content.article!.codeBlockCount = Number.MAX_SAFE_INTEGER + 1; },
    },
    {
      name: "invalid block discriminant",
      reason: "invalid_value",
      mutate(content) {
        (proseBlock(content) as unknown as { kind: unknown }).kind = "html";
      },
    },
    {
      name: "zero block index",
      reason: "invalid_value",
      mutate(content) { codeBlock(content).index = 0; },
    },
    {
      name: "nonfinite flag source line",
      reason: "invalid_value",
      mutate(content) { content.codeFlags[0].sourceLine = Number.POSITIVE_INFINITY; },
    },
    {
      name: "oversized title",
      reason: "oversized_structure",
      mutate(content) { content.article!.title = "x".repeat(100_001); },
    },
    {
      name: "oversized run array",
      reason: "oversized_structure",
      mutate(content) { proseBlock(content).runs = new Array(50_001); },
    },
    {
      name: "extra Article key",
      reason: "unexpected_property",
      mutate(content) {
        (content.article as unknown as Record<string, unknown>).extra = RAW_CANARY;
      },
    },
    {
      name: "extra block key",
      reason: "unexpected_property",
      mutate(content) {
        (proseBlock(content) as unknown as Record<string, unknown>).extra = RAW_CANARY;
      },
    },
    {
      name: "extra run key",
      reason: "unexpected_property",
      mutate(content) {
        (proseBlock(content).runs[0] as unknown as Record<string, unknown>).extra = RAW_CANARY;
      },
    },
    {
      name: "extra advisory key",
      reason: "unexpected_property",
      mutate(content) {
        (content.codeFlags[0] as unknown as Record<string, unknown>).extra = RAW_CANARY;
      },
    },
    {
      name: "extra link advisory key",
      reason: "unexpected_property",
      mutate(content) {
        (content.linkFlags[0] as unknown as Record<string, unknown>).extra = RAW_CANARY;
      },
    },
  ];

  for (const fixture of fixtures) {
    const content = cloneContent(base);
    fixture.mutate(content);
    let loaderCalls = 0;
    const outcome = await executeXDraftRealRun(
      { content },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          return async () => assert.fail("staging must not run");
        },
      },
    );
    assert.equal(loaderCalls, 0, fixture.name);
    assert.equal(outcome.exitCode, 2, fixture.name);
    assert.equal(outcome.savePhase, "save_not_attempted", fixture.name);
    assert.match(outcome.message, new RegExp(`reason=${fixture.reason}`), fixture.name);
    assert.doesNotMatch(outcome.message, /PRIVATE_ARTICLE|data-secret|session-secret/, fixture.name);
  }
});

test("invalid and Article-bearing non-Article discriminants cannot reach the loader", async () => {
  const article = await generateContent("# Mutated\n\nBody", { format: "article" });
  const invalid = cloneContent(article);
  (invalid as unknown as { format: unknown }).format = "bogus";

  const tweet = await generateContent("Safe tweet", { format: "tweet" });
  let articleReads = 0;
  Object.defineProperty(tweet, "article", {
    enumerable: true,
    get() {
      articleReads += 1;
      throw new Error(RAW_CANARY);
    },
  });

  for (const content of [invalid as GeneratedContent, tweet]) {
    let loaderCalls = 0;
    const outcome = await executeXDraftRealRun(
      { content },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          return async () => assert.fail("staging must not run");
        },
      },
    );
    assert.equal(loaderCalls, 0);
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.savePhase, "save_not_attempted");
    assert.equal(outcome.saveMechanism, null);
    assert.match(outcome.message, /before format\/mechanism classification/);
    assert.doesNotMatch(outcome.message, /Article Create|composer Save/);
  }
  assert.equal(articleReads, 0, "the forbidden Article property is never invoked");

  const stateful = cloneContent(article);
  let formatReads = 0;
  Object.defineProperty(stateful, "format", {
    enumerable: true,
    get() {
      formatReads += 1;
      return formatReads === 1 ? "tweet" : "article";
    },
  });
  let statefulLoaderCalls = 0;
  const statefulOutcome = await executeXDraftRealRun(
    { content: stateful },
    {
      async loadStageDraft() {
        statefulLoaderCalls += 1;
        return async () => assert.fail("staging must not run");
      },
    },
  );
  assert.equal(formatReads, 1);
  assert.equal(statefulLoaderCalls, 0);
  assert.equal(statefulOutcome.saveMechanism, null);
  assert.equal(statefulOutcome.exitCode, 2);

  const directStateful = cloneContent(article);
  let directFormatReads = 0;
  Object.defineProperty(directStateful, "format", {
    enumerable: true,
    get() {
      directFormatReads += 1;
      return directFormatReads === 1 ? "tweet" : "article";
    },
  });
  await assert.rejects(stageDraft(directStateful), (error: unknown) => {
    assert.ok(error instanceof XArticleStageSnapshotError);
    assert.ok(error instanceof XDraftStageError);
    assert.equal(isXDraftStageError(error), true);
    assert.equal(error.reason, "accessor_property");
    assert.equal(error.savePhase, "save_not_attempted");
    assert.equal(error.saveMechanism, null);
    assert.doesNotMatch(error.message, /Article Create|composer Save|native Create action|PRIVATE_ARTICLE/);
    assert.match(error.message, /native Save\/Create action/);
    return true;
  });
  assert.equal(directFormatReads, 1);

  for (const fixture of [
    { content: cloneContent(article), mechanism: "article_create_autosave" as const },
    { content: cloneContent(await generateContent("Safe tweet", { format: "tweet" })), mechanism: "composer_close_save" as const },
  ]) {
    (fixture.content as unknown as Record<string, unknown>).extra = RAW_CANARY;
    let loaderCalls = 0;
    const outcome = await executeXDraftRealRun(
      { content: fixture.content },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          return async () => assert.fail("staging must not run");
        },
      },
    );
    assert.equal(loaderCalls, 0);
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.savePhase, "save_not_attempted");
    assert.equal(outcome.saveMechanism, fixture.mechanism);
    await assert.rejects(stageDraft(fixture.content), (error: unknown) => {
      assert.ok(error instanceof XDraftStageError);
      assert.equal(error.savePhase, "save_not_attempted");
      assert.equal(error.saveMechanism, fixture.mechanism);
      return true;
    });
  }
});

test("hostile snapshot-error reasons stay closed and content-free at every local boundary", async () => {
  const hostileReason = `${RAW_CANARY}\u001b[31m\0${"x".repeat(100_000)}`;
  const forged = Object.create(XArticleStageSnapshotError.prototype) as object;
  Object.defineProperty(forged, "reason", {
    value: hostileReason,
    enumerable: true,
    writable: true,
    configurable: true,
  });

  let throwingReasonReads = 0;
  const throwingReason = Object.create(XArticleStageSnapshotError.prototype) as object;
  Object.defineProperty(throwingReason, "reason", {
    enumerable: true,
    get() {
      throwingReasonReads += 1;
      throw new Error(hostileReason);
    },
  });

  let statefulReasonReads = 0;
  const statefulReason = Object.create(XArticleStageSnapshotError.prototype) as object;
  Object.defineProperty(statefulReason, "reason", {
    enumerable: true,
    get() {
      statefulReasonReads += 1;
      return statefulReasonReads === 1 ? "unsafe_href" : hostileReason;
    },
  });

  class SnapshotErrorSubclass extends XArticleStageSnapshotError {}
  const subclassProxy = new Proxy(
    new SnapshotErrorSubclass("invalid_value"),
    {
      get(target, key, receiver) {
        if (key === "reason") return hostileReason;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const revoked = Proxy.revocable(new XArticleStageSnapshotError("invalid_value"), {});
  revoked.revoke();

  for (const thrown of [forged, throwingReason, statefulReason, subclassProxy, revoked.proxy]) {
    let loaderCalls = 0;
    const input = Object.defineProperty({}, "content", {
      enumerable: true,
      get() {
        throw thrown;
      },
    }) as Parameters<typeof executeXDraftRealRun>[0];
    const outcome = await executeXDraftRealRun(
      input,
      {
        async loadStageDraft() {
          loaderCalls += 1;
          return async () => assert.fail("staging must not run");
        },
      },
    );
    assert.equal(loaderCalls, 0);
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.savePhase, "save_not_attempted");
    assert.equal(outcome.saveMechanism, null);
    assert.match(outcome.message, /reason=property_read_failed/);
    assert.ok(outcome.message.length < 1_000);
    assert.doesNotMatch(outcome.message, /PRIVATE_ARTICLE|data-secret|session-secret|\u001b|\0/);
  }
  assert.equal(throwingReasonReads, 0, "a failed input.content read never inspects its error");
  assert.equal(statefulReasonReads, 0, "a failed input.content read never inspects its error");

  assert.equal(normalizeXArticleStageSnapshotFailure(forged), "property_read_failed");
  assert.equal(normalizeXArticleStageSnapshotFailure(throwingReason), "property_read_failed");
  assert.equal(throwingReasonReads, 1);
  assert.equal(normalizeXArticleStageSnapshotFailure(statefulReason), "unsafe_href");
  assert.equal(statefulReasonReads, 1, "the normalizer reads a stateful reason exactly once");
  assert.equal(normalizeXArticleStageSnapshotFailure(subclassProxy), "property_read_failed");
  assert.equal(normalizeXArticleStageSnapshotFailure(revoked.proxy), "property_read_failed");

  const closed = new XArticleStageSnapshotError("invalid_value");
  assert.throws(() => Object.defineProperty(closed, "reason", { value: hostileReason }));
  assert.throws(() => Object.defineProperty(closed, "message", { value: hostileReason }));
  assert.equal(closed.reason, "invalid_value");
  assert.doesNotMatch(closed.message, /PRIVATE_ARTICLE|data-secret|session-secret|\u001b|\0/);
  const invalidConstructor = new XArticleStageSnapshotError(
    hostileReason as XArticleStageSnapshotFailure,
  );
  assert.equal(invalidConstructor.reason, "property_read_failed");
  assert.doesNotMatch(
    invalidConstructor.message,
    /PRIVATE_ARTICLE|data-secret|session-secret|\u001b|\0/,
  );

  const direct = await generateContent("# Direct hostile error\n\nBody", { format: "article" });
  Object.defineProperty(direct, "format", {
    enumerable: true,
    get() {
      throw forged;
    },
  });
  await assert.rejects(stageDraft(direct), (error: unknown) => {
    assert.ok(error instanceof XArticleStageSnapshotError);
    assert.equal(error.reason, "property_read_failed");
    assert.equal(error.savePhase, "save_not_attempted");
    assert.equal(error.saveMechanism, null);
    assert.ok(error.message.length < 1_000);
    assert.doesNotMatch(error.message, /PRIVATE_ARTICLE|data-secret|session-secret|\u001b|\0/);
    return true;
  });
});

test("unsafe active hrefs fail before loader while supported percent bytes remain exact", async () => {
  const base = await generateContent(
    "# Link policy\n\n[linked](https://example.com/safe)",
    { format: "article" },
  );
  const unsafe = [
    "javascript:alert(1)",
    "data:text/html,evil",
    " https://example.com/safe",
    "https://example.com/safe\n",
    "https://example.com/a\tb",
    "https://example.com/a\0b",
    "https://example.com/a\u007fb",
    "https://example.com/a b",
    "https://example.com/a\u00a0b",
    "https://example.com/a\u3000b",
    `https://example.com/\u202eevil`,
    `https://example.com/\ud800evil`,
    "https://user:secret@example.com/",
    "https://@example.com/",
    "https://:@example.com/",
    "https://example.com\\@evil.test/",
    "https:////example.com/normalized",
  ];

  for (const href of unsafe) {
    const content = cloneContent(base);
    firstLinkedRun(content).href = href;
    content.linkFlags[0].url = href;
    let loaderCalls = 0;
    const outcome = await executeXDraftRealRun(
      { content },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          return async () => assert.fail("staging must not run");
        },
      },
    );
    assert.equal(loaderCalls, 0, JSON.stringify(href));
    assert.equal(outcome.exitCode, 2, JSON.stringify(href));
    assert.equal(outcome.savePhase, "save_not_attempted", JSON.stringify(href));
    assert.match(outcome.message, /reason=unsafe_href/, JSON.stringify(href));
    assert.doesNotMatch(outcome.message, /javascript|data:text|user:secret|evil\.test/);
  }

  for (const exact of [
    "https://example.com/@owner/a%20b?q=@mail&case=One",
    "https://example.com/50%-off",
    "https://example.com/a%ZZ?q=%0A%09",
    "https://example.com/%E2%80%AEevil",
  ]) {
    const safe = cloneContent(base);
    firstLinkedRun(safe).href = exact;
    safe.linkFlags[0].url = exact;
    const snapshot = snapshotXArticleStageInput(safe, "article");
    assert.equal(firstLinkedRun(snapshot.content).href, exact);
    assert.equal(
      snapshot.html.includes(`href="${exact.replace(/&/g, "&amp;")}"`),
      true,
      exact,
    );
    const capture: ArticleCapture = { events: [] };
    const result = await stageArticleDraft(
      {} as BrowserContext,
      {} as Page,
      safe,
      undefined,
      articleDependencies(capture),
    );
    assert.equal(result.savePhase, "verified", exact);
    assert.equal(capture.html, snapshot.html, exact);
    assert.equal(capture.plain, snapshot.plain, exact);
  }
});

test("unsafe URL-looking advisories inside excluded code never become active anchors", async () => {
  const source = [
    "# Advisory-only code",
    "",
    "Visible [body](https://example.com/safe?q=ok).",
    "",
    "```txt",
    "https://user:secret@example.com/private",
    `https://example.com/\u202eadvisory`,
    "https://example.com/a%ZZ?q=%0A%09",
    "```",
  ].join("\n");
  const content = await generateContent(source, { format: "article" });
  assert.equal(content.linkFlags.length, 4);
  content.linkFlags.push({
    url: "javascript:advisory-only",
    note: "Advisory-only fixture; never an active editor anchor.",
  });

  const snapshot = snapshotXArticleStageInput(content, "article");
  assert.equal(
    snapshot.html,
    '<p>Visible <a href="https://example.com/safe?q=ok">body</a>.</p>',
  );
  assert.equal(snapshot.plain, "Visible body.");
  assert.equal(snapshot.codeBlockCount, 1);
  assert.doesNotMatch(
    `${snapshot.html}\n${snapshot.plain}`,
    /user:secret|advisory|a%ZZ|javascript/,
  );

  const capture: ArticleCapture = { events: [] };
  const result = await stageArticleDraft(
    {} as BrowserContext,
    {} as Page,
    content,
    undefined,
    articleDependencies(capture),
  );
  assert.equal(result.savePhase, "verified");
  assert.equal(result.saveMechanism, "article_create_autosave");
  if (result.saveMechanism !== "article_create_autosave") {
    assert.fail("expected the Article Create/autosave result variant");
  }
  assert.equal(result.articleHandoff.codeBlockCount, 1);
  assert.equal(
    capture.html,
    '<p>Visible <a href="https://example.com/safe?q=ok">body</a>.</p>',
  );
  assert.equal(capture.plain, "Visible body.");
});

test("direct and production Article entrypoints reject malformed input before platform work", async () => {
  const base = await generateContent("# Direct boundary\n\nBody", { format: "article" });

  const extra = cloneContent(base) as GeneratedContent & { tweet?: undefined };
  extra.tweet = undefined;
  const extraEvents: string[] = [];
  await expectDirectNotAttempted(extra, extraEvents);
  assert.deepEqual(extraEvents, []);

  const articleTransition = cloneContent(base);
  const safeArticle = articleTransition.article!;
  const mutatedArticle = {
    ...safeArticle,
    title: "MUTATED_DIRECT_TITLE",
    markdown: "MUTATED_DIRECT_BODY",
    blocks: [],
    codeBlockCount: 0,
  };
  let articleReads = 0;
  Object.defineProperty(articleTransition, "article", {
    enumerable: true,
    get() {
      articleReads += 1;
      return articleReads === 1 ? safeArticle : mutatedArticle;
    },
  });
  const articleTransitionEvents: string[] = [];
  await expectDirectNotAttempted(articleTransition, articleTransitionEvents);
  assert.equal(articleReads, 1);
  assert.deepEqual(articleTransitionEvents, []);

  const codeTransition = await generateContent(
    "# Direct code transition\n\n```ts\nSECRET_CODE_TRANSITION\n```",
    { format: "article" },
  );
  const codeBlock = codeTransition.article!.blocks.find((block) => block.kind === "code");
  assert.ok(codeBlock);
  let kindReads = 0;
  Object.defineProperty(codeBlock, "kind", {
    enumerable: true,
    get() {
      kindReads += 1;
      return kindReads === 1 ? "code" : "paragraph";
    },
  });
  const transitionEvents: string[] = [];
  await expectDirectNotAttempted(codeTransition, transitionEvents);
  assert.equal(kindReads, 1);
  assert.deepEqual(transitionEvents, []);

  const basePathEvents: string[] = [];
  await expectDirectNotAttempted(
    cloneContent(base),
    basePathEvents,
    new Proxy({}, {
      get() { throw new Error(RAW_CANARY); },
    }) as unknown as string,
  );
  assert.deepEqual(basePathEvents, []);

  let optionReads = 0;
  const options = Object.defineProperty({}, "basePath", {
    enumerable: true,
    get() {
      optionReads += 1;
      throw new Error(RAW_CANARY);
    },
  });
  await assert.rejects(
    stageDraft(cloneContent(base), options),
    (error: unknown) => {
      assert.ok(error instanceof XDraftStageError);
      assert.equal(error.savePhase, "save_not_attempted");
      assert.equal(error.saveMechanism, "article_create_autosave");
      assert.doesNotMatch(error.message, /PRIVATE_ARTICLE|data-secret|session-secret/);
      return true;
    },
  );
  assert.equal(optionReads, 1);
});

test("loader and awaited dependency mutation cannot change the staged Article tuple", async () => {
  for (const verified of [true, false]) {
    const original = await generateContent(
      "# Original title\n\nOriginal body with [link](https://example.com/original).\n\n```ts\nSECRET_CODE\n```",
      { format: "article" },
    );
    const expected = snapshotXArticleStageInput(original, "article");
    const capture: ArticleCapture = { events: [] };
    let loaderCalls = 0;

    const outcome = await executeXDraftRealRun(
      { content: original, inspect: true, basePath: "/tmp/original.md" },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          original.article!.title = "LOADER_MUTATED_TITLE";
          original.article!.markdown = "LOADER_MUTATED_MARKDOWN";
          firstLinkedRun(original).text = "LOADER_MUTATED_LINK_TEXT";
          return async (stageContent, options) => {
            assert.notEqual(stageContent, original);
            assert.equal(Object.isFrozen(stageContent), true);
            assert.equal(Object.isFrozen(stageContent.article), true);
            assert.equal(stageContent.article?.title, expected.title);
            assert.deepEqual(options, {
              inspect: true,
              basePath: "/tmp/original.md",
            });
            return stageArticleDraft(
              {} as BrowserContext,
              {} as Page,
              stageContent,
              options.basePath,
              articleDependencies(capture, {
                verified,
                async mutateAfterSnapshot() {
                  await Promise.resolve();
                  original.article!.title = "AWAIT_MUTATED_TITLE";
                  original.article!.blocks = [];
                  original.article!.codeBlockCount = 0;
                  original.codeFlags = [];
                  original.linkFlags = [];
                },
              }),
            );
          };
        },
      },
    );

    assert.equal(loaderCalls, 1);
    assert.equal(outcome.kind, verified ? "staged" : "save_incomplete");
    assert.equal(outcome.exitCode, verified ? 0 : 1);
    assert.equal(outcome.savePhase, verified ? "verified" : "save_delivered_unverified");
    assert.equal(outcome.articleHandoff?.codeBlockCount, 1);
    assert.equal(capture.title, expected.title);
    assert.equal(capture.html, expected.html);
    assert.equal(capture.plain, expected.plain);
    assert.equal(capture.coverBasePath, "/tmp/original.md");
    assert.deepEqual(capture.verify, {
      editUrl: "https://x.com/compose/articles/edit/12345",
      title: expected.title,
      body: expected.plain,
    });
    assert.doesNotMatch(`${capture.title}\n${capture.html}\n${capture.plain}`, /MUTATED|SECRET_CODE/);
  }
});

test("execute reads the caller content slot once before detaching the Article", async () => {
  const safe = await generateContent("# Slot title\n\nSlot body", { format: "article" });
  const mutated = await generateContent("# MUTATED SLOT TITLE\n\nMUTATED SLOT BODY", {
    format: "article",
  });
  let contentReads = 0;
  const input = Object.defineProperty({}, "content", {
    enumerable: true,
    get() {
      contentReads += 1;
      return contentReads === 1 ? safe : mutated;
    },
  }) as { content: GeneratedContent };
  const capture: ArticleCapture = { events: [] };

  const outcome = await executeXDraftRealRun(input, {
    async loadStageDraft() {
      return async (content) => stageArticleDraft(
        {} as BrowserContext,
        {} as Page,
        content,
        undefined,
        articleDependencies(capture),
      );
    },
  });

  assert.equal(contentReads, 1);
  assert.equal(outcome.exitCode, 0);
  assert.equal(capture.title, "Slot title");
  assert.equal(capture.plain, "Slot body");
  assert.doesNotMatch(`${capture.title}\n${capture.plain}`, /MUTATED SLOT/);
});

test("only an exact canonical Article edit URL can reach verification", async () => {
  const content = await generateContent("# URL boundary\n\nBody", { format: "article" });
  for (const editUrl of [
    "https://x.com/compose/articles/edit/12345?query=1",
    "https://x.com/compose/articles/edit/not-digits",
    "https://user@x.com/compose/articles/edit/12345",
    new String("https://x.com/compose/articles/edit/12345"),
  ]) {
    const capture: ArticleCapture = { events: [] };
    const result = await stageArticleDraft(
      {} as BrowserContext,
      {} as Page,
      cloneContent(content),
      undefined,
      articleDependencies(capture, { editUrl }),
    );
    assert.equal(result.savePhase, "save_delivered_unverified");
    assert.equal(capture.events.includes("edit:verify"), false);
  }
});

test("non-Article graphs are deeply detached before loader-time mutation", async () => {
  const hostileArticle = await generateContent("# Injected Article\n\nMUTATED ARTICLE BODY", {
    format: "article",
  });
  for (const format of ["tweet", "thread"] as const) {
    const original = await generateContent("Original transport text", { format });
    const nestedPayload = format === "tweet" ? original.tweet : original.thread;
    const expectedNestedPayload = structuredClone(nestedPayload);
    let loaderCalls = 0;
    let stageCalls = 0;
    let articleEvents = 0;
    const outcome = await executeXDraftRealRun(
      { content: original },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          delete original.tweet;
          delete original.thread;
          Object.assign(original, cloneContent(hostileArticle));
          return async (stageContent) => {
            stageCalls += 1;
            assert.notEqual(stageContent, original);
            assert.equal(Object.isFrozen(stageContent), true);
            assert.equal(stageContent.format, format);
            assert.equal("article" in stageContent, false);
            assert.notEqual(
              format === "tweet" ? stageContent.tweet : stageContent.thread,
              nestedPayload,
              "tweet/thread transport must not retain caller-owned identity",
            );
            assert.deepEqual(
              format === "tweet" ? stageContent.tweet : stageContent.thread,
              expectedNestedPayload,
            );
            if ((stageContent as GeneratedContent).format === "article") articleEvents += 1;
            throw new XDraftStageError("save_not_attempted", "composer_close_save");
          };
        },
      },
    );
    assert.equal(loaderCalls, 1);
    assert.equal(stageCalls, 1);
    assert.equal(articleEvents, 0);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.savePhase, "save_not_attempted");
  }
});

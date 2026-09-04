import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { executeXDraftRealRun } from "../commands/draft.js";
import { LocalValidationError } from "../capabilities/validation.js";
import { splitLeadingFrontmatter } from "../commands/contentInput.js";
import {
  generateContent,
  renderForInspection,
  renderXLinkFlag,
  type GeneratedContent,
} from "./content.js";
import {
  articleCodeAdvisoryRenderSize,
  articleCodeLinkAdvisoryRenderSize,
  articleMarkdownForTerminal,
  collectXArticleCodeLinkAdvisories,
  isTerminalSafeBoundedCodeEvidence,
  isArticleCodeBlockFlag,
  renderXArticleCodeLinkAdvisory,
  renderXArticleCodeAdvisory,
  sameXArticleCodeLinkAdvisories,
  snapshotXArticleCodeAdvisories,
  snapshotXArticleCodeLinkAdvisories,
  X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS,
  type ArticleCodeBlockFlag,
  type ArticleCodeLinkAdvisory,
} from "./codeAdvisory.js";
import { snapshotXArticleStageInput } from "./articleStageSnapshot.js";
import {
  snapshotXArticleDraftHandoff,
  xDraftRowEvidenceNotApplicable,
  type XArticleDraftHandoff,
} from "./saveProgress.js";
import type { StageDraftResult } from "./draftPoster.js";
import {
  X_ARTICLE_STAGE_TEXT_MAX_CODE_UNITS,
  xArticleStageCopiedTextCodeUnits,
} from "./articleStageTextBudget.js";

const TILDE_FENCE = "~".repeat(3);
const UNSAFE_TERMINAL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function firstArticleFlag(content: GeneratedContent): ArticleCodeBlockFlag {
  const flag = content.codeFlags[0];
  assert.ok(isArticleCodeBlockFlag(flag));
  return flag;
}

function missingCover(): XArticleDraftHandoff["cover"] {
  return {
    status: "missing",
    ratio: "not_observed",
    width: null,
    height: null,
    crop: "not_observed",
  };
}

async function rejected(source: string): Promise<LocalValidationError> {
  try {
    await generateContent(source, { format: "article" });
  } catch (error) {
    assert.ok(error instanceof LocalValidationError);
    assert.equal(error.problem.phase, "local");
    assert.match(error.message, /no artifact or native draft was created/i);
    assert.ok(error.message.length < 1_000);
    return error;
  }
  assert.fail("expected local Article rejection");
}

test("Article digest identifies the exact normalized fence slice across closure and line endings", async () => {
  const cases = [
    {
      name: "explicit backtick",
      source: "# T\n\n```js\nalpha\n```\t \nAfter",
      digestSource: "```js\nalpha\n```\t ",
      closure: "explicit" as const,
      fence: "backtick" as const,
      terminal: false,
      sourceLineCount: 3,
      text: "alpha",
    },
    {
      name: "EOF tilde without terminal LF",
      source: `# T\n\n${TILDE_FENCE}txt\nalpha`,
      digestSource: `${TILDE_FENCE}txt\nalpha`,
      closure: "end_of_input" as const,
      fence: "tilde" as const,
      terminal: false,
      sourceLineCount: 2,
      text: "alpha",
    },
    {
      name: "EOF tilde with terminal LF",
      source: `# T\n\n${TILDE_FENCE}txt\nalpha\n`,
      digestSource: `${TILDE_FENCE}txt\nalpha\n`,
      closure: "end_of_input" as const,
      fence: "tilde" as const,
      terminal: true,
      sourceLineCount: 2,
      text: "alpha\n",
    },
  ];

  for (const fixture of cases) {
    const generated = await generateContent(fixture.source, {
      format: "article",
      sourceLineOffset: 7,
    });
    const flag = firstArticleFlag(generated);
    assert.equal(flag.normalizedSourceSha256, sha256(fixture.digestSource), fixture.name);
    assert.equal(flag.digestNormalization, "lf_normalized_exact_fence_source");
    assert.equal(flag.closure, fixture.closure);
    assert.equal(flag.fence, fixture.fence);
    assert.equal(flag.sourceTerminalNewline, fixture.terminal);
    assert.equal(flag.sourceLineCount, fixture.sourceLineCount);
    assert.equal(flag.sourceLine, 10);
    assert.equal(flag.markdownStartLine, 3);
    assert.equal(flag.sourceEndLine, 10 + fixture.sourceLineCount - 1);
    assert.equal(flag.markdownEndLine, 3 + fixture.sourceLineCount - 1);
    assert.equal(
      generated.article?.blocks.find((block) => block.kind === "code")?.text,
      fixture.text,
    );
    assert.equal(snapshotXArticleStageInput(generated, "article").codeBlockCount, 1);
  }

  assert.notEqual(
    sha256(cases[1].digestSource),
    sha256(cases[2].digestSource),
    "a caller-owned EOF terminal LF is part of exact source identity",
  );

  const normalizedDigests: string[] = [];
  for (const newline of ["\n", "\r\n", "\r"]) {
    const source = ["# T", "", "```txt", "same", "```"].join(newline);
    const generated = await generateContent(source, { format: "article" });
    assert.equal(generated.article?.markdown, source.replace(/\r\n?/gu, "\n"));
    normalizedDigests.push(firstArticleFlag(generated).normalizedSourceSha256);
  }
  assert.equal(new Set(normalizedDigests).size, 1);
});

test("bounded Article info and preview keep escapes atomic and hidden tails digest-distinct", async () => {
  const info = `${"i".repeat(74)}\u001bINFO_HIDDEN_TAIL`;
  const preview = `${"p".repeat(115)}\u202ePREVIEW_HIDDEN_TAIL`;
  const source = `# Safe evidence\n\n\`\`\`${info}\n${preview}\nsecond\n\`\`\``;
  const generated = await generateContent(source, { format: "article" });
  const flag = firstArticleFlag(generated);
  assert.equal(Array.from(flag.infoString ?? "").length, 80);
  assert.equal(flag.infoString, `${"i".repeat(74)}\\u{1b}`);
  assert.equal(flag.lang, flag.infoString);
  assert.equal(flag.infoStringTruncated, true);
  assert.equal(flag.preview, "p".repeat(115));
  assert.equal(flag.previewTruncated, true);
  assert.doesNotMatch(flag.infoString ?? "", /\\u\{1?$/u);
  assert.doesNotMatch(flag.preview, /\\u(?:\{|\{202?)?$/u);
  assert.ok(isTerminalSafeBoundedCodeEvidence(flag.infoString ?? "", 80));
  assert.ok(isTerminalSafeBoundedCodeEvidence(flag.preview, 120));
  assert.doesNotMatch(JSON.stringify(flag), UNSAFE_TERMINAL);

  const inspection = renderForInspection(generated);
  assert.match(inspection, /code block #1 excluded from terminal preview/i);
  assert.match(inspection, /infoString|info=/i);
  assert.match(inspection, /truncated=true/);
  assert.match(inspection, new RegExp(flag.normalizedSourceSha256));
  assert.doesNotMatch(inspection, /INFO_HIDDEN_TAIL|PREVIEW_HIDDEN_TAIL|\u001b|\u202e/);
  assert.equal(generated.article?.markdown, source);
  assert.equal(
    generated.article?.blocks.find((block) => block.kind === "code")?.text,
    `${preview}\nsecond`,
  );

  const prefix = "x".repeat(120);
  const first = await generateContent(`# T\n\n\`\`\`txt\n${prefix}FIRST_HIDDEN`, {
    format: "article",
  });
  const second = await generateContent(`# T\n\n\`\`\`txt\n${prefix}SECOND_HIDDEN`, {
    format: "article",
  });
  const firstFlag = firstArticleFlag(first);
  const secondFlag = firstArticleFlag(second);
  assert.equal(firstFlag.preview, secondFlag.preview);
  assert.equal(firstFlag.previewTruncated, true);
  assert.notEqual(
    firstFlag.normalizedSourceSha256,
    secondFlag.normalizedSourceSha256,
  );
});

test("Article projections visibly encode representative Cc, Cf, Zl, Zp, and bidi scalars", async () => {
  const rawInfo = "lang\u0007\u009b\u061c\u2066\u2069\ufeff\u2028\u2029";
  const rawPreview = "value\u0001\u200f\u202a\u202c\u202e\u2029end";
  const source = `# Categories\n\n\`\`\`${rawInfo}\n${rawPreview}\n\`\`\``;
  const content = await generateContent(source, { format: "article" });
  const flag = firstArticleFlag(content);
  assert.equal(
    flag.infoString,
    "lang\\u{07}\\u{9b}\\u{61c}\\u{2066}\\u{2069}\\u{feff}\\u{2028}\\u{2029}",
  );
  assert.equal(
    flag.preview,
    "value\\u{01}\\u{200f}\\u{202a}\\u{202c}\\u{202e}\\u{2029}end",
  );
  assert.equal(flag.infoStringTruncated, false);
  assert.equal(flag.previewTruncated, false);
  const rendered = renderForInspection(content);
  for (const escape of [
    "\\u{07}",
    "\\u{9b}",
    "\\u{61c}",
    "\\u{2066}",
    "\\u{2069}",
    "\\u{feff}",
    "\\u{2028}",
    "\\u{2029}",
    "\\u{200f}",
    "\\u{202a}",
    "\\u{202c}",
    "\\u{202e}",
  ]) assert.ok(rendered.includes(escape), escape);
  assert.doesNotMatch(
    JSON.stringify(flag) + rendered,
    /[\u0001\u0007\u009b\u061c\u200f\u2028\u2029\u202a\u202c\u202e\u2066\u2069\ufeff]/u,
  );
  assert.equal(content.article?.markdown, source);
  assert.equal(
    content.article?.blocks.find((block) => block.kind === "code")?.text,
    rawPreview,
  );
});

test("Article evidence rejects lone surrogates before hashing and accepts paired astral scalars", async () => {
  for (const source of [
    `# T\n\n\`\`\`bad\ud800info\npayload\n\`\`\``,
    `# T\n\n${TILDE_FENCE}txt\npayload\udc00`,
  ]) {
    const error = await rejected(source);
    assert.equal(error.problem.code, "x_article_code_advisory_unrepresentable");
    assert.doesNotMatch(error.message, /\ud800|\udc00|payload/);
  }

  const replacement = await generateContent(
    "# T\n\n```txt\n\ufffd",
    { format: "article" },
  );
  const astralInfo = `${"a".repeat(79)}\ud83d\ude00`;
  const astral = await generateContent(
    `# T\n\n\`\`\`${astralInfo}\n\ud83d\ude00\n\`\`\``,
    { format: "article" },
  );
  const replacementFlag = firstArticleFlag(replacement);
  const astralFlag = firstArticleFlag(astral);
  assert.equal(Array.from(astralFlag.infoString ?? "").length, 80);
  assert.equal(astralFlag.infoStringTruncated, false);
  assert.equal(astralFlag.preview, "\ud83d\ude00");
  assert.notEqual(
    replacementFlag.normalizedSourceSha256,
    astralFlag.normalizedSourceSha256,
  );
});

test("mapping-frontmatter offsets and canonical code bytes stay exact while advisories stay safe", async () => {
  const input = [
    "---",
    "owner: operator",
    "---",
    "# Offset title",
    "",
    `${TILDE_FENCE}txt`,
    " exact  ",
    TILDE_FENCE,
  ].join("\r\n");
  const split = splitLeadingFrontmatter(input, "offset.md", {
    policy: "mapping-only",
    preserveBodyLineEndings: true,
  });
  const generated = await generateContent(split.body, {
    format: "article",
    sourceLineOffset: split.bodyLineOffset,
  });
  assert.equal(generated.article?.markdown, split.body.replace(/\r\n?/gu, "\n"));
  const flag = firstArticleFlag(generated);
  assert.equal(flag.sourceLine, 6);
  assert.equal(flag.markdownStartLine, 3);
  assert.equal(
    generated.article?.blocks.find((block) => block.kind === "code")?.text,
    " exact  ",
  );
  assert.doesNotThrow(() => snapshotXArticleStageInput(generated, "article"));
});

test("code-derived links carry bounded provenance without suppressing exact active hrefs", async () => {
  const active = "https://same.example/exact?q=x%20y";
  const longUrl = `https://code.example/${"u".repeat(500)}\u001bURL_HIDDEN_TAIL`;
  const longLabel = `${"L".repeat(235)}\u202eLABEL_HIDDEN_TAIL`;
  const source = [
    "# Link evidence",
    "",
    `Visible [active](${active}).`,
    "",
    `\`\`\`${active}`,
    `[${longLabel}](${longUrl})`,
    "```",
  ].join("\n");
  const generated = await generateContent(source, { format: "article" });
  assert.deepEqual(generated.linkFlags[0], {
    url: active,
    text: "active",
    note: "Links cost reach — keep this OUT of the opening tweet; move it to a reply or the end of the thread.",
  });
  const codeLinks = generated.linkFlags.filter(
    (flag) => flag.advisorySource === "excluded_article_code",
  );
  assert.equal(codeLinks.length, 2);
  assert.equal(codeLinks[0]?.codeBlockIndex, 1);
  assert.equal(codeLinks[0]?.urlTruncated, true);
  assert.equal(codeLinks[0]?.textTruncated, true);
  assert.equal(Array.from(codeLinks[0]?.url ?? "").length <= 512, true);
  assert.equal(Array.from(codeLinks[0]?.text ?? "").length <= 240, true);
  assert.equal(codeLinks[1]?.url, active);
  for (const advisory of codeLinks) {
    assert.doesNotMatch(advisory.url, UNSAFE_TERMINAL);
    assert.doesNotMatch(advisory.text ?? "", UNSAFE_TERMINAL);
    assert.doesNotMatch(renderXArticleCodeLinkAdvisory(advisory), UNSAFE_TERMINAL);
  }
  const snapshot = snapshotXArticleStageInput(generated, "article");
  assert.deepEqual(snapshot.codeLinkAdvisories, codeLinks);
  assert.equal(
    snapshot.html,
    `<p>Visible <a href="${active}">active</a>.</p>`,
  );
  const inspection = renderForInspection(generated);
  assert.doesNotMatch(inspection, /URL_HIDDEN_TAIL|LABEL_HIDDEN_TAIL|\u001b|\u202e/);
});

test("excluded-code link identity rejects a present undefined text key before staging", async () => {
  const content = await generateContent(
    "# Closed optional key\n\n```txt\nhttps://bare.example/exact\n```",
    { format: "article" },
  );
  const generatedLink = content.linkFlags.find(
    (flag) => flag.advisorySource === "excluded_article_code",
  );
  assert.ok(generatedLink);
  assert.equal(Object.prototype.hasOwnProperty.call(generatedLink, "text"), false);
  const canonicalSnapshot = snapshotXArticleStageInput(content, "article");
  const canonicalHandoff: XArticleDraftHandoff = {
    body: "rich_html",
    codeBlockCount: canonicalSnapshot.receiptCodeBlockCount,
    codeAdvisories: canonicalSnapshot.codeAdvisories,
    codeLinkAdvisories: canonicalSnapshot.codeLinkAdvisories,
    cover: missingCover(),
  };

  const hostile = structuredClone(content) as GeneratedContent;
  const hostileLink = hostile.linkFlags.find(
    (flag) => flag.advisorySource === "excluded_article_code",
  );
  assert.ok(hostileLink);
  Object.defineProperty(hostileLink, "text", {
    value: undefined,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(hostileLink, "text"), true);
  assert.equal(
    sameXArticleCodeLinkAdvisories(
      [generatedLink as ArticleCodeLinkAdvisory],
      [hostileLink as ArticleCodeLinkAdvisory],
    ),
    false,
  );
  assert.throws(() => snapshotXArticleStageInput(hostile, "article"));

  let loaderCalls = 0;
  const outcome = await executeXDraftRealRun(
    { content: hostile },
    {
      async loadStageDraft() {
        loaderCalls += 1;
        return async (): Promise<StageDraftResult> => ({
          format: "article",
          posts: 1,
          saveMechanism: "article_create_autosave",
          savePhase: "verified",
          draftRowEvidence: xDraftRowEvidenceNotApplicable(),
          articleHandoff: canonicalHandoff,
          note: "unreachable verified result",
        });
      },
    },
  );
  assert.equal(loaderCalls, 0);
  assert.equal(outcome.kind, "save_incomplete");
  assert.equal(outcome.savePhase, "save_not_attempted");
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.articleHandoff, null);
  assert.match(outcome.message, /snapshot validation failed closed/i);
  assert.doesNotMatch(
    outcome.message,
    /persistence verified|CODE LINK ADVISORY|bare\.example/i,
  );

  const receipt = renderForInspection(hostile);
  assert.match(receipt, /inspection failed closed/i);
  assert.doesNotMatch(receipt, /bare\.example|CODE LINK ADVISORY/);
});

test("identical excluded-code links retain each source block provenance", async () => {
  const exact = "https://same-code.example/exact";
  const content = await generateContent(
    [
      "# Block provenance",
      "",
      "```txt",
      exact,
      exact,
      "```",
      "",
      "~~~txt",
      exact,
      "~~~",
    ].join("\n"),
    { format: "article" },
  );
  const links = content.linkFlags.filter(
    (flag): flag is ArticleCodeLinkAdvisory =>
      flag.advisorySource === "excluded_article_code",
  );
  assert.deepEqual(links.map((flag) => flag.codeBlockIndex), [1, 2]);
  assert.deepEqual(links.map((flag) => flag.url), [exact, exact]);
  assert.deepEqual(
    snapshotXArticleStageInput(content, "article").codeLinkAdvisories,
    links,
  );
});

test("excluded-code link scanning accepts one million unmatched brackets without candidates", async () => {
  const brackets = "[".repeat(1_000_000);
  const content = await generateContent(
    `# Linear scanner\n\n\`\`\`txt\n${brackets}\n\`\`\``,
    { format: "article" },
  );
  assert.equal(
    content.linkFlags.filter(
      (flag) => flag.advisorySource === "excluded_article_code",
    ).length,
    0,
  );
  assert.equal(
    content.article?.blocks.find((block) => block.kind === "code")?.text.length,
    1_000_000,
  );
  assert.doesNotThrow(() => snapshotXArticleStageInput(content, "article"));
});

test("linear code-link scanner preserves Markdown-first and bare-URL candidate semantics", () => {
  const source = [
    "[first](https://first.example/a)",
    "[[nested](http://nested.example/b)",
    "[](https://empty.example/c)",
    "[label with",
    "newline](https://multiline.example/d)",
    "[invalid](https://invalid.example/has space)",
    '"https://quoted.example/no',
    "(https://parenthesized.example/no",
    "joinedhttps://word.example/no",
    "bare https://bare.example/e.,",
  ].join("\n");
  const advisories = collectXArticleCodeLinkAdvisories([{
    codeBlockIndex: 1,
    infoString: "",
    codeText: source,
  }]);
  assert.ok(advisories);
  assert.deepEqual(
    advisories.map((advisory) => [
      advisory.url,
      Object.prototype.hasOwnProperty.call(advisory, "text")
        ? advisory.text
        : null,
    ]),
    [
      ["https://first.example/a", "first"],
      ["http://nested.example/b", "[nested"],
      ["https://empty.example/c", null],
      ["https://multiline.example/d", "label with\\u{0a}newline"],
      ["https://bare.example/e", null],
    ],
  );

  const overCap = collectXArticleCodeLinkAdvisories([{
    codeBlockIndex: 1,
    infoString: "",
    codeText: Array.from(
      { length: 50_001 },
      (_, index) => `https://cap.example/${index}`,
    ).join(" "),
  }]);
  assert.equal(overCap, null);
});

test("canonical Article link flags reject extra, omitted, reordered, or changed advisories", async () => {
  const content = await generateContent(
    [
      "# Complete links",
      "",
      "Visible [active](https://active.example/exact).",
      "",
      "```txt",
      "[code](https://code.example/exact)",
      "```",
    ].join("\n"),
    { format: "article" },
  );
  assert.equal(content.linkFlags.length, 2);

  const safeExtra = structuredClone(content) as GeneratedContent;
  safeExtra.linkFlags.unshift({
    url: "https://extra.example/benign",
    text: "benign",
    note: "benign extra advisory",
  });
  const omitted = structuredClone(content) as GeneratedContent;
  omitted.linkFlags.pop();
  const reordered = structuredClone(content) as GeneratedContent;
  reordered.linkFlags.reverse();
  const changed = structuredClone(content) as GeneratedContent;
  changed.linkFlags[0] = {
    ...changed.linkFlags[0],
    note: "changed canonical advisory",
  };
  for (const candidate of [safeExtra, omitted, reordered, changed]) {
    assert.throws(() => snapshotXArticleStageInput(candidate, "article"));
  }

  const hostile = structuredClone(content) as GeneratedContent;
  hostile.linkFlags.unshift({
    url: "https://forged.example/RAW_URL_\u001b[31m",
    text: "RAW_TEXT_\u0007\nSECOND_LINE",
    note: "RAW_NOTE_\u001b\nFORGED_NOTE_LINE",
  });
  assert.throws(() => snapshotXArticleStageInput(hostile, "article"));
  const receipt = renderForInspection(hostile);
  assert.match(receipt, /inspection failed closed/i);
  assert.doesNotMatch(
    receipt,
    /RAW_URL|RAW_TEXT|SECOND_LINE|RAW_NOTE|FORGED_NOTE_LINE|\u001b|\u0007/,
  );

  let loaderCalls = 0;
  const outcome = await executeXDraftRealRun(
    { content: hostile },
    {
      async loadStageDraft() {
        loaderCalls += 1;
        throw new Error("FORGED_LINK_LOADER_CANARY");
      },
    },
  );
  assert.equal(loaderCalls, 0);
  assert.equal(outcome.kind, "save_incomplete");
  assert.equal(outcome.savePhase, "save_not_attempted");
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.articleHandoff, null);
  assert.match(outcome.message, /snapshot validation failed closed/i);
  assert.doesNotMatch(
    outcome.message,
    /RAW_URL|RAW_TEXT|SECOND_LINE|RAW_NOTE|FORGED_NOTE_LINE|FORGED_LINK_LOADER_CANARY|\u001b|\u0007/,
  );
});

test("code-link tuple dedupe cannot collide across raw URL and label boundaries", () => {
  const advisories = collectXArticleCodeLinkAdvisories([{
    codeBlockIndex: 1,
    infoString: "",
    codeText:
      "[c](https://x.example/a\u0000b)\n" +
      "[b\u0000c](https://x.example/a)",
  }]);
  assert.ok(advisories);
  assert.equal(advisories.length, 2);
  assert.deepEqual(
    advisories.map((advisory) => [advisory.url, advisory.text]),
    [
      ["https://x.example/a\\u{00}b", "c"],
      ["https://x.example/a", "b\\u{00}c"],
    ],
  );
  for (const advisory of advisories) {
    assert.doesNotMatch(advisory.url, UNSAFE_TERMINAL);
    assert.doesNotMatch(advisory.text ?? "", UNSAFE_TERMINAL);
  }
});

test("verified and returned-unverified receipts reuse frozen code and code-link evidence", async () => {
  const longUrl = `https://receipt.example/${"r".repeat(600)}URL_RECEIPT_HIDDEN`;
  const longLabel = `${"L".repeat(250)}LABEL_RECEIPT_HIDDEN`;
  const content = await generateContent(
    `# Receipt\n\n\`\`\`${"i".repeat(90)}\n[${longLabel}](${longUrl})\n\`\`\``,
    { format: "article" },
  );
  const snapshot = snapshotXArticleStageInput(content, "article");
  const handoff: XArticleDraftHandoff = {
    body: "rich_html",
    codeBlockCount: snapshot.receiptCodeBlockCount,
    codeAdvisories: snapshot.codeAdvisories,
    codeLinkAdvisories: snapshot.codeLinkAdvisories,
    cover: missingCover(),
  };
  assert.ok(snapshotXArticleDraftHandoff(handoff));
  for (const phase of ["verified", "save_delivered_unverified"] as const) {
    const returned: StageDraftResult = {
      format: "article",
      posts: 1,
      saveMechanism: "article_create_autosave",
      savePhase: phase,
      draftRowEvidence: xDraftRowEvidenceNotApplicable(),
      articleHandoff: handoff,
      note: "ignored",
    };
    const outcome = await executeXDraftRealRun(
      { content },
      { async loadStageDraft() { return async () => returned; } },
    );
    assert.equal(outcome.kind, phase === "verified" ? "staged" : "save_incomplete");
    assert.match(outcome.message, /LF-normalized exact fence source sha256=[a-f0-9]{64}/);
    assert.match(outcome.message, /info=.*truncated=true/);
    assert.match(outcome.message, /CODE LINK ADVISORY block=1/);
    assert.match(outcome.message, /url=.*truncated=true/);
    assert.match(outcome.message, /text=.*truncated=true/);
    assert.doesNotMatch(outcome.message, /URL_RECEIPT_HIDDEN|LABEL_RECEIPT_HIDDEN/);
    assert.deepEqual(outcome.articleHandoff?.codeAdvisories, snapshot.codeAdvisories);
    assert.deepEqual(
      outcome.articleHandoff?.codeLinkAdvisories,
      snapshot.codeLinkAdvisories,
    );
  }
});

test("returned Article handoff arrays cannot forge or leak code-derived evidence", async () => {
  const content = await generateContent(
    "# Returned evidence\n\n```txt\n[label](https://handoff.example/exact)\n```",
    { format: "article" },
  );
  const snapshot = snapshotXArticleStageInput(content, "article");
  const valid: XArticleDraftHandoff = {
    body: "rich_html",
    codeBlockCount: snapshot.receiptCodeBlockCount,
    codeAdvisories: snapshot.codeAdvisories,
    codeLinkAdvisories: snapshot.codeLinkAdvisories,
    cover: missingCover(),
  };
  const returned = (articleHandoff: unknown): StageDraftResult => ({
    format: "article",
    posts: 1,
    saveMechanism: "article_create_autosave",
    savePhase: "verified",
    draftRowEvidence: xDraftRowEvidenceNotApplicable(),
    articleHandoff: articleHandoff as XArticleDraftHandoff,
    note: "ignored",
  });
  const expectUnknown = async (articleHandoff: unknown): Promise<void> => {
    const outcome = await executeXDraftRealRun(
      { content },
      { async loadStageDraft() { return async () => returned(articleHandoff); } },
    );
    assert.equal(outcome.kind, "save_incomplete");
    assert.equal(outcome.savePhase, "save_delivery_unknown");
    assert.equal(outcome.articleHandoff, null);
    assert.doesNotMatch(
      outcome.message,
      /HANDOFF_ARRAY_PRIVATE_CANARY|RETURNED_OVERSIZED_PRIVATE_CANARY|CODE BLOCK|CODE LINK|sha256|handoff\.example/,
    );
  };

  const differentDigest: XArticleDraftHandoff = {
    ...structuredClone(valid),
    codeAdvisories: valid.codeAdvisories.map((advisory, index) => index === 0
      ? { ...advisory, normalizedSourceSha256: "0".repeat(64) }
      : advisory),
  };
  await expectUnknown(differentDigest);

  const differentLink: XArticleDraftHandoff = {
    ...structuredClone(valid),
    codeLinkAdvisories: valid.codeLinkAdvisories.map((advisory, index) => index === 0
      ? {
          ...advisory,
          url: "https://handoff.example/different",
          text: "different safe label",
        }
      : advisory),
  };
  await expectUnknown(differentLink);

  const oversized = "RETURNED_OVERSIZED_PRIVATE_CANARY_".repeat(8_000);
  const oversizedCases: Array<(candidate: Record<string, unknown>) => void> = [
    (candidate) => {
      const flags = candidate.codeAdvisories as Array<Record<string, unknown>>;
      flags[0].preview = oversized;
    },
    (candidate) => {
      const flags = candidate.codeAdvisories as Array<Record<string, unknown>>;
      flags[0].lang = oversized;
      flags[0].infoString = oversized;
    },
    (candidate) => {
      const flags = candidate.codeAdvisories as Array<Record<string, unknown>>;
      flags[0].normalizedSourceSha256 = "a".repeat(oversized.length);
    },
    (candidate) => {
      const flags = candidate.codeLinkAdvisories as Array<Record<string, unknown>>;
      flags[0].url = `https://oversized.example/${oversized}`;
    },
    (candidate) => {
      const flags = candidate.codeLinkAdvisories as Array<Record<string, unknown>>;
      flags[0].text = oversized;
    },
    (candidate) => {
      const flags = candidate.codeLinkAdvisories as Array<Record<string, unknown>>;
      flags[0].note = oversized;
    },
    (candidate) => {
      const flags = candidate.codeLinkAdvisories as Array<Record<string, unknown>>;
      flags[0].advisorySource = oversized;
    },
  ];
  for (const mutate of oversizedCases) {
    const candidate = structuredClone(valid) as unknown as Record<string, unknown>;
    mutate(candidate);
    await expectUnknown(candidate);
  }

  for (const field of ["codeAdvisories", "codeLinkAdvisories"] as const) {
    {
      let reads = 0;
      const candidate = structuredClone(valid) as unknown as Record<string, unknown>;
      const source = candidate[field] as unknown[];
      candidate[field] = new Proxy(source, {
        get() {
          reads += 1;
          throw new Error("HANDOFF_ARRAY_PRIVATE_CANARY");
        },
      });
      await expectUnknown(candidate);
      assert.equal(reads, 0, `${field} proxy trap`);
    }
    {
      const candidate = structuredClone(valid) as unknown as Record<string, unknown>;
      const source = candidate[field] as unknown[];
      const revoked = Proxy.revocable(source, {});
      candidate[field] = revoked.proxy;
      revoked.revoke();
      await expectUnknown(candidate);
    }
    {
      let reads = 0;
      const candidate = structuredClone(valid) as unknown as Record<string, unknown>;
      const source = candidate[field] as unknown[];
      const entry = source[0];
      Object.defineProperty(source, "0", {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error("HANDOFF_ARRAY_PRIVATE_CANARY");
        },
      });
      await expectUnknown(candidate);
      assert.equal(reads, 0, `${field} index accessor`);
      assert.ok(entry);
    }
    {
      const candidate = structuredClone(valid) as unknown as Record<string, unknown>;
      const source = candidate[field] as unknown[] & Record<string, unknown>;
      source.HANDOFF_ARRAY_PRIVATE_CANARY = "hidden";
      await expectUnknown(candidate);
    }
  }
});

test("advisory count and aggregate output overflow reject locally with complete facts", async () => {
  const aggregateSource = "# T\n" + Array.from(
    { length: 2_500 },
    () => "\n```\n```\n",
  ).join("");
  const aggregate = await rejected(aggregateSource);
  assert.equal(aggregate.problem.code, "x_article_code_advisory_oversized");
  assert.match(String(aggregate.problem.actual), /receipt exceeds the local output bound/);

  const countSource = "# T\n" + Array.from(
    { length: 10_001 },
    () => "\n```\n```\n",
  ).join("");
  const count = await rejected(countSource);
  assert.equal(count.problem.code, "x_article_code_advisory_oversized");
  assert.match(String(count.problem.actual), /too many complete fenced-code advisories/);

  assert.equal(X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS, 1_000_000);
});

test("generation and snapshot share the exact 20M copied-text budget", async () => {
  const sourceWithLineLength = (length: number): string =>
    "# T\n" + Array.from(
      { length: 10 },
      () => `\n\`\`\`\n${"a".repeat(length)}\n\`\`\`\n`,
    ).join("");

  const rejectedAtSnapshotTotal = await rejected(sourceWithLineLength(999_934));
  assert.equal(rejectedAtSnapshotTotal.problem.code, "x_article_structure_oversized");
  assert.match(
    String(rejectedAtSnapshotTotal.problem.actual),
    /structured text exceeds the local aggregate bound/,
  );

  const accepted = await generateContent(sourceWithLineLength(999_902), {
    format: "article",
  });
  assert.ok(accepted.article);
  const copiedTextCodeUnits = xArticleStageCopiedTextCodeUnits({
    title: accepted.article.title,
    markdown: accepted.article.markdown,
    blocks: accepted.article.blocks,
    codeFlags: accepted.codeFlags as ArticleCodeBlockFlag[],
    linkFlags: accepted.linkFlags,
    warnings: accepted.warnings,
  });
  assert.equal(X_ARTICLE_STAGE_TEXT_MAX_CODE_UNITS, 20_000_000);
  assert.equal(copiedTextCodeUnits, 19_999_985);
  assert.doesNotThrow(() => snapshotXArticleStageInput(accepted, "article"));
});

test("aggregate sizing matches the largest framed human advisory lines at the cap", async () => {
  const generated = await generateContent("# Bound\n\n```txt\nvalue\n```", {
    format: "article",
  });
  const base = firstArticleFlag(generated);
  const accepted: ArticleCodeBlockFlag[] = [];
  let acceptedSize = 0;
  let overflow: ArticleCodeBlockFlag | null = null;
  for (let index = 1; index <= 10_000; index += 1) {
    const sourceLine = 3 + (index - 1) * 3;
    const flag: ArticleCodeBlockFlag = {
      ...base,
      index,
      sourceLine,
      sourceEndLine: sourceLine + 2,
      markdownStartLine: sourceLine,
      markdownEndLine: sourceLine + 2,
    };
    const framedLineSize = `  ${renderXArticleCodeAdvisory(flag)}\n`.length;
    if (acceptedSize + framedLineSize > X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS) {
      overflow = flag;
      break;
    }
    accepted.push(flag);
    acceptedSize += framedLineSize;
  }
  assert.ok(overflow);
  const rejected = [...accepted, overflow];
  const actualAcceptedDetails = accepted
    .map((flag) => `  ${renderXArticleCodeAdvisory(flag)}\n`)
    .join("");
  const actualRejectedDetails = rejected
    .map((flag) => `  ${renderXArticleCodeAdvisory(flag)}\n`)
    .join("");
  assert.equal(articleCodeAdvisoryRenderSize(accepted), actualAcceptedDetails.length);
  assert.equal(articleCodeAdvisoryRenderSize(rejected), actualRejectedDetails.length);
  assert.ok(actualAcceptedDetails.length <= X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS);
  assert.ok(actualRejectedDetails.length > X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS);
  assert.ok(snapshotXArticleCodeAdvisories(accepted));
  assert.equal(snapshotXArticleCodeAdvisories(rejected), null);

  const codeLinks = generated.linkFlags.filter(
    (flag): flag is ArticleCodeLinkAdvisory =>
      flag.advisorySource === "excluded_article_code",
  );
  assert.equal(codeLinks.length, 0);
  const projectedLinks = collectXArticleCodeLinkAdvisories([{
    codeBlockIndex: 1,
    infoString: "",
    codeText: "https://bound.example/exact",
  }]);
  assert.ok(projectedLinks);
  const actualLinkDetails = projectedLinks
    .map((flag) => `${renderXArticleCodeLinkAdvisory(flag)}\n`)
    .join("");
  assert.match(actualLinkDetails, /^  CODE LINK ADVISORY/);
  assert.equal(articleCodeLinkAdvisoryRenderSize(projectedLinks), actualLinkDetails.length);
});

test("large blank-line Article inspection redacts code without variadic overflow", async () => {
  const blankRun = "\n".repeat(200_000);
  const prefix = `# Large inspection\n\nBefore${blankRun}`;
  const fenced =
    "```txt\nbounded-preview\nRAW_LARGE_CODE_CANARY\nRAW_SECOND_CODE_CANARY\n```";
  const suffix = `${blankRun}After`;
  const source = `${prefix}${fenced}${suffix}`;
  const content = await generateContent(source, { format: "article" });
  const flag = firstArticleFlag(content);
  const marker =
    `[X Article code block #1 excluded from terminal preview; ` +
    `sha256=${flag.normalizedSourceSha256}]`;
  const expectedTerminalMarkdown = `${prefix}${marker}${suffix}`;

  let terminalMarkdown = "";
  assert.doesNotThrow(() => {
    terminalMarkdown = articleMarkdownForTerminal(source, [flag]);
  });
  assert.equal(terminalMarkdown, expectedTerminalMarkdown);
  assert.doesNotMatch(terminalMarkdown, /```txt|RAW_LARGE_CODE_CANARY|RAW_SECOND_CODE_CANARY/);

  let inspection = "";
  assert.doesNotThrow(() => {
    inspection = renderForInspection(content);
  });
  assert.match(inspection, /── article: Large inspection ──/);
  assert.match(inspection, /terminal projection truncated/);
  assert.match(inspection, /originalUtf16CodeUnits=/);
  assert.match(inspection, /digestNormalization=none/);
  assert.match(inspection, new RegExp(`LF-normalized exact fence source sha256=${flag.normalizedSourceSha256}`));
  assert.ok(inspection.length < 100_000, `inspection was not bounded: ${inspection.length}`);
  assert.doesNotMatch(
    inspection,
    /```txt|RAW_LARGE_CODE_CANARY|RAW_SECOND_CODE_CANARY|RangeError|Maximum call stack|\/Users\//,
  );
});

test("revoked proxies and forged code-derived advisory render inputs fail closed", async () => {
  const first = Proxy.revocable([], {});
  first.revoke();
  assert.doesNotThrow(() => snapshotXArticleCodeAdvisories(first.proxy));
  assert.equal(snapshotXArticleCodeAdvisories(first.proxy), null);

  const second = Proxy.revocable([], {});
  second.revoke();
  assert.doesNotThrow(() => snapshotXArticleCodeLinkAdvisories(second.proxy));
  assert.equal(snapshotXArticleCodeLinkAdvisories(second.proxy), null);

  const forged = {
    url: "RAW_FORGED_\u001b[31m",
    text: "RAW_LABEL_\u202e",
    note: "RAW_NOTE",
    advisorySource: "excluded_article_code" as const,
    codeBlockIndex: 1,
    urlTruncated: false,
    textTruncated: false,
  };
  const rendered = renderXLinkFlag(forged);
  assert.match(rendered, /failed closed/i);
  assert.doesNotMatch(rendered, /RAW_FORGED|RAW_LABEL|RAW_NOTE|\u001b|\u202e/);

  const content = await generateContent("# T\n\n```txt\nSAFE", { format: "article" });
  const hostile = structuredClone(content) as GeneratedContent;
  const revoked = Proxy.revocable([], {});
  hostile.codeFlags = revoked.proxy as GeneratedContent["codeFlags"];
  revoked.revoke();
  const inspection = renderForInspection(hostile);
  assert.match(inspection, /failed closed/i);
  assert.doesNotMatch(inspection, /SAFE/);
});

test("strict advisory and handoff validators reject impossible explicit-fence facts", async () => {
  const content = await generateContent("# T\n\n```txt\nvalue\n```", {
    format: "article",
  });
  const snapshot = snapshotXArticleStageInput(content, "article");
  const validFlag = structuredClone(snapshot.codeAdvisories[0]);
  const impossible = [
    { ...validFlag, sourceTerminalNewline: true },
    {
      ...validFlag,
      sourceEndLine: validFlag.sourceLine,
      sourceLineCount: 1,
      markdownEndLine: validFlag.markdownStartLine,
    },
  ];
  for (const flag of impossible) {
    assert.equal(isArticleCodeBlockFlag(flag), false);
    assert.equal(snapshotXArticleCodeAdvisories([flag]), null);
    assert.equal(snapshotXArticleDraftHandoff({
      body: "rich_html",
      codeBlockCount: 1,
      codeAdvisories: [flag],
      codeLinkAdvisories: [],
      cover: missingCover(),
    }), null);
  }
});

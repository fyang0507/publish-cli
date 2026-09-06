import test from "node:test";
import assert from "node:assert/strict";
import { errors, type Locator, type Page } from "playwright";
import { splitLeadingFrontmatter } from "../commands/contentInput.js";
import {
  classifyRedditStageResult,
  receiptForRedditStageOutcome,
} from "../commands/reddit-draft.js";
import { LocalValidationError } from "../capabilities/validation.js";
import {
  generateSelfPost,
  validateRedditFrontmatter,
  type RedditFrontmatter,
} from "./content.js";
import {
  describeRedditSaveAttempt,
  inspectRedditSaveValidation,
  saveDraftReddit,
  type RedditSaveDiagnostic,
  type StageDraftResult,
} from "./draftPoster.js";

function expectLocalProblem(
  fn: () => unknown,
  expected: { code: string; actual?: string | number | null; expected?: string },
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof LocalValidationError);
    assert.equal(error.problem.code, expected.code);
    if ("actual" in expected) assert.equal(error.problem.actual, expected.actual);
    if (expected.expected) assert.match(error.problem.expected, new RegExp(expected.expected));
    assert.equal(error.problem.phase, "local");
    return true;
  });
}

test("mapping-only frontmatter recognizes BOM and every line ending", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const source =
      `\ufeff---${newline}` +
      `subreddit: from-file${newline}` +
      `title: From file${newline}` +
      `flair: Discussion${newline}` +
      `---${newline}Body${newline}`;
    assert.deepEqual(
      splitLeadingFrontmatter(source, "post.md", { policy: "mapping-only" }),
      {
        body: "Body\n",
        data: { subreddit: "from-file", title: "From file", flair: "Discussion" },
        present: true,
        bodyLineOffset: 5,
      },
    );
    assert.equal(
      splitLeadingFrontmatter(source, "post.md", {
        policy: "mapping-only",
        preserveBodyLineEndings: true,
      }).body,
      `Body${newline}`,
    );
  }
});

test("mapping-only frontmatter accepts empty mappings and preserves ambiguous Markdown bytes", () => {
  for (const source of [
    "---\n---\nBody\n",
    "---\n  \n# comment only\n---\nBody\n",
    "---\n{}\n---\nBody\n",
  ]) {
    const split = splitLeadingFrontmatter(source, "post.md", { policy: "mapping-only" });
    assert.equal(split.present, true);
    assert.deepEqual(split.data, {});
    assert.equal(split.body, "Body\n");
  }

  const ordinaryMarkdown = [
    "---\nfalse\n---\nBody\n",
    "---\n- first\n- second\n---\nBody\n",
    "---\n\nA new section\n\n---\n\nMore\n",
    "---\nKey:value prose\n---\nBody\n",
    "---\r\n- list\r\n---\r\nBody\r\n",
    "\ufeff---\rscalar\r---\rBody\r",
    "---\nAn unterminated thematic section\n",
    "---\n\nBody\n\nEdit: text\n",
    "---\nOpening paragraph.\n\nMore prose.\n\ntitle: [broken\n",
    "---\n```yaml\ntitle: [broken\n```\n---\nBody\n",
    "---\n```yaml\ntitle: [broken\n```\nBody\n",
    "---\n```yaml\ninside: [broken\n```\ntitle: [broken\n",
    "---\n    inside: [broken\n    still code\ntitle: [broken\n",
    "---\n[ref]: https://example.com\n\nBody with [link][ref].\n",
    "---\n[ref]: https://example.com\nBody with [link][ref].\n",
    "---\n<div>\ntitle: [broken\n</div>\n---\nBody\n",
  ];
  for (const source of ordinaryMarkdown) {
    assert.deepEqual(
      splitLeadingFrontmatter(source, "post.md", { policy: "mapping-only" }),
      {
        body: source.startsWith("\ufeff") ? source.slice(1) : source,
        data: {},
        present: false,
        bodyLineOffset: 0,
      },
    );
  }

  for (const source of [
    "\ufeff---\nfalse\n---\nBody\n",
    "\ufeff---\r\n- a\r\n- b\r\n---\r\nBody\r\n",
    "\ufeff---\rA section\r\rBody\r",
  ]) {
    assert.deepEqual(
      splitLeadingFrontmatter(source, "post.md", {
        policy: "mapping-only",
        preserveBodyLineEndings: true,
      }),
      { body: source.slice(1), data: {}, present: false, bodyLineOffset: 0 },
    );
  }
});

test("mapping-intent malformed and unterminated frontmatter still rejects", () => {
  expectLocalProblem(
    () => splitLeadingFrontmatter("---\ntitle: [broken\n---\nBody", "post.md", { policy: "mapping-only" }),
    { code: "malformed_frontmatter", actual: "malformed_yaml" },
  );
  expectLocalProblem(
    () => splitLeadingFrontmatter("---\n标题: [broken\n---\nBody", "post.md", { policy: "mapping-only" }),
    { code: "malformed_frontmatter", actual: "malformed_yaml" },
  );
  expectLocalProblem(
    () => splitLeadingFrontmatter("---\ntitle: Hidden\nBody", "post.md", { policy: "mapping-only" }),
    { code: "unterminated_frontmatter", actual: "missing_closing_delimiter" },
  );
  expectLocalProblem(
    () => splitLeadingFrontmatter(
      "---\n# YAML comment\n\ntitle: [broken\n\nBody\n",
      "post.md",
      { policy: "mapping-only" },
    ),
    { code: "unterminated_frontmatter", actual: "missing_closing_delimiter" },
  );
  for (const malformedMapping of [
    "? title\n: [broken",
    "123: [broken",
    "-foo: [broken",
    "!!str title: [broken",
  ]) {
    expectLocalProblem(
      () => splitLeadingFrontmatter(
        `---\n${malformedMapping}\n---\nBody\n`,
        "post.md",
        { policy: "mapping-only" },
      ),
      { code: "malformed_frontmatter", actual: "malformed_yaml" },
    );
  }
});

test("Reddit frontmatter accepts only subreddit/title/flair string keys", () => {
  assert.deepEqual(
    validateRedditFrontmatter(
      { subreddit: "agents", title: "Hello", flair: "Discussion" },
      "post.md",
    ),
    { subreddit: "agents", title: "Hello", flair: "Discussion" },
  );
  assert.deepEqual(validateRedditFrontmatter({}, "post.md"), {
    subreddit: undefined,
    title: undefined,
    flair: undefined,
  });

  expectLocalProblem(
    () => validateRedditFrontmatter({ owner: "operator" }, "post.md"),
    { code: "reddit_frontmatter_key_unsupported", actual: "owner", expected: "subreddit, title, or flair" },
  );
  expectLocalProblem(
    () => validateRedditFrontmatter({ spoiler: true, nsfw: true }, "post.md"),
    { code: "reddit_frontmatter_flag_only", actual: "nsfw, spoiler", expected: "--nsfw/--spoiler" },
  );
  expectLocalProblem(
    () => validateRedditFrontmatter({ title: 42 }, "post.md"),
    { code: "reddit_frontmatter_value_invalid", actual: "number", expected: "string" },
  );
});

test("Reddit precedence is flag over frontmatter over leading H1 and inline Markdown stays literal", () => {
  const metadata: RedditFrontmatter = {
    subreddit: "from-file",
    title: "From file",
    flair: "File flair",
  };
  const flagsWin = generateSelfPost("Body\n", {
    subreddit: "r/from-flag",
    title: "From flag",
    flair: "Flag flair",
    frontmatter: metadata,
  });
  assert.equal(flagsWin.subreddit, "from-flag");
  assert.equal(flagsWin.title, "From flag");
  assert.equal(flagsWin.flair, "Flag flair");
  assert.equal(flagsWin.body, "Body\n");

  const metadataWins = generateSelfPost("# Body heading\nBody\n", { frontmatter: metadata });
  assert.equal(metadataWins.title, "From file");
  assert.equal(metadataWins.body, "# Body heading\nBody\n");

  const h1Wins = generateSelfPost("# Heading title\n\nBody\n");
  assert.equal(h1Wins.title, "Heading title");
  assert.equal(h1Wins.body, "Body");

  for (let spaces = 0; spaces <= 3; spaces += 1) {
    const commonMarkH1 = generateSelfPost(`${" ".repeat(spaces)}# Column title ##\nBody\n`);
    assert.equal(commonMarkH1.title, "Column title");
    assert.equal(commonMarkH1.body, "Body");
  }
  expectLocalProblem(
    () => generateSelfPost("    # Indented code, not H1\nBody\n", { subreddit: "test" }),
    { code: "reddit_title_missing" },
  );
  const indentedCode = generateSelfPost("    # Indented code, not H1\nBody\n", {
    title: "Explicit",
  });
  assert.equal(indentedCode.body, "    # Indented code, not H1\nBody\n");

  const loneCrH1 = generateSelfPost("# Lone CR title\rBody\r");
  assert.equal(loneCrH1.title, "Lone CR title");
  assert.equal(loneCrH1.body, "Body");

  const crlfBody = generateSelfPost("# Title\r\n\r\nAlpha\r\nBeta\r\n");
  assert.equal(crlfBody.body, "Alpha\r\nBeta");
  assert.equal(crlfBody.bodyChars, 11);
  const crBody = generateSelfPost("# Title\r\rAlpha\rBeta\r");
  assert.equal(crBody.body, "Alpha\rBeta");
  const lfBody = generateSelfPost("# Title\n\nAlpha\nBeta\n");
  assert.equal(lfBody.body, "Alpha\nBeta");

  const commentMapped = "\ufeff---\r# metadata intentionally empty\r---\r# Comment-map title\rBody\r";
  const split = splitLeadingFrontmatter(commentMapped, "post.md", {
    policy: "mapping-only",
    preserveBodyLineEndings: true,
  });
  const fromCommentMap = generateSelfPost(split.body, {
    frontmatter: validateRedditFrontmatter(split.data, "post.md"),
  });
  assert.equal(fromCommentMap.title, "Comment-map title");
  assert.equal(fromCommentMap.body, "Body");

  expectLocalProblem(
    () => generateSelfPost("Body", {
      subreddit: "",
      title: "Explicit",
      frontmatter: metadata,
    }),
    { code: "reddit_subreddit_empty", actual: "empty --subreddit" },
  );
  expectLocalProblem(
    () => generateSelfPost("# H1 fallback\nBody", {
      subreddit: "test",
      title: "  ",
      frontmatter: metadata,
    }),
    { code: "reddit_title_empty", actual: "empty --title" },
  );
  const clearedFlair = generateSelfPost("Body", {
    subreddit: "test",
    title: "Explicit",
    flair: "",
    frontmatter: metadata,
  });
  assert.equal(clearedFlair.flair, undefined);

  const literal = "---\ntitle: Literal content\n---\nBody\n";
  assert.equal(generateSelfPost(literal, { title: "Explicit title" }).body, literal);
});

test("Reddit generator reports portable code/table forms and unsupported Markdown images", () => {
  const post = generateSelfPost(
    [
      "```ts",
      "run()",
      "![inside-code](https://example.com/not-an-image.png)",
      "```",
      "",
      "~~~sh",
      "echo ok",
      "~~~",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| a | b |",
      "",
      "![inline](https://example.com/inline.png)",
      "![reference][shot]",
      "",
      "[shot]: https://example.com/reference.png",
      "",
      "`![code](https://example.com/not-an-image.png)`",
      "\\![escaped](https://example.com/not-an-image.png)",
    ].join("\n"),
    { title: "Formatting" },
  );

  assert.equal(post.codeFlags.length, 2);
  assert.match(post.warnings.join("\n"), /4-space-indented code/);
  assert.match(post.warnings.join("\n"), /tables render through old and new Reddit parsers/i);
  assert.match(post.warnings.join("\n"), /leading and trailing pipes/);
  assert.match(post.warnings.join("\n"), /2 Markdown image reference\(s\)/);
  assert.match(post.warnings.join("\n"), /does not upload inline body images/);

  const noOuterPipes = generateSelfPost("Name | Value\n--- | ---\na | b", { title: "Table" });
  assert.match(noOuterPipes.warnings.join("\n"), /leading and trailing pipes/);

  const h1ThenFence = generateSelfPost("# Derived title\n\n```js\nrun()\n```\n");
  assert.equal(h1ThenFence.codeFlags[0]?.sourceLine, 3);

  const loneCrFile = "\ufeff---\rsubreddit: test\r---\r# Title\r\r```js\rrun()\r```\r";
  const loneCrSplit = splitLeadingFrontmatter(loneCrFile, "post.md", {
    policy: "mapping-only",
    preserveBodyLineEndings: true,
  });
  const loneCrPost = generateSelfPost(loneCrSplit.body, {
    frontmatter: validateRedditFrontmatter(loneCrSplit.data, "post.md"),
    bodyLineOffset: loneCrSplit.bodyLineOffset,
  });
  assert.deepEqual(loneCrPost.codeFlags, [{
    index: 1,
    lang: "js",
    preview: "run()",
    sourceLine: 6,
  }]);

  const crlfFile = "---\r\nsubreddit: test\r\ntitle: T\r\n---\r\nIntro\r\n```ts\r\nrun()\r\n```\r\n";
  const crlfSplit = splitLeadingFrontmatter(crlfFile, "post.md", {
    policy: "mapping-only",
    preserveBodyLineEndings: true,
  });
  const crlfPost = generateSelfPost(crlfSplit.body, {
    frontmatter: validateRedditFrontmatter(crlfSplit.data, "post.md"),
    bodyLineOffset: crlfSplit.bodyLineOffset,
  });
  assert.equal(crlfPost.codeFlags[0]?.sourceLine, 6);
  assert.equal(
    generateSelfPost("Intro\n```ts\nrun()\n```", { title: "Inline" }).codeFlags[0]?.sourceLine,
    2,
  );

  const nestedEvidence = generateSelfPost(
    [
      "<div>",
      "```fake fence text inside HTML",
      "</div>",
      "",
      "- item",
      "",
      "  ```js",
      "  nested()",
      "  ```",
      "",
      "~~~sh",
      "echo root",
      "~~~",
    ].join("\n"),
    { title: "Evidence" },
  );
  assert.deepEqual(nestedEvidence.codeFlags.map((flag) => flag.sourceLine), [7, 11]);
  assert.deepEqual(nestedEvidence.codeFlags.map((flag) => flag.lang), ["js", "sh"]);

  const sameMarkerHtml = generateSelfPost(
    "- item\n\n  <div>\n  ```js\n  html\n  ```\n  </div>\n\n  ```js\n  real()\n  ```\n",
    { title: "Nested HTML evidence" },
  );
  assert.deepEqual(sameMarkerHtml.codeFlags, [{
    index: 1,
    lang: "js",
    preview: "real()",
    sourceLine: 9,
  }]);

  const sameMarkerIndentedCode = generateSelfPost(
    "- item\n\n      ```js\n      fake\n      ```\n\n  ```js\n  real()\n  ```\n",
    { title: "Nested indented evidence" },
  );
  assert.deepEqual(sameMarkerIndentedCode.codeFlags, [{
    index: 1,
    lang: "js",
    preview: "real()",
    sourceLine: 7,
  }]);

  const sameMarkerQuoteHtml = generateSelfPost(
    "> <div>\n> ```js\n> html\n> ```\n> </div>\n>\n> ```js\n> real()\n> ```\n",
    { title: "Blockquote HTML evidence" },
  );
  assert.deepEqual(sameMarkerQuoteHtml.codeFlags, [{
    index: 1,
    lang: "js",
    preview: "real()",
    sourceLine: 7,
  }]);

  const controls = generateSelfPost(
    [
      "    ```ts",
      "    literal fence text",
      "    ```",
      "",
      "not a table header",
      "",
      "--- | ---",
      "",
      "    ![inside-indented-code](https://example.com/no.png)",
      "    A | B",
      "    --- | ---",
    ].join("\n"),
    { title: "Controls" },
  );
  assert.equal(controls.codeFlags.length, 0);
  assert.doesNotMatch(controls.warnings.join("\n"), /4-space-indented code/);
  assert.doesNotMatch(controls.warnings.join("\n"), /tables render through old and new Reddit parsers/i);
  assert.doesNotMatch(controls.warnings.join("\n"), /Markdown image reference/);
});

test("Reddit save helper requires fresh toast evidence, clicks once, and never retries", async () => {
  let clickCount = 0;
  let locateCount = 0;
  let presenceChecks = 0;
  const save = {
    click: async (options?: { trial?: boolean }) => { if (!options?.trial) clickCount += 1; },
    isVisible: async () => true,
    isEnabled: async () => true,
  } as unknown as Locator;
  const locate = async (
    _page: Page,
    _candidates: readonly string[],
    _timeout?: number,
  ): Promise<Locator | null> => {
    locateCount += 1;
    return locateCount === 1 ? save : null;
  };

  const result = await saveDraftReddit(
    {} as Page,
    locate,
    async () => {
      presenceChecks += 1;
      return "absent";
    },
  );
  assert.deepEqual(result, { clicked: true, confirmed: false, deliveryUnknown: false, toastBeforeClick: "absent" });
  assert.equal(clickCount, 1);
  assert.equal(locateCount, 2);
  assert.equal(presenceChecks, 1);
  assert.match(describeRedditSaveAttempt("agents", true, false), /exactly once/);
  assert.match(describeRedditSaveAttempt("agents", true, false), /UNCONFIRMED/);
  assert.match(describeRedditSaveAttempt("agents", true, false), /Compare Reddit DRAFTS manually/);
  assert.match(describeRedditSaveAttempt("agents", true, false), /do not rerun automatically or blindly/);
  assert.match(describeRedditSaveAttempt("agents", true, false), /no draft idempotency ledger/);

  let freshLocateCount = 0;
  const toast = {} as Locator;
  const fresh = await saveDraftReddit(
    {} as Page,
    async (): Promise<Locator | null> => {
      freshLocateCount += 1;
      return freshLocateCount === 1 ? save : toast;
    },
    async () => "absent",
  );
  assert.deepEqual(fresh, { clicked: true, confirmed: true, deliveryUnknown: false, toastBeforeClick: "absent" });

  let staleLocateCount = 0;
  const stale = await saveDraftReddit(
    {} as Page,
    async (): Promise<Locator | null> => {
      staleLocateCount += 1;
      return staleLocateCount === 1 ? save : toast;
    },
    async () => "present",
  );
  assert.deepEqual(stale, { clicked: true, confirmed: false, deliveryUnknown: false, toastBeforeClick: "present" });
  assert.match(describeRedditSaveAttempt("agents", true, false, "present"), /already existed before/);
  assert.match(describeRedditSaveAttempt("agents", true, false, "present"), /could not be attributed/);

  let inconclusiveLocateCount = 0;
  const inconclusive = await saveDraftReddit(
    {} as Page,
    async (): Promise<Locator | null> => {
      inconclusiveLocateCount += 1;
      return inconclusiveLocateCount === 1 ? save : toast;
    },
    async () => "inconclusive",
  );
  assert.deepEqual(inconclusive, {
    clicked: true,
    confirmed: false,
    deliveryUnknown: false,
    toastBeforeClick: "inconclusive",
  });
  assert.match(
    describeRedditSaveAttempt("agents", true, false, "inconclusive"),
    /could not establish.*absent before the click/,
  );

  const nthCalls: number[] = [];
  const multipleMatchesPage = {
    locator: () => ({
      count: async () => 2,
      nth: (index: number) => ({
        isVisible: async () => {
          nthCalls.push(index);
          return index === 1;
        },
      }),
    }),
  } as unknown as Page;
  let multipleLocateCount = 0;
  const hiddenFirstVisibleSecond = await saveDraftReddit(
    multipleMatchesPage,
    async (): Promise<Locator | null> => {
      multipleLocateCount += 1;
      return multipleLocateCount === 1 ? save : toast;
    },
  );
  assert.deepEqual(hiddenFirstVisibleSecond, {
    clicked: true,
    confirmed: false,
    deliveryUnknown: false,
    toastBeforeClick: "present",
  });
  assert.deepEqual(nthCalls, [0, 1]);

  let hiddenLocateCount = 0;
  const allHiddenPage = {
    locator: () => ({
      count: async () => 2,
      nth: () => ({ isVisible: async () => false }),
    }),
  } as unknown as Page;
  const defaultFreshTransition = await saveDraftReddit(
    allHiddenPage,
    async (): Promise<Locator | null> => {
      hiddenLocateCount += 1;
      return hiddenLocateCount === 1 ? save : toast;
    },
  );
  assert.deepEqual(defaultFreshTransition, {
    clicked: true,
    confirmed: true,
    deliveryUnknown: false,
    toastBeforeClick: "absent",
  });

  const failingProbePage = {
    locator: () => { throw new Error("page detached"); },
  } as unknown as Page;
  let failedProbeLocateCount = 0;
  const failedProbe = await saveDraftReddit(
    failingProbePage,
    async (): Promise<Locator | null> => {
      failedProbeLocateCount += 1;
      return failedProbeLocateCount === 1 ? save : toast;
    },
  );
  assert.deepEqual(failedProbe, {
    clicked: true,
    confirmed: false,
    deliveryUnknown: false,
    toastBeforeClick: "inconclusive",
  });

  let absentLocateCount = 0;
  const absent = await saveDraftReddit(
    {} as Page,
    async (): Promise<Locator | null> => {
      absentLocateCount += 1;
      return null;
    },
  );
  assert.deepEqual(absent, {
    clicked: false, confirmed: false, deliveryUnknown: false, toastBeforeClick: "not_checked",
    diagnostic: { reason: "save_control_missing", validationProbe: "inconclusive", validation: [] },
  });
  assert.equal(absentLocateCount, 1);
  assert.equal(clickCount, 7);

  const rejectedClick = await saveDraftReddit(
    {} as Page,
    async () => ({
      click: async (options?: { trial?: boolean }) => { if (!options?.trial) throw new Error("dispatched then detached"); },
      isVisible: async () => true,
      isEnabled: async () => true,
    } as unknown as Locator),
    async () => "absent",
  );
  assert.deepEqual(rejectedClick, {
    clicked: true,
    confirmed: false,
    deliveryUnknown: true,
    toastBeforeClick: "absent",
  });
  assert.match(describeRedditSaveAttempt("agents", true, false, "absent", true), /delivery is unknown/i);
  assert.match(describeRedditSaveAttempt("agents", true, false, "absent", true), /do not rerun/i);
});

function validationPage(selectors: string[] = []): Page {
  return {
    locator: (selector: string) => {
      selectors.push(selector);
      const visible = selector.includes('field-name="body"') ||
        selector.includes('name="body"') || selector.includes('field-name="subredditName"');
      return {
        count: async () => visible ? 1 : 0,
        nth: () => ({
          isVisible: async () => true,
          innerText: () => { throw new Error("Native validation text must not be read"); },
        }),
      };
    },
  } as unknown as Page;
}

test("Reddit default Save lookup distinguishes observed absence from an unreadable page", async () => {
  for (const observation of ["absent", "closed_page", "protocol_failure", "timeout_then_unreadable"] as const) {
    const waitBudgets: number[] = [];
    let realSaveClicks = 0;
    let toastProbes = 0;
    const page = {
      locator: () => {
        if (observation === "protocol_failure") throw new Error("PRIVATE_PROTOCOL_DETAIL");
        const candidate = {
          waitFor: async (options: { timeout: number }) => {
            waitBudgets.push(options.timeout);
            if (observation === "closed_page") throw new Error("Target page has been closed: PRIVATE_PAGE_DETAIL");
            throw new errors.TimeoutError("PRIVATE_VISIBILITY_TIMEOUT");
          },
          isVisible: async () => {
            if (observation === "timeout_then_unreadable") throw new Error("PRIVATE_PROTOCOL_DETAIL");
            return false;
          },
          click: async (options?: { trial?: boolean }) => { if (!options?.trial) realSaveClicks += 1; },
        };
        return {
          first: () => candidate,
          count: async () => {
            if (observation !== "absent") throw new Error("PRIVATE_VALIDATION_DETAIL");
            return 0;
          },
        };
      },
    } as unknown as Page;
    const result = await saveDraftReddit(page, undefined, async () => { toastProbes += 1; return "absent"; });
    const expectedReason = observation === "absent" ? "save_control_missing" : "save_control_probe_inconclusive";
    assert.equal(result.diagnostic?.reason, expectedReason, observation);
    assert.equal(result.clicked, false, observation);
    assert.equal(result.deliveryUnknown, false, observation);
    assert.equal(realSaveClicks, 0, observation);
    assert.equal(toastProbes, 0, observation);
    assert.ok(waitBudgets.every((timeout) => timeout > 0 && timeout <= 750));
    assert.ok(waitBudgets.reduce((sum, timeout) => sum + timeout, 0) <= 3_000);
    assert.equal(waitBudgets.length, observation === "absent" ? 4 : observation === "protocol_failure" ? 0 : 1);
    const receipt = receiptForRedditStageOutcome(classifyRedditStageResult({
      kind: "self", subreddit: "agents", saveStatus: "not_attempted", saved: false, verified: false,
      note: "No Save dispatched.", saveDiagnostic: result.diagnostic,
    }));
    assert.equal(receipt.error?.code, `reddit_${expectedReason}`);
    assert.equal(receipt.error?.classification, observation === "absent" ? "known" : "unknown");
    assert.doesNotMatch(JSON.stringify({ result, receipt }), /PRIVATE_/);
  }
});

test("Reddit rejected Save lookup remains inconclusive without probing or dispatching Save", async () => {
  let lookups = 0;
  let toastProbes = 0;
  const result = await saveDraftReddit(validationPage(), async (_page, _selectors, timeout) => {
    lookups += 1;
    assert.equal(timeout, 3_000);
    throw new Error("PRIVATE_LOOKUP_DETAIL");
  }, async () => { toastProbes += 1; return "absent"; });
  assert.equal(lookups, 1);
  assert.equal(toastProbes, 0);
  assert.equal(result.clicked, false);
  assert.equal(result.confirmed, false);
  assert.equal(result.deliveryUnknown, false);
  assert.equal(result.diagnostic?.reason, "save_control_probe_inconclusive");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_LOOKUP_DETAIL/);
});

test("Reddit failed post-click toast lookup preserves the delivered, unconfirmed save", async () => {
  let lookups = 0;
  let realSaveClicks = 0;
  const result = await saveDraftReddit({} as Page, async () => {
    lookups += 1;
    if (lookups > 1) throw new Error("PRIVATE_TOAST_PROTOCOL_DETAIL");
    return {
      click: async (options?: { trial?: boolean }) => { if (!options?.trial) realSaveClicks += 1; },
      isVisible: async () => true,
      isEnabled: async () => true,
    } as unknown as Locator;
  }, async () => "absent");
  assert.equal(realSaveClicks, 1);
  assert.equal(lookups, 2);
  assert.deepEqual(result, { clicked: true, confirmed: false, deliveryUnknown: false, toastBeforeClick: "absent" });
});

test("Reddit disabled Save and failed readiness never dispatch a save or probe a confirmation toast", async () => {
  for (const failure of ["disabled", "covered", "probe_exception"] as const) {
    let trialCount = 0;
    let clickCount = 0;
    let locateCount = 0;
    let toastProbeCount = 0;
    const result = await saveDraftReddit(validationPage(), async () => {
      locateCount += 1;
      return {
        click: async (options?: { trial?: boolean; timeout?: number }) => {
          if (options?.trial) {
            trialCount += 1;
            assert.equal(options.timeout, 3_000);
            throw new Error("PRIVATE_BROWSER_DETAIL");
          }
          clickCount += 1;
        },
        isVisible: async () => true,
        isEnabled: async () => {
          if (failure === "probe_exception") throw new Error("PRIVATE_BROWSER_DETAIL");
          return failure !== "disabled";
        },
      } as unknown as Locator;
    }, async () => { toastProbeCount += 1; return "absent"; });
    assert.equal(trialCount, 1, failure);
    assert.equal(clickCount, 0, failure);
    assert.equal(locateCount, 1, failure);
    assert.equal(toastProbeCount, 0, failure);
    assert.deepEqual(result, {
      clicked: false, confirmed: false, deliveryUnknown: false, toastBeforeClick: "not_checked",
      diagnostic: {
        reason: failure === "disabled" ? "save_control_disabled" : "save_control_probe_inconclusive",
        validationProbe: "complete",
        validation: [
          { field: "body", code: "field_invalid" },
          { field: "subreddit", code: "validation_guidance_present" },
        ],
      },
    });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BROWSER_DETAIL/);
  }
});

test("Reddit trial waits for transient validation before the one real save click", async () => {
  let enabled = false;
  const events: string[] = [];
  let locateCount = 0;
  const result = await saveDraftReddit({} as Page, async () => {
    locateCount += 1;
    if (locateCount > 1) return {} as Locator;
    return {
      click: async (options?: { trial?: boolean }) => {
        if (options?.trial) { events.push("trial"); enabled = true; }
        else events.push("save");
      },
      isVisible: async () => true,
      isEnabled: async () => enabled,
    } as unknown as Locator;
  }, async () => { events.push("toast_absence"); return "absent"; });
  assert.deepEqual(events, ["trial", "toast_absence", "save"]);
  assert.equal(result.confirmed, true);
  assert.equal(result.diagnostic, undefined);
});

test("Reddit validation inspection is scoped, bounded, closed, and does not read native text", async () => {
  const selectors: string[] = [];
  const result = await inspectRedditSaveValidation(validationPage(selectors));
  assert.deepEqual(result.validation, [
    { field: "body", code: "field_invalid" },
    { field: "subreddit", code: "validation_guidance_present" },
  ]);
  assert.ok(selectors.every((selector) =>
    selector.includes('r-form-validation-message[field-name=') || selector.includes('[aria-invalid="true"]')));
  assert.ok(selectors.some((selector) => selector.includes('r-form-validation-message[field-name="body"] p')));
  assert.ok(Object.isFrozen(result.validation));
  assert.ok(result.validation.every(Object.isFrozen));
  let visibilityChecks = 0;
  const tooMany = await inspectRedditSaveValidation({
    locator: () => ({
      count: async () => 100_000,
      nth: () => ({ isVisible: async () => { visibilityChecks += 1; return false; } }),
    }),
  } as unknown as Page);
  assert.equal(visibilityChecks, 32);
  assert.equal(tooMany.validationProbe, "inconclusive");
  assert.deepEqual(tooMany.validation, []);
  const failed = await inspectRedditSaveValidation({
    locator: () => { throw new Error("PRIVATE_PAGE_TEXT"); },
  } as unknown as Page);
  assert.deepEqual(failed, { validationProbe: "inconclusive", validation: [] });
});

test("Reddit command maps only a toast-confirmed save to success", () => {
  const result = (
    overrides: Partial<StageDraftResult>,
  ): StageDraftResult => ({
    kind: "self",
    saveStatus: "not_attempted",
    saved: false,
    verified: false,
    subreddit: "agents",
    note: "No attempt.",
    ...overrides,
  });

  const blocked = classifyRedditStageResult(result({ blocked: "can't post to r/agents: restricted" }));
  assert.equal(blocked.exitCode, 1);
  assert.equal(blocked.stream, "stderr");

  const notAttempted = classifyRedditStageResult(result({
    note: describeRedditSaveAttempt("agents", false, false),
  }));
  assert.equal(notAttempted.exitCode, 1);
  assert.equal(notAttempted.stream, "stderr");
  assert.match(notAttempted.message, /No Reddit draft was confirmed/);
  assert.match(notAttempted.message, /Reddit DRAFTS/);
  assert.match(notAttempted.message, /same CLI-owned profile/);
  assert.match(notAttempted.message, /no draft idempotency ledger/);
  assert.match(notAttempted.message, /duplicate/);
  assert.doesNotMatch(notAttempted.message, /nothing was saved/i);
  assert.doesNotMatch(notAttempted.message, /re-run with --inspect/i);
  assert.doesNotMatch(notAttempted.message, /✓/);

  const unconfirmedNote = describeRedditSaveAttempt("agents", true, false);
  const unconfirmed = classifyRedditStageResult(result({
    saveStatus: "unconfirmed",
    saved: true,
    note: unconfirmedNote,
  }));
  assert.equal(unconfirmed.exitCode, 1);
  assert.equal(unconfirmed.stream, "stderr");
  assert.match(unconfirmed.message, /UNCONFIRMED/);
  assert.match(unconfirmed.message, /do not rerun automatically or blindly/);
  assert.doesNotMatch(unconfirmed.message, /✓/);

  const confirmed = classifyRedditStageResult(result({
    saveStatus: "toast_confirmed",
    saved: true,
    verified: true,
    note: describeRedditSaveAttempt("agents", true, true, "absent"),
  }));
  assert.equal(confirmed.exitCode, 0);
  assert.equal(confirmed.stream, "stdout");
  assert.match(confirmed.message, /verified by Draft saved toast: yes/);
});

test("Reddit receipt retains populated-composer uncertainty when Save Draft is unresolved", () => {
  const notAttempted = classifyRedditStageResult({
    kind: "self",
    saveStatus: "not_attempted",
    saved: false,
    verified: false,
    subreddit: "agents",
    note: describeRedditSaveAttempt("agents", false, false),
  });
  const receipt = receiptForRedditStageOutcome(notAttempted);
  assert.equal(receipt.terminalState, "native_draft_possible");
  assert.ok(receipt.remoteResidue.some((entry) =>
    entry.kind === "composer" && entry.state === "prepared_composer_save_not_attempted"));
  assert.ok(receipt.remoteResidue.some((entry) =>
    entry.kind === "native_draft" && entry.retryRisk === "duplicate"));
  assert.match(receipt.gotchas.join("\n"), /same CLI-owned profile/);
  assert.match(receipt.gotchas.join("\n"), /do not blindly restage/);

  const blocked = receiptForRedditStageOutcome(classifyRedditStageResult({
    kind: "self",
    saveStatus: "not_attempted",
    saved: false,
    verified: false,
    subreddit: "agents",
    blocked: "restricted",
    note: "Restricted before content entry.",
  }));
  assert.equal(blocked.terminalState, "platform_rejected");
  assert.equal(blocked.remoteResidue.length, 0);
});

test("Reddit readiness receipt distinguishes field validation from pre-content eligibility and click uncertainty", () => {
  const diagnostic: RedditSaveDiagnostic = {
    reason: "save_control_disabled", validationProbe: "complete",
    validation: [{ field: "body", code: "field_invalid" }],
  };
  const stage: StageDraftResult = {
    kind: "self", saveStatus: "not_attempted", saved: false, verified: false,
    subreddit: "agents", note: "No save click was attempted.", saveDiagnostic: diagnostic,
  };
  const outcome = classifyRedditStageResult(stage);
  const receipt = receiptForRedditStageOutcome(outcome);
  assert.equal(receipt.terminalState, "native_draft_possible");
  assert.equal(receipt.error?.code, "reddit_save_control_disabled");
  assert.equal(receipt.error?.classification, "known");
  assert.equal(receipt.error?.stage, "save_draft");
  assert.ok(receipt.remoteResidue.some((entry) => entry.state === "prepared_composer_save_not_attempted"));
  assert.match(receipt.validation.live.notes.join(" "), /body validation: field marked invalid/);
  assert.match(receipt.error!.suggestedCorrection!, /without bypassing community restrictions/);
  assert.match(receipt.error!.suggestedCorrection!, /same CLI-owned profile/);
  assert.ok(Object.isFrozen(outcome.saveDiagnostic));
  assert.ok(Object.isFrozen(outcome.saveDiagnostic?.validation));
  (diagnostic.validation[0] as { field: string }).field = "PRIVATE_SOURCE_TEXT";
  assert.equal(outcome.saveDiagnostic!.validation[0].field, "body");
  const inconclusive = receiptForRedditStageOutcome(classifyRedditStageResult({
    ...stage,
    saveDiagnostic: { reason: "save_control_probe_inconclusive", validationProbe: "inconclusive", validation: [] },
  }));
  assert.equal(inconclusive.error?.classification, "unknown");
  assert.equal(inconclusive.error?.code, "reddit_save_control_probe_inconclusive");
  assert.match(inconclusive.validation.live.notes.join(" "), /inspection was incomplete/);
  assert.equal(inconclusive.terminalState, "native_draft_possible");
});

test("Reddit diagnostic snapshots reject raw text, accessors, malformed fields and contradictory save phases", () => {
  let getterReads = 0;
  const valid = {
    reason: "save_control_disabled", validationProbe: "complete",
    validation: [{ field: "body", code: "field_invalid" }],
  };
  const base: StageDraftResult = {
    kind: "self", saveStatus: "not_attempted", saved: false, verified: false,
    subreddit: "agents", note: "Prepared composer.",
  };
  for (const diagnostic of [
    { ...valid, reason: "PRIVATE_SOURCE_TEXT" },
    { ...valid, message: "PRIVATE_SOURCE_TEXT" },
    { ...valid, validation: [{ field: "PRIVATE_SOURCE_TEXT", code: "field_invalid" }] },
    { ...valid, validation: [{ field: "body", code: "PRIVATE_SOURCE_TEXT" }] },
    { ...valid, validation: [{ field: "body", code: "field_invalid", message: "PRIVATE_SOURCE_TEXT" }] },
    { ...valid, validation: [valid.validation[0], valid.validation[0]] },
    { ...valid, validation: Array(5).fill(valid.validation[0]) },
    { ...valid, get validation() { getterReads += 1; throw new Error("PRIVATE_SOURCE_TEXT"); } },
    new Proxy(valid, {}),
  ]) {
    assert.throws(() => classifyRedditStageResult({ ...base, saveDiagnostic: diagnostic as RedditSaveDiagnostic }));
  }
  assert.equal(getterReads, 0);
  const notAttemptedOutcome = classifyRedditStageResult(base);
  assert.throws(() => receiptForRedditStageOutcome({
    ...notAttemptedOutcome,
    saveDiagnostic: { ...valid, reason: "PRIVATE_SOURCE_TEXT" } as unknown as RedditSaveDiagnostic,
  }));
  assert.throws(() => receiptForRedditStageOutcome({
    ...notAttemptedOutcome,
    get saveDiagnostic(): RedditSaveDiagnostic { getterReads += 1; throw new Error("PRIVATE_SOURCE_TEXT"); },
  }));
  assert.equal(getterReads, 0);
  for (const saveStatus of ["delivery_unknown", "unconfirmed", "toast_confirmed"] as const) {
    assert.throws(() => classifyRedditStageResult({
      ...base, saveStatus, saved: true, verified: saveStatus === "toast_confirmed",
      saveDiagnostic: valid as RedditSaveDiagnostic,
    }));
    const outcome = classifyRedditStageResult({
      ...base, saveStatus, saved: true, verified: saveStatus === "toast_confirmed",
    });
    assert.throws(() => receiptForRedditStageOutcome({ ...outcome, saveDiagnostic: valid as RedditSaveDiagnostic }));
  }
  assert.throws(() => classifyRedditStageResult({
    ...base, blocked: "restricted", saveDiagnostic: valid as RedditSaveDiagnostic,
  }));
});

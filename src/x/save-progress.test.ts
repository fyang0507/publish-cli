import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import {
  snapshotXDraftRowEvidence,
  XDraftStageError,
  runXDraftSaveFlow,
  xDraftMayExist,
  type XArticleCoverHandoff,
  type XDraftRowEvidence,
} from "./saveProgress.js";
import {
  saveAsDraft,
  stageArticleCover,
  stageArticleDraft,
  verifyArticleDraftSaved,
  type ArticleDraftStageDependencies,
  type SaveAsDraftDependencies,
} from "./draftPoster.js";
import { generateContent } from "./content.js";

const RAW_CANARY =
  "selector=[data-secret] PRIVATE_PATH_CANARY/operator/secret token=super-secret page=Private composer text";

function missingCover(): XArticleCoverHandoff {
  return {
    status: "missing",
    ratio: "not_observed",
    width: null,
    height: null,
    crop: "not_observed",
  };
}

function observedRows(visibleRowCount: number, exactFullTextMatches: number) {
  return {
    outcome: "observed" as const,
    route: "exact" as const,
    modal: "single_visible" as const,
    rows: "all_readable" as const,
    visibleModalCount: 1 as const,
    visibleRowCount,
    exactFullTextMatches,
  };
}

function rowEvidence(verified: boolean): XDraftRowEvidence {
  const baseline = observedRows(1, 0);
  const postSave = verified ? observedRows(2, 1) : observedRows(1, 0);
  return verified
    ? {
        status: "verified",
        method: "unsent_row_full_text_delta",
        contentMatch: "visible_scoped_multiset_plus_one",
        nativeRowId: "unavailable",
        listCompleteness: "visible_scoped_rows_only",
        baseline,
        postSave,
      }
    : {
        status: "unverified",
        method: "unsent_row_full_text_delta",
        contentMatch: "post_exact_missing",
        nativeRowId: "unavailable",
        listCompleteness: "visible_scoped_rows_only",
        baseline,
        postSave,
      };
}

async function capturedStageError(run: () => Promise<unknown>): Promise<XDraftStageError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof XDraftStageError);
    assert.doesNotMatch(error.message, /data-secret|PRIVATE_PATH_CANARY|super-secret|Private composer/);
    return error;
  }
  throw new Error("Expected XDraftStageError");
}

test("save progress assigns the exact await boundary and never leaks raw failures", async () => {
  const cases: Array<{
    name: string;
    expected: "save_not_attempted" | "save_delivery_unknown" | "save_delivered_unverified";
    beforeSave(): Promise<void>;
    deliverSave(): Promise<void>;
    afterSave(): Promise<{ verified: boolean; value: string }>;
  }> = [
    {
      name: "before action",
      expected: "save_not_attempted",
      beforeSave: async () => { throw new Error(RAW_CANARY); },
      deliverSave: async () => {},
      afterSave: async () => ({ verified: true, value: "unused" }),
    },
    {
      name: "delivery rejection after possible side effect",
      expected: "save_delivery_unknown",
      beforeSave: async () => {},
      deliverSave: async () => { throw new Error(RAW_CANARY); },
      afterSave: async () => ({ verified: true, value: "unused" }),
    },
    {
      name: "post-delivery verification rejection",
      expected: "save_delivered_unverified",
      beforeSave: async () => {},
      deliverSave: async () => {},
      afterSave: async () => { throw new Error(RAW_CANARY); },
    },
  ];

  for (const fixture of cases) {
    const error = await capturedStageError(() => runXDraftSaveFlow(
      "composer_close_save",
      fixture,
    ));
    assert.equal(error.savePhase, fixture.expected, fixture.name);
    assert.equal(error.saveMechanism, "composer_close_save");
    assert.equal(xDraftMayExist(error.savePhase), fixture.expected !== "save_not_attempted");
  }
});

test("nested typed errors cannot downgrade a boundary already crossed", async () => {
  const delivery = await capturedStageError(() => runXDraftSaveFlow(
    "composer_close_save",
    {
      beforeSave: async () => {},
      deliverSave: async () => {
        throw new XDraftStageError("save_not_attempted", "article_create_autosave");
      },
      afterSave: async () => ({ verified: true, value: "unused" }),
    },
  ));
  assert.equal(delivery.savePhase, "save_delivery_unknown");
  assert.equal(delivery.saveMechanism, "composer_close_save");

  const verification = await capturedStageError(() => runXDraftSaveFlow(
    "article_create_autosave",
    {
      beforeSave: async () => {},
      deliverSave: async () => {},
      afterSave: async () => {
        throw new XDraftStageError("save_not_attempted", "composer_close_save");
      },
    },
  ));
  assert.equal(verification.savePhase, "save_delivered_unverified");
  assert.equal(verification.saveMechanism, "article_create_autosave");
});

test("resolved observations form a closed unverified-or-verified result", async () => {
  for (const verified of [false, true]) {
    const result = await runXDraftSaveFlow("article_create_autosave", {
      beforeSave: async () => {},
      deliverSave: async () => {},
      afterSave: async () => ({ verified, value: "bounded" }),
    });
    assert.deepEqual(result, {
      savePhase: verified ? "verified" : "save_delivered_unverified",
      value: "bounded",
    });
  }
});

test("malformed post-Save observations cannot escape or regress to pre-Save", async () => {
  for (const malformed of [
    null,
    undefined,
    {},
    { verified: "yes", value: "unsafe" },
    Object.defineProperty({ value: "unsafe" }, "verified", {
      get() { throw new Error(RAW_CANARY); },
    }),
  ]) {
    const error = await capturedStageError(() => runXDraftSaveFlow(
      "composer_close_save",
      {
        beforeSave: async () => {},
        deliverSave: async () => {},
        afterSave: async () => malformed as never,
      },
    ));
    assert.equal(error.savePhase, "save_delivered_unverified");
  }

  let verifiedReads = 0;
  const stateful = Object.defineProperty({ value: "bounded" }, "verified", {
    get() {
      verifiedReads += 1;
      return verifiedReads > 1;
    },
  });
  const result = await runXDraftSaveFlow("composer_close_save", {
    beforeSave: async () => {},
    deliverSave: async () => {},
    afterSave: async () => stateful as { verified: boolean; value: string },
  });
  assert.equal(verifiedReads, 1);
  assert.equal(result.savePhase, "save_delivered_unverified");
});

interface ComposerFixture {
  closeMissing?: boolean;
  closeFails?: boolean;
  saveMissing?: boolean;
  saveLookupFails?: boolean;
  saveFails?: boolean;
  settleFails?: boolean;
  verifyFails?: boolean;
  verified?: boolean;
}

function composerDependencies(
  fixture: ComposerFixture,
  events: string[],
): SaveAsDraftDependencies {
  const close = {
    async click() {
      events.push("close:click");
      if (fixture.closeFails) throw new Error(RAW_CANARY);
    },
  } as unknown as Locator;
  const save = {
    async click() {
      events.push("save:click");
      if (fixture.saveFails) throw new Error(RAW_CANARY);
    },
  } as unknown as Locator;
  return {
    async locateClose() {
      events.push("close:locate");
      return fixture.closeMissing ? null : close;
    },
    async locateSave() {
      events.push("save:locate");
      if (fixture.saveLookupFails) throw new Error(RAW_CANARY);
      return fixture.saveMissing ? null : save;
    },
    async settle() {
      events.push("save:settle");
      if (fixture.settleFails) throw new Error(RAW_CANARY);
    },
  };
}

test("composer wiring never verifies a stale match when Save was not invoked", async () => {
  for (const fixture of [
    { closeMissing: true },
    { closeFails: true },
    { saveMissing: true },
    { saveLookupFails: true },
  ] as const) {
    const events: string[] = [];
    const error = await capturedStageError(() => saveAsDraft(
      {} as Page,
      async () => {
        events.push("verify:stale-match");
        return rowEvidence(true);
      },
      composerDependencies(fixture, events),
    ));
    assert.equal(error.savePhase, "save_not_attempted");
    assert.equal(events.includes("save:click"), false);
    assert.equal(events.includes("verify:stale-match"), false);
    assert.equal(events.some((event) => /post|publish|send/i.test(event)), false);
  }
});

test("composer wiring marks click rejection unknown and all later failures unverified", async () => {
  const clickEvents: string[] = [];
  const clickError = await capturedStageError(() => saveAsDraft(
    {} as Page,
    async () => {
      clickEvents.push("verify");
      return rowEvidence(true);
    },
    composerDependencies({ saveFails: true }, clickEvents),
  ));
  assert.equal(clickError.savePhase, "save_delivery_unknown");
  assert.equal(clickEvents.filter((event) => event === "save:click").length, 1);
  assert.equal(clickEvents.includes("verify"), false);

  for (const fixture of [{ settleFails: true }, { verifyFails: true }] as const) {
    const events: string[] = [];
    const error = await capturedStageError(() => saveAsDraft(
      {} as Page,
      async () => {
        events.push("verify");
        if (fixture.verifyFails) throw new Error(RAW_CANARY);
        return rowEvidence(true);
      },
      composerDependencies(fixture, events),
    ));
    assert.equal(error.savePhase, "save_delivered_unverified");
    assert.equal(events.filter((event) => event === "save:click").length, 1);
  }
});

test("composer wiring returns unverified for a negative reopen and verified only for a match", async () => {
  for (const verified of [false, true]) {
    const events: string[] = [];
    const result = await saveAsDraft(
      {} as Page,
      async () => {
        events.push("verify");
        return rowEvidence(verified);
      },
      composerDependencies({ verified }, events),
    );
    assert.equal(result.savePhase, verified ? "verified" : "save_delivered_unverified");
    assert.deepEqual(events, ["close:locate", "close:click", "save:locate", "save:click", "save:settle", "verify"]);
  }
});

test("malformed verifier evidence cannot regress a returned Save to delivery-unknown", async () => {
  for (const malformed of [
    null,
    { status: "unverified" },
    {
      ...rowEvidence(false),
      contentMatch: "post_unavailable",
      baseline: {
        outcome: "not_observed",
        route: "not_observed",
        modal: "not_observed",
        rows: "not_observed",
        visibleModalCount: null,
        visibleRowCount: null,
        exactFullTextMatches: null,
      },
    },
  ]) {
    const events: string[] = [];
    const result = await saveAsDraft(
      {} as Page,
      async () => malformed as never,
      composerDependencies({}, events),
    );
    assert.equal(result.savePhase, "save_delivered_unverified");
    assert.equal(result.draftRowEvidence.contentMatch, "baseline_unavailable");
    assert.equal(result.draftRowEvidence.baseline.outcome, "not_observed");
    assert.ok(snapshotXDraftRowEvidence(result.draftRowEvidence));
    assert.deepEqual(events, [
      "close:locate",
      "close:click",
      "save:locate",
      "save:click",
      "save:settle",
    ]);
  }
});

type ArticleFailurePoint =
  | "open_hub"
  | "locate_create"
  | "create_click"
  | "locate_title"
  | "write_title"
  | "locate_body"
  | "write_body"
  | "stage_cover"
  | "settle"
  | "verify";

function articleDependencies(
  events: string[],
  opts: {
    failAt?: ArticleFailurePoint;
    createMissing?: boolean;
    editUrl?: string | null;
    verified?: boolean;
    stageCover?: ArticleDraftStageDependencies["stageCover"];
  } = {},
): ArticleDraftStageDependencies {
  const fail = (point: ArticleFailurePoint): void => {
    if (opts.failAt === point) throw new Error(RAW_CANARY);
  };
  const locator = {} as Locator;
  const create = {
    async click() {
      events.push("create:click");
      // Record the possible native side effect before rejecting.
      if (opts.failAt === "create_click") throw new Error(RAW_CANARY);
    },
  } as unknown as Locator;
  return {
    async openHub() {
      events.push("hub:open");
      fail("open_hub");
    },
    async locateCreate() {
      events.push("create:locate");
      fail("locate_create");
      return opts.createMissing ? null : create;
    },
    currentEditUrl() {
      events.push("edit:url");
      return opts.editUrl === undefined
        ? "https://x.com/compose/articles/edit/12345"
        : opts.editUrl;
    },
    async locateTitle() {
      events.push("title:locate");
      fail("locate_title");
      return locator;
    },
    async writeTitle() {
      events.push("title:write");
      fail("write_title");
    },
    async locateBody() {
      events.push("body:locate");
      fail("locate_body");
      return locator;
    },
    async writeBody() {
      events.push("body:write");
      fail("write_body");
    },
    async stageCover(page, basePath) {
      events.push("cover:stage");
      fail("stage_cover");
      return opts.stageCover ? opts.stageCover(page, basePath) : missingCover();
    },
    async settle() {
      events.push("autosave:settle");
      fail("settle");
    },
    async verify() {
      events.push("edit:verify");
      fail("verify");
      return opts.verified ?? true;
    },
  };
}

test("Article wiring binds Create to delivery and every later failure to unverified", async () => {
  const generated = await generateContent("# Article title\n\nArticle body for reopen matching.", {
    format: "article",
  });
  for (const before of [
    { failAt: "open_hub" as const },
    { failAt: "locate_create" as const },
    { createMissing: true },
  ]) {
    const events: string[] = [];
    const error = await capturedStageError(() => stageArticleDraft(
      {} as never,
      {} as Page,
      generated,
      undefined,
      articleDependencies(events, before),
    ));
    assert.equal(error.savePhase, "save_not_attempted");
    assert.equal(events.includes("create:click"), false);
  }

  const clickEvents: string[] = [];
  const clickError = await capturedStageError(() => stageArticleDraft(
    {} as never,
    {} as Page,
    generated,
    undefined,
    articleDependencies(clickEvents, { failAt: "create_click" }),
  ));
  assert.equal(clickError.savePhase, "save_delivery_unknown");
  assert.equal(clickError.saveMechanism, "article_create_autosave");
  assert.equal(clickEvents.filter((event) => event === "create:click").length, 1);
  assert.equal(clickEvents.includes("title:locate"), false);

  for (const failAt of [
    "locate_title",
    "write_title",
    "locate_body",
    "write_body",
    "stage_cover",
    "settle",
    "verify",
  ] as const) {
    const events: string[] = [];
    const error = await capturedStageError(() => stageArticleDraft(
      {} as never,
      {} as Page,
      generated,
      undefined,
      articleDependencies(events, { failAt }),
    ));
    assert.equal(error.savePhase, "save_delivered_unverified", failAt);
    assert.equal(events.filter((event) => event === "create:click").length, 1);
  }
});

test("Article wiring returns unverified for no canonical edit URL or negative reopen", async () => {
  const generated = await generateContent("# Article title\n\nArticle body for reopen matching.", {
    format: "article",
  });
  for (const opts of [{ editUrl: null }, { verified: false }]) {
    const events: string[] = [];
    const result = await stageArticleDraft(
      {} as never,
      {} as Page,
      generated,
      undefined,
      articleDependencies(events, opts),
    );
    assert.equal(result.saveMechanism, "article_create_autosave");
    assert.equal(result.savePhase, "save_delivered_unverified");
    assert.equal(events.filter((event) => event === "create:click").length, 1);
    if (opts.editUrl === null) assert.equal(events.includes("edit:verify"), false);
  }
});

function articleVerifierPage(options: {
  currentUrl?: string;
  title: string;
  body: string;
}): Page {
  let currentUrl = options.currentUrl ?? "https://x.com/compose/articles/edit/12345";
  return {
    async goto(url: string) {
      if (!options.currentUrl) currentUrl = url;
      return null;
    },
    url() {
      return currentUrl;
    },
    async waitForTimeout() {},
    locator(selector: string) {
      const value = selector.includes("twitter-article-title")
        ? options.title
        : options.body;
      const locator = {
        first() { return locator; },
        async waitFor() {},
        async inputValue() { return value; },
        async innerText() { return value; },
      };
      return locator;
    },
  } as unknown as Page;
}

type ArticleRouteDriftPoint =
  | "title_locator"
  | "body_locator"
  | "title_read"
  | "body_read"
  | "body_fallback_read";

function articleRouteDriftPage(driftAt: ArticleRouteDriftPoint): Page {
  const editUrl = "https://x.com/compose/articles/edit/12345";
  let currentUrl = editUrl;
  return {
    async goto() { return null; },
    url() { return currentUrl; },
    async waitForTimeout() {},
    locator(selector: string) {
      const kind = selector.includes("title") ? "title" : "body";
      const value = kind === "title"
        ? "Article title"
        : "Body prefix followed by intended text";
      const locator = {
        first() { return locator; },
        async waitFor() {
          if (driftAt === `${kind}_locator`) {
            currentUrl = "https://x.com/compose/articles/edit/99999";
          }
        },
        async inputValue() {
          if (driftAt === "body_fallback_read" && kind === "body") {
            throw new Error("contenteditable has no input value");
          }
          if (driftAt === `${kind}_read`) currentUrl = "https://x.com/home";
          return value;
        },
        async innerText() {
          if (driftAt === "body_fallback_read" && kind === "body") {
            currentUrl = "https://x.com/login";
          }
          return value;
        },
      };
      return locator;
    },
  } as unknown as Page;
}

test("Article verifier requires the same canonical edit URL and exact title/body prefix", async () => {
  const editUrl = "https://x.com/compose/articles/edit/12345";
  assert.equal(await verifyArticleDraftSaved(
    articleVerifierPage({ title: " Article Title ", body: "Body prefix followed by intended text plus persisted suffix" }),
    editUrl,
    "Article title",
    "Body prefix followed by intended text",
  ), true);
  assert.equal(await verifyArticleDraftSaved(
    articleVerifierPage({
      currentUrl: "https://x.com/compose/articles/edit/99999",
      title: "Article title",
      body: "Body prefix followed by intended text",
    }),
    editUrl,
    "Article title",
    "Body prefix followed by intended text",
  ), false);
  assert.equal(await verifyArticleDraftSaved(
    articleVerifierPage({ title: "Article title", body: "Different persisted body" }),
    editUrl,
    "Article title",
    "Body prefix followed by intended text",
  ), false);
  assert.equal(await verifyArticleDraftSaved(
    articleVerifierPage({ currentUrl: "not a URL", title: "Article title", body: "Body prefix followed by intended text" }),
    editUrl,
    "Article title",
    "Body prefix followed by intended text",
  ), false);
  assert.equal(await verifyArticleDraftSaved(
    articleVerifierPage({ title: "Article title", body: "" }),
    editUrl,
    "Article title",
    "",
  ), true, "title-only articles can verify after reopening the same editor");
});

test("Article verifier gates the captured edit URL around every locator and text await", async () => {
  const editUrl = "https://x.com/compose/articles/edit/12345";
  for (const driftAt of [
    "title_locator",
    "body_locator",
    "title_read",
    "body_read",
    "body_fallback_read",
  ] as const) {
    assert.equal(await verifyArticleDraftSaved(
      articleRouteDriftPage(driftAt),
      editUrl,
      "Article title",
      "Body prefix followed by intended text",
    ), false, driftAt);
  }
});

test("verified Article output stays bounded when a cover upload fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-article-private-canary-"));
  try {
    const basePath = join(dir, "private-source.md");
    const coverPath = join(dir, "private-cover.png");
    writeFileSync(basePath, "# Article\n\nBody\n");
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(1500, 16);
    png.writeUInt32BE(600, 20);
    writeFileSync(coverPath, png);

    const coverPage = {
      locator() {
        const locator = {
          first() { return locator; },
          async waitFor() {},
          async setInputFiles() { throw new Error(RAW_CANARY); },
        };
        return locator;
      },
    } as unknown as Page;
    assert.deepEqual(await stageArticleCover(coverPage, basePath), {
      status: "upload_incomplete",
      ratio: "within_5_2",
      width: 1500,
      height: 600,
      crop: "not_observed",
    });

    const generated = await generateContent(
      "# Article title\n\nArticle body.\n\n```js\nconst fixture = true;\n```",
      { format: "article" },
    );
    const events: string[] = [];
    const result = await stageArticleDraft(
      {} as never,
      {} as Page,
      generated,
      basePath,
      articleDependencies(events, {
        verified: true,
        async stageCover(_page, sourcePath) {
          return stageArticleCover(coverPage, sourcePath);
        },
      }),
    );
    assert.equal(result.savePhase, "verified");
    if (result.saveMechanism !== "article_create_autosave") {
      assert.fail("expected an Article result");
    }
    assert.equal(result.articleHandoff.codeBlockCount, 1);
    assert.deepEqual(result.articleHandoff.cover, {
      status: "upload_incomplete",
      ratio: "within_5_2",
      width: 1500,
      height: 600,
      crop: "not_observed",
    });
    assert.doesNotMatch(JSON.stringify(result.articleHandoff), /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer|private-cover|publish-x-article-private/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

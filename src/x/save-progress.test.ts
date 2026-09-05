import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import {
  snapshotXDraftRowEvidence,
  snapshotXArticleDraftHandoff,
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
  waitForCanonicalArticleEditUrl,
  type ArticleDraftStageDependencies,
  type SaveAsDraftDependencies,
} from "./draftPoster.js";
import { generateContent } from "./content.js";
import { preloadXArticleCover } from "./articleCover.js";
import { executeXDraftRealRun } from "../commands/draft.js";

const RAW_CANARY =
  "selector=[data-secret] PRIVATE_PATH_CANARY/operator/secret token=super-secret page=Private composer text";

const COVER_DIR = mkdtempSync(join(tmpdir(), "publish-x-article-save-cover-"));
const COVER_PATH = join(COVER_DIR, "cover.png");
const COVER_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAUAAAACCAIAAAAfCIEKAAAACXBIWXMAAAABAAAAAQBPJcTWAAAADklEQVR4nGNkQAUsaHwAAIAABtETi70AAAAASUVORK5CYII=",
  "base64",
);
writeFileSync(COVER_PATH, COVER_BYTES);
const ARTICLE_COVER = preloadXArticleCover(COVER_PATH);
test.after(() => rmSync(COVER_DIR, { recursive: true, force: true }));

function stagedCover(): XArticleCoverHandoff {
  return {
    selection: "explicit",
    contentType: "image/png",
    width: ARTICLE_COVER.width,
    height: ARTICLE_COVER.height,
    ratio: "exact_5_2",
    sourceSha256: ARTICLE_COVER.sourceSha256,
    requested: true,
    resolved: true,
    set: true,
    setPhase: "set_returned",
    uploaded: null,
    applyPhase: "returned",
    observed: true,
    verified: null,
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
  | "settled_edit_url"
  | "verify";

function articleDependencies(
  events: string[],
  opts: {
    failAt?: ArticleFailurePoint;
    createMissing?: boolean;
    editUrl?: string | null;
    lateEditUrl?: string | null;
    verified?: boolean;
    verifyResult?: Readonly<{ content: boolean; cover: boolean }>;
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
      events.push("edit:url:provisional");
      return opts.editUrl === undefined
        ? "https://x.com/compose/articles/edit/12345"
        : opts.editUrl;
    },
    async settledEditUrl() {
      events.push("edit:url:settled");
      fail("settled_edit_url");
      if (opts.lateEditUrl !== undefined) return opts.lateEditUrl;
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
    async stageCover(page, cover) {
      events.push("cover:stage");
      fail("stage_cover");
      return opts.stageCover ? opts.stageCover(page, cover) : stagedCover();
    },
    async settle() {
      events.push("autosave:settle");
      fail("settle");
    },
    async verify() {
      events.push("edit:verify");
      fail("verify");
      if (opts.verifyResult) return opts.verifyResult;
      const verified = opts.verified ?? true;
      return { content: verified, cover: verified };
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
      ARTICLE_COVER,
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
    ARTICLE_COVER,
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
  ] as const) {
    const events: string[] = [];
    const error = await capturedStageError(() => stageArticleDraft(
      {} as never,
      {} as Page,
      generated,
      ARTICLE_COVER,
      articleDependencies(events, { failAt }),
    ));
    assert.equal(error.savePhase, "save_delivered_unverified", failAt);
    assert.equal(events.filter((event) => event === "create:click").length, 1);
  }
});

test("Article post-cover continuation failures retain the returned handoff and edit reference", async () => {
  const generated = await generateContent(
    "# Article title\n\nArticle body for reopen matching.",
    { format: "article" },
  );
  const editUrl = "https://x.com/compose/articles/edit/12345";

  for (const failAt of ["settle", "settled_edit_url", "verify"] as const) {
    const events: string[] = [];
    const returnedCover = stagedCover();
    const outcome = await executeXDraftRealRun(
      { content: generated, cover: ARTICLE_COVER },
      {
        async loadStageDraft() {
          return async (stageContent, options) => {
            assert.ok(options.cover);
            return stageArticleDraft(
              {} as never,
              {} as Page,
              stageContent,
              options.cover,
              articleDependencies(events, {
                failAt,
                async stageCover() { return returnedCover; },
              }),
            );
          };
        },
      },
    );

    assert.equal(outcome.kind, "save_incomplete", failAt);
    assert.equal(outcome.savePhase, "save_delivered_unverified", failAt);
    assert.equal(outcome.exitCode, 1, failAt);
    assert.equal(outcome.nativeReference, editUrl, failAt);
    assert.deepEqual(outcome.articleHandoff?.cover, returnedCover, failAt);
    assert.equal(outcome.articleHandoff?.cover.set, true, failAt);
    assert.equal(outcome.articleHandoff?.cover.applyPhase, "returned", failAt);
    assert.equal(outcome.articleHandoff?.cover.observed, true, failAt);
    assert.equal(outcome.articleHandoff?.cover.verified, null, failAt);
    assert.equal(events.filter((event) => event === "cover:stage").length, 1, failAt);
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
      ARTICLE_COVER,
      articleDependencies(events, opts),
    );
    assert.equal(result.saveMechanism, "article_create_autosave");
    assert.equal(result.savePhase, "save_delivered_unverified");
    assert.equal(events.filter((event) => event === "create:click").length, 1);
    if (opts.editUrl === null) assert.equal(events.includes("edit:verify"), false);
  }
});

test("Article verification requires one non-conflicting post-settle canonical edit URL", async () => {
  const generated = await generateContent("# Article title\n\nArticle body for reopen matching.", {
    format: "article",
  });
  const delayedUrl = "https://x.com/compose/articles/edit/67890";
  const delayedEvents: string[] = [];
  const delayed = await stageArticleDraft(
    {} as never,
    {} as Page,
    generated,
    ARTICLE_COVER,
    articleDependencies(delayedEvents, { editUrl: null, lateEditUrl: delayedUrl }),
  );
  assert.equal(delayed.savePhase, "verified");
  if (delayed.saveMechanism !== "article_create_autosave") {
    assert.fail("expected an Article result");
  }
  assert.equal(delayed.nativeReference, delayedUrl);
  assert.equal(delayed.articleHandoff.cover.verified, true);
  assert.deepEqual(
    delayedEvents.filter((event) => event.startsWith("edit:url") || event === "edit:verify"),
    ["edit:url:provisional", "edit:url:settled", "edit:verify"],
  );

  for (const fixture of [
    {
      name: "conflicting positive samples",
      editUrl: "https://x.com/compose/articles/edit/12345",
      lateEditUrl: "https://x.com/compose/articles/edit/67890",
    },
    {
      name: "invalid late sample",
      editUrl: "https://x.com/compose/articles/edit/12345",
      lateEditUrl: "https://x.com/compose/articles/edit/12345?source=untrusted",
    },
    {
      name: "missing late sample",
      editUrl: "https://x.com/compose/articles/edit/12345",
      lateEditUrl: null,
    },
  ]) {
    const events: string[] = [];
    const result = await stageArticleDraft(
      {} as never,
      {} as Page,
      generated,
      ARTICLE_COVER,
      articleDependencies(events, fixture),
    );
    assert.equal(result.savePhase, "save_delivered_unverified", fixture.name);
    if (result.saveMechanism !== "article_create_autosave") {
      assert.fail("expected an Article result");
    }
    assert.equal(result.nativeReference, undefined, fixture.name);
    assert.equal(result.articleHandoff.cover.verified, null, fixture.name);
    assert.equal(events.includes("edit:verify"), false, fixture.name);
    assert.equal(events.filter((event) => event === "edit:url:provisional").length, 1);
    assert.equal(events.filter((event) => event === "edit:url:settled").length, 1);
  }
});

test("Article authoritative persistence closes every Apply phase only after a returned set and complete proof", async () => {
  const generated = await generateContent(
    "# Article title\n\nArticle body for reopen matching.",
    { format: "article" },
  );

  const cases: ReadonlyArray<{
    name: string;
    cover: XArticleCoverHandoff;
    verifyResult: Readonly<{ content: boolean; cover: boolean }>;
    expectedVerified: boolean;
    expectedCoverVerified: boolean;
  }> = [
    ...(["not_attempted", "delivery_unknown", "returned"] as const).map(
      (applyPhase) => ({
        name: `${applyPhase} plus complete native proof`,
        cover: {
          ...stagedCover(),
          applyPhase,
          observed: false,
          verified: null,
        },
        verifyResult: { content: true, cover: true },
        expectedVerified: true,
        expectedCoverVerified: true,
      }),
    ),
    {
      name: "unknown Apply with missing cover parity",
      cover: {
        ...stagedCover(),
        applyPhase: "delivery_unknown",
        observed: false,
        verified: null,
      },
      verifyResult: { content: true, cover: false },
      expectedVerified: false,
      expectedCoverVerified: false,
    },
    {
      name: "unknown Apply with mismatched content",
      cover: {
        ...stagedCover(),
        applyPhase: "delivery_unknown",
        observed: false,
        verified: null,
      },
      verifyResult: { content: false, cover: true },
      expectedVerified: false,
      expectedCoverVerified: true,
    },
    {
      name: "cover target unavailable despite later positive-looking proof",
      cover: {
        ...stagedCover(),
        set: false,
        setPhase: "target_unavailable",
        applyPhase: "not_attempted",
        observed: false,
        verified: null,
      },
      verifyResult: { content: true, cover: true },
      expectedVerified: false,
      expectedCoverVerified: false,
    },
    {
      name: "cover set delivery unknown despite later positive-looking proof",
      cover: {
        ...stagedCover(),
        set: null,
        setPhase: "set_delivery_unknown",
        applyPhase: "not_attempted",
        observed: false,
        verified: null,
      },
      verifyResult: { content: true, cover: true },
      expectedVerified: false,
      expectedCoverVerified: false,
    },
  ];

  for (const fixture of cases) {
    const events: string[] = [];
    const result = await stageArticleDraft(
      {} as never,
      {} as Page,
      generated,
      ARTICLE_COVER,
      articleDependencies(events, {
        async stageCover() {
          return fixture.cover;
        },
        verifyResult: fixture.verifyResult,
      }),
    );

    assert.equal(
      result.savePhase,
      fixture.expectedVerified ? "verified" : "save_delivered_unverified",
      fixture.name,
    );
    if (result.saveMechanism !== "article_create_autosave") {
      assert.fail("expected an Article result");
    }
    assert.equal(result.articleHandoff.cover.set, fixture.cover.set, fixture.name);
    assert.equal(
      result.articleHandoff.cover.applyPhase,
      fixture.cover.applyPhase,
      fixture.name,
    );
    assert.equal(
      result.articleHandoff.cover.observed,
      fixture.expectedCoverVerified,
      fixture.name,
    );
    assert.equal(
      result.articleHandoff.cover.verified,
      fixture.expectedCoverVerified,
      fixture.name,
    );
    assert.equal(events.filter((event) => event === "edit:verify").length, 1, fixture.name);
  }
});

test("Article handoff snapshot accepts the tri-state Apply matrix and rejects contradictory provenance", () => {
  const handoff = (cover: XArticleCoverHandoff) => ({
    body: "rich_html" as const,
    codeBlockCount: 0,
    codeAdvisories: [],
    codeLinkAdvisories: [],
    cover,
    bodyImages: [],
  });

  for (const applyPhase of ["not_attempted", "delivery_unknown", "returned"] as const) {
    const cover = { ...stagedCover(), applyPhase, observed: true, verified: true };
    const snapshot = snapshotXArticleDraftHandoff(handoff(cover));
    assert.equal(snapshot?.cover.applyPhase, applyPhase);
    assert.equal(snapshot?.cover.verified, true);
  }

  for (const [name, cover] of [
    ["unknown Apply without a returned set", {
      ...stagedCover(),
      set: false,
      setPhase: "target_unavailable",
      applyPhase: "delivery_unknown",
      observed: false,
      verified: false,
    }],
    ["returned Apply without a returned set", {
      ...stagedCover(),
      set: null,
      setPhase: "set_delivery_unknown",
      applyPhase: "returned",
      observed: false,
      verified: false,
    }],
    ["verified cover without observation", {
      ...stagedCover(),
      applyPhase: "not_attempted",
      observed: false,
      verified: true,
    }],
    ["removed legacy Apply state", {
      ...stagedCover(),
      applyPhase: "failed",
      observed: true,
      verified: true,
    }],
  ] as const) {
    assert.equal(snapshotXArticleDraftHandoff(handoff(cover as XArticleCoverHandoff)), null, name);
  }
});

test("post-settle canonical URL capture accepts a delayed route and has a fixed poll bound", async () => {
  let delayedReads = 0;
  const delayedWaits: number[] = [];
  const delayedPage = {
    url() {
      delayedReads += 1;
      return delayedReads === 1
        ? "https://x.com/compose/articles"
        : "https://x.com/compose/articles/edit/24680";
    },
    async waitForTimeout(milliseconds: number) {
      delayedWaits.push(milliseconds);
    },
  } as unknown as Page;
  assert.equal(
    await waitForCanonicalArticleEditUrl(delayedPage),
    "https://x.com/compose/articles/edit/24680",
  );
  assert.equal(delayedReads, 2);
  assert.deepEqual(delayedWaits, [125]);

  let invalidReads = 0;
  const invalidWaits: number[] = [];
  const invalidPage = {
    url() {
      invalidReads += 1;
      return "https://x.com/compose/articles/edit/24680#not-exact";
    },
    async waitForTimeout(milliseconds: number) {
      invalidWaits.push(milliseconds);
    },
  } as unknown as Page;
  assert.equal(await waitForCanonicalArticleEditUrl(invalidPage), null);
  assert.equal(invalidReads, 21);
  assert.equal(invalidWaits.length, 20);
  assert.ok(invalidWaits.every((milliseconds) => milliseconds === 125));
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
      const value = selector.includes("textarea")
        ? options.title
        : options.body;
      const locator = {
        async count() { return 1; },
        nth() { return locator; },
        async isVisible() { return true; },
        async isEnabled() { return true; },
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
  | "title_input_error";

function articleRouteDriftPage(driftAt: ArticleRouteDriftPoint): Page {
  const editUrl = "https://x.com/compose/articles/edit/12345";
  let currentUrl = editUrl;
  return {
    async goto() { return null; },
    url() { return currentUrl; },
    async waitForTimeout() {},
    locator(selector: string) {
      const kind = selector.includes("textarea") ? "title" : "body";
      const value = kind === "title"
        ? "Article title"
        : "Body prefix followed by intended text";
      const locator = {
        async count() {
          if (driftAt === `${kind}_locator`) {
            currentUrl = "https://x.com/compose/articles/edit/99999";
          }
          return 1;
        },
        nth() { return locator; },
        async isVisible() { return true; },
        async isEnabled() { return true; },
        async inputValue() {
          if (driftAt === "title_input_error" && kind === "title") {
            throw new Error("title input unreadable");
          }
          if (driftAt === `${kind}_read`) currentUrl = "https://x.com/home";
          return value;
        },
        async innerText() {
          if (driftAt === `${kind}_read`) currentUrl = "https://x.com/home";
          return value;
        },
      };
      return locator;
    },
  } as unknown as Page;
}

test("Article verifier requires the same canonical edit URL and exact normalized full body", async () => {
  const editUrl = "https://x.com/compose/articles/edit/12345";
  const expectedBody =
    "Body prefix followed by intended text. The intended ending is alpha.";
  assert.equal(await verifyArticleDraftSaved(
    articleVerifierPage({
      title: " Article Title ",
      body: " BODY  prefix followed\nby intended TEXT. The intended ending is ALPHA. ",
    }),
    editUrl,
    "Article title",
    expectedBody,
  ), true);
  for (const [name, body] of [
    [
      "same prefix but different tail",
      "Body prefix followed by intended text. The persisted ending is beta.",
    ],
    ["truncated body", "Body prefix followed by intended text."],
    ["unexpected extra tail", `${expectedBody} Unexpected persisted tail.`],
  ] as const) {
    assert.equal(await verifyArticleDraftSaved(
      articleVerifierPage({ title: "Article title", body }),
      editUrl,
      "Article title",
      expectedBody,
    ), false, name);
  }
  assert.equal(await verifyArticleDraftSaved(
    articleVerifierPage({
      currentUrl: "https://x.com/compose/articles/edit/99999",
      title: "Article title",
      body: expectedBody,
    }),
    editUrl,
    "Article title",
    expectedBody,
  ), false);
  assert.equal(await verifyArticleDraftSaved(
    articleVerifierPage({ title: "Article title", body: "Different persisted body" }),
    editUrl,
    "Article title",
    expectedBody,
  ), false);
  assert.equal(await verifyArticleDraftSaved(
    articleVerifierPage({ currentUrl: "not a URL", title: "Article title", body: expectedBody }),
    editUrl,
    "Article title",
    expectedBody,
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
    "title_input_error",
  ] as const) {
    assert.equal(await verifyArticleDraftSaved(
      articleRouteDriftPage(driftAt),
      editUrl,
      "Article title",
      "Body prefix followed by intended text",
    ), false, driftAt);
  }
});

test("unknown Article cover delivery keeps output unverified and bounded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-article-private-canary-"));
  try {
    const basePath = join(dir, "private-source.md");
    const coverPath = join(dir, "private-cover.png");
    writeFileSync(basePath, "# Article\n\nBody\n");
    writeFileSync(coverPath, COVER_BYTES);
    const privateCover = preloadXArticleCover(coverPath);

    const rejectingInput = {
      async setInputFiles() { throw new Error(RAW_CANARY); },
    };
    const coverDeps = {
      async resolveTarget() {
        return {
          input: rejectingInput as never,
          editUrl: "https://x.com/compose/articles/edit/12345",
        };
      },
      async targetStillCalibrated() { return true; },
      async activeDialogCount() { return 0; },
      async locateApply() { return assert.fail("apply is not reached after unknown delivery"); },
      async settleAfterSet() { return assert.fail("set did not return"); },
      async settleAfterApply() { return assert.fail("apply was not reached"); },
      async observeCover() { return { status: "none" as const }; },
    };
    assert.deepEqual(await stageArticleCover({} as Page, privateCover, coverDeps), {
      selection: "explicit",
      contentType: "image/png",
      width: privateCover.width,
      height: privateCover.height,
      ratio: "exact_5_2",
      sourceSha256: privateCover.sourceSha256,
      requested: true,
      resolved: true,
      set: null,
      setPhase: "set_delivery_unknown",
      uploaded: null,
      applyPhase: "not_attempted",
      observed: false,
      verified: null,
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
      privateCover,
      articleDependencies(events, {
        verified: true,
        async stageCover(_page, cover) {
          return stageArticleCover({} as Page, cover, coverDeps);
        },
      }),
    );
    assert.equal(result.savePhase, "save_delivered_unverified");
    if (result.saveMechanism !== "article_create_autosave") {
      assert.fail("expected an Article result");
    }
    assert.equal(result.articleHandoff.codeBlockCount, 1);
    assert.deepEqual(result.articleHandoff.cover, {
      selection: "explicit",
      contentType: "image/png",
      width: privateCover.width,
      height: privateCover.height,
      ratio: "exact_5_2",
      sourceSha256: privateCover.sourceSha256,
      requested: true,
      resolved: true,
      set: null,
      setPhase: "set_delivery_unknown",
      uploaded: null,
      applyPhase: "not_attempted",
      observed: false,
      verified: false,
    });
    assert.doesNotMatch(JSON.stringify(result.articleHandoff), /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer|private-cover|publish-x-article-private/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import {
  captureDraftRowBaseline,
  saveAsDraft,
  verifyDraftSaved,
  type DraftRowProbeDependencies,
} from "./draftPoster.js";
import {
  snapshotXDraftRowEvidence,
  X_DRAFT_ROW_OBSERVATION_LIMIT,
} from "./saveProgress.js";

const DRAFTS_URL = "https://x.com/compose/post/unsent/drafts";
const RAW_CANARY =
  "selector=[data-secret] PRIVATE_PATH_CANARY/operator/secret token=super-secret page=Private draft text";

function observed(...texts: string[]): Record<string, unknown> {
  return { kind: "observed", texts };
}

function observedFact(visibleRowCount: number, exactFullTextMatches: number) {
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

type SnapshotStep = unknown | ((state: { setUrl(value: string): void }) => unknown);

function probeHarness(
  steps: SnapshotStep[],
  options: {
    gotoError?: boolean;
    gotoUrl?: string;
    waitErrorAt?: number;
  } = {},
): {
  page: Page;
  deps: DraftRowProbeDependencies;
  events: string[];
  setUrl(value: string): void;
} {
  let currentUrl = "about:blank";
  let snapshotIndex = 0;
  let waitIndex = 0;
  const events: string[] = [];
  const state = { setUrl(value: string) { currentUrl = value; } };
  const page = {
    url() { return currentUrl; },
  } as unknown as Page;
  const deps: DraftRowProbeDependencies = {
    async gotoDrafts() {
      events.push("goto:drafts");
      if (options.gotoError) throw new Error(RAW_CANARY);
      currentUrl = options.gotoUrl ?? DRAFTS_URL;
    },
    async wait(_page, milliseconds) {
      waitIndex += 1;
      events.push(`wait:${milliseconds}`);
      if (options.waitErrorAt === waitIndex) throw new Error(RAW_CANARY);
    },
    async snapshot() {
      events.push("snapshot");
      const index = Math.min(snapshotIndex, Math.max(steps.length - 1, 0));
      snapshotIndex += 1;
      const value = steps[index];
      return typeof value === "function" ? value(state) : value;
    },
  };
  return { page, deps, events, setUrl: state.setUrl };
}

async function evidenceFor(
  expected: string,
  baselineSnapshot: unknown,
  postSnapshot: unknown,
) {
  const harness = probeHarness([baselineSnapshot, postSnapshot]);
  const baseline = await captureDraftRowBaseline(harness.page, expected, harness.deps);
  const evidence = await verifyDraftSaved(
    harness.page,
    expected,
    baseline,
    harness.deps,
  );
  return { evidence, events: harness.events };
}

test("production probe is scoped to the live-calibrated modal, Unsent row, and content node", async () => {
  let currentUrl = "about:blank";
  let evaluations = 0;
  const expected = "calibrated scoped row";
  const page = {
    async goto(url: string) { currentUrl = url; },
    async waitForTimeout() {},
    url() { return currentUrl; },
    async evaluate(fn: unknown) {
      evaluations += 1;
      const source = String(fn);
      assert.match(source, /\[role=["']dialog["']\]\[aria-modal=["']true["']\]/);
      assert.match(source, /\[data-testid=["']unsentTweet["']\]/);
      assert.match(source, /\[data-testid=["']tweetText["']\]/);
      assert.doesNotMatch(source, /cellInnerDiv|querySelectorAll\(["']body["']\)/);
      return evaluations === 1
        ? observed("older row")
        : observed("older row", expected);
    },
  } as unknown as Page;

  const baseline = await captureDraftRowBaseline(page, expected);
  const evidence = await verifyDraftSaved(page, expected, baseline);
  assert.equal(evidence.status, "verified");
  assert.equal(evidence.contentMatch, "visible_scoped_multiset_plus_one");
  assert.equal(evaluations, 2);
});

test("one exact full scoped row plus an unchanged visible baseline is the only positive", async () => {
  for (const expected of [
    "x",
    "Exact full row with a common-looking beginning",
    "Café\r\nsecond line",
  ]) {
    const post = expected === "Café\r\nsecond line"
      ? "Cafe\u0301\nsecond line"
      : expected;
    const { evidence } = await evidenceFor(
      expected,
      observed("older A", "older B"),
      observed("older B", post, "older A"),
    );
    assert.equal(evidence.status, "verified", expected);
    assert.deepEqual(evidence.baseline, {
      outcome: "observed",
      route: "exact",
      modal: "single_visible",
      rows: "all_readable",
      visibleModalCount: 1,
      visibleRowCount: 2,
      exactFullTextMatches: 0,
    });
    assert.deepEqual(evidence.postSave, {
      outcome: "observed",
      route: "exact",
      modal: "single_visible",
      rows: "all_readable",
      visibleModalCount: 1,
      visibleRowCount: 3,
      exactFullTextMatches: 1,
    });
    assert.equal(evidence.nativeRowId, "unavailable");
    assert.equal(evidence.listCompleteness, "visible_scoped_rows_only");
    assert.ok(snapshotXDraftRowEvidence(evidence));
  }
});

test("the bounded row probe still covers the full Premium transport guard", async () => {
  const expected = "😀".repeat(25_000);
  const { evidence } = await evidenceFor(
    expected,
    observed("older"),
    observed("older", expected),
  );
  assert.equal(evidence.status, "verified");
  assert.equal(evidence.contentMatch, "visible_scoped_multiset_plus_one");
});

test("prefixes, background text, case, and whitespace cannot substitute for full row identity", async () => {
  const expected = "Common prefix followed by the exact intended ending";
  const cases = [
    {
      name: "common prefix only",
      post: observed("older", "Common prefix followed by another ending"),
      extra: {},
    },
    {
      name: "same first forty characters",
      post: observed("older", `${expected.slice(0, 40)}DIFFERENT`),
      extra: {},
    },
    {
      name: "duplicate common prefixes",
      post: observed(
        "older",
        `${expected.slice(0, 40)}DIFFERENT A`,
        `${expected.slice(0, 40)}DIFFERENT B`,
      ),
      extra: {},
    },
    {
      name: "background-only match",
      post: { ...observed("older"), backgroundPageText: expected },
      extra: {},
    },
    {
      name: "case differs",
      post: observed("older", expected.toLowerCase()),
      extra: {},
    },
    {
      name: "internal whitespace differs",
      post: observed("older", expected.replace("prefix ", "prefix  ")),
      extra: {},
    },
  ];
  for (const fixture of cases) {
    const { evidence } = await evidenceFor(expected, observed("older"), fixture.post);
    assert.equal(evidence.status, "unverified", fixture.name);
    assert.equal(evidence.contentMatch, "post_exact_missing", fixture.name);
    assert.doesNotMatch(JSON.stringify(evidence), /Common prefix|backgroundPageText/);
  }
});

test("pre-existing or duplicate exact rows and unrelated row churn remain ambiguous", async () => {
  const expected = "exact duplicate canary";
  const cases: Array<{
    name: string;
    before: unknown;
    after: unknown;
    match: string;
  }> = [
    {
      name: "pre-existing identical row",
      before: observed("older", expected),
      after: observed("older", expected, expected),
      match: "preexisting_exact",
    },
    {
      name: "two post-Save exact rows",
      before: observed("older"),
      after: observed("older", expected, expected),
      match: "post_exact_ambiguous",
    },
    {
      name: "another row changed concurrently",
      before: observed("older A", "older B"),
      after: observed("older A", "different row", expected),
      match: "visible_scoped_multiset_changed",
    },
    {
      name: "fixed visible window dropped a row",
      before: observed("older A", "older B"),
      after: observed("older B", expected),
      match: "visible_scoped_multiset_changed",
    },
  ];
  for (const fixture of cases) {
    const { evidence } = await evidenceFor(expected, fixture.before, fixture.after);
    assert.equal(evidence.status, "unverified", fixture.name);
    assert.equal(evidence.contentMatch, fixture.match, fixture.name);
  }
});

test("missing or ambiguous calibrated structure is bounded and fail-closed", async () => {
  const expected = "scoped row";
  const failures: Array<{ snapshot: unknown; outcome: string }> = [
    { snapshot: { kind: "modal_missing" }, outcome: "modal_missing" },
    {
      snapshot: { kind: "modal_ambiguous", visibleModalCount: 2 },
      outcome: "modal_ambiguous",
    },
    { snapshot: { kind: "rows_missing" }, outcome: "rows_missing" },
    {
      snapshot: { kind: "rows_unreadable", rows: "content_missing", visibleRowCount: 1 },
      outcome: "rows_unreadable",
    },
    {
      snapshot: { kind: "rows_unreadable", rows: "content_ambiguous", visibleRowCount: 1 },
      outcome: "rows_unreadable",
    },
    {
      snapshot: {
        kind: "rows_unreadable",
        rows: "count_exceeded",
        visibleRowCount: "many",
      },
      outcome: "rows_unreadable",
    },
  ];
  for (const fixture of failures) {
    const { evidence } = await evidenceFor(expected, observed("older"), fixture.snapshot);
    assert.equal(evidence.status, "unverified");
    assert.equal(evidence.contentMatch, "post_unavailable");
    assert.equal(evidence.postSave.outcome, fixture.outcome);
  }
});

test("empty content, route drift, navigation errors, delays, and probe failures never verify", async () => {
  const emptyHarness = probeHarness([observed("unused")]);
  const emptyBaseline = await captureDraftRowBaseline(emptyHarness.page, "", emptyHarness.deps);
  const empty = await verifyDraftSaved(
    emptyHarness.page,
    "",
    emptyBaseline,
    emptyHarness.deps,
  );
  assert.equal(empty.status, "unverified");
  assert.equal(empty.contentMatch, "empty_intended");
  assert.equal(emptyHarness.events.filter((event) => event === "snapshot").length, 1);

  const drift = probeHarness([
    observed("older"),
    ({ setUrl }: { setUrl(value: string): void }) => {
      setUrl("https://x.com/login");
      return observed("older", "expected");
    },
  ]);
  const driftBaseline = await captureDraftRowBaseline(drift.page, "expected", drift.deps);
  const driftEvidence = await verifyDraftSaved(
    drift.page,
    "expected",
    driftBaseline,
    drift.deps,
  );
  assert.equal(driftEvidence.status, "unverified");
  assert.equal(driftEvidence.postSave.outcome, "route_not_exact");

  for (const options of [
    { gotoError: true },
    { gotoUrl: "https://x.com/home" },
    { waitErrorAt: 1 },
  ]) {
    const harness = probeHarness([observed("older")], options);
    const baseline = await captureDraftRowBaseline(harness.page, "expected", harness.deps);
    assert.notEqual(baseline.observation.outcome, "observed");
  }

  const thrown = probeHarness([
    observed("older"),
    () => { throw new Error(RAW_CANARY); },
  ]);
  const thrownBaseline = await captureDraftRowBaseline(thrown.page, "expected", thrown.deps);
  const thrownEvidence = await verifyDraftSaved(
    thrown.page,
    "expected",
    thrownBaseline,
    thrown.deps,
  );
  assert.equal(thrownEvidence.status, "unverified");
  assert.equal(thrownEvidence.postSave.outcome, "probe_failed");
  assert.doesNotMatch(JSON.stringify(thrownEvidence), /data-secret|PRIVATE_PATH|super-secret|Private draft/);
});

test("malformed, throwing, and stateful snapshot getters cannot manufacture evidence", async () => {
  const malformed = [
    null,
    {},
    { kind: "observed", texts: [] },
    { kind: "observed", texts: ["x", 1] },
    {
      kind: "rows_unreadable",
      rows: "count_exceeded",
      visibleRowCount: X_DRAFT_ROW_OBSERVATION_LIMIT,
    },
    Object.defineProperty({ kind: "observed" }, "texts", {
      get() { throw new Error(RAW_CANARY); },
    }),
  ];
  for (const value of malformed) {
    const { evidence } = await evidenceFor("expected", observed("older"), value);
    assert.equal(evidence.status, "unverified");
    assert.equal(evidence.postSave.outcome, "probe_failed");
  }

  let reads = 0;
  const stateful = Object.defineProperty({ kind: "observed" }, "texts", {
    get() {
      reads += 1;
      return reads === 1 ? ["older", "expected"] : ["older"];
    },
  });
  const { evidence } = await evidenceFor("expected", observed("older"), stateful);
  assert.equal(reads, 1);
  assert.equal(evidence.status, "verified");
});

test("closed unverified match strengths reject contradictory observation facts", () => {
  const base = {
    status: "unverified",
    method: "unsent_row_full_text_delta",
    nativeRowId: "unavailable",
    listCompleteness: "visible_scoped_rows_only",
  } as const;
  const notObserved = {
    outcome: "not_observed",
    route: "not_observed",
    modal: "not_observed",
    rows: "not_observed",
    visibleModalCount: null,
    visibleRowCount: null,
    exactFullTextMatches: null,
  } as const;
  const contradictions = [
    { contentMatch: "empty_intended", baseline: observedFact(1, 0), postSave: observedFact(1, 0) },
    { contentMatch: "baseline_unavailable", baseline: observedFact(1, 0), postSave: observedFact(1, 0) },
    { contentMatch: "post_unavailable", baseline: observedFact(1, 0), postSave: observedFact(1, 0) },
    { contentMatch: "preexisting_exact", baseline: observedFact(1, 0), postSave: observedFact(2, 1) },
    { contentMatch: "post_exact_missing", baseline: observedFact(1, 0), postSave: observedFact(2, 1) },
    { contentMatch: "post_exact_ambiguous", baseline: observedFact(1, 0), postSave: observedFact(2, 1) },
    { contentMatch: "visible_scoped_multiset_changed", baseline: observedFact(1, 0), postSave: observedFact(1, 0) },
  ];
  for (const value of contradictions) {
    assert.equal(snapshotXDraftRowEvidence({ ...base, ...value }), null, value.contentMatch);
  }

  const coherent = [
    { contentMatch: "empty_intended", baseline: notObserved, postSave: observedFact(1, 0) },
    { contentMatch: "baseline_unavailable", baseline: notObserved, postSave: observedFact(1, 0) },
    { contentMatch: "post_unavailable", baseline: observedFact(1, 0), postSave: notObserved },
    { contentMatch: "preexisting_exact", baseline: observedFact(1, 1), postSave: observedFact(1, 0) },
    { contentMatch: "post_exact_missing", baseline: observedFact(1, 0), postSave: observedFact(2, 0) },
    { contentMatch: "post_exact_ambiguous", baseline: observedFact(1, 0), postSave: observedFact(3, 2) },
    { contentMatch: "visible_scoped_multiset_changed", baseline: observedFact(1, 0), postSave: observedFact(2, 1) },
  ] as const;
  for (const value of coherent) {
    const evidence = snapshotXDraftRowEvidence({ ...base, ...value });
    assert.equal(evidence?.status, "unverified", value.contentMatch);
    assert.equal(evidence?.contentMatch, value.contentMatch, value.contentMatch);
  }

  let reads = 0;
  const statefulPost = { ...observedFact(1, 0) } as Record<string, unknown>;
  Object.defineProperty(statefulPost, "exactFullTextMatches", {
    get() {
      reads += 1;
      return reads === 1 ? 0 : 1;
    },
  });
  assert.ok(snapshotXDraftRowEvidence({
    ...base,
    contentMatch: "post_exact_missing",
    baseline: observedFact(1, 0),
    postSave: statefulPost,
  }));
  assert.equal(reads, 1);

  assert.ok(snapshotXDraftRowEvidence({
    ...base,
    contentMatch: "empty_intended",
    baseline: notObserved,
    postSave: observedFact(1, 0),
  }));
});

test("a failed post-Save reopen after an unavailable baseline stays coherently delivered-unverified", async () => {
  let currentUrl = "about:blank";
  let draftsOpen = 0;
  const events: string[] = [];
  const page = { url: () => currentUrl } as unknown as Page;
  const rowDeps: DraftRowProbeDependencies = {
    async gotoDrafts() {
      draftsOpen += 1;
      events.push(`drafts:open:${draftsOpen}`);
      if (draftsOpen === 1) {
        currentUrl = "https://x.com/home";
        return;
      }
      throw new Error(RAW_CANARY);
    },
    async wait() { events.push("drafts:wait"); },
    async snapshot() {
      events.push("drafts:snapshot");
      return observed("unreachable");
    },
  };
  const baseline = await captureDraftRowBaseline(page, "intended row", rowDeps);
  const clickable = {
    async click() { events.push("native:click"); },
  } as unknown as Locator;
  const result = await saveAsDraft(
    page,
    () => verifyDraftSaved(page, "intended row", baseline, rowDeps),
    {
      async locateClose() { events.push("close:locate"); return clickable; },
      async locateSave() { events.push("save:locate"); return clickable; },
      async settle() { events.push("save:settle"); },
    },
  );

  assert.equal(result.savePhase, "save_delivered_unverified");
  assert.equal(result.draftRowEvidence.contentMatch, "baseline_unavailable");
  assert.equal(result.draftRowEvidence.baseline.outcome, "route_not_exact");
  assert.equal(result.draftRowEvidence.postSave.outcome, "probe_failed");
  assert.ok(snapshotXDraftRowEvidence(result.draftRowEvidence));
  assert.deepEqual(events, [
    "drafts:open:1",
    "close:locate",
    "native:click",
    "save:locate",
    "native:click",
    "save:settle",
    "drafts:open:2",
  ]);
});

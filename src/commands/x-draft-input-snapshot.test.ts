import test from "node:test";
import assert from "node:assert/strict";
import {
  executeXDraftRealRun,
  type XDraftRealRunInput,
} from "./draft.js";
import {
  generateContent,
  type GeneratedContent,
} from "../x/content.js";
import {
  snapshotXNonArticleDirectStageRequest,
} from "../x/articleStageSnapshot.js";
import { stageDraft, type StageDraftResult } from "../x/draftPoster.js";
import {
  snapshotXDraftStageError,
  type XDraftRowEvidence,
} from "../x/saveProgress.js";

const RAW_CANARY = "PRIVATE_INPUT_CANARY selector=[secret] cookie=hidden";

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

function evidence(verified: boolean): XDraftRowEvidence {
  return verified
    ? {
        status: "verified",
        method: "unsent_row_full_text_delta",
        contentMatch: "visible_scoped_multiset_plus_one",
        nativeRowId: "unavailable",
        listCompleteness: "visible_scoped_rows_only",
        baseline: observedRows(1, 0),
        postSave: observedRows(2, 1),
      }
    : {
        status: "unverified",
        method: "unsent_row_full_text_delta",
        contentMatch: "post_exact_missing",
        nativeRowId: "unavailable",
        listCompleteness: "visible_scoped_rows_only",
        baseline: observedRows(1, 0),
        postSave: observedRows(1, 0),
      };
}

function result(
  content: GeneratedContent,
  verified: boolean,
): StageDraftResult {
  return {
    format: content.format as "tweet" | "thread",
    posts: content.format === "thread" ? content.thread!.length : 1,
    note: "Closed composer result.",
    saveMechanism: "composer_close_save",
    savePhase: verified ? "verified" : "save_delivered_unverified",
    draftRowEvidence: evidence(verified) as never,
  };
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) assertDeepFrozen(descriptor.value, seen);
  }
}

test("generated tweet/thread requests and large inert advisories detach before the loader", async () => {
  const generatedCases = [
    await generateContent(
      `Short transport.\n\n## ${"h".repeat(60_000)}\n\nTail omitted.`,
      { format: "tweet" },
    ),
    await generateContent("Thread transport ".repeat(180), { format: "thread" }),
  ];

  for (const generated of generatedCases) {
    const caller = structuredClone(generated);
    const expected = structuredClone(generated);
    const replacement = await generateContent("Replacement B transport", { format: "tweet" });
    const input: XDraftRealRunInput = {
      content: caller,
      inspect: true,
      basePath: "/workspace/original.md",
    };
    let stagedContent: GeneratedContent | undefined;
    let stagedOptions: unknown;
    const outcome = await executeXDraftRealRun(input, {
      async loadStageDraft() {
        input.content = structuredClone(replacement);
        input.inspect = false;
        input.basePath = "/workspace/mutated.md";
        caller.limit = 1;
        if (caller.tweet) {
          caller.tweet.text = "MUTATED TWEET";
          caller.tweet.chars = -1;
          caller.tweet.unit = "unicode_code_points_transport_policy";
        }
        if (caller.thread) {
          caller.thread.reverse();
          for (const [position, row] of caller.thread.entries()) {
            row.text = `MUTATED ROW ${position}`;
            row.index = 99;
            row.total = 77;
            row.chars = -1;
          }
        }
        caller.codeFlags = [];
        caller.linkFlags = [];
        caller.fidelityFlags = [];
        caller.warnings = [RAW_CANARY];
        delete caller.tweet;
        delete caller.thread;
        Object.assign(caller, structuredClone(replacement));
        return async (content, options) => {
          stagedContent = content;
          stagedOptions = options;
          assert.notEqual(content, caller);
          assert.deepEqual(content, expected);
          assertDeepFrozen(content);
          assert.equal(Object.isFrozen(options), true);
          assert.deepEqual(options, {
            inspect: true,
            basePath: "/workspace/original.md",
          });
          await Promise.resolve();
          input.content = structuredClone(replacement);
          input.inspect = undefined;
          input.basePath = RAW_CANARY;
          assert.deepEqual(content, expected);
          return result(content, true);
        };
      },
    });
    assert.equal(outcome.kind, "staged");
    assert.equal(outcome.exitCode, 0);
    assert.ok(stagedContent);
    assert.ok(stagedOptions);
    assert.doesNotMatch(outcome.message, /PRIVATE_INPUT_CANARY|selector=|cookie=/u);
  }
});

test("the direct-stage snapshot binds copied posts, first-row identity, and options", async () => {
  const caller = await generateContent("Direct thread ".repeat(180), { format: "thread" });
  const original = structuredClone(caller);
  const options = {
    inspect: true,
    force: false,
    basePath: "/workspace/source.md",
  };
  const snapshot = snapshotXNonArticleDirectStageRequest(caller, "thread", options);
  assert.deepEqual(snapshot.content, original);
  assert.deepEqual(snapshot.posts, original.thread!.map((row) => row.text));
  assert.equal(snapshot.intendedFirstPostText, original.thread![0].text);
  assert.equal(snapshot.expectedPosts, original.thread!.length);
  assert.deepEqual(snapshot.stageOptions, options);
  assertDeepFrozen(snapshot);

  caller.thread![0].text = RAW_CANARY;
  options.inspect = false;
  assert.equal(snapshot.intendedFirstPostText, original.thread![0].text);
  assert.deepEqual(snapshot.stageOptions, {
    inspect: true,
    force: false,
    basePath: "/workspace/source.md",
  });

  const premium = await generateContent("Premium transport " + "p".repeat(400), {
    format: "tweet",
    long: true,
  });
  const premiumSnapshot = snapshotXNonArticleDirectStageRequest(
    premium,
    "tweet",
    {},
  );
  assert.equal(premiumSnapshot.content.limit, 25_000);
  assert.equal(
    premiumSnapshot.content.tweet!.unit,
    "unicode_code_points_transport_policy",
  );

  const shared: never[] = [];
  const dag = structuredClone(premium);
  dag.codeFlags = shared;
  dag.linkFlags = shared;
  dag.fidelityFlags = shared;
  dag.warnings = shared;
  const dagSnapshot = snapshotXNonArticleDirectStageRequest(dag, "tweet", {});
  assert.notEqual(dagSnapshot.content.codeFlags, shared);
  assert.notEqual(dagSnapshot.content.codeFlags, dagSnapshot.content.linkFlags);

  const customLongLimit = await generateContent("Custom limit transport", {
    format: "tweet",
    long: true,
    longLimit: 1_000,
  });
  assert.throws(() => snapshotXNonArticleDirectStageRequest(
    customLongLimit,
    "tweet",
    {},
  ));
});

test("hostile and incoherent non-Article requests fail with exit 2 before the loader", async () => {
  const base = await generateContent("Safe local tweet", { format: "tweet" });
  const cases: Array<{ name: string; input: unknown; reads?: () => number }> = [];

  let inputProxyTraps = 0;
  cases.push({
    name: "root proxy",
    input: new Proxy({ content: structuredClone(base) }, {
      get(target, key, receiver) {
        inputProxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    }),
    reads: () => inputProxyTraps,
  });

  const revoked = Proxy.revocable({ content: structuredClone(base) }, {});
  revoked.revoke();
  cases.push({ name: "revoked root proxy", input: revoked.proxy });

  let contentReads = 0;
  cases.push({
    name: "non-Article content slot accessor",
    input: Object.defineProperty({}, "content", {
      enumerable: true,
      get() {
        contentReads += 1;
        return structuredClone(base);
      },
    }),
    // #98 permits one discriminant observation so Article accessors retain
    // their reviewed compatibility; a non-Article value is then rejected.
    reads: () => contentReads,
  });

  let textReads = 0;
  const textAccessor = structuredClone(base);
  Object.defineProperty(textAccessor.tweet!, "text", {
    enumerable: true,
    get() {
      textReads += 1;
      return RAW_CANARY;
    },
  });
  cases.push({
    name: "nested transport accessor",
    input: { content: textAccessor },
    reads: () => textReads,
  });

  const sparseThread = await generateContent("Sparse thread ".repeat(180), {
    format: "thread",
  });
  const sparseRows = new Array(2) as NonNullable<GeneratedContent["thread"]>;
  sparseRows[0] = {
    index: 1,
    total: 2,
    text: "First 1/2",
    chars: 9,
  };
  sparseThread.thread = sparseRows;
  cases.push({ name: "sparse thread", input: { content: sparseThread } });

  const badCount = structuredClone(base);
  badCount.tweet!.chars += 1;
  cases.push({ name: "measurement mismatch", input: { content: badCount } });

  const wrongLimit = structuredClone(base);
  wrongLimit.limit = 279;
  cases.push({ name: "unsupported limit pair", input: { content: wrongLimit } });

  const extra = structuredClone(base) as GeneratedContent & { extra?: string };
  extra.extra = RAW_CANARY;
  cases.push({ name: "unexpected content key", input: { content: extra } });

  const hidden = structuredClone(base);
  Object.defineProperty(hidden, "hidden", {
    value: RAW_CANARY,
    enumerable: false,
  });
  cases.push({ name: "hidden content key", input: { content: hidden } });

  const symbol = structuredClone(base);
  Object.defineProperty(symbol, Symbol("private"), {
    value: RAW_CANARY,
    enumerable: true,
  });
  cases.push({ name: "symbol content key", input: { content: symbol } });

  const exotic = Object.assign(Object.create(null), structuredClone(base));
  cases.push({ name: "exotic content prototype", input: { content: exotic } });

  const cyclic = structuredClone(base);
  cyclic.tweet = cyclic as never;
  cases.push({ name: "cyclic content graph", input: { content: cyclic } });

  const oversizedArray = structuredClone(base);
  oversizedArray.linkFlags = new Array(10_001) as never;
  cases.push({ name: "oversized advisory array", input: { content: oversizedArray } });

  let inspectReads = 0;
  cases.push({
    name: "option accessor",
    input: Object.defineProperty({ content: structuredClone(base) }, "inspect", {
      enumerable: true,
      get() {
        inspectReads += 1;
        return true;
      },
    }),
    reads: () => inspectReads,
  });

  cases.push({
    name: "unexpected request key",
    input: { content: structuredClone(base), extra: RAW_CANARY },
  });

  cases.push({
    name: "oversized base path",
    input: { content: structuredClone(base), basePath: "x".repeat(1_000_001) },
  });

  for (const fixture of cases) {
    let loaderCalls = 0;
    const outcome = await executeXDraftRealRun(
      fixture.input as XDraftRealRunInput,
      {
        async loadStageDraft() {
          loaderCalls += 1;
          throw new Error("loader must not run");
        },
      },
    );
    assert.equal(loaderCalls, 0, fixture.name);
    assert.equal(outcome.exitCode, 2, fixture.name);
    assert.equal(outcome.savePhase, "save_not_attempted", fixture.name);
    assert.equal(outcome.draftRowEvidence, null, fixture.name);
    assert.doesNotMatch(outcome.message, /PRIVATE_INPUT_CANARY|selector=|cookie=/u);
    if (fixture.reads) {
      assert.equal(
        fixture.reads(),
        fixture.name === "non-Article content slot accessor" ? 1 : 0,
        fixture.name,
      );
    }
  }
});

test("direct stageDraft rejects nested and option accessors before session/profile access", async () => {
  const base = await generateContent("Direct invalid tweet", { format: "tweet" });
  let textReads = 0;
  const hostileContent = structuredClone(base);
  Object.defineProperty(hostileContent.tweet!, "text", {
    enumerable: true,
    get() {
      textReads += 1;
      return RAW_CANARY;
    },
  });
  await assert.rejects(stageDraft(hostileContent), (error: unknown) => {
    const snapshot = snapshotXDraftStageError(error);
    return snapshot?.savePhase === "save_not_attempted" &&
      snapshot.saveMechanism === "composer_close_save";
  });
  assert.equal(textReads, 0);

  let optionReads = 0;
  const hostileOptions = Object.defineProperty({}, "inspect", {
    enumerable: true,
    get() {
      optionReads += 1;
      return true;
    },
  });
  await assert.rejects(
    stageDraft(structuredClone(base), hostileOptions),
    (error: unknown) => {
      const snapshot = snapshotXDraftStageError(error);
      return snapshot?.savePhase === "save_not_attempted" &&
        snapshot.saveMechanism === "composer_close_save";
    },
  );
  assert.equal(optionReads, 0);
});

test("resolved hostile composer results can only produce post-invocation uncertainty", async () => {
  const tweet = await generateContent("Result boundary tweet", { format: "tweet" });
  const thread = await generateContent("Result boundary thread ".repeat(180), {
    format: "thread",
  });
  const cases: Array<{
    name: string;
    content: GeneratedContent;
    value: () => unknown;
    reads?: () => number;
    expectedReads?: number;
  }> = [];

  let phaseReads = 0;
  const phasePromotion = result(tweet, false) as unknown as Record<string, unknown>;
  Object.defineProperty(phasePromotion, "savePhase", {
    enumerable: true,
    get() {
      phaseReads += 1;
      phasePromotion.draftRowEvidence = evidence(true);
      return "verified";
    },
  });
  cases.push({
    name: "top-level phase promotion",
    content: tweet,
    value: () => phasePromotion,
    reads: () => phaseReads,
  });

  let statusReads = 0;
  const nestedPromotion = result(tweet, true) as unknown as Record<string, unknown>;
  Object.defineProperty(nestedPromotion.draftRowEvidence as object, "status", {
    enumerable: true,
    get() {
      statusReads += 1;
      return "verified";
    },
  });
  cases.push({
    name: "nested evidence accessor",
    content: tweet,
    value: () => nestedPromotion,
    reads: () => statusReads,
  });

  let observationReads = 0;
  const observationPromotion = result(tweet, true) as unknown as Record<string, unknown>;
  const baseline = (observationPromotion.draftRowEvidence as Record<string, unknown>).baseline;
  Object.defineProperty(baseline as object, "outcome", {
    enumerable: true,
    get() {
      observationReads += 1;
      return "observed";
    },
  });
  cases.push({
    name: "nested observation accessor",
    content: tweet,
    value: () => observationPromotion,
    reads: () => observationReads,
  });

  let handoffReads = 0;
  const extraHandoff = result(thread, true) as unknown as Record<string, unknown>;
  Object.defineProperty(extraHandoff, "articleHandoff", {
    enumerable: true,
    get() {
      handoffReads += 1;
      thread.thread!.length = 1;
      return {};
    },
  });
  cases.push({
    name: "irrelevant Article handoff accessor",
    content: thread,
    value: () => extraHandoff,
    reads: () => handoffReads,
  });

  const proxyTarget = result(tweet, true);
  let proxyTraps = 0;
  cases.push({
    name: "transparent root proxy",
    content: tweet,
    value: () => new Proxy(proxyTarget, {
      get(target, key, receiver) {
        proxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    }),
    reads: () => proxyTraps,
    // Promise resolution performs the ECMAScript thenable check before Catch B.
    expectedReads: 1,
  });

  let nestedProxyTraps = 0;
  const nestedProxy = result(tweet, true) as unknown as Record<string, unknown>;
  nestedProxy.draftRowEvidence = new Proxy(
    nestedProxy.draftRowEvidence as object,
    {
      get(target, key, receiver) {
        nestedProxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  cases.push({
    name: "nested evidence proxy",
    content: tweet,
    value: () => nestedProxy,
    reads: () => nestedProxyTraps,
  });

  const revokedEvidence = Proxy.revocable(evidence(true), {});
  revokedEvidence.revoke();
  const revokedNested = result(tweet, true) as unknown as Record<string, unknown>;
  revokedNested.draftRowEvidence = revokedEvidence.proxy;
  cases.push({
    name: "revoked nested evidence proxy",
    content: tweet,
    value: () => revokedNested,
  });

  cases.push({
    name: "Article result format flip",
    content: tweet,
    value: () => ({ ...result(tweet, true), format: "article" }),
  });

  for (const fixture of cases) {
    const outcome = await executeXDraftRealRun(
      { content: structuredClone(fixture.content) },
      {
        async loadStageDraft() {
          return async () => fixture.value() as StageDraftResult;
        },
      },
    );
    assert.equal(outcome.kind, "save_incomplete", fixture.name);
    assert.equal(outcome.savePhase, "save_delivery_unknown", fixture.name);
    assert.equal(outcome.exitCode, 1, fixture.name);
    assert.equal(outcome.draftRowEvidence, null, fixture.name);
    assert.equal(fixture.reads?.() ?? 0, fixture.expectedReads ?? 0, fixture.name);
  }
});

test("valid verified and unverified composer results retain their conservative outcomes", async () => {
  for (const format of ["tweet", "thread"] as const) {
    const content = await generateContent(
      format === "thread" ? "Conservative baseline ".repeat(180) : "Conservative baseline",
      { format },
    );
    for (const verified of [true, false]) {
      const outcome = await executeXDraftRealRun(
        { content },
        {
          async loadStageDraft() {
            return async (snapshot) => result(snapshot, verified);
          },
        },
      );
      assert.equal(outcome.kind, verified ? "staged" : "save_incomplete");
      assert.equal(outcome.savePhase, verified ? "verified" : "save_delivered_unverified");
      assert.equal(outcome.exitCode, verified ? 0 : 1);
    }
  }

  const content = await generateContent("Post-return mutation baseline", {
    format: "tweet",
  });
  let returned: StageDraftResult | undefined;
  const outcome = await executeXDraftRealRun(
    { content },
    {
      async loadStageDraft() {
        return async (snapshot) => {
          returned = result(snapshot, true);
          return returned;
        };
      },
    },
  );
  assert.equal(outcome.savePhase, "verified");
  (returned as unknown as Record<string, unknown>).savePhase =
    "save_delivered_unverified";
  (returned!.draftRowEvidence as unknown as Record<string, unknown>).status = "unverified";
  assert.equal(outcome.savePhase, "verified");
  assert.equal(outcome.draftRowEvidence?.status, "verified");
  assert.equal(Object.isFrozen(outcome.draftRowEvidence), true);
});

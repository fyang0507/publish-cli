import test from "node:test";
import assert from "node:assert/strict";
import {
  executeLinkedInDraftRealRun,
  type LinkedInDraftRealRunDependencies,
  type LinkedInDraftRealRunOutcome,
} from "./linkedin-draft.js";
import { generatePost, type GeneratedPost } from "../linkedin/content.js";
import type { StagePostResult } from "../linkedin/draftPoster.js";
import { LinkedInDraftStageError } from "../linkedin/saveProgress.js";

const RAW_CANARY =
  "selector=[data-secret] PRIVATE_PATH_CANARY/operator/session cookie=li-secret page=Private LinkedIn composer\u001b[31m";

function post(markdown = "Offline LinkedIn draft body."): GeneratedPost {
  return generatePost(markdown);
}

function result(
  savePhase: "save_delivered_unverified" | "verified",
  mediaAttached = 0,
): StagePostResult {
  return {
    format: "post",
    saveMechanism: "composer_close_save",
    savePhase,
    verified: savePhase === "verified",
    mediaAttached,
  };
}

function dependencies(
  loadStagePost: LinkedInDraftRealRunDependencies["loadStagePost"],
): LinkedInDraftRealRunDependencies {
  return { loadStagePost };
}

function assertNoRawLeak(outcome: LinkedInDraftRealRunOutcome): void {
  assert.ok(outcome.message.length < 2_000);
  assert.doesNotMatch(
    outcome.message,
    /data-secret|PRIVATE_PATH_CANARY|li-secret|Private LinkedIn composer|\u001b|\x1b/i,
  );
}

test("LinkedIn command exposes every branded failure phase with fixed recovery guidance", async () => {
  for (const phase of [
    "save_not_attempted",
    "save_delivery_unknown",
    "save_delivered_unverified",
  ] as const) {
    const outcome = await executeLinkedInDraftRealRun(
      { post: post(), inspect: true, media: [] },
      dependencies(async () => async (_post, options) => {
        assert.deepEqual(options, { inspect: true, media: [] });
        const error = new LinkedInDraftStageError(phase);
        Object.defineProperty(error, "cause", { value: new Error(RAW_CANARY) });
        throw error;
      }),
    );
    assert.equal(outcome.kind, "save_incomplete");
    assert.equal(outcome.savePhase, phase);
    assert.equal(outcome.saveMechanism, "composer_close_save");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.stream, "stderr");
    assert.match(outcome.message, /NEVER posted/);
    if (phase === "save_not_attempted") {
      assert.match(outcome.message, /before the native Save as draft action was invoked/);
      assert.doesNotMatch(outcome.message, /draft may exist/i);
    } else {
      assert.match(outcome.message, /native LinkedIn draft may exist/i);
      assert.match(outcome.message, /Before any retry, manually compare LinkedIn Drafts/);
      assert.match(outcome.message, /exact same CLI-owned LinkedIn profile used by this run/);
      assert.match(outcome.message, /If a matching draft exists or the comparison is uncertain, do not retry/);
      assert.match(outcome.message, /Only after that comparison may --inspect help/);
      assert.match(outcome.message, /not evidence that no draft exists/);
    }
    assertNoRawLeak(outcome);
  }
});

test("loader failures prove not attempted, but any untyped invoked rejection is unknown", async () => {
  const loader = await executeLinkedInDraftRealRun(
    { post: post(), media: [] },
    dependencies(async () => {
      throw new Error(RAW_CANARY);
    }),
  );
  assert.equal(loader.kind, "stage_runtime_failed");
  assert.equal(loader.savePhase, "save_not_attempted");
  assert.equal(loader.exitCode, 1);
  assertNoRawLeak(loader);

  const nonFunction = await executeLinkedInDraftRealRun(
    { post: post(), media: [] },
    dependencies(async () => undefined as unknown as Awaited<ReturnType<LinkedInDraftRealRunDependencies["loadStagePost"]>>),
  );
  assert.equal(nonFunction.savePhase, "save_not_attempted");
  assertNoRawLeak(nonFunction);

  for (const thrown of [
    new Error(RAW_CANARY),
    {
      savePhase: "save_not_attempted",
      saveMechanism: "composer_close_save",
      message: RAW_CANARY,
    },
  ]) {
    const invoked = await executeLinkedInDraftRealRun(
      { post: post(), media: [] },
      dependencies(async () => async () => {
        throw thrown;
      }),
    );
    assert.equal(invoked.savePhase, "save_delivery_unknown");
    assert.equal(invoked.exitCode, 1);
    assert.match(invoked.message, /draft may exist/i);
    assertNoRawLeak(invoked);
  }
});

test("returned verified false exits 1 and never emits a success receipt", async () => {
  const outcome = await executeLinkedInDraftRealRun(
    { post: post(), media: [] },
    dependencies(async () => async () => result("save_delivered_unverified")),
  );
  assert.equal(outcome.kind, "save_incomplete");
  assert.equal(outcome.savePhase, "save_delivered_unverified");
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.stream, "stderr");
  assert.match(outcome.message, /not positively verified after reopen/);
  assert.doesNotMatch(outcome.message, /✓|Staged a NATIVE/);
  assertNoRawLeak(outcome);
});

test("malformed, accessor, proxy, contradictory, and media-mismatched results fail unknown", async () => {
  const throwing = Object.defineProperty({}, "format", {
    get() {
      throw new Error(RAW_CANARY);
    },
    enumerable: true,
  });
  const stateful = {
    format: "post",
    saveMechanism: "composer_close_save",
    verified: true,
    mediaAttached: 0,
  } as Record<string, unknown>;
  let phaseReads = 0;
  Object.defineProperty(stateful, "savePhase", {
    get() {
      phaseReads += 1;
      return "verified";
    },
    enumerable: true,
  });
  const proxied = new Proxy(result("verified"), {
    ownKeys() {
      throw new Error(RAW_CANARY);
    },
  });
  const fixtures: unknown[] = [
    undefined,
    throwing,
    stateful,
    proxied,
    { ...result("verified"), verified: false },
    { ...result("verified"), mediaAttached: 1 },
    { ...result("verified"), note: RAW_CANARY },
  ];

  for (const returned of fixtures) {
    const outcome = await executeLinkedInDraftRealRun(
      { post: post(), media: [] },
      dependencies(async () => async () => returned as StagePostResult),
    );
    assert.equal(outcome.savePhase, "save_delivery_unknown");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.stream, "stderr");
    assertNoRawLeak(outcome);
  }
  assert.equal(phaseReads, 0, "accessor-backed phase must not be observed");
});

test("only a closed verified return exits 0 and receipts use pre-invocation facts", async () => {
  const generated = post("Read [the guide](https://example.com/guide).");
  const outcome = await executeLinkedInDraftRealRun(
    { post: generated, inspect: false, media: ["/safe/a.png", "/safe/b.png"] },
    dependencies(async () => async (_post, options) => {
      assert.deepEqual(options, {
        inspect: false,
        media: ["/safe/a.png", "/safe/b.png"],
      });
      return result("verified", 2);
    }),
  );
  assert.equal(outcome.kind, "staged");
  assert.equal(outcome.savePhase, "verified");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stream, "stdout");
  assert.match(outcome.message, /✓ Staged a NATIVE LinkedIn draft.*NEVER posted/s);
  assert.match(outcome.message, /complete intended text verified after reopening the composer: yes/);
  assert.match(outcome.message, /media attached: 2/);
  assert.match(outcome.message, /FIRST COMMENT/);
  assertNoRawLeak(outcome);
});

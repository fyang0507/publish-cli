import test from "node:test";
import assert from "node:assert/strict";
import {
  executeXDraftRealRun,
  type XDraftRealRunDependencies,
} from "./draft.js";
import { generateContent, type GeneratedContent, type XFormat } from "../x/content.js";
import type { StageDraftResult } from "../x/draftPoster.js";
import {
  XDraftStageError,
  type XDraftSaveMechanism,
} from "../x/saveProgress.js";

const RAW_CANARY =
  "selector=[data-secret] PRIVATE_PATH_CANARY/operator/secret cookie=session-secret page=Private composer text";

function mechanism(format: XFormat): XDraftSaveMechanism {
  return format === "article" ? "article_create_autosave" : "composer_close_save";
}

async function content(format: XFormat): Promise<GeneratedContent> {
  return generateContent(
    format === "article" ? "# Offline article\n\nBody prefix for persistence matching." : "Offline X draft.",
    { format },
  );
}

function stageResult(
  generated: GeneratedContent,
  savePhase: "save_delivered_unverified" | "verified",
  overrides: Partial<StageDraftResult> = {},
): StageDraftResult {
  return {
    format: generated.format,
    posts: generated.format === "thread" ? (generated.thread?.length ?? 0) : 1,
    saveMechanism: mechanism(generated.format),
    savePhase,
    note: "Bounded verified draft note.",
    ...overrides,
  };
}

function dependencies(
  run: XDraftRealRunDependencies["loadStageDraft"],
): XDraftRealRunDependencies {
  return { loadStageDraft: run };
}

test("tweet, thread, and Article commands expose each typed save phase without raw errors", async () => {
  for (const format of ["tweet", "thread", "article"] as const) {
    const generated = await content(format);
    for (const phase of [
      "save_not_attempted",
      "save_delivery_unknown",
      "save_delivered_unverified",
    ] as const) {
      const outcome = await executeXDraftRealRun(
        { content: generated, inspect: true, basePath: "PRIVATE_PATH_CANARY/operator/source.md" },
        dependencies(async () => async (_content, opts) => {
          assert.deepEqual(opts, {
            inspect: true,
            basePath: "PRIVATE_PATH_CANARY/operator/source.md",
          });
          const error = new XDraftStageError(phase, mechanism(format));
          Object.defineProperty(error, "cause", { value: new Error(RAW_CANARY) });
          throw error;
        }),
      );
      assert.equal(outcome.kind, "save_incomplete");
      assert.equal(outcome.savePhase, phase);
      assert.equal(outcome.saveMechanism, mechanism(format));
      assert.equal(outcome.exitCode, 1);
      assert.equal(outcome.stream, "stderr");
      assert.match(outcome.message, /NEVER posted/);
      if (phase === "save_not_attempted") {
        assert.match(outcome.message, /before the native .* action was invoked/i);
        assert.doesNotMatch(outcome.message, /draft may exist/i);
      } else {
        assert.match(outcome.message, /native draft may exist/i);
        assert.match(outcome.message, /exact CLI-owned profile used by this run/);
        assert.match(outcome.message, /Do not retry automatically/);
        assert.match(outcome.message, /--inspect cannot prove/);
      }
      assert.doesNotMatch(outcome.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);
    }
  }
});

test("runtime, untyped, wrong-mechanism, and malformed results default safely", async () => {
  const generated = await content("tweet");
  const cases: Array<{
    name: string;
    deps: XDraftRealRunDependencies;
    phase: "save_not_attempted" | "save_delivery_unknown";
  }> = [
    {
      name: "loader rejection",
      phase: "save_not_attempted",
      deps: dependencies(async () => { throw new Error(RAW_CANARY); }),
    },
    {
      name: "untyped stage rejection",
      phase: "save_delivery_unknown",
      deps: dependencies(async () => async () => { throw new Error(RAW_CANARY); }),
    },
    {
      name: "wrong typed mechanism",
      phase: "save_delivery_unknown",
      deps: dependencies(async () => async () => {
        throw new XDraftStageError("save_not_attempted", "article_create_autosave");
      }),
    },
    {
      name: "undefined result",
      phase: "save_delivery_unknown",
      deps: dependencies(async () => async () => undefined as unknown as StageDraftResult),
    },
    {
      name: "wrong result mechanism",
      phase: "save_delivery_unknown",
      deps: dependencies(async () => async () => stageResult(generated, "verified", {
        saveMechanism: "article_create_autosave",
      })),
    },
    {
      name: "wrong result post count",
      phase: "save_delivery_unknown",
      deps: dependencies(async () => async () => stageResult(generated, "verified", {
        posts: 2,
      })),
    },
  ];

  for (const fixture of cases) {
    const outcome = await executeXDraftRealRun({ content: generated }, fixture.deps);
    assert.equal(outcome.savePhase, fixture.phase, fixture.name);
    assert.equal(outcome.exitCode, 1);
    assert.doesNotMatch(outcome.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);
  }
});

test("resolved unverified results never print poster notes; verified is the only success", async () => {
  for (const format of ["tweet", "thread", "article"] as const) {
    const generated = await content(format);
    const unverified = await executeXDraftRealRun(
      { content: generated },
      dependencies(async () => async () => stageResult(
        generated,
        "save_delivered_unverified",
        { note: RAW_CANARY },
      )),
    );
    assert.equal(unverified.kind, "save_incomplete");
    assert.equal(unverified.savePhase, "save_delivered_unverified");
    assert.equal(unverified.exitCode, 1);
    assert.match(unverified.message, /persistence was not verified/i);
    assert.doesNotMatch(unverified.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);

    const verified = await executeXDraftRealRun(
      { content: generated },
      dependencies(async () => async () => stageResult(generated, "verified")),
    );
    assert.equal(verified.kind, "staged");
    assert.equal(verified.savePhase, "verified");
    assert.equal(verified.exitCode, 0);
    assert.equal(verified.stream, "stdout");
    assert.match(verified.message, /Staged a NATIVE X draft.*NEVER posted/s);
    assert.match(
      verified.message,
      format === "article"
        ? /verified by reopening the canonical Article edit URL: yes/
        : /verified in X Unsent\/Drafts: yes/,
    );
  }
});

test("throwing and stateful draft-result getters cannot leak or manufacture success", async () => {
  const generated = await content("tweet");
  const throwing = Object.defineProperty({}, "format", {
    get() { throw new Error(RAW_CANARY); },
  }) as StageDraftResult;
  const thrownOutcome = await executeXDraftRealRun(
    { content: generated },
    dependencies(async () => async () => throwing),
  );
  assert.equal(thrownOutcome.savePhase, "save_delivery_unknown");
  assert.equal(thrownOutcome.exitCode, 1);
  assert.doesNotMatch(thrownOutcome.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);

  let phaseReads = 0;
  const stateful = {
    format: "tweet",
    posts: 1,
    saveMechanism: "composer_close_save",
    note: "Bounded note.",
  } as unknown as StageDraftResult;
  Object.defineProperty(stateful, "savePhase", {
    get() {
      phaseReads += 1;
      return phaseReads === 1 ? "save_delivered_unverified" : "verified";
    },
  });
  const statefulOutcome = await executeXDraftRealRun(
    { content: generated },
    dependencies(async () => async () => stateful),
  );
  assert.equal(phaseReads, 1);
  assert.equal(statefulOutcome.kind, "save_incomplete");
  assert.equal(statefulOutcome.savePhase, "save_delivered_unverified");
  assert.equal(statefulOutcome.exitCode, 1);
});

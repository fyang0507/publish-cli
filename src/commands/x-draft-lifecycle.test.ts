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
  xDraftRowEvidenceNotApplicable,
  type XArticleDraftHandoff,
  type XDraftRowEvidence,
  type XDraftSaveMechanism,
} from "../x/saveProgress.js";

const RAW_CANARY =
  "selector=[data-secret] PRIVATE_PATH_CANARY/operator/secret cookie=session-secret page=Private composer text";

function mechanism(format: XFormat): XDraftSaveMechanism {
  return format === "article" ? "article_create_autosave" : "composer_close_save";
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

function composerEvidence(verified: boolean): XDraftRowEvidence {
  const baseline = observedRows(1, 0);
  return verified
    ? {
        status: "verified",
        method: "unsent_row_full_text_delta",
        contentMatch: "visible_scoped_multiset_plus_one",
        nativeRowId: "unavailable",
        listCompleteness: "visible_scoped_rows_only",
        baseline,
        postSave: observedRows(2, 1),
      }
    : {
        status: "unverified",
        method: "unsent_row_full_text_delta",
        contentMatch: "post_exact_missing",
        nativeRowId: "unavailable",
        listCompleteness: "visible_scoped_rows_only",
        baseline,
        postSave: observedRows(1, 0),
      };
}

function articleHandoff(
  cover: XArticleDraftHandoff["cover"] = {
    status: "missing",
    ratio: "not_observed",
    width: null,
    height: null,
    crop: "not_observed",
  },
  codeBlockCount: number | "many" = 0,
): XArticleDraftHandoff {
  return { body: "rich_html", codeBlockCount, cover };
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
  const draftRowEvidence = generated.format === "article"
    ? xDraftRowEvidenceNotApplicable()
    : composerEvidence(savePhase === "verified");
  return {
    format: generated.format,
    posts: generated.format === "thread" ? (generated.thread?.length ?? 0) : 1,
    saveMechanism: mechanism(generated.format),
    savePhase,
    note: "Bounded verified draft note.",
    draftRowEvidence,
    ...(generated.format === "article" ? { articleHandoff: articleHandoff() } : {}),
    ...overrides,
  } as StageDraftResult;
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
      assert.equal(outcome.draftRowEvidence, null);
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
    {
      name: "verified without row evidence",
      phase: "save_delivery_unknown",
      deps: dependencies(async () => async () => stageResult(generated, "verified", {
        draftRowEvidence: undefined,
      } as unknown as Partial<StageDraftResult>)),
    },
    {
      name: "verified with nonpositive row evidence",
      phase: "save_delivery_unknown",
      deps: dependencies(async () => async () => stageResult(generated, "verified", {
        draftRowEvidence: composerEvidence(false),
      } as unknown as Partial<StageDraftResult>)),
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
    assert.equal(
      unverified.draftRowEvidence?.status,
      format === "article" ? "not_applicable" : "unverified",
    );
    assert.equal(unverified.articleHandoff === null, format !== "article");
    assert.equal(unverified.exitCode, 1);
    assert.match(unverified.message, /persistence was not verified/i);
    if (format === "article") {
      assert.match(unverified.message, /heroAction=no supported cover selected.*codeBlockCount=0/s);
      assert.match(unverified.message, /HERO IMAGE MISSING/);
    }
    assert.doesNotMatch(unverified.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);

    const verified = await executeXDraftRealRun(
      { content: generated },
      dependencies(async () => async () => stageResult(
        generated,
        "verified",
        { note: RAW_CANARY },
      )),
    );
    assert.equal(verified.kind, "staged");
    assert.equal(verified.savePhase, "verified");
    assert.equal(verified.exitCode, 0);
    assert.equal(verified.stream, "stdout");
    assert.equal(
      verified.draftRowEvidence?.status,
      format === "article" ? "not_applicable" : "verified",
    );
    assert.match(
      verified.message,
      format === "article"
        ? /Staged a NATIVE X draft.*NEVER posted/s
        : /Native X Save action returned.*NEVER posted.*scoped-row observation: positive/s,
    );
    assert.match(
      verified.message,
      format === "article"
        ? /persistence verified by reopening the captured canonical Article edit URL: yes/
        : format === "thread"
          ? /full intended first thread-row text observed in one calibrated X Unsent draft row: yes/
          : /full intended tweet text observed in one calibrated X Unsent draft row: yes/,
    );
    if (format !== "article") {
      assert.doesNotMatch(verified.message, /Staged a NATIVE X draft/);
      assert.match(verified.message, /full-list completeness and causality: unproven/);
    } else {
      assert.match(verified.message, /heroAction=no supported cover selected.*codeBlockCount=0/s);
      assert.match(verified.message, /HERO IMAGE MISSING/);
    }
    assert.doesNotMatch(verified.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);
  }
});

test("verified and returned-unverified Article receipts preserve only closed handoff facts", async () => {
  const generated = await content("article");
  const cases: Array<{
    handoff: XArticleDraftHandoff;
    expected: RegExp[];
  }> = [
    {
      handoff: articleHandoff(undefined, 1),
      expected: [/heroAction=no supported cover selected/, /codeBlockCount=1/, /1 code block NOT auto-formatted/, /HERO IMAGE MISSING/],
    },
    {
      handoff: articleHandoff(undefined, "many"),
      expected: [/codeBlockCount=>10000/, /More than 10000 code blocks NOT auto-formatted/, /HERO IMAGE MISSING/],
    },
    {
      handoff: articleHandoff({
        status: "upload_incomplete",
        ratio: "outside_5_2",
        width: 1200,
        height: 600,
        crop: "not_observed",
      }, 2),
      expected: [/heroAction=upload action incomplete; attachment unconfirmed/, /codeBlockCount=2/, /2 code blocks NOT auto-formatted/, /HERO IMAGE RATIO/, /HERO UPLOAD INCOMPLETE/],
    },
    {
      handoff: articleHandoff({
        status: "upload_incomplete",
        ratio: "unknown",
        width: null,
        height: null,
        crop: "not_observed",
      }),
      expected: [/heroAction=upload action incomplete; attachment unconfirmed/, /HERO IMAGE RATIO UNVERIFIED/, /HERO UPLOAD INCOMPLETE/],
    },
    {
      handoff: articleHandoff({
        status: "attached",
        ratio: "within_5_2",
        width: 1500,
        height: 600,
        crop: "unverified",
      }),
      expected: [/heroAction=upload action returned; attachment and persistence unverified/, /codeBlockCount=0/, /HERO CROP UNVERIFIED/],
    },
    {
      handoff: articleHandoff({
        status: "attached",
        ratio: "within_5_2",
        width: 1500,
        height: 600,
        crop: "applied",
      }),
      expected: [/heroAction=upload action returned; attachment and persistence unverified/, /Hero upload and crop\/apply actions returned/, /cover persistence remains manual-review evidence only/],
    },
  ];
  for (const fixture of cases) {
    const expectedCount = fixture.handoff.codeBlockCount === "many"
      ? 10_001
      : fixture.handoff.codeBlockCount;
    const fixtureGenerated: GeneratedContent = {
      ...generated,
      codeFlags: Array.from({ length: expectedCount }, (_, index) => ({
        index: index + 1,
        preview: "",
        sourceLine: index + 1,
      })),
      article: {
        ...generated.article!,
        blocks: [
          ...generated.article!.blocks,
          ...Array.from({ length: expectedCount }, (_, index) => ({
            kind: "code" as const,
            index: index + 1,
            text: "",
          })),
        ],
        codeBlockCount: expectedCount,
      },
    };
    for (const phase of ["verified", "save_delivered_unverified"] as const) {
      const outcome = await executeXDraftRealRun(
        { content: fixtureGenerated },
        dependencies(async () => async () => stageResult(fixtureGenerated, phase, {
          articleHandoff: fixture.handoff,
          note: RAW_CANARY,
        })),
      );
      assert.equal(outcome.kind, phase === "verified" ? "staged" : "save_incomplete");
      assert.equal(outcome.exitCode, phase === "verified" ? 0 : 1);
      assert.deepEqual(outcome.articleHandoff, fixture.handoff);
      for (const pattern of fixture.expected) assert.match(outcome.message, pattern);
      if (phase === "save_delivered_unverified") {
        assert.match(outcome.message, /native Save\/autosave action returned, but persistence was not verified/i);
        assert.match(outcome.message, /compare X Articles → Drafts manually in the exact CLI-owned profile/);
      }
      assert.doesNotMatch(outcome.message, /hero=attached|cover (?:was )?attached|cover persistence (?:was )?verified/i);
      assert.doesNotMatch(outcome.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);
    }
  }
});

test("malformed and stateful Article handoff facts cannot leak or change after validation", async () => {
  const generated = await content("article");
  const malformed = [
    null,
    { body: "rich_html", codeBlockCount: -1, cover: articleHandoff().cover },
    {
      body: "rich_html",
      codeBlockCount: 0,
      cover: {
        status: "upload_incomplete",
        ratio: "outside_5_2",
        width: 1500,
        height: 600,
        crop: "not_observed",
      },
    },
    Object.defineProperty({}, "body", {
      get() { throw new Error(RAW_CANARY); },
    }),
  ];
  for (const value of malformed) {
    for (const phase of ["verified", "save_delivered_unverified"] as const) {
      const outcome = await executeXDraftRealRun(
        { content: generated },
        dependencies(async () => async () => stageResult(generated, phase, {
          articleHandoff: value as never,
          note: RAW_CANARY,
        })),
      );
      assert.equal(outcome.savePhase, "save_delivery_unknown");
      assert.equal(outcome.articleHandoff, null);
      assert.doesNotMatch(outcome.message, /HERO IMAGE|codeBlockCount|data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);
    }
  }

  for (const phase of ["verified", "save_delivered_unverified"] as const) {
    let statusReads = 0;
    const cover = {
      ratio: "within_5_2",
      width: 1500,
      height: 600,
      crop: "not_observed",
    } as Record<string, unknown>;
    Object.defineProperty(cover, "status", {
      get() {
        statusReads += 1;
        return statusReads === 1 ? "upload_incomplete" : "attached";
      },
    });
    const outcome = await executeXDraftRealRun(
      { content: generated },
      dependencies(async () => async () => stageResult(generated, phase, {
        articleHandoff: { body: "rich_html", codeBlockCount: 0, cover } as never,
        note: RAW_CANARY,
      })),
    );
    assert.equal(statusReads, 1);
    assert.equal(outcome.kind, phase === "verified" ? "staged" : "save_incomplete");
    assert.equal(outcome.exitCode, phase === "verified" ? 0 : 1);
    assert.equal(outcome.articleHandoff?.cover.status, "upload_incomplete");
    assert.match(outcome.message, /HERO UPLOAD INCOMPLETE/);
    assert.doesNotMatch(outcome.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);
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
    draftRowEvidence: composerEvidence(false),
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

test("throwing or stateful nested row evidence is read once and cannot manufacture success", async () => {
  const generated = await content("tweet");
  const throwingEvidence = Object.defineProperty({}, "status", {
    get() { throw new Error(RAW_CANARY); },
  });
  const throwing = stageResult(generated, "verified", {
    draftRowEvidence: throwingEvidence as never,
    note: RAW_CANARY,
  });
  const thrown = await executeXDraftRealRun(
    { content: generated },
    dependencies(async () => async () => throwing),
  );
  assert.equal(thrown.savePhase, "save_delivery_unknown");
  assert.equal(thrown.draftRowEvidence, null);
  assert.doesNotMatch(thrown.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);

  let statusReads = 0;
  const statefulEvidence = {
    ...composerEvidence(false),
  } as Record<string, unknown>;
  Object.defineProperty(statefulEvidence, "status", {
    get() {
      statusReads += 1;
      return statusReads === 1 ? "unverified" : "verified";
    },
  });
  const stateful = stageResult(generated, "verified", {
    draftRowEvidence: statefulEvidence as never,
  });
  const outcome = await executeXDraftRealRun(
    { content: generated },
    dependencies(async () => async () => stateful),
  );
  assert.equal(statusReads, 1);
  assert.equal(outcome.savePhase, "save_delivery_unknown");
  assert.equal(outcome.draftRowEvidence, null);

  const contradictory = stageResult(generated, "save_delivered_unverified", {
    draftRowEvidence: {
      ...composerEvidence(false),
      postSave: observedRows(2, 1),
    },
  } as unknown as Partial<StageDraftResult>);
  const contradictoryOutcome = await executeXDraftRealRun(
    { content: generated },
    dependencies(async () => async () => contradictory),
  );
  assert.equal(contradictoryOutcome.savePhase, "save_delivery_unknown");
  assert.equal(contradictoryOutcome.draftRowEvidence, null);
});

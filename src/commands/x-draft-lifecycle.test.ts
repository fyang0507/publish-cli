import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeXDraftRealRun,
  type XDraftRealRunDependencies,
  type XDraftRealRunInput,
} from "./draft.js";
import { generateContent, type GeneratedContent, type XFormat } from "../x/content.js";
import { snapshotXArticleStageInput } from "../x/articleStageSnapshot.js";
import { preloadXArticleCover } from "../x/articleCover.js";
import { emptyXArticleBodyImagePreloadSet } from "../x/articleBodyImages.js";
import type { StageDraftResult } from "../x/draftPoster.js";
import {
  isXDraftStageError,
  XDraftStageError,
  xDraftRowEvidenceNotApplicable,
  type XArticleDraftHandoff,
  type XDraftRowEvidence,
  type XDraftSaveMechanism,
} from "../x/saveProgress.js";

const RAW_CANARY =
  "selector=[data-secret] PRIVATE_PATH_CANARY/operator/secret cookie=session-secret page=Private composer text";

const COVER_DIR = mkdtempSync(join(tmpdir(), "publish-x-draft-lifecycle-cover-"));
const COVER_PATH = join(COVER_DIR, "cover.png");
const COVER_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAUAAAACCAIAAAAfCIEKAAAACXBIWXMAAAABAAAAAQBPJcTWAAAADklEQVR4nGNkQAUsaHwAAIAABtETi70AAAAASUVORK5CYII=",
  "base64",
);
writeFileSync(COVER_PATH, COVER_BYTES);
const ARTICLE_COVER = preloadXArticleCover(COVER_PATH);
test.after(() => rmSync(COVER_DIR, { recursive: true, force: true }));

function verifiedCover(
  overrides: Partial<XArticleDraftHandoff["cover"]> = {},
): XArticleDraftHandoff["cover"] {
  return {
    selection: "explicit",
    contentType: ARTICLE_COVER.contentType,
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
    verified: true,
    ...overrides,
  };
}

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
  cover: XArticleDraftHandoff["cover"] = verifiedCover(),
  codeBlockCount: number | "many" = 0,
): XArticleDraftHandoff {
  return {
    body: "rich_html",
    codeBlockCount,
    codeAdvisories: [],
    codeLinkAdvisories: [],
    cover,
    bodyImages: [],
  };
}

function articleHandoffFor(
  generated: GeneratedContent,
  cover: XArticleDraftHandoff["cover"] = articleHandoff().cover,
): XArticleDraftHandoff {
  const snapshot = snapshotXArticleStageInput(generated, "article");
  return {
    body: "rich_html",
    codeBlockCount: snapshot.receiptCodeBlockCount,
    codeAdvisories: snapshot.codeAdvisories,
    codeLinkAdvisories: snapshot.codeLinkAdvisories,
    cover,
    bodyImages: [],
  };
}

async function content(format: XFormat): Promise<GeneratedContent> {
  return generateContent(
    format === "article" ? "# Offline article\n\nBody prefix for persistence matching." : "Offline X draft.",
    { format },
  );
}

function runInput(
  generated: GeneratedContent,
  extras: Omit<XDraftRealRunInput, "content" | "cover"> = {},
): XDraftRealRunInput {
  return generated.format === "article"
    ? { content: generated, ...extras, cover: ARTICLE_COVER }
    : { content: generated, ...extras };
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
    ...(generated.format === "article"
      ? {
          articleHandoff: articleHandoffFor(generated),
          nativeReference: "https://x.com/compose/articles/edit/12345",
        }
      : {}),
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
        runInput(generated, {
          inspect: true,
          ...(format === "article"
            ? {}
            : { basePath: "PRIVATE_PATH_CANARY/operator/source.md" }),
        }),
        dependencies(async () => async (_content, opts) => {
          assert.deepEqual(opts, format === "article"
            ? {
                inspect: true,
                cover: ARTICLE_COVER,
                bodyImages: emptyXArticleBodyImagePreloadSet(),
              }
            : { inspect: true, basePath: "PRIVATE_PATH_CANARY/operator/source.md" });
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
    const outcome = await executeXDraftRealRun(runInput(generated), fixture.deps);
    assert.equal(outcome.savePhase, fixture.phase, fixture.name);
    assert.equal(outcome.exitCode, 1);
    assert.doesNotMatch(outcome.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);
  }
});

test("hostile thrown stage errors are snapshotted without getter reads or raw output", async () => {
  const generated = await content("tweet");
  const hostileText = `${RAW_CANARY}\u001b[31m\0${"x".repeat(100_000)}`;
  let phaseReads = 0;
  let mechanismReads = 0;
  const accessorError = Object.create(XDraftStageError.prototype) as object;
  Object.defineProperties(accessorError, {
    savePhase: {
      enumerable: true,
      get() {
        phaseReads += 1;
        return phaseReads === 1 ? "save_not_attempted" : hostileText;
      },
    },
    saveMechanism: {
      enumerable: true,
      get() {
        mechanismReads += 1;
        throw new Error(hostileText);
      },
    },
  });

  class AccessorStageError extends XDraftStageError {
    constructor() {
      super("save_not_attempted", "composer_close_save");
      Object.defineProperties(this, {
        savePhase: {
          enumerable: true,
          get() {
            phaseReads += 1;
            return phaseReads === 1 ? "save_not_attempted" : hostileText;
          },
        },
        saveMechanism: {
          enumerable: true,
          get() {
            mechanismReads += 1;
            throw new Error(hostileText);
          },
        },
      });
    }
  }
  const subclassError = new AccessorStageError();

  const mutated = new XDraftStageError("save_not_attempted", "composer_close_save");
  Object.defineProperty(mutated, "savePhase", { value: hostileText });

  const hostileProxy = new Proxy(
    new XDraftStageError("save_not_attempted", "composer_close_save"),
    {
      get() {
        throw new Error(hostileText);
      },
    },
  );
  const revoked = Proxy.revocable(
    new XDraftStageError("save_not_attempted", "composer_close_save"),
    {},
  );
  revoked.revoke();

  for (const error of [accessorError, subclassError, mutated, hostileProxy, revoked.proxy]) {
    let loaderCalls = 0;
    let stageCalls = 0;
    const outcome = await executeXDraftRealRun(
      { content: generated },
      dependencies(async () => {
        loaderCalls += 1;
        return async () => {
          stageCalls += 1;
          throw error;
        };
      }),
    );
    assert.equal(loaderCalls, 1);
    assert.equal(stageCalls, 1);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.savePhase, "save_delivery_unknown");
    assert.equal(outcome.saveMechanism, "composer_close_save");
    assert.ok(outcome.message.length < 2_000);
    assert.doesNotMatch(outcome.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|\u001b|\0/);
    assert.equal(isXDraftStageError(error), false);
  }
  assert.equal(phaseReads, 0);
  assert.equal(mechanismReads, 0);
});

test("resolved unverified results never print poster notes; verified is the only success", async () => {
  for (const format of ["tweet", "thread", "article"] as const) {
    const generated = await content(format);
    const unverified = await executeXDraftRealRun(
      runInput(generated),
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
      assert.match(unverified.message, /heroAction=exact preloaded cover observed after canonical draft reopen.*codeBlockCount=0/s);
      assert.match(unverified.message, /Cover evidence: requested=yes; resolved=yes; set=yes; uploaded=unknown; observed=yes; verified=yes; apply=returned/);
    }
    assert.doesNotMatch(unverified.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);

    const verified = await executeXDraftRealRun(
      runInput(generated),
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
      assert.match(verified.message, /heroAction=exact preloaded cover observed after canonical draft reopen.*codeBlockCount=0/s);
      assert.match(verified.message, /Cover evidence: requested=yes; resolved=yes; set=yes; uploaded=unknown; observed=yes; verified=yes; apply=returned/);
    }
    assert.doesNotMatch(verified.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);
  }
});

test("verified and returned-unverified Article receipts preserve only closed handoff facts", async () => {
  const cases: Array<{
    codeBlockCount: number;
    cover?: XArticleDraftHandoff["cover"];
    expected: RegExp[];
  }> = [
    {
      codeBlockCount: 1,
      expected: [/heroAction=exact preloaded cover observed after canonical draft reopen/, /codeBlockCount=1/, /1 code block NOT auto-formatted/, /verified=yes/],
    },
    {
      codeBlockCount: 2,
      cover: verifiedCover({
        set: false,
        setPhase: "target_unavailable",
        applyPhase: "not_attempted",
        observed: false,
        verified: false,
      }),
      expected: [/heroAction=exact preloaded cover not set \(target_unavailable\)/, /codeBlockCount=2/, /2 code blocks NOT auto-formatted/, /set=no/, /HERO PERSISTENCE UNVERIFIED/],
    },
    {
      codeBlockCount: 0,
      cover: verifiedCover({
        set: null,
        setPhase: "set_delivery_unknown",
        applyPhase: "not_attempted",
        observed: false,
        verified: null,
      }),
      expected: [/heroAction=exact preloaded cover delivery unknown/, /set=unknown/, /apply=not_attempted/, /HERO PERSISTENCE UNVERIFIED/],
    },
    {
      codeBlockCount: 0,
      cover: verifiedCover({
        applyPhase: "not_attempted",
        observed: true,
        verified: false,
      }),
      expected: [/heroAction=exact preloaded cover set; persistence not verified/, /codeBlockCount=0/, /observed=yes; verified=no; apply=not_attempted/, /HERO PERSISTENCE UNVERIFIED/],
    },
    {
      codeBlockCount: 0,
      cover: verifiedCover(),
      expected: [/heroAction=exact preloaded cover observed after canonical draft reopen/, /explicit image\/png; 5x2; exact 5:2/, /set=yes; uploaded=unknown; observed=yes; verified=yes; apply=returned/],
    },
  ];
  for (const fixture of cases) {
    const blocks = Array.from(
      { length: fixture.codeBlockCount },
      (_, index) => `\n\n\`\`\`txt\nreceipt-${index + 1}\n\`\`\``,
    ).join("");
    const fixtureGenerated = await generateContent(
      `# Offline article\n\nBody prefix for persistence matching.${blocks}`,
      { format: "article" },
    );
    const handoff = articleHandoffFor(fixtureGenerated, fixture.cover);
    const phases = handoff.cover.verified === true
      ? (["verified", "save_delivered_unverified"] as const)
      : (["save_delivered_unverified"] as const);
    for (const phase of phases) {
      const outcome = await executeXDraftRealRun(
        runInput(fixtureGenerated),
        dependencies(async () => async () => stageResult(fixtureGenerated, phase, {
          articleHandoff: handoff,
          note: RAW_CANARY,
        })),
      );
      assert.equal(outcome.kind, phase === "verified" ? "staged" : "save_incomplete");
      assert.equal(outcome.exitCode, phase === "verified" ? 0 : 1);
      assert.deepEqual(outcome.articleHandoff, handoff);
      assert.equal(
        outcome.nativeReference,
        "https://x.com/compose/articles/edit/12345",
      );
      for (const pattern of fixture.expected) assert.match(outcome.message, pattern);
      if (fixture.codeBlockCount > 0) {
        assert.match(outcome.message, /LF-normalized exact fence source sha256=[a-f0-9]{64}/);
        assert.match(outcome.message, /info=.*truncated=false.*preview=.*truncated=false/);
      }
      if (phase === "save_delivered_unverified") {
        assert.match(outcome.message, /native Save\/autosave action returned, but persistence was not verified/i);
        assert.match(outcome.message, /compare X Articles → Drafts manually in the exact CLI-owned profile/);
      }
      assert.doesNotMatch(outcome.message, /hero=attached|cover (?:was )?attached/i);
      assert.doesNotMatch(outcome.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);
    }
  }
});

test("a verified Article result without a canonical native reference cannot exit zero", async () => {
  const generated = await content("article");
  const hostile = {
    ...stageResult(generated, "verified"),
    nativeReference: null,
  } as unknown as StageDraftResult;
  const outcome = await executeXDraftRealRun(
    runInput(generated),
    dependencies(async () => async () => hostile),
  );

  assert.equal(outcome.kind, "save_incomplete");
  assert.equal(outcome.savePhase, "save_delivery_unknown");
  assert.equal(outcome.saveMechanism, "article_create_autosave");
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.stream, "stderr");
  assert.equal(outcome.nativeReference, null);
  assert.equal(outcome.articleHandoff, null);
  assert.doesNotMatch(outcome.message, /persistence verified.*yes/i);
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
        ...verifiedCover(),
        ratio: "outside_5_2",
      },
    },
    Object.defineProperty({}, "body", {
      get() { throw new Error(RAW_CANARY); },
    }),
  ];
  for (const value of malformed) {
    for (const phase of ["verified", "save_delivered_unverified"] as const) {
      const outcome = await executeXDraftRealRun(
        runInput(generated),
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
    let setPhaseReads = 0;
    const cover = {
      ...verifiedCover(),
    } as Record<string, unknown>;
    Object.defineProperty(cover, "setPhase", {
      get() {
        setPhaseReads += 1;
        return setPhaseReads === 1 ? "set_returned" : "target_unavailable";
      },
    });
    const baseHandoff = articleHandoffFor(generated);
    const outcome = await executeXDraftRealRun(
      runInput(generated),
      dependencies(async () => async () => stageResult(generated, phase, {
        articleHandoff: { ...baseHandoff, cover } as never,
        note: RAW_CANARY,
      })),
    );
    assert.equal(setPhaseReads, 0);
    assert.equal(outcome.kind, "save_incomplete");
    assert.equal(outcome.savePhase, "save_delivery_unknown");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.articleHandoff, null);
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
  assert.equal(phaseReads, 0);
  assert.equal(statefulOutcome.kind, "save_incomplete");
  assert.equal(statefulOutcome.savePhase, "save_delivery_unknown");
  assert.equal(statefulOutcome.exitCode, 1);
});

test("resolved result getters cannot turn branded errors into pre-Save evidence", async () => {
  for (const format of ["tweet", "article"] as const) {
    const generated = await content(format);
    const expectedMechanism = mechanism(format);
    for (const phase of [
      "save_not_attempted",
      "save_delivery_unknown",
      "save_delivered_unverified",
    ] as const) {
      const mechanism = expectedMechanism;
      const branded = new XDraftStageError(phase, mechanism);
      let topLevelReads = 0;
      const topLevel = Object.defineProperty({}, "format", {
        enumerable: true,
        get() {
          topLevelReads += 1;
          throw branded;
        },
      }) as StageDraftResult;
      const topLevelOutcome = await executeXDraftRealRun(
        runInput(generated),
        dependencies(async () => async () => topLevel),
      );
      assert.equal(topLevelReads, format === "article" ? 1 : 0);
      assert.equal(topLevelOutcome.kind, "save_incomplete");
      assert.equal(topLevelOutcome.savePhase, "save_delivery_unknown");
      assert.equal(topLevelOutcome.saveMechanism, expectedMechanism);
      assert.equal(topLevelOutcome.exitCode, 1);

      let nestedReads = 0;
      const nested = stageResult(generated, "verified");
      const nestedTarget = nested.saveMechanism === "article_create_autosave"
        ? nested.articleHandoff.cover
        : nested.draftRowEvidence;
      Object.defineProperty(nestedTarget, "status", {
        enumerable: true,
        get() {
          nestedReads += 1;
          throw branded;
        },
      });
      const nestedOutcome = await executeXDraftRealRun(
        runInput(generated),
        dependencies(async () => async () => nested),
      );
      assert.equal(nestedReads, 0);
      assert.equal(nestedOutcome.kind, "save_incomplete");
      assert.equal(nestedOutcome.savePhase, "save_delivery_unknown");
      assert.equal(nestedOutcome.saveMechanism, expectedMechanism);
      assert.equal(nestedOutcome.exitCode, 1);
    }
  }

  const generated = await content("tweet");
  let statefulReads = 0;
  const stateful = Object.defineProperty({}, "format", {
    enumerable: true,
    get() {
      statefulReads += 1;
      if (statefulReads === 1) {
        throw new XDraftStageError("save_not_attempted", "composer_close_save");
      }
      return "tweet";
    },
  }) as StageDraftResult;
  const statefulOutcome = await executeXDraftRealRun(
    { content: generated },
    dependencies(async () => async () => stateful),
  );
  assert.equal(statefulReads, 0);
  assert.equal(statefulOutcome.savePhase, "save_delivery_unknown");
  assert.equal(statefulOutcome.exitCode, 1);

  const revoked = Proxy.revocable(stageResult(generated, "verified"), {});
  revoked.revoke();
  const revokedOutcome = await executeXDraftRealRun(
    { content: generated },
    dependencies(async () => async () => revoked.proxy),
  );
  assert.equal(revokedOutcome.savePhase, "save_delivery_unknown");
  assert.equal(revokedOutcome.saveMechanism, "composer_close_save");
  assert.equal(revokedOutcome.exitCode, 1);
});

test("throwing or stateful nested row evidence cannot be invoked or manufacture success", async () => {
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
  assert.equal(statusReads, 0);
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

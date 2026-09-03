import test from "node:test";
import assert from "node:assert/strict";
import {
  executeReplyRealRun,
  executeReplyReservationRecovery,
  type ReplyLedgerPort,
  type ReplyRealRunDependencies,
  type ReplyRealRunInput,
} from "./reply.js";
import type {
  ReplyLedgerEntry,
  ReplyReservation,
  ReplyReservationRecovery,
  ReplyReservationState,
} from "../db.js";
import type { GeneratedContent } from "../x/content.js";
import type { StageReplyResult } from "../x/draftPoster.js";
import {
  XDraftStageError,
  xReplyTargetEvidenceNotCalibrated,
  xReplyTargetEvidenceNotChecked,
  type XDraftRowEvidence,
  type XDraftSaveFailurePhase,
  type XReplyTargetEvidence,
} from "../x/saveProgress.js";

const TARGET_ID = "1234567890123456789";
const OTHER_TARGET_ID = "9876543210987654321";
const TARGET_URL = `https://x.com/operator/status/${TARGET_ID}`;
const RAW_CANARY =
  "selector=[data-secret] PRIVATE_PATH_CANARY/operator/secret cookie=session-secret page=Private composer text";

const CONTENT: GeneratedContent = {
  format: "tweet",
  limit: 280,
  tweet: {
    text: "Offline reply lifecycle fixture.",
    chars: 32,
    unit: "twitter_text_weighted",
  },
  codeFlags: [],
  linkFlags: [],
  fidelityFlags: [],
  warnings: [],
};

const THREAD_CONTENT: GeneratedContent = {
  format: "thread",
  limit: 280,
  thread: [
    { index: 1, total: 2, text: "1/2 First reply-thread row.", chars: 27 },
    { index: 2, total: 2, text: "2/2 Second reply-thread row.", chars: 28 },
  ],
  codeFlags: [],
  linkFlags: [],
  fidelityFlags: [],
  warnings: [],
};

const PRIOR: ReplyLedgerEntry = {
  targetTweetId: TARGET_ID,
  stagedAt: "2026-09-03T00:00:00.000Z",
  status: "staged",
  draftRef: null,
};

const RESERVATION: ReplyReservation = {
  targetTweetId: TARGET_ID,
  reservationId: "offline-owner-token",
  reservedAt: "2026-09-03T01:00:00.000Z",
};

interface HarnessOptions {
  prior?: ReplyLedgerEntry;
  blockedState?: ReplyReservationState;
  verified?: boolean;
  openFails?: boolean;
  claimFails?: boolean;
  loadStageFails?: boolean;
  loadStageNonFunction?: boolean;
  stageFails?: boolean;
  stageFailurePhase?: XDraftSaveFailurePhase;
  stageFailureMechanism?: "composer_close_save" | "article_create_autosave";
  stageReturnsUndefined?: boolean;
  stageReplyToId?: string;
  stageResultMechanism?: "composer_close_save" | "article_create_autosave";
  stageResultPosts?: number;
  stageResultGetter?: "throwing" | "stateful";
  stageRowEvidence?: unknown;
  stageRowEvidenceGetter?: "throwing" | "stateful";
  stageTargetEvidence?: unknown;
  stageTargetEvidenceGetter?: "throwing" | "stateful";
  stageNote?: string;
  finalizeFails?: boolean;
  releaseFails?: boolean;
  releaseReturnsFalse?: boolean;
  closeFails?: boolean;
  recovery?: ReplyReservationRecovery;
  recoveryFails?: boolean;
}

interface Harness {
  deps: ReplyRealRunDependencies;
  events: string[];
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

function replyTargetEvidence(verified: boolean): XReplyTargetEvidence {
  return verified
    ? {
        status: "verified",
        method: "same_content_row_target_id",
        scope: "current_save_attempt",
        requestedTargetId: TARGET_ID,
        rowBinding: "same_content_matched_draft",
        targetMatch: "exact",
        targetContextCount: 1,
        distinctStatusIdCount: 1,
        reason: "exact_requested_target",
      }
    : xReplyTargetEvidenceNotChecked(TARGET_ID);
}

function createHarness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const deps: ReplyRealRunDependencies = {
    async openLedger() {
      events.push("ledger:open");
      if (options.openFails) throw new Error("RAW_OPEN_ERROR_WITH_PRIVATE_PATH");
      const ledger: ReplyLedgerPort = {
        claimReservation(targetTweetId, claimOptions) {
          events.push(`ledger:claim:${targetTweetId}:force=${Boolean(claimOptions?.force)}`);
          if (options.claimFails) throw new Error("RAW_CLAIM_ERROR_WITH_PRIVATE_PATH");
          if (options.blockedState) {
            return {
              kind: "reservation_blocked",
              reservation: RESERVATION,
              state: options.blockedState,
            };
          }
          if (options.prior && !claimOptions?.force) {
            return { kind: "already_staged", entry: options.prior };
          }
          return { kind: "acquired", reservation: RESERVATION };
        },
        releaseReservation(reservation) {
          events.push(`ledger:release:${reservation.reservationId}`);
          if (options.releaseFails) throw new Error("RAW_RELEASE_ERROR_WITH_PRIVATE_PATH");
          return !options.releaseReturnsFalse;
        },
        finalizeReservation(reservation, finalizeOptions) {
          events.push(
            `ledger:finalize:${reservation.targetTweetId}:${finalizeOptions?.status ?? "missing"}`,
          );
          if (options.finalizeFails) throw new Error("RAW_FINALIZE_ERROR_WITH_PRIVATE_PATH");
        },
        recoverStaleReservation(targetTweetId) {
          events.push(`ledger:recover:${targetTweetId}`);
          if (options.recoveryFails) throw new Error("RAW_RECOVERY_ERROR_WITH_PRIVATE_PATH");
          return options.recovery ?? { kind: "missing" };
        },
        close() {
          events.push("ledger:close");
          if (options.closeFails) throw new Error("RAW_CLOSE_ERROR_WITH_PRIVATE_PATH");
        },
      };
      return ledger;
    },
    async loadStageReplyDraft() {
      events.push("stage:load");
      if (options.loadStageFails) throw new Error("RAW_STAGE_LOAD_ERROR_WITH_PRIVATE_PATH");
      if (options.loadStageNonFunction) return undefined as never;
      return async (content, targetIdOrUrl, stageOptions): Promise<StageReplyResult> => {
        events.push(`stage:run:${targetIdOrUrl}:${content.format}`);
        assert.deepEqual(stageOptions, { inspect: true });
        assert.equal("force" in stageOptions, false, "dedupe --force must not become session force");
        if (options.stageFails) throw new Error("NATIVE_STAGE_ERROR");
        if (options.stageFailurePhase) {
          throw new XDraftStageError(
            options.stageFailurePhase,
            options.stageFailureMechanism ?? "composer_close_save",
          );
        }
        if (options.stageReturnsUndefined) return undefined as unknown as StageReplyResult;
        const result = {
          format: content.format,
          posts: options.stageResultPosts ?? (content.format === "thread" ? (content.thread?.length ?? 0) : 1),
          saveMechanism: options.stageResultMechanism ?? "composer_close_save",
          savePhase: options.verified ? "verified" : "save_delivered_unverified",
          draftRowEvidence: Object.prototype.hasOwnProperty.call(options, "stageRowEvidence")
            ? options.stageRowEvidence
            : rowEvidence(Boolean(options.verified)),
          replyTargetEvidence: Object.prototype.hasOwnProperty.call(options, "stageTargetEvidence")
            ? options.stageTargetEvidence
            : replyTargetEvidence(Boolean(options.verified)),
          note: options.stageNote ?? "Offline injected stage result.",
          replyToId: options.stageReplyToId ?? TARGET_ID,
        } as StageReplyResult;
        if (options.stageResultGetter === "throwing") {
          Object.defineProperty(result, "savePhase", {
            get() { throw new Error("RAW_STAGE_RESULT_GETTER_PRIVATE_PATH"); },
          });
        } else if (options.stageResultGetter === "stateful") {
          let reads = 0;
          Object.defineProperty(result, "savePhase", {
            get() {
              reads += 1;
              events.push(`stage:phase-read:${reads}`);
              return reads === 1 ? "save_delivered_unverified" : "verified";
            },
          });
        }
        if (options.stageRowEvidenceGetter === "throwing") {
          Object.defineProperty(result, "draftRowEvidence", {
            get() { throw new Error("RAW_ROW_EVIDENCE_GETTER_PRIVATE_PATH"); },
          });
        } else if (options.stageRowEvidenceGetter === "stateful") {
          let reads = 0;
          Object.defineProperty(result, "draftRowEvidence", {
            get() {
              reads += 1;
              events.push(`stage:evidence-read:${reads}`);
              return reads === 1 ? rowEvidence(false) : rowEvidence(true);
            },
          });
        }
        if (options.stageTargetEvidenceGetter === "throwing") {
          Object.defineProperty(result, "replyTargetEvidence", {
            get() { throw new Error("RAW_TARGET_EVIDENCE_GETTER_PRIVATE_PATH"); },
          });
        } else if (options.stageTargetEvidenceGetter === "stateful") {
          let reads = 0;
          Object.defineProperty(result, "replyTargetEvidence", {
            get() {
              reads += 1;
              events.push(`stage:target-evidence-read:${reads}`);
              return reads === 1
                ? xReplyTargetEvidenceNotCalibrated(TARGET_ID)
                : replyTargetEvidence(true);
            },
          });
        }
        return result;
      };
    },
  };
  return { deps, events };
}

function input(overrides: Partial<ReplyRealRunInput> = {}): ReplyRealRunInput {
  return {
    content: CONTENT,
    targetIdOrUrl: TARGET_URL,
    replyToId: TARGET_ID,
    inspect: true,
    ...overrides,
  };
}

test("post-save finalization failure preserves phase evidence without claiming durable state", async () => {
  for (const [verified, status, draftEvidence] of [
    [false, "staged-unverified", /native draft may exist/i],
    [true, "staged", /full intended X reply text observed.*exact requested status id bound.*yes/i],
  ] as const) {
    const harness = createHarness({ finalizeFails: true, verified });
    const outcome = await executeReplyRealRun(input(), harness.deps);

    assert.deepEqual(harness.events, [
      "ledger:open",
      `ledger:claim:${TARGET_ID}:force=false`,
      "stage:load",
      `stage:run:${TARGET_URL}:tweet`,
      `ledger:finalize:${TARGET_ID}:${status}`,
      "ledger:close",
    ]);
    assert.equal(outcome.kind, "ledger_persistence_failed");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.stream, "stderr");
    assert.match(outcome.message, new RegExp(`Save-phase evidence was produced for target ${TARGET_ID}`));
    assert.match(outcome.message, draftEvidence);
    assert.match(outcome.message, /record and reservation finalization outcome could not be confirmed/);
    assert.match(outcome.message, /reservation and finalized-history state are unknown/);
    assert.equal(outcome.savePhase, verified ? "verified" : "save_delivered_unverified");
    assert.equal(outcome.draftRowEvidence?.status, verified ? "verified" : "unverified");
    assert.match(outcome.message, /exact CLI-owned profile used by this run/);
    assert.doesNotMatch(
      outcome.message,
      /Failed to stage|RAW_FINALIZE_ERROR_WITH_PRIVATE_PATH|offline-owner-token/,
    );
  }
});

test("finalize and close failures retain mixed positive-content target-unavailable facts", async () => {
  for (const closeFails of [false, true]) {
    const harness = createHarness({
      stageRowEvidence: rowEvidence(true),
      stageTargetEvidence: xReplyTargetEvidenceNotCalibrated(TARGET_ID),
      finalizeFails: !closeFails,
      closeFails,
    });
    const outcome = await executeReplyRealRun(input(), harness.deps);
    assert.equal(outcome.kind, "ledger_persistence_failed");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.savePhase, "save_delivered_unverified");
    assert.equal(outcome.draftRowEvidence?.status, "verified");
    assert.equal(outcome.replyTargetEvidence?.reason, "no_exact_target_id_signal");
    assert.match(outcome.message, /full intended X reply text observed.*: yes/);
    assert.match(outcome.message, /exact requested status id bound.*: no/);
    assert.match(
      outcome.message,
      closeFails
        ? /finalization completed as staged-unverified.*did not close cleanly/s
        : /reservation and finalized-history state are unknown/,
    );
    assert.doesNotMatch(outcome.message, /RAW_FINALIZE|RAW_CLOSE|✓/);
  }
});

test("arbitrary native-stage failure retains the reservation and never finalizes", async () => {
  const harness = createHarness({ stageFails: true });
  const outcome = await executeReplyRealRun(input(), harness.deps);

  assert.deepEqual(harness.events, [
    "ledger:open",
    `ledger:claim:${TARGET_ID}:force=false`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    "ledger:close",
  ]);
  assert.equal(outcome.kind, "native_stage_uncertain");
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.savePhase, "save_delivery_unknown");
  assert.match(outcome.message, /Save action was invoked, but delivery is unknown/);
  assert.match(outcome.message, /reservation .* remains/i);
  assert.match(outcome.message, /exact CLI-owned profile used by this run/);
  assert.doesNotMatch(outcome.message, /NATIVE_STAGE_ERROR|--inspect|selector/i);
  assert.doesNotMatch(outcome.message, /ledger finalization/);
});

test("undefined or wrong-target stage results remain inconclusive and retain the claim", async () => {
  for (const options of [
    { stageReturnsUndefined: true },
    { stageReplyToId: OTHER_TARGET_ID },
    { stageResultMechanism: "article_create_autosave" as const },
    { stageResultPosts: 2 },
    { stageRowEvidence: null },
  ]) {
    const harness = createHarness(options);
    const outcome = await executeReplyRealRun(input(), harness.deps);

    assert.deepEqual(harness.events, [
      "ledger:open",
      `ledger:claim:${TARGET_ID}:force=false`,
      "stage:load",
      `stage:run:${TARGET_URL}:tweet`,
      "ledger:close",
    ]);
    assert.equal(outcome.kind, "stage_result_inconclusive");
    assert.match(outcome.message, /native draft may exist/i);
    assert.match(outcome.message, /no reply-ledger finalization was confirmed/);
    assert.match(outcome.message, /reservation .* remains/i);
    assert.doesNotMatch(outcome.message, new RegExp(OTHER_TARGET_ID));
  }
});

test("reply result getters cannot leak or change phase after validation", async () => {
  const throwing = createHarness({ stageResultGetter: "throwing" });
  const thrownOutcome = await executeReplyRealRun(input(), throwing.deps);
  assert.equal(thrownOutcome.kind, "native_stage_uncertain");
  assert.equal(thrownOutcome.savePhase, "save_delivery_unknown");
  assert.equal(throwing.events.some((event) => event.startsWith("ledger:finalize")), false);
  assert.doesNotMatch(thrownOutcome.message, /RAW_STAGE_RESULT_GETTER/);

  const stateful = createHarness({ stageResultGetter: "stateful" });
  const statefulOutcome = await executeReplyRealRun(input(), stateful.deps);
  assert.equal(stateful.events.filter((event) => event.startsWith("stage:phase-read")).length, 1);
  assert.match(stateful.events.join("\n"), /ledger:finalize:.*:staged-unverified/);
  assert.equal(statefulOutcome.kind, "staged_unverified");
  assert.equal(statefulOutcome.savePhase, "save_delivered_unverified");
  assert.equal(statefulOutcome.exitCode, 1);
});

test("nested row evidence is snapshotted once and malformed facts never finalize", async () => {
  for (const options of [
    { stageRowEvidenceGetter: "throwing" as const },
    { verified: true, stageRowEvidence: rowEvidence(false) },
    { verified: true, stageRowEvidence: { status: "verified" } },
    {
      stageRowEvidence: {
        ...rowEvidence(false),
        postSave: observedRows(2, 1),
      },
    },
  ]) {
    const harness = createHarness(options);
    const outcome = await executeReplyRealRun(input(), harness.deps);
    assert.equal(outcome.kind, options.stageRowEvidenceGetter ? "native_stage_uncertain" : "stage_result_inconclusive");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.draftRowEvidence, null);
    assert.equal(harness.events.some((event) => event.startsWith("ledger:finalize")), false);
    assert.doesNotMatch(outcome.message, /RAW_ROW_EVIDENCE|PRIVATE_PATH/);
  }

  const stateful = createHarness({
    verified: true,
    stageRowEvidenceGetter: "stateful",
  });
  const outcome = await executeReplyRealRun(input(), stateful.deps);
  assert.equal(stateful.events.filter((event) => event.startsWith("stage:evidence-read")).length, 1);
  assert.equal(outcome.kind, "stage_result_inconclusive");
  assert.equal(outcome.draftRowEvidence, null);
  assert.equal(stateful.events.some((event) => event.startsWith("ledger:finalize")), false);
});

test("verified and unverified returns finalize before close but only verified succeeds", async () => {
  for (const [verified, status, kind, exitCode, evidence] of [
    [true, "staged", "staged", 0, /exact requested status id bound.*: yes/],
    [false, "staged-unverified", "staged_unverified", 1, /target checking was skipped because the content row was not verified/],
  ] as const) {
    const harness = createHarness({ verified });
    const outcome = await executeReplyRealRun(input(), harness.deps);

    assert.deepEqual(harness.events, [
      "ledger:open",
      `ledger:claim:${TARGET_ID}:force=false`,
      "stage:load",
      `stage:run:${TARGET_URL}:tweet`,
      `ledger:finalize:${TARGET_ID}:${status}`,
      "ledger:close",
    ]);
    assert.equal(outcome.kind, kind);
    assert.equal(outcome.exitCode, exitCode);
    assert.equal(outcome.savePhase, verified ? "verified" : "save_delivered_unverified");
    assert.equal(outcome.draftRowEvidence?.status, verified ? "verified" : "unverified");
    assert.equal(outcome.replyTargetEvidence?.status, verified ? "verified" : "unverified");
    assert.match(outcome.message, evidence);
    if (verified) {
      assert.match(outcome.message, new RegExp(`Native X Save action returned.*NEVER posted.*request context: target ${TARGET_ID}.*full intended X reply text`, "s"));
      assert.match(outcome.message, /visible scoped row multiset changed by exactly that one full-text value/);
      assert.match(outcome.message, /full-list completeness and causality: unproven/);
      assert.doesNotMatch(outcome.message, /target preserved|reply draft[^\n]*\bto \d+/i);
    } else {
      assert.match(outcome.message, /exact CLI-owned profile used by this run/);
      assert.match(outcome.message, /Only after confidently finding no matching draft.*--force/s);
      assert.doesNotMatch(outcome.message, /Offline injected stage result/);
    }
  }
});

test("content-positive target-unavailable is a resolved staged-unverified result", async () => {
  for (const reportedVerified of [false, true]) {
    const harness = createHarness({
      verified: reportedVerified,
      stageRowEvidence: rowEvidence(true),
      stageTargetEvidence: xReplyTargetEvidenceNotCalibrated(TARGET_ID),
    });
    const outcome = await executeReplyRealRun(input(), harness.deps);

    assert.match(harness.events.join("\n"), /ledger:finalize:.*:staged-unverified/);
    assert.equal(outcome.kind, "staged_unverified");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.savePhase, "save_delivered_unverified");
    assert.equal(outcome.draftRowEvidence?.status, "verified");
    assert.equal(outcome.replyTargetEvidence?.status, "unverified");
    assert.equal(outcome.replyTargetEvidence?.reason, "no_exact_target_id_signal");
    assert.match(outcome.message, /full intended X reply text observed.*: yes/);
    assert.match(outcome.message, /calibrated Unsent row and reopened composer expose no exact target-id signal/);
    assert.match(outcome.message, /exact CLI-owned profile used by this run/);
    assert.doesNotMatch(outcome.message, /✓|target preserved|Offline injected stage result/);
  }
});

test("target-only malformed, throwing, and stateful evidence cannot escape or promote", async () => {
  const cases: HarnessOptions[] = [
    { verified: true, stageTargetEvidence: null },
    { verified: true, stageTargetEvidence: { status: "verified" } },
    {
      verified: true,
      stageTargetEvidence: {
        ...replyTargetEvidence(true),
        requestedTargetId: OTHER_TARGET_ID,
      },
    },
    { verified: true, stageTargetEvidenceGetter: "throwing" },
    { verified: true, stageTargetEvidenceGetter: "stateful" },
  ];
  for (const fixture of cases) {
    const harness = createHarness(fixture);
    const outcome = await executeReplyRealRun(input(), harness.deps);
    assert.equal(outcome.kind, "staged_unverified");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.draftRowEvidence?.status, "verified");
    assert.equal(outcome.replyTargetEvidence?.status, "unverified");
    assert.notEqual(outcome.replyTargetEvidence?.status, "verified");
    assert.ok(
      outcome.replyTargetEvidence?.reason === "probe_failed" ||
      outcome.replyTargetEvidence?.reason === "no_exact_target_id_signal",
    );
    assert.match(harness.events.join("\n"), /ledger:finalize:.*:staged-unverified/);
    assert.doesNotMatch(outcome.message, /RAW_TARGET|PRIVATE_PATH|9876543210987654321/);
  }
  const stateful = createHarness({ verified: true, stageTargetEvidenceGetter: "stateful" });
  await executeReplyRealRun(input(), stateful.deps);
  assert.equal(
    stateful.events.filter((event) => event.startsWith("stage:target-evidence-read")).length,
    1,
  );
});

test("missing, ambiguous, and different native target observations remain bounded", async () => {
  const common = {
    status: "unverified" as const,
    method: "same_content_row_target_id" as const,
    scope: "current_save_attempt" as const,
    requestedTargetId: TARGET_ID,
    rowBinding: "same_content_matched_draft" as const,
  };
  const cases = [
    {
      evidence: {
        ...common,
        targetMatch: "not_observed",
        targetContextCount: 0,
        distinctStatusIdCount: 0,
        reason: "target_context_missing",
      },
      reason: "target_context_missing",
    },
    {
      evidence: {
        ...common,
        targetMatch: "ambiguous",
        targetContextCount: 2,
        distinctStatusIdCount: null,
        reason: "target_context_ambiguous",
      },
      reason: "target_context_ambiguous",
    },
    {
      evidence: {
        ...common,
        targetMatch: "ambiguous",
        targetContextCount: 1,
        distinctStatusIdCount: 2,
        reason: "target_id_ambiguous",
      },
      reason: "target_id_ambiguous",
    },
    {
      evidence: {
        ...common,
        targetMatch: "different",
        targetContextCount: 1,
        distinctStatusIdCount: 1,
        reason: "target_id_mismatch",
      },
      reason: "target_id_mismatch",
    },
  ];
  for (const fixture of cases) {
    const harness = createHarness({
      stageRowEvidence: rowEvidence(true),
      stageTargetEvidence: fixture.evidence,
      stageNote: RAW_CANARY,
    });
    const outcome = await executeReplyRealRun(input(), harness.deps);
    assert.equal(outcome.kind, "staged_unverified");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.draftRowEvidence?.status, "verified");
    assert.equal(outcome.replyTargetEvidence?.reason, fixture.reason);
    assert.match(harness.events.join("\n"), /ledger:finalize:.*:staged-unverified/);
    assert.match(outcome.message, /bounded native target observation was not exact and unambiguous/);
    assert.doesNotMatch(outcome.message, /PRIVATE_PATH|session-secret|https:\/\//);
  }

  const contradictory = createHarness({
    stageTargetEvidence: replyTargetEvidence(true),
  });
  const outcome = await executeReplyRealRun(input(), contradictory.deps);
  assert.equal(outcome.kind, "staged_unverified");
  assert.equal(outcome.draftRowEvidence?.status, "unverified");
  assert.equal(outcome.replyTargetEvidence?.reason, "content_unverified");
});

test("an exact-content top-level Unsent row cannot substitute for reply-target identity", async () => {
  const targetMissing = {
    status: "unverified" as const,
    method: "same_content_row_target_id" as const,
    scope: "current_save_attempt" as const,
    requestedTargetId: TARGET_ID,
    rowBinding: "same_content_matched_draft" as const,
    targetMatch: "not_observed" as const,
    targetContextCount: 0 as const,
    distinctStatusIdCount: 0 as const,
    reason: "target_context_missing" as const,
  };
  const harness = createHarness({
    stageRowEvidence: rowEvidence(true),
    stageTargetEvidence: targetMissing,
  });
  const outcome = await executeReplyRealRun(input(), harness.deps);

  assert.deepEqual(harness.events, [
    "ledger:open",
    `ledger:claim:${TARGET_ID}:force=false`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    `ledger:finalize:${TARGET_ID}:staged-unverified`,
    "ledger:close",
  ]);
  assert.equal(outcome.kind, "staged_unverified");
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.draftRowEvidence?.status, "verified");
  assert.equal(outcome.replyTargetEvidence?.reason, "target_context_missing");
  assert.match(outcome.message, /full intended X reply text observed.*: yes/);
  assert.match(outcome.message, /exact requested status id bound.*: no/);
  assert.doesNotMatch(outcome.message, /exact requested status id bound.*: yes/);
});

test("coherent baseline-unavailable evidence finalizes staged-unverified after Save returned", async () => {
  const unavailable = {
    status: "unverified",
    method: "unsent_row_full_text_delta",
    contentMatch: "baseline_unavailable",
    nativeRowId: "unavailable",
    listCompleteness: "visible_scoped_rows_only",
    baseline: {
      outcome: "route_not_exact",
      route: "not_exact",
      modal: "not_observed",
      rows: "not_observed",
      visibleModalCount: null,
      visibleRowCount: null,
      exactFullTextMatches: null,
    },
    postSave: {
      outcome: "probe_failed",
      route: "unknown",
      modal: "not_observed",
      rows: "not_observed",
      visibleModalCount: null,
      visibleRowCount: null,
      exactFullTextMatches: null,
    },
  } as const;
  const harness = createHarness({ verified: false, stageRowEvidence: unavailable });
  const outcome = await executeReplyRealRun(input(), harness.deps);

  assert.deepEqual(harness.events, [
    "ledger:open",
    `ledger:claim:${TARGET_ID}:force=false`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    `ledger:finalize:${TARGET_ID}:staged-unverified`,
    "ledger:close",
  ]);
  assert.equal(outcome.kind, "staged_unverified");
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.savePhase, "save_delivered_unverified");
  assert.equal(outcome.draftRowEvidence?.contentMatch, "baseline_unavailable");
  assert.match(outcome.message, /finalized as staged-unverified/);
});

test("verified reply-thread receipts limit positive row evidence to the first row", async () => {
  const harness = createHarness({ verified: true });
  const outcome = await executeReplyRealRun(input({ content: THREAD_CONTENT }), harness.deps);
  assert.equal(outcome.kind, "staged");
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.message, /full intended X first reply-thread row text/);
  assert.match(outcome.message, /thread, 2 posts/);
  assert.match(outcome.message, /Review every saved row/);
  assert.doesNotMatch(outcome.message, /full intended X reply text/);
});

test("reply receipts never infer target identity from requested-target intent", async () => {
  const stagedUnverifiedPrior: ReplyLedgerEntry = {
    ...PRIOR,
    status: "staged-unverified",
  };
  for (const fixture of [
    { verified: true, stageNote: RAW_CANARY },
    { verified: true, finalizeFails: true },
    { verified: true, closeFails: true },
    { verified: false },
    { prior: PRIOR },
    { prior: stagedUnverifiedPrior },
    { stageFails: true },
    { stageFailurePhase: "save_not_attempted" as const },
  ]) {
    const outcome = await executeReplyRealRun(input(), createHarness(fixture).deps);
    assert.doesNotMatch(
      outcome.message,
      /reply target preserved|target preserved|Already staged a reply to|Staged a NATIVE X reply draft[^\n]*\bto\b/i,
    );
    if (outcome.replyTargetEvidence?.status === "verified") {
      assert.match(outcome.message, /exact requested status id bound.*: yes/i);
    } else if (outcome.savePhase === "save_delivered_unverified") {
      assert.match(outcome.message, /exact requested status id bound.*: no/i);
    }
    assert.doesNotMatch(outcome.message, /data-secret|PRIVATE_PATH_CANARY|session-secret|Private composer/);
  }
});

test("finalized history blocks non-force while force still acquires a reservation", async () => {
  const duplicate = createHarness({ prior: PRIOR });
  const refused = await executeReplyRealRun(input(), duplicate.deps);
  assert.deepEqual(duplicate.events, [
    "ledger:open",
    `ledger:claim:${TARGET_ID}:force=false`,
    "ledger:close",
  ]);
  assert.equal(refused.kind, "duplicate");
  assert.match(refused.message, /Finalized reply-attempt history exists for requested target.*override finalized history/s);
  assert.doesNotMatch(refused.message, /Already staged a reply to/);

  const forced = createHarness({ prior: PRIOR, verified: true });
  const staged = await executeReplyRealRun(input({ force: true }), forced.deps);
  assert.deepEqual(forced.events, [
    "ledger:open",
    `ledger:claim:${TARGET_ID}:force=true`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    `ledger:finalize:${TARGET_ID}:staged`,
    "ledger:close",
  ]);
  assert.equal(staged.kind, "staged");
});

test("active, stale, and ambiguous reservations block normal and force runs before X", async () => {
  for (const state of ["active", "stale", "ambiguous"] as const) {
    for (const force of [false, true]) {
      const harness = createHarness({ blockedState: state });
      const outcome = await executeReplyRealRun(input({ force }), harness.deps);
      assert.deepEqual(harness.events, [
        "ledger:open",
        `ledger:claim:${TARGET_ID}:force=${force}`,
        "ledger:close",
      ]);
      assert.equal(outcome.kind, `reservation_${state}`);
      assert.match(outcome.message, /No native staging was attempted/);
      assert.match(outcome.message, /--force cannot bypass/);
      assert.doesNotMatch(outcome.message, /offline-owner-token/);
      if (state === "stale") {
        assert.match(outcome.message, /Age makes the claim eligible.*does not prove/s);
        assert.match(outcome.message, /exact CLI-owned profile used by that run/);
        assert.match(outcome.message, /If a matching draft exists or the comparison is uncertain/);
        assert.match(outcome.message, /confirming no matching reply draft exists/);
        assert.match(outcome.message, /clears the claim and exits without staging/);
      }
    }
  }
});

test("only a proven pre-browser loader failure releases the owner-matched reservation", async () => {
  for (const loaderOptions of [{ loadStageFails: true }, { loadStageNonFunction: true }]) {
    const harness = createHarness(loaderOptions);
    const outcome = await executeReplyRealRun(input(), harness.deps);
    assert.deepEqual(harness.events, [
      "ledger:open",
      `ledger:claim:${TARGET_ID}:force=false`,
      "stage:load",
      `ledger:release:${RESERVATION.reservationId}`,
      "ledger:close",
    ]);
    assert.equal(outcome.kind, "stage_runtime_failed");
    assert.match(outcome.message, /No native staging was attempted/);
    assert.match(outcome.message, /owner-matched reservation was released/);
    assert.doesNotMatch(outcome.message, /RAW_STAGE_LOAD_ERROR_WITH_PRIVATE_PATH/);
  }

  for (const releaseOptions of [{ releaseFails: true }, { releaseReturnsFalse: true }]) {
    const harness = createHarness({ loadStageFails: true, ...releaseOptions });
    const outcome = await executeReplyRealRun(input(), harness.deps);
    assert.equal(outcome.kind, "stage_runtime_failed");
    assert.match(outcome.message, /reservation could not be released/);
    assert.match(outcome.message, /--force cannot bypass/);
    assert.doesNotMatch(outcome.message, /RAW_RELEASE_ERROR_WITH_PRIVATE_PATH/);
  }
});

test("typed Save-not-attempted evidence releases only the matching composer reservation", async () => {
  const released = createHarness({ stageFailurePhase: "save_not_attempted" });
  const releasedOutcome = await executeReplyRealRun(input(), released.deps);
  assert.deepEqual(released.events, [
    "ledger:open",
    `ledger:claim:${TARGET_ID}:force=false`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    `ledger:release:${RESERVATION.reservationId}`,
    "ledger:close",
  ]);
  assert.equal(releasedOutcome.kind, "native_stage_not_attempted");
  assert.equal(releasedOutcome.savePhase, "save_not_attempted");
  assert.equal(releasedOutcome.saveMechanism, "composer_close_save");
  assert.equal(releasedOutcome.reservationRelease, "released");
  assert.match(releasedOutcome.message, /typed poster evidence proves.*Save action was not invoked/s);

  for (const releaseFailure of [
    { releaseFails: true },
    { releaseReturnsFalse: true },
  ]) {
    const failed = createHarness({
      stageFailurePhase: "save_not_attempted",
      ...releaseFailure,
    });
    const failedOutcome = await executeReplyRealRun(input(), failed.deps);
    assert.equal(failedOutcome.kind, "native_stage_not_attempted");
    assert.equal(failedOutcome.reservationRelease, "not_released");
    assert.match(failedOutcome.message, /reservation could not be released/);
    assert.doesNotMatch(failedOutcome.message, /RAW_RELEASE_ERROR/);
  }

  const wrongMechanism = createHarness({
    stageFailurePhase: "save_not_attempted",
    stageFailureMechanism: "article_create_autosave",
  });
  const conservative = await executeReplyRealRun(input(), wrongMechanism.deps);
  assert.equal(conservative.kind, "native_stage_uncertain");
  assert.equal(conservative.savePhase, "save_delivery_unknown");
  assert.equal(conservative.reservationRelease, undefined);
  assert.equal(wrongMechanism.events.some((event) => event.startsWith("ledger:release")), false);
});

test("typed delivery unknown retains; typed delivered-unverified finalizes protection", async () => {
  const unknown = createHarness({ stageFailurePhase: "save_delivery_unknown" });
  const unknownOutcome = await executeReplyRealRun(input(), unknown.deps);
  assert.deepEqual(unknown.events, [
    "ledger:open",
    `ledger:claim:${TARGET_ID}:force=false`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    "ledger:close",
  ]);
  assert.equal(unknownOutcome.kind, "native_stage_uncertain");
  assert.equal(unknownOutcome.savePhase, "save_delivery_unknown");
  assert.match(unknownOutcome.message, /reservation .* remains/i);

  const delivered = createHarness({ stageFailurePhase: "save_delivered_unverified" });
  const deliveredOutcome = await executeReplyRealRun(input(), delivered.deps);
  assert.deepEqual(delivered.events, [
    "ledger:open",
    `ledger:claim:${TARGET_ID}:force=false`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    `ledger:finalize:${TARGET_ID}:staged-unverified`,
    "ledger:close",
  ]);
  assert.equal(deliveredOutcome.kind, "staged_unverified");
  assert.equal(deliveredOutcome.exitCode, 1);
  assert.equal(deliveredOutcome.savePhase, "save_delivered_unverified");
  assert.match(deliveredOutcome.message, /finalized as staged-unverified/);
  assert.match(deliveredOutcome.message, /Only after confidently finding no matching draft.*--force/s);
});

test("staged-unverified history blocks with manual-check guidance before force", async () => {
  const prior: ReplyLedgerEntry = { ...PRIOR, status: "staged-unverified" };
  const harness = createHarness({ prior });
  const outcome = await executeReplyRealRun(input(), harness.deps);
  assert.equal(outcome.kind, "duplicate");
  assert.equal(outcome.savePhase, null, "historical ledger evidence is not this run's Save phase");
  assert.equal(outcome.replyTargetEvidence, null, "historical rows never become current target proof");
  assert.equal(outcome.priorStatus, "staged-unverified");
  assert.match(outcome.message, /exact CLI-owned profile used by that run/);
  assert.match(outcome.message, /If a matching draft exists or the comparison is uncertain, do not retry or use --force/);
  assert.match(outcome.message, /Only after confidently finding no matching draft.*--force/s);
  assert.doesNotMatch(outcome.message, /Re-run with --force to override/);

  const closeHarness = createHarness({ prior, closeFails: true });
  const closeOutcome = await executeReplyRealRun(input(), closeHarness.deps);
  assert.equal(closeOutcome.exitCode, 1);
  assert.equal(closeOutcome.savePhase, null);
  assert.equal(closeOutcome.replyTargetEvidence, null);
  assert.equal(closeOutcome.priorStatus, "staged-unverified");
  assert.match(closeOutcome.message, /exact CLI-owned profile used by that run/);
  assert.match(closeOutcome.message, /Only after confidently finding no matching draft.*--force/s);
  assert.match(closeOutcome.message, /ledger failed to close/);
  assert.doesNotMatch(closeOutcome.message, /Re-run with --force|RAW_CLOSE_ERROR/);
});

test("release and close failures preserve both structured facts", async () => {
  for (const fixture of [
    { stageFailurePhase: "save_not_attempted" as const, closeFails: true },
    { stageFailurePhase: "save_not_attempted" as const, releaseFails: true, closeFails: true },
    { loadStageFails: true, closeFails: true },
    { loadStageFails: true, releaseReturnsFalse: true, closeFails: true },
  ]) {
    const harness = createHarness(fixture);
    const outcome = await executeReplyRealRun(input(), harness.deps);
    const expectedReleased = !fixture.releaseFails && !fixture.releaseReturnsFalse;
    assert.equal(outcome.reservationRelease, expectedReleased ? "released" : "not_released");
    assert.match(
      outcome.message,
      expectedReleased ? /reservation release returned/ : /reservation was not confirmed released/,
    );
    assert.match(outcome.message, /ledger .*failed to close/i);
    assert.doesNotMatch(outcome.message, /RAW_RELEASE|RAW_CLOSE/);
  }
});

test("open and atomic-claim failures stop before X and close only acquired ledgers", async () => {
  const open = createHarness({ openFails: true });
  const openOutcome = await executeReplyRealRun(input(), open.deps);
  assert.deepEqual(open.events, ["ledger:open"]);
  assert.equal(openOutcome.kind, "ledger_preflight_failed");
  assert.doesNotMatch(openOutcome.message, /RAW_OPEN_ERROR_WITH_PRIVATE_PATH/);

  const claim = createHarness({ claimFails: true });
  const claimOutcome = await executeReplyRealRun(input({ force: true }), claim.deps);
  assert.deepEqual(claim.events, [
    "ledger:open",
    `ledger:claim:${TARGET_ID}:force=true`,
    "ledger:close",
  ]);
  assert.equal(claimOutcome.kind, "ledger_preflight_failed");
  assert.match(claimOutcome.message, /No native staging was attempted/);
  assert.doesNotMatch(claimOutcome.message, /RAW_CLAIM_ERROR_WITH_PRIVATE_PATH/);
});

test("close failures preserve the primary reservation and persistence facts", async () => {
  const success = createHarness({ verified: true, closeFails: true });
  const successOutcome = await executeReplyRealRun(input(), success.deps);
  assert.equal(successOutcome.kind, "ledger_persistence_failed");
  assert.equal(successOutcome.exitCode, 1);
  assert.match(successOutcome.message, /finalization completed as staged/);
  assert.match(successOutcome.message, /scoped content-row and exact target-id observations were positive/i);
  assert.match(successOutcome.message, /Do not retry or use --force/);
  assert.doesNotMatch(successOutcome.message, /✓ Staged|RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/);

  const unverified = createHarness({
    stageFailurePhase: "save_delivered_unverified",
    closeFails: true,
  });
  const unverifiedOutcome = await executeReplyRealRun(input(), unverified.deps);
  assert.equal(unverifiedOutcome.kind, "ledger_persistence_failed");
  assert.equal(unverifiedOutcome.exitCode, 1);
  assert.equal(unverifiedOutcome.savePhase, "save_delivered_unverified");
  assert.match(unverifiedOutcome.message, /finalization completed as staged-unverified/);
  assert.match(unverifiedOutcome.message, /exact CLI-owned profile used by this run/);
  assert.match(unverifiedOutcome.message, /If a matching draft exists or the comparison is uncertain, do not retry or use --force/);
  assert.match(unverifiedOutcome.message, /Only after confidently finding no matching draft.*--force/s);
  assert.doesNotMatch(unverifiedOutcome.message, /✓ Staged|RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/);

  const finalize = createHarness({ finalizeFails: true, closeFails: true });
  const finalizeOutcome = await executeReplyRealRun(input(), finalize.deps);
  assert.equal(finalizeOutcome.kind, "ledger_persistence_failed");
  assert.match(finalizeOutcome.message, /record and reservation finalization outcome could not be confirmed/);
  assert.match(finalizeOutcome.message, /Closing the reply ledger also failed/);
  assert.doesNotMatch(
    finalizeOutcome.message,
    /Failed to stage|RAW_FINALIZE_ERROR_WITH_PRIVATE_PATH|RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/,
  );

  const stage = createHarness({ stageFails: true, closeFails: true });
  const stageOutcome = await executeReplyRealRun(input(), stage.deps);
  assert.equal(stageOutcome.kind, "native_stage_uncertain");
  assert.match(stageOutcome.message, /reservation remains.*ledger also failed to close/s);
  assert.doesNotMatch(stageOutcome.message, /RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/);

  const inconclusive = createHarness({ stageReturnsUndefined: true, closeFails: true });
  const inconclusiveOutcome = await executeReplyRealRun(input(), inconclusive.deps);
  assert.equal(inconclusiveOutcome.kind, "stage_result_inconclusive");
  assert.match(inconclusiveOutcome.message, /native draft may exist/i);
  assert.match(inconclusiveOutcome.message, /reply ledger also failed to close/);
  assert.doesNotMatch(inconclusiveOutcome.message, /RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/);

  const blocked = createHarness({ blockedState: "active", closeFails: true });
  const blockedOutcome = await executeReplyRealRun(input(), blocked.deps);
  assert.equal(blockedOutcome.kind, "reservation_active");
  assert.equal(blockedOutcome.exitCode, 1);
  assert.match(blockedOutcome.message, /reply ledger also failed to close/);

  const duplicate = createHarness({ prior: PRIOR, closeFails: true });
  const duplicateOutcome = await executeReplyRealRun(input(), duplicate.deps);
  assert.equal(duplicateOutcome.kind, "duplicate");
  assert.equal(duplicateOutcome.exitCode, 1);
  assert.match(duplicateOutcome.message, /Finalized reply-attempt history exists for requested target/);
  assert.match(duplicateOutcome.message, /No new native staging was attempted/);
  assert.match(duplicateOutcome.message, /do not bypass an unhealthy ledger with --force/);
  assert.doesNotMatch(duplicateOutcome.message, /Re-run with --force|RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/);
});

test("recovery never loads X and distinguishes cleared, missing, active, failed, and close-uncertain state", async () => {
  const recovered = createHarness({ recovery: { kind: "recovered", reservation: RESERVATION } });
  const recoveredOutcome = await executeReplyReservationRecovery(TARGET_ID, recovered.deps);
  assert.deepEqual(recovered.events, [
    "ledger:open",
    `ledger:recover:${TARGET_ID}`,
    "ledger:close",
  ]);
  assert.equal(recoveredOutcome.kind, "reservation_recovered");
  assert.equal(recoveredOutcome.exitCode, 0);
  assert.match(recoveredOutcome.message, /operator's attestation/);
  assert.match(recoveredOutcome.message, /exact CLI-owned profile used by that run/);
  assert.match(recoveredOutcome.message, /no matching reply draft was found/);
  assert.match(recoveredOutcome.message, /separate reply command/);
  assert.doesNotMatch(recoveredOutcome.message, /offline-owner-token/);

  const missing = createHarness();
  const missingOutcome = await executeReplyReservationRecovery(TARGET_ID, missing.deps);
  assert.equal(missingOutcome.kind, "reservation_missing");
  assert.equal(missingOutcome.exitCode, 2);

  const active = createHarness({
    recovery: { kind: "reservation_blocked", reservation: RESERVATION, state: "active" },
  });
  const activeOutcome = await executeReplyReservationRecovery(TARGET_ID, active.deps);
  assert.equal(activeOutcome.kind, "reservation_active");
  assert.match(activeOutcome.message, /may still be staging/);

  const failed = createHarness({ recoveryFails: true });
  const failedOutcome = await executeReplyReservationRecovery(TARGET_ID, failed.deps);
  assert.equal(failedOutcome.kind, "ledger_preflight_failed");
  assert.match(failedOutcome.message, /could not be confirmed/i);
  assert.doesNotMatch(failedOutcome.message, /RAW_RECOVERY_ERROR_WITH_PRIVATE_PATH/);

  const close = createHarness({
    recovery: { kind: "recovered", reservation: RESERVATION },
    closeFails: true,
  });
  const closeOutcome = await executeReplyReservationRecovery(TARGET_ID, close.deps);
  assert.equal(closeOutcome.kind, "reservation_recovery_uncertain");
  assert.equal(closeOutcome.stream, "stderr");
  assert.equal(closeOutcome.exitCode, 1);
  assert.match(closeOutcome.message, /clear returned.*did not close cleanly/s);
  assert.doesNotMatch(closeOutcome.message, /✓|RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/);
});

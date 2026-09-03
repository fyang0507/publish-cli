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

const TARGET_ID = "1234567890123456789";
const OTHER_TARGET_ID = "9876543210987654321";
const TARGET_URL = `https://x.com/operator/status/${TARGET_ID}`;

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
  stageReturnsUndefined?: boolean;
  stageReplyToId?: string;
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
        if (options.stageReturnsUndefined) return undefined as unknown as StageReplyResult;
        return {
          format: content.format,
          posts: content.format === "thread" ? (content.thread?.length ?? 0) : 1,
          verified: options.verified ?? false,
          note: "Offline injected stage result.",
          replyToId: options.stageReplyToId ?? TARGET_ID,
        };
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

test("post-stage finalization failure retains the claim and preserves verified evidence", async () => {
  for (const [verified, status, draftEvidence] of [
    [false, "staged-unverified", /native draft may exist/i],
    [true, "staged", /native draft was verified in X Unsent\/Drafts/i],
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
    assert.match(outcome.message, new RegExp(`native staging flow returned for target ${TARGET_ID}`));
    assert.match(outcome.message, draftEvidence);
    assert.match(outcome.message, /record and reservation finalization could not be confirmed/);
    assert.match(outcome.message, /reservation .* remains/i);
    assert.match(outcome.message, /exact CLI-owned profile used by this run/);
    assert.doesNotMatch(
      outcome.message,
      /Failed to stage|RAW_FINALIZE_ERROR_WITH_PRIVATE_PATH|offline-owner-token/,
    );
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
  assert.equal(outcome.kind, "native_stage_failed");
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.message, /Failed to stage the X reply draft: NATIVE_STAGE_ERROR/);
  assert.match(outcome.message, /reservation .* remains/i);
  assert.match(outcome.message, /exact CLI-owned profile used by this run/);
  assert.match(outcome.message, /--inspect cannot bypass or clear/);
  assert.doesNotMatch(outcome.message, /ledger finalization/);
});

test("undefined or wrong-target stage results remain inconclusive and retain the claim", async () => {
  for (const options of [
    { stageReturnsUndefined: true },
    { stageReplyToId: OTHER_TARGET_ID },
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

test("verified and unverified returns finalize the normalized target before one close", async () => {
  for (const [verified, status, evidence] of [
    [true, "staged", /verified in Unsent\/Drafts: yes/],
    [false, "staged-unverified", /verified in Unsent\/Drafts: unconfirmed/],
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
    assert.equal(outcome.kind, "staged");
    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.message, /Staged a NATIVE X reply draft.*NEVER posted/s);
    assert.match(outcome.message, evidence);
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
  assert.match(refused.message, /Refusing to stage a duplicate reply.*--force/s);

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
  assert.match(successOutcome.message, /record and reservation finalization completed/);
  assert.doesNotMatch(successOutcome.message, /✓ Staged|RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/);

  const finalize = createHarness({ finalizeFails: true, closeFails: true });
  const finalizeOutcome = await executeReplyRealRun(input(), finalize.deps);
  assert.equal(finalizeOutcome.kind, "ledger_persistence_failed");
  assert.match(finalizeOutcome.message, /record and reservation finalization could not be confirmed/);
  assert.match(finalizeOutcome.message, /Closing the reply ledger also failed/);
  assert.doesNotMatch(
    finalizeOutcome.message,
    /Failed to stage|RAW_FINALIZE_ERROR_WITH_PRIVATE_PATH|RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/,
  );

  const stage = createHarness({ stageFails: true, closeFails: true });
  const stageOutcome = await executeReplyRealRun(input(), stage.deps);
  assert.equal(stageOutcome.kind, "native_stage_failed");
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
  assert.match(duplicateOutcome.message, /Already staged a reply/);
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

import test from "node:test";
import assert from "node:assert/strict";
import {
  isXReplyEvidenceCompatible,
  resolveXReplyTargetEvidence,
  snapshotXReplyTargetEvidence,
  xReplyTargetEvidenceNotCalibrated,
  xReplyTargetEvidenceNotChecked,
  type XDraftRowEvidence,
  type XReplyTargetEvidence,
} from "./saveProgress.js";

const TARGET_ID = "1234567890123456789";
const OTHER_TARGET_ID = "9876543210987654321";
const RAW_CANARY =
  "https://user:secret@x.com/private/status/99999 selector=[data-secret] PRIVATE_PATH_CANARY";

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

function targetEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "verified",
    method: "same_content_row_target_id",
    scope: "current_save_attempt",
    requestedTargetId: TARGET_ID,
    rowBinding: "same_content_matched_draft",
    targetMatch: "exact",
    targetContextCount: 1,
    distinctStatusIdCount: 1,
    reason: "exact_requested_target",
    ...overrides,
  };
}

test("production target facts are closed unverified evidence", () => {
  const notChecked = xReplyTargetEvidenceNotChecked(TARGET_ID);
  const unavailable = xReplyTargetEvidenceNotCalibrated(TARGET_ID);
  assert.deepEqual(snapshotXReplyTargetEvidence(notChecked), notChecked);
  assert.deepEqual(snapshotXReplyTargetEvidence(unavailable), unavailable);
  assert.equal(unavailable.reason, "no_exact_target_id_signal");
  assert.doesNotMatch(JSON.stringify(unavailable), /href|handle|selector|PRIVATE_PATH/);
});

test("only semantically coherent calibrated target facts survive the boundary", () => {
  const valid: XReplyTargetEvidence[] = [
    targetEvidence() as unknown as XReplyTargetEvidence,
    targetEvidence({
      status: "unverified",
      rowBinding: "not_observed",
      targetMatch: "not_observed",
      targetContextCount: null,
      distinctStatusIdCount: null,
      reason: "route_not_exact",
    }) as unknown as XReplyTargetEvidence,
    targetEvidence({
      status: "unverified",
      targetMatch: "not_observed",
      targetContextCount: 0,
      distinctStatusIdCount: 0,
      reason: "target_context_missing",
    }) as unknown as XReplyTargetEvidence,
    targetEvidence({
      status: "unverified",
      targetMatch: "ambiguous",
      targetContextCount: 2,
      distinctStatusIdCount: null,
      reason: "target_context_ambiguous",
    }) as unknown as XReplyTargetEvidence,
    targetEvidence({
      status: "unverified",
      targetMatch: "not_observed",
      targetContextCount: 1,
      distinctStatusIdCount: 0,
      reason: "target_id_missing",
    }) as unknown as XReplyTargetEvidence,
    targetEvidence({
      status: "unverified",
      targetMatch: "ambiguous",
      targetContextCount: 1,
      distinctStatusIdCount: "many",
      reason: "target_id_ambiguous",
    }) as unknown as XReplyTargetEvidence,
    targetEvidence({
      status: "unverified",
      targetMatch: "different",
      targetContextCount: 1,
      distinctStatusIdCount: 1,
      reason: "target_id_mismatch",
    }) as unknown as XReplyTargetEvidence,
  ];
  for (const evidence of valid) {
    assert.deepEqual(snapshotXReplyTargetEvidence(evidence), evidence);
  }

  const invalid = [
    targetEvidence({ requestedTargetId: "01234" }),
    targetEvidence({ status: "unverified" }),
    targetEvidence({ targetContextCount: 2 }),
    targetEvidence({
      status: "unverified",
      targetMatch: "ambiguous",
      targetContextCount: 101,
      distinctStatusIdCount: null,
      reason: "target_context_ambiguous",
    }),
    targetEvidence({ distinctStatusIdCount: 0 }),
    targetEvidence({ rowBinding: "not_observed" }),
    targetEvidence({
      status: "unverified",
      targetMatch: "different",
      targetContextCount: 1,
      distinctStatusIdCount: 2,
      reason: "target_id_mismatch",
    }),
    targetEvidence({
      status: "unverified",
      targetMatch: "ambiguous",
      targetContextCount: 1,
      distinctStatusIdCount: 1,
      reason: "target_id_ambiguous",
    }),
    {
      ...xReplyTargetEvidenceNotCalibrated(TARGET_ID),
      method: "same_content_row_target_id",
    },
  ];
  for (const evidence of invalid) assert.equal(snapshotXReplyTargetEvidence(evidence), null);
});

test("target evidence getters are read once and raw extras never cross the boundary", () => {
  let reads = 0;
  const stateful = targetEvidence({ rawPageText: RAW_CANARY });
  Object.defineProperty(stateful, "targetMatch", {
    get() {
      reads += 1;
      return reads === 1 ? "different" : "exact";
    },
  });
  Object.assign(stateful, {
    status: "unverified",
    targetContextCount: 1,
    distinctStatusIdCount: 1,
    reason: "target_id_mismatch",
  });
  const snapshot = snapshotXReplyTargetEvidence(stateful);
  assert.equal(reads, 1);
  assert.equal(snapshot?.status, "unverified");
  assert.equal(snapshot?.targetMatch, "different");
  assert.doesNotMatch(JSON.stringify(snapshot), /user:secret|data-secret|PRIVATE_PATH_CANARY/);

  const throwing = targetEvidence();
  Object.defineProperty(throwing, "reason", {
    get() { throw new Error(RAW_CANARY); },
  });
  assert.equal(snapshotXReplyTargetEvidence(throwing), null);
});

test("post-Save target resolution never throws and never probes an unverified row", async () => {
  let calls = 0;
  const skipped = await resolveXReplyTargetEvidence(
    rowEvidence(false),
    TARGET_ID,
    async () => {
      calls += 1;
      return targetEvidence();
    },
  );
  assert.equal(calls, 0);
  assert.equal(skipped.reason, "content_unverified");

  const production = await resolveXReplyTargetEvidence(rowEvidence(true), TARGET_ID);
  assert.equal(production.reason, "no_exact_target_id_signal");

  for (const observe of [
    async () => false,
    async () => null,
    async () => { throw new Error(RAW_CANARY); },
    async () => targetEvidence({ requestedTargetId: OTHER_TARGET_ID }),
  ]) {
    const result = await resolveXReplyTargetEvidence(rowEvidence(true), TARGET_ID, observe);
    assert.equal(result.status, "unverified");
    assert.equal(result.reason, "probe_failed");
    assert.doesNotMatch(JSON.stringify(result), /user:secret|data-secret|PRIVATE_PATH_CANARY/);
  }

  const positive = await resolveXReplyTargetEvidence(
    rowEvidence(true),
    TARGET_ID,
    async () => targetEvidence(),
  );
  assert.equal(positive.status, "verified");
});

test("reply compatibility preserves content-positive target-negative as returned-unverified", () => {
  const rowVerified = rowEvidence(true);
  const rowUnverified = rowEvidence(false);
  const targetVerified = snapshotXReplyTargetEvidence(targetEvidence())!;
  const targetUnavailable = xReplyTargetEvidenceNotCalibrated(TARGET_ID);
  const targetSkipped = xReplyTargetEvidenceNotChecked(TARGET_ID);

  assert.equal(
    isXReplyEvidenceCompatible("verified", rowVerified, targetVerified, TARGET_ID),
    true,
  );
  assert.equal(
    isXReplyEvidenceCompatible(
      "save_delivered_unverified",
      rowVerified,
      targetUnavailable,
      TARGET_ID,
    ),
    true,
  );
  assert.equal(
    isXReplyEvidenceCompatible(
      "save_delivered_unverified",
      rowUnverified,
      targetSkipped,
      TARGET_ID,
    ),
    true,
  );
  assert.equal(
    isXReplyEvidenceCompatible("verified", rowVerified, targetUnavailable, TARGET_ID),
    false,
  );
  assert.equal(
    isXReplyEvidenceCompatible("verified", rowUnverified, targetVerified, TARGET_ID),
    false,
  );
  assert.equal(
    isXReplyEvidenceCompatible(
      "save_delivered_unverified",
      rowVerified,
      targetSkipped,
      TARGET_ID,
    ),
    false,
  );
});

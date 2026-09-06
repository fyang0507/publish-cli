import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  REPLY_RESERVATION_STALE_AFTER_MS,
  ReplyLedger,
  type ReplyReservation,
} from "../db.js";
import {
  X_PROFILE_ORIGIN_SCHEMA_VERSION,
  loadOrCreateXProfileOrigin,
  snapshotReplyOriginBoundaryError,
} from "../replyOrigin.js";
import {
  executeReplyRealRun,
  executeReplyReservationRecovery,
  receiptForXReplyOutcome,
  type ReplyLedgerPort,
  type ReplyRealRunDependencies,
  type ReplyRealRunInput,
} from "./reply.js";
import type { GeneratedContent } from "../x/content.js";
import type { StageReplyResult } from "../x/draftPoster.js";
import {
  xReplyTargetEvidenceNotChecked,
  type XDraftRowEvidence,
  type XReplyTargetEvidence,
} from "../x/saveProgress.js";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
const RECOVERY_FLAG = "--recover-stale-reservation-after-confirming-no-draft";
const TARGET_A = "1234567890123456789";
const TARGET_B = "9876543210987654321";
const ORIGIN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORIGIN_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-03T12:00:00.000Z");

const CONTENT: GeneratedContent = {
  format: "tweet",
  limit: 280,
  tweet: { text: "Reservation test reply.", chars: 23, unit: "twitter_text_weighted" },
  codeFlags: [],
  linkFlags: [],
  fidelityFlags: [],
  warnings: [],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function input(targetTweetId: string, force = false): ReplyRealRunInput {
  return {
    content: CONTENT,
    targetIdOrUrl: `https://x.com/operator/status/${targetTweetId}`,
    replyToId: targetTweetId,
    inspect: true,
    force,
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

function targetEvidence(targetTweetId: string, verified: boolean): XReplyTargetEvidence {
  return verified
    ? {
        status: "verified",
        method: "same_content_row_target_id",
        scope: "current_save_attempt",
        requestedTargetId: targetTweetId,
        rowBinding: "same_content_matched_draft",
        targetMatch: "exact",
        targetContextCount: 1,
        distinctStatusIdCount: 1,
        reason: "exact_requested_target",
      }
    : xReplyTargetEvidenceNotChecked(targetTweetId);
}

function stageResult(targetTweetId: string, verified = true): StageReplyResult {
  return {
    format: "tweet",
    posts: 1,
    saveMechanism: "composer_close_save",
    savePhase: verified ? "verified" : "save_delivered_unverified",
    draftRowEvidence: rowEvidence(verified),
    replyTargetEvidence: targetEvidence(targetTweetId, verified),
    note: "Offline barrier stage result.",
    replyToId: targetTweetId,
  } as StageReplyResult;
}

function dependencies(
  dbFile: string,
  stage: (targetIdOrUrl: string) => Promise<StageReplyResult>,
  onLoad?: () => void,
): ReplyRealRunDependencies {
  return {
    async openLedger() {
      return new ReplyLedger(dbFile, ORIGIN_ID);
    },
    async loadStageReplyDraft() {
      onLoad?.();
      return async (_content, targetIdOrUrl) => stage(targetIdOrUrl);
    },
  };
}

function withRawDb<T>(dbFile: string, read: (db: Database.Database) => T): T {
  const db = new Database(dbFile);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function reservationRow(dbFile: string, targetTweetId: string): ReplyReservation | undefined {
  return withRawDb(dbFile, (db) => db
    .prepare(
      `SELECT target_tweet_id AS targetTweetId,
              reservation_id AS reservationId,
              reserved_at AS reservedAt,
              origin_id AS originId
         FROM reply_reservations WHERE target_tweet_id = ?`,
    )
    .get(targetTweetId) as ReplyReservation | undefined);
}

function ledgerStatus(dbFile: string, targetTweetId: string): string | undefined {
  return withRawDb(dbFile, (db) => {
    const row = db
      .prepare("SELECT status FROM reply_ledger WHERE target_tweet_id = ?")
      .get(targetTweetId) as { status: string } | undefined;
    return row?.status;
  });
}

test("reservation schema is additive and preserves a legacy finalized ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-schema-"));
  const dbFile = join(dir, "publish.db");
  try {
    withRawDb(dbFile, (db) => {
      db.exec(`
        CREATE TABLE reply_ledger (
          target_tweet_id TEXT PRIMARY KEY,
          staged_at       TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'staged',
          draft_ref       TEXT
        );
      `);
      db.prepare(
        `INSERT INTO reply_ledger (target_tweet_id, staged_at, status, draft_ref)
         VALUES (?, ?, ?, ?)`,
      ).run(TARGET_A, NOW.toISOString(), "staged", null);
    });

    const ledger = new ReplyLedger(dbFile, ORIGIN_ID);
    for (const force of [false, true]) {
      assert.throws(
        () => ledger.claimReservation(TARGET_A, { now: NOW, force }),
        (error: unknown) => {
          assert.deepEqual(snapshotReplyOriginBoundaryError(error), {
            originId: null,
            match: "unknown",
            scope: "finalized_entry",
          });
          return true;
        },
      );
    }
    const separate = ledger.claimReservation(TARGET_B, {
      now: NOW,
      reservationId: "new-table-owner",
    });
    assert.equal(separate.kind, "acquired");
    if (separate.kind !== "acquired") throw new Error("new reservation table was unavailable");
    assert.equal(separate.reservation.originId, ORIGIN_ID);
    assert.equal(ledger.releaseReservation(separate.reservation), true);
    ledger.close();
    withRawDb(dbFile, (db) => {
      assert.deepEqual(
        db.prepare(
          "SELECT target_tweet_id AS targetTweetId, status, origin_id AS originId FROM reply_ledger WHERE target_tweet_id = ?",
        ).get(TARGET_A),
        { targetTweetId: TARGET_A, status: "staged", originId: null },
      );
      assert.equal(
        (db.prepare("SELECT origin_id AS originId FROM reply_profile_binding WHERE singleton = 1")
          .get() as { originId: string }).originId,
        ORIGIN_ID,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("machine-local X profile origin is persistent and the database binds future rows to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-origin-profile-"));
  const profileDir = join(dir, "x-profile");
  const originFile = join(profileDir, ".publish-origin.json");
  const dbFile = join(dir, "publish.db");
  try {
    mkdirSync(profileDir, { recursive: true });
    const first = loadOrCreateXProfileOrigin(originFile);
    const second = loadOrCreateXProfileOrigin(originFile);
    assert.deepEqual(second, first);
    assert.equal(first.schemaVersion, X_PROFILE_ORIGIN_SCHEMA_VERSION);

    const ledger = new ReplyLedger(dbFile, first.originId);
    const claim = ledger.claimReservation(TARGET_A, { now: NOW, reservationId: "new-owner" });
    assert.equal(claim.kind, "acquired");
    if (claim.kind !== "acquired") throw new Error("new reservation was not acquired");
    assert.equal(claim.reservation.originId, first.originId);
    ledger.finalizeReservation(claim.reservation, { status: "staged-unverified" });
    ledger.close();

    withRawDb(dbFile, (db) => {
      assert.equal(
        (db.prepare("SELECT origin_id AS originId FROM reply_profile_binding WHERE singleton = 1")
          .get() as { originId: string }).originId,
        first.originId,
      );
      assert.equal(
        (db.prepare("SELECT origin_id AS originId FROM reply_ledger WHERE target_tweet_id = ?")
          .get(TARGET_A) as { originId: string }).originId,
        first.originId,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a copied database bound to another profile fails before browser loading with opaque evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-origin-mismatch-"));
  const dbFile = join(dir, "publish.db");
  try {
    const seed = new ReplyLedger(dbFile, ORIGIN_ID);
    seed.close();

    let stageLoaderCalled = false;
    const outcome = await executeReplyRealRun(input(TARGET_A, true), {
      async openLedger() {
        return new ReplyLedger(dbFile, OTHER_ORIGIN_ID);
      },
      async loadStageReplyDraft() {
        stageLoaderCalled = true;
        return async () => stageResult(TARGET_A);
      },
    });
    assert.equal(outcome.kind, "reply_origin_mismatch");
    assert.equal(stageLoaderCalled, false);
    assert.deepEqual(outcome.origin, {
      originId: ORIGIN_ID,
      match: "mismatch",
      scope: "database",
    });
    const receipt = receiptForXReplyOutcome(outcome, "reply");
    assert.equal(receipt.platformTouched, false);
    assert.ok(receipt.remoteResidue.some((entry) =>
      entry.state === "reply_origin_mismatch" && entry.reference === ORIGIN_ID));
    const rendered = JSON.stringify(receipt);
    assert.doesNotMatch(rendered, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(rendered, new RegExp(OTHER_ORIGIN_ID));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy unknown reservations survive migration and block force and recovery before X", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-origin-legacy-reservation-"));
  const dbFile = join(dir, "publish.db");
  try {
    withRawDb(dbFile, (db) => {
      db.exec(`
        CREATE TABLE reply_reservations (
          target_tweet_id TEXT PRIMARY KEY,
          reservation_id  TEXT NOT NULL UNIQUE,
          reserved_at     TEXT NOT NULL
        );
      `);
      db.prepare(
        "INSERT INTO reply_reservations (target_tweet_id, reservation_id, reserved_at) VALUES (?, ?, ?)",
      ).run(
        TARGET_A,
        "legacy-owner",
        new Date(NOW.getTime() - REPLY_RESERVATION_STALE_AFTER_MS - 1).toISOString(),
      );
    });
    new ReplyLedger(dbFile, ORIGIN_ID).close();

    let stageLoaderCalled = false;
    const deps: ReplyRealRunDependencies = {
      async openLedger() { return new ReplyLedger(dbFile, ORIGIN_ID); },
      async loadStageReplyDraft() {
        stageLoaderCalled = true;
        return async () => stageResult(TARGET_A);
      },
    };
    const forced = await executeReplyRealRun(input(TARGET_A, true), deps);
    assert.equal(forced.kind, "reply_origin_unknown");
    assert.equal(stageLoaderCalled, false);
    assert.deepEqual(forced.origin, {
      originId: null,
      match: "unknown",
      scope: "reservation",
    });

    const recovered = await executeReplyReservationRecovery(TARGET_A, deps);
    assert.equal(recovered.kind, "reply_origin_unknown");
    assert.equal(reservationRow(dbFile, TARGET_A)?.reservationId, "legacy-owner");
    const receipt = receiptForXReplyOutcome(recovered, "reply", [], "recovery");
    assert.ok(receipt.remoteResidue.some((entry) =>
      entry.state === "reply_origin_unknown" && entry.reference === null));
    assert.match(JSON.stringify(receipt), /origin is unknown/i);
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same-target barrier allows exactly one concurrent non-force stage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-same-"));
  const dbFile = join(dir, "publish.db");
  const firstEntered = deferred<void>();
  const releaseFirst = deferred<void>();
  let stageCalls = 0;
  let secondLoads = 0;
  try {
    const first = executeReplyRealRun(
      input(TARGET_A),
      dependencies(dbFile, async () => {
        stageCalls += 1;
        firstEntered.resolve();
        await releaseFirst.promise;
        return stageResult(TARGET_A);
      }),
    );
    await within(firstEntered.promise, "first same-target stage barrier");

    const second = await executeReplyRealRun(
      input(TARGET_A),
      dependencies(dbFile, async () => {
        stageCalls += 1;
        return stageResult(TARGET_A);
      }, () => {
        secondLoads += 1;
      }),
    );
    assert.equal(second.kind, "reservation_active");
    assert.equal(secondLoads, 0);
    assert.equal(stageCalls, 1);

    releaseFirst.resolve();
    const firstOutcome = await within(first, "first same-target completion");
    assert.equal(firstOutcome.kind, "staged");
    assert.equal(stageCalls, 1);
    assert.equal(ledgerStatus(dbFile, TARGET_A), "staged");
    assert.equal(reservationRow(dbFile, TARGET_A), undefined);
  } finally {
    releaseFirst.resolve();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("different targets both reach staging while no SQLite transaction is held", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-different-"));
  const dbFile = join(dir, "publish.db");
  const bothEntered = deferred<void>();
  const releaseBoth = deferred<void>();
  const entered = new Set<string>();
  try {
    const makeStage = (targetTweetId: string) => async (): Promise<StageReplyResult> => {
      entered.add(targetTweetId);
      if (entered.size === 2) bothEntered.resolve();
      await releaseBoth.promise;
      return stageResult(targetTweetId, targetTweetId === TARGET_A);
    };

    const first = executeReplyRealRun(input(TARGET_A), dependencies(dbFile, makeStage(TARGET_A)));
    const second = executeReplyRealRun(input(TARGET_B), dependencies(dbFile, makeStage(TARGET_B)));
    await within(bothEntered.promise, "both different-target stage barriers");
    assert.deepEqual([...entered].sort(), [TARGET_A, TARGET_B].sort());

    releaseBoth.resolve();
    const outcomes = await within(Promise.all([first, second]), "different-target completion");
    assert.deepEqual(outcomes.map((value) => value.kind), ["staged", "staged_unverified"]);
    assert.equal(ledgerStatus(dbFile, TARGET_A), "staged");
    assert.equal(ledgerStatus(dbFile, TARGET_B), "staged-unverified");
    assert.equal(reservationRow(dbFile, TARGET_A), undefined);
    assert.equal(reservationRow(dbFile, TARGET_B), undefined);
  } finally {
    releaseBoth.resolve();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent force and non-force runs cannot bypass a force owner's reservation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-force-"));
  const dbFile = join(dir, "publish.db");
  const forceEntered = deferred<void>();
  const releaseForce = deferred<void>();
  let stageCalls = 0;
  try {
    const seed = new ReplyLedger(dbFile, ORIGIN_ID);
    const initial = seed.claimReservation(TARGET_A, {
      reservationId: "seed-owner",
      now: NOW,
    });
    assert.equal(initial.kind, "acquired");
    if (initial.kind !== "acquired") throw new Error("seed reservation was not acquired");
    seed.finalizeReservation(initial.reservation, { status: "staged" });
    seed.close();

    const owner = executeReplyRealRun(
      input(TARGET_A, true),
      dependencies(dbFile, async () => {
        stageCalls += 1;
        forceEntered.resolve();
        await releaseForce.promise;
        return stageResult(TARGET_A);
      }),
    );
    await within(forceEntered.promise, "force owner stage barrier");

    for (const force of [false, true]) {
      let loaded = false;
      const blocked = await executeReplyRealRun(
        input(TARGET_A, force),
        dependencies(dbFile, async () => stageResult(TARGET_A), () => {
          loaded = true;
        }),
      );
      assert.equal(blocked.kind, "reservation_active");
      assert.equal(loaded, false);
      assert.match(blocked.message, /--force cannot bypass/);
    }
    assert.equal(stageCalls, 1);

    releaseForce.resolve();
    assert.equal((await within(owner, "force owner completion")).kind, "staged");
    assert.equal(ledgerStatus(dbFile, TARGET_A), "staged");
  } finally {
    releaseForce.resolve();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic finalization failure leaves both ledger and reservation conservative", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-finalize-"));
  const dbFile = join(dir, "publish.db");
  try {
    const outcome = await executeReplyRealRun(
      input(TARGET_A),
      dependencies(dbFile, async () => {
        withRawDb(dbFile, (db) => db.exec(`
          CREATE TRIGGER fail_reply_finalize
          BEFORE DELETE ON reply_reservations
          BEGIN
            SELECT RAISE(ABORT, 'forced finalize failure');
          END;
        `));
        return stageResult(TARGET_A, false);
      }),
    );
    assert.equal(outcome.kind, "ledger_persistence_failed");
    assert.equal(ledgerStatus(dbFile, TARGET_A), undefined);
    assert.ok(reservationRow(dbFile, TARGET_A));

    let loaded = false;
    const blocked = await executeReplyRealRun(
      input(TARGET_A, true),
      dependencies(dbFile, async () => stageResult(TARGET_A), () => {
        loaded = true;
      }),
    );
    assert.equal(blocked.kind, "reservation_active");
    assert.equal(loaded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize commit followed by a thrown port error stays truthfully uncertain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-after-commit-"));
  const dbFile = join(dir, "publish.db");
  try {
    const deps: ReplyRealRunDependencies = {
      async openLedger() {
        const ledger = new ReplyLedger(dbFile, ORIGIN_ID);
        const port: ReplyLedgerPort = {
          claimReservation: ledger.claimReservation.bind(ledger),
          releaseReservation: ledger.releaseReservation.bind(ledger),
          finalizeReservation(reservation, options) {
            ledger.finalizeReservation(reservation, options);
            throw new Error("RAW_AFTER_COMMIT_PRIVATE_PATH");
          },
          recoverStaleReservation: ledger.recoverStaleReservation.bind(ledger),
          close: ledger.close.bind(ledger),
        };
        return port;
      },
      async loadStageReplyDraft() {
        return async () => stageResult(TARGET_A, false);
      },
    };
    const outcome = await executeReplyRealRun(input(TARGET_A), deps);
    assert.equal(outcome.kind, "ledger_persistence_failed");
    assert.equal(outcome.savePhase, "save_delivered_unverified");
    assert.match(outcome.message, /finalization outcome could not be confirmed/);
    assert.match(outcome.message, /reservation and finalized-history state are unknown/);
    assert.doesNotMatch(outcome.message, /RAW_AFTER_COMMIT|reservation .* remains/i);
    assert.equal(ledgerStatus(dbFile, TARGET_A), "staged-unverified");
    assert.equal(reservationRow(dbFile, TARGET_A), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("actual stage rejection and unusable result both leave the reservation row", async () => {
  for (const mode of ["throw", "undefined"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-retain-"));
    const dbFile = join(dir, "publish.db");
    try {
      const outcome = await executeReplyRealRun(
        input(TARGET_A),
        dependencies(dbFile, async () => {
          if (mode === "throw") throw new Error("offline stage rejection");
          return undefined as unknown as StageReplyResult;
        }),
      );
      assert.equal(
        outcome.kind,
        mode === "throw" ? "native_stage_uncertain" : "stage_result_inconclusive",
      );
      assert.ok(reservationRow(dbFile, TARGET_A));
      assert.equal(ledgerStatus(dbFile, TARGET_A), undefined);

      let loaded = false;
      const blocked = await executeReplyRealRun(
        input(TARGET_A, true),
        dependencies(dbFile, async () => stageResult(TARGET_A), () => {
          loaded = true;
        }),
      );
      assert.equal(blocked.kind, "reservation_active");
      assert.equal(loaded, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("crash residue is never auto-cleared and recovery starts exactly at 24 hours", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-stale-"));
  const dbFile = join(dir, "publish.db");
  try {
    const crashed = new ReplyLedger(dbFile, ORIGIN_ID);
    const claim = crashed.claimReservation(TARGET_A, {
      reservationId: "crashed-owner",
      now: NOW,
    });
    assert.equal(claim.kind, "acquired");
    crashed.close();

    const beforeBoundary = new Date(NOW.getTime() + REPLY_RESERVATION_STALE_AFTER_MS - 1);
    const observer = new ReplyLedger(dbFile, ORIGIN_ID);
    const normal = observer.claimReservation(TARGET_A, { now: beforeBoundary });
    const forced = observer.claimReservation(TARGET_A, { force: true, now: beforeBoundary });
    assert.equal(normal.kind, "reservation_blocked");
    assert.equal(forced.kind, "reservation_blocked");
    if (normal.kind === "reservation_blocked") assert.equal(normal.state, "active");
    if (forced.kind === "reservation_blocked") assert.equal(forced.state, "active");
    assert.equal(observer.recoverStaleReservation(TARGET_A, beforeBoundary).kind, "reservation_blocked");

    const boundary = new Date(NOW.getTime() + REPLY_RESERVATION_STALE_AFTER_MS);
    const stale = observer.claimReservation(TARGET_A, { force: true, now: boundary });
    assert.equal(stale.kind, "reservation_blocked");
    if (stale.kind === "reservation_blocked") assert.equal(stale.state, "stale");
    assert.equal(reservationRow(dbFile, TARGET_A)?.reservationId, "crashed-owner");

    const recovered = observer.recoverStaleReservation(TARGET_A, boundary);
    assert.equal(recovered.kind, "recovered");
    assert.equal(reservationRow(dbFile, TARGET_A), undefined);
    const later = observer.claimReservation(TARGET_A, {
      reservationId: "later-owner",
      now: new Date(boundary.getTime() + 1),
    });
    assert.equal(later.kind, "acquired");
    observer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovered owner fencing prevents late finalize or release from touching a new claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-fence-"));
  const dbFile = join(dir, "publish.db");
  try {
    const ledger = new ReplyLedger(dbFile, ORIGIN_ID);
    const old = ledger.claimReservation(TARGET_A, {
      reservationId: "old-owner",
      now: NOW,
    });
    assert.equal(old.kind, "acquired");
    if (old.kind !== "acquired") throw new Error("old owner was not acquired");
    const boundary = new Date(NOW.getTime() + REPLY_RESERVATION_STALE_AFTER_MS);
    assert.equal(ledger.recoverStaleReservation(TARGET_A, boundary).kind, "recovered");
    const current = ledger.claimReservation(TARGET_A, {
      reservationId: "current-owner",
      now: new Date(boundary.getTime() + 1),
    });
    assert.equal(current.kind, "acquired");
    if (current.kind !== "acquired") throw new Error("current owner was not acquired");

    assert.throws(() => ledger.finalizeReservation(old.reservation, { status: "staged" }));
    assert.equal(ledger.releaseReservation(old.reservation), false);
    assert.equal(reservationRow(dbFile, TARGET_A)?.reservationId, current.reservation.reservationId);
    assert.equal(ledgerStatus(dbFile, TARGET_A), undefined);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid and future reservation times stay ambiguous and ineligible for recovery", () => {
  for (const reservedAt of ["not-a-date", "2030-09-04T12:00:00.000Z"]) {
    const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-ambiguous-"));
    const dbFile = join(dir, "publish.db");
    try {
      const ledger = new ReplyLedger(dbFile, ORIGIN_ID);
      const claim = ledger.claimReservation(TARGET_A, {
        reservationId: "ambiguous-owner",
        now: NOW,
      });
      assert.equal(claim.kind, "acquired");
      withRawDb(dbFile, (db) => db
        .prepare("UPDATE reply_reservations SET reserved_at = ? WHERE target_tweet_id = ?")
        .run(reservedAt, TARGET_A));
      const blocked = ledger.claimReservation(TARGET_A, {
        force: true,
        now: new Date(NOW.getTime() + REPLY_RESERVATION_STALE_AFTER_MS * 2),
      });
      assert.equal(blocked.kind, "reservation_blocked");
      if (blocked.kind === "reservation_blocked") assert.equal(blocked.state, "ambiguous");
      const recovery = ledger.recoverStaleReservation(
        TARGET_A,
        new Date(NOW.getTime() + REPLY_RESERVATION_STALE_AFTER_MS * 2),
      );
      assert.equal(recovery.kind, "reservation_blocked");
      if (recovery.kind === "reservation_blocked") assert.equal(recovery.state, "ambiguous");
      ledger.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("two recovery attempts clear once and never start staging", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-recover-race-"));
  const dbFile = join(dir, "publish.db");
  try {
    const seed = new ReplyLedger(dbFile, ORIGIN_ID);
    seed.claimReservation(TARGET_A, { reservationId: "stale-owner", now: NOW });
    seed.close();
    const boundary = new Date(NOW.getTime() + REPLY_RESERVATION_STALE_AFTER_MS);
    const first = new ReplyLedger(dbFile, ORIGIN_ID);
    const second = new ReplyLedger(dbFile, ORIGIN_ID);
    const outcomes = [
      first.recoverStaleReservation(TARGET_A, boundary),
      second.recoverStaleReservation(TARGET_A, boundary),
    ];
    assert.deepEqual(outcomes.map((value) => value.kind).sort(), ["missing", "recovered"]);
    assert.equal(reservationRow(dbFile, TARGET_A), undefined);
    assert.equal(ledgerStatus(dbFile, TARGET_A), undefined);
    first.close();
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI recovery is content-free, locally rejects staging flags, and never imports X", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-reply-reservation-cli-"));
  const repoDir = join(dir, "repo");
  const dataDir = join(dir, "data");
  const dbDir = join(repoDir, ".publish-cli");
  const dbFile = join(dbDir, "publish.db");
  const loaderPath = join(dir, "block-x-staging.mjs");
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(
    loaderPath,
    `import { registerHooks } from "node:module";
const blocked = ["/dist/x/draftPoster.js", "/dist/session.js", "/node_modules/playwright/"];
const blockedDb = ["/dist/db.js", "/node_modules/better-sqlite3/"];
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (blocked.some((needle) => resolved.url.includes(needle))) {
    throw new Error("X_STAGING_IMPORT_BLOCKED: " + resolved.url);
  }
  if (process.env.PUBLISH_TEST_BLOCK_REPLY_DB === "1" && blockedDb.some((needle) => resolved.url.includes(needle))) {
    throw new Error("REPLY_DB_IMPORT_BLOCKED: " + resolved.url);
  }
  return resolved;
} });
`,
  );

  const run = (args: string[], blockDb = false) => spawnSync(
    process.execPath,
    ["--import", loaderPath, CLI_PATH, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PUBLISH_DATA_REPO: repoDir,
        PUBLISH_DATA_DIR: dataDir,
        PUBLISH_TEST_BLOCK_REPLY_DB: blockDb ? "1" : "0",
      },
    },
  );
  const combined = (result: ReturnType<typeof run>) => `${result.stdout}${result.stderr}`;

  try {
    const profileDir = join(dataDir, "x-profile");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, ".publish-origin.json"),
      `${JSON.stringify({ schemaVersion: X_PROFILE_ORIGIN_SCHEMA_VERSION, originId: ORIGIN_ID })}\n`,
      { mode: 0o600 },
    );
    const seed = new ReplyLedger(dbFile, ORIGIN_ID);
    seed.claimReservation(TARGET_A, {
      reservationId: "cli-stale-owner",
      now: new Date(Date.now() - REPLY_RESERVATION_STALE_AFTER_MS - 1_000),
    });
    seed.close();

    for (const conflict of [
      ["--text", "body"],
      ["--from", join(dir, "unused.md")],
      ["--long"],
      ["--dry-run"],
      ["--inspect"],
      ["--force"],
    ]) {
      const result = run(["x", "reply", "--to", TARGET_A, RECOVERY_FLAG, ...conflict], true);
      assert.equal(result.status, 2, combined(result));
      assert.match(combined(result), /recovery-only and accepts only --to/);
      assert.doesNotMatch(combined(result), /X_STAGING_IMPORT_BLOCKED|REPLY_DB_IMPORT_BLOCKED/);
      assert.ok(reservationRow(dbFile, TARGET_A), `reservation changed for ${conflict[0]}`);
    }

    const recovered = run([
      "x", "reply", "--to", `https://twitter.com/i/web/status/${TARGET_A}?s=20#reviewed`,
      RECOVERY_FLAG,
    ]);
    assert.equal(recovered.status, 0, combined(recovered));
    assert.match(recovered.stdout, /terminal draft state: local_state_updated/);
    assert.match(recovered.stdout, /state=reservation_recovered/);
    assert.match(recovered.stdout, /state=reply_origin_matched/);
    assert.match(recovered.stdout, new RegExp(ORIGIN_ID));
    assert.match(recovered.stdout, /exact CLI-owned profile used by that run/);
    assert.match(recovered.stdout, /no matching reply draft/);
    assert.match(recovered.stdout, /no native staging was attempted/i);
    assert.doesNotMatch(combined(recovered), /X_STAGING_IMPORT_BLOCKED/);
    assert.equal(reservationRow(dbFile, TARGET_A), undefined);

    const absentRepo = join(dir, "absent-repo");
    const absentData = join(dir, "absent-data");
    const invalid = spawnSync(
      process.execPath,
      ["--import", loaderPath, CLI_PATH, "x", "reply", "--to", "not-a-target", RECOVERY_FLAG],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PUBLISH_DATA_REPO: absentRepo,
          PUBLISH_DATA_DIR: absentData,
          PUBLISH_TEST_BLOCK_REPLY_DB: "1",
        },
      },
    );
    assert.equal(invalid.status, 2, `${invalid.stdout}${invalid.stderr}`);
    assert.match(`${invalid.stdout}${invalid.stderr}`, /Invalid --to/);
    assert.doesNotMatch(
      `${invalid.stdout}${invalid.stderr}`,
      /X_STAGING_IMPORT_BLOCKED|REPLY_DB_IMPORT_BLOCKED/,
    );
    assert.equal(existsSync(absentRepo), false);
    assert.equal(existsSync(absentData), false);

    for (const args of [["x", "reply", "--help"], ["x", "info", "--static", "--json"]]) {
      const readonlyRepo = join(dir, `readonly-repo-${args[1]}`);
      const readonlyData = join(dir, `readonly-data-${args[1]}`);
      const readonly = spawnSync(process.execPath, ["--import", loaderPath, CLI_PATH, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          PUBLISH_DATA_REPO: readonlyRepo,
          PUBLISH_DATA_DIR: readonlyData,
          PUBLISH_TEST_BLOCK_REPLY_DB: "1",
        },
      });
      assert.equal(readonly.status, 0, `${readonly.stdout}${readonly.stderr}`);
      assert.doesNotMatch(
        `${readonly.stdout}${readonly.stderr}`,
        /X_STAGING_IMPORT_BLOCKED|REPLY_DB_IMPORT_BLOCKED/,
      );
      assert.equal(existsSync(readonlyRepo), false);
      assert.equal(existsSync(readonlyData), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

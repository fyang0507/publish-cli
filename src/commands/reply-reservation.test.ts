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
  executeReplyRealRun,
  type ReplyRealRunDependencies,
  type ReplyRealRunInput,
} from "./reply.js";
import type { GeneratedContent } from "../x/content.js";
import type { StageReplyResult } from "../x/draftPoster.js";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
const RECOVERY_FLAG = "--recover-stale-reservation-after-confirming-no-draft";
const TARGET_A = "1234567890123456789";
const TARGET_B = "9876543210987654321";
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

function stageResult(targetTweetId: string, verified = true): StageReplyResult {
  return {
    format: "tweet",
    posts: 1,
    verified,
    note: "Offline barrier stage result.",
    replyToId: targetTweetId,
  };
}

function dependencies(
  dbFile: string,
  stage: (targetIdOrUrl: string) => Promise<StageReplyResult>,
  onLoad?: () => void,
): ReplyRealRunDependencies {
  return {
    async openLedger() {
      return new ReplyLedger(dbFile);
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
              reserved_at AS reservedAt
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

    const ledger = new ReplyLedger(dbFile);
    assert.deepEqual(ledger.find(TARGET_A), {
      targetTweetId: TARGET_A,
      stagedAt: NOW.toISOString(),
      status: "staged",
      draftRef: null,
    });
    assert.equal(ledger.claimReservation(TARGET_A, { now: NOW }).kind, "already_staged");
    const separate = ledger.claimReservation(TARGET_B, {
      now: NOW,
      reservationId: "new-table-owner",
    });
    assert.equal(separate.kind, "acquired");
    if (separate.kind !== "acquired") throw new Error("new reservation table was unavailable");
    assert.equal(ledger.releaseReservation(separate.reservation), true);
    const forced = ledger.claimReservation(TARGET_A, {
      force: true,
      now: NOW,
      reservationId: "legacy-force-owner",
    });
    assert.equal(forced.kind, "acquired");
    if (forced.kind !== "acquired") throw new Error("forced legacy claim was not acquired");
    assert.equal(ledger.releaseReservation(forced.reservation), true);
    assert.equal(ledger.find(TARGET_A)?.status, "staged");
    ledger.close();
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
    assert.deepEqual(outcomes.map((value) => value.kind), ["staged", "staged"]);
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
    const seed = new ReplyLedger(dbFile);
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
        mode === "throw" ? "native_stage_failed" : "stage_result_inconclusive",
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
    const crashed = new ReplyLedger(dbFile);
    const claim = crashed.claimReservation(TARGET_A, {
      reservationId: "crashed-owner",
      now: NOW,
    });
    assert.equal(claim.kind, "acquired");
    crashed.close();

    const beforeBoundary = new Date(NOW.getTime() + REPLY_RESERVATION_STALE_AFTER_MS - 1);
    const observer = new ReplyLedger(dbFile);
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
    const ledger = new ReplyLedger(dbFile);
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
      const ledger = new ReplyLedger(dbFile);
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
    const seed = new ReplyLedger(dbFile);
    seed.claimReservation(TARGET_A, { reservationId: "stale-owner", now: NOW });
    seed.close();
    const boundary = new Date(NOW.getTime() + REPLY_RESERVATION_STALE_AFTER_MS);
    const first = new ReplyLedger(dbFile);
    const second = new ReplyLedger(dbFile);
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
    const seed = new ReplyLedger(dbFile);
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
    assert.match(recovered.stdout, /Cleared the stale X reply reservation/);
    assert.match(recovered.stdout, /exact CLI-owned profile used by that run/);
    assert.match(recovered.stdout, /no matching reply draft was found/);
    assert.match(recovered.stdout, /No native staging was attempted/);
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

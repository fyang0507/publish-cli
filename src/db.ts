import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { dataPaths } from "./config.js";
import {
  ReplyOriginBoundaryError,
  isXProfileOriginId,
  loadOrCreateXProfileOrigin,
} from "./replyOrigin.js";

/**
 * Local SQLite store for the X watch loop. Its single job today is dedupe:
 * remember which posts we've already surfaced so repeated polls only emit new
 * items.
 *
 * The db file lives at the configured durable path — see config.dataPaths().dbFile.
 */
export class SeenStore {
  private db: Database.Database;

  /** @param path db file path; defaults to the configured durable database. */
  constructor(path?: string) {
    const file = path ?? dataPaths().dbFile;
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_posts (
        post_id     TEXT PRIMARY KEY,
        platform    TEXT NOT NULL DEFAULT 'x',
        origin      TEXT,
        first_seen  TEXT NOT NULL
      );
    `);
  }

  /** True if this post id has been recorded before. */
  hasSeen(postId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM seen_posts WHERE post_id = ?")
      .get(postId);
    return row !== undefined;
  }

  /**
   * Record a post id as seen. Idempotent (INSERT OR IGNORE).
   * @param origin the query or handle that surfaced the post (for provenance).
   */
  markSeen(postId: string, origin?: string, platform = "x"): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO seen_posts (post_id, platform, origin, first_seen)
         VALUES (?, ?, ?, ?)`,
      )
      .run(postId, platform, origin ?? null, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}

/** A recorded reply-ledger entry (issue #10). */
export interface ReplyLedgerEntry {
  targetTweetId: string;
  stagedAt: string;
  status: string;
  draftRef: string | null;
  originId: string;
}

export const REPLY_RESERVATION_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

export interface ReplyReservation {
  targetTweetId: string;
  reservationId: string;
  reservedAt: string;
  originId: string;
}

export type ReplyReservationState = "active" | "stale" | "ambiguous";

export type ReplyReservationClaim =
  | { kind: "acquired"; reservation: ReplyReservation }
  | { kind: "already_staged"; entry: ReplyLedgerEntry }
  | {
    kind: "reservation_blocked";
    reservation: ReplyReservation;
    state: ReplyReservationState;
  };

export type ReplyReservationRecovery =
  | { kind: "recovered"; reservation: ReplyReservation }
  | { kind: "missing" }
  | {
    kind: "reservation_blocked";
    reservation: ReplyReservation;
    state: Exclude<ReplyReservationState, "stale">;
  };

function reservationState(reservedAt: string, now: Date): ReplyReservationState {
  const reservedAtMs = Date.parse(reservedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(reservedAtMs) || !Number.isFinite(nowMs) || reservedAtMs > nowMs) {
    return "ambiguous";
  }
  return nowMs - reservedAtMs >= REPLY_RESERVATION_STALE_AFTER_MS ? "stale" : "active";
}

/**
 * Write-dedup ledger for staged replies (issue #10). Keyed on the TARGET tweet
 * id, this answers "have I already replied to this post?" — a different risk
 * tier from the read-path SeenStore ("have I looked at this post?").
 *
 * Replying is a WRITE, so it gets its own idempotency guarantee. Real reply
 * runners sharing this same live SQLite file atomically reserve a target before
 * browser work; a completed native stage is finalized only afterward. This
 * coordinates only one bound machine-local X profile origin; separate database
 * files, copied profiles, and separate machines are not coordinated.
 *
 * Lives in the SAME configured durable SQLite file as SeenStore but in a
 * SEPARATE table — read-dedup and write-dedup are deliberately decoupled.
 */
export class ReplyLedger {
  private db: Database.Database;
  private readonly originId: string;

  /**
   * @param path db file path; defaults to the configured durable file used by SeenStore.
   * @param originId injected only by deterministic tests; production resolves the
   * private identity stored inside the configured X profile.
   */
  constructor(path?: string, originId?: string) {
    const paths = originId === undefined || path === undefined ? dataPaths() : undefined;
    const file = path ?? paths!.dbFile;
    const resolvedOriginId = originId ?? loadOrCreateXProfileOrigin(paths!.xProfileOriginFile).originId;
    if (!isXProfileOriginId(resolvedOriginId)) {
      throw new Error("The local X profile origin identity is invalid.");
    }
    this.originId = resolvedOriginId;
    this.db = new Database(file);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    try {
      this.ensureSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private ensureSchema(): void {
    const initialize = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS reply_ledger (
          target_tweet_id TEXT PRIMARY KEY,
          staged_at       TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'staged',
          draft_ref       TEXT,
          origin_id       TEXT
        );

        CREATE TABLE IF NOT EXISTS reply_reservations (
          target_tweet_id TEXT PRIMARY KEY,
          reservation_id  TEXT NOT NULL UNIQUE,
          reserved_at     TEXT NOT NULL,
          origin_id       TEXT
        );

        CREATE TABLE IF NOT EXISTS reply_profile_binding (
          singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
          origin_id       TEXT NOT NULL,
          bound_at        TEXT NOT NULL
        );
      `);

      const ledgerColumns = this.db.prepare("PRAGMA table_info(reply_ledger)").all() as Array<{ name: string }>;
      if (!ledgerColumns.some((column) => column.name === "origin_id")) {
        this.db.exec("ALTER TABLE reply_ledger ADD COLUMN origin_id TEXT");
      }
      const reservationColumns = this.db.prepare("PRAGMA table_info(reply_reservations)").all() as Array<{ name: string }>;
      if (!reservationColumns.some((column) => column.name === "origin_id")) {
        this.db.exec("ALTER TABLE reply_reservations ADD COLUMN origin_id TEXT");
      }

      const binding = this.db
        .prepare("SELECT origin_id AS originId FROM reply_profile_binding WHERE singleton = 1")
        .get() as { originId: unknown } | undefined;
      if (!binding) {
        this.db
          .prepare("INSERT INTO reply_profile_binding (singleton, origin_id, bound_at) VALUES (1, ?, ?)")
          .run(this.originId, new Date().toISOString());
        return;
      }
      if (!isXProfileOriginId(binding.originId)) {
        throw new ReplyOriginBoundaryError({ originId: null, match: "unknown", scope: "database" });
      }
      if (binding.originId !== this.originId) {
        throw new ReplyOriginBoundaryError({
          originId: binding.originId,
          match: "mismatch",
          scope: "database",
        });
      }
    });
    initialize.immediate();
  }

  private assertOwnedOrigin(
    value: unknown,
    scope: "reservation" | "finalized_entry",
  ): string {
    if (!isXProfileOriginId(value)) {
      throw new ReplyOriginBoundaryError({ originId: null, match: "unknown", scope });
    }
    if (value !== this.originId) {
      throw new ReplyOriginBoundaryError({ originId: value, match: "mismatch", scope });
    }
    return value;
  }

  private findReservation(targetTweetId: string): ReplyReservation | undefined {
    const row = this.db
      .prepare(
        `SELECT target_tweet_id AS targetTweetId,
                reservation_id AS reservationId,
                reserved_at AS reservedAt,
                origin_id AS originId
           FROM reply_reservations WHERE target_tweet_id = ?`,
      )
      .get(targetTweetId) as (Omit<ReplyReservation, "originId"> & { originId: unknown }) | undefined;
    if (!row) return undefined;
    return { ...row, originId: this.assertOwnedOrigin(row.originId, "reservation") };
  }

  /** The recorded ledger entry for a target tweet id, or undefined if none. */
  find(targetTweetId: string): ReplyLedgerEntry | undefined {
    const row = this.db
      .prepare(
        `SELECT target_tweet_id AS targetTweetId, staged_at AS stagedAt,
                status, draft_ref AS draftRef, origin_id AS originId
           FROM reply_ledger WHERE target_tweet_id = ?`,
      )
      .get(targetTweetId) as (Omit<ReplyLedgerEntry, "originId"> & { originId: unknown }) | undefined;
    if (!row) return undefined;
    return { ...row, originId: this.assertOwnedOrigin(row.originId, "finalized_entry") };
  }

  /** True if a reply to this target tweet id has already been staged. */
  hasReplied(targetTweetId: string): boolean {
    return this.find(targetTweetId) !== undefined;
  }

  /**
   * Atomically claim one target for a browser staging attempt. The immediate
   * transaction ends before this method returns; callers must never put browser
   * work inside it. `force` bypasses finalized history only, never another
   * process's reservation.
   */
  claimReservation(
    targetTweetId: string,
    opts: { force?: boolean; now?: Date; reservationId?: string } = {},
  ): ReplyReservationClaim {
    const now = opts.now ?? new Date();
    const reserve = this.db.transaction((): ReplyReservationClaim => {
      const existingReservation = this.findReservation(targetTweetId);
      if (existingReservation) {
        return {
          kind: "reservation_blocked",
          reservation: existingReservation,
          state: reservationState(existingReservation.reservedAt, now),
        };
      }

      const prior = this.find(targetTweetId);
      if (prior && !opts.force) return { kind: "already_staged", entry: prior };

      const reservation: ReplyReservation = {
        targetTweetId,
        reservationId: opts.reservationId ?? randomUUID(),
        reservedAt: now.toISOString(),
        originId: this.originId,
      };
      this.db
        .prepare(
          `INSERT INTO reply_reservations (target_tweet_id, reservation_id, reserved_at, origin_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          reservation.targetTweetId,
          reservation.reservationId,
          reservation.reservedAt,
          reservation.originId,
        );
      return { kind: "acquired", reservation };
    });
    return reserve.immediate();
  }

  /** Release only the reservation owned by this staging process. */
  releaseReservation(reservation: ReplyReservation): boolean {
    this.assertOwnedOrigin(reservation.originId, "reservation");
    const result = this.db
      .prepare(
        `DELETE FROM reply_reservations
          WHERE target_tweet_id = ? AND reservation_id = ? AND origin_id = ?`,
      )
      .run(reservation.targetTweetId, reservation.reservationId, this.originId);
    return result.changes === 1;
  }

  /**
   * Atomically persist the returned native-stage result and release its exact
   * reservation. A failure rolls back both operations, retaining the claim.
   */
  finalizeReservation(
    reservation: ReplyReservation,
    opts: { status?: string; draftRef?: string | null } = {},
  ): void {
    const finalize = this.db.transaction(() => {
      const owned = this.db
        .prepare(
          `SELECT origin_id AS originId FROM reply_reservations
            WHERE target_tweet_id = ? AND reservation_id = ?`,
        )
        .get(reservation.targetTweetId, reservation.reservationId) as { originId: unknown } | undefined;
      if (!owned) throw new Error("Reply reservation ownership could not be confirmed.");
      this.assertOwnedOrigin(reservation.originId, "reservation");
      this.assertOwnedOrigin(owned.originId, "reservation");

      this.db
        .prepare(
          `INSERT INTO reply_ledger (target_tweet_id, staged_at, status, draft_ref, origin_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(target_tweet_id) DO UPDATE SET
             staged_at = excluded.staged_at,
             status = excluded.status,
             draft_ref = excluded.draft_ref,
             origin_id = excluded.origin_id`,
        )
        .run(
          reservation.targetTweetId,
          new Date().toISOString(),
          opts.status ?? "staged",
          opts.draftRef ?? null,
          this.originId,
        );

      const released = this.db
        .prepare(
          `DELETE FROM reply_reservations
            WHERE target_tweet_id = ? AND reservation_id = ? AND origin_id = ?`,
        )
        .run(reservation.targetTweetId, reservation.reservationId, this.originId);
      if (released.changes !== 1) {
        throw new Error("Reply reservation release could not be confirmed.");
      }
    });
    finalize.immediate();
  }

  /**
   * Recovery-only operation. Twenty-four hours makes a claim eligible for an
   * explicit operator-attested clear; age never triggers automatic deletion or
   * staging. The immediate transaction keeps classification and deletion
   * atomic without spanning any browser work.
   */
  recoverStaleReservation(targetTweetId: string, now = new Date()): ReplyReservationRecovery {
    const recover = this.db.transaction((): ReplyReservationRecovery => {
      const reservation = this.findReservation(targetTweetId);
      if (!reservation) return { kind: "missing" };
      const state = reservationState(reservation.reservedAt, now);
      if (state !== "stale") {
        return { kind: "reservation_blocked", reservation, state };
      }

      const cutoff = new Date(now.getTime() - REPLY_RESERVATION_STALE_AFTER_MS).toISOString();
      const deleted = this.db
        .prepare(
          `DELETE FROM reply_reservations
            WHERE target_tweet_id = ?
              AND reservation_id = ?
              AND reserved_at = ?
              AND origin_id = ?
              AND reserved_at <= ?`,
        )
        .run(targetTweetId, reservation.reservationId, reservation.reservedAt, this.originId, cutoff);
      if (deleted.changes !== 1) {
        throw new Error("Stale reply reservation recovery could not be confirmed.");
      }
      return { kind: "recovered", reservation };
    });
    return recover.immediate();
  }

  close(): void {
    this.db.close();
  }
}

import Database from "better-sqlite3";
import { dataPaths } from "./config.js";

/**
 * Local SQLite store for the X watch loop. Its single job today is dedupe:
 * remember which posts we've already surfaced so repeated polls only emit new
 * items.
 *
 * The db file lives under the runtime data dir (off Google Drive), NOT in the
 * repo — see config.dataPaths().dbFile.
 */
export class SeenStore {
  private db: Database.Database;

  /** @param path db file path; defaults to <dataDir>/publish.db. */
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
}

/**
 * Write-dedup ledger for staged replies (issue #10). Keyed on the TARGET tweet
 * id, this answers "have I already replied to this post?" — a different risk
 * tier from the read-path SeenStore ("have I looked at this post?").
 *
 * Replying is a WRITE, so it gets its own idempotency guarantee, robust to
 * failure modes the read path can't cover: a wiped/rebuilt dedupe db, a manual
 * re-run, a second machine, or a crash between surfacing and drafting. The
 * `reply` command consults this BEFORE staging and refuses (absent --force) if a
 * reply to that id was already staged; it records only after a successful stage.
 *
 * Lives in the SAME durable sqlite file as SeenStore (data repo, off Google
 * Drive) but in a SEPARATE table — read-dedup and write-dedup are deliberately
 * decoupled.
 */
export class ReplyLedger {
  private db: Database.Database;

  /** @param path db file path; defaults to <dataDir>/publish.db (same file as SeenStore). */
  constructor(path?: string) {
    const file = path ?? dataPaths().dbFile;
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reply_ledger (
        target_tweet_id TEXT PRIMARY KEY,
        staged_at       TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'staged',
        draft_ref       TEXT
      );
    `);
  }

  /** The recorded ledger entry for a target tweet id, or undefined if none. */
  find(targetTweetId: string): ReplyLedgerEntry | undefined {
    const row = this.db
      .prepare(
        `SELECT target_tweet_id AS targetTweetId, staged_at AS stagedAt,
                status, draft_ref AS draftRef
           FROM reply_ledger WHERE target_tweet_id = ?`,
      )
      .get(targetTweetId) as ReplyLedgerEntry | undefined;
    return row;
  }

  /** True if a reply to this target tweet id has already been staged. */
  hasReplied(targetTweetId: string): boolean {
    return this.find(targetTweetId) !== undefined;
  }

  /**
   * Record (or overwrite, on --force re-stage) a staged reply. Uses INSERT OR
   * REPLACE so a forced re-stage refreshes staged_at/draft_ref rather than
   * failing the primary-key constraint.
   */
  record(
    targetTweetId: string,
    opts: { status?: string; draftRef?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reply_ledger (target_tweet_id, staged_at, status, draft_ref)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        targetTweetId,
        new Date().toISOString(),
        opts.status ?? "staged",
        opts.draftRef ?? null,
      );
  }

  close(): void {
    this.db.close();
  }
}

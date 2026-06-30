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

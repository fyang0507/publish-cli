import { config } from "dotenv";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { tryResolveDataRepo } from "./dataRepo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env"), quiet: true });

/**
 * Environment config — secrets and infrastructure only.
 *
 * Behavior config (watch queries/accounts/triage criteria) lives in watch.yaml
 * and is loaded separately via loadWatchConfig().
 *
 * X session/auth note: there are NO pasted cookies here. The session module
 * (src/session.ts) performs an UNATTENDED credential login with PLAYWRIGHT
 * (X_USERNAME / X_PASSWORD / X_EMAIL), persists a browser profile under the
 * data dir, and harvests the auth_token + ct0 cookies into a cache file. Both
 * the watcher (cookie reads) and the publisher (browser automation) reuse that
 * one logged-in session.
 */
export interface PublishEnv {
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  TRIAGE_MODEL: string;
  /** X login handle (without leading @). */
  X_USERNAME: string;
  X_PASSWORD: string;
  /** Used to answer X's "confirm your email/phone" identifier challenge. */
  X_EMAIL: string;
}

const DEFAULT_TRIAGE_MODEL = "gemini-3.5-flash";

export const env: PublishEnv = {
  GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
  TRIAGE_MODEL: process.env.TRIAGE_MODEL ?? DEFAULT_TRIAGE_MODEL,
  X_USERNAME: process.env.X_USERNAME ?? "",
  X_PASSWORD: process.env.X_PASSWORD ?? "",
  X_EMAIL: process.env.X_EMAIL ?? "",
};

/**
 * Runtime paths. Two homes with different lifetimes:
 *   - baseDir (PUBLISH_DATA_DIR, default ~/.publish-cli): MACHINE-LOCAL session
 *     artifacts — the browser profile + cookie cache. Off any synced drive; the
 *     profile must never sit inside the repo.
 *   - dbFile: DURABLE dedupe state, placed in the DATA REPO (agent workspace, via
 *     dataRepo.ts) so it travels with the workspace; falls back to baseDir.
 *
 * baseDir resolution:
 *   1. PUBLISH_DATA_DIR env var, if set.
 *   2. Default: `${HOME || os.homedir()}/.publish-cli`.
 *
 * The directories are created on first access.
 */
export interface DataPaths {
  /** Base runtime dir, e.g. ~/.publish-cli. */
  baseDir: string;
  /** Persistent Playwright user-data-dir for the logged-in X profile. */
  xProfileDir: string;
  /** Harvested cookie cache (auth_token + ct0, ...) as JSON. */
  xCookieCache: string;
  /** better-sqlite3 dedupe store — in the data repo (`<dataRepo>/.publish-cli/`) when resolvable, else baseDir. */
  dbFile: string;
}

function resolveBaseDir(): string {
  const fromEnv = process.env.PUBLISH_DATA_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  return join(process.env.HOME || homedir(), ".publish-cli");
}

let cachedPaths: DataPaths | null = null;

/**
 * Resolve the runtime data paths and ensure the base dir + profile dir exist.
 * Idempotent and cached for the process lifetime.
 */
export function dataPaths(): DataPaths {
  if (cachedPaths) return cachedPaths;

  const baseDir = resolveBaseDir();
  const xProfileDir = join(baseDir, "x-profile");

  // Machine-local SESSION/secret artifacts (browser profile + cookie cache) live
  // under baseDir (~/.publish-cli), off any synced drive.
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(xProfileDir, { recursive: true });

  // DURABLE state (the dedupe DB) lives in the DATA REPO (the agent workspace) so
  // it travels with the workspace rather than the machine. Falls back to baseDir
  // when no data repo is resolvable (ad-hoc use, no workspace/env/dev-config).
  const dataRepo = tryResolveDataRepo();
  const dbDir = dataRepo ? join(dataRepo, ".publish-cli") : baseDir;
  mkdirSync(dbDir, { recursive: true });

  cachedPaths = {
    baseDir,
    xProfileDir,
    xCookieCache: join(baseDir, "x-cookies.json"),
    dbFile: join(dbDir, "publish.db"),
  };
  return cachedPaths;
}

/** Triage rubric, mirrors the `triage:` block of watch.yaml. */
export interface TriageConfig {
  persona: string;
  dimensions: string[];
  min_score: number;
  /**
   * How many posts to send the model per triage call. Short tweets pack fine at
   * ~25; going much higher risks the low-effort model truncating its JSON array
   * (the cap is output length). Overridable per-run via `--batch-size`.
   */
  batch_size: number;
}

/** Parsed watch.yaml behavior config for the X watch loop. */
export interface WatchConfig {
  triage_model: string;
  queries: string[];
  accounts: string[];
  /** X List ids whose merged member timeline to read (one fetch covers N accounts). */
  lists: string[];
  per_origin_limit: number;
  triage: TriageConfig;
}

const WATCH_DEFAULTS: WatchConfig = {
  triage_model: env.TRIAGE_MODEL,
  queries: [],
  accounts: [],
  lists: [],
  per_origin_limit: 25,
  triage: {
    persona: "",
    dimensions: ["fit", "timeliness", "unique_value"],
    min_score: 60,
    batch_size: 25,
  },
};

/**
 * Load and shallow-merge watch.yaml behavior config over defaults.
 * @param path explicit path to a watch.yaml; defaults to ./watch.yaml at the repo root.
 */
export function loadWatchConfig(path?: string): WatchConfig {
  const file = path ?? resolve(__dirname, "..", "watch.yaml");
  if (!existsSync(file)) return { ...WATCH_DEFAULTS };

  const parsed = (parseYaml(readFileSync(file, "utf-8")) ?? {}) as Partial<WatchConfig>;
  return {
    ...WATCH_DEFAULTS,
    ...parsed,
    triage: { ...WATCH_DEFAULTS.triage, ...(parsed.triage ?? {}) },
  };
}

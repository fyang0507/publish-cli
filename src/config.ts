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
 * Behavior config (watch queries/lists/triage criteria) lives in watch.yaml
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
  /** LinkedIn login identifier (email or member handle). */
  LI_USERNAME: string;
  LI_PASSWORD: string;
  /** Used to answer LinkedIn's email/identifier confirmation challenge. */
  LI_EMAIL: string;
  /** Reddit login username. */
  REDDIT_USERNAME: string;
  REDDIT_PASSWORD: string;
  /** Used to answer Reddit's email/identifier confirmation challenge. */
  REDDIT_EMAIL: string;
  /**
   * When truthy, `reddit inspect` / `reddit search` launch a HEADFUL browser by
   * default. Reddit's edge 403-blocks headless Chrome's fingerprint on some
   * networks/machines (the reads then hit a non-JSON "network security" wall);
   * a real headful Chrome passes. Reads are login-free, so this needs NO human —
   * it just needs a display to render into. Leave unset on well-fingerprinted /
   * headless-server hosts (where headless reads work and a headful browser would
   * need a virtual display). The reads also AUTO-RETRY headful once on a block, so
   * this flag mainly skips the wasted first headless attempt. Accepts 1/true/yes.
   */
  REDDIT_READS_HEADFUL: boolean;
}

const DEFAULT_TRIAGE_MODEL = "gemini-3.5-flash";

export const env: PublishEnv = {
  GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
  TRIAGE_MODEL: process.env.TRIAGE_MODEL ?? DEFAULT_TRIAGE_MODEL,
  X_USERNAME: process.env.X_USERNAME ?? "",
  X_PASSWORD: process.env.X_PASSWORD ?? "",
  X_EMAIL: process.env.X_EMAIL ?? "",
  LI_USERNAME: process.env.LI_USERNAME ?? "",
  LI_PASSWORD: process.env.LI_PASSWORD ?? "",
  LI_EMAIL: process.env.LI_EMAIL ?? "",
  REDDIT_USERNAME: process.env.REDDIT_USERNAME ?? "",
  REDDIT_PASSWORD: process.env.REDDIT_PASSWORD ?? "",
  REDDIT_EMAIL: process.env.REDDIT_EMAIL ?? "",
  REDDIT_READS_HEADFUL: /^(1|true|yes)$/i.test(process.env.REDDIT_READS_HEADFUL?.trim() ?? ""),
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
  /** Persistent Playwright user-data-dir for the logged-in LinkedIn profile. */
  liProfileDir: string;
  /** Harvested LinkedIn cookie cache as JSON. */
  liCookieCache: string;
  /** Persistent Playwright user-data-dir for the logged-in Reddit profile. */
  redditProfileDir: string;
  /** Harvested Reddit cookie cache as JSON. */
  redditCookieCache: string;
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
  const liProfileDir = join(baseDir, "li-profile");
  const redditProfileDir = join(baseDir, "reddit-profile");

  // Machine-local SESSION/secret artifacts (browser profile + cookie cache) live
  // under baseDir (~/.publish-cli), off any synced drive. One persistent profile
  // per browser-driven channel (X, LinkedIn, Reddit).
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(xProfileDir, { recursive: true });
  mkdirSync(liProfileDir, { recursive: true });
  mkdirSync(redditProfileDir, { recursive: true });

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
    liProfileDir,
    liCookieCache: join(baseDir, "li-cookies.json"),
    redditProfileDir,
    redditCookieCache: join(baseDir, "reddit-cookies.json"),
    dbFile: join(dbDir, "publish.db"),
  };
  return cachedPaths;
}

/** Triage rubric, mirrors the `triage:` block of watch.yaml. */
export interface TriageConfig {
  /**
   * Free-text reply-worthiness rubric (who is replying / what's additive). The
   * scoring dimensions themselves (fit/timeliness/unique_value) are a FIXED,
   * defined baseline in the triage prompt — not configurable by bare name, since
   * a bare axis label like "clarity" has no shared definition. Per-run nuance
   * goes here (or via --persona), where the caller can define its own criteria.
   */
  persona: string;
  /** Surface candidates at or above this score. Config unit is 0-100. */
  min_score: number;
  /**
   * How many posts to send the model per triage call. Short tweets pack fine at
   * ~25; going much higher risks the low-effort model truncating its JSON array
   * (the cap is output length). Config-only — it's perf plumbing, not per-run
   * editorial judgment.
   */
  batch_size: number;
}

/** Parsed watch.yaml behavior config for the X watch loop. */
export interface WatchConfig {
  triage_model: string;
  queries: string[];
  /** X List ids whose merged member timeline to read (one fetch covers N accounts). */
  lists: string[];
  per_origin_limit: number;
  /**
   * Max characters of a collapsed thread's text kept per candidate. Threads are
   * merged into one candidate (see collapseThreads) and can be arbitrarily long;
   * this caps how much lands in the triage classifier's context. Over the cap the
   * head and tail are kept and the middle is elided. Governs candidate assembly,
   * so it applies to --no-triage runs too.
   */
  max_thread_chars: number;
  /**
   * Allow-list of candidate languages (BCP-47-ish codes, e.g. ["en", "zh"]).
   * EMPTY = no filter / allow all — the public-repo default. When set, posts
   * KNOWN to be outside the list are dropped before triage so they don't burn
   * classifier/drafting tokens; untagged/undetermined posts are kept. Codes are
   * normalized at use (case + region stripped, "zh-CN" -> "zh"). Applied via the
   * channel-agnostic src/langFilter.ts, so any future watch channel reuses it.
   */
  allowed_languages: string[];
  triage: TriageConfig;
}

const WATCH_DEFAULTS: WatchConfig = {
  triage_model: env.TRIAGE_MODEL,
  queries: [],
  lists: [],
  per_origin_limit: 25,
  max_thread_chars: 1500,
  allowed_languages: [],
  triage: {
    persona: "",
    min_score: 60,
    batch_size: 25,
  },
};

const TOP_KEYS = ["triage_model", "queries", "lists", "per_origin_limit", "max_thread_chars", "allowed_languages", "triage"] as const;
const TRIAGE_KEYS = ["persona", "min_score", "batch_size"] as const;

/**
 * Migration hints for keys that USED to be valid and were removed in a schema
 * change. A bare "unknown key" error is accurate but leaves an agent repairing an
 * older config guessing at the replacement; these point at it (issue #19).
 */
const REMOVED_TOP_KEY_HINTS: Record<string, string> = {
  accounts:
    "per-account watching is no longer supported — build an X List with `publish x create-watch-list` and put its id under `lists`.",
};
const REMOVED_TRIAGE_KEY_HINTS: Record<string, string> = {
  dimensions:
    "scoring dimensions are fixed in the classifier prompt — express campaign-specific criteria in `triage.persona`.",
};

/**
 * Load and VALIDATE watch.yaml behavior config, merged over defaults.
 *
 * Unlike a silent shallow-merge, this rejects unknown keys (catches typos like
 * `dimenions`) and type-checks every field, throwing a single per-field error
 * list so a bad config fails LOUDLY — the caller (watch command) prints it and
 * exits before opening the browser, rather than running with silent defaults.
 *
 * @param path explicit path to a watch.yaml; defaults to ./watch.yaml at the repo root.
 */
export function loadWatchConfig(path?: string): WatchConfig {
  const file = path ?? resolve(__dirname, "..", "watch.yaml");
  // No file = pure defaults (a fully flag-specified run needs no config).
  if (!existsSync(file)) return { ...WATCH_DEFAULTS, triage: { ...WATCH_DEFAULTS.triage } };

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, "utf-8")) ?? {};
  } catch (err) {
    throw new Error(`watch.yaml is not valid YAML (${file}): ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`watch.yaml must be a YAML mapping (${file}).`);
  }

  const errors: string[] = [];
  const out: WatchConfig = { ...WATCH_DEFAULTS, triage: { ...WATCH_DEFAULTS.triage } };

  for (const k of Object.keys(parsed)) {
    if (!(TOP_KEYS as readonly string[]).includes(k)) {
      const hint = REMOVED_TOP_KEY_HINTS[k];
      errors.push(
        `unknown key "${k}" (expected one of: ${TOP_KEYS.join(", ")})` + (hint ? ` — ${hint}` : ""),
      );
    }
  }

  if ("triage_model" in parsed) {
    if (typeof parsed.triage_model === "string" && parsed.triage_model.trim()) out.triage_model = parsed.triage_model;
    else errors.push(`triage_model: expected a non-empty string, got ${describe(parsed.triage_model)}`);
  }
  if ("queries" in parsed) {
    if (isStringArray(parsed.queries)) out.queries = parsed.queries;
    else errors.push(`queries: expected a list of strings, got ${describe(parsed.queries)}`);
  }
  if ("lists" in parsed) {
    if (isStringArray(parsed.lists)) out.lists = parsed.lists;
    else errors.push(`lists: expected a list of strings (X List ids), got ${describe(parsed.lists)}`);
  }
  if ("per_origin_limit" in parsed) {
    if (isPositiveInt(parsed.per_origin_limit)) out.per_origin_limit = parsed.per_origin_limit;
    else errors.push(`per_origin_limit: expected a positive integer, got ${describe(parsed.per_origin_limit)}`);
  }
  if ("max_thread_chars" in parsed) {
    if (isPositiveInt(parsed.max_thread_chars)) out.max_thread_chars = parsed.max_thread_chars;
    else errors.push(`max_thread_chars: expected a positive integer, got ${describe(parsed.max_thread_chars)}`);
  }
  if ("allowed_languages" in parsed) {
    if (isStringArray(parsed.allowed_languages)) out.allowed_languages = parsed.allowed_languages;
    else
      errors.push(
        `allowed_languages: expected a list of language-code strings (e.g. [en, zh]), got ${describe(parsed.allowed_languages)}`,
      );
  }
  if ("triage" in parsed) {
    if (!isPlainObject(parsed.triage)) {
      errors.push(`triage: expected a mapping, got ${describe(parsed.triage)}`);
    } else {
      const tr = parsed.triage;
      for (const k of Object.keys(tr)) {
        if (!(TRIAGE_KEYS as readonly string[]).includes(k)) {
          const hint = REMOVED_TRIAGE_KEY_HINTS[k];
          errors.push(
            `triage.${k}: unknown key (expected one of: ${TRIAGE_KEYS.join(", ")})` + (hint ? ` — ${hint}` : ""),
          );
        }
      }
      if ("persona" in tr) {
        if (typeof tr.persona === "string") out.triage.persona = tr.persona;
        else errors.push(`triage.persona: expected a string, got ${describe(tr.persona)}`);
      }
      if ("min_score" in tr) {
        if (typeof tr.min_score === "number" && Number.isFinite(tr.min_score) && tr.min_score >= 0 && tr.min_score <= 100) {
          out.triage.min_score = tr.min_score;
        } else {
          errors.push(`triage.min_score: expected a number in 0..100, got ${describe(tr.min_score)}`);
        }
      }
      if ("batch_size" in tr) {
        if (isPositiveInt(tr.batch_size)) out.triage.batch_size = tr.batch_size;
        else errors.push(`triage.batch_size: expected a positive integer, got ${describe(tr.batch_size)}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid watch config (${file}):\n` + errors.map((e) => `  - ${e}`).join("\n"));
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v.length > 40 ? `a ${v.length}-char string` : JSON.stringify(v);
  return typeof v;
}

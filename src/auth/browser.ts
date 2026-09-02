import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type {
  AuthNextStep,
  AuthPlatform,
  AuthReadiness,
  BrowserLiveObservation,
  BrowserLocalEvidence,
} from "./types.js";

interface CookieShape {
  name?: unknown;
  expires?: unknown;
}

export interface PassiveBrowserProbeConfig {
  platform: Extract<AuthPlatform, "x" | "linkedin" | "reddit">;
  profileDir: string;
  cookieCache: string;
  requiredCookieNames: string[];
  entryUrl: string;
  authenticatedSelectors: string[];
  loggedOutSelectors: string[];
  challengeSelectors: string[];
  loggedOutUrlPatterns: RegExp[];
  challengeUrlPatterns: RegExp[];
  credentialsConfigured: boolean;
  manualLoginSupported: boolean;
  workflowRef: string;
  credentialsInstruction: string;
  loginInstruction: string;
  challengeInstruction: string;
}

export interface BrowserProbeBackend {
  probe(config: PassiveBrowserProbeConfig): Promise<BrowserLiveObservation>;
}

type PassiveContextLauncher = (
  profileDir: string,
  headless: boolean,
) => Promise<BrowserContext>;

interface PassiveProfileSnapshot {
  profileDir: string;
  cleanup(): Promise<void>;
}

interface BrowserProbeAttempt {
  observation: BrowserLiveObservation;
  accessBlocked: boolean;
}

const PROFILE_MARKERS = [
  "Local State",
  join("Default", "Preferences"),
  join("Default", "Cookies"),
  join("Default", "Network", "Cookies"),
  join("Default", "History"),
];

const VOLATILE_CHROME_PROFILE_NAMES = new Set([
  "DevToolsActivePort",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);

/** Authentication-bearing state needed for a live UI probe; caches are omitted. */
const PASSIVE_PROFILE_STATE_PATHS = [
  "Local State",
  join("Default", "Preferences"),
  join("Default", "Secure Preferences"),
  join("Default", "Cookies"),
  join("Default", "Cookies-journal"),
  join("Default", "Network", "Cookies"),
  join("Default", "Network", "Cookies-journal"),
  join("Default", "Local Storage"),
  join("Default", "Session Storage"),
  join("Default", "IndexedDB"),
  join("Default", "WebStorage"),
] as const;

/**
 * Chrome rewrites a user-data directory even when automation only reads a page.
 * Passive probes therefore launch against a short-lived profile snapshot, never
 * the operator's persistent profile. The snapshot is removed after each attempt.
 */
export async function createPassiveProfileSnapshot(
  sourceProfileDir: string,
): Promise<PassiveProfileSnapshot> {
  const root = await mkdtemp(join(tmpdir(), "publish-auth-probe-"));
  const profileDir = join(root, "profile");
  try {
    for (const relativePath of PASSIVE_PROFILE_STATE_PATHS) {
      const source = join(sourceProfileDir, relativePath);
      if (!existsSync(source)) continue;
      const destination = join(profileDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, {
        recursive: true,
        force: true,
        preserveTimestamps: true,
        filter: (candidate) =>
          !VOLATILE_CHROME_PROFILE_NAMES.has(basename(candidate)),
      });
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let cleaned = false;
  return {
    profileDir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}

function fileAgeDays(path: string, nowMs: number): number | undefined {
  try {
    return Math.max(0, (nowMs - statSync(path).mtimeMs) / 86_400_000);
  } catch {
    return undefined;
  }
}

/**
 * An empty directory (including one eagerly created by an older dataPaths()) is
 * NOT profile evidence. Require a non-empty Chrome persistence marker.
 */
export function hasMeaningfulProfileState(profileDir: string): boolean {
  if (!existsSync(profileDir)) return false;
  return PROFILE_MARKERS.some((relative) => {
    const path = join(profileDir, relative);
    try {
      return statSync(path).isFile() && statSync(path).size > 0;
    } catch {
      return false;
    }
  });
}

function newestMeaningfulProfileAge(profileDir: string, nowMs: number): number | undefined {
  const ages = PROFILE_MARKERS.map((relative) => fileAgeDays(join(profileDir, relative), nowMs)).filter(
    (age): age is number => age != null,
  );
  return ages.length ? Math.min(...ages) : undefined;
}

export function inspectBrowserLocalEvidence(
  config: Pick<PassiveBrowserProbeConfig, "profileDir" | "cookieCache" | "requiredCookieNames">,
  nowMs = Date.now(),
): BrowserLocalEvidence {
  const profilePresent = hasMeaningfulProfileState(config.profileDir);
  const cookieCachePresent = existsSync(config.cookieCache);
  let requiredCookiesPresent = false;
  let declaredExpired = false;

  if (cookieCachePresent) {
    try {
      const parsed = JSON.parse(readFileSync(config.cookieCache, "utf-8")) as CookieShape[];
      if (Array.isArray(parsed)) {
        const nowSeconds = nowMs / 1000;
        const byName = new Map(parsed.map((cookie) => [String(cookie.name ?? ""), cookie]));
        requiredCookiesPresent = config.requiredCookieNames.every((name) => byName.has(name));
        if (requiredCookiesPresent) {
          declaredExpired = config.requiredCookieNames.some((name) => {
            const expires = byName.get(name)?.expires;
            return typeof expires === "number" && expires > 0 && expires <= nowSeconds;
          });
        }
      }
    } catch {
      // A malformed cache is present but cannot be positive evidence.
    }
  }

  return {
    profilePresent,
    profileAgeDays: profilePresent ? newestMeaningfulProfileAge(config.profileDir, nowMs) : undefined,
    cookieCachePresent,
    cookieCacheAgeDays: cookieCachePresent ? fileAgeDays(config.cookieCache, nowMs) : undefined,
    requiredCookiesPresent,
    declaredExpired,
  };
}

function browserNextStep(
  config: PassiveBrowserProbeConfig,
  kind: "credentials" | "login" | "challenge",
): AuthNextStep {
  return {
    executor: kind === "credentials" || kind === "challenge" ? "human" : "agent",
    entryUrl: config.entryUrl,
    workflowRef: config.workflowRef,
    instruction:
      kind === "credentials"
        ? config.credentialsInstruction
        : kind === "challenge"
          ? config.challengeInstruction
          : config.loginInstruction,
    continueInSameContext: true,
  };
}

function missingRequiredCredentials(config: PassiveBrowserProbeConfig): boolean {
  return !config.credentialsConfigured && !config.manualLoginSupported;
}

export function evaluateBrowserReadiness(
  config: PassiveBrowserProbeConfig,
  local: BrowserLocalEvidence,
  live: BrowserLiveObservation,
  checkedAt = new Date().toISOString(),
): AuthReadiness {
  const common = {
    platform: config.platform,
    checkedAt,
    verificationMode: "passive_browser" as const,
    evidence: {
      ...local,
      credentialsConfigured: config.credentialsConfigured,
      liveProbe: live.kind,
      ...(live.note ? { note: live.note } : {}),
    },
    healed: [] as string[],
  };

  if (live.kind === "authenticated") {
    return { ...common, ready: true, status: "ready", requiresHuman: false };
  }
  if (live.kind === "logged_out") {
    const credentialsMissing = missingRequiredCredentials(config);
    return {
      ...common,
      ready: false,
      status: credentialsMissing ? "credentials_missing" : "login_required",
      requiresHuman: credentialsMissing || config.platform === "reddit",
      nextStep: browserNextStep(config, credentialsMissing ? "credentials" : "login"),
    };
  }
  if (live.kind === "challenge") {
    return {
      ...common,
      ready: false,
      status: "human_challenge_required",
      requiresHuman: true,
      nextStep: browserNextStep(config, "challenge"),
    };
  }
  if (live.kind === "network_error") {
    return {
      ...common,
      ready: false,
      status: "network_error",
      requiresHuman: false,
      nextStep: {
        executor: "agent",
        workflowRef: config.workflowRef,
        instruction: `Restore network/browser access to ${config.entryUrl}, then rerun publish auth check --platform ${config.platform}.`,
        continueInSameContext: false,
      },
    };
  }
  return {
    ...common,
    ready: false,
    status: "probe_inconclusive",
    requiresHuman: false,
    nextStep: {
      executor: "agent",
      entryUrl: config.entryUrl,
      workflowRef: config.workflowRef,
      instruction: `The passive ${config.platform} probe was inconclusive. ${config.loginInstruction}`,
      continueInSameContext: true,
    },
  };
}

/**
 * No meaningful persistent profile means there is no CLI browser session to
 * prove live. Return the binary non-ready recovery immediately instead of
 * launching Playwright, which would create a misleading durable profile tree.
 */
export function zeroStateBrowserReadiness(
  config: PassiveBrowserProbeConfig,
  local: BrowserLocalEvidence,
  checkedAt = new Date().toISOString(),
): AuthReadiness {
  const credentialsMissing = missingRequiredCredentials(config);
  return {
    platform: config.platform,
    ready: false,
    status: credentialsMissing ? "credentials_missing" : "login_required",
    checkedAt,
    verificationMode: "passive_browser",
    evidence: {
      ...local,
      credentialsConfigured: config.credentialsConfigured,
      liveProbe: "not_run",
      note: "No meaningful persistent browser profile exists. The live probe was skipped so auth check remains idempotent and does not create browser state.",
    },
    healed: [],
    requiresHuman: credentialsMissing || config.platform === "reddit",
    nextStep: browserNextStep(config, credentialsMissing ? "credentials" : "login"),
  };
}

export interface BrowserSignalPage {
  url(): string;
  locator(selector: string): {
    first(): { isVisible(): Promise<boolean> };
  };
  waitForTimeout(milliseconds: number): Promise<void>;
}

export interface BrowserSignalTiming {
  /** One shared budget for every selector group; it is never multiplied per selector. */
  budgetMs?: number;
  pollMs?: number;
  now?: () => number;
}

const DEFAULT_SIGNAL_BUDGET_MS = 5_000;
const DEFAULT_SIGNAL_POLL_MS = 100;

async function visibleSelectors(page: BrowserSignalPage, selectors: string[]): Promise<boolean> {
  const states = await Promise.all(
    selectors.map(async (selector) => {
      try {
        // isVisible is intentionally an immediate sample. Bounded waiting is
        // owned by waitForBrowserSignal's single deadline below.
        return await page.locator(selector).first().isVisible();
      } catch {
        return false;
      }
    }),
  );
  return states.some(Boolean);
}

/**
 * Poll positive page signals under one total deadline. Challenge signals have
 * precedence when a page exposes both a nominal authenticated surface and a
 * checkpoint overlay.
 */
export async function waitForBrowserSignal(
  page: BrowserSignalPage,
  config: PassiveBrowserProbeConfig,
  timing: BrowserSignalTiming = {},
): Promise<BrowserLiveObservation | undefined> {
  const now = timing.now ?? Date.now;
  const budgetMs = timing.budgetMs ?? DEFAULT_SIGNAL_BUDGET_MS;
  const pollMs = timing.pollMs ?? DEFAULT_SIGNAL_POLL_MS;
  const deadline = now() + Math.max(0, budgetMs);

  do {
    const url = page.url();
    if (
      config.challengeUrlPatterns.some((pattern) => pattern.test(url)) ||
      (await visibleSelectors(page, config.challengeSelectors))
    ) {
      return { kind: "challenge", note: "A known human verification or challenge surface is visible." };
    }
    if (await visibleSelectors(page, config.authenticatedSelectors)) return { kind: "authenticated" };
    if (
      config.loggedOutUrlPatterns.some((pattern) => pattern.test(url)) ||
      (await visibleSelectors(page, config.loggedOutSelectors))
    ) {
      return { kind: "logged_out" };
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(Math.max(1, pollMs), remaining));
  } while (now() <= deadline);

  return undefined;
}

const REDDIT_NETWORK_SECURITY_TEXT = "you've been blocked by network security";

/** Reddit serves this explicit 403 wall to headless Chrome on some networks. */
export function isKnownRedditAccessBlock(status: number, bodyText: string): boolean {
  return status === 403 && bodyText.toLowerCase().includes(REDDIT_NETWORK_SECURITY_TEXT);
}

/**
 * DOM markers are the fast path, but Reddit's same-origin account endpoint is a
 * second, independent auth signal when the shell markup drifts.
 */
export async function probeRedditApiSession(page: Page): Promise<BrowserLiveObservation | undefined> {
  try {
    const result = await page.evaluate(async () => {
      const response = await fetch("/api/me.json", { credentials: "include" });
      let parsed = false;
      let hasAccount = false;
      let accountAbsent = false;
      let authRejected = false;
      try {
        const value = (await response.json()) as unknown;
        parsed = true;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          const data = record.data;
          hasAccount =
            typeof data === "object" &&
            data !== null &&
            "name" in data &&
            typeof (data as { name?: unknown }).name === "string" &&
            (data as { name: string }).name.length > 0;

          // A structured 200 response with no account data is positive absence
          // evidence. Arbitrary parseable primitives or arrays are schema drift,
          // not proof that the user is logged out.
          accountAbsent =
            response.status === 200 &&
            !hasAccount &&
            (Object.keys(record).length === 0 ||
              ("data" in record &&
                (data == null ||
                  (typeof data === "object" && data !== null && !Array.isArray(data)))));

          // Reddit's JSON auth error envelope is `{ message, error }`. Status
          // alone is insufficient: opaque 401/403 responses are commonly WAF or
          // network-security walls and must never be reinterpreted as logout.
          const errorCode = record.error;
          const message = record.message;
          authRejected =
            (response.status === 401 || response.status === 403) &&
            errorCode === response.status &&
            typeof message === "string" &&
            /unauthorized|authentication required|login required|logged[ -]?out/i.test(message);
        }
      } catch {
        // The caller classifies non-JSON or unexpected responses below.
      }
      return { status: response.status, parsed, hasAccount, accountAbsent, authRejected };
    });

    if (result.status === 200 && result.hasAccount) {
      return {
        kind: "authenticated",
        note: "Reddit's account endpoint positively identified an authenticated session.",
      };
    }
    if (result.authRejected) {
      return {
        kind: "logged_out",
        note: `Reddit's account endpoint returned a structured authentication rejection (HTTP ${result.status}).`,
      };
    }
    if (result.accountAbsent) {
      return {
        kind: "logged_out",
        note: "Reddit's account endpoint returned no authenticated account.",
      };
    }
    if (result.status === 403 && !result.parsed) {
      return {
        kind: "network_error",
        note: "Reddit's account endpoint returned an opaque HTTP 403 access wall.",
      };
    }
    if (result.status >= 500) {
      return {
        kind: "network_error",
        note: `Reddit auth endpoint returned HTTP ${result.status}.`,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function launchPassiveContext(profileDir: string, headless: boolean): Promise<BrowserContext> {
  const launchOpts = {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  };
  try {
    return await chromium.launchPersistentContext(profileDir, {
      ...launchOpts,
      channel: "chrome",
    });
  } catch {
    return chromium.launchPersistentContext(profileDir, launchOpts);
  }
}

export class PlaywrightPassiveBrowserBackend implements BrowserProbeBackend {
  constructor(private readonly launchContext: PassiveContextLauncher = launchPassiveContext) {}

  private async probeOnce(
    config: PassiveBrowserProbeConfig,
    headless: boolean,
  ): Promise<BrowserProbeAttempt> {
    let context: BrowserContext | undefined;
    let snapshot: PassiveProfileSnapshot | undefined;
    try {
      try {
        snapshot = await createPassiveProfileSnapshot(config.profileDir);
        context = await this.launchContext(snapshot.profileDir, headless);
      } catch {
        return {
          accessBlocked: false,
          observation: {
            kind: "inconclusive",
            note: "Passive browser could not snapshot or launch the local profile. Check filesystem space and Chrome installation, then retry.",
          },
        };
      }

      const page = context.pages()[0] ?? (await context.newPage());
      let response;
      try {
        response = await page.goto(config.entryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (error) {
        return {
          accessBlocked: false,
          observation: { kind: "network_error", note: sanitizeError(error) },
        };
      }

      if (config.platform === "reddit") {
        const status = response?.status() ?? 0;
        const bodyText = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
        if (isKnownRedditAccessBlock(status, bodyText)) {
          return {
            accessBlocked: true,
            observation: {
              kind: "network_error",
              note: `Reddit blocked the ${headless ? "headless" : "headful"} browser probe with its network security wall (HTTP 403).`,
            },
          };
        }
      }

      const signal = await waitForBrowserSignal(page, config);
      if (signal) return { observation: signal, accessBlocked: false };

      if (config.platform === "reddit") {
        const apiSignal = await probeRedditApiSession(page);
        if (apiSignal) return { observation: apiSignal, accessBlocked: false };
      }

      return {
        accessBlocked: false,
        observation: {
          kind: "inconclusive",
          note: "No positive authenticated, logged-out, or challenge signal matched; selectors or page state may have drifted.",
        },
      };
    } finally {
      await context?.close().catch(() => {});
      await snapshot?.cleanup().catch(() => {});
    }
  }

  async probe(config: PassiveBrowserProbeConfig): Promise<BrowserLiveObservation> {
    const headless = await this.probeOnce(config, true);
    if (config.platform === "reddit" && headless.accessBlocked) {
      // Reddit commonly fingerprints headless Chrome and serves an explicit 403
      // wall. A one-shot headful retry is still passive: it never fills, clicks,
      // logs in, or opens a composer, and it closes after observing auth state.
      const retry = (await this.probeOnce(config, false)).observation;
      const retryNote =
        "Reddit blocked the headless probe with its network security wall; a passive headful retry completed the observation.";
      return {
        ...retry,
        note: retry.note ? `${retryNote} ${retry.note}` : retryNote,
      };
    }
    return headless.observation;
  }
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown browser error";
  return message.replace(/https?:\/\/[^\s]+/g, "[url]").slice(0, 240);
}

export async function probePassiveBrowserAuth(
  config: PassiveBrowserProbeConfig,
  backend: BrowserProbeBackend = new PlaywrightPassiveBrowserBackend(),
  nowMs = Date.now(),
): Promise<AuthReadiness> {
  const local = inspectBrowserLocalEvidence(config, nowMs);
  if (!local.profilePresent) {
    return zeroStateBrowserReadiness(config, local, new Date(nowMs).toISOString());
  }
  const live = await backend.probe(config);
  return evaluateBrowserReadiness(config, local, live, new Date(nowMs).toISOString());
}

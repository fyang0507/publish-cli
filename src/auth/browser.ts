import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
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
  workflowRef: string;
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

function browserNextStep(config: PassiveBrowserProbeConfig, challenge: boolean): AuthNextStep {
  return {
    executor: "agent_browser",
    entryUrl: config.entryUrl,
    workflowRef: config.workflowRef,
    instruction: challenge ? config.challengeInstruction : config.loginInstruction,
    continueInSameContext: true,
  };
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
      liveProbe: live.kind,
      ...(live.note ? { note: live.note } : {}),
    },
    healed: [] as string[],
  };

  if (live.kind === "authenticated") {
    return { ...common, ready: true, status: "ready", requiresHuman: false };
  }
  if (live.kind === "logged_out") {
    return {
      ...common,
      ready: false,
      status: "login_required",
      requiresHuman: true,
      nextStep: browserNextStep(config, false),
    };
  }
  if (live.kind === "challenge") {
    return {
      ...common,
      ready: false,
      status: "human_challenge_required",
      requiresHuman: true,
      nextStep: browserNextStep(config, true),
    };
  }
  if (live.kind === "network_error") {
    return {
      ...common,
      ready: false,
      status: "network_error",
      requiresHuman: false,
      nextStep: {
        executor: "operator",
        workflowRef: `${config.workflowRef}#probe-network`,
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
      executor: "agent_browser",
      entryUrl: config.entryUrl,
      workflowRef: `${config.workflowRef}#probe-inconclusive`,
      instruction: "Open the entry URL with a headful browser agent. Determine whether the page is authenticated, logged out, or challenged; do not infer logout from selector drift. If authenticated, continue the publishing workflow in that same browser context. Otherwise complete the returned login or human challenge before continuing.",
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
  return {
    platform: config.platform,
    ready: false,
    status: "login_required",
    checkedAt,
    verificationMode: "passive_browser",
    evidence: {
      ...local,
      liveProbe: "not_run",
      note: "No meaningful persistent browser profile exists. The live probe was skipped so auth check remains idempotent and does not create browser state.",
    },
    healed: [],
    requiresHuman: true,
    nextStep: browserNextStep(config, false),
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
      try {
        const value = (await response.json()) as unknown;
        parsed = true;
        if (typeof value === "object" && value !== null && "data" in value) {
          const data = (value as { data?: unknown }).data;
          hasAccount =
            typeof data === "object" &&
            data !== null &&
            "name" in data &&
            typeof (data as { name?: unknown }).name === "string" &&
            (data as { name: string }).name.length > 0;
        }
      } catch {
        // The caller classifies non-JSON or unexpected responses below.
      }
      return { status: response.status, parsed, hasAccount };
    });

    if (result.status === 200 && result.hasAccount) {
      return {
        kind: "authenticated",
        note: "Reddit's account endpoint positively identified an authenticated session.",
      };
    }
    if (result.status === 401 || result.status === 403) {
      return {
        kind: "logged_out",
        note: `Reddit's account endpoint rejected the session (HTTP ${result.status}).`,
      };
    }
    if (result.status === 200 && result.parsed) {
      return {
        kind: "logged_out",
        note: "Reddit's account endpoint returned no authenticated account.",
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
    try {
      try {
        context = await this.launchContext(config.profileDir, headless);
      } catch {
        return {
          accessBlocked: false,
          observation: {
            kind: "inconclusive",
            note: "Passive browser could not launch. Install Chrome or run npx playwright install chromium, then retry.",
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

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
      ...(live.kind === "challenge" || live.kind === "network_error" || live.kind === "inconclusive"
        ? { note: live.note }
        : {}),
    },
    healed: [] as string[],
  };

  if (live.kind === "authenticated") {
    return { ...common, status: "ready", requiresHuman: false };
  }
  if (live.kind === "logged_out") {
    return {
      ...common,
      status: "login_required",
      requiresHuman: true,
      nextStep: browserNextStep(config, false),
    };
  }
  if (live.kind === "challenge") {
    return {
      ...common,
      status: "human_challenge_required",
      requiresHuman: true,
      nextStep: browserNextStep(config, true),
    };
  }
  if (live.kind === "network_error") {
    return {
      ...common,
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
    status: "probe_inconclusive",
    requiresHuman: false,
    nextStep: {
      executor: "agent_browser",
      entryUrl: config.entryUrl,
      workflowRef: `${config.workflowRef}#probe-inconclusive`,
      instruction: "Inspect the visible page using the browser agent; do not infer logout from a missing selector. Verify an authenticated, logged-out, or challenge state and continue in that browser context.",
      continueInSameContext: true,
    },
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

export class PlaywrightPassiveBrowserBackend implements BrowserProbeBackend {
  async probe(config: PassiveBrowserProbeConfig): Promise<BrowserLiveObservation> {
    let context: BrowserContext | undefined;
    try {
      const launchOpts = {
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: ["--disable-blink-features=AutomationControlled"],
      };
      try {
        context = await chromium.launchPersistentContext(config.profileDir, {
          ...launchOpts,
          channel: "chrome",
        });
      } catch {
        try {
          context = await chromium.launchPersistentContext(config.profileDir, launchOpts);
        } catch {
          return {
            kind: "inconclusive",
            note: "Passive browser could not launch. Install Chrome or run npx playwright install chromium, then retry.",
          };
        }
      }

      const page = context.pages()[0] ?? (await context.newPage());
      try {
        await page.goto(config.entryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (error) {
        return { kind: "network_error", note: sanitizeError(error) };
      }

      const signal = await waitForBrowserSignal(page, config);
      if (signal) return signal;
      return {
        kind: "inconclusive",
        note: "No positive authenticated, logged-out, or challenge signal matched; selectors or page state may have drifted.",
      };
    } finally {
      await context?.close().catch(() => {});
    }
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
  // Measure first: launchPersistentContext may create/populate the directory.
  const local = inspectBrowserLocalEvidence(config, nowMs);
  const live = await backend.probe(config);
  return evaluateBrowserReadiness(config, local, live, new Date(nowMs).toISOString());
}

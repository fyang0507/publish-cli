import { env, peekDataPaths } from "../config.js";
import {
  ONEPOINT3ACRES_ENTRY_URL,
  XHS_ENTRY_URL,
} from "../capabilities/workflows.js";
import { LI_LOGIN_SELECTORS } from "../linkedin/session.js";
import { REDDIT_LOGIN_SELECTORS } from "../reddit/session.js";
import { X_SELECTORS } from "../session.js";
import {
  probePassiveBrowserAuth,
  type BrowserProbeBackend,
  type PassiveBrowserProbeConfig,
} from "./browser.js";
import { probeWechatAuth, type WeChatAuthDependencies } from "./wechat.js";
import {
  AUTH_PLATFORMS,
  type AuthPlatform,
  type AuthReadiness,
} from "./types.js";

export interface AuthProbeDependencies {
  browserBackend?: BrowserProbeBackend;
  wechat?: Partial<WeChatAuthDependencies>;
  now?: () => number;
  /** Deterministic test/integration seam; production callers normally omit it. */
  probeOverrides?: Partial<Record<AuthPlatform, AuthProbe>>;
}

export type AuthProbe = () => Promise<AuthReadiness>;
export type AuthProbeRegistry = Record<AuthPlatform, AuthProbe>;

function externallyOwnedDescriptor(
  platform: Extract<AuthPlatform, "xhs" | "1point3acres">,
  nowMs: number,
): AuthReadiness {
  const isXhs = platform === "xhs";
  return {
    platform,
    ready: false,
    status: isXhs ? "agent_check_required" : "human_login_required",
    checkedAt: new Date(nowMs).toISOString(),
    verificationMode: isXhs ? "browser_agent" : "human_handoff",
    evidence: {
      liveProbe: "not_run",
      note: isXhs
        ? "This channel's authenticated browser context is owned by the browser agent, not publish-cli."
        : "publish-cli does not access this website; the human performs login, then the browser agent owns drafting and composer verification.",
    },
    healed: [],
    requiresHuman: !isXhs,
    nextStep: {
      executor: isXhs ? "agent_browser" : "human",
      entryUrl: isXhs ? XHS_ENTRY_URL : ONEPOINT3ACRES_ENTRY_URL,
      instruction: isXhs
        ? "Open the creator portal with the browser agent, let the human scan the QR code if required, positively verify the authenticated creator UI, and continue in that same browser context."
        : "Have the human open and log in to 1point3acres in a browser the agent can control. Then hand that same context to the agent to draft, save, and reopen the post; return to the human for review and any publish decision.",
      continueInSameContext: true,
    },
  };
}

function browserConfigs(): Record<"x" | "linkedin" | "reddit", PassiveBrowserProbeConfig> {
  const paths = peekDataPaths();
  return {
    x: {
      platform: "x",
      profileDir: paths.xProfileDir,
      cookieCache: paths.xCookieCache,
      requiredCookieNames: ["auth_token", "ct0"],
      entryUrl: X_SELECTORS.homeUrl,
      authenticatedSelectors: [...X_SELECTORS.loggedInSignal],
      loggedOutSelectors: [
        'input[autocomplete*="username"]:visible',
        'a[href="/login"]:visible',
      ],
      challengeSelectors: [
        'input[data-testid="ocfEnterTextTextInput"]:visible',
        'iframe[src*="challenge"]:visible',
      ],
      loggedOutUrlPatterns: [/\/login(?:$|[/?#])/, /\/i\/flow\/login/],
      challengeUrlPatterns: [/challenge/i, /account\/access/i],
      credentialsConfigured: !!env.X_USERNAME && !!env.X_PASSWORD && !!env.X_EMAIL,
      manualLoginSupported: false,
      workflowRef: "publish x --help",
      credentialsInstruction: "Have the human provision X_USERNAME, X_PASSWORD, and X_EMAIL in .env. Then the agent runs its intended authenticated X action with --inspect; do not stage a draft merely to authenticate a read/list action.",
      loginInstruction: "Run the intended authenticated X action with --inspect (create-watch-list, watch, draft, reply, or history), which opens the CLI-owned profile. Let that same command continue after login.",
      challengeInstruction: "Run the intended authenticated X action with --inspect in the CLI-owned profile. Have the human complete the visible identity, CAPTCHA, 2FA, or checkpoint step, verify Home, and let the same command continue.",
    },
    linkedin: {
      platform: "linkedin",
      profileDir: paths.liProfileDir,
      cookieCache: paths.liCookieCache,
      requiredCookieNames: ["li_at"],
      entryUrl: LI_LOGIN_SELECTORS.homeUrl,
      authenticatedSelectors: [...LI_LOGIN_SELECTORS.loggedInSignal],
      loggedOutSelectors: [
        'input[autocomplete*="username"]:visible',
        'input[name="session_key"]:visible',
      ],
      challengeSelectors: [
        'iframe[src*="captcha"]:visible',
        'input[name="pin"]:visible',
        'input[name="email-address"]:visible',
      ],
      loggedOutUrlPatterns: [/\/login(?:$|[/?#])/, /\/uas\/login/],
      challengeUrlPatterns: [/\/checkpoint\//, /challenge/i],
      credentialsConfigured: !!env.LI_USERNAME && !!env.LI_PASSWORD && !!env.LI_EMAIL,
      manualLoginSupported: false,
      workflowRef: "publish linkedin draft --help",
      credentialsInstruction: "Have the human provision LI_USERNAME, LI_PASSWORD, and LI_EMAIL in .env. Then the agent runs the intended publish linkedin draft ... --inspect command.",
      loginInstruction: "Run the intended publish linkedin draft ... --inspect command, which opens the CLI-owned profile. Have the human complete login there, verify the feed, and let the same command continue.",
      challengeInstruction: "Run the intended LinkedIn draft with --inspect in the CLI-owned profile. Have the human complete the visible CAPTCHA, 2FA, identity, or device checkpoint, verify the feed, and let the same command continue.",
    },
    reddit: {
      platform: "reddit",
      profileDir: paths.redditProfileDir,
      cookieCache: paths.redditCookieCache,
      requiredCookieNames: ["reddit_session"],
      entryUrl: REDDIT_LOGIN_SELECTORS.homeUrl,
      authenticatedSelectors: [...REDDIT_LOGIN_SELECTORS.loggedInSignal],
      loggedOutSelectors: [
        'shreddit-app[user-logged-in="false"]',
        'input[name="username"]:visible',
      ],
      challengeSelectors: [
        'iframe[src*="captcha"]:visible',
        'iframe[src*="challenge"]:visible',
        'input[name="captcha"]:visible',
      ],
      loggedOutUrlPatterns: [/\/login(?:$|[/?#])/],
      challengeUrlPatterns: [/js_challenge=1/, /challenge/i],
      credentialsConfigured: !!env.REDDIT_USERNAME && !!env.REDDIT_PASSWORD,
      manualLoginSupported: true,
      workflowRef: "publish reddit draft --help",
      credentialsInstruction: "Set REDDIT_USERNAME and REDDIT_PASSWORD in .env, or enter them manually in the visible browser opened by the intended publish reddit draft ... --inspect command.",
      loginInstruction: "Run the intended publish reddit draft ... --inspect command, which opens the CLI-owned profile. Configured credentials are auto-filled; if absent, the human may enter them manually and solve CAPTCHA in that visible window. Verify the user menu and let the same command continue.",
      challengeInstruction: "Run the intended Reddit draft with --inspect in the CLI-owned profile. Have the human solve the CAPTCHA or identity challenge, verify the user menu, and let the same command continue.",
    },
  };
}

/**
 * Shared probe registry. Future `publish <channel> info` implementations must
 * call this registry (via probeAuth/probeAuthPlatforms) rather than inventing a
 * second auth model. Issue #32 owns wiring the returned readiness into info.
 */
export function createAuthProbeRegistry(deps: AuthProbeDependencies = {}): AuthProbeRegistry {
  const configs = browserConfigs();
  const now = deps.now ?? Date.now;
  const registry: AuthProbeRegistry = {
    x: () => probePassiveBrowserAuth(configs.x, deps.browserBackend, now()),
    linkedin: () => probePassiveBrowserAuth(configs.linkedin, deps.browserBackend, now()),
    reddit: () => probePassiveBrowserAuth(configs.reddit, deps.browserBackend, now()),
    wechat: () => probeWechatAuth({ ...deps.wechat, now }),
    xhs: async () => externallyOwnedDescriptor("xhs", now()),
    "1point3acres": async () => externallyOwnedDescriptor("1point3acres", now()),
  };
  return { ...registry, ...deps.probeOverrides };
}

function failureNextStep(platform: AuthPlatform, status: "network_error" | "probe_inconclusive") {
  const browserOwned = platform === "xhs";
  const humanHandoff = platform === "1point3acres";
  const workflowRef =
    platform === "x"
      ? "publish x --help"
      : platform === "linkedin"
        ? "publish linkedin draft --help"
        : platform === "reddit"
          ? "publish reddit draft --help"
          : platform === "wechat"
            ? "publish wechat check --help"
            : undefined;
  return {
    executor: browserOwned ? ("agent_browser" as const) : humanHandoff ? ("human" as const) : ("agent" as const),
    ...(workflowRef ? { workflowRef } : {}),
    instruction:
      status === "network_error"
        ? `Restore network access for ${platform}, then rerun publish auth check --platform ${platform}.`
        : humanHandoff
          ? "Have the human log in to 1point3acres in a controllable browser, then let the agent inspect the composer, draft, save, and reopen the post in that same context."
        : `Inspect the ${platform} authentication workflow without exposing credentials, then rerun publish auth check --platform ${platform}; do not infer readiness from local state alone.`,
    continueInSameContext: browserOwned || humanHandoff,
  };
}

/** Convert an unexpected implementation rejection into a stable, sanitized receipt. */
export function unexpectedProbeReadiness(
  platform: AuthPlatform,
  error: unknown,
  nowMs = Date.now(),
): AuthReadiness {
  const network = error instanceof Error && /connect|network|socket|timeout|dns|proxy|tunnel/i.test(error.message);
  const status = network ? "network_error" : "probe_inconclusive";
  return {
    platform,
    ready: false,
    status,
    checkedAt: new Date(nowMs).toISOString(),
    verificationMode:
      platform === "wechat" ? "api" : platform === "xhs" ? "browser_agent" : platform === "1point3acres" ? "human_handoff" : "passive_browser",
    evidence: {
      liveProbe: network ? "network_error" : "inconclusive",
      note: network
        ? "Authentication probe failed because its network transport was unavailable."
        : "Authentication probe failed without a classifiable sanitized result.",
    },
    healed: [],
    requiresHuman: false,
    nextStep: failureNextStep(platform, status),
  };
}

async function runProbeSafely(
  platform: AuthPlatform,
  probe: AuthProbe,
  now: () => number,
): Promise<AuthReadiness> {
  try {
    return await probe();
  } catch (error) {
    return unexpectedProbeReadiness(platform, error, now());
  }
}

export async function probeAuth(
  platform: AuthPlatform,
  deps: AuthProbeDependencies = {},
): Promise<AuthReadiness> {
  const now = deps.now ?? Date.now;
  try {
    const registry = createAuthProbeRegistry(deps);
    return await runProbeSafely(platform, registry[platform], now);
  } catch (error) {
    return unexpectedProbeReadiness(platform, error, now());
  }
}

export async function probeAuthPlatforms(
  platforms: AuthPlatform[],
  deps: AuthProbeDependencies = {},
): Promise<AuthReadiness[]> {
  const now = deps.now ?? Date.now;
  let registry: AuthProbeRegistry;
  try {
    registry = createAuthProbeRegistry(deps);
  } catch (error) {
    return platforms.map((platform) => unexpectedProbeReadiness(platform, error, now()));
  }
  return Promise.all(platforms.map((platform) => runProbeSafely(platform, registry[platform], now)));
}

export { AUTH_PLATFORMS };

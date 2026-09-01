import { peekDataPaths } from "../config.js";
import {
  ONEPOINT3ACRES_ENTRY_URL,
  ONEPOINT3ACRES_CAPABILITY_WORKFLOW_REF,
  XHS_ENTRY_URL,
  XHS_CAPABILITY_WORKFLOW_REF,
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

function agentOwnedDescriptor(
  platform: Extract<AuthPlatform, "xhs" | "1point3acres">,
  nowMs: number,
): AuthReadiness {
  const isXhs = platform === "xhs";
  return {
    platform,
    ready: false,
    status: "agent_check_required",
    checkedAt: new Date(nowMs).toISOString(),
    verificationMode: "browser_agent",
    evidence: {
      liveProbe: "not_run",
      note: "This channel's authenticated browser context is owned by the browser agent, not publish-cli.",
    },
    healed: [],
    requiresHuman: true,
    nextStep: {
      executor: "agent_browser",
      entryUrl: isXhs ? XHS_ENTRY_URL : ONEPOINT3ACRES_ENTRY_URL,
      workflowRef: isXhs ? XHS_CAPABILITY_WORKFLOW_REF : ONEPOINT3ACRES_CAPABILITY_WORKFLOW_REF,
      instruction: isXhs
        ? "Open the creator portal with the browser agent, let the operator scan the QR code if required, positively verify the authenticated creator UI, and continue in that same browser context."
        : "Open 1point3acres with the browser agent, complete any permitted human login or challenge, positively verify the authenticated state, and continue in that same browser context.",
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
      workflowRef: "x#authentication",
      loginInstruction: "Complete X login in the browser context that will continue the publishing workflow; positively verify the authenticated Home UI before continuing.",
      challengeInstruction: "Complete the visible X identity, CAPTCHA, 2FA, or checkpoint step with the operator; positively verify Home and continue in the same browser context.",
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
      workflowRef: "linkedin#authentication",
      loginInstruction: "Complete LinkedIn login in the browser context that will continue the publishing workflow; positively verify the authenticated feed before continuing.",
      challengeInstruction: "Complete the visible LinkedIn CAPTCHA, 2FA, identity, or device checkpoint with the operator; positively verify the feed and continue in the same browser context.",
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
      workflowRef: "reddit#authentication",
      loginInstruction: "Complete Reddit login in the browser context that will continue the publishing workflow; solve any CAPTCHA with the operator and positively verify the authenticated user menu.",
      challengeInstruction: "Let the operator solve Reddit's CAPTCHA or identity challenge; positively verify the authenticated user menu and continue in the same browser context.",
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
    xhs: async () => agentOwnedDescriptor("xhs", now()),
    "1point3acres": async () => agentOwnedDescriptor("1point3acres", now()),
  };
  return { ...registry, ...deps.probeOverrides };
}

function failureNextStep(platform: AuthPlatform, status: "network_error" | "probe_inconclusive") {
  const browserOwned = platform === "xhs" || platform === "1point3acres";
  return {
    executor: browserOwned ? ("agent_browser" as const) : ("operator" as const),
    workflowRef: `${platform}#auth-probe-${status === "network_error" ? "network" : "inconclusive"}`,
    instruction:
      status === "network_error"
        ? `Restore network access for ${platform}, then rerun publish auth check --platform ${platform}.`
        : `Inspect the ${platform} authentication workflow without exposing credentials, then rerun publish auth check --platform ${platform}; do not infer readiness from local state alone.`,
    continueInSameContext: browserOwned,
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
      platform === "wechat" ? "api" : platform === "xhs" || platform === "1point3acres" ? "browser_agent" : "passive_browser",
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

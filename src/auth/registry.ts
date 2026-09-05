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
  AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION,
  type AuthNextStep,
  type AuthPlatform,
  type AuthReadiness,
} from "./types.js";

const XHS_INFO_WORKFLOW_REF = "publish xhs info --static";
const ONEPOINT3ACRES_INFO_WORKFLOW_REF =
  "publish 1point3acres info --static";

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
        : "publish-cli does not access this website. The human always performs login; afterward, a browser/computer-use agent may continue in the same context only when automation is available and the user has explicitly authorized it, otherwise the human follows the info guidance to fill, save, reopen, and verify.",
    },
    healed: [],
    requiresHuman: !isXhs,
    nextStep: {
      executor: isXhs ? "agent_browser" : "human",
      recoveryContext: isXhs
        ? {
            schemaVersion: AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION,
            venue: "agent_owned_browser",
            owner: "agent_browser",
            launch: "entry_url",
          }
        : {
            schemaVersion: AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION,
            venue: "human_owned_handoff",
            owner: "human",
            launch: "entry_url",
          },
      entryUrl: isXhs ? XHS_ENTRY_URL : ONEPOINT3ACRES_ENTRY_URL,
      workflowRef: isXhs
        ? XHS_INFO_WORKFLOW_REF
        : ONEPOINT3ACRES_INFO_WORKFLOW_REF,
      instruction: isXhs
        ? "Open the creator portal with the browser agent, let the human scan the QR code if required, positively verify the authenticated creator UI, and continue in that same browser context."
        : "Have the human open and log in to 1point3acres, preserving that browser context. After login, a browser/computer-use agent may follow publish 1point3acres info there only when automation is available and the user has explicitly authorized it; otherwise the human follows the same guidance to fill, save, reopen, and verify. The human retains every publish decision.",
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

interface FailureRecovery {
  nextStep: AuthNextStep;
  requiresHuman: boolean;
}

function failureNextStep(
  platform: AuthPlatform,
  status: "network_error" | "probe_inconclusive",
): FailureRecovery {
  if (platform === "xhs") {
    return {
      requiresHuman: false,
      nextStep: {
        executor: "agent_browser",
        recoveryContext: {
          schemaVersion: AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION,
          venue: "agent_owned_browser",
          owner: "agent_browser",
          launch: "entry_url",
        },
        entryUrl: XHS_ENTRY_URL,
        workflowRef: XHS_INFO_WORKFLOW_REF,
        instruction:
          status === "network_error"
            ? "Restore browser-agent network access, then open the Xiaohongshu creator portal and follow the static channel info in that same agent-owned browser context."
            : "Open the Xiaohongshu creator portal in the agent-owned browser, positively verify its authenticated creator UI, and follow the static channel info in that same context without inferring readiness from local state.",
        continueInSameContext: true,
      },
    };
  }

  if (platform === "1point3acres") {
    return {
      requiresHuman: true,
      nextStep: {
        executor: "human",
        recoveryContext: {
          schemaVersion: AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION,
          venue: "human_owned_handoff",
          owner: "human",
          launch: "entry_url",
        },
        entryUrl: ONEPOINT3ACRES_ENTRY_URL,
        workflowRef: ONEPOINT3ACRES_INFO_WORKFLOW_REF,
        instruction:
          status === "network_error"
            ? "Have the human restore access to 1point3acres and open the known entry page in the human-owned browser, then follow the static channel info while preserving that context."
            : "Have the human open and log in to 1point3acres in the human-owned browser, then follow the static channel info while preserving that context; do not infer readiness from another browser.",
        continueInSameContext: true,
      },
    };
  }

  const workflowRef =
    platform === "x"
      ? "publish x --help"
      : platform === "linkedin"
        ? "publish linkedin draft --help"
        : platform === "reddit"
          ? "publish reddit draft --help"
          : "publish wechat check --help";
  if (status === "network_error" || platform === "wechat") {
    return {
      requiresHuman: false,
      nextStep: {
        executor: "agent",
        recoveryContext: {
          schemaVersion: AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION,
          venue: "local_runtime",
          owner: "agent",
          launch: "workflow_ref",
        },
        workflowRef,
        instruction:
          status === "network_error"
            ? `Restore network access for ${platform}, then rerun publish auth check --platform ${platform}.`
            : "Inspect the sanitized WeChat probe and egress configuration, then rerun publish auth check --platform wechat; do not infer readiness without authenticated API success.",
        continueInSameContext: false,
      },
    };
  }

  const entryUrl =
    platform === "x"
      ? X_SELECTORS.homeUrl
      : platform === "linkedin"
        ? LI_LOGIN_SELECTORS.homeUrl
        : REDDIT_LOGIN_SELECTORS.homeUrl;
  return {
    requiresHuman: false,
    nextStep: {
      executor: "agent",
      recoveryContext: {
        schemaVersion: AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION,
        venue: "cli_owned_persistent_profile",
        owner: "publish_cli",
        launch: "intended_cli_action_with_inspect",
      },
      entryUrl,
      workflowRef,
      instruction: `Launch the intended authenticated ${platform} CLI action with --inspect so recovery occurs in its CLI-owned persistent profile; do not open the entry URL in an unrelated browser or infer readiness from local state alone.`,
      continueInSameContext: true,
    },
  };
}

/** Convert an unexpected implementation rejection into a stable, sanitized receipt. */
export function unexpectedProbeReadiness(
  platform: AuthPlatform,
  error: unknown,
  nowMs = Date.now(),
): AuthReadiness {
  const network = isNetworkLike(error);
  const status = network ? "network_error" : "probe_inconclusive";
  const recovery = failureNextStep(platform, status);
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
    requiresHuman: recovery.requiresHuman,
    nextStep: recovery.nextStep,
  };
}

function isNetworkLike(error: unknown): boolean {
  try {
    const message = error instanceof Error ? error.message : undefined;
    return typeof message === "string" &&
      /connect|network|socket|timeout|dns|proxy|tunnel/i.test(message);
  } catch {
    return false;
  }
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

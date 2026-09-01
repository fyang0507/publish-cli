import { env } from "../config.js";
import {
  createWeChatClient,
  inspectTokenCache,
  type CheckResult,
  type TokenCacheEvidence,
  type WeChatClient,
} from "../wechat/client.js";
import type { AuthNextStep, AuthReadiness } from "./types.js";

export interface WeChatAuthDependencies {
  credentialsConfigured(): boolean;
  inspectTokenCache(): TokenCacheEvidence;
  createClient(): Promise<Pick<WeChatClient, "checkAccess" | "close">>;
  now(): number;
}

const DEFAULT_DEPS: WeChatAuthDependencies = {
  credentialsConfigured: () => !!env.WECHAT_APP_ID && !!env.WECHAT_APP_SECRET,
  inspectTokenCache,
  createClient: createWeChatClient,
  now: Date.now,
};

function nextStep(
  status: AuthReadiness["status"],
  result?: CheckResult,
): AuthNextStep {
  if (status === "credentials_missing" || status === "credentials_rejected") {
    return {
      executor: "operator",
      workflowRef: "wechat#credentials",
      instruction: "Set valid WECHAT_APP_ID and WECHAT_APP_SECRET in .env, then run publish auth check --platform wechat.",
      continueInSameContext: false,
    };
  }
  if (status === "ip_not_allowlisted") {
    const ip = result && !result.ok ? result.egressIp : undefined;
    return {
      executor: "human",
      entryUrl: "https://developers.weixin.qq.com/platform/",
      workflowRef: "wechat#ip-allowlist",
      instruction: `Add the observed egress IP${ip ? ` ${ip}` : ""} to IP白名单 and approve with the admin WeChat QR scan; then rerun publish auth check --platform wechat.`,
      continueInSameContext: false,
    };
  }
  if (status === "network_error") {
    return {
      executor: "operator",
      workflowRef: "wechat#egress",
      instruction: "Restore the configured proxy/SSH/direct egress to api.weixin.qq.com, then rerun publish auth check --platform wechat.",
      continueInSameContext: false,
    };
  }
  return {
    executor: "operator",
    workflowRef: "wechat#probe-inconclusive",
    instruction: "Inspect the sanitized WeChat probe stage and egress configuration, then rerun publish auth check --platform wechat; do not assume readiness without an authenticated API success.",
    continueInSameContext: false,
  };
}

export async function probeWechatAuth(
  overrides: Partial<WeChatAuthDependencies> = {},
): Promise<AuthReadiness> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const now = deps.now();
  const checkedAt = new Date(now).toISOString();
  const credentialsConfigured = deps.credentialsConfigured();
  const tokenBefore = deps.inspectTokenCache();
  const evidence = {
    credentialsConfigured,
    tokenCachePresent: tokenBefore.present,
    tokenCacheExpired: tokenBefore.expired,
    liveProbe: "not_run" as const,
  };

  if (!credentialsConfigured) {
    return {
      platform: "wechat",
      status: "credentials_missing",
      checkedAt,
      verificationMode: "api",
      evidence,
      healed: [],
      requiresHuman: false,
      nextStep: nextStep("credentials_missing"),
    };
  }

  let client: Pick<WeChatClient, "checkAccess" | "close">;
  try {
    client = await deps.createClient();
  } catch (error) {
    const status = isNetworkLike(error) ? "network_error" : "probe_inconclusive";
    return {
      platform: "wechat",
      status,
      checkedAt,
      verificationMode: "api",
      evidence: {
        ...evidence,
        liveProbe: status === "network_error" ? "network_error" : "inconclusive",
        note: "Could not initialize the configured egress.",
      },
      healed: [],
      requiresHuman: false,
      nextStep: nextStep(status),
    };
  }

  let readiness: AuthReadiness;
  try {
    const result = await client.checkAccess();
    const healed = result.tokenRefreshed ? ["token_refreshed"] : [];
    const base = {
      platform: "wechat" as const,
      checkedAt,
      verificationMode: "api" as const,
      evidence: {
        credentialsConfigured,
        tokenCachePresent: result.tokenCacheBeforeCheck?.present ?? tokenBefore.present,
        tokenCacheExpired: result.tokenCacheBeforeCheck?.expired ?? tokenBefore.expired,
        liveProbe: result.ok ? ("api_authenticated" as const) : ("inconclusive" as const),
        ...(!result.ok && result.errmsg ? { note: sanitizeApiNote(result) } : {}),
      },
      healed,
    };
    if (result.ok) {
      readiness = { ...base, status: "ready", requiresHuman: false };
    } else {
      const status: AuthReadiness["status"] =
        result.stage === "credentials"
          ? result.errcode
            ? "credentials_rejected"
            : "credentials_missing"
          : result.stage === "ip"
            ? "ip_not_allowlisted"
            : result.stage === "network"
              ? "network_error"
              : "probe_inconclusive";
      readiness = {
        ...base,
        status,
        evidence: {
          ...base.evidence,
          liveProbe: status === "network_error" ? "network_error" : "inconclusive",
        },
        requiresHuman: status === "ip_not_allowlisted",
        nextStep: nextStep(status, result),
      };
    }
  } catch (error) {
    const status: AuthReadiness["status"] = isNetworkLike(error) ? "network_error" : "probe_inconclusive";
    readiness = {
      platform: "wechat",
      status,
      checkedAt,
      verificationMode: "api",
      evidence: {
        ...evidence,
        liveProbe: status === "network_error" ? "network_error" : "inconclusive",
        note:
          status === "network_error"
            ? "Network or egress connection failed during the authenticated API probe."
            : "WeChat API probe failed without a classifiable sanitized result.",
      },
      healed: [],
      requiresHuman: false,
      nextStep: nextStep(status),
    };
  }

  // Cleanup is best-effort. A close failure must never erase a completed,
  // sanitized readiness receipt or leak the underlying transport error.
  try {
    await client.close();
  } catch {
    // Deliberately preserve the completed receipt.
  }
  return readiness;
}

function sanitizeApiNote(result: Exclude<CheckResult, { ok: true }>): string {
  if (result.stage === "ip") return "WeChat rejected the configured egress IP (40164).";
  if (result.stage === "credentials") return "WeChat rejected the configured App ID or App Secret.";
  if (result.stage === "network") return "Network or egress connection failed.";
  if (result.stage === "token") return `WeChat token exchange failed${result.errcode ? ` (errcode ${result.errcode})` : ""}.`;
  return "WeChat API probe was inconclusive.";
}

function isNetworkLike(error: unknown): boolean {
  return error instanceof Error && /connect|network|socket|timeout|dns|proxy|tunnel/i.test(error.message);
}

export const AUTH_PLATFORMS = [
  "x",
  "linkedin",
  "reddit",
  "wechat",
  "xhs",
  "1point3acres",
] as const;

export type AuthPlatform = (typeof AUTH_PLATFORMS)[number];

export type AuthStatus =
  | "ready"
  | "agent_check_required"
  | "login_required"
  | "human_challenge_required"
  | "credentials_missing"
  | "credentials_rejected"
  | "ip_not_allowlisted"
  | "network_error"
  | "probe_inconclusive";

export type LiveProbeEvidence =
  | "authenticated"
  | "logged_out"
  | "challenge"
  | "api_authenticated"
  | "network_error"
  | "inconclusive"
  | "not_run";

/** Sanitized evidence only. Cookie/token values and page content never belong here. */
export interface AuthEvidence {
  profilePresent?: boolean;
  profileAgeDays?: number;
  cookieCachePresent?: boolean;
  cookieCacheAgeDays?: number;
  requiredCookiesPresent?: boolean;
  declaredExpired?: boolean;
  credentialsConfigured?: boolean;
  tokenCachePresent?: boolean;
  tokenCacheExpired?: boolean;
  liveProbe: LiveProbeEvidence;
  note?: string;
}

export interface AuthNextStep {
  executor: "agent_browser" | "human" | "operator";
  entryUrl?: string;
  workflowRef: string;
  instruction: string;
  continueInSameContext: boolean;
}

export interface AuthReadiness {
  platform: AuthPlatform;
  /** Binary workflow gate. `status` explains why a false result is not ready. */
  ready: boolean;
  status: AuthStatus;
  checkedAt: string;
  verificationMode: "passive_browser" | "api" | "browser_agent";
  evidence: AuthEvidence;
  healed: string[];
  requiresHuman: boolean;
  nextStep?: AuthNextStep;
}

export type BrowserLiveObservation =
  | { kind: "authenticated"; note?: string }
  | { kind: "logged_out"; note?: string }
  | { kind: "challenge"; note?: string }
  | { kind: "network_error"; note: string }
  | { kind: "inconclusive"; note: string };

export interface BrowserLocalEvidence {
  profilePresent: boolean;
  profileAgeDays?: number;
  cookieCachePresent: boolean;
  cookieCacheAgeDays?: number;
  requiredCookiesPresent: boolean;
  declaredExpired: boolean;
}

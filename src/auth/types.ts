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
  | "human_login_required"
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

export const AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION =
  "publish.auth-recovery-context/v1" as const;

export type AuthRecoveryContext =
  | {
      schemaVersion: typeof AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION;
      venue: "cli_owned_persistent_profile";
      owner: "publish_cli";
      launch: "intended_cli_action_with_inspect";
    }
  | {
      schemaVersion: typeof AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION;
      venue: "agent_owned_browser";
      owner: "agent_browser";
      launch: "entry_url";
    }
  | {
      schemaVersion: typeof AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION;
      venue: "human_owned_handoff";
      owner: "human";
      launch: "entry_url";
    }
  | {
      schemaVersion: typeof AUTH_RECOVERY_CONTEXT_SCHEMA_VERSION;
      venue: "local_runtime";
      owner: "agent";
      launch: "workflow_ref";
    };

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
  /** Role that owns and initiates the immediate next step. */
  executor: "agent" | "agent_browser" | "human";
  /** Versioned venue ownership; `entryUrl` never overrides this launch boundary. */
  recoveryContext: AuthRecoveryContext;
  entryUrl?: string;
  /** Optional separately discoverable help command. Omit when this info response is the complete workflow. */
  workflowRef?: string;
  instruction: string;
  continueInSameContext: boolean;
}

export interface AuthReadiness {
  platform: AuthPlatform;
  /** Binary workflow gate. `status` explains why a false result is not ready. */
  ready: boolean;
  status: AuthStatus;
  checkedAt: string;
  verificationMode: "passive_browser" | "api" | "browser_agent" | "human_handoff";
  evidence: AuthEvidence;
  healed: string[];
  /** True only when the immediate next step cannot complete without human participation. */
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

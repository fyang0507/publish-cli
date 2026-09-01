import type { AuthPlatform, AuthReadiness } from "../auth/types.js";

export const CHANNEL_CAPABILITY_SCHEMA_VERSION = "publish.channel-capabilities/v1" as const;
export const CHANNEL_INFO_SCHEMA_VERSION = "publish.channel-info/v1" as const;

export type EvidenceKind =
  | "implementation_contract"
  | "official_documentation"
  | "live_positive_fixture"
  | "read_only_api"
  | "unknown";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface CapabilityEvidence extends JsonObject {
  kind: EvidenceKind;
  source: string;
  lastVerified: string;
}

/**
 * A single capability claim. Limits and other drift-prone facts use this wrapper
 * so documented values, live observations, lower bounds, and null unknowns never
 * collapse into an inferred maximum.
 */
export interface CapabilityFact<T extends JsonValue = JsonValue> extends JsonObject {
  value: T;
  evidence: CapabilityEvidence;
}

export type ExecutionMode = "cli_transport" | "agent_browser" | "human_handoff";
export type TransportSupport = "supported" | "agent_operated" | "manual_handoff_only";
export type WorkflowActor = "agent" | "cli" | "human" | "platform";
export type CapabilityDisposition = "intentionally_excluded" | "deferred" | "external";
export type WorkflowStopOutcome = "abort" | "needs_human" | "success_terminal";

export interface CapabilityField {
  name: string;
  required: boolean;
  description: string;
}

export interface CapabilityWorkflowStep {
  id: string;
  actor: WorkflowActor;
  instruction: string;
  verification: string;
  /** `readiness`, `auth`, or dot paths to evidence-bearing facts in this format. */
  evidenceRefs: string[];
}

export interface WorkflowStopCondition {
  id: string;
  when: string;
  actor: WorkflowActor;
  action: string;
  outcome: WorkflowStopOutcome;
}

/**
 * An executable procedure, not a pointer to another issue. A capable agent must
 * be able to reach the declared terminal state from these steps and the format
 * fields/constraints alone, regardless of whether execution belongs to the CLI,
 * an agent-owned browser, or a human handoff.
 */
export interface CapabilityWorkflow {
  objective: string;
  owner: ExecutionMode;
  preconditions: string[];
  steps: CapabilityWorkflowStep[];
  successCriteria: string[];
  terminalBoundary: string;
  stopConditions: WorkflowStopCondition[];
}

export interface ChannelFormatCapability {
  id: string;
  name: string;
  summary: string;
  /** Concrete CLI invocation, or an explicit statement that execution is external. */
  usage: string;
  /** Curated human-output facts; complete evidence remains in constraints/--json. */
  humanHighlights: string[];
  action: string;
  platformSupported: boolean;
  transportSupport: TransportSupport;
  fields: CapabilityField[];
  terminalState: string;
  constraints: JsonObject;
  validation: JsonObject;
  workflow: CapabilityWorkflow;
  gotchas: string[];
}

export interface ChannelAuthCapability {
  mode: string;
  entryUrl: string;
  workflowRef: string;
  continueInSameContext: boolean;
}

export interface ChannelStateCapability {
  machineLocal: string[];
  durable: string[];
  recovery: string[];
}

export interface ChannelResponsibilityBoundary {
  cli: string[];
  agent: string[];
  human: string[];
  platform: string[];
  rationale: string[];
}

export interface ChannelExcludedCapability {
  id: string;
  disposition: CapabilityDisposition;
  reason: string;
  owner: Exclude<WorkflowActor, "cli">;
  alternative: string | null;
}

export interface ChannelStaticCapabilities {
  schemaVersion: typeof CHANNEL_CAPABILITY_SCHEMA_VERSION;
  channel: AuthPlatform;
  displayName: string;
  executionMode: ExecutionMode;
  supportBoundary: string;
  responsibility: ChannelResponsibilityBoundary;
  excludedCapabilities: ChannelExcludedCapability[];
  auth: ChannelAuthCapability;
  state: ChannelStateCapability;
  formats: ChannelFormatCapability[];
  gotchas: string[];
  forbiddenActions: string[];
}

export interface ChannelInfoEnvelope {
  schemaVersion: typeof CHANNEL_INFO_SCHEMA_VERSION;
  channel: AuthPlatform;
  capabilities: ChannelStaticCapabilities;
  readiness: AuthReadiness;
}

export function capabilityFact<T extends JsonValue>(
  value: T,
  kind: EvidenceKind,
  source: string,
  lastVerified: string,
): CapabilityFact<T> {
  return { value, evidence: { kind, source, lastVerified } };
}

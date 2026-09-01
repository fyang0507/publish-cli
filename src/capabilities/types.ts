import type { AuthPlatform, AuthReadiness } from "../auth/types.js";

export const CHANNEL_CAPABILITY_SCHEMA_VERSION = "publish.channel-capabilities/v1" as const;
export const CHANNEL_INFO_SCHEMA_VERSION = "publish.channel-info/v1" as const;

export type EvidenceKind =
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

export interface CapabilityField {
  name: string;
  required: boolean;
  description: string;
}

export interface ChannelFormatCapability {
  id: string;
  name: string;
  summary: string;
  action: string;
  platformSupported: boolean;
  transportSupport: TransportSupport;
  fields: CapabilityField[];
  terminalState: string;
  constraints: JsonObject;
  validation: JsonObject;
  gotchas: string[];
}

export interface ChannelAuthCapability {
  mode: string;
  entryUrl: string;
  workflowRef: string;
  continueInSameContext: boolean;
}

export interface ChannelStaticCapabilities {
  schemaVersion: typeof CHANNEL_CAPABILITY_SCHEMA_VERSION;
  channel: AuthPlatform;
  displayName: string;
  executionMode: ExecutionMode;
  supportBoundary: string;
  auth: ChannelAuthCapability;
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

import type { AuthPlatform, AuthReadiness } from "../auth/types.js";

export const CHANNEL_INFO_SOURCE_SCHEMA_VERSION = "publish.channel-info-source/v1" as const;
export const CHANNEL_INFO_SCHEMA_VERSION = "publish.channel-info/v1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Human-editable static guidance loaded from capabilities/<channel>.md.
 *
 * The three Markdown sections are deliberately free-form. They are the minimum
 * information an agent needs before attempting channel work; add more schema
 * only after a concrete ambiguity proves it necessary.
 */
export interface ChannelInfoSource {
  schemaVersion: typeof CHANNEL_INFO_SOURCE_SCHEMA_VERSION;
  channel: AuthPlatform;
  displayName: string;
  cliBoundary: string;
  authentication: string;
  platformGuidance: string;
}

export interface ChannelInfoEnvelope {
  schemaVersion: typeof CHANNEL_INFO_SCHEMA_VERSION;
  channel: AuthPlatform;
  info: ChannelInfoSource;
  /** Live/passive state stays separate from the static Markdown guidance. */
  readiness: AuthReadiness;
}

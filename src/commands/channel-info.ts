import { Command } from "commander";
import {
  probeAuth,
  unexpectedProbeReadiness,
  type AuthPlatform,
  type AuthReadiness,
} from "../auth/index.js";
import {
  CHANNEL_INFO_SCHEMA_VERSION,
  getChannelCapabilities,
  type ChannelInfoEnvelope,
} from "../capabilities/index.js";

interface ChannelInfoOptions {
  json?: boolean;
}

export interface ChannelInfoExecution {
  envelope: ChannelInfoEnvelope;
  /** Info discovery always succeeds; readiness is data, not this command's exit gate. */
  exitCode: 0;
}

export type ChannelInfoProbe = (channel: AuthPlatform) => Promise<AuthReadiness>;

export async function executeChannelInfo(
  channel: AuthPlatform,
  authProbe: ChannelInfoProbe = probeAuth,
  now: () => number = Date.now,
): Promise<ChannelInfoExecution> {
  let readiness: AuthReadiness;
  try {
    readiness = await authProbe(channel);
  } catch (error) {
    readiness = unexpectedProbeReadiness(channel, error, now());
  }

  return {
    envelope: {
      schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
      channel,
      capabilities: getChannelCapabilities(channel),
      readiness,
    },
    exitCode: 0,
  };
}

export function renderChannelInfo(envelope: ChannelInfoEnvelope): string {
  const capabilities = envelope.capabilities;
  const readiness = envelope.readiness;
  const out = [
    `${capabilities.displayName} channel info`,
    `Static capabilities: ${capabilities.executionMode} — ${capabilities.supportBoundary}`,
    "Formats:",
    ...capabilities.formats.map(
      (format) => `  - ${format.id}: ${format.summary} Terminal: ${format.terminalState}.`,
    ),
    `Readiness: ${readiness.ready ? "ready" : "not ready"} (${readiness.status})`,
  ];

  if (readiness.nextStep) {
    out.push(`Next: ${readiness.nextStep.instruction}`);
    if (readiness.nextStep.entryUrl) out.push(`Entry: ${readiness.nextStep.entryUrl}`);
    out.push(`Reference: ${readiness.nextStep.workflowRef}`);
  }
  return out.join("\n");
}

export function registerChannelInfoCommand(parent: Command, channel: AuthPlatform): void {
  parent
    .command("info")
    .description("Show versioned static capabilities plus passive, sanitized readiness")
    .option("--json", "Emit the stable machine-readable channel-info envelope")
    .addHelpText(
      "after",
      "\nReturns every configured format at once. Readiness failures do not hide static capabilities and do not make info fail.\n",
    )
    .action(async (opts: ChannelInfoOptions) => {
      const execution = await executeChannelInfo(channel);
      console.log(
        opts.json
          ? JSON.stringify(execution.envelope, null, 2)
          : renderChannelInfo(execution.envelope),
      );
      process.exitCode = execution.exitCode;
    });
}

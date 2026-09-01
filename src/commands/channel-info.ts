import { Command } from "commander";
import {
  probeAuth,
  unexpectedProbeReadiness,
  type AuthPlatform,
  type AuthReadiness,
} from "../auth/index.js";
import {
  CHANNEL_INFO_SCHEMA_VERSION,
  getChannelInfoSource,
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
      info: getChannelInfoSource(channel),
      readiness,
    },
    exitCode: 0,
  };
}

export function renderChannelInfo(envelope: ChannelInfoEnvelope): string {
  const { info, readiness } = envelope;
  const readinessLabel = readiness.ready
    ? "ready"
    : readiness.status === "agent_check_required"
      ? "external preflight required"
      : "not ready";
  const out = [
    `${info.displayName} channel info`,
    `Readiness: ${readinessLabel} (${readiness.status})`,
    "Exit behavior: info returns 0 even when not ready; inspect readiness.ready/status in automation.",
  ];

  if (readiness.healed.length) out.push(`Healed: ${readiness.healed.join(", ")}`);
  if (readiness.nextStep) {
    out.push(`Next: ${readiness.nextStep.instruction}`);
    if (readiness.nextStep.entryUrl) out.push(`Recovery entry: ${readiness.nextStep.entryUrl}`);
    out.push(`Recovery reference: ${readiness.nextStep.workflowRef}`);
  }

  out.push(
    "",
    "## CLI boundary",
    "",
    info.cliBoundary,
    "",
    "## Authentication",
    "",
    info.authentication,
    "",
    "## Platform specification and gotchas",
    "",
    info.platformGuidance,
  );
  return out.join("\n");
}

export function registerChannelInfoCommand(parent: Command, channel: AuthPlatform): void {
  parent
    .command("info")
    .description("Show Markdown channel guidance plus bounded auth readiness")
    .option("--json", "Emit the stable machine-readable channel-info envelope")
    .addHelpText(
      "after",
      "\nReturns the complete channel boundary, authentication method, and platform specification/gotchas. Browser readiness probes are passive; WeChat may perform its normal token exchange and report token_refreshed. Readiness failures do not hide the static guidance or make info fail.\n",
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

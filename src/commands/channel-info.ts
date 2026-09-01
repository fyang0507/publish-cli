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

function compactValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join("; ") : "none";
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function renderChannelInfo(envelope: ChannelInfoEnvelope): string {
  const capabilities = envelope.capabilities;
  const readiness = envelope.readiness;
  const out = [
    `${capabilities.displayName} channel info`,
    `Readiness: ${readiness.ready ? "ready" : "not ready"} (${readiness.status})`,
    "Exit behavior: info returns 0 even when not ready; inspect readiness.ready/status in automation.",
  ];

  if (readiness.healed.length) out.push(`Healed: ${readiness.healed.join(", ")}`);
  if (readiness.nextStep) {
    out.push(`Next: ${readiness.nextStep.instruction}`);
    if (readiness.nextStep.entryUrl) out.push(`Recovery entry: ${readiness.nextStep.entryUrl}`);
    out.push(`Recovery reference: ${readiness.nextStep.workflowRef}`);
  }

  out.push(
    `Static capabilities: ${capabilities.executionMode} — ${capabilities.supportBoundary}`,
    `Authentication: ${capabilities.auth.mode}`,
    `Capability entry: ${capabilities.auth.entryUrl}`,
    `Workflow: ${capabilities.auth.workflowRef}`,
    "State:",
    `  - Machine-local: ${compactValue(capabilities.state.machineLocal)}`,
    `  - Durable: ${compactValue(capabilities.state.durable)}`,
    ...capabilities.state.recovery.map((item) => `  - Recovery: ${item}`),
    "Formats:",
  );

  for (const format of capabilities.formats) {
    out.push(
      `  - ${format.id} (${format.name})`,
      `    Summary: ${format.summary}`,
      `    Use: ${format.usage}`,
      `    Action: ${format.action}; transport: ${format.transportSupport}`,
      `    Terminal: ${format.terminalState}`,
      "    Inputs:",
      ...format.fields.map(
        (field) =>
          `      - ${field.name} (${field.required ? "required" : "optional"}): ${field.description}`,
      ),
      "    Key constraints:",
      ...format.humanHighlights.map((highlight) => `      - ${highlight}`),
      "    Validation:",
      ...Object.entries(format.validation).map(
        ([key, value]) => `      - ${key}: ${compactValue(value)}`,
      ),
    );
    if (format.gotchas.length) {
      out.push("    Gotchas:", ...format.gotchas.map((gotcha) => `      - ${gotcha}`));
    }
  }

  if (capabilities.gotchas.length) {
    out.push("Channel gotchas:", ...capabilities.gotchas.map((gotcha) => `  - ${gotcha}`));
  }
  out.push(
    "Forbidden actions:",
    ...capabilities.forbiddenActions.map((action) => `  - ${action}`),
    "Evidence: use --json for every constraint, source, verification date, conflict, lower bound, and unknown.",
  );
  return out.join("\n");
}

export function registerChannelInfoCommand(parent: Command, channel: AuthPlatform): void {
  parent
    .command("info")
    .description("Show all format capabilities plus passive readiness (exit 0 even when not ready)")
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

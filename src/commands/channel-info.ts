import { Command } from "commander";
import type { AuthPlatform, AuthReadiness } from "../auth/types.js";
import {
  CHANNEL_INFO_SCHEMA_VERSION,
  CHANNEL_INFO_ERROR_SCHEMA_VERSION,
  ChannelInfoSourceError,
  getChannelInfoSource,
  type ChannelInfoEnvelope,
  type ChannelInfoSource,
  type StaticChannelInfoAccess,
  type StaticChannelInfoReadiness,
} from "../capabilities/index.js";

interface ChannelInfoOptions {
  json?: boolean;
  static?: boolean;
}

export interface ChannelInfoExecution {
  envelope: ChannelInfoEnvelope;
  /** Info discovery always succeeds; readiness is data, not this command's exit gate. */
  exitCode: 0;
}

export type ChannelInfoProbe = (channel: AuthPlatform) => Promise<AuthReadiness>;
export type ChannelInfoSourceLoader = (channel: AuthPlatform) => ChannelInfoSource;

function skippedReadiness(): StaticChannelInfoReadiness {
  return {
    available: false,
    state: "skipped",
    reason: "static_requested",
  };
}

function staticAccess(): StaticChannelInfoAccess {
  return {
    readinessProbe: "skipped",
    profileAccessAttempted: false,
    browserLaunchAttempted: false,
    networkAccessAttempted: false,
    tokenAccessAttempted: false,
    apiAccessAttempted: false,
    platformAccessAttempted: false,
  };
}

export function executeStaticChannelInfo(
  channel: AuthPlatform,
  sourceLoader: ChannelInfoSourceLoader = getChannelInfoSource,
): ChannelInfoExecution {
  const info = sourceLoader(channel);
  return {
    envelope: {
      schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
      mode: "static",
      channel,
      info,
      readiness: skippedReadiness(),
      access: staticAccess(),
    },
    exitCode: 0,
  };
}

export async function executeChannelInfo(
  channel: AuthPlatform,
  authProbe?: ChannelInfoProbe,
  now: () => number = Date.now,
  sourceLoader: ChannelInfoSourceLoader = getChannelInfoSource,
): Promise<ChannelInfoExecution> {
  // Load only the selected local source before importing or invoking any
  // readiness code. A broken selected source therefore cannot touch auth or a
  // platform, while an unrelated source is never opened.
  const info = sourceLoader(channel);
  let readiness: AuthReadiness;
  try {
    const probe = authProbe ?? (await import("../auth/registry.js")).probeAuth;
    readiness = await probe(channel);
  } catch (error) {
    const { unexpectedProbeReadiness } = await import("../auth/registry.js");
    readiness = unexpectedProbeReadiness(channel, error, now());
  }

  return {
    envelope: {
      schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
      mode: "readiness",
      channel,
      info,
      readiness,
      access: { readinessProbe: "attempted" },
    },
    exitCode: 0,
  };
}

export function renderChannelInfo(envelope: ChannelInfoEnvelope): string {
  const { info } = envelope;
  const readinessLabel = envelope.mode === "static"
    ? "skipped (--static); unavailable"
    : envelope.readiness.ready
      ? "ready"
      : envelope.readiness.status === "agent_check_required"
        ? "external preflight required"
        : envelope.readiness.status === "human_login_required"
          ? "human login required"
          : "not ready";
  const out = [
    `${info.displayName} channel info`,
    `${info.channel === "reddit" ? "Draft readiness" : "Readiness"}: ${readinessLabel}${envelope.mode === "readiness" ? ` (${envelope.readiness.status})` : ""}`,
    envelope.mode === "static"
      ? `Access: static mode did not inspect a profile or token, launch a browser, use the network/API, or access ${info.channel}.`
      : `Exit behavior: info returns 0 even when not ready; run publish ${info.channel} info --json and inspect readiness.ready/status in automation.`,
  ];

  if (envelope.mode === "readiness" && envelope.readiness.healed.length) {
    out.push(`Healed: ${envelope.readiness.healed.join(", ")}`);
  }
  if (envelope.mode === "readiness") {
    const { readiness } = envelope;
    const { nextStep } = readiness;
    if (nextStep) {
      out.push(
        `Next owner: ${nextStep.executor}${readiness.requiresHuman ? " (human participation required)" : ""}`,
      );
      out.push(
        `Recovery context: ${nextStep.recoveryContext.venue} (owner=${nextStep.recoveryContext.owner}; launch=${nextStep.recoveryContext.launch})`,
      );
      out.push(`Next: ${nextStep.instruction}`);
      if (nextStep.entryUrl) out.push(`Recovery entry: ${nextStep.entryUrl}`);
      if (nextStep.workflowRef) out.push(`Recovery help: ${nextStep.workflowRef}`);
    }
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
  const readinessHelp = channel === "wechat"
    ? "WeChat may perform its normal token exchange and report token_refreshed."
    : channel === "xhs" || channel === "1point3acres" || channel === "website"
      ? "Info returns an external handoff descriptor and does not access the platform."
      : "Browser readiness probes are passive.";
  parent
    .command("info")
    .description("Show Markdown channel guidance plus bounded auth readiness")
    .option("--json", "Emit the stable machine-readable channel-info envelope")
    .option(
      "--static",
      "Return selected-channel guidance without profile, browser, network, API, token, or platform access",
    )
    .addHelpText(
      "after",
      `\nReturns the channel boundary, authentication method, and platform specification/gotchas. Use --static for an offline capability-only query whose readiness is explicitly skipped. Without --static, ${readinessHelp} Readiness failures do not hide the static guidance or make info fail.\n`,
    )
    .action(async (opts: ChannelInfoOptions) => {
      try {
        const execution = opts.static
          ? executeStaticChannelInfo(channel)
          : await executeChannelInfo(channel);
        console.log(
          opts.json
            ? JSON.stringify(execution.envelope, null, 2)
            : renderChannelInfo(execution.envelope),
        );
        process.exitCode = execution.exitCode;
      } catch (error) {
        if (!(error instanceof ChannelInfoSourceError)) throw error;
        if (opts.json) {
          console.log(JSON.stringify({
            schemaVersion: CHANNEL_INFO_ERROR_SCHEMA_VERSION,
            channel,
            mode: opts.static ? "static" : "readiness",
            error: { code: error.code, source: error.sourceName },
            access: staticAccess(),
          }, null, 2));
        } else {
          process.stderr.write(`${error.message}\n`);
        }
        process.exitCode = 1;
      }
    });
}

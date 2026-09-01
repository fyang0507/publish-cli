import { Command, InvalidArgumentError, Option } from "commander";
import {
  AUTH_PLATFORMS,
  probeAuthPlatforms,
  unexpectedProbeReadiness,
  type AuthPlatform,
  type AuthReadiness,
} from "../auth/index.js";

interface AuthCheckOptions {
  platform?: string[];
  /** Hidden tombstone so removed --all usage gets an actionable exit-2 error. */
  all?: boolean;
  json?: boolean;
}

export interface AuthCheckExecution {
  results: AuthReadiness[];
  exitCode: 0 | 1;
}

function collectPlatforms(value: string, previous: string[] = []): string[] {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => !part)) {
    throw new InvalidArgumentError(
      "--platform must be a comma-separated list without empty names.",
    );
  }
  return [...previous, ...parts];
}

function parsePlatforms(opts: AuthCheckOptions): AuthPlatform[] {
  if (opts.all) {
    throw new InvalidArgumentError(
      "--all was removed. Deliberately specify --platform <names>, for example --platform x,linkedin,reddit.",
    );
  }
  if (!opts.platform?.length) {
    throw new InvalidArgumentError(
      "Specify --platform <names>, for example --platform x,linkedin,reddit.",
    );
  }
  const requested = opts.platform;
  const unknown = requested.filter((value) => !(AUTH_PLATFORMS as readonly string[]).includes(value));
  if (unknown.length) {
    throw new InvalidArgumentError(
      `Unknown platform(s): ${unknown.join(", ")}. Expected: ${AUTH_PLATFORMS.join(", ")}.`,
    );
  }
  return [...new Set(requested)] as AuthPlatform[];
}

export function registerAuthCheckCommand(parent: Command): void {
  parent
    .command("check")
    .description("Check side-effect-bounded auth readiness; browser probes never log in or open a composer")
    .option(
      "--platform <names>",
      "Comma-separated platforms to check (repeatable): x,linkedin,reddit,wechat,xhs,1point3acres",
      collectPlatforms,
    )
    .addOption(new Option("--all").hideHelp())
    .option("--json", "Emit a sanitized machine-readable receipt")
    .addHelpText(
      "after",
      "\nPlatform modes:\n  CLI-probed     x, linkedin, reddit, wechat\n  Agent-browser  xhs (returns agent_check_required with a browser-agent next step)\n  Human-handoff  1point3acres (returns agent_check_required with a human-only next step)\n\nExamples:\n  publish auth check --platform x,linkedin,reddit\n  publish auth check --platform wechat,xhs --json\n\nExit codes:\n  0  every requested platform is ready\n  1  one or more requested platforms are not ready; follow nextStep\n  2  invalid command usage\n",
    )
    .action(async (opts: AuthCheckOptions) => {
      let platforms: AuthPlatform[];
      try {
        platforms = parsePlatforms(opts);
      } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 2;
        return;
      }

      const execution = await executeAuthCheck(platforms);
      const results = execution.results;
      if (opts.json) {
        console.log(JSON.stringify({ results }, null, 2));
      } else {
        console.log(renderAuthReport(results));
      }
      process.exitCode = execution.exitCode;
    });
}

/** Injectable command boundary used by the CLI and deterministic regression tests. */
export async function executeAuthCheck(
  platforms: AuthPlatform[],
  probe: typeof probeAuthPlatforms = probeAuthPlatforms,
): Promise<AuthCheckExecution> {
  // probeAuthPlatforms already isolates per-platform failures. This outer
  // boundary protects the command if a future registry implementation rejects
  // before it can return receipts.
  let results: AuthReadiness[];
  try {
    results = await probe(platforms);
  } catch {
    results = platforms.map((platform) => unexpectedProbeReadiness(platform, undefined));
  }

  const byPlatform = new Map(results.map((result) => [result.platform, result]));
  if (platforms.some((platform) => !byPlatform.has(platform))) {
    results = platforms.map(
      (platform) => byPlatform.get(platform) ?? unexpectedProbeReadiness(platform, undefined),
    );
  }
  return {
    results,
    exitCode: results.every((result) => result.ready) ? 0 : 1,
  };
}

export function renderAuthReport(results: AuthReadiness[]): string {
  const lines = ["publish auth check — bounded readiness (browser probes never log in)", ""];
  for (const result of results) {
    const marker = result.ready
      ? "✓"
      : result.status === "probe_inconclusive" || result.status === "agent_check_required"
        ? "?"
        : "✗";
    lines.push(`${marker} ${result.platform}: ready=${result.ready ? "yes" : "no"} (${result.status})`);
    lines.push(`  live proof: ${result.evidence.liveProbe}`);
    if (result.evidence.note) lines.push(`  detail: ${result.evidence.note}`);
    if (result.evidence.profilePresent != null) {
      lines.push(
        `  local evidence: profile=${result.evidence.profilePresent ? "present" : "missing"}, ` +
          `cookie-cache=${result.evidence.cookieCachePresent ? "present" : "missing"}, ` +
          `required-cookies=${result.evidence.requiredCookiesPresent ? "present" : "missing"}, ` +
          `declared-expired=${result.evidence.declaredExpired ? "yes" : "no"}`,
      );
    } else if (result.platform === "wechat") {
      lines.push(
        `  local evidence: credentials=${result.evidence.credentialsConfigured ? "configured" : "missing"}, ` +
          `token-cache=${result.evidence.tokenCachePresent ? "present" : "missing"}, ` +
          `token-expired=${result.evidence.tokenCacheExpired ? "yes" : "no"}`,
      );
    }
    if (result.healed.length) lines.push(`  healed: ${result.healed.join(", ")}`);
    if (result.nextStep) {
      lines.push(`  next: ${result.nextStep.instruction}`);
      if (result.nextStep.entryUrl) lines.push(`  entry: ${result.nextStep.entryUrl}`);
      lines.push(`  workflow: ${result.nextStep.workflowRef}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

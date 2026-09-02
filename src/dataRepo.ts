import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

/**
 * Data-repo resolution — where publish-cli's DURABLE state lives (the SQLite
 * dedupe store, and the target for installed copies of the agent skills). This
 * is the agent's WORKSPACE, not a machine-local scratch dir. Mirrors
 * outreach-cli's dataRepo.ts.
 *
 * NOTE the split: the persistent browser profile + cookie cache are machine-local
 * SESSION/secret artifacts and stay under PUBLISH_DATA_DIR (~/.publish-cli),
 * off any synced drive. Only durable state (the dedupe DB) lives in the data repo.
 */
export type ResolutionSource = "env" | "dev" | "walkup";

export interface ResolvedDataRepo {
  path: string;
  source: ResolutionSource;
}

export interface DevConfigLocation {
  path: string;
  dataRepoPath: string | null;
}

const WORKSPACE_MARKER = join(".agents", "workspace.yaml");
const DEV_CONFIG_FILENAME = "publish.config.dev.yaml";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Resolve a config value relative to the config file, not the caller's cwd. */
export function resolveConfigRelativePath(configPath: string, value: string): string {
  const expanded = expandHome(value.trim());
  return isAbsolute(expanded) ? expanded : resolve(dirname(configPath), expanded);
}

function cliRepoRoot(): string {
  // src/dataRepo.ts and dist/dataRepo.js both sit one level under the repo root.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, "..");
}

/**
 * Locate publish.config.dev.yaml next to the CLI, if present, and read its
 * `data_repo_path` (or null if absent/blank). This is the sticky dev override so
 * the build-time skill-install step (whose cwd is the CLI repo, not the workspace)
 * still finds the data repo without an env var. Relative values are based on
 * the config file's directory.
 */
export function locateDevConfig(): DevConfigLocation | null {
  const path = join(cliRepoRoot(), DEV_CONFIG_FILENAME);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf-8"));
  } catch {
    return { path, dataRepoPath: null };
  }
  if (!parsed || typeof parsed !== "object") return { path, dataRepoPath: null };

  const raw = (parsed as Record<string, unknown>).data_repo_path;
  if (typeof raw !== "string" || raw.trim() === "") return { path, dataRepoPath: null };
  return { path, dataRepoPath: resolveConfigRelativePath(path, raw) };
}

function findWorkspaceMarker(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, WORKSPACE_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the data repo path. Order:
 *   1. PUBLISH_DATA_REPO env var.
 *   2. publish.config.dev.yaml next to the CLI (sticky; wins over walk-up).
 *   3. Walk up from cwd for .agents/workspace.yaml.
 * Throws an actionable error on miss.
 */
export function resolveDataRepo(cwd: string = process.cwd()): ResolvedDataRepo {
  const envVal = process.env.PUBLISH_DATA_REPO;
  if (envVal && envVal.trim() !== "") {
    return { path: expandHome(envVal.trim()), source: "env" };
  }

  const dev = locateDevConfig();
  if (dev && dev.dataRepoPath) {
    return { path: dev.dataRepoPath, source: "dev" };
  }

  const walk = findWorkspaceMarker(cwd);
  if (walk) return { path: walk, source: "walkup" };

  throw new Error(
    [
      "Could not resolve the publish-cli data repo.",
      "Tried (in order):",
      "  1. PUBLISH_DATA_REPO env var — unset",
      `  2. ${DEV_CONFIG_FILENAME} next to the CLI — not found or missing data_repo_path`,
      `  3. Walk-up from cwd for ${WORKSPACE_MARKER} — no marker found`,
      "",
      "Fix one of:",
      "  • Set PUBLISH_DATA_REPO=/path/to/workspace for ad-hoc invocations.",
      `  • Create ${DEV_CONFIG_FILENAME} next to the CLI with data_repo_path: /path/to/workspace.`,
      `  • Run from a workspace that contains ${WORKSPACE_MARKER}.`,
    ].join("\n"),
  );
}

/** Non-throwing variant: returns the resolved path or null. */
export function tryResolveDataRepo(cwd: string = process.cwd()): string | null {
  try {
    return resolveDataRepo(cwd).path;
  } catch {
    return null;
  }
}

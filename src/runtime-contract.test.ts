import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const NODE_ENGINE = ">=22.19.0";
const README_REQUIREMENT = "Node.js 22.19.0 or newer is required";

interface PackageRecord {
  version?: string;
  dependencies?: Record<string, string>;
  engines?: { node?: string };
}

interface PackageLock {
  packages?: Record<string, PackageRecord>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

type Version = readonly [major: number, minor: number, patch: number];

function parseVersion(value: string, label: string): Version {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/u);
  assert.ok(match, `${label} must be a stable semantic version; received ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseMinimum(range: string, label: string): Version {
  const match = range.trim().match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u);
  assert.ok(
    match,
    `${label} must use a simple >= Node range so this runtime-floor guard remains exact; received ${range}`,
  );
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compare(left: Version, right: Version): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! - right[index]!;
  }
  return 0;
}

test("Node runtime floor stays synchronized across package metadata and setup docs", () => {
  const manifest = readJson<PackageRecord>(join(ROOT_DIR, "package.json"));
  const lock = readJson<PackageLock>(join(ROOT_DIR, "package-lock.json"));
  const readme = readFileSync(join(ROOT_DIR, "README.md"), "utf8");
  const evalReadme = readFileSync(join(ROOT_DIR, "eval", "README.md"), "utf8");
  const evalRunner = readFileSync(join(ROOT_DIR, "eval", "run.ts"), "utf8");
  const lockRoot = lock.packages?.[""];
  const installStart = readme.indexOf("## Install and build\n");
  assert.notEqual(installStart, -1, "README.md is missing its Install and build section");
  const nextSection = readme.indexOf("\n## ", installStart + 3);
  const installSection = readme.slice(installStart, nextSection < 0 ? undefined : nextSection);

  assert.equal(manifest.engines?.node, NODE_ENGINE);
  assert.equal(lockRoot?.engines?.node, NODE_ENGINE);
  assert.ok(installSection.includes(README_REQUIREMENT));
  assert.ok(installSection.includes(`\`${NODE_ENGINE}\``));
  assert.match(evalReadme, /Node ≥ 22\.19\.0 \(the repository supported floor\)/u);
  assert.match(evalRunner, /Node >= 22\.19\.0, the repository supported floor/u);
});

test("declared Node floor satisfies every locked direct runtime dependency", () => {
  const manifest = readJson<PackageRecord>(join(ROOT_DIR, "package.json"));
  const lock = readJson<PackageLock>(join(ROOT_DIR, "package-lock.json"));
  const declaredRange = manifest.engines?.node;
  assert.equal(declaredRange, NODE_ENGINE);
  assert.deepEqual(lock.packages?.[""]?.dependencies, manifest.dependencies);
  const declaredFloor = parseMinimum(declaredRange, "package engines.node");

  assert.ok(
    compare(parseVersion(process.versions.node, "current Node version"), declaredFloor) >= 0,
    `tests require Node ${declaredRange}; current runtime is ${process.versions.node}`,
  );

  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const locked = lock.packages?.[`node_modules/${dependency}`];
    assert.ok(locked, `package-lock.json is missing direct dependency ${dependency}`);
    const dependencyRange = locked.engines?.node;
    if (!dependencyRange) continue;
    const dependencyFloor = parseMinimum(
      dependencyRange,
      `${dependency}@${locked.version ?? "unknown"} engines.node`,
    );
    assert.ok(
      compare(declaredFloor, dependencyFloor) >= 0,
      `${dependency}@${locked.version ?? "unknown"} requires Node ${dependencyRange}, ` +
        `which exceeds the declared root floor ${declaredRange}`,
    );
  }
});

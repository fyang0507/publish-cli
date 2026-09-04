import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TRANSPORT_RECEIPT_SCHEMA_VERSION,
  type TransportReceipt,
} from "../transportReceipt.js";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
const X_CONTENT_URL = new URL("../x/content.js", import.meta.url).href;
const DRAFT_COMMAND_URL = new URL("./draft.js", import.meta.url).href;
const REPLY_COMMAND_URL = new URL("./reply.js", import.meta.url).href;
const CONTENT_CANARY = "X_PRESTAGE_BODY_MUST_NOT_LEAK";

type ThrowKind = "error" | "string" | "revoked_proxy" | "range_error";

interface Fixture {
  readonly dir: string;
  readonly loaderPath: string;
}

function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-prestage-runtime-"));
  const mockPath = join(dir, "mock-x-content.mjs");
  const mockUrl = pathToFileURL(mockPath).href;
  const loaderPath = join(dir, "mock-x-content-loader.mjs");

  writeFileSync(mockPath, `
export * from ${JSON.stringify(X_CONTENT_URL)};

export async function generateContent() {
  const kind = process.env.PUBLISH_TEST_X_THROW_KIND;
  const canary = process.env.PUBLISH_TEST_X_THROW_CANARY;
  if (kind === "error") throw new Error("raw Error " + canary);
  if (kind === "string") throw "raw string " + canary;
  if (kind === "range_error") throw new RangeError("raw RangeError " + canary);
  if (kind === "revoked_proxy") {
    const target = { canary };
    const pair = Proxy.revocable(target, {});
    pair.revoke();
    throw pair.proxy;
  }
  throw new Error("throw fixture was not configured");
}
`);

  writeFileSync(loaderPath, `
import { registerHooks } from "node:module";

const commandUrls = new Set(${JSON.stringify([DRAFT_COMMAND_URL, REPLY_COMMAND_URL])});
const mockUrl = ${JSON.stringify(mockUrl)};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../x/content.js" && commandUrls.has(context.parentURL)) {
      return nextResolve(mockUrl, context);
    }
    return nextResolve(specifier, context);
  },
});
`);

  return { dir, loaderPath };
}

function runCli(
  fixture: Fixture,
  args: readonly string[],
  kind: ThrowKind,
  canary: string,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", fixture.loaderPath, CLI_PATH, ...args], {
    encoding: "utf8",
    maxBuffer: 1_000_000,
    env: {
      ...process.env,
      PUBLISH_DATA_DIR: join(fixture.dir, "data"),
      PUBLISH_DATA_REPO: join(fixture.dir, "repo"),
      PUBLISH_TEST_X_THROW_KIND: kind,
      PUBLISH_TEST_X_THROW_CANARY: canary,
    },
  });
}

function parseSingleReceipt(stdout: string): TransportReceipt {
  assert.ok(stdout.endsWith("\n"), "JSON receipt should end with exactly one record newline");
  const receipt = JSON.parse(stdout) as TransportReceipt;
  assert.equal(receipt.schemaVersion, TRANSPORT_RECEIPT_SCHEMA_VERSION);
  assert.equal(
    stdout.trim(),
    JSON.stringify(receipt),
    "stdout must contain exactly one deterministic JSON document",
  );
  return receipt;
}

function assertContentFreeRuntimeReceipt(
  result: SpawnSyncReturns<string>,
  action: "draft" | "reply",
  throwCanary: string,
): TransportReceipt {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "", "JSON mode must reserve stderr even for hostile thrown values");
  const receipt = parseSingleReceipt(result.stdout);

  assert.equal(receipt.channel, "x");
  assert.equal(receipt.action, action);
  assert.equal(receipt.format, action === "draft" ? "tweet" : "reply");
  assert.equal(receipt.mode, "dry_run");
  assert.equal(receipt.platformTouched, false);
  assert.equal(receipt.published, false);
  assert.equal(receipt.terminalState, "no_native_draft");
  assert.equal(receipt.validation.local.status, "not_reached");
  assert.equal(receipt.validation.live.status, "not_reached");
  assert.equal(receipt.verification.status, "not_applicable");
  assert.equal(receipt.verification.nativeReference, null);
  assert.deepEqual(receipt.warnings, []);
  assert.deepEqual(receipt.assets, []);
  assert.deepEqual(receipt.remoteResidue, []);
  assert.equal(receipt.error?.source, "runtime");
  assert.equal(receipt.error?.stage, "content_generation");
  assert.equal(receipt.error?.classification, "unknown");
  assert.equal(receipt.error?.retryable, null);
  assert.equal(receipt.error?.inputRelated, null);
  assert.deepEqual(receipt.exit, { class: "runtime_or_platform_failure", code: 1 });

  const combined = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(combined, new RegExp(throwCanary));
  assert.doesNotMatch(combined, new RegExp(CONTENT_CANARY));
  assert.doesNotMatch(
    combined,
    /raw (?:Error|RangeError|string)|\bRangeError\b|\bError:|mock-x-content|generateContent|Cannot perform .* revoked|(?:^|\\n)\s*at\s/m,
    "receipt must not expose the thrown value, its type, or a stack",
  );
  return receipt;
}

test("X draft and reply turn hostile pre-stage generation throws into one fixed JSON receipt", () => {
  const fixture = createFixture();
  const cases = [
    {
      action: "draft" as const,
      args: ["x", "draft", "--format", "tweet", "--text", CONTENT_CANARY, "--dry-run", "--json"],
    },
    {
      action: "reply" as const,
      args: ["x", "reply", "--to", "1234567890123456789", "--text", CONTENT_CANARY, "--dry-run", "--json"],
    },
  ];
  const throwKinds: readonly ThrowKind[] = ["error", "string", "revoked_proxy", "range_error"];

  try {
    for (const command of cases) {
      const outputs: string[] = [];
      for (const kind of throwKinds) {
        const throwCanary = `X_PRESTAGE_THROW_MUST_NOT_LEAK_${command.action}_${kind}`;
        const result = runCli(fixture, command.args, kind, throwCanary);
        assertContentFreeRuntimeReceipt(result, command.action, throwCanary);
        outputs.push(result.stdout);
      }
      assert.equal(
        new Set(outputs).size,
        1,
        `${command.action} must emit byte-identical receipt facts for every unexpected thrown value`,
      );
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("X pre-stage runtime failure has one small fixed human receipt", () => {
  const fixture = createFixture();
  const throwCanary = "X_PRESTAGE_HUMAN_THROW_MUST_NOT_LEAK";
  try {
    const result = runCli(
      fixture,
      ["x", "draft", "--format", "tweet", "--text", CONTENT_CANARY, "--dry-run"],
      "range_error",
      throwCanary,
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.endsWith("\n"));
    assert.ok(result.stderr.length < 4_096, `human receipt was ${result.stderr.length} code units`);
    assert.equal(
      result.stderr.match(/Transport receipt \(publish\.transport-receipt\/v1\)/g)?.length,
      1,
    );
    assert.match(result.stderr, /channel\/action\/format: x\/draft\/tweet/);
    assert.match(result.stderr, /platform touched: no/);
    assert.match(result.stderr, /terminal draft state: no_native_draft/);
    assert.match(result.stderr, /exit: runtime_or_platform_failure \(1\)/);
    assert.doesNotMatch(result.stderr, new RegExp(throwCanary));
    assert.doesNotMatch(result.stderr, new RegExp(CONTENT_CANARY));
    assert.doesNotMatch(
      result.stderr,
      /raw RangeError|\bRangeError\b|\bError:|mock-x-content|generateContent|(?:^|\n)\s*at\s/m,
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

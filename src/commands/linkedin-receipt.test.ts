import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { TransportReceipt } from "../transportReceipt.js";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));

function png(width: number, height: number): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PUBLISH_DATA_REPO: "",
      PUBLISH_DATA_DIR: "",
    },
  });
}

function oneJsonReceipt(stdout: string): TransportReceipt {
  const documents = stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(documents.length, 1, stdout);
  return JSON.parse(documents[0]) as TransportReceipt;
}

test("LinkedIn JSON dry-run emits one receipt with ordered set-only media facts", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-linkedin-receipt-"));
  try {
    const first = join(dir, "first.png");
    const second = join(dir, "second.png");
    writeFileSync(first, png(1200, 800));
    writeFileSync(second, png(640, 640));
    const args = [
      "linkedin", "draft", "--text", "A clear LinkedIn receipt test body.",
      "--media", first, "--media", second, "--dry-run",
    ];
    const jsonRun = run([...args, "--json"]);
    assert.equal(jsonRun.status, 0, `${jsonRun.stdout}${jsonRun.stderr}`);
    assert.equal(jsonRun.stderr, "");
    const receipt = oneJsonReceipt(jsonRun.stdout);
    assert.equal(receipt.schemaVersion, "publish.transport-receipt/v1");
    assert.equal(receipt.channel, "linkedin");
    assert.equal(receipt.mode, "dry_run");
    assert.equal(receipt.platformTouched, false);
    assert.equal(receipt.published, false);
    assert.deepEqual(receipt.assets, [
      {
        index: 0, role: "media", requested: true, resolved: true,
        set: false, uploaded: null, observed: null, verified: null, remoteReference: null,
      },
      {
        index: 1, role: "media", requested: true, resolved: true,
        set: false, uploaded: null, observed: null, verified: null, remoteReference: null,
      },
    ]);
    assert.doesNotMatch(jsonRun.stdout, /first\.png|second\.png/);

    const humanRun = run(args);
    assert.equal(humanRun.status, 0, `${humanRun.stdout}${humanRun.stderr}`);
    assert.equal(humanRun.stderr, "");
    assert.match(humanRun.stdout, /Transport receipt \(publish\.transport-receipt\/v1\)/);
    assert.match(humanRun.stdout, /channel\/action\/format: linkedin\/draft\/post/);
    assert.match(humanRun.stdout, /platform touched: no/);
    assert.match(humanRun.stdout, /asset\[0\] media: requested=yes; resolved=yes; set=no; uploaded=unknown; observed=unknown; verified=unknown/);
    assert.match(humanRun.stdout, /published: false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LinkedIn JSON local and parse failures stay one-document exit 2", () => {
  const local = run([
    "linkedin", "draft", "--text", "a".repeat(3_001), "--json",
  ]);
  assert.equal(local.status, 2, `${local.stdout}${local.stderr}`);
  assert.equal(local.stderr, "");
  const localReceipt = oneJsonReceipt(local.stdout);
  assert.equal(localReceipt.exit.code, 2);
  assert.equal(localReceipt.platformTouched, false);
  assert.equal(localReceipt.validation.local.status, "failed");
  assert.equal(localReceipt.validation.local.problems[0].code, "linkedin_text_too_long");

  const parse = run([
    "linkedin", "draft", "--text", "body", "--not-a-real-option", "--json",
  ]);
  assert.equal(parse.status, 2, `${parse.stdout}${parse.stderr}`);
  assert.equal(parse.stderr, "");
  const parseReceipt = oneJsonReceipt(parse.stdout);
  assert.equal(parseReceipt.error?.source, "command_parser");
  assert.equal(parseReceipt.platformTouched, false);
  assert.equal(parseReceipt.published, false);
});

test("LinkedIn invalid media receipt retains requested order without paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-linkedin-invalid-media-"));
  try {
    const valid = join(dir, "valid.png");
    const invalid = join(dir, "private-invalid.png");
    writeFileSync(valid, png(1200, 800));
    writeFileSync(invalid, "not an image");
    const result = run([
      "linkedin", "draft", "--text", "Body", "--media", valid,
      "--media", invalid, "--json",
    ]);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.equal(result.stderr, "");
    const receipt = oneJsonReceipt(result.stdout);
    assert.deepEqual(receipt.assets.map((asset) => ({
      index: asset.index,
      resolved: asset.resolved,
      set: asset.set,
      observed: asset.observed,
      verified: asset.verified,
    })), [
      { index: 0, resolved: true, set: false, observed: null, verified: null },
      { index: 1, resolved: false, set: false, observed: null, verified: null },
    ]);
    assert.doesNotMatch(result.stdout, /valid\.png|private-invalid\.png|publish-linkedin-invalid-media/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

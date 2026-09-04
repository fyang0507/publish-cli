import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function parseSingleReceipt(stdout: string): TransportReceipt {
  assert.ok(stdout.endsWith("\n"));
  const receipt = JSON.parse(stdout) as TransportReceipt;
  assert.equal(stdout.trim(), JSON.stringify(receipt));
  return receipt;
}

test("WeChat JSON dry-run is one platform-free document and reports resolved assets", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-command-receipt-"));
  try {
    const cover = join(dir, "cover.png");
    const body = join(dir, "body.png");
    const dataDir = join(dir, "data");
    const repoDir = join(dir, "repo");
    const loader = join(dir, "block-wechat-platform.mjs");
    writeFileSync(cover, png(900, 900));
    writeFileSync(body, png(640, 480));
    mkdirSync(dataDir);
    mkdirSync(repoDir);
    writeFileSync(loader, `import { registerHooks } from "node:module";
const blocked = ["/dist/wechat/client.js", "/node_modules/undici/", "/node_modules/socks/"];
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (blocked.some((needle) => resolved.url.includes(needle))) throw new Error("WECHAT_PLATFORM_IMPORT_BLOCKED");
  return resolved;
} });
`);
    const result = spawnSync(process.execPath, [
      "--import", loader, CLI_PATH,
      "wechat", "draft", "--title", "Title", "--text", `Body\n\n![image](${body})`,
      "--cover", cover, "--dry-run", "--json",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PUBLISH_DATA_DIR: dataDir,
        PUBLISH_DATA_REPO: repoDir,
        WECHAT_AUTHOR: "",
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /WECHAT_PLATFORM_IMPORT_BLOCKED/);
    const receipt = parseSingleReceipt(result.stdout);
    assert.equal(receipt.channel, "wechat");
    assert.equal(receipt.mode, "dry_run");
    assert.equal(receipt.platformTouched, false);
    assert.equal(receipt.published, false);
    assert.deepEqual(receipt.assets.map((asset) => ({
      role: asset.role,
      resolved: asset.resolved,
      uploaded: asset.uploaded,
    })), [
      { role: "cover", resolved: true, uploaded: false },
      { role: "body_image", resolved: true, uploaded: false },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WeChat --out failure is runtime exit 1 with artifact residue and no API import", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-artifact-receipt-"));
  try {
    const cover = join(dir, "cover.png");
    const out = join(dir, "output.html");
    const loader = join(dir, "block-wechat-platform.mjs");
    writeFileSync(cover, png(900, 900));
    mkdirSync(out);
    writeFileSync(loader, `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (resolved.url.includes("/dist/wechat/client.js") || resolved.url.includes("/node_modules/undici/")) {
    throw new Error("WECHAT_PLATFORM_IMPORT_BLOCKED");
  }
  return resolved;
} });
`);
    const result = spawnSync(process.execPath, [
      "--import", loader, CLI_PATH,
      "wechat", "draft", "--title", "Title", "--text", "Body", "--cover", cover,
      "--out", out, "--dry-run", "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, PUBLISH_DATA_DIR: join(dir, "data"), WECHAT_AUTHOR: "" },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "");
    const receipt = parseSingleReceipt(result.stdout);
    assert.equal(receipt.error?.stage, "artifact_write");
    assert.equal(receipt.error?.source, "runtime");
    assert.equal(receipt.platformTouched, false);
    assert.equal(receipt.exit.code, 1);
    assert.ok(receipt.remoteResidue.some((entry) => entry.kind === "artifact"));
    assert.doesNotMatch(result.stdout, /WECHAT_PLATFORM_IMPORT_BLOCKED|EISDIR|errno/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WeChat local JSON rejection exits 2 before API import", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-local-receipt-"));
  try {
    const loader = join(dir, "block-wechat-platform.mjs");
    writeFileSync(loader, `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (resolved.url.includes("/dist/wechat/client.js")) throw new Error("WECHAT_PLATFORM_IMPORT_BLOCKED");
  return resolved;
} });
`);
    const result = spawnSync(process.execPath, [
      "--import", loader, CLI_PATH,
      "wechat", "draft", "--title", "Title", "--text", "Body",
      "--cover", join(dir, "missing.png"), "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, PUBLISH_DATA_DIR: join(dir, "data"), WECHAT_AUTHOR: "" },
    });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "");
    const receipt = parseSingleReceipt(result.stdout);
    assert.equal(receipt.validation.local.status, "failed");
    assert.equal(receipt.platformTouched, false);
    assert.equal(receipt.exit.class, "invalid_caller_input");
    assert.doesNotMatch(result.stdout, /WECHAT_PLATFORM_IMPORT_BLOCKED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WeChat receipt bounding does not invent a 99-body-image input limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-many-assets-"));
  try {
    const cover = join(dir, "cover.png");
    writeFileSync(cover, png(900, 900));
    const bodyPaths = Array.from({ length: 100 }, (_, index) => {
      const path = join(dir, `body-${index}.png`);
      writeFileSync(path, png(640, 480));
      return path;
    });
    const markdown = bodyPaths.map((path, index) => `![image ${index}](${path})`).join("\n\n");
    const result = spawnSync(process.execPath, [
      CLI_PATH,
      "wechat", "draft", "--title", "Title", "--text", markdown,
      "--cover", cover, "--dry-run", "--json",
    ], {
      encoding: "utf8",
      maxBuffer: 2_000_000,
      env: {
        ...process.env,
        PUBLISH_DATA_DIR: join(dir, "data"),
        PUBLISH_DATA_REPO: dir,
        WECHAT_AUTHOR: "",
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "");
    const receipt = parseSingleReceipt(result.stdout);
    assert.equal(receipt.validation.local.status, "passed");
    assert.equal(receipt.evidenceSummary.assets.total, 101);
    assert.equal(receipt.evidenceSummary.assets.listed, 100);
    assert.equal(receipt.evidenceSummary.assets.omitted, 1);
    assert.equal(receipt.evidenceSummary.assets.requested.yes, 101);
    assert.equal(receipt.evidenceSummary.assets.resolved.yes, 101);
    assert.match(receipt.evidenceSummary.assets.fullSetSha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

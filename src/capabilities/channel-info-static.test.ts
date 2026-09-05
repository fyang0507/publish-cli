import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthReadiness } from "../auth/types.js";
import {
  executeChannelInfo,
  executeStaticChannelInfo,
  renderChannelInfo,
} from "../commands/channel-info.js";
import {
  CHANNEL_INFO_SCHEMA_VERSION,
  ChannelInfoSourceError,
  getChannelInfoSource,
} from "./index.js";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
const CHECKED_AT = "2026-09-04T00:00:00.000Z";

function sourceMarkdown(channel: "x" | "reddit" | "xhs", displayName: string): string {
  return `---
schemaVersion: publish.channel-info-source/v1
channel: ${channel}
displayName: ${displayName}
---
# ${displayName}

## CLI boundary

Boundary for ${channel}.

## Authentication

Authentication for ${channel}.

## Platform specification and gotchas

Guidance for ${channel}.
`;
}

function readyX(): AuthReadiness {
  return {
    platform: "x",
    ready: true,
    status: "ready",
    checkedAt: CHECKED_AT,
    verificationMode: "passive_browser",
    evidence: { liveProbe: "authenticated" },
    healed: [],
    requiresHuman: false,
  };
}

test("static channel info reports skipped readiness and a closed no-access boundary", () => {
  const selected = getChannelInfoSource("x");
  const reads: string[] = [];
  const execution = executeStaticChannelInfo("x", (channel) => {
    reads.push(channel);
    return selected;
  });

  assert.equal(execution.exitCode, 0);
  assert.deepEqual(reads, ["x"]);
  assert.equal(execution.envelope.schemaVersion, CHANNEL_INFO_SCHEMA_VERSION);
  assert.equal(execution.envelope.mode, "static");
  assert.equal(execution.envelope.channel, "x");
  assert.equal(execution.envelope.info.channel, "x");
  assert.deepEqual(execution.envelope.readiness, {
    available: false,
    state: "skipped",
    reason: "static_requested",
  });
  assert.deepEqual(execution.envelope.access, {
    readinessProbe: "skipped",
    profileAccessAttempted: false,
    browserLaunchAttempted: false,
    networkAccessAttempted: false,
    tokenAccessAttempted: false,
    apiAccessAttempted: false,
    platformAccessAttempted: false,
  });
  const rendered = renderChannelInfo(execution.envelope);
  assert.match(rendered, /Readiness: skipped \(--static\); unavailable/);
  assert.match(rendered, /did not inspect a profile or token, launch a browser, use the network\/API, or access x/);
  assert.doesNotMatch(rendered, /readiness\.ready\/status/);
});

test("default channel info preserves readiness and probes only after loading the selected source", async () => {
  const selected = getChannelInfoSource("x");
  const readiness = readyX();
  const order: string[] = [];
  const execution = await executeChannelInfo(
    "x",
    async (channel) => {
      order.push(`probe:${channel}`);
      return readiness;
    },
    () => Date.parse(CHECKED_AT),
    (channel) => {
      order.push(`source:${channel}`);
      return selected;
    },
  );

  assert.deepEqual(order, ["source:x", "probe:x"]);
  assert.equal(execution.envelope.mode, "readiness");
  assert.equal(execution.envelope.channel, "x");
  assert.strictEqual(execution.envelope.readiness, readiness);
  assert.deepEqual(execution.envelope.access, { readinessProbe: "attempted" });
});

test("selected-source loading ignores a malformed unrelated channel and bounds selected failures", () => {
  const reads: string[] = [];
  const sourceDirectory = "/private/operator/capabilities";
  const readSource = (path: string): string => {
    reads.push(basename(path));
    if (basename(path) === "xhs.md") return sourceMarkdown("xhs", "Xiaohongshu");
    if (basename(path) === "reddit.md") return "SECRET malformed reddit source";
    throw new Error("SECRET unrelated read");
  };

  const xhs = getChannelInfoSource("xhs", { sourceDirectory, readSource });
  assert.equal(xhs.channel, "xhs");
  assert.deepEqual(reads, ["xhs.md"]);

  assert.throws(
    () => getChannelInfoSource("reddit", { sourceDirectory, readSource }),
    (error: unknown) => {
      if (!(error instanceof ChannelInfoSourceError)) return false;
      assert.equal(error.code, "channel_info_source_invalid");
      assert.equal(error.channel, "reddit");
      assert.equal(error.message, "capabilities/reddit.md: selected channel info source is invalid.");
      assert.doesNotMatch(JSON.stringify(error), /SECRET|\/private\/operator/);
      return true;
    },
  );
  assert.deepEqual(reads, ["xhs.md", "reddit.md"]);
});

test("a malformed selected source fails before the default readiness probe", async () => {
  let probeCalls = 0;
  await assert.rejects(
    executeChannelInfo(
      "reddit",
      async () => {
        probeCalls += 1;
        throw new Error("probe must not run");
      },
      Date.now,
      () => {
        throw new ChannelInfoSourceError("reddit", "channel_info_source_invalid");
      },
    ),
    (error: unknown) => error instanceof ChannelInfoSourceError && error.code === "channel_info_source_invalid",
  );
  assert.equal(probeCalls, 0);
});

test("static CLI JSON stays offline for browser and API channels and creates no profile/token state", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-static-info-"));
  const dataDir = join(dir, "must-remain-absent");
  try {
    for (const channel of ["x", "wechat"] as const) {
      const result = spawnSync(
        process.execPath,
        [CLI_PATH, channel, "info", "--static", "--json"],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            PUBLISH_DATA_DIR: dataDir,
            WECHAT_APP_ID: "must-not-be-used",
            WECHAT_APP_SECRET: "must-not-be-used",
            WECHAT_PROXY_URL: "http://127.0.0.1:1",
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(envelope.schemaVersion, CHANNEL_INFO_SCHEMA_VERSION);
      assert.equal(envelope.mode, "static");
      assert.equal(envelope.channel, channel);
      assert.deepEqual(envelope.readiness, {
        available: false,
        state: "skipped",
        reason: "static_requested",
      });
      assert.deepEqual(envelope.access, {
        readinessProbe: "skipped",
        profileAccessAttempted: false,
        browserLaunchAttempted: false,
        networkAccessAttempted: false,
        tokenAccessAttempted: false,
        apiAccessAttempted: false,
        platformAccessAttempted: false,
      });
      assert.doesNotMatch(result.stdout, /must-not-be-used|127\.0\.0\.1/);
    }
    assert.equal(existsSync(dataDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

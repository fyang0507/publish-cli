import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeWechatDraftRealRun,
  receiptForWechatStageFailure,
  receiptForWechatStageSuccess,
} from "../commands/wechat-draft.js";
import { generateArticle, type GeneratedArticle } from "./content.js";
import {
  snapshotStageArticleResult,
  snapshotWeChatDraftStageError,
  stageArticleDraft,
} from "./draft.js";
import { WeChatApiError, type WeChatClient } from "./client.js";
import { GENERATED_DRAFT_ARRAY_MAX } from "../draftSnapshot.js";

function png(width: number, height: number): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function articleFixture(bodyCount: number): { dir: string; article: GeneratedArticle } {
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-receipt-"));
  const cover = join(dir, "cover.png");
  writeFileSync(cover, png(900, 900));
  const bodyPaths = Array.from({ length: bodyCount }, (_, index) => {
    const path = join(dir, `body-${index}.png`);
    writeFileSync(path, png(640, 480));
    return path;
  });
  const markdown = [
    "Body",
    ...bodyPaths.map((path, index) => `![body ${index}](${path})`),
  ].join("\n\n");
  return {
    dir,
    article: generateArticle(markdown, { title: "Receipt", cover, baseDir: dir }),
  };
}

function fakeClient(input: {
  body?: (path: string, index: number) => Promise<string>;
  draft?: () => Promise<string>;
  close?: () => Promise<void>;
} = {}): WeChatClient {
  let bodyIndex = 0;
  return {
    async ensureToken() { return "token"; },
    async uploadCover() { return "cover-ref"; },
    async uploadBodyImage(path) {
      const index = bodyIndex++;
      return input.body ? input.body(path, index) : `https://mmbiz.qpic.cn/body-${index}`;
    },
    async addDraft() { return input.draft ? input.draft() : "draft-ref"; },
    async checkAccess() { throw new Error("not used"); },
    async close() { if (input.close) await input.close(); },
  };
}

async function captureStageFailure(client: WeChatClient, article: GeneratedArticle) {
  let thrown: unknown;
  try {
    await stageArticleDraft(client, article);
  } catch (error) {
    thrown = error;
  }
  const snapshot = snapshotWeChatDraftStageError(thrown);
  assert.ok(snapshot, "expected a genuine typed WeChat stage error");
  return { thrown, snapshot };
}

test("WeChat stage result is frozen and reports ordered successful upload evidence", async () => {
  const fixture = articleFixture(2);
  try {
    const result = await stageArticleDraft(fakeClient(), fixture.article);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.uploadedImages));
    assert.ok(Object.isFrozen(result.progress));
    assert.ok(Object.isFrozen(result.progress.uploadedBodyImages));
    assert.equal(result.progress.phase, "complete");
    assert.equal(result.progress.thumbMediaId, "cover-ref");
    assert.equal(result.progress.draftMediaId, "draft-ref");
    assert.deepEqual(
      result.progress.uploadedBodyImages.map(({ index, remoteReference }) => ({ index, remoteReference })),
      [
        { index: 0, remoteReference: "https://mmbiz.qpic.cn/body-0" },
        { index: 1, remoteReference: "https://mmbiz.qpic.cn/body-1" },
      ],
    );
    assert.ok(snapshotStageArticleResult(result, fixture.article));

    const receipt = receiptForWechatStageSuccess(fixture.article, result);
    assert.equal(receipt.exit.code, 0);
    assert.equal(receipt.verification.nativeReference, "draft-ref");
    assert.equal(receipt.verification.strength, "native_id_returned");
    assert.deepEqual(receipt.assets.map((asset) => asset.remoteReference), [
      "cover-ref",
      "https://mmbiz.qpic.cn/body-0",
      "https://mmbiz.qpic.cn/body-1",
    ]);
    assert.equal(receipt.published, false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("WeChat explicit body rejection preserves cover and prior body refs without leaking platform secrets", async () => {
  const fixture = articleFixture(2);
  try {
    const { thrown, snapshot } = await captureStageFailure(fakeClient({
      async body(_path, index) {
        if (index === 1) {
          throw new WeChatApiError(
            45009,
            "quota exceeded\naccess_token=RAW_PLATFORM_SECRET",
            "/cgi-bin/media/uploadimg?access_token=RAW_URL_SECRET",
            200,
          );
        }
        return "https://mmbiz.qpic.cn/first";
      },
    }), fixture.article);
    assert.equal(snapshot.phase, "body_image_upload");
    assert.equal(snapshot.failureKind, "api_rejection");
    assert.equal(snapshot.platformCode, "45009");
    assert.equal(snapshot.progress.thumbMediaId, "cover-ref");
    assert.equal(snapshot.progress.bodyUploadAttemptedCount, 2);
    assert.deepEqual(snapshot.progress.uploadedBodyImages, [
      { index: 0, remoteReference: "https://mmbiz.qpic.cn/first" },
    ]);
    assert.ok(Object.isFrozen(snapshot.progress));
    assert.doesNotMatch(String((thrown as Error).message), /RAW_PLATFORM_SECRET|RAW_URL_SECRET/);

    const receipt = receiptForWechatStageFailure(fixture.article, snapshot);
    assert.equal(receipt.terminalState, "platform_rejected");
    assert.deepEqual(receipt.assets.map((asset) => asset.uploaded), [true, true, false]);
    assert.deepEqual(receipt.remoteResidue.map((entry) => entry.assetIndex), [0, 1]);
    assert.doesNotMatch(JSON.stringify(receipt), /RAW_PLATFORM_SECRET|RAW_URL_SECRET/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("WeChat malformed returned body reference retains earlier progress as delivery unknown", async () => {
  const fixture = articleFixture(2);
  try {
    const { snapshot } = await captureStageFailure(fakeClient({
      async body(_path, index) {
        return index === 0 ? "https://mmbiz.qpic.cn/first" : "";
      },
    }), fixture.article);
    assert.equal(snapshot.phase, "body_image_upload");
    assert.equal(snapshot.failureKind, "delivery_unknown");
    assert.equal(snapshot.progress.thumbMediaId, "cover-ref");
    assert.equal(snapshot.progress.bodyUploadAttemptedCount, 2);
    assert.deepEqual(snapshot.progress.uploadedBodyImages, [
      { index: 0, remoteReference: "https://mmbiz.qpic.cn/first" },
    ]);

    const receipt = receiptForWechatStageFailure(fixture.article, snapshot);
    assert.equal(receipt.terminalState, "no_native_draft");
    assert.deepEqual(receipt.assets.map((asset) => asset.uploaded), [true, true, null]);
    assert.deepEqual(receipt.remoteResidue.map((entry) => entry.assetIndex), [0, 1, 2]);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("WeChat draft/add unknown delivery is distinct from an explicit rejection", async () => {
  const fixture = articleFixture(1);
  try {
    const unknown = await captureStageFailure(fakeClient({
      async draft() { throw new Error("Bearer RAW_UNTYPED_SECRET"); },
    }), fixture.article);
    assert.equal(unknown.snapshot.phase, "draft_add");
    assert.equal(unknown.snapshot.failureKind, "delivery_unknown");
    assert.equal(unknown.snapshot.progress.draftAddAttempted, true);
    const unknownReceipt = receiptForWechatStageFailure(fixture.article, unknown.snapshot);
    assert.equal(unknownReceipt.terminalState, "native_draft_possible");
    assert.equal(unknownReceipt.exit.code, 1);
    assert.ok(unknownReceipt.remoteResidue.some((entry) =>
      entry.kind === "native_draft" && entry.retryRisk === "duplicate"));
    assert.doesNotMatch(JSON.stringify(unknownReceipt), /RAW_UNTYPED_SECRET/);

    const rejected = await captureStageFailure(fakeClient({
      async draft() {
        throw new WeChatApiError(40007, "invalid media", "/cgi-bin/draft/add", 200);
      },
    }), fixture.article);
    assert.equal(rejected.snapshot.failureKind, "api_rejection");
    const rejectedReceipt = receiptForWechatStageFailure(fixture.article, rejected.snapshot);
    assert.equal(rejectedReceipt.terminalState, "platform_rejected");
    assert.equal(rejectedReceipt.remoteResidue.some((entry) => entry.kind === "native_draft"), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("maximum body uploads plus ambiguous draft/add fit the bounded receipt", async () => {
  const fixture = articleFixture(1);
  try {
    const seed = fixture.article.bodyImages[0]!;
    const article: GeneratedArticle = {
      ...fixture.article,
      bodyImages: Array.from({ length: GENERATED_DRAFT_ARRAY_MAX }, () => seed),
    };
    const { snapshot } = await captureStageFailure(fakeClient({
      async draft() { throw new RangeError("hostile draft/add transport detail"); },
    }), article);
    assert.equal(snapshot.phase, "draft_add");
    assert.equal(snapshot.failureKind, "delivery_unknown");
    assert.equal(snapshot.progress.uploadedBodyImages.length, GENERATED_DRAFT_ARRAY_MAX);

    const receipt = receiptForWechatStageFailure(article, snapshot);
    assert.equal(receipt.terminalState, "native_draft_possible");
    assert.equal(receipt.evidenceSummary.assets.total, GENERATED_DRAFT_ARRAY_MAX + 1);
    assert.equal(receipt.evidenceSummary.remoteResidue.total, GENERATED_DRAFT_ARRAY_MAX + 2);
    assert.equal(receipt.evidenceSummary.remoteResidue.listed, 100);
    assert.equal(receipt.evidenceSummary.remoteResidue.omitted, GENERATED_DRAFT_ARRAY_MAX - 98);
    assert.match(receipt.evidenceSummary.remoteResidue.fullSetSha256, /^[0-9a-f]{64}$/);
    assert.ok(receipt.remoteResidue.some((entry) =>
      entry.kind === "asset" && entry.assetIndex === 0));
    assert.ok(receipt.remoteResidue.some((entry) =>
      entry.kind === "native_draft" && entry.state === "draft_add_delivery_unknown"));
    assert.doesNotMatch(JSON.stringify(receipt), /hostile draft\/add transport detail/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("WeChat lifecycle guards client creation and retains native success across cleanup failure", async () => {
  const fixture = articleFixture(0);
  try {
    let createCloseCalls = 0;
    const createFailed = await executeWechatDraftRealRun(fixture.article, {
      async createClient() { throw new Error("local egress secret"); },
      async stage() { throw new Error("must not run"); },
      snapshotStageError: snapshotWeChatDraftStageError,
      snapshotStageResult: snapshotStageArticleResult,
    });
    assert.deepEqual(createFailed, {
      kind: "runtime_failed",
      stage: "client_create",
      platformTouched: false,
      nativeDraftPossible: false,
      cleanupFailed: false,
    });

    const client = fakeClient({
      async close() {
        createCloseCalls += 1;
        throw new Error("cleanup secret");
      },
    });
    const staged = await executeWechatDraftRealRun(fixture.article, {
      async createClient() { return client; },
      stage: stageArticleDraft,
      snapshotStageError: snapshotWeChatDraftStageError,
      snapshotStageResult: snapshotStageArticleResult,
    });
    assert.equal(staged.kind, "staged");
    assert.equal(staged.cleanupFailed, true);
    assert.equal(createCloseCalls, 1);
    if (staged.kind !== "staged") assert.fail("expected staged outcome");
    const receipt = receiptForWechatStageSuccess(fixture.article, staged.result, staged.cleanupFailed);
    assert.equal(receipt.exit.code, 1);
    assert.equal(receipt.terminalState, "native_draft_verified");
    assert.equal(receipt.verification.nativeReference, "draft-ref");
    assert.equal(receipt.remoteResidue[0]?.retryRisk, "duplicate");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("WeChat lifecycle still closes the client when either hostile snapshot port throws", async () => {
  const fixture = articleFixture(0);
  try {
    let closeCalls = 0;
    for (const stageThrows of [false, true]) {
      const client = fakeClient({ async close() { closeCalls += 1; } });
      const outcome = await executeWechatDraftRealRun(fixture.article, {
        async createClient() { return client; },
        async stage() {
          if (stageThrows) throw new Error("hostile stage error");
          return {};
        },
        snapshotStageError() { throw new Error("hostile error snapshot"); },
        snapshotStageResult() { throw new Error("hostile result snapshot"); },
      });
      assert.equal(outcome.kind, "runtime_failed");
      if (outcome.kind !== "runtime_failed") assert.fail("expected runtime failure");
      assert.equal(outcome.stage, stageThrows ? "stage_unknown" : "stage_result");
      assert.equal(outcome.platformTouched, true);
      assert.equal(outcome.nativeDraftPossible, true);
      assert.equal(outcome.cleanupFailed, false);
    }
    assert.equal(closeCalls, 2);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

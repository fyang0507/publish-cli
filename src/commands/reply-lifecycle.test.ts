import test from "node:test";
import assert from "node:assert/strict";
import {
  executeReplyRealRun,
  type ReplyLedgerPort,
  type ReplyRealRunDependencies,
  type ReplyRealRunInput,
} from "./reply.js";
import type { ReplyLedgerEntry } from "../db.js";
import type { GeneratedContent } from "../x/content.js";
import type { StageReplyResult } from "../x/draftPoster.js";

const TARGET_ID = "1234567890123456789";
const TARGET_URL = `https://x.com/operator/status/${TARGET_ID}`;

const CONTENT: GeneratedContent = {
  format: "tweet",
  limit: 280,
  tweet: {
    text: "Offline reply lifecycle fixture.",
    chars: 32,
    unit: "twitter_text_weighted",
  },
  codeFlags: [],
  linkFlags: [],
  fidelityFlags: [],
  warnings: [],
};

const PRIOR: ReplyLedgerEntry = {
  targetTweetId: TARGET_ID,
  stagedAt: "2026-09-03T00:00:00.000Z",
  status: "staged",
  draftRef: null,
};

interface HarnessOptions {
  prior?: ReplyLedgerEntry;
  verified?: boolean;
  openFails?: boolean;
  findFails?: boolean;
  loadStageFails?: boolean;
  stageFails?: boolean;
  stageReturnsUndefined?: boolean;
  recordFails?: boolean;
  closeFails?: boolean;
}

interface Harness {
  deps: ReplyRealRunDependencies;
  events: string[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const deps: ReplyRealRunDependencies = {
    async openLedger() {
      events.push("ledger:open");
      if (options.openFails) throw new Error("RAW_OPEN_ERROR_WITH_PRIVATE_PATH");
      const ledger: ReplyLedgerPort = {
        find(targetTweetId) {
          events.push(`ledger:find:${targetTweetId}`);
          if (options.findFails) throw new Error("RAW_FIND_ERROR_WITH_PRIVATE_PATH");
          return options.prior;
        },
        record(targetTweetId, recordOptions) {
          events.push(`ledger:record:${targetTweetId}:${recordOptions?.status ?? "missing"}`);
          if (options.recordFails) throw new Error("RAW_RECORD_ERROR_WITH_PRIVATE_PATH");
        },
        close() {
          events.push("ledger:close");
          if (options.closeFails) throw new Error("RAW_CLOSE_ERROR_WITH_PRIVATE_PATH");
        },
      };
      return ledger;
    },
    async loadStageReplyDraft() {
      events.push("stage:load");
      if (options.loadStageFails) throw new Error("RAW_STAGE_LOAD_ERROR_WITH_PRIVATE_PATH");
      return async (content, targetIdOrUrl, stageOptions): Promise<StageReplyResult> => {
        events.push(`stage:run:${targetIdOrUrl}:${content.format}`);
        assert.deepEqual(stageOptions, { inspect: true });
        assert.equal("force" in stageOptions, false, "dedupe --force must not become session force");
        if (options.stageFails) throw new Error("NATIVE_STAGE_ERROR");
        if (options.stageReturnsUndefined) return undefined as unknown as StageReplyResult;
        return {
          format: content.format,
          posts: content.format === "thread" ? (content.thread?.length ?? 0) : 1,
          verified: options.verified ?? false,
          note: "Offline injected stage result.",
          replyToId: TARGET_ID,
        };
      };
    },
  };
  return { deps, events };
}

function input(overrides: Partial<ReplyRealRunInput> = {}): ReplyRealRunInput {
  return {
    content: CONTENT,
    targetIdOrUrl: TARGET_URL,
    replyToId: TARGET_ID,
    inspect: true,
    ...overrides,
  };
}

test("post-stage ledger record failure closes once and requires same-profile comparison", async () => {
  for (const [verified, status, draftEvidence] of [
    [false, "staged-unverified", /native draft may exist/i],
    [true, "staged", /native draft was verified in X Unsent\/Drafts/i],
  ] as const) {
    const harness = createHarness({ recordFails: true, verified });
    const outcome = await executeReplyRealRun(input(), harness.deps);

    assert.deepEqual(harness.events, [
      "ledger:open",
      `ledger:find:${TARGET_ID}`,
      "stage:load",
      `stage:run:${TARGET_URL}:tweet`,
      `ledger:record:${TARGET_ID}:${status}`,
      "ledger:close",
    ]);
    assert.equal(outcome.kind, "ledger_persistence_failed");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.stream, "stderr");
    assert.match(outcome.message, new RegExp(`native staging flow returned for target ${TARGET_ID}`));
    assert.match(outcome.message, draftEvidence);
    assert.match(outcome.message, /reply-ledger record could not be confirmed/);
    assert.match(
      outcome.message,
      /Do not retry automatically.*compare X Unsent\/Drafts manually in the same CLI-owned profile/s,
    );
    assert.doesNotMatch(
      outcome.message,
      /Failed to stage|selector|--inspect|RAW_RECORD_ERROR_WITH_PRIVATE_PATH|NATIVE_STAGE_ERROR/,
    );
  }
});

test("native staging failure never records and retains its own classification", async () => {
  const harness = createHarness({ stageFails: true });
  const outcome = await executeReplyRealRun(input(), harness.deps);

  assert.deepEqual(harness.events, [
    "ledger:open",
    `ledger:find:${TARGET_ID}`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    "ledger:close",
  ]);
  assert.equal(outcome.kind, "native_stage_failed");
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.message, /Failed to stage the X reply draft: NATIVE_STAGE_ERROR/);
  assert.match(outcome.message, /selectors.*--inspect/s);
  assert.doesNotMatch(outcome.message, /ledger persistence failed|record could not be confirmed/);
});

test("an unusable post-stage result is safety-classified without writing the ledger", async () => {
  const harness = createHarness({ stageReturnsUndefined: true, closeFails: true });
  const outcome = await executeReplyRealRun(input(), harness.deps);

  assert.deepEqual(harness.events, [
    "ledger:open",
    `ledger:find:${TARGET_ID}`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    "ledger:close",
  ]);
  assert.equal(outcome.kind, "stage_result_inconclusive");
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.message, /native draft may exist/i);
  assert.match(outcome.message, /no reply-ledger record was written/);
  assert.match(outcome.message, /compare X Unsent\/Drafts manually in the same CLI-owned profile/);
  assert.match(outcome.message, /reply ledger also failed to close/);
  assert.doesNotMatch(outcome.message, /ledger.*read|selector|--inspect|RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/);
});

test("successful staging records verified and unverified states before one close", async () => {
  for (const [verified, status, evidence] of [
    [true, "staged", /verified in Unsent\/Drafts: yes/],
    [false, "staged-unverified", /verified in Unsent\/Drafts: unconfirmed/],
  ] as const) {
    const harness = createHarness({ verified });
    const outcome = await executeReplyRealRun(input(), harness.deps);

    assert.deepEqual(harness.events, [
      "ledger:open",
      `ledger:find:${TARGET_ID}`,
      "stage:load",
      `stage:run:${TARGET_URL}:tweet`,
      `ledger:record:${TARGET_ID}:${status}`,
      "ledger:close",
    ]);
    assert.equal(outcome.kind, "staged");
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.stream, "stdout");
    assert.match(outcome.message, /Staged a NATIVE X reply draft.*NEVER posted/s);
    assert.match(outcome.message, evidence);
  }
});

test("a known duplicate stops before X unless --force explicitly bypasses it", async () => {
  const duplicate = createHarness({ prior: PRIOR });
  const refused = await executeReplyRealRun(input(), duplicate.deps);
  assert.deepEqual(duplicate.events, [
    "ledger:open",
    `ledger:find:${TARGET_ID}`,
    "ledger:close",
  ]);
  assert.equal(refused.kind, "duplicate");
  assert.equal(refused.exitCode, 2);
  assert.match(refused.message, /Refusing to stage a duplicate reply.*--force/s);

  const forced = createHarness({ prior: PRIOR, verified: true });
  const staged = await executeReplyRealRun(input({ force: true }), forced.deps);
  assert.deepEqual(forced.events, [
    "ledger:open",
    `ledger:find:${TARGET_ID}`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    `ledger:record:${TARGET_ID}:staged`,
    "ledger:close",
  ]);
  assert.equal(staged.kind, "staged");
  assert.equal(staged.exitCode, 0);
});

test("ledger open, find, and stage-runtime failures stop before X and close when acquired", async () => {
  const open = createHarness({ openFails: true });
  const openOutcome = await executeReplyRealRun(input(), open.deps);
  assert.deepEqual(open.events, ["ledger:open"]);
  assert.equal(openOutcome.kind, "ledger_preflight_failed");
  assert.match(openOutcome.message, /No native staging was attempted/);
  assert.doesNotMatch(openOutcome.message, /RAW_OPEN_ERROR_WITH_PRIVATE_PATH/);

  const find = createHarness({ findFails: true });
  const findOutcome = await executeReplyRealRun(input({ force: true }), find.deps);
  assert.deepEqual(find.events, [
    "ledger:open",
    `ledger:find:${TARGET_ID}`,
    "ledger:close",
  ]);
  assert.equal(findOutcome.kind, "ledger_preflight_failed");
  assert.match(findOutcome.message, /No native staging was attempted/);
  assert.doesNotMatch(findOutcome.message, /RAW_FIND_ERROR_WITH_PRIVATE_PATH|--force/);

  const loader = createHarness({ loadStageFails: true });
  const loadOutcome = await executeReplyRealRun(input(), loader.deps);
  assert.deepEqual(loader.events, [
    "ledger:open",
    `ledger:find:${TARGET_ID}`,
    "stage:load",
    "ledger:close",
  ]);
  assert.equal(loadOutcome.kind, "stage_runtime_failed");
  assert.match(loadOutcome.message, /No native staging was attempted/);
  assert.doesNotMatch(loadOutcome.message, /RAW_STAGE_LOAD_ERROR_WITH_PRIVATE_PATH|selector|--inspect/);
});

test("close failure after successful stage and record becomes a post-stage safety stop", async () => {
  const harness = createHarness({ verified: true, closeFails: true });
  const outcome = await executeReplyRealRun(input(), harness.deps);

  assert.deepEqual(harness.events, [
    "ledger:open",
    `ledger:find:${TARGET_ID}`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    `ledger:record:${TARGET_ID}:staged`,
    "ledger:close",
  ]);
  assert.equal(outcome.kind, "ledger_persistence_failed");
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.message, /native draft was verified in X Unsent\/Drafts/i);
  assert.match(outcome.message, /reply ledger did not close cleanly after its record was written/);
  assert.match(outcome.message, /Before any retry, compare X Unsent\/Drafts manually in the same CLI-owned profile/);
  assert.doesNotMatch(outcome.message, /✓ Staged|Failed to stage|RAW_CLOSE_ERROR_WITH_PRIVATE_PATH|selector|--inspect/);
});

test("secondary close failures preserve record, stage, and duplicate primary facts", async () => {
  const record = createHarness({ recordFails: true, closeFails: true });
  const recordOutcome = await executeReplyRealRun(input(), record.deps);
  assert.deepEqual(record.events, [
    "ledger:open",
    `ledger:find:${TARGET_ID}`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    `ledger:record:${TARGET_ID}:staged-unverified`,
    "ledger:close",
  ]);
  assert.equal(recordOutcome.kind, "ledger_persistence_failed");
  assert.match(recordOutcome.message, /record could not be confirmed/);
  assert.match(recordOutcome.message, /Closing the reply ledger also failed/);
  assert.doesNotMatch(recordOutcome.message, /RAW_RECORD_ERROR_WITH_PRIVATE_PATH|RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/);

  const stage = createHarness({ stageFails: true, closeFails: true });
  const stageOutcome = await executeReplyRealRun(input(), stage.deps);
  assert.deepEqual(stage.events, [
    "ledger:open",
    `ledger:find:${TARGET_ID}`,
    "stage:load",
    `stage:run:${TARGET_URL}:tweet`,
    "ledger:close",
  ]);
  assert.equal(stageOutcome.kind, "native_stage_failed");
  assert.match(stageOutcome.message, /Failed to stage the X reply draft: NATIVE_STAGE_ERROR/);
  assert.match(stageOutcome.message, /reply ledger also failed to close/);
  assert.match(stageOutcome.message, /--inspect later only if the native error specifically indicates/);
  assert.doesNotMatch(stageOutcome.message, /RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/);

  const duplicate = createHarness({ prior: PRIOR, closeFails: true });
  const duplicateOutcome = await executeReplyRealRun(input(), duplicate.deps);
  assert.deepEqual(duplicate.events, [
    "ledger:open",
    `ledger:find:${TARGET_ID}`,
    "ledger:close",
  ]);
  assert.equal(duplicateOutcome.kind, "duplicate");
  assert.equal(duplicateOutcome.exitCode, 1);
  assert.match(duplicateOutcome.message, /Already staged a reply/);
  assert.match(duplicateOutcome.message, /No new native staging was attempted/);
  assert.match(duplicateOutcome.message, /do not bypass an unhealthy ledger with --force/);
  assert.doesNotMatch(duplicateOutcome.message, /Re-run with --force|RAW_CLOSE_ERROR_WITH_PRIVATE_PATH/);
});

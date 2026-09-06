import test from "node:test";
import assert from "node:assert/strict";
import {
  executeReplyRealRun,
  type ReplyLedgerPort,
  type ReplyRealRunDependencies,
  type ReplyRealRunInput,
  type ReplyRealRunOutcome,
} from "./reply.js";
import {
  X_REPLY_REQUEST_ADVISORY_CODE_UNITS_MAX,
  X_REPLY_REQUEST_ARRAY_ENTRIES_MAX,
  X_REPLY_REQUEST_TEXT_CODE_UNITS_MAX,
  snapshotXReplyRequest,
} from "./replyInputSnapshot.js";
import {
  countUnicodeCodePoints,
  countXWeightedLength,
} from "../capabilities/validation.js";
import {
  generateContent,
  type CodeBlockFidelityFlag,
  type GeneratedContent,
} from "../x/content.js";
import type {
  ReplyReservation,
  ReplyReservationClaim,
} from "../db.js";
import type { StageReplyResult } from "../x/draftPoster.js";
import type {
  XDraftRowEvidence,
  XReplyTargetEvidence,
} from "../x/saveProgress.js";
import {
  X_CODE_BLOCK_FIDELITY_NOTE,
  renderXNonArticleFidelityWarning,
} from "../x/nonArticleStageSnapshot.js";

const TARGET_A = "1234567890123456789";
const TARGET_B = "9876543210987654321";
const ORIGIN_ID = "11111111-1111-4111-8111-111111111111";
const URL_A = `https://x.com/operator/status/${TARGET_A}`;
const URL_B = `https://x.com/operator/status/${TARGET_B}`;
const RAW_CANARY = "RAW_PRIVATE_CANARY\u001b[31m /private/operator/path cookie=session-secret";

function tweetContent(text = "Snapshot-bound reply A."): GeneratedContent {
  return {
    format: "tweet",
    limit: 280,
    tweet: {
      text,
      chars: countXWeightedLength(text),
      unit: "twitter_text_weighted",
    },
    codeFlags: [],
    linkFlags: [],
    fidelityFlags: [],
    warnings: [],
  };
}

function premiumTweetContent(text = "Premium snapshot-bound reply A."): GeneratedContent {
  return {
    format: "tweet",
    limit: 25_000,
    tweet: {
      text,
      chars: countUnicodeCodePoints(text),
      unit: "unicode_code_points_transport_policy",
    },
    codeFlags: [],
    linkFlags: [],
    fidelityFlags: [],
    warnings: [],
  };
}

function fidelityFlag(): CodeBlockFidelityFlag {
  return {
    kind: "code_block",
    index: 1,
    placeholder: "[code block #1 → screenshot]",
    sourceStartLine: 3,
    sourceEndLine: 5,
    sourceLineCount: 3,
    fence: "backtick",
    closure: "explicit",
    infoString: "js",
    infoStringTruncated: false,
    preview: "run()",
    previewTruncated: false,
    digestNormalization: "lf_joined_source_lines",
    normalizedSourceSha256: "a".repeat(64),
    note: X_CODE_BLOCK_FIDELITY_NOTE,
  };
}

function richThreadContent(): GeneratedContent {
  const text = "Reply A https://example.com [code block #1 → screenshot] 1/1";
  const fidelity = fidelityFlag();
  return {
    format: "thread",
    limit: 280,
    thread: [{
      index: 1,
      total: 1,
      text,
      chars: countXWeightedLength(text),
    }],
    codeFlags: [{ index: 1, lang: "js", preview: "run()", sourceLine: 3 }],
    linkFlags: [{
      url: "https://example.com",
      text: "example",
      note: "Keep the link outside the opening post.",
    }],
    fidelityFlags: [fidelity],
    warnings: [renderXNonArticleFidelityWarning(fidelity)],
  };
}

function request(
  content: GeneratedContent = tweetContent(),
  overrides: Partial<ReplyRealRunInput> = {},
): ReplyRealRunInput {
  return {
    content,
    targetIdOrUrl: URL_A,
    replyToId: TARGET_A,
    inspect: true,
    force: false,
    ...overrides,
  };
}

function cloneRequest(value: ReplyRealRunInput): ReplyRealRunInput {
  return structuredClone(value);
}

function observedRows(visibleRowCount: number, exactFullTextMatches: number) {
  return {
    outcome: "observed" as const,
    route: "exact" as const,
    modal: "single_visible" as const,
    rows: "all_readable" as const,
    visibleModalCount: 1 as const,
    visibleRowCount,
    exactFullTextMatches,
  };
}

function verifiedRowEvidence(): Extract<XDraftRowEvidence, { status: "verified" }> {
  return {
    status: "verified",
    method: "unsent_row_full_text_delta",
    contentMatch: "visible_scoped_multiset_plus_one",
    nativeRowId: "unavailable",
    listCompleteness: "visible_scoped_rows_only",
    baseline: observedRows(1, 0),
    postSave: observedRows(2, 1),
  };
}

function verifiedTargetEvidence(): Extract<XReplyTargetEvidence, { status: "verified" }> {
  return {
    status: "verified",
    method: "same_content_row_target_id",
    scope: "current_save_attempt",
    requestedTargetId: TARGET_A,
    rowBinding: "same_content_matched_draft",
    targetMatch: "exact",
    targetContextCount: 1,
    distinctStatusIdCount: 1,
    reason: "exact_requested_target",
  };
}

function verifiedResult(format: "tweet" | "thread", posts: number): StageReplyResult {
  return {
    format,
    posts,
    note: "Offline verified result.",
    saveMechanism: "composer_close_save",
    savePhase: "verified",
    replyToId: TARGET_A,
    draftRowEvidence: verifiedRowEvidence(),
    replyTargetEvidence: verifiedTargetEvidence(),
  };
}

function zeroPortDependencies(events: string[]): ReplyRealRunDependencies {
  return {
    async openLedger() {
      events.push("ledger:open");
      throw new Error(RAW_CANARY);
    },
    async loadStageReplyDraft() {
      events.push("stage:load");
      throw new Error(RAW_CANARY);
    },
  };
}

function assertLocalInvalid(outcome: ReplyRealRunOutcome, events: readonly string[]): void {
  assert.equal(outcome.kind, "reply_input_invalid");
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.stream, "stderr");
  assert.equal(outcome.savePhase, null);
  assert.equal(outcome.saveMechanism, null);
  assert.equal(outcome.draftRowEvidence, null);
  assert.equal(outcome.replyTargetEvidence, null);
  assert.deepEqual(events, []);
  assert.match(outcome.message, /failed closed local snapshot validation/i);
  assert.match(outcome.message, /No reply ledger, runtime loader, profile, browser/i);
  assert.doesNotMatch(outcome.message, /RAW_|PRIVATE|cookie|session-secret|operator\/path/);
  assert.ok(outcome.message.length < 600);
}

async function rejectBeforePorts(value: unknown): Promise<void> {
  const events: string[] = [];
  const outcome = await executeReplyRealRun(
    value as ReplyRealRunInput,
    zeroPortDependencies(events),
  );
  assertLocalInvalid(outcome, events);
}

function assertDeepFrozenReplyContent(content: GeneratedContent): void {
  assert.equal(Object.isFrozen(content), true);
  assert.equal(Object.isFrozen(content.codeFlags), true);
  assert.equal(Object.isFrozen(content.linkFlags), true);
  assert.equal(Object.isFrozen(content.fidelityFlags), true);
  assert.equal(Object.isFrozen(content.warnings), true);
  if (content.tweet) assert.equal(Object.isFrozen(content.tweet), true);
  if (content.thread) {
    assert.equal(Object.isFrozen(content.thread), true);
    assert.equal(content.thread.every((row) => Object.isFrozen(row)), true);
  }
  assert.equal(content.codeFlags.every((flag) => Object.isFrozen(flag)), true);
  assert.equal(content.linkFlags.every((flag) => Object.isFrozen(flag)), true);
  assert.equal(content.fidelityFlags.every((flag) => Object.isFrozen(flag)), true);
}

test("valid tweet, Premium tweet, thread, and benign DAG requests detach and deep-freeze", () => {
  for (const content of [tweetContent(), premiumTweetContent(), richThreadContent()]) {
    const original = request(content);
    const snapshot = snapshotXReplyRequest(original);
    assert.ok(snapshot);
    assert.notEqual(snapshot, original);
    assert.notEqual(snapshot.content, original.content);
    assert.equal(snapshot.targetIdOrUrl, URL_A);
    assert.equal(snapshot.replyToId, TARGET_A);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.claimOptions), true);
    assert.equal(Object.isFrozen(snapshot.stageOptions), true);
    assertDeepFrozenReplyContent(snapshot.content);
    if (content.tweet) assert.notEqual(snapshot.content.tweet, content.tweet);
    if (content.thread) assert.notEqual(snapshot.content.thread, content.thread);
  }

  const shared: never[] = [];
  const dag = tweetContent();
  dag.codeFlags = shared;
  dag.linkFlags = shared;
  dag.fidelityFlags = shared;
  dag.warnings = shared;
  const dagSnapshot = snapshotXReplyRequest(request(dag));
  assert.ok(dagSnapshot);
  assert.notEqual(dagSnapshot.content.codeFlags, dagSnapshot.content.linkFlags);
  assert.notEqual(dagSnapshot.content.linkFlags, dagSnapshot.content.fidelityFlags);
  assert.notEqual(dagSnapshot.content.fidelityFlags, dagSnapshot.content.warnings);
});

test("actual generated code/link/fidelity output and preserved long whitespace remain compatible", async () => {
  const generated = await generateContent(
    [
      "# Omitted heading",
      "",
      "Reply prose with [a link](https://example.com).",
      "",
      "```js",
      "run()",
      "```",
      " ".repeat(700),
      "Tail prose.",
    ].join("\n"),
    { format: "thread" },
  );
  assert.equal(generated.format, "thread");
  assert.ok((generated.thread?.length ?? 0) > 1);
  assert.ok(generated.codeFlags.length > 0);
  assert.ok(generated.linkFlags.length > 0);
  assert.ok(generated.fidelityFlags.length > 0);
  const snapshot = snapshotXReplyRequest(request(generated));
  assert.ok(snapshot);
  assert.deepEqual(snapshot.content, generated);
  assert.notEqual(snapshot.content, generated);

  const whitespaceOnly = richThreadContent();
  whitespaceOnly.thread = [{
    index: 1,
    total: 1,
    text: "  1/1",
    chars: countXWeightedLength("  1/1"),
  }];
  whitespaceOnly.codeFlags = [];
  whitespaceOnly.linkFlags = [];
  whitespaceOnly.fidelityFlags = [];
  whitespaceOnly.warnings = [];
  await rejectBeforePorts(request(whitespaceOnly));

  const preservedMiddleWhitespace: GeneratedContent = {
    format: "thread",
    limit: 280,
    thread: ["A 1/3", "   2/3", "B 3/3"].map((text, index) => ({
      index: index + 1,
      total: 3,
      text,
      chars: countXWeightedLength(text),
    })),
    codeFlags: [],
    linkFlags: [],
    fidelityFlags: [],
    warnings: [],
  };
  assert.ok(snapshotXReplyRequest(request(preservedMiddleWhitespace)));

  const oversizedOmission = await generateContent(
    `Intro prose line.\n\n## ${"h".repeat(60_000)}\n\nTail prose.`,
    { format: "tweet" },
  );
  assert.ok(oversizedOmission.warnings[0].length > X_REPLY_REQUEST_TEXT_CODE_UNITS_MAX);
  assert.ok(
    oversizedOmission.fidelityFlags[0].kind !== "code_block" &&
      oversizedOmission.fidelityFlags[0].source.length > X_REPLY_REQUEST_TEXT_CODE_UNITS_MAX,
  );
  const oversizedSnapshot = snapshotXReplyRequest(request(oversizedOmission));
  assert.ok(oversizedSnapshot);
  assert.deepEqual(oversizedSnapshot.content, oversizedOmission);
  assertDeepFrozenReplyContent(oversizedSnapshot.content);

  let stagedOversized: GeneratedContent | undefined;
  const oversizedOutcome = await executeReplyRealRun(request(oversizedOmission), {
    async openLedger() {
      return {
        claimReservation() {
          return {
            kind: "acquired",
            reservation: {
              targetTweetId: TARGET_A,
              reservationId: "owner-oversized-advisory",
              reservedAt: "2026-09-03T12:00:00.000Z",
              originId: ORIGIN_ID,
            },
          };
        },
        releaseReservation() { return true; },
        finalizeReservation() {},
        recoverStaleReservation() { throw new Error("not used"); },
        close() {},
      };
    },
    async loadStageReplyDraft() {
      return async (content) => {
        stagedOversized = content;
        assert.equal(content.tweet?.text, oversizedOmission.tweet?.text);
        assert.deepEqual(content, oversizedOmission);
        return verifiedResult("tweet", 1);
      };
    },
  });
  assert.equal(oversizedOutcome.kind, "staged");
  assert.ok(stagedOversized);
  assert.notEqual(stagedOversized, oversizedOmission);
  const stagedWarning = stagedOversized.warnings[0];
  const stagedSource = stagedOversized.fidelityFlags[0].kind === "code_block"
    ? ""
    : stagedOversized.fidelityFlags[0].source;
  oversizedOmission.warnings[0] = RAW_CANARY;
  oversizedOmission.fidelityFlags[0].source = RAW_CANARY;
  assert.equal(stagedOversized.warnings[0], stagedWarning);
  assert.equal(
    stagedOversized.fidelityFlags[0].kind === "code_block"
      ? ""
      : stagedOversized.fidelityFlags[0].source,
    stagedSource,
  );

  const oversizedLinkLabel = "l".repeat(60_000);
  const generatedLinkMetadata = await generateContent(
    `Intro.\n\n## [${oversizedLinkLabel}](https://example.com)\n\nTail.`,
    { format: "tweet" },
  );
  assert.equal(generatedLinkMetadata.linkFlags[0].text, oversizedLinkLabel);
  const linkSnapshot = snapshotXReplyRequest(request(generatedLinkMetadata));
  assert.ok(linkSnapshot);
  assert.deepEqual(linkSnapshot.content, generatedLinkMetadata);
});

test("raw transport and aggregate advisory bounds accept the cap and reject cap plus one", async () => {
  const atCapText = "😀".repeat(25_000);
  assert.equal(atCapText.length, X_REPLY_REQUEST_TEXT_CODE_UNITS_MAX);
  assert.ok(snapshotXReplyRequest(request(premiumTweetContent(atCapText))));
  await rejectBeforePorts(request(premiumTweetContent(`${atCapText}a`)));

  const aggregateText = tweetContent();
  const aggregateFixedCodeUnits = URL_A.length + TARGET_A.length +
    aggregateText.tweet!.text.length + 1;
  const aggregateAdvisory = "u".repeat(
    X_REPLY_REQUEST_ADVISORY_CODE_UNITS_MAX - aggregateFixedCodeUnits,
  );
  aggregateText.linkFlags = [{ url: aggregateAdvisory, note: "n" }];
  const aggregateSnapshot = snapshotXReplyRequest(request(aggregateText));
  assert.ok(aggregateSnapshot);
  assert.equal(aggregateSnapshot.content.linkFlags[0].url, aggregateAdvisory);

  const aggregateOver = tweetContent();
  aggregateOver.linkFlags = [{ url: aggregateAdvisory, note: "nn" }];
  await rejectBeforePorts(request(aggregateOver));

  const sharedFlag = Object.freeze({ url: "https://example.com", note: "bounded" });
  const arrayAtCap = tweetContent();
  arrayAtCap.linkFlags = Array.from(
    { length: X_REPLY_REQUEST_ARRAY_ENTRIES_MAX },
    () => sharedFlag,
  );
  assert.ok(snapshotXReplyRequest(request(arrayAtCap)));
  const arrayOver = tweetContent();
  arrayOver.linkFlags = new Array(X_REPLY_REQUEST_ARRAY_ENTRIES_MAX + 1);
  await rejectBeforePorts(request(arrayOver));
});

test("root and nested proxies, accessors, exotic keys, cycles, and sparse arrays stop before ports", async () => {
  for (const location of ["root", "content", "tweet", "flags"] as const) {
    let traps = 0;
    const proxyHandler: ProxyHandler<object> = {
      getPrototypeOf() {
        traps += 1;
        return Object.prototype;
      },
      ownKeys() {
        traps += 1;
        return [];
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        return undefined;
      },
    };
    const hostile = request(tweetContent());
    if (location === "root") {
      await rejectBeforePorts(new Proxy(hostile, proxyHandler));
    } else if (location === "content") {
      hostile.content = new Proxy(hostile.content, proxyHandler) as GeneratedContent;
      await rejectBeforePorts(hostile);
    } else if (location === "tweet") {
      hostile.content.tweet = new Proxy(
        hostile.content.tweet! as object,
        proxyHandler,
      ) as unknown as NonNullable<GeneratedContent["tweet"]>;
      await rejectBeforePorts(hostile);
    } else {
      hostile.content.codeFlags = new Proxy(
        hostile.content.codeFlags,
        proxyHandler,
      ) as unknown as GeneratedContent["codeFlags"];
      await rejectBeforePorts(hostile);
    }
    assert.equal(traps, 0, location);
  }

  for (const location of ["root", "content", "array"] as const) {
    const hostile = request(tweetContent());
    const target = location === "root"
      ? hostile as object
      : location === "content"
        ? hostile.content as object
        : hostile.content.warnings as object;
    const revoked = Proxy.revocable(target, {});
    revoked.revoke();
    if (location === "root") await rejectBeforePorts(revoked.proxy);
    else if (location === "content") {
      hostile.content = revoked.proxy as GeneratedContent;
      await rejectBeforePorts(hostile);
    } else {
      hostile.content.warnings = revoked.proxy as string[];
      await rejectBeforePorts(hostile);
    }
  }

  const structuralCases: ReplyRealRunInput[] = [];
  const exoticRoot = request();
  Object.setPrototypeOf(exoticRoot, null);
  structuralCases.push(exoticRoot);
  const exoticContent = request();
  Object.setPrototypeOf(exoticContent.content, null);
  structuralCases.push(exoticContent);
  const extraRoot = request();
  (extraRoot as unknown as Record<string, unknown>).unexpected = RAW_CANARY;
  structuralCases.push(extraRoot);
  const hiddenExtra = request();
  Object.defineProperty(hiddenExtra.content, "hidden", { value: RAW_CANARY });
  structuralCases.push(hiddenExtra);
  const symbolExtra = request();
  Object.defineProperty(symbolExtra.content, Symbol("canary"), { value: RAW_CANARY });
  structuralCases.push(symbolExtra);
  const nonEnumerableKnown = request();
  Object.defineProperty(nonEnumerableKnown.content, "format", {
    value: "tweet",
    enumerable: false,
  });
  structuralCases.push(nonEnumerableKnown);
  const sparse = request();
  sparse.content.linkFlags = new Array(2);
  structuralCases.push(sparse);
  const extraArrayKey = request();
  (extraArrayKey.content.linkFlags as unknown as Record<string, unknown>).extra = RAW_CANARY;
  structuralCases.push(extraArrayKey);
  const cyclic = request();
  (cyclic.content.warnings as unknown[]).push(cyclic.content.warnings);
  structuralCases.push(cyclic);
  for (const hostile of structuralCases) await rejectBeforePorts(hostile);
});

test("enumerable prototype pollution fails at the first inherited key", () => {
  const objectKey = "__reply_snapshot_object_canary__";
  Object.defineProperty(Object.prototype, objectKey, {
    configurable: true,
    enumerable: true,
    value: RAW_CANARY,
  });
  try {
    assert.equal(snapshotXReplyRequest(request()), null);
  } finally {
    delete (Object.prototype as Record<string, unknown>)[objectKey];
  }

  const arrayKey = "__reply_snapshot_array_canary__";
  Object.defineProperty(Array.prototype, arrayKey, {
    configurable: true,
    enumerable: true,
    value: RAW_CANARY,
  });
  try {
    assert.equal(snapshotXReplyRequest(request()), null);
  } finally {
    delete (Array.prototype as unknown as Record<string, unknown>)[arrayKey];
  }
});

test("every request and nested content accessor is rejected without invocation", async () => {
  const rich = richThreadContent();
  const paths: readonly (readonly string[])[] = [
    ["content"],
    ["targetIdOrUrl"],
    ["replyToId"],
    ["inspect"],
    ["force"],
    ["content", "format"],
    ["content", "limit"],
    ["content", "thread"],
    ["content", "codeFlags"],
    ["content", "linkFlags"],
    ["content", "fidelityFlags"],
    ["content", "warnings"],
    ["content", "thread", "0"],
    ["content", "thread", "0", "index"],
    ["content", "thread", "0", "total"],
    ["content", "thread", "0", "text"],
    ["content", "thread", "0", "chars"],
    ["content", "codeFlags", "0"],
    ["content", "codeFlags", "0", "index"],
    ["content", "codeFlags", "0", "lang"],
    ["content", "codeFlags", "0", "preview"],
    ["content", "codeFlags", "0", "sourceLine"],
    ["content", "linkFlags", "0"],
    ["content", "linkFlags", "0", "url"],
    ["content", "linkFlags", "0", "text"],
    ["content", "linkFlags", "0", "note"],
    ["content", "fidelityFlags", "0"],
    ...[
      "kind",
      "index",
      "placeholder",
      "sourceStartLine",
      "sourceEndLine",
      "sourceLineCount",
      "fence",
      "closure",
      "infoString",
      "infoStringTruncated",
      "preview",
      "previewTruncated",
      "digestNormalization",
      "normalizedSourceSha256",
      "note",
    ].map((key) => ["content", "fidelityFlags", "0", key] as const),
    ["content", "warnings", "0"],
  ];

  for (const path of paths) {
    const hostile = request(structuredClone(rich));
    let owner: Record<PropertyKey, unknown> = hostile as unknown as Record<PropertyKey, unknown>;
    for (const key of path.slice(0, -1)) {
      owner = owner[key] as Record<PropertyKey, unknown>;
    }
    let reads = 0;
    Object.defineProperty(owner, path.at(-1)!, {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(RAW_CANARY);
      },
    });
    await rejectBeforePorts(hostile);
    assert.equal(reads, 0, path.join("."));
  }
});

test("target, discriminant, count, measurement, numbering, and advisory contradictions reject locally", async () => {
  const cases: Array<{ name: string; mutate(value: ReplyRealRunInput): void }> = [
    { name: "target mismatch", mutate(value) { value.replyToId = TARGET_B; } },
    { name: "invalid target", mutate(value) { value.targetIdOrUrl = `https://evil.test/status/${TARGET_A}`; } },
    { name: "inspect type", mutate(value) { (value as unknown as { inspect: unknown }).inspect = "yes"; } },
    { name: "force type", mutate(value) { (value as unknown as { force: unknown }).force = 1; } },
    { name: "article format", mutate(value) { value.content.format = "article"; delete value.content.tweet; } },
    { name: "dual payload", mutate(value) { value.content.thread = []; } },
    { name: "missing payload", mutate(value) { delete value.content.tweet; } },
    { name: "weighted limit", mutate(value) { value.content.limit = 279; } },
    { name: "unicode pair", mutate(value) {
      value.content.tweet!.unit = "unicode_code_points_transport_policy";
      value.content.tweet!.chars = countUnicodeCodePoints(value.content.tweet!.text);
    } },
    { name: "unsupported unit", mutate(value) { value.content.tweet!.unit = "utf16_code_units"; } },
    { name: "chars mismatch", mutate(value) { value.content.tweet!.chars += 1; } },
    { name: "chars NaN", mutate(value) { value.content.tweet!.chars = Number.NaN; } },
    { name: "limit infinity", mutate(value) { value.content.limit = Number.POSITIVE_INFINITY; } },
    { name: "empty text", mutate(value) { value.content.tweet!.text = ""; value.content.tweet!.chars = 0; } },
    { name: "blank text", mutate(value) {
      value.content.tweet!.text = " \t";
      value.content.tweet!.chars = countXWeightedLength(value.content.tweet!.text);
    } },
    { name: "edge whitespace", mutate(value) {
      value.content.tweet!.text = ` ${value.content.tweet!.text}`;
      value.content.tweet!.chars = countXWeightedLength(value.content.tweet!.text);
    } },
    { name: "tweet extra", mutate(value) {
      (value.content.tweet as unknown as Record<string, unknown>).extra = RAW_CANARY;
    } },
    { name: "warning count", mutate(value) { value.content.warnings.push("extra"); } },
  ];
  for (const fixture of cases) {
    const hostile = request(tweetContent());
    fixture.mutate(hostile);
    await rejectBeforePorts(hostile);
  }

  const threadCases: Array<{ name: string; mutate(content: GeneratedContent): void }> = [
    { name: "thread limit", mutate(content) { content.limit = 279; } },
    { name: "empty thread", mutate(content) { content.thread = []; } },
    { name: "row index", mutate(content) { content.thread![0].index = 2; } },
    { name: "row total", mutate(content) { content.thread![0].total = 2; } },
    { name: "row chars", mutate(content) { content.thread![0].chars += 1; } },
    { name: "row suffix", mutate(content) { content.thread![0].text = "Reply without numbering"; content.thread![0].chars = countXWeightedLength(content.thread![0].text); } },
    { name: "leading aggregate whitespace", mutate(content) {
      content.thread![0].text = ` ${content.thread![0].text}`;
      content.thread![0].chars = countXWeightedLength(content.thread![0].text);
    } },
    { name: "trailing aggregate whitespace", mutate(content) {
      content.thread![0].text = content.thread![0].text.replace(/ 1\/1$/u, "  1/1");
      content.thread![0].chars = countXWeightedLength(content.thread![0].text);
    } },
    { name: "row extra", mutate(content) { (content.thread![0] as unknown as Record<string, unknown>).extra = RAW_CANARY; } },
    { name: "code index", mutate(content) { content.codeFlags[0].index = 2; } },
    { name: "code source line", mutate(content) { content.codeFlags[0].sourceLine = 4; } },
    { name: "link value", mutate(content) { (content.linkFlags[0] as unknown as { url: unknown }).url = 2; } },
    { name: "fidelity lines", mutate(content) { (content.fidelityFlags[0] as CodeBlockFidelityFlag).sourceLineCount = 2; } },
    { name: "fidelity digest", mutate(content) { (content.fidelityFlags[0] as CodeBlockFidelityFlag).normalizedSourceSha256 = "bad"; } },
    { name: "fidelity count", mutate(content) { content.fidelityFlags = []; content.warnings = []; } },
  ];
  for (const fixture of threadCases) {
    const content = richThreadContent();
    fixture.mutate(content);
    await rejectBeforePorts(request(content));
  }
});

function mutateEveryCallerField(value: ReplyRealRunInput): void {
  const content = value.content;
  const row = content.thread![0];
  const code = content.codeFlags[0];
  const link = content.linkFlags[0];
  const fidelity = content.fidelityFlags[0] as CodeBlockFidelityFlag;
  value.targetIdOrUrl = URL_B;
  value.replyToId = TARGET_B;
  value.inspect = false;
  value.force = true;
  content.format = "tweet";
  content.limit = 1;
  row.index = 9;
  row.total = 9;
  row.text = `Mutated B ${RAW_CANARY}`;
  row.chars = 1;
  code.index = 9;
  code.lang = "mutated";
  code.preview = RAW_CANARY;
  code.sourceLine = 99;
  link.url = URL_B;
  link.text = RAW_CANARY;
  link.note = RAW_CANARY;
  fidelity.index = 9;
  fidelity.placeholder = RAW_CANARY;
  fidelity.sourceStartLine = 99;
  fidelity.sourceEndLine = 99;
  fidelity.sourceLineCount = 99;
  fidelity.fence = "tilde";
  fidelity.closure = "end_of_input";
  fidelity.infoString = RAW_CANARY;
  fidelity.infoStringTruncated = true;
  fidelity.preview = RAW_CANARY;
  fidelity.previewTruncated = true;
  fidelity.digestNormalization = "lf_joined_source_lines";
  fidelity.normalizedSourceSha256 = "b".repeat(64);
  fidelity.note = RAW_CANARY;
  content.warnings[0] = RAW_CANARY;
  content.thread = [{ index: 1, total: 1, text: "Mutated container B 1/1", chars: 1 }];
  content.tweet = tweetContent("Nested replacement B.").tweet;
  content.codeFlags = [];
  content.linkFlags = [];
  content.fidelityFlags = [];
  content.warnings = [];
  value.content = tweetContent("Whole content replacement B.");
}

test("open, claim, loader, stage-await, finalize, and close mutations cannot rebind request A", async () => {
  for (const boundary of ["open", "claim", "loader", "stage", "finalize", "close"] as const) {
    const caller = request(richThreadContent());
    const callerContent = caller.content;
    const callerThread = caller.content.thread!;
    const callerRow = callerThread[0];
    const callerCodeFlags = caller.content.codeFlags;
    const callerLinkFlags = caller.content.linkFlags;
    const callerFidelityFlags = caller.content.fidelityFlags;
    const callerWarnings = caller.content.warnings;
    const rawReservation: ReplyReservation = {
      targetTweetId: TARGET_A,
      reservationId: `owner-${boundary}`,
      reservedAt: "2026-09-03T12:00:00.000Z",
      originId: ORIGIN_ID,
    };
    const events: string[] = [];
    let mutated = false;
    const mutate = () => {
      if (mutated) return;
      mutated = true;
      mutateEveryCallerField(caller);
    };
    const ledger: ReplyLedgerPort = {
      claimReservation(target, options): ReplyReservationClaim {
        events.push(`claim:${target}:force=${String(options?.force)}`);
        assert.equal(target, TARGET_A);
        assert.equal(options?.force, false);
        if (boundary === "claim") mutate();
        return { kind: "acquired", reservation: rawReservation };
      },
      releaseReservation() {
        events.push("release");
        return true;
      },
      finalizeReservation(reservation, options) {
        if (boundary === "finalize") mutate();
        events.push(`finalize:${reservation.targetTweetId}:${reservation.reservationId}:${options?.status}`);
        assert.notEqual(reservation, rawReservation);
        assert.equal(Object.isFrozen(reservation), true);
        assert.equal(reservation.targetTweetId, TARGET_A);
        assert.equal(reservation.reservationId, `owner-${boundary}`);
        assert.equal(options?.status, "staged");
      },
      recoverStaleReservation() {
        throw new Error("not used");
      },
      close() {
        if (boundary === "close") mutate();
        events.push("close");
      },
    };
    const deps: ReplyRealRunDependencies = {
      async openLedger() {
        if (boundary === "open") mutate();
        events.push("open");
        return ledger;
      },
      async loadStageReplyDraft() {
        if (boundary === "loader") mutate();
        events.push("load");
        return async (content, targetIdOrUrl, options): Promise<StageReplyResult> => {
          events.push("stage");
          assert.notEqual(content, callerContent);
          assert.notEqual(content.thread, callerThread);
          assert.notEqual(content.thread![0], callerRow);
          assert.notEqual(content.codeFlags, callerCodeFlags);
          assert.notEqual(content.linkFlags, callerLinkFlags);
          assert.notEqual(content.fidelityFlags, callerFidelityFlags);
          assert.notEqual(content.warnings, callerWarnings);
          assertDeepFrozenReplyContent(content);
          assert.equal(targetIdOrUrl, URL_A);
          assert.deepEqual(options, { inspect: true });
          assert.equal(Object.isFrozen(options), true);
          assert.equal(content.format, "thread");
          assert.equal(content.limit, 280);
          assert.equal(content.thread![0].text, richThreadContent().thread![0].text);
          assert.equal(content.codeFlags[0].preview, "run()");
          assert.equal(content.linkFlags[0].url, "https://example.com");
          assert.equal((content.fidelityFlags[0] as CodeBlockFidelityFlag).index, 1);
          assert.doesNotMatch(JSON.stringify(content), /RAW_PRIVATE|session-secret/);
          await Promise.resolve();
          if (boundary === "stage") mutate();
          return verifiedResult("thread", 1);
        };
      },
    };

    const outcome = await executeReplyRealRun(caller, deps);
    assert.equal(outcome.kind, "staged", boundary);
    assert.equal(outcome.exitCode, 0, boundary);
    assert.equal(outcome.savePhase, "verified", boundary);
    assert.equal(mutated, true, boundary);
    assert.match(outcome.message, new RegExp(TARGET_A), boundary);
    assert.doesNotMatch(outcome.message, new RegExp(TARGET_B), boundary);
    assert.doesNotMatch(outcome.message, /RAW_|PRIVATE|cookie|session-secret/, boundary);
    assert.deepEqual(events, [
      "open",
      `claim:${TARGET_A}:force=false`,
      "load",
      "stage",
      `finalize:${TARGET_A}:owner-${boundary}:staged`,
      "close",
    ]);
  }
});

test("loader A-to-B substitution stages, validates, finalizes, and reports only detached A", async () => {
  const caller = request(tweetContent("Exact content A."));
  const events: string[] = [];
  let stagedContent: GeneratedContent | undefined;
  const reservation: ReplyReservation = {
    targetTweetId: TARGET_A,
    reservationId: "owner-a",
    reservedAt: "2026-09-03T12:00:00.000Z",
    originId: ORIGIN_ID,
  };
  const ledger: ReplyLedgerPort = {
    claimReservation(target) {
      events.push(`claim:${target}`);
      return { kind: "acquired", reservation };
    },
    releaseReservation() { return true; },
    finalizeReservation(owner, options) {
      events.push(`finalize:${owner.targetTweetId}:${owner.reservationId}:${options?.status}`);
    },
    recoverStaleReservation() { throw new Error("not used"); },
    close() { events.push("close"); },
  };
  const deps: ReplyRealRunDependencies = {
    async openLedger() { events.push("open"); return ledger; },
    async loadStageReplyDraft() {
      caller.content = tweetContent("Mutated content B.");
      caller.targetIdOrUrl = URL_B;
      caller.replyToId = TARGET_B;
      caller.inspect = false;
      caller.force = true;
      events.push("mutated-to-b");
      return async (content, targetIdOrUrl, options) => {
        stagedContent = content;
        events.push(`stage:${targetIdOrUrl}:${String(options.inspect)}`);
        return verifiedResult("tweet", 1);
      };
    },
  };
  const outcome = await executeReplyRealRun(caller, deps);
  assert.equal(stagedContent?.tweet?.text, "Exact content A.");
  assert.equal(outcome.kind, "staged");
  assert.match(outcome.message, new RegExp(TARGET_A));
  assert.doesNotMatch(outcome.message, new RegExp(TARGET_B));
  const frozenReceipt = outcome.message;
  caller.replyToId = RAW_CANARY;
  caller.targetIdOrUrl = RAW_CANARY;
  caller.content.tweet!.text = RAW_CANARY;
  assert.equal(outcome.message, frozenReceipt);
  assert.doesNotMatch(outcome.message, /RAW_|PRIVATE|cookie|session-secret/);
  assert.deepEqual(events, [
    "open",
    `claim:${TARGET_A}`,
    "mutated-to-b",
    `stage:${URL_A}:true`,
    `finalize:${TARGET_A}:owner-a:staged`,
    "close",
  ]);
});

test("coherent B evidence after loader mutation cannot finalize reservation A", async () => {
  const caller = request(tweetContent("Exact content A."));
  const events: string[] = [];
  const reservation: ReplyReservation = {
    targetTweetId: TARGET_A,
    reservationId: "owner-a",
    reservedAt: "2026-09-03T12:00:00.000Z",
    originId: ORIGIN_ID,
  };
  const ledger: ReplyLedgerPort = {
    claimReservation(target) {
      events.push(`claim:${target}`);
      return { kind: "acquired", reservation };
    },
    releaseReservation() { events.push("release"); return true; },
    finalizeReservation() { events.push("finalize"); },
    recoverStaleReservation() { throw new Error("not used"); },
    close() { events.push("close"); },
  };
  const deps: ReplyRealRunDependencies = {
    async openLedger() { events.push("open"); return ledger; },
    async loadStageReplyDraft() {
      caller.content = tweetContent("Mutated content B.");
      caller.targetIdOrUrl = URL_B;
      caller.replyToId = TARGET_B;
      caller.inspect = false;
      caller.force = true;
      events.push("mutated-to-b");
      return async (content, targetIdOrUrl, options): Promise<StageReplyResult> => {
        events.push(`stage:${targetIdOrUrl}:${String(options.inspect)}:${content.tweet?.text}`);
        return {
          format: "tweet",
          posts: 1,
          note: RAW_CANARY,
          saveMechanism: "composer_close_save",
          savePhase: "verified",
          replyToId: TARGET_B,
          draftRowEvidence: verifiedRowEvidence(),
          replyTargetEvidence: {
            ...verifiedTargetEvidence(),
            requestedTargetId: TARGET_B,
          },
        };
      };
    },
  };

  const outcome = await executeReplyRealRun(caller, deps);
  assert.equal(outcome.kind, "stage_result_inconclusive");
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.savePhase, "save_delivery_unknown");
  assert.equal(outcome.saveMechanism, "composer_close_save");
  assert.equal(outcome.draftRowEvidence, null);
  assert.equal(outcome.replyTargetEvidence, null);
  assert.match(outcome.message, new RegExp(TARGET_A));
  assert.doesNotMatch(outcome.message, new RegExp(TARGET_B));
  assert.doesNotMatch(outcome.message, /RAW_|PRIVATE|cookie|session-secret/);
  assert.deepEqual(events, [
    "open",
    `claim:${TARGET_A}`,
    "mutated-to-b",
    `stage:${URL_A}:true:Exact content A.`,
    "close",
  ]);
});

test("reservation owner evidence is detached, target-bound, and closed before staging", async () => {
  const mutableReservation: ReplyReservation = {
    targetTweetId: TARGET_A,
    reservationId: "owner-a",
    reservedAt: "2026-09-03T12:00:00.000Z",
    originId: ORIGIN_ID,
  };
  const events: string[] = [];
  let finalizedReservation: ReplyReservation | undefined;
  const ledger: ReplyLedgerPort = {
    claimReservation() { return { kind: "acquired", reservation: mutableReservation }; },
    releaseReservation() { return true; },
    finalizeReservation(owner) { finalizedReservation = owner; },
    recoverStaleReservation() { throw new Error("not used"); },
    close() { events.push("close"); },
  };
  const deps: ReplyRealRunDependencies = {
    async openLedger() { events.push("open"); return ledger; },
    async loadStageReplyDraft() {
      mutableReservation.targetTweetId = TARGET_B;
      mutableReservation.reservationId = "owner-b";
      mutableReservation.reservedAt = RAW_CANARY;
      return async () => verifiedResult("tweet", 1);
    },
  };
  const outcome = await executeReplyRealRun(request(), deps);
  assert.equal(outcome.kind, "staged");
  assert.ok(finalizedReservation);
  assert.notEqual(finalizedReservation, mutableReservation);
  assert.deepEqual(finalizedReservation, {
    targetTweetId: TARGET_A,
    reservationId: "owner-a",
    reservedAt: "2026-09-03T12:00:00.000Z",
    originId: ORIGIN_ID,
  });
  assert.equal(Object.isFrozen(finalizedReservation), true);

  for (const makeClaim of [
    () => ({
      kind: "acquired",
      reservation: { ...mutableReservation, targetTweetId: TARGET_B },
    }),
    () => {
      let reads = 0;
      const owner = { ...mutableReservation, targetTweetId: TARGET_A };
      Object.defineProperty(owner, "reservationId", {
        enumerable: true,
        get() { reads += 1; throw new Error(RAW_CANARY); },
      });
      return { kind: "acquired", reservation: owner, reads: () => reads };
    },
  ]) {
    const value = makeClaim() as ReturnType<typeof makeClaim> & { reads?: () => number };
    const claim = { kind: value.kind, reservation: value.reservation } as ReplyReservationClaim;
    const localEvents: string[] = [];
    const localLedger: ReplyLedgerPort = {
      claimReservation() { localEvents.push("claim"); return claim; },
      releaseReservation() { localEvents.push("release"); return true; },
      finalizeReservation() { localEvents.push("finalize"); },
      recoverStaleReservation() { throw new Error("not used"); },
      close() { localEvents.push("close"); },
    };
    const localDeps: ReplyRealRunDependencies = {
      async openLedger() { localEvents.push("open"); return localLedger; },
      async loadStageReplyDraft() { localEvents.push("load"); return async () => verifiedResult("tweet", 1); },
    };
    const localOutcome = await executeReplyRealRun(request(), localDeps);
    assert.equal(localOutcome.kind, "ledger_preflight_failed");
    assert.deepEqual(localEvents, ["open", "claim", "close"]);
    if (value.reads) assert.equal(value.reads(), 0);
    assert.doesNotMatch(localOutcome.message, /RAW_|PRIVATE|cookie|session-secret/);
  }
});

test("duplicate and blocked claim receipts remain target-A-bound and hostile claims fail generically", async () => {
  async function runClaim(claimValue: unknown): Promise<{
    outcome: ReplyRealRunOutcome;
    events: string[];
  }> {
    const events: string[] = [];
    const ledger: ReplyLedgerPort = {
      claimReservation() {
        events.push("claim");
        return claimValue as ReplyReservationClaim;
      },
      releaseReservation() { events.push("release"); return true; },
      finalizeReservation() { events.push("finalize"); },
      recoverStaleReservation() { throw new Error("not used"); },
      close() { events.push("close"); },
    };
    const deps: ReplyRealRunDependencies = {
      async openLedger() { events.push("open"); return ledger; },
      async loadStageReplyDraft() {
        events.push("load");
        return async () => verifiedResult("tweet", 1);
      },
    };
    return { outcome: await executeReplyRealRun(request(), deps), events };
  }

  const duplicate = await runClaim({
    kind: "already_staged",
    entry: {
      targetTweetId: TARGET_A,
      stagedAt: "2026-09-03T12:00:00.000Z",
      status: "staged",
      draftRef: null,
      originId: ORIGIN_ID,
    },
  });
  assert.equal(duplicate.outcome.kind, "duplicate");
  assert.match(duplicate.outcome.message, new RegExp(TARGET_A));
  assert.deepEqual(duplicate.events, ["open", "claim", "close"]);

  for (const state of ["active", "stale", "ambiguous"] as const) {
    const blocked = await runClaim({
      kind: "reservation_blocked",
      reservation: {
        targetTweetId: TARGET_A,
        reservationId: `owner-${state}`,
        reservedAt: "2026-09-03T12:00:00.000Z",
        originId: ORIGIN_ID,
      },
      state,
    });
    assert.equal(blocked.outcome.kind, `reservation_${state}`);
    assert.match(blocked.outcome.message, new RegExp(TARGET_A));
    assert.doesNotMatch(blocked.outcome.message, new RegExp(TARGET_B));
    assert.deepEqual(blocked.events, ["open", "claim", "close"]);
  }

  let accessorReads = 0;
  const accessorEntry = {
    targetTweetId: TARGET_A,
    stagedAt: "2026-09-03T12:00:00.000Z",
    status: "staged",
    draftRef: null,
    originId: ORIGIN_ID,
  };
  Object.defineProperty(accessorEntry, "status", {
    configurable: true,
    enumerable: true,
    get() { accessorReads += 1; throw new Error(RAW_CANARY); },
  });
  let proxyTraps = 0;
  const proxyHandler: ProxyHandler<object> = {
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
    ownKeys() { proxyTraps += 1; return []; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
  };
  const revoked = Proxy.revocable({
    targetTweetId: TARGET_A,
    reservationId: "owner-revoked",
    reservedAt: "2026-09-03T12:00:00.000Z",
    originId: ORIGIN_ID,
  }, {});
  revoked.revoke();

  const hostileClaims: unknown[] = [
    {
      kind: "already_staged",
      entry: {
        targetTweetId: TARGET_B,
        stagedAt: "2026-09-03T12:00:00.000Z",
        status: "staged",
        draftRef: null,
        originId: ORIGIN_ID,
      },
    },
    {
      kind: "already_staged",
      entry: {
        targetTweetId: TARGET_A,
        stagedAt: RAW_CANARY,
        status: "staged",
        draftRef: null,
        originId: ORIGIN_ID,
      },
    },
    {
      kind: "already_staged",
      entry: {
        targetTweetId: TARGET_A,
        stagedAt: "2026-09-03T12:00:00.000Z",
        status: RAW_CANARY,
        draftRef: null,
        originId: ORIGIN_ID,
      },
    },
    { kind: "already_staged", entry: accessorEntry },
    {
      kind: "reservation_blocked",
      reservation: {
        targetTweetId: TARGET_B,
        reservationId: "owner-b",
        reservedAt: "2026-09-03T12:00:00.000Z",
        originId: ORIGIN_ID,
      },
      state: "active",
    },
    new Proxy({
      kind: "reservation_blocked",
      reservation: {
        targetTweetId: TARGET_A,
        reservationId: "owner-proxy",
        reservedAt: "2026-09-03T12:00:00.000Z",
        originId: ORIGIN_ID,
      },
      state: "active",
    }, proxyHandler),
    {
      kind: "reservation_blocked",
      reservation: revoked.proxy,
      state: "active",
    },
  ];
  for (const hostile of hostileClaims) {
    const result = await runClaim(hostile);
    assert.equal(result.outcome.kind, "ledger_preflight_failed");
    assert.deepEqual(result.events, ["open", "claim", "close"]);
    assert.doesNotMatch(result.outcome.message, /RAW_|PRIVATE|cookie|session-secret/);
    assert.doesNotMatch(result.outcome.message, new RegExp(TARGET_B));
  }
  assert.equal(accessorReads, 0);
  assert.equal(proxyTraps, 0);
});

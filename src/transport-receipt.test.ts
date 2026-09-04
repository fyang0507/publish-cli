import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDryRunReceipt,
  createTransportReceipt,
  NO_ASSETS,
  NOT_REACHED_LIVE_VALIDATION,
  PASSED_LOCAL_VALIDATION,
  renderTransportReceiptHuman,
  TRANSPORT_RECEIPT_SCHEMA_VERSION,
  type TransportReceipt,
  type TransportReceiptInput,
} from "./transportReceipt.js";
import {
  receiptForXDraftOutcome,
  type XDraftRealRunOutcome,
} from "./commands/draft.js";
import type { XArticleDraftHandoff } from "./x/saveProgress.js";

const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));
const RECEIPT_MODULE_URL = new URL("./transportReceipt.js", import.meta.url).href;

function run(args: readonly string[]) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, PUBLISH_DATA_DIR: "/tmp/publish-receipt-test-unused" },
  });
}

function parseSingleReceipt(stdout: string): TransportReceipt {
  assert.ok(stdout.endsWith("\n"), "JSON receipt should end with one newline");
  const parsed = JSON.parse(stdout) as TransportReceipt;
  assert.equal(parsed.schemaVersion, TRANSPORT_RECEIPT_SCHEMA_VERSION);
  assert.equal(stdout.trim(), JSON.stringify(parsed), "stdout must contain exactly one deterministic JSON document");
  return parsed;
}

test("transport receipt is deeply frozen and both renderers consume the same closed facts", () => {
  const receipt = createDryRunReceipt({
    channel: "x",
    action: "draft",
    format: "tweet",
    warnings: ["manual review remains required"],
  });
  assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(receipt.validation));
  assert.ok(Object.isFrozen(receipt.validation.local));
  assert.ok(Object.isFrozen(receipt.warnings));
  assert.ok(Object.isFrozen(receipt.assets));
  assert.equal(receipt.published, false);
  assert.match(renderTransportReceiptHuman(receipt), /channel\/action\/format: x\/draft\/tweet/);
  assert.match(renderTransportReceiptHuman(receipt), /published: false/);
  assert.equal(JSON.parse(JSON.stringify(receipt)).terminalState, "dry_run_validated");
});

test("receipt builder rejects contradictory exit, verification, and asset claims", () => {
  const base: TransportReceiptInput = {
    channel: "linkedin",
    action: "draft",
    format: "post",
    mode: "real",
    validation: { local: PASSED_LOCAL_VALIDATION, live: { status: "passed", problems: [], notes: [] } },
    warnings: [],
    gotchas: [],
    assets: NO_ASSETS,
    platformTouched: true,
    terminalState: "native_draft_verified",
    verification: { status: "verified", strength: "exact_content_reopen", nativeReference: null },
    remoteResidue: [],
    error: null,
    exit: { class: "success", code: 0 },
  };
  assert.throws(() => createTransportReceipt({
    ...base,
    terminalState: "native_draft_unverified",
    verification: { status: "unverified", strength: "none", nativeReference: null },
  }));
  assert.throws(() => createTransportReceipt({
    ...base,
    exit: { class: "runtime_or_platform_failure", code: 0 },
  }));
  assert.throws(() => createTransportReceipt({
    ...base,
    assets: [{
      index: 0, role: "media", requested: true, resolved: false, set: true,
      uploaded: null, observed: null, verified: null, remoteReference: null,
    }],
  }));
  assert.throws(() => createTransportReceipt({
    ...base,
    platformTouched: false,
  }));
  assert.throws(() => createTransportReceipt({
    ...base,
    mode: "dry_run",
  }));
});

test("receipt closure rejects accessors and proxies before reading attacker-controlled facts", () => {
  let getterReads = 0;
  const valid = {
    channel: "x",
    action: "draft",
    format: "tweet",
    mode: "dry_run",
    validation: { local: PASSED_LOCAL_VALIDATION, live: { status: "skipped", problems: [], notes: [] } },
    warnings: [],
    gotchas: [],
    assets: [],
    platformTouched: false,
    terminalState: "dry_run_validated",
    verification: { status: "not_applicable", strength: "local_only", nativeReference: null },
    remoteResidue: [],
    error: null,
    exit: { class: "success", code: 0 },
  } as const;
  const accessor = { ...valid } as Record<string, unknown>;
  Object.defineProperty(accessor, "channel", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "x";
    },
  });
  assert.throws(() => createTransportReceipt(accessor as unknown as TransportReceiptInput));
  assert.equal(getterReads, 0);
  assert.throws(() => createTransportReceipt(new Proxy(valid, {}) as unknown as TransportReceiptInput));

  const warnings = ["closed fact"];
  const receipt = createTransportReceipt({ ...valid, warnings });
  warnings[0] = "mutated fact";
  assert.deepEqual(receipt.warnings, ["closed fact"]);
});

test("Commander usage failures emit one JSON receipt and exit 2 before actions", () => {
  const cases = [
    ["x", "draft", "--json"],
    ["x", "reply", "--json", "--text", "body"],
    ["linkedin", "draft", "--text", "body", "--unknown", "--json"],
    ["reddit", "draft", "--text", "one", "--text", "two", "--json"],
    ["wechat", "draft", "--json", "--text"],
    ["x", "draft", "--format", "tweet", "--text", "one", "--from", "missing.md", "--json"],
  ];
  for (const args of cases) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "", args.join(" "));
    const receipt = parseSingleReceipt(result.stdout);
    assert.equal(receipt.exit.code, 2);
    assert.equal(receipt.exit.class, "invalid_caller_input");
    assert.equal(receipt.platformTouched, false);
    assert.equal(receipt.published, false);
    assert.equal(receipt.validation.local.status, "failed");
  }
});

test("Commander usage failure human output is the same receipt facts, not raw parser prose", () => {
  const result = run(["x", "draft"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Transport receipt \(publish\.transport-receipt\/v1\)/);
  assert.match(result.stderr, /platform touched: no/);
  assert.match(result.stderr, /published: false/);
  assert.match(result.stderr, /exit: invalid_caller_input \(2\)/);
  assert.doesNotMatch(result.stderr, /^error: required option/m);
});

test("JSON dry-runs across browser channels emit one successful platform-free receipt", () => {
  const cases = [
    ["x", "draft", "--format", "tweet", "--text", "body", "--dry-run", "--json"],
    ["x", "reply", "--to", "12345", "--text", "body", "--dry-run", "--json"],
    ["linkedin", "draft", "--text", "body", "--dry-run", "--json"],
    ["reddit", "draft", "--subreddit", "agents", "--title", "Title", "--text", "body", "--dry-run", "--json"],
  ];
  for (const args of cases) {
    const result = run(args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "", args.join(" "));
    const receipt = parseSingleReceipt(result.stdout);
    assert.equal(receipt.exit.code, 0);
    assert.equal(receipt.platformTouched, false);
    assert.equal(receipt.terminalState, "dry_run_validated");
    assert.equal(receipt.validation.local.status, "passed");
    assert.equal(receipt.validation.live.status, "skipped");
    assert.equal(receipt.published, false);
  }
});

test("a runtime failure can retain verified native state while exiting 1", () => {
  const receipt = createTransportReceipt({
    channel: "reddit",
    action: "draft",
    format: "self_post",
    mode: "real",
    validation: { local: PASSED_LOCAL_VALIDATION, live: { status: "passed", problems: [], notes: [] } },
    warnings: [], gotchas: ["cleanup failed"], assets: NO_ASSETS,
    platformTouched: true,
    terminalState: "native_draft_verified",
    verification: { status: "verified", strength: "platform_signal", nativeReference: null },
    remoteResidue: [{ kind: "local_state", state: "cleanup_failed", assetIndex: null, reference: null, retryRisk: "duplicate" }],
    error: {
      source: "runtime", stage: "cleanup", code: "cleanup_failed", httpStatus: null,
      sanitizedMessage: "Cleanup failed after verification.", classification: "known",
      retryable: false, inputRelated: false, suggestedCorrection: "Do not restage.",
    },
    exit: { class: "runtime_or_platform_failure", code: 1 },
  });
  assert.equal(receipt.terminalState, "native_draft_verified");
  assert.equal(receipt.exit.code, 1);
});

test("unused live-validation sentinel remains immutable", () => {
  assert.ok(Object.isFrozen(NOT_REACHED_LIVE_VALIDATION));
});

test("large warning sets are bounded with total, omission, and exact ordered-set identity", () => {
  const warnings = Array.from({ length: 101 }, (_, index) => `warning-${index}`);
  const first = createDryRunReceipt({
    channel: "x", action: "draft", format: "tweet", warnings,
  });
  const changedTail = createDryRunReceipt({
    channel: "x", action: "draft", format: "tweet",
    warnings: [...warnings.slice(0, -1), "different-final-warning"],
  });
  assert.equal(first.warnings.length, 100);
  assert.deepEqual(
    {
      total: first.evidenceSummary.warnings.total,
      listed: first.evidenceSummary.warnings.listed,
      omitted: first.evidenceSummary.warnings.omitted,
    },
    { total: 101, listed: 100, omitted: 1 },
  );
  assert.match(first.evidenceSummary.warnings.fullSetSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(
    first.evidenceSummary.warnings.fullSetSha256,
    changedTail.evidenceSummary.warnings.fullSetSha256,
  );
});

test("large JSON and human receipts fully drain before an immediate process exit", () => {
  const childSource = (json: boolean) => `
    import { createDryRunReceipt, emitTransportReceipt } from ${JSON.stringify(RECEIPT_MODULE_URL)};
    const warnings = Array.from({ length: 100 }, (_, index) =>
      "warning-" + index + "-" + "x".repeat(1700) + (index === 99 ? "-FINAL_WARNING_MARKER" : ""));
    emitTransportReceipt(createDryRunReceipt({
      channel: "x", action: "draft", format: "tweet", warnings,
    }), { json: ${JSON.stringify(json)} });
    process.exit(0);
  `;

  const jsonRun = spawnSync(process.execPath, ["--input-type=module", "-e", childSource(true)], {
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  assert.equal(jsonRun.stderr, "");
  assert.ok(jsonRun.stdout.length > 65_536);
  const receipt = parseSingleReceipt(jsonRun.stdout);
  assert.equal(receipt.warnings.length, 100);
  assert.match(receipt.warnings[99]!, /FINAL_WARNING_MARKER$/);

  const humanRun = spawnSync(process.execPath, ["--input-type=module", "-e", childSource(false)], {
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  assert.equal(humanRun.status, 0, humanRun.stderr);
  assert.equal(humanRun.stderr, "");
  assert.ok(humanRun.stdout.length > 65_536);
  assert.match(humanRun.stdout, /warning: .*FINAL_WARNING_MARKER\n$/s);
});

const RAW_ARTICLE_RECEIPT_CONTENT =
  "RAW_ARTICLE_CALLER_CONTENT_[data-secret]_PRIVATE_PATH_CANARY_session-secret";

const VERIFIED_ARTICLE_COVER = Object.freeze({
  index: 0,
  role: "cover" as const,
  requested: true,
  resolved: true,
  set: true,
  uploaded: null,
  observed: true,
  verified: true,
  remoteReference: null,
});

const ARTICLE_RECEIPT_HANDOFF: XArticleDraftHandoff = Object.freeze({
  body: "rich_html",
  codeBlockCount: 1,
  codeAdvisories: Object.freeze([{
    kind: "article_code_block" as const,
    index: 1,
    lang: undefined,
    preview: RAW_ARTICLE_RECEIPT_CONTENT,
    sourceLine: 3,
    sourceEndLine: 5,
    sourceLineCount: 3,
    markdownStartLine: 3,
    markdownEndLine: 5,
    fence: "backtick" as const,
    closure: "explicit" as const,
    sourceTerminalNewline: false,
    infoString: null,
    infoStringTruncated: false,
    previewTruncated: false,
    digestNormalization: "lf_normalized_exact_fence_source" as const,
    normalizedSourceSha256: "a".repeat(64),
  }]),
  codeLinkAdvisories: Object.freeze([]),
  cover: Object.freeze({
    selection: "explicit" as const,
    contentType: "image/png" as const,
    width: 1500,
    height: 600,
    ratio: "exact_5_2" as const,
    sourceSha256: "b".repeat(64),
    requested: true as const,
    resolved: true as const,
    set: true,
    setPhase: "set_returned" as const,
    uploaded: null,
    applyPhase: "returned" as const,
    observed: true,
    verified: true,
  }),
});

function articleReceiptOutcome(
  savePhase: "verified" | "save_delivered_unverified",
  applyPhase: XArticleDraftHandoff["cover"]["applyPhase"] = "returned",
): XDraftRealRunOutcome {
  const verified = savePhase === "verified";
  const articleHandoff = applyPhase === "returned"
    ? ARTICLE_RECEIPT_HANDOFF
    : Object.freeze({
        ...ARTICLE_RECEIPT_HANDOFF,
        cover: Object.freeze({ ...ARTICLE_RECEIPT_HANDOFF.cover, applyPhase }),
      });
  return {
    kind: verified ? "staged" : "save_incomplete",
    savePhase,
    saveMechanism: "article_create_autosave",
    exitCode: verified ? 0 : 1,
    stream: verified ? "stdout" : "stderr",
    message: `Untrusted legacy prose must not enter the receipt: ${RAW_ARTICLE_RECEIPT_CONTENT}`,
    draftRowEvidence: null,
    articleHandoff,
    platformTouched: true,
    nativeReference: "https://x.com/compose/articles/edit/123456789",
  };
}

test("verified and unverified X Article receipts retain content-free manual-work and explicit-cover facts", () => {
  const receipts = (["verified", "save_delivered_unverified"] as const).map(
    (phase) => receiptForXDraftOutcome(articleReceiptOutcome(phase), "article"),
  );

  for (const receipt of receipts) {
    assert.deepEqual(receipt.assets, [VERIFIED_ARTICLE_COVER]);
    assert.deepEqual(receipt.evidenceSummary.assets.requested, {
      yes: 1,
      no: 0,
      unknown: 0,
    });
    for (const evidence of [
      receipt.evidenceSummary.assets.resolved,
      receipt.evidenceSummary.assets.set,
      receipt.evidenceSummary.assets.observed,
      receipt.evidenceSummary.assets.verified,
    ]) {
      assert.deepEqual(evidence, { yes: 1, no: 0, unknown: 0 });
    }
    assert.deepEqual(receipt.evidenceSummary.assets.uploaded, {
      yes: 0,
      no: 0,
      unknown: 1,
    });

    const manualCodeGotcha = receipt.gotchas.find(
      (gotcha) => /Insert → Code/.test(gotcha) && /screenshot/i.test(gotcha),
    );
    assert.ok(manualCodeGotcha, "Article receipt must retain the manual code-block handoff");
    assert.ok(!manualCodeGotcha.includes(RAW_ARTICLE_RECEIPT_CONTENT));
    assert.equal(receipt.gotchas.some((gotcha) => /cover.*not positively observed/i.test(gotcha)), false);

    const json = JSON.stringify(receipt);
    const parsed = JSON.parse(json) as typeof receipt;
    const human = renderTransportReceiptHuman(receipt);
    assert.deepEqual(parsed.assets, [VERIFIED_ARTICLE_COVER]);
    assert.ok(parsed.gotchas.includes(manualCodeGotcha));
    assert.match(
      human,
      /asset\[0\] cover: requested=yes; resolved=yes; set=yes; uploaded=unknown; observed=yes; verified=yes/,
    );
    assert.ok(human.includes(`gotcha: ${manualCodeGotcha}`));
    assert.ok(!json.includes(RAW_ARTICLE_RECEIPT_CONTENT));
    assert.ok(!human.includes(RAW_ARTICLE_RECEIPT_CONTENT));
  }

  assert.deepEqual(receipts[0].assets, receipts[1].assets);
  assert.equal(
    receipts[0].gotchas.find((gotcha) => /Insert → Code/.test(gotcha)),
    receipts[1].gotchas.find((gotcha) => /Insert → Code/.test(gotcha)),
  );
});

test("verified X Article JSON receipts retain every Apply phase and independent proof when needed", () => {
  for (const applyPhase of ["not_attempted", "delivery_unknown", "returned"] as const) {
    const receipt = receiptForXDraftOutcome(
      articleReceiptOutcome("verified", applyPhase),
      "article",
    );
    assert.equal(receipt.validation.live.status, "passed", applyPhase);
    assert.deepEqual(receipt.assets, [VERIFIED_ARTICLE_COVER], applyPhase);
    const provenance = receipt.gotchas.find((gotcha) =>
      gotcha.includes(`Apply phase=${applyPhase}`)
    );
    assert.ok(provenance, applyPhase);
    assert.doesNotMatch(provenance, /PRIVATE|selector|cookie|token/u, applyPhase);
    const independentProof = receipt.gotchas.find((gotcha) =>
      /Independent two-sided canonical persistence proved the exact cover and full title\/body without claiming Apply returned/.test(gotcha)
    );
    assert.equal(independentProof !== undefined, applyPhase !== "returned", applyPhase);
  }
});

test("unverified X Article JSON receipts distinguish every bounded Apply phase", () => {
  const expected = {
    not_attempted: /phase=not_attempted: no Apply click was invoked/,
    delivery_unknown: /phase=delivery_unknown: one exact Apply click was invoked once and its promise rejected; delivery is unknown and no retry was attempted/,
    returned: /phase=returned: one exact Apply click promise fulfilled/,
  } as const;
  const facts = new Set<string>();

  for (const applyPhase of ["not_attempted", "delivery_unknown", "returned"] as const) {
    const receipt = receiptForXDraftOutcome(
      articleReceiptOutcome("save_delivered_unverified", applyPhase),
      "article",
    );
    const phaseFact = receipt.gotchas.find((gotcha) =>
      gotcha.includes(`Apply phase=${applyPhase}`)
    );
    assert.ok(phaseFact, applyPhase);
    assert.match(phaseFact, expected[applyPhase], applyPhase);
    assert.ok(phaseFact.length < 240, applyPhase);
    assert.doesNotMatch(phaseFact, /PRIVATE|selector|cookie|token/u, applyPhase);
    facts.add(phaseFact);
    assert.equal(
      receipt.gotchas.some((gotcha) => /native draft may exist.*do not retry blindly/i.test(gotcha)),
      true,
      applyPhase,
    );
    assert.equal(
      receipt.gotchas.some((gotcha) => /independent two-sided canonical persistence/.test(gotcha)),
      false,
      applyPhase,
    );
    assert.equal(receipt.remoteResidue[0]?.retryRisk, "duplicate", applyPhase);
  }
  assert.equal(facts.size, 3);
});

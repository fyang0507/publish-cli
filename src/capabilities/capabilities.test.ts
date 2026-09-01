import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AUTH_PLATFORMS, createAuthProbeRegistry, type AuthReadiness } from "../auth/index.js";
import { executeChannelInfo, renderChannelInfo } from "../commands/channel-info.js";
import { generatePost } from "../linkedin/content.js";
import { generateContent } from "../x/content.js";
import { generateArticle } from "../wechat/content.js";
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_CAPABILITY_SCHEMA_VERSION,
  CHANNEL_INFO_SCHEMA_VERSION,
  GENERIC_CAPABILITY_WORKFLOW_REF,
  ONEPOINT3ACRES_CAPABILITY_WORKFLOW_REF,
  XHS_CAPABILITY_WORKFLOW_REF,
  LINKEDIN_POST_MAX_UTF16_CODE_UNITS,
  X_STANDARD_POST_MAX_WEIGHTED_LENGTH,
  countUtf16CodeUnits,
  countXWeightedLength,
  createServerValidationReceipt,
  validateWechatLocalImage,
  validateLinkedInPostText,
  validateXPostText,
} from "./index.js";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
const CHECKED_AT = "2026-09-01T00:00:00.000Z";

function ready(channel: (typeof AUTH_PLATFORMS)[number]): AuthReadiness {
  return {
    platform: channel,
    ready: true,
    status: "ready",
    checkedAt: CHECKED_AT,
    verificationMode: channel === "wechat" ? "api" : "passive_browser",
    evidence: { liveProbe: channel === "wechat" ? "api_authenticated" : "authenticated" },
    healed: [],
    requiresHuman: false,
  };
}

function collectFacts(value: unknown, facts: Array<{ value: unknown; evidence: Record<string, unknown> }> = []) {
  if (!value || typeof value !== "object") return facts;
  const record = value as Record<string, unknown>;
  if ("value" in record && "evidence" in record) {
    facts.push(record as { value: unknown; evidence: Record<string, unknown> });
  }
  for (const child of Array.isArray(value) ? value : Object.values(record)) collectFacts(child, facts);
  return facts;
}

function resolveDotPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cursor, key) =>
    cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[key] : undefined,
  value);
}

test("registry is complete, versioned, JSON-serializable, and evidence-aware", () => {
  assert.deepEqual(Object.keys(CHANNEL_CAPABILITIES).sort(), [...AUTH_PLATFORMS].sort());
  for (const channel of AUTH_PLATFORMS) {
    const entry = CHANNEL_CAPABILITIES[channel];
    assert.equal(entry.schemaVersion, CHANNEL_CAPABILITY_SCHEMA_VERSION);
    assert.equal(entry.channel, channel);
    assert.doesNotThrow(() => JSON.stringify(entry));
    assert.ok(entry.state.recovery.length > 0, `${channel} has state recovery guidance`);
    for (const role of ["cli", "agent", "human", "platform"] as const) {
      assert.ok(entry.responsibility[role].length > 0, `${channel} defines ${role} responsibility`);
    }
    assert.ok(entry.responsibility.rationale.length > 0, `${channel} explains its design boundary`);
    assert.ok(entry.excludedCapabilities.length > 0, `${channel} explains unsupported capabilities`);
    for (const format of entry.formats) {
      assert.ok(format.usage.length > 0, `${channel}/${format.id} has invocation guidance`);
      assert.ok(format.humanHighlights.length > 0, `${channel}/${format.id} has human highlights`);
      assert.equal(format.workflow.owner, entry.executionMode, `${channel}/${format.id} names the execution owner`);
      assert.ok(format.workflow.preconditions.length > 0, `${channel}/${format.id} has preconditions`);
      assert.ok(format.workflow.steps.length > 0, `${channel}/${format.id} has executable steps`);
      assert.equal(new Set(format.workflow.steps.map((step) => step.id)).size, format.workflow.steps.length);
      assert.ok(format.workflow.steps.every((step) => step.instruction && step.verification));
      for (const step of format.workflow.steps) {
        assert.ok(step.evidenceRefs.length > 0, `${channel}/${format.id}/${step.id} cites evidence`);
        for (const evidenceRef of step.evidenceRefs) {
          if (evidenceRef === "readiness" || evidenceRef === "auth") continue;
          const resolved = resolveDotPath(format, evidenceRef);
          assert.notEqual(resolved, undefined, `${channel}/${format.id} resolves ${evidenceRef}`);
          assert.ok(collectFacts(resolved).length > 0, `${channel}/${format.id} ${evidenceRef} is evidence-bearing`);
        }
      }
      assert.ok(format.workflow.successCriteria.length > 0, `${channel}/${format.id} has success criteria`);
      assert.match(format.workflow.terminalBoundary, /Stop/i);
      assert.ok(format.workflow.stopConditions.length > 1, `${channel}/${format.id} has explicit stops`);
      assert.equal(new Set(format.workflow.stopConditions.map((item) => item.id)).size, format.workflow.stopConditions.length);
      assert.deepEqual(
        [...new Set(format.workflow.stopConditions.map((item) => item.outcome))].sort(),
        ["abort", "needs_human", "success_terminal"],
      );
    }
    const facts = collectFacts(entry);
    assert.ok(facts.length > 0, `${channel} has evidence facts`);
    for (const item of facts) {
      assert.match(String(item.evidence.kind), /^(implementation_contract|official_documentation|live_positive_fixture|read_only_api|unknown)$/);
      assert.ok(String(item.evidence.source).length > 0);
      assert.match(String(item.evidence.lastVerified), /^\d{4}-\d{2}-\d{2}$/);
      if (item.value === null) assert.equal(item.evidence.kind, "unknown");
      if (item.evidence.kind === "unknown") assert.equal(item.value, null);
    }
  }
  assert.equal(CHANNEL_CAPABILITIES.wechat.auth.continueInSameContext, false);
  assert.equal(CHANNEL_CAPABILITIES["1point3acres"].auth.continueInSameContext, true);
});

test("registry returns every configured format at once", () => {
  const expected: Record<string, string[]> = {
    x: ["tweet", "thread", "article"],
    linkedin: ["post"],
    reddit: ["self_post"],
    wechat: ["article"],
    xhs: ["long_article"],
    "1point3acres": ["text_thread"],
  };
  for (const channel of AUTH_PLATFORMS) {
    assert.deepEqual(CHANNEL_CAPABILITIES[channel].formats.map((format) => format.id), expected[channel]);
  }

  const article = CHANNEL_CAPABILITIES.x.formats.find((format) => format.id === "article");
  assert.equal(article?.fields.find((field) => field.name === "coverAsset")?.required, false);
});

test("invocation guidance maps every advertised override and implicit resolution rule", () => {
  const xTweet = CHANNEL_CAPABILITIES.x.formats.find((format) => format.id === "tweet")!;
  for (const option of ["--long", "--dry-run", "--inspect"]) {
    assert.match(xTweet.usage, new RegExp(option));
  }

  const xThread = CHANNEL_CAPABILITIES.x.formats.find((format) => format.id === "thread")!;
  for (const option of ["--dry-run", "--inspect"]) {
    assert.match(xThread.usage, new RegExp(option));
  }

  const xArticle = CHANNEL_CAPABILITIES.x.formats.find((format) => format.id === "article");
  assert.match(xArticle?.usage ?? "", /--format article --from/);
  assert.match(xArticle?.usage ?? "", /--dry-run/);
  assert.match(xArticle?.usage ?? "", /--inspect/);
  assert.ok(xArticle?.humanHighlights.some((item) => /ranks 5:2 images first/.test(item)));
  assert.ok(xArticle?.humanHighlights.some((item) => /first Markdown H1/.test(item)));

  const reddit = CHANNEL_CAPABILITIES.reddit.formats[0];
  for (const option of ["--nsfw", "--spoiler", "--dry-run", "--inspect"]) {
    assert.match(reddit.usage, new RegExp(option));
  }

  const linkedin = CHANNEL_CAPABILITIES.linkedin.formats[0];
  for (const option of ["--media", "--bold", "--dry-run", "--inspect"]) {
    assert.match(linkedin.usage, new RegExp(option));
  }

  const wechat = CHANNEL_CAPABILITIES.wechat.formats[0];
  for (const option of ["--title", "--author", "--digest", "--cover", "--source-url", "--keep-links", "--out", "--dry-run"]) {
    assert.match(wechat.usage, new RegExp(option));
  }
  assert.match(wechat.fields.find((field) => field.name === "title")?.description ?? "", /after resolution/);
  assert.match(wechat.fields.find((field) => field.name === "cover")?.description ?? "", /frontmatter/);
});

test("workflow success claims stay bounded to observed receipts", () => {
  const tweet = CHANNEL_CAPABILITIES.x.formats.find((format) => format.id === "tweet")!;
  assert.match(tweet.workflow.successCriteria.join(" "), /verified=yes/);
  assert.match(tweet.workflow.stopConditions.find((item) => item.id === "stage_unconfirmed")?.action ?? "", /Do not claim/);

  const thread = CHANNEL_CAPABILITIES.x.formats.find((format) => format.id === "thread")!;
  assert.match(thread.workflow.successCriteria.join(" "), /first-row receipt.*bounded evidence/);
  assert.doesNotMatch(thread.workflow.successCriteria.join(" "), /all numbered rows were staged/);

  const linkedin = CHANNEL_CAPABILITIES.linkedin.formats[0];
  assert.match(linkedin.workflow.successCriteria.join(" "), /media.*visibly confirmed/);

  const reddit = CHANNEL_CAPABILITIES.reddit.formats[0];
  assert.match(reddit.workflow.successCriteria.join(" "), /no stronger reopen\/persistence claim/);
  assert.match(reddit.workflow.stopConditions.find((item) => item.id === "save_unconfirmed")?.action ?? "", /do not claim persistence/i);
});

test("documented values, live conflicts, lower bounds, actual maxima, and unknowns remain separate", () => {
  const x = CHANNEL_CAPABILITIES.x.formats[0].constraints as any;
  assert.equal(x.premiumLongPost.platformMaxLength.value, 25000);
  assert.deepEqual(x.premiumLongPost.liveDraftFixtures.value, [281, 500]);
  assert.equal(x.premiumLongPost.maxDraftableLength.value, null);

  const linkedin = CHANNEL_CAPABILITIES.linkedin.formats[0].constraints as any;
  assert.equal(linkedin.images.documentedMaximumCount.value, 20);
  assert.equal(linkedin.images.observedAcceptedCountAtLeast.value, 21);
  assert.equal(linkedin.images.actualMaximumCount.value, null);
  assert.equal(linkedin.draft.successfulMediaSaveObserved.value, false);
  assert.equal(linkedin.draft.mediaPersistence.value, null);

  const wechat = CHANNEL_CAPABILITIES.wechat.formats[0].constraints as any;
  assert.equal(wechat.textFields.title.documentedMaximumZi.value, 32);
  assert.equal(wechat.textFields.title.measurement.value, null);
  assert.deepEqual(wechat.htmlContent.conflictingDocumentedStatements.value, [
    "not over 2 kb",
    "fewer than 20,000 characters",
    "under 1 MB",
  ]);
  assert.equal(wechat.htmlContent.effectiveMaximum.value, null);

  const reddit = CHANNEL_CAPABILITIES.reddit.formats[0].constraints as any;
  assert.equal(reddit.transportContract.configuredTitleLimitCodePoints, 300);
  assert.equal(reddit.platformLimits.actualTitleMaximumCodePoints.value, null);
  assert.equal(reddit.dynamicCommunityContract.inspectable.command, "publish reddit inspect <subreddit>");
  assert.ok(reddit.dynamicCommunityContract.composerOnly.includes("karma eligibility"));
  assert.deepEqual(reddit.dynamicCommunityContract.unverifiableStatically, ["complete AutoMod behavior"]);
});

test("info keeps static capabilities separate, sanitizes probe failure, and always exits zero", async () => {
  const success = await executeChannelInfo("x", async () => ready("x"));
  assert.equal(success.exitCode, 0);
  assert.equal(success.envelope.schemaVersion, CHANNEL_INFO_SCHEMA_VERSION);
  assert.equal(success.envelope.capabilities.formats.length, 3);
  assert.equal(success.envelope.readiness.ready, true);

  const notReadyReceipt = ready("reddit");
  notReadyReceipt.ready = false;
  notReadyReceipt.status = "login_required";
  const notReady = await executeChannelInfo("reddit", async () => notReadyReceipt);
  assert.equal(notReady.exitCode, 0);
  assert.equal(notReady.envelope.capabilities.channel, "reddit");
  assert.equal(notReady.envelope.readiness.ready, false);

  const failure = await executeChannelInfo("linkedin", async () => {
    throw new Error("raw token SECRET_VALUE");
  }, () => Date.parse(CHECKED_AT));
  assert.equal(failure.exitCode, 0);
  assert.equal(failure.envelope.capabilities.channel, "linkedin");
  assert.equal(failure.envelope.readiness.status, "probe_inconclusive");
  assert.doesNotMatch(JSON.stringify(failure.envelope), /SECRET_VALUE|raw token/);
});

test("human info is readiness-first, concise, and actionable while JSON owns full evidence", () => {
  const readiness = ready("wechat");
  readiness.healed = ["token_refreshed"];
  const rendered = renderChannelInfo({
    schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
    channel: "wechat",
    capabilities: CHANNEL_CAPABILITIES.wechat,
    readiness,
  });
  assert.ok(rendered.indexOf("Readiness: ready") < rendered.indexOf("Static capabilities:"));
  assert.match(rendered, /Healed: token_refreshed/);
  assert.match(rendered, /Exit behavior: info returns 0 even when not ready/);
  assert.match(rendered, /cover \(required\)/);
  assert.match(rendered, /Use: publish wechat draft/);
  assert.match(rendered, /Cover formats: BMP\/PNG\/JPEG\/JPG\/GIF/);
  assert.match(rendered, /Exact byte boundaries are unknown\/server-authoritative/);
  assert.match(rendered, /32\/16\/120 字/);
  assert.match(rendered, /WECHAT_PROXY_URL or WECHAT_SSH_TUNNEL/);
  assert.match(rendered, /serverAuthoritative:/);
  assert.match(rendered, /Responsibility boundary:/);
  assert.match(rendered, /Workflow owner: cli_transport/);
  assert.match(rendered, /Execute:\n\s+1\. \[agent\]/);
  assert.match(rendered, /Verify: The API probe is authenticated/);
  assert.match(rendered, /Terminal boundary: Stop in 草稿箱/);
  assert.match(rendered, /ip_not_allowlisted \[needs_human; human\]/);
  assert.match(rendered, /2\.35:1 and 1:1/);
  assert.match(rendered, /Excluded, deferred, or external capabilities:/);
  assert.match(rendered, /Forbidden actions:\n  - freepublish\/\*/);
  assert.match(rendered, /Evidence: use --json/);
  assert.ok(rendered.split("\n").length < 120);
});

test("agent-owned entries use shipped channel references and truthful context boundaries", async () => {
  assert.ok(existsSync(resolve(process.cwd(), GENERIC_CAPABILITY_WORKFLOW_REF.split("#")[0])));
  assert.ok(existsSync(resolve(process.cwd(), XHS_CAPABILITY_WORKFLOW_REF.split("#")[0])));
  assert.ok(existsSync(resolve(process.cwd(), ONEPOINT3ACRES_CAPABILITY_WORKFLOW_REF.split("#")[0])));
  const registry = createAuthProbeRegistry({ now: () => Date.parse(CHECKED_AT) });
  const xhs = await registry.xhs();
  const acres = await registry["1point3acres"]();
  assert.equal(xhs.status, "agent_check_required");
  assert.equal(xhs.nextStep?.entryUrl, CHANNEL_CAPABILITIES.xhs.auth.entryUrl);
  assert.equal(xhs.nextStep?.workflowRef, XHS_CAPABILITY_WORKFLOW_REF);
  assert.equal(xhs.nextStep?.continueInSameContext, true);
  assert.equal(acres.status, "agent_check_required");
  assert.equal(acres.nextStep?.executor, "human");
  assert.equal(acres.verificationMode, "human_handoff");
  assert.equal(acres.nextStep?.entryUrl, CHANNEL_CAPABILITIES["1point3acres"].auth.entryUrl);
  assert.equal(acres.nextStep?.workflowRef, ONEPOINT3ACRES_CAPABILITY_WORKFLOW_REF);
  assert.equal(acres.nextStep?.continueInSameContext, true);
  assert.equal(CHANNEL_CAPABILITIES["1point3acres"].executionMode, "human_handoff");
  assert.match(CHANNEL_CAPABILITIES["1point3acres"].auth.mode, /human-owned normal-browser/);
  assert.doesNotMatch(CHANNEL_CAPABILITIES["1point3acres"].auth.mode, /agent-owned/);
  assert.match(CHANNEL_CAPABILITIES.xhs.formats[0].terminalState, /browser-local/);
  assert.match(CHANNEL_CAPABILITIES.xhs.formats[0].terminalState, /not a cloud draft/);
});

test("agent_check_required renders as an actionable external preflight with consistent ownership", async () => {
  const registry = createAuthProbeRegistry({ now: () => Date.parse(CHECKED_AT) });
  const xhsReadiness = await registry.xhs();
  const xhsRendered = renderChannelInfo({
    schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
    channel: "xhs",
    capabilities: CHANNEL_CAPABILITIES.xhs,
    readiness: xhsReadiness,
  });
  assert.match(xhsRendered, /Readiness: external preflight required \(agent_check_required\)/);
  assert.match(xhsRendered, /Next: Open the creator portal with the browser agent/);
  assert.match(xhsRendered, /1\. \[agent\] Open the capability entry URL/);
  assert.match(xhsRendered, /Supplemental reference: .*not required; the executable workflow is embedded below/);

  const acresReadiness = await registry["1point3acres"]();
  const acresRendered = renderChannelInfo({
    schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
    channel: "1point3acres",
    capabilities: CHANNEL_CAPABILITIES["1point3acres"],
    readiness: acresReadiness,
  });
  assert.match(acresRendered, /Next: Have the human open 1point3acres in a normal authorized browser/);
  assert.match(acresRendered, /Authentication: human-owned normal-browser/);
  assert.doesNotMatch(acresRendered, /Authentication: agent-owned/);
});

test("agent-browser and handoff info are standalone execution oracles", () => {
  const xhs = CHANNEL_CAPABILITIES.xhs.formats[0];
  const xhsConstraints = xhs.constraints as any;
  assert.deepEqual(xhsConstraints.import.acceptedExtensions.value, [".md", ".docx", ".txt"]);
  assert.equal(xhsConstraints.editor.titleVisibleMaximum.value, 64);
  assert.equal(xhsConstraints.editor.bodyVisibleMaximum.value, 10000);
  assert.equal(xhsConstraints.oneClickLayout.finalCaptionVisibleMaximum.value, 1000);
  assert.equal(xhsConstraints.oneClickLayout.finalTitleMaximum.value, null);
  assert.deepEqual(xhsConstraints.deferredImageTextPreparation.recommendedAspectRatioRange.value, {
    tallest: "3:4",
    widest: "2:1",
  });
  assert.deepEqual(xhs.workflow.steps.map((step) => step.id), [
    "authenticate",
    "import",
    "set_title",
    "choose_output_branch",
    "complete_post_layout",
    "save",
    "reopen",
  ]);
  assert.doesNotMatch(`${xhs.usage} ${xhs.summary}`, /issue #35|future|not implemented in #32/i);

  const acres = CHANNEL_CAPABILITIES["1point3acres"].formats[0];
  const acresConstraints = acres.constraints as any;
  assert.equal(acresConstraints.curatedDestinations.workplaceReflection.forumId, 98);
  assert.equal(acresConstraints.curatedDestinations.chineseLife.forumId, 29);
  assert.equal(acresConstraints.curatedDestinations.jobSearch.forumId, 28);
  assert.deepEqual(Object.keys(acresConstraints.curatedDestinations.jobSearch.requiredMetadata), [
    "jobYear",
    "jobCategory",
    "major",
    "experienceRange",
    "regionRequired",
  ]);
  assert.equal(acresConstraints.composer.title.measurement.value, null);
  assert.equal(acresConstraints.composer.body.maximum.value, null);
  assert.match(acres.workflow.steps.find((step) => step.id === "save_draft")?.instruction ?? "", /保存草稿/);
  assert.doesNotMatch(`${acres.usage} ${acres.summary}`, /issue #37|future|not implemented in #32/i);
});

test("channel media specifications are discoverable without inferring unknown maxima", () => {
  const xCover = (CHANNEL_CAPABILITIES.x.formats.find((format) => format.id === "article")?.constraints as any).cover;
  assert.equal(xCover.recommendedAspectRatio.value, "5:2");
  assert.equal(xCover.maximumBytes.value, null);

  const linkedinImages = (CHANNEL_CAPABILITIES.linkedin.formats[0].constraints as any).images;
  assert.deepEqual(linkedinImages.documentedAspectRatioRange.value, { widest: "3:1", tallest: "4:5" });
  assert.equal(linkedinImages.actualAcceptedAspectRatioRange.value, null);

  const wechatCover = (CHANNEL_CAPABILITIES.wechat.formats[0].constraints as any).cover;
  assert.deepEqual(wechatCover.supportedCropRatios.value, ["2.35:1", "1:1"]);
  assert.equal(wechatCover.requiredInputAspectRatio.value, null);
  const wechatPaths = (CHANNEL_CAPABILITIES.wechat.formats[0].constraints as any).pathResolution;
  assert.equal(wechatPaths.markdownRelativeBodyImages.value, "directory containing the --from Markdown file");
  assert.equal(wechatPaths.absolutePathsAccepted.value, true);
});

test("X uses official twitter-text fixtures from issue #40", () => {
  const url = "https://example.com/very/long/path";
  assert.equal(countXWeightedLength("a".repeat(280)), 280);
  assert.equal(countXWeightedLength("a".repeat(281)), 281);
  assert.equal(countXWeightedLength("汉".repeat(140)), 280);
  assert.equal(countXWeightedLength("汉".repeat(141)), 282);
  assert.equal(countXWeightedLength("👨‍👩‍👧‍👦".repeat(140)), 280);
  assert.equal(countXWeightedLength("👨‍👩‍👧‍👦".repeat(141)), 282);
  assert.equal(countXWeightedLength(`${"a".repeat(256)} ${url}`), 280);
  assert.equal(countXWeightedLength(`${"a".repeat(257)} ${url}`), 281);
  assert.equal(countXWeightedLength("café".repeat(70)), 280);
  assert.equal(countXWeightedLength("cafe\u0301".repeat(70)), 280);
  assert.equal(countXWeightedLength(`${"cafe\u0301".repeat(70)}a`), 281);

  assert.deepEqual(validateXPostText("汉".repeat(140)), {
    valid: true,
    measuredLength: 280,
    maximum: X_STANDARD_POST_MAX_WEIGHTED_LENGTH,
    unit: "twitter_text_weighted",
  });
  assert.equal(validateXPostText("汉".repeat(141)).valid, false);
});

test("X generation validates weighted CJK", async () => {
  const x = await generateContent("汉".repeat(141), { format: "tweet" });
  assert.equal(x.tweet?.chars, 280);
  assert.ok(x.warnings.some((warning) => /282/.test(warning)));
});

test("X thread splitting preserves URLs, punctuation, CJK, NFD, and ZWJ content", async () => {
  const fixtures = [
    Array.from({ length: 12 }, (_, index) => `https://example.com/path/${index}/resource`).join(" "),
    "Version 3.14 uses e.g. abbreviations. ".repeat(30),
    "汉".repeat(400),
    "cafe\u0301 ".repeat(100),
    "👨‍👩‍👧‍👦".repeat(200),
  ];
  const compact = (value: string) => value.replace(/\s+/g, "");

  for (const fixture of fixtures) {
    const generated = await generateContent(fixture, { format: "thread" });
    const posts = generated.thread ?? [];
    assert.ok(posts.length > 1);
    assert.ok(posts.every((post) => post.chars <= X_STANDARD_POST_MAX_WEIGHTED_LENGTH));
    const reconstructed = posts
      .map((post) => post.text.replace(/ \d+\/\d+$/, ""))
      .join(" ");
    assert.equal(compact(reconstructed), compact(fixture));
  }

  const punctuatedCjk = "汉字句子。".repeat(100);
  const cjkThread = await generateContent(punctuatedCjk, { format: "thread" });
  const exactCjk = (cjkThread.thread ?? [])
    .map((post) => post.text.replace(/ \d+\/\d+$/, ""))
    .join("");
  assert.equal(exactCjk, punctuatedCjk);
});

test("Premium long-post guard remains an explicit code-point transport policy", async () => {
  const fixture = "汉".repeat(13_000);
  const generated = await generateContent(fixture, { format: "tweet", long: true });
  assert.equal(generated.tweet?.text, fixture);
  assert.equal(generated.tweet?.chars, 13_000);
  assert.equal(generated.warnings.length, 0);
});

test("LinkedIn uses live-confirmed UTF-16 fixtures from issue #41", () => {
  const boundaryFixtures = [
    "a".repeat(3000),
    "汉".repeat(3000),
    "é".repeat(3000),
    "e\u0301".repeat(1500),
    "😀".repeat(1500),
    `${"👨‍👩‍👧‍👦".repeat(272)}${"a".repeat(8)}`,
  ];
  const overflowFixtures = [
    "a".repeat(3001),
    "汉".repeat(3001),
    "é".repeat(3001),
    "e\u0301".repeat(1501),
    "😀".repeat(1501),
    "👨‍👩‍👧‍👦".repeat(273),
  ];

  for (const fixture of boundaryFixtures) {
    assert.equal(countUtf16CodeUnits(fixture), LINKEDIN_POST_MAX_UTF16_CODE_UNITS);
    assert.equal(validateLinkedInPostText(fixture).valid, true);
  }
  for (const fixture of overflowFixtures) {
    assert.ok(countUtf16CodeUnits(fixture) > LINKEDIN_POST_MAX_UTF16_CODE_UNITS);
    assert.equal(validateLinkedInPostText(fixture).valid, false);
  }

  const linkedin = generatePost("😀".repeat(1501));
  assert.equal(linkedin.chars, 3000);
  assert.ok(linkedin.warnings.some((warning) => /3002/.test(warning)));
});

test("server-authoritative validation receipts preserve sanitized unknown errors", () => {
  const receipt = createServerValidationReceipt({
    source: "platform",
    stage: "draft_add",
    code: null,
    message: "The platform rejected it. access_token=SECRET_VALUE",
    platformTouched: true,
    published: false,
  });
  assert.doesNotThrow(() => JSON.stringify(receipt));
  assert.equal(receipt.code, null);
  assert.equal(receipt.outcome, "unknown_error");
  assert.equal(receipt.published, false);
  assert.doesNotMatch(JSON.stringify(receipt), /SECRET_VALUE/);
});

test("WeChat leaves unknown 字 measurement to the server and omits derived digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-capability-"));
  try {
    const cover = join(dir, "cover.bmp");
    writeFileSync(cover, "fixture");
    const article = generateArticle(`# ${"题".repeat(64)}\n\nBody paragraph`, { cover });
    assert.equal(article.title, "题".repeat(64));
    assert.equal(article.digest, "");
    assert.ok(article.warnings.some((warning) => /first 54 字/.test(warning)));

    const bodyGif = join(dir, "body.gif");
    writeFileSync(bodyGif, "fixture");
    assert.throws(
      () => generateArticle("# Title\n\n![body](body.gif)", { cover, baseDir: dir }),
      /body image must use \.jpg\/\.jpeg\/\.png/,
    );

    const documentedLabelCover = join(dir, "documented-label-cover.jpg");
    const documentedLabelBody = join(dir, "documented-label-body.png");
    writeFileSync(documentedLabelCover, "");
    writeFileSync(documentedLabelBody, "");
    truncateSync(documentedLabelCover, 10_000_000);
    truncateSync(documentedLabelBody, 1_000_000);
    assert.deepEqual(validateWechatLocalImage(documentedLabelCover, "cover"), {
      valid: true,
      surface: "cover",
      extension: ".jpg",
      contentType: "image/jpeg",
      sizeBytes: 10_000_000,
      maximumBytes: null,
      error: null,
    });
    assert.equal(validateWechatLocalImage(documentedLabelBody, "body").valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("info CLI has no --format and non-ready agent-owned info exits zero", () => {
  const rootHelp = spawnSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8" });
  assert.equal(rootHelp.status, 0);
  for (const channel of AUTH_PLATFORMS) assert.match(rootHelp.stdout, new RegExp(`\\b${channel}\\b`));

  const help = spawnSync(process.execPath, [CLI_PATH, "x", "info", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--format/);

  const rejected = spawnSync(process.execPath, [CLI_PATH, "x", "info", "--format", "tweet"], { encoding: "utf8" });
  assert.equal(rejected.status, 2);

  const wechatHelp = spawnSync(process.execPath, [CLI_PATH, "wechat", "draft", "--help"], { encoding: "utf8" });
  assert.equal(wechatHelp.status, 0);
  assert.match(wechatHelp.stdout, /32 字/);
  assert.doesNotMatch(wechatHelp.stdout, /64 code points/);

  const xhs = spawnSync(process.execPath, [CLI_PATH, "xhs", "info", "--json"], { encoding: "utf8" });
  assert.equal(xhs.status, 0, xhs.stderr);
  const receipt = JSON.parse(xhs.stdout) as { capabilities: { formats: unknown[] }; readiness: { ready: boolean } };
  assert.equal(receipt.capabilities.formats.length, 1);
  assert.equal(receipt.readiness.ready, false);
});

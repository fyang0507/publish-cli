import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AUTH_PLATFORMS, createAuthProbeRegistry, type AuthReadiness } from "../auth/index.js";
import {
  executeChannelInfo,
  renderChannelInfo,
} from "../commands/channel-info.js";
import { generatePost } from "../linkedin/content.js";
import { generateContent } from "../x/content.js";
import { preloadXArticleCover } from "../x/articleCover.js";
import { generateArticle } from "../wechat/content.js";
import {
  CHANNEL_INFO_SCHEMA_VERSION,
  CHANNEL_INFO_SOURCE_SCHEMA_VERSION,
  getChannelInfoSource,
  loadAllChannelInfoSources,
  LINKEDIN_POST_MAX_UTF16_CODE_UNITS,
  X_STANDARD_POST_MAX_WEIGHTED_LENGTH,
  countUtf16CodeUnits,
  countXWeightedLength,
  createServerValidationReceipt,
  parseChannelInfoMarkdown,
  validateWechatLocalImage,
  validateLinkedInPostText,
  validateXPostText,
} from "./index.js";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
const CHECKED_AT = "2026-09-01T00:00:00.000Z";
const CHANNEL_INFO_SOURCES = loadAllChannelInfoSources();

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function validTinyXArticleCoverPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAUAAAACCAIAAAAfCIEKAAAACXBIWXMAAAABAAAAAQBPJcTWAAAADklEQVR4nGNkQAUsaHwAAIAABtETi70AAAAASUVORK5CYII=",
    "base64",
  );
}

function bmpHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(26);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(12, 14);
  buffer.writeUInt16LE(width, 18);
  buffer.writeUInt16LE(height, 20);
  return buffer;
}

function gifHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(10);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

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

test("Markdown registry contains exactly one minimal source for every channel", () => {
  assert.deepEqual(Object.keys(CHANNEL_INFO_SOURCES).sort(), [...AUTH_PLATFORMS].sort());
  for (const channel of AUTH_PLATFORMS) {
    const source = CHANNEL_INFO_SOURCES[channel];
    assert.equal(source.schemaVersion, CHANNEL_INFO_SOURCE_SCHEMA_VERSION);
    assert.equal(source.channel, channel);
    assert.ok(source.displayName);
    assert.ok(source.cliBoundary);
    assert.ok(source.authentication);
    assert.ok(source.platformGuidance);
    assert.doesNotThrow(() => JSON.stringify(source));
  }
});

test("Markdown parser requires only the three sections and rejects silent omissions", () => {
  const valid = `---
schemaVersion: publish.channel-info-source/v1
channel: x
displayName: X
---
# X

## CLI boundary

CLI guidance.

## Authentication

Auth guidance.

## Platform specification and gotchas

Platform guidance.
`;
  assert.deepEqual(parseChannelInfoMarkdown(valid, "fixture", "x"), {
    schemaVersion: CHANNEL_INFO_SOURCE_SCHEMA_VERSION,
    channel: "x",
    displayName: "X",
    cliBoundary: "CLI guidance.",
    authentication: "Auth guidance.",
    platformGuidance: "Platform guidance.",
  });

  assert.throws(
    () => parseChannelInfoMarkdown(valid.replace("## Authentication", "## Login"), "fixture"),
    /expected exactly these H2 sections/,
  );
  assert.throws(
    () => parseChannelInfoMarkdown(valid.replace("# X\n", "# X\nUnmapped prose.\n"), "fixture"),
    /put all guidance inside/,
  );
  assert.throws(() => parseChannelInfoMarkdown(valid, "fixture", "reddit"), /expected channel/);
});

test("channel guides retain operator handoffs, verification limits, and recovery", () => {
  const guidance = (channel: (typeof AUTH_PLATFORMS)[number]): string => {
    const source = CHANNEL_INFO_SOURCES[channel];
    return [source.cliBoundary, source.authentication, source.platformGuidance].join("\n");
  };

  // Check operational disclosures, not whole paragraphs or implementation details.
  // Parser, staging, receipt, and action-help contracts are tested separately.
  const essentials: Record<(typeof AUTH_PLATFORMS)[number], RegExp[]> = {
    x: [
      /never publishes or schedules/,
      /intended authenticated action with `--inspect`/,
      /do not stage a draft merely to authenticate/,
      /member delta with `--dry-run`/,
      /account-wide member-add lock/,
      /triage rubric must be self-contained/,
      /history.*never includes staged drafts/s,
      /280-character limit/,
      /--format article.*--cover/,
      /exact 5:2 ratio/,
      /fences are excluded from the native/,
      /save_not_attempted/,
      /save_delivery_unknown/,
      /save_delivered_unverified/,
      /first thread row/,
      /whitespace\/case normalization/,
      /cannot prove the exact numeric target ID/,
      /`staged-unverified` and exits 1/,
      /Never retry automatically/,
      /exact CLI-owned profile/,
      /same live SQLite file.*same machine-local X profile origin/,
      /never bypasses.*reservation.*origin is unknown or mismatched/s,
      /24 hours old.*explicit recovery/,
      /--recover-stale-reservation-after-confirming-no-draft/,
      /clears the claim and exits without staging/,
    ],
    linkedin: [
      /personal-feed text post/,
      /intended draft with `--inspect`/,
      /3,000 UTF-16 code units/,
      /3:1 through 4:5/,
      /complete text match after reopening/,
      /Text verification does not reliably prove image persistence/,
      /exact same CLI-owned LinkedIn profile/,
      /matching draft exists or the comparison is uncertain, do not retry/,
      /published:false/,
    ],
    reddit: [
      /search for communities.*inspect a community/s,
      /intended draft with `--inspect`/,
      /CAPTCHA/,
      /300 title code points and 40,000 body code points/,
      /dry-run.*skips the live subreddit preflight/,
      /4-space-indented code/,
      /Inline body images are not uploaded or verified/,
      /absent before and visible after/,
      /fresh toast does not prove that the draft can be reopened/,
      /same CLI-owned profile/,
      /Never retry automatically or blindly/,
      /no draft idempotency ledger/,
    ],
    wechat: [
      /never calls publication or mass-messaging APIs/,
      /WECHAT_SSH_TUNNEL/,
      /WECHAT_PROXY_URL/,
      /40164/,
      /32 字.*16 字.*120 字/,
      /2\.35:1 and 1:1/,
      /nonempty.*media_id/,
      /visual inspection are optional/,
      /API success does not prove visual rendering or publication/,
      /renewal is reported in the receipt/,
      /do not rewrite or retry automatically/,
      /原创声明/,
      /创作来源/,
      /reuse it instead of creating another draft/,
    ],
    xhs: [
      /no Xiaohongshu read or write transport/,
      /user explicitly requests publication/,
      /same browser profile through save and verification/,
      /Drafts are browser-local/,
      /image-text save\/reopen and automated publication were not verified/,
      /一键排版.*下一步/,
      /native topic entity/,
      /草稿箱/,
      /reconcile the result before any retry/,
    ],
    "1point3acres": [
      /CLI offers no functionality to access or write/,
      /human must always perform login/,
      /same context when automation is available; otherwise the human follows/,
      /fid=98/,
      /fid=29/,
      /fid=28/,
      /保存草稿.*草稿箱.*compare the full title and body/,
      /publication is explicitly authorized.*verified live/,
    ],
    website: [
      /CLI provides discovery only/,
      /subagent.*repository\/worktree/,
      /add-website-content/,
      /agent_check_required/,
      /merge and deployment remain outside publish/,
      /archive-audit and real-browser preview evidence/,
    ],
  };

  for (const channel of AUTH_PLATFORMS) {
    const text = guidance(channel);
    for (const disclosure of essentials[channel]) {
      assert.match(text, disclosure, `${channel} guide must disclose ${disclosure}`);
    }
    assert.doesNotMatch(text, /readiness\.ready|Run `publish \w+ info`/);
  }
  assert.doesNotMatch(guidance("xhs"), /docs\/XHS_(?:DESIGN|HANDOFF)\.md/);
  assert.doesNotMatch(guidance("x"), /reply target preserved|target preserved|Already staged a reply to/i);
});

test("X Article cover selection is explicit and never scans neighboring images", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-selection-"));
  try {
    writeFileSync(join(dir, "z-cover.png"), validTinyXArticleCoverPng());
    writeFileSync(join(dir, "a-cover.png"), validTinyXArticleCoverPng());

    const selected = preloadXArticleCover(join(dir, "z-cover.png"));
    assert.equal(selected.selection, "explicit");
    assert.equal(selected.fileName, "x-article-cover.png");
    assert.equal(selected.width, 5);
    assert.equal(selected.height, 2);
    assert.equal(selected.ratio, "exact_5_2");
    assert.doesNotMatch(JSON.stringify(selected), /a-cover|z-cover|publish-x-cover-selection/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("info keeps Markdown guidance separate from readiness, sanitizes failures, and exits zero", async () => {
  const success = await executeChannelInfo("x", async () => ready("x"));
  assert.equal(success.exitCode, 0);
  assert.equal(success.envelope.schemaVersion, CHANNEL_INFO_SCHEMA_VERSION);
  assert.equal(success.envelope.mode, "readiness");
  assert.deepEqual(success.envelope.access, { readinessProbe: "attempted" });
  assert.equal(success.envelope.info.channel, "x");
  if (success.envelope.mode !== "readiness") assert.fail("expected readiness mode");
  assert.equal(success.envelope.readiness.ready, true);

  const notReadyReceipt = ready("reddit");
  notReadyReceipt.ready = false;
  notReadyReceipt.status = "login_required";
  const notReady = await executeChannelInfo("reddit", async () => notReadyReceipt);
  assert.equal(notReady.exitCode, 0);
  assert.equal(notReady.envelope.info.channel, "reddit");
  if (notReady.envelope.mode !== "readiness") assert.fail("expected readiness mode");
  assert.equal(notReady.envelope.readiness.ready, false);

  const failure = await executeChannelInfo("linkedin", async () => {
    throw new Error("raw token SECRET_VALUE");
  }, () => Date.parse(CHECKED_AT));
  assert.equal(failure.exitCode, 0);
  assert.equal(failure.envelope.info.channel, "linkedin");
  if (failure.envelope.mode !== "readiness") assert.fail("expected readiness mode");
  assert.equal(failure.envelope.readiness.status, "probe_inconclusive");
  assert.doesNotMatch(JSON.stringify(failure.envelope), /SECRET_VALUE|raw token/);
  const failureRendered = renderChannelInfo(failure.envelope);
  assert.match(
    failureRendered,
    /Recovery context: cli_owned_persistent_profile \(owner=publish_cli; launch=intended_cli_action_with_inspect\)/,
  );
  assert.match(failureRendered, /intended authenticated linkedin CLI action with --inspect/);
  assert.doesNotMatch(failureRendered, /SECRET_VALUE|raw token/);
});

test("human info is readiness-first and renders the three Markdown sections", () => {
  const readiness = ready("wechat");
  readiness.healed = ["token_refreshed"];
  const rendered = renderChannelInfo({
    schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
    mode: "readiness",
    channel: "wechat",
    info: CHANNEL_INFO_SOURCES.wechat,
    readiness,
    access: { readinessProbe: "attempted" },
  });
  assert.ok(rendered.indexOf("Readiness: ready") < rendered.indexOf("## CLI boundary"));
  assert.match(rendered, /Healed: token_refreshed/);
  assert.match(rendered, /Exit behavior: info returns 0 even when not ready/);
  assert.match(rendered, /publish wechat info --json/);
  assert.match(rendered, /## CLI boundary/);
  assert.match(rendered, /## Authentication/);
  assert.match(rendered, /## Platform specification and gotchas/);
  assert.match(rendered, /freepublish\/\*/);
});

test("external readiness descriptors render their owned context and static workflow", async () => {
  const registry = createAuthProbeRegistry({ now: () => Date.parse(CHECKED_AT) });
  const xhsReadiness = await registry.xhs();
  const xhsRendered = renderChannelInfo({
    schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
    mode: "readiness",
    channel: "xhs",
    info: CHANNEL_INFO_SOURCES.xhs,
    readiness: xhsReadiness,
    access: { readinessProbe: "attempted" },
  });
  assert.match(xhsRendered, /external preflight required \(agent_check_required\)/);
  assert.match(xhsRendered, /Next owner: agent_browser/);
  assert.doesNotMatch(xhsRendered, /Next owner: agent_browser \(human participation required\)/);
  assert.match(
    xhsRendered,
    /Recovery context: agent_owned_browser \(owner=agent_browser; launch=entry_url\)/,
  );
  assert.match(xhsRendered, /Next: Open the creator portal with the browser agent/);
  assert.match(xhsRendered, /continue.*same browser context/is);
  assert.match(xhsRendered, /Recovery help: publish xhs info --static/);
  assert.equal(xhsReadiness.requiresHuman, false);

  const acresReadiness = await registry["1point3acres"]();
  const acresRendered = renderChannelInfo({
    schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
    mode: "readiness",
    channel: "1point3acres",
    info: CHANNEL_INFO_SOURCES["1point3acres"],
    readiness: acresReadiness,
    access: { readinessProbe: "attempted" },
  });
  assert.match(acresRendered, /human login required \(human_login_required\)/);
  assert.match(acresRendered, /human open and log in/i);
  assert.match(acresRendered, /automation is available and the user has explicitly authorized it/i);
  assert.match(acresRendered, /otherwise the human follows the same guidance/i);
  assert.match(
    acresRendered,
    /Recovery context: human_owned_handoff \(owner=human; launch=entry_url\)/,
  );
  assert.equal(acresReadiness.nextStep?.executor, "human");
  assert.equal(acresReadiness.nextStep?.continueInSameContext, true);
  assert.equal(acresReadiness.requiresHuman, true);
  assert.match(acresRendered, /Recovery help: publish 1point3acres info --static/);
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

test("X generation rejects rather than shortening weighted overflow", async () => {
  await assert.rejects(
    generateContent("汉".repeat(141), { format: "tweet" }),
    (error: Error & { problem?: { actual?: number; expected?: string; unit?: string } }) => {
      assert.match(error.message, /282 weighted chars/);
      assert.equal(error.problem?.actual, 282);
      assert.equal(error.problem?.expected, "<= 280");
      assert.equal(error.problem?.unit, "twitter_text_weighted");
      return true;
    },
  );
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

  assert.throws(
    () => generatePost("😀".repeat(1501)),
    (error: Error & { problem?: { actual?: number; expected?: string; unit?: string } }) => {
      assert.match(error.message, /3002 UTF-16 code units/);
      assert.equal(error.problem?.actual, 3002);
      assert.equal(error.problem?.expected, "<= 3000");
      assert.equal(error.problem?.unit, "utf16_code_units");
      return true;
    },
  );
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
    writeFileSync(cover, bmpHeader(900, 900));
    const article = generateArticle(`# ${"题".repeat(64)}\n\nBody paragraph`, { cover });
    assert.equal(article.title, "题".repeat(64));
    assert.equal(article.digest, "");
    assert.ok(article.warnings.some((warning) => /first 54 字/.test(warning)));

    const bodyGif = join(dir, "body.gif");
    writeFileSync(bodyGif, gifHeader(800, 600));
    assert.throws(
      () => generateArticle("# Title\n\n![body](body.gif)", { cover, baseDir: dir }),
      (error: unknown) => {
        const local = error as Error & {
          problem?: { code?: string; actual?: string; expected?: string; unit?: string };
        };
        assert.equal(
          local.message,
          `body image must use .jpg/.jpeg/.png ` +
            `(actual: image/gif; expected: .jpg/.jpeg/.png): ${bodyGif}`,
        );
        assert.doesNotMatch(local.message, /Please report this|markedjs/);
        assert.equal(local.problem?.code, "wechat_image_type_unsupported");
        assert.equal(local.problem?.actual, "image/gif");
        assert.equal(local.problem?.expected, ".jpg/.jpeg/.png");
        assert.equal(local.problem?.unit, "content_type");
        return true;
      },
    );

    const documentedLabelCover = join(dir, "documented-label-cover.jpg");
    const documentedLabelBody = join(dir, "documented-label-body.png");
    writeFileSync(documentedLabelCover, Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
    ]));
    writeFileSync(documentedLabelBody, pngHeader(800, 600));
    truncateSync(documentedLabelCover, 10_000_000);
    truncateSync(documentedLabelBody, 1_000_000);
    const validatedCover = validateWechatLocalImage(documentedLabelCover, "cover");
    assert.equal(validatedCover.valid, true);
    assert.equal(validatedCover.contentType, "image/jpeg");
    assert.equal(validatedCover.sizeBytes, 10_000_000);
    assert.equal(validatedCover.width, 800);
    assert.equal(validatedCover.height, 600);
    assert.equal(validatedCover.maximumBytes, null);
    const validatedBody = validateWechatLocalImage(documentedLabelBody, "body");
    assert.equal(validatedBody.valid, true);
    assert.equal(validatedBody.maximumBytes, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("X action help keeps List, watch, history, and Article input boundaries discoverable", () => {
  const createWatchListHelp = spawnSync(
    process.execPath,
    [CLI_PATH, "x", "create-watch-list", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(createWatchListHelp.status, 0);
  for (const evidence of [
    /List member-add safety \(read before any mutation\)/,
    /Run --dry-run first to inspect the exact proposed delta/,
    /large initial build.*account-wide member-add lock.*native UI across every List/s,
    /Live observation 2026-07-01.*72-member build.*about 350 ms per add.*recovery was around 24 hours/s,
    /duration and all current limits remain X\/server-authoritative, not a retry timer/,
    /command stops.*Do not retry member adds until X permits them again/s,
    /existing --x-list adds only the missing delta.*about 3 seconds each.*safer.*not guaranteed/s,
    /can mutate List creation, membership, and privacy, but it never publishes content/,
  ]) assert.match(createWatchListHelp.stdout, evidence);

  const watchHelp = spawnSync(process.execPath, [CLI_PATH, "x", "watch", "--help"], {
    encoding: "utf8",
  });
  assert.equal(watchHelp.status, 0);
  for (const evidence of [
    /Watch accounts through one X List timeline, not one profile load per account/,
    /Editorial selection strategy belongs to the caller/,
    /must supply a self-contained rubric.*classifier receives only that rubric and each candidate post/s,
    /never a source essay, campaign brief, workspace files, or ambient agent context/,
    /intended replier, audience, positive and negative selection criteria, and what useful additional value means/,
    /--no-triage when the caller will judge raw candidates/,
    /never publishes or stages content/,
  ]) assert.match(watchHelp.stdout, evidence);

  const historyHelp = spawnSync(process.execPath, [CLI_PATH, "x", "history", "--help"], {
    encoding: "utf8",
  });
  assert.equal(historyHelp.status, 0);
  for (const evidence of [
    /only live posts and replies authored by the requested X profile/,
    /Staged tweet\/thread\/reply drafts and Article drafts are never history results/,
    /empty success requires usable profile-timeline capture and extraction/,
    /Missing or unusable capture\/extraction evidence fails nonzero and loud.*never reported as an empty history/s,
    /never publishes or stages content/,
  ]) assert.match(historyHelp.stdout, evidence);

  const draftHelp = spawnSync(process.execPath, [CLI_PATH, "x", "draft", "--help"], {
    encoding: "utf8",
  });
  assert.equal(draftHelp.status, 0);
  assert.match(
    draftHelp.stdout,
    /native editor exposes exactly two heading levels, Heading and Subheading.*ATX H1\/H2 body headings/s,
  );
  assert.match(draftHelp.stdout, /H3-H6 and Setext headings reject locally/);
  assert.match(draftHelp.stdout, /Inline backtick-code styling is unsupported and rejects locally/);
});

test("info CLI has no --format and non-ready external info exits zero", () => {
  const rootHelp = spawnSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8" });
  assert.equal(rootHelp.status, 0);
  for (const channel of AUTH_PLATFORMS) assert.match(rootHelp.stdout, new RegExp(`\\b${channel}\\b`));

  const help = spawnSync(process.execPath, [CLI_PATH, "x", "info", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--format/);
  assert.match(help.stdout, /--static/);
  assert.match(help.stdout, /without profile, browser,\s+network, API, token, or platform access/);
  assert.match(help.stdout, /readiness is explicitly skipped/);
  assert.doesNotMatch(help.stdout, /WeChat|token_refreshed/);

  const wechatInfoHelp = spawnSync(process.execPath, [CLI_PATH, "wechat", "info", "--help"], { encoding: "utf8" });
  assert.equal(wechatInfoHelp.status, 0);
  assert.match(wechatInfoHelp.stdout, /token_refreshed/);

  const wechatDraftHelp = spawnSync(process.execPath, [CLI_PATH, "wechat", "draft", "--help"], { encoding: "utf8" });
  assert.equal(wechatDraftHelp.status, 0);
  assert.match(
    wechatDraftHelp.stdout,
    /Explicit --author \(blank or whitespace intentionally clears\).*file\/stdin frontmatter author > trimmed WECHAT_AUTHOR > empty/s,
  );

  const xDraftHelp = spawnSync(process.execPath, [CLI_PATH, "x", "draft", "--help"], { encoding: "utf8" });
  assert.equal(xDraftHelp.status, 0);
  assert.match(xDraftHelp.stdout, /Required: tweet \| thread \| article/);
  assert.match(xDraftHelp.stdout, /local 25,000-code-point guard/);
  for (const evidence of [
    /leading empty or YAML mapping block.*metadata only and is removed/s,
    /Metadata keys are ignored; an Article title comes from the normalized Markdown body/,
    /BOM and LF\/CRLF\/lone-CR delimiters are recognized/,
    /mapping-intent malformed or unterminated metadata exits 2/,
    /Valid scalar\/sequence blocks and thematic-break prose remain literal Markdown apart from a leading transport BOM/,
    /Inline --text is always literal/,
    /Tweet\/thread staging invokes the close→Save action; Article staging invokes Create\/autosave/,
    /one calibrated native Unsent row whose full text exactly matches the intended tweet or first thread row/,
    /visible scoped-row multiset equal to the read-only pre-Save baseline plus that one value/,
    /Matching background\/page text, a prefix, a pre-existing identical visible row, duplicate matches, unreadable rows/,
    /no stable native row id and does not prove full-list completeness or causality/,
    /Article requires one explicit --cover path; tweet and thread reject that flag/,
    /never scans neighboring files and never crops, resizes, compresses, or converts the cover/,
    /Article success requires one unique title\/body editor root, a clean pre-set cover\/dialog baseline, one direct returned set on its calibrated same-parent cover input, and authoritative native persistence/,
    /Observation accepts only the exact noneditable native Media atom and excludes only that atom's UI text/,
    /X may rewrite uploaded bytes.*same-origin blob preview must be nonempty with a valid digest, positive byte count, expected available MIME, and exact dimensions.*first positive native digest is domain-bound.*source digest and size remain requested-input evidence.*identity-kind transitions fail closed/s,
    /same ordered identity kind, digest, and dimensions before and after reopening the same canonical draft URL; preview URLs are never emitted/,
    /Apply provenance remains not_attempted, delivery_unknown, or returned and is never retried or rewritten/,
    /complete native-state proof may close not_attempted or delivery_unknown without claiming Apply returned/,
    /immediate post-Create URL is provisional; a missing\/invalid late sample or conflicting positive samples are never used for navigation or verification/,
    /returned Article outcome reports bounded body\/code facts, distinct cover requested\/resolved\/set\/uploaded\/observed\/verified evidence.*body-image evidence/s,
    /rejected native cover or body-image input set leaves set unknown.*never retries or uses another upload route/s,
    /rejected Save\/Create action has unknown delivery.*returned action without a positive reopen match is unverified/s,
    /Both exit 1 because a draft may exist/,
    /compare X Unsent\/Drafts or X Articles → Drafts manually in the exact CLI-owned profile/,
    /Never retry automatically.*--inspect and selector calibration do not prove persistence/s,
  ]) assert.match(xDraftHelp.stdout, evidence);

  const xReplyHelp = spawnSync(process.execPath, [CLI_PATH, "x", "reply", "--help"], { encoding: "utf8" });
  assert.equal(xReplyHelp.status, 0);
  for (const evidence of [
    /leading empty or YAML mapping block.*metadata only and is removed/s,
    /Metadata keys are ignored; reply text comes only from the normalized Markdown body/,
    /BOM and LF\/CRLF\/lone-CR delimiters are recognized/,
    /mapping-intent malformed or unterminated metadata exits 2/,
    /Valid scalar\/sequence blocks and thematic-break prose remain literal Markdown apart from a leading transport BOM/,
    /Inline --text is always literal/,
    /--to is exact: whitespace, BOM\/control characters, and backslashes are rejected/,
    /raw ID is 5–25 ASCII digits matching \[1-9\]\[0-9\]\{4,24\}; leading zeroes are rejected/,
    /URL must use HTTPS with the exact apex host x\.com or twitter\.com/,
    /without credentials, an explicit port \(including :443\), a trailing-dot host, or subdomain such as www\/mobile/,
    /Scheme and host are case-insensitive/,
    /exact case-sensitive paths are \/<handle>\/status\/<id>, \/<handle>\/statuses\/<id>, \/i\/status\/<id>, or \/i\/web\/status\/<id>/,
    /<handle> is 1–15 ASCII letters, digits, or underscores/,
    /One trailing slash is allowed/,
    /Percent encoding in the status path, dot\/extra path segments, or URL-normalized path forms are rejected/,
    /query and fragment are allowed and ignored only after the path validates; the reply ID always comes from the path/,
    /--dry-run skips the reply ledger\/reservations and all browser\/profile\/database state/,
    /Target ID\/URL validation is syntax-only; existence, visibility, and reply eligibility remain unverified until a real run reaches X/,
    /real run first claims the normalized target, then may refuse finalized history unless --force/,
    /--force never bypasses an in-flight or retained reservation/,
    /Coordination is one-machine\/local-profile only: real runs must share the same live SQLite file and opaque X profile origin/,
    /DB binds atomically before browser loading.*different profile or copied DB fails before X/s,
    /First post-upgrade binding is prospective: legacy rows survive with origin unknown and cannot be attributed, force-bypassed, or recovered/,
    /Help and --dry-run do not create or read the identity/,
    /--force bypasses matching-origin finalized history only; it never bypasses a reservation or unknown\/mismatched origin/,
    /matching-origin claim aged 24 hours is only eligible for explicit review-based recovery/,
    /Recovery reports only the opaque origin id and matched\/unknown\/mismatch/,
    /--recover-stale-reservation-after-confirming-no-draft attests the prior process stopped, X Unsent\/Drafts was checked in the exact CLI-owned profile used by that run, and no matching reply draft was found/,
    /If a matching draft exists or the comparison is uncertain, leave the reservation in place/,
    /Recovery clears only the stale claim and exits/,
    /poster reports one closed phase: Save not attempted, Save delivery unknown, Save returned but persistence unverified, or verified in X Unsent\/Drafts/,
    /one calibrated native Unsent row whose full text exactly matches the intended first reply row/,
    /visible scoped-row multiset equal to the read-only pre-Save baseline plus that one value/,
    /Matching background\/page text, a prefix, a pre-existing identical visible row, duplicate matches, unreadable rows/,
    /no stable native row id and does not prove full-list completeness or causality/,
    /Reply target identity is separate from content-row persistence/,
    /requested compose URL, Replying-to label, content\/background links, and caller intent are never target proof/,
    /Live calibration found no exact numeric target-id signal in the content-matched Unsent row or its reopened composer/,
    /Every current returned reply Save finalizes staged-unverified history and exits 1, even when the content row verifies/,
    /Only content plus an exact target id bound to the same matched draft could exit 0/,
    /Typed proof that Save was not attempted releases only this run's owner- and origin-matched reservation/,
    /delivery-unknown or malformed whole result retains it/,
    /typed Save-delivered-unverified error finalizes staged-unverified protection without inventing missing row or target facts/,
    /Only after confidently finding no matching draft may a separate --force run intentionally bypass staged-unverified finalized history/,
    /If reply-ledger finalization\/close fails after Save-phase evidence, exit 1; the draft may exist/,
    /Before any retry, compare X Unsent\/Drafts manually in the exact CLI-owned profile used by the failed run/,
    /--inspect and selector calibration cannot repair a reply-ledger failure/,
  ]) assert.match(xReplyHelp.stdout, evidence);
  assert.doesNotMatch(xReplyHelp.stdout, /reply target preserved|target preserved|Already staged a reply to/i);

  const redditDraftHelp = spawnSync(process.execPath, [CLI_PATH, "reddit", "draft", "--help"], { encoding: "utf8" });
  assert.equal(redditDraftHelp.status, 0);
  assert.match(redditDraftHelp.stdout, /validate locally; skips live subreddit\s+preflight/);
  assert.match(redditDraftHelp.stdout, /Accepted keys: subreddit, title, flair/);
  assert.match(redditDraftHelp.stdout, /Empty --subreddit\/--title values reject; empty --flair intentionally clears metadata/);
  assert.match(redditDraftHelp.stdout, /BOM and LF\/CRLF\/lone-CR delimiters are recognized/);
  assert.match(redditDraftHelp.stdout, /only the first substantive block establishes mapping intent/);
  assert.match(redditDraftHelp.stdout, /Valid scalar\/sequence blocks remain literal Markdown/);
  assert.match(redditDraftHelp.stdout, /Inline --text is always literal/);
  assert.match(redditDraftHelp.stdout, /4-space-indented code/);
  assert.match(redditDraftHelp.stdout, /Tables should use outer pipes/);
  assert.match(redditDraftHelp.stdout, /Inline body images are not uploaded or verified/);
  assert.match(redditDraftHelp.stdout, /toast to be absent before the one Save Draft click/);
  assert.match(redditDraftHelp.stdout, /compare DRAFTS manually in the same\s+CLI-owned profile.*Never blindly retry.*duplicate risk.*no draft idempotency ledger/s);

  const wechatCheckHelp = spawnSync(process.execPath, [CLI_PATH, "wechat", "check", "--help"], { encoding: "utf8" });
  assert.equal(wechatCheckHelp.status, 0);
  assert.match(wechatCheckHelp.stdout, /WECHAT_SSH_TUNNEL=\[user@\]host\[:port\]/);
  assert.match(wechatCheckHelp.stdout, /WECHAT_PROXY_URL=socks5:\/\//);
  assert.match(wechatCheckHelp.stdout, /developers\.weixin\.qq\.com\/platform/);
  assert.match(wechatCheckHelp.stdout, /If it returns 40164, add the exact reported egress IP/);

  const rejected = spawnSync(process.execPath, [CLI_PATH, "x", "info", "--format", "tweet"], { encoding: "utf8" });
  assert.equal(rejected.status, 2);

  const wechatHelp = spawnSync(process.execPath, [CLI_PATH, "wechat", "draft", "--help"], { encoding: "utf8" });
  assert.equal(wechatHelp.status, 0);
  assert.match(wechatHelp.stdout, /32 字/);
  assert.doesNotMatch(wechatHelp.stdout, /64 code points/);
  for (const evidence of [
    /leading empty or YAML mapping block.*metadata only and is removed/s,
    /description\/summary\/digest.*coverImage\/cover\/image/s,
    /sourceUrl\/contentSourceUrl\/source_url.*Flags override metadata/s,
    /Relative metadata cover and body-image paths resolve beside a --from file \(CWD for stdin\)/,
    /BOM and LF\/CRLF\/lone-CR delimiters are recognized/,
    /mapping-intent malformed or\s+unterminated metadata exits 2 before --out, token, upload, or API access/s,
    /Valid scalar\/sequence blocks and thematic-break prose remain literal Markdown/,
    /Inline --text is always literal/,
    /Raw HTML is unsupported, including nested block\/inline tags, attributes, and comments/,
    /Markdown links allow explicit.*http\(s\), mailto, relative URLs, and fragments/s,
    /images allow explicit http\(s\) or local.*--source-url requires\s+absolute explicit http\(s\)/s,
    /Windows drive-absolute, never UNC\/network paths/s,
    /scheme-relative destinations\s+exit 2 before image reads.*--out.*API access/s,
    /malformed\/backslash, userinfo-bearing, surrounding-whitespace, control-bearing/s,
    /Dynamic HTML attributes.*escaped.*exact local\s+image identity\/order/s,
  ]) assert.match(wechatHelp.stdout, evidence);

  const xhs = spawnSync(process.execPath, [CLI_PATH, "xhs", "info", "--json"], { encoding: "utf8" });
  assert.equal(xhs.status, 0, xhs.stderr);
  const receipt = JSON.parse(xhs.stdout) as {
    schemaVersion: string;
    channel: string;
    info: { cliBoundary: string; authentication: string; platformGuidance: string };
    readiness: { ready: boolean };
  };
  assert.equal(receipt.schemaVersion, CHANNEL_INFO_SCHEMA_VERSION);
  assert.equal(receipt.channel, "xhs");
  assert.match(receipt.info.cliBoundary, /no Xiaohongshu read or write transport/);
  assert.match(receipt.info.authentication, /same browser profile through save and verification/);
  assert.equal(receipt.info.platformGuidance, CHANNEL_INFO_SOURCES.xhs.platformGuidance);
  assert.doesNotMatch(JSON.stringify(receipt.info), /XHS_DESIGN|XHS_HANDOFF|docs\//);
  assert.equal(receipt.readiness.ready, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AUTH_PLATFORMS, createAuthProbeRegistry, type AuthReadiness } from "../auth/index.js";
import { executeChannelInfo, renderChannelInfo } from "../commands/channel-info.js";
import { generatePost } from "../linkedin/content.js";
import { generateContent } from "../x/content.js";
import { generateArticle } from "../wechat/content.js";
import {
  CHANNEL_INFO_SCHEMA_VERSION,
  CHANNEL_INFO_SOURCE_SCHEMA_VERSION,
  CHANNEL_INFO_SOURCES,
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

test("free-text guidance preserves each channel's execution handoff and essential gotchas", () => {
  const x = `${CHANNEL_INFO_SOURCES.x.cliBoundary}\n${CHANNEL_INFO_SOURCES.x.authentication}\n${CHANNEL_INFO_SOURCES.x.platformGuidance}`;
  assert.match(x, /watch List/);
  assert.match(x, /tweet, thread, Article, or reply drafts/);
  assert.match(x, /5:2/);
  assert.match(x, /280/);
  assert.match(x, /publish x draft --format article --from/);
  assert.match(x, /before any authenticated X action.*create-watch-list.*watch.*draft.*reply.*history/);
  assert.match(x, /directory containing the `--from` Markdown/);
  assert.match(x, /intended authenticated action with `--inspect`/);
  assert.match(x, /do not stage a draft merely to authenticate read\/list work/);
  assert.match(x, /never (posts|publishes)|must not (post|publish)/i);
  assert.match(x, /credentials are missing or rejected/);
  assert.doesNotMatch(x, /Run `publish x info`|readiness\.ready/);

  const linkedin = `${CHANNEL_INFO_SOURCES.linkedin.cliBoundary}\n${CHANNEL_INFO_SOURCES.linkedin.authentication}\n${CHANNEL_INFO_SOURCES.linkedin.platformGuidance}`;
  assert.match(linkedin, /personal-feed text post/);
  assert.match(linkedin, /3,?000/);
  assert.match(linkedin, /3:1/);
  assert.match(linkedin, /4:5/);
  assert.match(linkedin, /credentials are missing or rejected/);
  assert.match(linkedin, /intended draft with `--inspect`/);
  assert.doesNotMatch(linkedin, /Run `publish linkedin info`|readiness\.ready/);

  const reddit = `${CHANNEL_INFO_SOURCES.reddit.cliBoundary}\n${CHANNEL_INFO_SOURCES.reddit.authentication}\n${CHANNEL_INFO_SOURCES.reddit.platformGuidance}`;
  assert.match(reddit, /search for communities/);
  assert.match(reddit, /inspect a community/);
  assert.match(reddit, /Save Draft/);
  assert.match(reddit, /CAPTCHA/);
  assert.match(reddit, /publish reddit draft --subreddit <name> --title <title>/);
  assert.match(reddit, /intended draft with `--inspect`/);
  assert.doesNotMatch(reddit, /Run `publish reddit info`|readiness\.ready/);

  const wechat = `${CHANNEL_INFO_SOURCES.wechat.cliBoundary}\n${CHANNEL_INFO_SOURCES.wechat.authentication}\n${CHANNEL_INFO_SOURCES.wechat.platformGuidance}`;
  assert.match(wechat, /draft\/add/);
  assert.match(wechat, /freepublish\/\*/);
  assert.match(wechat, /32.*16.*120.*字/s);
  assert.match(wechat, /2\.35:1/);
  assert.match(wechat, /1:1/);
  assert.match(wechat, /WECHAT_SSH_TUNNEL/);
  assert.match(wechat, /WECHAT_PROXY_URL/);
  assert.match(wechat, /socks5:\/\//);
  assert.match(wechat, /40164/);

  const xhs = `${CHANNEL_INFO_SOURCES.xhs.cliBoundary}\n${CHANNEL_INFO_SOURCES.xhs.authentication}\n${CHANNEL_INFO_SOURCES.xhs.platformGuidance}`;
  assert.match(xhs, /CLI offers no functionality to access or write Xiaohongshu/);
  assert.match(xhs, /agent is expected to use its own/);
  assert.match(xhs, /documented external workflow/);
  assert.match(xhs, /creator\.xiaohongshu\.com/);
  assert.match(xhs, /\.md|Markdown/);
  assert.match(xhs, /64/);
  assert.match(xhs, /10,?000/);
  assert.match(xhs, /1,?000/);
  assert.match(xhs, /browser-local/i);
  assert.match(xhs, /copy the first Markdown H1/);
  assert.match(xhs, /Default to a plain long article/);
  assert.match(xhs, /Only when image cards are requested/);
  assert.match(xhs, /Only when topics are requested/);

  const acres = `${CHANNEL_INFO_SOURCES["1point3acres"].cliBoundary}\n${CHANNEL_INFO_SOURCES["1point3acres"].authentication}\n${CHANNEL_INFO_SOURCES["1point3acres"].platformGuidance}`;
  assert.match(acres, /CLI offers no functionality to access or write 1point3acres/);
  assert.match(acres, /human to open and log in/);
  assert.match(acres, /agent takes over in that same context/);
  assert.match(acres, /98/);
  assert.match(acres, /29/);
  assert.match(acres, /28/);
  assert.match(acres, /保存草稿/);
  assert.match(acres, /No calibrated authenticated\/save-success marker/);
});

test("X Article cover selection has a deterministic lexical tie-break", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-selection-"));
  try {
    const basePath = join(dir, "article.md");
    writeFileSync(basePath, "# Article\n");
    const pngHeader = (width: number, height: number) => {
      const buffer = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
      buffer.writeUInt32BE(width, 16);
      buffer.writeUInt32BE(height, 20);
      return buffer;
    };
    writeFileSync(join(dir, "z-cover.png"), pngHeader(1500, 600));
    writeFileSync(join(dir, "a-cover.png"), pngHeader(1500, 600));

    const { resolveHeroImage } = await import("../x/draftPoster.js");
    const selected = resolveHeroImage(basePath);
    assert.equal(selected.path, join(dir, "a-cover.png"));
    assert.equal(selected.width, 1500);
    assert.equal(selected.height, 600);
    assert.equal(selected.ratioOk, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("info keeps Markdown guidance separate from readiness, sanitizes failures, and exits zero", async () => {
  const success = await executeChannelInfo("x", async () => ready("x"));
  assert.equal(success.exitCode, 0);
  assert.equal(success.envelope.schemaVersion, CHANNEL_INFO_SCHEMA_VERSION);
  assert.equal(success.envelope.info.channel, "x");
  assert.equal(success.envelope.readiness.ready, true);

  const notReadyReceipt = ready("reddit");
  notReadyReceipt.ready = false;
  notReadyReceipt.status = "login_required";
  const notReady = await executeChannelInfo("reddit", async () => notReadyReceipt);
  assert.equal(notReady.exitCode, 0);
  assert.equal(notReady.envelope.info.channel, "reddit");
  assert.equal(notReady.envelope.readiness.ready, false);

  const failure = await executeChannelInfo("linkedin", async () => {
    throw new Error("raw token SECRET_VALUE");
  }, () => Date.parse(CHECKED_AT));
  assert.equal(failure.exitCode, 0);
  assert.equal(failure.envelope.info.channel, "linkedin");
  assert.equal(failure.envelope.readiness.status, "probe_inconclusive");
  assert.doesNotMatch(JSON.stringify(failure.envelope), /SECRET_VALUE|raw token/);
});

test("human info is readiness-first and renders the three Markdown sections", () => {
  const readiness = ready("wechat");
  readiness.healed = ["token_refreshed"];
  const rendered = renderChannelInfo({
    schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
    channel: "wechat",
    info: CHANNEL_INFO_SOURCES.wechat,
    readiness,
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

test("external readiness descriptors remain actionable without a typed static workflow", async () => {
  const registry = createAuthProbeRegistry({ now: () => Date.parse(CHECKED_AT) });
  const xhsReadiness = await registry.xhs();
  const xhsRendered = renderChannelInfo({
    schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
    channel: "xhs",
    info: CHANNEL_INFO_SOURCES.xhs,
    readiness: xhsReadiness,
  });
  assert.match(xhsRendered, /external preflight required \(agent_check_required\)/);
  assert.match(xhsRendered, /Next owner: agent_browser/);
  assert.doesNotMatch(xhsRendered, /Next owner: agent_browser \(human participation required\)/);
  assert.match(xhsRendered, /Next: Open the creator portal with the browser agent/);
  assert.match(xhsRendered, /continue.*same browser context/is);
  assert.doesNotMatch(xhsRendered, /Recovery help:/);
  assert.equal(xhsReadiness.requiresHuman, false);

  const acresReadiness = await registry["1point3acres"]();
  const acresRendered = renderChannelInfo({
    schemaVersion: CHANNEL_INFO_SCHEMA_VERSION,
    channel: "1point3acres",
    info: CHANNEL_INFO_SOURCES["1point3acres"],
    readiness: acresReadiness,
  });
  assert.match(acresRendered, /human login required \(human_login_required\)/);
  assert.match(acresRendered, /human open and log in/i);
  assert.match(acresRendered, /hand that same context to the agent/i);
  assert.doesNotMatch(acresRendered, /browser agents must not operate/i);
  assert.doesNotMatch(acresRendered, /Recovery help:/);
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

test("info CLI has no --format and non-ready external info exits zero", () => {
  const rootHelp = spawnSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8" });
  assert.equal(rootHelp.status, 0);
  for (const channel of AUTH_PLATFORMS) assert.match(rootHelp.stdout, new RegExp(`\\b${channel}\\b`));

  const help = spawnSync(process.execPath, [CLI_PATH, "x", "info", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--format/);
  assert.doesNotMatch(help.stdout, /WeChat|token_refreshed/);

  const wechatInfoHelp = spawnSync(process.execPath, [CLI_PATH, "wechat", "info", "--help"], { encoding: "utf8" });
  assert.equal(wechatInfoHelp.status, 0);
  assert.match(wechatInfoHelp.stdout, /token_refreshed/);

  const xDraftHelp = spawnSync(process.execPath, [CLI_PATH, "x", "draft", "--help"], { encoding: "utf8" });
  assert.equal(xDraftHelp.status, 0);
  assert.match(xDraftHelp.stdout, /Required: tweet \| thread \| article/);
  assert.match(xDraftHelp.stdout, /local 25,000-code-point guard/);

  const redditDraftHelp = spawnSync(process.execPath, [CLI_PATH, "reddit", "draft", "--help"], { encoding: "utf8" });
  assert.equal(redditDraftHelp.status, 0);
  assert.match(redditDraftHelp.stdout, /validate locally; skips live subreddit\s+preflight/);

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

  const xhs = spawnSync(process.execPath, [CLI_PATH, "xhs", "info", "--json"], { encoding: "utf8" });
  assert.equal(xhs.status, 0, xhs.stderr);
  const receipt = JSON.parse(xhs.stdout) as { info: { platformGuidance: string }; readiness: { ready: boolean } };
  assert.match(receipt.info.platformGuidance, /Markdown|\.md/);
  assert.equal(receipt.readiness.ready, false);
});

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

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
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

test("free-text guidance preserves each channel's execution handoff and essential gotchas", () => {
  const x = `${CHANNEL_INFO_SOURCES.x.cliBoundary}\n${CHANNEL_INFO_SOURCES.x.authentication}\n${CHANNEL_INFO_SOURCES.x.platformGuidance}`;
  assert.match(x, /watch List/);
  assert.match(x, /tweet, thread, Article, or reply drafts/);
  assert.match(x, /5:2/);
  assert.match(x, /280/);
  assert.match(x, /publish x draft --format article --from/);
  assert.match(x, /top-level backtick or tilde fenced block with zero through three leading spaces may close explicitly or at end of input/);
  assert.match(x, /EOF-closed block preserves its LF-normalized code payload, including trailing spaces and blank or whitespace-only lines/);
  assert.match(x, /recognized top-level Article fenced block has one advisory, is excluded from the native rich-HTML paste, and is counted in both verified and unverified Article handoff receipts/);
  assert.match(x, /complete remaining Markdown is canonical.*retains the consumed title line plus every body byte/s);
  assert.match(x, /documented `Plain title` followed immediately by a body line is supported/);
  assert.match(x, /native title content is limited to plain or escaped text with representable edge characters/);
  assert.match(x, /title formatting, links, code, entity-like spellings, and caller-owned edge whitespace\/format characters reject locally/);
  assert.match(x, /A consumed H1 never causes a following body H1\/H2 to disappear/);
  assert.match(x, /lossless Article Markdown subset is closed/);
  assert.match(x, /Body blocks may be paragraphs, ATX H1\/H2 headings, flat single-paragraph quotes, one tight flat bullet or start-at-1 ordered list group at a time, and top-level backtick\/tilde fences/);
  assert.match(x, /Inline content may be plain or escaped text, emphasis, strong emphasis, soft breaks, and title-free exact safe absolute HTTP\(S\) links/);
  assert.match(x, /Active links use ordinary `\[label\]\(destination\)` syntax whose raw destination bytes equal the staged href/);
  assert.match(x, /angle-bracket, padded, multiline, titled, or backslash-normalized destinations reject locally/);
  assert.match(x, /checkbox-looking bullet text.*remains literal CommonMark list text rather than a task-list semantic/);
  assert.match(x, /nonempty spaces\/tabs-only physical line rejects when the parser swallows it into a root paragraph or supported quote child.*tabs that remain content inside a paragraph, heading, quote, or fenced payload are preserved/s);
  assert.match(x, /Literal tabs anywhere in a list root\/item reject locally because the CommonMark list tokenizer can expand them/);
  assert.match(x, /caller-owned Unicode trim\/control\/format edges on body ATX headings, parser-trimmed non-CommonMark-blank list edges or continuation lines, and other source-normalized link destinations also stop before artifacts or native staging/);
  assert.match(x, /H3-H6, Setext headings, thematic breaks, reference definitions, raw HTML, indented code.*adjacent distinct same-kind list groups.*inline code, hard breaks, images, U\+0000, unescaped entity-like spellings.*exit 2 locally/s);
  assert.match(x, /before inspection rendering, artifact writes, staging-runtime\/profile\/browser imports, or platform\/state access/);
  assert.match(x, /Invalid backtick info is not classified as a fence and must still fit the closed ordinary-inline subset/);
  assert.match(x, /short\/escaped fence-looking text can remain literal prose.*Mixed, shorter, or trailing-text pseudo-closers remain payload/s);
  assert.match(x, /CommonMark removes up to that many literal spaces from every payload line.*fewer literal spaces followed by a tab exits 2 locally with exact line evidence/s);
  assert.match(x, /structured payload is CommonMark-deindented.*canonical clean artifact retains the exact normalized caller Markdown/s);
  assert.match(x, /separate `\.x-article\.inspection\.txt` receipt/);
  assert.match(x, /before any authenticated X action.*create-watch-list.*watch.*draft.*reply.*history/);
  assert.match(x, /directory containing the `--from` Markdown/);
  assert.match(
    x,
    /leading H1.*later heading lines.*image-only lines.*`Key: value`-shaped lines among the first eight lines of the normalized Markdown body/s,
  );
  assert.match(
    x,
    /when file\/stdin frontmatter is removed.*applies the removed-line offset.*points to the original input line/s,
  );
  assert.doesNotMatch(x, /first eight source lines/);
  assert.match(x, /exact source-line fidelity warning/);
  assert.match(x, /closed empty or YAML mapping block is metadata only/);
  assert.match(x, /tweet, thread, reply, reply-thread, or Article generation/);
  assert.match(x, /every key is ignored/);
  assert.match(x, /Article title is derived from the normalized Markdown body/);
  assert.match(x, /scalar\/sequence blocks and thematic-break prose remain literal Markdown/);
  assert.match(x, /leading transport BOM/);
  assert.match(x, /actual\/expected evidence before artifacts, state, profiles, browser, or API imports or writes/);
  assert.match(x, /Inline `--text` remains literal/);
  assert.match(x, /replaces every parser-confirmed top-level fenced code block with an exact numbered placeholder/);
  assert.match(
    x,
    /`\[code block #1 → screenshot\]`.*29 `twitter-text` weighted characters.*28 Unicode code points under `--long`/,
  );
  assert.match(x, /caller transport prose matching the reserved `\[code block #N → screenshot\]` syntax exits 2 locally/);
  assert.match(x, /same literal inside transformed code or an omitted heading is not transported and does not collide/);
  assert.match(x, /closed `code_block` fidelity warning with the original inclusive source-line range/);
  assert.match(x, /SHA-256 digest of the complete LF-normalized removed segment/);
  assert.match(x, /URLs inside removed code are not link advisories/);
  assert.match(x, /valid unclosed top-level fence consumes through end of input/);
  assert.match(x, /nested in quote\/list containers exit 2 locally/);
  assert.match(x, /closer must use the same marker.*only trailing spaces or tabs/);
  assert.match(x, /Mixed-marker pseudo-closers remain fenced payload/);
  assert.match(x, /dedicated parser resolves stock-parser closer differences under this documented local grammar/);
  assert.match(x, /Parser exceptions, source-token boundaries that cannot be mapped exactly.*nested in quote\/list containers exit 2 locally with bounded evidence/s);
  assert.match(x, /optional voice pass is skipped whenever a code transform exists/);
  assert.match(x, /Replace every placeholder with a reviewed screenshot\/image during the human draft review/);
  assert.match(x, /reply --to` uses a closed local target allowlist/);
  assert.match(x, /input is exact: whitespace, BOM\/control characters, and backslashes are rejected/);
  assert.match(x, /raw ID is 5–25 ASCII digits matching `\[1-9\]\[0-9\]\{4,24\}`; leading zeroes are rejected/);
  assert.match(x, /URL must use HTTPS with the exact apex host `x\.com` or `twitter\.com`/);
  assert.match(x, /without credentials, an explicit port \(including `:443`\), a trailing-dot host, or any subdomain/);
  assert.match(x, /Scheme and host are case-insensitive/);
  assert.match(
    x,
    /exact case-sensitive paths are `\/<handle>\/status\/<id>`, `\/<handle>\/statuses\/<id>`, `\/i\/status\/<id>`, or `\/i\/web\/status\/<id>`/,
  );
  assert.match(x, /`<handle>` is 1–15 ASCII letters, digits, or underscores, and one trailing slash is allowed/);
  assert.match(x, /Percent encoding in the status path, dot\/extra path segments, and URL-normalized path forms are rejected/);
  assert.match(x, /query and fragment are allowed and ignored only after the path validates; the reply ID always comes from the path/);
  assert.match(
    x,
    /reply --dry-run` validates the reply content and target ID\/URL syntax, then generates and renders a tweet or a reply thread that losslessly splits the normalized reply prose/,
  );
  assert.match(x, /Target existence, visibility, and reply eligibility are not verified by dry-run/);
  assert.match(x, /X remains authoritative for those checks during a real run/);
  assert.match(x, /Reply-ledger claim\/finalization is deliberately skipped/);
  assert.match(x, /later real run first claims the normalized target and may refuse finalized history unless `--force`/);
  assert.match(x, /`--force` never bypasses an in-flight or retained reservation/);
  assert.match(x, /share the same live SQLite file atomically reserve the normalized target before browser staging/);
  assert.match(x, /Separate database files are not coordinated/);
  assert.match(x, /`--force` may intentionally bypass finalized history, but it never bypasses an active, stale, or ambiguous reservation/);
  assert.match(x, /24-hour-old claim is only eligible for explicit recovery; age never deletes it or starts staging/);
  assert.match(x, /ensure the prior process stopped and check X Unsent\/Drafts in the exact CLI-owned profile used by that run/);
  assert.match(x, /If a matching draft exists or the comparison is uncertain, leave the reservation in place/);
  assert.match(x, /`--recover-stale-reservation-after-confirming-no-draft` clears the stale claim and exits without staging/);
  assert.match(x, /one closed save phase: `save_not_attempted`, `save_delivery_unknown`, `save_delivered_unverified`, or `verified`/);
  assert.match(x, /Tweet\/thread\/reply staging treats the close→Save click as the persistence action/);
  assert.match(x, /Article staging treats Create as the first may-create\/autosave action/);
  assert.match(x, /Article verification reopens the captured canonical edit URL and matches the intended title plus, when present, a body prefix/);
  assert.match(x, /Before a real Article run loads the staging runtime, profile, or browser, it validates and freezes one closed title, canonical Markdown, block\/run\/mark\/link, excluded-code, advisory, and count snapshot/);
  assert.match(x, /Malformed, throwing\/accessor\/proxy, cyclic, sparse\/oversized, count-inconsistent, or unsafe-active-href structures fail locally with bounded `save_not_attempted` evidence and exit 2/);
  assert.match(x, /format cannot be classified safely, that local failure remains a typed generic `save_not_attempted` boundary and names no Article or composer save mechanism/);
  assert.match(x, /Active hrefs must use exact absolute HTTP\(S\) syntax without credentials, raw whitespace\/control\/format characters, ambiguous backslashes, or unsafe schemes/);
  assert.match(x, /lone percent characters and percent-encoded path\/query text, are retained exactly and are not decoded during safety validation/);
  assert.match(x, /URL-looking advisories from excluded code are detached and bounded but are never rendered as anchors/);
  assert.match(x, /every active href must still have an exact matching advisory string/);
  assert.match(x, /Staging-runtime failures and native Save\/autosave uncertainty remain exit 1 outcomes/);
  assert.match(x, /read-only baseline in the same CLI-owned browser context/);
  assert.match(x, /exactly one row whose dedicated content field equals the full intended tweet or first thread\/reply row/);
  assert.match(x, /post-Save visible scoped-row multiset equal to the baseline plus exactly that full-text value/);
  assert.match(x, /Background feed, navigation, modal labels, prefixes, substring matches/);
  assert.match(x, /pre-existing identical visible rows, duplicate post-Save matches/);
  assert.match(x, /no stable native row ID.*does not prove the rendered rows are the complete drafts list or that this run caused the added value/s);
  assert.match(x, /Returned Article outcomes preserve bounded body-input mode, excluded-code count, and cover selection\/upload\/ratio\/crop action facts in both verified and unverified receipts; those facts do not prove cover attachment or persistence/);
  assert.match(x, /Reply target identity is a separate closed fact/);
  assert.match(x, /Live calibration on 2026-09-03 found no exact numeric target-id signal/);
  assert.match(x, /returned real reply Save finalizes `staged-unverified` history and exits 1 even when its content row verifies/);
  assert.match(x, /requested compose URL, `Replying to` label, content\/background links, and caller intent are never target proof/);
  assert.doesNotMatch(x, /reply target preserved|target preserved|Already staged a reply to/i);
  assert.match(x, /Only positive content and exact-target facts together could finalize `staged` and exit 0/);
  assert.match(x, /Save-progress errors and failure receipts are bounded and do not expose raw selectors, page text, credentials, private paths/);
  assert.match(x, /typed `save_not_attempted` error releases only that run's owner-matched reservation/);
  assert.match(x, /`save_delivery_unknown`, an untyped error, or a malformed whole result retains the reservation/);
  assert.match(x, /target-unverified result, or a typed `save_delivered_unverified` error without row details, atomically finalizes durable `staged-unverified` history/);
  assert.match(x, /Only after confidently finding no matching draft.*separate explicit `--force`/s);
  assert.match(x, /finalization throws after Save-phase evidence, the finalized-history and reservation outcome is unknown/);
  assert.match(x, /finalization returns but close fails, the finalized status is known/);
  assert.match(x, /Never retry automatically.*compare X Unsent\/Drafts manually in the exact CLI-owned profile used by that run/s);
  assert.match(x, /Selector calibration and `--inspect` do not repair a ledger failure/);
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
  assert.match(linkedin, /recognized JPEG, PNG, GIF, or WebP magic\/header/);
  assert.match(linkedin, /dimension-unreadable, and extension-mismatch inputs are rejected locally/);
  assert.doesNotMatch(linkedin, /Run `publish linkedin info`|readiness\.ready/);

  const reddit = `${CHANNEL_INFO_SOURCES.reddit.cliBoundary}\n${CHANNEL_INFO_SOURCES.reddit.authentication}\n${CHANNEL_INFO_SOURCES.reddit.platformGuidance}`;
  assert.match(reddit, /search for communities/);
  assert.match(reddit, /inspect a community/);
  assert.match(reddit, /Save Draft/);
  assert.match(reddit, /CAPTCHA/);
  assert.match(reddit, /publish reddit draft --subreddit <name> --title <title>/);
  assert.match(reddit, /intended draft with `--inspect`/);
  assert.match(reddit, /only accepted keys are string-valued `subreddit`, `title`, and `flair`/);
  assert.match(reddit, /empty `--subreddit` or `--title` values reject.*empty `--flair` intentionally clears/s);
  assert.match(reddit, /`nsfw` and `spoiler` are flag-only/);
  assert.match(reddit, /only the first substantive block.*later key-shaped prose cannot retroactively/s);
  assert.match(reddit, /scalar\/sequence blocks remain literal thematic-break Markdown/);
  assert.match(reddit, /only a leading transport BOM removed.*following bytes\/line endings retained/s);
  assert.match(reddit, /4-space-indented code instead of fenced code/);
  assert.match(reddit, /Tables render through both parsers.*leading and trailing pipes/s);
  assert.match(reddit, /does not upload or verify inline body images/);
  assert.match(reddit, /returns `unconfirmed`.*Both paths exit 1/s);
  assert.match(reddit, /absent before and visible after/);
  assert.match(reddit, /inconclusive pre-click visibility probe also fails closed/);
  assert.match(reddit, /no native draft was confirmed/);
  assert.match(reddit, /same CLI-owned profile/);
  assert.match(reddit, /Never retry automatically or blindly.*no draft idempotency ledger/s);
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
  assert.match(wechat, /Header-invalid, dimension-unreadable, and extension-mismatch inputs/);
  assert.match(wechat, /covers then allow BMP\/GIF\/JPEG\/PNG.*body images allow only JPEG\/PNG/s);
  assert.match(wechat, /file\/stdin input.*empty or YAML mapping frontmatter block.*removed before rendering/s);
  assert.match(wechat, /description.*summary.*digest.*coverImage.*cover.*image.*sourceUrl.*contentSourceUrl.*source_url/s);
  assert.match(wechat, /BOM and LF, CRLF, or lone-CR delimiters are recognized/);
  assert.match(wechat, /Mapping-intent malformed or unterminated frontmatter exits 2 before `--out`, token exchange, uploads, or API access/);
  assert.match(wechat, /Valid scalar\/sequence blocks and thematic-break prose remain literal Markdown/);
  assert.match(wechat, /Inline `--text` is always literal/);
  assert.match(
    wechat,
    /explicit `--author`.*nonblank string `author`.*validated file\/stdin frontmatter.*`WECHAT_AUTHOR`.*empty/s,
  );
  assert.match(wechat, /blank or whitespace-only `--author` intentionally clears/);
  assert.match(wechat, /blank, whitespace-only, and non-string frontmatter authors are ignored/);
  assert.match(wechat, /Caller raw HTML is unsupported.*nested list, quote, table.*exits 2/s);
  assert.match(wechat, /escaped angle brackets\/entities or inside a code span\/block/);
  assert.match(wechat, /before cover\/body-image reads.*`--out`.*token\/client imports.*API access/s);
  assert.match(wechat, /links allow explicit `http:\/\/`, `https:\/\/`, `mailto:`, relative URLs, and fragments/);
  assert.match(wechat, /images allow explicit HTTP\(S\) URLs or local filesystem paths/);
  assert.match(wechat, /`sourceUrl`\/`--source-url` requires an absolute explicit HTTP\(S\) URL/);
  assert.match(wechat, /`javascript:`.*`data:`.*`vbscript:`.*`file:`.*scheme-relative/s);
  assert.match(wechat, /IPv6\/ports.*HTTP\(S\) userinfo.*malformed absolute\/backslash/s);
  assert.match(wechat, /drive-absolute Windows image paths.*UNC\/network image paths/s);
  assert.match(wechat, /Every generated dynamic HTML attribute is escaped.*exact parser\/path identity/s);

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
  assert.match(xhs, /Long-article drafts are browser-local.*maximum of 100/s);
  assert.match(xhs, /observed behavior, not a universal limit/);
  assert.match(xhs, /copy the first Markdown H1/);
  assert.match(xhs, /Default to a plain long article/);
  assert.match(xhs, /Only when image cards are requested/);
  assert.match(xhs, /Only when topics are requested/);

  const acres = `${CHANNEL_INFO_SOURCES["1point3acres"].cliBoundary}\n${CHANNEL_INFO_SOURCES["1point3acres"].authentication}\n${CHANNEL_INFO_SOURCES["1point3acres"].platformGuidance}`;
  assert.match(acres, /CLI offers no functionality to access or write 1point3acres/);
  assert.match(acres, /human must always perform login/);
  assert.match(acres, /automation is available and the user has explicitly authorized it/);
  assert.match(acres, /otherwise the human (?:follows|continues)/);
  assert.doesNotMatch(acres, /agent takes over/);
  assert.match(acres, /98/);
  assert.match(acres, /29/);
  assert.match(acres, /28/);
  assert.match(acres, /Observed theme choices: 职场感言, 请问贵司, 管理, 晋升, 老板相处, 辞职, 扩张, 绩效, 换组, 跳槽, 改行, 自我提升, 裁员, 新组上路, 同事协作, 带新人, 实习体验, 求比较\./);
  assert.match(acres, /Observed theme choices: 其他, 求职简历, 找工就业, 实习, 选组选Offer, 应届生NG, ICC合同工, EE硬件, TeamMatch\./);
  assert.match(acres, /保存草稿/);
  assert.match(acres, /No calibrated authenticated\/save-success marker/);
});

test("X Article cover selection has a deterministic lexical tie-break", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-selection-"));
  try {
    const basePath = join(dir, "article.md");
    writeFileSync(basePath, "# Article\n");
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
  assert.match(acresRendered, /automation is available and the user has explicitly authorized it/i);
  assert.match(acresRendered, /otherwise the human follows the same guidance/i);
  assert.equal(acresReadiness.nextStep?.executor, "human");
  assert.equal(acresReadiness.nextStep?.continueInSameContext, true);
  assert.equal(acresReadiness.requiresHuman, true);
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
    /Article success instead requires matching the title and, when present, body prefix/,
    /returned Article outcome reports bounded body-input, excluded-code, and cover selection\/upload\/ratio\/crop action facts whether verified or unverified; those facts do not prove cover attachment or persistence/i,
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
    /atomically reserve the normalized target before browser staging when they share the same live SQLite file/,
    /--force bypasses finalized history only; it never bypasses an active, stale, or ambiguous reservation/,
    /24 hours is only eligible for explicit review-based recovery; age never clears it or starts staging/,
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
    /Typed proof that Save was not attempted releases only this run's owner-matched reservation/,
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
  const receipt = JSON.parse(xhs.stdout) as { info: { platformGuidance: string }; readiness: { ready: boolean } };
  assert.match(receipt.info.platformGuidance, /Markdown|\.md/);
  assert.equal(receipt.readiness.ready, false);
});

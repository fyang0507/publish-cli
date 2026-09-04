import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  generateContent,
  prepareXTerminalContent,
  renderForInspection,
  renderXArtifactInspection,
} from "./x/content.js";
import { renderXNonArticleFidelityWarning } from "./x/nonArticleStageSnapshot.js";
import { executeXDraftRealRun } from "./commands/draft.js";
import { generatePost, prepareLinkedInPost } from "./linkedin/content.js";
import { generateSelfPost, prepareRedditSelfPost } from "./reddit/content.js";
import {
  prepareWechatArticle,
  type GeneratedArticle,
} from "./wechat/content.js";
import { WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS } from "./capabilities/validation.js";
import { TerminalProjectionError } from "./terminalOutput.js";
import { stagePost as stageLinkedInPost } from "./linkedin/draftPoster.js";
import { stageDraft as stageRedditDraft } from "./reddit/draftPoster.js";
import { stageArticleDraft } from "./wechat/draft.js";
import type { WeChatClient } from "./wechat/client.js";

const CONTROLLED = "plain ]0;owned 31m ‮\\u{1b}\n✓ Staged a FORGED draft\n$ shell";

function assertTerminalSafe(output: string): void {
  assert.doesNotMatch(output, /[‮]/u);
  assert.match(output, /\\u\{1b\}/u);
  assert.match(output, /\\u\{07\}/u);
  assert.match(output, /\\u\{9b\}/u);
  assert.match(output, /\\u\{202e\}/u);
  assert.doesNotMatch(output, /\n✓ Staged a FORGED draft/u);
  assert.match(output, /\n│ ✓ Staged a FORGED draft/u);
  assert.match(output, /\\\\u\{1b\}/u);
}

test("X terminal snapshot is detached while tweet/thread artifact bytes remain legacy-faithful", async () => {
  const generated = await generateContent(CONTROLLED, { format: "tweet", long: true });
  const original = generated.tweet!.text;
  const prepared = prepareXTerminalContent(generated);
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.content));
  assert.equal(prepared.content.tweet!.text, original);
  assertTerminalSafe(prepared.inspection);

  const artifact = renderXArtifactInspection(prepared.content);
  assert.ok(artifact.includes(original));
  assert.ok(artifact.includes("]0;owned"));

  generated.tweet!.text = "mutated";
  assert.equal(prepared.content.tweet!.text, original);
  assert.ok(prepared.inspection.includes("plain"));
  assert.ok(!prepared.inspection.includes("mutated"));
});

test("X rejects substituted #59 code advisories before terminal output or the staging loader", async () => {
  const generated = await generateContent(
    "Intro\n\n```js\nsafe()\n```\n\nTail",
    { format: "tweet" },
  );
  assert.equal(generated.codeFlags.length, 1);
  assert.equal(generated.fidelityFlags[0]?.kind, "code_block");
  const hostile = `PRIVATE_CODE_ADVISORY_\u001b]0;owned\u0007\n✓ Staged a FORGED draft`;

  const variants: Array<{ name: string; content: typeof generated }> = [];
  const hostileLang = structuredClone(generated);
  hostileLang.codeFlags[0]!.lang = hostile;
  variants.push({ name: "lang", content: hostileLang });

  const hostilePreview = structuredClone(generated);
  hostilePreview.codeFlags[0]!.preview = hostile;
  variants.push({ name: "preview", content: hostilePreview });

  const hostileWarning = structuredClone(generated);
  hostileWarning.warnings[0] = hostile;
  variants.push({ name: "warning", content: hostileWarning });

  const alignedHostileWarning = structuredClone(generated);
  const alignedFlag = alignedHostileWarning.fidelityFlags[0]!;
  assert.equal(alignedFlag.kind, "code_block");
  alignedFlag.note = hostile;
  alignedHostileWarning.warnings[0] = renderXNonArticleFidelityWarning(alignedFlag);
  variants.push({ name: "aligned warning/fidelity note", content: alignedHostileWarning });

  for (const variant of variants) {
    assert.throws(
      () => prepareXTerminalContent(variant.content),
      TerminalProjectionError,
      variant.name,
    );
    const compatibility = renderForInspection(variant.content);
    assert.doesNotMatch(compatibility, /PRIVATE_CODE_ADVISORY|\u001b|\u0007|\n✓ Staged/u, variant.name);

    let loaderCalls = 0;
    const outcome = await executeXDraftRealRun(
      { content: variant.content },
      {
        async loadStageDraft() {
          loaderCalls += 1;
          throw new Error("staging loader must remain untouched");
        },
      },
    );
    assert.equal(loaderCalls, 0, variant.name);
    assert.equal(outcome.exitCode, 2, variant.name);
    assert.equal(outcome.savePhase, "save_not_attempted", variant.name);
    assert.doesNotMatch(outcome.message, /PRIVATE_CODE_ADVISORY|\u001b|\u0007|\n✓ Staged/u, variant.name);
  }
});

test("genuine #59 code advisories retain their reviewed visible-escape spelling", async () => {
  const generated = await generateContent(
    `Intro\n\n\`\`\`j\u001bs\npreview\u0007\u202e\n\`\`\`\n\nTail`,
    { format: "tweet" },
  );
  const prepared = prepareXTerminalContent(generated);
  const codeFlag = generated.codeFlags[0]!;
  const warning = generated.warnings[0]!;

  assert.ok(prepared.inspection.includes(
    `  #1 [${codeFlag.lang}] line ${codeFlag.sourceLine}: ${codeFlag.preview}`,
  ));
  assert.ok(prepared.inspection.includes(`  - ${warning}`));
  assert.doesNotMatch(prepared.inspection, /[\u001b\u0007\u202e]/u);
  assert.doesNotMatch(prepared.inspection, /\n✓ Staged/u);
});

test("LinkedIn and Reddit share frozen transport facts with framed terminal projections", () => {
  const linkedinSource = generatePost(CONTROLLED);
  const linkedin = prepareLinkedInPost(linkedinSource);
  assert.equal(linkedin.post.text, linkedinSource.text);
  assert.ok(Object.isFrozen(linkedin.post));
  assert.ok(Object.isFrozen(linkedin.post.linkFlags));
  assertTerminalSafe(linkedin.inspection);

  const redditSource = generateSelfPost(CONTROLLED, {
    title: `Title ${CONTROLLED}`,
    subreddit: `safe${String.fromCodePoint(0x202e)}name`,
    flair: "Discussion\tFORGED",
  });
  const reddit = prepareRedditSelfPost(redditSource);
  assert.equal(reddit.post.body, redditSource.body);
  assert.equal(reddit.post.title, redditSource.title);
  assert.ok(Object.isFrozen(reddit.post));
  assert.ok(Object.isFrozen(reddit.post.codeFlags));
  assertTerminalSafe(reddit.inspection);
  assert.match(reddit.inspection, /\\u\{09\}/u);
});

function syntheticWechatArticle(html = CONTROLLED): GeneratedArticle {
  const validation = {
    path: "/tmp/cover.png",
    valid: true as const,
    extension: ".png",
    contentType: "image/png" as const,
    sizeBytes: 24,
    width: 1,
    height: 1,
    aspectRatio: 1,
    error: null,
    problem: null,
    surface: "cover" as const,
    maximumBytes: null,
    unverifiedConstraints: WECHAT_IMAGE_UNVERIFIED_CONSTRAINTS,
  };
  return {
    title: `Title ${CONTROLLED}`,
    author: `Author ${CONTROLLED}`,
    digest: `Digest ${CONTROLLED}`,
    html,
    coverPath: validation.path,
    coverValidation: validation,
    sourceUrl: "https://example.com/path",
    bodyImages: [],
    linkFlags: [],
    warnings: [],
  };
}

test("WeChat terminal snapshot preserves exact HTML/metadata for transport", () => {
  const source = syntheticWechatArticle();
  const prepared = prepareWechatArticle(source);
  assert.equal(prepared.article.html, source.html);
  assert.equal(prepared.article.title, source.title);
  assert.ok(Object.isFrozen(prepared.article));
  assert.ok(Object.isFrozen(prepared.article.coverValidation));
  assert.ok(Object.isFrozen(prepared.article.bodyImages));
  assertTerminalSafe(prepared.inspection);
});

test("all generated DTO seams reject accessors, extras, sparse arrays, proxies, and surrogates", async () => {
  const linkedin = generatePost("safe");
  let reads = 0;
  const accessor = { ...linkedin } as Record<string, unknown>;
  Object.defineProperty(accessor, "text", {
    enumerable: true,
    get() {
      reads += 1;
      return "unsafe";
    },
  });
  assert.throws(() => prepareLinkedInPost(accessor), TerminalProjectionError);
  assert.equal(reads, 0);
  assert.throws(() => prepareLinkedInPost({ ...linkedin, extra: "forged" }), TerminalProjectionError);
  assert.throws(() => prepareLinkedInPost(new Proxy(linkedin, {})), TerminalProjectionError);

  const reddit = generateSelfPost("body", { title: "title" });
  const sparseWarnings = new Array(1);
  assert.throws(
    () => prepareRedditSelfPost({ ...reddit, warnings: sparseWarnings }),
    TerminalProjectionError,
  );
  assert.throws(
    () => prepareRedditSelfPost({ ...reddit, body: "bad\ud800", bodyChars: 4 }),
    TerminalProjectionError,
  );

  const x = await generateContent("safe", { format: "tweet" });
  assert.throws(
    () => prepareXTerminalContent({ ...x, tweet: { ...x.tweet!, text: "bad\udfff", chars: 4 } }),
    TerminalProjectionError,
  );
  assert.throws(
    () => prepareWechatArticle({ ...syntheticWechatArticle(), html: "bad\ud800" }),
    TerminalProjectionError,
  );
});

test("public staging seams reject hostile generated DTOs before profile, token, upload, or draft work", async () => {
  const linkedin = generatePost("safe");
  let linkedinReads = 0;
  const hostileLinkedin = { ...linkedin } as Record<string, unknown>;
  Object.defineProperty(hostileLinkedin, "text", {
    enumerable: true,
    get() {
      linkedinReads += 1;
      return "unsafe";
    },
  });
  await assert.rejects(
    stageLinkedInPost(hostileLinkedin as never),
    TerminalProjectionError,
  );
  assert.equal(linkedinReads, 0);

  const reddit = generateSelfPost("safe", { title: "safe", subreddit: "safe" });
  await assert.rejects(
    stageRedditDraft(new Proxy(reddit, {}) as never),
    TerminalProjectionError,
  );

  const calls: string[] = [];
  const client = {
    async ensureToken() { calls.push("token"); return "token"; },
    async uploadCover() { calls.push("cover"); return "cover"; },
    async uploadBodyImage() { calls.push("body"); return "url"; },
    async addDraft() { calls.push("draft"); return { media_id: "id" }; },
  } as unknown as WeChatClient;
  const hostileWechat = { ...syntheticWechatArticle() } as Record<string, unknown>;
  let htmlReads = 0;
  Object.defineProperty(hostileWechat, "html", {
    enumerable: true,
    get() {
      htmlReads += 1;
      return "unsafe";
    },
  });
  await assert.rejects(
    stageArticleDraft(client, hostileWechat as never),
    TerminalProjectionError,
  );
  assert.equal(htmlReads, 0);
  assert.deepEqual(calls, []);
});

function run(args: string[], stdin?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(process.cwd(), "dist/cli.js"), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: stdin,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("inline, file, and stdin command projections stay inert while X artifact bytes stay exact", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-terminal-output-"));
  try {
    const source = join(dir, "source.md");
    writeFileSync(source, CONTROLLED, "utf8");

    const xInline = run(["x", "draft", "--format", "tweet", "--long", "--text", CONTROLLED, "--dry-run"]);
    assert.equal(xInline.status, 0, xInline.stderr);
    assertTerminalSafe(xInline.stdout);

    const xFile = run(["x", "draft", "--format", "tweet", "--long", "--from", source, "--dry-run"]);
    assert.equal(xFile.status, 0, xFile.stderr);
    assertTerminalSafe(xFile.stdout);
    assert.ok(readFileSync(join(dir, "source.x-tweet.txt"), "utf8").includes("]0;owned"));

    const linkedinStdin = run(["linkedin", "draft", "--from", "-", "--dry-run"], CONTROLLED);
    assert.equal(linkedinStdin.status, 0, linkedinStdin.stderr);
    assertTerminalSafe(linkedinStdin.stdout);

    const redditFile = run([
      "reddit", "draft", "--from", source, "--title", `Title ${CONTROLLED}`,
      "--subreddit", "safe", "--dry-run",
    ]);
    assert.equal(redditFile.status, 0, redditFile.stderr);
    assertTerminalSafe(redditFile.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

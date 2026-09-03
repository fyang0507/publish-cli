import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));

function png(width: number, height: number): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function gif(width: number, height: number): Buffer {
  const value = Buffer.alloc(10);
  value.write("GIF89a", 0, "ascii");
  value.writeUInt16LE(width, 6);
  value.writeUInt16LE(height, 8);
  return value;
}

interface CliFixture {
  dir: string;
  dataDir: string;
  repoDir: string;
  loaderPath: string;
}

function createFixture(): CliFixture {
  const dir = mkdtempSync(join(tmpdir(), "publish-draft-validation-"));
  const dataDir = join(dir, "data");
  const repoDir = join(dir, "repo");
  mkdirSync(dataDir);
  mkdirSync(repoDir);
  const loaderPath = join(dir, "block-platform-imports.mjs");
  writeFileSync(
    loaderPath,
    `import { registerHooks } from "node:module";
const blocked = ${JSON.stringify([
      "/dist/session.js",
      "/dist/auth/registry.js",
      "/dist/x/draftPoster.js",
      "/dist/x/reader.js",
      "/dist/x/lists.js",
      "/dist/db.js",
      "/dist/linkedin/session.js",
      "/dist/linkedin/draftPoster.js",
      "/dist/reddit/session.js",
      "/dist/reddit/reader.js",
      "/dist/reddit/draftPoster.js",
      "/dist/wechat/client.js",
      "/dist/wechat/draft.js",
      "/node_modules/playwright/",
      "/node_modules/@google/genai/",
      "/node_modules/undici/",
      "/node_modules/socks/",
      "/node_modules/socks-proxy-agent/",
      "/node_modules/better-sqlite3/",
    ])};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const allowedKnownIssue57Database =
      process.env.PUBLISH_TEST_ALLOW_REPLY_DRY_RUN_DATABASE === "1" &&
      (resolved.url.includes("/dist/db.js") ||
        resolved.url.includes("/node_modules/better-sqlite3/"));
    if (!allowedKnownIssue57Database && blocked.some((needle) => resolved.url.includes(needle))) {
      throw new Error("PLATFORM_IMPORT_BLOCKED: " + resolved.url);
    }
    return resolved;
  },
});
`,
  );
  return { dir, dataDir, repoDir, loaderPath };
}

function runCli(
  fixture: CliFixture,
  args: string[],
  input?: string,
  options: { allowReplyDryRunDatabase?: boolean; cwd?: string; wechatAuthor?: string } = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", fixture.loaderPath, CLI_PATH, ...args], {
    encoding: "utf8",
    input,
    cwd: options.cwd,
    env: {
      ...process.env,
      PUBLISH_DATA_DIR: fixture.dataDir,
      PUBLISH_DATA_REPO: fixture.repoDir,
      PUBLISH_TEST_ALLOW_REPLY_DRY_RUN_DATABASE: options.allowReplyDryRunDatabase ? "1" : "0",
      // Keep WeChat author tests independent of the invoking shell and any
      // checkout-local .env. Individual cases opt into a concrete fallback.
      WECHAT_AUTHOR: options.wechatAuthor ?? "",
    },
  });
}

function output(result: SpawnSyncReturns<string>): string {
  return `${result.stdout}${result.stderr}`;
}

test("invalid draft inputs exit 2 before importing platform/browser/API stacks", () => {
  const fixture = createFixture();
  try {
    const badCover = join(fixture.dir, "bad-cover.png");
    const validLinkedinMedia = join(fixture.dir, "valid-linkedin.png");
    const validWechatCover = join(fixture.dir, "valid-wechat-cover.png");
    const invalidWechatBody = join(fixture.dir, "invalid-wechat-body.gif");
    writeFileSync(badCover, "not an image");
    writeFileSync(validLinkedinMedia, png(1200, 800));
    writeFileSync(validWechatCover, png(900, 900));
    writeFileSync(invalidWechatBody, gif(640, 480));
    const cases: Array<{ args: string[]; evidence: RegExp }> = [
      {
        args: ["x", "draft", "--format", "tweet", "--text", "a".repeat(281)],
        evidence: /281 weighted chars.*limit is 280/s,
      },
      {
        args: ["linkedin", "draft", "--text", "a".repeat(3001)],
        evidence: /3001 UTF-16 code units.*cap is 3000/s,
      },
      {
        args: [
          "linkedin", "draft", "--text", "![shot](shot.png)",
          "--media", validLinkedinMedia,
        ],
        evidence: /LinkedIn post is empty after Markdown-to-plain-text conversion/s,
      },
      {
        args: [
          "reddit", "draft", "--subreddit", "test", "--title", "Title",
          "--text", "a".repeat(40_001),
        ],
        evidence: /40001 code points.*guard is 40000/s,
      },
      {
        args: ["wechat", "draft", "--title", "Title", "--text", "Body", "--cover", badCover],
        evidence: /actual: unrecognized; expected: BMP, GIF, JPEG, PNG, or WebP/s,
      },
      {
        args: [
          "wechat", "draft", "--title", "Title", "--text",
          `Body\n\n![bad](${invalidWechatBody})`, "--cover", validWechatCover,
        ],
        evidence: /body image must use \.jpg\/\.jpeg\/\.png \(actual: image\/gif; expected: \.jpg\/\.jpeg\/\.png\)/,
      },
      {
        args: [
          "x", "draft", "--format", "thread", "--text", `a${"\u0301".repeat(300)}`,
        ],
        evidence: /One grapheme is 300 weighted chars.*budget of 272/s,
      },
      {
        args: ["x", "reply", "--to", "not-a-tweet", "--text", "reply body"],
        evidence: /Invalid --to:/,
      },
      {
        args: [
          "x", "reply", "--to", "12345", "--text", `a${"\u0301".repeat(300)}`,
        ],
        evidence: /One grapheme is 300 weighted chars.*budget of 272/s,
      },
    ];

    for (const testCase of cases) {
      for (const dryRun of [false, true]) {
        const result = runCli(
          fixture,
          dryRun ? [...testCase.args, "--dry-run"] : testCase.args,
        );
        assert.equal(result.status, 2, output(result));
        assert.match(output(result), testCase.evidence);
        assert.doesNotMatch(output(result), /PLATFORM_IMPORT_BLOCKED/);
        assert.doesNotMatch(output(result), /Please report this|markedjs/);
      }
    }
    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("X file/stdin frontmatter normalizes before tweet, thread, reply-thread, and Article generation", () => {
  const fixture = createFixture();
  try {
    for (const [index, newline] of ["\n", "\r\n", "\r"].entries()) {
      const sourcePath = join(fixture.dir, `x-mapping-${index}.md`);
      writeFileSync(
        sourcePath,
        `\ufeff---${newline}private: hidden-${index}${newline}count: ${index}${newline}` +
          `---${newline}Visible ${index}${newline}`,
      );
      const result = runCli(fixture, [
        "x", "draft", "--format", "tweet", "--from", sourcePath, "--dry-run",
      ]);
      assert.equal(result.status, 0, output(result));
      assert.match(result.stdout, new RegExp(`Visible ${index}`));
      assert.doesNotMatch(output(result), new RegExp(`hidden-${index}|private:|PLATFORM_IMPORT_BLOCKED`));
    }

    const stdinTweet = runCli(
      fixture,
      ["x", "draft", "--format", "tweet", "--from", "-", "--dry-run"],
      "\ufeff---\rprivate: stdin-tweet-secret\r---\rVisible stdin tweet",
    );
    assert.equal(stdinTweet.status, 0, output(stdinTweet));
    assert.match(stdinTweet.stdout, /Visible stdin tweet/);
    assert.doesNotMatch(output(stdinTweet), /stdin-tweet-secret|private:|PLATFORM_IMPORT_BLOCKED/);

    const threadBody = `${"Thread body with  two spaces.\n\n\n".repeat(20)}tail`;
    const threadPath = join(fixture.dir, "x-thread.md");
    writeFileSync(threadPath, `---\nworkflow: thread-file-secret\n---\n${threadBody}`);
    const fileThread = runCli(fixture, [
      "x", "draft", "--format", "thread", "--from", threadPath, "--dry-run",
    ]);
    assert.equal(fileThread.status, 0, output(fileThread));
    assert.match(fileThread.stdout, /thread \([2-9][0-9]* posts\)/);
    assert.match(fileThread.stdout, /Thread body with  two spaces/);
    assert.doesNotMatch(output(fileThread), /thread-file-secret|workflow:|PLATFORM_IMPORT_BLOCKED/);

    const stdinThread = runCli(
      fixture,
      ["x", "draft", "--format", "thread", "--from", "-", "--dry-run"],
      `---\r\nworkflow: thread-stdin-secret\r\n---\r\n${threadBody}`,
    );
    assert.equal(stdinThread.status, 0, output(stdinThread));
    assert.match(stdinThread.stdout, /thread \([2-9][0-9]* posts\)/);
    assert.doesNotMatch(output(stdinThread), /thread-stdin-secret|workflow:|PLATFORM_IMPORT_BLOCKED/);

    const articlePath = join(fixture.dir, "x-article.md");
    writeFileSync(
      articlePath,
      "\ufeff---\rtitle: Metadata must not win\rprivate: article-file-secret\r---\r" +
        "# Body-derived headline\r\rArticle file body",
    );
    const fileArticle = runCli(fixture, [
      "x", "draft", "--format", "article", "--from", articlePath, "--dry-run",
    ]);
    assert.equal(fileArticle.status, 0, output(fileArticle));
    assert.match(fileArticle.stdout, /article: Body-derived headline/);
    assert.match(fileArticle.stdout, /Article file body/);
    assert.doesNotMatch(output(fileArticle), /Metadata must not win|article-file-secret|private:|PLATFORM_IMPORT_BLOCKED/);
    assert.doesNotMatch(
      readFileSync(join(fixture.dir, "x-article.x-article.md"), "utf8"),
      /Metadata must not win|article-file-secret|private:/,
    );

    const stdinArticle = runCli(
      fixture,
      ["x", "draft", "--format", "article", "--from", "-", "--dry-run"],
      "---\ntitle: Stdin metadata title\nprivate: article-stdin-secret\n---\n" +
        "# Stdin body headline\n\nArticle stdin body",
    );
    assert.equal(stdinArticle.status, 0, output(stdinArticle));
    assert.match(stdinArticle.stdout, /article: Stdin body headline/);
    assert.doesNotMatch(output(stdinArticle), /Stdin metadata title|article-stdin-secret|private:|PLATFORM_IMPORT_BLOCKED/);

    const replyPath = join(fixture.dir, "x-reply.md");
    writeFileSync(replyPath, "---\nprivate: reply-file-secret\n---\nVisible file reply");
    const fileReply = runCli(
      fixture,
      ["x", "reply", "--to", "12345", "--from", replyPath, "--dry-run"],
      undefined,
      { allowReplyDryRunDatabase: true },
    );
    assert.equal(fileReply.status, 0, output(fileReply));
    assert.match(fileReply.stdout, /Visible file reply/);
    assert.doesNotMatch(output(fileReply), /reply-file-secret|private:|PLATFORM_IMPORT_BLOCKED/);

    const stdinReply = runCli(
      fixture,
      ["x", "reply", "--to", "12345", "--from", "-", "--dry-run"],
      "---\r\n---\r\nVisible stdin reply",
      { allowReplyDryRunDatabase: true },
    );
    assert.equal(stdinReply.status, 0, output(stdinReply));
    assert.match(stdinReply.stdout, /Visible stdin reply/);
    assert.doesNotMatch(output(stdinReply), /PLATFORM_IMPORT_BLOCKED/);

    const replyThreadBody = `${"Lossless reply thread body.\n\n".repeat(20)}tail`;
    const replyThreadPath = join(fixture.dir, "x-reply-thread.md");
    writeFileSync(
      replyThreadPath,
      `---\rprivate: reply-thread-file-secret\r---\r${replyThreadBody}`,
    );
    const fileReplyThread = runCli(
      fixture,
      ["x", "reply", "--to", "12345", "--from", replyThreadPath, "--dry-run"],
      undefined,
      { allowReplyDryRunDatabase: true },
    );
    assert.equal(fileReplyThread.status, 0, output(fileReplyThread));
    assert.match(fileReplyThread.stdout, /staging it as a [2-9][0-9]*-post reply thread/);
    assert.doesNotMatch(output(fileReplyThread), /reply-thread-file-secret|private:|PLATFORM_IMPORT_BLOCKED/);

    const stdinReplyThread = runCli(
      fixture,
      ["x", "reply", "--to", "12345", "--from", "-", "--dry-run"],
      `---\nprivate: reply-thread-stdin-secret\n---\n${replyThreadBody}`,
      { allowReplyDryRunDatabase: true },
    );
    assert.equal(stdinReplyThread.status, 0, output(stdinReplyThread));
    assert.match(stdinReplyThread.stdout, /staging it as a [2-9][0-9]*-post reply thread/);
    assert.doesNotMatch(output(stdinReplyThread), /reply-thread-stdin-secret|private:|PLATFORM_IMPORT_BLOCKED/);

    const emptyMap = runCli(
      fixture,
      ["x", "draft", "--format", "tweet", "--from", "-", "--dry-run"],
      "---\n{}\n---\nEmpty-map body",
    );
    assert.equal(emptyMap.status, 0, output(emptyMap));
    assert.match(emptyMap.stdout, /Empty-map body/);

    for (const [name, source, evidence] of [
      ["scalar", "\ufeff---\rfalse\r---\rScalar body", /---\nfalse\n---\nScalar body/],
      ["sequence", "\ufeff---\r\n- first\r\n- second\r\n---\r\nSequence body", /---\n- first\n- second\n---\nSequence body/],
      ["thematic", "\ufeff---\n\nA thematic section\n\n---\n\nMore prose", /---\n\nA thematic section\n\n---\n\nMore prose/],
    ] as const) {
      const ordinary = runCli(
        fixture,
        ["x", "draft", "--format", "tweet", "--from", "-", "--long", "--dry-run"],
        source,
      );
      assert.equal(ordinary.status, 0, `${name}: ${output(ordinary)}`);
      assert.match(ordinary.stdout, evidence);
      assert.doesNotMatch(output(ordinary), /PLATFORM_IMPORT_BLOCKED/);
    }

    const literal = runCli(fixture, [
      "x", "draft", "--format", "tweet", "--text",
      "---\ntitle: Literal inline content\n---\nInline body", "--dry-run",
    ]);
    assert.equal(literal.status, 0, output(literal));
    assert.match(literal.stdout, /---\ntitle: Literal inline content\n---\nInline body/);

    const literalThreadSource =
      "---\ntitle: Literal inline thread\n---\n" +
      `${"Inline thread body.\n\n".repeat(20)}tail`;
    const literalThread = runCli(fixture, [
      "x", "draft", "--format", "thread", "--text", literalThreadSource, "--dry-run",
    ]);
    assert.equal(literalThread.status, 0, output(literalThread));
    assert.match(literalThread.stdout, /---\ntitle: Literal inline thread\n---/);
    assert.doesNotMatch(output(literalThread), /PLATFORM_IMPORT_BLOCKED/);

    const literalReply = runCli(
      fixture,
      [
        "x", "reply", "--to", "12345", "--text",
        "---\ntitle: Literal inline reply\n---\nReply body", "--dry-run",
      ],
      undefined,
      { allowReplyDryRunDatabase: true },
    );
    assert.equal(literalReply.status, 0, output(literalReply));
    assert.match(literalReply.stdout, /---\ntitle: Literal inline reply\n---\nReply body/);
    assert.doesNotMatch(output(literalReply), /PLATFORM_IMPORT_BLOCKED/);

    const weighted = runCli(
      fixture,
      ["x", "draft", "--format", "tweet", "--from", "-", "--dry-run"],
      `---\nignored: ${"z".repeat(600)}\n---\n${"汉".repeat(140)}`,
    );
    assert.equal(weighted.status, 0, output(weighted));
    assert.match(weighted.stdout, /\[280 twitter-text weighted chars\]/);
    assert.doesNotMatch(output(weighted), /ignored:|PLATFORM_IMPORT_BLOCKED/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("malformed X mapping frontmatter exits 2 before artifacts, state, profiles, or platform imports", () => {
  const fixture = createFixture();
  try {
    const malformedPath = join(fixture.dir, "x-malformed.md");
    const unterminatedPath = join(fixture.dir, "x-unterminated.md");
    const weightedPath = join(fixture.dir, "x-weighted.md");
    writeFileSync(
      malformedPath,
      "---\nprivate: workflow-secret\ntitle: [broken\n---\nVisible body",
    );
    writeFileSync(
      unterminatedPath,
      "---\nprivate: workflow-secret\ntitle: Hidden\nVisible body",
    );
    writeFileSync(
      weightedPath,
      `---\nprivate: ${"z".repeat(600)}\n---\n${"汉".repeat(141)}`,
    );

    for (const args of [
      ["x", "draft", "--format", "tweet", "--from", malformedPath],
      ["x", "draft", "--format", "thread", "--from", malformedPath],
      ["x", "draft", "--format", "article", "--from", malformedPath],
      ["x", "reply", "--to", "12345", "--from", malformedPath],
    ]) {
      for (const dryRun of [false, true]) {
        const invalid = runCli(fixture, dryRun ? [...args, "--dry-run"] : args);
        assert.equal(invalid.status, 2, output(invalid));
        assert.equal(invalid.signal, null, output(invalid));
        assert.match(
          output(invalid),
          /actual: malformed_yaml; expected: a valid YAML mapping between leading --- delimiters/,
        );
        assert.doesNotMatch(output(invalid), /workflow-secret|Visible body|PLATFORM_IMPORT_BLOCKED/);
        assert.doesNotMatch(output(invalid), /format:/);
      }
    }

    const malformedStdin = "\ufeff---\rprivate: stdin-secret\rtitle: [broken\r---\rBody";
    for (const args of [
      ["x", "draft", "--format", "tweet", "--from", "-"],
      ["x", "draft", "--format", "thread", "--from", "-"],
      ["x", "draft", "--format", "article", "--from", "-"],
      ["x", "reply", "--to", "12345", "--from", "-"],
    ]) {
      for (const dryRun of [false, true]) {
        const invalid = runCli(
          fixture,
          dryRun ? [...args, "--dry-run"] : args,
          malformedStdin,
        );
        assert.equal(invalid.status, 2, output(invalid));
        assert.equal(invalid.signal, null, output(invalid));
        assert.match(output(invalid), /actual: malformed_yaml; expected: a valid YAML mapping/);
        assert.doesNotMatch(output(invalid), /stdin-secret|Body|PLATFORM_IMPORT_BLOCKED/);
        assert.doesNotMatch(output(invalid), /format:/);
      }
    }

    const unterminated = runCli(fixture, [
      "x", "reply", "--to", "12345", "--from", unterminatedPath, "--dry-run",
    ]);
    assert.equal(unterminated.status, 2, output(unterminated));
    assert.equal(unterminated.signal, null, output(unterminated));
    assert.match(
      output(unterminated),
      /actual: missing_closing_delimiter; expected: a closing --- delimiter for leading YAML frontmatter/,
    );
    assert.doesNotMatch(output(unterminated), /workflow-secret|Visible body|PLATFORM_IMPORT_BLOCKED/);

    const unterminatedDraft = runCli(fixture, [
      "x", "draft", "--format", "tweet", "--from", unterminatedPath, "--dry-run",
    ]);
    assert.equal(unterminatedDraft.status, 2, output(unterminatedDraft));
    assert.equal(unterminatedDraft.signal, null, output(unterminatedDraft));
    assert.match(
      output(unterminatedDraft),
      /actual: missing_closing_delimiter; expected: a closing --- delimiter for leading YAML frontmatter/,
    );
    assert.doesNotMatch(
      output(unterminatedDraft),
      /workflow-secret|Visible body|format:|PLATFORM_IMPORT_BLOCKED/,
    );

    const weighted = runCli(fixture, [
      "x", "draft", "--format", "tweet", "--from", weightedPath, "--dry-run",
    ]);
    assert.equal(weighted.status, 2, output(weighted));
    assert.match(output(weighted), /282 weighted chars.*limit is 280/s);
    assert.equal(existsSync(join(fixture.dir, "x-weighted.x-tweet.txt")), false);

    for (const artifact of [
      "x-malformed.x-tweet.txt",
      "x-malformed.x-thread.txt",
      "x-malformed.x-article.md",
      "x-unterminated.x-tweet.txt",
    ]) {
      assert.equal(existsSync(join(fixture.dir, artifact)), false, artifact);
    }
    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("WeChat file/stdin frontmatter is normalized while inline text remains literal", () => {
  const fixture = createFixture();
  try {
    const cover = join(fixture.dir, "wechat-cover.png");
    const flagCover = join(fixture.dir, "wechat-flag-cover.png");
    const bodyImage = join(fixture.dir, "wechat-body.png");
    writeFileSync(cover, png(900, 900));
    writeFileSync(flagCover, png(940, 400));
    writeFileSync(bodyImage, png(640, 480));

    for (const [index, newline] of ["\n", "\r\n", "\r"].entries()) {
      const sourcePath = join(fixture.dir, `wechat-mapping-${index}.md`);
      const outPath = join(fixture.dir, `wechat-mapping-${index}.html`);
      writeFileSync(
        sourcePath,
        `\ufeff---${newline}` +
          `title: Metadata title ${index}${newline}` +
          `author: Metadata author ${index}${newline}` +
          `description: Metadata digest ${index}${newline}` +
          `coverImage: ./wechat-cover.png${newline}` +
          `sourceUrl: https://example.com/source-${index}${newline}` +
          `private: workflow-secret-${index}${newline}` +
          `---${newline}` +
          `Visible body ${index}${newline}${newline}` +
          `![body](./wechat-body.png)${newline}`,
      );
      const result = runCli(fixture, [
        "wechat", "draft", "--from", sourcePath, "--out", outPath, "--dry-run",
      ]);
      assert.equal(result.status, 0, output(result));
      assert.match(result.stdout, new RegExp(`title .*: Metadata title ${index}`));
      assert.match(result.stdout, new RegExp(`author: Metadata author ${index}`));
      assert.match(result.stdout, new RegExp(`digest .*: Metadata digest ${index}`));
      assert.match(result.stdout, new RegExp(`source-${index}`));
      assert.match(result.stdout, new RegExp(`Visible body ${index}`));
      assert.match(result.stdout, new RegExp(`${bodyImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.doesNotMatch(output(result), new RegExp(`workflow-secret-${index}|private:|PLATFORM_IMPORT_BLOCKED`));
      const html = readFileSync(outPath, "utf8");
      assert.match(html, new RegExp(`Visible body ${index}`));
      assert.doesNotMatch(
        html,
        new RegExp(`Metadata title ${index}|Metadata author ${index}|Metadata digest ${index}|workflow-secret-${index}|coverImage|sourceUrl|private:`),
      );
    }

    const stdinOut = join(fixture.dir, "wechat-stdin.html");
    const stdin = runCli(
      fixture,
      ["wechat", "draft", "--from", "-", "--out", stdinOut, "--dry-run"],
      `\ufeff---\rtitle: Stdin title\rauthor: Stdin author\rsummary: Stdin digest\r` +
        "cover: ./wechat-cover.png\rcontentSourceUrl: https://example.com/stdin\r" +
        "private: stdin-secret\r---\rStdin visible\r\r![body](./wechat-body.png)",
      { cwd: fixture.dir },
    );
    assert.equal(stdin.status, 0, output(stdin));
    assert.match(stdin.stdout, /title .*: Stdin title/);
    assert.match(stdin.stdout, /author: Stdin author/);
    assert.match(stdin.stdout, /digest .*: Stdin digest/);
    assert.match(stdin.stdout, /https:\/\/example\.com\/stdin/);
    assert.match(readFileSync(stdinOut, "utf8"), /Stdin visible/);
    assert.doesNotMatch(output(stdin), /stdin-secret|private:|PLATFORM_IMPORT_BLOCKED/);
    assert.doesNotMatch(readFileSync(stdinOut, "utf8"), /Stdin title|Stdin author|Stdin digest|stdin-secret|private:/);

    const articleDir = join(fixture.dir, "article");
    mkdirSync(articleDir);
    const articleBodyImage = join(articleDir, "local-body.png");
    const precedencePath = join(articleDir, "precedence.md");
    writeFileSync(articleBodyImage, png(320, 240));
    writeFileSync(
      precedencePath,
      "---\ntitle: Metadata title\ncoverImage: missing-metadata-cover.png\n---\n" +
        "File body\n\n![local](./local-body.png)",
    );
    const flagCoverFromCwd = runCli(
      fixture,
      [
        "wechat", "draft", "--from", "article/precedence.md",
        "--title", "Flag title", "--cover", "wechat-flag-cover.png", "--dry-run",
      ],
      undefined,
      { cwd: fixture.dir },
    );
    assert.equal(flagCoverFromCwd.status, 0, output(flagCoverFromCwd));
    assert.match(flagCoverFromCwd.stdout, /title .*: Flag title/);
    assert.match(flagCoverFromCwd.stdout, new RegExp(flagCover.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(flagCoverFromCwd.stdout, new RegExp(articleBodyImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(output(flagCoverFromCwd), /missing-metadata-cover|Metadata title|PLATFORM_IMPORT_BLOCKED/);

    const emptyPath = join(fixture.dir, "wechat-empty.md");
    writeFileSync(
      emptyPath,
      "\ufeff---\r# comment-only metadata\r---\r# Lone CR heading\r\rLone CR body",
    );
    const empty = runCli(fixture, [
      "wechat", "draft", "--from", emptyPath, "--cover", cover, "--dry-run",
    ]);
    assert.equal(empty.status, 0, output(empty));
    assert.equal(empty.stdout.match(/Lone CR heading/g)?.length, 1, empty.stdout);
    assert.match(empty.stdout, /Lone CR body/);
    assert.doesNotMatch(output(empty), /comment-only metadata|PLATFORM_IMPORT_BLOCKED/);

    const explicitEmptyPath = join(fixture.dir, "wechat-empty-map.md");
    writeFileSync(explicitEmptyPath, "---\n{}\n---\n# Empty-map title\n\nEmpty-map body");
    const explicitEmpty = runCli(fixture, [
      "wechat", "draft", "--from", explicitEmptyPath, "--cover", cover, "--dry-run",
    ]);
    assert.equal(explicitEmpty.status, 0, output(explicitEmpty));
    assert.match(explicitEmpty.stdout, /title .*: Empty-map title/);
    assert.match(explicitEmpty.stdout, /Empty-map body/);
    assert.doesNotMatch(output(explicitEmpty), /PLATFORM_IMPORT_BLOCKED/);

    for (const [name, source, evidence] of [
      ["scalar", "\ufeff---\rfalse\r---\rScalar body", /false[\s\S]*Scalar body/],
      ["sequence", "\ufeff---\r\n- first\r\n- second\r\n---\r\nSequence body", /first[\s\S]*second[\s\S]*Sequence body/],
      ["colon-scalar", "\ufeff---\nKey:value prose\n---\nColon body", /Key:value prose[\s\S]*Colon body/],
      ["thematic", "\ufeff---\n\nA thematic section\n\n---\n\nMore prose", /A thematic section[\s\S]*More prose/],
      ["unclosed-prose", "\ufeff---\n\nOrdinary body\n\nEdit: text", /Ordinary body[\s\S]*Edit: text/],
    ] as const) {
      const ordinary = runCli(
        fixture,
        ["wechat", "draft", "--from", "-", "--title", "Literal source", "--cover", cover, "--dry-run"],
        source,
      );
      assert.equal(ordinary.status, 0, `${name}: ${output(ordinary)}`);
      assert.match(ordinary.stdout, evidence);
      assert.doesNotMatch(output(ordinary), /PLATFORM_IMPORT_BLOCKED/);
    }

    const inlineSource = "---\ntitle: Literal inline metadata\ncoverImage: missing.png\n---\nInline body";
    const inline = runCli(
      fixture,
      [
        "wechat", "draft", "--text", inlineSource,
        "--title", "Flag title", "--cover", "wechat-flag-cover.png", "--dry-run",
      ],
      undefined,
      { cwd: fixture.dir },
    );
    assert.equal(inline.status, 0, output(inline));
    assert.match(inline.stdout, /title: Literal inline metadata/);
    assert.match(inline.stdout, /coverImage: missing\.png/);
    assert.match(inline.stdout, /Inline body/);
    assert.match(inline.stdout, new RegExp(flagCover.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(output(inline), /PLATFORM_IMPORT_BLOCKED/);

    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("WeChat CLI honors flag, frontmatter, environment, and empty author precedence", () => {
  const fixture = createFixture();
  try {
    const cover = join(fixture.dir, "wechat-author-cover.png");
    const file = join(fixture.dir, "wechat-author.md");
    const blankFile = join(fixture.dir, "wechat-author-blank.md");
    const nonStringFile = join(fixture.dir, "wechat-author-number.md");
    writeFileSync(cover, png(900, 900));
    writeFileSync(file, "---\nauthor: Metadata Author\n---\nBody");
    writeFileSync(blankFile, "---\nauthor: \"   \"\n---\nBody");
    writeFileSync(nonStringFile, "---\nauthor: 42\n---\nBody");

    const flagWins = runCli(
      fixture,
      [
        "wechat", "draft", "--from", file, "--title", "Title", "--cover", cover,
        "--author", "  Flag Author  ", "--dry-run",
      ],
      undefined,
      { wechatAuthor: "Environment Author" },
    );
    assert.equal(flagWins.status, 0, output(flagWins));
    assert.match(flagWins.stdout, /^author: Flag Author$/m);
    assert.doesNotMatch(output(flagWins), /Metadata Author|Environment Author|PLATFORM_IMPORT_BLOCKED/);

    for (const supplied of ["", "   "]) {
      const flagClears = runCli(
        fixture,
        [
          "wechat", "draft", "--from", file, "--title", "Title", "--cover", cover,
          "--author", supplied, "--dry-run",
        ],
        undefined,
        { wechatAuthor: "Environment Author" },
      );
      assert.equal(flagClears.status, 0, output(flagClears));
      assert.match(flagClears.stdout, /^author: \(none\)$/m);
      assert.doesNotMatch(output(flagClears), /Metadata Author|Environment Author|PLATFORM_IMPORT_BLOCKED/);
    }

    const metadataWins = runCli(
      fixture,
      ["wechat", "draft", "--from", file, "--title", "Title", "--cover", cover, "--dry-run"],
      undefined,
      { wechatAuthor: "Environment Author" },
    );
    assert.equal(metadataWins.status, 0, output(metadataWins));
    assert.match(metadataWins.stdout, /^author: Metadata Author$/m);
    assert.doesNotMatch(output(metadataWins), /Environment Author|PLATFORM_IMPORT_BLOCKED/);

    for (const sourcePath of [blankFile, nonStringFile]) {
      const environmentWins = runCli(
        fixture,
        ["wechat", "draft", "--from", sourcePath, "--title", "Title", "--cover", cover, "--dry-run"],
        undefined,
        { wechatAuthor: "  Environment Author  " },
      );
      assert.equal(environmentWins.status, 0, output(environmentWins));
      assert.match(environmentWins.stdout, /^author: Environment Author$/m);
      assert.doesNotMatch(output(environmentWins), /author: 42|PLATFORM_IMPORT_BLOCKED/);
    }

    const stdinMetadata = runCli(
      fixture,
      ["wechat", "draft", "--from", "-", "--title", "Title", "--cover", cover, "--dry-run"],
      "---\nauthor: Stdin Author\n---\nStdin body",
      { wechatAuthor: "Environment Author" },
    );
    assert.equal(stdinMetadata.status, 0, output(stdinMetadata));
    assert.match(stdinMetadata.stdout, /^author: Stdin Author$/m);
    assert.doesNotMatch(output(stdinMetadata), /Environment Author|PLATFORM_IMPORT_BLOCKED/);

    const stdinEnvironment = runCli(
      fixture,
      ["wechat", "draft", "--from", "-", "--title", "Title", "--cover", cover, "--dry-run"],
      "---\nauthor: \"   \"\n---\nStdin body",
      { wechatAuthor: "  Environment Author  " },
    );
    assert.equal(stdinEnvironment.status, 0, output(stdinEnvironment));
    assert.match(stdinEnvironment.stdout, /^author: Environment Author$/m);
    assert.doesNotMatch(output(stdinEnvironment), /PLATFORM_IMPORT_BLOCKED/);

    const inlineLiteral = runCli(
      fixture,
      [
        "wechat", "draft", "--text", "---\nauthor: Literal Body Author\n---\nInline body",
        "--title", "Title", "--cover", cover, "--dry-run",
      ],
      undefined,
      { wechatAuthor: "Environment Author" },
    );
    assert.equal(inlineLiteral.status, 0, output(inlineLiteral));
    assert.match(inlineLiteral.stdout, /^author: Environment Author$/m);
    assert.match(inlineLiteral.stdout, /author: Literal Body Author/);
    assert.doesNotMatch(output(inlineLiteral), /PLATFORM_IMPORT_BLOCKED/);

    for (const configured of ["", "   "]) {
      const emptyFallback = runCli(
        fixture,
        ["wechat", "draft", "--text", "Body", "--title", "Title", "--cover", cover, "--dry-run"],
        undefined,
        { wechatAuthor: configured },
      );
      assert.equal(emptyFallback.status, 0, output(emptyFallback));
      assert.match(emptyFallback.stdout, /^author: \(none\)$/m);
      assert.doesNotMatch(output(emptyFallback), /PLATFORM_IMPORT_BLOCKED/);
    }

    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("malformed WeChat mapping frontmatter exits 2 before artifacts, assets, state, or API imports", () => {
  const fixture = createFixture();
  try {
    const malformedPath = join(fixture.dir, "wechat-malformed.md");
    const unterminatedPath = join(fixture.dir, "wechat-unterminated.md");
    const literalCover = join(fixture.dir, "literal-cover.png");
    writeFileSync(literalCover, png(900, 900));
    writeFileSync(
      malformedPath,
      "---\ntitle: Hidden\nprivate: workflow-secret\ncoverImage: missing.png\nowner: [broken\n---\nVisible body",
    );
    writeFileSync(
      unterminatedPath,
      "\ufeff---\rtitle: Hidden\rprivate: workflow-secret\rcoverImage: missing.png\rVisible body",
    );

    for (const [name, sourcePath, evidence] of [
      ["malformed", malformedPath, /actual: malformed_yaml; expected: a valid YAML mapping between leading --- delimiters/],
      ["unterminated", unterminatedPath, /actual: missing_closing_delimiter; expected: a closing --- delimiter for leading YAML frontmatter/],
    ] as const) {
      for (const dryRun of [false, true]) {
        const outPath = join(fixture.dir, `${name}-${dryRun ? "dry" : "real"}.html`);
        if (dryRun) writeFileSync(outPath, "sentinel: do not overwrite");
        const result = runCli(fixture, [
          "wechat", "draft", "--from", sourcePath, "--out", outPath,
          ...(dryRun ? ["--dry-run"] : []),
        ], undefined, { wechatAuthor: "ENV_AUTHOR_SECRET_SENTINEL_66" });
        assert.equal(result.status, 2, output(result));
        assert.equal(result.signal, null, output(result));
        assert.equal(result.stdout, "");
        assert.match(output(result), evidence);
        assert.match(output(result), new RegExp(sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(
          output(result),
          /workflow-secret|Visible body|ENV_AUTHOR_SECRET_SENTINEL_66|PLATFORM_IMPORT_BLOCKED/,
        );
        if (dryRun) {
          assert.equal(readFileSync(outPath, "utf8"), "sentinel: do not overwrite");
        } else {
          assert.equal(existsSync(outPath), false, outPath);
        }
      }
    }

    for (const dryRun of [false, true]) {
      const malformedStdinOut = join(fixture.dir, `malformed-stdin-${dryRun ? "dry" : "real"}.html`);
      if (dryRun) writeFileSync(malformedStdinOut, "sentinel: do not overwrite");
      const malformedStdin = runCli(
        fixture,
        [
          "wechat", "draft", "--from", "-", "--out", malformedStdinOut,
          ...(dryRun ? ["--dry-run"] : []),
        ],
        "\ufeff---\rtitle: Hidden\rprivate: stdin-secret\rowner: [broken\r---\rBody",
        { wechatAuthor: "STDIN_ENV_AUTHOR_SECRET_SENTINEL_66" },
      );
      assert.equal(malformedStdin.status, 2, output(malformedStdin));
      assert.equal(malformedStdin.stdout, "");
      assert.match(output(malformedStdin), /stdin \(--from -\): leading frontmatter is malformed YAML/);
      assert.match(output(malformedStdin), /actual: malformed_yaml; expected: a valid YAML mapping/);
      assert.doesNotMatch(
        output(malformedStdin),
        /stdin-secret|Body|STDIN_ENV_AUTHOR_SECRET_SENTINEL_66|PLATFORM_IMPORT_BLOCKED/,
      );
      if (dryRun) {
        assert.equal(readFileSync(malformedStdinOut, "utf8"), "sentinel: do not overwrite");
      } else {
        assert.equal(existsSync(malformedStdinOut), false);
      }
    }

    const literalMalformed = runCli(
      fixture,
      [
        "wechat", "draft", "--text", "---\ntitle: [literal\n---\nInline body",
        "--title", "Literal", "--cover", "literal-cover.png", "--dry-run",
      ],
      undefined,
      { cwd: fixture.dir },
    );
    assert.equal(literalMalformed.status, 0, output(literalMalformed));
    assert.match(literalMalformed.stdout, /title: \[literal/);
    assert.match(literalMalformed.stdout, /Inline body/);
    assert.doesNotMatch(output(literalMalformed), /frontmatter is malformed YAML|PLATFORM_IMPORT_BLOCKED/);

    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("WeChat HTML and URL safety failures exit 2 before assets, output, state, or API imports", () => {
  const fixture = createFixture();
  try {
    const unsafeFrontmatter = join(fixture.dir, "wechat-unsafe-source.md");
    writeFileSync(
      unsafeFrontmatter,
      "---\ntitle: Title\ncoverImage: ./missing-cover.png\n" +
        "sourceUrl: data:text/html,FRONTMATTER_SECRET_67\n---\nBody",
    );
    const cases: Array<{ name: string; args: string[]; evidence: RegExp }> = [
      {
        name: "raw-html",
        args: [
          "wechat", "draft", "--title", "Title", "--text",
          "Body <IMG SRC=x OnErRoR=RAW_HTML_SECRET_67>",
          "--cover", join(fixture.dir, "missing-cover.png"),
        ],
        evidence: /actual: raw_html; expected: Markdown syntax, escaped HTML text, or code/,
      },
      {
        name: "encoded-link-scheme",
        args: [
          "wechat", "draft", "--title", "Title", "--text",
          "[safe-looking](java%73cript%3AURL_SECRET_67)",
          "--cover", join(fixture.dir, "missing-cover.png"),
        ],
        evidence: /actual: javascript; expected: http, https, mailto, a relative URL, or a fragment/,
      },
      {
        name: "scheme-relative-image",
        args: [
          "wechat", "draft", "--title", "Title", "--text",
          "![image](%2f%2fURL_SECRET_67.example/image.png)",
          "--cover", join(fixture.dir, "missing-cover.png"),
        ],
        evidence: /actual: scheme_relative; expected: an http\(s\) URL or local filesystem path/,
      },
      {
        name: "edge-control-link",
        args: [
          "wechat", "draft", "--title", "Title", "--text",
          "[link](<\thttps://URL_SECRET_67.example\t>)",
          "--cover", join(fixture.dir, "missing-cover.png"),
        ],
        evidence: /actual: control_character; expected: http, https, mailto, a relative URL, or a fragment/,
      },
      {
        name: "source-url-flag",
        args: [
          "wechat", "draft", "--title", "Title", "--text", "Body",
          "--source-url", "VBScript:URL_SECRET_67",
          "--cover", join(fixture.dir, "missing-cover.png"),
        ],
        evidence: /actual: vbscript; expected: an absolute http:\/\/ or https:\/\/ URL/,
      },
      {
        name: "source-url-edge-space",
        args: [
          "wechat", "draft", "--title", "Title", "--text", "Body",
          "--source-url", "https://URL_SECRET_67.example/source\u00a0",
          "--cover", join(fixture.dir, "missing-cover.png"),
        ],
        evidence: /actual: surrounding_whitespace; expected: an absolute http:\/\/ or https:\/\/ URL/,
      },
      {
        name: "source-url-frontmatter",
        args: ["wechat", "draft", "--from", unsafeFrontmatter],
        evidence: /actual: data; expected: an absolute http:\/\/ or https:\/\/ URL/,
      },
    ];

    for (const testCase of cases) {
      for (const dryRun of [false, true]) {
        const outPath = join(fixture.dir, `${testCase.name}-${dryRun ? "dry" : "real"}.html`);
        if (dryRun) writeFileSync(outPath, "sentinel: do not overwrite");
        const result = runCli(fixture, [
          ...testCase.args,
          "--out", outPath,
          ...(dryRun ? ["--dry-run"] : []),
        ]);
        assert.equal(result.status, 2, `${testCase.name}: ${output(result)}`);
        assert.equal(result.signal, null, output(result));
        assert.equal(result.stdout, "");
        assert.match(result.stderr, testCase.evidence);
        assert.doesNotMatch(
          output(result),
          /SECRET_67|missing-cover.*(?:not found|regular file)|PLATFORM_IMPORT_BLOCKED|Please report this|markedjs/,
        );
        if (dryRun) {
          assert.equal(readFileSync(outPath, "utf8"), "sentinel: do not overwrite");
        } else {
          assert.equal(existsSync(outPath), false);
        }
      }
    }

    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("valid dry-runs also avoid platform/browser/API imports", () => {
  const fixture = createFixture();
  try {
    const linkedinMedia = join(fixture.dir, "linkedin.png");
    const wechatCover = join(fixture.dir, "wechat.png");
    const wechatBody = join(fixture.dir, "wechat-body.png");
    writeFileSync(linkedinMedia, png(1200, 800));
    writeFileSync(wechatCover, png(900, 900));
    writeFileSync(wechatBody, png(640, 480));

    const cases = [
      ["x", "draft", "--format", "tweet", "--text", "valid X post", "--dry-run"],
      ["linkedin", "draft", "--text", "valid LinkedIn post", "--media", linkedinMedia, "--dry-run"],
      ["reddit", "draft", "--subreddit", "test", "--title", "Title", "--text", "Body", "--dry-run"],
      ["wechat", "draft", "--title", "Title", "--text", "Body", "--cover", wechatCover, "--dry-run"],
    ];
    for (const args of cases) {
      const result = runCli(fixture, args);
      assert.equal(result.status, 0, output(result));
      assert.match(output(result), /dry-run/i);
      assert.doesNotMatch(output(result), /PLATFORM_IMPORT_BLOCKED/);
    }

    const xFidelity = runCli(fixture, [
      "x", "draft", "--format", "tweet", "--text",
      "# Omitted title\n\n## Omitted section\n\nBody stays", "--dry-run",
    ]);
    assert.equal(xFidelity.status, 0, output(xFidelity));
    assert.match(xFidelity.stdout, /Source line 1 \(title_heading\) was omitted/);
    assert.match(xFidelity.stdout, /Source line 3 \(section_heading\) was omitted/);
    assert.match(xFidelity.stdout, /# Omitted title|## Omitted section/);
    assert.doesNotMatch(output(xFidelity), /PLATFORM_IMPORT_BLOCKED/);

    const referenceLink = runCli(fixture, [
      "linkedin", "draft", "--text",
      "Read [the docs][ref].\n\n[ref]: https://example.com/docs", "--dry-run",
    ]);
    assert.equal(referenceLink.status, 0, output(referenceLink));
    assert.match(referenceLink.stdout, /https:\/\/example\.com\/docs \(the docs\)/);
    assert.match(referenceLink.stdout, /FIRST COMMENT/);
    assert.doesNotMatch(output(referenceLink), /PLATFORM_IMPORT_BLOCKED/);

    const linkedinHelp = runCli(fixture, ["linkedin", "draft", "--help"]);
    assert.equal(linkedinHelp.status, 0, output(linkedinHelp));
    assert.match(linkedinHelp.stdout, /leading --- is literal/);
    assert.match(linkedinHelp.stdout, /Markdown images never attach files/);
    assert.doesNotMatch(output(linkedinHelp), /PLATFORM_IMPORT_BLOCKED/);

    const wechatInspection = runCli(fixture, [
      "wechat", "draft", "--title", "Title", "--text",
      `Body\n\n![body](${wechatBody})`, "--cover", wechatCover, "--dry-run",
    ]);
    assert.equal(wechatInspection.status, 0, output(wechatInspection));
    assert.match(
      wechatInspection.stdout,
      /cover: .*wechat\.png\n  image\/png; 900x900; 24 bytes; aspect 1\.0000/,
    );
    assert.match(
      wechatInspection.stdout,
      /wechat-body\.png[\s\S]*image\/png; 640x480; 24 bytes; aspect 1\.3333/,
    );
    assert.match(wechatInspection.stdout, /locally verified: readable file, magic\/header type/);
    assert.match(
      wechatInspection.stdout,
      /server-authoritative\/unverified: maximum_bytes_per_image.*maximum_body_image_count/,
    );
    assert.match(wechatInspection.stdout, /listed server-authoritative constraints remain unverified/);
    assert.doesNotMatch(output(wechatInspection), /PLATFORM_IMPORT_BLOCKED/);
    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("LinkedIn file/stdin frontmatter is stripped, inline text stays literal, and malformed input fails", () => {
  const fixture = createFixture();
  try {
    const postPath = join(fixture.dir, "post.md");
    const malformedPath = join(fixture.dir, "malformed.md");
    const unterminatedPath = join(fixture.dir, "unterminated.md");
    const emptyFrontmatterPath = join(fixture.dir, "empty-frontmatter.md");
    const nulPath = join(fixture.dir, "nul.md");
    const flaggedPath = join(fixture.dir, "flagged.md");
    writeFileSync(postPath, "---\ntitle: Should Not Leak\nowner: operator\n---\nBody stays\n");
    writeFileSync(malformedPath, "---\ntitle: [broken\n---\nBody\n");
    writeFileSync(unterminatedPath, "---\ntitle: Leaks\nowner: operator\nBody\n");
    writeFileSync(emptyFrontmatterPath, "---\n---\nMedia body\n");
    writeFileSync(nulPath, "before \u00000\u0000 after\n");
    writeFileSync(
      flaggedPath,
      "---\ntitle: Hidden\nowner: operator\n---\nOpening\n\n\n![asset](asset.png)\n\n```js\nrun()\n```\n",
    );

    const fromFile = runCli(fixture, ["linkedin", "draft", "--from", postPath, "--dry-run"]);
    assert.equal(fromFile.status, 0, output(fromFile));
    assert.match(fromFile.stdout, /Body stays/);
    assert.doesNotMatch(fromFile.stdout, /Should Not Leak|owner: operator/);

    const flagged = runCli(fixture, [
      "linkedin", "draft", "--from", flaggedPath, "--dry-run",
    ]);
    assert.equal(flagged.status, 0, output(flagged));
    assert.match(flagged.stdout, /\[js\] line 10: run\(\)/);
    assert.match(flagged.stdout, /line 8: asset\.png \(alt: asset\)/);
    assert.doesNotMatch(flagged.stdout, /title: Hidden|owner: operator|PLATFORM_IMPORT_BLOCKED/);

    const emptyFrontmatter = runCli(fixture, [
      "linkedin", "draft", "--from", emptyFrontmatterPath, "--dry-run",
    ]);
    assert.equal(emptyFrontmatter.status, 0, output(emptyFrontmatter));
    assert.match(emptyFrontmatter.stdout, /Media body/);
    assert.doesNotMatch(emptyFrontmatter.stdout, /PLATFORM_IMPORT_BLOCKED/);

    const fromStdin = runCli(
      fixture,
      ["linkedin", "draft", "--from", "-", "--dry-run"],
      "---\ntitle: Stdin Metadata\n---\nStdin body\n",
    );
    assert.equal(fromStdin.status, 0, output(fromStdin));
    assert.match(fromStdin.stdout, /Stdin body/);
    assert.doesNotMatch(fromStdin.stdout, /Stdin Metadata/);

    const inline = runCli(fixture, [
      "linkedin", "draft", "--text", "---\ntitle: Literal content\n---\nBody", "--dry-run",
    ]);
    assert.equal(inline.status, 0, output(inline));
    assert.match(inline.stdout, /title: Literal content/);

    const malformed = runCli(fixture, [
      "linkedin", "draft", "--from", malformedPath, "--dry-run",
    ]);
    assert.equal(malformed.status, 2, output(malformed));
    assert.match(output(malformed), /frontmatter is malformed YAML/);
    assert.doesNotMatch(output(malformed), /PLATFORM_IMPORT_BLOCKED/);

    const unterminated = runCli(fixture, [
      "linkedin", "draft", "--from", unterminatedPath, "--dry-run",
    ]);
    assert.equal(unterminated.status, 2, output(unterminated));
    assert.match(output(unterminated), /no closing --- delimiter/);
    assert.doesNotMatch(output(unterminated), /title: Leaks|owner: operator|PLATFORM_IMPORT_BLOCKED/);

    for (const dryRun of [false, true]) {
      const nul = runCli(
        fixture,
        ["linkedin", "draft", "--from", nulPath, ...(dryRun ? ["--dry-run"] : [])],
      );
      assert.equal(nul.status, 2, output(nul));
      assert.match(output(nul), /unsupported U\+0000 control character/);
      assert.doesNotMatch(output(nul), /PLATFORM_IMPORT_BLOCKED/);
    }

    const directory = runCli(fixture, [
      "linkedin", "draft", "--from", fixture.dir, "--dry-run",
    ]);
    assert.equal(directory.status, 2, output(directory));
    assert.match(output(directory), /not a regular file/);
    assert.doesNotMatch(output(directory), /\n\s+at /);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Reddit file/stdin frontmatter is exact, literal input stays literal, and failures are zero-touch", () => {
  const fixture = createFixture();
  try {
    for (const [index, newline] of ["\n", "\r\n", "\r"].entries()) {
      const postPath = join(fixture.dir, `reddit-${index}.md`);
      writeFileSync(
        postPath,
        `\ufeff---${newline}subreddit: from-file${newline}title: From file${newline}` +
          `flair: Discussion${newline}---${newline}Visible body${newline}`,
      );
      const fromFile = runCli(fixture, ["reddit", "draft", "--from", postPath, "--dry-run"]);
      assert.equal(fromFile.status, 0, output(fromFile));
      assert.match(fromFile.stdout, /subreddit: r\/from-file/);
      assert.match(fromFile.stdout, /flair \(requested\): Discussion/);
      assert.match(fromFile.stdout, /\nFrom file\n/);
      assert.match(fromFile.stdout, /Visible body/);
      assert.doesNotMatch(fromFile.stdout, /title: From file|subreddit: from-file|PLATFORM_IMPORT_BLOCKED/);
    }

    const precedencePath = join(fixture.dir, "reddit-precedence.md");
    writeFileSync(
      precedencePath,
      "---\nsubreddit: metadata-sub\ntitle: Metadata title\nflair: Metadata flair\n---\nBody\n",
    );
    const precedence = runCli(fixture, [
      "reddit", "draft", "--from", precedencePath,
      "--subreddit", "flag-sub", "--title", "Flag title", "--flair", "Flag flair",
      "--nsfw", "--spoiler", "--dry-run",
    ]);
    assert.equal(precedence.status, 0, output(precedence));
    assert.match(precedence.stdout, /subreddit: r\/flag-sub/);
    assert.match(precedence.stdout, /flair \(requested\): Flag flair/);
    assert.match(precedence.stdout, /\nFlag title\n/);
    assert.match(precedence.stdout, /flags: NSFW, spoiler/);
    assert.doesNotMatch(precedence.stdout, /metadata-sub|Metadata title|Metadata flair/);

    for (const [flag, evidence] of [
      ["--subreddit", /--subreddit was provided but empty/],
      ["--title", /--title was provided but empty/],
    ] as const) {
      const explicitlyEmpty = runCli(fixture, [
        "reddit", "draft", "--from", precedencePath, flag, "", "--dry-run",
      ]);
      assert.equal(explicitlyEmpty.status, 2, output(explicitlyEmpty));
      assert.match(output(explicitlyEmpty), evidence);
      assert.doesNotMatch(output(explicitlyEmpty), /PLATFORM_IMPORT_BLOCKED/);
    }
    const clearFlair = runCli(fixture, [
      "reddit", "draft", "--from", precedencePath, "--flair", "", "--dry-run",
    ]);
    assert.equal(clearFlair.status, 0, output(clearFlair));
    assert.doesNotMatch(clearFlair.stdout, /flair \(requested\): Metadata flair/);
    assert.doesNotMatch(clearFlair.stdout, /PLATFORM_IMPORT_BLOCKED/);

    const fromStdin = runCli(
      fixture,
      ["reddit", "draft", "--from", "-", "--dry-run"],
      "\ufeff---\rsubreddit: stdin-sub\rtitle: Stdin title\r---\rStdin body\r",
    );
    assert.equal(fromStdin.status, 0, output(fromStdin));
    assert.match(fromStdin.stdout, /subreddit: r\/stdin-sub/);
    assert.match(fromStdin.stdout, /Stdin title/);
    assert.match(fromStdin.stdout, /Stdin body/);
    assert.doesNotMatch(fromStdin.stdout, /subreddit: stdin-sub|PLATFORM_IMPORT_BLOCKED/);

    const commentMapH1Path = join(fixture.dir, "reddit-comment-map-h1.md");
    writeFileSync(
      commentMapH1Path,
      "\ufeff---\r# empty metadata comment\r---\r  # Lone CR H1 title\rLone CR body\r",
    );
    const commentMapH1 = runCli(fixture, [
      "reddit", "draft", "--from", commentMapH1Path,
      "--subreddit", "test", "--dry-run",
    ]);
    assert.equal(commentMapH1.status, 0, output(commentMapH1));
    assert.match(commentMapH1.stdout, /\nLone CR H1 title\n/);
    assert.match(commentMapH1.stdout, /Lone CR body/);
    assert.doesNotMatch(commentMapH1.stdout, /empty metadata comment|PLATFORM_IMPORT_BLOCKED/);

    const emptyPath = join(fixture.dir, "reddit-empty-map.md");
    writeFileSync(emptyPath, "---\n{}\n---\nEmpty-map body\n");
    const empty = runCli(fixture, [
      "reddit", "draft", "--from", emptyPath, "--subreddit", "test", "--title", "Title", "--dry-run",
    ]);
    assert.equal(empty.status, 0, output(empty));
    assert.match(empty.stdout, /Empty-map body/);

    const lateMappingPath = join(fixture.dir, "reddit-late-mapping-prose.md");
    writeFileSync(lateMappingPath, "---\n\nBody\n\nEdit: text\n");
    const lateMapping = runCli(fixture, [
      "reddit", "draft", "--from", lateMappingPath,
      "--subreddit", "test", "--title", "Title", "--dry-run",
    ]);
    assert.equal(lateMapping.status, 0, output(lateMapping));
    assert.match(lateMapping.stdout, /---\n\nBody\n\nEdit: text/);
    assert.doesNotMatch(lateMapping.stdout, /PLATFORM_IMPORT_BLOCKED/);

    const offsetPath = join(fixture.dir, "reddit-code-offset.md");
    writeFileSync(
      offsetPath,
      "\ufeff---\rsubreddit: test\r---\r# Title\r\r```js\rrun()\r```\r",
    );
    const offset = runCli(fixture, ["reddit", "draft", "--from", offsetPath, "--dry-run"]);
    assert.equal(offset.status, 0, output(offset));
    assert.match(offset.stdout, /\[js\] line 6: run\(\)/);
    assert.doesNotMatch(offset.stdout, /\[js\] line 3:/);

    for (const [name, content, evidence] of [
      ["malformed", "---\nsubreddit: test\ntitle: [broken\n---\nBody\n", /frontmatter is malformed YAML/],
      ["unterminated", "---\rsubreddit: test\rtitle: Hidden\rBody\r", /no closing --- delimiter/],
      ["unknown", "---\nsubreddit: test\ntitle: Title\nowner: operator\n---\nBody\n", /unsupported Reddit frontmatter key\(s\): owner/],
      ["flag-only", "---\nsubreddit: test\ntitle: Title\nnsfw: true\n---\nBody\n", /frontmatter cannot set nsfw.*--nsfw and --spoiler flags/s],
      ["wrong-type", "---\nsubreddit: test\ntitle: 42\n---\nBody\n", /frontmatter title must be a string/],
    ] as const) {
      const badPath = join(fixture.dir, `reddit-${name}.md`);
      writeFileSync(badPath, content);
      for (const dryRun of [false, true]) {
        const invalid = runCli(fixture, [
          "reddit", "draft", "--from", badPath, ...(dryRun ? ["--dry-run"] : []),
        ]);
        assert.equal(invalid.status, 2, output(invalid));
        assert.match(output(invalid), evidence);
        assert.doesNotMatch(output(invalid), /PLATFORM_IMPORT_BLOCKED/);
      }
    }

    for (const source of [
      "---\n- ordinary\n- list\n---\nBody\n",
      "---\nKey:value prose\n---\nBody\n",
    ]) {
      const thematic = runCli(fixture, [
        "reddit", "draft", "--subreddit", "test", "--title", "Title",
        "--text", source, "--dry-run",
      ]);
      assert.equal(thematic.status, 0, output(thematic));
      assert.match(thematic.stdout, /---/);
      assert.match(thematic.stdout, /Body/);
    }

    const scalarPath = join(fixture.dir, "reddit-scalar.md");
    const scalarSource = "\ufeff---\nfalse\n---\nScalar body\n";
    writeFileSync(scalarPath, scalarSource);
    const scalar = runCli(fixture, [
      "reddit", "draft", "--from", scalarPath,
      "--subreddit", "test", "--title", "Title", "--dry-run",
    ]);
    assert.equal(scalar.status, 0, output(scalar));
    assert.match(scalar.stdout, /---\nfalse\n---\nScalar body/);
    assert.doesNotMatch(scalar.stdout, /\ufeff/);

    for (const [name, source, evidence] of [
      ["sequence", "---\n- ordinary\n- list\n---\nSequence body\n", /---\n- ordinary\n- list\n---\nSequence body/],
      ["colon-scalar", "---\nKey:value prose\n---\nColon body\n", /---\nKey:value prose\n---\nColon body/],
    ] as const) {
      const ambiguousPath = join(fixture.dir, `reddit-${name}.md`);
      writeFileSync(ambiguousPath, source);
      const ambiguous = runCli(fixture, [
        "reddit", "draft", "--from", ambiguousPath,
        "--subreddit", "test", "--title", "Title", "--dry-run",
      ]);
      assert.equal(ambiguous.status, 0, output(ambiguous));
      assert.match(ambiguous.stdout, evidence);
    }

    const literalMapping = runCli(fixture, [
      "reddit", "draft", "--subreddit", "flag-sub", "--title", "Flag title", "--text",
      "---\nsubreddit: literal-sub\ntitle: Literal title\n---\nLiteral body\n", "--dry-run",
    ]);
    assert.equal(literalMapping.status, 0, output(literalMapping));
    assert.match(literalMapping.stdout, /---\nsubreddit: literal-sub\ntitle: Literal title\n---\nLiteral body/);
    assert.match(literalMapping.stdout, /subreddit: r\/flag-sub/);

    const guidance = runCli(fixture, [
      "reddit", "draft", "--subreddit", "test", "--title", "Formatting", "--text",
      "```ts\nrun()\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![shot](shot.png)",
      "--dry-run",
    ]);
    assert.equal(guidance.status, 0, output(guidance));
    assert.match(guidance.stdout, /4-space-indented code/);
    assert.match(guidance.stdout, /tables render through old and new Reddit parsers/i);
    assert.match(guidance.stdout, /does not upload inline body images/);
    assert.doesNotMatch(output(guidance), /PLATFORM_IMPORT_BLOCKED/);

    const guidanceControls = runCli(fixture, [
      "reddit", "draft", "--subreddit", "test", "--title", "Controls", "--text",
      "    ```ts\n    literal fence text\n    ```\n\nnot a header\n\n--- | ---\n\n    ![code](no.png)",
      "--dry-run",
    ]);
    assert.equal(guidanceControls.status, 0, output(guidanceControls));
    assert.doesNotMatch(guidanceControls.stdout, /old\.reddit won't render fenced code/);
    assert.doesNotMatch(guidanceControls.stdout, /tables render through old and new Reddit parsers/i);
    assert.doesNotMatch(guidanceControls.stdout, /does not upload inline body images/);

    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("invalid file-backed X text writes no artifact and LinkedIn reports media in caller order", () => {
  const fixture = createFixture();
  try {
    const xPath = join(fixture.dir, "too-long.md");
    writeFileSync(xPath, "a".repeat(281));
    const invalidX = runCli(fixture, [
      "x", "draft", "--format", "tweet", "--from", xPath, "--dry-run",
    ]);
    assert.equal(invalidX.status, 2, output(invalidX));
    assert.equal(existsSync(join(fixture.dir, "too-long.x-tweet.txt")), false);

    const first = join(fixture.dir, "first.png");
    const second = join(fixture.dir, "second.gif");
    writeFileSync(first, png(1200, 800));
    writeFileSync(second, gif(640, 640));
    const linkedin = runCli(fixture, [
      "linkedin", "draft", "--text", "Post body", "--media", first,
      "--media", second, "--dry-run",
    ]);
    assert.equal(linkedin.status, 0, output(linkedin));
    const firstIndex = linkedin.stdout.indexOf(`1. ${first}`);
    const secondIndex = linkedin.stdout.indexOf(`2. ${second}`);
    assert.ok(firstIndex >= 0 && secondIndex > firstIndex, linkedin.stdout);
    assert.match(linkedin.stdout, /image\/png; 1200x800; 24 bytes; aspect 1\.5000/);
    assert.match(linkedin.stdout, /image\/gif; 640x640; 10 bytes; aspect 1\.0000/);
    assert.match(linkedin.stdout, /server-authoritative\/unverified: maximum_count.*maximum_pixels/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

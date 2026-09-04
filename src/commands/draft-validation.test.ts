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
import {
  generateContent,
  parseArticleBlocks,
  renderXArtifactInspection,
} from "../x/content.js";
import { generateArticle } from "../wechat/content.js";

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
      "/node_modules/better-sqlite3/",
    ])};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (blocked.some((needle) => resolved.url.includes(needle))) {
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
  options: { cwd?: string; dataDir?: string; repoDir?: string; wechatAuthor?: string } = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", fixture.loaderPath, CLI_PATH, ...args], {
    encoding: "utf8",
    input,
    cwd: options.cwd,
    env: {
      ...process.env,
      PUBLISH_DATA_DIR: options.dataDir ?? fixture.dataDir,
      PUBLISH_DATA_REPO: options.repoDir ?? fixture.repoDir,
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
          "linkedin", "draft", "--text",
          "Before <span>[fake](https://inside.example)</span> after",
        ],
        evidence: /parser-confirmed raw HTML.*no browser was touched/s,
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

test("invalid X reply targets are zero-state before content, ledger, or platform access", () => {
  const fixture = createFixture();
  const recoveryFlag = "--recover-stale-reservation-after-confirming-no-draft";
  const invalidTargets = [
    "invoice-1234567890-reference",
    "0000012345",
    " 12345",
    "http://x.com/user/status/12345",
    "https://www.x.com/user/status/12345",
    "https://x.com.evil.example/user/status/12345",
    "https://user:s3cr3t@x.com/user/status/12345",
    "https://x.com:443/user/status/12345",
    "https://%78.com/user/status/12345",
    "https://x\u3002com/user/status/12345",
    "https://x.com/user/STATUS/12345",
    "https://x.com/a/../user/status/12345",
    "https://x.com\\user/status/12345",
    "https://x.com/user/status%2f12345",
    "https://x.com/user/status/12345/extra",
    "https://x.com/not-a-status?next=/user/status/12345",
  ];

  try {
    for (const [index, target] of invalidTargets.entries()) {
      for (const mode of ["real", "dry-run", "recovery"] as const) {
        const dataDir = join(fixture.dir, `invalid-target-${index}-${mode}-data`);
        const repoDir = join(fixture.dir, `invalid-target-${index}-${mode}-repo`);
        const args = mode === "recovery"
          ? ["x", "reply", "--to", target, recoveryFlag]
          : [
            "x", "reply", "--to", target, "--text", "reply body",
            ...(mode === "dry-run" ? ["--dry-run"] : []),
          ];
        const result = runCli(fixture, args, undefined, { dataDir, repoDir });

        assert.equal(result.status, 2, `${mode}: ${target}\n${output(result)}`);
        assert.equal(result.signal, null, `${mode}: ${target}\n${output(result)}`);
        assert.match(output(result), /Invalid --to: Expected \[1-9\]\[0-9\]\{4,24\}/);
        assert.doesNotMatch(output(result), /PLATFORM_IMPORT_BLOCKED|s3cr3t/);
        assert.ok(output(result).length < 4_000, `${mode}: unbounded error output`);
        assert.equal(existsSync(dataDir), false, `${mode}: data dir was created`);
        assert.equal(existsSync(repoDir), false, `${mode}: data repo was created`);
      }
    }

    const absentSource = join(fixture.dir, "must-not-be-read.md");
    const dataDir = join(fixture.dir, "invalid-target-missing-source-data");
    const repoDir = join(fixture.dir, "invalid-target-missing-source-repo");
    const beforeContent = runCli(
      fixture,
      ["x", "reply", "--to", "https://example.com/user/status/12345", "--from", absentSource],
      undefined,
      { dataDir, repoDir },
    );
    assert.equal(beforeContent.status, 2, output(beforeContent));
    assert.match(output(beforeContent), /Invalid --to:/);
    assert.doesNotMatch(output(beforeContent), /ENOENT|must-not-be-read|PLATFORM_IMPORT_BLOCKED/);
    assert.equal(existsSync(dataDir), false);
    assert.equal(existsSync(repoDir), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("valid X reply dry-runs render tweet and lossless thread previews without runtime state", () => {
  const fixture = createFixture();
  try {
    const unverifiedTargetId = "9999999999999999999";
    const threadMarkers = Array.from(
      { length: 18 },
      (_, index) => `lossless-segment-${String(index + 1).padStart(2, "0")}`,
    );
    const threadSource = threadMarkers
      .map((marker) => `${marker} carries distinct caller text through the reply preview.`)
      .join("\n\n");
    const cases = [
      {
        name: "tweet",
        args: [
          "x", "reply", "--to",
          `HTTPS://X.COM/Operator_1/status/${unverifiedTargetId}/?s=20#fragment`, "--text",
          "State-free single reply preview.", "--dry-run",
        ],
        format: /format: tweet/,
        markers: ["State-free single reply preview."],
      },
      {
        name: "thread",
        args: [
          "x", "reply", "--to", unverifiedTargetId, "--text",
          threadSource, "--dry-run", "--force", "--inspect",
        ],
        format: /format: thread/,
        markers: threadMarkers,
      },
    ];

    for (const testCase of cases) {
      const dataDir = join(fixture.dir, `${testCase.name}-absent-data`);
      const repoDir = join(fixture.dir, `${testCase.name}-absent-repo`);
      assert.equal(existsSync(dataDir), false);
      assert.equal(existsSync(repoDir), false);

      const result = runCli(fixture, testCase.args, undefined, { dataDir, repoDir });
      assert.equal(result.status, 0, output(result));
      assert.equal(result.signal, null, output(result));
      assert.equal(result.stderr, "");
      assert.match(result.stdout, new RegExp(`Replying to tweet ${unverifiedTargetId}:`));
      assert.match(result.stdout, testCase.format);
      assert.match(result.stdout, /mode: dry-run/);
      assert.match(result.stdout, /validation: local=passed; live=skipped/);
      assert.match(result.stdout, /platform touched: no/);
      assert.match(result.stdout, /terminal draft state: dry_run_validated/);
      assert.match(result.stdout, /Target syntax was validated locally/);
      assert.match(
        result.stdout,
        /target existence, visibility, and reply eligibility remain unverified/i,
      );
      assert.match(
        result.stdout,
        /X target checks, reply-ledger state, and native staging were intentionally skipped/,
      );
      assert.match(result.stdout, /--force never bypasses an in-flight or retained reservation/);
      assert.doesNotMatch(output(result), /PLATFORM_IMPORT_BLOCKED|Already staged/);
      for (const marker of testCase.markers) assert.match(result.stdout, new RegExp(marker));

      assert.equal(existsSync(dataDir), false, `${testCase.name}: data dir was created`);
      assert.equal(existsSync(repoDir), false, `${testCase.name}: data repo was created`);
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("X code-block fidelity is public for draft/reply input and invalid mappings stay zero-state", async () => {
  const fixture = createFixture();
  try {
    const inlineData = join(fixture.dir, "inline-code-absent-data");
    const inlineRepo = join(fixture.dir, "inline-code-absent-repo");
    const inlineRun = runCli(
      fixture,
      [
        "x", "draft", "--format", "tweet", "--text",
        "Visible\n```js\ninlineRun()\n```", "--dry-run",
      ],
      undefined,
      { dataDir: inlineData, repoDir: inlineRepo },
    );
    assert.equal(inlineRun.status, 0, output(inlineRun));
    assert.match(inlineRun.stdout, /Source lines 2-4 \(code_block\) were replaced/);
    assert.equal(existsSync(inlineData), false);
    assert.equal(existsSync(inlineRepo), false);

    const fileSource = join(fixture.dir, "code-fidelity.md");
    const fileArtifact = join(fixture.dir, "code-fidelity.x-tweet.txt");
    writeFileSync(
      fileSource,
      "\ufeff---\r\nprivate: ignored\r\n---\r\nVisible\r\n```ts label=demo\r\nrun()\r\n```\r\n",
    );
    const fileRun = runCli(
      fixture,
      ["x", "draft", "--format", "tweet", "--from", fileSource, "--dry-run"],
    );
    assert.equal(fileRun.status, 0, output(fileRun));
    assert.match(fileRun.stdout, /\[code block #1 → screenshot\]/);
    assert.match(fileRun.stdout, /Source lines 5-7 \(code_block\) were replaced/);
    assert.match(fileRun.stdout, /LF-normalized source sha256=[a-f0-9]{64}/);
    assert.doesNotMatch(fileRun.stdout, /private: ignored|PLATFORM_IMPORT_BLOCKED/);
    assert.equal(existsSync(fileArtifact), true);
    assert.match(readFileSync(fileArtifact, "utf8"), /Source lines 5-7 \(code_block\)/);

    const tildeFence = String.fromCharCode(126).repeat(3);
    const replySource =
      `${"reply-prefix ".repeat(30)}\r\n${tildeFence}python\r\nprint('reply')\r\n${tildeFence}\r\n` +
      "reply suffix ".repeat(15);
    const stdinData = join(fixture.dir, "reply-stdin-absent-data");
    const stdinRepo = join(fixture.dir, "reply-stdin-absent-repo");
    const stdinRun = runCli(
      fixture,
      ["x", "reply", "--to", "9999999999999999999", "--from", "-", "--dry-run"],
      `\ufeff---\r\nprivate: ignored\r\n---\r\n${replySource}`,
      { dataDir: stdinData, repoDir: stdinRepo },
    );
    assert.equal(stdinRun.status, 0, output(stdinRun));
    assert.match(stdinRun.stdout, /generated a \d+-post reply thread/);
    assert.match(stdinRun.stdout, /\[code block #1 → screenshot\]/);
    assert.match(stdinRun.stdout, /Source lines 5-7 \(code_block\) were replaced/);
    assert.match(stdinRun.stdout, /fence=tilde, closure=explicit/);
    assert.doesNotMatch(stdinRun.stdout, /private: ignored|PLATFORM_IMPORT_BLOCKED/);
    assert.equal(existsSync(stdinData), false);
    assert.equal(existsSync(stdinRepo), false);
    const expectedReplyThread = await generateContent(replySource, { format: "thread" });
    assert.equal(
      (expectedReplyThread.thread ?? [])
        .map((post) => post.text.replace(/ \d+\/\d+$/, ""))
        .join(""),
      `${"reply-prefix ".repeat(30)}\n[code block #1 → screenshot]\n${"reply suffix ".repeat(15).trimEnd()}`,
    );
    for (const post of expectedReplyThread.thread ?? []) {
      for (const line of post.text.split("\n")) {
        assert.ok(
          stdinRun.stdout.includes(`│ ${line}`),
          `reply dry-run omitted framed row ${post.index} line ${JSON.stringify(line)}`,
        );
      }
    }

    const invalidCases = [
      {
        name: "nested",
        content: "> quoted\n> ```js\n> hidden()\n> ```",
        evidence: /nested inside Markdown quote\/list structure/,
      },
      {
        name: "reserved-placeholder",
        content: "Caller literal [code block #9 → screenshot]",
        evidence: /reserved X code-block placeholder syntax/,
      },
    ];

    for (const testCase of invalidCases) {
      const invalidFile = join(fixture.dir, `${testCase.name}.md`);
      const invalidArtifact = join(fixture.dir, `${testCase.name}.x-thread.txt`);
      writeFileSync(invalidFile, testCase.content);
      for (const dryRun of [false, true]) {
        const suffix = `${testCase.name}-${dryRun ? "dry" : "real"}`;
        const dataDir = join(fixture.dir, `${suffix}-data`);
        const repoDir = join(fixture.dir, `${suffix}-repo`);
        const draft = runCli(
          fixture,
          [
            "x", "draft", "--format", "thread", "--from", invalidFile,
            ...(dryRun ? ["--dry-run"] : []),
          ],
          undefined,
          { dataDir, repoDir },
        );
        assert.equal(draft.status, 2, output(draft));
        assert.match(output(draft), testCase.evidence);
        assert.doesNotMatch(output(draft), /PLATFORM_IMPORT_BLOCKED|hidden\(\)/);
        assert.equal(existsSync(dataDir), false);
        assert.equal(existsSync(repoDir), false);
        assert.equal(existsSync(invalidArtifact), false);

        const replyData = join(fixture.dir, `${suffix}-reply-data`);
        const replyRepo = join(fixture.dir, `${suffix}-reply-repo`);
        const reply = runCli(
          fixture,
          [
            "x", "reply", "--to", "9999999999999999999", "--text", testCase.content,
            ...(dryRun ? ["--dry-run"] : []),
          ],
          undefined,
          { dataDir: replyData, repoDir: replyRepo },
        );
        assert.equal(reply.status, 2, output(reply));
        assert.match(output(reply), testCase.evidence);
        assert.doesNotMatch(output(reply), /PLATFORM_IMPORT_BLOCKED|hidden\(\)/);
        assert.equal(existsSync(replyData), false);
        assert.equal(existsSync(replyRepo), false);
      }
    }

    const draftHelp = runCli(fixture, ["x", "draft", "--help"]);
    const replyHelp = runCli(fixture, ["x", "reply", "--help"]);
    for (const help of [draftHelp, replyHelp]) {
      assert.equal(help.status, 0, output(help));
      assert.match(help.stdout, /parser-confirmed top-level backtick\/tilde fenced block/);
      assert.match(help.stdout, /\[code block #N → screenshot\] placeholder/);
      assert.match(
        help.stdout,
        /#1 counts as 29 twitter-text weighted characters normally and 28 Unicode code points with --long/,
      );
      assert.match(help.stdout, /caller transport prose matching the reserved \[code block #N → screenshot\] syntax exits 2 locally/);
      assert.match(help.stdout, /inside transformed code or an omitted heading do not collide/);
      assert.match(help.stdout, /inclusive original line range.*LF-normalized source SHA-256/s);
      assert.match(help.stdout, /closer needs the same marker at least as long plus only trailing spaces or tabs/);
      assert.match(help.stdout, /Mixed-marker pseudo-closers remain payload/);
      assert.match(help.stdout, /Parser exceptions, unmappable source-token boundaries, and parser-confirmed quote\/list-nested fences exit 2 locally with bounded evidence/);
      assert.match(help.stdout, /does not attach the required screenshot\/image/);
    }
    assert.match(draftHelp.stdout, /Article code-block handoff/);
    assert.match(draftHelp.stdout, /fence with 0–3 leading spaces may close explicitly or at end of input/);
    assert.match(draftHelp.stdout, /including trailing spaces and blank\/whitespace-only lines/);
    assert.match(draftHelp.stdout, /Every recognized top-level Article fenced block has one advisory/);
    assert.match(draftHelp.stdout, /excluded from the native rich-HTML paste/);
    assert.match(draftHelp.stdout, /verified and unverified handoff receipts/);
    assert.match(draftHelp.stdout, /separate \.x-article\.inspection\.txt receipt/);
    assert.match(draftHelp.stdout, /terminal-safe NFC info \(80 code points\) and deindented preview \(120 code points\)/);
    assert.match(draftHelp.stdout, /SHA-256 of the exact LF-normalized opener-through-closer source slice/);
    assert.match(draftHelp.stdout, /Terminal inspection replaces each excluded fence with its block number and digest/);
    assert.match(draftHelp.stdout, /link advisories carry block provenance.*512\/240 code points/s);
    assert.match(draftHelp.stdout, /More than 10000 code blocks or 1000000 UTF-16 code units/);
    assert.match(draftHelp.stdout, /Before loading the staging runtime, profile, or browser, the real Article path validates and freezes one closed title\/Markdown\/block\/run\/link\/code-count snapshot/);
    assert.match(draftHelp.stdout, /reparses canonical Markdown with the same Article parser and requires the complete code block\/advisory\/code-link sets to correspond/);
    assert.match(draftHelp.stdout, /unsafe-active-href Article structures exit 2 locally with save_not_attempted/);
    assert.match(draftHelp.stdout, /runtime and native Save\/autosave failures retain exit 1 semantics/);
    assert.match(draftHelp.stdout, /format cannot be classified safely, the local exit-2 failure is a typed generic save_not_attempted boundary and names no Article or composer save mechanism/);
    assert.match(draftHelp.stdout, /supported percent bytes remain exact and are not decoded by safety validation/);
    assert.match(draftHelp.stdout, /URL-looking advisories from excluded code are bounded but never become active anchors/);
    assert.match(draftHelp.stdout, /publish x info.*owned Article Markdown support matrix and stop conditions/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("X Article fidelity rejects locally before artifacts, runtime imports, profiles, or state", () => {
  const fixture = createFixture();
  try {
    const validPath = join(fixture.dir, "article-correspondence.md");
    const validCanonical = [
      "# Native Title",
      "",
      "# First body heading",
      "",
      "## Second body heading",
      "",
      "Body.",
    ].join("\n");
    writeFileSync(
      validPath,
      `\ufeff---\r\nprivate: artifact-canary\r\n---\r\n${validCanonical.replace(/\n/gu, "\r\n")}`,
    );
    const valid = runCli(fixture, [
      "x", "draft", "--format", "article", "--from", validPath, "--dry-run",
    ]);
    assert.equal(valid.status, 0, output(valid));
    assert.doesNotMatch(output(valid), /artifact-canary|PLATFORM_IMPORT_BLOCKED/);
    assert.equal(
      readFileSync(join(fixture.dir, "article-correspondence.x-article.md"), "utf8"),
      validCanonical,
    );
    assert.match(valid.stdout, /article: Native Title/);
    assert.match(valid.stdout, /# First body heading/);
    assert.match(valid.stdout, /## Second body heading/);

    const invalidFiles = [
      {
        name: "setext-title",
        source: "Title\n=====\nRAW_PRIVATE_CANARY",
        evidence: /Setext underline/,
      },
      {
        name: "nested-fence",
        source: "# Title\n\n> before\n> ```js\n> RAW_PRIVATE_CANARY\n> ```",
        evidence: /quote\/list-nested fenced block/,
      },
      {
        name: "body-image",
        source: "# Title\n\n![RAW_PRIVATE_CANARY](body.png)",
        evidence: /unsupported image inline/,
      },
      {
        name: "inline-code",
        source: "# Title\n\n`RAW_PRIVATE_CANARY`",
        evidence: /unsupported inline_code inline/,
      },
      {
        name: "double-bom",
        source: "\ufeff\ufeff# RAW_PRIVATE_CANARY\nBody",
        evidence: /edge characters the native title field cannot preserve/,
      },
      {
        name: "nul-body",
        source: "# Title\n\na\0RAW_PRIVATE_CANARY",
        evidence: /U\+0000 at source line 3.*cannot preserve exactly/s,
      },
      {
        name: "heading-unicode-edge",
        source: "# Title\n\n## RAW_PRIVATE_CANARY\u00a0",
        evidence: /body heading at source line 3 has edge characters.*cannot preserve exactly/s,
      },
      {
        name: "paragraph-tab-blank",
        source: "# Title\n\nAlpha\n \t\nRAW_PRIVATE_CANARY",
        evidence: /spaces\/tabs-only line swallowed into a paragraph at source line 4/,
      },
      {
        name: "list-tab",
        source: "# Title\n\n- RAW_PRIVATE_CANARY\titem",
        evidence: /list source contains a tab at source line 3.*can expand before native staging/s,
      },
      {
        name: "list-unicode-edge",
        source: "# Title\n\n- RAW_PRIVATE_CANARY\u2029",
        evidence: /list source at line 3 has a parser-trimmed Unicode edge or continuation/s,
      },
      {
        name: "list-unicode-continuation",
        source: "# Title\n\n- first\n \u2029\n- RAW_PRIVATE_CANARY",
        evidence: /list source at line 4 has a parser-trimmed Unicode edge or continuation/s,
      },
      {
        name: "link-source-edge",
        source: "# Title\n\n[RAW_PRIVATE_CANARY](https://example.com/path\u00a0)",
        evidence: /source-normalized active link at source line 3/,
      },
      {
        name: "link-source-escape",
        source: "# Title\n\n[RAW_PRIVATE_CANARY](https://example.com/a\\_b)",
        evidence: /source-normalized active link at source line 3/,
      },
    ];

    for (const fixtureCase of invalidFiles) {
      const sourcePath = join(fixture.dir, `${fixtureCase.name}.md`);
      const markdownArtifact = join(fixture.dir, `${fixtureCase.name}.x-article.md`);
      const inspectionArtifact = join(
        fixture.dir,
        `${fixtureCase.name}.x-article.inspection.txt`,
      );
      writeFileSync(sourcePath, fixtureCase.source);
      writeFileSync(markdownArtifact, "UNCHANGED_MARKDOWN_SENTINEL");
      writeFileSync(inspectionArtifact, "UNCHANGED_INSPECTION_SENTINEL");

      for (const dryRun of [false, true]) {
        const mode = dryRun ? "dry" : "real";
        const dataDir = join(fixture.dir, `${fixtureCase.name}-${mode}-data`);
        const repoDir = join(fixture.dir, `${fixtureCase.name}-${mode}-repo`);
        const result = runCli(
          fixture,
          [
            "x", "draft", "--format", "article", "--from", sourcePath,
            ...(dryRun ? ["--dry-run"] : []),
          ],
          undefined,
          { dataDir, repoDir },
        );
        assert.equal(result.status, 2, `${fixtureCase.name}/${mode}: ${output(result)}`);
        assert.equal(result.signal, null);
        assert.match(output(result), fixtureCase.evidence);
        assert.doesNotMatch(output(result), /RAW_PRIVATE_CANARY|PLATFORM_IMPORT_BLOCKED/);
        assert.ok(output(result).length < 4_000);
        assert.equal(existsSync(dataDir), false);
        assert.equal(existsSync(repoDir), false);
        assert.equal(readFileSync(markdownArtifact, "utf8"), "UNCHANGED_MARKDOWN_SENTINEL");
        assert.equal(readFileSync(inspectionArtifact, "utf8"), "UNCHANGED_INSPECTION_SENTINEL");
      }
    }

    for (const [name, stdin, evidence] of [
      [
        "unsafe-link",
        "---\r\nprivate: RAW_PRIVATE_CANARY\r\n---\r\n# Title\r\n\r\n[x](https://user:secret@example.com/path)",
        /unsafe or unsupported active link at source line 6/,
      ],
      [
        "later-inline",
        "---\nprivate: RAW_PRIVATE_CANARY\n---\n# Title\n\nVisible\n&amp;",
        /entity_like_text inline at source line 7/,
      ],
      [
        "source-normalized-link",
        "---\nprivate: RAW_PRIVATE_CANARY\n---\n# Title\n\n[x](https://example.com/path\u00a0)",
        /source-normalized active link at source line 6/,
      ],
      [
        "list-unicode-continuation",
        "---\nprivate: hidden\n---\n# Title\n\n- first\n \u00a0\n- RAW_PRIVATE_CANARY",
        /list source at line 7 has a parser-trimmed Unicode edge or continuation/,
      ],
      [
        "paragraph-tab-blank",
        "---\rprivate: hidden\r---\r# Title\r\rAlpha\r\t \rRAW_PRIVATE_CANARY",
        /spaces\/tabs-only line swallowed into a paragraph at source line 7/,
      ],
    ] as const) {
      for (const dryRun of [false, true]) {
        const mode = dryRun ? "dry" : "real";
        const dataDir = join(fixture.dir, `${name}-${mode}-data`);
        const repoDir = join(fixture.dir, `${name}-${mode}-repo`);
        const result = runCli(
          fixture,
          [
            "x", "draft", "--format", "article", "--from", "-",
            ...(dryRun ? ["--dry-run"] : []),
          ],
          stdin,
          { dataDir, repoDir },
        );
        assert.equal(result.status, 2, `${name}/${mode}: ${output(result)}`);
        assert.match(output(result), evidence);
        assert.doesNotMatch(output(result), /RAW_PRIVATE_CANARY|user:secret|PLATFORM_IMPORT_BLOCKED/);
        assert.ok(output(result).length < 4_000);
        assert.equal(existsSync(dataDir), false);
        assert.equal(existsSync(repoDir), false);
      }
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("X Article EOF fences stay exact in clean file artifacts and mapped stdin inspection", () => {
  const fixture = createFixture();
  try {
    for (const [index, newline] of ["\n", "\r\n", "\r"].entries()) {
      const sourcePath = join(fixture.dir, `article-eof-${index}.md`);
      const markdownPath = join(fixture.dir, `article-eof-${index}.x-article.md`);
      const inspectionPath = join(
        fixture.dir,
        `article-eof-${index}.x-article.inspection.txt`,
      );
      const cleanLines = [
        `# EOF artifact ${index}`,
        "",
        "Visible body.",
        "",
        `${" ".repeat(index)}${index % 2 === 0 ? "```txt" : "~~~ txt"}`,
        `${" ".repeat(index)}payload with trailing spaces  `,
        " ".repeat(index + 2),
      ];
      const cleanSource = cleanLines.join(newline);
      writeFileSync(
        sourcePath,
        `\ufeff---${newline}private: artifact-secret-${index}${newline}---${newline}${cleanSource}`,
      );

      const result = runCli(fixture, [
        "x", "draft", "--format", "article", "--from", sourcePath, "--dry-run",
      ]);
      assert.equal(result.status, 0, output(result));
      assert.match(result.stdout, /native rich-HTML excluded code blocks: 1/);
      assert.match(result.stdout, /CODE BLOCKS.*CODE BLOCK #1 excluded.*sourceLines=8-10/s);
      assert.match(result.stdout, /LF-normalized exact fence source sha256=[a-f0-9]{64}/);
      assert.match(result.stdout, /Clean content written to/);
      assert.match(result.stdout, /Inspection receipt written to/);
      assert.doesNotMatch(output(result), /artifact-secret|PLATFORM_IMPORT_BLOCKED/);

      const cleanArtifact = readFileSync(markdownPath, "utf8");
      assert.equal(cleanArtifact, cleanSource.replace(/\r\n?/g, "\n"));
      assert.doesNotMatch(cleanArtifact, /ARTICLE NATIVE|CODE BLOCK #|<!--|-->/);
      const reparsedCode = parseArticleBlocks(cleanArtifact)
        .filter((block) => block.kind === "code");
      assert.deepEqual(reparsedCode, [{
        kind: "code",
        index: 1,
        lang: "txt",
        text: "payload with trailing spaces  \n  ",
      }]);

      const inspection = readFileSync(inspectionPath, "utf8");
      assert.match(inspection, /^ARTICLE NATIVE RICH-HTML EXCLUDED CODE BLOCK COUNT: 1$/m);
      assert.match(inspection, /CODE BLOCK #1 excluded.*sourceLines=8-10/);
      assert.match(inspection, /closure=end_of_input.*sourceTerminalNewline=false/);
      assert.match(inspection, /LF-normalized exact fence source sha256=[a-f0-9]{64}/);
      assert.doesNotMatch(inspection, /artifact-secret|PLATFORM_IMPORT_BLOCKED/);
      assert.deepEqual(
        readdirSync(fixture.dir).filter((name) =>
          name.startsWith(`article-eof-${index}.x-article`)
        ).sort(),
        [
          `article-eof-${index}.x-article.inspection.txt`,
          `article-eof-${index}.x-article.md`,
        ],
      );
    }

    const stdinData = join(fixture.dir, "article-eof-stdin-data");
    const stdinRepo = join(fixture.dir, "article-eof-stdin-repo");
    const articleTildeFence = String.fromCharCode(126).repeat(3);
    const stdin = runCli(
      fixture,
      ["x", "draft", "--format", "article", "--from", "-", "--dry-run"],
      `---\rprivate: stdin-artifact-secret\r---\r# Stdin EOF\r\r${articleTildeFence}js\rline()  \r  `,
      { dataDir: stdinData, repoDir: stdinRepo },
    );
    assert.equal(stdin.status, 0, output(stdin));
    assert.match(stdin.stdout, /native rich-HTML excluded code blocks: 1/);
    assert.match(stdin.stdout, /CODE BLOCKS.*CODE BLOCK #1 excluded.*sourceLines=6-8/s);
    assert.match(stdin.stdout, /preview="line\(\)".*truncated=false/);
    assert.doesNotMatch(stdin.stdout, /line\(\)  \n  /);
    assert.match(stdin.stdout, /No base file — content printed above, no artifact written/);
    assert.doesNotMatch(output(stdin), /stdin-artifact-secret|PLATFORM_IMPORT_BLOCKED/);
    assert.equal(existsSync(stdinData), false);
    assert.equal(existsSync(stdinRepo), false);
    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("X Article dry-run keeps canonical code exact but emits only bounded safe shared evidence", () => {
  const fixture = createFixture();
  try {
    const info =
      `tag\u0007\u009b\u001b\u061c\u2066\u2069\ufeff\u2028\u2029${"i".repeat(30)}` +
      "INFO_ARTIFACT_HIDDEN";
    const preview =
      `value\u0001\u200f\u202a\u202c\u202e\u2029${"p".repeat(90)}` +
      "PREVIEW_ARTIFACT_HIDDEN";
    const canonical = [
      "# Safe dry-run",
      "",
      "Visible [outside](https://outside.example/exact).",
      "",
      `\`\`\`${info}`,
      preview,
      "[code](https://code.example/exact)",
      "RAW_SECOND_CODE_LINE_CANARY",
      "```",
    ].join("\n");
    const sourcePath = join(fixture.dir, "article-safe-advisory.md");
    const markdownPath = join(fixture.dir, "article-safe-advisory.x-article.md");
    const inspectionPath = join(
      fixture.dir,
      "article-safe-advisory.x-article.inspection.txt",
    );
    writeFileSync(
      sourcePath,
      `---\r\nprivate: FRONTMATTER_PRIVATE_CANARY\r\n---\r\n${canonical.replace(/\n/gu, "\r\n")}`,
    );

    const result = runCli(fixture, [
      "x", "draft", "--format", "article", "--from", sourcePath, "--dry-run",
    ]);
    assert.equal(result.status, 0, output(result));
    const inspection = readFileSync(inspectionPath, "utf8");
    assert.match(
      inspection,
      /^LINK https:\/\/outside\.example\/exact \(outside\) — Links cost reach — keep this OUT of the opening tweet; move it to a reply or the end of the thread\.$/m,
    );
    assert.match(
      inspection,
      /^  CODE LINK ADVISORY block=1, url="https:\/\/code\.example\/exact" \(truncated=false\), text="code" \(truncated=false\): URL-looking text came from Article code excluded from native rich HTML; this is inert advisory evidence, not an active link\.$/m,
    );
    assert.doesNotMatch(inspection, /^LINK https:\/\/code\.example\/exact/m);
    const terminalOutput = `${result.stdout}\n${result.stderr}\n${inspection}`;
    assert.match(terminalOutput, /info=.*truncated=true/);
    assert.match(terminalOutput, /preview=.*truncated=true/);
    for (const escape of [
      "\\u{07}", "\\u{9b}", "\\u{1b}", "\\u{61c}", "\\u{2066}",
      "\\u{2069}", "\\u{feff}", "\\u{2028}", "\\u{2029}", "\\u{01}",
      "\\u{200f}", "\\u{202a}", "\\u{202c}", "\\u{202e}",
    ]) assert.ok(terminalOutput.includes(escape), escape);
    const stdoutDigest = result.stdout.match(/sha256=([a-f0-9]{64})/)?.[1];
    const receiptDigest = inspection.match(/sha256=([a-f0-9]{64})/)?.[1];
    assert.ok(stdoutDigest);
    assert.equal(receiptDigest, stdoutDigest);
    assert.doesNotMatch(
      terminalOutput,
      /INFO_ARTIFACT_HIDDEN|PREVIEW_ARTIFACT_HIDDEN|RAW_SECOND_CODE_LINE_CANARY|FRONTMATTER_PRIVATE_CANARY|[\u0001\u0007\u009b\u001b\u061c\u200f\u2028\u2029\u202a\u202c\u202e\u2066\u2069\ufeff]|PLATFORM_IMPORT_BLOCKED/u,
    );
    assert.equal(readFileSync(markdownPath, "utf8"), canonical);
    assert.match(readFileSync(markdownPath, "utf8"), /RAW_SECOND_CODE_LINE_CANARY/);
    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("X Article copied-text overflow rejects before dry-run artifacts or runtime imports", () => {
  const fixture = createFixture();
  try {
    const sourcePath = join(fixture.dir, "article-copied-text-overflow.md");
    const markdownPath = join(
      fixture.dir,
      "article-copied-text-overflow.x-article.md",
    );
    const inspectionPath = join(
      fixture.dir,
      "article-copied-text-overflow.x-article.inspection.txt",
    );
    const source = "# T\n" + Array.from(
      { length: 10 },
      () => `\n\`\`\`\n${"a".repeat(999_934)}\n\`\`\`\n`,
    ).join("");
    writeFileSync(sourcePath, source);

    const result = runCli(fixture, [
      "x", "draft", "--format", "article", "--from", sourcePath, "--dry-run",
    ]);
    assert.equal(result.status, 2, output(result));
    assert.match(output(result), /structured text exceeds the local aggregate bound/i);
    assert.doesNotMatch(output(result), /PLATFORM_IMPORT_BLOCKED/);
    assert.equal(existsSync(markdownPath), false);
    assert.equal(existsSync(inspectionPath), false);
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
    );
    assert.equal(fileReply.status, 0, output(fileReply));
    assert.match(fileReply.stdout, /Visible file reply/);
    assert.doesNotMatch(output(fileReply), /reply-file-secret|private:|PLATFORM_IMPORT_BLOCKED/);

    const stdinReply = runCli(
      fixture,
      ["x", "reply", "--to", "12345", "--from", "-", "--dry-run"],
      "---\r\n---\r\nVisible stdin reply",
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
    );
    assert.equal(fileReplyThread.status, 0, output(fileReplyThread));
    assert.match(fileReplyThread.stdout, /generated a [2-9][0-9]*-post reply thread without truncating the normalized reply prose/);
    assert.doesNotMatch(output(fileReplyThread), /reply-thread-file-secret|private:|PLATFORM_IMPORT_BLOCKED/);

    const stdinReplyThread = runCli(
      fixture,
      ["x", "reply", "--to", "12345", "--from", "-", "--dry-run"],
      `---\nprivate: reply-thread-stdin-secret\n---\n${replyThreadBody}`,
    );
    assert.equal(stdinReplyThread.status, 0, output(stdinReplyThread));
    assert.match(stdinReplyThread.stdout, /generated a [2-9][0-9]*-post reply thread without truncating the normalized reply prose/);
    assert.doesNotMatch(output(stdinReplyThread), /reply-thread-stdin-secret|private:|PLATFORM_IMPORT_BLOCKED/);

    const emptyMap = runCli(
      fixture,
      ["x", "draft", "--format", "tweet", "--from", "-", "--dry-run"],
      "---\n{}\n---\nEmpty-map body",
    );
    assert.equal(emptyMap.status, 0, output(emptyMap));
    assert.match(emptyMap.stdout, /Empty-map body/);

    for (const [name, source, evidence] of [
      ["scalar", "\ufeff---\rfalse\r---\rScalar body", /│ ---\n│ false\n│ ---\n│ Scalar body/],
      ["sequence", "\ufeff---\r\n- first\r\n- second\r\n---\r\nSequence body", /│ ---\n│ - first\n│ - second\n│ ---\n│ Sequence body/],
      ["thematic", "\ufeff---\n\nA thematic section\n\n---\n\nMore prose", /│ ---\n│ \n│ A thematic section\n│ \n│ ---\n│ \n│ More prose/],
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
    assert.match(literal.stdout, /│ ---\n│ title: Literal inline content\n│ ---\n│ Inline body/);

    const literalThreadSource =
      "---\ntitle: Literal inline thread\n---\n" +
      `${"Inline thread body.\n\n".repeat(20)}tail`;
    const literalThread = runCli(fixture, [
      "x", "draft", "--format", "thread", "--text", literalThreadSource, "--dry-run",
    ]);
    assert.equal(literalThread.status, 0, output(literalThread));
    assert.match(literalThread.stdout, /│ ---\n│ title: Literal inline thread\n│ ---/);
    assert.doesNotMatch(output(literalThread), /PLATFORM_IMPORT_BLOCKED/);

    const literalReply = runCli(
      fixture,
      [
        "x", "reply", "--to", "12345", "--text",
        "---\ntitle: Literal inline reply\n---\nReply body", "--dry-run",
      ],
      undefined,
    );
    assert.equal(literalReply.status, 0, output(literalReply));
    assert.match(literalReply.stdout, /│ ---\n│ title: Literal inline reply\n│ ---\n│ Reply body/);
    assert.doesNotMatch(output(literalReply), /PLATFORM_IMPORT_BLOCKED/);

    const weighted = runCli(
      fixture,
      ["x", "draft", "--format", "tweet", "--from", "-", "--dry-run"],
      `---\nignored: ${"z".repeat(600)}\n---\n${"汉".repeat(140)}`,
    );
    assert.equal(weighted.status, 0, output(weighted));
    assert.match(weighted.stdout, /\[280 twitter-text weighted chars\]/);
    assert.doesNotMatch(output(weighted), /ignored:|PLATFORM_IMPORT_BLOCKED/);
    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
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
        assert.doesNotMatch(output(invalid), /^format:/m);
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
        assert.doesNotMatch(output(invalid), /^format:/m);
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
      /workflow-secret|Visible body|^format:|PLATFORM_IMPORT_BLOCKED/m,
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
      "x-malformed.x-article.inspection.txt",
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
    assert.match(
      referenceLink.stdout,
      /Read the docs \(https:\/\/example\.com\/docs\)\./,
    );
    assert.match(referenceLink.stdout, /https:\/\/example\.com\/docs \(the docs\)/);
    assert.match(referenceLink.stdout, /FIRST COMMENT/);
    assert.doesNotMatch(referenceLink.stdout, /\[the docs\]\[ref\]|\[ref\]:/);
    assert.doesNotMatch(output(referenceLink), /PLATFORM_IMPORT_BLOCKED/);

    const autolink = runCli(fixture, [
      "linkedin", "draft", "--text",
      "Open <https://example.com/path?q=1&x=2>.", "--dry-run",
    ]);
    assert.equal(autolink.status, 0, output(autolink));
    assert.match(autolink.stdout, /Open https:\/\/example\.com\/path\?q=1&x=2\./);
    assert.doesNotMatch(autolink.stdout, /https:\/\/example\.com\/path\?q=1&x=2>/);
    assert.doesNotMatch(output(autolink), /PLATFORM_IMPORT_BLOCKED/);

    const linkedinHelp = runCli(fixture, ["linkedin", "draft", "--help"]);
    assert.equal(linkedinHelp.status, 0, output(linkedinHelp));
    assert.match(linkedinHelp.stdout, /leading --- is literal/);
    assert.match(linkedinHelp.stdout, /Markdown images never attach files/);
    assert.match(linkedinHelp.stdout, /One deterministic CommonMark\/GFM parse owns plain text and evidence/);
    assert.match(linkedinHelp.stdout, /full\/collapsed\/shortcut reference, bare, and autolinks/);
    assert.match(linkedinHelp.stdout, /character references decode\s+once/);
    assert.match(linkedinHelp.stdout, /Parser-confirmed raw HTML exits 2 before profile\/browser access/);
    assert.match(linkedinHelp.stdout, /Only a returned Save as draft action followed by a full intended-text match/);
    assert.match(linkedinHelp.stdout, /rejected Save click has unknown\s+delivery/);
    assert.match(linkedinHelp.stdout, /Both uncertain states exit 1 because a native draft may exist/);
    assert.match(linkedinHelp.stdout, /open feed\/\?shareActive=true in the exact same CLI-owned LinkedIn profile/);
    assert.match(linkedinHelp.stdout, /choose Start a post on the feed/);
    assert.match(linkedinHelp.stdout, /--inspect is secondary diagnosis after comparison and cannot prove absence/);
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
    assert.match(wechatInspection.stdout, /Server-authoritative title, digest, image quota, and draft acceptance constraints remain unverified/);
    assert.doesNotMatch(output(wechatInspection), /PLATFORM_IMPORT_BLOCKED/);
    assert.deepEqual(readdirSync(fixture.dataDir), []);
    assert.deepEqual(readdirSync(fixture.repoDir), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("local artifact write failures stay bounded and content-free before platform access", async () => {
  const fixture = createFixture();
  const rawForgedReceipt = "\n✓ Staged a FORGED draft";
  const hostileDir = join(
    fixture.dir,
    `write-\u001b]0;owned\u0007${rawForgedReceipt}`,
  );
  const assertSafeFailure = (
    result: SpawnSyncReturns<string>,
    expectedCode: RegExp,
  ): void => {
    const combined = output(result);
    assert.equal(result.status, 1, combined);
    assert.equal(result.signal, null, combined);
    assert.match(result.stderr, /Transport receipt \(publish\.transport-receipt\/v1\)/);
    assert.match(result.stderr, /platform touched: no/);
    assert.match(result.stderr, /published: false/);
    assert.match(result.stderr, /exit: runtime_or_platform_failure \(1\)/);
    assert.match(result.stderr, /residue: artifact/);
    assert.match(result.stderr, expectedCode);
    assert.ok(result.stderr.length < 4_000, "write failure receipt must stay bounded");
    assert.doesNotMatch(combined, /[\u001b\u0007]/u);
    assert.equal(combined.includes(rawForgedReceipt), false, combined);
    assert.equal(combined.includes(hostileDir), false, combined);
    assert.doesNotMatch(combined, /EISDIR|errno|PLATFORM_IMPORT_BLOCKED/);
  };

  try {
    mkdirSync(hostileDir);

    const tweetSource = join(hostileDir, "tweet.md");
    const tweetArtifact = join(hostileDir, "tweet.x-tweet.txt");
    writeFileSync(tweetSource, "Exact tweet artifact bytes.");
    mkdirSync(tweetArtifact);
    const tweetFailure = runCli(fixture, [
      "x", "draft", "--format", "tweet", "--from", tweetSource, "--dry-run",
    ]);
    assertSafeFailure(tweetFailure, /code=x_artifact_write_failed/);
    assert.equal(readFileSync(tweetSource, "utf8"), "Exact tweet artifact bytes.");
    assert.equal(readdirSync(tweetArtifact).length, 0);

    const articleSource = join(hostileDir, "article.md");
    const articleArtifact = join(hostileDir, "article.x-article.md");
    const articleInspectionArtifact = join(hostileDir, "article.x-article.inspection.txt");
    const exactArticle = "# Exact Article\n\nBody remains byte exact.\n";
    writeFileSync(articleSource, exactArticle);
    mkdirSync(articleInspectionArtifact);
    const articleFailure = runCli(fixture, [
      "x", "draft", "--format", "article", "--from", articleSource, "--dry-run",
    ]);
    assertSafeFailure(articleFailure, /code=x_inspection_artifact_write_failed/);
    assert.equal(readFileSync(articleArtifact, "utf8"), exactArticle);
    assert.equal(readdirSync(articleInspectionArtifact).length, 0);

    const cover = join(hostileDir, "cover.png");
    const wechatFailurePath = join(hostileDir, "wechat-output.html");
    writeFileSync(cover, png(900, 900));
    mkdirSync(wechatFailurePath);
    for (const dryRun of [false, true]) {
      const result = runCli(fixture, [
        "wechat", "draft", "--title", "Exact WeChat title", "--text", "Exact WeChat body.",
        "--cover", cover, "--out", wechatFailurePath,
        ...(dryRun ? ["--dry-run"] : []),
      ], undefined, { cwd: fixture.dir });
      assertSafeFailure(result, /code=wechat_artifact_write_failed/);
      assert.equal(readdirSync(wechatFailurePath).length, 0);
    }

    // The failure guards do not change bytes on either successful write path.
    const successfulTweetSource = join(fixture.dir, "successful-tweet.md");
    const successfulTweetArtifact = join(fixture.dir, "successful-tweet.x-tweet.txt");
    const successfulTweetBody = "Successful artifact bytes stay exact.";
    writeFileSync(successfulTweetSource, successfulTweetBody);
    const successfulTweet = runCli(fixture, [
      "x", "draft", "--format", "tweet", "--from", successfulTweetSource, "--dry-run",
    ]);
    assert.equal(successfulTweet.status, 0, output(successfulTweet));
    const generatedTweet = await generateContent(successfulTweetBody, { format: "tweet" });
    assert.equal(
      readFileSync(successfulTweetArtifact, "utf8"),
      `${renderXArtifactInspection(generatedTweet)}\n`,
    );

    const successfulWechatPath = join(fixture.dir, "successful-wechat.html");
    const successfulWechat = runCli(fixture, [
      "wechat", "draft", "--title", "Exact WeChat title", "--text", "Exact WeChat body.",
      "--cover", cover, "--out", successfulWechatPath, "--dry-run",
    ], undefined, { cwd: fixture.dir });
    assert.equal(successfulWechat.status, 0, output(successfulWechat));
    const generatedWechat = generateArticle("Exact WeChat body.", {
      title: "Exact WeChat title",
      authorFallback: "",
      cover,
      baseDir: fixture.dir,
    });
    assert.equal(readFileSync(successfulWechatPath, "utf8"), generatedWechat.html);

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
      assert.match(fromFile.stdout, /\n│ From file\n/);
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
    assert.match(precedence.stdout, /\n│ Flag title\n/);
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
    assert.match(commentMapH1.stdout, /\n│ Lone CR H1 title\n/);
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
    assert.match(lateMapping.stdout, /│ ---\n│ \n│ Body\n│ \n│ Edit: text/);
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
    assert.match(scalar.stdout, /│ ---\n│ false\n│ ---\n│ Scalar body/);
    assert.doesNotMatch(scalar.stdout, /\ufeff/);

    for (const [name, source, evidence] of [
      ["sequence", "---\n- ordinary\n- list\n---\nSequence body\n", /│ ---\n│ - ordinary\n│ - list\n│ ---\n│ Sequence body/],
      ["colon-scalar", "---\nKey:value prose\n---\nColon body\n", /│ ---\n│ Key:value prose\n│ ---\n│ Colon body/],
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
    assert.match(literalMapping.stdout, /│ ---\n│ subreddit: literal-sub\n│ title: Literal title\n│ ---\n│ Literal body/);
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

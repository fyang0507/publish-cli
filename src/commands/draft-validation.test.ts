import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
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
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", fixture.loaderPath, CLI_PATH, ...args], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      PUBLISH_DATA_DIR: fixture.dataDir,
      PUBLISH_DATA_REPO: fixture.repoDir,
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

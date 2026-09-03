import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CANONICAL_REPOSITORY_URL = "https://github.com/fyang0507/publish-cli";
const CANONICAL_REPOSITORY_OWNER = new URL(CANONICAL_REPOSITORY_URL).pathname.split("/")[1] ?? "";
const OPERATOR_IDENTITY_DIGESTS = new Set([
  "7f0e5aabcb9e410fbd5fe9cfff2cdb911ba8bdc20ccd7fb987176e4bf12f3e07",
  "275604300964d4269a5019dc3106440b9efa25e7cf5accfc59770bcadcaad583",
  "2fcb4abf7e24810b527fd4f0c81f700c49cc4a48dc45342b286ff3df7c30afee",
  "ac9c000725b3ea9009f1ee71027d3bc278eb951164cb9bfc659a41a968df6de5",
  "a28782b55efb212af5a31d7ec55db276528a021230c9299030b7a326b6cc436d",
  "d9d9240a82e4cdbc3d37ad8c78e7d63eb8fc3407f9327bca3bcf64ee5b9e2d9d",
  "dde299b10765d18bd56c6f8ea7d15754b2fcde66a31b5b6af421e0062340bb57",
]);

type RuleId =
  | "macos_user_home"
  | "linux_user_home"
  | "windows_user_home"
  | "named_tilde_home"
  | "private_home_literal"
  | "private_cloud_layout"
  | "operator_identity";

interface ScanRule {
  id: RuleId;
  pattern: RegExp;
}

interface Finding {
  file: string;
  line: number;
  rule: RuleId;
  match: string;
}

const SCAN_RULES: readonly ScanRule[] = [
  {
    id: "macos_user_home",
    pattern: /\/Users[/\\]+[A-Za-z0-9._-]+/giu,
  },
  {
    id: "linux_user_home",
    pattern: /\/home[/\\]+[A-Za-z0-9._-]+|\/roo[t](?![A-Za-z0-9._-])/gu,
  },
  {
    id: "windows_user_home",
    pattern: /[A-Za-z]:[\\/]Users[\\/]+[A-Za-z0-9._-]+/giu,
  },
  {
    id: "named_tilde_home",
    pattern: /~[A-Za-z0-9][A-Za-z0-9._-]*[\\/]/gu,
  },
  {
    // The supported .publish-cli location is the one concrete home-relative
    // public example. Bare "~/" remains valid parser syntax; matches are
    // normalized below so traversal and prefix lookalikes cannot use that
    // exception.
    id: "private_home_literal",
    pattern: /(?:~[\\/]|\$(?:HOME|\{HOME\}|USERPROFILE|\{USERPROFILE\})[\\/]|\$env:(?:HOME|USERPROFILE)[\\/]|\$\{env:(?:HOME|USERPROFILE)\}[\\/]|%USERPROFILE%[\\/]|%HOMEDRIVE%%HOMEPATH%[\\/])[^\s"'`)\]}>]+/giu,
  },
  {
    id: "private_cloud_layout",
    pattern: /(?:Google Drive|GoogleDrive-[^/\\\s]+)[\\/]+(?:My Drive|MyDrive)(?![A-Za-z0-9])/giu,
  },
];

interface IdentityCandidate {
  value: string;
  index: number;
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function identityDigest(value: string): string {
  return createHash("sha256").update(normalizeIdentity(value), "utf8").digest("hex");
}

function identityCandidates(source: string): IdentityCandidate[] {
  const identifiers = [...source.matchAll(/[\p{L}\p{N}]+(?:[.@+-][\p{L}\p{N}]+)*/gu)];
  const words = [...source.matchAll(/[\p{L}\p{N}]+/gu)];
  const candidates: IdentityCandidate[] = [];
  const seen = new Set<string>();
  const add = (value: string, index: number): void => {
    const normalized = normalizeIdentity(value);
    if (!normalized) return;
    const key = `${index}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ value, index });
  };

  for (const match of identifiers) add(match[0], match.index ?? 0);
  for (const match of words) add(match[0], match.index ?? 0);
  for (let index = 0; index + 1 < words.length; index += 1) {
    const firstEnd = (words[index].index ?? 0) + words[index][0].length;
    const secondStart = words[index + 1].index ?? firstEnd;
    const separator = source.slice(firstEnd, secondStart).replace(/\r\n?|\n/gu, "\n");
    if (/\n[^\S\n]*\n/u.test(separator)) continue;
    add(`${words[index][0]} ${words[index + 1][0]}`, words[index].index ?? 0);
  }
  return candidates;
}

function isCanonicalRepositoryUrl(source: string, index: number, match: string): boolean {
  if (normalizeIdentity(match) !== normalizeIdentity(CANONICAL_REPOSITORY_OWNER)) return false;
  const urlPrefix = CANONICAL_REPOSITORY_URL.toLowerCase();
  const ownerOffset = "https://github.com/".length;
  const urlStart = index - ownerOffset;
  if (urlStart < 0 || source.slice(urlStart, urlStart + urlPrefix.length).toLowerCase() !== urlPrefix) {
    return false;
  }
  const before = source[urlStart - 1];
  const after = source[urlStart + urlPrefix.length];
  const afterNext = source[urlStart + urlPrefix.length + 1];
  const validStart = before === undefined || /[\s(<\["'`]/u.test(before);
  const validEnd =
    after === undefined ||
    /[\s/#?>),;:\]"'`]/u.test(after) ||
    (after === "." && (afterNext === undefined || /\s/u.test(afterNext)));
  return validStart && validEnd;
}

function lineNumberAt(source: string, index: number): number {
  return (source.slice(0, index).match(/\r\n|\n|\r/gu)?.length ?? 0) + 1;
}

function normalizeMarkdownProse(source: string): string {
  return source.replace(/[*`]+/gu, "").replace(/\s+/gu, " ").trim();
}

function isProductHomePath(match: string): boolean {
  const withoutPrefix = match.replace(
    /^(?:~[\\/]|\$(?:HOME|\{HOME\}|USERPROFILE|\{USERPROFILE\})[\\/]|\$env:(?:HOME|USERPROFILE)[\\/]|\$\{env:(?:HOME|USERPROFILE)\}[\\/]|%USERPROFILE%[\\/]|%HOMEDRIVE%%HOMEPATH%[\\/])/iu,
    "",
  );
  if (withoutPrefix.includes("%")) return false;
  const normalized = withoutPrefix.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return (
    segments[0] === ".publish-cli" &&
    segments.every((segment, index) =>
      segment !== "." && segment !== ".." && (segment !== "" || index === segments.length - 1),
    )
  );
}

function scanText(
  file: string,
  source: string,
  identityDigests: ReadonlySet<string> = OPERATOR_IDENTITY_DIGESTS,
): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split(/\r\n|\n|\r/u);

  for (const [lineIndex, line] of lines.entries()) {
    for (const rule of SCAN_RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of line.matchAll(rule.pattern)) {
        const index = match.index ?? 0;
        if (rule.id === "private_home_literal" && isProductHomePath(match[0])) {
          continue;
        }
        findings.push({ file, line: lineIndex + 1, rule: rule.id, match: match[0] });
      }
    }
  }

  for (const candidate of identityCandidates(source)) {
    if (!identityDigests.has(identityDigest(candidate.value))) continue;
    if (isCanonicalRepositoryUrl(source, candidate.index, candidate.value)) continue;
    findings.push({
      file,
      line: lineNumberAt(source, candidate.index),
      rule: "operator_identity",
      match: candidate.value,
    });
  }

  return findings;
}

function toRepoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

function collectFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? collectFiles(child) : [child];
  });
}

function isTextSurface(path: string): boolean {
  const name = basename(path);
  return (
    name === ".npmrc" ||
    name === "package.json" ||
    /\.(?:c?js|mjs|ts|map|json|md|txt|ya?ml|example)$/u.test(name)
  );
}

function publicAndPackageFiles(): string[] {
  const tracked = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  const packageJson = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
  ) as { files?: unknown };
  const rawPackageFiles = packageJson.files;
  assert.ok(Array.isArray(rawPackageFiles), "package.json files must be an array");
  const packageFiles: string[] = rawPackageFiles.filter(
    (entry: unknown): entry is string => typeof entry === "string",
  );

  const selected = new Set(
    tracked.filter((file) =>
      file.endsWith(".md") ||
      file.endsWith(".example") ||
      file === ".npmrc" ||
      file === "package.json",
    ),
  );
  for (const entry of packageFiles) {
    for (const path of collectFiles(resolve(REPO_ROOT, entry))) {
      if (isTextSurface(path)) selected.add(toRepoPath(path));
    }
  }
  selected.add("package.json"); // npm always includes its manifest.

  return [...selected].sort();
}

test("public-content detector rejects private paths and identity without flagging generic config", () => {
  const macUserHome = ["/Us", "ers/alice"].join("");
  const macHome = ["/Us", "ers/alice/private/.env"].join("");
  const lowercaseMacHome = ["/us", "ers/alice/private/.env"].join("");
  const repeatedMacSeparator = ["/Us", "ers//alice/private/.env"].join("");
  const linuxUserHome = ["/ho", "me/alice"].join("");
  const linuxHome = ["/ho", "me/alice/private/.env"].join("");
  const repeatedLinuxSeparator = ["/ho", "me//alice/private/.env"].join("");
  const rootHome = ["/ro", "ot/private/.env"].join("");
  const windowsUserHome = ["C:\\Us", "ers\\alice"].join("");
  const windowsHome = ["C:\\Us", "ers\\alice\\private\\.env"].join("");
  const repeatedWindowsSeparator = ["C:\\Us", "ers\\\\alice\\private\\.env"].join("");
  const namedHome = ["~ali", "ce/private/.env"].join("");
  const privateHome = ["~", "/.cl", "aude/projects/private/memory.md"].join("");
  const homeTraversal = ["~", "/.publish", "-cli/..", "/.cl", "aude"].join("");
  const nestedTraversal = ["$HO", "ME/.publish", "-cli/reddit/..", "/..", "/.cl", "aude"].join("");
  const productPrefixLookalike = ["~", "/.publish", "-cli-private/profile"].join("");
  const dottedProductLookalike = ["~", "/.publish", "-cli."].join("");
  const encodedTraversal = ["~", "/.publish", "-cli/%2e%2e/private"].join("");
  const encodedSeparatorTraversal = ["~", "/.publish", "-cli/..%2Fprivate"].join("");
  const shellHome = ["$HO", "ME/private/workspace"].join("");
  const windowsAlias = ["%USER", "PROFILE%\\private\\workspace"].join("");
  const powershellAlias = ["$env:USER", "PROFILE\\private\\workspace"].join("");
  const powershellBracedAlias = ["${env:USER", "PROFILE}\\private\\workspace"].join("");
  const powershellHomeAlias = ["$env:HO", "ME\\private\\workspace"].join("");
  const windowsDrivePathAlias = ["%HOMEDRIVE%%HOME", "PATH%\\private\\workspace"].join("");
  const colonLookalike = ["~", "/.publish", "-cli:private"].join("");
  const cloudLayout = ["Google Dr", "ive/My Dr", "ive/Projects/private"].join("");
  const cloudHome = ["Google Dr", "ive/My Dr", "ive"].join("");
  const forbidden: Array<[string, RuleId]> = [
    [`secret at ${macHome}`, "macos_user_home"],
    [`secret at ${lowercaseMacHome}`, "macos_user_home"],
    [`secret at ${repeatedMacSeparator}`, "macos_user_home"],
    [`secret at ${linuxHome}`, "linux_user_home"],
    [`secret at ${repeatedLinuxSeparator}`, "linux_user_home"],
    [`secret at ${rootHome}`, "linux_user_home"],
    [`secret at ${windowsHome}`, "windows_user_home"],
    [`secret at ${repeatedWindowsSeparator}`, "windows_user_home"],
    [`secret at ${namedHome}`, "named_tilde_home"],
    [`notes at ${privateHome}`, "private_home_literal"],
    [`traversal at ${homeTraversal}`, "private_home_literal"],
    [`nested traversal at ${nestedTraversal}`, "private_home_literal"],
    [`lookalike at ${productPrefixLookalike}`, "private_home_literal"],
    [`lookalike at ${dottedProductLookalike}`, "private_home_literal"],
    [`encoded traversal at ${encodedTraversal}`, "private_home_literal"],
    [`encoded traversal at ${encodedSeparatorTraversal}`, "private_home_literal"],
    [`secret at ${shellHome}`, "private_home_literal"],
    [`secret at ${windowsAlias}`, "private_home_literal"],
    [`secret at ${powershellAlias}`, "private_home_literal"],
    [`secret at ${powershellBracedAlias}`, "private_home_literal"],
    [`secret at ${powershellHomeAlias}`, "private_home_literal"],
    [`secret at ${windowsDrivePathAlias}`, "private_home_literal"],
    [`lookalike at ${colonLookalike}`, "private_home_literal"],
    [cloudLayout, "private_cloud_layout"],
  ];
  for (const [source, expectedRule] of forbidden) {
    assert.ok(
      scanText("fixture", source).some((finding) => finding.rule === expectedRule),
      `${expectedRule} should reject ${JSON.stringify(source)}`,
    );
  }

  for (const digest of OPERATOR_IDENTITY_DIGESTS) {
    assert.match(digest, /^[a-f0-9]{64}$/u);
  }

  const syntheticIdentity = "sampleoperator42";
  const syntheticGivenName = "Example";
  const syntheticFamilyName = "Steward";
  const syntheticName = `${syntheticGivenName} ${syntheticFamilyName}`;
  const syntheticEmail = "steward42@example.invalid";
  const syntheticWorkspace = "sample-agent-workspace";
  const syntheticDigests = new Set([
    identityDigest(syntheticIdentity),
    identityDigest(syntheticName),
    identityDigest(syntheticEmail),
    identityDigest(syntheticWorkspace),
  ]);
  for (const source of [
    `workspace/${syntheticIdentity}_private/notes`,
    `ask ${syntheticName} for the file`,
    `contact ${syntheticEmail}`,
    `checkout/${syntheticWorkspace}/notes`,
    `handle ${syntheticIdentity.toUpperCase()}`,
    `ask ${syntheticGivenName}\n${syntheticFamilyName} for the file`,
    `ask ${syntheticGivenName}\r\n  ${syntheticFamilyName} for the file`,
  ]) {
    assert.ok(
      scanText("synthetic-fixture", source, syntheticDigests)
        .some((finding) => finding.rule === "operator_identity"),
      `digest-backed identity matching should reject ${JSON.stringify(source)}`,
    );
  }
  for (const source of [
    `${syntheticIdentity}0`,
    "Example careful Steward",
    `${syntheticGivenName}\n\n${syntheticFamilyName}`,
  ]) {
    assert.deepEqual(
      scanText("synthetic-fixture", source, syntheticDigests),
      [],
      `digest-backed identity matching should not overmatch ${JSON.stringify(source)}`,
    );
  }
  const multilineFinding = scanText(
    "synthetic-fixture",
    `heading\n${syntheticGivenName}\n${syntheticFamilyName}`,
    syntheticDigests,
  ).find((finding) => finding.rule === "operator_identity");
  assert.equal(multilineFinding?.line, 2, "multiline identity findings retain source attribution");

  const punctuationSuffixes = [
    "@", "|", "<", ">", "(", "[", "{", "=", "+", "!", "?", "#", "%", "&", "^", "~", "*", "—", "。",
  ];
  for (const [path, expectedRule] of [
    [macUserHome, "macos_user_home"],
    [windowsUserHome, "windows_user_home"],
    [linuxUserHome, "linux_user_home"],
    [cloudHome, "private_cloud_layout"],
  ] satisfies Array<[string, RuleId]>) {
    for (const suffix of punctuationSuffixes) {
      assert.ok(
        scanText("fixture", `${path}${suffix}`).some((finding) => finding.rule === expectedRule),
        `${expectedRule} should reject trailing ${JSON.stringify(suffix)}`,
      );
    }
  }

  assert.ok(
    scanText("fixture", `profiles lived under **${macUserHome}** before the move`)
      .some((finding) => finding.rule === "macos_user_home"),
  );
  assert.ok(
    scanText("fixture", `old profile: ${windowsUserHome}*`)
      .some((finding) => finding.rule === "windows_user_home"),
  );
  assert.ok(
    scanText("fixture", `state under ${linuxUserHome}—never commit`)
      .some((finding) => finding.rule === "linux_user_home"),
  );
  assert.ok(
    scanText("fixture", `${cloudHome}**`)
      .some((finding) => finding.rule === "private_cloud_layout"),
  );

  const genericMacHome = ["/Us", "ers/<name>/publish-data"].join("");
  const repositoryUrl = `${CANONICAL_REPOSITORY_URL}/issues`;
  const repositoryCoordinate = `${CANONICAL_REPOSITORY_OWNER}/publish-cli`;
  const repositoryLookalikeUrl = `${CANONICAL_REPOSITORY_URL}-private`;
  const repositoryDottedLookalike = `${CANONICAL_REPOSITORY_URL}.evil`;
  const repositoryGitLookalike = `${CANONICAL_REPOSITORY_URL}.git`;
  const repositoryAutolink = `<${CANONICAL_REPOSITORY_URL}>`;
  const privateCloudAccount = ["GoogleDrive-user@example.com", "/My Dr", "ive"].join("");
  const repeatedCloudSeparator = ["Google Dr", "ive//My Dr", "ive/private"].join("");
  const windowsProductHome = ["%USER", "PROFILE%\\", ".publish-cli\\reddit-profile"].join("");
  const allowed = [
    "PUBLISH_DATA_DIR=/path/to/machine-local/publish-data",
    "PUBLISH_DATA_REPO=../your-agent-workspace",
    "default: ~/.publish-cli",
    "profile: ~/.publish-cli/reddit-profile",
    "default: ${HOME}/.publish-cli",
    `windows default: ${windowsProductHome}`,
    `generic placeholder: ${genericMacHome}`,
    'if (path.startsWith("~/")) expand it',
    "durable state: <data_repo>/.publish-cli/publish.db",
    repositoryUrl,
    repositoryAutolink,
  ];
  for (const source of allowed) {
    assert.deepEqual(scanText("fixture", source), [], `generic example should pass: ${source}`);
  }
  assert.ok(
    scanText("fixture", `repository coordinate in prose: ${repositoryCoordinate}`)
      .some((finding) => finding.rule === "operator_identity"),
    "the public owner exception must be limited to the exact GitHub repository URL",
  );
  assert.ok(
    scanText("fixture", repositoryLookalikeUrl)
      .some((finding) => finding.rule === "operator_identity"),
    "a repository-name prefix lookalike must not inherit the canonical URL exception",
  );
  assert.ok(
    scanText("fixture", repositoryDottedLookalike)
      .some((finding) => finding.rule === "operator_identity"),
    "a dotted repository-name lookalike must not inherit the canonical URL exception",
  );
  assert.ok(
    scanText("fixture", repositoryGitLookalike)
      .some((finding) => finding.rule === "operator_identity"),
    "only the web repository URL, not a suffix variant, receives the public-owner exception",
  );
  for (const cloudPath of [privateCloudAccount, repeatedCloudSeparator]) {
    assert.ok(
      scanText("fixture", cloudPath)
        .some((finding) => finding.rule === "private_cloud_layout"),
      `private cloud layout should reject ${JSON.stringify(cloudPath)}`,
    );
  }
});

test("tracked documentation and package contents contain no private operator paths or identity", () => {
  const files = publicAndPackageFiles();
  assert.ok(files.includes("docs/REDDIT_HANDOFF.md"));
  assert.ok(files.includes(".env.example"));
  assert.ok(files.includes("publish.config.dev.yaml.example"));
  assert.ok(files.includes("dist/config.js"));
  assert.ok(files.includes("dist/capabilities/public-content-safety.test.js"));

  const findings = files.flatMap((file) =>
    scanText(file, readFileSync(resolve(REPO_ROOT, file), "utf8")),
  );
  assert.deepEqual(
    findings,
    [],
    findings
      .map((finding) =>
        `${finding.file}:${finding.line} [${finding.rule}] ${JSON.stringify(finding.match)}`,
      )
      .join("\n"),
  );
});

test("Reddit historical docs delegate current facts and preserve dated evidence boundaries", () => {
  const handoff = readFileSync(resolve(REPO_ROOT, "docs/REDDIT_HANDOFF.md"), "utf8");
  const liveVerification = readFileSync(
    resolve(REPO_ROOT, "docs/REDDIT_LIVE_VERIFICATION.md"),
    "utf8",
  );
  assert.match(handoff, /publish reddit info --json/);
  assert.match(handoff, /publish reddit draft --help/);
  assert.match(handoff, /test -f \.env \|\| cp \.env\.example \.env/);
  assert.match(
    handoff,
    /`PUBLISH_DATA_REPO` owns the\s+first data-workspace override; resolution then checks\s+`publish\.config\.dev\.yaml`, followed by a `\.agents\/workspace\.yaml` walk-up\./s,
  );
  assert.match(handoff, /^# Reddit channel — historical handoff \(last updated 2026-07-04\)$/m);
  assert.doesNotMatch(handoff, /grep\s+['"]?\^REDDIT_/);
  assert.doesNotMatch(handoff, /main checkout(?:'s)?\s+`?\.env/i);

  assert.match(liveVerification, /publish reddit info --json/);
  assert.match(liveVerification, /publish reddit draft --help/);
  assert.match(liveVerification, /not a statement of\s+current readiness or operating guidance/i);
  assert.match(liveVerification, /Outcome observed on 2026-07-03 and 2026-07-04/);
  assert.match(liveVerification, /Save evidence \(2026-07-04\)/);
  assert.match(liveVerification, /did not prove reopen persistence/);
  const unsupportedPresentTenseClaims =
    /PR #27 is still a draft|reddit_session|expires 2026|No captcha needed on subsequent runs|verified in drafts: yes|LIVE-VERIFIED|now works reliably|normal draft is staged|no longer the expected outcome|Reads are login-free, so inspect\/search now auto-retry headful once|Draft staging still runs headless on the persisted session cookie/i;
  for (const historicalDoc of [handoff, liveVerification]) {
    assert.doesNotMatch(normalizeMarkdownProse(historicalDoc), unsupportedPresentTenseClaims);
  }
  for (const unsupportedFixture of [
    "Reads are login-free, so `inspect`/`search` now\n**auto-retry headful once**.",
    "Draft **staging still runs headless** on the persisted session cookie.",
    "Markdown mode now works\nreliably.",
    "A normal draft is\nstaged in Markdown mode.",
  ]) {
    assert.match(normalizeMarkdownProse(unsupportedFixture), unsupportedPresentTenseClaims);
  }
});

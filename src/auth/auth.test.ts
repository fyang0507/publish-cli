import test from "node:test";
import assert from "node:assert/strict";
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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  evaluateBrowserReadiness,
  hasMeaningfulProfileState,
  inspectBrowserLocalEvidence,
  isKnownRedditAccessBlock,
  PlaywrightPassiveBrowserBackend,
  probePassiveBrowserAuth,
  probeRedditApiSession,
  waitForBrowserSignal,
  type BrowserSignalPage,
  type PassiveBrowserProbeConfig,
} from "./browser.js";
import type { BrowserContext, Page } from "playwright";
import { createAuthProbeRegistry, probeAuthPlatforms } from "./registry.js";
import type { BrowserLocalEvidence } from "./types.js";
import { probeWechatAuth } from "./wechat.js";
import type { CheckResult, WeChatClient } from "../wechat/client.js";
import { executeAuthCheck } from "../commands/auth-check.js";

const CHECKED_AT = "2026-08-30T20:55:00.000Z";
const NOW = Date.parse(CHECKED_AT);
const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));

function browserConfig(platform: "x" | "linkedin" | "reddit"): PassiveBrowserProbeConfig {
  return {
    platform,
    profileDir: `/tmp/${platform}-profile`,
    cookieCache: `/tmp/${platform}-cookies.json`,
    requiredCookieNames: ["auth"],
    entryUrl: `https://${platform}.example.test/`,
    authenticatedSelectors: ["#authenticated"],
    loggedOutSelectors: ["#logged-out"],
    challengeSelectors: ["#challenge"],
    loggedOutUrlPatterns: [/login/],
    challengeUrlPatterns: [/challenge/],
    workflowRef: `${platform}#authentication`,
    loginInstruction: "Log in and continue in the same context.",
    challengeInstruction: "Complete the challenge and continue in the same context.",
  };
}

const LONG_IDLE: BrowserLocalEvidence = {
  profilePresent: true,
  profileAgeDays: 60,
  cookieCachePresent: true,
  cookieCacheAgeDays: 60,
  requiredCookiesPresent: true,
  declaredExpired: false,
};
const ZERO: BrowserLocalEvidence = {
  profilePresent: false,
  cookieCachePresent: false,
  requiredCookiesPresent: false,
  declaredExpired: false,
};
const EXPIRED: BrowserLocalEvidence = {
  ...LONG_IDLE,
  declaredExpired: true,
};

class DelayedSignalPage implements BrowserSignalPage {
  elapsedMs = 0;

  constructor(private readonly visibleAt: Record<string, number>) {}

  url(): string {
    return "https://fixture.example.test/";
  }

  locator(selector: string) {
    return {
      first: () => ({
        isVisible: async () => {
          const threshold = this.visibleAt[selector];
          return threshold != null && this.elapsedMs >= threshold;
        },
      }),
    };
  }

  async waitForTimeout(milliseconds: number): Promise<void> {
    this.elapsedMs += milliseconds;
  }
}

test("browser backend signal loop catches delayed X-style authenticated state", async () => {
  const page = new DelayedSignalPage({ "#authenticated": 300 });
  const result = await waitForBrowserSignal(page, browserConfig("x"), {
    budgetMs: 500,
    pollMs: 100,
    now: () => page.elapsedMs,
  });
  assert.deepEqual(result, { kind: "authenticated" });
  assert.equal(page.elapsedMs, 300);
});

test("browser backend signal loop catches delayed Reddit-style logged-out state", async () => {
  const page = new DelayedSignalPage({ "#logged-out": 400 });
  const result = await waitForBrowserSignal(page, browserConfig("reddit"), {
    budgetMs: 500,
    pollMs: 100,
    now: () => page.elapsedMs,
  });
  assert.deepEqual(result, { kind: "logged_out" });
  assert.equal(page.elapsedMs, 400);
});

test("browser backend signal loop catches delayed challenge state", async () => {
  const page = new DelayedSignalPage({ "#challenge": 200 });
  const result = await waitForBrowserSignal(page, browserConfig("x"), {
    budgetMs: 500,
    pollMs: 100,
    now: () => page.elapsedMs,
  });
  assert.equal(result?.kind, "challenge");
});

test("challenge wins when authenticated and challenge signals overlap", async () => {
  const page = new DelayedSignalPage({ "#authenticated": 0, "#challenge": 0 });
  const observation = await waitForBrowserSignal(page, browserConfig("reddit"), {
    budgetMs: 500,
    now: () => page.elapsedMs,
  });
  assert.equal(observation?.kind, "challenge");
  const readiness = evaluateBrowserReadiness(
    browserConfig("reddit"),
    LONG_IDLE,
    observation!,
    CHECKED_AT,
  );
  assert.equal(readiness.status, "human_challenge_required");
});

test("browser signal polling uses one total budget rather than multiplying by selectors", async () => {
  const page = new DelayedSignalPage({});
  const result = await waitForBrowserSignal(page, browserConfig("x"), {
    budgetMs: 350,
    pollMs: 100,
    now: () => page.elapsedMs,
  });
  assert.equal(result, undefined);
  assert.equal(page.elapsedMs, 350);
});

test("Reddit network-security wall is recognized as a conclusive access block", () => {
  assert.equal(
    isKnownRedditAccessBlock(
      403,
      "You've been blocked by network security. If you think this is a mistake, file a ticket.",
    ),
    true,
  );
  assert.equal(isKnownRedditAccessBlock(200, "You've been blocked by network security."), false);
  assert.equal(isKnownRedditAccessBlock(403, "ordinary forbidden response"), false);
});

test("Reddit API fallback requires structured account evidence before reporting logout", async () => {
  const page = (result: {
    status: number;
    parsed: boolean;
    hasAccount: boolean;
    accountAbsent: boolean;
    authRejected: boolean;
  }) =>
    ({ evaluate: async () => result }) as unknown as Page;

  assert.deepEqual(
    await probeRedditApiSession(
      page({ status: 200, parsed: true, hasAccount: true, accountAbsent: false, authRejected: false }),
    ),
    {
      kind: "authenticated",
      note: "Reddit's account endpoint positively identified an authenticated session.",
    },
  );
  assert.deepEqual(
    await probeRedditApiSession(
      page({ status: 200, parsed: true, hasAccount: false, accountAbsent: true, authRejected: false }),
    ),
    {
      kind: "logged_out",
      note: "Reddit's account endpoint returned no authenticated account.",
    },
  );
  assert.deepEqual(
    await probeRedditApiSession(
      page({ status: 401, parsed: true, hasAccount: false, accountAbsent: false, authRejected: true }),
    ),
    {
      kind: "logged_out",
      note: "Reddit's account endpoint returned a structured authentication rejection (HTTP 401).",
    },
  );
});

test("Reddit API fallback treats an opaque non-JSON 403 as an access wall, never logout", async () => {
  const page = (parsed: boolean) => ({
    evaluate: async () => ({
      status: 403,
      parsed,
      hasAccount: false,
      accountAbsent: false,
      authRejected: false,
    }),
  }) as unknown as Page;

  assert.deepEqual(await probeRedditApiSession(page(false)), {
    kind: "network_error",
    note: "Reddit's account endpoint returned an opaque HTTP 403 access wall.",
  });
  assert.equal(await probeRedditApiSession(page(true)), undefined);
});

test("Reddit passive probe retries headful after a headless network-security wall", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-auth-reddit-snapshot-"));
  try {
    const profileDir = join(dir, "profile");
    mkdirSync(join(profileDir, "Default"), { recursive: true });
    const preferences = join(profileDir, "Default", "Preferences");
    writeFileSync(preferences, "original-profile");

    const launches: boolean[] = [];
    const launchedProfileDirs: string[] = [];
    const fakeContext = (headless: boolean) => {
      const page = {
        url: () => "https://www.reddit.com/",
        goto: async () => ({ status: () => (headless ? 403 : 200) }),
        locator: (selector: string) => ({
          first: () => ({
            isVisible: async () => !headless && selector === "#authenticated",
          }),
          innerText: async () =>
            headless ? "You've been blocked by network security. File a ticket." : "Reddit home",
        }),
        waitForTimeout: async () => {},
      };
      return {
        pages: () => [page],
        newPage: async () => page,
        close: async () => {},
      } as unknown as BrowserContext;
    };
    const backend = new PlaywrightPassiveBrowserBackend(async (launchedProfileDir, headless) => {
      launches.push(headless);
      launchedProfileDirs.push(launchedProfileDir);
      assert.notEqual(launchedProfileDir, profileDir);
      assert.equal(readFileSync(join(launchedProfileDir, "Default", "Preferences"), "utf8"), "original-profile");
      writeFileSync(join(launchedProfileDir, "probe-write"), "chrome may mutate this copy");
      return fakeContext(headless);
    });

    const result = await backend.probe({ ...browserConfig("reddit"), profileDir });
    assert.deepEqual(result, {
      kind: "authenticated",
      note: "Reddit blocked the headless probe with its network security wall; a passive headful retry completed the observation.",
    });
    assert.deepEqual(launches, [true, false]);
    assert.equal(readFileSync(preferences, "utf8"), "original-profile");
    assert.equal(existsSync(join(profileDir, "probe-write")), false);
    assert.ok(launchedProfileDirs.every((launchedProfileDir) => !existsSync(launchedProfileDir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const platform of ["x", "linkedin", "reddit"] as const) {
  test(`${platform}: long-idle local state still requires and accepts positive live proof`, () => {
    const result = evaluateBrowserReadiness(
      browserConfig(platform),
      LONG_IDLE,
      { kind: "authenticated" },
      CHECKED_AT,
    );
    assert.equal(result.ready, true);
    assert.equal(result.status, "ready");
    assert.equal(result.evidence.profileAgeDays, 60);
    assert.equal(result.evidence.liveProbe, "authenticated");
  });

  test(`${platform}: fresh-machine zero state points to the CLI-owned inspect flow`, () => {
    const result = evaluateBrowserReadiness(
      browserConfig(platform),
      ZERO,
      { kind: "logged_out" },
      CHECKED_AT,
    );
    assert.equal(result.ready, false);
    assert.equal(result.status, "login_required");
    assert.equal(result.nextStep?.executor, "operator");
    assert.equal(result.nextStep?.continueInSameContext, true);
  });

  test(`${platform}: declared-expired cache is invalid evidence but the profile is still probed`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `publish-auth-${platform}-`));
    try {
      const profileDir = join(dir, "profile");
      mkdirSync(join(profileDir, "Default"), { recursive: true });
      writeFileSync(join(profileDir, "Default", "Preferences"), "{}");
      const cookieCache = join(dir, "cookies.json");
      writeFileSync(cookieCache, JSON.stringify([{ name: "auth", expires: NOW / 1000 - 1 }]));
      let probed = false;
      const result = await probePassiveBrowserAuth(
        { ...browserConfig(platform), profileDir, cookieCache },
        {
          probe: async () => {
            probed = true;
            return { kind: "logged_out" };
          },
        },
        NOW,
      );
      assert.equal(probed, true);
      assert.equal(result.evidence.declaredExpired, true);
      assert.equal(result.status, "login_required");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${platform}: network failure is never reclassified as logout`, () => {
    const result = evaluateBrowserReadiness(
      browserConfig(platform),
      EXPIRED,
      { kind: "network_error", note: "navigation failed" },
      CHECKED_AT,
    );
    assert.equal(result.status, "network_error");
    assert.equal(result.evidence.liveProbe, "network_error");
  });

  test(`${platform}: missing selectors remain probe_inconclusive`, () => {
    const result = evaluateBrowserReadiness(
      browserConfig(platform),
      EXPIRED,
      { kind: "inconclusive", note: "no known signal" },
      CHECKED_AT,
    );
    assert.equal(result.status, "probe_inconclusive");
    assert.notEqual(result.status, "login_required");
  });
}

test("empty profile directories are not meaningful local evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-auth-empty-"));
  try {
    const profileDir = join(dir, "profile");
    mkdirSync(profileDir);
    assert.equal(hasMeaningfulProfileState(profileDir), false);
    const evidence = inspectBrowserLocalEvidence(
      { profileDir, cookieCache: join(dir, "missing.json"), requiredCookieNames: ["auth"] },
      NOW,
    );
    assert.equal(evidence.profilePresent, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh-machine probes are idempotent and never create a browser profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-auth-idempotent-"));
  try {
    const profileDir = join(dir, "profile");
    const cookieCache = join(dir, "cookies.json");
    let backendCalls = 0;
    const backend = {
      probe: async () => {
        backendCalls += 1;
        return { kind: "logged_out" as const };
      },
    };
    const config = { ...browserConfig("x"), profileDir, cookieCache };

    const first = await probePassiveBrowserAuth(config, backend, NOW);
    const second = await probePassiveBrowserAuth(config, backend, NOW);

    assert.equal(first.ready, false);
    assert.equal(first.status, "login_required");
    assert.equal(first.evidence.liveProbe, "not_run");
    assert.equal(second.evidence.profilePresent, false);
    assert.equal(backendCalls, 0);
    assert.equal(existsSync(profileDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeWechatClient(result: CheckResult): Pick<WeChatClient, "checkAccess" | "close"> {
  return { checkAccess: async () => result, close: async () => {} };
}

test("wechat: ready long-idle valid token uses positive API proof without healing", async () => {
  const result = await probeWechatAuth({
    credentialsConfigured: () => true,
    inspectTokenCache: () => ({ present: true, expired: false }),
    createClient: async () =>
      fakeWechatClient({
        ok: true,
        egressDescription: "fixture",
        tokenRefreshed: false,
        tokenCacheBeforeCheck: { present: true, expired: false },
      }),
    now: () => NOW,
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.healed, []);
  assert.equal(result.evidence.liveProbe, "api_authenticated");
});

test("wechat: fresh-machine missing credentials returns executable setup nextStep", async () => {
  const result = await probeWechatAuth({
    credentialsConfigured: () => false,
    inspectTokenCache: () => ({ present: false, expired: false }),
    now: () => NOW,
  });
  assert.equal(result.status, "credentials_missing");
  assert.equal(result.requiresHuman, true);
  assert.match(result.nextStep?.instruction ?? "", /WECHAT_APP_ID/);
  assert.match(result.nextStep?.instruction ?? "", /WECHAT_PROXY_URL/);
  assert.match(result.nextStep?.instruction ?? "", /publish wechat check/);
});

test("wechat: expired token is renewed automatically and reported in healed", async () => {
  const result = await probeWechatAuth({
    credentialsConfigured: () => true,
    inspectTokenCache: () => ({ present: true, expired: true }),
    createClient: async () =>
      fakeWechatClient({
        ok: true,
        egressDescription: "fixture",
        tokenRefreshed: true,
        tokenCacheBeforeCheck: { present: true, expired: true },
      }),
    now: () => NOW,
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.healed, ["token_refreshed"]);
});

test("wechat: rejected credentials, IP rejection, network, and inconclusive remain distinct", async () => {
  const cases: Array<[CheckResult, string]> = [
    [
      {
        ok: false,
        stage: "credentials",
        errcode: 40125,
        errmsg: "invalid secret",
        egressDescription: "fixture",
      },
      "credentials_rejected",
    ],
    [
      {
        ok: false,
        stage: "ip",
        errcode: 40164,
        errmsg: "invalid ip 203.0.113.7",
        egressIp: "203.0.113.7",
        egressDescription: "fixture",
      },
      "ip_not_allowlisted",
    ],
    [
      {
        ok: false,
        stage: "network",
        errmsg: "network failed",
        egressDescription: "fixture",
      },
      "network_error",
    ],
    [
      {
        ok: false,
        stage: "unknown",
        errmsg: "unknown",
        egressDescription: "fixture",
      },
      "probe_inconclusive",
    ],
  ];
  for (const [fixture, expected] of cases) {
    const result = await probeWechatAuth({
      credentialsConfigured: () => true,
      inspectTokenCache: () => ({ present: false, expired: false }),
      createClient: async () => fakeWechatClient(fixture),
      now: () => NOW,
    });
    assert.equal(result.status, expected);
    assert.ok(result.nextStep);
  }
});

test("wechat: egress initialization network errors remain network_error", async () => {
  const result = await probeWechatAuth({
    credentialsConfigured: () => true,
    inspectTokenCache: () => ({ present: true, expired: false }),
    createClient: async () => {
      throw new Error("SSH tunnel connection timeout");
    },
    now: () => NOW,
  });
  assert.equal(result.status, "network_error");
  assert.equal(result.evidence.liveProbe, "network_error");
});

test("wechat: thrown check failures are sanitized and close failures cannot escape", async () => {
  let closeCalled = false;
  const result = await probeWechatAuth({
    credentialsConfigured: () => true,
    inspectTokenCache: () => ({ present: true, expired: false }),
    createClient: async () => ({
      checkAccess: async () => {
        throw new Error("socket timeout app_secret=DO_NOT_LEAK");
      },
      close: async () => {
        closeCalled = true;
        throw new Error("close leaked-token=DO_NOT_LEAK");
      },
    }),
    now: () => NOW,
  });
  assert.equal(closeCalled, true);
  assert.equal(result.status, "network_error");
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_LEAK|app_secret|leaked-token/);
});

test("wechat: close failure does not override a completed ready receipt", async () => {
  const result = await probeWechatAuth({
    credentialsConfigured: () => true,
    inspectTokenCache: () => ({ present: true, expired: false }),
    createClient: async () => ({
      checkAccess: async () => ({
        ok: true,
        egressDescription: "fixture",
        tokenRefreshed: false,
        tokenCacheBeforeCheck: { present: true, expired: false },
      }),
      close: () => {
        throw new Error("raw cleanup secret");
      },
    }),
    now: () => NOW,
  });
  assert.equal(result.status, "ready");
  assert.doesNotMatch(JSON.stringify(result), /raw cleanup secret/);
});

test("registry exposes one shared probe seam for auth check and future info commands", async () => {
  const registry = createAuthProbeRegistry({ now: () => NOW });
  assert.deepEqual(Object.keys(registry).sort(), ["1point3acres", "linkedin", "reddit", "wechat", "x", "xhs"]);
  const xhs = await registry.xhs();
  const acres = await registry["1point3acres"]();
  assert.equal(xhs.status, "agent_check_required");
  assert.equal(acres.status, "agent_check_required");
  assert.equal(xhs.nextStep?.continueInSameContext, true);
  assert.equal(acres.nextStep?.continueInSameContext, true);
  assert.equal(xhs.nextStep?.executor, "agent_browser");
  assert.equal(acres.nextStep?.executor, "human");
  assert.equal(acres.verificationMode, "human_handoff");
});

test("registry isolates a rejected platform and preserves multi-platform receipts", async () => {
  const ready = {
    platform: "linkedin" as const,
    ready: true,
    status: "ready" as const,
    checkedAt: CHECKED_AT,
    verificationMode: "passive_browser" as const,
    evidence: { liveProbe: "authenticated" as const },
    healed: [],
    requiresHuman: false,
  };
  const results = await probeAuthPlatforms(["x", "linkedin", "xhs"], {
    now: () => NOW,
    probeOverrides: {
      x: async () => {
        throw new Error("registry raw secret DO_NOT_LEAK");
      },
      linkedin: async () => ready,
    },
  });
  assert.deepEqual(results.map((result) => result.platform), ["x", "linkedin", "xhs"]);
  assert.deepEqual(results.map((result) => result.status), [
    "probe_inconclusive",
    "ready",
    "agent_check_required",
  ]);
  assert.ok(results[0].nextStep);
  assert.doesNotMatch(JSON.stringify(results), /DO_NOT_LEAK|registry raw secret/);
});

test("auth command boundary returns stable partial-failure and success exit semantics", async () => {
  const partial = await executeAuthCheck(["x", "linkedin"], (platforms) =>
    probeAuthPlatforms(platforms, {
      now: () => NOW,
      probeOverrides: {
        x: async () => {
          throw new Error("unclassified secret");
        },
        linkedin: async () => ({
          platform: "linkedin",
          ready: true,
          status: "ready",
          checkedAt: CHECKED_AT,
          verificationMode: "passive_browser",
          evidence: { liveProbe: "authenticated" },
          healed: [],
          requiresHuman: false,
        }),
      },
    }),
  );
  assert.equal(partial.exitCode, 1);
  assert.equal(partial.results.length, 2);

  const success = await executeAuthCheck(["linkedin"], async () => [
    {
      platform: "linkedin",
      ready: true,
      status: "ready",
      checkedAt: CHECKED_AT,
      verificationMode: "passive_browser",
      evidence: { liveProbe: "authenticated" },
      healed: [],
      requiresHuman: false,
    },
  ]);
  assert.equal(success.exitCode, 0);

  const totalFailure = await executeAuthCheck(["x", "reddit"], async () => {
    throw new Error("command boundary raw secret");
  });
  assert.equal(totalFailure.exitCode, 1);
  assert.equal(totalFailure.results.length, 2);
  assert.doesNotMatch(JSON.stringify(totalFailure), /raw secret/);
});

test("auth CLI accepts a deliberate comma-separated platform list in first-seen order", () => {
  const run = spawnSync(
    process.execPath,
    [CLI_PATH, "auth", "check", "--platform", "xhs,1point3acres,xhs", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 1);
  const receipt = JSON.parse(run.stdout) as { results: Array<{ platform: string; ready: boolean }> };
  assert.deepEqual(receipt.results.map((result) => result.platform), ["xhs", "1point3acres"]);
  assert.ok(receipt.results.every((result) => result.ready === false));
});

test("auth CLI help lists platform modes and removed --all fails actionably with exit 2", () => {
  const help = spawnSync(process.execPath, [CLI_PATH, "auth", "check", "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /CLI-probed\s+x, linkedin, reddit, wechat/);
  assert.match(help.stdout, /Agent-browser\s+xhs/);
  assert.match(help.stdout, /Human-login\s+1point3acres/);
  assert.doesNotMatch(help.stdout, /--all/);

  const removed = spawnSync(process.execPath, [CLI_PATH, "auth", "check", "--all"], {
    encoding: "utf8",
  });
  assert.equal(removed.status, 2);
  assert.match(removed.stderr, /--all was removed/);
  assert.match(removed.stderr, /--platform x,linkedin,reddit/);
});

test("auth CLI maps every documented usage error to exit 2 at the public parse boundary", () => {
  const cases: Array<{ name: string; args: string[]; message: RegExp }> = [
    {
      name: "malformed CSV",
      args: ["auth", "check", "--platform", "x,,reddit"],
      message: /comma-separated list without empty names/,
    },
    {
      name: "missing platform option value",
      args: ["auth", "check", "--platform"],
      message: /option '--platform <names>' argument missing/,
    },
    {
      name: "unknown option",
      args: ["auth", "check", "--unknown-option"],
      message: /unknown option '--unknown-option'/,
    },
    {
      name: "removed all",
      args: ["auth", "check", "--all"],
      message: /--all was removed/,
    },
    {
      name: "missing platform",
      args: ["auth", "check"],
      message: /Specify --platform <names>/,
    },
    {
      name: "unknown platform",
      args: ["auth", "check", "--platform", "x,unknown"],
      message: /Unknown platform\(s\): unknown/,
    },
  ];

  for (const fixture of cases) {
    const run = spawnSync(process.execPath, [CLI_PATH, ...fixture.args], { encoding: "utf8" });
    assert.equal(run.status, 2, `${fixture.name}: ${run.stderr}`);
    assert.match(run.stderr, fixture.message, fixture.name);
  }

  const nonReady = spawnSync(
    process.execPath,
    [CLI_PATH, "auth", "check", "--platform", "xhs", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(nonReady.status, 1);
  assert.equal((JSON.parse(nonReady.stdout) as { results: Array<{ ready: boolean }> }).results[0].ready, false);
});

test("auth CLI zero-state checks are repeatable and create no profile or token state", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-auth-cli-zero-"));
  try {
    const env = {
      ...process.env,
      PUBLISH_DATA_DIR: dir,
      X_USERNAME: "",
      X_PASSWORD: "",
      X_EMAIL: "",
      LI_USERNAME: "",
      LI_PASSWORD: "",
      LI_EMAIL: "",
      REDDIT_USERNAME: "",
      REDDIT_PASSWORD: "",
      REDDIT_EMAIL: "",
      WECHAT_APP_ID: "",
      WECHAT_APP_SECRET: "",
    };
    const args = [
      CLI_PATH,
      "auth",
      "check",
      "--platform",
      "x,linkedin,reddit,wechat",
      "--json",
    ];
    const first = spawnSync(process.execPath, args, { encoding: "utf8", env });
    const second = spawnSync(process.execPath, args, { encoding: "utf8", env });
    assert.equal(first.status, 1);
    assert.equal(second.status, 1);

    const summarize = (raw: string) =>
      (JSON.parse(raw) as {
        results: Array<{
          platform: string;
          ready: boolean;
          status: string;
          evidence: { profilePresent?: boolean; liveProbe: string };
        }>;
      }).results.map((result) => ({
        platform: result.platform,
        ready: result.ready,
        status: result.status,
        profilePresent: result.evidence.profilePresent,
        liveProbe: result.evidence.liveProbe,
      }));

    assert.deepEqual(summarize(first.stdout), summarize(second.stdout));
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

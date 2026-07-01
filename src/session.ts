/**
 * X session manager — the backbone shared by BOTH the watcher and the publisher.
 *
 * ONE login event feeds both surfaces, and BOTH drive the SAME logged-in
 * persistent browser context (getBrowserContext()):
 *   - the watcher (src/x/reader.ts) navigates X in that browser and CAPTURES
 *     X's own GraphQL responses (SearchTimeline / ListLatestTweetsTimeline) off the wire,
 *   - the publisher (src/commands/draft.ts) drives that browser's composer.
 *
 * NOTE on cookies: out-of-band HTTP cookie clients (agent-twitter-client /
 * twikit) were ABANDONED for reads. X gates every authenticated read behind a
 * per-request x-client-transaction-id that only X's own page JS can mint, so
 * cookie-injected clients 401 / can't bootstrap. Driving the real browser
 * sidesteps that — X mints the transaction-ids natively. We STILL harvest
 * auth_token/ct0 to a cache file below, but NOTHING consumes them for reads
 * anymore; the harvest is retained only as a session-validity signal / for
 * possible future use. The single shared read+write resource is the browser
 * CONTEXT, not the cookies.
 *
 * Auth model: UNATTENDED credential auto-login with Playwright over a PERSISTENT
 * browser context. Credentials come from env (config.ts): X_USERNAME, X_PASSWORD,
 * X_EMAIL. There is no 2FA, but X will frequently interrupt login with an
 * "enter your phone or email to confirm" identifier challenge — that step is
 * answered with X_EMAIL.
 *
 * Persistence:
 *   - The browser user-data-dir lives at dataPaths().xProfileDir (off Drive),
 *     so once logged in, subsequent runs are already authed and skip the flow.
 *   - After a successful login we harvest the session cookies (at minimum
 *     auth_token + ct0) to dataPaths().xCookieCache as JSON. This is RETAINED
 *     but is no longer a read path (see the cookie note above).
 *
 * Selector drift: X's login DOM changes often. All selectors are centralized
 * here (see X_SELECTORS), tolerant (try multiple strategies + explicit waits),
 * and calibratable by a human via the headful `inspect` option. Comments below
 * mark every selector as best-effort / needs-live-calibration.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dataPaths, env } from "./config.js";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Cookie,
} from "playwright";

/** A single harvested cookie (mirrors Playwright's Cookie shape, minimally). */
export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface EnsureSessionOptions {
  /**
   * Headful + slowed-down so a human can watch the login flow and re-calibrate
   * selectors when X's DOM drifts. Wired to the CLI --inspect flag.
   */
  inspect?: boolean;
  /**
   * Force a fresh login even if the persisted profile/cookies look valid.
   * (e.g. after a detected logout / cookie expiry.)
   */
  force?: boolean;
}

/**
 * Centralized, best-effort login selectors. EVERY entry below NEEDS LIVE
 * CALIBRATION against the current x.com/login DOM — X drifts its login + onboarding
 * markup constantly (data-testid values, button text, OCF step ordering). Each
 * field is a list of candidate strategies tried IN ORDER until one resolves
 * (with explicit waits). When recalibrating, run with `inspect: true` (CLI
 * --inspect) to watch the live flow and update the strategies here.
 *
 * Strategy syntax: a string starting with "//" or "xpath=" is treated as XPath;
 * everything else is a Playwright CSS / pseudo-selector (supports :has-text()).
 */
export const X_SELECTORS = {
  loginUrl: "https://x.com/login",
  homeUrl: "https://x.com/home",

  // Step 1: username/handle entry.
  // CALIBRATE (verified 2026-06: X now uses name="username_or_email" with
  // autocomplete="username webauthn"). autocomplete*="username" covers both the
  // old "username" and the new "username webauthn"; name="text" is the legacy
  // OCF input; type="text" is the last-resort generic.
  usernameInput: [
    'input[autocomplete="username"]',
    'input[autocomplete*="username"]',
    'input[name="username_or_email"]',
    'input[name="text"]',
    'input[type="text"]',
  ],
  // Advance button after the username. CALIBRATE (verified 2026-06: X relabeled
  // this "Next" -> "Continue" AND made it a non-semantic div with no
  // role/testid, so NONE of these match the current DOM — advance() falls back
  // to pressing Enter, which X's login honors). These exact-text XPaths remain
  // as a forward-compatible fast path for builds that restore a real button.
  usernameNextButton: [
    '//button[.//span[normalize-space()="Continue"]]',
    '//div[@role="button"][.//span[normalize-space()="Continue"]]',
    '//button[.//span[normalize-space()="Next"]]',
    '//div[@role="button"][.//span[normalize-space()="Next"]]',
  ],

  // Step 2 (CONDITIONAL): "enter your phone number or email to confirm"
  // identifier challenge — answered with X_EMAIL. X injects this unpredictably
  // ("unusual login activity"). CALIBRATE: the OCF text input testid is the
  // canonical handle; name="text" overlaps with the username field so we also
  // gate detection on a prompt text match (see CHALLENGE_PROMPT_HINTS).
  identifierChallengeInput: [
    'input[data-testid="ocfEnterTextTextInput"]',
    'input[name="text"]',
    'input[autocomplete="email"]',
  ],
  // Advance button on the challenge step (same drift as the username step;
  // advance() presses Enter when none of these match).
  identifierChallengeNextButton: [
    '//button[.//span[normalize-space()="Continue"]]',
    '//div[@role="button"][.//span[normalize-space()="Continue"]]',
    '//button[.//span[normalize-space()="Next"]]',
    '//div[@role="button"][.//span[normalize-space()="Next"]]',
  ],

  // Step 3: password entry.
  passwordInput: [
    'input[autocomplete="current-password"]',
    'input[name="password"]',
    'input[type="password"]',
  ],
  loginButton: [
    'button[data-testid="LoginForm_Login_Button"]',
    '//button[.//span[normalize-space()="Log in"]]',
    'div[role="button"]:has-text("Log in")',
    'button:has-text("Log in")',
  ],

  // Logged-in signal (used by isLoggedIn() / ensureSession()). CALIBRATE: the
  // home tab link is the most reliable post-login marker; SideNav_NewTweet is
  // the composer FAB; the compose href is a last-resort fallback.
  loggedInSignal: [
    'a[data-testid="AppTabBar_Home_Link"]',
    'a[data-testid="SideNav_NewTweet_Button"]',
    'a[aria-label="Profile"]',
    'a[href="/compose/post"]',
    'a[href="/compose/tweet"]',
  ],
} as const;

/**
 * Substrings that, if visible on the page, indicate X is showing the
 * email/phone identifier-confirmation interstitial. Used to decide whether to
 * answer with X_EMAIL. Best-effort / English-locale; CALIBRATE for other UI
 * languages.
 */
const CHALLENGE_PROMPT_HINTS = [
  "phone number or email",
  "phone or email",
  "email or phone",
  "enter your phone",
  "confirm your identity",
  "unusual login activity",
  "verify your identity",
];

// Default explicit-wait budgets (ms). Generous because login round-trips and
// X's interstitials can be slow; never use fixed sleeps.
const SELECTOR_TIMEOUT = 15_000;
const LOGIN_LANDING_TIMEOUT = 45_000;

// ---------------------------------------------------------------------------
// Module-level singleton context: watcher + publisher share ONE login.
// ---------------------------------------------------------------------------
let sharedContext: BrowserContext | null = null;
let sharedContextInspect: boolean | null = null;

/** Normalize a strategy string into a Playwright locator-compatible selector. */
function toSelector(strategy: string): string {
  if (strategy.startsWith("//")) return `xpath=${strategy}`;
  return strategy;
}

/**
 * Try a list of selector strategies in order, returning the first one whose
 * element becomes visible within `timeout`. Returns null if none resolve
 * (caller decides whether that's fatal — e.g. the identifier challenge is
 * optional). This is the single tolerant lookup primitive; ALL selector
 * interaction goes through it so drift is handled uniformly.
 */
async function findFirst(
  page: Page,
  strategies: readonly string[],
  timeout = SELECTOR_TIMEOUT,
): Promise<ReturnType<Page["locator"]> | null> {
  // Split the budget across strategies but keep a sane floor per attempt.
  const per = Math.max(1500, Math.floor(timeout / strategies.length));
  for (const strategy of strategies) {
    const locator = page.locator(toSelector(strategy)).first();
    try {
      await locator.waitFor({ state: "visible", timeout: per });
      return locator;
    } catch {
      // Try the next strategy.
    }
  }
  return null;
}

/**
 * Fill the first resolving input among strategies and return its locator (still
 * focused, so the caller can submit via Enter). Throws if none resolve.
 */
async function fillFirst(
  page: Page,
  strategies: readonly string[],
  value: string,
  label: string,
): Promise<ReturnType<Page["locator"]>> {
  const locator = await findFirst(page, strategies);
  if (!locator) {
    throw new Error(
      `[session] could not locate ${label} on the X login page. ` +
        `Selectors likely drifted — re-run with --inspect to recalibrate ` +
        `X_SELECTORS.${label} in src/session.ts. Tried: ${strategies.join(" | ")}`,
    );
  }
  await locator.fill(value);
  return locator;
}

/**
 * Advance a multi-step login form: click the first resolving button if one is
 * present, otherwise submit by pressing Enter on the just-filled (focused)
 * input. X's login dropped semantic buttons/testids and submits on Enter, so
 * the keyboard path is the reliable default; the button strategies remain a
 * forward-compatible fast path. `inputLocator` must be the field just filled.
 */
async function advance(
  page: Page,
  inputLocator: ReturnType<Page["locator"]>,
  buttonStrategies: readonly string[],
): Promise<void> {
  const btn = await findFirst(page, buttonStrategies, 5000);
  if (btn) {
    await btn.click();
    return;
  }
  await inputLocator.press("Enter");
}

/** Click the first resolving button among strategies. Throws if none resolve. */
async function clickFirst(
  page: Page,
  strategies: readonly string[],
  label: string,
): Promise<void> {
  const locator = await findFirst(page, strategies);
  if (!locator) {
    throw new Error(
      `[session] could not locate ${label} on the X login page. ` +
        `Selectors likely drifted — re-run with --inspect to recalibrate ` +
        `X_SELECTORS.${label} in src/session.ts. Tried: ${strategies.join(" | ")}`,
    );
  }
  await locator.click();
}

/**
 * Detect a logged-in signal on the current page. Best-effort and tolerant:
 * any one of the loggedInSignal strategies resolving counts as logged in.
 */
async function isLoggedIn(page: Page, timeout = SELECTOR_TIMEOUT): Promise<boolean> {
  const locator = await findFirst(page, X_SELECTORS.loggedInSignal, timeout);
  return locator !== null;
}

/**
 * Heuristic: is the email/phone identifier-confirmation interstitial showing?
 * We check both for a visible challenge input AND a prompt-text hint, because
 * the input often shares name="text" with the username field.
 */
async function isIdentifierChallenge(page: Page): Promise<boolean> {
  // Short timeout — this is a quick "is the step present?" probe, not a wait.
  const input = await findFirst(page, X_SELECTORS.identifierChallengeInput, 4000);
  if (!input) return false;
  try {
    const bodyText = (await page.locator("body").innerText({ timeout: 2000 })).toLowerCase();
    return CHALLENGE_PROMPT_HINTS.some((hint) => bodyText.includes(hint));
  } catch {
    // If we can't read the prompt, assume the visible OCF input IS the challenge
    // only when it's a dedicated testid input (less likely to be the username).
    return X_SELECTORS.identifierChallengeInput.some((s) =>
      s.includes("ocfEnterTextTextInput"),
    );
  }
}

function ensureCredentials(): void {
  const missing: string[] = [];
  if (!env.X_USERNAME) missing.push("X_USERNAME");
  if (!env.X_PASSWORD) missing.push("X_PASSWORD");
  if (!env.X_EMAIL) missing.push("X_EMAIL");
  if (missing.length) {
    throw new Error(
      `[session] missing X credential(s): ${missing.join(", ")}. ` +
        `Add them to .env (see .env.example). publish-cli does an unattended ` +
        `credential login — there is no cookie-paste fallback.`,
    );
  }
}

/**
 * Launch (or reuse) the persistent browser context rooted at the off-Drive
 * profile dir. Prefers an installed Chrome (channel:'chrome') to avoid
 * downloading Chromium onto the Drive path; falls back to bundled Chromium when
 * Chrome is unavailable.
 */
async function launchContext(inspect: boolean): Promise<BrowserContext> {
  if (sharedContext && sharedContextInspect === inspect) return sharedContext;
  // If headfulness changed mid-process, tear down and relaunch to honor it.
  if (sharedContext && sharedContextInspect !== inspect) {
    await closeSession();
  }

  const { xProfileDir } = dataPaths();
  const launchOpts = {
    headless: !inspect,
    // A real-ish viewport reduces the odds of X serving a degraded/mobile flow.
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  };

  let context: BrowserContext;
  try {
    // Preferred: drive an installed Chrome (no Chromium download).
    context = await chromium.launchPersistentContext(xProfileDir, {
      ...launchOpts,
      channel: "chrome",
    });
  } catch (chromeErr) {
    // Fallback: bundled Chromium (requires `npx playwright install chromium`).
    try {
      context = await chromium.launchPersistentContext(xProfileDir, launchOpts);
    } catch (bundledErr) {
      throw new Error(
        `[session] failed to launch a browser. Tried channel:'chrome' ` +
          `(${(chromeErr as Error).message}) and bundled chromium ` +
          `(${(bundledErr as Error).message}). Install Google Chrome, or run ` +
          `\`npx playwright install chromium\` for the bundled fallback.`,
      );
    }
  }

  sharedContext = context;
  sharedContextInspect = inspect;
  return context;
}

/** Get a Page to work with — reuse the first existing one or open a fresh tab. */
async function getWorkingPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages();
  return existing.length ? existing[0] : await context.newPage();
}

/**
 * Run the credential login flow against X_SELECTORS on the given page.
 * Sequence: username -> (optional email/phone challenge) -> password -> land.
 */
async function performLogin(page: Page): Promise<void> {
  ensureCredentials();

  await page.goto(X_SELECTORS.loginUrl, { waitUntil: "domcontentloaded" });

  // Step 1: username/handle.
  const userInput = await fillFirst(
    page,
    X_SELECTORS.usernameInput,
    env.X_USERNAME,
    "usernameInput",
  );
  await advance(page, userInput, X_SELECTORS.usernameNextButton);

  // Step 2 (conditional): X may interject the "confirm your email/phone" step,
  // OR may jump straight to the password. Probe for the challenge first.
  if (await isIdentifierChallenge(page)) {
    const challengeInput = await fillFirst(
      page,
      X_SELECTORS.identifierChallengeInput,
      env.X_EMAIL,
      "identifierChallengeInput",
    );
    await advance(page, challengeInput, X_SELECTORS.identifierChallengeNextButton);
  }

  // Step 3: password. Wait for the password field to surface (it may appear
  // immediately after username, or after the challenge step).
  const passwordInput = await fillFirst(
    page,
    X_SELECTORS.passwordInput,
    env.X_PASSWORD,
    "passwordInput",
  );
  await advance(page, passwordInput, X_SELECTORS.loginButton);

  // Step 4: confirm we landed. X redirects to /home on success.
  const landed = await isLoggedIn(page, LOGIN_LANDING_TIMEOUT);
  if (!landed) {
    throw new Error(
      `[session] login did not land on a logged-in page within ` +
        `${LOGIN_LANDING_TIMEOUT}ms. X may have raised an unhandled challenge ` +
        `(2FA / extra verification) or the selectors drifted. Re-run with ` +
        `--inspect to watch the flow and recalibrate X_SELECTORS in src/session.ts.`,
    );
  }
}

/** Map Playwright cookies to the minimal SessionCookie shape, keeping X auth cookies. */
function normalizeCookies(cookies: Cookie[]): SessionCookie[] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));
}

/**
 * Harvest cookies from the live context and write the auth-relevant ones to the
 * cookie cache. RETAINED but NOT a read path: the watcher reads by capturing
 * GraphQL responses in the shared browser (see module header / src/x/reader.ts),
 * not by injecting these cookies. We persist the FULL x/twitter cookie set (not
 * just auth_token + ct0) for completeness / possible future use, but require
 * auth_token + ct0 to consider the session valid.
 */
async function harvestAndCacheCookies(context: BrowserContext): Promise<SessionCookie[]> {
  const all = await context.cookies(["https://x.com", "https://twitter.com"]);
  const xCookies = normalizeCookies(all).filter(
    (c) => c.domain.includes("x.com") || c.domain.includes("twitter.com"),
  );

  const hasAuth = xCookies.some((c) => c.name === "auth_token");
  const hasCt0 = xCookies.some((c) => c.name === "ct0");
  if (!hasAuth || !hasCt0) {
    throw new Error(
      `[session] logged-in page detected but auth cookies are missing ` +
        `(auth_token=${hasAuth}, ct0=${hasCt0}). The session is not usable. ` +
        `Re-run ensureSession({ force: true }) or --inspect to recalibrate.`,
    );
  }

  writeFileSync(dataPaths().xCookieCache, JSON.stringify(xCookies, null, 2), {
    mode: 0o600,
  });
  return xCookies;
}

/** Read the cached cookies, if present and structurally valid. */
function readCachedCookies(): SessionCookie[] | null {
  const file = dataPaths().xCookieCache;
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as SessionCookie[];
    if (!Array.isArray(parsed)) return null;
    const hasAuth = parsed.some((c) => c.name === "auth_token");
    const hasCt0 = parsed.some((c) => c.name === "ct0");
    return hasAuth && hasCt0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a valid logged-in X session exists, logging in only if needed.
 *
 * Flow:
 *   1. Launch the persistent context (channel:'chrome', fallback chromium).
 *   2. Unless `force`, navigate to /home and check the logged-in signal. If the
 *      persisted profile is already authed, just (re)harvest cookies and return.
 *   3. Otherwise run the credential login flow (username -> optional email/phone
 *      challenge with X_EMAIL -> password -> wait for home).
 *   4. Harvest auth_token + ct0 (and the rest) to the cookie cache (retained as
 *      a session-validity signal, NOT a read path — see module header). The
 *      profile stays warm on disk so the next run skips straight to step 2.
 *
 * Idempotent + cheap when already authed. Leaves the shared context OPEN so BOTH
 * the watcher (GraphQL capture) and the publisher (composer) can drive the same
 * profile via getBrowserContext(); call closeSession() at process end.
 */
export async function ensureSession(opts: EnsureSessionOptions = {}): Promise<void> {
  const inspect = !!opts.inspect;
  const context = await launchContext(inspect);
  const page = await getWorkingPage(context);

  if (!opts.force) {
    // Cheap reuse path: the persistent profile may already be logged in.
    try {
      await page.goto(X_SELECTORS.homeUrl, { waitUntil: "domcontentloaded" });
      if (await isLoggedIn(page)) {
        await harvestAndCacheCookies(context);
        return;
      }
    } catch {
      // Navigation hiccup — fall through to a full login.
    }
  }

  await performLogin(page);
  await harvestAndCacheCookies(context);
}

/**
 * Return the harvested session cookies (auth_token + ct0 at minimum). Uses the
 * cache when valid; otherwise runs ensureSession() to (re)login and re-harvest.
 *
 * NOTE: this is NO LONGER the watcher's read path. The watcher now drives the
 * shared browser via getBrowserContext() and captures GraphQL responses (see
 * the module header and src/x/reader.ts). This accessor is retained for the
 * harvested-cookie surface (session-validity signal / possible future use) but
 * is not consumed by reads.
 */
export async function getCookies(opts: EnsureSessionOptions = {}): Promise<SessionCookie[]> {
  if (!opts.force) {
    const cached = readCachedCookies();
    if (cached) return cached;
  }
  await ensureSession(opts);
  const cached = readCachedCookies();
  if (!cached) {
    throw new Error(
      "[session] cookies unavailable after ensureSession — the cookie cache " +
        "was not written. Re-run with --inspect to debug the login flow.",
    );
  }
  return cached;
}

/**
 * Return the live, logged-in PERSISTENT browser context for the publisher to
 * drive the X composer. Same profile as ensureSession — never a second login.
 * The caller MUST NOT close the context directly; use closeSession() so the
 * shared handle is cleared.
 */
export async function getBrowserContext(
  opts: EnsureSessionOptions = {},
): Promise<BrowserContext> {
  await ensureSession(opts);
  if (!sharedContext) {
    // ensureSession always sets sharedContext; this guards against a torn-down race.
    throw new Error("[session] browser context unavailable after ensureSession.");
  }
  return sharedContext;
}

/**
 * Close the shared persistent context (flushes the profile to disk). Call once
 * at process shutdown. Safe to call when nothing is open.
 */
export async function closeSession(): Promise<void> {
  if (sharedContext) {
    const ctx = sharedContext;
    sharedContext = null;
    sharedContextInspect = null;
    try {
      await ctx.close();
    } catch {
      // Best-effort; the profile is persisted regardless.
    }
  }
}

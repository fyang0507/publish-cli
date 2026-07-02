/**
 * LinkedIn session manager — the persistent-profile backbone for the LinkedIn
 * PUBLISH capability (staging native feed-post drafts).
 *
 * MIRRORS src/session.ts (the X session) in STRUCTURE — a persistent Playwright
 * context, one unattended credential login, headful --inspect for calibration,
 * and the same ensureSession / getBrowserContext / closeSession surface — because
 * LinkedIn is a browser-driven channel with the same auth model as X (persistent
 * profile, credential login). See LINKEDIN_DESIGN.md §3.1: the browser-session
 * pattern preserves across browser-driven channels (X, LinkedIn, 小红书) and only
 * diverges for API channels (Reddit, WeChat).
 *
 * DELIBERATELY NOT REFACTORED into a shared createBrowserSession() factory yet —
 * the design doc proposes that lift (§3.1), but the shipped X session is
 * hard-to-live-test and must stay untouched. This module is a structural sibling,
 * not a fork of live-verified X code.
 *
 * Auth model: UNATTENDED credential auto-login over a PERSISTENT browser context.
 * Credentials come from env (config.ts): LI_USERNAME, LI_PASSWORD, LI_EMAIL.
 * LinkedIn may interrupt login with an email/identifier confirmation step — that
 * is answered with LI_EMAIL.
 *
 * Persistence:
 *   - The browser user-data-dir lives at dataPaths().liProfileDir (off Drive), so
 *     once logged in, subsequent runs are already authed and skip the flow.
 *   - After a successful login we harvest the session cookies to
 *     dataPaths().liCookieCache as JSON (a session-validity signal / for possible
 *     future use — the composer drives the live CONTEXT, not injected cookies).
 *
 * Selector drift: LinkedIn's login DOM changes like X's. All login selectors are
 * centralized in LI_LOGIN_SELECTORS below and every one is BEST-EFFORT and NEEDS
 * LIVE CALIBRATION — run with `--inspect` (headful) to watch the flow and update
 * them. None of this is trustworthy until verified live (CLAUDE.md "Verify live").
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dataPaths, env } from "../config.js";
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
   * selectors when LinkedIn's DOM drifts. Wired to the CLI --inspect flag.
   */
  inspect?: boolean;
  /** Force a fresh login even if the persisted profile/cookies look valid. */
  force?: boolean;
}

/**
 * Centralized, BEST-EFFORT LinkedIn login selectors. EVERY entry below NEEDS LIVE
 * CALIBRATION against the current linkedin.com/login DOM — LinkedIn drifts its
 * login markup and interjects checkpoint/identity steps. Each field is a list of
 * candidate strategies tried IN ORDER until one resolves (with explicit waits).
 * When recalibrating, run with `inspect: true` (CLI --inspect) to watch the live
 * flow and update the strategies here.
 *
 * Strategy syntax: a string starting with "//" is treated as XPath; everything
 * else is a Playwright CSS / pseudo-selector (supports :has-text()).
 */
export const LI_LOGIN_SELECTORS = {
  loginUrl: "https://www.linkedin.com/login",
  homeUrl: "https://www.linkedin.com/feed/",

  // Username / email field. CALIBRATED LIVE 2026-07: LinkedIn now renders DYNAMIC
  // React ids (e.g. «Refvd3ksopa55j6», not id="username") AND a duplicate HIDDEN
  // copy of the form. The `:visible` filter is REQUIRED — without it .first()
  // grabs the hidden duplicate and waitFor(visible) times out (the original bug).
  // The visible field is type=email autocomplete="username webauthn".
  usernameInput: [
    'input[autocomplete*="username"]:visible',
    'input[type="email"]:visible',
    "input#username", // legacy fallback
    'input[name="session_key"]', // legacy fallback
  ],
  // Password field. CALIBRATED LIVE 2026-07: same hidden-duplicate issue — the
  // `:visible` filter is required.
  passwordInput: [
    'input[type="password"]:visible',
    'input[autocomplete="current-password"]:visible',
    "input#password", // legacy fallback
    'input[name="session_password"]', // legacy fallback
  ],
  // Submit button. CALIBRATED LIVE 2026-07: the sign-in control is a
  // <button type="button"> with text "Sign in" (NOT type=submit), and there is a
  // decoy "Sign in with Apple". In practice advance() SUBMITS BY PRESSING ENTER on
  // the focused password field (verified to log in), so these are best-effort — a
  // miss safely falls through to the Enter submit.
  submitButton: [
    'button[aria-label="Sign in"]:visible',
    'button[type="submit"]:visible',
    '//button[normalize-space()="Sign in"]',
  ],

  // CONDITIONAL email/identifier confirmation ("enter the email associated with
  // your account" / checkpoint). Answered with LI_EMAIL. BEST-EFFORT — LinkedIn
  // injects checkpoints unpredictably; gated on CHALLENGE_PROMPT_HINTS below.
  identifierChallengeInput: [
    'input[name="email-address"]:visible',
    'input[name="emailAddress"]:visible',
    'input[autocomplete="email"]:visible',
    'input[type="email"]:visible',
  ],
  identifierChallengeSubmit: [
    'button[type="submit"]:visible',
    '//button[normalize-space()="Submit"]',
    '//button[normalize-space()="Verify"]',
    'button:has-text("Submit"):visible',
  ],

  // Logged-in signal (used by isLoggedIn()/ensureSession()). CALIBRATED LIVE
  // 2026-07: LinkedIn's feed uses HASHED, unstable class names, so the old
  // search-typeahead class / combobox role no longer match. The durable markers
  // now are the global search input's placeholder and the top-nav Home button.
  // LOCALE NOTE: placeholder + Home aria-label are English-UI text (best-effort).
  loggedInSignal: [
    'input[placeholder*="looking for"]',
    'button[aria-label^="Home"]',
    "input.search-global-typeahead__input", // legacy fallback
    'button[aria-label*="Start a post"]', // legacy fallback
  ],
} as const;

/**
 * Substrings that, if visible, indicate LinkedIn is showing an email/identifier
 * confirmation interstitial. Used to decide whether to answer with LI_EMAIL.
 * Best-effort / English-locale; CALIBRATE for other UI languages.
 */
const CHALLENGE_PROMPT_HINTS = [
  "enter the email",
  "email associated with your account",
  "confirm your email",
  "verify your identity",
  "let's do a quick security check",
  "we noticed some unusual activity",
];

// Default explicit-wait budgets (ms). Generous because login round-trips and
// LinkedIn's interstitials can be slow; never use fixed sleeps.
const SELECTOR_TIMEOUT = 15_000;
const LOGIN_LANDING_TIMEOUT = 45_000;

// ---------------------------------------------------------------------------
// Module-level singleton context (the publisher drives ONE logged-in profile).
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
 * element becomes visible within `timeout`. Returns null if none resolve (caller
 * decides whether that's fatal — e.g. the identifier challenge is optional). This
 * is the single tolerant lookup primitive so drift is handled uniformly.
 */
async function findFirst(
  page: Page,
  strategies: readonly string[],
  timeout = SELECTOR_TIMEOUT,
): Promise<ReturnType<Page["locator"]> | null> {
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
      `[li-session] could not locate ${label} on the LinkedIn login page. ` +
        `Selectors likely drifted — re-run with --inspect to recalibrate ` +
        `LI_LOGIN_SELECTORS.${label} in src/linkedin/session.ts. Tried: ${strategies.join(" | ")}`,
    );
  }
  await locator.fill(value);
  return locator;
}

/**
 * Advance a login step: click the first resolving button if present, otherwise
 * submit by pressing Enter on the just-filled (focused) input.
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

/**
 * Detect a logged-in signal on the current page. Best-effort and tolerant: any
 * one of the loggedInSignal strategies resolving counts as logged in.
 */
async function isLoggedIn(page: Page, timeout = SELECTOR_TIMEOUT): Promise<boolean> {
  const locator = await findFirst(page, LI_LOGIN_SELECTORS.loggedInSignal, timeout);
  return locator !== null;
}

/**
 * Heuristic: is an email/identifier confirmation interstitial showing? We check
 * for a visible challenge input AND a prompt-text hint (the input often overlaps
 * with a generic email field).
 */
async function isIdentifierChallenge(page: Page): Promise<boolean> {
  const input = await findFirst(page, LI_LOGIN_SELECTORS.identifierChallengeInput, 4000);
  if (!input) return false;
  try {
    const bodyText = (await page.locator("body").innerText({ timeout: 2000 })).toLowerCase();
    return CHALLENGE_PROMPT_HINTS.some((hint) => bodyText.includes(hint));
  } catch {
    return false;
  }
}

function ensureCredentials(): void {
  const missing: string[] = [];
  if (!env.LI_USERNAME) missing.push("LI_USERNAME");
  if (!env.LI_PASSWORD) missing.push("LI_PASSWORD");
  if (!env.LI_EMAIL) missing.push("LI_EMAIL");
  if (missing.length) {
    throw new Error(
      `[li-session] missing LinkedIn credential(s): ${missing.join(", ")}. ` +
        `Add them to .env (see .env.example). publish-cli does an unattended ` +
        `credential login — there is no cookie-paste fallback.`,
    );
  }
}

/**
 * Launch (or reuse) the persistent LinkedIn browser context rooted at the
 * off-Drive profile dir. Prefers an installed Chrome (channel:'chrome') to avoid
 * downloading Chromium onto the Drive path; falls back to bundled Chromium.
 */
async function launchContext(inspect: boolean): Promise<BrowserContext> {
  if (sharedContext && sharedContextInspect === inspect) return sharedContext;
  if (sharedContext && sharedContextInspect !== inspect) {
    await closeSession();
  }

  const { liProfileDir } = dataPaths();
  const launchOpts = {
    headless: !inspect,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  };

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(liProfileDir, {
      ...launchOpts,
      channel: "chrome",
    });
  } catch (chromeErr) {
    try {
      context = await chromium.launchPersistentContext(liProfileDir, launchOpts);
    } catch (bundledErr) {
      throw new Error(
        `[li-session] failed to launch a browser. Tried channel:'chrome' ` +
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
 * Run the credential login flow against LI_LOGIN_SELECTORS on the given page.
 * Sequence: username + password -> submit -> (optional email/identifier
 * challenge) -> land on the feed.
 */
async function performLogin(page: Page): Promise<void> {
  ensureCredentials();

  await page.goto(LI_LOGIN_SELECTORS.loginUrl, { waitUntil: "domcontentloaded" });

  // LinkedIn's classic login shows username + password on ONE page.
  await fillFirst(page, LI_LOGIN_SELECTORS.usernameInput, env.LI_USERNAME, "usernameInput");
  const passwordInput = await fillFirst(
    page,
    LI_LOGIN_SELECTORS.passwordInput,
    env.LI_PASSWORD,
    "passwordInput",
  );
  await advance(page, passwordInput, LI_LOGIN_SELECTORS.submitButton);

  // CONDITIONAL: LinkedIn may interject an email/identifier confirmation.
  if (await isIdentifierChallenge(page)) {
    const challengeInput = await fillFirst(
      page,
      LI_LOGIN_SELECTORS.identifierChallengeInput,
      env.LI_EMAIL,
      "identifierChallengeInput",
    );
    await advance(page, challengeInput, LI_LOGIN_SELECTORS.identifierChallengeSubmit);
  }

  const landed = await isLoggedIn(page, LOGIN_LANDING_TIMEOUT);
  if (!landed) {
    throw new Error(
      `[li-session] login did not land on a logged-in page within ` +
        `${LOGIN_LANDING_TIMEOUT}ms. LinkedIn may have raised an unhandled ` +
        `checkpoint (CAPTCHA / 2FA / device verification) or the selectors ` +
        `drifted. Re-run with --inspect to watch the flow and recalibrate ` +
        `LI_LOGIN_SELECTORS in src/linkedin/session.ts.`,
    );
  }
}

/** Map Playwright cookies to the minimal SessionCookie shape. */
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
 * Harvest cookies from the live context and write the LinkedIn ones to the cookie
 * cache. RETAINED as a session-validity signal / for possible future use — the
 * composer drives the shared CONTEXT, not injected cookies. LinkedIn's auth
 * cookie is `li_at`; we require it to consider the session valid.
 */
async function harvestAndCacheCookies(context: BrowserContext): Promise<SessionCookie[]> {
  const all = await context.cookies(["https://www.linkedin.com", "https://linkedin.com"]);
  const liCookies = normalizeCookies(all).filter((c) => c.domain.includes("linkedin.com"));

  const hasAuth = liCookies.some((c) => c.name === "li_at");
  if (!hasAuth) {
    throw new Error(
      `[li-session] logged-in page detected but the li_at auth cookie is missing. ` +
        `The session is not usable. Re-run ensureSession({ force: true }) or ` +
        `--inspect to recalibrate.`,
    );
  }

  writeFileSync(dataPaths().liCookieCache, JSON.stringify(liCookies, null, 2), {
    mode: 0o600,
  });
  return liCookies;
}

/** Read the cached cookies, if present and structurally valid (has li_at). */
function readCachedCookies(): SessionCookie[] | null {
  const file = dataPaths().liCookieCache;
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as SessionCookie[];
    if (!Array.isArray(parsed)) return null;
    return parsed.some((c) => c.name === "li_at") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a valid logged-in LinkedIn session exists, logging in only if needed.
 *
 * Flow:
 *   1. Launch the persistent context (channel:'chrome', fallback chromium).
 *   2. Unless `force`, navigate to /feed and check the logged-in signal. If the
 *      persisted profile is already authed, just (re)harvest cookies and return.
 *   3. Otherwise run the credential login flow (username + password -> optional
 *      email/identifier challenge with LI_EMAIL -> wait for the feed).
 *   4. Harvest the li_at cookie (and the rest) to the cookie cache. The profile
 *      stays warm on disk so the next run skips straight to step 2.
 *
 * Idempotent + cheap when already authed. Leaves the shared context OPEN so the
 * publisher (composer) can drive it via getBrowserContext(); call closeSession()
 * at process end.
 */
export async function ensureSession(opts: EnsureSessionOptions = {}): Promise<void> {
  const inspect = !!opts.inspect;
  const context = await launchContext(inspect);
  const page = await getWorkingPage(context);

  if (!opts.force) {
    try {
      await page.goto(LI_LOGIN_SELECTORS.homeUrl, { waitUntil: "domcontentloaded" });
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
 * Return the harvested session cookies (li_at at minimum). Uses the cache when
 * valid; otherwise runs ensureSession() to (re)login and re-harvest. Retained for
 * the harvested-cookie surface (session-validity signal / possible future use).
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
      "[li-session] cookies unavailable after ensureSession — the cookie cache " +
        "was not written. Re-run with --inspect to debug the login flow.",
    );
  }
  return cached;
}

/**
 * Return the live, logged-in PERSISTENT browser context for the publisher to
 * drive the LinkedIn composer. Same profile as ensureSession — never a second
 * login. The caller MUST NOT close the context directly; use closeSession() so
 * the shared handle is cleared.
 */
export async function getBrowserContext(
  opts: EnsureSessionOptions = {},
): Promise<BrowserContext> {
  await ensureSession(opts);
  if (!sharedContext) {
    throw new Error("[li-session] browser context unavailable after ensureSession.");
  }
  return sharedContext;
}

/**
 * Close the shared persistent context (flushes the profile to disk). Call once at
 * process shutdown. Safe to call when nothing is open.
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

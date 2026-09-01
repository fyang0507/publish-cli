/**
 * Reddit session manager — the persistent-profile backbone for the Reddit PUBLISH
 * capability (staging native self-post drafts) and the authenticated JSON reads
 * (inspect / search / preflight) that drive off the same logged-in context.
 *
 * MIRRORS src/session.ts (X) and src/linkedin/session.ts in STRUCTURE — a
 * persistent Playwright context, one unattended credential login, headful
 * --inspect for calibration, and the same ensureSession / getBrowserContext /
 * getCookies / closeSession surface — because Reddit is a browser-driven channel
 * with the same auth model (persistent profile, credential login). See
 * REDDIT_DESIGN.md §3.2: Reddit joins X, LinkedIn (and 小红书) as browser-driven;
 * only WeChat stays API-driven.
 *
 * DELIBERATELY NOT REFACTORED into a shared createBrowserSession() factory — same
 * posture as LinkedIn (AGENTS.md): the shipped X session is hard-to-live-test and
 * must stay untouched, so this is a structural sibling, not a fork of live-verified
 * X code. It does NOT share X's src/session.ts.
 *
 * Auth model: UNATTENDED credential auto-login over a PERSISTENT browser context.
 * Credentials come from env (config.ts): REDDIT_USERNAME, REDDIT_PASSWORD, and
 * REDDIT_EMAIL (only consumed IF Reddit interjects an email/identifier challenge).
 *
 * CAPTCHA-HEAVY FIRST LOGIN — IMPORTANT: Reddit's login is the highest onboarding
 * risk of any channel here. It routinely raises a CAPTCHA / bot check that CANNOT
 * be solved unattended. The FIRST login MUST be run HEADFUL via `--inspect`
 * (inspect: true) so a human can solve the challenge in the visible browser; after
 * that the persisted profile (redditProfileDir) keeps the session warm and later
 * runs skip the flow. A headless first login will fail at the CAPTCHA — this is a
 * hard constraint, exactly like X blocking headless login.
 *
 * Persistence:
 *   - The browser user-data-dir lives at dataPaths().redditProfileDir (off Drive),
 *     so once logged in, subsequent runs are already authed and skip the flow.
 *   - After a successful login we harvest the session cookies to
 *     dataPaths().redditCookieCache as JSON (a session-validity signal / for
 *     possible future use — the reader/composer drive the live CONTEXT, not
 *     injected cookies).
 *
 * Selector drift: Reddit's login DOM changes like X's / LinkedIn's. All login
 * selectors are centralized in REDDIT_LOGIN_SELECTORS below and every one is
 * BEST-EFFORT and NEEDS LIVE CALIBRATION — run with `--inspect` (headful) to watch
 * the flow and update them. None of this is trustworthy until verified live
 * (AGENTS.md "Verify live").
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
   * Headful + slowed-down so a human can watch the login flow, SOLVE THE CAPTCHA
   * (Reddit's login is captcha-heavy — first login must be headful), and
   * re-calibrate selectors when Reddit's DOM drifts. Wired to the CLI --inspect
   * flag.
   */
  inspect?: boolean;
  /** Force a fresh login even if the persisted profile/cookies look valid. */
  force?: boolean;
  /**
   * When true (default), a logged-in session is required — the credential login
   * flow runs if the persisted profile isn't already authed (the write path). Set
   * to false via getBrowserContext() to obtain an ANONYMOUS read context: the
   * persistent context is launched/returned WITHOUT performLogin / ensureCredentials
   * so logged-out reads (inspect / search) proceed even without credentials. If the
   * profile already carries a session, reads run authed; otherwise logged-out.
   */
  requireLogin?: boolean;
}

/**
 * Centralized, BEST-EFFORT Reddit login selectors. EVERY entry below NEEDS LIVE
 * CALIBRATION against the current reddit.com/login DOM — Reddit renders its login
 * inside faceplate/shadowed web components, drifts its markup, and (crucially)
 * interjects a CAPTCHA / bot check that only a human can solve. Each field is a
 * list of candidate strategies tried IN ORDER until one resolves (with explicit
 * waits). When recalibrating, run with `inspect: true` (CLI --inspect) to watch
 * the live flow and update the strategies here.
 *
 * Strategy syntax: a string starting with "//" is treated as XPath; everything
 * else is a Playwright CSS / pseudo-selector (supports :has-text()). Playwright
 * pierces open shadow roots for CSS selectors, so faceplate inputs are reachable.
 */
export const REDDIT_LOGIN_SELECTORS = {
  loginUrl: "https://www.reddit.com/login/",
  homeUrl: "https://www.reddit.com/",

  // Username field. LIVE-CALIBRATED 2026-07 (verified against real Reddit):
  // input[name="username"]:visible resolves (count=1). The autocomplete value is
  // "username webauthn", so match with ~= (whitespace-separated token), not =.
  usernameInput: [
    'input[name="username"]:visible',
    'input[autocomplete~="username"]',
    'input[type="text"]:visible',
  ],
  // Password field. LIVE-CALIBRATED 2026-07: input[name="password"]:visible
  // resolves (verified); autocomplete="current-password" kept as a fallback.
  passwordInput: [
    'input[name="password"]:visible',
    'input[autocomplete="current-password"]:visible',
    'input[type="password"]:visible',
  ],
  // Submit button. LIVE-CALIBRATED 2026-07: the control is type="button" (NOT
  // type="submit"), labeled "Log In" (count=1 verified) — so the text/xpath
  // strategies lead. advance() falls back to pressing Enter on the focused
  // password field if none of these resolve.
  submitButton: [
    '//button[normalize-space()="Log In"]',
    'button:has-text("Log In"):visible',
    '//button[normalize-space()="Log in"]',
  ],

  // CONDITIONAL email/identifier confirmation (Reddit may ask you to confirm the
  // email associated with the account, or verify identity). Answered with
  // REDDIT_EMAIL. BEST-EFFORT / NEEDS LIVE CALIBRATION; gated on
  // CHALLENGE_PROMPT_HINTS below. NOTE: a CAPTCHA is NOT this — a CAPTCHA has no
  // input to fill and requires the headful --inspect manual solve.
  identifierChallengeInput: [
    'input[name="email"]:visible',
    'input[autocomplete="email"]:visible',
    'input[type="email"]:visible',
  ],
  identifierChallengeSubmit: [
    'button[type="submit"]:visible',
    '//button[normalize-space()="Continue"]',
    '//button[normalize-space()="Verify"]',
    '//button[normalize-space()="Submit"]',
    'button:has-text("Continue"):visible',
  ],

  // Logged-in signal (used by isLoggedIn()/ensureSession()). CALIBRATED LIVE
  // 2026-07-03 against the authenticated www.reddit.com shell (release web3x /
  // 2026-07-02). The durable marker is the `user-logged-in` ATTRIBUTE Reddit
  // stamps on its <shreddit-app> root element — it reads "true" when authed and
  // "false"/absent otherwise, so it is both reliable and locale-independent (no
  // aria-label text to drift). The user-drawer (avatar menu) button is the
  // secondary marker; it renders ONLY when logged in.
  //
  // Do NOT add `a[href^="/submit"]`, `a[aria-label="Create post"]`, or the chat
  // button here: Reddit renders those on the LOGGED-OUT shell too (they open the
  // login modal), so isLoggedIn() would false-positive → skip credential login →
  // cookie harvest throws "reddit_session cookie missing". Likewise avoid
  // `a[href^="/user/"]`, which also matches logged-out post-author links. A
  // false-NEGATIVE here is the safe direction (it just re-attempts login).
  // NOTE: the prior avatar/user_avatar/#USER_DROPDOWN_ID markers were STALE
  // (all resolved 0 on the live authed page — the cause of a failed login-land).
  loggedInSignal: [
    'shreddit-app[user-logged-in="true"]',
    "button#expand-user-drawer-button",
  ],
} as const;

/**
 * Substrings that, if visible, indicate Reddit is showing an email/identifier
 * confirmation interstitial (as opposed to a CAPTCHA, which has no fillable
 * input). Used to decide whether to answer with REDDIT_EMAIL. Best-effort /
 * English-locale; CALIBRATE for other UI languages.
 */
const CHALLENGE_PROMPT_HINTS = [
  "confirm your email",
  "verify your email",
  "email associated with your account",
  "enter your email",
  "verify your identity",
  "help us keep your account safe",
];

// Default explicit-wait budgets (ms). Generous because login round-trips and
// Reddit's interstitials (incl. a human-solved CAPTCHA under --inspect) can be
// slow; never use fixed sleeps.
const SELECTOR_TIMEOUT = 15_000;
// Headless landing budget — SHORT on purpose: without a human there's no way to
// solve the captcha, so fail fast with the re-run-with-inspect hint rather than
// hang.
const LOGIN_LANDING_TIMEOUT = 30_000;
// Manual-login budget under --inspect: the operator solves the JS bot-challenge /
// CAPTCHA and can finish login BY HAND in the visible browser; we poll for the
// logged-in signal for this long before giving up.
const MANUAL_LOGIN_TIMEOUT = 180_000;
// How long to wait for the login FORM to attach after navigating to /login.
// www.reddit.com/login first serves a JS bot-challenge interstitial (URL gains
// ?js_challenge=1&token=…) that has ZERO inputs and needs several seconds of JS
// to clear before the real form mounts.
const LOGIN_FORM_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Module-level singleton context (the publisher/reader drive ONE logged-in
// profile).
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
      `[reddit-session] could not locate ${label} on the Reddit login page. ` +
        `Selectors likely drifted — re-run with --inspect to recalibrate ` +
        `REDDIT_LOGIN_SELECTORS.${label} in src/reddit/session.ts. Tried: ${strategies.join(" | ")}`,
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
  const locator = await findFirst(page, REDDIT_LOGIN_SELECTORS.loggedInSignal, timeout);
  return locator !== null;
}

/**
 * Heuristic: is an email/identifier confirmation interstitial showing? We check
 * for a visible challenge input AND a prompt-text hint (the input often overlaps
 * with a generic email field). A CAPTCHA — which has no fillable input — is NOT
 * matched here; it is solved by the human under --inspect.
 */
async function isIdentifierChallenge(page: Page): Promise<boolean> {
  const input = await findFirst(page, REDDIT_LOGIN_SELECTORS.identifierChallengeInput, 4000);
  if (!input) return false;
  try {
    const bodyText = (await page.locator("body").innerText({ timeout: 2000 })).toLowerCase();
    return CHALLENGE_PROMPT_HINTS.some((hint) => bodyText.includes(hint));
  } catch {
    return false;
  }
}

/**
 * Verify the core (always-required) credentials are present. REDDIT_EMAIL is
 * NOT required up front — it is only consumed if Reddit raises the optional
 * email/identifier challenge (performLogin throws a targeted error there if it is
 * needed but missing).
 */
function ensureCredentials(): void {
  const missing: string[] = [];
  if (!env.REDDIT_USERNAME) missing.push("REDDIT_USERNAME");
  if (!env.REDDIT_PASSWORD) missing.push("REDDIT_PASSWORD");
  if (missing.length) {
    throw new Error(
      `[reddit-session] missing Reddit credential(s): ${missing.join(", ")}. ` +
        `Add them to .env (see .env.example). publish-cli does an unattended ` +
        `credential login — there is no cookie-paste fallback. (REDDIT_EMAIL is ` +
        `only needed if Reddit raises an email confirmation challenge.)`,
    );
  }
}

/**
 * Launch (or reuse) the persistent Reddit browser context rooted at the off-Drive
 * profile dir. Prefers an installed Chrome (channel:'chrome') to avoid downloading
 * Chromium onto the Drive path; falls back to bundled Chromium.
 */
async function launchContext(inspect: boolean): Promise<BrowserContext> {
  if (sharedContext && sharedContextInspect === inspect) return sharedContext;
  if (sharedContext && sharedContextInspect !== inspect) {
    await closeSession();
  }

  const { redditProfileDir } = dataPaths();
  // locale + timezoneId make the context look like a real browser — Reddit's JS
  // bot-challenge interstitial only auto-clears with a realistic context.
  const launchOpts = {
    headless: !inspect,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    args: ["--disable-blink-features=AutomationControlled"],
  };

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(redditProfileDir, {
      ...launchOpts,
      channel: "chrome",
    });
  } catch (chromeErr) {
    try {
      context = await chromium.launchPersistentContext(redditProfileDir, launchOpts);
    } catch (bundledErr) {
      throw new Error(
        `[reddit-session] failed to launch a browser. Tried channel:'chrome' ` +
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
 * Run the credential login flow against REDDIT_LOGIN_SELECTORS on the given page.
 * Sequence: navigate -> WAIT for the form to clear the JS bot-challenge -> fill
 * username + password -> submit -> (optional email/identifier challenge, and/or a
 * human-solved CAPTCHA under --inspect) -> land logged in.
 *
 * The REAL first-login failure was TIMING, not selectors: www.reddit.com/login
 * first serves a JS bot-challenge interstitial (URL gains ?js_challenge=1&token=…)
 * that has ZERO inputs and needs several seconds of JS to clear before the form
 * attaches — so we explicitly wait for the username input before probing.
 *
 * `inspect` toggles the MANUAL-LOGIN posture: Reddit login requires solving a
 * CAPTCHA that automation cannot. Under --inspect (headful) any auto-fill hiccup
 * is NON-fatal — we give the operator up to MANUAL_LOGIN_TIMEOUT to solve the
 * challenge / finish login BY HAND in the visible browser. The headless path stays
 * strict: short wait, then throw with the re-run-with-inspect hint.
 */
async function performLogin(page: Page, inspect: boolean): Promise<void> {
  // Credentials are required for the UNATTENDED path. Under --inspect a human can
  // finish by hand, so missing creds is non-fatal there (auto-fill is skipped).
  if (!inspect) ensureCredentials();

  await page.goto(REDDIT_LOGIN_SELECTORS.loginUrl, { waitUntil: "domcontentloaded" });

  // Wait for the login form to clear the JS bot-challenge interstitial and attach.
  // Under --inspect this same window lets the human start solving the captcha.
  try {
    await page.waitForSelector('input[name="username"]', {
      state: "visible",
      timeout: LOGIN_FORM_TIMEOUT,
    });
  } catch {
    if (!inspect) {
      throw new Error(
        `[reddit-session] the Reddit login form never attached within ` +
          `${LOGIN_FORM_TIMEOUT}ms — www.reddit.com/login first serves a JS ` +
          `bot-challenge interstitial (?js_challenge=1&token=…) that must clear ` +
          `before the form mounts, and headless couldn't get past it. The FIRST ` +
          `login MUST be headful — re-run with --inspect to SOLVE THE CAPTCHA by ` +
          `hand and (if needed) recalibrate REDDIT_LOGIN_SELECTORS in ` +
          `src/reddit/session.ts.`,
      );
    }
    // Under --inspect, don't give up: fall through so the human can drive the
    // browser (clear the challenge / log in by hand) within the manual window.
  }

  // Best-effort auto-fill. Reddit's login shows username + password on ONE page.
  // Under --inspect any hiccup here is swallowed — the human finishes by hand.
  try {
    if (env.REDDIT_USERNAME && env.REDDIT_PASSWORD) {
      await fillFirst(
        page,
        REDDIT_LOGIN_SELECTORS.usernameInput,
        env.REDDIT_USERNAME,
        "usernameInput",
      );
      const passwordInput = await fillFirst(
        page,
        REDDIT_LOGIN_SELECTORS.passwordInput,
        env.REDDIT_PASSWORD,
        "passwordInput",
      );
      await advance(page, passwordInput, REDDIT_LOGIN_SELECTORS.submitButton);

      // CONDITIONAL: Reddit may interject an email/identifier confirmation.
      if (await isIdentifierChallenge(page)) {
        if (!env.REDDIT_EMAIL) {
          throw new Error(
            `[reddit-session] Reddit raised an email/identifier confirmation but ` +
              `REDDIT_EMAIL is not set. Add REDDIT_EMAIL to .env and re-run ` +
              `(with --inspect to watch the flow).`,
          );
        }
        const challengeInput = await fillFirst(
          page,
          REDDIT_LOGIN_SELECTORS.identifierChallengeInput,
          env.REDDIT_EMAIL,
          "identifierChallengeInput",
        );
        await advance(page, challengeInput, REDDIT_LOGIN_SELECTORS.identifierChallengeSubmit);
      }
    }
  } catch (fillErr) {
    if (!inspect) throw fillErr;
    // Under --inspect the operator takes over; swallow and wait for the signal.
  }

  // Wait to land logged in. Under --inspect the long window covers the human
  // solving the CAPTCHA in the visible browser; headless stays short + strict.
  const landingTimeout = inspect ? MANUAL_LOGIN_TIMEOUT : LOGIN_LANDING_TIMEOUT;
  const landed = await isLoggedIn(page, landingTimeout);
  if (!landed) {
    throw new Error(
      `[reddit-session] login did not land on a logged-in page within ` +
        `${landingTimeout}ms. Reddit likely raised a CAPTCHA / bot check ` +
        `(it is captcha-heavy) or an unhandled 2FA/device step, or the selectors ` +
        `drifted. The FIRST login MUST be headful — re-run with --inspect to ` +
        `SOLVE THE CAPTCHA by hand and recalibrate REDDIT_LOGIN_SELECTORS in ` +
        `src/reddit/session.ts.`,
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
 * Harvest cookies from the live context and write the Reddit ones to the cookie
 * cache. RETAINED as a session-validity signal / for possible future use — the
 * reader/composer drive the shared CONTEXT, not injected cookies. Reddit's auth
 * cookie is `reddit_session` (the analog of X's auth_token / LinkedIn's li_at);
 * we require it to consider the session valid.
 */
async function harvestAndCacheCookies(context: BrowserContext): Promise<SessionCookie[]> {
  const all = await context.cookies(["https://www.reddit.com", "https://reddit.com"]);
  const redditCookies = normalizeCookies(all).filter((c) => c.domain.includes("reddit.com"));

  const hasAuth = redditCookies.some((c) => c.name === "reddit_session");
  if (!hasAuth) {
    throw new Error(
      `[reddit-session] logged-in page detected but the reddit_session auth ` +
        `cookie is missing. The session is not usable. Re-run ` +
        `ensureSession({ force: true }) or --inspect to recalibrate.`,
    );
  }

  writeFileSync(dataPaths().redditCookieCache, JSON.stringify(redditCookies, null, 2), {
    mode: 0o600,
  });
  return redditCookies;
}

/** Read the cached cookies, if present and structurally valid (has reddit_session). */
function readCachedCookies(): SessionCookie[] | null {
  const file = dataPaths().redditCookieCache;
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as SessionCookie[];
    if (!Array.isArray(parsed)) return null;
    return parsed.some((c) => c.name === "reddit_session") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a valid logged-in Reddit session exists, logging in only if needed.
 *
 * Flow:
 *   1. Launch the persistent context (channel:'chrome', fallback chromium).
 *   2. Unless `force`, navigate home and check the logged-in signal. If the
 *      persisted profile is already authed, just (re)harvest cookies and return.
 *   3. Otherwise run the credential login flow (username + password -> optional
 *      email/identifier challenge with REDDIT_EMAIL, and/or a human-solved CAPTCHA
 *      under --inspect -> wait to land logged in).
 *   4. Harvest the reddit_session cookie (and the rest) to the cookie cache. The
 *      profile stays warm on disk so the next run skips straight to step 2.
 *
 * Idempotent + cheap when already authed. Leaves the shared context OPEN so the
 * reader/composer can drive it via getBrowserContext(); call closeSession() at
 * process end.
 *
 * FIRST-LOGIN REMINDER: run headful (opts.inspect: true / CLI --inspect) — Reddit
 * is captcha-heavy and a headless first login will stall at the bot check.
 */
export async function ensureSession(opts: EnsureSessionOptions = {}): Promise<void> {
  const inspect = !!opts.inspect;
  const context = await launchContext(inspect);
  const page = await getWorkingPage(context);

  if (!opts.force) {
    try {
      await page.goto(REDDIT_LOGIN_SELECTORS.homeUrl, { waitUntil: "domcontentloaded" });
      if (await isLoggedIn(page)) {
        await harvestAndCacheCookies(context);
        return;
      }
    } catch {
      // Navigation hiccup — fall through to a full login.
    }
  }

  await performLogin(page, inspect);
  await harvestAndCacheCookies(context);
}

/**
 * Return the harvested session cookies (reddit_session at minimum). Uses the cache
 * when valid; otherwise runs ensureSession() to (re)login and re-harvest. Retained
 * for the harvested-cookie surface (session-validity signal / possible future
 * use).
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
      "[reddit-session] cookies unavailable after ensureSession — the cookie " +
        "cache was not written. Re-run with --inspect to debug the login flow.",
    );
  }
  return cached;
}

/**
 * Return the live PERSISTENT browser context for the reader (JSON reads / response
 * capture) and the composer to drive. Same profile as ensureSession — never a
 * second login. The caller MUST NOT close the context directly; use closeSession()
 * so the shared handle is cleared.
 *
 * By default this requires a logged-in session (the write path). Pass
 * `requireLogin: false` for an ANONYMOUS read context (inspect / search): the
 * persistent context is launched WITHOUT performLogin / ensureCredentials, so reads
 * proceed logged-out (or authed, if the profile already carries a session). We
 * still navigate www.reddit.com once so the anonymous edgebucket cookie is set and
 * the JS bot-challenge clears before the reader drives it (the reader may also do
 * its own page.goto).
 */
export async function getBrowserContext(
  opts: EnsureSessionOptions = {},
): Promise<BrowserContext> {
  if (opts.requireLogin === false) {
    const inspect = !!opts.inspect;
    const context = await launchContext(inspect);
    const page = await getWorkingPage(context);
    try {
      await page.goto(REDDIT_LOGIN_SELECTORS.homeUrl, { waitUntil: "domcontentloaded" });
    } catch {
      // Best-effort priming; the reader does its own navigation too.
    }
    return context;
  }

  await ensureSession(opts);
  if (!sharedContext) {
    throw new Error("[reddit-session] browser context unavailable after ensureSession.");
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

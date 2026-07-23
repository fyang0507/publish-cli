#!/usr/bin/env node
/**
 * XHS LOGIN-TTS SPIKE — throwaway feasibility probe. NOT part of the CLI.
 *
 * PURPOSE: measure how long a 小红书 creator-platform login PERSISTS in a
 * persistent Playwright profile — the gating unknown for whether an XHS channel
 * can reuse the X/LinkedIn/Reddit "one headful login, then warm session" model,
 * or whether XHS forces a QR re-scan often enough to change the whole user flow.
 *
 * READ-ONLY / NEVER POSTS: this script only navigates to the creator dashboard
 * and READS whether the session is logged in. It never opens the composer, never
 * uploads, never clicks 发布. It is a login-state probe, nothing else.
 *
 * XHS auth is QR-SCAN (no username/password), so there is no unattended login —
 * the FIRST run is headful and waits for you to scan the QR with the Xiaohongshu
 * app. Subsequent runs check whether that session survived.
 *
 * HOW TO MEASURE TTS (time-to-session-expiry):
 *   1. Run it once:  `node scripts/xhs-login-spike.mjs`
 *      A visible Chrome opens. Scan the QR in the 小红书 app to log in.
 *      The script records the login timestamp and exits.
 *   2. Re-run it later (hours / next day / days later), WITHOUT logging in:
 *      `node scripts/xhs-login-spike.mjs`
 *      It reports SESSION ALIVE or EXPIRED, and how long since first login.
 *   Repeat step 2 over increasing gaps to bracket the persistence window.
 *
 * The profile lives OFF any synced drive, under PUBLISH_DATA_DIR (default
 * ~/.publish-cli), exactly like the real channels' profiles — so the spike's
 * persistence behavior matches what a real xhs-profile would see.
 *
 * `node scripts/xhs-login-spike.mjs --reset` wipes the spike profile + state to
 * start a clean measurement.
 */

import { chromium } from "playwright";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";

// ---- paths (mirror config.ts resolveBaseDir + a dedicated spike profile) ----
function resolveBaseDir() {
  const fromEnv = process.env.PUBLISH_DATA_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  return join(process.env.HOME || homedir(), ".publish-cli");
}
const BASE_DIR = resolveBaseDir();
const PROFILE_DIR = join(BASE_DIR, "xhs-spike-profile");
const STATE_FILE = join(BASE_DIR, "xhs-spike-state.json");
const SHOT_FILE = join(BASE_DIR, "xhs-spike-last.png");

// creator dashboard root; logged-out users are bounced to a QR login page.
const HOME_URL = "https://creator.xiaohongshu.com/";
// Signals that we are LOGGED OUT (a QR/login wall is showing). SPECIFIC ONLY —
// LIVE-CALIBRATED 2026-07-06: bare `canvas` / `.qrcode` were REMOVED because the
// logged-in creator dashboard renders <canvas> data widgets and tripped a false
// "out". The phone-login input is the reliable, unambiguous logged-out marker.
const LOGGED_OUT_SIGNALS = [
  'input[placeholder*="手机号"]',
  'text=扫码登录',
  'text=手机号登录',
  '.login-container',
];
// Signals that we are LOGGED IN (creator shell chrome). LIVE-CALIBRATED
// 2026-07-06: `text=发布笔记` resolves reliably on the authed dashboard.
const LOGGED_IN_SIGNALS = [
  'text=发布笔记',
  'text=创作灵感',
  'text=数据中心',
  '.creator-layout',
  '.side-bar',
  '.user',
];

const MANUAL_LOGIN_TIMEOUT = 300_000; // 5 min to scan the QR by hand
const PROBE_SETTLE = 3_000;

function readState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}
function writeState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function nowISO() {
  return new Date().toISOString();
}
function humanElapsed(fromISO) {
  const ms = Date.now() - new Date(fromISO).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = ms / 3600000;
  if (hrs < 48) return `${hrs.toFixed(1)} h`;
  return `${(hrs / 24).toFixed(1)} days`;
}

/** First selector in `list` that is visible within `timeout`, else null. */
async function firstVisible(page, list, timeout) {
  const per = Math.max(600, Math.floor(timeout / list.length));
  for (const sel of list) {
    try {
      await page.locator(sel).first().waitFor({ state: "visible", timeout: per });
      return sel;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Classify the current page: "in" (logged in), "out" (login wall), or "unknown".
 *
 * LIVE-CALIBRATED 2026-07-06: the URL is AUTHORITATIVE and the fastest signal —
 * a logged-out user hitting the creator root is bounced to a `/login` URL, while
 * an authed one lands on `/new/…` (e.g. /new/home). The DOM signals are slower
 * (the dashboard is a client-rendered SPA — `发布笔记` paints a beat after the URL
 * resolves), so we settle for network-idle, decide on the URL first, and only
 * consult the DOM signals to disambiguate a non-obvious URL.
 */
async function classify(page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  const url = page.url();
  if (/\/login/i.test(url)) return { state: "out", via: `url:${url}` };
  if (/\/new\//i.test(url)) return { state: "in", via: `url:${url}` };
  // URL ambiguous — fall back to DOM signals (logged-in checked first so a stray
  // dashboard widget can't false-positive a logged-out read).
  const inn = await firstVisible(page, LOGGED_IN_SIGNALS, 8_000);
  if (inn) return { state: "in", via: inn };
  const out = await firstVisible(page, LOGGED_OUT_SIGNALS, 4_000);
  if (out) return { state: "out", via: out };
  return { state: "unknown", via: `url:${url}` };
}

async function launch(headless) {
  const opts = {
    headless, // false for QR-scan (needs a visible window); true for --check polling
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    args: ["--disable-blink-features=AutomationControlled"],
  };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: "chrome" });
  } catch {
    return await chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
}

async function main() {
  if (process.argv.includes("--reset")) {
    rmSync(PROFILE_DIR, { recursive: true, force: true });
    rmSync(STATE_FILE, { force: true });
    console.log("[xhs-spike] reset: wiped spike profile + state.");
    return;
  }

  mkdirSync(BASE_DIR, { recursive: true });
  mkdirSync(PROFILE_DIR, { recursive: true });
  const state = readState();

  console.log(`[xhs-spike] profile: ${PROFILE_DIR}`);
  if (state.firstLoginAt) {
    console.log(
      `[xhs-spike] first login recorded ${state.firstLoginAt} (${humanElapsed(state.firstLoginAt)} ago); ` +
        `last seen alive: ${state.lastAliveAt ?? "—"}`,
    );
  } else {
    console.log("[xhs-spike] no prior login recorded — this run establishes the baseline.");
  }

  // --check: unattended headless poll — report alive/expired and exit; NEVER waits
  // for a QR (if the session is gone, there's no human to scan, so just record it).
  const CHECK = process.argv.includes("--check");

  const ctx = await launch(CHECK); // headless only in --check
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(PROBE_SETTLE);

    let { state: st, via } = await classify(page);
    console.log(`[xhs-spike] classification: ${st} (via ${via})`);

    if (st === "in") {
      const at = nowISO();
      state.lastAliveAt = at;
      state.firstLoginAt = state.firstLoginAt ?? at; // if profile was pre-warmed
      writeState(state);
      console.log(
        `\n✅ SESSION ALIVE.${
          state.firstLoginAt ? ` Persisted ${humanElapsed(state.firstLoginAt)} since first recorded login.` : ""
        }`,
      );
    } else if (CHECK) {
      // Headless poll found no session — record the expiry window and exit (no QR).
      const gap = state.lastAliveAt ? humanElapsed(state.lastAliveAt) : "unknown";
      state.expiredSeenAt = nowISO();
      writeState(state);
      console.log(
        `\n❌ SESSION EXPIRED (state=${st}). Last seen alive ${gap} ago` +
          `${state.firstLoginAt ? `; ${humanElapsed(state.firstLoginAt)} since first login` : ""}. ` +
          `Re-run WITHOUT --check to re-scan the QR and reset the baseline.`,
      );
    } else {
      console.log(
        `\n🔑 NOT LOGGED IN. Scan the QR in the 小红书 app in the visible window. ` +
          `Waiting up to ${Math.round(MANUAL_LOGIN_TIMEOUT / 60000)} min…`,
      );
      const landed = await firstVisible(page, LOGGED_IN_SIGNALS, MANUAL_LOGIN_TIMEOUT);
      if (landed) {
        const at = nowISO();
        state.firstLoginAt = at;
        state.lastAliveAt = at;
        delete state.expiredSeenAt;
        writeState(state);
        console.log(`\n✅ LOGGED IN at ${at} (via ${landed}). Baseline recorded. Re-run later to measure persistence.`);
      } else {
        console.log(
          `\n❌ Did not detect a logged-in state within the window. ` +
            `Either the QR wasn't scanned, or the logged-in signals need calibration ` +
            `(inspect the visible page and update LOGGED_IN_SIGNALS).`,
        );
      }
    }

    await page.screenshot({ path: SHOT_FILE, fullPage: false }).catch(() => {});
    console.log(`[xhs-spike] screenshot: ${SHOT_FILE}`);
    if (!CHECK) await page.waitForTimeout(4_000); // hold the visible window to eyeball
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error("[xhs-spike] error:", e?.message ?? e);
  process.exitCode = 1;
});

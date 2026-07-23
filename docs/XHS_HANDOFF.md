# XHS (小红书 / RedNote) channel — research & spike handoff (2026-07-06)

Self-contained pickup notes for a **future agent**. This is the state BEFORE any
design or channel code: research is done, a login-persistence spike is done and
green, and the design is intentionally **NOT written yet** (operator's call).

Your job when you pick this up (see [§7 runbook](#7-follow-up-runbook-do-this-first)):
run **one follow-up TTS check** to confirm the login is still alive after the
elapsed gap. **If it passes**, continue iterating on the design (§6 open questions
first). If it fails, record the expiry window and re-scan — the channel is still
viable (§5), the number just tunes re-scan frequency.

---

## 1. TL;DR

- **Goal:** add a 小红书 / RedNote / XHS publishing channel to `publish-cli`,
  consistent with its "human-gated, never auto-posts" posture.
- **Crux finding:** XHS has **no native web/API draft** (draft box is
  mobile-app-only). The existing "stage a native platform draft, never post"
  boundary **cannot apply as-is** — it must be re-interpreted (§3, §5).
- **Path chosen:** **browser automation** with a persistent profile (mirrors
  X/LinkedIn/Reddit). Rejected: reverse API (ToS/ban/`x-s` drift) and official
  API (enterprise-gated, unavailable to individuals, still no draft).
- **Spike result (green):** one-time QR login **persists across browser
  restarts**, and the session is **reusable headless**. XHS fits the
  persistent-profile model. Only the persistence *duration* is unmeasured (§6).
- **Nothing built** beyond a throwaway spike script
  (`scripts/xhs-login-spike.mjs`). No `src/xhs/*`, no CLI wiring, no design doc.

---

## 2. Research findings

Two research passes (web + the operator's reference repos). Full sources are in
those repos' READMEs and the URLs below.

### 2.1 Publishing paths (which mechanism)

| Path | Individual access | Signing / fingerprint | Ban / ToS | Maintenance | Draft? |
|---|---|---|---|---|---|
| **Official API** (`open.xiaohongshu.com`, 蒲公英/千帆) | ❌ enterprise-verified, app review | clean key/secret | low | one-time | ❌ no draft endpoint; publish is enterprise-gated |
| **Reverse API** (`web_api/sns/v2/note` + `x-s`/`x-t`/`x-s-common` signing) | ✅ w/ cookies | **severe** (cookies + canvas/UA fingerprint + obfuscated JS signer, drifts ~monthly) | **high** (clear ToS violation) | **constant** | ❌ publishes live |
| **Browser automation** (Playwright persistent profile) | ✅ | none | medium (human-gated) | occasional selector drift | ❌ web has no draft box |

**Decision: browser automation.** It's the only individual-viable, non-ToS-violating,
low-maintenance path — and it matches the shipped channels.

### 2.2 End-to-end pipeline (browser path) & composer facts

Given a base post (caption markdown + pre-rendered card images), the composer
steps (drift-prone; verify live):

1. Login: headful **QR scan** to `creator.xiaohongshu.com`, persist the profile.
2. `goto https://creator.xiaohongshu.com/publish/publish`.
3. **Click the 上传图文 (image-text) tab** — the page defaults to the *video* tab.
4. **Upload images** via `input[type="file"]`, **all in one `set_input_files` call**;
   **≥1 image is mandatory** (image-text posts). Up to ~18 images (commonly cited,
   **max unverified**).
5. **Title:** `input[placeholder*="标题"]`, **≤20 code points** — over the cap the
   Publish button **silently does nothing** (confirmed in xhs-toolkit). Hard trap.
6. **Body:** a TipTap `div.ProseMirror[contenteditable="true"]`, **≤1000 chars**.
7. **Topics/mentions:** type `#`/`@` inline in the editor; location via lookup.
8. **AI-content declaration** checkbox when the content is AI-assisted.
9. **NO "存草稿" control exists on web.** The only terminal action is **发布 (Publish)**.

**Card geometry:** cards are **vertical** — **3:4 = 1080×1440** (default, highest
reach), **9:16 = 1080×1920** (full-bleed). **NOT 16:9** (that's landscape — wrong
orientation). A post is a **carousel of up to ~18** cards; **consistency across the
carousel** is a top taste signal.

### 2.3 Card taste (methodology to copy, from the reference skill repos)

`cclank/xhs-cover-skill`, `JuneYaooo/xhs-writer-skill`,
`ziguishian/xhs-visual-director-skill` all encode taste as **prose prompts fed to
an image model** — **copy the methodology, reject the rendering** (baked pixels,
unreliable Chinese glyphs). The transferable pattern (visual-director is the gold
standard):

- **Named style bundles as design tokens** (palette, type ramp, grid = 1080×1440 /
  12-col / 8px / safe margins, per-style composition frame-%).
- **Negative-constraint checklists** (≤2 fonts, no text-walls, single focus,
  carousel consistency-lock, no-gradients-where-forbidden) — highest leverage.
- **Copy rubrics** (title formulas, selling-point scoring, cover-hook rules).
- Two legit taste camps to pick per content-type: **高级感 minimal** (Source Han
  Sans, muted, whitespace) vs **素人感 grassroots** (cream/pastel bg, oversized
  emoji, casual — anti-professional for trust).

### 2.4 Editability

Best fit for a deterministic, git/Drive-friendly, editable pipeline: **HTML/CSS
templates → PNG via headless Chrome** (reuses the Playwright infra already here;
zero new heavy deps). Editable source of truth = HTML + CSS + JSON style-tokens +
markdown, all plain-text/diffable. Pin embeddable Chinese fonts (Source Han Sans /
Alibaba PuHui / HarmonyOS Sans — all freely embeddable) + a color-emoji font via
`@font-face`. Optionally also emit SVG for vector editing. **Reject image-model
rendering as the primary path** (un-editable, non-deterministic, bad Chinese text);
it may stay an optional background layer *under* editable text.

**BUT** — per §3, all of 2.3/2.4 belongs to the **orthogonal design system, NOT the
XHS channel.**

---

## 3. Decisions made (operator, 2026-07-06)

1. **Action is NOT named `draft`.** "draft" implies a native platform draft, which
   XHS lacks. Candidates: **`compose`** (lead), `stage`, `preview`.
2. **Publish is always headful + human-present, never headless background.** The
   agent always has a synchronous surface to show the operator (headful browser
   and/or the **Discord escalation path** in the larger *fred-agent* ecosystem).
   This de-risks the missing draft: a present human reviews the populated composer
   and posts right then; login expiry becomes friction, not a blocker.
3. **The design/taste system is ORTHOGONAL** — an atomic, cross-channel component
   that lives **outside** the per-channel code (likely outside publish-cli). It
   does not exist yet. The XHS channel **declares its input contract only**
   (vertical card PNGs 3:4/9:16 + a caption) and **stays dumb about aesthetics** —
   no style tokens, no card renderer inside `publish xhs`.
4. **Path = browser automation, persistent profile** (from §2.1 + the spike).
5. **No design doc yet** — this handoff first; design after the follow-up TTS test.

**Anticipated channel shape (NOT yet designed — do not treat as spec):**
`publish xhs compose` → deterministic caption validation (title ≤20, body ≤1000,
`#topics`; reuse `src/x/content.ts` patterns) + drive composer (上传图文 → upload →
fill) → surface a preview for approval → **never clicks 发布** (a documented
FORBIDDEN selector, like Reddit's Post). Open question in §6 whether we drive the
live composer at all vs. stop at a local preview → Discord.

---

## 4. The spike — what was run and proven

Throwaway probe: **`scripts/xhs-login-spike.mjs`** (read-only login-state prober;
never opens the composer, never posts). Mirrors the persistent-profile model:
profile at `PUBLISH_DATA_DIR/xhs-spike-profile` (off Drive), state at
`PUBLISH_DATA_DIR/xhs-spike-state.json`, last screenshot at `…/xhs-spike-last.png`.

**Confirmed live (2026-07-06 ~17:47 UTC):**

| Question | Result |
|---|---|
| One-time headful **QR login** works? | ✅ scanned once → landed authed on `/new/home` |
| Session survives a **fresh browser process**? | ✅ relaunched → authed, **no re-scan** |
| Session reusable **headless** (`--check`)? | ✅ headless read of the authed dashboard via persisted cookies (unlike Reddit, no 403 on the fingerprint) |

**Detection calibrated live (baked into the script):**
- **URL is authoritative & fastest:** `/login` = logged out; `/new/…` (e.g.
  `/new/home`) = logged in. The dashboard is a client-rendered SPA, so `发布笔记`
  paints a beat after the URL resolves — don't rely on DOM alone.
- **Logged-out DOM marker:** `input[placeholder*="手机号"]`. **Never use bare
  `canvas`** for logged-out — the authed dashboard renders `<canvas>` widgets and
  it false-positived a logged-out read (fixed).
- Logged-in DOM markers: `text=发布笔记` / `创作灵感` / `数据中心`.

**Script usage:**
```bash
node scripts/xhs-login-spike.mjs           # headful; scans QR if needed, records baseline
node scripts/xhs-login-spike.mjs --check   # HEADLESS; report ALIVE/EXPIRED + elapsed, no window, no wait
node scripts/xhs-login-spike.mjs --reset    # wipe spike profile + state for a clean measurement
```

---

## 5. Boundary implication (important)

XHS offers **no native draft to stop at**, so the never-posts invariant is honored
differently from the other channels:

- **NOT** via a persisted platform draft (none exists).
- **NOT** via 私密发布 (private-publish) or 定时发布 (scheduled-publish) — both
  **actually publish** and would violate the boundary.
- **Instead:** stop at the **fully-populated composer**, reviewed **synchronously**
  by the present human (headful and/or Discord preview), who takes the final post
  action. 发布 stays a **documented FORBIDDEN selector** no code path clicks.

This is a genuine departure from X/LinkedIn/Reddit/WeChat and must be stated
plainly in the eventual design + SKILL docs (no silent limitation).

---

## 6. Open questions (resolve before/while designing)

1. **Login-TTS duration** — the follow-up test (§7). Hours? Days? Weeks? Sets
   re-scan frequency; **not architecture-blocking**.
2. **Live composer vs. local preview only.** Do we drive the real XHS composer
   (upload images + fill caption → screenshot → Discord, stop before 发布), or stop
   at a **locally-rendered preview** (cards + caption composed into a Discord
   message, no XHS login at all)? The live composer adds fidelity (exact XHS
   render + live caps) but adds login dependency + selector-drift maintenance;
   local preview is strictly more robust. Operator leaned "verify TTS first, then
   decide" — the duration result should inform this.
3. **Action name** — confirm `compose` (vs `stage`/`preview`).
4. **The orthogonal design system** — does it exist yet? If not, the channel needs
   only its **input contract** stubbed; someone/something else produces the cards.
5. **Image count max** (unverified ~18), **AI-content declaration** handling,
   **font licensing/bundling** for the (orthogonal) renderer, public-repo posture.

---

## 7. Follow-up runbook (DO THIS FIRST)

Preconditions: the operator has the 小红书 app handy (in case a re-scan is needed);
run from the repo root (Playwright resolves from `node_modules`).

1. **Re-test persistence (headless, seconds):**
   ```bash
   node scripts/xhs-login-spike.mjs --check
   ```
   - `✅ SESSION ALIVE. Persisted N h/days …` → **PASS.** The one-time-login model
     holds for at least that gap. Record N. Proceed to step 3.
   - `❌ SESSION EXPIRED. Last seen alive N ago …` → the window is ~N. Still
     viable (§5): note it, then step 2 to re-establish and (optionally) keep
     measuring a longer gap.
2. **(If expired or you want a fresh baseline) re-scan headful:**
   ```bash
   node scripts/xhs-login-spike.mjs        # operator scans the QR in the visible window
   ```
   Then `--check` again after the next gap to bracket the window further.
3. **If PASS → continue the design.** Start from §6 open questions (esp. #2 live
   composer vs local preview, informed by the measured duration), then write
   `docs/XHS_DESIGN.md` in the style of `REDDIT_DESIGN.md` / `WECHAT_DESIGN.md`,
   THEN implement `src/xhs/*` mirroring `src/reddit/*` (session/content/draftPoster)
   + `src/commands/xhs-compose.ts` + CLI/config wiring. Reuse by import
   (`src/x/content.ts`, `src/commands/contentInput.ts`) — **do not edit X's modules.**

---

## 8. Where things live

- **Spike script:** `scripts/xhs-login-spike.mjs` (throwaway; live-calibrated
  detection). Profile/state/screenshot under `PUBLISH_DATA_DIR` (default
  `~/.publish-cli`): `xhs-spike-profile/`, `xhs-spike-state.json`, `xhs-spike-last.png`.
- **Reference repos (operator-supplied):** publishing — `jogholy/xhs-publisher`
  (Playwright, publishes live), `puzhen-ryan/xhs-toolkit` (Puppeteer/CDP, publishes
  live), `cv-cat/XhsSkills` (reverse API via `Spider_XHS`+`xhshow`, publishes live);
  taste — `cclank/xhs-cover-skill`, `JuneYaooo/xhs-writer-skill`,
  `ziguishian/xhs-visual-director-skill`. **None save a draft** (confirms §2.1).
- **Memory** (`~/.claude/projects/…/memory/`): `xhs-no-web-draft.md`,
  `xhs-login-tts-spike.md`, `publish-always-headful-sync.md`,
  `design-language-orthogonal.md`.
- **Closest code analog to mirror:** `src/reddit/*` (browser-driven, persistent
  profile, "Save Draft" boundary with a FORBIDDEN Post selector, live-calibrated
  selectors) + `src/x/content.ts` (deterministic caption/caps).

## 9. Guardrails (do not break)

- **Never posts.** No code path may click 发布/publish. Keep it a documented
  FORBIDDEN selector (mirror Reddit's Post / WeChat's `freepublish/*`).
- **Never touch the mobile-only draft assumption** — there is no web draft; don't
  design around one, and don't use 私密/定时发布 as a "draft" (they publish).
- **Reuse by import, don't edit X/LinkedIn/Reddit** for XHS's sake.
- **Machine-local state off Google Drive** — profile/cookies under
  `PUBLISH_DATA_DIR`; never commit `.env`.
- **Design/taste stays orthogonal** — the XHS channel consumes cards + caption; it
  does not embed a renderer or style rules.
- **Verify live before claiming a flow works** (CLAUDE.md).

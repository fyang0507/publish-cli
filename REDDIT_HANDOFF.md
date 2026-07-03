# Reddit channel — handoff (updated 2026-07-03: LIVE-VERIFIED ✅)

Self-contained pickup notes. Read this, then
[REDDIT_DESIGN.md](./REDDIT_DESIGN.md) for the full design.

## TL;DR

A **browser-driven** Reddit PUBLISH channel (`publish reddit inspect | search |
draft`, self-posts only, **draft-only, never posts**) is **implemented and
LIVE-VERIFIED end-to-end** on branch `worktree-reddit-channel-design` (PR #27).

**2026-07-03 live verification (headful, operator solved the login captcha):**
- `reddit search` + logged-out `reddit inspect codex` return **real data**.
- Credential login succeeds + persists; a **real `reddit draft` to r/codex stages
  a native PRIVATE draft** (login → preflight → title/body → flair → Save Draft),
  confirmed in Reddit Drafts, **nothing posted**. The delete path also works
  (test drafts cleaned up).
- Several selectors were **live-calibrated** against Reddit's new
  `<shreddit-composer>` (see commit `ec82f72`): `loggedInSignal`, the flair-list
  endpoint, the body editor, and the flair modal.

**Known limitation (surfaced, not silent):** Reddit's new composer hydrates its
"Switch to Markdown" toggle unreliably, so the body is often entered in the rich
editor and markdown renders literally; `stageDraft` emits an advisory telling the
operator to flip "… → Switch to Markdown" in the draft before posting. Every draft
is human-reviewed pre-post, so this is acceptable.

Note: the 403 "network security" wall blocks the **headless** read path but a
**headful** real Chrome (persistent profile) passes — always verify live with
`--inspect`.

## Where things live

- **Branch / worktree:** `worktree-reddit-channel-design` at
  `.claude/worktrees/reddit-channel-design` (this dir). **PR #27** (draft).
- **Design doc:** `REDDIT_DESIGN.md` (9 sections; authoritative).
- **Memory:** `~/.claude/projects/…/memory/reddit-channel-browser-driven.md`
  (why browser not API; live-calibrated facts; IP-ban caution).

## Architecture decision (important context)

Originally designed against Reddit's official **OAuth API** (per
PRODUCT_SPEC §2.2 / LINKEDIN_DESIGN §3.1). We **reversed to browser-driven**
because Reddit's external app creation is now gated behind the Responsible
Builder Policy → **Developer Platform (Devvit)** onboarding (`npm create
devvit@latest`, apps that run *inside* Reddit) and requires a **dedicated bot
account** — it never issues external `client_id`/`client_secret` for a CLI. So
the channel mirrors X/LinkedIn: persistent Playwright profile, operator logs in
**as themselves**, drafts land in **their own** Reddit Drafts. Full rationale in
REDDIT_DESIGN.md §3.1. **Do not re-attempt the API path** unless Reddit reopens a
non-Devvit external OAuth flow.

## What's implemented (all new/edited, committed)

| File | Purpose |
|---|---|
| `src/reddit/session.ts` | persistent-profile login (`REDDIT_USERNAME`/`PASSWORD`), headful `--inspect` first login, `getBrowserContext({requireLogin})` (login-free reads) |
| `src/reddit/reader.ts` | login-free JSON reads for inspect/search/preflight; `page.goto` transport; host rules; `RedditReadBlockedError`; post_requirements capture fallback |
| `src/reddit/content.ts` | `generateSelfPost` — title + **Markdown verbatim**, caps (300/40000), advisories; reuses `../x/content.ts` |
| `src/reddit/draftPoster.ts` | `stageDraft` — composer → **"Save Draft"**; eligibility-block detection; Post is a FORBIDDEN selector; bail safeguard |
| `src/commands/reddit-{inspect,search,draft}.ts` | the three commands; reuse `resolveContentInput` |
| `src/cli.ts`, `src/config.ts`, `.env.example` | wiring: reddit group; `REDDIT_*` creds + `reddit-profile`/`reddit-cookies` in `dataPaths()` |
| `skills/publish/{SKILL,SETUP,calibration}.md`, `CLAUDE.md`, `README.md` | docs registrations |

## Verified ✅ (locally)

- `npx tsc --noEmit` green; `npm run build` ok.
- All `--help` render; `reddit` group wired.
- `reddit draft --dry-run` is **browser-free and needs no creds** (keeps Markdown
  verbatim). A prior bug where dry-run launched the browser was fixed.
- **Never-posts boundary** confirmed in code: Post appears only as a documented
  forbidden selector; "Save Draft" is the sole save path + bail safeguard.
- **Block-handling** verified against the live 403 wall: `inspect`/`search` report
  `✗ … blocked or unreachable — HTTP 403 …` and exit 1 (no hollow/fake data).
- Login selectors, hosts (old.reddit vs www), `page.goto` transport, and the
  `post_requirements` USER_REQUIRED-envelope fix were **live-calibrated** against
  real Reddit *before* the IP ban (see REDDIT_DESIGN §3.3 / memory).

## Outstanding ❌ (the actual next task)

Real-data live verification — none of this has run against live data yet:
1. `reddit search "…"` returns real candidate subreddits.
2. `reddit inspect codex` returns real subscribers/rules + verdict; logged-out it
   should show flairs/post_requirements as "requires login (validated at draft
   time)". Logged-in it should show the real flair list + requirements.
3. **Headful login** succeeds and persists a session (captcha, human-solved).
4. A real `reddit draft` against **r/codex** stages a native draft (verify it
   lands in Drafts, is private, never posted) and the **eligibility-block path**
   (karma/age → plain "can't post to r/codex: <reason>") behaves.
5. Calibrate any drifted composer/`loggedInSignal` selectors found during (3)/(4).

## ⚠️ Blocker: this machine's IP is Reddit-banned

On 2026-07-02 an investigation subagent probed Reddit too aggressively and tripped
its **network ban**: every endpoint (www + old.reddit) returns HTTP 403 with a
non-JSON "You've been blocked by network security" wall. This blocks **reads AND
login** from this machine until it lifts (IP-level, usually temporary — hours).

**Lesson for the fresh agent: rate-limit ALL live Reddit calls hard** — a handful,
several seconds apart. Do not loop/burst. The code already backs off + surfaces
`RedditReadBlockedError`; if you see the 403 wall, STOP and wait, don't retry in a
loop (that prolongs the ban).

## How to finish (fresh-agent runbook)

Preconditions: Reddit reachable again (ban lifted, or use a **different network /
VPN / hotspot**). No 2FA on the operator's account (confirmed).

1. **Creds.** They live in the **main checkout's** `.env`
   (`/Users/fredy/Google Drive/My Drive/Projects/publish-cli/.env`), NOT the
   worktree. To run from the worktree, copy the two keys in without printing them:
   ```
   grep '^REDDIT_' "/Users/fredy/Google Drive/My Drive/Projects/publish-cli/.env" >> .env
   ```
   (worktree `.env` is gitignored). Keys: `REDDIT_USERNAME`, `REDDIT_PASSWORD`
   (`REDDIT_EMAIL` only if an email challenge appears).
2. **Build:** `npm run build`.
3. **Verify reads FIRST (unauthenticated, no login), rate-limited:**
   ```
   node dist/cli.js reddit search "ai agents" --limit 5
   node dist/cli.js reddit inspect codex
   ```
   Expect real data; logged-out inspect noting flair/post_requirements need login
   is correct, not a bug. If 403 wall → still banned; stop and wait.
4. **Headful login (HUMAN — captcha; an agent cannot do this):** ask the operator
   to run and solve the captcha:
   ```
   ! node dist/cli.js reddit inspect codex --inspect
   ```
   This persists the session in the machine-local `reddit-profile`. Calibrate
   `REDDIT_LOGIN_SELECTORS` / `loggedInSignal` in `src/reddit/session.ts` if login
   auto-fill misbehaves (selectors are best-effort; see REDDIT_DESIGN §9).
5. **Verify draft (now logged-in):**
   ```
   node dist/cli.js reddit draft --subreddit codex --title "test" --text "hello from publish-cli" --dry-run   # preflight w/ real contract
   node dist/cli.js reddit draft --subreddit codex --title "test" --text "hello from publish-cli"              # stages a native DRAFT (never posts)
   ```
   Then confirm on reddit.com that a **private draft** was created and nothing was
   posted. Exercise the eligibility path (r/codex may gate on karma → expect a
   plain "can't post to r/codex: …").
6. Calibrate any drifted composer selectors in `src/reddit/draftPoster.ts`
   (`REDDIT_COMPOSER_SELECTORS`), rebuild, re-verify. Commit + push to PR #27.

## Guardrails (do not break)

- **Draft-only, never posts.** No code path may click Post / submit. Keep Post a
  comment-only forbidden selector; keep the Save-Draft bail safeguard.
- **Reuse by import, don't edit X/LinkedIn** — Reddit imports `../x/content.ts`
  and `../x/draftPoster.ts` primitives + `../commands/contentInput.ts`.
- **Machine-local state off Google Drive** — profiles/cookies live under
  `~/.publish-cli` (PUBLISH_DATA_DIR); never commit `.env`.
- **Verify live before claiming a flow works** (CLAUDE.md) — but rate-limit.

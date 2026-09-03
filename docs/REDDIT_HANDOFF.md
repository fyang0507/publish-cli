# Reddit channel — historical handoff (last updated 2026-07-04)

These are historical implementation and live-verification notes. Before current
Reddit work, run `publish reddit info --json`; that native response owns channel
capabilities, authentication, readiness, recovery, and stop conditions. Use
action-level `--help` for flags, [README.md](../README.md) for setup, and
[REDDIT_DESIGN.md](./REDDIT_DESIGN.md) only for architectural history.

## TL;DR

A browser-driven Reddit implementation (`publish reddit inspect | search |
draft`) was exercised through a private self-post draft in July 2026. This dated
evidence does not establish current readiness or behavior; use the native `info`
response for the current contract.

**2026-07-03 live verification (headful, operator solved the login captcha):**
- `reddit search` and logged-out `reddit inspect codex` returned live data.
- Credential login succeeded and persisted into the dated follow-up. A
  `reddit draft` flow to r/codex filled the private composer and used Save Draft;
  the session observed the test draft in Reddit Drafts, then removed it. Nothing
  was posted.
- Several selectors were **live-calibrated** against Reddit's new
  `<shreddit-composer>` (see commit `ec82f72`): `loggedInSignal`, the flair-list
  endpoint, the body editor, and the flair modal.

**Markdown mode — observed working on 2026-07-04:** the session found "Switch to
Markdown" as an `rpl-menu-item[role=menuitem]` inside the body toolbar's More
options menu rather than the visible button assumed by the earlier selector. At
that revision, `stageDraft` selected the menu item, checked for the reverse Rich
Text toggle or a Markdown textarea, and filled the textarea. The observed draft
was staged in Markdown mode and rendered as expected. The manual-switch advisory
was a fallback at that revision. The native `info` response owns the current
contract and recovery guidance.

**Headless-read observation (2026-07-04):** some tested environments returned a
non-JSON network-security response to headless reads. The dated revision added
one headful retry and an environment override. This is historical behavior, not
current readiness, login, or recovery guidance.

## Current sources

- **Channel contract and readiness:** `publish reddit info --json`.
- **Command flags:** `publish reddit inspect --help`, `publish reddit search
  --help`, and `publish reddit draft --help`.
- **Setup and examples:** [README.md](../README.md) and the checked-in
  `.env.example`.
- **Architecture history:** [REDDIT_DESIGN.md](./REDDIT_DESIGN.md).

## Architecture decision (important context)

The initial design considered Reddit's OAuth API (PRODUCT_SPEC §2.2 /
LINKEDIN_DESIGN §3.1). Research recorded in July 2026 found external app creation
routed through Responsible Builder Policy and Developer Platform onboarding,
which did not provide the external credentials needed by the CLI design. The
dated implementation therefore selected a persistent Playwright profile. See
REDDIT_DESIGN.md §3.1 for that historical rationale; use native `info` for the
current transport and platform guidance.

## Implementation snapshot recorded in July 2026

| File | Purpose |
|---|---|
| `src/reddit/session.ts` | persistent-profile login (`REDDIT_USERNAME`/`PASSWORD`), headful `--inspect` first login, `getBrowserContext({requireLogin})` (login-free reads) |
| `src/reddit/reader.ts` | login-free JSON reads for inspect/search/preflight; `page.goto` transport; host rules; `RedditReadBlockedError`; post_requirements capture fallback |
| `src/reddit/content.ts` | `generateSelfPost` — title + **Markdown verbatim**, caps (300/40000), advisories; reuses `../x/content.ts` |
| `src/reddit/draftPoster.ts` | `stageDraft` — composer → **"Save Draft"**; eligibility-block detection; Post is a FORBIDDEN selector; bail safeguard |
| `src/commands/reddit-{inspect,search,draft}.ts` | the three commands; reuse `resolveContentInput` |
| `src/cli.ts`, `src/config.ts`, `.env.example` | wiring: reddit group; `REDDIT_*` creds + `reddit-profile`/`reddit-cookies` in `dataPaths()` |
| `skills/publish/SKILL.md`, `AGENTS.md`, `README.md` | docs registrations |

## Local evidence recorded in July 2026

- `npx tsc --noEmit` and `npm run build` completed successfully.
- The dated `--help` checks rendered and the `reddit` group was wired.
- `reddit draft --dry-run` stayed browser-free in the dated test and preserved
  Markdown verbatim. A prior bug where dry-run launched the browser was fixed.
- The code review found Post only in a documented forbidden selector, with Save
  Draft as the exercised save path and a bail safeguard.
- The dated 403 test made `inspect` and `search` report the block and exit 1
  instead of returning placeholder data.
- Login selectors, hosts (old.reddit vs www), `page.goto` transport, and the
  `post_requirements` USER_REQUIRED-envelope fix were **live-calibrated** against
  real Reddit during the dated verification (see REDDIT_DESIGN §3.3).

## Historical network caveat

One July 2026 verification environment received Reddit's non-JSON HTTP 403
network-security wall after repeated probes. That observation is historical, not
a statement about the current operator or network. If the native readiness or a
read command reports the wall, stop instead of looping or treating it as proof of
logout.

## Reproduce verification safely

1. **Create checkout-local configuration without exposing another workspace.**
   From this repository root, initialize the ignored `.env` once, then use a
   private editor to replace only the needed `REDDIT_*` placeholders. Never print,
   pipe, or commit credential values.
   ```bash
   test -f .env || cp .env.example .env
   ```
   `PUBLISH_DATA_DIR` owns machine-local profiles and cookie caches; leave it
   unset for the documented default or set it to an operator-chosen absolute path
   outside this repository and cloud-synced storage. `PUBLISH_DATA_REPO` owns the
   first data-workspace override; resolution then checks
   `publish.config.dev.yaml`, followed by a `.agents/workspace.yaml` walk-up.
2. **Build and load the owned contract and help.**
   ```bash
   npm run build
   node dist/cli.js reddit info --json
   node dist/cli.js reddit draft --help
   ```
3. **Exercise the local-only path before any separately authorized live check.**
   ```bash
   node dist/cli.js reddit draft --subreddit codex --title "test" --text "hello from publish-cli" --dry-run
   ```
4. For an authorized live verification, follow the current native `info`
   recovery and stop conditions. Rate-limit reads, keep any login/CAPTCHA or
   other challenge human-controlled, and verify the native saved draft without
   crossing the final-publication boundary.

## Guardrails (do not break)

- **Draft-only, never posts.** No code path may click Post / submit. Keep Post a
  comment-only forbidden selector; keep the Save-Draft bail safeguard.
- **Reuse by import, don't edit X/LinkedIn** — Reddit imports `../x/content.ts`
  and `../x/draftPoster.ts` primitives + `../commands/contentInput.ts`.
- **Machine-local state off cloud-synced storage** — profiles/cookies live under
  `~/.publish-cli` (PUBLISH_DATA_DIR); never commit `.env`.
- **Verify live before claiming a flow works** (AGENTS.md) — but rate-limit.

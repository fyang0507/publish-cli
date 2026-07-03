# Reddit channel — live verification session summary (2026-07-03)

Companion to [REDDIT_HANDOFF.md](./REDDIT_HANDOFF.md) (pickup notes) and
[REDDIT_DESIGN.md](./REDDIT_DESIGN.md) (full design). This doc records what the
2026-07-03 live-verification session did, the current state, and what's left.

## Outcome: the channel is LIVE-VERIFIED end-to-end ✅

Branch `worktree-reddit-channel-design`, **PR #27** (still a *draft* — see "Further
action"). Three commits added this session:

| Commit | What |
|---|---|
| `849361b` | Pre-live review: fixed 3 runtime bugs (eligibility XPath matched `<html>`; `capturePostRequirements` race; stale `loggedInSignal`). |
| `ec82f72` | Live calibration against Reddit's new `<shreddit-composer>` + end-to-end draft verified. |
| `090fad2` | Updated `REDDIT_HANDOFF.md` to LIVE-VERIFIED. |

## What was verified against live Reddit (headful, operator solved the captcha)

- `publish reddit search "ai agents"` → **real candidate subreddits**.
- `publish reddit inspect codex` (logged-out) → **real subscribers/rules/verdict**;
  flair + post_requirements correctly degrade to "requires login".
- Credential login succeeds and **persists** (`reddit_session` cookie in the
  profile, expires 2026-12-31). No captcha needed on subsequent runs.
- `publish reddit draft --subreddit codex … --flair News` → **stages a native
  PRIVATE self-post draft** (login → preflight → title/body → flair → Save Draft),
  confirmed in Reddit Drafts, **nothing posted**. The never-posts boundary held
  throughout. Delete path also works (test drafts were cleaned up; account at 0).

## Bugs fixed (all calibrated against the live 2026-07-03 www.reddit.com composer)

1. **`loggedInSignal` was stale** (`src/reddit/session.ts`) — the avatar /
   `#USER_DROPDOWN_ID` markers matched 0 elements on the live authed shell, so login
   "did not land" *even though it succeeded*. Now
   `shreddit-app[user-logged-in="true"]` (durable auth attribute) +
   `button#expand-user-drawer-button`.
2. **Flair-list endpoint 404** (`src/reddit/reader.ts`) — the bare
   `/api/link_flair_v2` path 404s on www → flairs read as empty, wrongly failing
   preflight. Now tries `link_flair_v2.json` then the verified-working
   `link_flair.json`.
3. **Body editor selector** (`src/reddit/draftPoster.ts`) — the body is a
   name-scoped contenteditable `div[role="textbox"][name="body"]`, NOT a
   `<textarea>`; the old generic `contenteditable[role=textbox]` matched a hidden
   node first and timed out. Now leads with the visible name-scoped selectors.
4. **Flair modal** (`src/reddit/draftPoster.ts`) — new composer flairs are
   visually-hidden `faceplate-radio-input[name="flairId"]` selected via `.check()`
   by accessible **text** (composer radio value-ids ≠ `link_flair` ids), reached
   after "View all flairs", confirmed with **"Add"**
   (`getByRole('button',{name:'Add',exact:true})`; a CSS `:text-is("Add")` does not
   match). Leaving it open made the modal intercept the Save Draft click. `flairText`
   now threads through `StageDraftOptions` → `reddit-draft.ts`.
5. **Pre-live review fixes** — eligibility XPaths scoped to leaf elements (were
   matching `<html>`); `capturePostRequirements` reads the response body before the
   page closes (was ~always null).

## Known limitation (surfaced, not silent): Markdown mode is unreliable

Reddit's new `<shreddit-composer>` stores the body as a structured rich-text
document and hydrates its **"Switch to Markdown"** toggle inconsistently (it lives
in the body toolbar's "More options … " overflow and depends on RTE-toolbar
hydration timing / composer state). `switchToMarkdownMode` is now a robust
best-effort (waits for toolbar hydration, tries the inline button then the overflow
menu), **but it often can't engage in the real flow** — so the body is entered in
the rich editor where markdown syntax (`**bold**`, lists, fenced code) renders
**literally**.

When it can't engage, `stageDraft` emits an advisory telling the operator to open
the draft and flip **"… → Switch to Markdown"** before posting. Since every draft
is human-reviewed pre-post, this is acceptable, but it's the main quality gap.

## Further action / dev needed

1. **PR #27 is still a draft.** Review the two calibration commits (`849361b`,
   `ec82f72`) and, when happy, mark it ready-for-review / merge. (I did not flip it
   or merge — outward-facing state left to you.)
2. **Markdown-mode engagement** is the biggest open item. Options to explore:
   - Detect hydration more reliably (e.g. wait on a specific composer-ready signal)
     and/or open a **fresh** submit tab so an auto-restored draft doesn't perturb the
     RTE state.
   - Investigate whether typing raw markdown then toggling AFTER typing preserves it,
     or whether a paste path renders markdown.
   - If it stays unreliable, consider making the advisory even louder, or a
     `--require-markdown` flag that fails the stage if the toggle can't engage.
3. **`verifyDraftSaved` always reports "unconfirmed"** (`src/reddit/draftPoster.ts`)
   — it navigates to `submit?type=TEXT` (the composer), not a real drafts list. The
   actual drafts UI is a **dialog** opened by the "Drafts" button (rows carry an
   edit `svg[icon-name="edit"]` and delete `svg[icon-name="delete"]`), with no clean
   list URL. Non-fatal (the draft does land), but the verification signal is dead;
   calibrate it to open the Drafts dialog and match the title if you want a real
   confirmation.
4. **Headless reads are 403-blocked on this machine's fingerprint.** `inspect` /
   `search` without `--inspect` hit the "network security" wall; a headful real
   Chrome passes. Decide whether the read commands should default to headful, or
   document that `--inspect` is required for reads here.
5. **Selector drift.** All composer selectors are calibrated to 2026-07-03 and
   Reddit's shell drifts; expect periodic re-calibration via `--inspect`. Every
   fragile selector is commented "CALIBRATED LIVE 2026-07-03 … NEEDS LIVE
   CALIBRATION" in `src/reddit/draftPoster.ts` / `session.ts` / `reader.ts`.

## Guardrails preserved

- **Draft-only, never posts** — verified live; Post remains a comment-only forbidden
  selector; Save-Draft bail safeguard intact; flair modal dismissed on failure so it
  can't intercept anything.
- **Reuse-by-import** (X/LinkedIn primitives) — unchanged.
- **Machine-local state** (profile/cookies under `~/.publish-cli`) — never committed.

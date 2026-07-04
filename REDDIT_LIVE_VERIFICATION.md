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

## Markdown mode — now works reliably (fixed, live-verified 2026-07-04)

Root cause found + fixed: the **"Switch to Markdown"** control is an
`rpl-menu-item[role=menuitem]` inside the body toolbar's **"…" (More options)**
overflow — NOT a `<button>` (the only matching `<button aria-label>` is a
permanently-hidden responsive copy, which is why earlier attempts couldn't engage).
`switchToMarkdownMode` now matches it by role/text, **confirms the switch engaged**
(the reverse toggle becomes "Switch to Rich Text Editor" / a Markdown `<textarea>`
appears), and types the body into that `<textarea>`. So a normal draft is now staged
**in Markdown mode** and renders correctly.

The advisory telling the operator to flip **"… → Switch to Markdown"** manually now
fires **only** in the rare case the switch genuinely can't engage — it is a fallback,
no longer the expected outcome.

## Further action / dev needed

1. **PR #27 is still a draft.** Review the two calibration commits (`849361b`,
   `ec82f72`) and, when happy, mark it ready-for-review / merge. (I did not flip it
   or merge — outward-facing state left to you.)
2. **Markdown-mode engagement — DONE (live-verified 2026-07-04).** Root cause was
   that the "Switch to Markdown" control is an `rpl-menu-item[role=menuitem]` in the
   body toolbar's "…" overflow, not a `<button>`. `switchToMarkdownMode` now matches
   it by role/text, confirms the switch engaged, and types into the Markdown
   `<textarea>`; a normal draft stages in Markdown mode and renders correctly. See
   "Markdown mode — now works reliably" above.
3. **Draft-saved verification — DONE (live-verified 2026-07-04).** Root cause:
   reopening the composer "Drafts" modal right after saving showed a **stale** list
   (the just-saved draft hadn't propagated), so title-matching there always failed.
   Fixed by verifying via Reddit's transient **"Draft saved" toast**, captured right
   after the Save-Draft click. "verified in drafts: yes" is now the normal result on
   a successful save.
4. **Headless-reads 403 — DONE (live-verified 2026-07-04).** `reddit inspect` /
   `reddit search` default to a headless browser, but Reddit 403-blocks headless
   Chrome's fingerprint on **some** networks/machines (a non-JSON "network security"
   wall). Reads are **login-free**, so headful needs no human — only a display to
   render into. New behavior: reads **auto-retry headful once** on a block (with an
   advisory note), and **`REDDIT_READS_HEADFUL=1`** starts them headful to skip the
   doomed first attempt (leave unset on headless-server / good-fingerprint hosts).
   This is distinct from the one-time first **login**, which still needs headful
   `--inspect` (captcha) as a setup-stage cost. Draft **staging** still runs headless
   (reuses the persisted session cookie); the never-posts boundary is unchanged.
5. **Selector drift.** Composer selectors are calibrated to 2026-07-03, with the
   Markdown-toggle / More-options / body-editor / Markdown-confirm / Save-confirm
   selectors **re-calibrated 2026-07-04** (fixing #2/#3 — see their code comments
   "RE-CALIBRATED LIVE 2026-07-04"). Reddit's shell drifts; expect periodic
   re-calibration via `--inspect`. Every fragile selector is commented "CALIBRATED
   LIVE …/RE-CALIBRATED LIVE … NEEDS LIVE CALIBRATION" in
   `src/reddit/draftPoster.ts` / `session.ts` / `reader.ts`.

## Guardrails preserved

- **Draft-only, never posts** — verified live; Post remains a comment-only forbidden
  selector; Save-Draft bail safeguard intact; flair modal dismissed on failure so it
  can't intercept anything.
- **Reuse-by-import** (X/LinkedIn primitives) — unchanged.
- **Machine-local state** (profile/cookies under `~/.publish-cli`) — never committed.

# Reddit channel — historical live-verification record (2026-07-03 and 2026-07-04)

This document preserves dated engineering evidence; it is not a statement of
current readiness or operating guidance. Before current Reddit work, run:

```bash
publish reddit info --json
publish reddit draft --help
```

The native `info` response owns current capabilities, authentication readiness,
recovery, executor ownership, and stop conditions. Action help owns flags, and
the README owns setup. The observations below may have drifted since their
recorded dates.

Companion historical context lives in [REDDIT_HANDOFF.md](./REDDIT_HANDOFF.md)
and [REDDIT_DESIGN.md](./REDDIT_DESIGN.md).

## Outcome observed on 2026-07-03 and 2026-07-04

During those sessions, the test account completed search, inspection, and one
private self-post draft-staging flow without posting. Those dated observations
do not establish present-day readiness.

Three implementation commits captured the session's changes:

| Commit | Historical change |
|---|---|
| `849361b` | Fixed eligibility XPath scope, a response-capture race, and stale login markers before the live session. |
| `ec82f72` | Calibrated the dated Reddit composer flow and recorded an end-to-end draft observation. |
| `090fad2` | Updated the companion handoff with the session result. |

### Evidence recorded on 2026-07-03

- `publish reddit search "ai agents"` returned candidate subreddits.
- `publish reddit inspect codex` returned subscriber, rule, and verdict data while
  flair and post-requirement details degraded to login-required.
- Credential login persisted into a follow-up run. That dated follow-up did not
  present another CAPTCHA; this was an observation, not a future guarantee.
- `publish reddit draft --subreddit codex … --flair News` filled the private
  self-post composer and used Save Draft. The session observed the test draft in
  Reddit Drafts and later removed it. Nothing was posted.

## Bugs calibrated against the 2026-07-03 composer

1. **Stale login signal** (`src/reddit/session.ts`) — the previously used avatar
   markers matched no elements in the authenticated shell. The dated revision
   added the observed authenticated-shell attribute and user-drawer button.
2. **Flair-list endpoint failure** (`src/reddit/reader.ts`) — the bare endpoint
   returned 404 during the session. The dated revision tried the JSON endpoints
   observed during calibration.
3. **Body editor selector** (`src/reddit/draftPoster.ts`) — the observed body was
   a name-scoped contenteditable element rather than a textarea. A generic
   contenteditable selector had selected a hidden node and timed out.
4. **Flair modal** (`src/reddit/draftPoster.ts`) — the dated composer exposed
   visually hidden radio inputs selected by accessible text after “View all
   flairs,” followed by an “Add” button. Leaving that modal open intercepted the
   Save Draft control.
5. **Pre-session fixes** — eligibility checks were narrowed to leaf elements,
   and post-requirement response bodies were captured before the page closed.

## Markdown-mode observation on 2026-07-04

The session found “Switch to Markdown” as a menu item inside the body toolbar's
More options menu, not as the visible button assumed by the earlier selector.
The dated revision selected that menu item, checked for the reverse Rich Text
toggle or a Markdown textarea, and filled the textarea. The observed draft then
rendered Markdown as expected.

At that revision, a manual-switch advisory remained a fallback for a failed
mode change. This dated result does not guarantee that the current composer has
the same controls.

## Additional dated observations

- **Save evidence (2026-07-04):** reopening the Drafts modal immediately after
  saving produced a stale list. The revised session therefore captured a fresh
  “Draft saved” toast immediately after the one Save Draft click. That evidence
  did not prove reopen persistence. Defer to `publish reddit info --json` for
  current confirmation, unconfirmed-result, manual-comparison, and retry rules.
- **Headless read blocking (2026-07-04):** some tested environments returned a
  non-JSON network-security response to headless reads. The dated revision added
  one headful retry and an environment override. This is historical behavior,
  not current readiness or recovery guidance.
- **Selector drift:** the composer selectors were calibrated on 2026-07-03 and
  2026-07-04. Reddit can change them; the dates are evidence boundaries, not a
  durability promise.

## Boundaries observed in the dated sessions

- The exercised flow stopped after Save Draft; no Post action was taken.
- Shared browser helpers remained imported rather than copied.
- Machine-local profile state was not committed to the repository.

Current safety boundaries come from `AGENTS.md` and the native `info` response,
not from this historical record.

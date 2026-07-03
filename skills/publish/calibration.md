# Selector calibration (browser-driven paths)

X's **login and composer DOM drift.** The CLI centralizes its selectors and tries
multiple strategies (role / text / test-id / CSS) with explicit waits, but they are
best-effort and occasionally need **live recalibration** against the current X UI.
This is the most fragile surface in the tool. Consult this when a browser-driven
run (login, composer, or the Articles editor) hangs, times out, or lands somewhere
unexpected.

## How to calibrate

1. Re-run the same command with **`--inspect`** for a headful browser you can watch:
   ```bash
   publish x draft --from <file.md> --format tweet --inspect
   publish x watch --inspect      # if the session needs a re-login
   ```
2. Note where the flow stalls:
   - **Login** — username field, the optional "enter your email/phone to confirm"
     interstitial (answered with `X_EMAIL`), the password field, or the logged-in
     landing check.
   - **Composer** — the tweet text box, the thread "add post" affordance, the reply
     composer, or the Articles editor (body paste, cover-image upload).
3. The persistent profile lives under `PUBLISH_DATA_DIR` (`~/.publish-cli/x-profile`
   by default). Once logged in it **stays** logged in, so a hang is usually a
   composer/editor selector, not auth.

## Fixing

Selectors live in one place per surface: `X_SELECTORS` (login) in `src/session.ts`
and `X_COMPOSER_SELECTORS` in `src/x/draftPoster.ts`. Match X GraphQL read
operations by op **name** (query-id hashes drift), not by full path. Capture which
step stalled and the current on-screen DOM, update the relevant selector list, and
rebuild. In unattended runs, route the failure through your environment's
error-reporting path rather than retrying blindly.

## LinkedIn (`publish linkedin draft`)

The LinkedIn channel drifts the same way and is calibrated the same way — re-run
with `--inspect` and update selectors. Its selectors live in `LI_LOGIN_SELECTORS`
(`src/linkedin/session.ts`) and `LI_COMPOSER_SELECTORS` (`src/linkedin/draftPoster.ts`);
the profile is `~/.publish-cli/li-profile`.

Gotchas found during live calibration (2026-07) — the likely drift points:

- **Login**: LinkedIn renders DYNAMIC input ids **and a duplicate HIDDEN copy of
  the login form**, so selectors MUST filter to `:visible` (a bare attribute
  selector matches the hidden copy and `waitFor(visible)` times out). The sign-in
  control is a `<button type="button">` (not `submit`); the flow falls back to
  pressing Enter on the password field. LinkedIn may inject a CAPTCHA / "verify
  it's you" checkpoint — complete it in the headful window.
- **Feed logged-in signal**: feed CSS classes are hashed/unstable; use durable
  markers (the search box placeholder, the top-nav Home button).
- **Composer**: open via `feed/?shareActive=true` (the direct `/sharing/compose`
  URL 404s). The editor is TipTap `div.ProseMirror[contenteditable]`. LinkedIn
  **auto-restores the last saved draft into the composer**, so the poster
  select-all-clears before typing.
- **Save/verify**: closing a non-empty composer (`aria-label="Dismiss"`) raises a
  dialog with TEXT-only buttons **"Save as draft"** and **"Discard"** (no
  aria-labels — match by text). NEVER click "Discard" or the "Post" button; both
  are documented FORBIDDEN selectors. Verification reopens the composer and matches
  the staged text in the auto-restored editor.

## Reddit (`publish reddit inspect` / `search` / `draft`)

The Reddit channel drifts the same way and is calibrated the same way — re-run with
`--inspect` and update selectors. Its selectors live in `REDDIT_LOGIN_SELECTORS`
(`src/reddit/session.ts`) and `REDDIT_COMPOSER_SELECTORS`
(`src/reddit/draftPoster.ts`); the profile is `~/.publish-cli/reddit-profile`.

Facts found during live calibration (2026-07) and likely drift points to check headful:

- **Login (www, captcha-heavy).** `www.reddit.com/login` renders its form inside
  **shadow-DOM faceplate web components**; the fields are `input[name="username"]`
  and `input[name="password"]` (Playwright pierces open shadow roots for CSS), and
  the submit control is a **`type="button"` labeled "Log In"** (not `type=submit`) —
  the flow falls back to pressing Enter on the focused field. Before the form
  mounts, www serves a **`js_challenge` interstitial** (URL gains
  `?js_challenge=1&token=…`) with zero inputs that needs **a few seconds of JS plus
  a hardened context** to clear — the context sets `locale`/`timezoneId` and launches
  with `--disable-blink-features=AutomationControlled`. The **first login MUST be
  headful `--inspect`**: Reddit raises a CAPTCHA that only a human can solve. The
  optional email/identifier challenge (`identifierChallengeInput`) and the logged-in
  signal (`loggedInSignal`) may need re-selection; keep the signal a durable marker,
  not a hashed feed class.
- **Reads (inspect/search) run LOGGED-OUT — never demand credentials.** Host split
  (verified): `subreddits/search.json` works on **www**, but `about.json` +
  `about/rules.json` 403 logged-out on www and must go through **old.reddit.com**;
  `link_flair_v2` + `post_requirements` **require login** and return a
  `USER_REQUIRED` envelope logged-out (degrade to empty flairs / permissive
  requirements + a "validated at draft time" note, never a crash). A raw
  `context.request.get()` gets **IP-throttled / edge-403'd** (served the HTML wall
  instead of JSON), so every read is **page-driven** (`page.goto` → parse the nav
  response, retry once after the challenge delay). Private/quarantined subs degrade
  to a note, not a whole-run error; watch for read rate-limiting. When the profile
  already carries a session, the same reads transparently return authed data.
- **Composer**: the self-post `submit` page/tab, the **Markdown-mode toggle** (must
  switch the body editor to raw `<textarea>` so the body is taken verbatim), the
  title/body editors, the **flair picker**, and the `nsfw`/`spoiler` toggles all
  drift and need live calibration.
- **Save/verify**: save is the composer's **"Save Draft"** affordance — the ONLY
  save path. NEVER locate or click **"Post"** (a documented FORBIDDEN selector); if
  "Save Draft" doesn't resolve, the flow bails rather than falling through to
  another button (same safeguard as LinkedIn). Verification reopens the drafts list
  and matches the staged title / leading body.
- **Eligibility gates (karma / account age)** are AutoMod-enforced and NOT in the
  JSON, so they only surface authoritatively at draft time — confirm `draft`
  reliably catches the composer's "not enough karma" / "account too new" /
  "approved submitters only" / restricted block and returns a plain message rather
  than failing opaquely or proceeding toward Post.

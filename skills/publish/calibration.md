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
   publish draft x --from <file.md> --format tweet --inspect
   publish watch x --inspect      # if the session needs a re-login
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

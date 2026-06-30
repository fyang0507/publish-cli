# Selector Calibration (browser-driven paths)

Load this note only when a browser-driven run (login or composer) hangs, times out, or lands somewhere unexpected — not for normal operation.

## Why this exists

X's **login DOM and composer DOM drift**. The CLI centralizes its selectors and tries multiple strategies (role / text / test-id / CSS) with explicit waits, but selectors are best-effort and need **live calibration** against the current X UI. This is the single most fragile surface in the tool.

## How to calibrate

1. Re-run the same command with **`--inspect`** to get a headful browser a human can watch:
   ```bash
   publish draft x --from <base.md> --format tweet --inspect
   publish watch x --inspect   # if the session needs a re-login
   ```
2. Watch where the flow stalls:
   - **Login** — username field, the optional "enter your email/phone to confirm" interstitial (answered with `X_EMAIL`), the password field, or the logged-in landing check.
   - **Composer** — the tweet text box, the thread "add post" affordance, or the Articles composer.
3. The persistent profile lives under `PUBLISH_DATA_DIR` (`~/.publish-cli/x-profile` by default). Once logged in it **stays** logged in, so a hang is usually a composer selector, not auth.

## What to report back

If a step is genuinely broken (not a transient network blip), capture which step stalled and the current on-screen UI, and hand it to whoever maintains the selector module. In headless runs, follow the project's headless-error-report path rather than retrying blindly.

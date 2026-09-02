# Reddit transport calibration

Read this only when the user requested diagnosis or maintenance after
`publish reddit info --json` selected a maintained CLI transport and a Reddit
read or draft path hangs, times out, or lands on unexpected UI. Native `info`
remains the owner of authentication, platform constraints, Markdown behavior,
and the terminal draft contract.

## Diagnose

1. End the hung action and confirm it no longer owns the persistent profile.
   Re-run the same action with `--inspect` and record the exact step, visible UI,
   URL, and relevant DOM or response evidence. Prefer `--dry-run` when it can
   reproduce the issue; do not save another native draft solely for diagnosis.
2. Preserve the readiness classification. A network-security response, CAPTCHA,
   selector drift, and logged-out state are different failures and must not be
   collapsed into one another.
3. If evidence shows an auth, challenge, or network failure, stop calibration,
   rerun native Reddit info, and follow its recovery contract.
4. Otherwise update only the drifted selector, response parser, or verification
   signal, rebuild, and repeat the same action headfully. Record every live
   staging attempt and flag possible duplicate drafts for human review. Never
   fall through to another composer control when the documented draft control
   is absent.

## Maintainer map

- Login selectors: `REDDIT_LOGIN_SELECTORS` in `src/reddit/session.ts`.
- Composer and verification selectors: `REDDIT_COMPOSER_SELECTORS` in
  `src/reddit/draftPoster.ts`.
- Read host selection, response parsing, and retry classification:
  `src/reddit/reader.ts`.

Inspect open shadow roots, visibility, roles, and stable text rather than hashed
classes. For read failures, preserve login-free versus authenticated response
semantics and report opaque edge responses as network failures, not auth facts.

# LinkedIn transport calibration

Read this only when the user requested diagnosis or maintenance after
`publish linkedin info --json` selected the maintained CLI transport and a
LinkedIn draft path hangs, times out, or lands on unexpected UI. Native `info`
remains the owner of authentication, platform constraints, and the terminal
draft contract.

## Diagnose

1. End the hung action and confirm it no longer owns the persistent profile.
   Re-run the same draft action with `--inspect` and record the exact step,
   visible UI, URL, and relevant DOM evidence. Do not save another native draft
   solely for diagnosis.
2. Compare the failure with the readiness classification. Do not reinterpret a
   checkpoint, network error, or selector drift as a confirmed logout.
3. If evidence shows an auth, challenge, or network failure, stop calibration,
   rerun native LinkedIn info, and follow its recovery contract.
4. Otherwise update only the drifted selector or verification signal, rebuild,
   and repeat the same action headfully. Never substitute a different terminal
   control when the documented draft control cannot be located.

## Maintainer map

- Login selectors: `LI_LOGIN_SELECTORS` in `src/linkedin/session.ts`.
- Composer and verification selectors: `LI_COMPOSER_SELECTORS` in
  `src/linkedin/draftPoster.ts`.

Prefer durable roles, visible text, and stable editor attributes. Filter out
hidden duplicate controls and avoid hashed feed classes. Treat a restored older
draft as data requiring explicit handling, not as proof the new draft saved.

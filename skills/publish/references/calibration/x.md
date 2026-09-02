# X transport calibration

Read this only when the user requested diagnosis or maintenance after
`publish x info --json` selected a maintained CLI transport and an X browser
read or draft path hangs, times out, returns false-empty data, or lands on
unexpected UI. Native `info` remains the owner of authentication, platform
constraints, and terminal-state rules.

## Diagnose

1. End the hung action and confirm it no longer owns the persistent profile.
   Re-run the same action with `--inspect` and record the exact step, visible UI,
   URL, and relevant DOM or network evidence. Prefer a dry run or read path when
   it can reproduce the problem; do not stage content solely for diagnosis.
2. Compare the failure with the readiness classification. Do not reinterpret
   selector drift, a network error, or an unfamiliar page as logout.
3. If evidence shows an auth, challenge, or network failure, stop calibration,
   rerun native X info, and follow its recovery contract.
4. Otherwise update only the drifted surface, rebuild, and repeat the same
   action headfully before claiming the path is restored.

## Maintainer map

- Login selectors: `X_SELECTORS` in `src/session.ts`.
- Composer selectors: `X_COMPOSER_SELECTORS` in `src/x/draftPoster.ts`.
- GraphQL capture and extraction: `src/x/reader.ts`. Match operations by name,
  not query-id hash. Current monitored names include `SearchTimeline`,
  `ListLatestTweetsTimeline`, `UserTweets`, and `UserTweetsAndReplies`; verify
  the live network when a read fails.

History must fail loud rather than turn an unreadable timeline into an empty
campaign history. If responses arrive but none map to the requested handle,
recalibrate author extraction instead of weakening that guard.

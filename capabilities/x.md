---
schemaVersion: publish.channel-info-source/v1
channel: x
displayName: X
---
# X

## CLI boundary

The CLI can create/populate a watch List, watch searches or Lists, read the operator's published history, and stage tweet, thread, Article, or reply drafts. It never publishes or schedules content.

The agent is responsible for choosing the action and format, supplying final text/Markdown and any Article cover, and checking the native draft when the receipt cannot prove full persistence. The human handles login/checkpoints, Premium purchase, draft review, and the final publish decision. Tweet, thread, and reply drafts do not support media; only Articles can use a cover.

## Authentication

X uses a CLI-owned Playwright persistent profile with `X_USERNAME` and `X_PASSWORD` (`X_EMAIL` when requested by a checkpoint). First login must be completed headfully by the human; an unrelated Chrome session does not authenticate the CLI profile.

To establish or recover that session, the agent starts the intended draft or reply with `--inspect`; that command opens the CLI-owned profile, the human completes login/checkpoints there, and the same command continues afterward.

Authentication can fail because credentials are missing or rejected, the persisted session expired, X requires a human challenge, the network failed, or selector drift made the probe inconclusive. Profile and cookie files are only evidence; the auth receipt is the current result.

## Platform specification and gotchas

- Tweets and replies use `twitter-text` weighted counting after NFC normalization: maximum 280; CJK and parsed emoji weigh 2, and transformed URLs weigh 23. `--long` requires Premium; its actual draftable limit remains server-authoritative.
- Thread rows are split deterministically and each numbered row must remain within weighted 280. The receipt verifies the first row, so inspect every row when full persistence matters.
- Stage an Article with `publish x draft --format article --from <base.md>`. Articles require Premium. The first Markdown H1 becomes the title, otherwise the first non-empty line, then `Untitled`. The body limit is unknown.
- An Article cover is optional and has no flag. The CLI selects a neighboring JPG, PNG, or WebP by closeness to 5:2, preferred cover-like filename, then lexical path. Prepare 5:2 and expect X's crop editor even for an exact-ratio image.
- Reply deduplication is recorded only after successful staging; use `--force` only for an intentional duplicate.
- Drafts and Articles must remain unposted. Treat missing verification, Premium ineligibility, selector drift, or server rejection as incomplete rather than claiming success.

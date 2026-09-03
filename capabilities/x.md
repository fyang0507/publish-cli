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

X uses a CLI-owned Playwright persistent profile. Configure `X_USERNAME`, `X_PASSWORD`, and `X_EMAIL` before any authenticated X action—`create-watch-list`, `watch`, `draft`, `reply`, or `history`; this transport does not support manual credential entry or an unrelated Chrome session.

To establish or recover that session, the agent runs the intended authenticated action with `--inspect`—`create-watch-list`, `watch`, `draft`, `reply`, or `history`. That command opens the CLI-owned profile and continues afterward; do not stage a draft merely to authenticate read/list work. A human intervenes only if X presents a checkpoint.

Authentication can fail because credentials are missing or rejected, the persisted session expired, X requires a human challenge, the network failed, or selector drift made the probe inconclusive. Profile and cookie files are only evidence; the auth receipt is the current result.

## Platform specification and gotchas

- Tweets and replies use `twitter-text` weighted counting after NFC normalization: maximum 280; CJK and parsed emoji weigh 2, and transformed URLs weigh 23. `--long` requires Premium; its actual draftable limit remains server-authoritative.
- Supply exactly one of `--text` or `--from`; `--from -` reads stdin. X file/stdin input recognizes a BOM and LF, CRLF, or lone-CR leading frontmatter. A closed empty or YAML mapping block is metadata only: it is removed before tweet, thread, reply, reply-thread, or Article generation, every key is ignored, and an Article title is derived from the normalized Markdown body. Valid scalar/sequence blocks and thematic-break prose remain literal Markdown (apart from removal of a leading transport BOM under the shared file-input contract). Mapping-intent malformed or unterminated YAML exits 2 with actual/expected evidence before artifacts, state, profiles, browser, or API imports or writes. Inline `--text` remains literal and is never interpreted as frontmatter.
- Thread rows are split deterministically and each numbered row must remain within weighted 280. The receipt verifies the first row, so inspect every row when full persistence matters.
- Tweet, thread, and reply generation derives a prose stream from Markdown: a leading H1 is consumed as the document title, while later heading lines, image-only lines, and `Key: value`-shaped lines among the first eight lines of the normalized Markdown body are omitted from transport text. Every such omission is emitted as an exact source-line fidelity warning; when file/stdin frontmatter is removed, that warning applies the removed-line offset and still points to the original input line. Review those warnings before accepting the draft. Tweet/thread/reply media attachments are unsupported, so a Markdown image warning is not evidence that an image was attached.
- Stage an Article with `publish x draft --format article --from <base.md>`. Articles require Premium. The first Markdown H1 becomes the title, otherwise the first non-empty line, then `Untitled`. The body limit is unknown.
- An Article cover is optional and has no flag. The CLI scans every supported JPG, PNG, or WebP file in the directory containing the `--from` Markdown, ranking exact/closest 5:2, cover-like filename, then lexical path. Move unrelated supported images elsewhere—or keep only the intended candidate—and expect X's crop editor even for an exact-ratio image.
- `publish x reply --dry-run` validates the reply content and target ID/URL syntax, then generates and renders a tweet or a reply thread that losslessly splits the normalized reply prose, without opening the duplicate ledger or reading or writing browser/profile/data-repository/SQLite runtime state. Target existence, visibility, and reply eligibility are not verified by dry-run; X remains authoritative for those checks during a real run. Duplicate-ledger preflight is deliberately skipped, so a later real run still checks the ledger and may refuse a recorded target unless `--force` is explicitly supplied.
- Real-run reply deduplication is checked before staging and recorded only after successful staging; use `--force` only for an intentional duplicate.
- If native reply staging returns but the reply-ledger record or close fails, the command exits nonzero because the draft may already exist while durable deduplication is missing or uncertain. Never retry automatically: before any retry, compare X Unsent/Drafts manually in the same CLI-owned profile. Selector calibration and `--inspect` do not repair a ledger failure.
- Drafts and Articles must remain unposted. Treat missing verification, Premium ineligibility, selector drift, or server rejection as incomplete rather than claiming success.

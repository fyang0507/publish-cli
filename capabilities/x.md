---
schemaVersion: publish.channel-info-source/v1
channel: x
displayName: X
---
# X

## CLI boundary

The CLI can create or update a watch List, watch searches or Lists, read published history, and stage tweet, thread, Article, or reply drafts. It never publishes or schedules content.

The agent chooses the action and format, supplies final text/Markdown and any Article assets, and reports the receipt's verification limits. The operator handles account checkpoints, Premium access, draft review, and the final publication decision. Tweet, thread, and reply drafts do not support media attachments; Articles support a required cover and local body images.

## Authentication

Configure `X_USERNAME`, `X_PASSWORD`, and `X_EMAIL` before any authenticated X action. X uses a dedicated CLI-owned browser profile; manual credential entry and an unrelated Chrome session are unsupported.

To establish or recover the session, run the intended authenticated action with `--inspect`. It opens that profile and continues the requested work; do not stage a draft merely to authenticate read/list work. A human intervenes only for an X checkpoint.

Use the current auth receipt to distinguish missing or rejected credentials, an expired session, a human challenge, network failure, and an inconclusive probe caused by UI changes. Existing profile or cookie files alone do not prove readiness.

## Platform specification and gotchas

**Discovery and history**

- Before any non-dry-run `create-watch-list`, inspect the proposed member delta with `--dry-run`. A large first build can trigger an account-wide member-add lock, including the native UI across every List. On a lock or not-allowed/403 signal, stop member adds until X permits them again. Refreshing an existing List adds only missing members, paced at about three seconds per add, but does not guarantee avoidance of server limits. List creation, membership, and privacy changes are mutations.
- For account watching, create or refresh one List, then use `watch --x-list <id>`. The caller owns editorial selection. A triage rubric must be self-contained: the classifier sees only the rubric and each candidate post, without the source essay, brief, workspace files, or agent context. Include the replier, audience, selection/exclusion criteria, and what useful added value means, or use `--no-triage` and judge the candidates yourself.
- `history` reads published posts and replies authored by the requested profile; it never includes staged drafts. A failed or unusable timeline read exits nonzero rather than claiming the history is empty.

**Text, Markdown, and dry-runs**

- Supply exactly one of `--text` or `--from`; `--from -` reads stdin. Use the action's `--help` for flags and `--dry-run` to review generated content and warnings before staging. A reply dry-run checks content and target syntax without opening the browser or reply ledger; it cannot verify the target's existence, visibility, or reply eligibility.
- File/stdin input removes a leading transport BOM, normalizes line endings, and strips a closed empty or YAML mapping frontmatter block. Every metadata key is ignored, including Article titles. Valid scalar/sequence blocks and thematic-break prose remain literal Markdown. Malformed or unterminated mapping frontmatter fails locally. Inline `--text` remains literal and is never parsed as frontmatter.
- Standard tweets and replies have a weighted 280-character limit: CJK and parsed emoji count as 2, transformed URLs as 23. Each numbered thread row must fit that limit. `--long` requires Premium; X decides the actual accepted limit.
- Tweet/thread/reply generation consumes a leading H1 as the document title and omits later headings, image-only lines, and `Key: value`-shaped lines among the first eight normalized body lines. Review each source-line fidelity warning; line numbers still refer to the original file when frontmatter was removed. Image warnings do not mean images were attached.
- Top-level fenced code becomes numbered transport text such as `[code block #1 → screenshot]`, with source-line and digest evidence. Do not use the reserved `[code block #N → screenshot]` syntax in ordinary transport prose. The optional voice pass is skipped for code transforms. Review every placeholder and arrange the screenshot/image replacement during human draft review; the CLI does not attach it.
- Backtick and tilde fences may be indented up to three spaces and may run to end of input. A closer must use the same marker and be at least as long as its opener; apparent closers with other markers or trailing text remain code. Quote/list-nested fences and transformations that cannot preserve exact source boundaries fail locally. Check warnings carefully for an accidentally unclosed fence.

**Articles**

Stage with `publish x draft --format article --from <base.md> --cover <prepared-5:2.jpg|png|webp>`. Articles require Premium; their accepted body limit remains X-authoritative.

- The first substantive physical line supplies the native title: use a plain title or one ATX H1, with plain/escaped text and no formatting, links, code, entity-like spellings, or edge whitespace/control characters. The body starts on the following line; a following H1/H2 stays in the body. After frontmatter and line-ending normalization, the complete remaining Markdown is canonical and retained in `.x-article.md`.
- Supported body content is deliberately limited: paragraphs, ATX H1/H2 headings, flat single-paragraph quotes, tight flat bullet lists or ordered lists starting at 1, standalone local images, and top-level fenced code. Inline content supports plain/escaped text, emphasis, strong emphasis, soft breaks, and ordinary `[label](https://example.com)` links. Checkbox-looking list text stays literal.
- Use exact absolute HTTP(S) link destinations without credentials, whitespace, controls, or backslashes. Titled, angle-bracket, padded, multiline, or otherwise rewritten destinations reject locally. Unsupported constructs also reject rather than silently flatten: H3–H6/Setext headings, thematic breaks, HTML, inline/indented code, hard breaks, nested/loose/non-1 lists, adjacent separate same-kind list groups, and mixed/nested/titled/remote images. Use empty blank lines and avoid tabs in lists or unusual whitespace at heading/list edges; source changes caused by parsing can fail validation. Local errors identify the affected lines before platform access.
- Every Article requires an explicit JPEG/PNG/WebP cover with matching file type/extension, readable dimensions, and an exact 5:2 ratio. Prepare it beforehand: the CLI never discovers, crops, resizes, compresses, or converts the cover. `--cover` is invalid for tweet/thread drafts.
- Body images must occupy an entire top-level paragraph with empty alt text and no title, for example `![](diagram.png)` or a resolved empty-alt reference. Use local GIF/JPEG/PNG/WebP files with matching extensions and readable positive dimensions. Remote, data, blob, and file URLs are unsupported. Relative paths resolve from the Markdown file's directory, or the invocation directory for stdin. Repeated occurrences are kept in order. Files are read once before staging and uploaded unchanged; X may transform them. No X image size/count limit is claimed.
- Real staging with body images requires `--inspect`. An uncertain or rejected cover/body-image upload stops further insertions; the CLI never retries it through another control or upload route. The receipt preserves partial asset evidence so an incomplete upload is not mistaken for a completed Article.
- Article fences are excluded from the native rich-text body, even in a verified receipt. Each has an advisory with original/canonical line ranges, closure, bounded preview, and a complete source digest. Finish each block through native Insert → Code or reviewed screenshots during human review. Raw code remains in `.x-article.md`; terminal inspection shows block numbers/digests, and file-backed dry-runs keep separate `.x-article.inspection.txt` receipts. These are inspection artifacts; the native draft is the deliverable.

**Verification and retry decisions**

Native staging reports one save phase:

| Phase | Meaning and next step |
|---|---|
| `save_not_attempted` | No native Save/Create attempt. Correct the reported issue before another run. |
| `save_delivery_unknown` | The persistence action may have reached X. Compare native drafts in the same profile before considering a retry. |
| `save_delivered_unverified` | The action returned, but persistence or required content/target evidence is incomplete. A draft may exist; compare it manually. |
| `verified` | The receipt's required checks passed, subject to the format limits below. |

Tweet/thread/reply persistence begins with close → Save. Article Create can begin autosave; an edit URL alone does not prove persistence. Never retry automatically after unknown or unverified delivery. Inspect X Unsent/Drafts or Articles → Drafts in the exact CLI-owned profile used by that run; a matching draft or uncertain comparison is a stop condition.

- Tweet/thread verification checks the full tweet or first thread row against native Unsent/Drafts before and after Save. Prefixes, pre-existing identical drafts, duplicate matches, or other visible-row changes cannot verify a save. This is visible-content evidence without a stable native draft ID or proof the displayed list is complete. Inspect every thread row when full persistence matters.
- Article verification reopens the same canonical `https://x.com/compose/articles/edit/<digits>` URL after autosave and compares the complete intended native title/body after whitespace/case normalization. It also checks cover identity/dimensions and ordered body-image positions/identities/dimensions. Missing or conflicting URLs and weak or mismatched evidence remain unverified. Excluded code still requires the handoff above.
- Article receipts separate requested assets, upload delivery, native observation, and reopen verification. Cover Apply is recorded independently as `not_attempted`, `delivery_unknown`, or `returned`; independent persistence proof can verify the cover without claiming Apply returned. A rejected upload remains delivery-unknown and is not retried.
- Reply content and target identity are separate checks. Current production cannot prove the exact numeric target ID from the saved native draft. A returned real reply Save therefore records `staged-unverified` and exits 1 even when content verifies. A compose URL, `Replying to` label, or background link is not target proof. Review the actual target in the native draft.
- For failures, follow the sanitized receipt's `substage`, `reason`, and recovery guidance. Missing/ambiguous controls or a rejected browser operation do not by themselves prove an auth or network failure. `--inspect` helps investigation but does not weaken verification or repair reply-ledger failures.

**Reply targets and duplicate protection**

- `reply --to` accepts a 5–25 digit ASCII ID without leading zeroes, or an HTTPS URL on exactly `x.com` or `twitter.com`. Allowed paths are `/<handle>/status/<id>`, `/<handle>/statuses/<id>`, `/i/status/<id>`, and `/i/web/status/<id>`, with one optional trailing slash. Handles are 1–15 ASCII letters, digits, or underscores. Scheme/host are case-insensitive; paths are case-sensitive. Query/fragment text is ignored after path validation. Whitespace, control/BOM characters, backslashes, credentials, explicit ports, subdomains, trailing-dot hosts, encoded status paths, and extra/dot path segments reject locally.
- Read dedupe and reply duplicate protection are separate. Real replies reserve the target before browser work; successful staging outcomes are then recorded in history. `--force` can bypass matching-origin finalized history only. It never bypasses an active or retained reservation, or history whose origin is unknown or mismatched.
- Coordination requires the same live SQLite file and the same machine-local X profile origin. The reply database binds to that profile; opening it from another profile fails before browser work. Copied/synchronized databases do not coordinate across machines, copied profiles are unsupported, and legacy rows retain unknown origin. Keep the original profile and database available for recovery.
- A failure proven to precede Save releases that run's reservation. Interrupted, delivery-unknown, untyped, or malformed outcomes retain it. A returned but target-unverified outcome records `staged-unverified` history and clears the reservation; this is duplicate protection, not proof that a correctly targeted draft exists. Only after confidently finding no matching draft in the originating profile may a separate explicit `--force` run bypass that finalized entry.
- A reservation at least 24 hours old is eligible for explicit recovery, never automatic expiry. First ensure the prior process stopped and check native drafts in the originating profile. If a matching draft exists or comparison is uncertain, leave the reservation in place. Only after confirming no matching draft exists, use `--recover-stale-reservation-after-confirming-no-draft`; it clears the claim and exits without staging. Unknown/mismatched-origin claims cannot be recovered. See action help for incompatible flags.
- If reply-ledger finalization fails after Save, the durable history/reservation outcome may be unknown. If finalization succeeded but cleanup failed, the finalized status is known. Both exit nonzero: inspect durable state and same-profile native drafts before any further run.

**Receipts**

`draft --json` and `reply --json` each emit one `publish.transport-receipt/v1` document covering validation, platform access, save phase, verification, assets, warnings, and possible residue, with `published:false`. Exit 0 means a valid dry-run or verified staging; exit 1 means a runtime/platform/state failure or incomplete verification; exit 2 means local input rejection before platform access. Real reply conflicts are state failures (exit 1).

Human output escapes unsafe terminal characters and bounds long fields without changing canonical content or artifacts. Use the artifacts for full source review. Missing verification, Premium ineligibility, UI changes, and server rejection are incomplete outcomes, never successful drafts.

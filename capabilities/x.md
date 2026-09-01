---
schemaVersion: publish.channel-info-source/v1
channel: x
displayName: X
---
# X

## CLI boundary

`publish x info [--json]` returns static capabilities plus a passive authentication-readiness receipt. It succeeds when authentication is not ready and never logs in, opens a composer, creates a draft, or posts.

The X transport may read X, manage an X List, and stage native drafts:

- `publish x create-watch-list [--from-following] [--handle <handle>] [--name <name>] [--description <text>] [--x-list <id>] [--private|--public] [--limit <n>] [--dry-run] [--inspect] [--json]` creates or idempotently populates an X List from Following and prints its id. The default is a private List sourced from the logged-in account's Following. This writes List membership, but never posts.
- `publish x watch [--query <q...>] [--x-list <id...>] [--config <path>] [--languages <codes|all>] [--persona <text>|--persona-from <path>] [--no-triage] [--validate-config] [--inspect] [--format <text|json|markdown|md>] [--json] [--out <file>]` captures search/List GraphQL responses in the authenticated browser, deduplicates, optionally filters language and runs Gemini triage, and returns candidates. Lists are watched as Lists, not as one request per member. It may update local seen state; it never posts.
- `publish x draft --format <tweet|thread|article> ...` stages a native Unsent post/thread or autosaved Article draft. It never operates Post, Post all, Publish, or scheduling.
- `publish x reply --to <id|url> (--text <content> | --from <base.md|->) [--long] [--dry-run] [--inspect] [--force]` stages a native reply draft; overflow can become a thread. A reply ledger refuses to re-stage the same target after a successful stage unless `--force`. It never sends the reply.
- `publish x history [--handle <handle>] [--limit <n>] [--include <posts|replies|all>] [--since <iso>] [--format <text|json|markdown|md>] [--json] [--out <file>] [--inspect]` reads the operator's own live published posts and replies, excluding reposts and other authors' quoted posts. It is read-only; staged drafts are absent because they are not live.

The CLI renders caller-supplied content and transports caller-supplied assets. The agent chooses the format, prepares canonical text/Markdown and any cover, resolves readiness, runs dry-run where available, and checks the receipt. The human completes login/checkpoints or Premium purchase, reviews the native draft, and alone decides whether to publish. X remains authoritative for eligibility, unknown limits, media transforms, and draft persistence. The CLI does not generate, resize, compress, convert, or redesign assets, and tweet/thread/reply transport has no media attachment path.

## Authentication

Run `publish x info` first. Readiness requires a positive live authenticated signal; `PUBLISH_DATA_DIR/x-profile` and `PUBLISH_DATA_DIR/x-cookies.json` are advisory evidence only. The passive probe navigates an ephemeral copy of the profile and does not call the automatic login execution path, submit credentials, or reinterpret selector/navigation failure as logout.

The entry URL is `https://x.com/home`. The CLI browser owns `PUBLISH_DATA_DIR/x-profile`; a session opened in unrelated Chrome or another browser backend does not transfer into that profile. There is no separate side-effect-free CLI login command. On first use, configure `X_USERNAME` and `X_PASSWORD` (plus `X_EMAIL` when the checkpoint requires it), prepare the real intended draft, and run that exact `publish x draft ... --inspect` or `publish x reply ... --inspect` command. Its headful Playwright window uses the persistent CLI profile: let the human complete login/checkpoints there, positively verify the Home UI, then allow the command to continue to the native-draft terminal state. After it closes, rerun `publish x info`; `readiness.ready=true` is the positive reusable-session check. Do not use throwaway content merely to bootstrap, because the execution command can stage it.

X blocks headless first login. On a fresh machine, establish the session through that intended headful execution path; never copy cookies between machines. Preserve `login_required`, `human_challenge_required`, `network_error`, and `probe_inconclusive` as distinct outcomes, and do not expose credentials or cookie values.

## Platform specification and gotchas

### Tweet / post

Use `publish x draft --format tweet (--text <content> | --from <base.md|->) [--long] [--dry-run] [--inspect]`. Supply exactly one text source; `--from -` reads stdin. Run `--dry-run` first, then stage only when the complete rendered text is valid.

Standard posts use `twitter-text` weighted counting after NFC normalization: maximum 280; Latin/common characters weigh 1; CJK and parsed emoji/ZWJ sequences weigh 2; transformed URLs weigh 23. A successful run ends at a native Unsent draft. If verification is unconfirmed, visibly inspect Unsent instead of claiming persistence.

`--long` is for an eligible Premium account. X documents a 25,000 platform maximum, but the measurement and maximum draftable length are unknown. The local 25,000-Unicode-code-point guard is a legacy transport policy, not a confirmed platform measurement. Premium web drafts at weighted lengths 281 and 500 saved and reopened in the 2026-08-31 fixture, despite conflicting official web-draft guidance; those are lower-bound fixtures, not proof of 25,000-draft support.

### Thread

Use `publish x draft --format thread (--text <content> | --from <base.md|->) [--dry-run] [--inspect]`. The deterministic numbered rows must each remain at or below weighted 280 after numbering. No row receives media. The terminal state is a native multi-row Unsent draft; current verification matches the first row, not every row after reopen, so inspect all rows when full persistence proof matters. Never operate Post all.

### Article

Use `publish x draft --format article --from <base.md> [--dry-run] [--inspect]`. Articles require Premium. The title is the first Markdown H1, otherwise the first non-empty line, otherwise `Untitled`; the body maximum is unknown.

A cover is optional and there is no cover flag. Place already-prepared `.jpg`, `.jpeg`, `.png`, or `.webp` candidates beside the Markdown. Selection is deterministic: a ratio within absolute distance 0.02 of 5:2 first, then names containing `hero`, `cover`, `banner`, `og`, `5x2`, or `5-2`, then the ratio closest to 5:2, then lexical full path. To remove any selection ambiguity, keep only the intended supported image beside the Markdown or give it the winning ratio/name/path. `--dry-run` renders article content but does not inspect cover files; the real-run receipt names the uploaded path and dimensions, and the agent may inspect candidates before browser execution. JPEG, PNG, and WebP covers at 1500x600 and 1500x620 were accepted on 2026-08-31. Use 5:2 as preparation guidance, but byte limits, dimension limits, accepted ratio range, exhaustive MIME support, pixel-exact crop fidelity, and other transformations remain server-authoritative. Every tested upload, including exact 5:2, opened X's crop editor and required Apply.

The Article autosaves and returns an editor id/URL. Reopen when persistence matters: the fixture preserved title, representative body text, bold, a two-item unordered list, and cover presence. Stop in the autosaved/reopened Article editor; never operate Publish.

### Reply, reads, and terminal conditions

Replies use the same standard weighted-length rules and the optional Premium `--long` policy. `--dry-run` must not touch the browser. Record the reply ledger only after successful staging; use `--force` only for an intentional duplicate draft. Stop at the native reply draft.

X reads deliberately use browser GraphQL response capture matched by operation name, not drifting query hashes or out-of-band HTTP clients. Treat selector drift, absent verification, Premium ineligibility, or an unknown server rejection as a stop condition: correct evidenced local input, request human action where needed, or report the result as unconfirmed. Nothing in this channel may click Post, Post all, Publish, or schedule publication.

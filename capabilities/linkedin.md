---
schemaVersion: publish.channel-info-source/v1
channel: linkedin
displayName: LinkedIn
---
# LinkedIn

## CLI boundary

`publish linkedin info [--json]` returns the static personal-post contract plus passive authentication readiness. It succeeds when authentication is not ready and never logs in, opens the composer, creates a draft, or posts.

The only execution command is `publish linkedin draft (--text <content> | --from <base.md|->) [--media <path> ...] [--bold] [--dry-run] [--inspect]`. It deterministically converts one inline, Markdown-file, or stdin source to a single plain-text personal feed post, preserves emoji, optionally converts Markdown emphasis to Unicode math-bold with the stated accessibility caveat, attaches repeatable caller-supplied local images in flag order, and invokes LinkedIn's native Save as draft flow. `--dry-run` generates only and does not open a browser.

The CLI does not support LinkedIn WATCH, articles, newsletters, company-page posts, video, documents, scheduling, or public send. It does not generate, normalize, crop, resize, or redesign images. The agent prepares text and local image paths, resolves readiness, previews, stages, and visibly checks any media. The human completes login/checkpoints, reviews restored content and link-preview choices, and alone decides whether to click Post. LinkedIn controls account rules, media layout/transforms, link-preview interaction, and native persistence.

## Authentication

Run `publish linkedin info` first. Readiness requires a positive live authenticated signal; `PUBLISH_DATA_DIR/li-profile` and `PUBLISH_DATA_DIR/li-cookies.json` are evidence, not proof. The passive probe uses an ephemeral copy of LinkedIn's separate persistent profile and does not submit credentials, invoke automatic login, open a composer, or classify navigation/selector failure as logout.

The entry URL is `https://www.linkedin.com/feed/`. The CLI browser owns `PUBLISH_DATA_DIR/li-profile`; a session opened in unrelated Chrome or another browser backend does not transfer into it. There is no separate side-effect-free CLI login command. On first use, configure `LI_USERNAME` and `LI_PASSWORD` (plus `LI_EMAIL` when a checkpoint requires it), prepare the real intended post, and run that exact `publish linkedin draft ... --inspect` command. Its headful Playwright window uses the persistent CLI profile: let the human finish login/checkpoints there, positively verify the authenticated feed, then allow the command to continue to Save as draft. After it closes, rerun `publish linkedin info`; `readiness.ready=true` is the positive reusable-session check. Do not use throwaway content merely to bootstrap, because the execution command can stage it. Do not copy cookies between machines. Keep login-required, challenge, network, and inconclusive outcomes distinct, and never expose credentials or cookie values.

## Platform specification and gotchas

### Personal feed post

Supply exactly one of `--text` or `--from`; `--from -` reads stdin. Text is locally capped at 3,000 UTF-16 code units, matching both documented maximum and the 2026-09-01 live boundary fixture. Over-limit input remained in the editor while Post was disabled; the CLI must reject rather than truncate. Run `--dry-run` to inspect the complete plain-text rendering, links, UTF-16 length, media order, and any Unicode-bold advisory.

Real staging opens the composer via `https://www.linkedin.com/feed/?shareActive=true`; direct `/sharing/compose` was a 404 in the 2026-07 calibration. LinkedIn auto-restores the last text draft, so the CLI select-all-clears stale content before typing. Saving is Dismiss followed by the text control Save as draft. Discard and Post are forbidden controls and are never selected. The terminal state is a native personal-post draft; reopen and compare restored text before claiming success.

### Images and link previews

Each `--media <path>` must be an existing local image. The CLI attaches paths in command-line order and performs no image transformation. Live fixtures accepted JPEG, PNG, GIF, and WebP, at least 21 images, and at least 5,246,142 bytes for one PNG. They also accepted 551x276 and 552x275 images, plus 4:1 and 3:5 ratios outside older documented guidance. These are observed lower bounds, not maxima.

LinkedIn's documented guidance says up to 20 images, 5 MB each, minimum 552x276, 36,000,000 maximum pixels, and ratios from 3:1 through 4:5; it lists JPEG/PNG/GIF for desktop. Because newer live acceptance conflicts with the count, bytes, minimum dimensions, ratio range, and WebP list, actual count, byte, dimension, and ratio boundaries remain server-authoritative. In the fixtures, the editor preview used `object-fit: contain` and did not auto-crop; observed manual crop presets were original, 1:1, 3:4, 4:1, and 16:9.

Official guidance says image media and a link preview are mutually exclusive, but live replacement behavior is unresolved. Text restoration is confirmed; a bounded media Save as draft attempt remained in progress, so successful media save, restored count/order, and first-image layout are unknown. If media was requested, reopen and visibly verify every image rather than inferring persistence from a successful text receipt.

Stop when the intended native draft is saved and the required text/media evidence has been checked. If Save as draft fails, text does not restore, or media is not visibly confirmed, report the draft as incomplete or unconfirmed. Never operate Post.

---
schemaVersion: publish.channel-info-source/v1
channel: linkedin
displayName: LinkedIn
---
# LinkedIn

## CLI boundary

The CLI stages one personal-feed text post, optionally with caller-supplied local images, through LinkedIn's native Save as draft flow. It converts Markdown to plain text and can apply Unicode math-bold; it does not support articles, newsletters, company pages, video, documents, scheduling, or publishing.

The agent supplies and previews the final text and image order, stages the draft, and visibly checks requested media. The human handles login/checkpoints, reviews the restored draft and link preview, and makes the final Post decision. The CLI does not generate, crop, resize, or redesign images.

## Authentication

LinkedIn uses a separate CLI-owned Playwright persistent profile. Configure `LI_USERNAME`, `LI_PASSWORD`, and `LI_EMAIL` before the first content-bearing command; this transport does not support manual credential entry or transfer an unrelated browser session.

To establish or recover that session, the agent starts the intended draft with `--inspect`; that command opens the CLI-owned profile, the human completes any checkpoint there, and the same command continues afterward.

Authentication can fail because credentials are missing or rejected, the persisted session expired, LinkedIn requires a checkpoint, the network failed, or selector drift made the probe inconclusive. Profile and cookie files are only evidence; the auth receipt is the current result.

## Platform specification and gotchas

- Supply exactly one of `--text` or `--from`; `--from -` reads stdin. File/stdin input strips a well-formed leading YAML mapping or empty frontmatter block. On those inputs a leading `---` is reserved for frontmatter, so malformed, unterminated, scalar, or sequence frontmatter is rejected instead of leaking into the draft; inline `--text` keeps a leading `---` literal. The CLI rejects, rather than truncates, text over 3,000 UTF-16 code units.
- Markdown renders as plain text. `--bold` uses Unicode math characters, which can reduce accessibility and searchability; inspect with `--dry-run`.
- Markdown image syntax never attaches a file: it is omitted from the plain-text body and surfaced for inspection. Repeat `--media` for existing local images in the desired order. Media-only draft staging has not been live-verified and is unsupported, so the CLI requires non-empty rendered text even when `--media` is present. LinkedIn's documented guidance is up to 20 JPEG/PNG/GIF images, 5 MB each, at least 552x276, at most 36,000,000 pixels, with ratios from 3:1 through 4:5. Live acceptance has exceeded several of these values and accepted WebP, so the server remains authoritative.
- Before any browser access, each `--media` path must be a readable regular file whose bytes have a recognized JPEG, PNG, GIF, or WebP magic/header, whose positive dimensions can be read from that header, and whose filename extension matches the detected type. Header-invalid, dimension-unreadable, and extension-mismatch inputs are rejected locally with measured evidence; changing a suffix does not convert an image.
- Image persistence and interaction with link previews are not reliably proven by the text-draft receipt. Reopen the draft and verify every requested image, order, crop, and preview before claiming completion.
- LinkedIn can auto-restore an older draft; the CLI clears it before typing. The terminal state is Save as draft, never Post.

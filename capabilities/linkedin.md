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
- One deterministic CommonMark/GFM parser owns link conversion and evidence. Inline links, full/collapsed/shortcut reference links, bare URLs, autolinks, and definitions nested in lists or quotes resolve from that parser: visible labels retain the parser destination, character references decode once before rendering and destination dedupe, definitions disappear, HTTP(S) destinations are deduplicated in first-seen advisory order, and autolinks lose their angle brackets. Parser-confirmed raw HTML exits 2 before profile/browser access because its visible text cannot be recovered faithfully; HTML- or link-looking text inside code spans or code blocks remains inert.
- Image evidence uses parser-normalized alt text, including normalized escapes and code spans. Image-looking literals inside code or raw HTML never become image evidence.
- If conversion leaves no transportable text, exit 2 identifies only the constructs actually omitted: code blocks, Markdown images, link-reference definitions, thematic breaks, or whitespace.
- Markdown image syntax never attaches a file: it is omitted from the plain-text body and surfaced for inspection. Repeat `--media` for existing local images in the desired order. Media-only draft staging has not been live-verified and is unsupported, so the CLI requires non-empty rendered text even when `--media` is present. LinkedIn's documented guidance is up to 20 JPEG/PNG/GIF images, 5 MB each, at least 552x276, at most 36,000,000 pixels, with ratios from 3:1 through 4:5. Live acceptance has exceeded several of these values and accepted WebP, so the server remains authoritative.
- Before any browser access, each `--media` path must be a readable regular file whose bytes have a recognized JPEG, PNG, GIF, or WebP magic/header, whose positive dimensions can be read from that header, and whose filename extension matches the detected type. Header-invalid, dimension-unreadable, and extension-mismatch inputs are rejected locally with measured evidence; changing a suffix does not convert an image.
- Image persistence and interaction with link previews are not reliably proven by the text-draft receipt. Reopen the draft and verify every requested image, order, crop, and preview before claiming completion.
- LinkedIn can auto-restore an older draft; the CLI clears it before typing. The terminal state is Save as draft, never Post.
- Native staging reports one LinkedIn-local closed save phase: `save_not_attempted`, `save_delivery_unknown`, `save_delivered_unverified`, or `verified`. Failures before the Save as draft click prove that action was not invoked. A rejected Save click has unknown delivery because the click may already have reached LinkedIn. After the click returns, a settle/reopen failure or a reopened editor whose complete text does not equal the complete intended text after only line-ending and NFC normalization is delivered but unverified. Prefixes, substrings, case folding, whitespace collapse, background text, and a previously restored different draft are never positive evidence.
- Only positive full-text verification after reopening the composer exits 0. Every delivery-unknown or delivered-unverified outcome exits 1 because a native draft may exist. Before any retry, reopen the composer in the exact same CLI-owned LinkedIn profile at `https://www.linkedin.com/feed/?shareActive=true` or through feed `Start a post`, then compare the restored text and media. If a matching draft exists or the comparison is uncertain, do not retry. Only after that comparison may `--inspect` help diagnose selector drift; it is secondary and cannot prove that no draft exists.
- Save-progress failure receipts are fixed, bounded, and content-free. Raw browser errors, selectors, page text, credentials, cookies, private paths, and poster-supplied notes never reach terminal output.
- Human terminal output is a presentation-only projection of the same closed, recursively frozen post/media snapshot used for staging. Caller lines are visibly framed; terminal/layout controls and literal backslashes have unambiguous visible spellings. Each field and the whole command transcript are bounded; truncation reports exact original UTF-16 size plus SHA-256 over the complete unnormalised UTF-8 scalar string. Unpaired surrogates or an invalid projection exit 2 before browser/profile/native staging. Composer text and media paths are not rewritten by terminal projection.
- `publish linkedin draft ... --json` emits exactly one `publish.transport-receipt/v1` document; the human summary is rendered from the same frozen facts. Media is reported in caller order with separate requested, resolved, file-input-set, observed, and verified stages. A successful file chooser or `setInputFiles` call proves only `set`, never UI attachment or persisted media. The receipt also preserves possible composer residue and same-profile manual-review guidance after incomplete staging, always with `published:false`.

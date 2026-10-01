---
schemaVersion: publish.channel-info-source/v1
channel: linkedin
displayName: LinkedIn
---
# LinkedIn

## CLI boundary

The CLI stages one personal-feed text post with optional local images through LinkedIn's native Save as draft flow. It supports plain text converted from Markdown and optional Unicode bold. Articles, newsletters, company pages, video, documents, scheduling, and publishing are unsupported.

The agent prepares and previews the text and image order, stages the draft, and checks requested media. The operator handles login checkpoints, reviews the restored draft and link preview, and makes the final Post decision. The CLI does not create or edit images.

## Authentication

LinkedIn uses a separate CLI-owned browser profile. Configure `LI_USERNAME`, `LI_PASSWORD`, and `LI_EMAIL` before drafting; manual credential entry and unrelated browser sessions are unsupported.

To establish or recover the session, start the intended draft with `--inspect`. The operator completes any checkpoint in the browser opened by that command, then the same command continues.

Authentication can fail because credentials are missing or rejected, the session expired, a human checkpoint is required, the network failed, or a changed page made the probe inconclusive. Existing profile or cookie files do not prove a working session; follow the current auth receipt.

## Platform specification and gotchas

### Prepare the draft

- Supply exactly one of `--text` or `--from`; `--from -` reads stdin. File/stdin input removes a leading YAML mapping or empty frontmatter block. A leading `---` is reserved for frontmatter on those inputs, and invalid or non-mapping frontmatter is rejected. Inline `--text` stays literal.
- The CLI rejects text over 3,000 UTF-16 code units instead of truncating it. Run `--dry-run` to inspect the converted text. Unicode `--bold` can reduce accessibility and searchability.
- Markdown links retain their visible labels and destinations, while reference definitions disappear. Raw HTML is rejected before browser access; escape it or use inline code to show HTML-looking text. Code blocks and Markdown images are omitted, and the result must contain non-empty text. A media-only draft is unsupported.
- Markdown image syntax does not attach a file. Repeat `--media` for readable local JPEG, PNG, GIF, or WebP images in the desired order. File contents, dimensions, and extension must agree; renaming a suffix does not convert an image.
- LinkedIn's documented image guidance is up to 20 JPEG/PNG/GIF images, 5 MB each, at least 552×276, at most 36,000,000 pixels, and ratios from 3:1 through 4:5. Live acceptance has differed, including accepting WebP; LinkedIn decides the final limits.
- Reopening the composer restores the last saved draft, with any link-preview card it carries. A saved draft keeps the first card it got, even after its text is cleared or the card is dismissed, so the CLI discards a restored draft (close → Discard) before typing. The new Save would replace that draft anyway, but anything in it is lost even if this run then stops before Save.
- While a link-preview card is attached, the composer hides its Media control. With `--media`, the CLI dismisses the card LinkedIn generates for a link in the new text before attaching the images. When attaching media or video by hand, dismiss the card first.

### Verify and recover

Only a complete text match after reopening the saved composer exits 0. LinkedIn rewrites links in a saved draft to `https://lnkd.in/<code>`; a short link counts as the link it replaces, and every other character must match. A new draft can take several seconds to restore, so the CLI reopens a composer that stays empty, up to five times. LinkedIn sometimes rejects a Save made right after a Discard or while a link preview or image is still loading ("We encountered a problem sharing your post"), so the CLI waits before each; a rejected Save leaves the receipt unverified. An image can restore several seconds after the text. The receipt distinguishes Save not attempted, delivery unknown, delivered but unverified, and verified. A failed Save click may still have reached LinkedIn; delivery-unknown and unverified saves exit 1 because a draft may exist.

Text verification does not reliably prove image persistence or link-preview behavior. Reopen the draft and check every requested image, its order and crop, and the preview before claiming the requested draft is complete. A successful file chooser alone proves no attachment or persistence.

Before any retry, reopen the composer in the exact same CLI-owned LinkedIn profile at `https://www.linkedin.com/feed/?shareActive=true` or through feed `Start a post`, and compare the restored text and media. If a matching draft exists or the comparison is uncertain, do not retry. Only after checking the existing draft should `--inspect` be used to diagnose changed page controls.

Use `--json` for a structured receipt with save status, separate media evidence, and any content that may remain in the composer. It always reports `published:false`. Terminal summaries may escape or shorten displayed input; they do not alter the staged content.

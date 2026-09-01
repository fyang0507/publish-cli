---
schemaVersion: publish.channel-info-source/v1
channel: wechat
displayName: WeChat Official Account
---
# WeChat Official Account

## CLI boundary

The CLI can check Official Account API access and turn Markdown into one inline-styled `article_type=news` draft: it uploads the required cover and local body images, rewrites image URLs, and calls `draft/add`. It never calls `freepublish/*` or `message/mass/*`.

The agent prepares the article and assets, configures fixed egress, runs dry-run, creates the draft, and inspects the 草稿箱 preview. The human provisions credentials, QR-authorizes IP allowlist changes, reviews the preview, and makes any later publication decision in the official console. The CLI does not design, crop, resize, compress, or deduplicate covers.

## Authentication

WeChat uses `WECHAT_APP_ID` and `WECHAT_APP_SECRET` over the Official Account API, not a browser profile. Every call must use one stable, allowlisted egress configured with either `WECHAT_SSH_TUNNEL` or `WECHAT_PROXY_URL`; a short-lived stable token is cached locally and may be renewed automatically.

Authentication can fail because credentials are missing or rejected, token exchange fails, error `40164` reports an egress IP absent from IP白名单, the SSH tunnel/proxy or network fails, or the API response is inconclusive. There is no allowlist-edit API: a human must add the reported IP in the developer console and approve it by QR scan.

## Platform specification and gotchas

- Supply exactly one of `--from` or `--text`. Title resolves from `--title`, frontmatter, or the leading H1. A cover resolves from `--cover` or frontmatter and is required. For file input, relative frontmatter/body-image paths resolve beside the Markdown; a `--cover` flag resolves from the invocation directory.
- Documented limits are title 32 字, author 16 字, and digest 120 字, but exact Unicode measurement is unknown and server-authoritative. Conflicting HTML-size documentation also makes the effective body limit unknown.
- The renderer uses inline `style=` because WeChat strips stylesheets and classes. JavaScript is removed; external images are filtered; external links become bottom citations unless `--keep-links` is requested.
- Documented cover formats are BMP, PNG, JPEG/JPG, and GIF with a `10M` label. WeChat presents 2.35:1 and 1:1 crops; these are preview crops, not proven required input ratios. Inspect both.
- Local body images use JPG or PNG with documented wording `1MB以下`. Exact byte, dimension, count, recompression, and quota boundaries remain server-authoritative.
- A successful API receipt is not visual proof. Verify title, inline styling after sanitization, body images, links/citations, and both cover presentations in 草稿箱.

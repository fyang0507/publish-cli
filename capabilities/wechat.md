---
schemaVersion: publish.channel-info-source/v1
channel: wechat
displayName: WeChat Official Account
---
# WeChat Official Account

## CLI boundary

`publish wechat info [--json]` returns the static article contract plus API readiness. `publish wechat check [--json]` is a read-only preflight that verifies credentials, obtains/renews a stable token when necessary, and confirms that WeChat accepts the fixed egress IP. Neither command uploads material nor creates or publishes a draft.

`publish wechat draft (--from <base.md|-> | --text <content>) [--title <title>] [--author <name>] [--digest <summary>] [--cover <image>] [--source-url <url>] [--keep-links] [--out <file.html>] [--dry-run]` deterministically renders one `article_type=news` article, uploads the required permanent cover and local body images, rewrites body image sources to WeChat CDN URLs, and calls `/cgi-bin/draft/add`. `--dry-run` performs local render/validation only: no token exchange, upload, network call, or `draft/add`. `--out` writes the pre-upload inline-styled HTML; local body paths are not CDN-rewritten in that artifact.

The API transport is structurally draft-only. It may call `stable_token`, `get_api_domain_ip`, `media/uploadimg`, `material/add_material`, and `draft/add`. It must never call `freepublish/*` or `message/mass/*`. The CLI does not design, resize, crop, compress, or deduplicate covers. The agent prepares content/assets and fixed egress, runs readiness and dry-run, stages, and inspects the 草稿箱 preview. The human provisions credentials, QR-authorizes allowlist changes, reviews the preview/crops, and alone makes any later publication decision in the official console. WeChat remains authoritative for token/IP acceptance, 字 measurement, HTML/media limits, sanitization, transforms, quotas, and persistence.

## Authentication

This channel uses the Official Account API, not a browser profile. Configure `WECHAT_APP_ID` and `WECHAT_APP_SECRET`, then exactly one fixed-egress option:

- `WECHAT_SSH_TUNNEL=publisher@203.0.113.10` means a non-interactive `ssh publisher@203.0.113.10` already works; the CLI starts `ssh -N -D` on a temporary local port, routes all WeChat calls through it, and tears it down. The example IP is documentation-only; substitute the operator's fixed-IP host.
- `WECHAT_PROXY_URL=socks5://user:password@proxy.example:1080` or `WECHAT_PROXY_URL=https://user:password@proxy.example:8443` points at an existing SOCKS5 or HTTP(S) proxy whose public egress IP is stable. Substitute real values and keep credentials out of logs and committed files.

Set only one. Every API call, including token minting, uses the same selected egress.

The administrative entry URL is `https://developers.weixin.qq.com/platform/`. `publish wechat check` is the canonical single-channel preflight before drafting; it reports credentials → token → IP allowlist and stages nothing. `publish auth check --platform wechat` invokes the same underlying readiness probe for batch automation but has the shared auth-receipt shape; the commands are not output aliases. If `wechat check` receives `40164`, it prints the exact public egress IP WeChat observed. A human opens the developer console, QR-authorizes adding that IP to IP白名单, and reruns `publish wechat check` until all three gates pass. A successful check reports the selected egress description; it need not rediscover an already-allowlisted public IP. The allowlist has no edit API, requires an admin QR scan for changes, and is capped at 15 IPs, so this step cannot be automated. Unlike browser channels, there is no same-browser drafting context (`continueInSameContext: false`): the console is only the human administration/review surface, while the CLI owns API execution.

The short-lived stable-token cache is `PUBLISH_DATA_DIR/wechat-token.json`; there is no browser profile or cookie cache. Normal token renewal may create/update this file and must be reported as `readiness.healed: ["token_refreshed"]`. Missing/rejected credentials, `40164`, network failure, and inconclusive proof are distinct outcomes. Never emit the App Secret, token, proxy credentials, private headers, or unrelated API content.

## Platform specification and gotchas

### Article fields and rendering

Supply exactly one of `--from` and `--text`; `--from -` reads stdin. The title is required after resolution from `--title`, frontmatter `title`, or a leading Markdown H1. The cover is required after resolution from `--cover` or frontmatter `coverImage`, `cover`, or `image`. Author resolves from `--author`, frontmatter, or `WECHAT_AUTHOR`. Digest resolves from `--digest` or frontmatter `description`/`summary`/`digest`; when omitted, WeChat documents deriving the first 54 字. Source URL resolves from `--source-url` or frontmatter `sourceUrl`/`contentSourceUrl`.

The renderer emits inline `style=` on every element because WeChat strips `<style>`, `<link>`, and CSS classes. JavaScript is removed. External images are filtered unless uploaded through WeChat. External links are rewritten to bottom citations by default; `--keep-links` retains inline links for server sanitization.

Documented limits are title 32 字, author 16 字, and digest 120 字, but exact Unicode measurement is unknown and server-authoritative; do not implement these as code-point limits. The draft documentation also contains conflicting HTML limits—“not over 2 kb,” fewer than 20,000 characters, and under 1 MB—so the effective maximum is unknown. The source URL is documented as 1 kb, but its exact byte boundary is unknown.

### Asset paths and media

For `--from <file>`, relative body-image paths and frontmatter cover paths resolve from the Markdown file's directory. For inline `--text` and stdin, relative body assets resolve from the invocation working directory. A `--cover` flag always resolves from the invocation working directory. Absolute paths are accepted.

The required cover is uploaded as permanent material. Documented cover formats are BMP, PNG, JPEG/JPG, and GIF with a `10M` limit label; exact bytes, minimum/recommended/maximum dimensions, required input ratio, GIF animation persistence, default crop, and recompression behavior are unknown. WeChat documents crop presentations at 2.35:1 and 1:1; these are preview crops, not a proven required input ratio. Prepare the image deliberately and inspect both crops in 草稿箱.

Local body images support JPG and PNG with documented wording `1MB以下`; exact bytes, pixel dimensions, maximum count in news HTML, and recompression/metadata behavior are unknown. Body images use `uploadimg` and do not count against permanent-image quota. Each fresh cover upload consumes permanent material quota; documented limits are 100,000 image/news materials and 1,000 for other material types, including console-created materials. Identical-cover deduplication is unknown.

### Draft terminal boundary

After readiness, run dry-run and optionally inspect `--out`. A real run uploads the cover, uploads/rewrites body images, then calls `draft/add`. Success returns a draft `media_id`, `thumb_media_id`, body-image count when applicable, and the 草稿箱 URL. Open that URL and visibly inspect title, inline styling after sanitizer, body images, citations/links, and both cover presentations.

Do not claim completion if upload/quota/server validation fails or the preview differs. Stop only at an accepted native 草稿箱 draft. Publication remains a separate human action; no `freepublish` or mass-message endpoint may be called.

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

Accepted forms are `WECHAT_SSH_TUNNEL=[user@]host[:port]` or `WECHAT_PROXY_URL=socks5://[user:pass@]host:port` (also `http://` or `https://`). Set exactly one, using a host whose public IP is stable.

Provision credentials at `https://developers.weixin.qq.com/platform/`, configure one stable egress, then run `publish wechat check`. If it returns `40164`, add the exact egress IP reported by WeChat to IP白名单 with an admin QR scan, then rerun the check. Do not guess the proxy endpoint's outbound IP.

Authentication can fail because credentials are missing or rejected, token exchange fails, error `40164` reports an egress IP absent from IP白名单, the SSH tunnel/proxy or network fails, or the API response is inconclusive. There is no allowlist-edit API: a human must add the reported IP in the developer console and approve it by QR scan.

## Platform specification and gotchas

- Supply exactly one of `--from` or `--text`. For file/stdin input, an optional leading empty or YAML mapping frontmatter block is metadata only and is removed before rendering. Recognized string keys are `title`; `author`; `description`/`summary`/`digest`; `coverImage`/`cover`/`image`; and `sourceUrl`/`contentSourceUrl`/`source_url`; flags override metadata and other keys are ignored. BOM and LF, CRLF, or lone-CR delimiters are recognized. Mapping-intent malformed or unterminated frontmatter exits 2 before `--out`, token exchange, uploads, or API access. Valid scalar/sequence blocks and thematic-break prose remain literal Markdown apart from a leading transport BOM. Inline `--text` is always literal and is never interpreted as frontmatter.
- Title resolves from `--title`, file/stdin frontmatter, or the leading H1. A cover resolves from `--cover` or file/stdin frontmatter and is required. Relative frontmatter/body-image paths resolve beside a Markdown file (or from the invocation directory for stdin); a `--cover` flag resolves from the invocation directory.
- Author resolves from an explicit `--author`, then a nonblank string `author` in validated file/stdin frontmatter, then `WECHAT_AUTHOR`, then empty. Values are trimmed. An explicitly supplied blank or whitespace-only `--author` intentionally clears the lower-precedence values; blank, whitespace-only, and non-string frontmatter authors are ignored and fall through.
- Documented limits are title 32 字, author 16 字, and digest 120 字, but exact Unicode measurement is unknown and server-authoritative. Conflicting HTML-size documentation also makes the effective body limit unknown.
- The renderer uses inline `style=` because WeChat strips stylesheets and classes. Caller raw HTML is unsupported: block or inline HTML (including nested list, quote, table, tag attributes, and comments) exits 2 instead of being passed through. Write HTML-looking text with escaped angle brackets/entities or inside a code span/block. This recursive token check runs before cover/body-image reads, rendered inspection, `--out`, token/client imports, uploads, or API access.
- Rendered Markdown links allow explicit `http://`, `https://`, `mailto:`, relative URLs, and fragments. Links to `mp.weixin.qq.com` stay inline; other HTTP(S) links become bottom citations unless `--keep-links` is requested. Markdown images allow explicit HTTP(S) URLs or local filesystem paths; `sourceUrl`/`--source-url` requires an absolute explicit HTTP(S) URL. Mixed-case safe schemes, IPv6/ports, ordinary internal spaces in angle-bracket relative paths, and drive-absolute Windows image paths work. UNC/network image paths, HTTP(S) userinfo, leading/trailing Unicode whitespace, active/unknown schemes (`javascript:`, `data:`, `vbscript:`, `file:`), control/entity/percent-obfuscated schemes, malformed absolute/backslash forms, and scheme-relative destinations are rejected locally before assets or platform access.
- Every generated dynamic HTML attribute is escaped. Local body images retain a separate exact parser/path identity so escapable filenames and duplicates keep caller order through upload and CDN-URL rewriting; no caller path is emitted as raw markup.
- Documented cover formats are BMP, PNG, JPEG/JPG, and GIF with a `10M` label. WeChat presents 2.35:1 and 1:1 crops; these are preview crops, not proven required input ratios. Inspect both.
- Local body images use JPG or PNG with documented wording `1MB以下`. Exact byte, dimension, count, recompression, and quota boundaries remain server-authoritative.
- Before any API/token access, every cover and local body-image path must be a readable regular file with recognized magic/header bytes, positive dimensions readable from its header, and a filename extension matching the detected type. Header-invalid, dimension-unreadable, and extension-mismatch inputs are rejected locally; covers then allow BMP/GIF/JPEG/PNG, while body images allow only JPEG/PNG. Renaming a file does not convert it.
- A successful API receipt is not visual proof. Verify title, inline styling after sanitization, body images, links/citations, and both cover presentations in 草稿箱.
- Human terminal output is a presentation-only projection of the same closed, recursively frozen article/image snapshot used for uploads and `draft/add`. Caller lines are visibly framed; terminal/layout controls and literal backslashes have unambiguous visible spellings. Each field and the whole command transcript are bounded; truncation reports exact original UTF-16 size plus SHA-256 over the complete unnormalised UTF-8 scalar string. Unpaired surrogates or an invalid projection exit 2 before `--out`, token/client creation, upload, or API staging. Canonical inline HTML, metadata, source URL, and image paths are not rewritten by terminal projection.
- `publish wechat draft ... --json` emits exactly one `publish.transport-receipt/v1` document; the human summary uses the same frozen facts. It records ordered cover/body-image requested, resolved, uploaded, observed, and verified stages. If a later step fails, returned permanent-material/CDN references remain explicit remote residue; a failed or ambiguous `draft/add` never erases earlier uploads or claims publication. Server failures carry only bounded, redacted stage/code/status/message evidence and never trigger automatic rewriting or retry.

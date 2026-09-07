---
schemaVersion: publish.channel-info-source/v1
channel: wechat
displayName: WeChat Official Account
---
# WeChat Official Account

## CLI boundary

The CLI checks Official Account API access and creates one Markdown article draft. It renders inline-styled HTML, uploads the required cover and local body images, and calls `draft/add`. It never calls publication or mass-messaging APIs (`freepublish/*` or `message/mass/*`).

The agent prepares the article and assets, configures fixed egress, runs a dry-run, and creates the draft. Successful required uploads and a successful `draft/add` response with a nonempty native `media_id` verify draft creation. The operator provisions credentials, QR-authorizes IP allowlist changes, and makes any later publication decision. The CLI does not create or edit images.

## Authentication

Set `WECHAT_APP_ID` and `WECHAT_APP_SECRET` from `https://developers.weixin.qq.com/platform/`. Every API call must leave through one stable, allowlisted public IP. Configure exactly one of:

- `WECHAT_SSH_TUNNEL=[user@]host[:port]`
- `WECHAT_PROXY_URL=socks5://[user:pass@]host:port` (`http://` and `https://` also work)

Run `publish wechat check`. If error `40164` appears, add the exact egress IP reported by WeChat to IP白名单 in the developer console, approve it with an admin QR scan, and rerun the check. Do not guess the proxy endpoint's outbound IP. There is no allowlist-edit API.

Other failures include missing/rejected credentials, token exchange failure, tunnel/proxy or network failure, and an inconclusive API response. Follow the receipt's recovery guidance. A short-lived token is cached locally and may renew automatically; renewal is reported in the receipt.

## Platform specification and gotchas

### Prepare the article

- Supply exactly one of `--text` or `--from`; `--from -` reads stdin. File/stdin input removes optional leading empty or YAML mapping frontmatter before rendering. Invalid or unterminated mapping metadata is rejected before files are written or API calls begin. Valid scalar/sequence blocks remain Markdown; inline `--text` is always literal.
- Metadata accepts `title`, `author`, `description`/`summary`/`digest`, `coverImage`/`cover`/`image`, and `sourceUrl`/`contentSourceUrl`/`source_url`; other keys are ignored. Flags override metadata. Title otherwise falls back to a leading H1. A cover from `--cover` or metadata is required.
- Relative metadata cover and body-image paths resolve beside the Markdown file, or from the invocation directory for stdin. An explicit `--cover` path resolves from the invocation directory.
- Author resolves from `--author`, then a nonblank string in frontmatter, then `WECHAT_AUTHOR`, then empty. Values are trimmed; a blank `--author` intentionally clears the fallback, while blank or non-string metadata authors are ignored.
- Documented limits are title 32 字, author 16 字, and digest 120 字. Exact Unicode measurement and the effective HTML body limit are uncertain; WeChat decides final acceptance.
- Covers support BMP/GIF/JPEG/PNG, with a documented `10M` size label. WeChat offers 2.35:1 and 1:1 cover crops; these are not proven required input ratios. Local body images support JPEG/PNG with documented size `1MB以下`. Effective size, dimension, count, and quota limits remain server-authoritative.
- Every local image must be a readable regular file with valid image contents, readable positive dimensions, and a matching extension. Invalid files are rejected before API access; renaming a suffix does not convert an image.

### Review rendering and references

Run `--dry-run` to inspect the article before uploads; generated files are inspection artifacts, while the native saved draft is the deliverable. WeChat strips stylesheets and classes, so the renderer uses inline styles. Body paragraphs include an extra blank-line gap; references use compact formatting.

Raw HTML, including tags and comments nested in Markdown, is rejected locally. Use escaped angle brackets/entities or code spans/blocks for HTML-looking text. Links accept explicit HTTP(S), `mailto:`, relative URLs, and fragments; images accept explicit HTTP(S) URLs or local paths. `sourceUrl`/`--source-url` requires an absolute HTTP(S) URL. Unsafe or malformed destinations, scheme-relative URLs, and network image paths are rejected before asset reads or API access.

By default, external HTTP(S) body links become numbered bottom citations; repeated destinations share a citation. Safe `mp.weixin.qq.com` links and non-HTTP(S) links remain inline. `--keep-links` keeps safe inline hyperlinks, but cannot make WeChat support otherwise unsupported clickable links.

To supply an authored bibliography, use a top-level heading named `Reference`, `References`, `Bibliography`, `参考文献`, or `参考资料`, followed by numbered/bulleted entries or paragraphs beginning `【N】` or `[N]`. English heading names are case-insensitive; any heading depth is accepted. A heading inside a quote or list does not qualify. The section ends at the next heading or other block. Use only one populated recognized section; multiple sections return `wechat_bibliography_ambiguous` and must be combined in the staging copy.

The renderer preserves authored entry text, numbering, gaps, and grouping. It removes hidden link destinations while keeping readable labels and explicitly visible URLs; those links create no extra citations. `--keep-links` also keeps safe hyperlinks within references. References move to the end, followed by any generated body-link citations. Put creation/completion dates in separate unnumbered paragraphs so they keep ordinary body formatting before references. Canonical Markdown stays unchanged.

### Verify and recover

A successful API draft receipt with a nonempty `media_id`, after validation and required uploads, completes draft creation. Console login, opening a gated draft URL, and visual inspection are optional; an inaccessible preview does not invalidate the draft. API success does not prove visual rendering or publication.

Use `--json` for the structured receipt, including image upload progress and any remote assets left by a later failure. A failed or ambiguous `draft/add` does not undo earlier uploads. Follow the reported failure stage; do not rewrite or retry automatically. Terminal summaries may escape or shorten displayed input without changing the article.

### Originality and creation-source handoff

The API does not set or verify 原创声明 or 创作来源. Neither `author` nor `content_source_url` sets them; the [official draft/add schema](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add.html) has no such fields.

For an operator-authored opinion draft, the operator or an agent with authorized browser access should open the existing matching draft under 内容管理 → 草稿箱, check its title/body, enable 原创声明, select 创作来源 → 个人观点，仅供参考, and save. Verify both settings persisted. Do not declare a reprint original. This is a console handoff, not a live-verified CLI browser capability or authorization to publish.

If a control is unavailable, requires a human login/QR step, or does not persist, identify the pending setting and hand off with this explicit reminder: **发表前，请在现有草稿中开启原创声明，并将创作来源设为「个人观点，仅供参考」；保存后确认两项设置均已生效，再发表。** The API draft remains verified while those settings are pending; reuse it instead of creating another draft.

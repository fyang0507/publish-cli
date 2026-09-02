# Platform capabilities & authoring base-rules

Research-led source of truth for **what Markdown actually renders** on each target
surface, and the **base rules** for authoring canonical Markdown so it maps
faithfully. Feeds (a) the article/post **authoring** guidance and (b) the
per-platform **renderers** (e.g. issue #5's X Articles renderer).

Method: X Articles = **empirical** (drove the live editor, 2026-06). Reddit =
research against current docs (snoomark/GFM). X tweet/thread = plaintext (known).
WeChat article = **empirical** — inline-CSS survival verified live in the WeChat
草稿箱 (draft box) preview, 2026-07-04.

For operational limits and readiness, use `publish <channel> info [--json]`.
Its versioned envelope separates the three Markdown guidance sections from
passive `readiness`. Unknown or server-authoritative limits remain explicit in
the prose rather than being inferred.

## Xiaohongshu discovery boundary

`publish xhs info` describes the initial `long_article` / `写长文` format and
returns `agent_check_required` with the creator entry URL. Authentication and
drafting belong to the agent-owned headful browser context: let the operator
complete QR login when required, positively verify the creator UI, and continue
in that same context. The long-article terminal state is a browser-local draft,
not a cloud draft; it disappears if browser data is cleared and must be reopened
before a workflow claims persistence. The CLI does not implement selectors,
import, composer, or draft execution. `publish xhs info` itself is the execution
oracle: its free-text boundary, authentication, and platform-guidance sections
tell a capable headful browser agent how to import, optionally run one-click
layout/topics, save, and reopen the draft. Never click a final, private, or
scheduled publish action.

## 1point3acres discovery boundary

`publish 1point3acres info` is an offline capability/manual-handoff contract.
The CLI performs no crawl, login, composer fill, draft save, or submit action.
`publish 1point3acres info` itself contains the curated forum mappings, weighted
title evidence, destination-specific required metadata, and the complete textual
handoff procedure. A human uses that handoff in a normal authorized browser,
saves with `保存草稿`, and reopens `草稿箱`; the final submit action remains outside
the workflow.

## Capability matrix

| Feature | X tweet/thread | X Articles | Reddit self-post |
|---|---|---|---|
| Paragraphs | plain text | yes (blank-line) | yes (**blank line required**; single `\n` collapses) |
| Headings | ✗ (plain text) | **exactly 2 levels** — "Heading" + "Subheading" (Body dropdown) | H1–H6 (H1/H2 dominate) |
| Bold / italic | ✗ | ✓ `btn-bold` / `btn-italic` | ✓ `**b**` / `*i*` |
| Strikethrough | ✗ | ✓ `btn-strikethrough` | ✓ `~~s~~` |
| Blockquote | ✗ | ✓ `btn-blockquote` | ✓ `>` |
| Bulleted / ordered lists | ✗ | ✓ `btn-ul` / `btn-ol` (+ nesting) | ✓ `-` / `1.` (+ nesting) |
| Inline code | ✗ | ✗ (no inline-code style) | ✓ `` `x` `` |
| Code block | ✗ → screenshot | ✓ **native** (Insert → Code) | ✓ (**4-space indent** portable; ``` ``` new-reddit only; no highlighting) |
| Tables | ✗ | ✓ (Insert → Table) | new-reddit/app only (raw pipes on old reddit) |
| Horizontal rule / divider | ✗ | ✓ (Insert → Divider) | ✓ `---` |
| LaTeX / math | ✗ | ✓ (Insert → LaTeX) | ✗ (no native math) |
| Embedded posts / GIF | native quote / GIF | ✓ (Insert → Posts / GIF) | link only |
| Links | bare/auto-shortened URL | ✓ `btn-link` (anchor text) | ✓ `[text](url)` |
| Inline images in body | media attach | ✓ Insert → Media (+ **5:2 hero** to publish) | **✗ in Markdown body** (needs a separate image/gallery post) |
| Emoji | native | ✓ `btn-emoji` | unicode only |
| Superscript / spoilers | ✗ | ✗ | ✓ (reddit-only; old-reddit CSS-dependent) |
| Max length | weighted 280; Premium platform max 25k, draft-tested only at 281/500 | unknown | nominal 40,000 code points |

### WeChat article (微信公众号) — API-driven, HTML body

WeChat is the first **API-driven** channel (X/LinkedIn/Reddit are browser-driven)
and its article body is neither Markdown nor plaintext but **HTML with inline
styles ONLY** — the draft editor's sanitizer strips `<style>`/`<link>` tags and
`class` attributes, so only per-element `style="…"` survives. Facts (empirical,
2026-07-04):

| Feature | WeChat article |
|---|---|
| Body format | **HTML, inline styles only** (`<style>`/`<link>`/`class` stripped) |
| Paragraphs | yes |
| Headings | ✓ render (emitted as inline-styled HTML) |
| Bold / italic | ✓ (inline-styled) |
| Blockquote | ✓ (inline-styled) |
| Bulleted / ordered lists | ✓ (inline-styled) |
| Code block | ✓ (inline-styled `<pre>`; no syntax highlighting) |
| Inline images in body | ✓ **but must be WeChat-hosted** — local images auto-uploaded to the WeChat CDN; **remote images are dropped** |
| Links | **mostly deactivated** in article bodies (`mp.weixin.qq.com` links kept inline) → send others to **bottom citations** |
| Cover image | **required** (`thumb_media_id`, uploaded as permanent material) |
| Field limits | documented title/author/digest 32/16/120 字; exact measurement unknown/server-authoritative; omitted digest uses first 54 字 |
| LaTeX / math | **unknown — verify live** (no assumption made) |
| Max length | large limit |

**Takeaway:** X **Articles** and Reddit are both *rich* surfaces with a large
overlap (headings, bold/italic/strike, lists, blockquote, code, tables, links,
dividers). The truly restrictive surface is the **tweet/thread** (plain text).
X Articles even adds LaTeX + embedded posts that Reddit lacks; Reddit adds
super/spoilers + H3–H6 that X lacks.

## Base authoring rules (canonical Markdown)

Author to this vocabulary; renderers apply it faithfully on rich surfaces and
downgrade for tweets. This is the rule the authoring skill enforces.

1. **Headings: `#` and `##` only — never H3+.** Hard fact: X Articles offers
   exactly two levels (Heading=`#`, Subheading=`##`). Reddit renders deeper but
   H1/H2 dominate. So ≤H2 is the universal ceiling.
2. **Paragraphs: separate with a blank line** (double newline). Never rely on a
   single newline (Reddit collapses it). Intra-paragraph break = two trailing spaces.
3. **Inline: `**bold**`, `*italic*`, `~~strike~~`** — all render on X Articles + Reddit.
   (Inline `` `code` `` renders on Reddit only; on X it's plain text — avoid relying on it.)
4. **Lists (`-`, `1.`)** — supported on both X Articles and Reddit; keep nesting shallow.
5. **Blockquotes (`>`)**, **horizontal rules (`---`)** — both.
6. **Code: fenced ```` ``` ````** — X Articles renders it natively (Insert→Code);
   Reddit render path emits **4-space-indented** blocks (old-reddit-safe). No
   syntax highlighting on either. Tweets → screenshot.
7. **Tables (GFM pipe)** — X Articles + new-reddit render them; **old-reddit shows
   raw pipes**. Usable; if old-reddit fidelity matters, provide a list fallback.
   Tweets → list/image.
8. **Links `[text](url)`** — anchor text on X Articles + Reddit; **bare URL on tweets**.
9. **Images: one 5:2 hero** for X Articles (required to publish) + inline media on X.
   **Reddit self-posts can't inline images** → plan a separate image post there.
10. **X-only extras (LaTeX, embedded Posts, GIF)** and **Reddit-only extras
    (super/subscript, spoilers, H3+)** are opt-in per-platform, never in the
    common canonical source.
11. Respect length caps (tweet 280/25k, Reddit body 40k).

## Per-platform render/downgrade profiles

**X tweet/thread** — plain text. Strip markup to text; links → bare URLs;
code/tables/images → screenshots or attached media; headings/quotes → plain lines.

**X Articles** (issue #5 target — CORRECTED from empirical probe):
- Editor: title `data-testid="twitter-article-title"`; body `data-testid="composer"`.
- Toolbar: **`btn-bold`, `btn-italic`, `btn-strikethrough`**, the **"Body" block-style
  dropdown** (options: **Heading / Subheading / Body** — H1/H2/paragraph),
  **`btn-blockquote`, `btn-ul`, `btn-ol`, `btn-link`, `btn-emoji`**, and the
  **Insert** menu ("Add Media") → **Media, GIF, Posts, Divider, Code, LaTeX, Table**.
- Apply headings via the Body dropdown (NOT markdown shortcuts — `##` does not
  autoformat); apply bold/italic/strike/quote/list/link via their `btn-*`;
  code/table/divider/image via the Insert menu.
- Genuinely nothing to downgrade except inline-`code` (→ plain or a code block)
  and H3+ (→ Subheading). Code does NOT need a screenshot here.
- 5:2 hero image required to publish.

**Reddit self-post** (future channel):
- Post via **Markdown mode** or the API — the Rich Text editor mangles pasted markdown.
- Code → 4-space-indented blocks (portable). Tables only if old-reddit raw-pipe
  fallback acceptable. Images → separate image post. Blank-line paragraphs.

**WeChat article** (API-driven — deterministic, no LLM):
- Render Markdown → **inline-styled HTML** via a `marked` renderer override that
  attaches a `style="…"` to **every** element — no `<style>` block or `class`
  survives WeChat's sanitizer. One default typographic look this phase.
- **External links → bottom numbered citations** by default; `mp.weixin.qq.com`
  links are kept inline (those stay active).
- Local `<img>` tags → **uploaded to the WeChat CDN**, `src` rewritten to the
  returned CDN URL (remote images are dropped by WeChat, so plan for local).
- **Cover image** → uploaded as **permanent material**; its `thumb_media_id` is
  required to stage the draft.

## Caveat
Reddit old-vs-new gaps and the 40k cap are corroborated across secondary refs, not
Reddit's official guide — verify with a live round-trip on old + new Reddit before
locking the Reddit path. X Articles capability above is from a live editor probe.

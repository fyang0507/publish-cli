# Platform capabilities & authoring base-rules

Research-led source of truth for **what Markdown actually renders** on each target
surface, and the **base rules** for authoring canonical Markdown so it maps
faithfully. Feeds (a) the article/post **authoring** guidance and (b) the
per-platform **renderers** (e.g. issue #5's X Articles renderer).

Method: X Articles = **empirical** (drove the live editor, 2026-06). Reddit =
research against current docs (snoomark/GFM). X tweet/thread = plaintext (known).

## Capability matrix

| Feature | X tweet/thread | X Articles | Reddit self-post |
|---|---|---|---|
| Paragraphs | plain text | yes (blank-line) | yes (**blank line required**; single `\n` collapses) |
| Headings | ✗ (plain text) | **~1 level** (`# `→heading; `##`+ did NOT render as H2) | H1–H6 (H1/H2 dominate) |
| Bold / italic | ✗ | ✓ `btn-bold` / `btn-italic` | ✓ `**b**` / `*i*` |
| Strikethrough | ✗ | ✗ | ✓ `~~s~~` |
| Blockquote | ✗ | ✓ `btn-blockquote` | ✓ `>` |
| Bulleted / ordered lists | ✗ | **✗ (no button, no autoformat)** | ✓ `-` / `1.` (nesting ok) |
| Inline code | ✗ | ✗ | ✓ `` `x` `` |
| Code block | ✗ → screenshot | ✗ → screenshot | ✓ (**4-space indent** = portable; ``` ``` fences new-reddit only; no highlighting) |
| Tables | ✗ | ✗ | new-reddit/app only (raw pipes on old reddit) |
| Horizontal rule | ✗ | (unconfirmed; treat ✗) | ✓ `---` |
| Links | bare/auto-shortened URL | ✓ `btn-link` (anchor text) | ✓ `[text](url)` |
| Inline images in body | media attach | ✓ **Add Media** (+ 5:2 hero to publish) | **✗ in Markdown body** (needs a separate image/gallery post) |
| Superscript / spoilers | ✗ | ✗ | ✓ (reddit-only; old-reddit CSS-dependent) |
| Max length | 280 (25k premium) | large | 40,000 chars |

## Base authoring rules (canonical Markdown)

Author to this capped vocabulary; each renderer downgrades as noted. This is the
rule the authoring skill enforces.

1. **Headings: `#` and `##` only — never H3+.** H3+ is invisible on X and weak on
   Reddit. (X Articles realistically renders only one heading level; `##`
   downgrades to a bold lead-in there.)
2. **Paragraphs: separate with a blank line** (double newline). Never rely on a
   single newline (Reddit collapses it). Intra-paragraph break = two trailing spaces.
3. **Inline emphasis: `**bold**` and `*italic*` only.** No strikethrough/super/spoiler
   in canonical source (Reddit-only; drop elsewhere).
4. **Lists (`-`, `1.`) are allowed** — Reddit renders them; **X flattens them to
   line-broken paragraphs** (no list support). Keep nesting shallow + consistent.
5. **Links: `[text](url)`.** Expect **bare-URL** rendering on X tweets; keep links out
   of a tweet's opening line.
6. **Code: fenced ```` ``` ````.** Reddit render path emits **4-space-indented**
   blocks (old-reddit-safe, no highlighting); **X downgrades code → screenshot/gist**
   (X can't render code at all).
7. **Avoid tables** (X can't render them; old-reddit shows raw pipes). If needed,
   author as a list and let the Reddit path optionally upgrade.
8. **Images: one 5:2 hero** for X Articles (required to publish) + inline media on X.
   **Reddit self-posts can't inline images** — plan a separate image post there.
9. Respect length caps (tweet 280/25k, Reddit body 40k).

## Per-platform render/downgrade profiles

**X tweet/thread** — plain text. Strip all markup to text; links become bare URLs;
code/tables/images → screenshots or attached media; headings/quotes → plain lines.

**X Articles** (issue #5 target — CORRECTED from empirical probe):
- Editor: title `data-testid="twitter-article-title"`; body `data-testid="composer"`.
- Real inline toolbar: **`btn-bold`, `btn-italic`, `btn-blockquote`, `btn-link`**, and
  **"Add Media"** (aria-label; inline images). NO heading/list/code/table controls.
- Apply: bold/italic (select-range → `btn-*` or Cmd/Ctrl+B/I), blockquote, links, images.
- **Downgrade**: `##`→ bold lead-in; lists → line-broken paragraphs (optionally with
  "• " prefixes as literal text); code → screenshot; tables → list/image; H3+ → bold.
- Verify exact heading levels live during #5 (single vs two).

**Reddit self-post** (future channel):
- Post via **Markdown mode** or the API — the Rich Text editor mangles pasted markdown.
- Code → 4-space-indented blocks (portable). Tables allowed only if old-reddit raw-pipe
  fallback is acceptable. Images → separate image post. Blank-line paragraphs.

## Caveat
Reddit's official guide doesn't enumerate old-vs-new gaps or the 40k cap; those are
corroborated across secondary refs and long-standing behavior. Before locking the
Reddit path, do a live round-trip test post on both old.reddit.com and new Reddit.
X Articles heading-level count should be pinned during #5 calibration.

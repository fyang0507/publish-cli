# `publish <channel> info` capability spike

> Status: research complete for implementation planning, 2026-08-30. No `info`
> command is implemented yet. Unknown values stay unknown until their linked spike
> is completed.

## Purpose and boundary

`publish <channel> info` is the transport-owned operational contract. It returns
every format the channel currently supports, all at once, in human-readable or
JSON form. It describes accepted inputs, locally enforceable constraints,
platform-only checks, terminal state, and evidence freshness.

The CLI remains a transport and validation layer. It does not select a channel,
make editorial decisions, generate assets, crop, resize, compress, convert, or
otherwise transform supplied content.

## Evidence rules

Capability data must distinguish:

- **transport support** — what this CLI actually accepts and can stage;
- **platform capability** — what the platform supports but this CLI does not;
- **local validation** — what can fail before a browser or API is touched;
- **live validation** — what requires authentication or a destination-specific
  composer/API call;
- **unknowns** — values that remain `null` rather than being guessed;
- **evidence per fact** — unstable claims carry their own source and verification
  date instead of inheriting one blanket channel date.

Editorial advice such as hook quality, hashtags, audience fit, or whether links
reduce reach belongs in the `publish` skill or the workflow layer, not the static
capability registry.

## Server feedback and agent self-correction

Local validation cannot anticipate every platform response. Every draft,
compose, prepare, or publish transport must preserve a new server/platform error
in both the human response and structured receipt so an agent can correct its
input instead of receiving an opaque runtime failure.

The error receipt should include, when available:

- `source`, operation `stage`, platform/API code, and HTTP status;
- a sanitized platform message and whether the error is already classified;
- `retryable` and `inputRelated` as explicit booleans or `null` when unknown;
- a bounded `suggestedCorrection` derived from evidence, without silently
  changing the caller's content or assets;
- whether the platform was touched, the observed draft/composer state, and
  `published: false` whenever that is known;
- enough redacted evidence to diagnose a novel constraint and propose a future
  capability-registry or validator update.

Credentials, tokens, cookies, private headers, and unrelated response content
must never be echoed. Unknown errors remain visible as unknown rather than being
misclassified, and the CLI must not enter an automatic correction/retry loop.

## Current format inventory

| Channel | Transport-supported formats | Terminal state |
|---|---|---|
| X | `tweet`, `thread`, `article` | native draft; Article cover flow incomplete |
| LinkedIn | `post` | native personal-post draft |
| Reddit | `self_post` | native self-post draft |
| WeChat | `article` (`article_type=news`) | native Official Account draft |
| Xiaohongshu | proposed `long_article` | native autosaving web draft via 写长文 |
| 1point3acres | proposed `text_thread` | local manual handoff; operator-assisted visible inspection for spikes |

## X

### Tweet

- Inputs: inline text, Markdown file, or stdin.
- Rendering: plain text.
- Platform limit: weighted 280, not raw Unicode code points.
- Official counting uses NFC normalization; CJK and emoji weight 2; URLs use a
  fixed 23-character weight.
- Current implementation incorrectly uses raw code points and can undercount.
- X supports post media, but this CLI does not accept tweet media today. `info`
  must not advertise it as transport-supported.
- Result: native Unsent draft, verified by matching the staged prefix.

### Thread

- Inputs: inline text, Markdown file, or stdin.
- Rendering: numbered plain-text sequence.
- Each post must satisfy the same weighted 280 limit.
- The transport does not currently attach per-post media.
- Result: native multi-row draft; current verification matches the first post.

### Article

- Input: Markdown file only.
- Implemented rich paste: H1/H2, paragraphs, bold, italic, lists, blockquotes,
  and links.
- Code blocks, inline code styling, tables, dividers, LaTeX, embedded posts,
  strikethrough, and inline body media are not currently transported even when
  the platform supports them.
- Cover: one already-prepared 5:2 JPEG/PNG/WebP. Exact byte and dimension limits
  and crop/apply behavior remain unknown.
- Result: autosaved Article draft. Current verification proves an editor id was
  created, not that the body and cover persisted after reopen.

### Blocking X spike

[Issue #40](https://github.com/fyang0507/publish-cli/issues/40) must resolve:

- official weighted-count fixtures and boundary tests;
- whether >280 Premium posts can be saved as web drafts;
- whether `--long` is a draftable transport capability at all;
- exact Article cover acceptance and persistence;
- reopen verification for title, body, and cover.

Official references:

- <https://docs.x.com/fundamentals/counting-characters>
- <https://help.x.com/en/using-x/how-to-post>
- <https://help.x.com/en/using-x/types-of-posts>
- <https://help.x.com/en/using-x/articles>

## LinkedIn

### Personal feed post

- Inputs: inline text, Markdown file, or stdin.
- Rendering: deterministic plain text; optional Unicode mathematical bold.
- Platform limit: 3,000 characters. Exact Unicode counting behavior is not yet
  established.
- Assets supported by the transport: repeatable image paths.
- Current implementation validates file existence only and reports requested
  attachment count rather than observed previews.
- Current official help describes desktop GIF/JPEG/PNG, up to 20 images, 5 MB
  per image, minimum 552×276, recommended 1080 px width, and ratios from 3:1
  through 4:5. Out-of-range images may be centered and cropped.
- Result: native draft via Dismiss → Save as draft; text persistence is checked
  by reopening and matching the prefix. Media persistence is not verified.

### Blocking LinkedIn spike

[Issue #41](https://github.com/fyang0507/publish-cli/issues/41) must resolve:

- 3,000/3,001 boundaries across ASCII, Chinese, emoji, and normalization forms;
- type, count, byte, dimension, and ratio boundaries;
- URL/link-preview interaction with uploaded images;
- observed preview count, ordering, layout, and persistence after reopen.

Official references:

- <https://www.linkedin.com/help/linkedin/answer/a525307/share-photos-or-videos?lang=en>
- <https://www.linkedin.com/help/linkedin/answer/a564109?lang=en>
- <https://www.linkedin.com/help/linkedin/answer/a767101/save-a-post-as-a-draft?lang=en>
- <https://www.linkedin.com/help/linkedin/answer/a524422?lang=en>

## Reddit

### Self-post

- Inputs: inline text, Markdown file, or stdin.
- Required: subreddit and title. Both may come from frontmatter.
- Title: 300 code points; overflow is rejected.
- Body: Markdown, nominally 40,000 code points.
- Optional: flair, NSFW, and spoiler.
- Assets: none for this self-post format. Inline body images are unsupported.
- Result: native draft via Save Draft, verified through the Draft saved toast.
- First authenticated login is CAPTCHA-heavy and may require headful inspection.

Static `info` must not absorb live subreddit contracts. The existing Reddit
discovery path remains responsible for submission type, required flair/templates,
title regexes, required/blacklisted strings, and per-subreddit body restrictions.
Karma, account-age, restricted-community, ban, and approved-submitter gates may
only surface in the composer. Complete AutoMod behavior is unknowable.

Current docs incorrectly say browser-free `--dry-run` performs the live subreddit
preflight; implementation performs local generation/validation only. Current
body overflow also keeps a leading segment, which violates the transport-only
boundary and should become rejection.

[Issue #43](https://github.com/fyang0507/publish-cli/issues/43) tracks the
reconciliation.

## WeChat Official Account

### Article (`article_type=news`)

- Inputs: inline text, Markdown file, or stdin.
- Required: title and cover.
- Optional: author, digest, source URL, and link-retention option.
- Current title limit: 64 code points.
- Current explicit digest limit: 120 code points; derived digest is shortened
  with a warning.
- Rendering: Markdown to inline-styled HTML.
- Local body images are uploaded and rewritten to WeChat CDN URLs.
- Remote body images remain warned and may be dropped by the platform.
- External links become bottom citations by default.
- Cover is permanent material and consumes account quota.
- Result: native 草稿箱 draft through `draft/add`.
- `freepublish/*` and `message/mass/*` remain structurally forbidden.

Authentication uses app credentials, a cached stable token, and an allowlisted
source IP. Fixed proxy/SSH egress is the supported traveling-operator setup.

The current image contract is incomplete: code recognizes GIF while errors/docs
promise PNG/JPEG; the 1 MiB body-image cap is enforced only during upload; cover
byte/dimension/aspect constraints are unknown; and dry-run does not fully check
file existence/type/size.

[Issue #42](https://github.com/fyang0507/publish-cli/issues/42) tracks the field
and image-contract spike.

## Xiaohongshu / RedNote

### Long article draft (`写长文`)

- This is the sole initial transport-supported Xiaohongshu format because it
  matches the primary Chinese long-form essay workflow.
- Proposed action: `draft`.
- Title: separate field with a visible 64-character maximum and DOM
  `maxlength=64`; exact Unicode counting behavior remains untested.
- Body: TipTap/ProseMirror rich-text editor with a 10,000-character maximum.
- Preferred input is the native file-import path. The modal accepts `.md`,
  `.docx`, and `.txt`, and warns that import overwrites current body content.
- Measured Markdown fidelity: H1 and H2, ordered/unordered lists, and
  blockquotes survive; H3 becomes a paragraph; bold and italic styling are
  stripped. The first H1 remains in the body and does not fill the title.
- The editor explicitly says content auto-saves and provides `暂存离开`.
- The landing page exposes `草稿箱`, `新的创作`, `导入链接`, and long-article
  collections.
- Formatting controls observed: H1/H2, ordered/unordered lists, quote,
  highlight, inline image, emoji, and file import, plus undo/redo.
- `一键排版` is an optional platform transform, not a silent transport step.
  A live fixture became three image cards with an auto-generated summary,
  default template, and generated cover. Cover settings include image/no-image,
  optional author (20 characters), and summary (60 characters). Word count/read
  duration is available only at 1,500 characters or more.
- Advancing from layout triggers platform image generation and enters the
  ordinary image-text composer. The live fixture produced three images, an
  auto-truncated title, and an empty caption with a 1,000-character maximum.
- Topics are structured platform entities in that final composer, not plain
  hashtags. The verified flow is: invoke `话题`, type a query, select an exact
  live candidate, and verify the resulting clickable topic entity. Candidates
  expose view counts, recommendations change dynamically, and four selected
  topics survived reload and draft-box reopen. Static `info` should advertise
  repeatable `topics` and live resolution while leaving the maximum count
  unknown; it must not cache a topic catalog or make editorial selections.
- `暂存离开` produced `保存成功`; reopening preserved the title and three-card
  layout. The platform states that long-article drafts are browser-local,
  disappear when browser data is cleared, and are limited to 100.
- Authentication: one-time QR login into a persistent local browser profile.
- Final publication, private publication, and scheduled publication remain
  forbidden.

### Deferred image-text format

The authenticated image-text uploader states a 32 MB maximum per image, accepts
multiple JPEG/PNG/WebP files, and rejects GIF and Live Photo formats. Aspect
ratio is unrestricted; 3:4 through 2:1 and at least 720×960 are recommended.
Image count, title/body limits, and staging semantics remain unverified because
this format is no longer implementation priority.

The documented read-only persistence check on 2026-08-30 found the July 6 session
logged out after 55.2 days. A fresh QR-authenticated session remained alive 30
minutes after login. These observations do not establish session TTL.

[Issue #35](https://github.com/fyang0507/publish-cli/issues/35) tracks the
long-article live spike and implementation. Full current evidence is in
[`XHS_DESIGN.md`](./XHS_DESIGN.md); image-text is future-only.

## 1point3acres

### Safe initial capability

The current [Terms of Service](https://www.1point3acres.com/terms_of_service.html)
prohibit non-authorized automated access such as crawlers and browser plugins.
A visible/headful browser does not by itself remove that restriction. The safe
initial product capability remains:

- static offline `info`;
- locally prepared textual handoff;
- human-operated posting;
- no runtime forum inspection or crawling;
- no automated login, composer filling, CAPTCHA handling, or submission.

For the bounded spike, the operator may log in personally and direct a visible
browser inspection of the composer controls. This is an operator-assisted
research session, not authorization for background crawling or a general
Playwright transport. Do not read credentials, cookies, or browser storage; do
not submit a post.

The terms also state that a published post is editable for only 30 minutes and
cannot be deleted directly by its author, strengthening the never-publish rule.

### Curated offline sub-forums

| slug | parent / destination | forum id | thread category | stable URL | intended use |
|---|---|---:|---|---|---|
| `workplace-reflection` (default) | 职场达人 | 98 | 职场感言; selector id unknown | <https://www.1point3acres.com/bbs/forum-98-1.html> | default for workplace and career reflections |
| `chinese-life` | 海外生活 / 华人生活 | 29 | none known | <https://www.1point3acres.com/bbs/forum-29-1.html> | overseas Chinese life and community experience |
| `job-search` | 海外求职 / 求职（非面经） | 28 | none known | <https://www.1point3acres.com/bbs/forum-28-1.html> | job-search writing that is not interview-experience content |

The logged-in composer confirmed that 职场感言 is a selectable thread category
and the intended default. No stable numeric selector value was exposed, so the
manual handoff identifies it by label rather than inventing an id.

The 2026-08-30 visible composer spike also established:

- all three destinations expose Markdown-capable rich text, preview, a native
  `保存草稿` action, a draft box, and a separate forbidden publish control;
- the title counter is weighted with a 40-unit maximum: 40 ASCII letters count
  as 20, 40 CJK characters as 40, and 40 `😀` emoji as 80; the exact general
  algorithm remains unknown;
- 华人生活 exposes no category selector;
- 求职（非面经） requires theme, job-search year, role category, major, and
  experience range; region is optional;
- no visible body counter or body maximum was observed.

Full evidence and category/metadata choices are recorded in
[`1POINT3ACRES_DESIGN.md`](./1POINT3ACRES_DESIGN.md). An operator-approved write
probe verified that title, body, selected category, save timestamp, and draft
count persist after loading a native draft from `草稿箱`. The product remains
offline info plus manual handoff under the current authorization boundary.

If none fits, the workflow agent researches manually and supplies a custom forum
id/target. The CLI does not inspect the website at runtime.

[Issue #36](https://github.com/fyang0507/publish-cli/issues/36) records the spike;
[issue #37](https://github.com/fyang0507/publish-cli/issues/37) is narrowed to
offline info and manual handoff unless authorization is obtained.

## Implementation dependencies

- Capability registry and all-format `info`: issue #32.
- Shared local validation: issue #33.
- JSON operation receipts: issue #34.
- Explicit X Article cover transport: issue #5 after issue #40.
- No asset preprocessing: issue #39 remains future-only.

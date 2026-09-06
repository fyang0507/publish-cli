# Design spike: Xiaohongshu long-form article draft

> **Status:** authenticated import, layout, final-composer, native-draft, and
> reopen verification completed 2026-08-30. Nothing was published. The labeled
> throwaway draft remains in the operator's browser-local draft box pending
> explicit deletion approval.

## Decision

The first Xiaohongshu transport format is `long_article`, reached through
`写长文`. It serves the primary Chinese long-form essay workflow. Image-text,
video, and podcast formats are deferred until real workflow demand justifies
their separate contracts.

This corrects the earlier image-text-first assumption in `XHS_HANDOFF.md`.
Xiaohongshu exposes a native web draft model for long articles: the editor
auto-saves and provides `暂存离开`, while the landing page exposes `草稿箱`.
The appropriate initial action is therefore `draft`, not `compose`.

## Proposed surface

```sh
publish xhs info [--json]
publish xhs draft --title <title> --from <article.md> [--inspect]
```

The primary transport uploads a prepared Markdown file through the platform's
native `从文件导入` control, fills the separate title field, validates confirmed
limits, saves through `暂存离开`, reopens the browser-local draft, and returns
`published: false`. Deterministic rich-editor filling is a fallback when native
file import is unavailable. The CLI never invokes a final publication control.

## Authenticated long-article contract

The live `写长文` landing page exposed `新的创作`, `导入链接`, `草稿箱`,
long-article collections, and `新建长文合集`.

`新的创作` opened a TipTap/ProseMirror editor with:

- a separate title textarea with `maxlength=64` and a visible counter;
- a body limit displayed as 10,000 characters;
- explicit autosave copy plus `暂存离开` and `一键排版`;
- undo/redo, H1, H2, ordered and unordered lists, quote, highlight, image,
  emoji, and `从文件导入` toolbar actions.

The import modal accepts DOCX, Markdown, and TXT and warns that importing
overwrites current editor content. A live Markdown fixture imported
successfully with this measured fidelity:

| Markdown input | Imported result |
|---|---|
| `#` | body H1; does not populate the separate title |
| `##` | body H2 |
| `###` | normal paragraph |
| unordered and ordered lists | preserved |
| blockquote | preserved |
| bold and italic | text preserved, styling stripped |

The CLI must disclose these losses in `info` and must not claim general
Markdown fidelity. Title counting beyond the visible 64-character limit and
inline-image constraints remain unmeasured.

## One-click layout is an explicit platform transform

`一键排版` transformed the 225-character fixture into three image cards. It
also generated a summary, selected a default visual template, and selected an
automatically generated cover image that was not reliably related to the text.
The platform exposed many template families rather than one stable format.

Cover settings observed:

- `有图封面` and `无图封面`;
- optional author, maximum 20 characters;
- summary enabled by default, maximum 60 characters;
- optional word count/read duration, available only at 1,500 characters or
  more.

`下一步` initiated a platform image-generation request and then entered the
ordinary image-text composer with three generated images, an automatically
truncated title, and an empty caption with a 1,000-character maximum.

The final composer also owns Xiaohongshu topics. Topics are not equivalent to
plain hashtag text:

- clicking `话题` inserts a literal `#` at the caption cursor;
- typing after it performs live platform topic search;
- candidates include an exact name plus related topics and display current view
  counts;
- selecting a candidate converts the text into a distinct `[话题]` entity that
  is clickable in preview;
- recommended-topic chips insert the same semantic entity and then refresh
  dynamically;
- four selected topics survived page reload, draft-box reopen, and preview.

The transport should therefore accept topics as a repeatable structured input
separate from the caption, search the live selector, require an exact platform
match, and return candidates when resolution is ambiguous or absent. It must
not silently leave an unresolved `#name` as plain text. Topic discovery and
editorial selection belong to the agent/workflow layer; the CLI resolves and
verifies caller-selected topics. The maximum topic count remains unmeasured.

This flow is not a silent formatting step. It changes representation and
generates editorial/visual output. If exposed later, it must be opt-in and
return the generated card count, summary, template, cover state, and review
boundary. The CLI remains a transport layer and does not recreate, crop, or
restyle these assets itself.

## Native draft boundary and persistence

The verified safe sequence is:

1. Open `写长文` → `新的创作` in the persistent authenticated profile.
2. Upload the Markdown source and fill the separate title.
3. Observe autosave completion.
4. Optionally enter `一键排版` only when explicitly requested and reviewed.
5. Use `暂存离开`.
6. Reopen the entry through `草稿箱` and verify title/content or generated-card
   structure.
7. Return a receipt with browser-local draft evidence and `published: false`.

The live test showed `保存成功`, incremented `长文笔记` to one, and reopened the
same title and three-card layout. Xiaohongshu explicitly states that drafts are
stored in the current browser's local data, disappear if browser data is
cleared, and are limited to 100 long-article drafts. This is not a cloud-draft
guarantee and must be reflected in both `info` and the receipt.

No implementation may click a publish/final-submit control. Private and
scheduled publication are also publication, not draft mechanisms.

## Capability information

Initial `publish xhs info` should report `long_article` as the sole
transport-supported format and include:

- `action: draft` and terminal action `暂存离开`;
- title maximum 64 and body maximum 10,000;
- native import formats `md`, `docx`, and `txt`, with `md` preferred;
- the measured Markdown fidelity table and overwrite behavior;
- authentication through a persistent QR-authenticated browser profile;
- browser-local persistence, 100-draft limit, and browser-data deletion risk;
- `一键排版` as an optional platform transform, not a default transport step;
- layout/cover controls, generated-output review requirements, and the final
  image-text composer's 1,000-character caption limit;
- repeatable structured topics, live exact-match resolution, semantic-entity
  verification, and unknown maximum topic count;
- evidence date and remaining unknowns;
- deferred platform formats separately from transport support.

## Deferred formats

Image-text has a separately observed contract: multiple JPEG/PNG/WebP images,
32 MB per image, no GIF/Live Photo, no hard aspect-ratio restriction, recommended
3:4 through 2:1, and at least 720×960 recommended. It is not part of the initial
implementation.

Video and podcast formats are also deferred. The CLI remains a transport layer;
it does not render cards, crop images, or make editorial decisions.

## Remaining work

- define the structured receipt for browser-local draft evidence;
- establish title Unicode-counting behavior, inline-image constraints, and the
  maximum topic count;
- capture and preserve novel server/platform errors for agent self-correction
  under issue #34;
- implement the Markdown-import-first long-article transport;
- delete the live throwaway draft only after explicit operator approval.

# Design spike: 1point3acres textual handoff

> **Status:** live composer inspection completed 2026-08-30 for the three
> curated destinations. Native draft persistence is verified; body-size
> boundaries remain unverified. No post was submitted.

## Decision

The initial product is static `info` plus a local textual handoff. The CLI does
not log in, crawl, fill the composer, solve CAPTCHA, or submit. A human uses the
handoff in a normal logged-in browser.

The logged-in site exposes a native `保存草稿` action. A throwaway draft verified
that title, body, forum category, save timestamp, and draft count survive loading
the draft from `草稿箱`. Current site terms still make this a platform capability
rather than an automated transport capability unless authorization for
automation is obtained separately.

## Proposed surface

```sh
publish 1point3acres info [--json]
publish 1point3acres prepare \
  --forum <workplace-reflection|chinese-life|job-search|custom-target> \
  --title <title> \
  --from <article.md> \
  [destination-specific metadata]
```

`prepare` validates the confirmed static contract and emits a manual handoff
containing the target URL, forum/category choices, title/body, warnings,
unresolved live checks, and `published: false`. It does not transform content.

## Curated destinations

| slug | forum | id | theme/category | composer URL | use |
|---|---|---:|---|---|---|
| `workplace-reflection` | 职场达人 | 98 | required; default `职场感言` | `https://www.1point3acres.com/editor/thread?fid=98&from=home` | workplace and career reflections |
| `chinese-life` | 华人生活 (under 海外生活) | 29 | no selector observed | `https://www.1point3acres.com/editor/thread?fid=29&from=home` | overseas Chinese life and community experience |
| `job-search` | 求职（非面经） (under 海外求职) | 28 | required | `https://www.1point3acres.com/editor/thread?fid=28&from=home` | job-search writing that is not interview-experience content |

For a custom target, the caller supplies a forum id/URL and any manually
researched category/metadata. The CLI does not inspect it at runtime.

### 职场达人 themes

The visible composer offered:

`职场感言`, `请问贵司`, `管理`, `晋升`, `老板相处`, `辞职`, `扩张`, `绩效`,
`换组`, `跳槽`, `改行`, `自我提升`, `裁员`, `新组上路`, `同事协作`, `带新人`,
`实习体验`, and `求比较`.

`职场感言` is the product default. It is a visible label in a client-rendered
combobox; no stable numeric category id was exposed. A manual handoff should
therefore identify it by label rather than inventing an id.

### 求职（非面经） themes and required metadata

The visible theme choices were:

`其他`, `求职简历`, `找工就业`, `实习`, `选组选Offer`, `应届生NG`, `ICC合同工`,
`EE硬件`, and `TeamMatch`.

Selecting a theme revealed these structured fields:

| field | required | observed choices/contract |
|---|---|---|
| 找工年度 | yes | 2011–2029 in the inspected composer, displayed in a non-sorted order; this list is time-sensitive |
| 工作职位类别 | yes | management, general software, statistics, data science/analysis, quant finance, hardware/electronics, engineering, PM, design, mobile, frontend, ML engineering, data engineering, or other |
| 专业 | yes | enumerated academic-major taxonomy including CS, EE, statistics, finance, data science, and `Other` |
| 相关工作经验范围 | yes | fresh grad; ≤3 months; 3 months–1 year; 1–3; 3–5; 5–10; 11–15; >15 years |
| 地区 | no | enumerated region list |

The CLI should expose this destination-specific requirement in `info` and
require the four mandatory fields in `prepare`. The year list needs a freshness
date and must not silently become timeless static truth.

## Shared composer contract

All three inspected composers exposed:

- title, rich-text body, preview, `保存草稿`, `草稿箱`, and `发布帖子`;
- body copy stating Markdown is supported;
- toolbar actions for bold, italic, underline, color, font size, headings,
  lists, quote, code, link, image, video, attachment, table, and more;
- AI writing assistance and topic selection;
- an explicit final publish control that remains forbidden.

The scoped transport is textual. Images, video, attachments, polls, aliases,
anonymous posting, topics, props, and the site's AI assistant are not initial
CLI features.

## Title counting

The UI displays a maximum of 40 counter units while the title input has DOM
`maxlength=80`. Live unsaved probes observed:

| input | displayed counter |
|---|---:|
| 40 ASCII letters | 20 / 40 |
| 41 ASCII letters | 21 / 40 |
| 40 CJK characters | 40 / 40 |
| 41 CJK characters | 41 / 40 |
| 40 emoji (`😀`) | 80 / 40 |

This proves the platform counter is weighted rather than a raw code-point
count. The complete weighting/normalization algorithm is not yet established,
so `info` should describe the confirmed examples and mark the exact local
validator as pending instead of guessing. The test title was cleared and never
saved.

No visible body counter or body maximum was observed. Body-size limits remain a
live/server-side unknown.

## Destination rules relevant to routing

- 职场达人 directs job-search experience/questions to forum 28 and interview
  experience to forum 145; PIP, support, and Dev List topics have a separate
  forum.
- 华人生活 asks posters to use the correct specialized boards and forbids
  referrals and rental ads in this forum.
- 求职（非面经） forbids reply-gated content and email-for-material posts, and
  directs interview experiences, referrals, salary discussion, technical
  questions, and OPT/H1B questions to dedicated forums.

These are operational gotchas for `info`, not editorial routing performed by
the CLI.

## Evidence and safety

Evidence source: operator-authenticated, visible Chrome session inspected on
2026-08-30. The session covered only the three explicit composer URLs above.
No credentials, cookies, local storage, or private headers were read. No content
was uploaded and no post was published.

With explicit operator approval, one throwaway draft was saved in 职场达人 →
职场感言 and reopened from `草稿箱`. The exact title, exact body, selected
category, save timestamp, and `草稿箱(1)` state persisted. After separate
operator approval, the fixture was deleted and `草稿箱` returned to empty.

Current terms: <https://www.1point3acres.com/terms_of_service.html>. A headful
browser does not itself grant authorization for an automated product transport.

## Remaining spike

- Establish the exact title weighting/normalization algorithm if a local
  validator is required.
- Establish body maximum and server error shape without publishing.
- Capture any server-originated validation failure in the structured receipt
  contract from issue #34 so the calling agent can self-correct.

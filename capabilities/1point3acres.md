---
schemaVersion: publish.channel-info-source/v1
channel: 1point3acres
displayName: 1point3acres
---
# 1point3acres

## CLI boundary

`publish 1point3acres info [--json]` returns an offline destination/composer contract and human handoff. There is no CLI draft command and no agent-operated website transport. Publish-cli and the agent must not crawl the site, automate login or CAPTCHA, inspect or fill the live composer, save a website draft, or submit a post.

The agent may select a checked-in curated destination, validate known offline fields/examples, and prepare an exact copy-ready handoff containing the composer URL, forum/category, title, Markdown body, theme, and required metadata. A human owns every website interaction in a normal authorized browser: authentication, challenge handling, live-rule confirmation, field selection, paste/preview, 保存草稿, 草稿箱 reopen, and any final 发布帖子 decision. The platform owns current routing/metadata rules, weighted title counting, unknown body limits, and native draft persistence.

This boundary follows the site's [terms](https://www.1point3acres.com/terms_of_service.html) as checked on 2026-09-01: a headful or authenticated browser does not authorize automated access. The terminal product result is a human-saved and human-reopened native draft; publish-cli itself terminates earlier at the local textual handoff. Never operate 发布帖子.

## Authentication

The entry URL is `https://www.1point3acres.com/`. There is no publish-cli profile, cookie cache, or auth probe against the website. The human opens the exact target composer URL in a normal browser, authenticates and resolves any challenge, confirms the live forum/category/rules, then performs all remaining website work in that same human-owned context (`continueInSameContext: true`).

The agent must not take control after login, treat a human's browser session as automation authorization, or inspect a custom target by crawling. If a curated destination does not fit, the human manually inspects the target and returns its forum id or composer URL, visible category/theme, required metadata, and current rules for the offline handoff.

## Platform specification and gotchas

### Curated routing

- `workplace-reflection`: 职场达人, forum id 98, `https://www.1point3acres.com/editor/thread?fid=98&from=home`; default for workplace/career reflection. A theme is required; the default is 职场感言. Job-search material belongs in forum 28, interview experience in forum 145, and PIP/support/Dev List topics have separate forums.
- `chinese-life`: 海外生活 / 华人生活, forum id 29, `https://www.1point3acres.com/editor/thread?fid=29&from=home`; for overseas Chinese life/community experience. Use specialized boards when applicable; referrals and rental ads are forbidden in this forum.
- `job-search`: 海外求职 / 求职（非面经）, forum id 28, `https://www.1point3acres.com/editor/thread?fid=28&from=home`; for job-search writing that is not interview-experience content. A theme plus 找工年度, 工作职位类别, 专业, and 相关工作经验范围 are required; 地区 is optional. Live year/category/taxonomy choices are time-sensitive. Interview, referral, salary, technical, and OPT/H1B topics belong in dedicated forums; reply-gated or email-for-material posts are not allowed.
- `custom`: no runtime crawl. A human must supply the manually confirmed composer URL/forum id, visible category/theme, required metadata, and current destination rules.

Observed fid 98 themes included 职场感言, 请问贵司, 管理, 晋升, 老板相处, 辞职, 扩张, 绩效, 换组, 跳槽, 改行, 自我提升, 裁员, 新组上路, 同事协作, 带新人, 实习体验, and 求比较. Observed fid 28 themes included 其他, 求职简历, 找工就业, 实习, 选组选Offer, 应届生NG, ICC合同工, EE硬件, TeamMatch. Treat both lists as dated observations and confirm the visible live choice.

### Text handoff contract

The handoff requires target, exact title, and textual Markdown body. Include the exact theme for fid 98 and fid 28. For fid 28 also include year, job category, major, and experience range; observed experience choices were fresh grad, no more than 3 months, 3 months–1 year, 1–3, 3–5, 5–10, 11–15, and over 15 years. Region is optional.

The visible title maximum is weighted 40, but the exact algorithm is unknown. Bounded examples from 2026-08-30 were: 40 ASCII letters displayed 20/40, 41 ASCII displayed 21/40, 40 CJK displayed 40/40, 41 CJK displayed 41/40, and 40 grinning-face emoji displayed 80/40. The DOM `maxlength` was 80. Use these examples only as an offline precheck; the human must verify the live counter is not over 40.

The composer says Markdown is supported. Body maximum is unknown and server-authoritative. The initial contract is text-only and excludes images, video, attachments, polls, topics, aliases, anonymous posting, props, and the site's AI assistant; there are no media path, count, byte, dimension, or aspect-ratio rules in this handoff.

### Human save flow and terminal boundary

1. The agent prepares a copy-ready package with exact composer URL/forum id/name, current-use rationale, title, Markdown body, required theme/metadata, and explicit live unknowns.
2. The human opens that URL in a normal browser, authenticates, confirms current forum rules/category, and resolves any changed requirement before entering content.
3. The human selects theme and structured metadata, pastes title/body, checks the weighted title counter, and reviews the complete Markdown preview.
4. The human chooses 保存草稿, opens 草稿箱, and reopens the saved thread. The bounded fixture persisted title, body, forum category, save timestamp, and draft count; required metadata must also be visibly checked for the current draft.
5. The agent records only the human-reported native-draft verification and `published=false`, clearly distinguishing the CLI's local handoff from the human's website work.

If target rules are incomplete, the title counter is over 40, metadata is missing, authentication/rules changed, 保存草稿 is unavailable, or reopened content differs, do not claim a native draft. Correct the handoff or repeat the human save/reopen check. Stop at the reopened draft; authored-post edit/delete recovery is limited and 发布帖子 always remains an explicit human-only decision.

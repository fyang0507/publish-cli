---
schemaVersion: publish.channel-info-source/v1
channel: 1point3acres
displayName: 1point3acres
---
# 1point3acres

## CLI boundary

The CLI offers no functionality to access or write 1point3acres. A human must always perform login and any challenge. After login, a browser/computer-use agent may continue in that same context only when automation is available and the user has explicitly authorized it; otherwise the human follows this same guidance to choose the destination, fill the composer, save the draft, and reopen it for verification. Publish-cli never accesses the site, and the human always makes the final publish decision.

## Authentication

Ask the human to open and log in to `https://www.1point3acres.com/`, preserving that browser context. After login, a browser/computer-use agent may continue there only when automation is available and the user has explicitly authorized it; otherwise the human continues with the documented fill, save, reopen, and verification steps. Authentication can fail because login or a challenge is incomplete or the authenticated page cannot be confirmed; return to the human when a challenge recurs.

## Platform specification and gotchas

- `workplace-reflection`: 职场达人, forum 98, `https://www.1point3acres.com/editor/thread?fid=98&from=home`; use for workplace/career reflection. Theme is required; default to 职场感言 when appropriate. Observed theme choices: 职场感言, 请问贵司, 管理, 晋升, 老板相处, 辞职, 扩张, 绩效, 换组, 跳槽, 改行, 自我提升, 裁员, 新组上路, 同事协作, 带新人, 实习体验, 求比较.
- `chinese-life`: 海外生活 / 华人生活, forum 29, `https://www.1point3acres.com/editor/thread?fid=29&from=home`; referrals and rental ads belong elsewhere.
- `job-search`: 海外求职 / 求职（非面经）, forum 28, `https://www.1point3acres.com/editor/thread?fid=28&from=home`; requires theme, year, job category, major, and experience range. Observed theme choices: 其他, 求职简历, 找工就业, 实习, 选组选Offer, 应届生NG, ICC合同工, EE硬件, TeamMatch. Interview experience, referrals, salary, technical, and OPT/H1B topics have dedicated forums.
- For any other destination, inspect the live forum/category, rules, theme, and required metadata before drafting.
- The visible title counter has a weighted maximum of 40, but its algorithm is unknown; CJK counted as 1, ASCII approximately 0.5, and emoji approximately 2 in bounded fixtures. Obey the live counter. The composer supports Markdown; the body maximum is unknown.
- The initial contract is text-only. No calibrated authenticated/save-success marker is known: require the expected composer controls to be interactive, choose 保存草稿, then reopen from 草稿箱 and compare the content before claiming success. Notify the human only after the draft is ready for review; never operate 发布帖子.

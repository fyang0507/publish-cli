---
schemaVersion: publish.channel-info-source/v1
channel: 1point3acres
displayName: 1point3acres
---
# 1point3acres

## CLI boundary

The CLI offers no functionality to access or write 1point3acres. The agent is expected to use its own browser/computer-use tools to choose the destination, fill the composer, save the draft, and reopen it for verification. The human handles login and any challenge, then returns only to review the saved draft and decide whether to publish.

## Authentication

Ask the human to open and log in to `https://www.1point3acres.com/` in a browser the agent can continue controlling. After login, the agent takes over in that same context. Authentication can fail because login or a challenge is incomplete, the authenticated page cannot be confirmed, or the browser session cannot be handed back to the agent; return to the human when a challenge recurs.

## Platform specification and gotchas

- `workplace-reflection`: 职场达人, forum 98, `https://www.1point3acres.com/editor/thread?fid=98&from=home`; use for workplace/career reflection. Theme is required; default to 职场感言 when appropriate.
- `chinese-life`: 海外生活 / 华人生活, forum 29, `https://www.1point3acres.com/editor/thread?fid=29&from=home`; referrals and rental ads belong elsewhere.
- `job-search`: 海外求职 / 求职（非面经）, forum 28, `https://www.1point3acres.com/editor/thread?fid=28&from=home`; requires theme, year, job category, major, and experience range. Interview experience, referrals, salary, technical, and OPT/H1B topics have dedicated forums.
- For any other destination, inspect the live forum/category, rules, theme, and required metadata before drafting.
- The visible title counter has a weighted maximum of 40, but its algorithm is unknown; CJK counted as 1, ASCII approximately 0.5, and emoji approximately 2 in bounded fixtures. Obey the live counter. The composer supports Markdown; the body maximum is unknown.
- The initial contract is text-only. Fill all required metadata, preview the Markdown, choose 保存草稿, wait for the save result, then reopen from 草稿箱 and compare the content. Notify the human only after the draft is ready for review; never operate 发布帖子.

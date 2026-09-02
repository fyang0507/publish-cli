---
schemaVersion: publish.channel-info-source/v1
channel: xhs
displayName: Xiaohongshu / RedNote
---
# Xiaohongshu / RedNote

## CLI boundary

The CLI offers no functionality to access or write Xiaohongshu. The agent is expected to use its own headful browser/computer-use tools to import a long article, resolve platform choices, save it, and reopen the browser-local draft. The human handles QR login, reviews generated cards/cover and the reopened draft, and makes the final publish decision.

The documented external workflow below is long-article import. Direct image-text staging is not yet specified well enough to claim support.

## Authentication

Open `https://creator.xiaohongshu.com/publish/publish` in a persistent agent browser. If logged out, ask the human to scan the QR code, then continue drafting in that same browser context. Authentication can fail because the QR login/challenge is incomplete, the creator UI cannot be positively identified, or the browser context is not persistent.

Publish-cli does not own this profile. Preserve it after saving because Xiaohongshu drafts are browser-local and can disappear when browser data is cleared.

## Platform specification and gotchas

- Prepare `.md`, `.docx`, or `.txt` plus a separate title. Import replaces the editor body and does not populate the title. If no title is supplied, copy the first Markdown H1, otherwise the first non-empty line; never invent or silently truncate it.
- Observed editor counters are title 64 and body 10,000; their measurement is unknown, so obey the live counters. Markdown H1/H2, lists, and blockquotes survived import; H3 became a paragraph and bold/italic were stripped. Compare the full import with the source.
- Default to a plain long article: 写长文 → 新的创作 → import → fill title → 暂存离开 → wait for 保存成功 → reopen from 草稿箱.
- Long-article drafts are browser-local. A live observation found a maximum of 100; treat this as observed behavior, not a universal limit, and obey the live UI if it changes.
- Only when image cards are requested, choose 一键排版, review the generated cards/template/cover, then 下一步. This generates images and enters the image-text composer; review image order, the platform-modified title, and the caption, whose observed counter is 1,000.
- Only when topics are requested, choose exact live 话题 suggestions. Plain pasted hashtags are not equivalent structured topics.
- Stop if import fidelity is unacceptable, a counter is exceeded, generation changes are unacceptable, 保存成功 is absent, or the reopened draft differs. The agent must not operate final, private, or scheduled publication controls.

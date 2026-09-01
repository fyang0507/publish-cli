---
schemaVersion: publish.channel-info-source/v1
channel: xhs
displayName: Xiaohongshu / RedNote
---
# Xiaohongshu / RedNote

## CLI boundary

`publish xhs info [--json]` returns an offline capability/readiness contract. There is no `publish xhs draft` transport: publish-cli does not open, inspect, or mutate Xiaohongshu, own selectors, log in, import content, save drafts, or manage browser state.

Execution belongs to an agent-owned headful browser/computer-use context. The agent imports the prepared artifact, reviews fidelity, optionally applies layout and topics, saves, reopens, and verifies the browser-local draft. The human scans the QR code when required, reviews generated cards/cover and the reopened draft, preserves the browser profile, and alone decides whether to publish. Xiaohongshu imports/transforms content, resolves live topics, enforces live limits, generates optional cards, and stores the local draft. Image-text staging is deferred; the supported execution oracle below is the long-article workflow.

Publish-cli and the agent must not operate final, private, or scheduled publication controls. The terminal boundary is a reopened browser-local draft, not a cloud-synced draft and not a published post. After this workflow ends, a human may separately decide to publish manually; that later action is outside publish-cli and the agent-owned flow.

## Authentication

Use the entry URL `https://creator.xiaohongshu.com/publish/publish` in a selected headful agent browser with a persistent local profile. If the page is logged out, display the QR code for the human to scan, positively identify the authenticated creator UI, and continue import, save, and reopen in that exact context (`continueInSameContext: true`). A loaded login page or stale browser profile is not readiness proof.

Publish-cli creates no XHS profile. The selected browser backend owns the profile location and must preserve it: Xiaohongshu drafts are browser-local and disappear when browser data is cleared. If authentication cannot be positively proven, a challenge remains, or the browser state is ambiguous, stop as human-required/inconclusive; do not infer readiness or switch to a disposable context.

## Platform specification and gotchas

### Required long-article inputs

Prepare a local `.md`, `.docx`, or `.txt` file and a separate title. Native import overwrites the current editor body. The first Markdown H1 does not populate the title automatically. When the caller supplies only a file, deterministically copy its first Markdown H1 into the separate title field; if there is no H1, use the first non-empty plain-text line. Do not invent or silently truncate a title: if neither source yields a usable title, or the resolved title exceeds the visible counter, stop and request a title/correction. Observed visible editor maxima on 2026-08-30 were title 64 and body 10,000; their Unicode measurements are unknown and the live counters are authoritative.

For Markdown import, observed H1, H2, ordered/unordered lists, and blockquotes survived; H3 became a paragraph and bold/italic were stripped. Review the complete imported body and correct unacceptable downgrade before saving.

### Agent browser flow

1. Open the creator entry URL, complete QR login if needed, and keep the same persistent context.
2. Enter 写长文, choose 新的创作, invoke file import, acknowledge that import replaces the body, and upload the prepared `.md`, `.docx`, or `.txt` artifact.
3. Compare the complete imported body with the source and review the known formatting downgrades. Populate the separate title explicitly and keep title/body within the visible counters.
4. Plain long article is the default: when image-card output was not explicitly requested, skip 一键排版 and add no topics. For requested image-card output only, choose 一键排版, review every generated card plus template, cover, optional author, and summary, then choose 下一步. 下一步 triggers platform image generation and enters the ordinary image-text composer. The bounded fixture generated three cards plus an auto-summary, template, and cover; author maximum was 20, summary maximum 60, and word-count/read-duration presentation required at least 1,500 body characters. These observations are not universal maxima.
5. In the resulting image-text composer, review generated images/order and the auto-truncated final title. The final-title maximum and measurement are unknown. Fill the separate caption within its observed 1,000 maximum when needed.
6. Only when the caller requested topics, invoke 话题 for each query and select an exact live suggestion. Topics must persist as structured clickable entities; plain pasted hashtags are not substitutes. With no requested topics, add none. Four topics persisted in the fixture, but the actual maximum is unknown.
7. Choose 暂存离开, wait for 保存成功, open 草稿箱 in the same profile, reopen the item, and compare title/body or generated cards/caption/topics with the intended result.

Stop if import is incomplete, a visible counter is exceeded, generated layout/title/crop/order is unacceptable, a topic does not resolve exactly, 保存成功 is absent, or reopened content differs. Do not silently accept platform transformations. Success requires the requested branch to persist after reopen and no publication action by publish-cli or the agent.

### Draft storage and deferred image-text guidance

The draft is browser-local, not cloud-synced, and is lost when browser data is cleared. An observed maximum of 100 drafts is a dated platform observation, not a durable guarantee. Preserve the browser profile after delivery.

Image-text is not a complete supported transport contract. Preparation-only live guidance accepted multiple JPEG, PNG, and WebP images, rejected GIF and Live Photo, showed a 32 MB per-image label, recommended ratios from 3:4 through 2:1, and recommended at least 720x960. Exact byte boundary, image count, title/body rules, and complete staging semantics remain unknown. Do not substitute this partial guidance for the long-article execution oracle or claim image-text draft support.

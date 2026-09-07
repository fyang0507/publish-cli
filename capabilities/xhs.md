---
schemaVersion: publish.channel-info-source/v1
channel: xhs
displayName: Xiaohongshu / RedNote
---
# Xiaohongshu / RedNote

## CLI boundary

Publish-cli has no Xiaohongshu read or write transport. `publish xhs info` provides the procedure below; the agent executes it in its own persistent, visible browser and verifies readiness there. The operator owns editorial choices, content representation, and publication authorization.

Start from a long article; direct image-text, video, and podcast staging are unspecified. This guidance does not authorize publication. When the user explicitly requests publication and execution permissions allow it, continue through verification of the published result; the CLI's draft boundary is not a reason to stop this browser workflow early.

## Authentication

Open `https://creator.xiaohongshu.com/publish/publish` and positively identify the authenticated creator UI before drafting. For QR login or another challenge, ask the human to complete it, then resume in that exact browser context. Cookies and local files alone do not prove readiness.

Drafts are browser-local. Preserve the same browser profile through save and verification, including human review; clearing or losing its data can remove drafts. Report this limitation at handoff. Stop if the creator UI cannot be identified, login remains incomplete, or the original context cannot be continued.

## Platform specification and gotchas

The following behavior was observed on 2026-08-30 and 2026-09-06. Re-check current controls and counters before acting. Plain long-article save/reopen was verified; image-text save/reopen and automated publication were not verified in the latest follow-up. These gaps do not block otherwise authorized composer preparation and review.

### Import the article

1. Prepare `.md` (preferred), `.docx`, or `.txt` and a separate title. Open `写长文` → `新的创作`, import the source, and fill the title. Import replaces the entire body and leaves the title empty. Without a supplied title, copy the first Markdown H1, or the first non-empty line if no H1 exists. Never invent or silently truncate it.
2. Compare the complete imported body, block order, and supported structure with the source. Observed imports preserved H1/H2, lists, and blockquotes; H3 became a paragraph, bold/italic lost styling, and hyperlinks became plain labels. Disclose these losses and resolve unacceptable changes. If the user accepts labels without links, continue without asking again or inserting visible URLs; preserve the linked source separately.
3. Obey live counters. The long-article editor showed 64 for the title and 10,000 for the body, but their measurement units are unknown.

### Choose the representation

- **Plain draft only:** keep the long article and proceed to draft saving below.
- **Complete post preparation or publication:** explain that `一键排版` → `下一步` converts the article into image cards and opens the image-text composer, where structured topics were available. Continue unless the user restricted the representation. Clarify any conflicting constraint; silence does not approve an exception.

For the card route, review card count, order, full text, pagination/readability, template, summary, and cover. Compare all body-card text with the accepted article. Conversion can change the title: show any changed title exactly and obtain acceptance before adopting it; do not silently repair or truncate it. The image-text title limit remains unverified.

### Complete the image-text composer

- **Caption:** use the supplied text or, when post preparation is delegated, write a concise, source-grounded summary/hook. Make it witty when requested, without substituting pasted excerpts or adding unsupported claims. The caption is separate from the cards; its observed counter was 1,000 with unknown units.
- **Topics:** select requested topics through live `话题` suggestions and verify each became a native topic entity, not literal `#text`. If an exact match is missing or ambiguous, stop topic selection and return the visible candidates. When post completion is delegated, choose a small relevant set from live suggestions; the user need not name every topic. The maximum count is unknown. Preserve topic entities during caption edits and verify both text and topics afterward; replacing the whole editor can erase topics.
- **Declarations:** complete applicable fields and preserve existing choices. When requested, enable `原创声明` and verify both the checked control and `已声明原创` preview. Select only an accurate content-type declaration. Do not invent optional locations, people, groups, attachments, or other associations.

Before saving, publishing, or handing off, review the exact title, all images, caption, topics, and applicable declarations. A browser action returning without error does not prove a change: inspect the visible result. If controls do not respond, follow the browser tool's documented troubleshooting and retarget observed controls. Do not use hidden handlers or private APIs. Ask for the exact blocked human action only when necessary, then resume in the same context.

### Save or publish and verify

- **Draft:** identify a non-publication save control before using it; `暂存离开` was verified for plain long articles. If missing or ambiguous, stop without trying neighboring controls. Reopen the corresponding entry through `草稿箱` in the same persistent browser. For a plain draft, require the exact accepted title, full body, block order, and supported structure. For a card draft, first establish the current save control's role, then require the accepted card count/order/content, template/cover, exact title, caption, and every topic entity after reopening. A toast, autosave label, reload, URL change, or landing page alone is insufficient. A missing, ambiguous, or differing draft remains unverified: stop and do not repeat the save.
- **Authorized publication:** verify the completed composer, identify the current publication control, submit once, and check an authoritative result or post record. A `published=true` URL alone is insufficient. Do not schedule or change visibility beyond the user's authorization.
- **Uncertain save or submission:** reconcile the result before any retry. A draft or post may already exist; inspect the same-profile draft box or authoritative publication record. Report only the verified outcome and distinguish human actions from agent actions.

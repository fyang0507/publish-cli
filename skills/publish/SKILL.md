---
name: publish
description: Inspect channel readiness, discover content, and stage drafts with the publish CLI. Route requests for X posts or Articles, LinkedIn, WeChat public accounts, Xiaohongshu (xhs/RedNote), Reddit, 1point3acres, and personal websites to the supported CLI or agent-owned workflow.
---

# Publish

Use `publish` for discovery and draft staging. The calling workflow owns editorial strategy, approvals, and publication.

## Boundaries

CLI content commands stop at verified native drafts and provide no final-send transport. In an agent-owned workflow, continue beyond that checkpoint when the user has authorized further preparation or publication, using live controls within execution permissions. Otherwise, stop before final submission.

## Route the request

1. Identify the requested channels and outcome. Handle selected channels sequentially; skip unrequested channels.
2. Resolve command spelling with `publish --help`, then read each selected channel's guide:

   ```bash
   publish <channel> info --json
   ```

3. Follow the full response: capabilities, readiness, authentication and recovery, executor, browser-context requirements, and completion checks. User instructions override workflow defaults, but cannot supply missing capabilities or verification.
4. For a CLI action, read its `--help` before running it. For an agent-owned or human-handoff workflow, follow the returned procedure in the required context.
5. If the guide is unavailable, an action is unsupported, or recovery or verification is blocked, complete independent authorized preparation and report the exact blocker. An inconclusive result is not success.
6. Report what changed, the last verified state (editor, saved draft, submitted, or published), and remaining work.

## References across platforms

When reference hyperlinks are unsupported, retain readable reference text in the staging copy and remove link markup and destination URLs, unless the user requests visible URLs. Do not generate a replacement bibliography. Preserve the linked canonical source locally.

Keep references in a distinct, labeled section and preserve their existing style where supported. Use the channel's completion checks; reference formatting adds no preview or visual-verification requirement.

## Workflow order

For agent-owned browser work, open a fresh tab for each channel task in the required browser profile, then preserve that context through save and verification. For CLI-owned browsers, follow the channel's launch and recovery procedure.

Use these ordering examples only for channels the user selected, following any requested order:

- Long essay, usually supplied in Chinese: Xiaohongshu → WeChat → English translation using an available translation skill → personal website → optional X Article or Reddit.
- Short post, usually supplied in English: X tweet → LinkedIn.

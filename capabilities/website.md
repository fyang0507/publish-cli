---
schemaVersion: publish.channel-info-source/v1
channel: website
displayName: Personal website
---
# Personal website

## CLI boundary

The CLI provides discovery only. Delegate content staging to a subagent in the target website repository/worktree, using its local `add-website-content` skill. The deliverable is a verified review branch/commit or draft PR; merge and deployment remain outside publish.

## Authentication

Readiness is `agent_check_required`: the agent must check repository access, the local skill, and required tooling. Local preparation needs no GitHub login; remote staging requires repository access. Report missing prerequisites as blockers.

## Platform specification and gotchas

- **Source:** supplied prose is canonical; the calling workflow owns authoring and translation. Follow the website repository's instructions for formatting, assets, and validation.
- **Article text:** Chinese and English versions are expected unless a single-language exception is explicit. English precedes Chinese, separated by `---zh---`; newlines are literal, and frontmatter titles are not repeated in the body.
- **Metadata:** supply `title`, `title_zh`, `date`, `coverImage`, `languages`, and positionally aligned `tags`/`tags_zh`. Optional subtitles are bilingual; use the repository's tag choices.
- **Media:** supply full-resolution originals and placement; covers use JPEG, PNG, or WebP. Gallery photos need capture dates, locations, and categories. Preserve source-relative paths when delegating.
- **Completion:** review the subagent's change and require archive-audit and real-browser preview evidence for relevant languages and media. Missing evidence means incomplete work. Preserve existing content, stable IDs, and unrelated edits.

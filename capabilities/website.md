---
schemaVersion: publish.channel-info-source/v1
channel: website
displayName: Personal website
---
# Personal website

## CLI boundary

Website content is delegated to a headless subagent rooted in the target website repository/worktree, using its repository-local `add-website-content` skill. The CLI provides discovery only. The deliverable is a verified review branch/commit or draft PR; merge and deployment remain outside publish.

## Authentication

Readiness is `agent_check_required`: repository, skill, delegation, tooling, and remote access are unverified. Local preparation needs no GitHub authentication; remote staging requires access to the target repository. The operating agent owns delegation and review of the result. Missing prerequisites or incomplete verification remain blockers.

## Platform specification and gotchas

- **Ownership:** the website repository's instructions and content skill own formatting details, generators, audits, and browser verification. Supplied prose is canonical; authoring and translation belong to the calling workflow.
- **Article text:** Chinese and English versions are expected unless a single-language exception is explicit. English precedes Chinese, separated by `---zh---`; newlines are literal, and frontmatter titles are not repeated in the body.
- **Metadata:** `title`, `title_zh`, `date`, `coverImage`, `languages`, and positionally aligned `tags`/`tags_zh` are required. Optional subtitles are bilingual. Primary tag pairs include `stories we live` / `我们生活的故事`, `everyday chronicles` / `日常记趣`, `travel log` / `游记`, `commentary` / `杂文`, and `poem` / `诗`.
- **Media:** full-resolution originals and intended placement are inputs; the website owns derived assets. Covers use JPEG, PNG, or WebP. Gallery photos need capture dates, locations, and categories. Source-relative media paths retain their meaning across the delegation boundary.
- **Completion:** a reviewable change with archive-audit and real-browser preview evidence, including relevant language variants and media. The parent owns the success claim; missing evidence is incomplete work. Existing content, stable IDs, and unrelated edits are preserved.

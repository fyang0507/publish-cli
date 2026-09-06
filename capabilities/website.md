---
schemaVersion: publish.channel-info-source/v1
channel: website
displayName: Personal website
---
# Personal website

## CLI boundary

The CLI provides discovery and a delegated repository workflow only. There is no `publish website draft` transport and no subagent launcher in the CLI. The operating agent starts a headless subagent in the selected personal website repository or isolated worktree. That subagent uses the repository-local `add-website-content` skill to prepare and verify a repository-native review draft. Stop at a verified review branch/commit or draft PR; never merge, push to a deployment branch, dispatch deployment, or operate an equivalent final-publication surface. Local previews are verification artifacts, not evidence of live publication.

## Authentication

`info` returns `agent_check_required`, not readiness proof. It does not inspect the repository, local skill, credentials, remote permissions, generators, browser, or subagent availability. The immediate executor is the operating agent in its local runtime: resolve and verify the target repository and launch a repository-scoped subagent using the host's supported delegation facility. Local preparation needs no GitHub authentication; the subagent must verify access to the exact remote when remote staging is requested. Report missing checkout/skill, unavailable delegation, missing tools, conflicts, authentication/permission failures, network errors, and inconclusive checks distinctly. Never expose credentials or infer access from cached login state.

## Platform specification and gotchas

### Delegation and repository boundary

- Resolve the intended personal website checkout from the calling workspace's configuration or the operator's supplied repository location. A sibling checkout is a possible layout, not proof of identity. Confirm the repository remote and intended base branch before launching; do not infer the website root from publish-cli's installation path or the caller's current directory.
- Start a headless subagent with its task context and working directory rooted in the selected website repository or isolated worktree. Merely changing a shell command's directory in an already-running agent does not establish repository skill discovery. At startup, have the subagent read that repository's `AGENTS.md` and load its own `.agents/skills/add-website-content/SKILL.md`, then the article/photo references appropriate to the request. Confirm these resources are available in the selected worktree; do not assume parent-agent skills are inherited. No nested skill or cross-repository skill symlink is required in publish.
- Pass a self-contained assignment: verified repository/base branch, review-only stop boundary, requested content operation, supplied language versions and metadata, accessible source/media locations, and explicit editorial exceptions. Resolve caller-relative input paths against the original caller directory before dispatch; source Markdown image paths remain relative to that source document, not the subagent's working directory. If the subagent uses a different filesystem, transfer the authorized inputs and provide their new locations before it starts. Never pass credential values or unrelated workspace material.
- The subagent owns website edits and runs generators, Git operations, the archive audit, and browser preview checks from the selected website root. Preserve unrelated work and use a non-deployment review branch/worktree. The local skill and repository sources own implementation details and take precedence over this high-level input summary if the schema changes; report mismatches to the caller before changing supplied content.
- If the host cannot launch a headless task in the required repository context, or the local skill is missing, report the setup blocker. Do not silently perform the website workflow in the calling workspace. The parent waits for completion, reviews the returned diff and verification evidence, and follows up on failures or incomplete verification before reporting success.

### Article inputs

- Supply Chinese and English versions unless the operator explicitly requests a single-language exception. Preserve supplied prose. Missing text, translations, dates, categories, or authorship must not be invented; return missing inputs to the calling workflow. Authoring and translation remain its responsibility.
- The current canonical article shape requires `title`, `title_zh`, `coverImage`, `date` (`YYYY-MM-DD`), `tags`, `tags_zh`, and `languages` (normally `['en', 'zh']`). Provide `subtitle` and `subtitle_zh` together when used. Empty `excerpt` and `excerpt_zh` use generated excerpts; supplied excerpts are editorial choices.
- English body comes first, followed by exactly one `---zh---` separator and the Chinese body. Do not repeat frontmatter titles as opening body headings. Newlines are literal rendered line breaks; preserve intentional blank lines and use asterisk emphasis. The local skill defines translation-note and reference formatting; attribution must match the supplied content's actual provenance, and any conflict must be surfaced rather than inventing a translator.
- Align `tags` and `tags_zh` by position. Recognized primary pairs are `stories we live` / `我们生活的故事`, `everyday chronicles` / `日常记趣`, `travel log` / `游记`, `commentary` / `杂文`, and `poem` / `诗`. Additional topical/geographic tags are allowed. Confirm category fit instead of inventing a primary tag; these pairs control Writing-page filters.
- Article Markdown belongs in `content/posts/`; covers belong in `images/blog/covers/`. Supply accessible full-resolution JPEG, PNG, or WebP covers, preserve filename case, and disclose any required alpha flattening or format conversion. Supply body media and its intended placement as well. Let the website tooling generate served derivatives; do not hand-resize assets or edit generated manifests. Existing dates and English titles affect public IDs, so preserve them during unrelated updates and check new IDs for collisions.

### Photo inputs and completion evidence

- For gallery additions, provide full-resolution originals, actual capture dates, truthful locations, and appropriate existing categories. The website skill owns `images/gallery/`, `content/photos-source.ts`, stable numeric IDs, and derivative generation. Do not substitute import dates for unknown capture dates.
- The website workflow regenerates media derivatives when media changes, then content manifests, then Chinese font subsets when Chinese text changes. The local skill owns the exact commands and complete archive audit. Generated files must be included in the review change.
- Require the subagent to return its selected repository/worktree and review branch/commit or draft PR, changed content and stable IDs/URLs, audit results, and real browser preview evidence for relevant language variants, media, links, and desktop/mobile layouts. A successful process exit, saved file, or generator alone is insufficient. If browser verification is unavailable, report incomplete verification.
- The parent reports a verified draft only after reviewing that evidence. Do not fabricate a CLI transport receipt for a delegated workflow. Final merge and deployment remain with the human/calling workflow.

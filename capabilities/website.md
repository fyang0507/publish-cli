---
schemaVersion: publish.channel-info-source/v1
channel: website
displayName: Personal website
---
# Personal website

## CLI boundary

The CLI provides discovery and an agent-owned repository workflow only. There is no `publish website draft` transport. The operating agent follows the website-owned skill to prepare and verify a repository-native review draft. Stop at a verified review branch/commit or draft PR; never merge, push to a deployment branch, dispatch deployment, or operate any equivalent final-publication surface. Local previews are verification artifacts, not evidence of a live publication.

## Authentication

`info` returns `agent_check_required`, not readiness proof. It does not inspect the linked skill, repository, credentials, remote permissions, generators, or browser. The executor is the operating agent in its local runtime. Resolve the linked skill and positively check the selected repository identity, branch/worktree, source schema, and required tooling before editing. Local preparation needs no GitHub authentication; verify access to the exact remote when remote staging is requested. Report missing checkout/skill, missing tools, conflicts, authentication/permission failures, network errors, and inconclusive checks distinctly. Never expose credentials or infer access from cached login state.

## Platform specification and gotchas

1. Locate `website/SKILL.md` relative to the loaded publish skill directory. This is an explicit handoff to the website-owned `add-website-content` skill, not a CLI-owned copy of the content procedure. Resolve the entire symlink chain and read its entrypoint and only the references needed for the requested content.
2. The link is a local-checkout integration. All target repositories must be available with the relative layout preserved, or the operator must relink `website` to the intended website skill directory. An npm package alone does not include the external skill. If the link or any required reference is unavailable, stop with the missing prerequisite; do not guess another workflow or claim readiness.
3. Select the intended website checkout or isolated worktree explicitly. Verify its identity and read its own `AGENTS.md`. Resolve linked skill references relative to the skill directory, but run content generators and Git commands from the selected website root, never from the calling workspace or publish-cli. If using a worktree, use its matching website skill and source version. Pass the selected root through `--root` when invoking the content audit from elsewhere.
4. Preserve unrelated edits. Prepare the change on a non-deployment review branch/worktree. The website skill owns canonical inputs, article/photo metadata, stable IDs, generated media/manifests/fonts, audits, and browser preview checks. Preserve supplied prose; authoring and translation belong to the calling workflow.
5. Follow that skill through its audit and real browser verification. A saved file or successful generator is insufficient: inspect the rendered content and required assets. Keep the same selected repository/worktree throughout preparation and verification.
6. Report the review branch/commit or draft PR, changed content, preview evidence, audit result, and any remaining blockers. If no verified review draft exists, report incomplete preparation. Do not fabricate a CLI transport receipt for this agent-owned workflow. Final merge and deployment remain with the human/calling workflow.

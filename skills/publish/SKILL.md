---
name: publish
description: Use the publish CLI to inspect channel capabilities and readiness, perform supported discovery, and stage content for X, LinkedIn, Reddit, WeChat, Xiaohongshu, 1point3acres, or a personal website. Route agent-owned workflows according to the requested outcome.
---

# Publish

Use `publish` as the mechanical distribution layer. Editorial strategy, approval, and the final send remain with the calling workflow and the human.

## Boundaries

- CLI content commands end at verified native drafts; this skill does not add final-send transports. For an agent-owned workflow, a verified draft is a checkpoint when the user has authorized further preparation or publication. Continue the authorized work using live controls and the applicable execution permissions; do not treat the default draft boundary as overriding explicit user instructions. Without publication authorization, stop before final submission.
- Run only the channels and actions the user selected. Do not invent an unsupported transport, format, fallback, or successful verification.
- Authorization to use this skill does not authorize unrelated platform mutations.

## Route the request

1. Identify the selected channel and requested action. For a multi-channel request, keep one route per selected channel and do not inspect the others.
2. Resolve command spelling with `publish --help`, then run this for each selected channel:

   ```bash
   publish <channel> info --json
   ```

3. Treat the complete response as the execution guide. Follow its CLI boundary, authentication, platform guidance, readiness, recovery step, executor, context-continuity requirement, and stop conditions. Use current channel facts rather than remembered procedures. Explicit user instructions take precedence over workflow defaults, but do not create missing transport capabilities or successful verification.
4. If the response selects a CLI action, inspect that action's `--help` and run only the requested action. If it selects an agent-owned workflow, agent-browser, or human-handoff path, follow the returned procedure in the required context.
5. If the action is unsupported, readiness is unresolved, a required recovery step cannot be completed, or a requested terminal result cannot be verified, report that exact blocker after completing independent authorized preparation. Never turn an inconclusive result into success.
6. Report what was inspected or changed, the last verified state (editor, saved draft, submitted, or published), and any remaining work.

If `publish` or the selected `info` response is unavailable, report that the current channel contract could not be resolved. Do not search for repository files or substitute another copy of channel guidance.

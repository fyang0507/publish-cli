---
name: publish
description: Use the publish CLI to inspect channel capabilities and readiness, perform supported discovery, and stage draft-only content for X, LinkedIn, Reddit, WeChat, Xiaohongshu, 1point3acres, or a personal website. Never use it to publish, send, schedule, or make content public.
---

# Publish

Use `publish` as the mechanical distribution layer. Editorial strategy, approval, and the final send remain with the calling workflow and the human.

## Boundaries

- Stop every content workflow at a verified saved native draft. Never operate Post, Publish, Send, scheduling, private-publication, or equivalent final controls.
- Run only the channels and actions the user selected. Do not invent an unsupported transport, format, fallback, or successful verification.
- Authorization to use this skill does not authorize unrelated platform mutations.

## Route the request

1. Identify the selected channel and requested action. For a multi-channel request, keep one route per selected channel and do not inspect the others.
2. Resolve command spelling with `publish --help`, then run this for each selected channel:

   ```bash
   publish <channel> info --json
   ```

3. Treat the complete response as the execution guide. Follow its CLI boundary, authentication, platform guidance, readiness, recovery step, executor, context-continuity requirement, and stop conditions. Do not add remembered channel instructions or override the response.
4. If the response selects a CLI action, inspect that action's `--help` and run only the requested action. If it selects an agent-owned workflow, agent-browser, or human-handoff path, follow the returned procedure in the required context.
5. If the action is unsupported, readiness is unresolved, a required recovery step cannot be completed, or draft verification is absent, stop and report that exact state. Never turn an inconclusive result into success.
6. Report what was inspected or changed, where a confirmed draft was saved, and what remains for human review.

If `publish` or the selected `info` response is unavailable, report that the current channel contract could not be resolved. Do not search for repository files or substitute another copy of channel guidance.

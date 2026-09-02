---
name: publish
description: Answer channel capability and readiness questions, perform supported distribution discovery, and stage draft-only content for X, LinkedIn, Reddit, WeChat, Xiaohongshu, or 1point3acres. Use for channel preparation, requirements, read-only research, or native draft staging; never for sending or publishing content.
---

# Publish

`publish` is a mechanical distribution capability. It discovers supported
opportunities and prepares native drafts; it does not choose an editorial
strategy or publish content.

## Hard boundaries

- Stop every content workflow at a saved native draft. Never operate Post,
  Publish, Send, scheduling, private-publication, or equivalent final controls.
- Treat a staged draft as awaiting human review. Do not claim a draft exists
  unless the current channel verification contract is satisfied.
- Keep editorial judgment, voice, campaign policy, approvals, and notifications
  in the calling workflow. Authorization to use this skill does not authorize
  publication or unrelated platform mutations.

## Route each request

1. Identify only the channels and actions required by the request. For a
   multi-channel request, keep a separate route for each selected channel; do
   not inspect every supported channel. Resolve each CLI channel token from
   `publish --help`; never derive a command token from a platform display name.
2. For each selected channel, run the following unless the explicit offline
   branch below applies:

   ```bash
   publish <channel> info --json
   ```

   Treat that response as the current execution oracle. The JSON fields
   `info.cliBoundary`, `info.authentication`, and `info.platformGuidance` own
   channel support, authentication, required inputs, platform behavior, and
   limitations. `readiness` owns current status, evidence, `verificationMode`,
   executor, human involvement, context continuity, and recovery. Do not replace
   these facts with remembered limits or prose copied into this skill.

   `info` is side-effect-bounded but not generally offline: readiness may
   navigate an ephemeral copy of a browser profile, open one passive visible
   retry, or perform a normal API credential exchange. It never logs in, opens
   a composer, or stages content.

   If the user forbids browser, network, API, or platform access, apply that
   constraint to the whole route, not just `info`:

   - Inspect `publish <channel> info --help` first. Run `info --json` only when
     its help says the selected channel info does not access the platform.
   - Otherwise, resolve the active CLI package root from the installed `publish`
     executable or current checkout, then read only
     `<package-root>/capabilities/<channel>.md` when present. It is the backing
     source for `info`, not a second skill copy. Always state that this provides
     static guidance only and that current readiness is unavailable.
   - If that source is unavailable, inspect only offline `--help` and state that
     the full current channel contract and readiness could not be loaded.
   - Do not run any other command merely because it is described as read-only;
     use it only when its help or selected contract explicitly guarantees no
     browser, network, API, or platform access.
   - If the request requires a live step forbidden by this constraint, stop and
     identify the blocked step. Do not substitute stale facts or partial work.
     Installation, dependency fetching, and building are also blocked unless
     their required access is explicitly allowed.
3. Interpret the selected response in this order:

   - First decide whether the requested action and format are supported, and
     whether execution belongs to a CLI transport, an agent browser, or a human
     handoff. If unsupported or undefined, stop and report the boundary. Never
     invent a browser fallback, silently change format, or approximate the task.
   - For a CLI transport, inspect only `publish <channel> --help` and the matching
     action help. When the selected contract permits, use a dry run before a
     content-bearing action. Run only the action the user requested.
   - Apply readiness only to the requested step when the selected contract says
     that step requires authentication. Login-free or otherwise auth-independent
     actions may continue even when another action on the channel is not ready.
   - If a CLI-owned `passive_browser` or `api` step requires auth and is not
     ready, follow a present `readiness.nextStep.instruction` and `workflowRef`
     within that CLI route. Do not treat its `entryUrl` as permission to
     establish an unrelated browser session. The declared `executor` owns the
     immediate step; involve a human when `requiresHuman` is true, and preserve
     the same execution context when `continueInSameContext` is true. If no next
     step is present, use `info.authentication` and do not infer recovery.
   - For `verificationMode: browser_agent`, proceed only when the request
     authorizes that website interaction and suitable headful browser tools are
     available. Follow the returned next step, use its `entryUrl` when present,
     obtain any required human login or challenge completion, and preserve the
     context when instructed. After readiness is resolved, follow the selected
     `info.platformGuidance` workflow in that context through its draft-only
     terminal state and stop conditions.
   - For `verificationMode: human_handoff`, give the human the returned
     instructions and entry URL when present. Continue with browser automation
     only if `info.cliBoundary` permits it, suitable tooling is available, and
     the user authorized that interaction; otherwise preserve the handoff. The
     human or authorized browser agent then follows the selected
     `info.platformGuidance` through its draft-only terminal state and stop
     conditions.
   - A false `ready` value is not permission to guess. External modes may use a
     non-ready status to transfer ownership of the documented workflow.
4. Re-read only the selected channel response when the task changes action,
   format, channel, execution context, or a diagnosis reclassifies the failure.
   Never preload other channels for convenience.
5. Report the applicable terminal state: capability facts for an information
   request; or, for execution, what was read or changed, where the native draft
   was saved, what verification succeeded, any artifacts left by partial
   failure, and what remains for human review. Do not convert an inconclusive
   receipt into success.

## Conditional references

- If the CLI is absent, unbuilt, newly installed, cannot resolve its data
  workspace, or is independently proven stale relative to its source checkout,
  read
  [references/setup.md](./references/setup.md).
- Do not infer a stale build from an ordinary runtime, network, authentication,
  or selector failure; use the selected response and failure evidence first.
- If an ordinary execution hangs or lands on unexpected UI, capture the step,
  URL, visible evidence, and current receipt; report that no confirmed draft was
  produced, then stop. Do not expand a drafting request into repository repair.
- Only when the user requested CLI diagnosis or maintenance, read the matching
  guide for the selected maintained transport:
  [X](./references/calibration/x.md),
  [LinkedIn](./references/calibration/linkedin.md), or
  [Reddit](./references/calibration/reddit.md). Never load the other transport
  guides or use these for agent-owned external-browser channels.

These references cover shared installation and maintainer diagnostics only.
Channel capability and execution guidance remains native to
`publish <channel> info [--json]`.

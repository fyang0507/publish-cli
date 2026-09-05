# Authentication readiness contract

`publish auth check` is the shared P0 preflight for every channel. It separates:

1. Local evidence: meaningful profile state, sanitized cookie-cache shape and
   declared expiry, credential presence, or token-cache state.
2. Live proof: a positive authenticated UI signal or harmless authenticated API
   call.
3. Recovery: a structured status and sanitized executable `nextStep`.

Browser probes never call `ensureSession()`, submit credentials, open composers,
or copy cookies. Missing selectors are `probe_inconclusive`; navigation failures
are `network_error`. For an existing profile, `login_required` needs a positive
logged-out signal.
Declared-expired cookie caches are invalid local evidence, but an existing profile
is still probed because the live session may remain valid.

Reddit has an additional conclusive fallback. If its explicit HTTP 403 network-
security wall blocks the headless probe, the CLI automatically retries once in a
passive headful browser; a browser window may briefly appear and is closed after
the observation. It still never clicks, fills, or logs in. DOM drift falls
back to Reddit's same-origin `/api/me.json` account endpoint. A successful headful
retry is disclosed in `evidence.note`; a wall that also blocks headful is
`network_error`, not `probe_inconclusive`.
Only a structured account response or structured authentication rejection proves
logout. An opaque/non-JSON 403 from the account endpoint is an access wall and
returns `network_error`; status code alone never implies `login_required`.

An absent or empty profile is deterministically not ready. The probe returns
`login_required` with `liveProbe: not_run` and does not launch Playwright, create
a profile tree, or change the local evidence. Repeating a zero-state check is
therefore idempotent.

Every receipt has a binary `ready` field. `status` explains a false result and
selects its recovery. In particular, `probe_inconclusive` means the CLI reached
the site but could not positively identify authenticated, logged-out, or
challenge state. It is non-ready and exits `1`; the agent must follow `nextStep`,
open the entry URL with a headful browser agent, inspect the visible state, and
continue the workflow in that same context only after authentication is proven.

WeChat preserves the credential → token → IP-allowlist stages. A missing or
expired token may be renewed through the normal App ID/Secret exchange; successful
renewal appears in `healed` as `token_refreshed`. No token or secret is emitted.

## CLI

```bash
publish auth check --platform x,linkedin,reddit --json
publish auth check --platform wechat,xhs --json
```

The platform list is always explicit and deliberate. There is no `--all`.

- CLI-probed: `x`, `linkedin`, `reddit`, `wechat`.
- Agent-owned: `xhs`, `1point3acres`; these return `agent_check_required` with a
  browser recovery step because publish-cli does not own their browser context.

- Exit 0: every requested platform has `ready: true`.
- Exit 1: one or more platforms have `ready: false`; follow `nextStep`.
- Exit 2: invalid usage, including a malformed platform list, missing option
  value, unknown option/platform, removed `--all`, or a missing `--platform`.

## Channel info integration

Default `publish <channel> info` uses `src/auth/registry.ts`'s `probeAuth()` seam
and includes the returned readiness without turning a non-ready result into a
command failure. `publish <channel> info --static` is a separate capability-only
path: it loads only the selected packaged Markdown source, marks readiness as
skipped and unavailable, and does not inspect profiles or tokens, launch a
browser, use the network or API, renew credentials, or access the platform.

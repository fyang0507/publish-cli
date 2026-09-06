# publish-cli

## Instruction source

`AGENTS.md` is the only editable repository-agent guide. `CLAUDE.md` is a
checkout compatibility symlink; never maintain a second copy.

## Product boundary

`publish` is a channel-first discovery and draft-staging CLI. Every content
workflow must stop at a verified native draft for human review. Never click or
call Post, Publish, Send, scheduling, private-publication, `freepublish/*`,
`message/mass/*`, or any equivalent final-send surface.

Editorial strategy, personas, approvals, and final publication belong to the
calling workflow, not this repository.

## Sources of truth

- `publish <channel> info [--json]` owns channel capabilities, authentication,
  platform guidance, readiness, recovery, executor ownership, and stop
  conditions. Its Markdown source lives in `capabilities/`.
- Action-level `--help` owns command flags.
- `skills/publish/SKILL.md` is a thin, standalone router. Do not duplicate
  channel facts there or link it to repository files. The post-build installer
  links shipped skill directories into `.agents/skills` with relative checkout
  symlinks; edit the source skills here, not workspace copies.
- `README.md` owns user setup and examples. `docs/PRODUCT_SPEC.md` owns the
  product vision and roadmap.

## Channel surfaces

| Channel | Surface | Transport |
|---|---|---|
| X | `create-watch-list`, `watch`, `draft`, `reply`, `history` | Browser CLI |
| LinkedIn | `draft` | Browser CLI |
| Reddit | `inspect`, `search`, `draft` | Browser CLI |
| WeChat | `check`, `draft` | Official API CLI |
| Xiaohongshu | Procedure returned by `info` | Agent-owned browser |
| 1point3acres | Procedure returned by `info` | Human handoff |

Do not add a transport or claim readiness merely because a research spike found
a possible route.

## Authentication readiness

Authentication is P0 for channel expansion. Follow issue #45 and
`docs/AUTH_READINESS.md`:

- Browser `probeAuth()` is passive: never call `ensureSession()`, submit stored
  credentials, or open a composer.
- Treat profiles, cookies, and caches as evidence, not proof. Require a positive
  live UI or API signal.
- Probe browser channels through an ephemeral profile copy; Chrome mutates user
  data even during nominally read-only navigation.
- Preserve distinct structured states for login, human challenge, rejected
  credentials, IP allowlist, network failure, and `probe_inconclusive`.
- Return sanitized recovery instructions, executor, human involvement, entry
  URL, and context-continuity requirements where applicable.
- Never emit secrets, private headers, cookies, or unrelated page/API content.
- Test ready, zero-state, expired/revoked, long-idle, and inconclusive/network
  cases live before claiming usability.

Normal API token renewal is allowed but must be reported in the receipt.

## Implementation invariants

- TypeScript and Node use ESM. Local imports include the `.js` extension.
- All content-bearing commands use `src/commands/contentInput.ts` and enforce
  exactly one of `--text` or `--from`.
- X, LinkedIn, and Reddit use separate persistent browser profiles. Reuse common
  helpers by import; do not restructure the shipped X path to add a sibling
  channel.
- X reads through browser GraphQL capture matched by operation name. Do not
  reintroduce out-of-band X clients such as `agent-twitter-client` or `twikit`.
- WeChat uses the Official Account API through one fixed-egress seam. Only token,
  image/material upload, `draft/add`, and the read-only domain-IP check are in
  bounds. Its rendered article CSS must remain inline.
- Caller-supplied Markdown is canonical. `--from -` reads stdin; generated files
  are inspection artifacts, while the native saved draft is the deliverable.
- X read dedupe and reply idempotency are separate risk controls. Record a reply
  only after successful staging; bypass requires explicit `--force`. Reply
  coordination is limited to processes using the same live SQLite file and the
  same machine-local X profile origin; copied or synchronized databases are not
  cross-machine coordination.

## State and repository posture

Persistent profiles, cookie caches, and WeChat tokens live under
`PUBLISH_DATA_DIR` and must stay off this repository and cloud-synced paths.
Durable sqlite state lives in `<data_repo>/.publish-cli/`; resolve the data repo
through `PUBLISH_DATA_REPO`, `publish.config.dev.yaml`, or a
`.agents/workspace.yaml` walk-up. Never hardcode a personal path.

The X profile contains one private opaque origin identity under
`PUBLISH_DATA_DIR`. The reply database binds to that origin on first use; new
reservations and finalized rows retain it. A different profile must fail before
browser work. Migrated legacy rows keep unknown origin and cannot be bypassed
with `--force` or stale-reservation recovery. Never expose host names, private
paths, credentials, cookies, or profile contents as provenance.

Keep this public capability layer generic: say "the operator," avoid personal
identity or workspace policy, and keep secrets out of fixtures and output.

## Build and verification

```bash
npm install
npm test
node dist/cli.js --help
npm pack --dry-run
```

Compilation and unit tests are necessary but insufficient for platform flows.
Live-verify browser reads/drafts against the real site, and verify WeChat through
the real API plus the draft-box preview, before claiming an execution path works.
Never turn an inconclusive probe or unverified save into success.

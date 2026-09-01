# Authentication readiness contract

`publish auth check` is the shared P0 preflight for every channel. It separates:

1. Local evidence: meaningful profile state, sanitized cookie-cache shape and
   declared expiry, credential presence, or token-cache state.
2. Live proof: a positive authenticated UI signal or harmless authenticated API
   call.
3. Recovery: a structured status and sanitized executable `nextStep`.

Browser probes never call `ensureSession()`, submit credentials, open composers,
or copy cookies. Missing selectors are `probe_inconclusive`; navigation failures
are `network_error`; `login_required` needs a positive logged-out signal.
Declared-expired cookie caches are invalid local evidence, but an existing profile
is still probed because the live session may remain valid.

An empty profile directory is not `profilePresent`. The probe measures local
state before launching Playwright and requires a non-empty Chrome persistence
marker, so eager directory creation cannot turn zero state into evidence.

WeChat preserves the credential → token → IP-allowlist stages. A missing or
expired token may be renewed through the normal App ID/Secret exchange; successful
renewal appears in `healed` as `token_refreshed`. No token or secret is emitted.

## CLI

```bash
publish auth check --platform x --platform reddit --json
publish auth check --all --json
```

- Exit 0: every requested platform is `ready`.
- Exit 1: one or more platforms are not ready.
- Exit 2: invalid usage.

## Future `info` integration

`src/auth/registry.ts` exports `probeAuth()` and `probeAuthPlatforms()` as the
single reusable seam. Issue #32 must call this seam and include the returned
readiness in each `publish <channel> info` response. `info` itself should still
exit successfully when auth is not ready. The capability registry/info commands
are intentionally not implemented as part of issue #45.

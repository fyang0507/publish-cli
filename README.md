# publish-cli

A per-channel content-distribution toolkit for growing the operator's audience in the AI community. CLI binary: **`publish`**. Each channel exposes a **PUBLISH** capability and (optionally) a **WATCH** capability; a task layer composes them. **This deliverable is the X channel only.** See [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) for the full vision and roadmap, and [CLAUDE.md](./CLAUDE.md) for the high-level agent orientation.

## What it does (X channel)

- **`publish watch x`** — borrowed-reach loop. Polls search queries and watched accounts, dedupes seen posts, triages each new post with a cheap Gemini model for follow-up worthiness, and emits ranked candidates (human-readable, or `--json`).
- **`publish draft x`** — owned-content publisher. Turns a canonical base markdown into an X-ready **tweet / thread / article** and stages it as a **native draft on X**. It **never posts** — the send action is human-gated and out of scope here.

## Install

```bash
npm install
npm run build      # rm -rf dist && tsc && install skill symlinks + chmod the bin
```

### Browser engine (Playwright)

The session module drives a persistent browser. It prefers **system Google Chrome** (`channel: 'chrome'`) to avoid downloading a ~Chromium bundle onto the Google Drive repo path. If system Chrome is unavailable, install the bundled engine once as a fallback:

```bash
npx playwright install chromium
```

## Configuration

- **Secrets** live in `.env` (gitignored). Copy `.env.example` and fill in:
  - `GOOGLE_GENERATIVE_AI_API_KEY` — Gemini (triage + optional tailoring).
  - `TRIAGE_MODEL` — cheap triage model id (default `gemini-3.5-flash`).
  - `X_USERNAME` / `X_PASSWORD` / `X_EMAIL` — X credential login. No 2FA; `X_EMAIL` answers X's email/identifier confirmation challenge.
  - `PUBLISH_DATA_DIR` (optional) — runtime data dir, default `~/.publish-cli`.
- **Behavior config** lives in `watch.yaml` (copy `watch.yaml.example`): queries, accounts, per-origin limit, and the triage rubric.

### Session model

One unattended credential login (Playwright over a **persistent** profile) backs both capabilities. The watcher reads by driving the logged-in UI and capturing X's GraphQL responses (matched by operation name); the publisher drives the same browser to stage native drafts. Re-login happens only when the persisted session is invalid. Out-of-band HTTP read libraries are intentionally not used — 2026 X anti-automation blocks them.

### State lives in two homes

- **Machine-local session artifacts** — the persistent browser profile + cookie cache — live under `PUBLISH_DATA_DIR` (default `${HOME}/.publish-cli`), **never** inside this repo (it sits on Google Drive and the constant churn would thrash Drive sync).
- **Durable state** — the sqlite dedupe store — lives in the **data repo** at `<data_repo>/.publish-cli/`, so it travels with the agent workspace. The data repo resolves via `PUBLISH_DATA_REPO` → `publish.config.dev.yaml` → a `.agents/workspace.yaml` walk-up; if unresolved it falls back to `PUBLISH_DATA_DIR`. See [skills/publish/SETUP.md](./skills/publish/SETUP.md).

```
~/.publish-cli/                 # machine-local (PUBLISH_DATA_DIR)
  x-profile/                    persistent Playwright user-data-dir (logged-in X session)
  x-cookies.json                harvested auth_token + ct0 (and friends)

<data_repo>/.publish-cli/       # durable, travels with the workspace
  publish.db                    better-sqlite3 dedupe store
```

## Canonical content

The source of truth for content is caller-supplied local markdown, passed to the publisher via `--from`. The data repo that holds it is configurable (env `PUBLISH_DATA_REPO`, or a `.agents/workspace.yaml` walk-up) — see [skills/publish/SETUP.md](./skills/publish/SETUP.md) for setup specifics. Notion is the post-publish record, not the drafting surface.

## Usage

```bash
publish --help

publish watch x [--query <q>...] [--account <handle>...] [--list <id>...] [--config <watch.yaml>] [--json]
publish draft x --from <base.md> --format tweet|thread|article [--inspect]
publish reply x --to <id|url> --from <base.md> [--inspect]
```

Run any subcommand with `--help` for the authoritative flag list.

## Status

Working (X channel). The watch loop (poll → dedupe → triage → ranked candidates) and the drafting-only publisher (`draft` / `reply`, staging native X drafts) are implemented and live-verified. The publisher **never posts** — the human-gated send action is out of scope. Open work is tracked in GitHub issues.

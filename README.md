# publish-cli

A per-channel content-distribution toolkit for growing Fred's audience in the AI community. CLI binary: **`publish`**. Each channel exposes a **PUBLISH** capability and (optionally) a **WATCH** capability; a task layer composes them. **This deliverable is the X channel only.** See [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) for the full vision and roadmap.

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

One unattended credential login (Playwright over a **persistent** profile) backs both capabilities. The watcher reads via harvested cookies; the publisher drives the same logged-in browser. Re-login happens only when the persisted session is invalid.

### Runtime data lives OFF Google Drive

The browser profile, harvested cookie cache, and sqlite dedupe db all live under `PUBLISH_DATA_DIR` (default `${HOME}/.publish-cli`) — **never** inside this repo (it sits on Google Drive and the constant churn would thrash Drive sync).

```
~/.publish-cli/
  x-profile/        persistent Playwright user-data-dir (logged-in X session)
  x-cookies.json    harvested auth_token + ct0 (and friends) for the cookie reader
  publish.db        better-sqlite3 dedupe store
```

## Canonical content

The source of truth for content is local markdown under `/Users/fredy/Downloads/fred-agent/publish/<date>-<slug>/`. Notion is the post-publish record, not the drafting surface.

## Usage

```bash
publish --help

publish watch x [--query <q>...] [--account <handle>...] [--config <watch.yaml>] [--json]
publish draft x --from <base.md> --format tweet|thread|article [--long] [--dry-run] [--inspect]
```

## Status

Scaffold / skeleton. Command registration, config, session/reader interfaces, the dedupe store, and the Gemini client are in place; feature logic (login flow, fetch/triage, content generation, draft staging) is stubbed with `TODO(*-agent)` markers and throws "not implemented".

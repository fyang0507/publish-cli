# publish-cli

Per-channel content-distribution toolkit for growing the operator's AI-community audience. Binary: `publish`. **This deliverable = the X channel only** — a WATCH loop and a drafting-only PUBLISH that **never posts**.

See [AGENTS.md](./AGENTS.md) for the full working contract and [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) for the vision/roadmap. Key points:

## Working Rules

- Keep TypeScript ESM imports with `.js` extensions; `module`/`moduleResolution` are `Node16`.
- Each command file exports `register*Command(parent)` and attaches to a commander `Command` (see `src/cli.ts`).
- The publisher stops at a **native X draft** — never clicks Post. The send-gate is future scope only.
- Runtime data (browser profile, cookie cache, sqlite db) MUST live OFF Google Drive under `PUBLISH_DATA_DIR` (default `~/.publish-cli`), resolved by `dataPaths()` in `src/config.ts`. Never put the browser profile in the repo.
- One unattended Playwright credential login (`src/session.ts`) backs both watcher and publisher. The reader injects harvested cookies into `agent-twitter-client`; it does not run its own login.
- Skill frontmatter is runtime-agnostic ("agent" / "headless agent").

## Parallel-agent guardrails

- Only the scaffold agent and integration agent run `npm install`. Feature agents write `.ts` files only — no npm, no git.
- Do not delete other agents' files. Fill in `TODO(session-agent)` / `TODO(watcher-agent)` / `TODO(publisher-agent)` bodies; keep exported signatures stable.

## Current Commands

```bash
publish --help
publish watch x [--query <q>...] [--account <handle>...] [--config <watch.yaml>] [--json]
publish draft x --from <base.md> --format tweet|thread|article [--long] [--dry-run] [--inspect]
```

## Key Files

| Path | Purpose |
|---|---|
| `src/cli.ts` | Command registration (watch, draft) |
| `src/config.ts` | Env (creds, TRIAGE_MODEL), `dataPaths()`, `loadWatchConfig()` |
| `src/session.ts` | Playwright persistent-profile login; `ensureSession`/`getCookies`/`getBrowserContext` (STUB) |
| `src/gemini.ts` | `@google/genai` client: `generate()` + `triage()` |
| `src/db.ts` | `better-sqlite3` `SeenStore` (dedupe), db under the data dir |
| `src/x/reader.ts` | `AgentTwitterReader`: cookie-injected `fetchSearch`/`fetchUserTimeline` (STUB) |
| `src/commands/watch.ts` | `publish watch x` (STUB) |
| `src/commands/draft.ts` | `publish draft x` (STUB) |
| `scripts/install-agent-skill-symlinks.js` | Post-build: chmod bin + symlink `skills/publish` |
| `skills/publish/SKILL.md` | Sharable agent-facing skill doc |

## Development Checks

```bash
npm install
npm run build
node dist/cli.js --help
node dist/cli.js watch x --help
node dist/cli.js draft x --help
```

Prefer system Chrome for Playwright (`channel: 'chrome'`); fall back to `npx playwright install chromium`.

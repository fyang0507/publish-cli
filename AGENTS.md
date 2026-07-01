# publish-cli — agent & contributor guide

Per-channel content-distribution toolkit. Binary: `publish`. **This deliverable = the X channel only** (WATCH + drafting-only PUBLISH). Read [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) for the full architecture; this file is the working contract.

## Boundary

- In scope: X watch loop (poll → dedupe → cheap-LLM triage → ranked candidates) and X publisher (canonical markdown → tweet/thread/article → **native X draft**).
- Out of scope: posting/publishing (the send-gate — Discord approval → phone escalation — is FUTURE scope, documented in PRODUCT_SPEC §5, not built); other channels (Reddit, LinkedIn, 小红书, WeChat) are later phases.
- The publisher stops at "draft staged on X". It MUST NOT click Post.

## Stack & house style

Mirrors the sibling `outreach-cli`:

- TypeScript + Node **ESM** (`"type": "module"`), `module`/`moduleResolution` `Node16` — import local files with the `.js` extension.
- `commander` for the CLI; each command file exports a `register*Command(parent)` that attaches to a `Command`.
- `@google/genai` for Gemini (construct `new GoogleGenAI({ apiKey })`, drive thinking via `thinkingConfig.thinkingLevel`); env var `GOOGLE_GENERATIVE_AI_API_KEY`.
- `better-sqlite3` for the dedupe store, `yaml` for `watch.yaml`, `dotenv` for `.env`.
- `playwright` for the persistent-profile session + composer automation; `agent-twitter-client` for cookie-based reads.
- Build: `npm run build` → `rm -rf dist && tsc && node scripts/install-agent-skill-symlinks.js`. The script chmods the bin and symlinks `skills/*` into the agent's `.agents/skills/`.
- Secrets in `.env` (gitignored, `.env.example` committed); behavior in committed `*.example` yaml; skill under `skills/<name>/`. Skill frontmatter is runtime-agnostic ("agent" / "headless agent"), never naming a specific runtime.

## Session is the backbone

One UNATTENDED credential login (Playwright, **persistent** context at `dataPaths().xProfileDir`) feeds BOTH the watcher and the publisher. `src/session.ts` exposes `ensureSession()`, `getCookies()`, `getBrowserContext()`. The reader injects the harvested cookies into `agent-twitter-client` — it does NOT run its own password login. Login selectors are centralized in `X_SELECTORS`, tolerant (multi-strategy + explicit waits), and need live calibration (run headful via `--inspect`).

## Runtime data lives OFF Google Drive

This repo is on Google Drive. The browser profile, cookie cache, and sqlite db MUST live under `PUBLISH_DATA_DIR` (default `${HOME}/.publish-cli`), resolved + ensured by `src/config.ts` (`dataPaths()`). Never put the browser profile in the repo.

## File map

```
src/
  cli.ts              commander program 'publish' (registers watch + draft)
  config.ts           env (creds, TRIAGE_MODEL) + dataPaths() + loadWatchConfig()
  session.ts          Playwright persistent-profile login; ensureSession/getCookies/getBrowserContext  [STUB]
  gemini.ts           @google/genai client: generate() + triage()
  db.ts               better-sqlite3 SeenStore (dedupe), db file under data dir
  x/reader.ts         AgentTwitterReader: cookie-injected fetchSearch/fetchUserTimeline  [STUB]
  commands/
    watch.ts          'publish watch x'  [STUB → watcher-agent]
    draft.ts          'publish draft x'  [STUB → publisher-agent]
scripts/install-agent-skill-symlinks.js   post-build: chmod bin + symlink skills/publish
skills/publish/SKILL.md
watch.yaml.example    queries / accounts / per_origin_limit / triage rubric
```

## Guardrails for parallel agents

- **Only the scaffold agent and the integration agent run `npm install`.** Feature agents write `.ts` files only — no `npm`, no `git`.
- Do not delete other agents' files. Build on the existing scaffold; don't clobber working files.
- Feature work is marked with `TODO(session-agent)`, `TODO(watcher-agent)`, `TODO(publisher-agent)`. Fill in the bodies; keep the exported signatures stable so siblings keep type-checking.

## Canonical content

Source of truth = caller-supplied local markdown, passed via `--from`. The data repo that holds it is configurable (env `PUBLISH_DATA_REPO`, or a `.agents/workspace.yaml` walk-up) — never a hardcoded personal path; see `skills/publish/SETUP.md` for setup specifics. The publisher reads `--from` and writes artifacts back into the same folder (or `--out`). Notion is the post-publish record only.

# publish-cli

Per-channel content-distribution toolkit for growing the operator's AI-community audience. Binary: `publish`. **This deliverable = the X channel only** — a WATCH loop (borrowed-reach) and a drafting-only PUBLISH (owned-content).

Companion docs: [README.md](./README.md) (usage), [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) (vision/roadmap), [skills/publish/SETUP.md](./skills/publish/SETUP.md) (setup) and [skills/publish/SKILL.md](./skills/publish/SKILL.md) (agent-facing capability layer).

## Hard boundary

The publisher stops at a **native draft staged on X**. It MUST NOT click Post / publish. The human-gated send action (Discord approval → phone escalation) is **future scope, not built here**. Any change that could auto-send is out of bounds.

## What it is

The CLI is **channel-first**: `publish <channel> <action>` (each channel has its own action space; X is the only channel today).

- `publish x create-watch-list` — build/populate the account-watch List from who you follow → prints the id for `watch --x-list`. Never posts (writes List membership only).
- `publish x watch` — poll queries / Lists → dedupe → cheap-LLM triage (Gemini, low reasoning effort) → ranked reply candidates. Accounts are watched via a List (`--x-list`), never one-by-one. The `x-list` spelling is unified across `watch` and `create-watch-list`.
- `publish x draft` — canonical markdown → tweet / thread / article → **native X draft**.
- `publish x reply --to <id|url> --from <md>` — stage a native reply draft (overflow → thread); never posts.

## Stack

TypeScript + Node **ESM** (`"type": "module"`, `module`/`moduleResolution` = `Node16`) — **import local files with the `.js` extension**. `commander` CLI (each command file exports a `register*Command(parent)`). `@google/genai` (Gemini triage/tailoring), `better-sqlite3` (dedupe store), `playwright` (browser), `yaml` (`watch.yaml`), `dotenv` (`.env`).

## X access = one browser, both directions

A single Playwright **persistent-profile** browser (one unattended credential login, `src/session.ts`) backs BOTH reads and writes:

- **Reads** = browser **GraphQL response capture** — drive the logged-in UI and capture `/graphql/` responses, matched by **operation NAME** (`SearchTimeline`, `ListLatestTweetsTimeline`); query-id hashes drift, names don't. (Per-account timelines aren't read — accounts are watched via a List.)
- **Writes** = composer automation (tweet/thread/article/reply drafts).
- **Do not reintroduce out-of-band HTTP read libs** (`agent-twitter-client`, `twikit`). 2026 X's anti-automation (`x-client-transaction-id`) blocks them; the browser path is the deliberate, verified choice.
- X blocks **headless login** — first login must be headful (`--inspect`). Login/composer selectors need occasional live re-calibration.

## State lives in two homes

- **Machine-local** — persistent browser profile + harvested cookie cache — under `PUBLISH_DATA_DIR` (default `~/.publish-cli`). **MUST stay off any cloud-synced path and out of the repo.**
- **Durable** — the SQLite dedupe store — in the **data repo** at `<data_repo>/.publish-cli/`, so it travels with the agent workspace. The agent-skill symlink also targets `<data_repo>/.agents/skills/`.
- **Data-repo resolution** (`src/dataRepo.ts`): `PUBLISH_DATA_REPO` env → `publish.config.dev.yaml` (`data_repo_path`) → walk up for `.agents/workspace.yaml`. If unresolved, the dedupe DB falls back to `PUBLISH_DATA_DIR` and the symlink step is skipped. **Never hardcode a personal path.**
- **This repo sits on Google Drive** — churny runtime data off-repo is a correctness requirement, not a preference.

Dedupe policy: **seen ⇒ never resurface** (by design). Reply writes get their own idempotency guarantee: a **reply ledger** (`ReplyLedger`, `src/db.ts`, same sqlite file, separate `reply_ledger` table) keyed on the target tweet id. `publish x reply` refuses to re-stage a reply to a tweet already in the ledger (records only after a successful stage) unless `--force`. Read-dedup (SeenStore) and write-dedup (ReplyLedger) are deliberately decoupled — different risk tiers.

## Public-repo posture

This repo is intended to go public and is the **capability layer** only. Keep it generic: refer to "the operator," never a personal name; skill frontmatter stays runtime-agnostic ("agent" / "headless agent"). Editorial judgment, personas, and execution protocol belong to the consuming agent workspace, **not here**.

## Canonical content

Source of truth = caller-supplied local markdown via `--from`; artifacts write back to that folder (or `--out`).

## File map

| Path | Purpose |
|---|---|
| `src/cli.ts` | `publish` program; registers `watch` / `draft` / `reply` |
| `src/config.ts` | env (creds, `TRIAGE_MODEL`), `dataPaths()`, `loadWatchConfig()` |
| `src/dataRepo.ts` | `resolveDataRepo()` — env → dev config → workspace walk-up |
| `src/session.ts` | Playwright persistent-profile login; `ensureSession`/`getCookies`/`getBrowserContext` |
| `src/gemini.ts` | `@google/genai` client: `generate()` + `triage()` |
| `src/db.ts` | `better-sqlite3` `SeenStore` (dedupe), db in the data repo |
| `src/x/reader.ts` | `BrowserReader` — GraphQL response capture (search / list timelines) |
| `src/x/triage.ts` | cheap-LLM triage → ranked candidates |
| `src/x/content.ts` | canonical-markdown parser → tweet / thread / article blocks |
| `src/x/draftPoster.ts` | composer automation: stage native tweet/thread/article/reply drafts |
| `src/commands/{create-watch-list,watch,draft,reply}.ts` | command bodies |
| `scripts/install-agent-skill-symlinks.js` | post-build: chmod bin + symlink skill into `<data_repo>/.agents/skills` |
| `skills/publish/` | agent-facing capability layer (SKILL.md router + SETUP.md + calibration.md) |

## Build & checks

```bash
npm install
npm run build      # rm -rf dist && tsc && install-agent-skill-symlinks.js (chmod bin + symlink skill into <data_repo>/.agents/skills)
node dist/cli.js --help
```

Playwright prefers system Google Chrome (`channel: 'chrome'`); fall back to `npx playwright install chromium`. Secrets in `.env` (gitignored; `.env.example` committed); behavior in `watch.yaml` (commit `watch.yaml.example`).

## Verify live

Compile-green + code review has repeatedly missed real bugs in the browser flows. **Verify browser reads/drafts against live X** (headful `--inspect`) before claiming a flow works.

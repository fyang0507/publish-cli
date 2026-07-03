# publish-cli

Per-channel content-distribution toolkit for growing the operator's AI-community audience. Binary: `publish`. **Channels built today: X** (a WATCH loop for borrowed-reach + a drafting-only PUBLISH for owned-content), **LinkedIn** (drafting-only PUBLISH) **and Reddit** (drafting-only PUBLISH — self-posts). Every PUBLISH path is **draft-only — it never posts**.

Companion docs: [README.md](./README.md) (usage), [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) (vision/roadmap), [skills/publish/SETUP.md](./skills/publish/SETUP.md) (setup) and [skills/publish/SKILL.md](./skills/publish/SKILL.md) (agent-facing capability layer).

## Hard boundary

Every publisher stops at a **native draft staged on the platform** (X Unsent, LinkedIn "Save as draft"). It MUST NOT click Post / publish. The human-gated send action (Discord approval → phone escalation) is **future scope, not built here**. Any change that could auto-send is out of bounds.

## What it is

The CLI is **channel-first**: `publish <channel> <action>` (each channel has its own action space). Three channels today: `x`, `linkedin`, and `reddit`.

- `publish x create-watch-list` — build/populate the account-watch List from who you follow → prints the id for `watch --x-list`. Never posts (writes List membership only).
- `publish x watch` — poll queries / Lists → dedupe → cheap-LLM triage (Gemini, low reasoning effort) → ranked reply candidates. Accounts are watched via a List (`--x-list`), never one-by-one. The `x-list` spelling is unified across `watch` and `create-watch-list`.
- `publish x draft` — canonical markdown (`--from`) or inline `--text` → tweet / thread / article → **native X draft**.
- `publish x reply --to <id|url> (--text <s> | --from <md>)` — stage a native reply draft (overflow → thread); never posts.
- `publish linkedin draft (--text <s> | --from <md>)` — inline text (primary) or markdown → a single LinkedIn **post** (3000-char cap, deterministic markdown→plain-text, emoji passthrough, optional `--media`) → **native LinkedIn draft** via "Save as draft"; never posts. LinkedIn has no WATCH capability today (PUBLISH only).
- `publish reddit inspect <sub>...` / `publish reddit search "<query>"` — read-only discovery: `inspect` reports each named subreddit's posting contract (subscribers, allowed types, rules, flairs, post requirements); `search` lists candidate subreddits. Facts only, no LLM ranking — the agent judges.
- `publish reddit draft --subreddit <name> --title <t> (--text <s> | --from <md>) [--flair <id|text>]` — canonical markdown (kept ~verbatim; Reddit renders Markdown) → a single **self-post** → **native Reddit draft** via "Save Draft"; never posts. Enforces the target subreddit's contract before staging. Reddit has no WATCH capability today (PUBLISH only).

Short posts/replies take inline `--text`; `--from` (with `-` = stdin) is for longer, file-based canonical markdown. Both resolve through the shared `src/commands/contentInput.ts` (exactly-one-of validation).

## Stack

TypeScript + Node **ESM** (`"type": "module"`, `module`/`moduleResolution` = `Node16`) — **import local files with the `.js` extension**. `commander` CLI (each command file exports a `register*Command(parent)`). `@google/genai` (Gemini triage/tailoring), `better-sqlite3` (dedupe store), `playwright` (browser), `yaml` (`watch.yaml`), `dotenv` (`.env`).

## X access = one browser, both directions

A single Playwright **persistent-profile** browser (one unattended credential login, `src/session.ts`) backs BOTH reads and writes:

- **Reads** = browser **GraphQL response capture** — drive the logged-in UI and capture `/graphql/` responses, matched by **operation NAME** (`SearchTimeline`, `ListLatestTweetsTimeline`); query-id hashes drift, names don't. (Per-account timelines aren't read — accounts are watched via a List.)
- **Writes** = composer automation (tweet/thread/article/reply drafts).
- **Do not reintroduce out-of-band HTTP read libs** (`agent-twitter-client`, `twikit`). 2026 X's anti-automation (`x-client-transaction-id`) blocks them; the browser path is the deliberate, verified choice.
- X blocks **headless login** — first login must be headful (`--inspect`). Login/composer selectors need occasional live re-calibration.

## LinkedIn reuses the browser-driven pattern (its own profile)

LinkedIn is a browser-driven PUBLISH channel that mirrors X's persistent-profile model with a **separate** session (`src/linkedin/session.ts`, profile `<PUBLISH_DATA_DIR>/li-profile`, creds `LI_USERNAME`/`LI_PASSWORD`/`LI_EMAIL`) — one unattended credential login, headful `--inspect` for first login / calibration. It does **not** share X's `src/session.ts`; the design-doc `createBrowserSession` factory lift is deferred to protect the shipped X code.

- **Reuse by import, not by editing X:** `src/linkedin/*` imports the channel-agnostic helpers (`parseBaseMarkdown`/`countChars` from `src/x/content.ts`; `tolerantLocator`/`optionalLocator`/`typeText` from `src/x/draftPoster.ts`; `resolveContentInput` from `src/commands/contentInput.ts`). Do NOT relocate/rewrite X's browser modules for LinkedIn's sake.
- **Composer facts (calibrated live 2026-07, drift-prone):** open via `feed/?shareActive=true` (`/sharing/compose` 404s as a direct URL); editor is TipTap `div.ProseMirror[contenteditable]`; LinkedIn **auto-restores the last draft into the composer**, so the poster select-all-clears before typing; save = close (`aria-label="Dismiss"`) → text button **"Save as draft"** (never the sibling "Discard" or "Post" — both are documented FORBIDDEN selectors no code path clicks).

## Reddit reuses the browser-driven pattern (its own profile)

Reddit is a browser-driven PUBLISH channel that mirrors the X/LinkedIn persistent-profile model with a **separate** session (`src/reddit/session.ts`, profile `<PUBLISH_DATA_DIR>/reddit-profile`, cache `reddit-cookies.json`, creds `REDDIT_USERNAME`/`REDDIT_PASSWORD`(/`REDDIT_EMAIL`)) — one unattended credential login, headful `--inspect` for first login / calibration (Reddit login is **captcha-heavy**). It reuses by import (`parseBaseMarkdown`/`countChars` from `src/x/content.ts`; `tolerantLocator`/`optionalLocator`/`typeText` from `src/x/draftPoster.ts`; `resolveContentInput`), never by editing X. Composer save = **"Save Draft"** (never "Post" — a documented FORBIDDEN selector). The poster **attempts** to switch the composer to Markdown mode so the body renders as Markdown, but Reddit's new `<shreddit-composer>` hydrates that toggle **unreliably** (calibrated live 2026-07-03): when it can't engage, the body is entered in the rich editor (markdown syntax renders literally) and `stageDraft` emits an advisory telling the operator to flip "… → Switch to Markdown" in the draft before posting. Since every draft is human-reviewed pre-post, this is a surfaced-limitation, not a silent failure.

## State lives in two homes

- **Machine-local** — the persistent browser profiles + harvested cookie caches (per channel: `x-profile`/`x-cookies.json`, `li-profile`/`li-cookies.json`, `reddit-profile`/`reddit-cookies.json`) — under `PUBLISH_DATA_DIR` (default `~/.publish-cli`). **MUST stay off any cloud-synced path and out of the repo.**
- **Durable** — the SQLite dedupe store — in the **data repo** at `<data_repo>/.publish-cli/`, so it travels with the agent workspace. The agent-skill symlink also targets `<data_repo>/.agents/skills/`.
- **Data-repo resolution** (`src/dataRepo.ts`): `PUBLISH_DATA_REPO` env → `publish.config.dev.yaml` (`data_repo_path`) → walk up for `.agents/workspace.yaml`. If unresolved, the dedupe DB falls back to `PUBLISH_DATA_DIR` and the symlink step is skipped. **Never hardcode a personal path.**
- **This repo sits on Google Drive** — churny runtime data off-repo is a correctness requirement, not a preference.

Dedupe policy: **seen ⇒ never resurface** (by design). Reply writes get their own idempotency guarantee: a **reply ledger** (`ReplyLedger`, `src/db.ts`, same sqlite file, separate `reply_ledger` table) keyed on the target tweet id. `publish x reply` refuses to re-stage a reply to a tweet already in the ledger (records only after a successful stage) unless `--force`. Read-dedup (SeenStore) and write-dedup (ReplyLedger) are deliberately decoupled — different risk tiers.

## Public-repo posture

This repo is intended to go public and is the **capability layer** only. Keep it generic: refer to "the operator," never a personal name; skill frontmatter stays runtime-agnostic ("agent" / "headless agent"). Editorial judgment, personas, and execution protocol belong to the consuming agent workspace, **not here**.

## Canonical content

Source of truth = caller-supplied local markdown via `--from` (or inline `--text`; `--from -` = stdin); artifacts write back to that folder (or `--out`).

## File map

| Path | Purpose |
|---|---|
| `src/cli.ts` | `publish` program; registers the `x` group (`create-watch-list` / `watch` / `draft` / `reply`), the `linkedin` group (`draft`) and the `reddit` group (`inspect` / `search` / `draft`) |
| `src/config.ts` | env (X + LinkedIn + Reddit creds, `TRIAGE_MODEL`), `dataPaths()` (x-/li-/reddit-profile + cookie caches), `loadWatchConfig()` |
| `src/dataRepo.ts` | `resolveDataRepo()` — env → dev config → workspace walk-up |
| `src/session.ts` | X Playwright persistent-profile login; `ensureSession`/`getCookies`/`getBrowserContext` |
| `src/gemini.ts` | `@google/genai` client: `generate()` + `triage()` |
| `src/db.ts` | `better-sqlite3` `SeenStore` (dedupe), db in the data repo |
| `src/x/reader.ts` | `BrowserReader` — GraphQL response capture (search / list timelines) |
| `src/x/triage.ts` | cheap-LLM triage → ranked candidates |
| `src/x/content.ts` | canonical-markdown parser → tweet / thread / article blocks (shared by LinkedIn) |
| `src/x/draftPoster.ts` | composer automation: stage native tweet/thread/article/reply drafts (exports shared locator/typing primitives) |
| `src/linkedin/session.ts` | LinkedIn persistent-profile login (structural sibling of `src/session.ts`) |
| `src/linkedin/content.ts` | `generatePost` — deterministic markdown → LinkedIn plain-text post (3000-char cap, hook/link advisories) |
| `src/linkedin/draftPoster.ts` | LinkedIn composer automation: stage a native post draft via "Save as draft" (never posts) |
| `src/reddit/session.ts` | Reddit persistent-profile login (structural sibling of `src/session.ts`); `ensureSession`/`getBrowserContext`/`getCookies`/`closeSession` |
| `src/reddit/reader.ts` | authenticated JSON reads for `inspect` / `search` / draft preflight (`about` / `about/rules` / `link_flair_v2` / `subreddits/search`) + `post_requirements` response capture |
| `src/reddit/content.ts` | `generateSelfPost` — canonical markdown → title + Markdown body (kept ~verbatim), caps, old-reddit/link advisories (reuses `src/x/content.ts`) |
| `src/reddit/draftPoster.ts` | Reddit composer automation: stage a native self-post draft via "Save Draft" (never posts) |
| `src/commands/contentInput.ts` | shared `--text` / `--from` / stdin resolution (exactly-one-of) for `draft` / `reply` / `linkedin draft` / `reddit draft` |
| `src/commands/{create-watch-list,watch,draft,reply,linkedin-draft}.ts` | command bodies |
| `src/commands/reddit-{inspect,search,draft}.ts` | Reddit command bodies |
| `scripts/install-agent-skill-symlinks.js` | post-build: chmod bin + symlink skill into `<data_repo>/.agents/skills` |
| `skills/publish/` | agent-facing capability layer, shipped as a whole dir (SKILL.md router + SETUP.md + calibration.md + PLATFORM_CAPABILITIES.md). Symlinked into other workspaces, so intra-skill links MUST be `./`-relative — never escape the folder (e.g. `../../docs/…`). |

## Build & checks

```bash
npm install
npm run build      # rm -rf dist && tsc && install-agent-skill-symlinks.js (chmod bin + symlink skill into <data_repo>/.agents/skills)
node dist/cli.js --help
```

Playwright prefers system Google Chrome (`channel: 'chrome'`); fall back to `npx playwright install chromium`. Secrets in `.env` (gitignored; `.env.example` committed); behavior in `watch.yaml` (commit `watch.yaml.example`).

## Verify live

Compile-green + code review has repeatedly missed real bugs in the browser flows. **Verify browser reads/drafts against the live platform** (X or LinkedIn, headful `--inspect`) before claiming a flow works. The LinkedIn channel was calibrated this way (2026-07) — its login/composer selectors, like X's, drift and need occasional live re-calibration.

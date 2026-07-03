# publish-cli setup

One-time setup for the `publish` CLI. See [SKILL.md](./SKILL.md) for usage.

## Install / build

```bash
npm install
npm run build     # compiles to dist/ and symlinks the `publish` skill into the agent's skills dir
```

- Run as `node dist/cli.js <command>` (or the `publish` bin if linked).
- The build symlinks `skills/publish/` into an agent skills directory. Override the
  target with the `PUBLISH_SKILLS_DIR` env var.

## Credentials — `.env`

Copy `.env.example` → `.env` (gitignored) and set:

- `GOOGLE_GENERATIVE_AI_API_KEY` — cheap-LLM triage for `watch` (Gemini).
- `X_USERNAME`, `X_PASSWORD`, `X_EMAIL` — unattended credential login. The login
  answers X's "confirm your email/phone" interstitial with `X_EMAIL`. **No 2FA is
  supported** — the account must not require a second factor at login.
- `LI_USERNAME`, `LI_PASSWORD`, `LI_EMAIL` — LinkedIn credential login (same
  persistent-profile model as X; `LI_EMAIL` answers LinkedIn's identifier
  checkpoint). **Only needed for `publish linkedin draft`.** No 2FA/CAPTCHA is
  automated — if LinkedIn raises one, complete it in the headful `--inspect` window.
- `REDDIT_USERNAME`, `REDDIT_PASSWORD` (and `REDDIT_EMAIL` if the login challenge
  needs it) — Reddit credential login (same persistent-profile model as X). **Only
  needed for the `reddit` channel** (`inspect` / `search` / `draft`). Reddit login
  is **captcha-heavy** and no CAPTCHA/2FA is automated — run the first login headful
  (`--inspect`) and solve any challenge in that window.
- `TRIAGE_MODEL` (optional) — cheap model id; default `gemini-3.5-flash`.

## Watch config — `watch.yaml`

Copy `watch.yaml.example` → `watch.yaml` and set `queries`, `lists`,
`per_origin_limit`, and the triage block (`persona`, `min_score`, `batch_size`).
The file is schema-validated on load — unknown keys / wrong types fail loudly
before the browser opens, with **migration hints** for removed keys (e.g. a stale
`accounts:` points you to build a List). CLI flags (`--query`, `--x-list`,
`--persona`) ADD to / supply values over this file. (Accounts are watched via a
`List` built with `publish x create-watch-list`, not a per-account origin.)

- **Validate cheaply, no browser:** `publish x watch --validate-config` parses the
  config + merged flags, prints the resolved settings, and exits before any read —
  the safe pre-flight for a scheduled job or after editing `watch.yaml`.
- **Triage rubric ships blank** — supply it per run with `--persona <text>` or
  `--persona-from <file>`. It **must be self-contained**: the classifier sees only
  the rubric + each candidate post, never the source essay/brief/context. Keep long
  rubrics in a file and use `--persona-from` (avoids shell-quoting breakage).
- **Output shape:** `--format text` (default) | `json` | `markdown` (a reviewable
  digest); `--json` aliases `--format json`; `--out <file>` writes to a file.

## Where state lives (two homes)

- **Machine-local session artifacts** — the persistent browser profile + cookie
  cache — live under `PUBLISH_DATA_DIR` (default `~/.publish-cli`). Keep this OFF
  any cloud-synced path and out of the repo.
- **Durable state** — the SQLite dedupe store — lives in the **data repo** (the
  agent workspace) at `<data_repo>/.publish-cli/`, so it travels with the
  workspace. The **agent-skill symlink** also targets `<data_repo>/.agents/skills/`.

**Data-repo resolution** (see `src/dataRepo.ts`), in order:
1. `PUBLISH_DATA_REPO` env var.
2. `publish.config.dev.yaml` next to the CLI, with `data_repo_path:` (copy from
   `publish.config.dev.yaml.example`). This is what lets `npm run build` install
   the skill symlink, since the build's cwd is the CLI repo, not the workspace.
3. Walk up from the current directory for `.agents/workspace.yaml`.

If none resolves, the dedupe DB falls back to `PUBLISH_DATA_DIR` and the skill
symlink step is skipped (the build still succeeds). `PUBLISH_SKILLS_DIR` can
override the symlink target directly.

## First login (headful)

The browser paths (`watch`, `draft`, `reply`, `linkedin draft`, and the `reddit`
commands) auto-log-in on first use into a persistent profile, then reuse it.
**X blocks headless login**, so run the first login with `--inspect` (headful):

```bash
node dist/cli.js x watch --query "some topic" --inspect        # X profile
node dist/cli.js linkedin draft --text "hello 👋" --inspect    # LinkedIn profile
node dist/cli.js reddit inspect AskReddit --inspect            # Reddit profile
```

Each channel has its own profile, so log in to each once. LinkedIn may raise a
security checkpoint (CAPTCHA / "verify it's you") on the first automated login —
complete it in the headful window. **Reddit login is captcha-heavy** — expect a
manual challenge solve on the first headful login. Watch the login complete; the
warm profile persists for subsequent (including headless) runs. If a step stalls,
see [calibration.md](./calibration.md).

## Browser

Uses Playwright, preferring an installed Google Chrome (`channel: 'chrome'`) to
avoid a Chromium download; falls back to bundled Chromium
(`npx playwright install chromium`).

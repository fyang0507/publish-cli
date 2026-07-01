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
- `TRIAGE_MODEL` (optional) — cheap model id; default `gemini-3.5-flash`.

## Watch config — `watch.yaml`

Copy `watch.yaml.example` → `watch.yaml` and set `queries`, `accounts`, `lists`,
`per_origin_limit`, and the triage rubric (`persona`, `dimensions`, `min_score`,
`batch_size`). CLI flags (`--query`, `--account`, `--list`, `--persona`, …) merge
with / override this file.

## Runtime data — off-repo

`PUBLISH_DATA_DIR` (default `~/.publish-cli`) holds the **persistent browser
profile**, the cookie cache, and the SQLite dedupe store. Keep it OFF any synced
drive, and never place the browser profile inside the repo.

## First login (headful)

The browser paths (`watch`, `draft`, `reply`) auto-log-in on first use into a
persistent profile, then reuse it. **X blocks headless login**, so run the first
login with `--inspect` (headful):

```bash
node dist/cli.js watch x --query "some topic" --inspect
```

Watch the login complete; the warm profile persists for subsequent (including
headless) runs. If a step stalls, see [calibration.md](./calibration.md).

## Browser

Uses Playwright, preferring an installed Google Chrome (`channel: 'chrome'`) to
avoid a Chromium download; falls back to bundled Chromium
(`npx playwright install chromium`).

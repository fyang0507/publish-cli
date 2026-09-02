# publish-cli

A per-channel content-distribution toolkit for growing the operator's audience in the AI community. CLI binary: **`publish`**. X, LinkedIn, Reddit, and WeChat provide draft-only transports; Xiaohongshu is executed by an agent-owned browser and 1point3acres by a human handoff, both guided by the CLI's offline `info` oracle. Every PUBLISH path is **draft-only and never posts.** WeChat is the **first API-driven channel** (X / LinkedIn / Reddit are browser-driven; WeChat talks to the Official Account API directly). See [PRODUCT_SPEC.md](./docs/PRODUCT_SPEC.md) for the full vision and roadmap, and [AGENTS.md](./AGENTS.md) for the high-level agent orientation.

## Discover channel capabilities

Run `publish <channel> info` (or `--json`) before channel work. It returns every
configured format at once as three human-editable Markdown sections: the CLI
boundary, authentication method, and platform specification/gotchas. Static
`info` is kept separate from side-effect-bounded `readiness` in the versioned
JSON envelope. Browser probes are passive;
WeChat may perform its normal token exchange and report `token_refreshed`.
Missing auth and probe failures remain exit 0
so static limits and recovery steps are always available. The Markdown files in
[`capabilities/`](./capabilities/) are the runtime source and can be coedited
without changing TypeScript. There is no `--format`.

```bash
publish x info --json
publish linkedin info
publish reddit info --json
publish wechat info --json
publish xhs info --json
publish 1point3acres info --json
```

## What it does (X channel)

- **`publish x watch`** — borrowed-reach loop. Polls search queries and watch Lists (accounts are watched via a List, not one-by-one), dedupes seen posts, triages each new post with a cheap Gemini model for follow-up worthiness, and emits ranked candidates (human-readable, or `--json`).
- **`publish x create-watch-list`** — builds the account-watch List from the accounts you follow (a List reads all its members in one fetch, so it's the scalable account path). Precursor to `watch --x-list`.
- **`publish x draft`** — owned-content publisher. Turns a canonical base markdown into an X-ready **tweet / thread / article** and stages it as a **native draft on X**. It **never posts** — the send action is human-gated and out of scope here.
- **`publish x history`** — read-only. Reads your OWN published posts + replies from X (live, filtering out reposts and others' quoted tweets) so an agent can see what it has already put out and avoid repeating itself across a multi-day campaign. Emits text / `--json` / markdown.

## What it does (LinkedIn channel)

- **`publish linkedin draft`** — owned-content publisher. Turns inline text (`--text`, the primary path) or a markdown file (`--from`) into a single LinkedIn **post** (3,000 UTF-16-code-unit cap, deterministic markdown→plain-text, emoji passthrough, optional `--media`) and stages it as a **native draft on LinkedIn** via "Save as draft". Same boundary as X — it **never posts**. Surfaces an above-the-fold hook advisory and a first-comment-link advisory; opt-in `--bold` maps `**emphasis**` to Unicode bold (accessibility caveat). Selectors are best-effort — calibrate live with `--inspect`.

## What it does (Reddit channel)

Reddit self-posts are **contract-gated**: each subreddit imposes its own rules (mandatory flair, title regex, allowed post types), so publishing is a two-phase flow — discover the contract, then draft against it. Discovery is **facts only, no LLM ranking** (the agent judges where to post).

- **`publish reddit inspect <sub>...`** / **`publish reddit search "<query>"`** — read-only discovery. `inspect` reports each named subreddit's full posting contract (subscribers, `submission_type`, rules, flair templates, post requirements) with a one-line verdict; `search` lists candidate subreddits for a topic (`--limit`, `--include-nsfw`). Both take `--json` for machine output. Reads are **login-free** and default to a headless browser; on networks where Reddit 403-blocks the headless fingerprint they **auto-retry headful once** (an advisory notes the switch, and headful needs a display but no human). Set `REDDIT_READS_HEADFUL=1` to start reads headful and skip the doomed first attempt; leave it unset on headless-server / good-fingerprint hosts.
- **`publish reddit draft`** — owned-content publisher. Turns inline text (`--text`) or a markdown file (`--from`) into a single **self-post** for one subreddit (`--subreddit`, `--title`, optional `--flair`/`--nsfw`/`--spoiler`) and stages it as a **native draft on Reddit** via "Save Draft". Because Reddit renders Markdown natively, the body is kept ~verbatim (typed in Markdown mode) rather than flattened. Preflights the target subreddit's contract before staging and **never posts**. `--subreddit`/`--title`/`--flair` may also come from `--from` frontmatter.

## What it does (WeChat channel)

WeChat Official Account (微信公众号) is the **first API-driven channel** — no browser profile, no Playwright. Auth is an `app_id`/`app_secret` → cached-stable-token loop, and every API call is **gated by source IP**, so the toolkit routes through one fixed egress IP (allowlisted once) to stay zero-touch on a traveling / VPN laptop.

- **`publish wechat check`** — read-only preflight. Verifies the configured credentials, mints an access token, and confirms the egress IP the API actually sees is on the account's allowlist (travel-aware — it reports the IP the WeChat servers observe, not the laptop's local one). Stages nothing; `--json` for machine output.
- **`publish wechat draft`** — owned-content publisher. Turns a canonical base markdown (`--from`, the primary path) or inline text (`--text`) into a single **article** (文章 / `article_type=news`) and stages it as a **native draft in the account's 草稿箱 (draft box)** via the `draft/add` endpoint. Same boundary as every other channel — it **never publishes**. A permanent-material **cover image is required**. WeChat documents title/author/digest limits as 32/16/120 字 but does not define the Unicode measurement, so those boundaries remain server-authoritative; when digest is omitted, WeChat derives the first 54 字. The body renders to **inline-styled HTML**. External links default to bottom citations; local body images are uploaded to WeChat's CDN. `--dry-run` renders + validates with no network calls.

The never-publishes boundary here is **structural, not a guard-rail**: saving a draft (`draft/add`) and publishing (`freepublish/*`) are different API endpoints. Only `draft/add` is ever called; `freepublish/*` and `message/mass/*` (mass-send) are never invoked.

See [docs/WECHAT_DESIGN.md](./docs/WECHAT_DESIGN.md) for the full design and the operator runbook (fixed-egress-IP setup, token cache, rendering pipeline).

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
  - `LI_USERNAME` / `LI_PASSWORD` / `LI_EMAIL` — LinkedIn credential login (same persistent-profile model as X); `LI_EMAIL` answers LinkedIn's identifier confirmation checkpoint. Only needed for `publish linkedin draft`.
  - `REDDIT_USERNAME` / `REDDIT_PASSWORD` (/ `REDDIT_EMAIL` if the login challenge needs it) — Reddit credential login (same persistent-profile model as X). Only needed for the `reddit` channel. Reddit login is captcha-heavy — complete any challenge in the headful `--inspect` window on first login.
  - `REDDIT_READS_HEADFUL` (optional) — set to `1` to start `reddit inspect` / `search` in a headful browser (skips the doomed headless attempt on hosts where Reddit 403-blocks the headless fingerprint). Reads are login-free, so this needs a display but no human. Leave unset on headless-server / good-fingerprint hosts; reads auto-retry headful once on a block regardless. Distinct from the one-time first login, which still requires headful `--inspect` (captcha). Draft staging still runs headless.
  - `WECHAT_APP_ID` / `WECHAT_APP_SECRET` — Official Account (公众号) API credentials. Only needed for the `wechat` channel.
  - `WECHAT_AUTHOR` — fallback article author when `--author` / frontmatter is absent.
  - `WECHAT_PROXY_URL` **or** `WECHAT_SSH_TUNNEL` — fixed-egress-IP mode. WeChat gates all API calls by source IP, so the toolkit routes traffic through one stable egress IP that is allowlisted once; a traveling / VPN laptop then stays zero-touch. See [docs/WECHAT_DESIGN.md](./docs/WECHAT_DESIGN.md) for the setup.
  - `WECHAT_NEED_OPEN_COMMENT` (optional, default `1`) / `WECHAT_ONLY_FANS_CAN_COMMENT` (optional, default `0`) — draft comment settings passed to `draft/add`.
  - WeChat has **no browser profile** — auth is an `app_id`/`app_secret` → cached-stable-token loop, and the token cache lives at `<PUBLISH_DATA_DIR>/wechat-token.json` (machine-local, off Drive).
  - `PUBLISH_DATA_DIR` (optional) — runtime data dir, default `~/.publish-cli`.
- **Behavior config** lives in `watch.yaml` (copy `watch.yaml.example`): queries, watch Lists, per-origin limit, an optional language allow-list, and the triage rubric. The triage rubric (`triage.persona`, or `--persona` / `--persona-from <file>`) **must be self-contained** — the classifier sees only the rubric plus each candidate post, never the source essay, campaign brief, or surrounding agent context, so spell out the actual selection criteria inline. Validate a config cheaply (no browser) with `publish x watch --validate-config`.
- **Language filter** — set `allowed_languages: [en, zh]` in `watch.yaml` (or `--languages en,zh`) to restrict candidates by language. Posts known to be outside the list are dropped **before** triage so they don't burn classifier tokens; untagged posts are kept. Empty = no filter; `--languages all` disables a configured one. The dropped count is reported in every output format (`languageFiltered` in JSON).

### Session model

One unattended credential login (Playwright over a **persistent** profile) backs both capabilities. The watcher reads by driving the logged-in UI and capturing X's GraphQL responses (matched by operation name); the publisher drives the same browser to stage native drafts. Re-login happens only when the persisted session is invalid. Out-of-band HTTP read libraries are intentionally not used — 2026 X anti-automation blocks them.

### State lives in two homes

- **Machine-local session artifacts** — the persistent browser profile + cookie cache — live under `PUBLISH_DATA_DIR` (default `${HOME}/.publish-cli`), **never** inside this repo (it sits on Google Drive and the constant churn would thrash Drive sync).
- **Durable state** — the sqlite dedupe store — lives in the **data repo** at `<data_repo>/.publish-cli/`, so it travels with the agent workspace. The data repo resolves via `PUBLISH_DATA_REPO` → `publish.config.dev.yaml` → a `.agents/workspace.yaml` walk-up; if unresolved it falls back to `PUBLISH_DATA_DIR`. See [skills/publish/references/setup.md](./skills/publish/references/setup.md).

```
~/.publish-cli/                 # machine-local (PUBLISH_DATA_DIR)
  x-profile/                    persistent Playwright user-data-dir (logged-in X session)
  x-cookies.json                harvested auth_token + ct0 (and friends)

<data_repo>/.publish-cli/       # durable, travels with the workspace
  publish.db                    better-sqlite3 dedupe store
```

## Canonical content

The source of truth for content is caller-supplied local markdown, passed to the publisher via `--from` (or, for short tweets/replies, inline via `--text` — no scratch file; `--from -` reads stdin). The data repo that holds it is configurable (env `PUBLISH_DATA_REPO`, or a `.agents/workspace.yaml` walk-up) — see [skills/publish/references/setup.md](./skills/publish/references/setup.md) for setup specifics. Notion is the post-publish record, not the drafting surface.

## Usage

```bash
publish --help

publish auth check --platform x,linkedin,reddit [--json]
publish auth check --platform wechat,xhs [--json]

publish x create-watch-list [--from-following] [--handle <h>] [--name <n>] [--x-list <id>] [--private|--public] [--dry-run] [--json] [--inspect]
publish x watch [--query <q>...] [--x-list <id>...] [--languages en,zh] [--persona <text> | --persona-from <file>] [--config <watch.yaml>] [--validate-config] [--no-triage] [--format text|json|markdown] [--json] [--out <file>]
publish x draft --format tweet|thread|article (--text <content> | --from <base.md>) [--inspect]
publish x reply --to <id|url> (--text <content> | --from <base.md>) [--long] [--dry-run] [--force] [--inspect]
publish x history [--handle <h>] [--limit <n>] [--include posts|replies|all] [--since <iso>] [--format text|json|markdown] [--json] [--out <file>] [--inspect]

publish linkedin draft (--text <content> | --from <base.md>) [--media <path>...] [--bold] [--dry-run] [--inspect]  # 3,000 UTF-16 code-unit cap

publish reddit inspect <subreddit>... [--json] [--inspect]
publish reddit search "<query>" [--limit <n>] [--include-nsfw] [--json] [--inspect]
publish reddit draft --subreddit <name> --title <title> (--text <content> | --from <base.md>) [--flair <id|text>] [--nsfw] [--spoiler] [--dry-run] [--inspect]

publish wechat check [--json]
publish wechat draft (--text <content> | --from <base.md>) [--title <t>] [--author <name>] [--digest <s>] --cover <image.(bmp|png|jpg|jpeg|gif)> [--source-url <url>] [--keep-links] [--out <file.html>] [--dry-run]
```

Run any subcommand with `--help` for the authoritative flag list.

`auth check` is passive and sanitized: it never logs in, submits credentials, or
opens a composer. The comma-separated platform list is explicit; there is no
`--all`. Each receipt has a binary `ready` field plus a diagnostic `status`.
Exit `0` means all requested platforms are ready, `1` means at least one needs
its returned `nextStep`, and `2` means invalid usage (including malformed or
missing platform values, unknown options/platforms, and removed `--all`). An absent or empty browser
profile returns `login_required` without launching Playwright or creating local
state. `probe_inconclusive` is non-ready and directs the agent to inspect the
entry URL headfully. Reddit first handles its known headless HTTP 403 wall itself:
it passively retries headful once (a browser window may briefly appear and then
closes) and uses `/api/me.json` as a DOM-drift fallback. Only a structured account
response or authentication rejection proves logout; an opaque/non-JSON 403 stays
a non-ready network error. WeChat may
automatically renew its short-lived token and reports that as
`healed: ["token_refreshed"]`.

## Status

Working (X channel). The watch loop (poll → dedupe → triage → ranked candidates), the drafting-only publisher (`draft` / `reply`, staging native X drafts), and the read-only `history` reader (own published posts + replies, live-verified 2026-07-08) are implemented and live-verified. The publisher **never posts** — the human-gated send action is out of scope. Open work is tracked in GitHub issues.

The WeChat channel (`check` / `draft`) is implemented and live-verified (2026-07-04), staging native 草稿箱 drafts via `draft/add`; it **never publishes**.

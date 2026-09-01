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

## Check authentication readiness first

Run this before any channel operation and after moving to a new machine or
leaving a profile idle for a long time:

```bash
publish auth check --platform x,linkedin,reddit --json
publish auth check --platform wechat --json
```

Always name the intended comma-separated platform set; there is no `--all`.
Exit `0` means every requested platform has `ready: true`; exit `1` means at
least one has `ready: false` and needs recovery; exit `2` means invalid command
usage. The probe is passive: browser checks navigate an existing profile but
never call `ensureSession()`, submit credentials, or open a composer. An absent
or empty profile returns `login_required` without launching a browser or
creating profile state. WeChat may use App ID/Secret to renew its normal
short-lived token and reports that repair in `healed`.

For browser recovery, follow `nextStep` with the headful browser agent that will
continue the task. Complete login/CAPTCHA/QR/2FA with the operator, positively
verify the authenticated UI, and continue in the same browser context. A missing
selector is `probe_inconclusive`, not proof of logout. Do not copy cookie files
between machines.

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
- `REDDIT_READS_HEADFUL` (optional) — set to `1` to start `reddit inspect` /
  `reddit search` headful. These reads are **login-free** and default to a headless
  browser, but Reddit 403-blocks headless Chrome's fingerprint on some
  networks/machines (a non-JSON "network security" wall); on a block the reads
  **auto-retry headful once** (with an advisory note). Set this on a host with a
  bad fingerprint to skip the doomed first attempt; leave unset on
  headless-server / good-fingerprint hosts. Distinct from the one-time first login
  (below), which still needs headful `--inspect`; draft staging still runs headless
  via the persisted session.
- `WECHAT_APP_ID`, `WECHAT_APP_SECRET` — the Official Account's app credentials
  (from the 微信开发者平台 / mp.weixin.qq.com admin console). **Only needed for the
  `wechat` channel.** Unlike X/LinkedIn/Reddit there is **no browser login and no
  persistent profile** — auth is an app_id/app_secret → cached **stable-token**
  loop; the token cache lives at `<PUBLISH_DATA_DIR>/wechat-token.json`
  (machine-local, off Drive).
- `WECHAT_AUTHOR` (optional) — fallback article author.
- `WECHAT_NEED_OPEN_COMMENT` (default `1`) / `WECHAT_ONLY_FANS_CAN_COMMENT`
  (default `0`) — draft comment settings.
- `WECHAT_PROXY_URL` **or** `WECHAT_SSH_TUNNEL` — the fixed-egress-IP mode (see the
  **"WeChat channel — credentials + fixed-egress-IP"** section below). Mutually
  exclusive.

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

The execution paths can auto-log-in, but they are not readiness probes and must
not be used to diagnose ambiguous auth state. Run `publish auth check` first.
When its `nextStep` requires login, use the agent-owned headful browser context;
**X blocks headless login** and Reddit commonly raises CAPTCHA.

The legacy command-assisted setup paths remain available for explicit,
operator-observed calibration:

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

**WeChat is the exception** — it is **API-driven, so there is NO headful login and
NO persistent profile**. Its one-time setup is instead: allowlist a fixed egress IP
once (via an admin WeChat QR scan) and point the CLI at that egress. See the
**"WeChat channel — credentials + fixed-egress-IP (the gcloud dependency)"**
section below.

## WeChat channel — credentials + fixed-egress-IP (the gcloud dependency)

WeChat (微信公众号 Official Account) is the **first API-driven channel** — no
browser, no profile, no headful login. Auth is an `app_id`/`app_secret` →
**stable-token** loop, cached at `<PUBLISH_DATA_DIR>/wechat-token.json`. The one
hard operational cost is the **fixed egress IP**.

**Why a fixed egress IP is unavoidable.** WeChat's API rejects calls from any
source IP not in the account's **IP 白名单 (IP allowlist)** — this includes the
token fetch itself (rejected with `errcode 40164`). The allowlist has **no edit
API**: every change requires a manual **admin WeChat QR re-scan**, and it holds at
most **15 IPs** — so it **cannot be automated**. A traveling laptop (especially on
a VPN) has no stable raw IP, so allowlisting the laptop is hopeless. The fix: route
**all** WeChat calls through **one stable egress IP** and allowlist that IP **once**.

**The runtime dependency (stated plainly).** Operating the WeChat channel therefore
depends on:

- **(a)** an always-on host with a **stable public IP** that can reach
  `api.weixin.qq.com`. The operator's setup uses a free small cloud VM as an
  example of such a host — e.g. a GCP `e2-micro` **Always-Free** instance,
  provisioned with the **`gcloud` CLI** — but any box with a stable public IP works.
- **(b)** that host kept **running**. A stopped cloud instance that holds a reserved
  static IP still gets **billed** for the idle address.
- **(c)** local **SSH access** to it.

If the host is down, `publish wechat check` / `publish wechat draft` fail with
`40164`.

**Two ways to point the CLI at the egress** (set exactly one):

- `WECHAT_SSH_TUNNEL=<user>@<static-ip>` — the CLI **auto-spawns** its own
  `ssh -N -D` SOCKS5 tunnel per run (waits until it is ready, tears it down after —
  no orphan process). Zero-touch. It requires that plain `ssh <user>@<static-ip>`
  works **non-interactively**: add an `~/.ssh/config` `Host` block for the box
  (`User`, `IdentityFile`, `IdentitiesOnly yes`) so the right key is selected
  automatically. This matters when the key is not a default `~/.ssh/id_*` (e.g. a
  cloud-provider-generated key).
- `WECHAT_PROXY_URL=socks5://127.0.0.1:<port>` (or an `http(s)://` proxy) — route
  through a tunnel you start and manage yourself. **Mutually exclusive** with
  `WECHAT_SSH_TUNNEL`.

**One-time allowlist step (manual, unavoidable).** Sign in to the **微信开发者平台**
(`developers.weixin.qq.com/platform/` — the console migrated there from
mp.weixin.qq.com on 2025-12-01) as the account **admin** → 开发管理 →
开发接口管理 → **IP白名单** → add the fixed egress IP (one entry per line; a single
IP or a CIDR block; ≤15 total) → 确认修改 → **scan the QR with the admin's WeChat**.
Then verify with `publish wechat check`.

**Verify.** `publish wechat check` should report ✓ credentials / ✓ token / ✓ IP
allowlist. Read the error code, don't guess:
- `40013` / `40125` → bad `app_id` / `app_secret`. **NOT an IP problem — do not
  touch the allowlist.**
- `40164` → the egress IP is not in the allowlist (or the egress host is down).

**Node deps for this channel** (pulled in by `npm install`): `marked`, `undici`,
`socks`, `socks-proxy-agent`.

## Browser

Uses Playwright, preferring an installed Google Chrome (`channel: 'chrome'`) to
avoid a Chromium download; falls back to bundled Chromium
(`npx playwright install chromium`).

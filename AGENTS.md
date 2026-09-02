# publish-cli

## Instruction maintenance

`AGENTS.md` is the only editable source of repository-agent guidance. Make all
future instruction changes here. `CLAUDE.md` is a checkout-only compatibility
symlink to `AGENTS.md`; never maintain it as a separate copy.

Per-channel content-distribution toolkit for growing the operator's AI-community audience. Binary: `publish`. **Channels built today: X** (a WATCH loop for borrowed-reach + a drafting-only PUBLISH for owned-content), **LinkedIn** (drafting-only PUBLISH), **Reddit** (drafting-only PUBLISH — self-posts) **and WeChat** (微信公众号; drafting-only PUBLISH — article self-posts, the first API-driven channel). Every PUBLISH path is **draft-only — it never posts**.

Companion docs: [README.md](./README.md) (usage), [PRODUCT_SPEC.md](./docs/PRODUCT_SPEC.md) (vision/roadmap), [skills/publish/SETUP.md](./skills/publish/SETUP.md) (setup) and [skills/publish/SKILL.md](./skills/publish/SKILL.md) (agent-facing capability layer).

## Hard boundary

Every publisher stops at a **native draft staged on the platform** (X Unsent, LinkedIn "Save as draft"). It MUST NOT click Post / publish. The human-gated send action (Discord approval → phone escalation) is **future scope, not built here**. Any change that could auto-send is out of bounds.

## Auth readiness is P0

Authentication is a prerequisite for every channel feature. Before building or
expanding a channel, implement the auth-readiness and fresh-machine recovery
contract in [issue #45](https://github.com/fyang0507/publish-cli/issues/45).

- Define a side-effect-bounded `probeAuth()` that never calls an automatic
  browser-login path and never submits credentials.
- A cookie/profile/cache file is evidence, not proof. Check presence, cache age,
  and declared expiry, then require a positive live authenticated UI/API signal.
- Auth preflight must be passive for browser channels: it must not call
  `ensureSession()`, submit stored credentials, or reinterpret navigation failure
  or selector drift as logout.
- Launch passive browser probes against an ephemeral copy of the persistent
  profile. Chrome rewrites user-data directories during read-only navigation, so
  `auth check` / `info` must never launch against the operator's original profile.
- Distinguish `login_required`, `human_challenge_required`, missing/rejected
  credentials, IP allowlist failure, network failure, and
  `probe_inconclusive`; return a sanitized, structured `nextStep` for each.
- Test both long-idle state and zero state on a new machine with no profile,
  cookie cache, or token cache. Do not require copying cookies between machines.
- For agent-browser channels, return the entry URL, workflow reference, required
  human interaction, and `continueInSameContext`; the agent chooses and owns the
  headful browser/computer-use backend from authentication onward.
- API token renewal may happen automatically as the normal credential exchange,
  but the receipt must report it explicitly (for example,
  `healed: ["token_refreshed"]`).
- Never emit cookie values, tokens, passwords, private headers, or unrelated
  page/API content.
- Live-verify ready, missing-state, expired/revoked, and inconclusive/network
  cases before claiming that the channel is usable.

Current `ensureSession()` implementations are execution paths, not auth probes.
Do not reuse them for `publish auth check` or `publish <channel> info`.

Research spikes may inspect a channel before this work is complete, but feature
implementation must not claim readiness until its auth probe and zero-state
recovery path pass.

## What it is

The CLI is **channel-first**: `publish <channel> <action>` (each channel has its own action space). X, LinkedIn, Reddit, and WeChat have CLI transports; Xiaohongshu and 1point3acres currently expose static capability/readiness boundaries only.

- `publish <channel> info [--json]` — versioned Markdown guidance plus passive readiness for `x`, `linkedin`, `reddit`, `wechat`, `xhs`, and `1point3acres`. Returns every configured format at once under three free-text sections (CLI boundary, authentication, and platform specification/gotchas), succeeds even when auth is not ready, and never logs in or opens a composer.

- `publish x create-watch-list` — build/populate the account-watch List from who you follow → prints the id for `watch --x-list`. Never posts (writes List membership only).
- `publish x watch` — poll queries / Lists → dedupe → cheap-LLM triage (Gemini, low reasoning effort) → ranked reply candidates. Accounts are watched via a List (`--x-list`), never one-by-one. The `x-list` spelling is unified across `watch` and `create-watch-list`.
- `publish x draft` — canonical markdown (`--from`) or inline `--text` → tweet / thread / article → **native X draft**.
- `publish x reply --to <id|url> (--text <s> | --from <md>)` — stage a native reply draft (overflow → thread); never posts.
- `publish x history [--handle <h>] [--include posts|replies|all] [--since <iso>] [--limit <n>]` — read-only: read the operator's OWN published posts + replies live from X (reusing the browser GraphQL-capture reader), filtering out reposts / others' quoted tweets, so a multi-day campaign agent can see what it already published and avoid repeating itself. Writes no state; reflects only what is LIVE on X (staged-but-unposted drafts don't appear). Never posts.
- `publish linkedin draft (--text <s> | --from <md>)` — inline text (primary) or markdown → a single LinkedIn **post** (3,000 UTF-16 code-unit cap, deterministic markdown→plain-text, emoji passthrough, optional `--media`) → **native LinkedIn draft** via "Save as draft"; never posts. LinkedIn has no WATCH capability today (PUBLISH only).
- `publish reddit inspect <sub>...` / `publish reddit search "<query>"` — read-only discovery: `inspect` reports each named subreddit's posting contract (subscribers, allowed types, rules, flairs, post requirements); `search` lists candidate subreddits. Facts only, no LLM ranking — the agent judges.
- `publish reddit draft --subreddit <name> --title <t> (--text <s> | --from <md>) [--flair <id|text>]` — canonical markdown (kept ~verbatim; Reddit renders Markdown) → a single **self-post** → **native Reddit draft** via "Save Draft"; never posts. Enforces the target subreddit's contract before staging. Reddit has no WATCH capability today (PUBLISH only).
- `publish wechat check` — read-only preflight: verify credentials, mint a stable-token, and confirm the egress IP the API sees is in the account's IP allowlist (travel-aware). Never writes.
- `publish wechat draft --from <base.md> --cover <img> (or --text)` — canonical markdown → title + **inline-styled HTML** body + cover → a single **article** (`article_type=news`) → a **native draft in the 草稿箱** via `draft/add`; never publishes. The official title/author/digest limits are 32/16/120 `字`, but exact Unicode measurement is unresolved and server-authoritative. A cover is required; local body images upload to WeChat's CDN; external links default to bottom citations. WeChat has no WATCH capability today (PUBLISH only).

Short posts/replies take inline `--text`; `--from` (with `-` = stdin) is for longer, file-based canonical markdown (WeChat is long-form — `--from` primary). All resolve through the shared `src/commands/contentInput.ts` (exactly-one-of validation).

## Stack

TypeScript + Node **ESM** (`"type": "module"`, `module`/`moduleResolution` = `Node16`) — **import local files with the `.js` extension**. `commander` CLI (each command file exports a `register*Command(parent)`). `twitter-text` supplies X's official weighted counting semantics. `@google/genai` (Gemini triage/tailoring), `better-sqlite3` (dedupe store), `playwright` (browser), `yaml` (`watch.yaml`), `dotenv` (`.env`). WeChat (API-driven) adds `marked` (markdown → inline-styled HTML) and `undici`/`socks`/`socks-proxy-agent` (the fixed-egress-IP dispatcher + ssh/SOCKS tunnel).

## X access = one browser, both directions

A single Playwright **persistent-profile** browser (one unattended credential login, `src/session.ts`) backs BOTH reads and writes:

- **Reads** = browser **GraphQL response capture** — drive the logged-in UI and capture `/graphql/` responses, matched by **operation NAME** (`SearchTimeline`, `ListLatestTweetsTimeline`); query-id hashes drift, names don't. (Per-account timelines aren't read — accounts are watched via a List.)
- **Writes** = composer automation (tweet/thread/article/reply drafts).
- **Do not reintroduce out-of-band HTTP read libs** (`agent-twitter-client`, `twikit`). 2026 X's anti-automation (`x-client-transaction-id`) blocks them; the browser path is the deliberate, verified choice.
- X blocks **headless login** — first login must be headful (`--inspect`). Login/composer selectors need occasional live re-calibration.

## LinkedIn reuses the browser-driven pattern (its own profile)

LinkedIn is a browser-driven PUBLISH channel that mirrors X's persistent-profile model with a **separate** session (`src/linkedin/session.ts`, profile `<PUBLISH_DATA_DIR>/li-profile`, creds `LI_USERNAME`/`LI_PASSWORD`/`LI_EMAIL`) — one unattended credential login, headful `--inspect` for first login / calibration. It does **not** share X's `src/session.ts`; the design-doc `createBrowserSession` factory lift is deferred to protect the shipped X code.

- **Reuse by import, not by editing X:** `src/linkedin/*` imports channel-agnostic helpers (`parseBaseMarkdown` from `src/x/content.ts`; UTF-16 validation from `src/capabilities/`; `tolerantLocator`/`optionalLocator`/`typeText` from `src/x/draftPoster.ts`; `resolveContentInput` from `src/commands/contentInput.ts`). Do NOT relocate/rewrite X's browser modules for LinkedIn's sake.
- **Composer facts (calibrated live 2026-07, drift-prone):** open via `feed/?shareActive=true` (`/sharing/compose` 404s as a direct URL); editor is TipTap `div.ProseMirror[contenteditable]`; LinkedIn **auto-restores the last draft into the composer**, so the poster select-all-clears before typing; save = close (`aria-label="Dismiss"`) → text button **"Save as draft"** (never the sibling "Discard" or "Post" — both are documented FORBIDDEN selectors no code path clicks).

## Reddit reuses the browser-driven pattern (its own profile)

Reddit is a browser-driven PUBLISH channel that mirrors the X/LinkedIn persistent-profile model with a **separate** session (`src/reddit/session.ts`, profile `<PUBLISH_DATA_DIR>/reddit-profile`, cache `reddit-cookies.json`, creds `REDDIT_USERNAME`/`REDDIT_PASSWORD`(/`REDDIT_EMAIL`)) — one unattended credential login, headful `--inspect` for first login / calibration (Reddit login is **captcha-heavy**) — a one-time setup-stage cost. Draft **staging** still runs headless (reuses the persisted session cookie); the never-posts boundary is unchanged. `reddit inspect` / `reddit search` reads are **login-free** and default to a headless browser, but Reddit 403-blocks headless Chrome's fingerprint on SOME networks/machines (a non-JSON "network security" wall); since reads need no human — only a display — they **auto-retry headful once** on a block (with an advisory note), and `REDDIT_READS_HEADFUL=1` starts them headful to skip the doomed first attempt (leave unset on headless-server / good-fingerprint hosts). It reuses by import (`parseBaseMarkdown`/`countChars` from `src/x/content.ts`; `tolerantLocator`/`optionalLocator`/`typeText` from `src/x/draftPoster.ts`; `resolveContentInput`), never by editing X. Composer save = **"Save Draft"** (never "Post" — a documented FORBIDDEN selector). The poster switches the composer to Markdown mode so the body renders as Markdown (calibrated live 2026-07-04): the "Switch to Markdown" control is an `rpl-menu-item[role=menuitem]` inside the body toolbar's "…" (More options) overflow — NOT a `<button>` (the only matching `<button aria-label>` is a permanently-hidden responsive copy) — so the poster matches it by role/text, confirms the switch engaged (the reverse toggle becomes "Switch to Rich Text Editor" / a Markdown `<textarea>` appears), and types the body into that `<textarea>`. A normal draft is therefore staged **in** Markdown mode and renders correctly; the advisory to flip "… → Switch to Markdown" manually now fires ONLY in the rare case the switch genuinely can't engage — a fallback, no longer the expected outcome. After the "Save Draft" click the poster verifies the save via Reddit's transient "Draft saved" toast (reopening the "Drafts" modal shows a stale list, so it is not used), so "verified in drafts: yes" is the normal result on a successful save. Since every draft is human-reviewed pre-post, any residual limitation is surfaced, not silent.

## WeChat is API-driven (the first non-browser channel)

WeChat (微信公众号 / Official Account) is the first channel that does **NOT** use Playwright — it calls the official Official Account API (`api.weixin.qq.com`) over HTTPS. Auth = `WECHAT_APP_ID`/`WECHAT_APP_SECRET` → a cached **stable-token** (`/cgi-bin/stable_token`), cache at `<PUBLISH_DATA_DIR>/wechat-token.json` (machine-local, off Drive). **No browser, no persistent profile, no cookie cache.** See [docs/WECHAT_DESIGN.md](./docs/WECHAT_DESIGN.md).

- **Reuse by import, not by editing X:** `src/wechat/*` imports channel-agnostic helpers (`parseBaseMarkdown` from `src/x/content.ts`; `resolveContentInput` from `src/commands/contentInput.ts`) and adds a `marked`-based renderer that emits **inline `style=` on every element** — WeChat's draft sanitizer strips `<style>`/`<link>`/CSS classes, so styling MUST be inlined. Deterministic, no LLM. Do NOT guess `字` measurement with a shared Unicode counter. Do NOT relocate/rewrite X's modules for WeChat's sake.
- **Hard boundary is structural (the API analog of the browser channels' forbidden selectors):** save (`/cgi-bin/draft/add`) and publish (`/cgi-bin/freepublish/submit`) are **different endpoints**. Only `draft/add` (+ `stable_token`, `media/uploadimg`, `material/add_material`, and the read-only `get_api_domain_ip` for the IP check) is ever called. `freepublish/*` and `message/mass/*` are **FORBIDDEN** — never imported/called (a boundary comment in `client.ts` enumerates them). There is no code path that publishes.
- **IP allowlist (IP白名单):** WeChat gates **ALL** API calls by source IP (including the token fetch itself; an unlisted IP → error `40164`). The allowlist has **no edit API**, requires a manual **admin QR re-scan** per change, and caps at **15 IPs** — so it cannot be automated. The channel instead routes **every** call through **one fixed egress IP allowlisted once** (fixed-egress-IP mode): `WECHAT_SSH_TUNNEL` (the CLI auto-spawns/tears down an `ssh -N -D` SOCKS5 tunnel) or `WECHAT_PROXY_URL` (http(s)/socks5) — a single egress seam in `client.ts`/`egress.ts`. This keeps a traveling / VPN operator zero-touch: the account's egress never changes even as the operator's real IP does. The admin console for the allowlist migrated 2025-12-01 to the 微信开发者平台 (`developers.weixin.qq.com/platform/`). Built + live-verified 2026-07-04.

## State lives in two homes

- **Machine-local** — the persistent browser profiles + harvested cookie caches (per channel: `x-profile`/`x-cookies.json`, `li-profile`/`li-cookies.json`, `reddit-profile`/`reddit-cookies.json`) plus WeChat's stable-token cache (`wechat-token.json`) — under `PUBLISH_DATA_DIR` (default `~/.publish-cli`). **MUST stay off any cloud-synced path and out of the repo.** WeChat is API-driven, so it has **no** browser profile and its draft channel does **no** sqlite dedupe — just the token cache.
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
| `src/cli.ts` | `publish` program; registers the `x` group (`create-watch-list` / `watch` / `draft` / `reply` / `history`), the `linkedin` group (`draft`), the `reddit` group (`inspect` / `search` / `draft`) and the `wechat` group (`check` / `draft`) |
| `src/config.ts` | env (X + LinkedIn + Reddit + WeChat creds, `TRIAGE_MODEL`, `WECHAT_SSH_TUNNEL`/`WECHAT_PROXY_URL`), `dataPaths()` (x-/li-/reddit-profile + cookie caches + `wechatTokenCache`), `loadWatchConfig()` |
| `src/dataRepo.ts` | `resolveDataRepo()` — env → dev config → workspace walk-up |
| `capabilities/` | Human-editable Markdown source for each channel's CLI boundary, authentication method, and platform specification/gotchas; loaded directly at runtime |
| `src/capabilities/` | Minimal Markdown loader/schema plus reusable confirmed measurement/validation helpers |
| `src/session.ts` | X Playwright persistent-profile login; `ensureSession`/`getCookies`/`getBrowserContext` |
| `src/gemini.ts` | `@google/genai` client: `generate()` + `triage()` |
| `src/db.ts` | `better-sqlite3` `SeenStore` (dedupe), db in the data repo |
| `src/langFilter.ts` | channel-agnostic language allow-list filter for watch pipelines (operates on a minimal `{lang?}` shape; reused by import, like `db.ts`/`config.ts`) |
| `src/x/reader.ts` | `BrowserReader` — GraphQL response capture (search / list / own-profile timelines); `fetchUserTimeline` (own-authored posts+replies, drops reposts) backs `x history` |
| `src/x/triage.ts` | cheap-LLM triage → ranked candidates |
| `src/x/content.ts` | canonical-markdown parser → tweet / thread / article blocks (shared by LinkedIn) |
| `src/x/draftPoster.ts` | composer automation: stage native tweet/thread/article/reply drafts (exports shared locator/typing primitives) |
| `src/linkedin/session.ts` | LinkedIn persistent-profile login (structural sibling of `src/session.ts`) |
| `src/linkedin/content.ts` | `generatePost` — deterministic markdown → LinkedIn plain-text post (3,000 UTF-16 code-unit cap, hook/link advisories) |
| `src/linkedin/draftPoster.ts` | LinkedIn composer automation: stage a native post draft via "Save as draft" (never posts) |
| `src/reddit/session.ts` | Reddit persistent-profile login (structural sibling of `src/session.ts`); `ensureSession`/`getBrowserContext`/`getCookies`/`closeSession` |
| `src/reddit/reader.ts` | authenticated JSON reads for `inspect` / `search` / draft preflight (`about` / `about/rules` / `link_flair_v2` / `subreddits/search`) + `post_requirements` response capture |
| `src/reddit/content.ts` | `generateSelfPost` — canonical markdown → title + Markdown body (kept ~verbatim), caps, old-reddit/link advisories (reuses `src/x/content.ts`) |
| `src/reddit/draftPoster.ts` | Reddit composer automation: stage a native self-post draft via "Save Draft" (never posts) |
| `src/wechat/client.ts` | WeChat API backbone: stable-token mint + cache, image uploads, `addDraft`, the single egress seam, `40164` (IP-not-allowlisted) parsing; documents the FORBIDDEN `freepublish/*` / `message/mass/*` endpoints |
| `src/wechat/egress.ts` | fixed-egress-IP dispatcher — routes API calls through `WECHAT_SSH_TUNNEL` (auto-spawned `ssh -N -D` SOCKS5) or `WECHAT_PROXY_URL` (http(s)/socks5) |
| `src/wechat/content.ts` | `generateArticle` — canonical markdown → title + inline-styled HTML body (`marked`, `style=` on every element), with unresolved `字` limits left server-authoritative |
| `src/wechat/draft.ts` | draft orchestration: upload cover + body images, rewrite image `src`s to CDN URLs, then `draft/add` (never publishes) |
| `src/commands/contentInput.ts` | shared `--text` / `--from` / stdin resolution (exactly-one-of) for `draft` / `reply` / `linkedin draft` / `reddit draft` / `wechat draft` |
| `src/commands/channel-info.ts` | Shared `publish <channel> info [--json]` command; Markdown guidance plus passive shared-auth readiness |
| `src/commands/{create-watch-list,watch,draft,reply,history,linkedin-draft}.ts` | command bodies |
| `src/commands/reddit-{inspect,search,draft}.ts` | Reddit command bodies |
| `src/commands/wechat-{check,draft}.ts` | WeChat command bodies |
| `scripts/install-agent-skill-symlinks.js` | post-build: chmod bin + symlink skill into `<data_repo>/.agents/skills` |
| `skills/article-references/` | compact essay-reference research, source-selection, formatting, and safe Notion update workflow |
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

WeChat is API-driven, so "verify live" means exercising the real API and eyeballing the 草稿箱 (drafts) preview — in particular that the **inline CSS survives** WeChat's draft sanitizer (the whole reason styling is inlined) and that the egress IP is allowlisted. Built + live-verified 2026-07-04.

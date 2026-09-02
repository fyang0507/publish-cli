# Design: WeChat Official Account channel (`publish wechat check` / `draft`)

> **Status:** IMPLEMENTED + live-verified 2026-07-04 (Phase 3, per [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) §7).
> `publish wechat check` and `publish wechat draft` are built and verified live end-to-end
> (token mint via `stable_token`, cover + body-image upload, `draft/add` → a native draft in
> the 草稿箱, over the fixed-egress-IP tunnel; inline-styled HTML confirmed to survive WeChat's
> sanitizer in the 草稿箱 preview). This document is retained as the design of record — it
> describes what was built, not a proposal.
> **Scope:** the WeChat Official Account (微信公众号) **PUBLISH** capability only,
> and within it **article self-posts (文章 / `article_type=news`) only**. Two flat
> sibling actions (matching the toolkit's two-level `publish <channel> <action>`
> grammar): one read-only preflight verb — **`check`** (verify credentials, mint a
> token, report the egress IP the API sees and whether it is allowlisted) — plus
> **`draft`**, staging a native WeChat **draft** in the account's 草稿箱 (draft box)
> from canonical markdown (title + inline-styled HTML body + cover). Image-text
> posts (图文 / `newspic`, up to 9 images), themed rendering, and multi-account
> support are separate follow-ups (§8).
>
> **Automation goal — human-in-the-loop ONLY at the final proofread+publish.**
> Like every other channel, the operator's per-use flow must be zero-touch up to a
> staged draft. WeChat's **IP allowlist** is the one thing that threatens this: it
> gates the API by source IP, cannot be edited via any API, and every edit requires
> a manual **admin QR re-scan** (§3.3). So "auto-add my current IP" is *impossible*
> to make zero-human. The design meets the goal a different way — a **stable egress
> IP added to the allowlist ONCE** (a one-time setup cost, like the one-time login
> the browser channels need), through which all API calls are routed thereafter
> (§3.3, "fixed-egress-IP mode"). This is **in scope** and the recommended
> production setup for a traveling operator; the deferred remote-API bits are
> narrower (§8).
>
> **Architecture: API-driven** — this is the **first non-browser channel** in the
> toolkit. X, LinkedIn, and Reddit all drive a persistent Playwright profile; WeChat
> instead calls the **official Official-Account API** (`api.weixin.qq.com`) over
> HTTPS with an `app_id`/`app_secret`-derived access token. This matches the
> long-standing classification in [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) §2.2 and
> [LINKEDIN_DESIGN.md](./LINKEDIN_DESIGN.md) §3.1 ("let API channels own their own
> auth loop, no browser"), and the note carried in `src/reddit/session.ts`:
> *"Reddit joins X, LinkedIn, and 小红书 as browser-driven; only WeChat remains
> API-driven."* See §3.1.
>
> **Hard boundary (unchanged, and cleaner here):** the publisher stops at a
> **native draft staged on the platform**. It MUST NOT publish. WeChat's API makes
> this a *structural* guarantee rather than a discipline: **saving a draft**
> (`POST /cgi-bin/draft/add`) and **publishing** (`POST /cgi-bin/freepublish/submit`)
> are **different endpoints**. This channel implements only `draft/add`; the
> `freepublish/*` and `message/mass/*` families are **never imported and never
> called** — the API analog of the browser channels' "documented forbidden
> selector." There is no composer, so no misclick can escalate a draft to a post.

---

## 1. What a WeChat article draft is

The unit is a single **article** (文章) staged in the Official Account's **草稿箱
(draft box)**: a required **title**, an optional **author** and **digest (摘要)**,
a required **cover image** (封面, the `thumb_media_id`), and a **rich-HTML body**.
Once `draft/add` returns, the article is visible under
`mp.weixin.qq.com` → 内容管理 → 草稿箱, where the operator reviews it and (manually,
outside this tool) publishes or schedules it.

Three things make WeChat unlike every channel shipped today:

1. **The body is rich HTML, not text or Markdown.** X/LinkedIn emit plain text;
   Reddit keeps Markdown verbatim. WeChat articles are **HTML** — and the editor
   **strips `<style>` blocks, `<link>` tags, and CSS classes**, so *every* visual
   rule must be an **inline `style="…"` attribute on the element itself**. The
   content layer therefore needs a real **markdown → inline-styled-HTML renderer**,
   the heaviest content transform in the toolkit (§3.4, §4).
2. **Auth is a token loop, not a browser session.** No persistent profile, no
   cookies, no login automation. `app_id` + `app_secret` → a short-lived
   **access token** (7200 s), cached machine-local and refreshed on demand (§3.2).
3. **The API is IP-gated, and the gate cannot be automated.** WeChat only accepts
   calls — *including the token fetch itself* — from IPs in the account's **IP 白名单
   (IP allowlist)**; an unlisted IP fails with `errcode 40164`. The allowlist has
   **no edit API** and every change needs a manual **admin QR re-scan**, so it can
   *only* be managed by a human in the web console (§3.3). For a **traveling laptop**
   (changing IPs) the answer is therefore not to automate the edits but to remove
   the need for them: route all calls through one **stable egress IP** allowlisted
   once (§3.3).

### 1.1 The workflow: check → draft → (human) review

Publishing is a **two-phase** flow; the editorial judgment of *what* to publish
stays with the **consuming agent / operator**, not this repo (AGENTS.md
public-repo posture):

0. **One-time setup** — allowlist a **stable egress IP** and point the CLI at it
   (§3.3, fixed-egress-IP mode). Done once, with a single admin QR scan. After
   this, steps 1–3 are the only recurring flow and step 2 is fully unattended.
1. **`publish wechat check`** (optional, e.g. after a network/proxy change) —
   verify credentials, mint a token, and confirm the egress IP the API sees is
   allowlisted. On `40164` it prints the exact IP and the settings URL. Read-only;
   stages nothing. In fixed-egress-IP mode this should already pass without action.
2. **`publish wechat draft --from article.md --cover cover.png`** — render the
   markdown to inline-styled HTML, upload the cover (→ `thumb_media_id`) and any
   local body images (→ WeChat CDN URLs), assemble the `draft/add` payload, and
   stage the draft. Prints the returned draft `media_id` and the 草稿箱 URL.
3. **Human reviews and publishes** in `mp.weixin.qq.com` — outside this tool (the
   send-gate is future scope, PRODUCT_SPEC §5).

## 2. CLI surface

Two flat sibling actions — one read-only preflight verb (`check`) that precedes
the write (`draft`). Kept flat (not nested) to match the toolkit's two-level
`publish <channel> <action>` grammar, exactly as X exposes `watch` / `draft` and
Reddit exposes `inspect` / `search` / `draft`.

New channel group in `src/cli.ts`, mirroring `x` / `linkedin` / `reddit`:

```ts
const wechat = program.command("wechat")
  .description("WeChat Official Account channel: check (credentials/IP) + draft (native article drafts, never posts)");
registerWechatCheckCommand(wechat);
registerWechatDraftCommand(wechat);
```

**`check` — verify credentials + token + IP allowlist (travel-aware).**

```
publish wechat check                 # verify creds, mint token, confirm egress IP is allowlisted
                  [--json]           # machine-readable (default: human report)
```

Steps, each reported as ✓/✗ with actionable next steps (never opaque failure):

| Step | What it does | On failure |
|---|---|---|
| Credentials | `WECHAT_APP_ID` + `WECHAT_APP_SECRET` present | Point at `.env` / `skills/publish/references/setup.md` |
| Token | `POST /cgi-bin/stable_token` → cache it (§3.2) | Surface `errcode`/`errmsg` (e.g. `40013` invalid appid, `40125` invalid secret) |
| IP allowlist | one harmless authenticated call; catch `40164` and **parse the egress IP from `errmsg`** | Print: *"WeChat sees this machine as `<ip>` — add it at 公众号设置 → 安全中心 → IP白名单: https://mp.weixin.qq.com/…"* |

`check` is the traveling operator's friend: land on a new network → `publish wechat
check` → copy the reported IP into the allowlist → done. It stages nothing and
makes no `draft/add` call.

**`draft` — stage a native article draft in the 草稿箱.**

```
publish wechat draft (--from <base.md> | --from - | --text "<body>")
                     [--title "<title>"]        # official ≤32 字; measurement server-authoritative
                     [--author "<name>"]        # official ≤16 字; or frontmatter / WECHAT_AUTHOR
                     [--digest "<summary>"]     # official ≤120 字; omitted => first 54 字 from body
                     --cover <image.(bmp|png|jpg|jpeg|gif)> # required permanent material
                     [--source-url <url>]       # 阅读原文 link (or frontmatter sourceUrl)
                     [--keep-links]             # keep inline external links (default: → bottom citations, §4)
                     [--out <file.html>]        # write the rendered HTML for inspection
                     [--dry-run]                # render + validate only; NO network, NO uploads, NO draft/add
```

**Body input mirrors the rest of the toolkit** — the shared `resolveContentInput`
(`--text` | `--from <file>` | `--from -` stdin, exactly-one-of). WeChat is
long-form, so `--from <base.md>` is the primary path (inline `--text` still works
for short bodies), the same emphasis as Reddit and the same code.

**Metadata may also come from Markdown frontmatter** in the `--from` file, with the
flags overriding — so one canonical `.md` fully describes an article:

```markdown
---
title: "What we learned shipping an on-call triage agent"
author: "the operator"
description: "Six weeks, one pager rotation, and what the agent actually caught."
coverImage: ./imgs/cover.png
sourceUrl: https://example.com/original
---
# body markdown here…
```

`--dry-run` renders the HTML, resolves + validates all metadata, and reports the
body-image / cover / link plan **without any network call** (no token, no upload,
no `draft/add`) — the WeChat analog of Reddit's browser-free dry-run. Combined with
`--out`, the operator can eyeball the exact HTML before spending a token or an
allowlisted call.

## 3. Architecture — API-driven (the first non-browser channel)

### 3.1 Why API, not browser

Unlike Reddit (whose official-API path was falsified live and reversed to
browser-driven, see [REDDIT_DESIGN.md](./REDDIT_DESIGN.md) §3.1), WeChat's
Official-Account API is the *right* tool and has been the plan since
[PRODUCT_SPEC.md](./PRODUCT_SPEC.md) §2.2:

- **Sanctioned and stable.** `api.weixin.qq.com` is the official server-to-server
  API for Official Accounts, with a documented, versioned `draft/add` contract.
- **The operator's own account.** Credentials are the operator's own
  `app_id`/`app_secret`; drafts land in the operator's own 草稿箱. No bot account,
  no third-party app review.
- **A native draft endpoint exists.** `draft/add` is *purpose-built* for staging
  unpublished content — the hard boundary is a first-class API concept, not an
  automation trick.
- **The web composer is hostile to automation** (heavy anti-bot, a canvas-based
  rich editor). Driving it would be strictly worse than the API on every axis.

So WeChat stays API-driven. It does **not** reuse `src/session.ts` or any
browser primitive; it reuses only the **channel-agnostic content helpers** by
import (§3.4), exactly as LinkedIn/Reddit reuse them — never by editing X.

### 3.2 Auth — `app_id`/`app_secret` → cached access token (no profile)

The auth backbone is `src/wechat/client.ts` — the structural analog of the other
channels' `session.ts`, but with **no browser and no persistent profile**:

- **Token source:** `POST /cgi-bin/stable_token` with
  `{grant_type:"client_credential", appid, secret, force_refresh:false}`. WeChat's
  **stable-token** endpoint is designed for server-side callers: repeated fetches
  return the *same* valid token (a 5-minute overlap window on refresh) instead of
  silently invalidating the previous one, which the legacy `GET /cgi-bin/token`
  does. This avoids the classic "two processes fighting over the token" bug.
- **Cache:** the token + expiry are cached machine-local at
  `dataPaths().wechatTokenCache` = `<PUBLISH_DATA_DIR>/wechat-token.json`, refreshed
  when <5 min remain. A live access token is **secret-adjacent**, so it lives under
  `PUBLISH_DATA_DIR` (default `~/.publish-cli`) **off any cloud-synced drive** — the
  same rule as the browser cookie caches (AGENTS.md "State lives in two homes").
  There is **no browser profile dir** for WeChat (it is the first channel without
  one).
- **Credentials:** `WECHAT_APP_ID` + `WECHAT_APP_SECRET` from `.env` (§6). The
  `app_secret` never leaves the local process and is never written to the cache.

### 3.3 The IP allowlist — why it can't be auto-edited, and the fixed-egress-IP answer

WeChat's API rejects calls from any IP not in the account's **IP 白名单** — and this
gate covers the **token fetch itself**, so an unlisted IP can do *nothing*
([official docs](https://developers.weixin.qq.com/doc/oplatform/developers/basic_func/ip_whitelist.html)).
For a **traveling local operator** whose laptop IP changes per network, this is the
channel's one real threat to the "unattended until proofread" goal — and it is
worse than "per physical location." The operator **runs a VPN most of the time**,
so the egress IP rotates *even at a single desk* (VPN servers reassign addresses on
reconnect). There is effectively **no stable raw IP to allowlist**, which rules out
Mode B as a primary strategy and makes the fixed-egress-IP approach (below) not just
recommended but necessary.

**The allowlist cannot be automated — this was verified, not assumed:**

1. **No edit API.** The allowlist is editable *only* in the `mp.weixin.qq.com`
   console ("设置与开发 → 开发接口管理"). There is no `access_token` endpoint to
   read or write it.
2. **Every edit needs a manual admin QR re-scan.** Saving the list ends with *"用
   微信扫码让管理员确认"* — the admin must confirm each change in their WeChat app.
   A deliberate anti-automation gate; even browser-driving the console would still
   stop here on every trip.
3. **Chicken-and-egg + a 15-IP cap.** You need an allowlisted IP to get a token, and
   the list holds at most **15** IPs. Auto-adding each new travel IP would exhaust
   the slots *and* demand an admin scan every time.

So the design does **not** try to add IPs on the fly. It removes the need to:

**Mode A — fixed egress IP (recommended; meets the automation goal).** Route every
WeChat call through one **stable IP that never changes wherever the laptop is**, and
allowlist that IP **once**:

- **Setup (one-time, one admin scan):** stand up a fixed-IP hop — a cheap VPS
  reached by an **SSH SOCKS5 tunnel** (`ssh -N -D <port>`, only `sshd` needed on the
  box), or any **static-IP HTTP/SOCKS proxy / VPN**. Add its IP to the allowlist
  once. This is the WeChat analog of the one-time headful login the browser channels
  require — a setup-stage cost, then unattended forever.
- **Runtime:** `client.ts` sends all requests through the configured proxy
  (`WECHAT_PROXY_URL`, or the SSH-tunnel keys in §6). WeChat always sees the fixed
  IP; the laptop's changing IP is invisible. **No per-trip human step** → the only
  human touch is the final proofread+publish. ✅
- The proxy is a single **HTTP seam in `client.ts`** (one `fetch`/dispatcher
  wrapper), so content and command code are untouched by it.
- **The VPN doesn't interfere.** WeChat only ever sees the *final* hop (the fixed
  IP). The laptop→proxy leg may itself run over the VPN — irrelevant, because the
  proxy re-originates the request from its own stable address. So "VPN on" and
  "Mode A" coexist with no conflict.
- **Variant — a dedicated-IP VPN.** Since the operator already runs a VPN, the
  lowest-effort Mode A may be a **dedicated/static-IP add-on** from the VPN provider
  (a fixed IP assigned only to this account). Allowlist that IP once and keep the
  VPN on; no VPS to manage. It is a **paid** add-on (see options, Appendix B), so
  it is listed alongside the free VPS route rather than as the default.

For the concrete setup runbook (VPS + `sshd`, or dedicated-IP VPN) and the free
options, see **Appendix B**.

**Mode B — direct + travel-aware `check` (fallback, no proxy).** The laptop calls
WeChat directly. This is simpler but **does not** meet the automation goal — a new
network means a manual allowlist edit (admin scan). The tooling makes that edit as
cheap as possible rather than automating it:

- **The rejected IP is discoverable.** `40164`'s `errmsg` is `invalid ip <a.b.c.d>
  …, not in whitelist`; `client.ts` parses `<a.b.c.d>` so the operator never has to
  look up "what's my IP."
- **`check` surfaces it proactively;** `draft` surfaces it on the first real call
  and **aborts before staging** (uploads are ordered so `40164` fails fast — no
  partial draft, no dangling media; §5), then prints the IP + the console URL to add
  it (followed by the one admin scan WeChat forces).

Mode is a config choice (§6): set a proxy → Mode A; leave it unset → Mode B. Both
share the same `client.ts` code path.

### 3.4 Content generation — reuse X's parser, emit inline-styled HTML

`src/wechat/content.ts` reuses the shared deterministic parser and adds the one
genuinely new piece — a markdown → inline-styled-HTML renderer:

- **Reused by import:** `parseBaseMarkdown` + `countChars` from `src/x/content.ts`
  (frontmatter extraction, leading-H1 title derivation, link flags, code-point
  counting) and `resolveContentInput` from `src/commands/contentInput.ts`. Same
  reuse posture as LinkedIn/Reddit.
- **New:** a `marked`-based renderer with an **overridden renderer** that emits an
  inline `style="…"` on every block/inline element (headings, paragraphs,
  blockquotes, lists, code, `<img>`, `<a>`). No `<style>`/class output — everything
  survives WeChat's sanitizer. A single **default look** (one readable typographic
  scale); themes/color presets are deferred (§8). Deterministic — same markdown in,
  same HTML out, **no LLM** (consistent with every other content generator).

## 4. Content generation + validation (deterministic, no LLM)

`generateArticle(md, opts)` in `src/wechat/content.ts` produces everything the
draft assembler needs, with **no network and no LLM**:

1. **Parse** via `parseBaseMarkdown` → frontmatter, leading H1, body markdown, link
   flags.
2. **Resolve metadata** (flag → frontmatter → fallback):
   - **title:** `--title` → frontmatter `title` → leading H1. **Required.** The
     official contract says **≤32 `字`**, but does not define code-point, UTF-16,
     or grapheme measurement, so the CLI reports the limit and leaves rejection
     server-authoritative rather than guessing a local counter.
   - **author:** `--author` → frontmatter `author` → `WECHAT_AUTHOR` env → empty.
     The official **≤16 `字`** boundary has the same unresolved measurement.
   - **digest (摘要):** `--digest` → frontmatter `description`/`summary`; when
     omitted, leave it empty so WeChat derives the first **54 `字`** from the body.
     The documented maximum is **120 `字`**, with measurement server-authoritative.
   - **cover:** `--cover` → frontmatter `coverImage`/`cover`/`image`. **Required**
     for `article_type=news`; if unresolved → **ERROR** with guidance (mirrors the
     reference's "no cover" stop).
   - **content_source_url (阅读原文):** `--source-url` → frontmatter
     `sourceUrl`/`contentSourceUrl`. Optional.
3. **Render body** → inline-styled HTML (§3.4). Collect referenced **local image
   paths** for upload (§4.1).
4. **Link handling (default → citations):** WeChat strips/deactivates most external
   `<a href>` in article bodies (non-whitelisted domains are not clickable). By
   default, ordinary external links are rewritten to **bottom citations** (a
   numbered footnote list showing the URL as text) — the reference's default and the
   WeChat-friendly choice. `--keep-links` opts out and leaves inline links as-is.
   Links to `mp.weixin.qq.com` are always kept inline.
5. **Return** `{ title, author, digest, html, coverPath, sourceUrl, bodyImages[],
   linkFlags, warnings[] }`. `bodyImages[]` are the local paths the assembler must
   upload + rewrite. `warnings[]` carries advisories (omitted digest delegated to
   WeChat, links converted to citations, remote image found) — printed for the
   operator, never silent.

Everything in §4 runs in `--dry-run` (no network); the uploads in §4.1 and §5 do
not.

### 4.1 Images — body uploads and the cover

WeChat requires images to be **hosted by WeChat**; external `<img src>` to
non-WeChat hosts are stripped from published articles. Two upload paths, both in
`client.ts` and both invoked only on a **real run**:

- **Body images:** for each local image referenced in the markdown, `POST
  /cgi-bin/media/uploadimg` → returns a WeChat CDN **URL**; the assembler rewrites
  the corresponding `<img src>` to that URL. Official documentation says jpg/png
  and `1MB以下`; exact byte semantics are unresolved and server-authoritative, so
  the CLI validates the extension and file presence but does not invent a local
  byte cutoff. Auto-compression is a follow-up (§8).
- **Cover (`thumb_media_id`):** `POST /cgi-bin/material/add_material?type=image` →
  returns a **permanent-material** `media_id` used as the article's
  `thumb_media_id`. Official documentation labels the maximum `10M`; exact byte
  semantics remain unresolved/server-authoritative. Note: this consumes the
  account's permanent-material quota; a future optimization could dedupe by
  content hash (§8).
- **Remote images** (`http(s)://` sources in the markdown): flagged as a
  `warning` and left as-is this phase (a published article would drop them). Auto
  download-then-reupload is a follow-up (§8).

## 5. The `draft/add` call + the never-publish boundary

`src/wechat/draft.ts` is the orchestration layer (the "poster" analog, no browser).
On a real run it:

1. Ensures a token (§3.2).
2. Uploads the **cover** → `thumb_media_id`. (Cover first: it is required, so a
   `40164`/quota failure aborts before any body work.)
3. Uploads each **body image** → rewrites `<img src>` in the HTML.
4. Assembles the `draft/add` payload and calls
   `POST /cgi-bin/draft/add?access_token=…`:

```jsonc
{ "articles": [ {
    "article_type": "news",
    "title": "<official ≤32 字; server-authoritative measurement>",
    "author": "<optional; official ≤16 字>",
    "digest": "<optional; official ≤120 字; omission derives first 54 字>",
    "content": "<inline-styled HTML, external images rewritten to WeChat URLs>",
    "content_source_url": "<optional 阅读原文>",
    "thumb_media_id": "<from step 2>",
    "need_open_comment": 1,        // WECHAT_NEED_OPEN_COMMENT (default 1)
    "only_fans_can_comment": 0     // WECHAT_ONLY_FANS_CAN_COMMENT (default 0)
} ] }
```

5. On success WeChat returns the draft's **`media_id`**; the command prints it plus
   the 草稿箱 URL and a plain **"staged a native draft — NEVER published"** line
   (same success grammar as the browser channels).

**The boundary, enforced structurally.** The only endpoints this channel ever
touches are: `stable_token`, `media/uploadimg`, `material/add_material`,
`draft/add`. The following are **FORBIDDEN** — never imported, never referenced,
called out in a comment in `client.ts` the way browser channels list forbidden
selectors:

- `POST /cgi-bin/freepublish/submit` (publish a draft) — **and the rest of
  `freepublish/*`.**
- `POST /cgi-bin/message/mass/*` (mass send to followers).

Any change that adds one of these is out of bounds (AGENTS.md "Hard boundary").

## 6. Config & state additions

**`src/config.ts` — env (secrets/infra only):**

| Key | Default | Purpose |
|---|---|---|
| `WECHAT_APP_ID` | `""` | Official Account app id |
| `WECHAT_APP_SECRET` | `""` | Official Account app secret (never cached to disk) |
| `WECHAT_AUTHOR` | `""` | Fallback article author |
| `WECHAT_NEED_OPEN_COMMENT` | `1` | `articles[].need_open_comment` |
| `WECHAT_ONLY_FANS_CAN_COMMENT` | `0` | `articles[].only_fans_can_comment` |
| `WECHAT_PROXY_URL` | `""` | Fixed-egress-IP mode (§3.3). An `http(s)://` or `socks5://[user:pass@]host:port` proxy through which **all** WeChat calls are routed. Set → Mode A (allowlist the proxy's IP once); unset → Mode B (direct + travel-aware `check`). |
| `WECHAT_SSH_TUNNEL` | `""` | Optional convenience: `[user@]host[:port]`. When set, `client.ts` spawns `ssh -N -D <localPort> …` to that fixed-IP box and routes through the resulting local SOCKS5 proxy — so only `sshd` is needed on the server (no standalone proxy). Mutually exclusive with an explicit `WECHAT_PROXY_URL`. |

Egress-mode envs are **infra, not secrets** but follow the same `.env` hygiene. The
proxy/tunnel is a single seam in `client.ts` (§7); nothing else is aware of it.

**`src/config.ts` — `DataPaths`:** add `wechatTokenCache` =
`<baseDir>/wechat-token.json` (machine-local, off Drive). **No** `wechatProfileDir`
(no browser). No SQLite involvement — draft channels don't dedupe (consistent with
X/LinkedIn/Reddit `draft`).

**`src/commands/contentInput.ts`:** extend the docstring to list `wechat draft`
among the consumers (no code change — the resolver is already channel-agnostic).

**`.env.example`:** add the `WECHAT_*` keys with comments (including a commented
`WECHAT_PROXY_URL` / `WECHAT_SSH_TUNNEL` block explaining fixed-egress-IP mode).

## 7. File map (additions)

| Path | Purpose |
|---|---|
| `src/wechat/client.ts` | WeChat API backbone (auth analog of `session.ts`, no browser): stable-token fetch + machine-local cache, `uploadBodyImage` (`media/uploadimg`), `uploadCover` (`material/add_material`), `addDraft` (`draft/add`), `40164` egress-IP parsing, and the **single egress seam** — all requests go through one wrapper that honors `WECHAT_PROXY_URL` / `WECHAT_SSH_TUNNEL` (fixed-egress-IP mode, §3.3). Documents the FORBIDDEN `freepublish/*` + `message/mass/*` endpoints it must never call. |
| `src/wechat/egress.ts` | The proxy/tunnel helper feeding `client.ts`'s seam: build a `fetch` dispatcher for an `http(s)`/`socks5` proxy, or spawn+manage the `ssh -N -D` SOCKS5 tunnel for `WECHAT_SSH_TUNNEL` (start, wait-until-ready, tear down). Kept separate so `client.ts` stays a thin API layer and the tunnel lifecycle is testable in isolation. Needs `socks-proxy-agent` (or `undici` `ProxyAgent`) — see deps. |
| `src/wechat/content.ts` | `generateArticle` — canonical markdown → `{title, author, digest, html, coverPath, sourceUrl, bodyImages[], linkFlags, warnings[]}`. Reuses `parseBaseMarkdown`/`countChars` from `src/x/content.ts`; adds the `marked`-based inline-style renderer + link→citation transform. Deterministic, no LLM. |
| `src/wechat/draft.ts` | Orchestration ("poster" analog, no browser): upload cover + body images via `client.ts`, rewrite `<img>` srcs, assemble + send the `draft/add` payload. |
| `src/commands/wechat-check.ts` | `publish wechat check` — credential + token + IP-allowlist preflight through the configured egress (reports the IP the API actually sees; travel-aware `40164`). |
| `src/commands/wechat-draft.ts` | `publish wechat draft` command body. |

**Edits:** `src/cli.ts` (register the `wechat` group), `src/config.ts` (env +
`wechatTokenCache`), `src/commands/contentInput.ts` (docstring), `.env.example`,
and — at implementation time — `README.md`, `PRODUCT_SPEC.md`, `AGENTS.md`, and the
`skills/publish/*` capability layer.

**New dependencies:** `marked` (deterministic markdown → HTML; the renderer override
emits inline styles; no DOM library needed) and `socks-proxy-agent` (SOCKS5
dispatcher for fixed-egress-IP mode; `http(s)` proxies can use `undici`'s built-in
`ProxyAgent` instead). Both are inert when `WECHAT_PROXY_URL`/`WECHAT_SSH_TUNNEL`
are unset (Mode B).

## 8. Out of scope (follow-ups)

- **Themed rendering** — multiple themes (default/grace/simple/modern) + color
  presets. This phase ships one default inline-styled look.
- **Egress convenience beyond the core seam** — fixed-egress-IP mode itself is
  **in scope** (§3.3). Deferred are the *conveniences* around it: per-invocation
  `--remote-*` flag overrides (env config only this phase), a managed multi-hop
  `ProxyJump`, and auto-provisioning the VPS. The operator supplies a proxy/SSH
  target; the CLI just routes through it.
- **Image-text posts (图文 / `article_type=newspic`,** up to 9 images, no cover) —
  articles (`news`) only this phase.
- **Body-image auto-compression** and **remote-image download+reupload** — local,
  in-spec images only this phase (oversized/remote → ERROR/warning).
- **Multi-account** (an `accounts:` block selecting among several Official
  Accounts) — single account via env this phase.
- **WeChat WATCH / borrowed-reach** — WeChat has weak on-platform discovery
  (PRODUCT_SPEC §2.2); no read/monitor loop, consistent with LinkedIn/Reddit
  shipping PUBLISH-only.
- **Publishing / scheduled send** (`freepublish/*`) — the hard boundary; the
  human-gated send is future toolkit-wide scope (PRODUCT_SPEC §5), never this
  channel.

## 9. Open verification risks (verify live before claiming it works)

Compile-green + code review misses real bugs in these flows (AGENTS.md "Verify
live"). For WeChat the live surface is the API + the 草稿箱 preview, not a browser:

- **Field measurement and content limits remain unresolved.** The official title,
  author, and digest limits are 32/16/120 `字`, but exact Unicode measurement is
  unknown. Preserve sanitized live `errcode`s instead of guessing a local counter.
  The official HTML row also conflicts between 2 KB, 20,000 characters, and 1 MB.
- **Inline-style rendering.** WeChat's editor sanitizes *some* inline CSS. Stage a
  real draft and eyeball it in the 草稿箱 preview — headings, code blocks, lists,
  images, and citations must render as intended. This is the highest-risk item and
  cannot be caught by compile.
- **`stable_token` behavior** and the refresh-overlap window — confirm caching
  doesn't thrash and a stale cached token refreshes cleanly.
- **IP allowlist / `40164`.** Confirm the `errmsg` IP-parsing matches the live
  message format, and that `check` on a fresh network reports the correct IP.
  **Live observation (2026-07-04, through the GCP egress with *dummy* creds):** the
  legacy `GET /cgi-bin/token` returned `40013` (invalid appid) from a *non*-allowlisted
  IP — i.e. WeChat appears to validate credentials **before** the IP check on that
  path. So `check` must not treat "no `40164`" as "IP is allowlisted": use **real**
  creds and a call that reaches the IP gate, and only conclude ✓ allowlisted when a
  genuinely authenticated call succeeds (or explicitly handle the credential-error-first
  ordering). Re-confirm which endpoint (`stable_token` vs `token`) surfaces `40164` first.
- **Fixed-egress-IP mode (§3.3).** Verify that with `WECHAT_PROXY_URL` /
  `WECHAT_SSH_TUNNEL` set, WeChat sees the **proxy's** IP (not the laptop's) — e.g.
  `check` passes on a network whose raw IP is *not* allowlisted — and that the SSH
  tunnel starts, is waited-on until ready, and is torn down cleanly (no orphan `ssh`
  process, no `SOCKS proxy not ready` race). This is the linchpin of the automation
  goal and must be verified live, on an actually-changing network.

---

## Appendix A — Manually adding an IP to the allowlist (operator runbook)

> Reusable verbatim in the agent skill (`skills/publish/*`). This is the **one
> manual step** WeChat forces (§3.3): it needs the admin's WeChat app and cannot be
> automated. In fixed-egress-IP mode you do it **once**; in fallback Mode B you
> repeat it whenever the egress IP changes.
>
> **Console migration (effective 2025-12-01).** WeChat moved 开发接口管理 (which
> holds IP白名单) **out of `mp.weixin.qq.com` (设置与开发 → 开发接口管理) into the new
> 微信开发者平台 (WeChat Developer Platform, `developers.weixin.qq.com/platform/`).**
> The API itself (`api.weixin.qq.com`, the endpoints, AppID/AppSecret, `40164`) is
> unchanged — only the console UI where a human adds the IP relocated. Steps below
> target the new platform, with the legacy path kept as a fallback for accounts not
> yet migrated.

**What IP to add:**

- **Mode A:** the **fixed IP of your proxy/VPS** (Appendix B) — a value you already
  know from setup.
- **Mode B:** run `publish wechat check`; it prints *"WeChat sees this machine as
  `<a.b.c.d>`"* (parsed from the live `40164` message). Add exactly that.

**Steps (微信开发者平台 admin console):**

1. Sign in at **https://developers.weixin.qq.com/platform/** as the account
   **admin** (the allowlist confirmation is scanned by the admin's WeChat, so a
   non-admin login can't finish the confirm step). Select the target Official
   Account if you manage several.
2. Open **开发管理 → 开发接口管理 (Development → Development Interface Management)**
   and find **IP白名单 (IP whitelist)**. *(Legacy fallback for un-migrated accounts:
   `mp.weixin.qq.com` → 设置与开发 → 开发接口管理 → IP白名单, older layouts 基本配置.)*
3. Click **配置 / 修改 (Configure / Modify)**.
4. Enter the IP(s), **one per line**. Both single IPs (`203.0.113.7`) and CIDR
   ranges (`203.0.113.0/24`) are accepted. **Cap: 15 entries** — if full, delete a
   stale one first.
5. Click **确认修改 (Confirm changes)**.
6. **Scan the QR code with the admin's WeChat** to approve. *(This is the
   unavoidable human gate.)*
7. Changes take effect within ~seconds. Verify with `publish wechat check` (should
   now report ✓ allowlisted).

**Notes for the skill:**

- If `check`/`draft` returns `40164` after adding, re-read the reported IP — a VPN
  reconnect (Mode B) or a proxy change may have moved it again. Mode A is the fix
  for that churn.
- `40125`/`40013` mean bad `app_secret`/`app_id`, **not** an IP problem — don't
  touch the allowlist for those.

## Appendix B — Fixed-egress-IP setup for Mode A (free and paid options)

The requirement is simply: **one stable public IP you control, reachable from your
laptop, that can make outbound HTTPS to `api.weixin.qq.com`.** Allowlist it once
(Appendix A), point `WECHAT_PROXY_URL`/`WECHAT_SSH_TUNNEL` at it (§6), done.

**Free options (recommended):**

- **Google Cloud `e2-micro` "Always Free" VM — the operator's preferred route
  (provisioned + tunnel-verified 2026-07-04).** One `e2-micro` runs free in the
  eligible US regions (`us-west1` / `us-central1` / `us-east1`). Full CLI recipe,
  with three gotchas the skill must state:
  1. **Reserve the external IP as *static* and keep the instance *running*.** A
     static IP attached to a **running** Always-Free `e2-micro` is free; an
     **idle/stopped** reserved IP is billed (~US$7/mo).
  2. **Set Network Service Tier to Standard on *both* the address and the
     instance** (`--network-tier=STANDARD`) — the Always-Free egress allowance only
     covers Standard tier; a Premium-tier address is billed.
  3. **US-region only** → higher latency to WeChat's China endpoints, but fine for
     our small, async draft calls (a few API + image-upload requests, no realtime).
  Provision (Always Free requires a billing account linked to the project — the one
  console/credit-card step; there is no CLI to create a billing account):
  ```bash
  gcloud projects create <project> --name=<project>
  gcloud config set project <project>
  gcloud billing projects link <project> --billing-account=<ACCT-ID>
  gcloud services enable compute.googleapis.com
  gcloud compute addresses create wechat-egress --region=us-west1 --network-tier=STANDARD
  gcloud compute instances create wechat-egress \
    --zone=us-west1-b --machine-type=e2-micro --network-tier=STANDARD \
    --address=$(gcloud compute addresses describe wechat-egress --region=us-west1 --format='value(address)') \
    --image-family=debian-12 --image-project=debian-cloud
  gcloud compute firewall-rules create allow-ssh --allow=tcp:22
  ```
  The VM's outbound public IP **is** the reserved static IP — allowlist that value
  (Appendix A). Then tunnel with the built-in `gcloud` wrapper (no extra `sshd`
  config; it manages SSH keys on first run):
  ```bash
  gcloud compute ssh wechat-egress --zone us-west1-b --ssh-flag="-N" --ssh-flag="-D" --ssh-flag="1080"
  # then, in .env:  WECHAT_PROXY_URL=socks5://127.0.0.1:1080
  ```
  (Or set `WECHAT_SSH_TUNNEL=<user>@<static-ip>` and let `client.ts` manage the
  tunnel.) Verify egress: `curl --socks5-hostname 127.0.0.1:1080 https://api.ipify.org`
  must return the static IP (not the laptop's).
  ([configure static IP](https://docs.cloud.google.com/compute/docs/ip-addresses/configure-static-external-ip-address),
  [e2-micro guide](https://thedaryls.com/free-for-life-google-cloud-e2-micro-vps/))
- **Oracle Cloud "Always Free" VM — alternative, better China latency.** The
  Always-Free tier includes **1 permanent Reserved Public IP** plus an always-free
  VM, and lets you pick an **Asia home region** (Tokyo/Osaka/Singapore/Seoul) at
  signup — lower latency to WeChat than GCP's US-only free VMs. Same `sshd` +
  `ssh -N -D` model; set `WECHAT_SSH_TUNNEL=ubuntu@<reserved-ip>`. Home region and
  ARM capacity are fixed/constrained after signup.
  ([OCI free tier](https://www.oracle.com/cloud/free/),
  [Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm))

**Paid options (lower effort, no VPS to run):**

- **Dedicated-IP VPN add-on** (NordVPN / Surfshark / PIA, etc.) — a fixed IP bound
  to your VPN account. Since the operator already runs a VPN, this can be the
  least-effort route: allowlist the dedicated IP once, keep the VPN on, no server to
  maintain. Typically a few USD/month.
- **Any cheap fixed-IP VPS** (Hetzner / Vultr / DigitalOcean / Lightsail, ~US$4–6/mo)
  — same `sshd` + `ssh -N -D` setup as the Oracle box, without the free-tier
  capacity/region constraints.

**Doesn't fit — ngrok / Cloudflare Tunnel / other ingress tunnels.** These give a
stable *inbound* URL (traffic **into** your laptop). WeChat's allowlist checks the
**source IP of your *outbound* call** to `api.weixin.qq.com` — the opposite
direction. ngrok has no static-egress/source-IP product, so it cannot make WeChat
see a fixed IP. Mode A needs something that **originates outbound** from a stable
address (a VPS or dedicated-IP VPN), which ingress tunnels do not do.

**Avoid — free public/"open" proxies and free shared-VPN lists.** The IP is shared
and rotating (so *not* stable, defeating the point) and untrustworthy for a path
carrying an access token. Mode A needs an IP **you** control.

**Minimal `sshd`-box checklist (free/paid VPS):**

1. Create the VM; assign/attach the **reserved/static** public IP.
2. Security rule: allow inbound **TCP 22** from your networks (or anywhere, key-only
   auth).
3. Key-only SSH (`PasswordAuthentication no`); confirm `ssh ubuntu@<ip>` works
   non-interactively.
4. No extra software needed — `ssh -N -D` uses the stock `sshd` as a SOCKS5 proxy.
5. Set `WECHAT_SSH_TUNNEL=ubuntu@<ip>` (or run your own `-D` tunnel and set
   `WECHAT_PROXY_URL=socks5://127.0.0.1:<port>`), then `publish wechat check`.
6. Allowlist `<ip>` once (Appendix A).
- **`thumb_media_id`** validity + permanent-material quota consumption on repeated
  runs.
- **Link stripping** varies by account verification status — confirm the citations
  default renders correctly for the operator's account type.
- **The boundary.** Verify a run stages into 草稿箱 and that **no** `freepublish/*`
  call is ever made (grep the code; watch the network in a dry run of the real
  path).

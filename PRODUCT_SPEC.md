# publish-cli — Product Specification

> A per-channel content distribution toolkit for growing the operator's audience in the AI community.
> CLI binary: `publish`. Ships the **X channel** (session + watcher + publisher) and a **LinkedIn PUBLISH** channel (`publish linkedin draft`, live-verified 2026-07 — a native feed-post draft, never posts). LinkedIn WATCH remains future scope.
>
> **X auth backbone:** unattended **credential auto-login** through a **persistent Playwright browser profile** — credentials from `.env`, no pasted cookies. **One login event feeds two consumers, and BOTH drive the same logged-in browser:** the watcher reads by navigating X in that browser and **capturing X's own GraphQL responses** (`SearchTimeline` / `ListLatestTweetsTimeline`) off the wire; the publisher drives the same profile's composer. The publisher creates **native drafts on X** (typed into X's own composer and saved as drafts), never local copy-paste files, and **never clicks Post**. (X gates every authenticated read behind a per-request `x-client-transaction-id` that only X's own page JS can mint, so out-of-band HTTP clients like `agent-twitter-client` / `twikit` were abandoned — driving the real browser is the only reliable read path.)

---

## 1. Vision

The goal is **audience growth and distribution**, not authoring. The operator already produces high-signal long-form thinking on AI agents, enablement, and engineering practice. The bottleneck is reach: good writing that nobody encounters does not compound.

**Why publishing alone is insufficient at cold start.** Pushing owned content into a feed assumes the feed already routes attention to you. At cold start it does not — there is no follower graph, no engagement history, and the ranking systems have no reason to surface your posts. Publishing into a vacuum produces near-zero distribution regardless of quality. Reach has to be *borrowed* first: you show up with additive, high-fit contributions inside conversations that **already have an audience** (popular posts, active threads, relevant searches), and you convert a slice of that borrowed attention into followers who will then see your owned content. Distribution is therefore two coupled motions — **publish** (owned) and **watch + engage** (borrowed) — and the toolkit treats them as first-class peers, not as a posting tool with monitoring bolted on.

publish-cli operationalizes this: each channel exposes a way to **publish** owned content and (optionally) a way to **watch** for borrowed-reach opportunities, and a task layer composes channels in parallel so a single piece of canonical content fans out across the AI community's surfaces.

---

## 2. Per-Channel Architecture

### 2.1 Capability model

Every channel is a module exposing up to two capabilities:

- **PUBLISH** (required): transform a canonical draft into channel-ready artifacts and (eventually) post them.
- **WATCH** (optional): monitor channel-native origins (accounts, queries, communities) for follow-up opportunities, triage them cheaply, and surface ranked candidates.

Channels are uniform behind these two capabilities. The **task layer** composes channels in **parallel**: one canonical draft can be tailored and published across all PUBLISH-capable channels concurrently, and all WATCH-capable channels can poll concurrently and merge their candidate streams. Each channel encapsulates its own auth, rate limits, formatting rules, and feasibility constraints, so the task layer never needs channel-specific logic.

```
                      ┌──────────── task layer (parallel composition) ────────────┐
                      │                                                            │
   canonical draft ──▶│  fan-out: tailor + publish across PUBLISH channels         │──▶ platform artifacts / posts
                      │  fan-in:  poll + triage across WATCH channels              │──▶ ranked follow-up candidates
                      │                                                            │
                      └────────────────────────────────────────────────────────────┘
        channels:  X      LinkedIn      Reddit      小红书      微信公众号
                   ▲ publish + watch    each channel = self-contained capability module
```

### 2.2 Target channels and feasibility

| Channel | Publish feasibility | Watch feasibility | Notes |
|---|---|---|---|
| **X (Twitter)** | Browser-driven (Playwright, native drafts) | Browser-driven (Playwright, GraphQL-response capture) | No official API key. A persistent Playwright profile auto-logs-in from `.env` credentials; the **publisher drives that profile** to create native drafts, and the **watcher drives the same profile** to read — navigating the search/List page and **capturing X's own `SearchTimeline` / `ListLatestTweetsTimeline` GraphQL responses** off the wire (out-of-band cookie clients like `agent-twitter-client` no longer work; see legend). **This deliverable.** |
| **Reddit** | Programmable (API) | Programmable (API) | Official API; subreddit + search monitoring is well-supported. Phase 2. |
| **微信公众号 (WeChat Official Account)** | Programmable (API) | Limited | Official Account API supports draft + publish. Discovery/watch is weak on-platform. Phase 3. |
| **LinkedIn** | Browser-driven (Playwright) — **PUBLISH built + live-verified 2026-07** | Browser-driven — Phase 2 | No friendly write API for personal posting; reuses the X persistent-profile pattern with its own `li-profile` session. `publish linkedin draft` stages a native feed-post draft (never posts). WATCH still Phase 2. |
| **小红书 (Xiaohongshu)** | Browser-driven (Playwright) | Browser-driven | No public posting API; persistent browser profile. Phase 3. |

**Feasibility legend.** "Programmable (API)" = automatable end-to-end against a stable official API. "Browser-driven (Playwright)" = no stable write/read API, so the channel is automated by **driving a persistent, already-logged-in browser profile** — for writes, type into the platform's own composer and save native drafts (not ready-to-paste files); for reads, navigate the platform and **capture its own GraphQL responses off the wire**. X is the reference implementation of the browser-driven pattern that LinkedIn and 小红书 reuse later. (X's read path was originally planned as an out-of-band cookie client against an unofficial endpoint — "Programmable (cookies)" — but X now gates every authenticated read behind a per-request `x-client-transaction-id` that only its page JS can mint, defeating `agent-twitter-client` / `twikit`; reads therefore moved into the browser too.)

---

## 3. The Two-Loop Model

Distribution runs as two symbiotic loops sharing one canonical content store.

### 3.1 Owned-content loop (publish)

```
author ──▶ tailor-per-platform ──▶ publish ──▶ log
   ▲                                              │
   └──────────────── feeds future authoring ◀─────┘
```

- **author** — the operator writes a canonical base draft (markdown) under `<date>-<slug>/` in the caller-supplied data repo.
- **tailor-per-platform** — the channel's PUBLISH capability transforms the base draft into surface-specific content (for X: tweet / thread / Article).
- **publish** — the content is **staged as a native draft on the platform**. For X, the publisher types the tailored content into X's own composer and saves it as a draft — **one click from publishing**, but it **never clicks Post** (the actual Post is future scope behind the SEND-GATE, §5).
- **log** — the published item is recorded in Notion as the durable post-publish record (after a human posts).

### 3.2 Borrowed-reach / watch loop (engage)

```
monitor target accounts + search queries
        │
        ▼
cheap-LLM triage (fit, timeliness, unique value)
        │
        ▼
draft additive reply  ──▶  human sends  ──▶  measure
        ▲                                       │
        └────────── informs which origins to watch ◀┘
```

- **monitor** — pull recent posts from watch Lists (accounts grouped into a List) and search queries.
- **triage** — a cheap LLM scores each item for follow-up fit (timeliness, relevance, whether the operator can add unique value).
- **draft additive reply** — generate a reply that genuinely adds value (not a drive-by).
- **human sends** — the send action is gated on human approval (see §5).
- **measure** — track outcomes to refine targets and queries.

### 3.3 Why they are symbiotic

The watch loop earns the borrowed attention that the owned loop needs to land. The owned loop produces the credibility and back-catalog that make watch-loop replies worth following. Watch-loop measurement tells the owned loop what topics resonate; owned-loop output gives the watch loop something substantive to point back to. Neither works alone at cold start.

---

## 4. Canonical Content Source of Truth

The **single source of truth for content is the local markdown filesystem**, not Notion.

- Canonical drafts live under a per-article folder `<date>-<slug>/` inside the **caller-supplied data repo** (configurable via env `PUBLISH_DATA_REPO`, or a `.agents/workspace.yaml` walk-up; never a hardcoded personal path — see `skills/publish/SETUP.md`).
- Each article folder holds the **base draft**, images, prompts, and notes together (per that directory's `AGENTS.md` workflow).
- publish-cli **reads** the canonical base draft from this folder. It does **not** write platform-variant files here as the primary output: the X publisher's real output is a **native draft created on X itself** (typed into X's composer, saved unsent). The canonical folder stays the human-owned drafting surface; the platform draft lives on the platform.
- The generated tweet/thread/Article content can optionally be echoed to disk for inspection (notably in `--dry-run`, which never touches the browser), but that is a debug artifact, not the deliverable.
- **Notion is the post-publish record**, the durable final publication log — not the drafting or co-editing surface. publish-cli does not draft in Notion. The owned-content loop only writes to Notion at the **log** step, after a human has posted.

```
<data-repo>/2026-06-29-agent-enablement/
  agent-enablement-base.md        ← canonical source (READ by publish-cli)
  technical-visual.png            ← becomes a screenshot/image for code blocks
  thumbnail-illustration.png
  (the X tweet/thread/Article ends up as a NATIVE DRAFT on x.com, not a file here)
```

### 4.1 Runtime data lives off Google Drive

The canonical content folder lives in a local, caller-supplied data repo (**not** on a cloud-synced path). publish-cli's **runtime state** — the persistent Playwright profile, the exported cookie cache, and the better-sqlite3 dedupe DB — also lives off any cloud-synced path, under a configurable **`PUBLISH_DATA_DIR`** (default a local app-data path). Reasons:

- The persistent browser profile and SQLite file are mutated continuously and tolerate no cloud-sync races, file-lock contention, or partial uploads.
- Cookies and a logged-in profile are **secrets**; they must not be replicated into any cloud-synced location.
- This keeps the "scratchpad" (local) cleanly separated from any archival surface (a cloud-synced drive is an archive only, never touched by this tool).

---

## 5. Human-Approval SEND-GATE (FUTURE SCOPE — do not build now)

> This section documents the autonomy end-game. **It is explicitly out of scope for this deliverable.** The X publisher in this deliverable produces drafts only and **never posts**.

The agent may **scout, triage, and draft autonomously**, but the **`send` action always pauses for human approval**. This is the **contact-operator pattern**:

1. The agent prepares exactly what it is about to publish (the full artifact + target + context).
2. **In headless mode**, it posts a **Discord** message describing the pending action.
3. It **waits ~2 minutes** for a human approval/rejection.
4. If no response within the window, it **escalates to a phone call**.
5. Only on explicit approval does the send proceed; otherwise it holds.

This gate applies uniformly to both loops' send actions (owned publish and watch-loop replies) once automation lands. Until then, every posting path stops at "draft ready for human."

---

## 6. X Module Specification (BUILD NOW)

The X module has three parts, layered so a **single login event feeds two consumers** — and **both consumers drive the same logged-in browser**:

1. **Session** (the backbone) — unattended credential auto-login through a persistent Playwright profile; exposes the shared logged-in browser context via `getBrowserContext()`. (It also still harvests `auth_token`/`ct0` cookies to a cache file, but nothing consumes them for reads anymore — see §6.1.)
2. **Watcher** — drives the shared browser context: navigates the search/List page and **captures X's own GraphQL responses** (`SearchTimeline` / `ListLatestTweetsTimeline`) off the wire, then walks the JSON for tweets — dedupes and triages.
3. **Publisher** — drives the same persistent profile's composer to create **native drafts on X**, never posting.

```
        .env credentials (X_USERNAME / X_PASSWORD / X_EMAIL)
                            │
                            ▼
              ┌──────── SESSION (Playwright) ────────────┐
              │  persistent profile  <dataDir>/x-profile  │
              │  auto-login → persist profile;            │
              │  expose shared logged-in browser context  │
              │  (also harvests auth_token/ct0 → cache,   │
              │   but NOT used for reads)                 │
              └───────────────┬───────────────┬──────────┘
                              │               │
       getBrowserContext() ───┴───────────────┘  (same logged-in browser)
                              │               │
                              ▼               ▼
                  WATCHER (Playwright)     PUBLISHER (Playwright)
                  navigates X + CAPTURES   types into X composer,
                  GraphQL responses        saves NATIVE DRAFT (no Post)
                  (SearchTimeline /
                   ListLatestTweetsTimeline)
```

### 6.1 Session & authentication (the backbone — BUILD FIRST)

The session module is the foundation everything else depends on. It performs **unattended credential auto-login** and persists the result so later runs are already authed.

**Credentials (from `.env`)**
- **`X_USERNAME`**, **`X_PASSWORD`**, **`X_EMAIL`** — full credentials, no pasted cookies. (No 2FA on this account — but the login flow must still answer X's email/identifier **confirmation challenge** using `X_EMAIL`.)

**Persistent Playwright profile**
- Use **Playwright** with a **persistent browser context** rooted at a **user-data-dir under `PUBLISH_DATA_DIR`** (e.g. `<dataDir>/x-profile`).
- Prefer **`channel: 'chrome'`** to drive an installed Chrome and **avoid downloading Chromium** where feasible; **fall back to bundled Chromium** when Chrome is unavailable.
- Because the profile is persistent, once logged in the profile *stays* logged in — subsequent runs reuse it without re-authenticating.

**Login flow** (`x.com/login`)
1. Open `x.com/login`.
2. Fill the **username/handle**.
3. Handle the possible **"enter your email or phone to confirm"** interstitial using **`X_EMAIL`** (X frequently injects this identifier-confirmation step).
4. Fill the **password**.
5. Land logged in; verify before proceeding.

**Shared browser context & API surface**
- After a successful login, the **same logged-in persistent profile** is the single shared resource for both consumers.
- The module exposes:
  - **`ensureSession()`** — guarantees a valid logged-in session, **re-logging-in only if the persisted session is invalid** (cheap no-op when the profile is already authed).
  - **`getBrowserContext()`** — returns the live, logged-in **persistent Playwright `BrowserContext`** for both the watcher (read) and the publisher (write) to drive. The caller must not close it directly; use `closeSession()` so the shared handle is cleared.
- **Cookie harvest (retained, but NOT the read path):** after login the module still **harvests `auth_token` + `ct0` (and the rest)** to a cookie cache file under `PUBLISH_DATA_DIR` and exposes **`getCookies()`**. This was the original read mechanism, but **nothing consumes it for reads anymore** — it is kept only as a session-validity signal / potential future use. (`getCookies()` is not used by the watcher.)
- **One login, two consumers:** **both** the watcher and the publisher drive the **same persistent browser context** via `getBrowserContext()`. There is exactly one place that authenticates.

**Selector resilience (honest caveat)**
- **X's login DOM drifts** and is the most fragile surface in the whole tool. Login selectors must be **centralized and configurable** in one place, and **tolerant**: try **multiple selector strategies** (role/text/test-id/CSS fallbacks) with **explicit waits** rather than fixed sleeps.
- Provide an **`--inspect` / headful mode** so a human can watch the flow and recalibrate. Comments in the selector module must be **explicit that the selectors are best-effort and need live calibration** against the current X UI.

### 6.2 X Watcher

**Reader / auth (reuse the session — do NOT re-login)**
- The reader drives the **shared logged-in browser context** from the session module (`getBrowserContext()`). It does **NOT** use `agent-twitter-client`, `twikit`, or any out-of-band cookie-injection HTTP client, and never performs its own login.
- **Why the browser, not cookies.** X gates every authenticated read behind a per-request **`x-client-transaction-id`** that only X's own page JS can mint. Out-of-band HTTP clients can't generate it: `agent-twitter-client` 401s and `twikit` can't bootstrap the transaction-id. Driving the real logged-in browser sidesteps this — X mints the transaction-ids natively — and unifies the X channel on one mechanism (the same persistent profile the publisher drives).
- **How it reads (GraphQL-response capture).** Rather than scrape the fragile DOM, the reader (`src/x/reader.ts`, class `BrowserReader`) **navigates** to the search / List URL and **captures X's own GraphQL responses off the wire** — listening for the `SearchTimeline` / `ListLatestTweetsTimeline` operations on `/graphql/` — then **walks the JSON** for tweet results (identified by `legacy.full_text` + an id, wherever they nest). It scrolls to lazy-load more until it hits the requested limit or the feed stops growing. The JSON shape is far more stable than the rendered DOM and carries clean metrics.

**Fetch methods → normalized posts**
- **`fetchSearch(query)`** — recent posts matching a search query (origin = query).
- **`fetchListTimeline(listId)`** — the merged recent timeline of every member of an X List in ONE fetch (origin = `list:<id>`). This is the account-watch path: N accounts in a List cost one page load instead of N profile loads (there is no per-account fetch — that doesn't scale and reads as bot traffic).
- Both map every result to a **normalized post** shape kept in one place so the rest of the loop stays client-agnostic:
  **`{ id, author, text, createdAt, url, metrics }`** (metrics = likes / reposts / replies / views where available), plus an `origin` for provenance.

**Inputs**
- A list of search **QUERIES** and a list of X **LISTS** (ids). Accounts are watched via a List, built with `publish x create-watch-list`; there is no per-account origin.
- Sourced from a **`watch.yaml`** config (ship a committed **`watch.yaml.example`**) and/or CLI flags (`--query`, `--x-list`). Flags and config merge; flags add to config. The config is **schema-validated** on load (unknown keys / wrong types fail loudly before the browser opens).

**`watch.yaml` (example shape)**
```yaml
queries:
  - "agent skills"
  - "context engineering LLM"
lists:
  - "1700000000000000000"
```

**Pull**
- Fetch **recent posts** from each watch List and each search query.

**Dedupe**
- Store seen posts in a **`better-sqlite3`** store (**`src/db.ts`**) keyed by tweet id (with origin, author, timestamp, captured text). The DB file lives under **`PUBLISH_DATA_DIR`** (off Google Drive).
- Repeated polls **only surface new items**; previously-seen posts are filtered out.

**Triage**
- Invoke a **cheap Gemini model** to score each new post for follow-up worthiness:
  - **fit** — relevance to the operator's topics/voice,
  - **timeliness** — is the conversation still live,
  - **unique value** — can the operator add something genuinely additive.
- Default model id **`gemini-3.5-flash`**, configurable via **`TRIAGE_MODEL`** (env/config).
- Use a **minimal / low thinking budget** (triage is cheap and high-volume).
- Each scored item yields: **`{ postId, score (0–1), reason, suggestedAngle }`**.

**Output**
- A **ranked list of follow-up candidates** emitted in two forms:
  - **human-readable text** by default (ranked, with score, origin, author, link, reason, and suggested angle), and
  - **machine JSON** under **`--json`** (for the task layer), rendered from the same stable schema.

### 6.3 X Publisher (creates NATIVE DRAFTS ON X — never posts)

Takes a **canonical base draft** (a markdown file path, `--from`), generates X-ready content **deterministically**, then **drives the persistent logged-in profile to create a native draft on X**. It **never clicks Post**.

#### Content generation (deterministic, plain code)

From the canonical base markdown, produce one of three formats (`--format`):
- **`tweet`** — a single tweet, **character-validated**. Default limit **280**; **`--long`** raises it to the Premium long-post cap (configurable, default up to **25000**).
- **`thread`** — a **hook-first** ordered split into multiple posts, **each within the limit**, **numbered/sequenced** (the strongest opener leads).
- **`article`** — long-form **Article** markdown suitable for X's Articles composer.

Generation rules (all in plain code, **not** an LLM, so output is reproducible and verifiable):
- **Character counting**, limit validation, and thread splitting are deterministic.
- **X does not render code blocks** — generation must **flag where each code block must become a screenshot/image** rather than inline text (the matching image typically already lives in the canonical folder).
- **Links cost reach** — surface every link with **placement notes** (e.g. keep links out of the opening tweet; move them to a reply or the end).

#### Draft creation (Playwright, on the persistent logged-in profile)

- Reuse the **same persistent profile** the session module logged in (no second login).
- Open the **X composer** and **type the generated content** into it:
  - **tweet** → the composer text box.
  - **thread** → add each post in order via the composer's "add post" affordance.
  - **article** → use the **Articles composer** for long-form.
- **Save it as a native draft / leave it unsent** so it sits **one click from publishing**.
- It **MUST NOT publish / click Post.** Stopping at "draft on X" is the hard boundary of this deliverable (the Post action is future scope behind the SEND-GATE, §5).

#### Modes & selector resilience

- **`--dry-run`** — generate content **only**; **never touches the browser**. Reports **where the generated content was written** (a debug echo to disk) so a human can inspect it without staging a draft.
- **`--inspect`** — headful run so a human can watch/calibrate the composer interaction.
- **Composer selectors are centralized** (alongside the login selectors) and **commented clearly as best-effort, needing live calibration** — X's composer DOM drifts like its login DOM.

#### Result reporting

- On a normal run, report that the **draft was staged on X** (format + post/segment count).
- On **`--dry-run`**, report **where the content was written** for inspection.

---

## 7. CLI Surface

All commands live under the **`publish`** binary (built with **commander**).

| Command | Purpose |
|---|---|
| `publish x create-watch-list [--from-following] [--handle <h>] [--name <n>] [--x-list <id>] [--private\|--public] [--limit <n>] [--dry-run] [--json] [--inspect]` | Build/populate the account-watch List from the accounts `--handle` follows (default: logged-in `X_USERNAME`), then read `member_count` back to verify. Precursor to `watch --x-list`. Never posts (writes List membership only). |
| `publish x watch [--query <q>...] [--x-list <id>...] [--persona <text>] [--config <watch.yaml>] [--no-triage] [--json] [--inspect]` | Read recent posts from watched queries/Lists (by driving the session's shared logged-in browser and capturing X's `SearchTimeline` / `ListLatestTweetsTimeline` GraphQL responses), dedupe in SQLite, triage with the cheap Gemini model, emit ranked follow-up candidates (human text by default, machine JSON with `--json`). Accounts are watched via a List, not one-by-one. X is anti-headless, so unattended runs currently need `--inspect` (headful). |
| `publish x draft --from <base.md> --format <tweet\|thread\|article> [--long] [--dry-run] [--inspect]` | Generate X content from a canonical base draft and **stage it as a native draft on X** via the persistent logged-in profile. Never posts. `--dry-run` generates content only (no browser); `--inspect` runs headful for calibration. |
| `publish --help` | Must work and list the above commands and options. |

**Flag notes**
- `--query` / `--x-list` are repeatable and merge with `watch.yaml`.
- `--config` overrides the default `watch.yaml` path.
- `--json` switches `watch` output to machine JSON.
- `--long` raises the tweet limit to the configurable Premium long-post cap.
- `--dry-run` (`draft x`) generates content without touching the browser; reports where content was written.
- `--inspect` (both commands' browser paths) runs headful so a human can watch/calibrate drift-prone selectors.

**Auth is implicit.** Both commands obtain the shared logged-in browser via `getBrowserContext()`, which calls `ensureSession()` first; it auto-logs-in from `.env` credentials only if the persistent profile is invalid. There is no cookie-paste step and no per-command login flag. (The watcher reads by capturing X's GraphQL responses in that browser, not via harvested cookies — see §6.2.)

---

## 8. Phased Roadmap

| Phase | Scope | Capabilities | Send automation |
|---|---|---|---|
| **Phase 1 — X (this deliverable)** | X channel only | SESSION (persistent Playwright profile, credential auto-login, shared logged-in browser context) → WATCH (browser GraphQL-response capture + dedupe + Gemini triage) and PUBLISH (native X drafts: tweet / thread / article) | None — drafts only, no posting |
| **Phase 2 — Reddit + LinkedIn (browser)** | Add Reddit (API, publish + watch) and LinkedIn (Playwright persistent profile, publish + watch). **LinkedIn PUBLISH (`draft`) landed early — built + live-verified 2026-07; LinkedIn WATCH + Reddit remain.** | Extend task-layer parallel composition across X + Reddit + LinkedIn; LinkedIn reuses the X persistent-profile pattern (its own `li-profile` session) | None — native drafts only |
| **Phase 3 — 小红书 + WeChat** | Add 小红书 (Playwright persistent profile) and 微信公众号 (API publish) | Full 5-channel fan-out | None — native drafts only |
| **Phase 4 — Send automation + measurement** | Wire the **SEND-GATE** (§5: Discord → wait ~2min → phone escalation) and outcome **measurement** into both loops | Autonomous scout/triage/draft with human-approved send; measure borrowed-reach conversion | Human-approved sends enabled |

**Sequencing rationale.** X first because it is the densest AI-community surface **and** because its **browser-backed session is the reusable backbone**: the persistent-profile auto-login pattern built here is what LinkedIn (Phase 2) and 小红书 (Phase 3) inherit, and the one-login-two-consumers split (browser GraphQL capture for read, composer for write) generalizes to any no-official-API channel. Reddit and LinkedIn come next to broaden borrowed reach (Reddit via official API, LinkedIn via the X browser pattern). 小红书 and WeChat extend into Chinese-language audiences. Send automation and measurement come last, after the drafting and watch loops are trusted, because the send-gate is where autonomy meets risk and must be deliberately gated.

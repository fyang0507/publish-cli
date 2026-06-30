# publish-cli — Product Specification

> A per-channel content distribution toolkit for growing Fred's audience in the AI community.
> CLI binary: `publish`. This deliverable ships the **X channel only** (session + watcher + publisher).
>
> **X auth backbone:** unattended **credential auto-login** through a **persistent Playwright browser profile** — credentials from `.env`, no pasted cookies. **One login event feeds two consumers:** the watcher reads via the harvested cookies; the publisher drives the same logged-in profile. The publisher creates **native drafts on X** (typed into X's own composer and saved as drafts), never local copy-paste files, and **never clicks Post**.

---

## 1. Vision

The goal is **audience growth and distribution**, not authoring. Fred already produces high-signal long-form thinking on AI agents, enablement, and engineering practice. The bottleneck is reach: good writing that nobody encounters does not compound.

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
| **X (Twitter)** | Browser-driven (Playwright, native drafts) | Programmable (cookies harvested from the login) | No official API key. A persistent Playwright profile auto-logs-in from `.env` credentials; the **publisher drives that profile** to create native drafts, and the **watcher reads via the harvested session cookies** (`agent-twitter-client`). **This deliverable.** |
| **Reddit** | Programmable (API) | Programmable (API) | Official API; subreddit + search monitoring is well-supported. Phase 2. |
| **微信公众号 (WeChat Official Account)** | Programmable (API) | Limited | Official Account API supports draft + publish. Discovery/watch is weak on-platform. Phase 3. |
| **LinkedIn** | Browser-driven (Playwright) | Browser-driven | No friendly write API for personal posting; reuse the X pattern — a persistent logged-in browser profile drives publish + watch. Phase 2. |
| **小红书 (Xiaohongshu)** | Browser-driven (Playwright) | Browser-driven | No public posting API; persistent browser profile. Phase 3. |

**Feasibility legend.** "Programmable (API)" = automatable end-to-end against a stable official API. "Programmable (cookies …)" = automatable against an unofficial endpoint using a logged-in session's cookies. "Browser-driven (Playwright)" = no stable write API, so the channel is automated by **driving a persistent, already-logged-in browser profile** (type into the platform's own composer, save native drafts) — not by producing ready-to-paste files. X is the reference implementation of the browser-driven pattern that LinkedIn and 小红书 reuse later.

---

## 3. The Two-Loop Model

Distribution runs as two symbiotic loops sharing one canonical content store.

### 3.1 Owned-content loop (publish)

```
author ──▶ tailor-per-platform ──▶ publish ──▶ log
   ▲                                              │
   └──────────────── feeds future authoring ◀─────┘
```

- **author** — Fred writes a canonical base draft (markdown) under `publish/<date>-<slug>/`.
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

- **monitor** — pull recent posts from watched accounts and search queries.
- **triage** — a cheap LLM scores each item for follow-up fit (timeliness, relevance, whether Fred can add unique value).
- **draft additive reply** — generate a reply that genuinely adds value (not a drive-by).
- **human sends** — the send action is gated on human approval (see §5).
- **measure** — track outcomes to refine targets and queries.

### 3.3 Why they are symbiotic

The watch loop earns the borrowed attention that the owned loop needs to land. The owned loop produces the credibility and back-catalog that make watch-loop replies worth following. Watch-loop measurement tells the owned loop what topics resonate; owned-loop output gives the watch loop something substantive to point back to. Neither works alone at cold start.

---

## 4. Canonical Content Source of Truth

The **single source of truth for content is the local markdown filesystem**, not Notion.

- Canonical drafts live under: `/Users/fredy/Downloads/fred-agent/publish/<date>-<slug>/`
- Each article folder holds the **base draft**, images, prompts, and notes together (per that directory's `AGENTS.md` workflow).
- publish-cli **reads** the canonical base draft from this folder. It does **not** write platform-variant files here as the primary output: the X publisher's real output is a **native draft created on X itself** (typed into X's composer, saved unsent). The canonical folder stays the human-owned drafting surface; the platform draft lives on the platform.
- The generated tweet/thread/Article content can optionally be echoed to disk for inspection (notably in `--dry-run`, which never touches the browser), but that is a debug artifact, not the deliverable.
- **Notion is the post-publish record**, the durable final publication log — not the drafting or co-editing surface. publish-cli does not draft in Notion. The owned-content loop only writes to Notion at the **log** step, after a human has posted.

```
publish/2026-06-29-agent-enablement/
  agent-enablement-base.md        ← canonical source (READ by publish-cli)
  technical-visual.png            ← becomes a screenshot/image for code blocks
  thumbnail-illustration.png
  (the X tweet/thread/Article ends up as a NATIVE DRAFT on x.com, not a file here)
```

### 4.1 Runtime data lives off Google Drive

The canonical content folder is under `/Users/fredy/Downloads/fred-agent/publish/` (local, **not** Google Drive). publish-cli's **runtime state** — the persistent Playwright profile, the exported cookie cache, and the better-sqlite3 dedupe DB — also lives off Google Drive, under a configurable **`PUBLISH_DATA_DIR`** (default a local app-data path). Reasons:

- The persistent browser profile and SQLite file are mutated continuously and tolerate no cloud-sync races, file-lock contention, or partial uploads.
- Cookies and a logged-in profile are **secrets**; they must not be replicated into Drive.
- This keeps the "scratchpad" (local) cleanly separated from any archival surface (Drive is an archive only, never touched by this tool).

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

The X module has three parts, layered so a **single login event feeds two consumers**:

1. **Session** (the backbone) — unattended credential auto-login through a persistent Playwright profile; exports cookies.
2. **Watcher** — reads X via the harvested cookies (`agent-twitter-client`), dedupes, and triages.
3. **Publisher** — drives the same persistent profile to create **native drafts on X**, never posting.

```
        .env credentials (X_USERNAME / X_PASSWORD / X_EMAIL)
                            │
                            ▼
              ┌──────── SESSION (Playwright) ────────┐
              │  persistent profile  <dataDir>/x-profile │
              │  auto-login → persist profile + export   │
              │  cookies (auth_token, ct0)               │
              └───────────────┬───────────────┬─────────┘
                              │               │
            getCookies() ─────┘               └───── same logged-in profile
                              │                              │
                              ▼                              ▼
                  WATCHER (agent-twitter-client)     PUBLISHER (Playwright)
                  reads via injected cookies         types into X composer,
                                                     saves NATIVE DRAFT (no Post)
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

**Cookie export & API surface**
- After a successful login, **export the session cookies** (at minimum **`auth_token`** + **`ct0`**) to a **cookie cache file under `PUBLISH_DATA_DIR`**.
- The module exposes:
  - **`ensureSession()`** — guarantees a valid logged-in session, **re-logging-in only if the persisted session is invalid** (cheap no-op when the profile is already authed).
  - **`getCookies()`** — returns the harvested cookies for the watcher to inject.
- **One login, two consumers:** the watcher consumes `getCookies()`; the publisher reuses the **same persistent profile**. There is exactly one place that authenticates.

**Selector resilience (honest caveat)**
- **X's login DOM drifts** and is the most fragile surface in the whole tool. Login selectors must be **centralized and configurable** in one place, and **tolerant**: try **multiple selector strategies** (role/text/test-id/CSS fallbacks) with **explicit waits** rather than fixed sleeps.
- Provide an **`--inspect` / headful mode** so a human can watch the flow and recalibrate. Comments in the selector module must be **explicit that the selectors are best-effort and need live calibration** against the current X UI.

### 6.2 X Watcher

**Reader / auth (reuse the session — do NOT re-login)**
- The reader uses **`agent-twitter-client`** initialized with the **cookies harvested by the session module** (`getCookies()`).
- It must **inject those cookies** (e.g. build the cookie strings and call the client's `setCookies(...)`, verify with `isLoggedIn()`) and must **NOT** trigger `agent-twitter-client`'s own separate username/password login. The Playwright session module is the single authenticator; the watcher is a pure cookie consumer.
- Read **`agent-twitter-client`'s actual API from `node_modules`** for the correct method names and cookie-injection signature (the package's surface — `Scraper`, `setCookies`, `getCookies`, `isLoggedIn`, and its search / user-tweets methods — must be confirmed against the installed version, not assumed).

**Fetch methods → normalized posts**
- **`fetchSearch(query)`** — recent posts matching a search query (origin = query).
- **`fetchUserTimeline(handle)`** — recent posts from a user's timeline (origin = handle, no leading `@`).
- Both map every result to a **normalized post** shape kept in one place so the rest of the loop stays client-agnostic:
  **`{ id, author, text, createdAt, url, metrics }`** (metrics = likes / reposts / replies / views where available), plus an `origin` for provenance.

**Inputs**
- A list of search **QUERIES** and a list of X **ACCOUNTS** (handles).
- Sourced from a **`watch.yaml`** config (ship a committed **`watch.yaml.example`**) and/or CLI flags (`--query`, `--account`). Flags and config merge; flags add to config.

**`watch.yaml` (example shape)**
```yaml
queries:
  - "agent skills"
  - "context engineering LLM"
accounts:
  - swyx
  - simonw
```

**Pull**
- Fetch **recent posts** from each watched account and each search query.

**Dedupe**
- Store seen posts in a **`better-sqlite3`** store (**`src/db.ts`**) keyed by tweet id (with origin, author, timestamp, captured text). The DB file lives under **`PUBLISH_DATA_DIR`** (off Google Drive).
- Repeated polls **only surface new items**; previously-seen posts are filtered out.

**Triage**
- Invoke a **cheap Gemini model** to score each new post for follow-up worthiness:
  - **fit** — relevance to Fred's topics/voice,
  - **timeliness** — is the conversation still live,
  - **unique value** — can Fred add something genuinely additive.
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
| `publish watch x [--query <q>...] [--account <handle>...] [--config <watch.yaml>] [--json]` | Read recent posts from watched queries/accounts (via the session's harvested cookies), dedupe in SQLite, triage with the cheap Gemini model, emit ranked follow-up candidates (human text by default, machine JSON with `--json`). |
| `publish draft x --from <base.md> --format <tweet\|thread\|article> [--long] [--dry-run] [--inspect]` | Generate X content from a canonical base draft and **stage it as a native draft on X** via the persistent logged-in profile. Never posts. `--dry-run` generates content only (no browser); `--inspect` runs headful for calibration. |
| `publish --help` | Must work and list the above commands and options. |

**Flag notes**
- `--query` / `--account` are repeatable and merge with `watch.yaml`.
- `--config` overrides the default `watch.yaml` path.
- `--json` switches `watch x` output to machine JSON.
- `--long` raises the tweet limit to the configurable Premium long-post cap.
- `--dry-run` (`draft x`) generates content without touching the browser; reports where content was written.
- `--inspect` (both commands' browser paths) runs headful so a human can watch/calibrate drift-prone selectors.

**Auth is implicit.** Both commands call `ensureSession()` first; it auto-logs-in from `.env` credentials only if the persistent profile / cached cookies are invalid. There is no cookie-paste step and no per-command login flag.

---

## 8. Phased Roadmap

| Phase | Scope | Capabilities | Send automation |
|---|---|---|---|
| **Phase 1 — X (this deliverable)** | X channel only | SESSION (persistent Playwright profile, credential auto-login, cookie export) → WATCH (cookies + dedupe + Gemini triage) and PUBLISH (native X drafts: tweet / thread / article) | None — drafts only, no posting |
| **Phase 2 — Reddit + LinkedIn (browser)** | Add Reddit (API, publish + watch) and LinkedIn (Playwright persistent profile, publish + watch) | Extend task-layer parallel composition across X + Reddit + LinkedIn; LinkedIn reuses the X persistent-profile pattern | None — native drafts only |
| **Phase 3 — 小红书 + WeChat** | Add 小红书 (Playwright persistent profile) and 微信公众号 (API publish) | Full 5-channel fan-out | None — native drafts only |
| **Phase 4 — Send automation + measurement** | Wire the **SEND-GATE** (§5: Discord → wait ~2min → phone escalation) and outcome **measurement** into both loops | Autonomous scout/triage/draft with human-approved send; measure borrowed-reach conversion | Human-approved sends enabled |

**Sequencing rationale.** X first because it is the densest AI-community surface **and** because its **browser-backed session is the reusable backbone**: the persistent-profile auto-login + cookie-export pattern built here is what LinkedIn (Phase 2) and 小红书 (Phase 3) inherit, and the one-login-two-consumers split (cookies for read, profile for write) generalizes to any no-official-API channel. Reddit and LinkedIn come next to broaden borrowed reach (Reddit via official API, LinkedIn via the X browser pattern). 小红书 and WeChat extend into Chinese-language audiences. Send automation and measurement come last, after the drafting and watch loops are trusted, because the send-gate is where autonomy meets risk and must be deliberately gated.

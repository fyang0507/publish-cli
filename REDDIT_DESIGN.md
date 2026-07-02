# Design: Reddit self-post channel (`publish reddit discover` / `draft`)

> **Status:** design proposal (Phase 2, per [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) §8;
> the API-channel divergence this doc builds on was called in
> [LINKEDIN_DESIGN.md](./LINKEDIN_DESIGN.md) §3.1).
> **Scope:** the Reddit **PUBLISH** capability only, and within it **text /
> self-posts only**. Two actions: a read-only **`discover`** (report a
> subreddit's posting contract — subscribers, allowed types, rules,
> `post_requirements`, flairs) and **`draft`** — staging a native Reddit **draft**
> (subreddit + title + Markdown body + optional flair). Link/image/gallery posts,
> multi-subreddit repost in one command, and Reddit **WATCH** (monitoring →
> reply candidates) are separate designs (§8).
>
> **Hard boundary (unchanged):** the publisher stops at a **native draft staged
> on the platform**. It MUST NOT publish. Reddit's official API has a first-class
> **Draft** primitive (`POST /api/draft`) — drafts stay private until an explicit
> `submit`, which this channel **never implements**. So the boundary holds exactly
> as it does for X ("Unsent") and LinkedIn ("Save as draft"), and here it is even
> stronger: the submit endpoint is simply absent from the code, not a
> forbidden-button we must avoid clicking.

---

## 1. What a Reddit self-post is

The unit is a single **self-post (text post)** targeted at one **subreddit**:
a required **title**, a **Markdown body**, and — for most real subreddits — a
required **flair**, plus optional `nsfw`/`spoiler` flags.

Two things make Reddit unlike either channel we ship:

1. **It is closest to X, not LinkedIn — long-form and Markdown-native.** X's
   `content.ts` already treats long-form (the Article path) as first-class, and
   Reddit *renders Markdown natively* (the composer's "Switch to Markdown"
   toggle). So unlike LinkedIn — which flattens Markdown to plain text — Reddit
   keeps the Markdown body essentially **verbatim**. The content layer leans on
   X's parser and is closer to passthrough than to LinkedIn's emitter.
2. **The subreddit is a publication contract, not just a destination.** Each
   subreddit imposes its own rules: mandatory flair, title regex / required or
   banned prefixes (`[Tag]`), allowed post types (some ban self-posts, some ban
   links), body length floors/ceilings, and account karma/age gates. This axis
   does not exist for X or LinkedIn and is the main new complexity. Crucially,
   Reddit exposes these rules **programmatically** (§4), so we can validate a
   draft against the target subreddit's contract before staging it.

### 1.1 The workflow: discover → decide → draft

Because the subreddit is a contract, publishing is a **two-phase** flow, and the
judgment of *where* to post stays with the **consuming agent**, not this repo
(CLAUDE.md public-repo posture — editorial judgment lives in the agent
workspace):

1. **Agent proposes** candidate subreddits for a piece of content (its own
   knowledge / a `--search` query).
2. **`publish reddit discover <sub…>`** returns the **mechanical facts** for each
   candidate — subscribers, `submission_type` (any/self/link), `over18`, the
   `post_requirements` (flair required?, title regex, body limits), the flair
   templates, and the rules text. **No ranking, no LLM** — deliberately unlike
   `x watch`'s Gemini triage. The CLI reports; the agent judges.
3. **Agent decides** the target (and, for a repost, the *set* of targets and any
   per-subreddit tailoring).
4. **`publish reddit draft --subreddit <one>`** stages the native draft, enforcing
   that subreddit's contract (§4). **Repost = the agent loops step 4** over each
   chosen subreddit; the CLI stays single-target (§8).

How it differs from the X channel we already ship:

| Dimension | X (existing) | Reddit self-post (this design) |
|---|---|---|
| Transport | browser (persistent Playwright profile) | **official Reddit API (OAuth)** — no browser at runtime (§3) |
| Target | your own timeline | **a chosen subreddit** — required, with its own rules (§4) |
| Title | none | **required, ≤ 300 chars** (may face a subreddit title regex) |
| Body | tweet / thread / article | **single Markdown body, ≤ ~40 000 chars** |
| Formatting | plain (tweet) / rich (article) | **Markdown, kept ~verbatim** (Reddit renders it) — not flattened |
| Flair | n/a | **often mandatory** — validated & set via API |
| Flags | n/a | optional `--nsfw` / `--spoiler` |
| Media | article hero (5:2, required) | **none this phase** — self-post only (§8) |
| Draft boundary | native Unsent draft, never Post | native **API Draft**, `submit` never implemented |

## 2. CLI surface

Two actions. `discover` (read-only facts) precedes `draft` (write) — the agent
bridges them.

```
publish reddit discover <subreddit>...             # report each named subreddit's posting contract
                        [--search "<query>"]       # instead of/alongside names: list candidate subreddits (mechanical, no ranking)
                        [--json]                    # machine-readable facts for the agent to parse
```

`discover` is **facts only** — for each subreddit it fetches `about`
(subscribers, `submission_type`, `over18`), `post_requirements`, flair templates,
and rules text, and prints them (human table or `--json`). `--search` runs
Reddit's subreddit search and lists candidate names + subscriber counts — again
mechanical, **no LLM ranking** (the agent proposes and decides; §1.1). Read-only:
no draft, no dedupe state.

```
publish reddit draft --subreddit <name>            # target community (or from --from frontmatter)
                     --title "<title>"             # ≤300 chars (or derived from markdown H1)
                     (--text "<body>" | --from <base.md> | --from -)
                     [--flair <id|text>]           # flair template id, or text matched to a template
                     [--nsfw] [--spoiler]
                     [--dry-run]                   # generate + preflight-validate only; no write
                     [--login]                     # one-time headful OAuth consent (capture refresh token)
```

New channel group in `src/cli.ts`, mirroring `x` / `linkedin`:

```ts
const reddit = program.command("reddit")
  .description("Reddit channel: discover (subreddit facts) + draft (native self-post drafts via API, never posts)");
registerRedditDiscoverCommand(reddit);
registerRedditDraftCommand(reddit);
```

**Body input mirrors the rest of the toolkit** — the shared
`resolveContentInput` (`--text` | `--from <file>` | `--from -` stdin,
exactly-one-of). Because Reddit is long-form, `--from <base.md>` is the primary
path (an inline `--text` still works for short posts), which is the opposite
emphasis from LinkedIn but the same code.

**`--subreddit`, `--title`, and `--flair` may also come from Markdown
frontmatter** in the `--from` file (canonical-content metadata), with the flags
overriding. This keeps a self-post fully described by one canonical `.md`:

```markdown
---
subreddit: MachineLearning
title: "What we learned shipping an on-call triage agent"
flair: "Discussion"
---
# body markdown here…
```

There is **no `--media`** (self-post only, §8) and **no `--inspect`** (no
browser to inspect — `--login` is the one-time consent step, §3.2). `--dry-run`
still renders the post *and* runs the subreddit preflight (§4) without writing a
draft.

## 3. Architecture — an API channel, as the roadmap called

### 3.1 Why API, not browser (and how it satisfies the boundary)

[LINKEDIN_DESIGN.md](./LINKEDIN_DESIGN.md) §3.1 already drew the line: the
browser-profile session pattern preserves for **browser-driven** channels (X,
LinkedIn, 小红书) and **deliberately diverges for API channels** — Reddit was
named there as OAuth/token, "no browser, no shared-context duality." This design
fulfils that call. PRODUCT_SPEC §2.2/§8 concur: Reddit is "Programmable (API),
Phase 2."

Two properties make the API the right — and *safer* — choice here, where it
would be wrong for X:

- **Reddit's API is sanctioned.** Unlike X (whose HTTP surface is actively
  blocked, forcing the browser path), Reddit offers a first-party OAuth API. No
  anti-automation arms race, no selector drift, no headless-login captcha wall.
- **The draft boundary is intrinsic, not enforced by omission-of-a-click.** The
  Draft primitive (`POST /api/draft`) stages a real native draft (visible in
  Reddit's own Drafts list) that is private until `POST /api/submit`. We
  implement `create-draft` and preflight **only**; `submit` never exists in the
  codebase. The "never publish" guarantee is therefore structural.

### 3.2 Auth — a non-expiring, auto-refreshing refresh token

The operator's requirement was: adopt the API **iff** auth can last
indefinitely and auto-refresh. Reddit OAuth satisfies this exactly:

- Access tokens live **60 minutes**. Requesting the authorization-code grant with
  **`duration=permanent`** additionally returns a **refresh token that does not
  expire** (valid until the user revokes it, or ~1 year of *total* inactivity —
  a nightly-cron cadence keeps it alive indefinitely).
- The client transparently exchanges the refresh token for a fresh access token
  whenever the current one is near expiry. Fully unattended after a **one-time**
  consent.

**Flow.** Register a Reddit **"web app"** (gives a `client_id` + `client_secret`
+ a redirect URI). `publish reddit draft --login` runs the one-time consent:
open the authorize URL in the system browser, capture the `code` on a loopback
redirect (`http://localhost:<port>/callback`), exchange it for
`{ access_token, refresh_token, expires_at, scope }`, and persist that to a
**machine-local** token store (`<baseDir>/reddit-token.json`, `mode 0600`) — the
direct analog of X/LinkedIn's `--inspect` first-login + cookie cache. Every
subsequent run reads the store and auto-refreshes; no password is ever kept at
rest, and 2FA is handled entirely inside the browser consent. (A script-app
password grant was considered and rejected: it can't do unattended 2FA.)

Scopes requested: **`identity submit flair read history`** (`submit`+`flair` for
drafting/flair, `read` for `post_requirements`, `history`/`read` for listing
drafts on verify). Exact scope set for the Draft endpoints is a verification
item (§9).

### 3.3 HTTP client — thin and hand-rolled, not a wrapper

Use Node's global `fetch` behind a small authorized client rather than a
third-party wrapper (`snoowrap`/PRAW-equivalent). Rationale: (a) it keeps the
dependency surface lean, matching CLAUDE.md's "do not reintroduce out-of-band
libs" posture (sanctioned here, but the discipline stands); (b) it lets the code
implement **exactly** create-draft + preflight and *nothing that submits* —
tightening the hard boundary; (c) Reddit requires a descriptive `User-Agent` and
enforces ~100 QPM per OAuth client — both trivial to honor in a thin client, and
both things a heavy wrapper hides.

### 3.4 Content generation — reuse X's parser, keep the Markdown

Reddit is Markdown-native, so `src/reddit/content.ts` is closer to passthrough
than LinkedIn's flattener. It imports the channel-agnostic primitives from
`../x/content.ts` — `parseBaseMarkdown` (for the H1→title derivation, `codeFlags`,
`linkFlags`) and `countChars` (for the title/body caps) — and emits a
`GeneratedSelfPost` that carries the body **as Markdown** (§4). This honors the
operator's "Reddit ≈ X" framing at the content layer regardless of transport.

## 4. Content generation + subreddit-rules preflight (deterministic, no LLM)

`generateSelfPost(md, opts) -> GeneratedSelfPost` — same discipline as X/LinkedIn:
plain code, reproducible, verifiable, no LLM deciding content.

- **Title.** Required. From `--title`, else frontmatter `title`, else the
  Markdown H1 (via `parseBaseMarkdown`). Cap **300** code points (`countChars`);
  over cap → error, never silent truncation.
- **Body → Markdown, kept verbatim.** Reddit renders GFM-ish Markdown, so we do
  **not** flatten (the key divergence from LinkedIn). Strip only a leading H1 if
  it was consumed as the title. Cap **~40 000** code points; over cap → emit
  leading segment + warning.
- **Old-vs-new render advisory.** Per
  [PLATFORM_CAPABILITIES.md](./skills/publish/PLATFORM_CAPABILITIES.md): on
  old.reddit, fenced code + tables don't render — advise 4-space-indented code
  and caution on tables. Reuse `codeFlags` to surface this. Draft is created in
  **Markdown mode** so syntax is taken literally, not as rich-text.
- **Link advisory.** Reuse `linkFlags` (informational; Reddit has no
  LinkedIn-style reach penalty, but flags bare/duplicated URLs).

**Subreddit preflight (the new, load-bearing step).** Before staging, fetch and
enforce the target subreddit's contract:

- `GET /api/v1/{subreddit}/post_requirements` → `is_flair_required`,
  `title_regexes`, `title_required_strings`, `title_blacklisted_strings`,
  `body_restriction_policy`, `body_blacklisted_strings`, min/max body length,
  `guidelines_text`.
- Flair templates: `GET /r/{subreddit}/api/link_flair_v2` → resolve `--flair`
  text to a `flair_template_id` (or list valid choices on miss).

> **`discover` and `draft` share this fetch.** `discover` reports these facts for
> agent-proposed candidate subreddits (read-only, §1.1); `draft` re-runs the same
> fetch to *enforce* the contract on the chosen target. One `src/reddit/rules.ts`,
> two consumers.

Validate the generated post against these and **fail early with an actionable
message** — e.g. *"r/MachineLearning requires a flair; valid: Discussion,
Research, Project…"* or *"title must match `^\[D\]|\[R\]|\[P\]` "* — rather than
staging a draft the subreddit would reject. This is the API analog of X's
`watch.yaml` behavior layer: a per-target rules gate. `--dry-run` runs the full
preflight so the operator sees violations without any write. (Caveat: AutoMod
rules aren't exposed by `post_requirements` — preflight catches the
API-declared contract, not every mod filter; §9.)

## 5. Draft creation + the never-publish boundary

`stageDraft(post, opts) -> StageDraftResult` in `src/reddit/draft.ts`:

1. Authorized client from `src/reddit/auth.ts` (auto-refreshed access token).
2. **Preflight** (§4) — abort on any violation.
3. `POST /api/draft` with `{ subreddit, title, body_markdown (kind: self),
   flair_id?, nsfw?, spoiler?, is_public_link: false }`. This stages a native
   private draft.
4. **Verify:** `GET /api/v1/me/drafts` and confirm the new draft is present by id
   (port the X/LinkedIn "match the staged item, don't trust a blind success"
   hardening).
5. Return `{ kind: "self", draftId, verified, subreddit, flair, note }` with the
   old-reddit/link advisories folded into `note`.

**The submit path is intentionally not implemented.** There is no code calling
`POST /api/submit` or `Draft.submit`. The module's single write is
`create-draft`. This is the structural equivalent of X/LinkedIn's forbidden
Post selector — but stronger, because there is no affordance to mis-fire.

## 6. Config & state additions

- `PublishEnv`: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`,
  `REDDIT_REDIRECT_URI` (default `http://localhost:8765/callback`),
  `REDDIT_USER_AGENT` (Reddit mandates a descriptive UA) — added to
  `.env.example`. **No `REDDIT_PASSWORD`** (refresh-token flow, not password
  grant).
- `DataPaths`: `redditTokenCache` (`<baseDir>/reddit-token.json`, `mode 0600`) —
  machine-local, **off Google Drive**, same posture as the cookie caches. **No
  `reddit-profile`** — there is no browser profile for an API channel.
- No `watch.yaml` changes (publish-only). No change to
  `scripts/install-agent-skill-symlinks.js` (Reddit lives inside the existing
  `publish` skill).

## 7. File map (additions)

| Path | Purpose |
|---|---|
| `src/reddit/auth.ts` | OAuth: `--login` consent (loopback capture), token store, auto-refresh, authorized `fetch` client (UA + rate-limit aware) |
| `src/reddit/rules.ts` | subreddit facts + preflight: fetch `about` / `post_requirements` / flair templates / rules; validate a post; resolve flair text → id. **Shared by `discover` and `draft`** |
| `src/commands/reddit-discover.ts` | `registerRedditDiscoverCommand`; read-only facts report (`--search` / `--json`) over `rules.ts` |
| `src/reddit/content.ts` | `generateSelfPost` — title + Markdown body (kept verbatim), caps, old-reddit/link advisories (reuses `../x/content.ts`) |
| `src/reddit/draft.ts` | `stageDraft` — `POST /api/draft` + verify; **no submit** |
| `src/commands/reddit-draft.ts` | `registerRedditDraftCommand`; reuses `resolveContentInput`; lazy-imports auth/draft |
| `src/cli.ts` | register the `reddit` group (mirror the `linkedin` block) |
| `src/config.ts` | `REDDIT_*` env + `redditTokenCache` in `DataPaths`/`dataPaths()` |

Unlike LinkedIn, **no** `session.ts` and **no** browser `draftPoster.ts` — the
API channel replaces both with `auth.ts` (token) + `draft.ts` (HTTP). The
channel-agnostic reuse is `src/x/content.ts` (parser) and
`src/commands/contentInput.ts` (input) — both imported, neither edited, per
CLAUDE.md "reuse by import."

## 8. Out of scope (follow-ups)

- **Reddit WATCH** — subreddit/search monitoring → triage → reply candidates
  (the Reddit analog of `x watch`); PRODUCT_SPEC Phase 2, separate design. The
  read API + OAuth client built here is the foundation.
- **Link / image / gallery / video posts** — self-post first; the draft call
  generalizes (`kind: link`, media upload via `POST /api/media/asset.json`).
- **Multi-subreddit repost in one command / crossposts** — one subreddit per
  `draft` this phase; the agent orchestrates a repost by looping `draft` over the
  targets it chose from `discover` (§1.1). Native crosspost (`kind: crosspost`)
  is a later add.
- **LLM subreddit ranking** — `discover` stays facts-only by design; ranking
  "which subreddit fits best" is the consuming agent's job, not the CLI's.
- **Scheduled posts & the human send-gate** (`submit`) — future scope for the
  whole toolkit (PRODUCT_SPEC §5), explicitly not built here.
- **AutoMod-rule prediction** — preflight covers the API-declared contract only.

## 9. Open verification risks

Per CLAUDE.md "Verify live" — compile-green is not proof for a platform flow.
Do a live round-trip (a throwaway subreddit / your profile) before locking:

- **Draft endpoints.** `POST /api/draft` and `GET /api/v1/me/drafts` are
  lightly documented. Verify the exact request shape, that the created draft is
  private (never appears publicly), the required OAuth **scope**, and the field
  names for flair/nsfw/spoiler. This is the highest-risk item.
- **`post_requirements` coverage.** Confirm the response fields and that
  preflight failures match what the composer would actually reject; document that
  AutoMod filters are *not* covered — so `discover` reports the API-declared
  contract, not every mod filter, and the agent should treat it as necessary-not-
  sufficient.
- **`discover` fact endpoints.** Confirm `GET /r/{sub}/about`, subreddit search
  (`/subreddits/search` or `subreddit_autocomplete_v2`), and `about/rules` return
  the fields the report promises, and that private/quarantined subreddits degrade
  gracefully rather than erroring the whole run.
- **Markdown fidelity.** Round-trip the body on both new and old Reddit
  (fenced code, tables, headings) to confirm the "keep verbatim, Markdown mode"
  assumption and validate the PLATFORM_CAPABILITIES render profile empirically.
- **Refresh-token longevity & revocation.** Confirm `duration=permanent` yields a
  non-expiring refresh token and that the client handles a revoked/invalid token
  by prompting `--login` again (not crashing).
- **Rate limit & User-Agent.** Confirm ~100 QPM headroom and that a
  descriptive UA avoids throttling/blocks.

# Design: Reddit self-post channel (`publish reddit inspect` / `search` / `draft`)

> **Status:** design proposal (Phase 2, per [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) §8).
> **Scope:** the Reddit **PUBLISH** capability only, and within it **text /
> self-posts only**. Three flat sibling actions (matching the toolkit's two-level
> `publish <channel> <action>` grammar): two read-only discovery verbs —
> **`inspect <sub>…`** (report each named subreddit's posting contract:
> subscribers, allowed types, rules, post requirements, flairs) and
> **`search <query>`** (list candidate subreddits) — plus **`draft`**, staging a
> native Reddit **draft** (subreddit + title + Markdown body + optional flair).
> Link/image/gallery posts, multi-subreddit repost in one command, and Reddit
> **WATCH** (monitoring → reply candidates) are separate designs (§8).
>
> **Architecture: browser-driven** (mirrors X and LinkedIn's persistent-profile
> model) — **not** the official Reddit API. This **reverses** the API classification
> in [LINKEDIN_DESIGN.md](./LINKEDIN_DESIGN.md) §3.1 and [PRODUCT_SPEC.md](./PRODUCT_SPEC.md)
> §2.2; see §3.1 for why the facts changed.
>
> **Hard boundary (unchanged):** the publisher stops at a **native draft staged
> on the platform**. It MUST NOT publish. Reddit's web composer has a real
> **"Save Draft"**, so the boundary holds exactly as for X ("Unsent") and
> LinkedIn ("Save as draft"): the code clicks Save Draft and **never** clicks
> Post — which appears in the composer selectors only as a documented forbidden
> selector.

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
   does not exist for X or LinkedIn and is the main new complexity. Reddit still
   exposes these rules to a logged-in session (§3.3), so we can validate a draft
   against the target subreddit's contract before staging it.

### 1.1 The workflow: search / inspect → decide → draft

Because the subreddit is a contract, publishing is a **two-phase** flow, and the
judgment of *where* to post stays with the **consuming agent**, not this repo
(CLAUDE.md public-repo posture — editorial judgment lives in the agent
workspace):

1. **Agent proposes** candidate subreddits for a piece of content — from its own
   knowledge, or by running **`publish reddit search "<query>"`** to list
   candidate subreddits it doesn't already know (breadth; §2).
2. **`publish reddit inspect <sub…>`** returns the **mechanical facts** for each
   candidate — subscribers, `submission_type` (any/self/link), `over18`, the
   post requirements (flair required?, title regex, body limits), the flair
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
| Transport | browser (persistent Playwright profile) | **same** — browser, persistent profile, your own login (§3) |
| Target | your own timeline | **a chosen subreddit** — required, with its own rules (§4) |
| Title | none | **required, ≤ 300 chars** (may face a subreddit title regex) |
| Body | tweet / thread / article | **single Markdown body, ≤ ~40 000 chars** |
| Formatting | plain (tweet) / rich (article) | **Markdown, kept ~verbatim** (Reddit renders it) — not flattened |
| Flair | n/a | **often mandatory** — read from the sub, set in the composer |
| Flags | n/a | optional `--nsfw` / `--spoiler` |
| Media | article hero (5:2, required) | **none this phase** — self-post only (§8) |
| Draft boundary | native Unsent draft, never Post | composer **"Save Draft"**, never Post |

## 2. CLI surface

Three flat sibling actions — two read-only discovery verbs (`search`, `inspect`)
that precede the write (`draft`), the agent bridging them. Kept flat (not nested
under a `discover` group) to match the toolkit's two-level `publish <channel>
<action>` grammar, exactly as X exposes `watch` / `draft` / `reply` as siblings.
Both discovery verbs are **facts only, no LLM ranking** — read-only (the agent
proposes and decides; §1.1). All three drive the shared persistent Reddit browser
session (§3.2); `--inspect` runs any of them headful for first login / calibration.

**`inspect` — depth: the full posting contract for each named subreddit.**

```
publish reddit inspect <subreddit>...              # one or more names (the agent already knows them)
                       [--json]                    # machine-readable (default: human report)
                       [--inspect]                 # headful (first login / selector calibration)
```

For each `<subreddit>` it merges four reads (§3.3) into the full contract:

| Group | Facts | Source |
|---|---|---|
| Reach & type | subscribers, active users, `subreddit_type` (public/restricted/private), `submission_type` (any/self/link), `over18`, quarantined | `GET /r/{sub}/about.json` |
| Rules | `{short_name, description}[]` | `GET /r/{sub}/about/rules.json` |
| Flairs | `{id, text}[]` | `GET /r/{sub}/api/link_flair_v2` |
| Posting contract | `is_flair_required`, `title_regexes`, title required/blacklisted strings, `body_restriction_policy`, body min/max length, `guidelines_text` | composer gateway response (captured; §3.3) |

Plus a one-line **verdict** per sub: self-posts allowed? flair required (which)?
would a draft pass the title regex? plus **any karma/age gate the rules text
mentions** (best-effort — hard gates are AutoMod-enforced and only surface
authoritatively at `draft` time; §4.1). Private/quarantined subs degrade to a
note, not a hard error (§9).

**`search` — breadth: list candidate subreddits for a topic** (the aid for when
the agent can't name candidates).

```
publish reddit search "<query>"                    # free-text topic
                      [--limit <n>]                # cap results (default 25)
                      [--include-nsfw]             # include over-18 subs (default: excluded)
                      [--json]                     # machine-readable (default: human report)
                      [--inspect]                  # headful
```

Fetches `GET /subreddits/search.json?q=…` (§3.3) and returns a **shallow**
candidate list — `{name, subscribers, over18, submission_type,
public_description}` per hit. No contract detail; it exists to feed `inspect`.

The two compose: `reddit search "…"` → agent picks names →
`reddit inspect Name1 Name2` for full contracts → agent decides → `draft`.
`--json` (either verb) emits a structured array for the agent to parse.

**`draft` — stage a native self-post draft.**

```
publish reddit draft --subreddit <name>            # target community (or from --from frontmatter)
                     --title "<title>"             # ≤300 chars (or derived from markdown H1)
                     (--text "<body>" | --from <base.md> | --from -)
                     [--flair <id|text>]           # flair template id, or text matched to a template
                     [--nsfw] [--spoiler]
                     [--dry-run]                   # generate + preflight-validate only; no browser
                     [--inspect]                   # headful (first login / selector calibration)
```

New channel group in `src/cli.ts`, mirroring `x` / `linkedin`:

```ts
const reddit = program.command("reddit")
  .description("Reddit channel: inspect/search (subreddit facts) + draft (native self-post drafts, never posts)");
registerRedditInspectCommand(reddit);
registerRedditSearchCommand(reddit);
registerRedditDraftCommand(reddit);
```

**Body input mirrors the rest of the toolkit** — the shared `resolveContentInput`
(`--text` | `--from <file>` | `--from -` stdin, exactly-one-of). Because Reddit is
long-form, `--from <base.md>` is the primary path (an inline `--text` still works
for short posts), the opposite emphasis from LinkedIn but the same code.

**`--subreddit`, `--title`, and `--flair` may also come from Markdown frontmatter**
in the `--from` file (canonical-content metadata), with the flags overriding.
This keeps a self-post fully described by one canonical `.md`:

```markdown
---
subreddit: MachineLearning
title: "What we learned shipping an on-call triage agent"
flair: "Discussion"
---
# body markdown here…
```

There is **no `--media`** (self-post only, §8). `--inspect` replaces the old
`--login`: like X/LinkedIn, first login is headful and unattended thereafter.
`--dry-run` renders the post *and* runs the subreddit preflight (§4) without
touching the composer.

## 3. Architecture — browser-driven (mirror X / LinkedIn)

### 3.1 Why browser, not API (the reversal)

An earlier draft of this design used Reddit's official OAuth API, per
[LINKEDIN_DESIGN.md](./LINKEDIN_DESIGN.md) §3.1 ("Reddit = API channel") and
[PRODUCT_SPEC.md](./PRODUCT_SPEC.md) §2.2. That choice rested on the API being
**sanctioned, frictionless, usable on the operator's own account, with indefinite
auth**. Attempting the setup live falsified three of those four:

- **Not frictionless.** External app creation at `reddit.com/prefs/apps` is now
  gated behind Reddit's **Responsible Builder Policy** registration, which funnels
  into the **Developer Platform (Devvit)** onboarding (`npm create devvit@latest …`)
  — tooling for apps that run *inside* Reddit, not an external CLI. The clean
  `client_id`/`client_secret` path was not reachable.
- **Not the operator's own account.** The registration flow requires a **dedicated
  automated (bot) account** ("no mixed-use accounts"), so drafts would land under
  the bot, not the operator — wrong for a "stage → *I* review → *I* publish" flow.
- **Possible approval gate / Data-API support-ticket** with an unknown wait.

The browser-driven pattern we already ship for X and LinkedIn has **none** of this
friction: the operator logs in **as themselves**, drafts land in **their own**
Reddit Drafts, and there is no registration, bot account, or approval. So Reddit
joins X, LinkedIn, and 小红书 as a **browser-driven** channel; only WeChat remains
API-driven. Designs update when the facts change — this is that update.

### 3.2 Session — a persistent Reddit profile, structural sibling of X/LinkedIn

`src/reddit/session.ts` mirrors `src/session.ts` (X) and `src/linkedin/session.ts`:
a Playwright **persistent-profile** context, one unattended credential login,
headful `--inspect` for first login / calibration. It is a **separate** session
(profile `<PUBLISH_DATA_DIR>/reddit-profile`, cache `reddit-cookies.json`, creds
`REDDIT_USERNAME` / `REDDIT_PASSWORD`) and does **not** share X's session — same
"structural sibling, don't force a premature factory" posture as LinkedIn
(CLAUDE.md). It exposes the browser-channel surface the reader and composer
consume: `ensureSession` / `getBrowserContext` / `getCookies` / `closeSession`.

Reddit's **login is captcha-heavy**, so first login is headful (`--inspect`) and
may need a manual challenge solve, exactly like X's headful-first-login
constraint. Login/composer selectors drift and need occasional live
re-calibration (§9).

### 3.3 Reads — authenticated JSON, with a capture fallback (inspect / search / preflight)

Reddit serves the facts as JSON to a **logged-in session**, so no OAuth app is
needed. `src/reddit/reader.ts` (the analog of X's `src/x/reader.ts`) issues these
reads **through the authenticated browser context** — cookies attached — via
`context.request.get(url)` / `page.evaluate(fetch)`:

- **Direct JSON (primary):** `GET /subreddits/search.json` (search),
  `GET /r/{sub}/about.json`, `GET /r/{sub}/about/rules.json`,
  `GET /r/{sub}/api/link_flair_v2` (inspect). Stable, and the same endpoints
  reddit.com's own frontend calls.
- **Response capture (fallback):** `post_requirements` (flair-required?, title
  regex, body limits) is served via the composer gateway/GraphQL, not a tidy
  `.json` URL. For it, drive the composer for the target sub and **capture the
  response** the frontend loads — matched by operation/path (hashes drift), the
  same technique X uses for `/graphql/` reads.

`inspect` and `search` are thin CLI wrappers over this reader; `draft`'s preflight
(§4) calls the same reader. One reads layer, three consumers. No dedupe/SeenStore
(that is a WATCH concern).

### 3.4 Content generation — reuse X's parser, keep the Markdown

Reddit is Markdown-native, so `src/reddit/content.ts` is closer to passthrough
than LinkedIn's flattener. It imports the channel-agnostic primitives from
`../x/content.ts` — `parseBaseMarkdown` (for the H1→title derivation, `codeFlags`,
`linkFlags`) and `countChars` (for the title/body caps) — and emits a
`GeneratedSelfPost` that carries the body **as Markdown** (§4). This honors the
"Reddit ≈ X" framing at the content layer.

## 4. Content generation + subreddit-rules preflight (deterministic, no LLM)

`generateSelfPost(md, opts) -> GeneratedSelfPost` — same discipline as X/LinkedIn:
plain code, reproducible, verifiable, no LLM deciding content.

- **Title.** Required. From `--title`, else frontmatter `title`, else the Markdown
  H1 (via `parseBaseMarkdown`). Cap **300** code points (`countChars`); over cap →
  error, never silent truncation.
- **Body → Markdown, kept verbatim.** Reddit renders GFM-ish Markdown, so we do
  **not** flatten (the key divergence from LinkedIn). Strip only a leading H1 if
  it was consumed as the title. Cap **~40 000** code points; over cap → emit
  leading segment + warning.
- **Old-vs-new render advisory.** Per
  [PLATFORM_CAPABILITIES.md](./skills/publish/PLATFORM_CAPABILITIES.md): on
  old.reddit, fenced code + tables don't render — advise 4-space-indented code and
  caution on tables. Reuse `codeFlags` to surface this. The composer is switched
  to **Markdown mode** so syntax is taken literally, not as rich text.
- **Link advisory.** Reuse `linkFlags` (informational; Reddit has no
  LinkedIn-style reach penalty, but flags bare/duplicated URLs).

**Subreddit preflight (the new, load-bearing step).** Before driving the composer,
read and enforce the target's contract via `src/reddit/reader.ts` (§3.3):
`post_requirements` (flair required?, title regex, body limits) + flair templates
(resolve `--flair` text → a template to select in the UI). Validate the generated
post and **fail early with an actionable message** — e.g. *"r/MachineLearning
requires a flair; valid: Discussion, Research, Project…"* or *"title must match
`^\[D\]|\[R\]|\[P\]`"* — rather than staging a draft the subreddit would reject.
This is the browser analog of X's `watch.yaml` behavior layer: a per-target rules
gate. `--dry-run` runs the full preflight so the operator sees violations without
touching the composer. (Caveat: AutoMod rules aren't exposed — preflight catches
the declared contract, not every mod filter; §9.)

### 4.1 Eligibility gates (karma / account age)

Many subreddits gate posting on **account karma or age**. These are almost always
enforced by **AutoMod / internal spam filters and are NOT machine-declared** —
they don't appear in `post_requirements` or `about.json`. The honest split:

- **`inspect` (best-effort):** surface any karma/age requirement the subreddit's
  **rules text** states in prose, plus the operator's own karma (from
  `/api/v1/me`) for context. It does **not** promise a definitive threshold,
  because the threshold usually isn't published.
- **`draft` (authoritative):** driving the composer is what actually reveals
  eligibility. If Reddit blocks with "not enough karma," "account too new,"
  "approved submitters only," or a restricted/banned notice, `draft` **detects
  that composer/gateway error and returns a plain message** (e.g. *"can't post to
  r/foo: insufficient karma"*) instead of a silent failure — the browser-driven
  advantage of seeing exactly what a human sees. It never degrades into clicking
  Post. `--dry-run` surfaces this too where the block is detectable pre-submit.

## 5. Composer automation + the never-publish boundary

`stageDraft(post, opts) -> StageDraftResult` in `src/reddit/draftPoster.ts`,
mirroring X's/LinkedIn's `stagePost` and reusing their shared primitives
(`tolerantLocator` / `optionalLocator` / `typeText` from `../x/draftPoster.js`;
`getBrowserContext` from `./session.js`):

1. `getBrowserContext()` (persistent Reddit profile) → new page.
2. **Preflight** (§4) via the reader — abort on any violation.
3. Open the composer for the target sub (`/r/<sub>/submit`, self-post tab).
   **Eligibility check (§4.1):** if the composer surfaces a karma/age/
   approved-submitter/ban/restricted block, stop and return a plain
   *"can't post to r/<sub>: <reason>"* — never proceed toward Post.
4. **Switch to Markdown mode**, then `typeText` the title and the Markdown body.
5. **Flair (if required/requested):** open the flair picker and select the
   resolved template.
6. Set `nsfw`/`spoiler` toggles if flagged.
7. **Save Draft:** click the composer's **"Save Draft"** affordance. **Never**
   locate or click **Post** — it appears in `REDDIT_COMPOSER_SELECTORS` only as a
   documented forbidden selector (mirrors X's `tweetButton` and LinkedIn's Post).
   Same safeguard as LinkedIn: if the Save-Draft affordance doesn't resolve, bail
   — never fall through to another button.
8. **Verify:** reopen the drafts list and match the staged title/leading body
   (port the X/LinkedIn "match the staged item, don't trust a blind success"
   hardening).
9. Return `{ kind: "self", verified, subreddit, flair, note }` with the
   old-reddit/link advisories folded into `note`.

Every selector lives in one `REDDIT_COMPOSER_SELECTORS` block, commented
**best-effort / needs live calibration**. Per CLAUDE.md "Verify live," none of it
is trustworthy until run headful (`--inspect`) against real Reddit.

## 6. Config & state additions

- `PublishEnv`: `REDDIT_USERNAME`, `REDDIT_PASSWORD` (+ `REDDIT_EMAIL` if the login
  challenge needs it) — added to `.env.example`. No OAuth client id/secret/token.
- `DataPaths`: `redditProfileDir` (`<baseDir>/reddit-profile`), `redditCookieCache`
  (`<baseDir>/reddit-cookies.json`) — machine-local, **off Google Drive**, same
  posture as the X/LinkedIn profiles. `mkdirSync` the profile like the others.
- No `watch.yaml` changes (publish-only). No change to
  `scripts/install-agent-skill-symlinks.js` (Reddit lives inside the existing
  `publish` skill).

## 7. File map (additions)

| Path | Purpose |
|---|---|
| `src/reddit/session.ts` | Reddit persistent-profile login (structural sibling of `src/session.ts` / `src/linkedin/session.ts`); `ensureSession` / `getBrowserContext` / `getCookies` / `closeSession` |
| `src/reddit/reader.ts` | authenticated JSON reads for `inspect` / `search` / preflight (`about` / `about/rules` / `link_flair_v2` / `subreddits/search`) + `post_requirements` response capture. **Shared by all three commands** |
| `src/reddit/content.ts` | `generateSelfPost` — title + Markdown body (kept verbatim), caps, old-reddit/link advisories (reuses `../x/content.ts`) |
| `src/reddit/draftPoster.ts` | `stageDraft` — composer automation → "Save Draft"; `REDDIT_COMPOSER_SELECTORS` (Post = forbidden). Reuses `../x/draftPoster.js` primitives |
| `src/commands/reddit-inspect.ts` | `registerRedditInspectCommand`; read-only depth report over `reader.ts`, human or `--json` |
| `src/commands/reddit-search.ts` | `registerRedditSearchCommand`; read-only breadth candidate list (`--limit`/`--include-nsfw`), human or `--json` |
| `src/commands/reddit-draft.ts` | `registerRedditDraftCommand`; reuses `resolveContentInput`; lazy-imports session/reader/draftPoster |
| `src/cli.ts` | register the `reddit` group (mirror the `linkedin` block) |
| `src/config.ts` | `REDDIT_*` creds + `redditProfileDir` / `redditCookieCache` in `DataPaths`/`dataPaths()` |

Channel-agnostic reuse (imported, not edited, per CLAUDE.md "reuse by import"):
`src/x/content.ts` (parser), `src/x/draftPoster.ts` (locator/typing primitives),
`src/commands/contentInput.ts` (input). Reddit is now a near-structural twin of
LinkedIn — session + content + composer + commands — differing mainly in the
reader layer (subreddit facts) and Markdown-verbatim content.

## 8. Out of scope (follow-ups)

- **Reddit WATCH** — subreddit/search monitoring → triage → reply candidates (the
  Reddit analog of `x watch`); PRODUCT_SPEC Phase 2, separate design. The
  browser session + reader built here are the foundation.
- **Link / image / gallery / video posts** — self-post first; the composer flow
  generalizes to the other post tabs later.
- **Multi-subreddit repost in one command / crossposts** — one subreddit per
  `draft` this phase; the agent orchestrates a repost by looping `draft` over the
  targets it chose from `search`/`inspect` (§1.1).
- **LLM subreddit ranking** — `search`/`inspect` stay facts-only by design;
  ranking "which subreddit fits best" is the consuming agent's job, not the CLI's.
- **Scheduled posts & the human send-gate** (publishing the draft) — future scope
  for the whole toolkit (PRODUCT_SPEC §5), explicitly not built here.
- **AutoMod-rule prediction** — preflight covers the declared contract only.

## 9. Open calibration risks

Per CLAUDE.md "Verify live" — compile-green is not proof for a browser flow. Run
headful (`--inspect`) against real Reddit before claiming any of this works:

- **Login is captcha-heavy.** First headful login may need a manual challenge
  solve; headless login likely blocked (same class as X). Highest onboarding risk.
- **Composer selectors drift.** The self-post tab, the **Markdown-mode toggle**,
  the title/body editors, the **flair picker**, and especially the **"Save Draft"**
  affordance all need live calibration. Mis-clicking Save Draft must **never** fall
  through to Post (mirror LinkedIn's "don't guess another button" safeguard).
- **`post_requirements` capture.** Confirm the composer gateway/GraphQL response
  that carries requirements, match it by a stable operation/path, and confirm the
  fields; document that AutoMod filters are *not* covered (necessary-not-
  sufficient).
- **JSON read stability.** Confirm `about.json` / `about/rules.json` /
  `link_flair_v2` / `subreddits/search.json` return the promised fields through
  the authenticated context, and that private/quarantined subs degrade gracefully
  rather than erroring the whole run. Watch for read rate-limiting.
- **Markdown fidelity.** Round-trip the body on new *and* old Reddit (fenced code,
  tables, headings) to confirm the "keep verbatim, Markdown mode" assumption and
  validate the PLATFORM_CAPABILITIES render profile empirically.
- **Native draft semantics.** Confirm "Save Draft" stages a private draft
  reachable later, and that the verify step can find it reliably.
- **Eligibility-gate detection.** Karma/age gates are AutoMod-enforced and not in
  the JSON; confirm `draft` reliably catches the composer's eligibility block and
  phrases it plainly (§4.1) rather than failing opaquely. Verify against r/codex.

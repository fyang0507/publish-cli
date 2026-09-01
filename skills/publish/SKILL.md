---
name: publish
description: Capability layer for the `publish` CLI — grow an audience by building an X account-watch List from who you follow, finding posts worth replying to, reading your own published X post/reply history, and staging native drafts (X single tweet, thread, or long-form Article, and replies; LinkedIn feed posts; Reddit self-posts; WeChat Official Account article drafts staged in the 草稿箱 from Markdown) from inline text or a Markdown file. Also inspects/searches subreddits for their posting contracts (facts only). Never posts; leaves drafts one click from publishing. Use when an agent needs to build/populate an X List, monitor X for reply opportunities, review what it has already published on X (to avoid repeating a multi-day campaign), discover subreddit posting rules, or turn Markdown into X-ready, LinkedIn-ready, Reddit-ready, or WeChat-ready drafts.
---

`publish` is a CLI that turns Markdown into X (Twitter) drafts and surfaces reply
opportunities. It is a **capability layer**: it does the mechanics (read, generate,
stage) and stops at a **native draft, one click from publishing** — it **never
posts**. *What* to say, *whether* a post is worth replying to, and any
send/approval flow are the caller's concern, not this CLI's.

## Auth first — required before channel work

Before reading, drafting, or implementing a channel, run the passive readiness
probe. It never calls an automatic login path, submits credentials, or opens a
composer:

```bash
publish auth check --platform x,linkedin,reddit --json
publish auth check --platform wechat,xhs --json
```

A profile directory or cookie/token cache is only local evidence. Always name
the intended comma-separated platform set; there is no `--all`. Proceed only on
`ready: true`, which requires a positive live UI/API signal for an existing
session. `status` explains a false result. For any non-ready status, execute the
sanitized `nextStep`. Browser-channel recovery is owned by
the browser agent: open `entryUrl`, let the operator complete CAPTCHA/QR/2FA as
needed, positively verify authentication, and continue in that **same browser
context**. Never interpret selector drift, an unfamiliar page, or a network
failure as logout. Never copy cookies between machines.

WeChat may renew an expired stable token as part of its normal credential
exchange; the receipt reports that explicitly as `healed: ["token_refreshed"]`.
`xhs` and `1point3acres` intentionally return `agent_check_required` because the
CLI cannot prove their live auth state. For `xhs`, the returned browser-agent
step owns authentication and drafting. For `1point3acres`, the returned executor
is the human and all website work stays in a normal human-operated browser.

`probe_inconclusive` is not an ambiguous permission to proceed. It means the
CLI could not positively classify the visible page, so `ready` is false. Open
the returned entry URL headfully, determine authenticated/logged-out/challenge
state, and continue the publishing workflow in that same context only after
authentication is proven. An absent or empty persistent profile skips the live
probe and returns `login_required` without creating browser state.

Reddit's known headless HTTP 403 network-security wall is handled inside the
preflight: it automatically retries once headfully without clicking, filling, or
logging in. If Reddit's DOM markers drift, `/api/me.json` supplies the independent
account signal. Inspect `evidence.note` to see when the headful retry occurred.

## What it does

- **channel info** — `publish <channel> info [--json]` returns every configured
  format as three free-text sections: the CLI boundary, authentication method,
  and platform specification/gotchas, plus separate bounded readiness. Treat
  those sections as the channel execution oracle, including when execution
  belongs to an agent browser or human handoff rather than a CLI draft command.
  Non-ready auth remains exit 0; follow the sanitized `nextStep`.
- **auth check** — passive, sanitized authentication readiness for one or more
  channels; returns local evidence, positive live proof, status, and an executable
  recovery step. Never logs in.
- **create-watch-list** — build/populate an X **List** from the accounts you
  follow (the **precursor to account-based watching**): enumerate Following, create
  a (private by default) List, add every followed account, verify member count.
- **watch** — poll X search queries and Lists for recent posts; dedupe across runs
  (persistent store); optionally triage with a cheap LLM; emit ranked candidates
  worth a follow-up reply. (Watch accounts via a List, not one-by-one — see below.)
- **draft** — turn a Markdown file into a native X draft: a single **tweet**, a
  numbered **thread**, or a long-form **Article**.
- **reply** — stage a native **reply** draft targeted at a specific tweet.
- **history** — read your OWN published posts + replies from X (live, read-only),
  so an agent can see what it has already put out and avoid repeating itself across
  a multi-day campaign. Filters reposts and others' quoted tweets out.
- **linkedin draft** — turn inline text (or a Markdown file) into a native
  **LinkedIn post** draft (single post, 3,000 UTF-16 code-unit cap, optional attached media).
- **reddit inspect / search** — read-only subreddit discovery (facts only, no LLM
  ranking): `inspect <sub>…` reports each named subreddit's posting contract
  (subscribers, allowed post types, rules, flairs, post requirements); `search
  "<query>"` lists candidate subreddits for a topic.
- **reddit draft** — turn inline text (or a Markdown file) into a native **Reddit
  self-post** draft for one subreddit (title + Markdown body kept ~verbatim,
  optional flair/nsfw/spoiler), preflighting that subreddit's rules.
- **wechat check** — read-only preflight (the first **API-driven** channel — X,
  LinkedIn and Reddit are browser-driven): verify credentials, mint an access token
  (stable-token), and confirm the egress IP the API sees is in the account's IP
  allowlist (travel-aware). Stages nothing.
- **wechat draft** — turn canonical Markdown (or inline text) into a native WeChat
  Official Account **article** draft (文章) staged in the 草稿箱: title +
  **inline-styled HTML** body + required cover image; external links default to
  bottom citations; local body images uploaded to WeChat's CDN.

## When to use

- Set up account-based watching efficiently → build a List first with
  `publish x create-watch-list` (one List timeline = one fetch for all members),
  then watch it with `publish x watch --x-list <id>`. This is the ONLY way to watch
  accounts: the watcher loads one List timeline per poll instead of one profile per
  account (N profile loads don't scale and read as bot traffic).
- Find X posts worth engaging with, then stage a reply → `publish x watch`, then
  `publish x reply --to <tweet>`.
- Before publishing another variation in a multi-day campaign, check what you've
  already posted → `publish x history --since <date> --json`, then have the agent
  compare against it so it doesn't repeat itself.
- Publish owned content to X from Markdown → `publish x draft`.
- Long-form → `publish x draft --format article`. Note: **an X Article requires a
  5:2 aspect-ratio hero image to publish.**
- Publish owned content to LinkedIn → `publish linkedin draft --text "…"` (or
  `--from <file.md>`). Single post, **3,000 UTF-16 code-unit cap**, deterministic
  markdown→plain-text (headings→plain, bullets→"• ", emoji passthrough); links are
  advised into the **first comment**, not the body; `--media <path>` (repeatable)
  attaches images; opt-in `--bold` maps `**emphasis**` to Unicode bold (accessibility
  caveat). Stages a native draft and **never posts**.
- Publish owned content to Reddit → first discover the target community's rules,
  then draft. Name candidates you already know and read their contracts with
  `publish reddit inspect <sub>…`, or find new ones with `publish reddit search
  "<query>"` → pick names → `inspect` them. Then stage the self-post with `publish
  reddit draft --subreddit <name> --title "…" --from <file.md>` (or `--text`). The
  CLI reports subreddit facts; **you** decide which subreddit fits (no LLM ranking).
  Because Reddit renders Markdown, the body is kept ~verbatim (not flattened).
- Publish owned long-form to WeChat → `publish wechat draft --from <file.md> --cover
  <img>` (or `--text`). The body is **rich inline-styled HTML** (WeChat strips
  `<style>` and CSS classes, so all styling is inlined; one default look). Title
  documents title/author/digest as **32/16/120 字**, but exact Unicode measurement
  is unknown and server-authoritative; omitted digest lets WeChat derive its first
  **54 字**. A **cover image is required.** External links → bottom
  citations by default (`--keep-links` keeps them inline). Rendering is
  **deterministic, no LLM**. Stages a native draft in the 草稿箱 and **never posts**.
  On a new network/proxy, run `publish wechat check` first (the API is
  IP-allowlist-gated).

Do **not** use it to post/publish (it only drafts), and do not use it to *decide*
content — supply the Markdown (and, for triage, the free-text persona/rubric) yourself.

## Automation pattern: watch → prepare reply drafts

For an end-to-end borrowed-reach workflow, run `watch` as the discovery primitive
and `reply` as the native-draft primitive, with an agent-owned editorial layer in
between:

0. (Scheduled/unattended) Pre-flight the config without a browser:
   `publish x watch --config <campaign-watch.yaml> --validate-config` — confirms the
   config + flags resolve and the persona is non-blank before the real run.
1. `publish x watch --config <campaign-watch.yaml> --json` (use `--format markdown
   --out <file>` instead when a human wants a readable digest to review). Supply the
   self-contained rubric with `--persona-from <rubric.md>` for long rubrics.
2. Agent selects only a small number of high-confidence candidates.
3. Agent writes the reply per target tweet — inline via `--text "…"` for short
   replies, or a Markdown source (`--from <reply.md>`) for longer ones.
4. Agent dry-runs each reply:
   `publish x reply --to <tweet-url> --text "…" --dry-run`
5. Agent stages accepted drafts:
   `publish x reply --to <tweet-url> --text "…"`
6. Human reviews/sends from X Unsent/Drafts.

Keep campaign-specific choices outside this CLI skill: selection criteria,
operator voice, notifications, approval policy, and destinations such as Discord
belong to the consuming workspace's workflow skill. The `publish` CLI remains the
mechanical layer and never posts.

## Workflow: watch a set of accounts via a List

Account-watching is **List-based** — there is no per-account origin. To watch a set
of people, build a List once, then keep it fresh:

1. **Create the List from who you follow** (once):
   `publish x create-watch-list --name "AI & Tech Follows" --private`
   → enumerates your Following, creates a private List, adds every account, prints
   the list id and the ready `watch --x-list` line.
2. **Register it:** add the id under `lists:` in `watch.yaml`, or pass
   `--x-list <id>` at call time.
3. **Refresh after you follow new people:** just **rerun with the same id** — it is
   an idempotent top-up (re-enumerates Following, adds only what's missing):
   `publish x create-watch-list --x-list <id>`
4. **Watch it:** `publish x watch --x-list <id>`

> **⚠️ Rate-limit warning — do NOT bulk-add List members fast.** X applies an
> **account-level** anti-automation lock when List member-adds come too rapidly.
> Symptom: every add fails with *"You aren't allowed to add members to this list"*
> — and once locked it blocks adds in the **native UI too**, on **every** list, not
> just the one you were building. (Confirmed 2026-07-01: a 72-member bulk build with
> ~350ms between adds locked the whole account; recovery is ~24h.) Reads and the
> `watch` path are unaffected, and if you see the lock, **stop and wait ~24h** —
> retrying makes it worse. `create-watch-list` now defends against this: refreshes
> add only the delta (accounts not already in the List), each add is throttled
> (~3s apart), and it aborts immediately on the lock error instead of hammering — so
> **refreshes are safe**. The only real risk left is the *initial* build of a large
> List (many first-time adds): expect it to be slow, or seed a big List by hand.

## Commands (complements `publish --help`)

```bash
publish auth check --platform <comma-separated-names> [--json]
publish x create-watch-list [--from-following] [--handle <h>] [--name <n>] [--description <t>] \
                 [--x-list <id>] [--private|--public] [--limit <n>] [--dry-run] [--json] [--inspect]
publish x watch  [--query <q>...] [--x-list <id>...] [--languages en,zh] \
                 [--persona <text> | --persona-from <file>] \
                 [--config <watch.yaml>] [--validate-config] [--no-triage] \
                 [--format text|json|markdown] [--json] [--out <file>] [--inspect]
publish x draft  --format tweet|thread|article (--text <content> | --from <file.md>) [--long] [--dry-run] [--inspect]
publish x reply  --to <id|url> (--text <content> | --from <file.md>) [--long] [--dry-run] [--force] [--inspect]
publish x history [--handle <h>] [--limit <n>] [--include posts|replies|all] [--since <iso>] \
                 [--format text|json|markdown] [--json] [--out <file>] [--inspect]
publish linkedin draft (--text <content> | --from <file.md>) [--media <path>...] [--bold] [--dry-run] [--inspect]
publish reddit inspect <subreddit>... [--json] [--inspect]
publish reddit search "<query>" [--limit <n>] [--include-nsfw] [--json] [--inspect]
publish reddit draft --subreddit <name> --title "<title>" (--text <content> | --from <file.md>) \
                 [--flair <id|text>] [--nsfw] [--spoiler] [--dry-run] [--inspect]
publish wechat check [--json]
publish wechat draft (--text <content> | --from <file.md>) [--title "<t>"] [--author "<name>"] \
                 [--digest "<s>"] --cover <image.(bmp|png|jpg|jpeg|gif)> [--source-url <url>] [--keep-links] \
                 [--out <file.html>] [--dry-run]
```

- **create-watch-list** — seeds a List from the accounts `--handle` (default: the
  logged-in `X_USERNAME`) follows. Creates a new List (name via `--name`, default
  `Watchlist`) or tops up an existing one with `--x-list <id>` (idempotent — re-adds
  are harmless). `--private` (default) / `--public` set visibility. `--dry-run`
  reports who WOULD be added without writing. `--limit` caps enumeration; `--json`
  for machine output. Prints the list id and the ready-to-run `watch --x-list`
  command. Writes go through X's list mutations driven in-page from the logged-in
  browser; adds are tolerant of X's partial `DecodeException` responses, and the
  final `member_count` is read back to verify.
- **watch** — `--query`/`--x-list` merge with `watch.yaml` (both repeatable; each
  `--x-list` takes one X List id). Accounts are watched via a List, never one-by-one.
  `--languages en,zh` (or `allowed_languages` in `watch.yaml`) restricts candidates
  by language — posts KNOWN to be outside the list are dropped BEFORE triage (saving
  classifier/drafting tokens); untagged posts are kept. The flag OVERRIDES the config
  value; `--languages all` disables a configured filter. The dropped count is reported
  in every format (`languageFiltered` in JSON) so a scheduled run can explain an empty
  result. `--no-triage` skips the LLM and emits raw deduped posts (the caller judges them).
  `--persona` supplies the free-text reply-worthiness rubric at call time, or
  `--persona-from <file>` loads it from a file (mutually exclusive with `--persona`);
  either overrides `watch.yaml`. **The rubric MUST be self-contained** — the
  classifier sees ONLY the rubric plus each candidate post, never the source essay,
  campaign brief, workspace files, or other agent context. A vague persona ("replies
  for my agent-enablement essay") scores against a campaign name, not real editorial
  judgment, so results look plausible but misaligned; spell out the actual selection
  criteria inline. Long self-contained rubrics are the right shape → keep them in a
  file and pass `--persona-from` (avoids shell-quoting breakage). Define your own
  criteria in prose; the scoring dimensions fit/timeliness/unique_value are a fixed,
  defined baseline, not a knob. `watch.yaml` holds durable infra (`triage_model`,
  `min_score`, `batch_size`) and is schema-validated on load — unknown keys / wrong
  types fail loudly (with migration hints for removed keys) before the browser opens.
  `--validate-config` runs that validation and prints the resolved settings **without
  opening the browser or touching the seen store** — cheap pre-flight for scheduled
  jobs. Output shape: `--format text` (default ranked summary) | `json` | `markdown`
  (reviewable digest with links/scores/reasons/angles); `--json` is an alias for
  `--format json`; `--out <file>` writes to a file instead of stdout.
- **draft / reply** — `--dry-run` generates + prints content without a browser;
  `--long` raises the single-post cap to the Premium limit; `--inspect` runs headful.
  `--to` accepts a tweet id or status URL. **reply** is write-deduped by a reply
  ledger keyed on the target tweet id: it refuses to re-stage a reply to a tweet
  it has already staged (records only after a successful stage) unless `--force`.
- Content generation is **deterministic** (character-fit, thread splitting, code/link
  advisories). An Article body is pasted as rich HTML the editor converts natively;
  a tweet/thread/reply is typed into the composer and saved as an unsent draft.
- **history** — **read-only**, never drafts or posts, writes no local state. Reads
  the profile of `--handle` (default the logged-in `X_USERNAME`) live through the
  browser (same GraphQL-capture mechanism as `watch`), keeping only tweets that
  handle **authored** — **reposts and others' quoted tweets are excluded**, so what
  you get is the operator's own writing. `--include posts|replies|all` (default
  `all`); `--limit <n>` (default 50); `--since <iso>` drops older items; output
  `--format text|json|markdown` (`--json` alias), `--out <file>`. Each item reports
  its type (`post`/`reply`), text, timestamp, url, and — for replies — the
  in-reply-to target. **Because this tool never posts, `history` reflects what is
  LIVE on X only** — a draft staged-but-not-yet-posted won't appear until a human
  posts it. Use it as the pre-draft "have I already said this?" check in a campaign.
- **linkedin draft** — inline `--text` (primary) or `--from <file.md>` (`-` = stdin);
  single post, **3,000 UTF-16 code-unit cap** (over cap → leading segment + warning, never silent
  truncation); deterministic markdown→plain-text with emoji passthrough; `--media`
  (repeatable) attaches images in order; `--bold` opts into Unicode bold; `--dry-run`
  generates + prints without a browser; `--inspect` runs headful. It surfaces an
  above-the-fold hook advisory and advises links into the first comment. Never posts.
- **reddit inspect / search** — read-only discovery, **facts only, no LLM ranking**
  (deliberately unlike `x watch`). `inspect` takes one or more subreddit names and
  merges four reads per sub (about / rules / flair templates / composer post
  requirements) into the full contract plus a one-line verdict (self-posts allowed?
  flair required? would the title pass?). `search` takes a free-text query and lists
  shallow candidates (`--limit`, default 25; `--include-nsfw` to include over-18
  subs). Both emit a human report by default or a structured array with `--json`.
  These reads are **login-free** and run in a **headless** browser by default; on
  hosts where Reddit 403-blocks the headless fingerprint they **auto-retry headful
  once** (with an advisory note), and `REDDIT_READS_HEADFUL=1` starts them headful to
  skip the doomed first attempt (leave it unset on headless-server / good-fingerprint
  hosts). Draft staging stays headless (reuses the persisted session cookie).
  They compose: `search` → agent picks names → `inspect` those → agent decides →
  `draft`.
- **reddit draft** — inline `--text` or `--from <file.md>` (`-` = stdin); one
  `--subreddit` (required, or from frontmatter), a `--title` (≤300 chars, or from
  frontmatter / the Markdown H1). Body is **kept ~verbatim** (Reddit renders
  Markdown; typed in the composer's Markdown mode, not flattened), capped at ~40 000
  chars. `--flair <id|text>` resolves against the sub's flair templates;
  `--nsfw`/`--spoiler` set the flags. Before staging it **preflights the target
  subreddit's contract** (flair required?, title regex, body limits) and fails early
  with an actionable message rather than staging a rejectable draft; karma/age gates
  are AutoMod-enforced and only surface authoritatively at draft time. `--dry-run`
  generates + runs the preflight without a browser; `--inspect` runs headful. Stages
  via **"Save Draft"** and never posts. There is **no `--media`** (self-post only).
- **wechat check** — read-only preflight, the first **API-driven** channel (**no
  browser**, so **no `--inspect`**). Runs three gates in order — credentials → token
  → IP-allowlist — printing each as ✓/✗ with an actionable next step: it reads the
  app credentials, mints/caches a **stable-token**, then calls the API to learn the
  egress IP it actually sees. On a **40164** (IP not allowlisted) it prints the
  offending egress IP plus the console URL to add it, so the fix is one paste away
  (travel-aware — the IP changes with the network). `--json` for machine output.
  Stages nothing.
- **wechat draft** — inline `--text` or `--from <file.md>` (`-` = stdin) via the
  shared resolver. Metadata `--title` / `--author` / `--digest` / `--cover` /
  `--source-url` fall back to `--from` frontmatter (`coverImage`/`cover`/`image` for
  the cover, `sourceUrl` for the source link). WeChat documents title/author/digest
  as **32/16/120 字** without defining the Unicode measurement, so the CLI does not
  guess code-point boundaries; omitted digest is left for WeChat's first-54-字
  behavior. The
  **cover is required** and is uploaded to become the article's `thumb_media_id`. The
  body is rendered to **inline-styled HTML** (WeChat strips `<style>`/classes);
  **local body images are uploaded to WeChat's CDN and their `<img src>` rewritten**,
  while **remote `http(s)` images are flagged and left as-is** (a published article
  would drop them). WeChat documents body uploads as `1MB以下` and cover uploads as
  `10M`, but exact byte semantics are unknown and server-authoritative; the CLI
  does not invent a local byte cutoff.
  `--dry-run` renders + validates with **NO network** (no token, no upload, no
  `draft/add`) and, with `--out`, writes the HTML for inspection. It stages via
  **`draft/add`** and **never publishes** — `freepublish/*` and `message/mass/*` are
  never called; the boundary is **structural** (separate endpoints, no code path
  reaches them). Auth is **not** a browser login: an app_id/app_secret →
  cached-stable-token loop, and the API is **IP-allowlist-gated**, so calls must be
  routed through one fixed egress IP (allowlisted once) configured via env — see
  [SETUP.md](./SETUP.md).

## Platform constraints (what each surface does NOT support)

Author Markdown to the common ceiling; the CLI downgrades per surface. Full
capability matrix + editor selectors: [`PLATFORM_CAPABILITIES.md`](./PLATFORM_CAPABILITIES.md).

- **All surfaces:** no headings beyond **H2**; separate paragraphs with a **blank line**.
- **X tweet/thread:** NO Markdown — plain text; links show bare; code/tables/images
  must become screenshots or attached media.
- **X Articles:** NO inline `` `code` `` (use a fenced code block); NO H3+ (editor
  offers only Heading/Subheading). Otherwise rich — lists, code blocks, tables,
  strikethrough, dividers, LaTeX, embedded posts, inline images + a required **5:2 hero**.
- **Reddit self-post:** NO inline body images (separate image post); on old reddit,
  fenced code + tables don't render (use 4-space code; avoid tables); post in Markdown mode.
- **WeChat article:** body is **HTML with inline styles only** — WeChat strips
  `<style>`, `<link>`, and CSS classes; most **external links are deactivated** in
  article bodies (default → bottom citations; only `mp.weixin.qq.com` links stay
  inline); **images must be WeChat-hosted** (local images are auto-uploaded to the
  CDN; remote `http(s)` images are dropped by a published article → flagged); one
  default look this phase (no themes); **article self-posts only** (图文/newspic not yet).

## More

- **Setup & auth** (install, credentials, first login, data dir): [SETUP.md](./SETUP.md)
- **WeChat setup** (app credentials + the fixed-egress-IP requirement): [SETUP.md](./SETUP.md)
- **A browser step hangs / times out** (selector drift): [calibration.md](./calibration.md)
- **Full render capability matrix**: [`PLATFORM_CAPABILITIES.md`](./PLATFORM_CAPABILITIES.md)

## Boundaries

- **Never posts.** Every content path stops at a native draft; there is no code
  path that clicks Post/Publish. Any send/approval flow is the caller's
  responsibility. (`create-watch-list` DOES write — it changes List
  membership/visibility — but it never publishes content.)
- **Mechanics only.** The CLI does not choose what to say or which posts merit a
  reply — the caller supplies the Markdown and the triage persona/rubric.

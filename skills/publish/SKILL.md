---
name: publish
description: Capability layer for the `publish` CLI — grow an X (Twitter) audience by building an account-watch List from who you follow, finding posts worth replying to, and staging native X drafts (single tweet, thread, or long-form Article) and replies from a Markdown file. Never posts; leaves drafts one click from publishing. Use when an agent needs to build/populate an X List, monitor X for reply opportunities, or turn Markdown into X-ready drafts.
---

`publish` is a CLI that turns Markdown into X (Twitter) drafts and surfaces reply
opportunities. It is a **capability layer**: it does the mechanics (read, generate,
stage) and stops at a **native draft, one click from publishing** — it **never
posts**. *What* to say, *whether* a post is worth replying to, and any
send/approval flow are the caller's concern, not this CLI's.

## What it does

- **create-watch-list** — build/populate an X **List** from the accounts you
  follow (the **precursor to account-based watching**): enumerate Following, create
  a (private by default) List, add every followed account, verify member count.
- **watch** — poll X search queries and Lists for recent posts; dedupe across runs
  (persistent store); optionally triage with a cheap LLM; emit ranked candidates
  worth a follow-up reply. (Watch accounts via a List, not one-by-one — see below.)
- **draft** — turn a Markdown file into a native X draft: a single **tweet**, a
  numbered **thread**, or a long-form **Article**.
- **reply** — stage a native **reply** draft targeted at a specific tweet.

## When to use

- Set up account-based watching efficiently → build a List first with
  `publish x create-watch-list` (one List timeline = one fetch for all members),
  then watch it with `publish x watch --x-list <id>`. This is the ONLY way to watch
  accounts: the watcher loads one List timeline per poll instead of one profile per
  account (N profile loads don't scale and read as bot traffic).
- Find X posts worth engaging with, then stage a reply → `publish x watch`, then
  `publish x reply --to <tweet>`.
- Publish owned content to X from Markdown → `publish x draft`.
- Long-form → `publish x draft --format article`. Note: **an X Article requires a
  5:2 aspect-ratio hero image to publish.**

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
3. Agent writes one Markdown reply source per target tweet.
4. Agent dry-runs each reply:
   `publish x reply --to <tweet-url> --from <reply.md> --dry-run`
5. Agent stages accepted drafts:
   `publish x reply --to <tweet-url> --from <reply.md>`
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
publish x create-watch-list [--from-following] [--handle <h>] [--name <n>] [--description <t>] \
                 [--x-list <id>] [--private|--public] [--limit <n>] [--dry-run] [--json] [--inspect]
publish x watch  [--query <q>...] [--x-list <id>...] [--persona <text> | --persona-from <file>] \
                 [--config <watch.yaml>] [--validate-config] [--no-triage] \
                 [--format text|json|markdown] [--json] [--out <file>] [--inspect]
publish x draft  --from <file.md> --format tweet|thread|article [--long] [--dry-run] [--inspect]
publish x reply  --to <id|url> --from <file.md> [--long] [--dry-run] [--force] [--inspect]
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
  `--no-triage` skips the LLM and emits raw deduped posts (the caller judges them).
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

## Platform constraints (what each surface does NOT support)

Author Markdown to the common ceiling; the CLI downgrades per surface. Full
capability matrix + editor selectors: [`docs/PLATFORM_CAPABILITIES.md`](../../docs/PLATFORM_CAPABILITIES.md).

- **All surfaces:** no headings beyond **H2**; separate paragraphs with a **blank line**.
- **X tweet/thread:** NO Markdown — plain text; links show bare; code/tables/images
  must become screenshots or attached media.
- **X Articles:** NO inline `` `code` `` (use a fenced code block); NO H3+ (editor
  offers only Heading/Subheading). Otherwise rich — lists, code blocks, tables,
  strikethrough, dividers, LaTeX, embedded posts, inline images + a required **5:2 hero**.
- **Reddit self-post:** NO inline body images (separate image post); on old reddit,
  fenced code + tables don't render (use 4-space code; avoid tables); post in Markdown mode.

## More

- **Setup & auth** (install, credentials, first login, data dir): [SETUP.md](./SETUP.md)
- **A browser step hangs / times out** (selector drift): [calibration.md](./calibration.md)
- **Full render capability matrix**: [`docs/PLATFORM_CAPABILITIES.md`](../../docs/PLATFORM_CAPABILITIES.md)

## Boundaries

- **Never posts.** Every content path stops at a native draft; there is no code
  path that clicks Post/Publish. Any send/approval flow is the caller's
  responsibility. (`create-watch-list` DOES write — it changes List
  membership/visibility — but it never publishes content.)
- **Mechanics only.** The CLI does not choose what to say or which posts merit a
  reply — the caller supplies the Markdown and the triage persona/rubric.

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

## Commands (complements `publish --help`)

```bash
publish x create-watch-list [--from-following] [--handle <h>] [--name <n>] [--description <t>] \
                 [--x-list <id>] [--private|--public] [--limit <n>] [--dry-run] [--json] [--inspect]
publish x watch  [--query <q>...] [--x-list <id>...] [--persona <text>] \
                 [--config <watch.yaml>] [--no-triage] [--json] [--inspect]
publish x draft  --from <file.md> --format tweet|thread|article [--long] [--dry-run] [--inspect]
publish x reply  --to <id|url> --from <file.md> [--long] [--dry-run] [--inspect]
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
  `--persona` supplies the free-text reply-worthiness rubric at call time (define
  your own criteria in prose; the scoring dimensions fit/timeliness/unique_value are
  a fixed, defined baseline, not a knob). `watch.yaml` holds durable infra
  (`triage_model`, `min_score`, `batch_size`) and is schema-validated on load —
  unknown keys / wrong types fail loudly before the browser opens. `--json` for
  machine output; otherwise a ranked human summary.
- **draft / reply** — `--dry-run` generates + prints content without a browser;
  `--long` raises the single-post cap to the Premium limit; `--inspect` runs headful.
  `--to` accepts a tweet id or status URL.
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

---
name: publish
description: Capability layer for the `publish` CLI — grow an X (Twitter) audience by finding posts worth replying to and by staging native X drafts (single tweet, thread, or long-form Article) and replies from a Markdown file. Never posts; leaves drafts one click from publishing. Use when an agent needs to monitor X for reply opportunities or turn Markdown into X-ready drafts.
---

`publish` is a CLI that turns Markdown into X (Twitter) drafts and surfaces reply
opportunities. It is a **capability layer**: it does the mechanics (read, generate,
stage) and stops at a **native draft, one click from publishing** — it **never
posts**. *What* to say, *whether* a post is worth replying to, and any
send/approval flow are the caller's concern, not this CLI's.

## What it does

- **watch** — poll X search queries, watched accounts, and Lists for recent posts;
  dedupe across runs (persistent store); optionally triage with a cheap LLM; emit
  ranked candidates worth a follow-up reply.
- **draft** — turn a Markdown file into a native X draft: a single **tweet**, a
  numbered **thread**, or a long-form **Article**.
- **reply** — stage a native **reply** draft targeted at a specific tweet.

## When to use

- Find X posts worth engaging with, then stage a reply → `publish watch x`, then
  `publish reply x --to <tweet>`.
- Publish owned content to X from Markdown → `publish draft x`.
- Long-form → `publish draft x --format article`. Note: **an X Article requires a
  5:2 aspect-ratio hero image to publish.**

Do **not** use it to post/publish (it only drafts), and do not use it to *decide*
content — supply the Markdown (and, for triage, the persona/rubric) yourself.

## Commands (complements `publish --help`)

```bash
publish watch x  [--query <q>...] [--account <handle>...] [--list <id>...] \
                 [--config <watch.yaml>] [--persona <text>] [--rubric <text>] \
                 [--dimensions <a,b,c>] [--no-triage] [--batch-size <n>] [--json] [--inspect]
publish draft x  --from <file.md> --format tweet|thread|article [--long] [--dry-run] [--inspect]
publish reply x  --to <id|url> --from <file.md> [--long] [--dry-run] [--inspect]
```

- **watch x** — `--query`/`--account`/`--list` merge with `watch.yaml`. `--no-triage`
  skips the LLM and emits raw deduped posts (the caller judges them). `--persona`/
  `--rubric`/`--dimensions` supply the triage rubric at call time (overriding
  `watch.yaml`). `--batch-size` sets posts-per-LLM-call (default 25). `--json` for
  machine output; otherwise a ranked human summary.
- **draft x / reply x** — `--dry-run` generates + prints content without a browser;
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

- **Never posts.** Every path stops at a native draft; there is no code path that
  clicks Post/Publish. Any send/approval flow is the caller's responsibility.
- **Mechanics only.** The CLI does not choose what to say or which posts merit a
  reply — the caller supplies the Markdown and the triage persona/rubric.

---
name: publish
description: Orchestrate Fred's X distribution to grow his AI-community audience — WATCH for borrowed-reach follow-up opportunities and rank them, and DRAFT native X tweets/threads/articles from a canonical markdown. Stages drafts one click from publishing and never posts. Use when an agent needs to monitor X for engagement candidates or turn an owned draft into an X-ready draft.
---

This skill drives the `publish` CLI (X channel) end to end. It has two motions that share **one** logged-in session:

- **WATCH** — find conversations that already have an audience, triage them, and draft additive replies in Fred's voice.
- **DRAFT** — turn a canonical owned draft into native X tweet/thread/article drafts.

Both stop at a **native draft on X, one click from publishing**. This skill **never posts** — the send action is human-gated (future scope; see Boundaries).

## When to use

- Monitor X (search queries + watched accounts) for posts Fred could add value to, ranked by fit/timeliness/unique value.
- Stage X-ready draft(s) on X from a canonical base markdown under `/Users/fredy/Downloads/fred-agent/publish/<date>-<slug>/`.

Do NOT use this to actually post/publish, or to draft inside Notion (Notion is the post-publish record only).

## Prerequisites (first run)

- X credentials in `.env`: `X_USERNAME`, `X_PASSWORD`, `X_EMAIL` (no 2FA; the login answers X's email/identifier confirmation step with `X_EMAIL`). `GOOGLE_GENERATIVE_AI_API_KEY` for triage.
- The first browser-driven run may need a **one-time selector calibration** — X's login and composer DOM drift. Run the browser path once with `--inspect` (headful) so a human can watch and recalibrate if a step hangs. See [calibration.md](./calibration.md).
- Runtime state (browser profile, cookie cache, dedupe db) lives off Google Drive under `PUBLISH_DATA_DIR` (defaults to `~/.publish-cli`). One credential login backs both motions: the watcher reads via harvested cookies, the publisher drives the same persistent profile. Auth is implicit — both commands call `ensureSession()` first; there is no login flag.

## Command surface

```bash
publish watch x [--query <q>...] [--account <handle>...] [--config <watch.yaml>] [--json]
publish draft x --from <base.md> --format tweet|thread|article [--long] [--dry-run] [--inspect]
publish --help
```

`--query` / `--account` are repeatable and **merge with** `watch.yaml`. `--json` switches `watch x` to machine JSON. `--long` raises the single-tweet cap to the Premium long-post limit. `--dry-run` (draft) generates content without touching the browser. `--inspect` (either browser path) runs headful for calibration.

## WATCH workflow

1. Run `publish watch x` (add `--json` when you'll parse the output programmatically; default is human-readable ranked text). Queries/accounts come from `watch.yaml`, extended by any `--query`/`--account` flags. The CLI dedupes against the local store, so each run surfaces only **new** posts, triaged with the cheap Gemini model (low reasoning effort) into `{postId, score, reason, suggestedAngle}`.
2. **Summarize** the ranked candidates for the human: top items with score, origin (query or handle), author, link, why it scored, and the suggested angle. Lead with the highest-fit few; don't dump the whole list.
3. For **high-fit** candidates only, draft an **additive reply** — a concrete, non-obvious contribution from Fred's experience, not a drive-by. Invoke the **fred-style-guide** skill to write the reply in Fred's voice; do not improvise the voice yourself.
4. **Stop at the draft.** Present the reply text + the target post link to the human and hand off. Do NOT send. See [reply-drafting.md](./reply-drafting.md) for what makes a reply worth Fred's name.

## DRAFT workflow

1. Locate the canonical base markdown under `/Users/fredy/Downloads/fred-agent/publish/<slug>/`. This is the source of truth — do not author in Notion.
2. **Review the base against fred-style-guide first.** Invoke the **fred-style-guide** skill to confirm the prose is in Fred's voice before staging it; the publisher's formatting is deterministic and won't fix voice.
3. Preview with `--dry-run` to inspect the generated content without touching the browser:
   ```bash
   publish draft x --from <base.md> --format thread --dry-run
   ```
   Check the split: a `thread` is hook-first and numbered with each post within the limit; a `tweet` is char-validated (`--long` for the long-post cap); an `article` is long-form Article markdown. The generator **flags code blocks** that must become screenshots (X won't render code — the image usually already lives in the canonical folder) and surfaces **links with placement notes** (keep links out of the opening tweet).
4. Stage the native draft (drop `--dry-run`):
   ```bash
   publish draft x --from <base.md> --format thread
   ```
   This drives the persistent logged-in profile, types into X's composer (thread: each post in order; article: the Articles composer), and saves an **unsent draft**. Use `--inspect` on the first staging run to watch the composer interaction.
5. Report what was staged (format + post/segment count) and hand to the human for the final click.

## Platform constraints — what each surface does NOT support

Author canonical Markdown to the common ceiling; the renderer downgrades for tweets. Full capability matrix + real editor selectors: `docs/PLATFORM_CAPABILITIES.md`.

- **All surfaces:** no headings beyond **H2**; separate paragraphs with a **blank line** (a single newline collapses on Reddit).
- **X tweet/thread:** NO markdown at all — plain text; links show bare; code/tables/images must become screenshots or attached media.
- **X Articles:** NO inline `` `code` `` (use a fenced code block instead); NO H3+ (the editor offers only Heading/Subheading). Everything else renders natively — lists, code blocks, tables, strikethrough, dividers, LaTeX, embedded posts, inline images + a required **5:2 hero**.
- **Reddit self-post:** NO inline images in the body (needs a separate image post); on **old reddit**, fenced code + tables do NOT render (use 4-space-indented code; avoid tables or give a list fallback); must post in **Markdown mode** (the rich editor mangles markdown).

## Boundaries

- **Never posts.** Both motions stop at "draft on X." The send-gate (headless: Discord approval → wait ~2min → phone escalation, contact-operator pattern) is future scope, not built here.
- **Voice is delegated.** Reply and draft prose go through **fred-style-guide**; this skill orchestrates and stages, it does not own Fred's voice.
- **Canonical content is local markdown** under `publish/<date>-<slug>/`, not Notion. Notion is the durable post-publish record, written only after a human posts.
- **Runtime data is off Google Drive** under `PUBLISH_DATA_DIR`. Never put the browser profile in the repo.

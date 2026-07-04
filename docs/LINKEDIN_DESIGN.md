# Design: LinkedIn post channel (`publish linkedin draft`)

> **Status:** design proposal (Phase 2, per [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) §8).
> **Scope:** the LinkedIn **PUBLISH** capability only — staging a native LinkedIn
> feed-post draft. LinkedIn **WATCH** (borrowed-reach) is a separate design.
>
> **Hard boundary (unchanged):** the publisher stops at a **native draft**. It
> MUST NOT click Post. LinkedIn's composer has a real "Save as draft", so the
> boundary holds exactly as it does for X.

---

## 1. What a LinkedIn post is

The unit is a single **feed share**: short-to-medium plain text, emoji-friendly,
with **optional** attached media. It is *not* a thread, and *not* an
Article/Newsletter (those use a different composer — out of scope, §8).

How it differs from the X channel we already ship:

| Dimension | X (existing) | LinkedIn post (this design) |
|---|---|---|
| Input | `--from <base.md>` (long article source) | **`--text "<post>"`** (inline) — see §2 |
| Length cap | 280 / 25 000 (`--long`) | **3 000 chars**, one hard limit (no `--long`) |
| Structure | tweet / thread / article | **single post** only |
| Fold / preview | n/a | **"…see more"** truncates preview at ~**210 chars / ~3 lines** on desktop — the hook must land above the fold |
| Formatting | plain (tweet) / rich (article) | **plain text only** — markdown syntax is stripped, not typed literally; newlines render verbatim |
| Emphasis | none | no native bold/italic — only the Unicode math-alphanumeric hack (**off by default**, §4) |
| Emoji | passthrough | **passthrough, first-class** — flows from `--text` untouched |
| Media | article hero (5:2, required) | **optional**, explicit `--media` paths, no ratio constraint |
| Links | "cost reach" advisory | **stronger penalty** → advise the link in the **first comment**, not the body |
| Draft boundary | native Unsent draft, never Post | LinkedIn **"Save as draft"** → same boundary |

## 2. CLI surface

```
publish linkedin draft --text "<post text>"
                       [--media <path>...]   # repeatable; images attached in order
                       [--bold]              # opt-in Unicode-bold for **emphasis** (accessibility caveat, §4)
                       [--dry-run]           # generate only; no browser
                       [--inspect]           # headful for selector calibration
```

New channel group in `src/cli.ts`, mirroring `x`:

```ts
const linkedin = program.command("linkedin")
  .description("LinkedIn channel: draft (native post drafts, never posts)");
registerLinkedInDraftCommand(linkedin);
```

**Input is `--text`, not `--from`.** `--from` is designed for the long-form
article source the X publisher consumes; a LinkedIn post is short, so an inline
`--text` string is the right ergonomics and suffices. (A `--from <file>`
convenience alias that reads the file's text can be added later, but `--text` is
the documented path.) There is no `--format` (one format) and no `--long` (single
3 000 cap). `--media` is **explicit** — LinkedIn media is optional and
multi-image, so auto-discovering images next to a file (as the X hero flow does)
would guess intent; explicit paths are the safe default.

## 3. Architecture — reuse vs. add, and how the session pattern scales

### 3.1 Does the session pattern preserve or diverge across future channels?

This is the load-bearing decision. The answer: **the browser-profile session
pattern preserves for browser-driven channels and deliberately diverges for
API channels — so the shared abstraction must be drawn at "browser-driven," not
"all channels."**

| Channel | Auth model | Session shape |
|---|---|---|
| **X** (shipped) | persistent Playwright profile, credential login | browser session — read+write drive one logged-in context |
| **LinkedIn** (this design) | persistent Playwright profile, credential login | **same** browser session |
| **小红书** (Phase 3) | persistent Playwright profile | **same** browser session |
| **Reddit** (Phase 2) | OAuth token / official API | **different** — token store, no browser, no shared-context duality |
| **微信公众号** (Phase 3) | app_id/secret → access_token, API | **different** — token refresh loop, no browser |

The "one login, two consumers, both drive the same logged-in browser" property
(PRODUCT_SPEC §6) is intrinsic to the *browser-driven* channels. Reddit and
WeChat authenticate with tokens and talk to an API — there is no persistent
profile and no read/write-share-one-context invariant to preserve. Forcing them
through a browser-session interface would be a wrong abstraction (a token has no
`getBrowserContext()`).

**Recommendation:** refactor `src/session.ts` into a
**`createBrowserSession(config)`** factory shared by the browser-driven channels
(X now, LinkedIn next, 小红书 later), and let API channels (Reddit, WeChat) own
entirely separate auth modules. Concretely:

```
src/browser/session.ts
  createBrowserSession({
    profileDir,           // <dataDir>/<channel>-profile   (machine-local, off Drive)
    cookieCache,          // <dataDir>/<channel>-cookies.json
    loginUrl, selectors,  // channel login DOM (centralized, best-effort, calibratable)
    creds: { username, password, email },
  }) -> { ensureSession, getBrowserContext, getCookies, closeSession }
```

- X keeps its current public API by binding the factory with X config (behavior
  unchanged — pure refactor).
- LinkedIn binds it with LinkedIn config in `src/linkedin/session.ts`.
- The channel-agnostic surface every browser channel shares is exactly the
  Playwright profile lifecycle: `ensureSession` / `getBrowserContext` /
  `closeSession`. That is the interface the task layer (PRODUCT_SPEC §2) can
  depend on for browser channels.
- When Reddit/WeChat land, they implement whatever their API auth needs and are
  **not** shoehorned into this factory. The task layer composes over the
  capability (PUBLISH/WATCH), not over a single session type.

### 3.2 Content generation — reuse the parser, add a LinkedIn emitter

`src/x/content.ts::parseBaseMarkdown()` already produces what we need from text:
title, a prose stream with metadata / heading / image-only lines dropped,
`codeFlags`, `linkFlags`, and a code-point `countChars`. Lift the shared parser
to `src/content/markdown.ts` and have both channels import it. LinkedIn adds a
`generatePost()` emitter (§4) in `src/linkedin/content.ts`.

### 3.3 Poster — mirror `stageDraft`, share the browser helpers

`tolerantLocator` / `optionalLocator` / `typeText` and the close→Save pattern in
`src/x/draftPoster.ts` are channel-agnostic. Lift them to
`src/browser/composer.ts`. LinkedIn gets `src/linkedin/draftPoster.ts` with its
own centralized, calibration-flagged `LI_COMPOSER_SELECTORS`.

## 4. Content generation rules (deterministic, no LLM)

`generatePost(text, opts) -> GeneratedPost` — same discipline as X: plain code so
output is reproducible and verifiable.

- **Char fit.** Cap **3 000** code points (`countChars`). Over cap → emit the
  leading segment + a warning (never silent truncation). Emoji ZWJ sequences
  count as multiple code points → conservative over-count, the safe direction
  (same rationale as the X `countChars` comment).
- **Hook / fold advisory.** Compute the above-the-fold preview (first ~210 chars
  or up to the first blank line) and warn if the hook is weak (starts with a
  link, is a bare heading label, or is very short). Advisory only — we never
  rewrite prose (no LLM decides content).
- **Markdown → plain text.** Strip syntax LinkedIn would render literally:
  headings → plain line, bullets → `• ` prefix, `**bold**`/`*italic*` → plain
  text **unless `--bold`**. Preserve blank-line paragraph breaks and single
  newlines verbatim (LinkedIn honors both).
- **`--bold` (opt-in).** Map `**x**` to Unicode math-bold (𝘅). **Off by default
  and flagged** — it breaks screen readers and search indexing, so it is an
  explicit operator choice, not a default.
- **Emoji passthrough.** Emoji in `--text` pass through untouched into the
  composer (typed via `keyboard.insertText`, which fires the input events
  LinkedIn expects). No stripping, ever. (First-class per requirement.)
- **Code blocks →** reuse `codeFlags`: "LinkedIn won't render code — paste a
  screenshot or add it as a document."
- **Links →** reuse `linkFlags`, reworded: "LinkedIn suppresses reach on body
  links — post this URL as the **first comment** instead." Surfaced in the result
  note (a first comment can't be pre-saved in a draft, so it's a human step
  after publishing).
- **Hashtags →** advisory: keep 3–5, at the end.

## 5. Composer automation + draft boundary + media

`stagePost(content, { media, inspect }) -> StagePostResult` in
`src/linkedin/draftPoster.ts`:

1. `getBrowserContext()` (persistent LinkedIn profile) → new page → open the
   share composer (`linkedin.com/feed/?shareActive=true`, or the "Start a post"
   modal).
2. `tolerantLocator` the composer contenteditable → `typeText(...)` the generated
   post (emoji + newlines intact).
3. **Media (optional):** for each `--media` path, drive the "add media" control's
   hidden `input[type=file]` via `setInputFiles` (same technique as the X hero
   upload, minus the 5:2 ratio gate — LinkedIn feed images are ratio-flexible).
   Handle the media preview / "Next" dialog with `optionalLocator`.
4. **Save as draft:** click composer **Close** → LinkedIn raises *"Save this post
   as a draft?"* → click **Save as draft**. Centralize both. **Never** locate or
   click the **Post** button — it appears in `LI_COMPOSER_SELECTORS` only as a
   documented forbidden selector, exactly as X's `tweetButton` does.
5. **Verify:** open the drafts list and match the staged text's leading ~40 chars
   (port `verifyDraftSaved`'s "match the staged prefix, don't trust any row"
   hardening — the same false-positive trap X hit).
6. Return `{ format: "post", verified, mediaAttached, note }` with the
   first-comment-link and hashtag advisories folded into `note`.

Every selector lives in one `LI_COMPOSER_SELECTORS` block, commented
**best-effort / needs live calibration** — LinkedIn's DOM drifts like X's. Per
CLAUDE.md "Verify live," none of it is trustworthy until run headful
(`--inspect`) against real LinkedIn.

## 6. Config & state additions

- `PublishEnv`: `LI_USERNAME`, `LI_PASSWORD`, `LI_EMAIL` (+ `.env.example`).
- `DataPaths`: `liProfileDir` (`<baseDir>/li-profile`), `liCookieCache`
  (`<baseDir>/li-cookies.json`) — machine-local, off Google Drive, same posture
  as the X profile.
- No `watch.yaml` changes (publish-only).

## 7. File map (additions / refactors)

| Path | Purpose |
|---|---|
| `src/content/markdown.ts` | shared `parseBaseMarkdown` / `countChars` (lifted from `x/content.ts`) |
| `src/browser/session.ts` | `createBrowserSession(config)` factory (refactor of `session.ts`); X binds it |
| `src/browser/composer.ts` | shared `tolerantLocator` / `optionalLocator` / `typeText` / close→Save (lifted from `x/draftPoster.ts`) |
| `src/linkedin/session.ts` | LinkedIn profile + login selectors bound to the factory |
| `src/linkedin/content.ts` | `generatePost` — LinkedIn rules (§4) |
| `src/linkedin/draftPoster.ts` | `stagePost` + `LI_COMPOSER_SELECTORS` |
| `src/commands/linkedin-draft.ts` | `registerLinkedInDraftCommand` |

Rows 1–3 are pure refactors (X behavior unchanged) so LinkedIn is not a fork of X.

## 8. Out of scope (follow-ups)

- **LinkedIn WATCH** (borrowed-reach) — PRODUCT_SPEC Phase 2; separate design.
- **Articles / Newsletters** — different composer; the `post` format covers the
  "generally short" requirement.
- **First-comment link auto-staging** — can't be saved in a draft; stays a human
  step (surfaced in the result note).
- **Video / document (PDF carousel) media** — images first; the media hook
  generalizes to these later.

## 9. Open calibration risks

- LinkedIn login and composer DOM drift (same fragility class as X). All
  selectors are best-effort and need live `--inspect` calibration.
- The "Save as draft" confirmation dialog wording/affordance is the highest-risk
  selector — mis-clicking must never fall through to Post (mirror X's
  "don't guess another button" safeguard in `saveAsDraft`).
- LinkedIn's exact character-count semantics (code points vs. UTF-16) — we
  over-count conservatively to avoid overflowing the composer.

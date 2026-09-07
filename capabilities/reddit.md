---
schemaVersion: publish.channel-info-source/v1
channel: reddit
displayName: Reddit
---
# Reddit

## CLI boundary

The CLI can search for communities and inspect a community's posting requirements without login. It can stage a Markdown self-post with optional flair, NSFW, and spoiler settings after login. Link, image, gallery, and inline-body-media posts are unsupported; the CLI never clicks Post.

The agent chooses the community and flair from live inspection, prepares compliant content, stages Save Draft, and evaluates the receipt. The operator handles login/CAPTCHA, reviews community fit and the native draft, and makes the final publication decision. Discovery results do not replace community rules.

## Authentication

`search` and `inspect` are logged-out reads. A non-JSON 403 or network-security wall triggers one retry in a visible browser. Such a block does not prove logout.

Drafting uses a separate CLI-owned browser profile. `REDDIT_USERNAME` and `REDDIT_PASSWORD` enable auto-fill, with `REDDIT_EMAIL` used only when requested. To establish or recover the session, start the intended draft with `--inspect`; the operator can enter credentials manually and complete login/CAPTCHA there, then the same command continues.

Follow the auth receipt when credentials are rejected, a session expires, a human challenge appears, the network is blocked, or changed page controls make the result inconclusive. Account eligibility for a particular community may still block drafting after login.

## Platform specification and gotchas

### Prepare the draft

Inspect the target immediately before drafting. Check self-post eligibility, required flair, title patterns or required strings, and body restrictions. Karma, account age, bans, restricted-community access, and additional AutoMod rules may only surface in the composer. Flair must match a live destination-specific id or exact text.

Stage with `publish reddit draft --subreddit <name> --title <title> (--text <body> | --from <base.md|->)` plus the resolved flair/state flags. Consult `publish reddit draft --help` for flags.

- Supply exactly one of `--text` or `--from`; `--from -` reads stdin. File/stdin frontmatter accepts only string-valued `subreddit`, `title`, and `flair`. Flags override metadata; title otherwise falls back to a leading Markdown H1. Empty `--subreddit` or `--title` values are rejected; empty `--flair` clears metadata but does not waive required flair. NSFW and spoiler are flag-only.
- Invalid mapping frontmatter or unsupported keys are rejected before browser access. Valid scalar/sequence blocks remain literal Markdown. Inline `--text` is always literal.
- Local limits are 300 title code points and 40,000 body code points; Reddit decides its effective limits. `--dry-run` validates locally and skips the live subreddit preflight.
- The CLI switches to Markdown mode before filling the body. If it cannot confirm the switch, follow its manual-switch advisory. For old/new Reddit compatibility, use 4-space-indented code instead of fenced code, and leading and trailing pipes on every table row. Review native rendering.
- Inline body images are not uploaded or verified. Replace Markdown image references with text/links or handle them manually during review.

### Verify and recover

Save confirmation requires a fresh `Draft saved` toast: absent before and visible after the one Save Draft click. A stale toast or inconclusive check cannot confirm the save. Even a fresh toast does not prove that the draft can be reopened; the Drafts modal can also be stale.

An unavailable Save control, unknown click delivery, or missing confirmation exits 1. Content may remain in the composer, and a native draft may exist. Inspect the native title, body, flair, or community validation guidance without bypassing restrictions.

Before any retry, manually compare Reddit DRAFTS in the same CLI-owned profile. If a matching draft exists or comparison is uncertain, do not retry. Never retry automatically or blindly: Reddit has no draft idempotency ledger, so another attempt can duplicate a draft.

Use `--json` for a structured receipt separating local validation, community eligibility, Save not attempted, delivery unknown, toast unconfirmed, and fresh-toast confirmation. It reports possible composer/draft residue and always reports `published:false`. Terminal summaries may escape or shorten displayed input; they do not alter the staged content.

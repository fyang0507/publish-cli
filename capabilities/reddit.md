---
schemaVersion: publish.channel-info-source/v1
channel: reddit
displayName: Reddit
---
# Reddit

## CLI boundary

The CLI can search for communities and inspect a community's current posting contract without login. Draft authentication is required only to stage a Markdown self-post with optional flair, NSFW, and spoiler state. The CLI reports discovery facts but does not choose the community or bypass its rules; it does not support link, image, gallery, or inline-body-media posts, and it never clicks Post.

The agent chooses the destination and flair from live inspection, prepares compliant title/body content, stages Save Draft, and evaluates the save receipt. The human handles login/CAPTCHA, reviews community fit and the native draft, and makes the final publish decision.

## Authentication

`search` and `inspect` are logged-out reads. Reddit may return a non-JSON 403/network-security wall; the CLI retries headfully once, and that response is a read/network block rather than proof of logout.

Drafting uses a CLI-owned Playwright persistent profile. `REDDIT_USERNAME` and `REDDIT_PASSWORD` enable auto-fill (`REDDIT_EMAIL` only when requested), but under `--inspect` the human may enter credentials manually. Authentication can fail because credentials are rejected, the session expired, Reddit requires CAPTCHA or another human challenge, the account is ineligible for the community, the network is blocked, or selector drift made the probe inconclusive.

To establish or recover the draft session, the agent starts the intended draft with `--inspect`; that command opens the CLI-owned profile, the human completes login/CAPTCHA there, and the same command continues afterward.

## Platform specification and gotchas

- Inspect the target immediately before drafting. Confirm self-post eligibility, required flair/templates, title regexes or required strings, and body restrictions. Karma, account age, bans, restricted-community status, and full AutoMod behavior may only surface in the composer.
- Stage with `publish reddit draft --subreddit <name> --title <title> (--text <body> | --from <base.md|->)` plus any resolved flair/state flags.
- File and stdin input recognize a BOM and LF, CRLF, or lone-CR leading frontmatter. The only accepted keys are string-valued `subreddit`, `title`, and `flair`; flags override those values in that order of precedence, and title otherwise falls back to a parser-confirmed leading ATX H1 (zero through three columns of indentation; four-space-indented text remains code). Explicitly empty `--subreddit` or `--title` values reject instead of falling back; an explicitly empty `--flair` intentionally clears file metadata and the live preflight still enforces destination requirements. Empty mappings are accepted. Unsupported keys and mapping-intent malformed YAML exit 2 before browser access. For an opener without a closer, only the first substantive block after optional comments/blank lines can establish mapping intent; later key-shaped prose cannot retroactively claim an opening thematic break. `nsfw` and `spoiler` are flag-only (`--nsfw`, `--spoiler`). Valid scalar/sequence blocks remain literal thematic-break Markdown, with only a leading transport BOM removed and all following bytes/line endings retained; inline `--text` is always literal.
- The local transport guards are 300 title code points and 40,000 body code points; actual platform limits remain server-authoritative. Flair must match a live destination-specific id or exact text.
- `--dry-run` renders locally but skips the live subreddit preflight.
- Real staging switches the editor to Markdown mode before filling the body. For old/new Reddit portability, use 4-space-indented code instead of fenced code. Tables render through both parsers, but should include leading and trailing pipes on every row and still need native review. This text-only self-post command does not upload or verify inline body images; Markdown image references need a text/link fallback or manual handling during review. If the Markdown-mode switch cannot be confirmed, follow the manual-switch advisory instead of assuming fidelity.
- Success requires Reddit's transient Draft saved toast to be absent before and visible after the one Save Draft click. A pre-existing toast is stale/ambiguous evidence and cannot confirm the attempt; an inconclusive pre-click visibility probe also fails closed. The Drafts modal can also be stale, so even a fresh toast does not prove reopen persistence. If the save control is unavailable, the command reports only that no native draft was confirmed; if no fresh toast follows the click, it returns `unconfirmed`. Both paths exit 1 and require manually comparing Reddit DRAFTS in the same CLI-owned profile before any retry. Never retry automatically or blindly: Reddit has no draft idempotency ledger, so another attempt can duplicate an existing draft.
- Human terminal output is a presentation-only projection of the same closed, recursively frozen self-post snapshot used by preflight and staging. Caller lines are visibly framed; terminal/layout controls and literal backslashes have unambiguous visible spellings. Each field and the whole command transcript are bounded; truncation reports exact original UTF-16 size plus SHA-256 over the complete unnormalised UTF-8 scalar string. Unpaired surrogates or an invalid projection exit 2 before browser/profile/native staging. Title, Markdown body, subreddit, flair, and other transport facts remain exact.
- `publish reddit draft ... --json` emits exactly one `publish.transport-receipt/v1` document; the human summary uses the same frozen facts. It keeps local validation and the live subreddit preflight separate, distinguishes Save not attempted, click delivery unknown, toast unconfirmed, and fresh-toast confirmation, and always reports `published:false`. Once the composer was populated, an unresolved Save affordance, delivery-unknown click, or unconfirmed toast exits 1 with prepared-composer/possible-draft residue and explicit same-profile/no-blind-retry guidance because another attempt can duplicate a draft; an eligibility block before content entry is distinct.

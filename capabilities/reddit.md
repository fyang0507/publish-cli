---
schemaVersion: publish.channel-info-source/v1
channel: reddit
displayName: Reddit
---
# Reddit

## CLI boundary

`publish reddit info [--json]` returns static capabilities plus passive readiness and never logs in, opens a composer, creates a draft, or posts.

Available commands are:

- `publish reddit inspect <subreddits...> [--json] [--inspect]` reports each named community's current posting contract: subscribers, allowed submission types, rules, flairs/templates, title regexes/strings, body restrictions, and captured post requirements. It reports facts only; it does not rank or choose a destination.
- `publish reddit search <query> [--limit <n>] [--include-nsfw] [--json] [--inspect]` lists candidate subreddits; the default limit is 25 and NSFW results are excluded unless requested. It reports facts only.
- `publish reddit draft --subreddit <name> --title <title> (--text <body> | --from <base.md|->) [--flair <id|text>] [--nsfw] [--spoiler] [--dry-run] [--inspect]` validates the current destination contract, switches the composer to Markdown, and chooses Save Draft. `--subreddit` and `--title` may resolve from frontmatter/leading H1 where the command supports that resolution, but both must be present after resolution. `--from -` reads stdin. Dry-run renders locally and does not open the browser or run the live subreddit preflight.

The transport supports Markdown self-posts only. It cannot upload inline body images and does not implement image, gallery, or link-post composers. The agent chooses the community and flair from live facts, satisfies the current contract, prepares title/body, and checks the save receipt. The human completes CAPTCHA/login, reviews community fit and the native draft, and alone decides whether to click Post. Reddit controls account eligibility, current rules/flairs, AutoMod, Markdown rendering, and draft persistence.

## Authentication

`inspect` and `search` are logged-out reads and do not require authentication. They start headless by default, retry headful once when Reddit returns its non-JSON 403/network-security wall, and may be forced headful with `--inspect` or started headful with `REDDIT_READS_HEADFUL=1`. An opaque 403 is a network/read block, not proof of logout.

Draft staging requires positive authentication. Run `publish reddit info` before the real draft run. The entry URL is `https://www.reddit.com/`. `PUBLISH_DATA_DIR/reddit-profile` and `PUBLISH_DATA_DIR/reddit-cookies.json` are advisory only; the passive probe uses an ephemeral profile copy and never submits credentials or invokes automatic login.

The CLI browser owns `PUBLISH_DATA_DIR/reddit-profile`; an unrelated browser session does not transfer into it, and logged-out `reddit inspect/search --inspect` does not bootstrap draft authentication. There is no separate side-effect-free CLI login command. On first use, configure `REDDIT_USERNAME` and `REDDIT_PASSWORD` (plus `REDDIT_EMAIL` if required), prepare the real intended self-post, and run that exact `publish reddit draft ... --inspect` command. Its headful Playwright window uses the persistent CLI profile: let the human complete the CAPTCHA-heavy login/challenge there, positively verify the authenticated Reddit UI, then allow the command to continue through Save Draft. After it closes, rerun `publish reddit info`; `readiness.ready=true` is the positive reusable-session check. Do not use throwaway content merely to bootstrap. Do not copy cookies to a new machine. Keep login, challenge, network, and inconclusive outcomes distinct.

## Platform specification and gotchas

### Destination contract

Always run `publish reddit inspect <subreddit>` before staging. Static info never freezes community rules. Confirm that self-posts are allowed and resolve required flair/templates, title regular expressions, required or blacklisted strings, and body restrictions. Karma, account age, bans, restricted-community/approved-submitter status are composer-only. Complete AutoMod behavior is not statically knowable. Stop and surface the exact blocker rather than bypassing it.

`publish reddit search` is discovery only; editorial routing remains the agent's responsibility. Reads may fail behind Reddit's network-security wall even when authentication is unrelated.

### Self-post format

The body remains Markdown, approximately preserving the caller's canonical source. The transport guard is 300 title code points and 40,000 body code points; actual platform maxima are unknown and server-authoritative. Flair is a live destination-specific id or exact text match. `--nsfw` and `--spoiler` set the corresponding draft state. No inline body image, media path, aspect-ratio, or attachment contract exists for this format.

Run `--dry-run` first, but remember it skips the live subreddit preflight. On the real run, the CLI re-fetches the contract, stops on known violations or eligibility blocks, opens the self-post composer, opens the body toolbar's More options menu, selects the `rpl-menu-item` named Switch to Markdown, confirms the reverse toggle or a Markdown `<textarea>`, fills the exact body, and chooses Save Draft. The fallback advisory to switch modes manually is only for genuine switch failure.

The terminal success signal is Reddit's transient Draft saved toast. Reopening the Drafts modal is not used because its list can be stale, so the receipt proves the observed save signal but not a stronger reopen/persistence claim. If the toast is absent, Save Draft is unavailable, or the composer rejects eligibility/content, do not claim a saved draft. Stop after the verified toast; never operate Post.

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

Drafting uses a CLI-owned Playwright persistent profile with `REDDIT_USERNAME` and `REDDIT_PASSWORD` (`REDDIT_EMAIL` when requested). Authentication can fail because credentials are missing or rejected, the session expired, Reddit requires CAPTCHA or another human challenge, the account is ineligible for the community, the network is blocked, or selector drift made the probe inconclusive.

To establish or recover the draft session, the agent starts the intended draft with `--inspect`; that command opens the CLI-owned profile, the human completes login/CAPTCHA there, and the same command continues afterward.

## Platform specification and gotchas

- Inspect the target immediately before drafting. Confirm self-post eligibility, required flair/templates, title regexes or required strings, and body restrictions. Karma, account age, bans, restricted-community status, and full AutoMod behavior may only surface in the composer.
- Stage with `publish reddit draft --subreddit <name> --title <title> (--text <body> | --from <base.md|->)` plus any resolved flair/state flags.
- The local transport guards are 300 title code points and 40,000 body code points; actual platform limits remain server-authoritative. Flair must match a live destination-specific id or exact text.
- `--dry-run` renders locally but skips the live subreddit preflight.
- Real staging switches the editor to Markdown mode before filling the body. If the switch cannot be confirmed, follow the manual-switch advisory instead of assuming Markdown fidelity.
- Success is Reddit's transient Draft saved toast. The Drafts modal can be stale, so the receipt does not prove reopen persistence; an absent toast means the draft is unconfirmed.

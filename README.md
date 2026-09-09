# publish-cli

`publish` is a channel-first content-distribution CLI. It provides discovery and
draft staging for X, LinkedIn, Reddit, and WeChat, plus execution guidance for
Xiaohongshu, 1point3acres, and personal websites.

CLI content commands end at a native draft for human review. The CLI never posts, publishes, sends, schedules, or makes a draft public. Agent-owned workflows follow the user-authorized outcome; a draft checkpoint does not end an explicitly authorized continuation.

## Start with channel info

Before channel work, load only the selected channel's current contract:

```bash
publish <channel> info --json
```

The response is the source of truth for supported actions and formats,
authentication, platform constraints, current readiness, recovery, executor
ownership, and stop conditions. A non-ready result still returns the static
contract and a structured readiness receipt.

When browser, network, API, token, profile, and platform access are forbidden,
request only the selected channel's packaged guidance:

```bash
publish <channel> info --static --json
```

The versioned response uses `mode: "static"`, marks readiness as unavailable
and skipped, and records that every runtime-access attempt was false. Without
`--static`, `info` retains its bounded readiness probe. Capability sources are
loaded independently, so an invalid unrelated channel source cannot break the
selected query.

```bash
publish x info --json
publish linkedin info --json
publish reddit info --json
publish wechat info --json
publish xhs info --json
publish 1point3acres info --json
publish website info --json
```

| Channel | Available surface |
|---|---|
| X | `create-watch-list`, `watch`, `draft`, `reply`, `history` |
| LinkedIn | `draft` |
| Reddit | `inspect`, `search`, `draft` |
| WeChat | `check`, `draft` |
| Xiaohongshu | Agent-browser workflow returned by `info` |
| 1point3acres | Human-handoff workflow returned by `info` |
| Website | Agent-owned repository workflow returned by `info`; verified review draft only |

Use `publish --help`, `publish <channel> --help`, and action-level `--help` for
the authoritative command and flag lists.

## Install and build

Node.js 22.19.0 or newer is required (the package metadata declares
`>=22.19.0`).

Dependency decision: this project intentionally retains `twitter-text@3.1.0`
for X's weighted-length semantics. It transitively installs deprecated
`core-js@2.6.12`, so `npm install` emits a known deprecation warning; this
decision accepts that warning rather than claiming it has been removed. Do not
override it to core-js 3 because the published `twitter-text` output imports
core-js 2 module paths. Reevaluate this decision when a vulnerability is
confirmed to apply to this CLI, a maintained compatible upstream release is
available, or an actual incompatibility with a supported runtime is reproduced.

```bash
npm install
npm run build
node dist/cli.js --help
```

Playwright prefers system Google Chrome. If it is unavailable, install the
bundled fallback once:

```bash
npx playwright install chromium
```

The build compiles the CLI and keeps it executable without reading workspace configuration or installing skills. The consuming workspace owns linking or installing the complete `skills/publish/` and `skills/article-references/` bundles; edit their canonical source in this repository. Keep the source checkout available when using links.

## Configuration

Copy `.env.example` to `.env` for credentials and machine-local settings. Copy
`watch.yaml.example` to `watch.yaml` for X watch behavior. The checked-in
examples are the authoritative configuration inventory.

Common paths and overrides:

- `PUBLISH_DATA_DIR` controls machine-local profiles, cookies, and token caches;
  the default is `~/.publish-cli`.
- `PUBLISH_DATA_REPO` selects the durable data workspace. Resolution otherwise
  uses `publish.config.dev.yaml`, then a `.agents/workspace.yaml` walk-up.
- `WECHAT_PROXY_URL` or `WECHAT_SSH_TUNNEL` supplies WeChat's fixed egress path.

Run a passive, sanitized authentication preflight when needed:

```bash
publish auth check --platform x,linkedin,reddit --json
publish auth check --platform wechat,xhs --json
```

Browser preflight never logs in, submits credentials, or opens a composer. It
probes an ephemeral profile copy and returns structured recovery. WeChat may
perform its normal token exchange and reports token renewal explicitly.

## Content and examples

Use `--text` for short inline content and `--from <file>` (or `--from -` for
stdin) for canonical Markdown. Draft commands accept exactly one content input.

```bash
publish x watch --json
publish x draft --format thread --from article.md
publish x draft --format article --from article.md --cover cover.png
publish linkedin draft --text "Draft copy"
publish reddit inspect agents --json
publish reddit draft --subreddit agents --title "Title" --from post.md
publish wechat draft --from article.md --cover cover.png
```

WeChat drafts add one extra body line of paragraph spacing and place the authored
Reference section after the body, including any separate 起笔于/完成于 paragraphs.
Canonical Markdown stays unchanged. For an original opinion draft, complete
原创声明 and 创作来源 → 个人观点，仅供参考 in the saved console draft; the API command
does not set these options. `publish wechat info` provides the handoff procedure,
and successful draft receipts flag these settings as unverified.
If the agent cannot finish these settings, it must remind the receiving human
to enable 原创声明, select 创作来源 → 个人观点，仅供参考, and save and verify both
in the existing draft **before publication**.

X Articles require an explicit JPEG, PNG, or WebP cover at an exact 5:2 ratio. The CLI uploads its validated bytes unchanged. X may resize the hosted cover; verification requires one cover with the same hosted identity, actual dimensions, rendered size and position relative to the title before and after reopening the native draft. Source dimensions remain input evidence.

X Article body images use ordinary Markdown image paragraphs in the canonical
source, for example `![](images/diagram.png)` or the empty-alt reference form
`![][diagram]`. Each image must be the only content in its top-level paragraph,
must have empty alt text and no Markdown title attribute, and must name a local
JPEG, PNG, WebP, or GIF. Nonempty-alt, mixed/nested, titled, remote, or
URL-backed images reject locally because native alt editing is not calibrated.
Relative paths in a file-backed Article are
resolved from that Markdown file's directory. Relative paths read from stdin
are resolved from one working-directory snapshot taken at invocation; absolute
local paths are also accepted. Each unique file is read once and its exact
validated bytes are staged without resizing, recompression, conversion, or
other transformation. X does not expose a stable body-image limit here, so
server acceptance remains authoritative.

Real image-bearing Article staging requires `--inspect` (headed mode). Each
body image uses one newly created native Media input once, in Markdown
occurrence order; a missing/ambiguous target, rejected delivery, or uncertain
observation stops the run without fallback or automatic retry. Observation is
limited to the calibrated noneditable Media atom. X-native control text inside
that exact atom is excluded from Markdown comparison; other text is not. A
same-origin blob preview must fetch as a nonempty native representation with
the expected available MIME and dimensions. X may rewrite the uploaded bytes,
so the first positively observed native digest becomes the domain-bound
persistence identity and must survive canonical reopen. The source digest and
size remain request evidence; private preview URLs are never emitted. The command
still stops at a verified native draft for human review and never posts.

Add `--json` to any draft command (or `x reply`) to receive exactly one
`publish.transport-receipt/v1` JSON document. It reports the selected channel
and format, local/live/skipped validation, warnings and gotchas, ordered asset
progress, whether the platform was touched, terminal native-draft state,
verification strength/reference, partial remote residue, `published:false`, and
the exit class. Large evidence sets stay bounded: the receipt includes total,
listed, and omitted counts plus a SHA-256 identity of each exact ordered set and
complete asset-stage truth counts. Human summaries are rendered from the same frozen receipt.
Exit 0 means a valid dry-run or positively verified native stage, exit 1 means a
runtime/platform/durable-state failure, and exit 2 means invalid caller input.

These examples are illustrative. Consult the selected channel's `info` response
and action help before execution.

## State and skill installation

Machine-local authentication artifacts live under `PUBLISH_DATA_DIR` and must
stay outside the repository and cloud-synced paths. Durable dedupe state lives
at `<data_repo>/.publish-cli/publish.db` when a data workspace resolves, and
falls back to `<PUBLISH_DATA_DIR>/publish.db` otherwise.

The X seen-store and reply ledger are separate. Real reply runners sharing the
same live SQLite file and machine-local X profile origin reserve a target before
browser staging, then finalize history only after staging returns. The profile
stores a private random opaque identity; the reply database binds to it
atomically and new reply rows retain it. This is one-machine/local-profile
coordination, not a shared service: copying or synchronizing the database does
not coordinate another profile or machine and a bound-origin mismatch stops
before browser work. On first post-upgrade use, binding applies prospectively;
legacy rows remain origin-unknown and cannot be attributed, force-bypassed, or
recovered automatically. `--force` can bypass matching finalized history for an
intentional re-stage, but it never bypasses an in-flight, retained,
origin-unknown, or origin-mismatched claim.

The publish agent skill is intentionally a small, self-contained router. It
contains no copied channel manual or dependency on this source checkout; native
`info` supplies channel-specific guidance progressively at runtime.

## Development

```bash
npm test
npm pack --dry-run
```

TypeScript uses Node ESM, so local imports include `.js`. Browser and API flows
need live verification before they are claimed usable; compilation alone does
not validate selectors, authentication, platform contracts, or saved drafts.

See [PRODUCT_SPEC.md](./docs/PRODUCT_SPEC.md) for product scope and roadmap,
[AUTH_READINESS.md](./docs/AUTH_READINESS.md) for the readiness contract, and
[AGENTS.md](./AGENTS.md) for contributor invariants. Open work is tracked in
[GitHub issues](https://github.com/fyang0507/publish-cli/issues).

### Website subagent handoff

`publish website info --json` describes the article language, metadata, tag,
and media expectations and instructs the operating agent to launch a headless
subagent in the selected website checkout/worktree. The subagent loads that
repository's own `add-website-content` skill and follows its content workflow.
No website skill is nested or linked under the publish skill.

Resolve caller-relative source/media paths before dispatch and give the subagent
accessible inputs. The subagent verifies the content locally and returns a review
branch/commit or draft PR plus audit and browser evidence. The parent reviews the
result before reporting success. Missing repository-local skills or unavailable
repository-scoped delegation are setup blockers. The CLI does not launch agents,
stage website content, merge, or deploy.

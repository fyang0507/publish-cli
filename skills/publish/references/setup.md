# Setup and workspace resolution

Read this reference only when `publish` is not installed, built, or current with
its source checkout, or when its machine-local or durable workspace cannot be resolved. For channel credentials,
authentication recovery, inputs, and platform constraints, run
`publish <channel> info --json`; do not reconstruct those contracts here.

## Install and build

From the publish-cli repository:

```bash
npm install
npm run build
node dist/cli.js --help
```

The build compiles `dist/`, makes the binary executable, and installs a symlink
to the complete `skills/publish/` directory when a destination workspace can be
resolved. Use `node dist/cli.js <command>` directly when the `publish` binary is
not linked.

Rebuild after switching revisions or changing `src/`, `capabilities/`, or the
skill. Do not treat a stale `dist/` tree as the current execution oracle.

Playwright prefers installed Google Chrome and falls back to bundled Chromium.
If neither is available, install the fallback with:

```bash
npx playwright install chromium
```

## Configuration

Copy `.env.example` to the gitignored `.env`, then use the selected channel's
native info response and action help to determine which values or configuration
files are required.

Never commit `.env`, browser profiles, cookies, token caches, or other session
artifacts. Never copy session artifacts between machines; follow the selected
channel's native recovery step to establish fresh machine-local state.

## State has two homes

- Machine-local session artifacts live under `PUBLISH_DATA_DIR` (default
  `~/.publish-cli`). Keep this directory off cloud-synced storage and out of the
  repository.
- Durable dedupe state lives at `<data_repo>/.publish-cli/`. The installed skill
  symlink also targets `<data_repo>/.agents/skills/`.

The data repository resolves in this order:

1. `PUBLISH_DATA_REPO`.
2. `data_repo_path` in `publish.config.dev.yaml` beside the CLI.
3. Walking upward from the current directory for `.agents/workspace.yaml`.

If none resolves, durable state falls back to `PUBLISH_DATA_DIR` and the build
skips the workspace skill symlink. `PUBLISH_SKILLS_DIR` overrides only the skill
symlink destination.

After setup, return to [the router](../SKILL.md) and query native channel info
before executing the selected action.

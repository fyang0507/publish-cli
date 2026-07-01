import { Command } from "commander";
import { env } from "../config.js";
import { XListManager, type XFollowedUser, type AddMemberResult } from "../x/lists.js";

/**
 * `publish x create-watch-list` — build/populate an X List, the PRECURSOR to
 * account-based watching (`publish x watch --x-list <id>`).
 *
 * The watcher reads a List's merged member timeline in ONE fetch, so watching N
 * accounts is far cheaper via a List than N per-account fetches. This command
 * assembles that List — by default seeded from the accounts you already follow.
 *
 * Flow (`--from-following`, the default source):
 *   1. Enumerate the accounts a handle follows (capture X's Following GraphQL).
 *   2. Create a new List (or reuse --x-list) via X's list mutations, driven
 *      in-page from the logged-in browser (see src/x/lists.ts).
 *   3. Add every followed account as a member (one mutation each; tolerant of
 *      X's partial DecodeException responses).
 *   4. Enforce privacy (default private) and read member_count back to verify.
 *   5. Print the list id, ready to drop into `watch.yaml` or `watch --x-list`.
 *
 * NEVER posts; this only manages List membership. Like the rest of the CLI it
 * reuses the one logged-in session (session.ts).
 */
export function registerCreateWatchListCommand(x: Command): void {
  x
    .command("create-watch-list")
    .description("Create or populate an X List (precursor to `watch --x-list`), by default from the accounts you follow")
    .option(
      "--from-following",
      "Seed members from the accounts <handle> follows (default source)",
    )
    .option(
      "--handle <handle>",
      "Whose Following to read (defaults to the logged-in X_USERNAME)",
    )
    .option("--name <name>", "List name (used on create; also re-applied on update)")
    .option("--description <text>", "List description", "")
    .option(
      "--x-list <id>",
      "Reuse/populate an EXISTING X List (by id) instead of creating one (idempotent top-up)",
    )
    .option("--private", "Make the List private (default)")
    .option("--public", "Make the List public")
    .option(
      "--limit <n>",
      "Max accounts to enumerate from Following",
      parsePositiveInt,
    )
    .option(
      "--dry-run",
      "Enumerate + report who WOULD be added; create/add nothing",
    )
    .option("--inspect", "Headful browser if a (re-)login is needed, so a human can calibrate")
    .option("--json", "Emit machine JSON instead of the human-readable summary")
    .action(async (opts: CreateWatchListOptions) => {
      await runCreateWatchList(opts);
    });
}

interface CreateWatchListOptions {
  fromFollowing?: boolean;
  handle?: string;
  name?: string;
  description?: string;
  xList?: string;
  private?: boolean;
  public?: boolean;
  limit?: number;
  dryRun?: boolean;
  inspect?: boolean;
  json?: boolean;
}

function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`expected a positive integer, got "${raw}"`);
  }
  return n;
}

async function runCreateWatchList(opts: CreateWatchListOptions): Promise<void> {
  if (opts.private && opts.public) {
    throw new Error("Pass only one of --private / --public.");
  }
  // Default source is the accounts you follow; it's currently the only source,
  // so we don't force the flag, but we document it as the default.
  const isPrivate = opts.public ? false : true; // default private
  const handle = (opts.handle ?? env.X_USERNAME).replace(/^@/, "").trim();
  if (!handle) {
    throw new Error(
      "No handle to read Following from: pass --handle or set X_USERNAME in .env.",
    );
  }
  const name = opts.name ?? (opts.xList ? undefined : "Watchlist");

  const mgr = new XListManager({ inspect: opts.inspect });
  await mgr.init();

  try {
    // 1. Enumerate the source accounts (the accounts <handle> follows).
    const following = await mgr.enumerateFollowing(handle, opts.limit ?? 5000);

    if (opts.dryRun) {
      emitDryRun(handle, following, opts.json === true);
      return;
    }

    if (following.length === 0) {
      throw new Error(
        `Enumerated 0 accounts from @${handle}'s Following — refusing to create an empty List. ` +
          `Re-run with --inspect if a login/selector issue is suspected.`,
      );
    }

    // 2. Create the List (or reuse an existing one).
    let listId = opts.xList;
    let created = false;
    if (!listId) {
      listId = await mgr.createList(name ?? "Watchlist", opts.description ?? "");
      created = true;
    }

    // 3. Add every followed account as a member.
    const results = await mgr.addMembers(listId, following);

    // 4. Enforce privacy + name (UpdateList is the reliable privacy path). Only
    //    set name on update when we know it (create path, or explicit --name).
    const updateName = name ?? (await mgr.getMeta(listId)).name ?? "Watchlist";
    await mgr.setPrivacy(listId, updateName, isPrivate, opts.description ?? "");

    // 5. Verify via a fresh read.
    const meta = await mgr.getMeta(listId);

    emit(
      { handle, listId, created, name: updateName, isPrivate, following, results, meta },
      opts.json === true,
    );
  } finally {
    await mgr.close();
  }
}

interface ListRunSummary {
  handle: string;
  listId: string;
  created: boolean;
  name: string;
  isPrivate: boolean;
  following: XFollowedUser[];
  results: AddMemberResult[];
  meta: { memberCount?: number; mode?: string; name?: string };
}

function emitDryRun(handle: string, following: XFollowedUser[], asJson: boolean): void {
  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        { handle, dryRun: true, count: following.length, members: following },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const lines = [`Dry run: @${handle} follows ${following.length} account(s) that WOULD be added:`];
  following.forEach((u, i) => lines.push(`  ${i + 1}. @${u.handle}${u.name ? `  (${u.name})` : ""}`));
  lines.push("");
  lines.push("Re-run without --dry-run to create the List and add them.");
  process.stdout.write(lines.join("\n") + "\n");
}

function emit(s: ListRunSummary, asJson: boolean): void {
  const failed = s.results.filter((r) => !r.ok);
  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          handle: s.handle,
          listId: s.listId,
          url: `https://x.com/i/lists/${s.listId}`,
          created: s.created,
          name: s.name,
          requestedPrivate: s.isPrivate,
          followingCount: s.following.length,
          added: s.results.filter((r) => r.ok).length,
          failed: failed.map((r) => ({ handle: r.handle, error: r.error })),
          verified: { memberCount: s.meta.memberCount, mode: s.meta.mode, name: s.meta.name },
          watchHint: `publish x watch --x-list ${s.listId}`,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const ok = s.results.filter((r) => r.ok).length;
  const lines: string[] = [];
  lines.push(
    `${s.created ? "Created" : "Updated"} X List "${s.meta.name ?? s.name}" (${s.meta.mode ?? (s.isPrivate ? "Private" : "Public")})`,
  );
  lines.push(`  id:      ${s.listId}`);
  lines.push(`  url:     https://x.com/i/lists/${s.listId}`);
  lines.push(`  source:  @${s.handle} Following (${s.following.length} account(s))`);
  lines.push(`  added:   ${ok}/${s.following.length}` + (failed.length ? `  (${failed.length} failed)` : ""));
  if (s.meta.memberCount != null) lines.push(`  members: ${s.meta.memberCount} (verified)`);
  if (failed.length) {
    lines.push("");
    lines.push("Failed adds (retry-able):");
    for (const r of failed) lines.push(`  ! @${r.handle}: ${r.error}`);
  }
  lines.push("");
  lines.push(`Now watch it:  publish x watch --x-list ${s.listId}`);
  process.stdout.write(lines.join("\n") + "\n");
}

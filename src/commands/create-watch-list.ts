import { Command } from "commander";
import { env } from "../config.js";
import type { XFollowedUser, AddMemberResult } from "../x/lists.js";

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
    .addHelpText(
      "after",
      "\nList member-add safety (read before any mutation):\n" +
        "  Run --dry-run first to inspect the exact proposed delta. A large initial build makes many first-time adds and can trigger X's account-wide member-add lock, which also blocks member adds in the native UI across every List.\n" +
        "  Live observation 2026-07-01: a 72-member build at about 350 ms per add triggered the lock; recovery was around 24 hours. That duration and all current limits remain X/server-authoritative, not a retry timer.\n" +
        "  On the lock or its not-allowed/403 signal, the command stops. Do not retry member adds until X permits them again.\n" +
        "  Refreshing an existing --x-list adds only the missing delta and throttles additions to about 3 seconds each. It is safer than a large first build, not guaranteed against server limits.\n" +
        "  This command can mutate List creation, membership, and privacy, but it never publishes content.\n",
    )
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

  const { XListManager } = await import("../x/lists.js");
  const mgr = new XListManager({ inspect: opts.inspect });
  await mgr.init();

  try {
    // 1. Enumerate the source accounts (the accounts <handle> follows).
    const following = await mgr.enumerateFollowing(handle, opts.limit ?? 5000);

    if (opts.dryRun) {
      // Honest dry-run: when reusing a List, show the REAL delta (only new
      // follows would be added), not the full follow dump. No-list create case:
      // the delta is all follows (nothing is a member yet).
      if (opts.xList) {
        const current = await mgr.getMembers(opts.xList);
        emitDryRun(handle, following, computeDelta(following, current), current.length, opts.json === true);
      } else {
        emitDryRun(handle, following, following, 0, opts.json === true);
      }
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

    // 3. Compute the delta and add ONLY new accounts. A freshly created List is
    //    empty (skip the read); a reused List is diffed so we never re-add
    //    existing members (which is what tripped X's account-level add lock).
    const current = created ? [] : await mgr.getMembers(listId);
    const toAdd = computeDelta(following, current);
    if (!created && current.length === 0) {
      process.stderr.write(
        `[create-watch-list] Warning: existing List ${listId} read back 0 members — ` +
          `if it isn't genuinely empty, the members read may have been blocked; all follows would be re-added.\n`,
      );
    }
    if (toAdd.length > 20) {
      process.stderr.write(
        `[create-watch-list] Warning: ${toAdd.length} accounts to add are throttled (~${Math.round((toAdd.length * 3) / 60)}min) and a large bulk risks X's account-level add rate lock.\n`,
      );
    }
    const results: AddMemberResult[] = toAdd.length ? await mgr.addMembers(listId, toAdd) : [];

    // 4. Enforce privacy + name (UpdateList is the reliable privacy path). Only
    //    set name on update when we know it (create path, or explicit --name).
    const updateName = name ?? (await mgr.getMeta(listId)).name ?? "Watchlist";
    await mgr.setPrivacy(listId, updateName, isPrivate, opts.description ?? "");

    // 5. Verify via a fresh read.
    const meta = await mgr.getMeta(listId);

    emit(
      {
        handle,
        listId,
        created,
        name: updateName,
        isPrivate,
        following,
        alreadyMembers: current.length,
        toAdd,
        results,
        meta,
      },
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
  alreadyMembers: number;
  toAdd: XFollowedUser[];
  results: AddMemberResult[];
  meta: { memberCount?: number; mode?: string; name?: string };
}

/**
 * Diff Following against current List members: return only the accounts NOT yet
 * in the List. Match primarily by numeric user id; fall back to lowercased
 * handle when an id is missing. An empty `current` yields all of `following`.
 */
function computeDelta(following: XFollowedUser[], current: XFollowedUser[]): XFollowedUser[] {
  const currentIds = new Set(current.map((u) => u.id));
  const currentHandles = new Set(current.map((u) => u.handle.toLowerCase()));
  return following.filter((f) =>
    f.id ? !currentIds.has(f.id) : !currentHandles.has(f.handle.toLowerCase()),
  );
}

function emitDryRun(
  handle: string,
  following: XFollowedUser[],
  toAdd: XFollowedUser[],
  alreadyMembers: number,
  asJson: boolean,
): void {
  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          handle,
          dryRun: true,
          followingCount: following.length,
          alreadyMembers,
          toAdd: toAdd.length,
          members: toAdd,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const lines = [
    `Dry run: @${handle} follows ${following.length} account(s); ${alreadyMembers} already in the List; ${toAdd.length} would be added:`,
  ];
  toAdd.forEach((u, i) => lines.push(`  ${i + 1}. @${u.handle}${u.name ? `  (${u.name})` : ""}`));
  lines.push("");
  lines.push(
    toAdd.length
      ? "Re-run without --dry-run to add them."
      : "Already in sync — nothing to add.",
  );
  process.stdout.write(lines.join("\n") + "\n");
}

function emit(s: ListRunSummary, asJson: boolean): void {
  // Distinguish genuine per-user failures from un-attempted (skipped) users.
  const failed = s.results.filter((r) => !r.ok && !r.skipped);
  const skipped = s.results.filter((r) => r.skipped);
  const rateLimited = s.results.some((r) => r.rateLimited);
  const ok = s.results.filter((r) => r.ok).length;
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
          alreadyMembers: s.alreadyMembers,
          toAdd: s.toAdd.length,
          added: ok,
          skipped: skipped.length,
          rateLimited,
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
  const lines: string[] = [];
  lines.push(
    `${s.created ? "Created" : "Updated"} X List "${s.meta.name ?? s.name}" (${s.meta.mode ?? (s.isPrivate ? "Private" : "Public")})`,
  );
  lines.push(`  id:      ${s.listId}`);
  lines.push(`  url:     https://x.com/i/lists/${s.listId}`);
  lines.push(`  source:  @${s.handle} Following (${s.following.length} account(s))`);
  lines.push(`  already members: ${s.alreadyMembers}`);
  if (s.toAdd.length === 0) {
    lines.push(`  added:   already in sync — nothing to add`);
  } else {
    lines.push(
      `  added:   ${ok}/${s.toAdd.length}` + (failed.length ? `  (${failed.length} failed)` : ""),
    );
  }
  if (s.meta.memberCount != null) lines.push(`  members: ${s.meta.memberCount} (verified)`);
  if (rateLimited) {
    lines.push("");
    lines.push(
      `! X account-level add lock hit — stopped early; ${skipped.length} un-attempted account(s) skipped.`,
    );
    lines.push("  Wait for the lock to clear (~24h) before re-running.");
  }
  if (failed.length) {
    lines.push("");
    lines.push("Failed adds (retry-able):");
    for (const r of failed) lines.push(`  ! @${r.handle}: ${r.error}`);
  }
  lines.push("");
  lines.push(`Now watch it:  publish x watch --x-list ${s.listId}`);
  process.stdout.write(lines.join("\n") + "\n");
}

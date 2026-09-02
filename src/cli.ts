#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { registerWatchCommand } from "./commands/watch.js";
import { registerDraftCommand } from "./commands/draft.js";
import { registerReplyCommand } from "./commands/reply.js";
import { registerHistoryCommand } from "./commands/history.js";
import { registerCreateWatchListCommand } from "./commands/create-watch-list.js";
import { registerLinkedInDraftCommand } from "./commands/linkedin-draft.js";
import { registerRedditInspectCommand } from "./commands/reddit-inspect.js";
import { registerRedditSearchCommand } from "./commands/reddit-search.js";
import { registerRedditDraftCommand } from "./commands/reddit-draft.js";
import { registerWechatCheckCommand } from "./commands/wechat-check.js";
import { registerWechatDraftCommand } from "./commands/wechat-draft.js";
import { registerAuthCheckCommand } from "./commands/auth-check.js";
import { registerChannelInfoCommand } from "./commands/channel-info.js";

const program = new Command();

// Install the override before subcommands are created so Commander propagates it
// to parse-time option errors raised by those child commands.
program.exitOverride();

program
  .name("publish")
  .description("Per-channel content distribution toolkit")
  .version("0.1.0");

const auth = program
  .command("auth")
  .description("Passive authentication readiness checks and recovery descriptors");

registerAuthCheckCommand(auth);

// Channel-first: each channel groups its OWN action space, because those spaces
// diverge (X needs create-watch-list; other channels won't). X is the only
// channel built today; add a sibling `publish <channel> ...` group per platform.
const x = program
  .command("x")
  .description("X channel: info + create-watch-list + watch + draft + reply + history");

registerChannelInfoCommand(x, "x");

// --- create-watch-list: build the account-based watch List (precursor to `watch --x-list`) ---
registerCreateWatchListCommand(x);

// --- watch: borrowed-reach loop (poll + dedupe + triage) ---
registerWatchCommand(x);

// --- draft: owned-content publisher (native X drafts, never posts) ---
registerDraftCommand(x);

// --- reply: targeted reply drafts (watcher -> publisher loop; never posts) ---
registerReplyCommand(x);

// --- history: read the operator's OWN published posts + replies (never posts) ---
registerHistoryCommand(x);

// LinkedIn channel: PUBLISH only today (native post drafts, never posts). Watch
// (borrowed-reach) is a separate, future design.
const linkedin = program
  .command("linkedin")
  .description("LinkedIn channel: info + draft (native post drafts, never posts)");

registerChannelInfoCommand(linkedin, "linkedin");

// --- draft: owned-content publisher (native LinkedIn post drafts, never posts) ---
registerLinkedInDraftCommand(linkedin);

// Reddit channel: inspect/search (subreddit facts) + draft (native self-post
// drafts, never posts). No watch (borrowed-reach) loop today.
const reddit = program
  .command("reddit")
  .description("Reddit channel: info + inspect/search (subreddit facts) + draft (native self-post drafts, never posts)");

registerChannelInfoCommand(reddit, "reddit");

// --- inspect: subreddit facts (rules/flair/posting requirements) ---
registerRedditInspectCommand(reddit);

// --- search: find subreddits / posts ---
registerRedditSearchCommand(reddit);

// --- draft: owned-content publisher (native Reddit self-post drafts, never posts) ---
registerRedditDraftCommand(reddit);

// WeChat Official Account channel: API-driven (first non-browser channel).
// check (credentials/token/IP-allowlist preflight) + draft (native article drafts,
// never posts). No watch loop today.
const wechat = program
  .command("wechat")
  .description("WeChat Official Account channel: info + check (credentials/IP) + draft (native article drafts, never posts)");

registerChannelInfoCommand(wechat, "wechat");

// --- check: credential + token + IP-allowlist preflight (travel-aware) ---
registerWechatCheckCommand(wechat);

// --- draft: owned-content publisher (native WeChat article drafts, never posts) ---
registerWechatDraftCommand(wechat);

// Downstream channel contracts intentionally begin with truthful discovery only.
// #35 owns Xiaohongshu execution details; #37 owns the 1point3acres handoff.
const xhs = program
  .command("xhs")
  .description("Xiaohongshu channel: static info + agent-owned readiness only");
registerChannelInfoCommand(xhs, "xhs");

const onePointThreeAcres = program
  .command("1point3acres")
  .description("1point3acres channel: static info + manual-handoff readiness only");
registerChannelInfoCommand(onePointThreeAcres, "1point3acres");

try {
  await program.parseAsync();
} catch (error) {
  if (!(error instanceof CommanderError)) throw error;
  if (error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    const isAuthCheck = process.argv[2] === "auth" && process.argv[3] === "check";
    const isChannelInfo = process.argv[3] === "info";
    process.exitCode = isAuthCheck || isChannelInfo ? 2 : error.exitCode;
  }
}

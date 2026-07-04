#!/usr/bin/env node
import { Command } from "commander";
import { registerWatchCommand } from "./commands/watch.js";
import { registerDraftCommand } from "./commands/draft.js";
import { registerReplyCommand } from "./commands/reply.js";
import { registerCreateWatchListCommand } from "./commands/create-watch-list.js";
import { registerLinkedInDraftCommand } from "./commands/linkedin-draft.js";
import { registerRedditInspectCommand } from "./commands/reddit-inspect.js";
import { registerRedditSearchCommand } from "./commands/reddit-search.js";
import { registerRedditDraftCommand } from "./commands/reddit-draft.js";
import { registerWechatCheckCommand } from "./commands/wechat-check.js";
import { registerWechatDraftCommand } from "./commands/wechat-draft.js";

const program = new Command();

program
  .name("publish")
  .description("Per-channel content distribution toolkit")
  .version("0.1.0");

// Channel-first: each channel groups its OWN action space, because those spaces
// diverge (X needs create-watch-list; other channels won't). X is the only
// channel built today; add a sibling `publish <channel> ...` group per platform.
const x = program
  .command("x")
  .description("X channel: create-watch-list + watch + draft + reply");

// --- create-watch-list: build the account-based watch List (precursor to `watch --x-list`) ---
registerCreateWatchListCommand(x);

// --- watch: borrowed-reach loop (poll + dedupe + triage) ---
registerWatchCommand(x);

// --- draft: owned-content publisher (native X drafts, never posts) ---
registerDraftCommand(x);

// --- reply: targeted reply drafts (watcher -> publisher loop; never posts) ---
registerReplyCommand(x);

// LinkedIn channel: PUBLISH only today (native post drafts, never posts). Watch
// (borrowed-reach) is a separate, future design.
const linkedin = program
  .command("linkedin")
  .description("LinkedIn channel: draft (native post drafts, never posts)");

// --- draft: owned-content publisher (native LinkedIn post drafts, never posts) ---
registerLinkedInDraftCommand(linkedin);

// Reddit channel: inspect/search (subreddit facts) + draft (native self-post
// drafts, never posts). No watch (borrowed-reach) loop today.
const reddit = program
  .command("reddit")
  .description("Reddit channel: inspect/search (subreddit facts) + draft (native self-post drafts, never posts)");

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
  .description("WeChat Official Account channel: check (credentials/IP) + draft (native article drafts, never posts)");

// --- check: credential + token + IP-allowlist preflight (travel-aware) ---
registerWechatCheckCommand(wechat);

// --- draft: owned-content publisher (native WeChat article drafts, never posts) ---
registerWechatDraftCommand(wechat);

program.parse();

#!/usr/bin/env node
import { Command } from "commander";
import { registerWatchCommand } from "./commands/watch.js";
import { registerDraftCommand } from "./commands/draft.js";
import { registerReplyCommand } from "./commands/reply.js";
import { registerCreateWatchListCommand } from "./commands/create-watch-list.js";

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

program.parse();

#!/usr/bin/env node
import { Command } from "commander";
import { registerWatchCommand } from "./commands/watch.js";
import { registerDraftCommand } from "./commands/draft.js";
import { registerReplyCommand } from "./commands/reply.js";

const program = new Command();

program
  .name("publish")
  .description("Per-channel content distribution toolkit (X channel) — watch + draft + reply")
  .version("0.1.0");

// --- watch: borrowed-reach loop (poll + dedupe + triage) ---
registerWatchCommand(program);

// --- draft: owned-content publisher (native X drafts, never posts) ---
registerDraftCommand(program);

// --- reply: targeted reply drafts (watcher -> publisher loop; never posts) ---
registerReplyCommand(program);

program.parse();

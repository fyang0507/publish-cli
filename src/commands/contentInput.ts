import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve the canonical content source for the drafting commands — `x draft` /
 * `x reply` / `linkedin draft` / `reddit draft` / `wechat draft` (the resolver is
 * channel-agnostic; each channel's own generator interprets the returned markdown).
 * Short posts (tweets, replies) shouldn't require staging a scratch markdown file,
 * so every consumer accepts EXACTLY ONE of:
 *   --text <content>   inline markdown, used verbatim (the ergonomic path)
 *   --from <base.md>   a canonical markdown file, OR "-" to read stdin (pipes)
 *
 * The resolved value is a markdown string handed straight to generateContent()
 * — inline text is just prose, so the deterministic parser / char-fit / code &
 * link flagging all apply unchanged. Usage errors exit(2) with a clear message.
 */
export interface ContentInputOptions {
  from?: string;
  text?: string;
}

export function resolveContentInput(opts: ContentInputOptions): string {
  const hasFrom = opts.from !== undefined;
  const hasText = opts.text !== undefined;

  // Exactly-one: reject both-missing and both-present up front (clearer than
  // silently letting one win).
  if (hasFrom && hasText) {
    console.error("Provide exactly one of --text <content> or --from <base.md>, not both.");
    process.exit(2);
  }
  if (!hasFrom && !hasText) {
    console.error("Provide the content via --text <content> or --from <base.md>.");
    process.exit(2);
  }

  if (hasText) {
    if (!opts.text!.trim()) {
      console.error("--text was empty. Provide the content inline, or use --from <base.md>.");
      process.exit(2);
    }
    return opts.text!;
  }

  // --from "-" = read stdin, so `pbpaste | publish x reply --to … --from -` works.
  if (opts.from === "-") {
    const md = readFileSync(0, "utf-8");
    if (!md.trim()) {
      console.error("No content on stdin (--from -).");
      process.exit(2);
    }
    return md;
  }

  const fromPath = resolve(opts.from!);
  if (!existsSync(fromPath)) {
    console.error(`Base markdown not found: ${fromPath}`);
    process.exit(2);
  }
  return readFileSync(fromPath, "utf-8");
}

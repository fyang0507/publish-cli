/**
 * Post-build hook (mirrors outreach-cli's):
 *   1. `chmod +x dist/cli.js` so the `publish` bin stays executable even on
 *      filesystems that don't preserve the exec bit (e.g. Google Drive FUSE).
 *   2. Best-effort installation of shipped agent skills as symlinks under the
 *      agent's skills directory.
 *
 * publish-cli lives on Google Drive but the agent it serves lives at a fixed
 * workspace root, so the skills target is that root's .agents/skills/ rather
 * than a dynamically-resolved data repo. Override with PUBLISH_SKILLS_DIR if
 * the workspace ever moves.
 */

import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

chmodSync("dist/cli.js", 0o755);

const SKILLS_TARGET_DIR =
  process.env.PUBLISH_SKILLS_DIR ||
  "/Users/fredy/Downloads/fred-agent/.agents/skills";

try {
  const skills = ["publish"];

  mkdirSync(SKILLS_TARGET_DIR, { recursive: true });

  for (const skill of skills) {
    const dest = join(SKILLS_TARGET_DIR, skill);
    const source = resolve("skills", skill);
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(source, dest, "dir");
    console.log(`Agent skill symlink installed -> ${dest} -> ${source}`);
  }
} catch (err) {
  console.log(`Agent skill symlink skipped: ${err.message}`);
}

/**
 * Post-build hook (mirrors outreach-cli's):
 *   1. `chmod +x dist/cli.js` so the `publish` bin stays executable even on
 *      filesystems that don't preserve the exec bit (e.g. Google Drive FUSE).
 *   2. Best-effort installation of shipped agent skills as symlinks under
 *      <data_repo>/.agents/skills/ when a data repo is resolvable.
 *
 * The skills target is resolved via the SAME helper the CLI uses (dist/dataRepo.js:
 * PUBLISH_DATA_REPO env → publish.config.dev.yaml → .agents/workspace.yaml walk-up),
 * so there is NO hardcoded workspace path. PUBLISH_SKILLS_DIR overrides the target
 * dir outright. If none resolves (e.g. a fresh clone with no workspace configured),
 * the symlink step is skipped — the build still succeeds.
 */

import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

chmodSync("dist/cli.js", 0o755);

try {
  let skillsTargetDir = process.env.PUBLISH_SKILLS_DIR?.trim();
  if (!skillsTargetDir) {
    const { resolveDataRepo } = await import("../dist/dataRepo.js");
    const { path: dataRepo } = resolveDataRepo();
    skillsTargetDir = join(dataRepo, ".agents", "skills");
  }

  const skills = ["publish"];
  mkdirSync(skillsTargetDir, { recursive: true });

  for (const skill of skills) {
    const dest = resolve(skillsTargetDir, skill);
    const source = resolve("skills", skill);
    // Emit a RELATIVE link target. An absolute target bakes this machine's
    // current checkout path into the *data repo*, so moving or re-cloning
    // publish-cli silently leaves a dangling skill symlink behind in a repo
    // that never gets rebuilt. A relative target survives any move that keeps
    // the two repos in the same relative position, and fails loudly otherwise.
    const target = relative(dirname(dest), source);
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(target, dest, "dir");
    console.log(`Agent skill symlink installed -> ${dest} -> ${target}`);
  }
} catch (err) {
  console.log(
    `Agent skill symlink skipped: ${err.message}\n` +
      "  (set PUBLISH_DATA_REPO, add publish.config.dev.yaml with data_repo_path, " +
      "or set PUBLISH_SKILLS_DIR to install the skill symlink.)",
  );
}

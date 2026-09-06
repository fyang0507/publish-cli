/**
 * Post-build hook:
 *   1. Keep dist/cli.js executable on filesystems that lose the mode bit.
 *   2. Best-effort link shipped agent skills under <data_repo>/.agents/skills/.
 *
 * Relative symlinks keep the checkout authoritative and survive moving sibling
 * repositories together. Existing installations are replaced directly.
 */

import { chmodSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { fileURLToPath } from "node:url";

const repoRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
chmodSync(join(repoRoot, "dist/cli.js"), 0o755);

try {
  let skillsTargetDir = process.env.PUBLISH_SKILLS_DIR?.trim();
  if (!skillsTargetDir) {
    const { resolveDataRepo } = await import("../dist/dataRepo.js");
    const { path: dataRepo } = resolveDataRepo();
    skillsTargetDir = join(dataRepo, ".agents", "skills");
  }

  const skills = ["article-references", "publish"];
  mkdirSync(skillsTargetDir, { recursive: true });
  // Resolve symlinked parents before calculating relative link targets.
  skillsTargetDir = realpathSync(skillsTargetDir);

  for (const skill of skills) {
    const dest = resolve(skillsTargetDir, skill);
    const source = join(repoRoot, "skills", skill);
    if (dest === source) throw new Error(`Skill destination is its source: ${dest}`);
    if (!lstatSync(join(source, "SKILL.md")).isFile()) {
      throw new Error(`Missing skill entrypoint: ${source}`);
    }
    const linkTarget = relative(dirname(dest), source);
    let existing;
    try {
      existing = lstatSync(dest);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (existing?.isSymbolicLink() && readlinkSync(dest) === linkTarget) continue;
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(linkTarget, dest, "dir");
    console.log(`Agent skill symlink installed -> ${dest} -> ${linkTarget}`);
  }
} catch (err) {
  console.log(
    `Agent skill installation skipped: ${err.message}\n` +
      "  (set PUBLISH_DATA_REPO, add publish.config.dev.yaml with data_repo_path, " +
      "or set PUBLISH_SKILLS_DIR to install the skills.)",
  );
}

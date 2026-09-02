/**
 * Post-build hook:
 *   1. Keep dist/cli.js executable on filesystems that lose the mode bit.
 *   2. Best-effort copy shipped agent skills under <data_repo>/.agents/skills/.
 *
 * Skills are copied, not symlinked, so an installed skill remains usable when
 * the publish-cli package or source checkout is moved or removed.
 */

import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

chmodSync("dist/cli.js", 0o755);

try {
  let skillsTargetDir = process.env.PUBLISH_SKILLS_DIR?.trim();
  if (!skillsTargetDir) {
    const { resolveDataRepo } = await import("../dist/dataRepo.js");
    const { path: dataRepo } = resolveDataRepo();
    skillsTargetDir = join(dataRepo, ".agents", "skills");
  }

  const skills = ["article-references", "publish"];
  mkdirSync(skillsTargetDir, { recursive: true });

  for (const skill of skills) {
    const dest = resolve(skillsTargetDir, skill);
    const source = resolve("skills", skill);
    rmSync(dest, { recursive: true, force: true });
    cpSync(source, dest, { recursive: true });
    console.log(`Agent skill installed -> ${dest}`);
  }
} catch (err) {
  console.log(
    `Agent skill installation skipped: ${err.message}\n` +
      "  (set PUBLISH_DATA_REPO, add publish.config.dev.yaml with data_repo_path, " +
      "or set PUBLISH_SKILLS_DIR to install the skills.)",
  );
}

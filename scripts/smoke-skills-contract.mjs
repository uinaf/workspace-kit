import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = mkdtempSync(join(tmpdir(), "workspace-kit-skills-contract-"));
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const skillName = process.env.SKILLS_CONTRACT_NAME ?? "workspace-kit-fixture";
const source = process.env.SKILLS_CONTRACT_SOURCE ?? "uinaf/workspace-kit";
const manifest = join(workspace, "skills", "skills.json");
const installed = join(workspace, ".agents", "skills", skillName);

try {
  writeFileSync(join(workspace, "workspace.json"), '{"skills":{}}\n');
  mkdirSync(join(workspace, "skills"));
  writeManifest([{ name: skillName, source }]);
  sync();
  assert.ok(existsSync(join(installed, "SKILL.md")), "remote skill was not copied");
  assert.equal(readLock().skills[skillName].source, source);
  assert.equal(readManagedLock().skills[skillName], source);

  writeManifest([]);
  sync();
  assert.equal(existsSync(installed), false, "retired remote skill was not removed");
  assert.equal(Object.hasOwn(readLock().skills, skillName), false);
  assert.equal(Object.hasOwn(readManagedLock().skills, skillName), false);
  console.log("skills.sh contract smoke ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function writeManifest(skills) {
  writeFileSync(manifest, `${JSON.stringify({ skills }, null, 2)}\n`);
}

function sync() {
  const result = spawnSync(process.execPath, [cli, "skills", "sync"], {
    cwd: workspace,
    encoding: "utf8",
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

function readLock() {
  const path = join(workspace, "skills-lock.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, skills: {} };
}

function readManagedLock() {
  return JSON.parse(readFileSync(join(workspace, "skills", "workspace-kit-lock.json"), "utf8"));
}

// Every init profile must produce a doctor-green workspace out of the box
// (contract deliberately deferred until an origin remote exists).
import assert from "node:assert/strict";
import { test } from "node:test";
import { execSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initWorkspace } from "../src/init.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

for (const profile of ["personal", "runtime", "work"] as const) {
  test(`init --profile ${profile} scaffolds a doctor-green workspace`, () => {
    const dir = mkdtempSync(join(tmpdir(), `init-${profile}-`));
    const result = initWorkspace(dir, profile);
    assert.ok(result.created.includes("AGENTS.md"));
    assert.ok(lstatSync(join(dir, "CLAUDE.md")).isSymbolicLink());
    assert.equal(readlinkSync(join(dir, "CLAUDE.md")), "AGENTS.md");

    // Scaffolded AGENTS.md is a structural skeleton, never behavioral prose.
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.match(agents, /TODO/);

    execSync("git init -q", { cwd: dir });
    const doctor = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(
      doctor.status,
      0,
      `doctor must pass on a fresh ${profile} scaffold:\n${doctor.stderr}`,
    );
    assert.match(doctor.stdout, /doctor ok/);
  });

  test(`init --profile ${profile} never overwrites existing files`, () => {
    const dir = mkdtempSync(join(tmpdir(), `reinit-${profile}-`));
    initWorkspace(dir, profile);
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const second = initWorkspace(dir, profile);
    assert.equal(second.created.length, 0);
    assert.ok(second.skipped.includes("AGENTS.md"));
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), before);
  });
}

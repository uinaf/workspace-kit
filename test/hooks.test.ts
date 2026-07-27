import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { gitEnvironmentForRepository } from "../src/lib/gitProcess.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvironmentForRepository(),
  }).trim();
}

test("hooks install configures a linked worktree and makes the hook executable", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "workspace-hooks-"));
  const fixture = join(temporaryRoot, "workspace");
  const linked = join(temporaryRoot, "linked");
  mkdirSync(join(fixture, ".githooks"), { recursive: true });
  writeFileSync(
    join(fixture, ".githooks", "pre-commit"),
    '#!/usr/bin/env bash\nset -euo pipefail\ngit rev-parse --show-toplevel > "$HOOK_MARKER"\n',
  );
  chmodSync(join(fixture, ".githooks", "pre-commit"), 0o644);
  git(fixture, "init", "-q");
  git(fixture, "config", "user.name", "Workspace Test");
  git(fixture, "config", "user.email", "workspace-test@example.invalid");
  git(fixture, "config", "commit.gpgsign", "false");
  git(fixture, "add", ".");
  git(fixture, "commit", "-qm", "fixture");
  git(fixture, "branch", "-M", "main");
  git(fixture, "worktree", "add", "-qb", "hook-test", linked);

  const install = spawnSync(process.execPath, [cli, "hooks", "install"], {
    cwd: linked,
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /Git hooks use .*\/linked\/\.githooks/);
  assert.equal(git(linked, "config", "--get", "core.hooksPath"), ".githooks");

  const marker = join(temporaryRoot, "hook-marker");
  execFileSync("git", ["hook", "run", "pre-commit"], {
    cwd: linked,
    env: { ...gitEnvironmentForRepository(), HOOK_MARKER: marker },
  });
  assert.equal(
    execFileSync("sed", ["-n", "1p", marker], { encoding: "utf8" }).trim(),
    realpathSync.native(linked),
  );
});

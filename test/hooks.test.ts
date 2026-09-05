import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { gitEnvironmentForRepository } from "../src/lib/gitProcess.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

for (const missing of ["directory", "file"]) {
  test(`hooks install reports a missing hook ${missing} without changing config`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "workspace-hooks-"));
    try {
      if (missing === "file") mkdirSync(join(fixture, ".githooks"));
      git(fixture, "init", "-q");
      git(fixture, "config", "core.hooksPath", "existing-hooks");
      const configBefore = git(fixture, "config", "--local", "--list");
      const install = spawnSync(process.execPath, [cli, "hooks", "install"], {
        cwd: fixture,
        encoding: "utf8",
      });
      assert.equal(install.status, 1, install.stderr);
      assert.match(install.stderr, /\.githooks\/pre-commit is missing/);
      assert.equal(git(fixture, "config", "--local", "--list"), configBefore);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

for (const link of ["parent", "hook"]) {
  for (const existingHooksPath of [undefined, "existing-hooks"]) {
    test(`hooks install rejects a symlinked ${link} with hooksPath ${existingHooksPath ?? "unset"}`, () => {
      const temporaryRoot = mkdtempSync(join(tmpdir(), "workspace-hooks-"));
      try {
        const fixture = join(temporaryRoot, "workspace");
        const external = join(temporaryRoot, "external");
        mkdirSync(fixture);
        mkdirSync(external);
        const externalHook = join(external, "pre-commit");
        writeFileSync(externalHook, "#!/bin/sh\nexit 0\n");
        chmodSync(externalHook, 0o600);
        if (link === "parent") {
          symlinkSync(external, join(fixture, ".githooks"));
        } else {
          mkdirSync(join(fixture, ".githooks"));
          symlinkSync(externalHook, join(fixture, ".githooks", "pre-commit"));
        }
        git(fixture, "init", "-q");
        if (existingHooksPath) git(fixture, "config", "core.hooksPath", existingHooksPath);
        const configBefore = git(fixture, "config", "--local", "--list");
        const install = spawnSync(process.execPath, [cli, "hooks", "install"], {
          cwd: fixture,
          encoding: "utf8",
        });
        assert.equal(statSync(externalHook).mode & 0o777, 0o600);
        assert.equal(git(fixture, "config", "--local", "--list"), configBefore);
        assert.equal(install.status, 1, install.stderr);
        assert.match(install.stderr, link === "parent" ? /symbolic-link parent/ : /regular file/);
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    });
  }
}

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

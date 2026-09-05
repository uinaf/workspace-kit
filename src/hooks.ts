import { spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { gitEnvironmentForRepository } from "./lib/gitProcess.ts";
import { workspaceLstat } from "./lib/workspaceFs.ts";

export function installHooks(repoRoot: string): string {
  const hook = join(repoRoot, ".githooks", "pre-commit");
  const stat = workspaceLstat(repoRoot, ".githooks/pre-commit");
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(".githooks/pre-commit must be a regular file");
  }
  const descriptor = openSync(hook, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error(".githooks/pre-commit changed while installing hooks");
    }
    const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: gitEnvironmentForRepository(),
    });
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || "could not configure core.hooksPath");
    }
    fchmodSync(descriptor, opened.mode | 0o111);
  } finally {
    closeSync(descriptor);
  }
  return `Git hooks use ${repoRoot}/.githooks`;
}

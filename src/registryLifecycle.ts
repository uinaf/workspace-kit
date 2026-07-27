import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ProjectEntry } from "./checks/registry.ts";
import { gitEnvironmentForRepository } from "./lib/gitProcess.ts";

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
  errorCode?: string;
};

type RunCommand = (command: string, args: string[]) => CommandResult;

export type RegistryLifecycleOptions = {
  homeDirectory?: string;
  run?: RunCommand;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

function defaultRun(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: command === "git" ? gitEnvironmentForRepository() : process.env,
  });
  const errorCode =
    result.error &&
    typeof result.error === "object" &&
    "code" in result.error &&
    typeof result.error.code === "string"
      ? result.error.code
      : undefined;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(errorCode ? { errorCode } : {}),
  };
}

function context(options: RegistryLifecycleOptions) {
  return {
    home: options.homeDirectory ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir(),
    run: options.run ?? defaultRun,
    stdout: options.stdout ?? ((text: string) => process.stdout.write(text)),
    stderr: options.stderr ?? ((text: string) => process.stderr.write(text)),
  };
}

function projectPath(home: string, entry: ProjectEntry): string {
  return resolve(home, entry.path.slice(2));
}

function isGitWorktree(run: RunCommand, path: string): boolean {
  const result = run("git", ["-C", path, "rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

function relay(
  result: CommandResult,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
) {
  if (result.stdout) stdout(result.stdout);
  if (result.stderr) stderr(result.stderr);
}

export function cloneProjects(
  entries: ProjectEntry[],
  options: RegistryLifecycleOptions = {},
): number {
  const { home, run, stdout, stderr } = context(options);
  for (const entry of entries.filter(({ mode }) => mode === "managed")) {
    const path = projectPath(home, entry);
    if (isGitWorktree(run, path)) {
      stdout(`Skipping ${entry.label} (${path} already cloned)\n`);
      continue;
    }
    if (existsSync(path)) {
      stderr(`Refusing to clone into existing non-git path: ${path}\n`);
      return 1;
    }
    mkdirSync(dirname(path), { recursive: true });
    stdout(`Cloning ${entry.label}: ${entry.repo} -> ${path}\n`);
    const args = ["repo", "clone", entry.repo, path];
    if (entry.branch) args.push("--", "--branch", entry.branch);
    const result = run("gh", args);
    if (result.errorCode === "ENOENT") {
      stderr("Missing dependency: gh\n");
      return 1;
    }
    relay(result, stdout, stderr);
    if (result.status !== 0) return result.status;
  }
  return 0;
}

export function statusProjects(
  entries: ProjectEntry[],
  options: RegistryLifecycleOptions = {},
): number {
  const { home, run, stdout, stderr } = context(options);
  for (const entry of entries) {
    const path = projectPath(home, entry);
    if (isGitWorktree(run, path)) {
      stdout(`\u001b[1m== ${entry.label} [${entry.mode}] (${path}) ==\u001b[0m\n`);
      const result = run("git", ["-C", path, "status", "-sb"]);
      relay(result, stdout, stderr);
      if (result.status !== 0) return result.status;
    } else if (entry.mode === "managed") {
      stdout(`\u001b[33m== ${entry.label} [${entry.mode}] (${path} missing) ==\u001b[0m\n`);
    }
  }
  return 0;
}

export function pullProjects(
  entries: ProjectEntry[],
  options: RegistryLifecycleOptions = {},
): number {
  const { home, run, stdout, stderr } = context(options);
  for (const entry of entries.filter(({ mode }) => mode === "managed")) {
    const path = projectPath(home, entry);
    if (!isGitWorktree(run, path)) {
      stdout(`\u001b[33m== ${entry.label} (${path} missing, skipping) ==\u001b[0m\n`);
      continue;
    }
    stdout(`\u001b[1m== pulling ${entry.label} (${path}) ==\u001b[0m\n`);
    if (entry.branch) {
      const branch = run("git", ["-C", path, "branch", "--show-current"]);
      if (branch.stderr) stderr(branch.stderr);
      if (branch.status !== 0) return branch.status;
      if (branch.stdout.trim() !== entry.branch) {
        stderr(`Refusing to pull ${path}: expected branch ${entry.branch}\n`);
        return 1;
      }
    }
    const result = run("git", ["-C", path, "pull", "--ff-only"]);
    relay(result, stdout, stderr);
    if (result.status !== 0) return result.status;
  }
  return 0;
}

export function resolveProjectPath(
  entries: ProjectEntry[],
  label: string,
  requiredMode: string | undefined,
  options: RegistryLifecycleOptions = {},
): string {
  const matches = entries.filter(
    (entry) => entry.label === label && (!requiredMode || entry.mode === requiredMode),
  );
  if (matches.length !== 1) {
    const qualifier = requiredMode ? ` with mode ${requiredMode}` : "";
    throw new Error(`expected exactly one project ${label}${qualifier}`);
  }
  return projectPath(context(options).home, matches[0]!);
}

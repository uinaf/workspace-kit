#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Contract = {
  repository: string;
  peerRepository: string;
  sharedAncestor: string;
  requiredOwnerPaths: string[];
  forbiddenOwnerPaths: string[];
};

type GitResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function git(repoRoot: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("contract must be an object");
  }
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function textList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

export function loadContract(repoRoot = "."): Contract {
  const value = record(
    JSON.parse(readFileSync(resolve(repoRoot, "workspace.contract.json"), "utf8")),
  );
  return {
    repository: text(value.repository, "repository"),
    peerRepository: text(value.peerRepository, "peerRepository"),
    sharedAncestor: text(value.sharedAncestor, "sharedAncestor"),
    requiredOwnerPaths: textList(value.requiredOwnerPaths, "requiredOwnerPaths"),
    forbiddenOwnerPaths: textList(value.forbiddenOwnerPaths, "forbiddenOwnerPaths"),
  };
}

function repositoryName(remote: string): string | null {
  const match = remote
    .trim()
    .match(/^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

function trackedPaths(repoRoot: string): string[] {
  const result = git(repoRoot, ["ls-files", "-z"]);
  if (result.status !== 0) throw new Error("could not list tracked files");
  return result.stdout.split("\0").filter(Boolean);
}

function matchesTrackedPath(paths: string[], expected: string): boolean {
  if (expected.endsWith("/")) return paths.some((path) => path.startsWith(expected));
  return paths.includes(expected);
}

export function workspaceErrors(repoRoot = "."): string[] {
  const root = resolve(repoRoot);
  const contract = loadContract(root);
  const errors: string[] = [];

  const origin = git(root, ["remote", "get-url", "origin"]);
  if (origin.status !== 0) {
    errors.push("origin remote is missing");
  } else if (repositoryName(origin.stdout) !== contract.repository) {
    errors.push(`origin does not match ${contract.repository}`);
  }

  const paths = trackedPaths(root);
  for (const path of contract.requiredOwnerPaths) {
    if (!matchesTrackedPath(paths, path)) errors.push(`required owner path is not tracked: ${path}`);
  }
  for (const path of contract.forbiddenOwnerPaths) {
    if (matchesTrackedPath(paths, path)) errors.push(`foreign owner path is tracked: ${path}`);
  }

  if (!/^[0-9a-f]{40}$/.test(contract.sharedAncestor)) {
    errors.push("sharedAncestor must be a full commit id");
  } else if (
    git(root, ["merge-base", "--is-ancestor", contract.sharedAncestor, "HEAD"]).status !== 0
  ) {
    errors.push(`shared ancestor is not in HEAD: ${contract.sharedAncestor}`);
  }

  return errors;
}

function postSplitCommits(repoRoot: string, ancestor: string): string[] {
  const result = git(repoRoot, ["rev-list", "HEAD", `^${ancestor}`]);
  if (result.status !== 0) {
    throw new Error(`could not inspect history: ${result.stderr.trim()}`);
  }
  return result.stdout.trim().split("\n").filter(Boolean);
}

export function peerErrors(currentRoot: string, peerRoot: string): string[] {
  const current = loadContract(currentRoot);
  const peer = loadContract(peerRoot);
  const errors = [
    ...workspaceErrors(currentRoot).map((error) => `current: ${error}`),
    ...workspaceErrors(peerRoot).map((error) => `peer: ${error}`),
  ];

  if (current.peerRepository !== peer.repository || peer.peerRepository !== current.repository) {
    errors.push("workspace contracts are not reciprocal");
  }
  if (current.sharedAncestor !== peer.sharedAncestor) {
    errors.push("workspace contracts name different shared ancestors");
    return errors;
  }

  const peerCommits = new Set(postSplitCommits(peerRoot, peer.sharedAncestor));
  const shared = postSplitCommits(currentRoot, current.sharedAncestor).filter((commit) =>
    peerCommits.has(commit),
  );
  if (shared.length > 0) errors.push(`post-split history is shared: ${shared.join(", ")}`);

  return errors;
}

const privatePaths = new Set([
  "AGENTS.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  "MEMORY.md",
  "SOUL.md",
  "TOOLS.md",
  "USER.md",
  "avatar.png",
  "projects.json",
  "workspace.contract.json",
]);
const privatePrefixes = [
  ".agents/skills/",
  "docs/reference/",
  "docs/runbooks/",
  "memory/",
  "user/",
];

export function isPrivateHandoffPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return true;
  const base = path.split("/").at(-1) ?? "";
  if (base === ".env" || base.startsWith(".env.")) return true;
  return privatePaths.has(path) || privatePrefixes.some((prefix) => path.startsWith(prefix));
}

function printErrors(errors: string[]): void {
  if (errors.length === 0) return;
  console.error(errors.join("\n"));
  process.exit(1);
}

function main(): void {
  const [mode, ...args] = process.argv.slice(2);

  try {
    if (mode === "--check") {
      const contract = loadContract();
      printErrors(workspaceErrors());
      console.log(`workspace boundary ok (${contract.repository})`);
      return;
    }

    if (mode === "--peer" && args.length === 1) {
      const current = loadContract();
      const peer = loadContract(args[0]);
      printErrors(peerErrors(".", args[0]));
      console.log(`workspace histories are separate (${current.repository} <-> ${peer.repository})`);
      return;
    }

    if (mode === "--handoff" && args.length > 0) {
      const blocked = args.filter(isPrivateHandoffPath);
      printErrors(blocked.map((path) => `owner-private handoff path: ${path}`));
      console.log(`handoff paths eligible for review:\n${args.join("\n")}`);
      return;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.error(
    "usage: scripts/workspace-contract.ts --check | --peer <checkout> | --handoff <path...>",
  );
  process.exit(2);
}

if (import.meta.main) main();

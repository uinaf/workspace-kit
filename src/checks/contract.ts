// Port of the legacy workspace-contract validator. Message strings and
// evaluation order are parity-locked to parity/goldens — do not "improve"
// them without regenerating the oracle.
import { spawnSync } from "node:child_process";
import { posix, resolve, win32 } from "node:path";
import type { HandoffConfig } from "../config.ts";
import { parseGitRemote } from "../lib/gitRemote.ts";
import { readWorkspaceText } from "../lib/workspaceFs.ts";

export type Contract = {
  repository: string;
  peerRepository: string;
  sharedAncestor: string;
  requiredOwnerPaths: string[];
  forbiddenOwnerPaths: string[];
};

type GitResult = { status: number; stdout: string; stderr: string };

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
  return value as Record<string, unknown>;
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
  return value as string[];
}

export function loadContract(repoRoot = ".", file = "workspace.contract.json"): Contract {
  const value = record(JSON.parse(readWorkspaceText(repoRoot, file, "contract file")));
  return {
    repository: text(value.repository, "repository"),
    peerRepository: text(value.peerRepository, "peerRepository"),
    sharedAncestor: text(value.sharedAncestor, "sharedAncestor"),
    requiredOwnerPaths: textList(value.requiredOwnerPaths, "requiredOwnerPaths"),
    forbiddenOwnerPaths: textList(value.forbiddenOwnerPaths, "forbiddenOwnerPaths"),
  };
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

export function workspaceErrors(repoRoot = ".", file = "workspace.contract.json"): string[] {
  const root = resolve(repoRoot);
  const contract = loadContract(root, file);
  const errors: string[] = [];

  const origin = git(root, ["remote", "get-url", "origin"]);
  if (origin.status !== 0) {
    errors.push("origin remote is missing");
  } else {
    const remote = parseGitRemote(origin.stdout);
    if (remote?.host !== "github.com" || remote.repository !== contract.repository) {
      errors.push(`origin does not match ${contract.repository}`);
    }
  }

  const paths = trackedPaths(root);
  for (const path of contract.requiredOwnerPaths) {
    if (!matchesTrackedPath(paths, path))
      errors.push(`required owner path is not tracked: ${path}`);
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

export function peerErrors(
  currentRoot: string,
  peerRoot: string,
  file = "workspace.contract.json",
): string[] {
  const current = loadContract(currentRoot, file);
  // The peer's contract file name is protocol, not per-repo config.
  const peer = loadContract(peerRoot, "workspace.contract.json");
  const errors = [
    ...workspaceErrors(currentRoot, file).map((error) => `current: ${error}`),
    ...workspaceErrors(peerRoot, "workspace.contract.json").map((error) => `peer: ${error}`),
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

export function isPrivateHandoffPath(path: string, handoff: HandoffConfig): boolean {
  // Kit-level invariants: never configurable. Raw-path checks run first so
  // traversal is always blocked regardless of what it would normalize to.
  const portable = path.replaceAll("\\", "/");
  if (
    !path ||
    path.includes("\0") ||
    posix.isAbsolute(portable) ||
    win32.isAbsolute(path) ||
    /^[A-Za-z]:/.test(portable) ||
    portable.split("/").includes("..")
  ) {
    return true;
  }
  // Normalize candidates and configured rules alike so spelling differences
  // cannot sidestep the denylist.
  const normalized = normalizePath(path);
  if (!normalized) return true;
  const base = normalized.split("/").at(-1) ?? "";
  if (base.startsWith(".env")) return true;
  return (
    handoff.paths.some((configured) => normalizePath(configured) === normalized) ||
    handoff.prefixes.some((configured) => {
      const prefix = normalizePath(configured);
      return prefix !== "" && (normalized === prefix || normalized.startsWith(`${prefix}/`));
    })
  );
}

function normalizePath(path: string): string {
  const segments = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  // Treat case aliases conservatively so a path approved on a case-sensitive
  // host cannot name protected content when handed off on Windows or macOS.
  return segments.join("/").toLowerCase();
}

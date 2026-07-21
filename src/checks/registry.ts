import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  portablePathIdentity,
  type ProjectRegistryConfig,
  type RegistryConfig,
} from "../config.ts";
import { readWorkspaceText, workspaceLstat } from "../lib/workspaceFs.ts";
import { registryErrors } from "./structure.ts";

const PROJECT_FIELDS = ["name", "repo", "path", "mode"] as const;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type GitResult = { status: number; stdout: string };
type ProjectEntry = {
  label: string;
  repo: string;
  path: string;
  mode: string;
  catalog?: string;
};

export type ProjectRegistryOptions = {
  homeDirectory?: string;
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function git(repoRoot: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
  };
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsafeProjectPath(path: string, pathPrefix: string): boolean {
  if (!path.startsWith(pathPrefix) || path.length === pathPrefix.length) {
    return true;
  }
  if (path.includes("\\") || path.includes("\0") || path.endsWith("/") || path.includes("//")) {
    return true;
  }
  return path
    .slice(pathPrefix.length)
    .split("/")
    .some((part) => part === "." || part === ".." || /[ .]$/.test(part));
}

function unsafeCatalogPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//")
  ) {
    return true;
  }
  return path.split("/").some((part) => part === "." || part === ".." || /[ .]$/.test(part));
}

function githubRepository(remote: string): string | undefined {
  let normalized = remote.trim();
  if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
  for (const prefix of ["git@github.com:", "https://github.com/", "ssh://git@github.com/"]) {
    if (!normalized.startsWith(prefix)) continue;
    const repository = normalized.slice(prefix.length);
    return GITHUB_REPOSITORY.test(repository) ? repository : undefined;
  }
  return undefined;
}

function configuredHome(options: ProjectRegistryOptions): string {
  return options.homeDirectory ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

function absoluteProjectPath(home: string, path: string): string {
  return resolve(home, path.slice(2));
}

function canonicalPath(path: string): string {
  return realpathSync.native(path);
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") return left.toUpperCase() === right.toUpperCase();
  return left === right;
}

function parseEntries(value: unknown, project: ProjectRegistryConfig): ProjectEntry[] {
  if (!isRecord(value)) return [];
  const entries: ProjectEntry[] = [];
  for (const [category, categoryEntries] of Object.entries(value)) {
    if (!Array.isArray(categoryEntries)) continue;
    for (const value of categoryEntries) {
      if (!isRecord(value)) continue;
      const name = value.name as string;
      const catalogField = project.catalog?.field;
      entries.push({
        label: `${category}/${name}`,
        repo: value.repo as string,
        path: value.path as string,
        mode: value.mode as string,
        ...(catalogField !== undefined && typeof value[catalogField] === "string"
          ? { catalog: value[catalogField] }
          : {}),
      });
    }
  }
  return entries;
}

function staticEntryErrors(
  file: string,
  entries: ProjectEntry[],
  project: ProjectRegistryConfig,
): string[] {
  const errors: string[] = [];
  const labels = new Map<string, string[]>();
  const paths = new Map<string, Array<{ label: string; path: string }>>();

  for (const entry of entries) {
    const entryLabels = labels.get(entry.label) ?? [];
    entryLabels.push(entry.path);
    labels.set(entry.label, entryLabels);

    const pathIdentity = portablePathIdentity(entry.path);
    const pathEntries = paths.get(pathIdentity) ?? [];
    pathEntries.push({ label: entry.label, path: entry.path });
    paths.set(pathIdentity, pathEntries);

    if (!project.modes.includes(entry.mode)) {
      errors.push(
        `${file} ${entry.label}: invalid mode ${entry.mode} (expected ${project.modes.join(" or ")})`,
      );
    }
    if (!GITHUB_REPOSITORY.test(entry.repo)) {
      errors.push(`${file} ${entry.label}: invalid GitHub repository ${entry.repo}`);
    }
    if (unsafeProjectPath(entry.path, project.pathPrefix)) {
      errors.push(`${file} ${entry.label}: unsafe project path ${entry.path}`);
    }
    if (entry.catalog !== undefined) {
      if (!project.catalog?.modes.includes(entry.mode)) {
        errors.push(
          `${file} ${entry.label}: ${project.catalog?.field ?? "catalog"} is not allowed for mode ${entry.mode}`,
        );
      }
      if (unsafeCatalogPath(entry.catalog)) {
        errors.push(`${file} ${entry.label}: unsafe catalog path ${entry.catalog}`);
      }
    }
  }

  for (const [label, projectPaths] of labels) {
    if (projectPaths.length > 1) {
      errors.push(`${file}: duplicate project label ${label}: ${projectPaths.join(", ")}`);
    }
  }
  for (const pathEntries of paths.values()) {
    if (pathEntries.length > 1) {
      errors.push(
        `${file}: duplicate project path ${pathEntries[0]!.path}: ${pathEntries
          .map(({ label, path }) => `${label}=${path}`)
          .join(", ")}`,
      );
    }
  }
  return errors;
}

function catalogPathError(
  projectPath: string,
  catalog: string,
): "missing" | "symlink" | "not-file" | undefined {
  let current = projectPath;
  const segments = catalog.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    let stat: Stats | undefined;
    try {
      stat = lstatOrUndefined(current);
    } catch {
      return "missing";
    }
    if (!stat) return "missing";
    if (stat.isSymbolicLink()) return "symlink";
    if (index < segments.length - 1 && !stat.isDirectory()) return "missing";
    if (index === segments.length - 1 && !stat.isFile()) return "not-file";
  }
  return undefined;
}

function checkoutErrors(
  file: string,
  entries: ProjectEntry[],
  options: ProjectRegistryOptions,
): string[] {
  const errors: string[] = [];
  const roots = new Map<string, string[]>();
  const home = configuredHome(options);

  for (const entry of entries) {
    const projectPath = absoluteProjectPath(home, entry.path);
    let stat: Stats | undefined;
    try {
      stat = lstatOrUndefined(projectPath);
    } catch {
      errors.push(`${file} ${entry.label}: could not inspect project path ${entry.path}`);
      continue;
    }
    if (!stat) continue;

    const inside = git(projectPath, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.status !== 0 || inside.stdout.trim() !== "true") {
      errors.push(`${file} ${entry.label}: registered path is not a Git worktree: ${entry.path}`);
      continue;
    }

    let expectedRoot: string;
    let actualRoot: string;
    try {
      expectedRoot = canonicalPath(projectPath);
      const root = git(projectPath, ["rev-parse", "--show-toplevel"]);
      if (root.status !== 0 || root.stdout.trim().length === 0) {
        throw new Error("missing worktree root");
      }
      actualRoot = canonicalPath(root.stdout.trim());
    } catch {
      errors.push(`${file} ${entry.label}: could not resolve Git worktree root for ${entry.path}`);
      continue;
    }

    if (!samePath(expectedRoot, actualRoot)) {
      errors.push(
        `${file} ${entry.label}: registered path is inside another checkout: ${entry.path}`,
      );
      continue;
    }

    const rootIdentity = process.platform === "win32" ? actualRoot.toUpperCase() : actualRoot;
    const rootLabels = roots.get(rootIdentity) ?? [];
    rootLabels.push(entry.label);
    roots.set(rootIdentity, rootLabels);

    const origin = git(projectPath, ["remote", "get-url", "origin"]);
    if (origin.status !== 0 || origin.stdout.trim().length === 0) {
      errors.push(`${file} ${entry.label}: origin remote is missing`);
    } else {
      const actualRepository = githubRepository(origin.stdout);
      if (actualRepository === undefined) {
        errors.push(`${file} ${entry.label}: origin is not a supported GitHub URL`);
      } else if (actualRepository !== entry.repo) {
        errors.push(
          `${file} ${entry.label}: origin mismatch (expected ${entry.repo}, found ${actualRepository})`,
        );
      }
    }

    if (entry.catalog !== undefined) {
      const problem = catalogPathError(projectPath, entry.catalog);
      if (problem === "symlink") {
        errors.push(
          `${file} ${entry.label}: catalog must not traverse symbolic links: ${entry.catalog}`,
        );
      } else if (problem !== undefined) {
        errors.push(`${file} ${entry.label}: missing catalog ${entry.catalog}`);
      }
    }
  }

  for (const projectLabels of roots.values()) {
    if (projectLabels.length > 1) {
      errors.push(
        `${file}: multiple project entries resolve to the same checkout: ${projectLabels.join(", ")}`,
      );
    }
  }
  return errors;
}

export function projectRegistryErrors(
  repoRoot: string,
  registry: RegistryConfig,
  options: ProjectRegistryOptions = {},
): string[] {
  if (!workspaceLstat(repoRoot, registry.file)) return [`missing ${registry.file}`];

  const shapeErrors = registryErrors(registry, repoRoot);
  if (shapeErrors.length > 0) return shapeErrors;

  const missingFields = PROJECT_FIELDS.filter((field) => !registry.entry.required.includes(field));
  if (missingFields.length > 0) {
    return [
      `registry project validation requires registry.entry.required to include ${missingFields.join(", ")}`,
    ];
  }

  if (!registry.project) {
    return ["registry validate requires a registry.project policy"];
  }

  const parsed: unknown = JSON.parse(readWorkspaceText(repoRoot, registry.file));
  const entries = parseEntries(parsed, registry.project);
  const staticErrors = staticEntryErrors(registry.file, entries, registry.project);
  if (staticErrors.length > 0) return staticErrors;
  return checkoutErrors(registry.file, entries, options);
}

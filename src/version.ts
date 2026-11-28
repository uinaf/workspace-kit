import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gitEnvironmentForRepository } from "./lib/gitProcess.ts";

declare const __WORKSPACE_KIT_VERSION__: string | undefined;

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) return difference;
  }

  return 0;
}

function packageVersion(packageRoot: string): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

    if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") {
      return STABLE_VERSION.test(pkg.version) ? pkg.version : "0.0.0";
    }
  } catch {
    return "0.0.0";
  }

  return "0.0.0";
}

function reachableTagVersions(packageRoot: string): Array<string> {
  // SAFETY: package-local git metadata only, so archives and installs never inherit a surrounding repo's tags.
  if (!existsSync(join(packageRoot, ".git"))) {
    throw new Error(
      "could not determine workspace-kit version: use a full Git checkout with release tags",
    );
  }

  const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: gitEnvironmentForRepository(),
  });

  if (shallow.status !== 0) {
    throw new Error("could not inspect Git history while determining workspace-kit version");
  }

  if (shallow.stdout.trim() === "true") {
    throw new Error(
      "could not determine workspace-kit version from a shallow checkout; fetch full history and tags",
    );
  }

  const result = spawnSync("git", ["tag", "--merged", "HEAD", "--list", "v*"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: gitEnvironmentForRepository(),
  });

  if (result.status !== 0) {
    throw new Error("could not read Git tags while determining workspace-kit version");
  }

  const versions = (result.stdout ?? "")
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .map((tag) => tag.slice(1));

  if (versions.length === 0) {
    throw new Error(
      "could not determine workspace-kit version: fetch the repository's release tags",
    );
  }

  return versions;
}

export function resolveKitVersion(packageRoot: string): string {
  return reachableTagVersions(packageRoot).reduce((current, tagged) => {
    return compareVersions(tagged, current) > 0 ? tagged : current;
  }, packageVersion(packageRoot));
}

let sourceVersion: string | undefined;

export function kitVersion(): string {
  if (typeof __WORKSPACE_KIT_VERSION__ === "string") return __WORKSPACE_KIT_VERSION__;

  if (sourceVersion) return sourceVersion;
  const here = import.meta.dirname;
  sourceVersion = resolveKitVersion(join(here, ".."));

  return sourceVersion;
}

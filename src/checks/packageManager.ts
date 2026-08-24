import type { PackageManagerConfig } from "../config.ts";
import { readWorkspaceText, workspaceLstat } from "../lib/workspaceFs.ts";

export const CONSUMER_PACKAGE_MANAGER = "pnpm@11.23.0";

const FOREIGN_LOCKFILES = ["package-lock.json", "yarn.lock"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPnpmPackageManagerPin(value: unknown): value is string {
  return typeof value === "string" && /^pnpm@\d+\.\d+\.\d+(?:\+[A-Za-z0-9._-]+)?$/.test(value);
}

export function packageManagerErrors(config: PackageManagerConfig, repoRoot = "."): string[] {
  const bad: string[] = [];
  const stat = workspaceLstat(repoRoot, "package.json", "package.json");
  if (!stat) {
    bad.push("package.json: file is missing");
  } else {
    try {
      const parsed: unknown = JSON.parse(
        readWorkspaceText(repoRoot, "package.json", "package.json"),
      );
      const pin = isRecord(parsed) ? parsed.packageManager : undefined;
      if (!isPnpmPackageManagerPin(pin)) {
        bad.push(
          pin === undefined
            ? "package.json: packageManager must be a pnpm@ pin"
            : `package.json: packageManager must be a pnpm@ pin (got ${JSON.stringify(pin)})`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SyntaxError) {
        bad.push("package.json: is not valid JSON");
      } else {
        bad.push(`package.json: could not read package metadata (${message})`);
      }
    }
  }

  if (!config.allowForeignLockfiles) {
    for (const file of FOREIGN_LOCKFILES) {
      if (workspaceLstat(repoRoot, file, file)) {
        bad.push(`${file}: foreign lockfile is not allowed; use pnpm-lock.yaml`);
      }
    }
  }

  return bad;
}

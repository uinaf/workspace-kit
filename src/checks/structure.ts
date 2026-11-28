// SAFETY: message strings and ordering are parity-locked to parity/goldens; regenerate the oracle on change.
import type { LinkRule, RegistryConfig, WorkspaceConfig } from "../config.ts";
import {
  assertWorkspaceLinkTarget,
  readWorkspaceLink,
  readWorkspaceText,
  workspaceLstat,
} from "../lib/workspaceFs.ts";

export function requiredFileErrors(required: Array<string>): Array<string> {
  const bad: Array<string> = [];

  for (const path of required) {
    const stat = workspaceLstat(".", path);

    if (!stat) {
      bad.push(`missing ${path}`);
      continue;
    }

    if (stat.isSymbolicLink()) {
      try {
        assertWorkspaceLinkTarget(".", path, readWorkspaceLink(".", path));
      } catch {
        bad.push(`missing ${path}`);
      }
    }
  }

  return bad;
}

export function forbiddenFileErrors(forbidden: Array<string>): Array<string> {
  const bad: Array<string> = [];

  for (const path of forbidden) {
    if (workspaceLstat(".", path)) bad.push(`forbidden file exists: ${path}`);
  }

  return bad;
}

export function linkErrors(links: Array<LinkRule>): Array<string> {
  const bad: Array<string> = [];

  for (const { path, target } of links) {
    try {
      assertWorkspaceLinkTarget(".", path, target);
    } catch (error) {
      bad.push(
        `${path} has unsafe target ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const stat = workspaceLstat(".", path);

    if (!stat) continue;

    if (!stat.isSymbolicLink()) {
      bad.push(`${path} should be a symlink to ${target}`);
    } else {
      const actual = readWorkspaceLink(".", path);

      if (actual !== target) {
        bad.push(`${path} points to ${actual}, expected ${target}`);
      }
    }
  }

  return bad;
}

export function registryErrors(registry: RegistryConfig, repoRoot = "."): Array<string> {
  const bad: Array<string> = [];
  const file = registry.file;

  if (!workspaceLstat(repoRoot, file)) return bad;

  try {
    const parsed: unknown = JSON.parse(readWorkspaceText(repoRoot, file));

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      bad.push(`${file} should be an object of category arrays`);
    } else {
      for (const [category, entries] of Object.entries(parsed)) {
        if (!Array.isArray(entries)) {
          bad.push(`${file} category ${category} should be an array`);
          continue;
        }

        for (const entry of entries) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            bad.push(`${file} category ${category} has a non-object entry`);
            continue;
          }

          const record = entry as Record<string, unknown>;

          for (const key of registry.entry.required) {
            if (!(key in record) || typeof record[key] !== "string" || record[key].length === 0) {
              bad.push(`${file} category ${category} entry missing string ${key}`);
            }
          }

          for (const key of registry.entry.optional) {
            if (key in record && (typeof record[key] !== "string" || record[key].length === 0)) {
              bad.push(`${file} category ${category} entry has invalid ${key}`);
            }
          }
        }
      }
    }
  } catch (error) {
    bad.push(`${file} parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return bad;
}

export function structureErrors(config: WorkspaceConfig): Array<string> {
  return [
    ...requiredFileErrors(config.required ?? []),
    ...linkErrors(config.links ?? []),
    ...(config.registry ? registryErrors(config.registry) : []),
    ...forbiddenFileErrors(config.forbidden ?? []),
  ];
}

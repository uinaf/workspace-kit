// Port of the legacy doctor's own checks (required files, alias symlinks,
// registry shape, daily-log H1). Message strings and ordering are
// parity-locked to parity/goldens. Required files deliberately use
// filesystem existence, not git-tracked state — the contract check owns
// tracked semantics.
import { posix } from "node:path";
import type { DailyLogsConfig, LinkRule, RegistryConfig, WorkspaceConfig } from "../config.ts";
import {
  assertWorkspaceLinkTarget,
  readWorkspaceDirectory,
  readWorkspaceLink,
  readWorkspaceText,
  workspaceLstat,
} from "../lib/workspaceFs.ts";

export function requiredFileErrors(required: string[]): string[] {
  const bad: string[] = [];
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

export function forbiddenFileErrors(forbidden: string[]): string[] {
  const bad: string[] = [];
  for (const path of forbidden) {
    if (workspaceLstat(".", path)) bad.push(`forbidden file exists: ${path}`);
  }
  return bad;
}

export function linkErrors(links: LinkRule[]): string[] {
  const bad: string[] = [];
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
    if (!stat) continue; // missing is the required-list's job
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

export function registryErrors(registry: RegistryConfig, repoRoot = "."): string[] {
  const bad: string[] = [];
  const file = registry.file;
  if (!workspaceLstat(repoRoot, file)) return bad; // missing is the required-list's job
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
            if (
              !(key in record) ||
              typeof record[key] !== "string" ||
              (record[key] as string).length === 0
            ) {
              bad.push(`${file} category ${category} entry missing string ${key}`);
            }
          }
          for (const key of registry.entry.optional) {
            if (
              key in record &&
              (typeof record[key] !== "string" || (record[key] as string).length === 0)
            ) {
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

export function dailyLogErrors(config: DailyLogsConfig): string[] {
  const out: string[] = [];
  for (const entry of readWorkspaceDirectory(".", config.root, "empty")) {
    const path = posix.join(config.root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${path}: symbolic links are not allowed in daily logs`);
    }
    if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) out.push(path);
  }
  for (const entry of readWorkspaceDirectory(".", config.contexts, "empty")) {
    const dir = posix.join(config.contexts, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${dir}: symbolic links are not allowed in daily-log contexts`);
    }
    if (!entry.isDirectory()) continue;
    for (const child of readWorkspaceDirectory(".", dir)) {
      const path = posix.join(dir, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(`${path}: symbolic links are not allowed in daily logs`);
      }
      if (child.isFile() && child.name.endsWith(".md")) out.push(path);
    }
  }
  out.sort();

  const missingH1: string[] = [];
  for (const path of out) {
    const text = readWorkspaceText(".", path).replace(/^﻿/, "");
    if (!text.startsWith("# ")) missingH1.push(path);
  }
  if (missingH1.length > 0) {
    return [`missing H1:\n${missingH1.join("\n")}`];
  }
  return [];
}

export function structureErrors(config: WorkspaceConfig): string[] {
  return [
    ...requiredFileErrors(config.required ?? []),
    ...linkErrors(config.links ?? []),
    ...(config.registry ? registryErrors(config.registry) : []),
    ...forbiddenFileErrors(config.forbidden ?? []),
    ...(config.dailyLogs ? dailyLogErrors(config.dailyLogs) : []),
  ];
}

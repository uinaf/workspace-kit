// Port of the legacy doctor's own checks (required files, alias symlinks,
// registry shape, daily-log H1). Message strings and ordering are
// parity-locked to parity/goldens. Required files deliberately use
// filesystem existence, not git-tracked state — the contract check owns
// tracked semantics.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DailyLogsConfig, LinkRule, RegistryConfig, WorkspaceConfig } from "../config.ts";

export function requiredFileErrors(required: string[]): string[] {
  const bad: string[] = [];
  for (const path of required) {
    if (!existsSync(path)) bad.push(`missing ${path}`);
  }
  return bad;
}

export function forbiddenFileErrors(forbidden: string[]): string[] {
  const bad: string[] = [];
  for (const path of forbidden) {
    if (existsSync(path)) bad.push(`forbidden file exists: ${path}`);
  }
  return bad;
}

export function linkErrors(links: LinkRule[]): string[] {
  const bad: string[] = [];
  for (const { path, target } of links) {
    if (!existsSync(path)) continue; // missing is the required-list's job
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) {
      bad.push(`${path} should be a symlink to ${target}`);
    } else {
      const actual = readlinkSync(path);
      if (actual !== target) {
        bad.push(`${path} points to ${actual}, expected ${target}`);
      }
    }
  }
  return bad;
}

export function registryErrors(registry: RegistryConfig): string[] {
  const bad: string[] = [];
  const file = registry.file;
  if (!existsSync(file)) return bad; // missing is the required-list's job
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
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
  if (existsSync(config.root)) {
    for (const name of readdirSync(config.root)) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) out.push(join(config.root, name));
    }
  }
  if (existsSync(config.contexts)) {
    for (const slug of readdirSync(config.contexts)) {
      const dir = join(config.contexts, slug);
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".md")) out.push(join(dir, name));
      }
    }
  }
  out.sort();

  const missingH1: string[] = [];
  for (const path of out) {
    const text = readFileSync(path, "utf8").replace(/^﻿/, "");
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

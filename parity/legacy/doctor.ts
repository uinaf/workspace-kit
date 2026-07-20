#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";

const required = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  "SOUL.md",
  "USER.md",
  "MEMORY.md",
  "TOOLS.md",
  ".env.example",
  "projects.json",
  "workspace.contract.json",
  "docs/README.md",
  "memory/wiki/index.md",
  "memory/wiki/schema.md",
  "memory/wiki/log.md",
];

const bad: string[] = [];

for (const path of required) {
  if (!existsSync(path)) bad.push(`missing ${path}`);
}

if (existsSync("CLAUDE.md")) {
  const stat = lstatSync("CLAUDE.md");
  if (!stat.isSymbolicLink()) {
    bad.push("CLAUDE.md should be a symlink to AGENTS.md");
  } else {
    const target = readlinkSync("CLAUDE.md");
    if (target !== "AGENTS.md") {
      bad.push(`CLAUDE.md points to ${target}, expected AGENTS.md`);
    }
  }
}

if (existsSync("projects.json")) {
  try {
    const parsed: unknown = JSON.parse(readFileSync("projects.json", "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      bad.push("projects.json should be an object of category arrays");
    } else {
      for (const [category, entries] of Object.entries(parsed)) {
        if (!Array.isArray(entries)) {
          bad.push(`projects.json category ${category} should be an array`);
          continue;
        }
        for (const entry of entries) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            bad.push(`projects.json category ${category} has a non-object entry`);
            continue;
          }
          for (const key of ["name", "repo", "path", "owns"]) {
            if (!(key in entry) || typeof entry[key] !== "string" || entry[key].length === 0) {
              bad.push(`projects.json category ${category} entry missing string ${key}`);
            }
          }
          if (
            "branch" in entry &&
            (typeof entry.branch !== "string" || entry.branch.length === 0)
          ) {
            bad.push(`projects.json category ${category} entry has invalid branch`);
          }
        }
      }
    }
  } catch (error) {
    bad.push(`projects.json parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function dailyLogs(): string[] {
  const out: string[] = [];
  if (existsSync("memory")) {
    for (const name of readdirSync("memory")) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) out.push(join("memory", name));
    }
  }
  const contexts = "memory/contexts";
  if (existsSync(contexts)) {
    for (const slug of readdirSync(contexts)) {
      const dir = join(contexts, slug);
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".md")) out.push(join(dir, name));
      }
    }
  }
  return out.sort();
}

const missingH1: string[] = [];
for (const path of dailyLogs()) {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  if (!text.startsWith("# ")) missingH1.push(path);
}
if (missingH1.length > 0) {
  bad.push(`missing H1:\n${missingH1.join("\n")}`);
}

const lint = spawnSync("bun", ["scripts/wiki-lint.ts"], { encoding: "utf8" });
process.stdout.write(lint.stdout ?? "");
process.stderr.write(lint.stderr ?? "");
if (lint.status !== 0) bad.push(`wiki-lint failed (exit ${lint.status})`);

const contract = spawnSync("bun", ["scripts/workspace-contract.ts", "--check"], {
  encoding: "utf8",
});
process.stdout.write(contract.stdout ?? "");
process.stderr.write(contract.stderr ?? "");
if (contract.status !== 0) bad.push(`workspace contract failed (exit ${contract.status})`);

if (bad.length > 0) {
  console.error(bad.join("\n"));
  process.exit(1);
}

console.log("doctor ok");

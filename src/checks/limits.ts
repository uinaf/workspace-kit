// Soft size limits from the workspace convention (e.g. MEMORY.md under 200
// lines, daily logs under 80). These are WARNINGS by design — "the audit
// flags them, the human decides" — so they never fail a run.
import { spawnSync } from "node:child_process";
import type { LimitRule } from "../config.ts";
import { readWorkspaceText, workspaceLstat } from "../lib/workspaceFs.ts";

// Tiny glob: * matches within a path segment, ? matches one character,
// ** crosses segments. Enough for "memory/????-??-??.md" style rules.
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}

export function limitWarnings(rules: LimitRule[]): string[] {
  const warnings: string[] = [];
  const result = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (result.status !== 0) {
    warnings.push("warning: could not list tracked files for limit checks");
    return warnings;
  }
  const tracked = result.stdout.split("\0").filter(Boolean).sort();

  for (const rule of rules) {
    const regex = globToRegExp(rule.pattern);
    for (const file of tracked) {
      if (!regex.test(file)) continue;
      const stat = workspaceLstat(".", file, "tracked file");
      if (stat?.isSymbolicLink()) continue;
      const content = readWorkspaceText(".", file, "tracked file");
      const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      if (lines > rule.maxLines) {
        warnings.push(`warning: ${file}: ${lines} lines exceeds soft limit ${rule.maxLines}`);
      }
    }
  }
  return warnings;
}

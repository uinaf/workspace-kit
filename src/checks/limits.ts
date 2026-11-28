import { spawnSync } from "node:child_process";
import type { LimitRule } from "../config.ts";
import { readWorkspaceText, workspaceLstat } from "../lib/workspaceFs.ts";

export function globToRegExp(pattern: string): RegExp {
  let out = "";

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (String.raw`\^$.|+()[]{}`.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }

  return new RegExp(`^${out}$`);
}

export function limitWarnings(rules: Array<LimitRule>): Array<string> {
  const warnings: Array<string> = [];
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

      try {
        const stat = workspaceLstat(".", file, "tracked file");

        if (stat?.isSymbolicLink()) continue;
        const content = readWorkspaceText(".", file, "tracked file");
        const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

        if (lines > rule.maxLines) {
          warnings.push(`warning: ${file}: ${lines} lines exceeds soft limit ${rule.maxLines}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(`warning: could not check soft limit for ${file} (${detail})`);
      }
    }
  }

  return warnings;
}

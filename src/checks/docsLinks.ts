// New in the kit (off by default): every relative markdown link in
// git-tracked *.md files must resolve to a git-tracked file or directory.
// Resolving against the tracked set (not the filesystem) catches
// gitignored-but-present targets, repo-escaping links, and case mismatches
// that break on case-sensitive hosts.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { DocsLinksConfig } from "../config.ts";

function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
}

// CommonMark allows an optional quoted title after the destination.
function stripLinkTitle(href: string): string {
  return href.replace(/\s+(["']).*\1\s*$/, "").trim();
}

export function docsLinkErrors(config: DocsLinksConfig): string[] {
  const bad: string[] = [];
  const result = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (result.status !== 0) {
    bad.push("could not list tracked files");
    return bad;
  }
  const tracked = new Set(result.stdout.split("\0").filter(Boolean));
  const isTracked = (target: string): boolean => {
    if (tracked.has(target)) return true;
    const prefix = `${target}/`;
    for (const file of tracked) {
      if (file.startsWith(prefix)) return true;
    }
    return false;
  };

  const files = [...tracked]
    .filter((file) => file.endsWith(".md"))
    .filter((file) => !config.exclude.some((prefix) => file.startsWith(prefix)))
    .sort();

  for (const file of files) {
    const text = stripFencedCode(readFileSync(file, "utf8"));
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const rawHref = match[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(rawHref) || rawHref.startsWith("#")) continue;
      let href = stripLinkTitle(rawHref);
      try {
        href = decodeURIComponent(href);
      } catch {
        bad.push(`${file}: broken link (${rawHref})`);
        continue;
      }
      href = href.split("#")[0] ?? "";
      if (!href) continue;
      const target = normalize(join(dirname(file), href)).replace(/\/+$/, "");
      if (target.startsWith("..")) {
        bad.push(`${file}: broken link (${rawHref})`);
        continue;
      }
      if (!isTracked(target)) bad.push(`${file}: broken link (${rawHref})`);
    }
  }
  return bad;
}

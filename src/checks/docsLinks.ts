// New in the kit (off by default): every relative markdown link in
// git-tracked *.md files must resolve. Scoped to tracked files so
// media-heavy trees stay fast.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { DocsLinksConfig } from "../config.ts";

function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
}

export function docsLinkErrors(config: DocsLinksConfig): string[] {
  const bad: string[] = [];
  const result = spawnSync("git", ["ls-files", "-z", "--", "*.md"], { encoding: "utf8" });
  if (result.status !== 0) {
    bad.push("could not list tracked markdown files");
    return bad;
  }
  const files = result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => !config.exclude.some((prefix) => file.startsWith(prefix)));

  for (const file of files) {
    const text = stripFencedCode(readFileSync(file, "utf8"));
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const rawHref = match[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(rawHref) || rawHref.startsWith("#")) continue;
      const href = decodeURIComponent(rawHref).split("#")[0];
      if (!href) continue;
      const target = normalize(join(dirname(file), href));
      if (!existsSync(target)) bad.push(`${file}: broken link (${rawHref})`);
    }
  }
  return bad;
}

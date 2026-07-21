// Port of the legacy wiki-stale. Informational: never fails a run; report
// text and ordering are parity-locked to parity/goldens.
import { execSync } from "node:child_process";
import { relative } from "node:path";
import { asList, isExternal, parseFrontmatter } from "../lib/frontmatter.ts";
import {
  normalizeWorkspacePath,
  readWorkspaceText,
  walkWorkspaceMarkdown,
} from "../lib/workspaceFs.ts";

function buildCommitDateMap(warn: (line: string) => void): Map<string, string> {
  const map = new Map<string, string>();
  let stdout: string;
  try {
    stdout = execSync("git log --name-only --format=__COMMIT__%cs", {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (err) {
    warn(`git log failed: ${(err as Error).message}`);
    return map;
  }
  let currentDate: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("__COMMIT__")) {
      currentDate = line.slice("__COMMIT__".length).trim() || null;
      continue;
    }
    if (!currentDate || !line) continue;
    if (!map.has(line)) map.set(line, currentDate);
  }
  return map;
}

function isStaleExempt(rel: string): boolean {
  if (rel.startsWith("sources/") || rel.startsWith("tags/")) return true;
  return false;
}

export type WikiStaleResult = { out: string[]; err: string[]; fatal?: string };

export function wikiStaleReport(rawRoot: string): WikiStaleResult {
  const err: string[] = [];
  let root: string;
  let pages: string[];
  try {
    root = normalizeWorkspacePath(rawRoot, "wiki.root");
    pages = walkWorkspaceMarkdown(".", root);
  } catch (error) {
    return {
      out: [],
      err: [],
      fatal: error instanceof Error ? error.message : String(error),
    };
  }
  const commitDates = buildCommitDateMap((line) => err.push(line));

  type Stale = {
    page: string;
    updated: string;
    newest: string;
    newer: { path: string; date: string }[];
  };

  const stale: Stale[] = [];

  for (const path of pages) {
    const rel = relative(root, path).replace(/\.md$/, "").replaceAll("\\\\", "/");
    if (isStaleExempt(rel)) continue;
    const text = readWorkspaceText(".", path);
    const fm = parseFrontmatter(text);
    const updated = typeof fm.updated === "string" ? fm.updated : null;
    if (!updated || !/^\d{4}-\d{2}-\d{2}$/.test(updated)) continue;

    const newer: { path: string; date: string }[] = [];
    let newest = updated;
    for (const source of asList(fm.sources)) {
      if (isExternal(source) || source.startsWith("[[")) continue;
      const date = commitDates.get(source);
      if (!date) continue;
      if (date > updated) {
        newer.push({ path: source, date });
        if (date > newest) newest = date;
      }
    }
    if (newer.length > 0) stale.push({ page: path, updated, newest, newer });
  }

  const out: string[] = [];
  if (stale.length === 0) {
    out.push("wiki-stale ok");
    return { out, err };
  }

  stale.sort((a, b) => b.newest.localeCompare(a.newest));
  for (const s of stale) {
    out.push(`${s.page} (updated=${s.updated}, newest source=${s.newest})`);
    for (const src of s.newer.slice(0, 5)) {
      out.push(`  - ${src.path} (${src.date})`);
    }
    if (s.newer.length > 5) out.push(`  - ... +${s.newer.length - 5} more`);
  }
  out.push(
    `\n${stale.length} wiki page${stale.length === 1 ? "" : "s"} have sources newer than their updated date`,
  );
  return { out, err };
}

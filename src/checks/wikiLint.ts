// Port of the legacy wiki-lint. Messages, ordering, and wikilink resolution
// (page-relative -> root-relative -> unique-leaf fallback) are parity-locked
// to parity/goldens. One recorded fix vs legacy: a missing log file is a
// clean error instead of an uncaught crash.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, relative } from "node:path";
import { asList, isExternal, parseFrontmatter } from "../lib/frontmatter.ts";

function walk(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) return walk(path);
      return path.endsWith(".md") ? [path] : [];
    })
    .sort();
}

function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
}

export type WikiLintResult = { errors: string[]; fatal?: string };

export function wikiLintErrors(root: string): WikiLintResult {
  let pages: string[];
  try {
    pages = walk(root);
  } catch {
    return { errors: [], fatal: `missing ${root}` };
  }

  const known = new Set<string>();
  const byLeaf = new Map<string, string[]>();
  for (const path of pages) {
    const rel = relative(root, path).replace(/\.md$/, "").replaceAll("\\\\", "/");
    known.add(rel);
    const leaf = basename(path, ".md");
    if (!byLeaf.has(leaf)) byLeaf.set(leaf, []);
    byLeaf.get(leaf)!.push(rel);
  }

  function normalizeWikiTarget(value: string): string {
    return normalize(value).replaceAll("\\\\", "/").replace(/^\.\//, "").replace(/\.md$/, "");
  }

  function resolveWikiTarget(fromPath: string, rawTarget: string): string[] {
    const fromRel = relative(root, fromPath).replace(/\.md$/, "").replaceAll("\\\\", "/");
    const fromDir = dirname(fromRel);
    const target = normalizeWikiTarget(rawTarget.trim().replace(/^\/+/, ""));
    const candidates = [normalizeWikiTarget(join(fromDir, target)), target];
    const found = candidates.find((candidate) => known.has(candidate));
    if (found) return [found];
    if (target.includes("/")) return [];
    const leafMatches = byLeaf.get(target) ?? [];
    return leafMatches.length === 1 ? leafMatches : [];
  }

  const bad: string[] = [];
  const inbound = new Map<string, Set<string>>();
  for (const path of pages) {
    const rel = relative(root, path).replace(/\.md$/, "").replaceAll("\\\\", "/");
    inbound.set(rel, new Set());
  }

  for (const path of pages) {
    const text = readFileSync(path, "utf8");
    if (!text.startsWith("---\n")) bad.push(`${path}: missing frontmatter`);
    if (!text.slice(4).includes("\n---\n")) bad.push(`${path}: unterminated frontmatter`);
    const fm = parseFrontmatter(text);
    for (const key of ["title", "type", "status", "updated", "tags", "sources"]) {
      if (!(key in fm)) bad.push(`${path}: missing frontmatter field ${key}`);
    }
    for (const key of ["tags", "sources"]) {
      if (asList(fm[key]).length === 0) bad.push(`${path}: empty frontmatter field ${key}`);
    }
    const status = fm.status;
    if (typeof status === "string" && !["active", "draft", "archived"].includes(status)) {
      bad.push(`${path}: invalid status ${status}`);
    }
    const updated = fm.updated;
    if (typeof updated === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(updated)) {
      bad.push(`${path}: updated must be YYYY-MM-DD`);
    }
    for (const source of asList(fm.sources)) {
      if (isExternal(source) || source.startsWith("[[")) continue;
      if (!existsSync(source)) bad.push(`${path}: missing source ${source}`);
    }

    const linkText = stripFencedCode(text);
    for (const match of linkText.matchAll(/\[\[([^\]|#]+)/g)) {
      const resolved = resolveWikiTarget(path, match[1]!);
      if (resolved.length === 0) {
        bad.push(`${path}: broken wikilink [[${match[1]}]]`);
      } else {
        for (const rel of resolved) inbound.get(rel)?.add(path);
      }
    }

    for (const match of linkText.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const rawHref = match[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(rawHref) || rawHref.startsWith("#")) continue;
      const href = rawHref.replace(/%20/g, " ").split("#")[0];
      if (!href) continue;
      const target = normalize(join(dirname(path), href));
      if (!existsSync(target)) bad.push(`${path}: broken markdown link (${rawHref})`);
      if (target.startsWith(root) && target.endsWith(".md")) {
        const rel = relative(root, target).replace(/\.md$/, "").replaceAll("\\\\", "/");
        inbound.get(rel)?.add(path);
      }
    }
  }

  function isOrphanExempt(rel: string): boolean {
    if (rel === "index" || rel === "log" || rel === "schema") return true;
    if (rel.endsWith("/index")) return true;
    if (rel.startsWith("sources/") || rel.startsWith("tags/")) return true;
    return false;
  }

  for (const page of inbound.keys()) {
    if (isOrphanExempt(page)) continue;
    if ((inbound.get(page)?.size ?? 0) === 0) bad.push(`${root}/${page}.md: no inbound wiki links`);
  }

  const logPath = join(root, "log.md");
  if (!existsSync(logPath)) {
    // Recorded fix: legacy crashed here with a stack trace.
    bad.push(`missing ${logPath}`);
  } else {
    const logText = readFileSync(logPath, "utf8");
    const logHeadings = [...logText.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!);
    for (const heading of logHeadings) {
      if (!/^\[\d{4}-\d{2}-\d{2}\]\s+\S+\s+\|\s+.+$/.test(heading)) {
        bad.push(`${root}/log.md: unparseable log heading ${heading}`);
      }
    }
  }

  return { errors: bad };
}

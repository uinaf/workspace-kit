// Port of the legacy wiki-backfill generator. Generated content, the
// date-only-diff idempotency suppression, and the stale tag-page purge are
// parity-locked to parity/goldens. Adds --dry-run (no legacy counterpart).
import { basename, dirname, posix, relative } from "node:path";
import { parseFrontmatter } from "../lib/frontmatter.ts";
import {
  normalizeWorkspacePath,
  readWorkspaceDirectory,
  readWorkspaceText,
  unlinkWorkspaceFile,
  walkWorkspaceMarkdown,
  workspaceLstat,
  writeWorkspaceText,
} from "../lib/workspaceFs.ts";

type Source = {
  path: string;
  title: string;
  tags: string[];
  kind: string;
  date: string | undefined;
};

type WriteOperation = { path: string; content: string };

const WORKSPACE_ROOT = ".";

function firstHeading(text: string): string | undefined {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "untagged"
  );
}

function sourceKind(path: string): string {
  if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) return "daily-log";
  if (path.startsWith("memory/contexts/")) return "context";
  if (path.startsWith("memory/intake/")) return "intake";
  if (path.startsWith("memory/notes/")) return "note";
  if (path.startsWith("docs/reference/")) return "reference";
  if (path.startsWith("docs/runbooks/")) return "runbook";
  if (path.startsWith("docs/specs/")) return "spec";
  if (path.startsWith("user/")) return "user";
  return "source";
}

function titleFor(path: string, text: string, fm: Record<string, unknown>): string {
  const t = fm.title;
  if (typeof t === "string" && t.length > 0) return t;
  return firstHeading(text) ?? basename(path, ".md");
}

function tagsFor(path: string, fm: Record<string, unknown>): string[] {
  const tags = fm.tags;
  const arr = Array.isArray(tags) ? tags.map(String) : typeof tags === "string" ? [tags] : [];
  const derived = new Set(arr.map((t) => slugify(t)).filter(Boolean));
  derived.add(sourceKind(path));
  if (path.startsWith("docs/")) derived.add("docs");
  if (path.startsWith("user/")) derived.add("private");
  if (path.startsWith("memory/contexts/")) derived.add(path.split("/")[2]!);
  return [...derived].sort();
}

function directDailyLogs(): string[] {
  return readWorkspaceDirectory(WORKSPACE_ROOT, "memory", "empty")
    .flatMap((entry) => {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) return [];
      const path = posix.join("memory", entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`${path}: symbolic-link file is not allowed`);
      }
      return entry.isFile() ? [path] : [];
    })
    .sort();
}

function optionalRootFile(path: string): boolean {
  const stat = workspaceLstat(WORKSPACE_ROOT, path, "source path");
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`${path}: symbolic-link file is not allowed`);
  if (!stat.isFile()) throw new Error(`${path}: expected a regular file`);
  return true;
}

function allSources(root: string): Source[] {
  const paths = [
    ...walkWorkspaceMarkdown(WORKSPACE_ROOT, "memory/intake", "empty"),
    ...walkWorkspaceMarkdown(WORKSPACE_ROOT, "memory/notes", "empty"),
    ...walkWorkspaceMarkdown(WORKSPACE_ROOT, "docs", "empty"),
    ...walkWorkspaceMarkdown(WORKSPACE_ROOT, "user", "empty"),
    ...walkWorkspaceMarkdown(WORKSPACE_ROOT, "memory/contexts", "empty"),
    ...directDailyLogs(),
    "AGENTS.md",
    "MEMORY.md",
    "USER.md",
    "TOOLS.md",
    "SOUL.md",
    "README.md",
    "CONTRIBUTING.md",
  ].filter(
    // Root convention files are optional: a scaffold without SOUL.md et al.
    // must not crash the generator (recorded fix vs legacy).
    (p, i, a) =>
      a.indexOf(p) === i && p !== root && !p.startsWith(`${root}/`) && optionalRootFile(p),
  );

  return paths.sort().map((path) => {
    const text = readWorkspaceText(WORKSPACE_ROOT, path, "source path");
    const fm = parseFrontmatter(text);
    return {
      path,
      title: titleFor(path, text, fm),
      tags: tagsFor(path, fm),
      kind: sourceKind(path),
      date: path.match(/(\d{4}-\d{2}-\d{2})/)?.[1],
    };
  });
}

function yamlList(items: string[]): string {
  return items.length ? items.map((x) => `  - ${JSON.stringify(x)}`).join("\n") : "  []";
}

export type BackfillResult = { out: string[]; planned: string[] };

export function wikiBackfill(options: { root: string; dryRun: boolean }): BackfillResult {
  const root = normalizeWorkspacePath(options.root, "wiki.root");
  const today = new Date().toLocaleDateString("sv-SE");
  const planned: string[] = [];
  const writes: WriteOperation[] = [];
  const deletes: string[] = [];

  function planWrite(path: string, content: string): void {
    const outputPath = normalizeWorkspacePath(path, "generated path");
    const next = content.endsWith("\n") ? content : `${content}\n`;
    const stat = workspaceLstat(WORKSPACE_ROOT, outputPath, "generated path");
    if (stat) {
      if (stat.isSymbolicLink()) {
        throw new Error(`${outputPath}: refusing to write through a symlink`);
      }
      if (!stat.isFile()) throw new Error(`${outputPath}: expected a regular file`);
      const current = readWorkspaceText(WORKSPACE_ROOT, outputPath, "generated path");
      const stripDates = (value: string) =>
        value
          .split("\n")
          .filter((line) => !/^\s*[A-Za-z0-9_-]+:\s*\d{4}-\d{2}-\d{2}\s*$/.test(line))
          .join("\n");
      if (stripDates(current) === stripDates(next)) {
        if (!options.dryRun) {
          writes.push({
            path: outputPath,
            content: current.endsWith("\n") ? current : `${current}\n`,
          });
        }
        return;
      }
    }
    if (options.dryRun) {
      planned.push(`would write ${outputPath}`);
    }
    writes.push({ path: outputPath, content: next });
  }

  function preflightWrite(path: string): void {
    const stat = workspaceLstat(WORKSPACE_ROOT, path, "generated path");
    if (stat?.isSymbolicLink()) throw new Error(`${path}: refusing to write through a symlink`);
    if (stat && !stat.isFile()) throw new Error(`${path}: expected a regular file`);
  }

  function preflightDelete(path: string): void {
    const stat = workspaceLstat(WORKSPACE_ROOT, path, "generated path");
    if (!stat) throw new Error(`${path}: file is missing`);
    if (stat.isSymbolicLink()) throw new Error(`${path}: refusing to delete a symlink`);
    if (!stat.isFile()) throw new Error(`${path}: expected a regular file`);
  }

  function table(sources: Source[]): string {
    return [
      "| Source | Kind | Tags |",
      "|---|---|---|",
      ...sources.map(
        (s) =>
          `| [${s.title.replaceAll("|", "\\|")}](${relative(dirname(`${root}/sources/index.md`), s.path).replaceAll(" ", "%20")}) | ${s.kind} | ${s.tags
            .slice(0, 8)
            .map((t) => `#${t}`)
            .join(" ")} |`,
      ),
    ].join("\n");
  }

  const sources = allSources(root);
  const byTag = new Map<string, Source[]>();
  const byKind = new Map<string, Source[]>();
  for (const s of sources) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, []);
    byKind.get(s.kind)!.push(s);
    for (const tag of s.tags) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push(s);
    }
  }

  const tagEntries = [...byTag.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const materializedTagEntries = tagEntries.filter(([, list]) => list.length >= 2);
  const kindEntries = [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  planWrite(
    `${root}/sources/index.md`,
    `---
title: "Source Catalog"
type: wiki-index
status: active
updated: ${today}
tags: [sources, backfill, wiki]
sources:
${yamlList(sources.map((s) => s.path))}
related:
  - "[[../index]]"
  - "[[../tags/index]]"
---

# Source Catalog

Generated catalog of raw/source-layer markdown files currently feeding the wiki.

## Counts

- Total sources: ${sources.length}
${kindEntries.map(([kind, list]) => `- ${kind}: ${list.length}`).join("\n")}

## By Kind

Daily logs live in their own catalog at [[daily-log]] to keep this index navigable; everything else is below.

${kindEntries
  .filter(([kind]) => kind !== "daily-log")
  .map(([kind, list]) => `### ${kind}\n\n${table(list)}`)
  .join("\n\n")}
`,
  );

  planWrite(
    `${root}/tags/index.md`,
    `---
title: "Tag Index"
type: wiki-index
status: active
updated: ${today}
tags: [tags, backfill, wiki]
sources:
  - ${root}/sources/index.md
related:
  - "[[../index]]"
---

# Tag Index

Generated index of normalized tags across raw sources.

${tagEntries.map(([tag, list]) => (list.length >= 2 ? `- [[${tag}]] — ${list.length} sources` : `- ${tag} — 1 source`)).join("\n")}
`,
  );

  // Purge stale tag pages (tags that no longer materialize)
  const keepTags = new Set(materializedTagEntries.map(([tag]) => tag));
  const tagsDir = posix.join(root, "tags");
  for (const entry of readWorkspaceDirectory(WORKSPACE_ROOT, tagsDir, "empty")) {
    const name = entry.name;
    if (!name.endsWith(".md") || name === "index.md") continue;
    const tag = name.replace(/\.md$/, "");
    if (!keepTags.has(tag)) {
      const path = posix.join(tagsDir, name);
      deletes.push(path);
      if (options.dryRun) {
        planned.push(`would delete ${path}`);
      }
    }
  }

  for (const [tag, list] of materializedTagEntries) {
    planWrite(
      `${root}/tags/${tag}.md`,
      `---
title: "Tag: ${tag}"
type: wiki
status: active
updated: ${today}
tags: [tag, ${tag}]
sources:
${yamlList(list.map((s) => s.path))}
related:
  - "[[index]]"
  - "[[../sources/index]]"
---

# Tag: ${tag}

${list.length} source${list.length === 1 ? "" : "s"} currently carry this tag or derived classification.

${table(list)}
`,
    );
  }

  const daily = sources.filter((s) => s.kind === "daily-log");
  planWrite(
    `${root}/sources/daily-log.md`,
    `---
title: "Daily Log Backfill"
type: wiki-index
status: active
updated: ${today}
tags: [daily-log, backfill, timeline]
sources:
${yamlList(daily.map((s) => s.path))}
related:
  - "[[index]]"
  - "[[../agents/write-backs]]"
---

# Daily Log Backfill

Raw daily logs are the chronological evidence stream. Durable facts should be promoted into topic pages instead of copied wholesale.

${table(daily)}
`,
  );

  // Inventory, current-output reads, and destructive candidates are complete
  // before the first mutation. Re-check every leaf immediately before apply so
  // an unsafe output shape cannot leave a partially refreshed catalog.
  for (const operation of writes) preflightWrite(operation.path);
  for (const path of deletes) preflightDelete(path);
  if (!options.dryRun) {
    for (const operation of writes) {
      writeWorkspaceText(WORKSPACE_ROOT, operation.path, operation.content);
    }
    // Deletions are deliberately last: a purge error must surface, but should
    // never prevent a newly computed catalog from being fully materialized.
    for (const path of deletes) unlinkWorkspaceFile(WORKSPACE_ROOT, path);
  }

  const out = [
    `backfilled ${sources.length} sources, ${tagEntries.length} tags (${materializedTagEntries.length} materialized pages)`,
  ];
  return { out, planned };
}

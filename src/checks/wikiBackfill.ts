// Port of the legacy wiki-backfill generator. Generated content, the
// date-only-diff idempotency suppression, and the stale tag-page purge are
// parity-locked to parity/goldens. Adds --dry-run (no legacy counterpart).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseFrontmatter } from "../lib/frontmatter.ts";

type Source = {
  path: string;
  title: string;
  tags: string[];
  kind: string;
  date: string | undefined;
};

function walk(dir: string): string[] {
  try {
    return readdirSync(dir)
      .flatMap((name) => {
        const path = join(dir, name);
        const stat = statSync(path);
        if (stat.isDirectory()) return walk(path);
        return path.endsWith(".md") ? [path] : [];
      })
      .sort();
  } catch {
    return [];
  }
}

function firstHeading(text: string): string | undefined {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untagged";
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

function allSources(): Source[] {
  const paths = [
    ...walk("memory/intake"),
    ...walk("memory/notes"),
    ...walk("docs"),
    ...walk("user"),
    ...walk("memory/contexts"),
    ...walk("memory").filter((p) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(p)),
    "AGENTS.md", "MEMORY.md", "USER.md", "TOOLS.md", "SOUL.md", "README.md", "CONTRIBUTING.md",
  ].filter((p, i, a) => a.indexOf(p) === i && !p.startsWith("memory/wiki/"));

  return paths.sort().map((path) => {
    const text = readFileSync(path, "utf8");
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

export function wikiBackfill(options: { dryRun: boolean }): BackfillResult {
  const today = new Date().toLocaleDateString("sv-SE");
  const planned: string[] = [];

  function write(path: string, content: string): void {
    const next = content.endsWith("\n") ? content : `${content}\n`;
    if (existsSync(path)) {
      const current = readFileSync(path, "utf8");
      const stripDates = (value: string) =>
        value
          .split("\n")
          .filter((line) => !/^\s*[A-Za-z0-9_-]+:\s*\d{4}-\d{2}-\d{2}\s*$/.test(line))
          .join("\n");
      if (stripDates(current) === stripDates(next)) {
        if (!options.dryRun) {
          writeFileSync(path, current.endsWith("\n") ? current : `${current}\n`);
        }
        return;
      }
    }
    if (options.dryRun) {
      planned.push(`would write ${path}`);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
  }

  function table(sources: Source[]): string {
    return [
      "| Source | Kind | Tags |",
      "|---|---|---|",
      ...sources.map(
        (s) =>
          `| [${s.title.replaceAll("|", "\\|")}](${relative(dirname("memory/wiki/sources/index.md"), s.path).replaceAll(" ", "%20")}) | ${s.kind} | ${s.tags.slice(0, 8).map((t) => `#${t}`).join(" ")} |`,
      ),
    ].join("\n");
  }

  const sources = allSources();
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

  write("memory/wiki/sources/index.md", `---
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

${kindEntries.filter(([kind]) => kind !== "daily-log").map(([kind, list]) => `### ${kind}\n\n${table(list)}`).join("\n\n")}
`);

  write("memory/wiki/tags/index.md", `---
title: "Tag Index"
type: wiki-index
status: active
updated: ${today}
tags: [tags, backfill, wiki]
sources:
  - memory/wiki/sources/index.md
related:
  - "[[../index]]"
---

# Tag Index

Generated index of normalized tags across raw sources.

${tagEntries.map(([tag, list]) => (list.length >= 2 ? `- [[${tag}]] — ${list.length} sources` : `- ${tag} — 1 source`)).join("\n")}
`);

  // Purge stale tag pages (tags that no longer materialize)
  const keepTags = new Set(materializedTagEntries.map(([tag]) => tag));
  const tagsDir = "memory/wiki/tags";
  try {
    for (const name of readdirSync(tagsDir)) {
      if (!name.endsWith(".md") || name === "index.md") continue;
      const tag = name.replace(/\.md$/, "");
      if (!keepTags.has(tag)) {
        if (options.dryRun) {
          planned.push(`would delete ${join(tagsDir, name)}`);
        } else {
          unlinkSync(join(tagsDir, name));
        }
      }
    }
  } catch {}

  for (const [tag, list] of materializedTagEntries) {
    write(`memory/wiki/tags/${tag}.md`, `---
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
`);
  }

  const daily = sources.filter((s) => s.kind === "daily-log");
  write("memory/wiki/sources/daily-log.md", `---
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
`);

  const out = [
    `backfilled ${sources.length} sources, ${tagEntries.length} tags (${materializedTagEntries.length} materialized pages)`,
  ];
  return { out, planned };
}

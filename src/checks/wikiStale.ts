// The default date-only report is parity-locked to the legacy wiki-stale.
// Stale findings remain informational; opt-in revision mode fails only when
// complete Git history cannot be inspected safely.
import { execFileSync, execSync } from "node:child_process";
import { relative } from "node:path";
import { asList, isExternal, parseFrontmatter } from "../lib/frontmatter.ts";
import {
  normalizeWorkspacePath,
  readWorkspaceText,
  walkWorkspaceMarkdown,
} from "../lib/workspaceFs.ts";

type Commit = { hash: string; date: string };

type GitHistory = {
  head: string;
  latestCommit(path: string): Commit | undefined;
  blobAt(revision: string, path: string): string | undefined;
};

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

function gitOutput(args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`could not inspect Git history: ${(error as Error).message}`);
  }
}

function buildGitHistory(): GitHistory {
  const shallow = gitOutput(["rev-parse", "--is-shallow-repository"]).trim();
  if (shallow === "true") {
    throw new Error("wiki stale requires a full Git history; repository is shallow");
  }
  if (shallow !== "false") throw new Error("could not determine whether Git history is shallow");

  const head = gitOutput(["rev-parse", "--verify", "HEAD"]).trim();
  const commits = new Map<string, Commit | undefined>();
  const blobs = new Map<string, string | undefined>();

  return {
    head,
    latestCommit(path) {
      if (commits.has(path)) return commits.get(path);
      const output = gitOutput([
        "--literal-pathspecs",
        "log",
        "-1",
        "--format=format:%H%x00%cs",
        head,
        "--",
        path,
      ]);
      if (output.length === 0) {
        commits.set(path, undefined);
        return undefined;
      }
      const separator = output.indexOf("\0");
      const hash = output.slice(0, separator);
      const date = output.slice(separator + 1);
      if (separator < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`could not parse Git history for ${path}`);
      }
      const commit = { hash, date };
      commits.set(path, commit);
      return commit;
    },
    blobAt(revision, path) {
      const key = `${revision}\0${path}`;
      if (blobs.has(key)) return blobs.get(key);
      const output = gitOutput([
        "--literal-pathspecs",
        "ls-tree",
        "-z",
        "--full-tree",
        revision,
        "--",
        path,
      ]);
      if (output.length === 0) {
        blobs.set(key, undefined);
        return undefined;
      }
      const terminator = output.indexOf("\0");
      const record = output.slice(0, terminator);
      const tab = record.indexOf("\t");
      const [mode, type, object] = record.slice(0, tab).split(" ");
      if (terminator < 0 || tab < 1 || !mode || type !== "blob" || !object) {
        throw new Error(`could not parse Git tree state for ${path}`);
      }
      blobs.set(key, object);
      return object;
    },
  };
}

export type WikiStaleResult = { out: string[]; err: string[]; fatal?: string };

type StaleSource = { path: string; date: string; newerRevision?: boolean };
type StalePage = {
  page: string;
  updated: string;
  newest: string;
  newer: StaleSource[];
};

function fatal(error: unknown): WikiStaleResult {
  return {
    out: [],
    err: [],
    fatal: error instanceof Error ? error.message : String(error),
  };
}

function isStaleExempt(rel: string): boolean {
  if (rel.startsWith("sources/") || rel.startsWith("tags/")) return true;
  return false;
}

function renderStale(stale: StalePage[], err: string[]): WikiStaleResult {
  const out: string[] = [];
  if (stale.length === 0) {
    out.push("wiki-stale ok");
    return { out, err };
  }

  stale.sort((a, b) => b.newest.localeCompare(a.newest));
  for (const entry of stale) {
    out.push(`${entry.page} (updated=${entry.updated}, newest source=${entry.newest})`);
    for (const source of entry.newer.slice(0, 5)) {
      out.push(
        `  - ${source.path} (${source.date}${source.newerRevision ? "; newer commit" : ""})`,
      );
    }
    if (entry.newer.length > 5) out.push(`  - ... +${entry.newer.length - 5} more`);
  }
  const hasNewerRevision = stale.some((entry) =>
    entry.newer.some((source) => source.newerRevision),
  );
  out.push(
    hasNewerRevision
      ? `\n${stale.length} wiki page${stale.length === 1 ? "" : "s"} ${stale.length === 1 ? "has" : "have"} source commits newer than the page revision or updated date`
      : `\n${stale.length} wiki page${stale.length === 1 ? "" : "s"} have sources newer than their updated date`,
  );
  return { out, err };
}

function legacyWikiStaleReport(rawRoot: string): WikiStaleResult {
  const err: string[] = [];
  let root: string;
  let pages: string[];
  try {
    root = normalizeWorkspacePath(rawRoot, "wiki.root");
    pages = walkWorkspaceMarkdown(".", root);
  } catch (error) {
    return fatal(error);
  }
  const commitDates = buildCommitDateMap((line) => err.push(line));

  const stale: StalePage[] = [];

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

  return renderStale(stale, err);
}

function revisionWikiStaleReport(rawRoot: string): WikiStaleResult {
  let root: string;
  let pages: string[];
  let history: GitHistory;
  try {
    root = normalizeWorkspacePath(rawRoot, "wiki.root");
    pages = walkWorkspaceMarkdown(".", root);
    history = buildGitHistory();
  } catch (error) {
    return fatal(error);
  }

  const stale: StalePage[] = [];

  try {
    for (const path of pages) {
      const rel = relative(root, path).replace(/\.md$/, "").replaceAll("\\\\", "/");
      if (isStaleExempt(rel)) continue;
      const text = readWorkspaceText(".", path);
      const fm = parseFrontmatter(text);
      const updated = typeof fm.updated === "string" ? fm.updated : null;
      if (!updated || !/^\d{4}-\d{2}-\d{2}$/.test(updated)) continue;

      const newer: StaleSource[] = [];
      let newest = "";
      const pageCommit = history.latestCommit(path);
      for (const source of asList(fm.sources)) {
        if (isExternal(source) || source.startsWith("[[")) continue;
        const sourceCommit = history.latestCommit(source);
        const currentSourceBlob = history.blobAt(history.head, source);
        if (!sourceCommit || !currentSourceBlob) continue;
        const visibleSourceBlob = pageCommit ? history.blobAt(pageCommit.hash, source) : undefined;
        const revisionStale = visibleSourceBlob !== currentSourceBlob;
        const dateStale = sourceCommit.date > updated;
        if (dateStale || revisionStale) {
          newer.push({
            path: source,
            date: sourceCommit.date,
            newerRevision: revisionStale && !dateStale,
          });
          if (!newest || sourceCommit.date > newest) newest = sourceCommit.date;
        }
      }
      if (newer.length > 0) stale.push({ page: path, updated, newest, newer });
    }
  } catch (error) {
    return fatal(error);
  }

  return renderStale(stale, []);
}

export function wikiStaleReport(
  rawRoot: string,
  options: { revisionStaleness?: boolean } = {},
): WikiStaleResult {
  return options.revisionStaleness
    ? revisionWikiStaleReport(rawRoot)
    : legacyWikiStaleReport(rawRoot);
}

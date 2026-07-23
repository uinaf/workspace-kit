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
  workspaceLstat,
} from "../lib/workspaceFs.ts";

type Commit = { hash: string; date: string };
type HistoryCommit = Commit & { parents: string[] };

type GitHistory = {
  head: string;
  latestCommit(path: string): Commit | undefined;
  commits(path: string): HistoryCommit[];
  blobAt(revision: string, path: string): string | undefined;
  blobText(object: string): string;
  worktreeBlob(path: string): string;
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
  const pathCommits = new Map<string, HistoryCommit[]>();
  const blobs = new Map<string, string | undefined>();
  const blobTexts = new Map<string, string>();
  const worktreeBlobs = new Map<string, string>();

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
    commits(path) {
      const cached = pathCommits.get(path);
      if (cached) return cached;
      const output = gitOutput([
        "--literal-pathspecs",
        "log",
        "--first-parent",
        "--format=format:%H%x00%cs%x00%P%x1e",
        head,
        "--",
        path,
      ]);
      const history = output
        .split("\x1e")
        .map((record) => record.replace(/^\n+|\n+$/g, ""))
        .filter(Boolean)
        .map((record) => {
          const [hash, date, rawParents, ...rest] = record.split("\0");
          if (
            rest.length > 0 ||
            !hash ||
            !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ||
            rawParents === undefined
          ) {
            throw new Error(`could not parse Git history for ${path}`);
          }
          return {
            hash,
            date: date!,
            parents: rawParents ? rawParents.split(" ") : [],
          };
        });
      pathCommits.set(path, history);
      return history;
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
    blobText(object) {
      const cached = blobTexts.get(object);
      if (cached !== undefined) return cached;
      const output = gitOutput(["cat-file", "blob", object]);
      blobTexts.set(object, output);
      return output;
    },
    worktreeBlob(path) {
      const cached = worktreeBlobs.get(path);
      if (cached !== undefined) return cached;
      const object = gitOutput(["hash-object", `--path=${path}`, "--", path]).trim();
      if (!object) throw new Error(`could not inspect working-tree state for ${path}`);
      worktreeBlobs.set(path, object);
      return object;
    },
  };
}

export type WikiStaleResult = { out: string[]; err: string[]; fatal?: string };

type StaleSource = {
  path: string;
  date: string;
  newerRevision?: boolean;
  workingTree?: boolean;
  uncommitted?: boolean;
  deleted?: boolean;
};
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

function isWikiPage(root: string, path: string): boolean {
  return path.endsWith(".md") && path.startsWith(`${root}/`);
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function withoutUpdatedMetadata(text: string): string {
  const normalized = normalizeLineEndings(text);
  if (!normalized.startsWith("---\n")) return normalized;
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return normalized;
  const frontmatter = normalized
    .slice(4, end)
    .split("\n")
    .filter((line) => !line.startsWith("updated:"))
    .join("\n");
  return `---\n${frontmatter}${normalized.slice(end)}`;
}

function sourceState(root: string, path: string, text: string): string {
  return isWikiPage(root, path) ? withoutUpdatedMetadata(text) : text;
}

function latestSubstantiveCommit(
  history: GitHistory,
  root: string,
  path: string,
): Commit | undefined {
  if (!isWikiPage(root, path)) return history.latestCommit(path);

  for (const commit of history.commits(path)) {
    const object = history.blobAt(commit.hash, path);
    const parent = commit.parents[0];
    const parentObject = parent ? history.blobAt(parent, path) : undefined;
    if (!object) {
      if (parentObject) return commit;
      continue;
    }
    const text = withoutUpdatedMetadata(history.blobText(object));
    if (
      parentObject === undefined ||
      withoutUpdatedMetadata(history.blobText(parentObject)) !== text
    ) {
      return commit;
    }
  }
  return undefined;
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
      const revision = source.uncommitted
        ? "; uncommitted"
        : source.workingTree
          ? "; working tree"
          : source.newerRevision
            ? "; newer commit"
            : "";
      const deletion = source.deleted ? "; deleted" : "";
      out.push(`  - ${source.path} (${source.date}${revision}${deletion})`);
    }
    if (entry.newer.length > 5) out.push(`  - ... +${entry.newer.length - 5} more`);
  }
  const hasNewerRevision = stale.some((entry) =>
    entry.newer.some((source) => source.newerRevision),
  );
  const hasWorkingTree = stale.some((entry) => entry.newer.some((source) => source.workingTree));
  out.push(
    hasWorkingTree
      ? `\n${stale.length} wiki page${stale.length === 1 ? "" : "s"} ${stale.length === 1 ? "has" : "have"} source revisions newer than the proposed page revision or updated date`
      : hasNewerRevision
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
  const substantiveCommits = new Map<string, Commit | undefined>();

  try {
    for (const path of pages) {
      const rel = relative(root, path).replace(/\.md$/, "").replaceAll("\\\\", "/");
      if (isStaleExempt(rel)) continue;
      const text = readWorkspaceText(".", path);
      const normalizedText = normalizeLineEndings(text);
      const fm = parseFrontmatter(normalizedText);
      const updated = typeof fm.updated === "string" ? fm.updated : null;
      if (!updated || !/^\d{4}-\d{2}-\d{2}$/.test(updated)) continue;

      const newer: StaleSource[] = [];
      let newest = "";
      const pageCommit = history.latestCommit(path);
      const pageHeadBlob = history.blobAt(history.head, path);
      const proposedPage =
        pageHeadBlob === undefined ||
        normalizeLineEndings(history.blobText(pageHeadBlob)) !== normalizedText;
      for (const source of asList(fm.sources)) {
        if (isExternal(source) || source.startsWith("[[")) continue;
        const sourcePath = normalizeWorkspacePath(source, "wiki source");
        const sourceCommit = history.latestCommit(sourcePath);
        let substantiveCommit: Commit | undefined;
        if (substantiveCommits.has(sourcePath)) {
          substantiveCommit = substantiveCommits.get(sourcePath);
        } else {
          substantiveCommit = latestSubstantiveCommit(history, root, sourcePath);
          substantiveCommits.set(sourcePath, substantiveCommit);
        }
        const visibleSourceBlob = pageCommit
          ? history.blobAt(pageCommit.hash, sourcePath)
          : undefined;
        let revisionStale = false;
        let workingTree = false;
        const sourceStat = workspaceLstat(".", sourcePath, "wiki source");
        if (sourceStat?.isSymbolicLink()) {
          throw new Error(`${sourcePath}: symbolic-link file is not allowed`);
        }
        const sourceMissing = sourceStat === undefined;
        if (!proposedPage) {
          const headSourceBlob = history.blobAt(history.head, sourcePath);
          if (sourceMissing) {
            workingTree = headSourceBlob !== undefined;
            revisionStale = visibleSourceBlob !== undefined;
          } else if (isWikiPage(root, sourcePath)) {
            const currentState = sourceState(root, sourcePath, readWorkspaceText(".", sourcePath));
            workingTree =
              headSourceBlob === undefined ||
              currentState !== sourceState(root, sourcePath, history.blobText(headSourceBlob));
            revisionStale =
              visibleSourceBlob === undefined ||
              currentState !== sourceState(root, sourcePath, history.blobText(visibleSourceBlob));
          } else {
            const currentSourceBlob = history.worktreeBlob(sourcePath);
            workingTree = headSourceBlob === undefined || currentSourceBlob !== headSourceBlob;
            revisionStale =
              visibleSourceBlob === undefined || currentSourceBlob !== visibleSourceBlob;
          }
        }
        const dateStale = substantiveCommit !== undefined && substantiveCommit.date > updated;
        if (dateStale || revisionStale) {
          const sourceDate = substantiveCommit?.date ?? "working tree";
          newer.push({
            path: sourcePath,
            date: sourceDate,
            newerRevision: revisionStale && !dateStale,
            workingTree: workingTree && !dateStale,
            uncommitted: sourceCommit === undefined,
            deleted: sourceMissing,
          });
          if (substantiveCommit && (!newest || substantiveCommit.date > newest)) {
            newest = substantiveCommit.date;
          }
        }
      }
      if (newer.length > 0) {
        stale.push({ page: path, updated, newest: newest || "working tree", newer });
      }
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

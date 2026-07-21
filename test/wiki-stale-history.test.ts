import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vite-plus/test";
import { wikiStaleReport } from "../src/checks/wikiStale.ts";

function inDir<T>(dir: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function strictReport(root: string) {
  return wikiStaleReport(root, { revisionStaleness: true });
}

function commitAll(dir: string, message: string, date: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "-qm", message],
    {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
}

function merge(dir: string, branch: string, date: string): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "user.name=Fixture",
      "merge",
      "--no-ff",
      "-qm",
      `merge ${branch}`,
      branch,
    ],
    {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
}

test("wiki stale detects a source committed later on the page's updated date", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-stale-history-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "memory", "wiki"), { recursive: true });
  writeFileSync(join(dir, "docs", "source.md"), "# Source\n\nInitial.\n");
  writeFileSync(
    join(dir, "memory", "wiki", "topic.md"),
    [
      "---",
      'title: "Topic"',
      "type: wiki",
      "status: active",
      "updated: 2026-07-21",
      "tags: [topic]",
      "sources:",
      "  - docs/source.md",
      "---",
      "",
      "# Topic",
      "",
      "Initial.",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  commitAll(dir, "baseline", "2026-07-21T08:00:00Z");

  const baseline = inDir(dir, () => strictReport("memory/wiki"));
  assert.deepEqual(baseline.out, ["wiki-stale ok"]);

  writeFileSync(join(dir, "docs", "source.md"), "# Source\n\nChanged later.\n");
  commitAll(dir, "update source", "2026-07-21T09:00:00Z");

  const legacy = inDir(dir, () => wikiStaleReport("memory/wiki"));
  assert.deepEqual(legacy.out, ["wiki-stale ok"]);

  const stale = inDir(dir, () => strictReport("memory/wiki"));
  assert.deepEqual(stale.err, []);
  assert.deepEqual(stale.out, [
    "memory/wiki/topic.md (updated=2026-07-21, newest source=2026-07-21)",
    "  - docs/source.md (2026-07-21; newer commit)",
    "\n1 wiki page has source commits newer than the page revision or updated date",
  ]);

  const page = join(dir, "memory", "wiki", "topic.md");
  writeFileSync(page, readFileSync(page, "utf8").replace("Initial.", "Changed later."));
  commitAll(dir, "refresh page", "2026-07-21T10:00:00Z");

  const refreshed = inDir(dir, () => strictReport("memory/wiki"));
  assert.deepEqual(refreshed.out, ["wiki-stale ok"]);

  writeFileSync(join(dir, "docs", "source.md"), "# Source\n\nBackdated change.\n");
  commitAll(dir, "backdated source update", "2026-07-20T12:00:00Z");
  const backdated = inDir(dir, () => strictReport("memory/wiki"));
  assert.match(backdated.out.join("\n"), /docs\/source\.md \(2026-07-20; newer commit\)/);
});

test("wiki stale covers every source state across a divergent merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-stale-merge-"));
  const source = join(dir, "docs", "source.md");
  const page = join(dir, "memory", "wiki", "topic.md");
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "memory", "wiki"), { recursive: true });
  writeFileSync(source, "# Source\n\nalpha: old\n1\n2\n3\n4\n5\n6\n7\n8\nbeta: old\n");
  writeFileSync(
    page,
    "---\ntitle: Topic\ntype: wiki\nstatus: active\nupdated: 2026-07-21\ntags: [topic]\nsources:\n  - docs/source.md\n---\n\n# Topic\n\nBaseline.\n",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  commitAll(dir, "baseline", "2026-07-21T08:00:00Z");

  execFileSync("git", ["checkout", "-qb", "branch-change"], { cwd: dir });
  writeFileSync(source, readFileSync(source, "utf8").replace("beta: old", "beta: branch"));
  commitAll(dir, "change beta", "2026-07-21T09:00:00Z");

  execFileSync("git", ["checkout", "-q", "main"], { cwd: dir });
  writeFileSync(source, readFileSync(source, "utf8").replace("alpha: old", "alpha: main"));
  commitAll(dir, "change alpha", "2026-07-21T09:30:00Z");
  writeFileSync(page, readFileSync(page, "utf8").replace("Baseline.", "Main state."));
  commitAll(dir, "refresh page before merge", "2026-07-21T10:00:00Z");

  merge(dir, "branch-change", "2026-07-21T11:00:00Z");
  const uncovered = inDir(dir, () => strictReport("memory/wiki"));
  assert.match(uncovered.out.join("\n"), /docs\/source\.md \(2026-07-21; newer commit\)/);

  writeFileSync(page, readFileSync(page, "utf8").replace("Main state.", "Merged state."));
  commitAll(dir, "refresh page after merge", "2026-07-21T12:00:00Z");
  const covered = inDir(dir, () => strictReport("memory/wiki"));
  assert.deepEqual(covered.out, ["wiki-stale ok"]);
});

test("wiki stale handles Unicode and quoted source paths literally", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-stale-unicode-"));
  const sourcePath = 'docs/café "notes".md';
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "memory", "wiki"), { recursive: true });
  writeFileSync(join(dir, sourcePath), "# Source\n\nInitial.\n");
  writeFileSync(
    join(dir, "memory", "wiki", "topic.md"),
    `---\ntitle: Topic\ntype: wiki\nstatus: active\nupdated: 2026-07-21\ntags: [topic]\nsources:\n  - ${sourcePath}\n---\n\n# Topic\n\nInitial.\n`,
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  commitAll(dir, "baseline", "2026-07-21T08:00:00Z");
  writeFileSync(join(dir, sourcePath), "# Source\n\nChanged.\n");
  commitAll(dir, "update Unicode source", "2026-07-21T09:00:00Z");

  const result = inDir(dir, () => strictReport("memory/wiki"));
  assert.match(result.out.join("\n"), /docs\/café "notes"\.md \(2026-07-21; newer commit\)/);
});

test("wiki stale refuses a misleading clean report in a shallow repository", () => {
  const origin = mkdtempSync(join(tmpdir(), "wiki-stale-origin-"));
  mkdirSync(join(origin, "memory", "wiki"), { recursive: true });
  writeFileSync(
    join(origin, "memory", "wiki", "index.md"),
    "---\ntitle: Index\ntype: wiki-index\nstatus: active\nupdated: 2026-07-21\ntags: [index]\nsources: []\n---\n\n# Index\n",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: origin });
  commitAll(origin, "baseline", "2026-07-21T08:00:00Z");

  const clone = join(mkdtempSync(join(tmpdir(), "wiki-stale-clone-")), "workspace");
  execFileSync("git", ["clone", "-q", "--depth", "1", pathToFileURL(origin).href, clone]);
  const result = inDir(clone, () => strictReport("memory/wiki"));
  assert.deepEqual(result.out, []);
  assert.equal(result.fatal, "wiki stale requires a full Git history; repository is shallow");
});

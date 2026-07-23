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
  const dirty = inDir(dir, () => strictReport("memory/wiki"));
  assert.match(dirty.out.join("\n"), /docs\/source\.md \(2026-07-21; working tree\)/);

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
  const proposedRefresh = inDir(dir, () => strictReport("memory/wiki"));
  assert.deepEqual(proposedRefresh.out, ["wiki-stale ok"]);

  commitAll(dir, "refresh page", "2026-07-21T10:00:00Z");

  const refreshed = inDir(dir, () => strictReport("memory/wiki"));
  assert.deepEqual(refreshed.out, ["wiki-stale ok"]);

  writeFileSync(join(dir, "docs", "source.md"), "# Source\n\nBackdated change.\n");
  commitAll(dir, "backdated source update", "2026-07-20T12:00:00Z");
  const backdated = inDir(dir, () => strictReport("memory/wiki"));
  assert.match(backdated.out.join("\n"), /docs\/source\.md \(2026-07-20; newer commit\)/);
});

test("wiki stale stops updated-only attestation churn but follows substantive nested changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-stale-chain-"));
  const source = join(dir, "docs", "source.md");
  const middle = join(dir, "memory", "wiki", "middle.md");
  const top = join(dir, "memory", "wiki", "top.md");
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "memory", "wiki"), { recursive: true });
  writeFileSync(source, "# Source\n\nInitial.\n");
  writeFileSync(
    middle,
    "---\ntitle: Middle\ntype: wiki\nstatus: active\nupdated: 2026-07-21\ntags: [topic]\nsources:\n  - docs/source.md\n---\n\n# Middle\n\nInitial.\n",
  );
  writeFileSync(
    top,
    "---\ntitle: Top\ntype: wiki\nstatus: active\nupdated: 2026-07-21\ntags: [topic]\nsources:\n  - memory/wiki/middle.md\n---\n\n# Top\n\nInitial.\n",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  commitAll(dir, "baseline", "2026-07-21T08:00:00Z");

  writeFileSync(source, "# Source\n\nChanged.\n");
  const dirtySource = inDir(dir, () => strictReport("memory/wiki"));
  assert.match(dirtySource.out.join("\n"), /^memory\/wiki\/middle\.md /);
  assert.doesNotMatch(dirtySource.out.join("\n"), /memory\/wiki\/top\.md/);

  writeFileSync(middle, readFileSync(middle, "utf8").replace("2026-07-21", "2026-07-22"));
  const proposedAttestation = inDir(dir, () => strictReport("memory/wiki"));
  assert.deepEqual(proposedAttestation.out, ["wiki-stale ok"]);
  commitAll(dir, "update source and attest middle", "2026-07-22T08:00:00Z");

  const committedAttestation = inDir(dir, () => strictReport("memory/wiki"));
  assert.deepEqual(committedAttestation.out, ["wiki-stale ok"]);

  writeFileSync(middle, readFileSync(middle, "utf8").replace("Initial.", "Substantive change."));
  const nestedChange = inDir(dir, () => strictReport("memory/wiki"));
  assert.match(nestedChange.out.join("\n"), /^memory\/wiki\/top\.md /);
  commitAll(dir, "change middle", "2026-07-23T08:00:00Z");

  writeFileSync(top, readFileSync(top, "utf8").replace("Initial.", "Reviewed change."));
  const backdatedAttestation = inDir(dir, () => strictReport("memory/wiki"));
  assert.match(backdatedAttestation.out.join("\n"), /^memory\/wiki\/top\.md /);

  writeFileSync(top, readFileSync(top, "utf8").replace("2026-07-21", "2026-07-23"));
  const proposedNestedAttestation = inDir(dir, () => strictReport("memory/wiki"));
  assert.deepEqual(proposedNestedAttestation.out, ["wiki-stale ok"]);
  commitAll(dir, "attest top", "2026-07-23T09:00:00Z");

  const committedNestedAttestation = inDir(dir, () => strictReport("memory/wiki"));
  assert.deepEqual(committedNestedAttestation.out, ["wiki-stale ok"]);
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

test("wiki stale ignores substantive edits discarded by a metadata-only merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-stale-discarded-merge-"));
  const source = join(dir, "memory", "wiki", "source.md");
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "memory", "wiki"), { recursive: true });
  writeFileSync(
    source,
    "---\ntitle: Source\ntype: wiki\nstatus: active\nupdated: 2026-07-21\ntags: [topic]\nsources:\n  - docs/input.md\n---\n\n# Source\n\nBaseline.\n",
  );
  writeFileSync(join(dir, "docs", "input.md"), "# Input\n");
  writeFileSync(
    join(dir, "memory", "wiki", "dependent.md"),
    "---\ntitle: Dependent\ntype: wiki\nstatus: active\nupdated: 2026-07-21\ntags: [topic]\nsources:\n  - memory/wiki/source.md\n---\n\n# Dependent\n\nBaseline.\n",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  commitAll(dir, "baseline", "2026-07-21T08:00:00Z");

  execFileSync("git", ["checkout", "-qb", "discarded-change"], { cwd: dir });
  writeFileSync(source, readFileSync(source, "utf8").replace("Baseline.", "Discarded."));
  commitAll(dir, "change source on branch", "2026-07-30T08:00:00Z");

  execFileSync("git", ["checkout", "-q", "main"], { cwd: dir });
  writeFileSync(source, readFileSync(source, "utf8").replace("2026-07-21", "2026-07-22"));
  commitAll(dir, "attest source on main", "2026-07-22T08:00:00Z");

  execFileSync("git", ["merge", "--no-ff", "--no-commit", "discarded-change"], {
    cwd: dir,
    stdio: "pipe",
  });
  writeFileSync(
    source,
    readFileSync(source, "utf8")
      .replace("2026-07-22", "2026-07-23")
      .replace("Discarded.", "Baseline."),
  );
  commitAll(dir, "merge without branch content", "2026-07-31T08:00:00Z");

  const result = inDir(dir, () => strictReport("memory/wiki"));
  assert.deepEqual(result.out, ["wiki-stale ok"]);
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

test("wiki stale detects untracked and staged-new source files", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-stale-new-source-"));
  const source = join(dir, "docs", "new.md");
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "memory", "wiki"), { recursive: true });
  writeFileSync(
    join(dir, "memory", "wiki", "topic.md"),
    "---\ntitle: Topic\ntype: wiki\nstatus: active\nupdated: 2026-07-21\ntags: [topic]\nsources:\n  - docs/new.md\n---\n\n# Topic\n",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  commitAll(dir, "page before source", "2026-07-21T08:00:00Z");

  writeFileSync(source, "# New source\n");
  const untracked = inDir(dir, () => strictReport("memory/wiki"));
  assert.match(untracked.out.join("\n"), /docs\/new\.md \(working tree; uncommitted\)/);

  execFileSync("git", ["add", "docs/new.md"], { cwd: dir });
  const staged = inDir(dir, () => strictReport("memory/wiki"));
  assert.match(staged.out.join("\n"), /docs\/new\.md \(working tree; uncommitted\)/);
});

test("wiki stale rejects source paths outside the workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-stale-path-"));
  mkdirSync(join(dir, "memory", "wiki"), { recursive: true });
  writeFileSync(
    join(dir, "memory", "wiki", "topic.md"),
    "---\ntitle: Topic\ntype: wiki\nstatus: active\nupdated: 2026-07-21\ntags: [topic]\nsources:\n  - ../outside.md\n---\n\n# Topic\n",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  commitAll(dir, "page with unsafe source", "2026-07-21T08:00:00Z");

  const result = inDir(dir, () => strictReport("memory/wiki"));
  assert.equal(result.fatal, "wiki source must stay inside the workspace");
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

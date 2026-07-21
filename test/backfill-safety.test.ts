import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "vite-plus/test";
import { wikiBackfill } from "../src/checks/wikiBackfill.ts";

function scratch(prefix = "backfill-safety-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "AGENTS.md"), "# Agents\n");
  return dir;
}

function inDir<T>(dir: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

test("backfill canonicalizes wiki.root and excludes its generated pages", () => {
  const dir = scratch();
  mkdirSync(join(dir, "memory", "archive"), { recursive: true });
  writeFileSync(join(dir, "memory", "2026-07-20.md"), "# Direct daily log\n");
  writeFileSync(join(dir, "memory", "archive", "2026-07-19.md"), "# Nested archive\n");

  const first = inDir(dir, () => wikiBackfill({ root: "./memory//wiki/", dryRun: false }));
  const second = inDir(dir, () => wikiBackfill({ root: "./memory//wiki/", dryRun: false }));
  assert.deepEqual(first.out, ["backfilled 2 sources, 2 tags (0 materialized pages)"]);
  assert.deepEqual(second.out, first.out);

  const catalog = readFileSync(join(dir, "memory", "wiki", "sources", "index.md"), "utf8");
  assert.match(catalog, /memory\/2026-07-20\.md/);
  assert.doesNotMatch(catalog, /memory\/archive\/2026-07-19\.md/);
  assert.doesNotMatch(catalog, /^\s+- memory\/wiki\//m);
});

test("backfill rejects a symlink in a source scan before writing", () => {
  const dir = scratch();
  const outside = mkdtempSync(join(tmpdir(), "backfill-source-outside-"));
  writeFileSync(join(outside, "leak.md"), "# Outside\n");
  mkdirSync(join(dir, "docs"));
  symlinkSync(join(outside, "leak.md"), join(dir, "docs", "leak.md"));

  assert.throws(
    () => inDir(dir, () => wikiBackfill({ root: "memory/wiki", dryRun: false })),
    /docs\/leak\.md: symbolic links are not allowed/,
  );
  assert.equal(existsSync(join(dir, "memory", "wiki", "sources", "index.md")), false);
});

test("backfill rejects a symlinked output root", () => {
  const dir = scratch();
  const outside = mkdtempSync(join(tmpdir(), "backfill-output-outside-"));
  mkdirSync(join(dir, "memory"));
  symlinkSync(outside, join(dir, "memory", "wiki"), "dir");

  assert.throws(
    () => inDir(dir, () => wikiBackfill({ root: "memory/wiki", dryRun: false })),
    /memory\/wiki: symbolic-link parent is not allowed/,
  );
  assert.equal(existsSync(join(outside, "sources", "index.md")), false);
});

test("backfill preflights purge candidates before any write", () => {
  const dir = scratch();
  inDir(dir, () => wikiBackfill({ root: "memory/wiki", dryRun: false }));
  const catalog = join(dir, "memory", "wiki", "sources", "index.md");
  writeFileSync(catalog, "sentinel\n");
  const stale = join(dir, "memory", "wiki", "tags", "stale.md");
  mkdirSync(stale);

  assert.throws(
    () => inDir(dir, () => wikiBackfill({ root: "memory/wiki", dryRun: false })),
    /memory\/wiki\/tags\/stale\.md: expected a regular file/,
  );
  assert.equal(readFileSync(catalog, "utf8"), "sentinel\n");
  assert.equal(lstatSync(stale).isDirectory(), true);
});

test("backfill rejects an escaping configured root", () => {
  const dir = scratch();
  const outside = mkdtempSync(join(tmpdir(), "backfill-escape-outside-"));

  assert.throws(
    () => inDir(dir, () => wikiBackfill({ root: `../${basename(outside)}`, dryRun: false })),
    /wiki\.root must stay inside the workspace/,
  );
  assert.equal(existsSync(join(outside, "sources", "index.md")), false);
});

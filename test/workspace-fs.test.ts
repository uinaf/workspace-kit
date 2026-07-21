import assert from "node:assert/strict";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { initWorkspace } from "../src/init.ts";
import { normalizeLinkTarget, normalizeWorkspacePath } from "../src/lib/workspaceFs.ts";

test("workspace paths use portable repository-relative semantics", () => {
  assert.equal(normalizeWorkspacePath("./memory//wiki/"), "memory/wiki");
  for (const path of [
    "../x",
    "..\\x",
    "/x",
    "\\x",
    "C:\\x",
    "C:/x",
    "C:x",
    "\\\\server\\share",
    "//server/share",
    "bad\0path",
  ]) {
    assert.throws(() => normalizeWorkspacePath(path), /inside the workspace|repository-relative/);
  }
  for (const path of [".. /outside", "safe./file", "safe /file", "safe/.../file"]) {
    assert.throws(() => normalizeWorkspacePath(path), /ending in a space or period/);
  }
});

test("link targets may traverse only within the workspace", () => {
  assert.equal(normalizeLinkTarget("sub/CLAUDE.md", "../AGENTS.md"), "../AGENTS.md");
  assert.throws(() => normalizeLinkTarget("CLAUDE.md", "../outside"), /inside the workspace/);
  assert.throws(
    () => normalizeLinkTarget("sub/CLAUDE.md", "../../outside"),
    /inside the workspace/,
  );
  assert.throws(() => normalizeLinkTarget("CLAUDE.md", "C:\\outside"), /inside the workspace/);
  for (const target of [".. /outside", "safe./file", "safe /file", "safe/.../file"]) {
    assert.throws(
      () => normalizeLinkTarget("nested/CLAUDE.md", target),
      /ending in a space or period/,
    );
  }
});

test("init refuses an escaping intermediate symlink", () => {
  const workspace = mkdtempSync(join(tmpdir(), "init-contained-"));
  const outside = mkdtempSync(join(tmpdir(), "init-outside-"));
  symlinkSync(outside, join(workspace, "docs"));

  assert.throws(() => initWorkspace(workspace, "work"), /docs: symbolic-link parent/);
  assert.equal(existsSync(join(outside, "README.md")), false);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { initWorkspace } from "../src/init.ts";
import { writeWorkspaceText } from "../src/lib/workspaceFs.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

function kit(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

function scaffold(profile: "personal" | "work" = "work"): string {
  const dir = mkdtempSync(join(tmpdir(), "workspace-boundary-"));
  initWorkspace(dir, profile);
  return dir;
}

test("links fix validates every rule before mutating", () => {
  const parent = mkdtempSync(join(tmpdir(), "link-boundary-"));
  const dir = join(parent, "workspace");
  mkdirSync(dir);
  initWorkspace(dir, "work");
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  config.links = [
    { path: "CLAUDE.md", target: "docs/README.md" },
    { path: "../escaped-link", target: "AGENTS.md" },
  ];
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));

  const result = kit(dir, "links", "fix");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /links\[1\]\.path must stay inside the workspace/);
  assert.equal(readlinkSync(join(dir, "CLAUDE.md")), "AGENTS.md");
  assert.equal(existsSync(join(parent, "escaped-link")), false);
});

test("links fix rejects portable case-folded path collisions before mutating", () => {
  const dir = scaffold();
  symlinkSync("AGENTS.md", join(dir, "S.md"));
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  config.links = [
    { path: "S.md", target: "docs/README.md" },
    { path: "ſ.md", target: "AGENTS.md" },
  ];
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));

  const result = kit(dir, "links", "fix");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /links\[1\]\.path duplicates links\[0\]\.path/);
  assert.equal(readlinkSync(join(dir, "S.md")), "AGENTS.md");
});

test("links fix rejects targets reached through symlinked directories", () => {
  const dir = scaffold();
  const outside = mkdtempSync(join(tmpdir(), "link-target-outside-"));
  writeFileSync(join(outside, "AGENTS.md"), "# Outside\n");
  symlinkSync(outside, join(dir, "external"));
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  config.links.push({ path: "EXTERNAL.md", target: "external/AGENTS.md" });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));

  const result = kit(dir, "links", "fix");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /external: symbolic-link parent is not allowed/);
  assert.equal(existsSync(join(dir, "EXTERNAL.md")), false);
});

test("links fix rejects missing self-referential targets before mutation", () => {
  const dir = scaffold();
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  config.links.push({ path: "SELF.md", target: "SELF.md" });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));

  const result = kit(dir, "links", "fix");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SELF\.md: link target would create a cycle/);
  assert.equal(existsSync(join(dir, "SELF.md")), false);
});

test("links fix rejects directory links back to an ancestor", () => {
  const dir = scaffold();
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  config.links.push({ path: "a/b/loop", target: ".." });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));

  const result = kit(dir, "links", "fix");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /a: link target would create a cycle/);
  assert.equal(existsSync(join(dir, "a", "b", "loop")), false);
});

test("doctor treats a dangling required symlink as missing", () => {
  const dir = scaffold();
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  config.required = ["CLAUDE.md"];
  rmSync(join(dir, "AGENTS.md"));
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));

  const result = kit(dir, "doctor", "--json");
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.errors.includes("missing CLAUDE.md"));
});

test("workspace writes replace hard links without mutating the outside inode", () => {
  const dir = scaffold();
  const outside = mkdtempSync(join(tmpdir(), "hard-link-outside-"));
  const outsideFile = join(outside, "shared.md");
  writeFileSync(outsideFile, "outside\n");
  linkSync(outsideFile, join(dir, "generated.md"));

  writeWorkspaceText(dir, "generated.md", "inside\n");

  assert.equal(readFileSync(outsideFile, "utf8"), "outside\n");
  assert.equal(readFileSync(join(dir, "generated.md"), "utf8"), "inside\n");
});

test("workspace writes support existing filenames near the filesystem limit", () => {
  const dir = scaffold();
  const name = `${"x".repeat(240)}.md`;
  writeFileSync(join(dir, name), "before\n");

  writeWorkspaceText(dir, name, "after\n");

  assert.equal(readFileSync(join(dir, name), "utf8"), "after\n");
});

test("workspace writes preserve read-only output protection", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const dir = scaffold();
  const path = join(dir, "read-only.md");
  writeFileSync(path, "protected\n");
  chmodSync(path, 0o444);

  assert.throws(() => writeWorkspaceText(dir, "read-only.md", "replaced\n"), /EACCES|EPERM/);
  assert.equal(readFileSync(path, "utf8"), "protected\n");
  assert.equal(statSync(path).mode & 0o777, 0o444);
});

test("doctor operational failures preserve the JSON contract", () => {
  const dir = scaffold("personal");
  const outside = mkdtempSync(join(tmpdir(), "doctor-outside-"));
  symlinkSync(outside, join(dir, "memory", "contexts"));

  const result = kit(dir, "doctor", "--json");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "fail");
  assert.equal(payload.failed, 1);
  assert.equal(payload.warnings, 0);
  assert.deepEqual(payload.checks, {});
  assert.equal(payload.errors.length, 1);
  assert.match(payload.errors[0], /memory\/contexts: symbolic links are not allowed/);

  const plain = kit(dir, "doctor");
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /memory\/contexts: symbolic links are not allowed/);
  assert.doesNotMatch(plain.stderr, /\n\s+at /);
});

test("configuration is never read through a workspace symlink", () => {
  const dir = scaffold();
  const outside = mkdtempSync(join(tmpdir(), "config-outside-"));
  const planted = join(outside, "workspace.json");
  writeFileSync(planted, '{"required":["outside-only-marker"]}\n');
  rmSync(join(dir, "workspace.json"));
  symlinkSync(planted, join(dir, "workspace.json"));

  const result = kit(dir, "doctor", "--json");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.match(payload.errors[0], /workspace\.json: symbolic-link file is not allowed/);
  assert.doesNotMatch(result.stdout, /outside-only-marker/);
});

test("wiki scans reject symlinks instead of following them", () => {
  const dir = scaffold("personal");
  const outside = mkdtempSync(join(tmpdir(), "wiki-outside-"));
  const secret = join(outside, "secret.md");
  writeFileSync(secret, "# outside-only-marker\n");
  symlinkSync(secret, join(dir, "memory", "wiki", "outside.md"));

  const result = kit(dir, "wiki", "lint");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside\.md: symbolic links are not allowed/);
  assert.doesNotMatch(result.stderr, /outside-only-marker/);
});

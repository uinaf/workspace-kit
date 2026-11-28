import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp, limitWarnings } from "../src/checks/limits.ts";
import { initWorkspace } from "../src/init.ts";
import { tempDir } from "./temp-dir.ts";

const root = join(import.meta.dirname, "..");
const cli = join(root, "src", "cli.ts");

function inDir<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

test("glob matcher handles segment wildcards and date shapes", () => {
  assert.ok(globToRegExp("memory/????-??-??.md").test("memory/2026-01-02.md"));
  assert.ok(!globToRegExp("memory/????-??-??.md").test("memory/contexts/x/2026-01-02.md"));
  assert.ok(
    globToRegExp("memory/contexts/*/????-??-??.md").test("memory/contexts/demo/2026-01-02.md"),
  );
  assert.ok(globToRegExp("**/*.md").test("a/b/c.md"));
  assert.ok(!globToRegExp("MEMORY.md").test("SUBMEMORY.md"));
});

test("limits: warnings for oversized tracked files, silence under the limit", () => {
  const dir = tempDir("limits-");
  execSync("git init -q", { cwd: dir });
  writeFileSync(join(dir, "MEMORY.md"), `# M\n${"line\n".repeat(10)}`);
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, "memory", "2026-01-02.md"), `# D\n${"line\n".repeat(90)}`);
  execSync("git add -A && git -c user.email=f@example.com -c user.name=F commit -qm x", {
    cwd: dir,
  });
  const warnings = inDir(dir, () =>
    limitWarnings([
      { pattern: "MEMORY.md", maxLines: 200 },
      { pattern: "memory/????-??-??.md", maxLines: 80 },
    ]),
  );
  assert.equal(warnings.length, 1, warnings.join("; "));
  assert.match(warnings[0]!, /memory\/2026-01-02\.md: 91 lines exceeds soft limit 80/);
});

test("doctor counts limit warnings without failing, and limits command works", () => {
  const dir = tempDir("softdoc-");
  initWorkspace(dir, "work");
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  config.limits = [{ pattern: "docs/README.md", maxLines: 1 }];
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));
  execSync(
    "git init -q && git add -A && git -c user.email=f@example.com -c user.name=F commit -qm x",
    {
      cwd: dir,
    },
  );
  const doctor = spawnSync(process.execPath, [cli, "doctor", "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  const payload = JSON.parse(doctor.stdout);
  assert.equal(payload.status, "pass");
  assert.equal(payload.warnings, 1);

  const limits = spawnSync(process.execPath, [cli, "limits"], { cwd: dir, encoding: "utf8" });
  assert.equal(limits.status, 0);
  assert.match(limits.stderr, /exceeds soft limit 1/);
});

for (const shape of ["missing", "directory", "symlink-parent"] as const) {
  test(`soft limits keep unreadable tracked files nonfatal (${shape})`, () => {
    const dir = tempDir("soft-limits-");
    execSync("git init -q", { cwd: dir });
    writeFileSync(
      join(dir, "workspace.json"),
      JSON.stringify({ limits: [{ pattern: "notes/*.md", maxLines: 1 }] }),
    );
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "a.md"), "short\n");
    writeFileSync(join(dir, "notes", "z.md"), "one\ntwo\n");
    execSync("git add -A", { cwd: dir });
    rmSync(join(dir, "notes", "a.md"));
    if (shape === "directory") mkdirSync(join(dir, "notes", "a.md"));
    if (shape === "symlink-parent") {
      rmSync(join(dir, "notes"), { recursive: true });
      const outside = tempDir("soft-limits-outside-");
      writeFileSync(join(outside, "a.md"), "outside\n".repeat(10));
      symlinkSync(outside, join(dir, "notes"));
    }

    const limits = spawnSync(process.execPath, [cli, "limits"], { cwd: dir, encoding: "utf8" });
    assert.equal(limits.status, 0, limits.stderr);
    assert.match(limits.stderr, /warning: could not check soft limit for notes\/a\.md/);
    if (shape === "symlink-parent") {
      assert.match(limits.stderr, /symbolic-link parent is not allowed/);
      assert.doesNotMatch(limits.stderr, /10 lines exceeds/);
    } else {
      assert.match(limits.stderr, /notes\/z\.md: 2 lines exceeds soft limit 1/);
    }
    for (const command of ["doctor", "verify"]) {
      const result = spawnSync(process.execPath, [cli, command, "--json"], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "pass");
      assert.equal(payload.warnings, 2);
    }
  });
}

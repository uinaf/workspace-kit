// The opt-in llm-wiki enforcement checks: index-as-catalog coverage,
// append-only log chronology, configurable required frontmatter, and soft
// size-limit warnings. They default off to preserve golden parity.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { wikiLintErrors } from "../src/checks/wikiLint.ts";
import { globToRegExp, limitWarnings } from "../src/checks/limits.ts";
import { initWorkspace } from "../src/init.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

function page(title: string, extra = "", body = ""): string {
  return `---\ntitle: ${title}\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: [demo]\nsources: [wiki/index.md]\n${extra}---\n\n# ${title}\n\n${body}`;
}

function makeWiki(): string {
  const dir = mkdtempSync(join(tmpdir(), "kwiki-"));
  mkdirSync(join(dir, "wiki", "topics"), { recursive: true });
  writeFileSync(join(dir, "wiki", "index.md"), page("Index", "", "- [[alpha]]\n"));
  writeFileSync(
    join(dir, "wiki", "log.md"),
    page("Log", "", "## [2026-01-01] seed | first\n\n## [2026-01-02] seed | second\n"),
  );
  writeFileSync(join(dir, "wiki", "schema.md"), page("Schema"));
  // alpha is cataloged in the index; beta is only linked from alpha.
  writeFileSync(join(dir, "wiki", "topics", "alpha.md"), page("Alpha", "", "See [[beta]].\n"));
  writeFileSync(join(dir, "wiki", "topics", "beta.md"), page("Beta"));
  return dir;
}

function inDir<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

test("indexCoverage: reachable-but-uncataloged pages fail only when enabled", () => {
  const dir = makeWiki();
  const relaxed = inDir(dir, () => wikiLintErrors({ root: "wiki" }));
  assert.deepEqual(relaxed.errors, [], relaxed.errors.join("; "));
  const strict = inDir(dir, () => wikiLintErrors({ root: "wiki", indexCoverage: true }));
  assert.ok(
    strict.errors.includes("wiki/topics/beta.md: not cataloged in wiki/index.md"),
    strict.errors.join("; "),
  );
  assert.ok(!strict.errors.some((e) => e.includes("alpha.md: not cataloged")));
});

test("logChronology: decreasing dates fail only when enabled", () => {
  const dir = makeWiki();
  writeFileSync(
    join(dir, "wiki", "log.md"),
    page("Log", "", "## [2026-01-05] seed | later\n\n## [2026-01-02] seed | earlier\n"),
  );
  const relaxed = inDir(dir, () => wikiLintErrors({ root: "wiki" }));
  assert.deepEqual(relaxed.errors, []);
  const strict = inDir(dir, () => wikiLintErrors({ root: "wiki", logChronology: true }));
  assert.ok(
    strict.errors.includes(
      "wiki/log.md: log entries out of chronological order (2026-01-02 after 2026-01-05)",
    ),
    strict.errors.join("; "),
  );
});

test("requiredFields: adding created flags pages missing it", () => {
  const dir = makeWiki();
  const fields = ["title", "type", "status", "updated", "tags", "sources", "created"];
  const result = inDir(dir, () => wikiLintErrors({ root: "wiki", requiredFields: fields }));
  assert.ok(
    result.errors.includes("wiki/index.md: missing frontmatter field created"),
    result.errors.join("; "),
  );
});

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
  const dir = mkdtempSync(join(tmpdir(), "limits-"));
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
  const dir = mkdtempSync(join(tmpdir(), "softdoc-"));
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
    const dir = mkdtempSync(join(tmpdir(), "soft-limits-"));
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
      const outside = mkdtempSync(join(tmpdir(), "soft-limits-outside-"));
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

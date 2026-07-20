// Coverage for the kit-only v1 surfaces plus regressions for the
// pre-release adversarial-review findings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initWorkspace } from "../src/init.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

function kit(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

function scaffold(profile: "personal" | "work" = "personal"): string {
  const dir = mkdtempSync(join(tmpdir(), `cli-${profile}-`));
  initWorkspace(dir, profile);
  execSync("git init -q", { cwd: dir });
  return dir;
}

function commitAll(dir: string): void {
  execSync("git add -A && git -c user.email=f@example.com -c user.name=F commit -qm x", {
    cwd: dir,
  });
}

test("wiki backfill runs green on the kit's own scaffold (P0 regression)", () => {
  const dir = scaffold("personal");
  const result = kit(dir, "wiki", "backfill");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, "memory", "wiki", "sources", "index.md")));
});

test("wiki backfill honors a configured wiki.root", () => {
  const dir = scaffold("personal");
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  config.wiki = { root: "notes/wiki" };
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));
  mkdirSync(join(dir, "notes", "wiki"), { recursive: true });
  const result = kit(dir, "wiki", "backfill");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, "notes", "wiki", "sources", "index.md")));
  assert.ok(!existsSync(join(dir, "memory", "wiki", "sources")), "must not write memory/wiki");
});

test("wiki stale reports a missing root cleanly", () => {
  const dir = scaffold("personal");
  rmSync(join(dir, "memory", "wiki"), { recursive: true });
  const result = kit(dir, "wiki", "stale");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing memory\/wiki/);
});

test("contract handoff works without a contract section and blocks ./ paths", () => {
  const dir = scaffold("personal"); // personal profile has handoff, no contract
  const blocked = kit(dir, "contract", "handoff", "./MEMORY.md");
  assert.equal(blocked.status, 1, "dot-slash bypass must be blocked");
  assert.match(blocked.stderr, /owner-private handoff path: \.\/MEMORY\.md/);
  const doubled = kit(dir, "contract", "handoff", "memory//x.md");
  assert.equal(doubled.status, 1, "doubled-slash bypass must be blocked");
  const envrc = kit(dir, "contract", "handoff", ".envrc");
  assert.equal(envrc.status, 1, ".env* basenames must be blocked");
  const ok = kit(dir, "contract", "handoff", "scripts/example.ts");
  assert.equal(ok.status, 0, ok.stderr);
});

test("docs links: broken, title-syntax, malformed-escape, and untracked targets", () => {
  const dir = scaffold("work");
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  config.docsLinks = { enabled: true };
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n\nSee [readme](../AGENTS.md).\n");
  commitAll(dir);
  assert.equal(kit(dir, "docs", "links").status, 0);

  // CommonMark title syntax must not be a false positive.
  writeFileSync(
    join(dir, "docs", "guide.md"),
    '# Guide\n\nSee [readme](../AGENTS.md "The Guide").\n',
  );
  commitAll(dir);
  assert.equal(kit(dir, "docs", "links").status, 0);

  // Malformed percent-escape must be a broken link, not a crash.
  writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n\nSee [x](%zz) and [y](gone.md).\n");
  commitAll(dir);
  const broken = kit(dir, "docs", "links");
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /broken link \(%zz\)/);
  assert.match(broken.stderr, /broken link \(gone\.md\)/);

  // Gitignored-but-present targets are broken for consumers of the repo.
  writeFileSync(join(dir, ".gitignore"), "tmp/\n");
  mkdirSync(join(dir, "tmp"), { recursive: true });
  writeFileSync(join(dir, "tmp", "local.md"), "# Local\n");
  writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n\nSee [local](../tmp/local.md).\n");
  commitAll(dir);
  assert.equal(kit(dir, "docs", "links").status, 1, "gitignored target must be broken");
});

test("config validate: minVersion gate, format, unknown keys, boolean enabled", () => {
  const dir = scaffold("work");
  assert.equal(kit(dir, "config", "validate").status, 0);

  const write = (mutate: (config: Record<string, unknown>) => void) => {
    const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
    mutate(config);
    writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));
  };

  write((c) => {
    c.minVersion = "9.9.9";
  });
  const gated = kit(dir, "config", "validate");
  assert.equal(gated.status, 1);
  assert.match(gated.stderr, /requires workspace-kit >= 9\.9\.9/);

  write((c) => {
    c.minVersion = "not-a-version";
  });
  assert.match(kit(dir, "config", "validate").stderr, /minVersion must be a semver version/);

  write((c) => {
    c.minVersion = "0.1.0";
    (c as Record<string, unknown>).requird = ["typo"];
  });
  const warned = kit(dir, "config", "validate");
  assert.equal(warned.status, 0);
  assert.match(warned.stderr, /unrecognized key requird/);

  write((c) => {
    delete (c as Record<string, unknown>).requird;
    c.docsLinks = { enabled: "true" };
  });
  assert.match(kit(dir, "config", "validate").stderr, /docsLinks\.enabled must be a boolean/);
});

test("doctor --json carries errors and always emits JSON", () => {
  const dir = scaffold("work");
  const pass = kit(dir, "doctor", "--json");
  assert.equal(pass.status, 0);
  const passPayload = JSON.parse(pass.stdout);
  assert.equal(passPayload.status, "pass");
  assert.deepEqual(passPayload.errors, []);

  rmSync(join(dir, "docs", "README.md"));
  const fail = kit(dir, "doctor", "--json");
  assert.equal(fail.status, 1);
  const failPayload = JSON.parse(fail.stdout);
  assert.equal(failPayload.status, "fail");
  assert.ok(failPayload.errors.includes("missing docs/README.md"));

  rmSync(join(dir, "workspace.json"));
  const noConfig = kit(dir, "doctor", "--json");
  assert.equal(noConfig.status, 1);
  assert.equal(JSON.parse(noConfig.stdout).status, "fail");
});

test("links check and fix, including refusal and subdirectory creation", () => {
  const dir = scaffold("work");
  assert.equal(kit(dir, "links", "check").status, 0);

  rmSync(join(dir, "CLAUDE.md"));
  symlinkSync("README.md", join(dir, "CLAUDE.md"));
  assert.equal(kit(dir, "links", "check").status, 1);
  const fixed = kit(dir, "links", "fix");
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(kit(dir, "links", "check").status, 0);

  rmSync(join(dir, "CLAUDE.md"));
  writeFileSync(join(dir, "CLAUDE.md"), "# Real file\n");
  const refused = kit(dir, "links", "fix");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to replace/);
  assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "# Real file\n");

  rmSync(join(dir, "CLAUDE.md"));
  symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  config.links.push({ path: "sub/CLAUDE.md", target: "../AGENTS.md" });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));
  const subdir = kit(dir, "links", "fix");
  assert.equal(subdir.status, 0, subdir.stderr);
  assert.ok(lstatSync(join(dir, "sub", "CLAUDE.md")).isSymbolicLink());
});

test("init refuses to write through pre-existing dangling symlinks", () => {
  const victim = mkdtempSync(join(tmpdir(), "victim-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
  const plantedTarget = join(elsewhere, "planted.json");
  symlinkSync(plantedTarget, join(victim, "workspace.json"));
  const result = initWorkspace(victim, "work");
  assert.ok(result.skipped.includes("workspace.json"));
  assert.ok(!existsSync(plantedTarget), "must not create files at the symlink target");
});

test("init --dir pointing at an existing file fails cleanly", () => {
  const parent = mkdtempSync(join(tmpdir(), "notadir-"));
  const file = join(parent, "occupied");
  writeFileSync(file, "x\n");
  const result = kit(parent, "init", "--dir", file);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a usable directory/);
});

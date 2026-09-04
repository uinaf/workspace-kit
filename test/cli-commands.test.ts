// Integration coverage for CLI surfaces outside the golden parity suite.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { initWorkspace } from "../src/init.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

function kit(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

function kitCombined(cwd: string, ...args: string[]) {
  const outputPath = join(mkdtempSync(join(tmpdir(), "cli-output-")), "combined.log");
  const output = openSync(outputPath, "w");
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    stdio: ["ignore", output, output],
  });
  closeSync(output);
  return { status: result.status, output: readFileSync(outputPath, "utf8") };
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

test("wiki backfill accepts the kit's own scaffold", () => {
  const dir = scaffold("personal");
  const result = kit(dir, "wiki", "backfill");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, "memory", "wiki", "sources", "index.md")));
  assert.match(
    readFileSync(join(dir, "memory", "wiki", "sources", "daily-log.md"), "utf8"),
    /^sources: \[\]$/m,
  );
  assert.equal(kit(dir, "wiki", "lint").status, 0);
});

test("wiki backfill honors a configured wiki.root", () => {
  const dir = scaffold("personal");
  rmSync(join(dir, "memory", "wiki", "sources"), { recursive: true });
  rmSync(join(dir, "memory", "wiki", "tags"), { recursive: true });
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  config.wiki = { root: "notes/wiki" };
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config, null, 2));
  mkdirSync(join(dir, "notes", "wiki"), { recursive: true });
  const result = kit(dir, "wiki", "backfill");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, "notes", "wiki", "sources", "index.md")));
  assert.ok(!existsSync(join(dir, "memory", "wiki", "sources")), "must not write memory/wiki");
});

test("wiki backfill --check reports drift without mutating and --dry-run stays green", () => {
  const dir = scaffold("personal");
  commitAll(dir);
  rmSync(join(dir, "memory", "wiki", "sources", "index.md"));

  const check = kit(dir, "wiki", "backfill", "--check");
  assert.equal(check.status, 1);
  assert.match(check.stdout, /would write memory\/wiki\/sources\/index\.md/);
  assert.ok(!existsSync(join(dir, "memory", "wiki", "sources", "index.md")));

  const dryRun = kit(dir, "wiki", "backfill", "--dry-run");
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(dryRun.stdout, check.stdout);

  assert.equal(kit(dir, "wiki", "backfill").status, 0);
  const clean = kit(dir, "wiki", "backfill", "--check");
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout, /^would /m);

  const staleTag = join(dir, "memory", "wiki", "tags", "orphan.md");
  writeFileSync(staleTag, "# Orphan\n");
  const deleteCheck = kit(dir, "wiki", "backfill", "--check");
  assert.equal(deleteCheck.status, 1);
  assert.match(deleteCheck.stdout, /would delete memory\/wiki\/tags\/orphan\.md/);
  assert.ok(existsSync(staleTag), "check mode must not delete stale generated pages");
});

test("help documents the wiki backfill check mode", () => {
  const dir = scaffold("work");
  const result = kit(dir, "--help");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /wiki backfill \[--dry-run\|--check\]/);
});

test("wiki stale reports a missing root cleanly", () => {
  const dir = scaffold("personal");
  rmSync(join(dir, "memory", "wiki"), { recursive: true });
  const result = kit(dir, "wiki", "stale");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing memory\/wiki/);
});

test("wiki stale fails clearly instead of reporting clean in a shallow clone", () => {
  const origin = scaffold("personal");
  const config = JSON.parse(readFileSync(join(origin, "workspace.json"), "utf8"));
  config.wiki.revisionStaleness = true;
  writeFileSync(join(origin, "workspace.json"), JSON.stringify(config, null, 2));
  commitAll(origin);
  const clone = join(mkdtempSync(join(tmpdir(), "cli-shallow-")), "workspace");
  execFileSync("git", ["clone", "-q", "--depth", "1", pathToFileURL(origin).href, clone]);

  const result = kit(clone, "wiki", "stale");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /wiki stale requires a full Git history; repository is shallow/);
  assert.doesNotMatch(result.stdout, /wiki-stale ok/);
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

test("doctor preserves check output order and authored pages still require sources", () => {
  const dir = scaffold("personal");
  const configPath = join(dir, "workspace.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.docsLinks = { enabled: true };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const indexPath = join(dir, "memory", "wiki", "index.md");
  writeFileSync(
    indexPath,
    readFileSync(indexPath, "utf8").replace("sources: [AGENTS.md]", "sources: []"),
  );

  const result = kitCombined(dir, "doctor");
  const wikiError = "memory/wiki/index.md: empty frontmatter field sources";
  const laterSuccess = "docs-links ok";
  assert.equal(result.status, 1);
  assert.ok(result.output.includes(wikiError), result.output);
  assert.ok(result.output.includes(laterSuccess), result.output);
  assert.ok(result.output.indexOf(wikiError) < result.output.indexOf(laterSuccess), result.output);
});

test("verify composes configured offline checks and emits one JSON result", () => {
  const dir = scaffold("personal");
  const pass = kit(dir, "verify", "--json");
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(pass.stderr, "");
  assert.equal(pass.stdout.trimEnd().includes("\n"), false);
  const passPayload = JSON.parse(pass.stdout);
  assert.equal(passPayload.status, "pass");
  assert.equal(passPayload.checks.config, "ok");
  assert.equal(passPayload.checks.registry, "ok");
  assert.equal(passPayload.checks.wikiBackfill, "ok");

  rmSync(join(dir, "memory", "wiki", "sources", "index.md"));
  const fail = kit(dir, "verify", "--json");
  assert.equal(fail.status, 1);
  assert.equal(fail.stderr, "");
  assert.equal(fail.stdout.trimEnd().includes("\n"), false);
  const failPayload = JSON.parse(fail.stdout);
  assert.equal(failPayload.status, "fail");
  assert.equal(failPayload.checks.wikiBackfill, "fail");
  assert.ok(failPayload.errors.includes("would write memory/wiki/sources/index.md"), fail.stdout);
});

test("verify reports registry shape errors once", () => {
  const dir = scaffold("personal");
  writeFileSync(join(dir, "projects.json"), '{"invalid":{}}\n');
  const message = "projects.json category invalid should be an array";

  const jsonResult = kit(dir, "verify", "--json");
  assert.equal(jsonResult.status, 1);
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(
    payload.errors.filter((error: string) => error === message).length,
    1,
    jsonResult.stdout,
  );

  const plainResult = kit(dir, "verify");
  assert.equal(plainResult.status, 1);
  assert.equal(plainResult.stderr.split(message).length - 1, 1, plainResult.stderr);
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
  assert.throws(
    () => initWorkspace(victim, "work"),
    /workspace.json: symbolic-link file is not allowed/,
  );
  assert.ok(lstatSync(join(victim, "workspace.json")).isSymbolicLink());
  assert.equal(existsSync(join(victim, "AGENTS.md")), false);
  assert.ok(!existsSync(plantedTarget), "must not create files at the symlink target");
});

test("init points workspace owners to the packaged bootstrap convention", () => {
  const parent = mkdtempSync(join(tmpdir(), "init-guide-"));
  const result = kit(parent, "init", "--profile", "runtime");
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /next: replace the AGENTS\.md TODOs using @uinaf\/workspace-kit\/docs\/convention\.md/,
  );
  assert.match(result.stdout, /enable the hook with: pnpm hooks:install/);
});

test("init --dir pointing at an existing file fails cleanly", () => {
  const parent = mkdtempSync(join(tmpdir(), "notadir-"));
  const file = join(parent, "occupied");
  writeFileSync(file, "x\n");
  const result = kit(parent, "init", "--dir", file);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a usable directory/);
});

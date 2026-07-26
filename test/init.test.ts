// Every init profile must produce a doctor-green workspace out of the box
// (contract deliberately deferred until an origin remote exists).
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { execSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initWorkspace } from "../src/init.ts";
import { kitVersion } from "../src/version.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

for (const profile of ["personal", "runtime", "work"] as const) {
  test(`init --profile ${profile} scaffolds a doctor-green workspace`, () => {
    const dir = mkdtempSync(join(tmpdir(), `init-${profile}-`));
    const result = initWorkspace(dir, profile);
    assert.ok(result.created.includes("AGENTS.md"));
    assert.ok(lstatSync(join(dir, "CLAUDE.md")).isSymbolicLink());
    assert.equal(readlinkSync(join(dir, "CLAUDE.md")), "AGENTS.md");

    // Scaffolded AGENTS.md is a structural skeleton, never behavioral prose.
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.match(agents, /TODO/);
    assert.match(agents, /## Skill Ownership/);
    assert.match(agents, /npm run verify/);
    const packageJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(packageJson.devDependencies["@uinaf/workspace-kit"], kitVersion());
    assert.equal(packageJson.scripts.doctor, "workspace-kit doctor");
    if (profile === "personal" || profile === "runtime") {
      assert.match(agents, /npm run registry:check/);
      const hook = readFileSync(join(dir, ".githooks", "pre-commit"), "utf8");
      assert.match(hook, /npm run verify/);
      assert.doesNotMatch(hook, /npx/);
      assert.equal(packageJson.scripts["registry:check"], "workspace-kit registry validate");

      const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")) as {
        handoff?: { prefixes?: unknown };
      };
      const prefixes = config.handoff?.prefixes;
      assert.ok(Array.isArray(prefixes));
      assert.ok(prefixes.includes("skills/"));
      if (profile === "runtime") {
        assert.ok(lstatSync(join(dir, "skills")).isDirectory());
        assert.ok(lstatSync(join(dir, ".agents", "skills")).isDirectory());
        assert.ok(lstatSync(join(dir, ".claude", "skills")).isSymbolicLink());
        assert.equal(readlinkSync(join(dir, ".claude", "skills")), "../.agents/skills");
        assert.deepEqual(JSON.parse(readFileSync(join(dir, "skills", "skills.json"), "utf8")), {
          skills: [],
        });
      }
    } else {
      assert.doesNotMatch(agents, /registry:check/);
    }

    execSync("git init -q", { cwd: dir });
    const doctor = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(
      doctor.status,
      0,
      `doctor must pass on a fresh ${profile} scaffold:\n${doctor.stderr}`,
    );
    assert.match(doctor.stdout, /doctor ok/);

    if (profile === "personal" || profile === "runtime") {
      const registry = spawnSync(process.execPath, [cli, "registry", "validate"], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(registry.status, 0, registry.stderr);
      assert.equal(registry.stdout, "registry ok\n");

      const bin = join(dir, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      const shim = join(bin, "workspace-kit");
      writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
      chmodSync(shim, 0o755);
      const hook = spawnSync(join(dir, ".githooks", "pre-commit"), [], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, npm_config_offline: "true" },
      });
      assert.equal(hook.status, 0, `${hook.stdout}${hook.stderr}`);
    }
  });

  test(`init --profile ${profile} never overwrites existing files`, () => {
    const dir = mkdtempSync(join(tmpdir(), `reinit-${profile}-`));
    initWorkspace(dir, profile);
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const second = initWorkspace(dir, profile);
    assert.equal(second.created.length, 0);
    assert.ok(second.skipped.includes("AGENTS.md"));
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), before);
  });
}

test("init reports an unusable destination with filesystem context", () => {
  const root = scratchDirectory("init-blocked-");
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "occupied\n");

  assert.throws(
    () => initWorkspace(join(blocker, "workspace"), "work"),
    /not-a-directory\/workspace is not a usable directory:/,
  );
});

test("init stops before scaffolding around an incompatible existing package", () => {
  const dir = scratchDirectory("init-existing-");
  writeFileSync(join(dir, "package.json"), '{"scripts":{"test":"custom"}}\n');

  assert.throws(
    () => initWorkspace(dir, "personal"),
    /package.json is not compatible.*existing-workspace adoption steps/,
  );
  assert.equal(existsSync(join(dir, "AGENTS.md")), false);
});

test("init explains malformed existing package metadata", () => {
  const dir = scratchDirectory("init-malformed-");
  writeFileSync(join(dir, "package.json"), "{");
  assert.throws(() => initWorkspace(dir, "work"), /package.json is not usable by init/);
});

function scratchDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

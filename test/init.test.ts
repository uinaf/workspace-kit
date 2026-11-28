// Every init profile must produce a verify-green workspace out of the box
// (contract deliberately deferred until an origin remote exists).
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { execSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { initWorkspace } from "../src/init.ts";
import { kitVersion } from "../src/version.ts";
import { tempDir } from "./temp-dir.ts";

const root = join(import.meta.dirname, "..");
const cli = join(root, "src", "cli.ts");

for (const profile of ["personal", "runtime", "work"] as const) {
  for (const wiki of [false, true]) {
    test(`init --profile ${profile} ${wiki ? "--wiki " : ""}scaffolds a verify-green workspace`, () => {
      const dir = tempDir(`init-${profile}-`);
      const result = initWorkspace(dir, profile, { wiki });
      assert.equal(existsSync(join(dir, "docs", "index.md")), wiki);
      assert.equal(existsSync(join(dir, "docs", "README.md")), !wiki);
      assert.equal(existsSync(join(dir, "memory")), false);
      assert.match(
        readFileSync(join(dir, "docs", "projects", "README.md"), "utf8"),
        /No registered projects/,
      );
      assert.ok(result.created.includes("docs/projects/README.md"));
      assert.ok(result.created.includes("AGENTS.md"));
      assert.ok(lstatSync(join(dir, "CLAUDE.md")).isSymbolicLink());
      assert.equal(readlinkSync(join(dir, "CLAUDE.md")), "AGENTS.md");

      // Scaffolded AGENTS.md is a structural skeleton, never behavioral prose.
      const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
      assert.match(agents, /TODO/);
      assert.match(agents, /## Skill Ownership/);
      assert.match(agents, /pnpm verify/);
      const packageJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
        devDependencies: Record<string, string>;
        packageManager: string;
      };
      assert.equal(packageJson.devDependencies["@uinaf/workspace-kit"], kitVersion());
      assert.equal(packageJson.scripts.doctor, "workspace-kit doctor");
      assert.equal(packageJson.scripts.test, "pnpm verify");
      assert.equal(packageJson.scripts.verify, "workspace-kit verify");
      assert.equal(packageJson.packageManager, "pnpm@12.0.0");
      assert.equal(packageJson.scripts["registry:check"], "workspace-kit registry validate");
      assert.equal(packageJson.scripts["registry:clone"], "workspace-kit registry clone");
      assert.equal(packageJson.scripts["registry:status"], "workspace-kit registry status");
      assert.equal(packageJson.scripts["registry:pull"], "workspace-kit registry pull");
      assert.equal(packageJson.scripts["registry:pointers"], "workspace-kit registry pointers");
      if (profile === "personal" || profile === "runtime") {
        const hook = readFileSync(join(dir, ".githooks", "pre-commit"), "utf8");
        assert.match(hook, /pnpm verify/);
        assert.doesNotMatch(hook, /npx/);
        assert.doesNotMatch(hook, /npm run/);
        assert.equal(packageJson.scripts["hooks:install"], "workspace-kit hooks install");

        const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")) as {
          handoff?: { prefixes?: unknown };
        };
        const prefixes = config.handoff?.prefixes;
        assert.ok(Array.isArray(prefixes));
        assert.ok(prefixes.includes("skills/"));
        assert.ok(prefixes.includes("docs/projects/"));
        assert.equal(prefixes.includes("docs/"), wiki);
        if (profile === "runtime") {
          assert.ok(lstatSync(join(dir, "skills")).isDirectory());
          assert.ok(lstatSync(join(dir, ".agents", "skills")).isDirectory());
          assert.ok(lstatSync(join(dir, ".claude", "skills")).isSymbolicLink());
          assert.equal(readlinkSync(join(dir, ".claude", "skills")), "../.agents/skills");
          assert.deepEqual(JSON.parse(readFileSync(join(dir, "skills", "skills.json"), "utf8")), {
            skills: [],
          });
        }
      }

      execSync("git init -q", { cwd: dir });
      const verify = spawnSync(process.execPath, [cli, "verify"], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(
        verify.status,
        0,
        `verify must pass on a fresh ${profile} scaffold:\n${verify.stderr}`,
      );
      assert.match(verify.stdout, /verify ok/);

      if (profile === "personal" || profile === "runtime") {
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
  }

  test(`init --profile ${profile} never overwrites existing files`, () => {
    const dir = tempDir(`reinit-${profile}-`);
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

test("init refuses a matching package that is missing the pnpm pin", () => {
  const dir = scratchDirectory("init-unpinned-");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        scripts: {
          doctor: "workspace-kit doctor",
          test: "pnpm verify",
          verify: "workspace-kit verify",
        },
        devDependencies: { "@uinaf/workspace-kit": kitVersion() },
      },
      null,
      2,
    )}\n`,
  );

  assert.throws(
    () => initWorkspace(dir, "work"),
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
  return tempDir(prefix);
}

test("init keeps the existing wiki choice and refuses malformed existing configuration", () => {
  const withWiki = scratchDirectory("init-existing-wiki-");
  initWorkspace(withWiki, "personal", { wiki: true });
  const config = readFileSync(join(withWiki, "workspace.json"), "utf8");
  assert.equal(initWorkspace(withWiki, "personal").created.length, 0);
  assert.equal(initWorkspace(withWiki, "personal", { wiki: true }).created.length, 0);
  assert.equal(readFileSync(join(withWiki, "workspace.json"), "utf8"), config);

  const without = scratchDirectory("init-existing-no-wiki-");
  writeFileSync(join(without, "workspace.json"), "{}");
  initWorkspace(without, "personal");
  assert.equal(existsSync(join(without, "docs", "index.md")), false);
  assert.throws(() => initWorkspace(without, "personal", { wiki: true }), /conflicts/);

  const invalid = scratchDirectory("init-invalid-config-");
  writeFileSync(join(invalid, "workspace.json"), '{"wiki":{"root":"../out"}}');
  assert.throws(() => initWorkspace(invalid, "personal"), /wiki.root/);
  assert.equal(existsSync(join(invalid, "AGENTS.md")), false);
  writeFileSync(join(invalid, "workspace.json"), "{");
  assert.throws(() => initWorkspace(invalid, "personal"), SyntaxError);
  assert.equal(existsSync(join(invalid, "AGENTS.md")), false);
});

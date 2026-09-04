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
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONSUMER_PACKAGE_MANAGER } from "../src/checks/packageManager.ts";
import { initWorkspace } from "../src/init.ts";
import { kitVersion } from "../src/version.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

for (const profile of ["personal", "runtime", "work"] as const) {
  test(`init --profile ${profile} scaffolds a verify-green workspace`, () => {
    const dir = mkdtempSync(join(tmpdir(), `init-${profile}-`));
    const result = initWorkspace(dir, profile);
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
    assert.equal(packageJson.packageManager, CONSUMER_PACKAGE_MANAGER);
    if (profile === "personal" || profile === "runtime") {
      const hook = readFileSync(join(dir, ".githooks", "pre-commit"), "utf8");
      assert.match(hook, /pnpm verify/);
      assert.doesNotMatch(hook, /npx/);
      assert.doesNotMatch(hook, /npm run/);
      assert.equal(packageJson.scripts["registry:check"], "workspace-kit registry validate");
      assert.equal(packageJson.scripts["registry:clone"], "workspace-kit registry clone");
      assert.equal(packageJson.scripts["registry:status"], "workspace-kit registry status");
      assert.equal(packageJson.scripts["registry:pull"], "workspace-kit registry pull");
      assert.equal(packageJson.scripts["hooks:install"], "workspace-kit hooks install");

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

test("init scaffolds a Hindsight workspace without llm-wiki artifacts", () => {
  const dir = scratchDirectory("init-hindsight-");
  initWorkspace(dir, "personal", {
    strategy: "hindsight",
    integration: "coding-agent",
    namespace: "fixture-owner/fixture-workspace",
  });

  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(config.memory, {
    strategy: "hindsight",
    integration: "coding-agent",
    namespace: "fixture-owner/fixture-workspace",
  });
  assert.equal(config.dailyLogs, undefined);
  assert.equal(config.wiki, undefined);
  assert.equal(existsSync(join(dir, "memory", "wiki")), false);
  assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /Search Hindsight knowledge pages/);

  execSync("git init -q", { cwd: dir });
  const verify = spawnSync(process.execPath, [cli, "verify"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(verify.status, 0, verify.stderr);
});

test("init validates explicit memory selections before writing", () => {
  const invalidNamespace = scratchDirectory("init-memory-namespace-");
  assert.throws(
    () =>
      initWorkspace(invalidNamespace, "personal", {
        strategy: "hindsight",
        integration: "coding-agent",
        namespace: "invalid",
      }),
    /namespace must be a Git repository path/,
  );
  assert.equal(existsSync(join(invalidNamespace, "AGENTS.md")), false);

  const workWiki = scratchDirectory("init-work-wiki-");
  assert.throws(
    () => initWorkspace(workWiki, "work", { strategy: "llm-wiki" }),
    /does not scaffold the llm-wiki memory layout/,
  );
  assert.equal(existsSync(join(workWiki, "AGENTS.md")), false);
});

function scratchDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

for (const profile of ["personal", "runtime"] as const) {
  test(`reinitializing ${profile} preserves existing Hindsight and rejects migration options`, () => {
    const dir = scratchDirectory("reinit-memory-");
    const memory = {
      strategy: "hindsight",
      integration: "coding-agent",
      namespace: "fixture-owner/workspace",
    } as const;
    initWorkspace(dir, profile, memory);
    const before = readFileSync(join(dir, "workspace.json"), "utf8");
    assert.equal(initWorkspace(dir, profile).created.length, 0);
    assert.equal(initWorkspace(dir, profile, memory).created.length, 0);
    assert.equal(existsSync(join(dir, "memory/wiki")), false);
    rmSync(join(dir, "README.md"));
    for (const requested of [
      { strategy: "llm-wiki" } as const,
      { ...memory, namespace: "fixture-owner/other" },
      { ...memory, integration: "openclaw" } as const,
    ]) {
      assert.throws(() => initWorkspace(dir, profile, requested), /conflicts with workspace.json/);
      assert.equal(existsSync(join(dir, "README.md")), false);
      assert.equal(existsSync(join(dir, "memory/wiki")), false);
      assert.equal(readFileSync(join(dir, "workspace.json"), "utf8"), before);
    }
  });
}

test("init preserves legacy or disabled memory and refuses malformed existing configuration", () => {
  const legacy = scratchDirectory("init-legacy-memory-");
  initWorkspace(legacy, "personal");
  const config = JSON.parse(readFileSync(join(legacy, "workspace.json"), "utf8"));
  delete config.memory;
  writeFileSync(join(legacy, "workspace.json"), JSON.stringify(config));
  assert.equal(initWorkspace(legacy, "personal").created.length, 0);
  assert.deepEqual(config.dailyLogs, { root: "memory", contexts: "memory/contexts" });
  assert.deepEqual(config.wiki, { root: "memory/wiki" });
  assert.equal(initWorkspace(legacy, "personal", { strategy: "llm-wiki" }).created.length, 0);
  assert.throws(
    () =>
      initWorkspace(legacy, "personal", {
        strategy: "hindsight",
        integration: "coding-agent",
        namespace: "fixture-owner/workspace",
      }),
    /conflicts with workspace.json/,
  );

  const disabled = scratchDirectory("init-disabled-memory-");
  writeFileSync(join(disabled, "workspace.json"), "{}");
  initWorkspace(disabled, "personal");
  assert.equal(existsSync(join(disabled, "memory/wiki")), false);
  assert.throws(() => initWorkspace(disabled, "personal", { strategy: "llm-wiki" }), /conflicts/);

  const invalid = scratchDirectory("init-invalid-config-");
  writeFileSync(join(invalid, "workspace.json"), '{"memory":{"strategy":"invalid"}}');
  assert.throws(() => initWorkspace(invalid, "personal"), /memory.strategy/);
  assert.equal(existsSync(join(invalid, "AGENTS.md")), false);
  writeFileSync(join(invalid, "workspace.json"), "{");
  assert.throws(() => initWorkspace(invalid, "personal"), SyntaxError);
  assert.equal(existsSync(join(invalid, "AGENTS.md")), false);
});

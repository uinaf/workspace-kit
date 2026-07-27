import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = "npm";
const scratch = mkdtempSync(join(tmpdir(), "workspace-kit-package-smoke-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: join(scratch, "npm-cache"),
      npm_config_update_notifier: "false",
    },
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  return result.stdout ?? "";
}

try {
  const archiveDir = join(scratch, "archive");
  const consumerDir = join(scratch, "consumer");
  const fixtureDir = join(scratch, "fixture-workspace");
  const stagedPackageDir = join(scratch, "package");
  mkdirSync(archiveDir);
  mkdirSync(consumerDir);

  const sourceVersion = run(
    process.execPath,
    [join(repoRoot, "src", "cli.ts"), "--version"],
    repoRoot,
  ).trim();

  cpSync(repoRoot, stagedPackageDir, {
    recursive: true,
    filter(source) {
      const topLevel = relative(repoRoot, source).split(sep)[0];
      return topLevel !== ".git" && topLevel !== "node_modules";
    },
  });
  const stagedManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  stagedManifest.version = sourceVersion;
  writeFileSync(
    join(stagedPackageDir, "package.json"),
    `${JSON.stringify(stagedManifest, null, 2)}\n`,
  );

  const packResult = JSON.parse(
    run(
      npm,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", archiveDir],
      stagedPackageDir,
    ),
  );
  const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  assert.ok(packed);
  assert.equal(packed.version, sourceVersion);
  assert.deepEqual(
    packed.files.map((file) => file.path).sort(),
    ["LICENSE", "README.md", "dist/cli.mjs", "docs/convention.md", "package.json"].sort(),
  );
  const archive = join(archiveDir, packed.filename);

  run(
    npm,
    ["install", "--offline", "--no-audit", "--no-fund", "--package-lock=false", archive],
    consumerDir,
  );

  const installedCli = join(
    consumerDir,
    "node_modules",
    "@uinaf",
    "workspace-kit",
    "dist",
    "cli.mjs",
  );
  const installedManifest = JSON.parse(
    readFileSync(
      join(consumerDir, "node_modules", "@uinaf", "workspace-kit", "package.json"),
      "utf8",
    ),
  );
  assert.equal(installedManifest.version, sourceVersion);
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(installedManifest.scripts?.[lifecycle], undefined);
  }
  const installedVersion = run(
    npm,
    ["exec", "--offline", "--", "workspace-kit", "--version"],
    consumerDir,
  ).trim();
  assert.equal(installedVersion, sourceVersion);

  run(
    npm,
    [
      "exec",
      "--offline",
      "--",
      "workspace-kit",
      "init",
      "--profile",
      "personal",
      "--dir",
      fixtureDir,
    ],
    consumerDir,
  );
  const config = JSON.parse(readFileSync(join(fixtureDir, "workspace.json"), "utf8"));
  assert.equal(config.minVersion, sourceVersion);
  assert.ok(config.registry.entry.required.includes("mode"));
  const fixturePackage = JSON.parse(readFileSync(join(fixtureDir, "package.json"), "utf8"));
  assert.equal(fixturePackage.devDependencies["@uinaf/workspace-kit"], sourceVersion);
  assert.equal(fixturePackage.scripts.verify, "workspace-kit verify");
  const hook = readFileSync(join(fixtureDir, ".githooks", "pre-commit"), "utf8");
  assert.match(hook, /npm run verify/);
  assert.doesNotMatch(hook, /npx/);
  run(process.execPath, [installedCli, "verify"], fixtureDir);
  run(process.execPath, [installedCli, "registry", "status"], fixtureDir);
  run("git", ["init", "-q"], fixtureDir);
  run(process.execPath, [installedCli, "hooks", "install"], fixtureDir);
  assert.equal(run("git", ["config", "--get", "core.hooksPath"], fixtureDir).trim(), ".githooks");
  config.skills = {};
  writeFileSync(join(fixtureDir, "workspace.json"), `${JSON.stringify(config, null, 2)}\n`);
  mkdirSync(join(fixtureDir, ".agents", "skills", "fixture-skill"), { recursive: true });
  mkdirSync(join(fixtureDir, ".claude"), { recursive: true });
  symlinkSync("../.agents/skills", join(fixtureDir, ".claude", "skills"));
  const fixtureManifest = "---\nname: fixture-skill\ndescription: Packaged smoke fixture.\n---\n";
  writeFileSync(
    join(fixtureDir, ".agents", "skills", "fixture-skill", "SKILL.md"),
    fixtureManifest,
  );
  mkdirSync(join(fixtureDir, "skills"), { recursive: true });
  writeFileSync(
    join(fixtureDir, "skills", "skills.json"),
    '{\n  "skills": [\n    {\n      "name": "fixture-skill",\n      "source": "fixture/skills"\n    }\n  ]\n}\n',
  );
  writeFileSync(
    join(fixtureDir, "skills-lock.json"),
    `${JSON.stringify(
      {
        version: 1,
        skills: {
          "fixture-skill": {
            source: "fixture/skills",
            computedHash: "dependency-owned",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, [installedCli, "skills", "check"], fixtureDir);
  run(process.execPath, [installedCli, "wiki", "backfill"], fixtureDir);
  run(process.execPath, [installedCli, "wiki", "backfill", "--check"], fixtureDir);

  console.log(`packed smoke ok (${sourceVersion})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { CONSUMER_PACKAGE_MANAGER, packageManagerErrors } from "../src/checks/packageManager.ts";
import { parseWorkspaceConfig } from "../src/config.ts";
import { initWorkspace } from "../src/init.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "package-manager-"));
}

function inDir<T>(dir: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function kit(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

test("consumer packageManager pin tracks the kit Corepack version", () => {
  const kitPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    packageManager: string;
  };
  assert.equal(CONSUMER_PACKAGE_MANAGER, kitPackage.packageManager);
});

test("package-manager check is off unless enforce is true", () => {
  assert.equal(parseWorkspaceConfig({}).packageManager, undefined);
  const parsed = parseWorkspaceConfig({ packageManager: {} });
  assert.deepEqual(parsed.packageManager, { enforce: false, allowForeignLockfiles: false });
  assert.throws(
    () => parseWorkspaceConfig({ packageManager: true }),
    /packageManager must be an object/,
  );
  assert.throws(
    () => parseWorkspaceConfig({ packageManager: { enforce: "true" } }),
    /packageManager.enforce must be a boolean/,
  );
  assert.throws(
    () => parseWorkspaceConfig({ packageManager: { allowForeignLockfiles: "true" } }),
    /packageManager.allowForeignLockfiles must be a boolean/,
  );
});

test("package-manager check requires a pnpm@ pin and rejects foreign lockfiles", () => {
  const dir = scratch();
  writeFileSync(join(dir, "package.json"), '{"private":true}\n');
  const enforced = { enforce: true, allowForeignLockfiles: false };

  assert.deepEqual(
    inDir(dir, () => packageManagerErrors(enforced)),
    ["package.json: packageManager must be a pnpm@ pin"],
  );

  writeFileSync(join(dir, "package.json"), '{"packageManager":"npm@11.16.0"}\n');
  assert.deepEqual(
    inDir(dir, () => packageManagerErrors(enforced)),
    ['package.json: packageManager must be a pnpm@ pin (got "npm@11.16.0")'],
  );

  writeFileSync(join(dir, "package.json"), '{"packageManager":"pnpm@"}\n');
  assert.deepEqual(
    inDir(dir, () => packageManagerErrors(enforced)),
    ['package.json: packageManager must be a pnpm@ pin (got "pnpm@")'],
  );

  writeFileSync(join(dir, "package.json"), '{"packageManager":"pnpm@latest"}\n');
  assert.deepEqual(
    inDir(dir, () => packageManagerErrors(enforced)),
    ['package.json: packageManager must be a pnpm@ pin (got "pnpm@latest")'],
  );

  writeFileSync(join(dir, "package.json"), '{"packageManager":"pnpm@^11.18.0"}\n');
  assert.deepEqual(
    inDir(dir, () => packageManagerErrors(enforced)),
    ['package.json: packageManager must be a pnpm@ pin (got "pnpm@^11.18.0")'],
  );

  writeFileSync(
    join(dir, "package.json"),
    `{"packageManager":"${CONSUMER_PACKAGE_MANAGER}+sha512-deadbeef"}\n`,
  );
  assert.deepEqual(
    inDir(dir, () => packageManagerErrors(enforced)),
    [],
  );

  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  writeFileSync(join(dir, "yarn.lock"), "\n");
  assert.deepEqual(
    inDir(dir, () => packageManagerErrors(enforced)),
    [
      "package-lock.json: foreign lockfile is not allowed; use pnpm-lock.yaml",
      "yarn.lock: foreign lockfile is not allowed; use pnpm-lock.yaml",
    ],
  );

  assert.deepEqual(
    inDir(dir, () => packageManagerErrors({ enforce: true, allowForeignLockfiles: true })),
    [],
  );
});

test("package-manager check reports missing and unreadable package metadata", () => {
  const dir = scratch();
  const enforced = { enforce: true, allowForeignLockfiles: false };
  assert.deepEqual(
    inDir(dir, () => packageManagerErrors(enforced)),
    ["package.json: file is missing"],
  );

  writeFileSync(join(dir, "package.json"), "{");
  assert.deepEqual(
    inDir(dir, () => packageManagerErrors(enforced)),
    ["package.json: is not valid JSON"],
  );

  const unreadable = scratch();
  mkdirSync(join(unreadable, "package.json"));
  const readErrors = inDir(unreadable, () => packageManagerErrors(enforced));
  assert.equal(readErrors.length, 1);
  assert.match(readErrors[0]!, /package\.json: could not read package metadata/);
});

test("init enables package-manager enforcement and doctor stays green", () => {
  const dir = scratch();
  initWorkspace(dir, "work");
  execSync("git init -q", { cwd: dir });
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")) as {
    packageManager?: { enforce?: boolean };
  };
  assert.deepEqual(config.packageManager, { enforce: true });

  const pass = kit(dir, "doctor", "--json");
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).checks.packageManager, "ok");

  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  const fail = kit(dir, "doctor", "--json");
  assert.equal(fail.status, 1);
  const payload = JSON.parse(fail.stdout) as {
    checks: { packageManager: string };
    errors: string[];
  };
  assert.equal(payload.checks.packageManager, "fail");
  assert.ok(
    payload.errors.includes(
      "package-lock.json: foreign lockfile is not allowed; use pnpm-lock.yaml",
    ),
  );
});

test("package-manager enforcement stays off for existing configs without the flag", () => {
  const dir = scratch();
  initWorkspace(dir, "work");
  execSync("git init -q", { cwd: dir });
  const config = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")) as Record<
    string,
    unknown
  >;
  delete config.packageManager;
  writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(dir, "package.json"), '{"packageManager":"npm@11.16.0"}\n');
  writeFileSync(join(dir, "package-lock.json"), "{}\n");

  const result = kit(dir, "doctor", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).checks.packageManager, undefined);
});

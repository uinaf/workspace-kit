// THE migration gate: the kit CLI must reproduce every legacy golden
// byte-for-byte (normalization identical to capture). Scenario definitions
// are shared with the capture script via parity/scenarios.ts, so the two
// runners cannot drift.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PARITY_EXEMPT,
  buildBase,
  makeEnv,
  normalize,
  runScenarios,
  utcToday,
  type Runner,
  type RunResult,
  type Sink,
} from "../parity/scenarios.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const parityDir = join(root, "parity");
const fixtureSrc = join(parityDir, "fixtures", "green-personal");
const legacyDir = join(parityDir, "legacy");
const goldenDir = join(parityDir, "goldens");
const workRoot = join(root, "tmp", "kit-parity-work");
const cli = join(root, "src", "cli.ts");

const today = utcToday();
const env = makeEnv();

const runner: Runner = (command, cwd) => {
  const result = spawnSync(process.execPath, [cli, ...command], { cwd, encoding: "utf8", env });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
};

function scrub(name: string, text: string, dir: string): string {
  const normalized = normalize(text, dir, workRoot, today);
  return name === "peer-check-shared" ? normalized.replace(/[0-9a-f]{40}/g, "<SHA>") : normalized;
}

function golden(file: string): string {
  return readFileSync(join(goldenDir, file), "utf8");
}

test("kit CLI reproduces every legacy golden", () => {
  const mismatches: string[] = [];

  const compare = (label: string, actual: string, expected: string) => {
    if (actual !== expected) {
      mismatches.push(`${label}:\n--- expected ---\n${expected}\n--- actual ---\n${actual}`);
    }
  };

  const sink: Sink = {
    emit(name: string, result: RunResult, dir: string): void {
      if (PARITY_EXEMPT.has(name)) {
        // Usage text is kit-owned; only the exit contract carries over.
        assert.equal(result.status, Number(golden(`${name}.exit`).trim()), name);
        assert.match(result.stderr, /usage:/, name);
        return;
      }
      compare(`${name}.out`, scrub(name, result.stdout, dir), golden(`${name}.out`));
      compare(`${name}.err`, scrub(name, result.stderr, dir), golden(`${name}.err`));
      compare(`${name}.exit`, `${result.status}\n`, golden(`${name}.exit`));
    },
  };

  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  runScenarios({ workRoot, fixtureSrc, legacyDir, runner, sink });

  assert.equal(
    mismatches.length,
    0,
    `parity mismatches (${mismatches.length}):\n\n${mismatches.join("\n\n")}`,
  );
}, 20_000);

test("doctor reports structure errors on the parity fixture", () => {
  const dir = buildBase({ workRoot, fixtureSrc, legacyDir }, "kit-structure-errors");
  rmSync(join(dir, "CONTRIBUTING.md"));
  rmSync(join(dir, "CLAUDE.md"));
  writeFileSync(join(dir, "CLAUDE.md"), "# Not a symlink\n");
  const projects = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8"));
  delete projects.examples[0].owns;
  projects.examples[1].branch = "";
  writeFileSync(join(dir, "projects.json"), `${JSON.stringify(projects, null, 2)}\n`);
  const result = runner(["doctor"], dir);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "workspace boundary ok (fixture-owner/fixture-workspace)\n");
  assert.equal(
    result.stderr,
    [
      "missing CONTRIBUTING.md",
      "CLAUDE.md should be a symlink to AGENTS.md",
      "projects.json category examples entry missing string owns",
      "projects.json category examples entry has invalid branch",
      "",
    ].join("\n"),
  );
  assert.equal(
    runner(["doctor"], buildBase({ workRoot, fixtureSrc, legacyDir }, "kit-green")).stdout,
    "workspace boundary ok (fixture-owner/fixture-workspace)\ndoctor ok\n",
  );
});

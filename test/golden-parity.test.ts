// THE migration gate: the kit CLI must reproduce every legacy golden
// byte-for-byte (normalization identical to capture). Scenario definitions
// are shared with the capture script via parity/scenarios.ts, so the two
// runners cannot drift.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PARITY_EXEMPT,
  makeEnv,
  normalize,
  runScenarios,
  snapshotTree,
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
      mismatches.push(
        `${label}:\n--- expected ---\n${expected}\n--- actual ---\n${actual}`,
      );
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
    snapshot(name: string, dir: string, subdirs: string[]): void {
      compare(`${name}.tree`, scrub(name, snapshotTree(dir, subdirs), dir), golden(`${name}.tree`));
    },
    status(name: string, dir: string, statusText: string): void {
      compare(`${name}.txt`, scrub(name, statusText, dir), golden(`${name}.txt`));
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
});

#!/usr/bin/env bun
// Regenerates parity/goldens/ by driving the frozen legacy scripts through
// the shared scenario definitions in parity/scenarios.ts.
// Local-only: requires bun and git on PATH. CI never runs legacy scripts.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  makeEnv,
  normalize,
  runScenarios,
  snapshotTree,
  utcToday,
  type Runner,
  type RunResult,
  type Sink,
} from "./scenarios.ts";

const parityDir = dirname(fileURLToPath(import.meta.url));
const fixtureSrc = join(parityDir, "fixtures", "green-personal");
const legacyDir = join(parityDir, "legacy");
const goldenDir = join(parityDir, "goldens");
const workRoot = join(parityDir, "..", "tmp", "parity-work");

const today = utcToday();
const env = makeEnv();

// Translate the kit's semantic argv into legacy bun script invocations.
function legacyArgv(command: string[]): string[] {
  const [tool, mode, ...rest] = command;
  if (tool === "doctor") return ["scripts/doctor.ts"];
  if (tool === "wiki" && mode === "lint") return ["scripts/wiki-lint.ts"];
  if (tool === "wiki" && mode === "stale") return ["scripts/wiki-stale.ts"];
  if (tool === "wiki" && mode === "backfill") return ["scripts/wiki-backfill.ts"];
  if (tool === "contract" && mode === "check") return ["scripts/workspace-contract.ts", "--check"];
  if (tool === "contract" && mode === "peer")
    return ["scripts/workspace-contract.ts", "--peer", ...rest];
  if (tool === "contract" && mode === "handoff")
    return ["scripts/workspace-contract.ts", "--handoff", ...rest];
  if (tool === "contract" && mode === undefined) return ["scripts/workspace-contract.ts"];
  throw new Error(`no legacy mapping for command: ${command.join(" ")}`);
}

const runner: Runner = (command, cwd) => {
  const result = spawnSync("bun", legacyArgv(command), { cwd, encoding: "utf8", env });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
};

function scrub(name: string, text: string, dir: string): string {
  const normalized = normalize(text, dir, workRoot, today);
  // Shared-history commit ids are deterministic but opaque; assert shape.
  return name === "peer-check-shared" ? normalized.replace(/[0-9a-f]{40}/g, "<SHA>") : normalized;
}

const sink: Sink = {
  emit(name: string, result: RunResult, dir: string): void {
    writeFileSync(join(goldenDir, `${name}.out`), scrub(name, result.stdout, dir));
    writeFileSync(join(goldenDir, `${name}.err`), scrub(name, result.stderr, dir));
    writeFileSync(join(goldenDir, `${name}.exit`), `${result.status}\n`);
  },
  snapshot(name: string, dir: string, subdirs: string[]): void {
    writeFileSync(join(goldenDir, `${name}.tree`), scrub(name, snapshotTree(dir, subdirs), dir));
  },
  status(name: string, dir: string, statusText: string): void {
    writeFileSync(join(goldenDir, `${name}.txt`), scrub(name, statusText, dir));
  },
};

rmSync(goldenDir, { recursive: true, force: true });
mkdirSync(goldenDir, { recursive: true });
mkdirSync(workRoot, { recursive: true });

runScenarios({ workRoot, fixtureSrc, legacyDir, runner, sink });

console.log("captured goldens into parity/goldens");

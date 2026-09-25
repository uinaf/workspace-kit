import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vite-plus/test";
import type { ProjectEntry } from "../src/checks/registry.ts";
import {
  cloneProjects,
  pullProjects,
  resolveProjectPath,
  statusProjects,
  type RegistryLifecycleOptions,
} from "../src/registryLifecycle.ts";

type Result = { status: number; stdout: string; stderr: string; errorCode?: string };

function entry(name: string, overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    label: `tools/${name}`,
    repo: `fixture-owner/${name}`,
    path: `~/projects/fixture-owner/${name}`,
    mode: "managed",
    ...overrides,
  };
}

function harness(home: string, worktrees: Set<string>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: string[] = [];
  let branch = "main";
  let missingGh = false;
  const run = (command: string, args: string[]): Result => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "gh") {
      return missingGh
        ? { status: 1, stdout: "", stderr: "", errorCode: "ENOENT" }
        : { status: 0, stdout: "cloned\n", stderr: "" };
    }
    const path = args[1]!;
    if (args.includes("--is-inside-work-tree")) {
      return {
        status: worktrees.has(path) ? 0 : 1,
        stdout: worktrees.has(path) ? "true\n" : "",
        stderr: "",
      };
    }
    if (args.includes("--show-current")) {
      return { status: 0, stdout: `${branch}\n`, stderr: "" };
    }
    if (args.includes("status")) return { status: 0, stdout: "## main\n", stderr: "" };
    if (args.includes("pull")) return { status: 0, stdout: "Already up to date.\n", stderr: "" };
    return { status: 1, stdout: "", stderr: "unexpected command\n" };
  };
  const options: RegistryLifecycleOptions = {
    homeDirectory: home,
    run,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  return {
    calls,
    options,
    stderr,
    stdout,
    setBranch(value: string) {
      branch = value;
    },
    setMissingGh(value: boolean) {
      missingGh = value;
    },
  };
}

test("registry clone skips existing worktrees and clones missing managed entries", () => {
  const home = mkdtempSync(join(tmpdir(), "registry-lifecycle-home-"));
  const existing = join(home, "projects", "fixture-owner", "existing");
  mkdirSync(existing, { recursive: true });
  const state = harness(home, new Set([existing]));

  const result = cloneProjects(
    [
      entry("existing"),
      entry("missing", { branch: "main" }),
      entry("route", { mode: "route-only" }),
    ],
    state.options,
  );

  assert.equal(result, 0);
  assert.match(state.stdout.join(""), /Skipping tools\/existing/);
  assert.match(state.stdout.join(""), /Cloning tools\/missing/);
  assert.ok(
    state.calls.some(
      (call) =>
        call.includes("gh repo clone fixture-owner/missing") && call.endsWith("-- --branch main"),
    ),
  );
  assert.doesNotMatch(state.calls.join("\n"), /fixture-owner\/route/);
});

test("registry clone reports a missing GitHub CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "registry-lifecycle-home-"));
  const state = harness(home, new Set());
  state.setMissingGh(true);

  assert.equal(cloneProjects([entry("missing")], state.options), 1);
  assert.equal(state.stderr.join(""), "Missing dependency: gh\n");
});

test("registry status reports present and missing managed entries but hides missing routes", () => {
  const home = mkdtempSync(join(tmpdir(), "registry-lifecycle-home-"));
  const present = join(home, "projects", "fixture-owner", "present");
  mkdirSync(present, { recursive: true });
  const state = harness(home, new Set([present]));

  const result = statusProjects(
    [entry("present"), entry("missing"), entry("route", { mode: "route-only" })],
    state.options,
  );

  assert.equal(result, 0);
  assert.match(state.stdout.join(""), /tools\/present \[managed\]/);
  assert.match(state.stdout.join(""), /## main/);
  assert.match(state.stdout.join(""), /tools\/missing \[managed\]/);
  assert.doesNotMatch(state.stdout.join(""), /tools\/route/);
});

test("registry pull enforces configured branches and skips missing checkouts", () => {
  const home = mkdtempSync(join(tmpdir(), "registry-lifecycle-home-"));
  const present = join(home, "projects", "fixture-owner", "present");
  mkdirSync(present, { recursive: true });
  const state = harness(home, new Set([present]));
  const entries = [entry("present", { branch: "main" }), entry("missing")];

  assert.equal(pullProjects(entries, state.options), 0);
  assert.ok(state.calls.some((call) => call.endsWith("pull --ff-only")));
  assert.match(state.stdout.join(""), /tools\/missing .*missing, skipping/);

  state.setBranch("other");
  assert.equal(pullProjects([entries[0]!], state.options), 1);
  assert.match(state.stderr.join(""), /expected branch main/);
});

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

function installFakeGit(pullScript: string) {
  const bin = mkdtempSync(join(tmpdir(), "registry-lifecycle-bin-"));
  const git = join(bin, "git");
  writeFileSync(
    git,
    [
      "#!/bin/sh",
      'case "$*" in',
      "  *--is-inside-work-tree*) echo true ;;",
      `  *pull*) ${pullScript} ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(git, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
}

function pullWithRealProcess() {
  const home = mkdtempSync(join(tmpdir(), "registry-lifecycle-home-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = pullProjects([entry("present")], {
    homeDirectory: home,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { status, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("registry pull relays git output larger than the default child-process buffer", () => {
  installFakeGit("head -c 2097152 /dev/zero | tr '\\0' x; echo");

  const result = pullWithRealProcess();

  assert.equal(result.stderr, "");
  assert.equal(result.status, 0);
  assert.ok(result.stdout.length > 2_097_152);
});

test("registry pull reports a git process killed by a signal", () => {
  installFakeGit("kill -TERM $$");

  const result = pullWithRealProcess();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /git -C \S+ pull --ff-only terminated by SIGTERM/);
});

test("registry path resolves an exact label and optional mode", () => {
  const home = mkdtempSync(join(tmpdir(), "registry-lifecycle-home-"));
  const entries = [entry("agents")];

  assert.equal(
    resolveProjectPath(entries, "tools/agents", "managed", { homeDirectory: home }),
    join(home, "projects", "fixture-owner", "agents"),
  );
  assert.throws(
    () => resolveProjectPath(entries, "tools/agents", "route-only", { homeDirectory: home }),
    /expected exactly one project tools\/agents with mode route-only/,
  );
});

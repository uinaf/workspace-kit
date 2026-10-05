import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "vite-plus/test";

type ExecConfig = { verifyReleaseCmd: string; prepareCmd: string };

const releaseConfig = JSON.parse(readFileSync(".releaserc.json", "utf8")) as {
  plugins: (string | [string, unknown])[];
};
const execEntry = releaseConfig.plugins.find(
  (plugin): plugin is [string, ExecConfig] =>
    Array.isArray(plugin) && plugin[0] === "@semantic-release/exec",
);
assert.ok(execEntry, ".releaserc.json configures @semantic-release/exec");
const exec = execEntry[1];

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "user.name=Fixture",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: dir, encoding: "utf8" },
  ).trim();
}

function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

// The release checkout sits on the verified commit; the github-commit plugin has
// already fetched whatever it pushed to main, and `gh` reports main's live head.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "release-handoff-"));
  git(dir, "init", "-q");
  commit(dir, { "package.json": '{"version":"1.0.0"}\n', "cli.ts": "v1\n" }, "feat: base");
  const verified = commit(dir, { "cli.ts": "v2\n" }, "fix: verified");
  const versionCommit = commit(dir, { "package.json": '{"version":"1.0.1"}\n' }, "chore(release)");
  git(dir, "switch", "-q", "--detach", verified);
  const unverified = commit(dir, { "cli.ts": "v3\n" }, "feat: pushed during the release");
  const raceVersionCommit = commit(
    dir,
    { "package.json": '{"version":"1.0.1"}\n' },
    "chore(release)",
  );
  git(dir, "switch", "-q", "--detach", verified);
  const smuggled = commit(
    dir,
    { "package.json": '{"version":"1.0.1"}\n', "cli.ts": "v4\n" },
    "chore(release)",
  );
  git(dir, "switch", "-q", "--detach", verified);

  const bin = join(dir, ".bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_MAIN"\n');
  chmodSync(join(bin, "gh"), 0o755);

  const run = (command: string, main: string) => {
    const result = spawnSync("sh", ["-c", command], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: "fixture-owner/fixture-repository",
        GITHUB_SHA: verified,
        FIXTURE_MAIN: main,
      },
    });
    return { status: result.status, head: git(dir, "rev-parse", "HEAD") };
  };
  return { verified, versionCommit, unverified, raceVersionCommit, smuggled, run };
}

test("release proceeds only while main is still the verified commit", () => {
  const { verified, unverified, run } = fixture();
  assert.equal(run(exec.verifyReleaseCmd, verified).status, 0);
  assert.notEqual(run(exec.verifyReleaseCmd, unverified).status, 0);
});

test("release switches to the version commit made on the verified commit", () => {
  const { versionCommit, run } = fixture();
  assert.deepEqual(run(exec.prepareCmd, versionCommit), { status: 0, head: versionCommit });
});

test("release stays on the verified commit when no version commit was needed", () => {
  const { verified, run } = fixture();
  assert.deepEqual(run(exec.prepareCmd, verified), { status: 0, head: verified });
});

test("release refuses a version commit that carries unverified changes", () => {
  const { verified, raceVersionCommit, smuggled, run } = fixture();
  for (const main of [raceVersionCommit, smuggled]) {
    const result = run(exec.prepareCmd, main);
    assert.notEqual(result.status, 0, main);
    assert.equal(result.head, verified, main);
  }
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
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
const fakeGh = fileURLToPath(new URL("fake-gh.ts", import.meta.url));

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

// The release checkout sits on the verified commit and `gh` talks to a bare remote through
// fake-gh.ts. `release` follows semantic-release: verifyRelease, then prepare (npm writes the
// version, then exec), then it tags HEAD and publishes the working tree.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-handoff-"));
  const remote = join(root, "remote.git");
  const dir = join(root, "checkout");
  const bin = join(root, "bin");
  const race = join(root, "race");
  mkdirSync(dir);
  mkdirSync(bin);
  git(root, "init", "-q", "--bare", remote);
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", remote);
  commit(dir, { "package.json": '{"version":"1.0.0"}\n', "cli.ts": "v1\n" }, "feat: base");
  const verified = commit(dir, { "cli.ts": "v2\n" }, "fix: verified");
  const unverified = commit(dir, { "cli.ts": "v3\n" }, "feat: pushed during the release");
  git(
    dir,
    "push",
    "-q",
    "origin",
    `${verified}:refs/heads/main`,
    `${unverified}:refs/heads/pushed`,
  );
  git(dir, "switch", "-q", "--detach", verified);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${fakeGh}" "$@"\n`);
  chmodSync(join(bin, "gh"), 0o755);

  const run = (command: string) =>
    spawnSync("sh", ["-c", command], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: "fixture-owner/fixture-repository",
        GITHUB_SHA: verified,
        FIXTURE_REMOTE: remote,
        FIXTURE_RACE: race,
      },
    }).status;
  const main = () => git(root, "--git-dir", remote, "rev-parse", "refs/heads/main");
  const setMain = (sha: string) =>
    git(root, "--git-dir", remote, "update-ref", "refs/heads/main", sha);

  const release = (version: string, options: { pushDuringRelease?: boolean } = {}) => {
    const verify = run(exec.verifyReleaseCmd);
    writeFileSync(join(dir, "package.json"), `{"version":"${version}"}\n`);
    if (options.pushDuringRelease) writeFileSync(race, unverified);
    const prepareCmd = exec.prepareCmd.replaceAll("${nextRelease.version}", version);
    assert.doesNotMatch(prepareCmd, /\$\{/);
    const prepare = run(prepareCmd);
    return {
      verify,
      prepare,
      tagged: git(dir, "rev-parse", "HEAD"),
      published: readFileSync(join(dir, "package.json"), "utf8"),
      main: main(),
    };
  };
  return { dir, verified, unverified, run, setMain, release };
}

test("release proceeds only while main is still the verified commit", () => {
  const { unverified, run, setMain } = fixture();
  assert.equal(run(exec.verifyReleaseCmd), 0);
  setMain(unverified);
  assert.notEqual(run(exec.verifyReleaseCmd), 0);
});

test("release fast-forwards main to one version commit on the verified commit and ships it", () => {
  const { dir, verified, release } = fixture();
  const result = release("1.0.1");
  assert.deepEqual([result.verify, result.prepare], [0, 0]);
  assert.equal(result.main, result.tagged);
  assert.equal(git(dir, "rev-parse", `${result.tagged}^@`), verified);
  assert.equal(git(dir, "diff", "--name-only", verified, result.tagged), "package.json");
  assert.equal(git(dir, "show", `${result.tagged}:package.json`), '{"version":"1.0.1"}');
  assert.equal(result.published, '{"version":"1.0.1"}\n');
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("release stays on the verified commit when no version commit was needed", () => {
  const { verified, release } = fixture();
  const result = release("1.0.0");
  assert.deepEqual([result.verify, result.prepare], [0, 0]);
  assert.deepEqual([result.tagged, result.main], [verified, verified]);
});

test("a push during the release leaves main untouched and stops before tagging", () => {
  const { verified, unverified, release } = fixture();
  const result = release("1.0.1", { pushDuringRelease: true });
  assert.equal(result.verify, 0);
  assert.notEqual(result.prepare, 0);
  assert.equal(result.main, unverified);
  assert.equal(result.tagged, verified);
});

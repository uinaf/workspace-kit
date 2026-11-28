import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isPrivateHandoffPath,
  loadContract,
  workspaceErrors,
  peerErrors,
} from "../src/checks/contract.ts";
import { tempDir } from "./temp-dir.ts";

const HANDOFF = {
  paths: ["AGENTS.md", "SOUL.md"],
  prefixes: ["memory/"],
};

function scratch(prefix: string): string {
  return tempDir(prefix);
}

test("handoff invariants are not configurable", () => {
  for (const path of [
    "",
    "/etc/passwd",
    "a/../b",
    ".env",
    ".ENV",
    ".env.local",
    "x/.Env.prod",
    "memory/x.md",
    "MEMORY/x.md",
    "SOUL.md",
    "soul.md",
  ]) {
    assert.equal(isPrivateHandoffPath(path, HANDOFF), true, path);
  }

  assert.equal(isPrivateHandoffPath("scripts/ok.ts", HANDOFF), false);
});

test("loadContract fails fast in field order", () => {
  const dir = scratch("contract-");
  writeFileSync(
    join(dir, "workspace.contract.json"),
    JSON.stringify({ repository: "a/b", peerRepository: "c/d" }),
  );
  assert.throws(() => loadContract(dir), /sharedAncestor must be a non-empty string/);
});

test("contract reports missing origin and non-hex ancestor", () => {
  const dir = scratch("origin-");
  execSync("git init -q", { cwd: dir });
  writeFileSync(
    join(dir, "workspace.contract.json"),
    JSON.stringify({
      repository: "a/b",
      peerRepository: "c/d",
      sharedAncestor: "not-a-sha",
      requiredOwnerPaths: [],
      forbiddenOwnerPaths: [],
    }),
  );
  const errors = workspaceErrors(dir);
  assert.ok(errors.includes("origin remote is missing"), errors.join("; "));
  assert.ok(errors.includes("sharedAncestor must be a full commit id"), errors.join("; "));
});

test("non-reciprocal peers error; different ancestors skip the history check", () => {
  const make = (repo: string, peer: string, ancestor: string): string => {
    const dir = scratch("peer-");
    execSync("git init -q -b main", { cwd: dir });
    execSync(`git remote add origin git@github.com:${repo}.git`, { cwd: dir });
    writeFileSync(
      join(dir, "workspace.contract.json"),
      JSON.stringify({
        repository: repo,
        peerRepository: peer,
        sharedAncestor: ancestor,
        requiredOwnerPaths: [],
        forbiddenOwnerPaths: [],
      }),
    );
    execSync("git add -A && git -c user.email=f@example.com -c user.name=F commit -qm x", {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    });

    return dir;
  };

  const ancestorA = "a".repeat(40);
  const ancestorB = "b".repeat(40);
  const current = make("o/current", "o/peer", ancestorA);
  const peer = make("o/peer", "o/somebody-else", ancestorB);
  const errors = peerErrors(current, peer);
  assert.ok(errors.includes("workspace contracts are not reciprocal"), errors.join("; "));
  assert.ok(
    errors.includes("workspace contracts name different shared ancestors"),
    errors.join("; "),
  );
  assert.ok(!errors.some((e) => e.startsWith("post-split history is shared")));
});

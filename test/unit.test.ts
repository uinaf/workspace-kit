// Port-time unit-test debt from parity/README.md: legacy behaviors that
// goldens cannot capture, pinned here so the port cannot silently diverge.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean, parseFrontmatter } from "../src/lib/frontmatter.ts";
import {
  isPrivateHandoffPath,
  loadContract,
  workspaceErrors,
  peerErrors,
} from "../src/checks/contract.ts";
import { wikiLintErrors } from "../src/checks/wikiLint.ts";
import { wikiBackfill } from "../src/checks/wikiBackfill.ts";

const HANDOFF = {
  paths: ["AGENTS.md", "SOUL.md"],
  prefixes: ["memory/"],
};

function inDir<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("frontmatter parser quirks are kept as-is", () => {
  // Inline arrays split on commas even inside quotes — a kept quirk.
  assert.deepEqual(parseFrontmatter('---\ntags: ["a, b"]\n---\n').tags, ["a", "b"]);
  // Single- and double-quote stripping (one char per side).
  assert.equal(clean("'hello'"), "hello");
  assert.equal(clean('"hello"'), "hello");
  // CRLF files never parse: the terminator is LF-only.
  assert.deepEqual(parseFrontmatter("---\r\ntitle: x\r\n---\r\n"), {});
  // Block lists accumulate under the current key.
  assert.deepEqual(parseFrontmatter("---\nsources:\n  - a.md\n  - b.md\n---\n").sources, [
    "a.md",
    "b.md",
  ]);
});

test("non-string updated silently skips validation (kept quirk)", () => {
  const dir = scratch("wiki-");
  mkdirSync(join(dir, "wiki"), { recursive: true });
  writeFileSync(
    join(dir, "wiki", "log.md"),
    "---\ntitle: Log\ntype: wiki-log\nstatus: active\nupdated: 2026-01-01\ntags: [log]\nsources: [wiki/log.md]\n---\n\n# Log\n",
  );
  writeFileSync(
    join(dir, "wiki", "index.md"),
    "---\ntitle: Index\ntype: wiki-index\nstatus: active\nupdated: [2026]\ntags: [index]\nsources: [wiki/index.md]\n---\n\n# Index\n",
  );
  const result = inDir(dir, () => wikiLintErrors("wiki"));
  assert.ok(
    !result.errors.some((e) => e.includes("updated must be")),
    `list-valued updated must skip validation: ${result.errors.join("; ")}`,
  );
});

test("missing wiki root is a clean fatal error", () => {
  const dir = scratch("nowiki-");
  const result = inDir(dir, () => wikiLintErrors("memory/wiki"));
  assert.equal(result.fatal, "missing memory/wiki");
});

test("missing wiki log is an error, not a crash (recorded fix)", () => {
  const dir = scratch("nolog-");
  mkdirSync(join(dir, "wiki"), { recursive: true });
  writeFileSync(
    join(dir, "wiki", "index.md"),
    "---\ntitle: Index\ntype: wiki-index\nstatus: active\nupdated: 2026-01-01\ntags: [index]\nsources: [wiki/index.md]\n---\n\n# Index\n",
  );
  const result = inDir(dir, () => wikiLintErrors("wiki"));
  assert.ok(result.errors.includes("missing wiki/log.md"), result.errors.join("; "));
});

test("handoff invariants are not configurable", () => {
  for (const path of ["", "/etc/passwd", "a/../b", ".env", ".env.local", "x/.env.prod"]) {
    assert.equal(isPrivateHandoffPath(path, HANDOFF), true, path);
  }
  assert.equal(isPrivateHandoffPath("scripts/ok.ts", HANDOFF), false);
  assert.equal(isPrivateHandoffPath("memory/x.md", HANDOFF), true);
  assert.equal(isPrivateHandoffPath("SOUL.md", HANDOFF), true);
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
  // Early return: the shared-history check must NOT have run.
  assert.ok(!errors.some((e) => e.startsWith("post-split history is shared")));
});

test("backfill cross-day idempotency: date-only diffs do not rewrite", () => {
  const dir = scratch("backfill-");
  for (const file of [
    "AGENTS.md",
    "MEMORY.md",
    "USER.md",
    "TOOLS.md",
    "SOUL.md",
    "README.md",
    "CONTRIBUTING.md",
  ]) {
    writeFileSync(join(dir, file), `# ${file}\n`);
  }
  inDir(dir, () => wikiBackfill({ root: "memory/wiki", dryRun: false }));
  // Simulate a previous-day generation: rewrite every generated updated:
  // stamp to an old date.
  const sourcesIndex = join(dir, "memory", "wiki", "sources", "index.md");
  const aged = readFileSync(sourcesIndex, "utf8").replace(
    /^updated: \d{4}-\d{2}-\d{2}$/m,
    "updated: 2000-01-01",
  );
  writeFileSync(sourcesIndex, aged);
  inDir(dir, () => wikiBackfill({ root: "memory/wiki", dryRun: false }));
  assert.equal(
    readFileSync(sourcesIndex, "utf8"),
    aged,
    "a date-only difference must not trigger a rewrite",
  );
});

test("backfill --dry-run plans without writing", () => {
  const dir = scratch("dryrun-");
  for (const file of [
    "AGENTS.md",
    "MEMORY.md",
    "USER.md",
    "TOOLS.md",
    "SOUL.md",
    "README.md",
    "CONTRIBUTING.md",
  ]) {
    writeFileSync(join(dir, file), `# ${file}\n`);
  }
  const result = inDir(dir, () => wikiBackfill({ root: "memory/wiki", dryRun: true }));
  assert.ok(result.planned.length > 0);
  assert.ok(result.planned.every((line) => line.startsWith("would ")));
  assert.throws(() => readFileSync(join(dir, "memory", "wiki", "sources", "index.md")));
});

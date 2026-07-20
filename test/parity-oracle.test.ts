import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const goldens = join(root, "parity", "goldens");
const fixture = join(root, "parity", "fixtures", "green-personal");

const greenScenarios = [
  "doctor-green",
  "wiki-lint-green",
  "contract-check-green",
  "contract-check-green-https",
  "wiki-stale-green",
  "handoff-allowed",
  "peer-check-green",
  "backfill-first-run",
  "wiki-lint-post-backfill",
  "backfill-second-run",
];

const failingScenarios = [
  "doctor-structure-errors",
  "doctor-cascade-errors",
  "wiki-lint-errors",
  "contract-check-errors",
  "contract-malformed",
  "handoff-blocked",
  "peer-check-shared",
];

test("green goldens exist and exited 0", () => {
  for (const scenario of greenScenarios) {
    const exitFile = join(goldens, `${scenario}.exit`);
    assert.ok(existsSync(exitFile), `missing golden ${scenario}.exit`);
    assert.equal(readFileSync(exitFile, "utf8").trim(), "0", scenario);
    assert.equal(readFileSync(join(goldens, `${scenario}.err`), "utf8"), "", scenario);
  }
});

test("failing goldens exist, exited 1, and carry errors", () => {
  for (const scenario of failingScenarios) {
    assert.equal(
      readFileSync(join(goldens, `${scenario}.exit`), "utf8").trim(),
      "1",
      scenario,
    );
    assert.ok(
      readFileSync(join(goldens, `${scenario}.err`), "utf8").length > 0,
      `${scenario} should capture stderr`,
    );
  }
});

test("usage error golden exits 2 with usage text", () => {
  assert.equal(
    readFileSync(join(goldens, "contract-usage-error.exit"), "utf8").trim(),
    "2",
  );
  assert.match(
    readFileSync(join(goldens, "contract-usage-error.err"), "utf8"),
    /usage:/,
  );
});

test("goldens contain no absolute or capture-day residue", () => {
  for (const scenario of [...greenScenarios, ...failingScenarios]) {
    for (const ext of [".out", ".err"]) {
      const content = readFileSync(join(goldens, `${scenario}${ext}`), "utf8");
      assert.ok(!content.includes("/Users/"), `${scenario}${ext} leaks a path`);
      assert.ok(!content.includes("/home/"), `${scenario}${ext} leaks a path`);
      assert.ok(!content.includes("\u001b"), `${scenario}${ext} contains ANSI codes`);
    }
  }
  const tree = readFileSync(join(goldens, "backfill-generated.tree"), "utf8");
  assert.ok(!tree.includes("/Users/"), "tree snapshot leaks a path");
  assert.ok(!/updated: \d{4}-\d{2}-\d{2}/.test(tree), "tree snapshot leaks capture date");
});

test("backfill idempotency golden shows an unchanged worktree", () => {
  const status = readFileSync(join(goldens, "backfill-worktree-status.txt"), "utf8");
  const lines = status.split("\n").filter(Boolean);
  assert.ok(
    lines.every((line) => line.startsWith("??") || /memory\/wiki\/(sources|tags)\//.test(line)),
    `unexpected worktree changes: ${status}`,
  );
});

test("fixture keeps its structural invariants", () => {
  assert.ok(lstatSync(join(fixture, "CLAUDE.md")).isSymbolicLink());
  assert.equal(readlinkSync(join(fixture, "CLAUDE.md")), "AGENTS.md");
  const contract = JSON.parse(
    readFileSync(join(fixture, "workspace.contract.json"), "utf8"),
  );
  assert.equal(contract.repository, "fixture-owner/fixture-workspace");
  assert.ok(contract.sharedAncestor.startsWith("PLACEHOLDER"));
});

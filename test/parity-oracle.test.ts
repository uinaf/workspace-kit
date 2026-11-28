import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const goldens = join(root, "parity", "goldens");
const fixture = join(root, "parity", "fixtures", "green-personal");

const greenScenarios = [
  "contract-check-green",
  "contract-check-green-https",
  "handoff-allowed",
  "peer-check-green",
];

const failingScenarios = [
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
    assert.equal(readFileSync(join(goldens, `${scenario}.exit`), "utf8").trim(), "1", scenario);
    assert.ok(
      readFileSync(join(goldens, `${scenario}.err`), "utf8").length > 0,
      `${scenario} should capture stderr`,
    );
  }
});

test("usage error golden exits 2 with usage text", () => {
  assert.equal(readFileSync(join(goldens, "contract-usage-error.exit"), "utf8").trim(), "2");
  assert.match(readFileSync(join(goldens, "contract-usage-error.err"), "utf8"), /usage:/);
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
});

test("fixture keeps its structural invariants", () => {
  assert.ok(lstatSync(join(fixture, "CLAUDE.md")).isSymbolicLink());
  assert.equal(readlinkSync(join(fixture, "CLAUDE.md")), "AGENTS.md");
  const contract = JSON.parse(readFileSync(join(fixture, "workspace.contract.json"), "utf8"));
  assert.equal(contract.repository, "fixture-owner/fixture-workspace");
  assert.ok(contract.sharedAncestor.startsWith("PLACEHOLDER"));
});

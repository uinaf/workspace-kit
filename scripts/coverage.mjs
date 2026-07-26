import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "workspace-kit-coverage-"));
const subprocessDirectory = join(root, "subprocess");
const unitDirectory = join(root, "unit");
const require = createRequire(import.meta.url);
const c8 = join(dirname(require.resolve("c8/package.json")), "bin", "c8.js");

try {
  const run = spawnSync(
    process.execPath,
    [
      c8,
      "--all",
      "--include=src/**/*.ts",
      "--reporter=json",
      `--reports-dir=${subprocessDirectory}`,
      "vp",
      "test",
      "run",
      "--coverage",
      "--coverage.include=src/**/*.ts",
      "--coverage.reporter=json",
      `--coverage.reportsDirectory=${unitDirectory}`,
    ],
    { stdio: "inherit" },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) {
    process.exitCode = run.status ?? 1;
  } else {
    const subprocess = readCoverage(subprocessDirectory);
    const unit = readCoverage(unitDirectory);
    let covered = 0;
    let total = 0;

    for (const file of Object.keys(unit).sort((left, right) => left.localeCompare(right))) {
      const executable = lineHits(unit[file]);
      const childHits = lineHits(subprocess[file]);
      const fileCovered = [...executable].filter(
        ([line, hit]) => hit || childHits.get(line),
      ).length;
      covered += fileCovered;
      total += executable.size;
      const relative = file.includes("/src/") ? `src/${file.split("/src/")[1]}` : file;
      console.log(`${relative} ${percentage(fileCovered, executable.size)}% lines`);
    }

    console.log("");
    const result = percentage(covered, total);
    console.log(`lines: ${result}% (${covered}/${total})`);
    if (Number(result) < 90) {
      console.error("line coverage must be at least 90%");
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

function readCoverage(directory) {
  return JSON.parse(readFileSync(join(directory, "coverage-final.json"), "utf8"));
}

function lineHits(coverage) {
  const lines = new Map();
  if (!coverage) return lines;
  for (const [id, location] of Object.entries(coverage.statementMap)) {
    const line = location.start.line;
    lines.set(line, (lines.get(line) ?? false) || coverage.s[id] > 0);
  }
  return lines;
}

function percentage(covered, total) {
  return (total === 0 ? 100 : (covered / total) * 100).toFixed(2);
}

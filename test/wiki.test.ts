import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { tempDir } from "./temp-dir.ts";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");

function kit(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

function workspace(config: Record<string, unknown> = { wiki: {} }): string {
  const dir = tempDir("wiki-");
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(config));
  mkdirSync(join(dir, "docs", "topics"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "index.md"),
    "# Index\n\n- [Alpha](alpha.md): first page\n- [[topics/beta]]: second page\n",
  );
  writeFileSync(
    join(dir, "docs", "alpha.md"),
    "# Alpha\n\nSee [[topics/beta]], [the log](log.md#top), and [site](https://example.com).\n\n`[code](nowhere.md)`\n",
  );
  writeFileSync(join(dir, "docs", "topics", "beta.md"), "# Beta\n\nBack to [[alpha|Alpha]].\n");
  writeFileSync(
    join(dir, "docs", "log.md"),
    "# Log\n\n## [2026-01-01] seed\n\n## [2026-01-01] same day\n\n## [2026-01-03] later\n",
  );
  return dir;
}

test("wiki check passes an indexed wiki with resolvable links", () => {
  const dir = workspace();
  const result = kit(dir, "wiki", "check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "wiki ok\n");
  assert.equal(kit(dir, "doctor").status, 0);
});

test("wiki check reports unlisted pages and broken links", () => {
  const dir = workspace();
  writeFileSync(join(dir, "docs", "gamma.md"), "# Gamma\n\n[gone](missing.md) and [[nowhere]]\n");
  writeFileSync(join(dir, "docs", "index.md"), "# Index\n\n- [Alpha](alpha.md)\n- [[ghost]]\n");
  const result = kit(dir, "wiki", "check");
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    [
      "docs/gamma.md: broken link (missing.md)",
      "docs/gamma.md: broken link ([[nowhere]])",
      "docs/index.md: broken link ([[ghost]])",
      "docs/index.md: missing entry for docs/gamma.md",
      "docs/index.md: missing entry for docs/topics/beta.md",
      "",
    ].join("\n"),
  );
});

test("wiki check requires dated log headings that never go backwards", () => {
  const dir = workspace();
  writeFileSync(
    join(dir, "docs", "log.md"),
    "# Log\n\n## [2026-01-05] later\n\n## [2026-01-02] earlier\n\n## missing date\n\n## [2026-02-30] impossible\n",
  );
  const result = kit(dir, "wiki", "check");
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    [
      "docs/log.md:5: 2026-01-02 is earlier than 2026-01-05",
      'docs/log.md:7: heading must be "## [YYYY-MM-DD] summary"',
      'docs/log.md:9: heading must be "## [YYYY-MM-DD] summary"',
      "",
    ].join("\n"),
  );

  rmSync(join(dir, "docs", "log.md"));
  writeFileSync(join(dir, "docs", "alpha.md"), "# Alpha\n");
  assert.equal(kit(dir, "wiki", "check").status, 0);
});

test("wiki check needs an index, honors wiki.root, and skips generated pointers", () => {
  const dir = workspace();
  rmSync(join(dir, "docs", "index.md"));
  const missing = kit(dir, "wiki", "check");
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, "missing docs/index.md\n");
  mkdirSync(join(dir, "docs", "index.md"));
  assert.equal(kit(dir, "wiki", "check").stderr, "missing docs/index.md\n");

  const custom = workspace({ wiki: { root: "notes" } });
  assert.equal(kit(custom, "wiki", "check").stderr, "missing notes/index.md\n");

  const pointers = workspace({
    wiki: {},
    registry: {
      file: "projects.json",
      entry: { required: ["name", "repo", "path", "owns", "mode"], optional: [] },
      project: { pathPrefix: "~/projects/", modes: ["managed"] },
      pointers: { dir: "docs/projects" },
    },
  });
  mkdirSync(join(pointers, "docs", "projects"));
  writeFileSync(join(pointers, "docs", "projects", "README.md"), "# Projects\n");
  symlinkSync("../../AGENTS.md", join(pointers, "docs", "projects", "agents-link.md"));
  assert.equal(kit(pointers, "wiki", "check").status, 0);
});

test("a workspace without a wiki section gets no wiki check", () => {
  const dir = workspace({});
  writeFileSync(join(dir, "docs", "unlisted.md"), "# Unlisted\n\n[gone](missing.md)\n");
  const doctor = kit(dir, "doctor", "--json");
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.equal(JSON.parse(doctor.stdout).checks.wiki, undefined);
  assert.equal(kit(dir, "wiki", "check").status, 1);
});

test("wiki check reads real log headings, inline index entries, and real link targets", () => {
  const dir = workspace();
  writeFileSync(
    join(dir, "docs", "log.md"),
    "# Log\n\n## [2026-01-01] `config.json` updated\n\n```md\n## not a heading\n```\n",
  );
  writeFileSync(
    join(dir, "docs", "index.md"),
    "# Index\n\n- [Alpha][a]\n\n[a]: alpha.md\n[b]: topics/beta.md\n",
  );
  const unused = kit(dir, "wiki", "check");
  assert.equal(
    unused.stderr,
    "docs/index.md: missing entry for docs/alpha.md\ndocs/index.md: missing entry for docs/topics/beta.md\n",
  );

  writeFileSync(
    join(dir, "docs", "index.md"),
    "# Index\n\n- [Alpha](alpha.md)\n- [[topics/beta]]\n\n[unused]: alpha.md\n",
  );
  assert.equal(kit(dir, "wiki", "check").status, 0, kit(dir, "wiki", "check").stderr);

  symlinkSync("nonexistent.md", join(dir, "dangling.md"));
  writeFileSync(join(dir, "docs", "alpha.md"), "# Alpha\n\n[Source](../dangling.md)\n");
  assert.equal(kit(dir, "wiki", "check").stderr, "docs/alpha.md: broken link (../dangling.md)\n");
});

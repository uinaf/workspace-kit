import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { tempDir } from "./temp-dir.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const marker =
  "Generated from `projects.json` by `workspace-kit registry pointers`; edit the registry, then rerun it.";

function kit(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

function workspace(projects: unknown, pointers: unknown = { dir: "docs/projects" }): string {
  const dir = tempDir("registry-pointers-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(
    join(dir, "workspace.json"),
    JSON.stringify({
      registry: {
        file: "projects.json",
        entry: { required: ["name", "repo", "path", "owns", "mode"], optional: ["branch"] },
        project: { pathPrefix: "~/projects/", modes: ["managed", "route-only"] },
        pointers,
      },
    }),
  );
  writeFileSync(join(dir, "projects.json"), JSON.stringify(projects));
  return dir;
}

const projects = {
  tools: [
    {
      name: "kit",
      repo: "fixture-owner/kit",
      path: "~/projects/fixture-owner/kit",
      owns: "the CLI\nand its docs",
      mode: "managed",
      branch: "main",
    },
  ],
  apps: [
    {
      name: "web",
      repo: "fixture-owner/web",
      path: "~/projects/fixture-owner/web",
      owns: "the web app",
      mode: "route-only",
    },
  ],
};

test("registry pointers writes one index and one file per category", () => {
  const dir = workspace(projects);
  const result = kit(dir, "registry", "pointers");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "wrote docs/projects/tools.md\nwrote docs/projects/apps.md\nwrote docs/projects/README.md\nregistry-pointers ok\n",
  );
  assert.equal(
    readFileSync(join(dir, "docs/projects/README.md"), "utf8"),
    `# Projects\n\n${marker}\n\n- [tools](tools.md): kit\n- [apps](apps.md): web\n`,
  );
  assert.equal(
    readFileSync(join(dir, "docs/projects/tools.md"), "utf8"),
    `# tools\n\n${marker}\n\n- **kit**: the CLI and its docs (\`~/projects/fixture-owner/kit\`, \`fixture-owner/kit\`, managed, branch \`main\`)\n`,
  );
  assert.equal(
    readFileSync(join(dir, "docs/projects/apps.md"), "utf8"),
    `# apps\n\n${marker}\n\n- **web**: the web app (\`~/projects/fixture-owner/web\`, \`fixture-owner/web\`, route-only)\n`,
  );
  assert.equal(kit(dir, "registry", "pointers", "--check").status, 0);
  assert.equal(kit(dir, "verify").status, 0);
});

test("verify fails on pointer drift and a rerun purges only generated files", () => {
  const dir = workspace(projects);
  assert.equal(kit(dir, "registry", "pointers").status, 0);
  writeFileSync(join(dir, "docs/projects/notes.md"), "# Notes\n");
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ tools: projects.tools }));

  const check = kit(dir, "registry", "pointers", "--check");
  assert.equal(check.status, 1);
  assert.equal(
    check.stderr,
    "would write docs/projects/README.md\nwould delete docs/projects/apps.md\n",
  );
  assert.ok(existsSync(join(dir, "docs/projects/apps.md")));

  const verify = kit(dir, "verify", "--json");
  assert.equal(verify.status, 1);
  const report = JSON.parse(verify.stdout) as { checks: Record<string, string> };
  assert.equal(report.checks.registryPointers, "fail");

  assert.equal(kit(dir, "registry", "pointers").status, 0);
  assert.equal(existsSync(join(dir, "docs/projects/apps.md")), false);
  assert.equal(readFileSync(join(dir, "docs/projects/notes.md"), "utf8"), "# Notes\n");
  assert.equal(kit(dir, "verify").status, 0);
});

test("registry pointers rejects unsafe categories and misconfiguration", () => {
  const unsafe = workspace({ "../x": [] });
  const result = kit(unsafe, "registry", "pointers");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /category \.\.\/x cannot name a pointer file/);

  const readme = workspace({ README: [] });
  assert.match(kit(readme, "registry", "pointers").stderr, /cannot name a pointer file/);

  const root = workspace(projects, { dir: "." });
  assert.match(
    kit(root, "registry", "pointers").stderr,
    /registry.pointers.dir must stay inside the workspace/,
  );

  const symlinked = workspace(projects);
  mkdirSync(join(symlinked, "elsewhere"));
  execFileSync("ln", ["-s", "elsewhere", join(symlinked, "docs")]);
  assert.equal(kit(symlinked, "registry", "pointers").status, 1);
  assert.equal(existsSync(join(symlinked, "elsewhere", "projects")), false);

  const dir = tempDir("registry-pointers-config-");
  writeFileSync(
    join(dir, "workspace.json"),
    JSON.stringify({
      registry: {
        file: "projects.json",
        entry: { required: [], optional: [] },
        pointers: { dir: "docs/projects" },
      },
    }),
  );
  assert.match(
    kit(dir, "config", "validate").stderr,
    /registry.pointers requires registry.project/,
  );
});

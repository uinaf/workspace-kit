import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

type Project = {
  name: string;
  repo: string;
  path: string;
  owns: string;
  mode: string;
  branch?: unknown;
  catalog?: unknown;
};

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function workspace(projects: Record<string, Project[]>): string {
  const dir = scratch("registry-workspace-");
  git(dir, "init", "-q");
  writeFileSync(
    join(dir, "workspace.json"),
    `${JSON.stringify(
      {
        registry: {
          file: "projects.json",
          entry: {
            required: ["name", "repo", "path", "owns", "mode"],
            optional: ["branch", "catalog"],
          },
          project: {
            pathPrefix: "~/projects/",
            modes: ["managed", "route-only"],
            catalog: { field: "catalog", modes: ["managed"] },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "projects.json"), `${JSON.stringify(projects, null, 2)}\n`);
  return dir;
}

function project(name: string, overrides: Partial<Project> = {}): Project {
  return {
    name,
    repo: `fixture-owner/${name}`,
    path: `~/projects/fixture-owner/${name}`,
    owns: "synthetic fixture",
    mode: "managed",
    ...overrides,
  };
}

function kit(cwd: string, home: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

function checkout(home: string, name: string, origin?: string): string {
  const dir = join(home, "projects", "fixture-owner", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  if (origin) git(dir, "remote", "add", "origin", origin);
  return dir;
}

test("registry validate accepts a valid missing checkout", () => {
  const home = scratch("registry-home-");
  const dir = workspace({ tools: [project("alpha", { branch: "main" })] });

  const result = kit(dir, home, "registry", "validate");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "registry ok\n");
});

test("registry validate rejects malformed optional fields before checkout inspection", () => {
  const home = scratch("registry-home-");
  mkdirSync(join(home, "projects", "fixture-owner", "alpha"), { recursive: true });
  const malformedBranch = workspace({ tools: [project("alpha", { branch: 42 })] });
  const branchResult = kit(malformedBranch, home, "registry", "validate");
  assert.equal(branchResult.status, 1);
  assert.equal(branchResult.stdout, "");
  assert.match(branchResult.stderr, /entry has invalid branch/);
  assert.doesNotMatch(branchResult.stderr, /Git worktree/);

  const malformedCatalog = workspace({ tools: [project("alpha", { catalog: [] })] });
  const catalogResult = kit(malformedCatalog, home, "registry", "validate");
  assert.equal(catalogResult.status, 1);
  assert.equal(catalogResult.stdout, "");
  assert.match(catalogResult.stderr, /entry has invalid catalog/);
  assert.doesNotMatch(catalogResult.stderr, /Git worktree/);
});

test("registry validate rejects invalid project policy and duplicate declarations", () => {
  const home = scratch("registry-home-");
  const invalid = workspace({
    tools: [
      project("alpha", {
        mode: "automatic",
        repo: "not-a-repository",
        path: "~/projects/fixture-owner/../alpha",
      }),
      project("catalog", { mode: "route-only", catalog: "./repos.json" }),
    ],
  });
  const invalidResult = kit(invalid, home, "registry", "validate");
  assert.equal(invalidResult.status, 1);
  assert.match(invalidResult.stderr, /invalid mode automatic/);
  assert.match(invalidResult.stderr, /invalid GitHub repository not-a-repository/);
  assert.match(invalidResult.stderr, /unsafe project path/);
  assert.match(invalidResult.stderr, /catalog is not allowed for mode route-only/);
  assert.match(invalidResult.stderr, /unsafe catalog path/);

  const duplicates = workspace({
    tools: [
      project("alpha"),
      project("alpha", { path: "~/projects/fixture-owner/alpha-two" }),
      project("beta", { path: "~/projects/fixture-owner/alpha" }),
    ],
  });
  const duplicateResult = kit(duplicates, home, "registry", "validate");
  assert.equal(duplicateResult.status, 1);
  assert.match(duplicateResult.stderr, /duplicate project label tools\/alpha/);
  assert.match(duplicateResult.stderr, /duplicate project path ~\/projects\/fixture-owner\/alpha/);
});

test("registry validate rejects portable aliases before checkout inspection", () => {
  const home = scratch("registry-home-");
  const caseAliases = workspace({
    tools: [
      project("upper", { path: "~/projects/fixture-owner/Alpha" }),
      project("lower", { path: "~/projects/fixture-owner/alpha" }),
    ],
  });
  const caseResult = kit(caseAliases, home, "registry", "validate");
  assert.equal(caseResult.status, 1);
  assert.match(caseResult.stderr, /duplicate project path/);
  assert.match(caseResult.stderr, /tools\/upper=.*Alpha/);
  assert.match(caseResult.stderr, /tools\/lower=.*alpha/);

  const unicodeAliases = workspace({
    tools: [
      project("ascii-s", { path: "~/projects/fixture-owner/S" }),
      project("long-s", { path: "~/projects/fixture-owner/ſ" }),
    ],
  });
  const unicodeResult = kit(unicodeAliases, home, "registry", "validate");
  assert.equal(unicodeResult.status, 1);
  assert.match(unicodeResult.stderr, /duplicate project path/);
  assert.match(unicodeResult.stderr, /tools\/ascii-s=.*\/S/);
  assert.match(unicodeResult.stderr, /tools\/long-s=.*\/ſ/);
});

test("registry validate accepts supported GitHub origins and an existing catalog", () => {
  const home = scratch("registry-home-");
  const origins = [
    ["alpha", "git@github.com:fixture-owner/alpha.git"],
    ["beta", "https://github.com/fixture-owner/beta.git"],
    ["gamma", "ssh://git@github.com/fixture-owner/gamma.git"],
  ] as const;
  for (const [name, origin] of origins) checkout(home, name, origin);
  writeFileSync(join(home, "projects", "fixture-owner", "alpha", "repos.json"), "{}\n");
  const dir = workspace({
    tools: [project("alpha", { catalog: "repos.json" }), project("beta"), project("gamma")],
  });

  const result = kit(dir, home, "registry", "validate");

  assert.equal(result.status, 0, result.stderr);
});

test("registry validate rejects nested paths and duplicate canonical roots", () => {
  const home = scratch("registry-home-");
  const alpha = checkout(home, "alpha", "git@github.com:fixture-owner/alpha.git");
  mkdirSync(join(alpha, "nested"));
  const nested = workspace({
    tools: [
      project("nested", {
        repo: "fixture-owner/alpha",
        path: "~/projects/fixture-owner/alpha/nested",
      }),
    ],
  });
  const nestedResult = kit(nested, home, "registry", "validate");
  assert.equal(nestedResult.status, 1);
  assert.match(nestedResult.stderr, /registered path is inside another checkout/);

  symlinkSync(alpha, join(home, "projects", "fixture-owner", "alpha-alias"), "junction");
  const aliased = workspace({
    tools: [
      project("alpha"),
      project("alpha-alias", {
        repo: "fixture-owner/alpha",
        path: "~/projects/fixture-owner/alpha-alias",
      }),
    ],
  });
  const aliasResult = kit(aliased, home, "registry", "validate");
  assert.equal(aliasResult.status, 1);
  assert.match(aliasResult.stderr, /multiple project entries resolve to the same checkout/);
});

test("registry validate rejects an existing non-Git project root", () => {
  const home = scratch("registry-home-");
  mkdirSync(join(home, "projects", "fixture-owner", "alpha"), { recursive: true });
  const dir = workspace({ tools: [project("alpha")] });

  const result = kit(dir, home, "registry", "validate");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /registered path is not a Git worktree/);
});

test("registry validate rejects missing, unsupported, and mismatched origins", () => {
  const home = scratch("registry-home-");
  checkout(home, "missing");
  checkout(home, "unsupported", "https://example.invalid/fixture-owner/unsupported.git");
  checkout(home, "mismatch", "git@github.com:fixture-owner/elsewhere.git");
  const dir = workspace({
    tools: [project("missing"), project("unsupported"), project("mismatch")],
  });

  const result = kit(dir, home, "registry", "validate");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tools\/missing: origin remote is missing/);
  assert.match(result.stderr, /tools\/unsupported: origin is not a supported GitHub URL/);
  assert.match(
    result.stderr,
    /tools\/mismatch: origin mismatch \(expected fixture-owner\/mismatch, found fixture-owner\/elsewhere\)/,
  );
});

test("registry validate rejects a missing catalog in an existing checkout", () => {
  const home = scratch("registry-home-");
  checkout(home, "alpha", "git@github.com:fixture-owner/alpha.git");
  const dir = workspace({ tools: [project("alpha", { catalog: "repos.json" })] });

  const result = kit(dir, home, "registry", "validate");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tools\/alpha: missing catalog repos\.json/);
});

test("registry validate rejects catalog symlink traversal", () => {
  const home = scratch("registry-home-");
  const alpha = checkout(home, "alpha", "git@github.com:fixture-owner/alpha.git");
  const outside = scratch("registry-catalog-outside-");
  writeFileSync(join(outside, "repos.json"), "{}\n");
  symlinkSync(outside, join(alpha, "catalog-link"), "junction");
  const dir = workspace({
    tools: [project("alpha", { catalog: "catalog-link/repos.json" })],
  });

  const result = kit(dir, home, "registry", "validate");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /catalog must not traverse symbolic links/);
});

test("registry project policy is explicit and validated", () => {
  const home = scratch("registry-home-");
  const dir = workspace({ tools: [project("alpha")] });
  const configPath = join(dir, "workspace.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));

  delete config.registry.project;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const missing = kit(dir, home, "registry", "validate");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires a registry\.project policy/);

  config.registry.project = {
    pathPrefix: "../projects/",
    modes: ["managed"],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const unsafePrefix = kit(dir, home, "config", "validate");
  assert.equal(unsafePrefix.status, 1);
  assert.match(unsafePrefix.stderr, /pathPrefix must be a portable, traversal-free/);

  config.registry.project = {
    pathPrefix: "~/projects/",
    modes: ["managed", "managed"],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const duplicateModes = kit(dir, home, "config", "validate");
  assert.equal(duplicateModes.status, 1);
  assert.match(duplicateModes.stderr, /registry\.project\.modes must not contain duplicates/);

  config.registry.project = {
    pathPrefix: "~/projects./",
    modes: ["managed"],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const nonPortablePrefix = kit(dir, home, "config", "validate");
  assert.equal(nonPortablePrefix.status, 1);
  assert.match(nonPortablePrefix.stderr, /pathPrefix must be a portable, traversal-free/);

  config.registry.project = {
    pathPrefix: "~/projects/",
    modes: ["managed"],
    catalog: { field: "inventory", modes: ["managed"] },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const undeclaredCatalog = kit(dir, home, "config", "validate");
  assert.equal(undeclaredCatalog.status, 1);
  assert.match(undeclaredCatalog.stderr, /catalog\.field must be declared in registry\.entry/);

  config.registry.project.catalog = { field: "catalog", modes: ["route-only"] };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const catalogModeOutsidePolicy = kit(dir, home, "config", "validate");
  assert.equal(catalogModeOutsidePolicy.status, 1);
  assert.match(catalogModeOutsidePolicy.stderr, /catalog\.modes must be included/);
});

test("registry project paths use the configured home-relative prefix", () => {
  const home = scratch("registry-home-");
  const dir = workspace({
    tools: [project("alpha", { path: "~/worktrees/fixture-owner/alpha" })],
  });
  const configPath = join(dir, "workspace.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.registry.project.pathPrefix = "~/worktrees/";
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const result = kit(dir, home, "registry", "validate");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "registry ok\n");
});

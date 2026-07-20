#!/usr/bin/env bun
// Regenerates parity/goldens/ from the frozen legacy scripts.
// Local-only: requires bun and git on PATH. CI never runs legacy scripts.
//
// Every scenario builds a fresh fixture repo in tmp/parity-work with pinned
// git author/committer dates so commit ids and outputs are deterministic.
// Normalization applied to captured output: the fixture working directory
// becomes <WORK>, and the capture day's date becomes <TODAY> (the legacy
// backfill stamps the current date into generated frontmatter).

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const parityDir = dirname(fileURLToPath(import.meta.url));
const fixtureSrc = join(parityDir, "fixtures", "green-personal");
const legacyDir = join(parityDir, "legacy");
const goldenDir = join(parityDir, "goldens");
const workRoot = join(parityDir, "..", "tmp", "parity-work");

// UTC, matching TZ=UTC in the child env — a local-TZ date here would desync
// from the backfill child's stamped date around midnight.
const today = new Date().toISOString().slice(0, 10);

// Explicit allowlist — never spread process.env: a stray FORCE_COLOR or
// locale in the invoking shell would poison goldens with ANSI codes or
// ICU-collated ordering.
const gitEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  TZ: "UTC",
  LANG: "C",
  LC_ALL: "C",
  NO_COLOR: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function sh(cwd: string, command: string, date?: string): string {
  const env = date
    ? { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    : gitEnv;
  return execSync(command, { cwd, env, encoding: "utf8" });
}

function buildBase(name: string): string {
  const dir = join(workRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(fixtureSrc, dir, { recursive: true, verbatimSymlinks: true });
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  for (const file of [
    "doctor.ts",
    "wiki-lint.ts",
    "wiki-backfill.ts",
    "wiki-stale.ts",
    "workspace-contract.ts",
  ]) {
    cpSync(join(legacyDir, file), join(dir, "scripts", file));
  }
  cpSync(
    join(legacyDir, "lib", "frontmatter.ts"),
    join(dir, "scripts", "lib", "frontmatter.ts"),
  );
  sh(dir, "git init -q -b main");
  sh(dir, "git remote add origin git@github.com:fixture-owner/fixture-workspace.git");
  sh(dir, "git add -A");
  sh(dir, 'git commit -qm "init"', "2026-01-01T00:00:00Z");
  const ancestor = sh(dir, "git rev-parse HEAD").trim();
  const contractPath = join(dir, "workspace.contract.json");
  writeFileSync(
    contractPath,
    readFileSync(contractPath, "utf8").replace(
      "PLACEHOLDER_ANCESTOR_SHA_REWRITTEN_BY_CAPTURE",
      ancestor,
    ),
  );
  sh(dir, "git add workspace.contract.json");
  sh(dir, 'git commit -qm "contract"', "2026-01-02T00:00:00Z");
  return dir;
}

function normalize(text: string, dir: string): string {
  return text
    .replaceAll(dir, "<WORK>")
    .replaceAll(workRoot, "<WORKROOT>")
    .replaceAll(today, "<TODAY>");
}

function capture(scenario: string, dir: string, args: string[]): void {
  const result = spawnSync("bun", args, { cwd: dir, encoding: "utf8", env: gitEnv });
  writeFileSync(join(goldenDir, `${scenario}.out`), normalize(result.stdout ?? "", dir));
  writeFileSync(join(goldenDir, `${scenario}.err`), normalize(result.stderr ?? "", dir));
  writeFileSync(join(goldenDir, `${scenario}.exit`), `${result.status}\n`);
}

function snapshotTree(scenario: string, dir: string, subdirs: string[]): void {
  const chunks: string[] = [];
  const walk = (base: string): string[] => {
    if (!existsSync(base)) return [];
    return readdirSync(base)
      .flatMap((entry) => {
        const path = join(base, entry);
        return statSync(path).isDirectory() ? walk(path) : [path];
      })
      .sort();
  };
  for (const sub of subdirs) {
    for (const path of walk(join(dir, sub))) {
      chunks.push(`=== ${relative(dir, path)} ===`);
      chunks.push(normalize(readFileSync(path, "utf8"), dir));
    }
  }
  writeFileSync(join(goldenDir, `${scenario}.tree`), chunks.join("\n"));
}

rmSync(goldenDir, { recursive: true, force: true });
mkdirSync(goldenDir, { recursive: true });
mkdirSync(workRoot, { recursive: true });

// --- Green path -----------------------------------------------------------

{
  const dir = buildBase("green");
  capture("doctor-green", dir, ["scripts/doctor.ts"]);
  capture("wiki-lint-green", dir, ["scripts/wiki-lint.ts"]);
  capture("contract-check-green", dir, ["scripts/workspace-contract.ts", "--check"]);
  capture("wiki-stale-green", dir, ["scripts/wiki-stale.ts"]);
  capture("handoff-allowed", dir, [
    "scripts/workspace-contract.ts",
    "--handoff",
    "scripts/example.ts",
    "docs/specs/example.md",
    "Makefile",
  ]);
  capture("handoff-blocked", dir, [
    "scripts/workspace-contract.ts",
    "--handoff",
    "scripts/example.ts",
    ".env",
    ".env.local",
    "config/.env.production",
    "IDENTITY.md",
    "HEARTBEAT.md",
    "SOUL.md",
    "MEMORY.md",
    "avatar.png",
    "projects.json",
    "workspace.contract.json",
    "memory/2026-01-02.md",
    "user/FACET.md",
    ".agents/skills/demo/SKILL.md",
    "docs/reference/hosts.md",
    "docs/runbooks/procedure.md",
    "/absolute/path.md",
    "scripts/../memory/sneaky.md",
    "",
  ]);
}

// --- Green https remote form -------------------------------------------------

{
  const dir = buildBase("green-https");
  sh(dir, "git remote set-url origin https://github.com/fixture-owner/fixture-workspace.git");
  capture("contract-check-green-https", dir, ["scripts/workspace-contract.ts", "--check"]);
}

// --- Doctor cascade: failing wiki child ---------------------------------------

{
  const dir = buildBase("doctor-cascade");
  const alphaPath = join(dir, "memory", "wiki", "topics", "alpha.md");
  writeFileSync(
    alphaPath,
    readFileSync(alphaPath, "utf8").replace("status: active\n", ""),
  );
  capture("doctor-cascade-errors", dir, ["scripts/doctor.ts"]);
}

// --- Backfill + post-backfill lint + idempotency ---------------------------

{
  const dir = buildBase("backfill");
  capture("backfill-first-run", dir, ["scripts/wiki-backfill.ts"]);
  snapshotTree("backfill-generated", dir, [
    "memory/wiki/sources",
    "memory/wiki/tags",
  ]);
  capture("wiki-lint-post-backfill", dir, ["scripts/wiki-lint.ts"]);
  capture("backfill-second-run", dir, ["scripts/wiki-backfill.ts"]);
  const status = sh(dir, "git status --porcelain");
  writeFileSync(
    join(goldenDir, "backfill-worktree-status.txt"),
    normalize(status, dir),
  );
}

// --- Peer check ------------------------------------------------------------

{
  const base = buildBase("peer-base");
  // The shared ancestor is the commit BEFORE the contract commit; the peer
  // must branch exactly there or the contract commit itself becomes shared
  // post-split history.
  const ancestor = sh(base, "git rev-parse HEAD~1").trim();
  const peer = join(workRoot, "peer-clone");
  rmSync(peer, { recursive: true, force: true });
  sh(workRoot, `git clone -q --no-hardlinks ${JSON.stringify(base)} peer-clone`);
  sh(peer, "git remote set-url origin git@github.com:fixture-owner/peer-workspace.git");
  sh(peer, `git reset -q --hard ${ancestor}`);
  const peerContractPath = join(peer, "workspace.contract.json");
  const peerContract = JSON.parse(readFileSync(peerContractPath, "utf8"));
  peerContract.repository = "fixture-owner/peer-workspace";
  peerContract.peerRepository = "fixture-owner/fixture-workspace";
  peerContract.sharedAncestor = ancestor;
  writeFileSync(peerContractPath, `${JSON.stringify(peerContract, null, 2)}\n`);
  sh(peer, "git add workspace.contract.json");
  sh(peer, 'git commit -qm "peer identity"', "2026-01-03T00:00:00Z");
  writeFileSync(join(base, "docs", "base-only.md"), "# Base only\n");
  sh(base, "git add docs/base-only.md");
  sh(base, 'git commit -qm "base divergence"', "2026-01-03T00:00:00Z");
  capture("peer-check-green", base, [
    "scripts/workspace-contract.ts",
    "--peer",
    peer,
  ]);

  // Shared post-split history: clone AFTER base diverged, so the divergence
  // commit exists in both histories.
  const shared = join(workRoot, "peer-shared");
  rmSync(shared, { recursive: true, force: true });
  sh(workRoot, `git clone -q --no-hardlinks ${JSON.stringify(base)} peer-shared`);
  sh(shared, "git remote set-url origin git@github.com:fixture-owner/peer-workspace.git");
  const sharedContractPath = join(shared, "workspace.contract.json");
  const sharedContract = JSON.parse(readFileSync(sharedContractPath, "utf8"));
  sharedContract.repository = "fixture-owner/peer-workspace";
  sharedContract.peerRepository = "fixture-owner/fixture-workspace";
  writeFileSync(sharedContractPath, `${JSON.stringify(sharedContract, null, 2)}\n`);
  sh(shared, "git add workspace.contract.json");
  sh(shared, 'git commit -qm "peer identity"', "2026-01-04T00:00:00Z");
  const sharedGolden = spawnSync(
    "bun",
    ["scripts/workspace-contract.ts", "--peer", shared],
    { cwd: base, encoding: "utf8", env: gitEnv },
  );
  // The shared-commit id is deterministic (pinned dates) but opaque; assert
  // shape rather than value by normalizing 40-hex ids.
  const normHex = (s: string) =>
    normalize(s, base).replace(/[0-9a-f]{40}/g, "<SHA>");
  writeFileSync(join(goldenDir, "peer-check-shared.out"), normHex(sharedGolden.stdout ?? ""));
  writeFileSync(join(goldenDir, "peer-check-shared.err"), normHex(sharedGolden.stderr ?? ""));
  writeFileSync(join(goldenDir, "peer-check-shared.exit"), `${sharedGolden.status}\n`);
}

// --- Structure errors (doctor) ---------------------------------------------

{
  const dir = buildBase("errors-structure");
  rmSync(join(dir, "CONTRIBUTING.md"));
  rmSync(join(dir, "CLAUDE.md"));
  writeFileSync(join(dir, "CLAUDE.md"), "# Not a symlink\n");
  const projects = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8"));
  delete projects.examples[0].owns;
  projects.examples[1].branch = "";
  writeFileSync(join(dir, "projects.json"), `${JSON.stringify(projects, null, 2)}\n`);
  writeFileSync(join(dir, "memory", "2026-01-02.md"), "no heading here\n");
  capture("doctor-structure-errors", dir, ["scripts/doctor.ts"]);
}

// --- Wiki lint errors -------------------------------------------------------

{
  const dir = buildBase("errors-wiki");
  const wiki = join(dir, "memory", "wiki");
  // Orphan page with valid frontmatter, zero inbound links.
  writeFileSync(
    join(wiki, "topics", "orphan.md"),
    `---\ntitle: Orphan\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: [demo]\nsources: [README.md]\n---\n\n# Orphan\n\nNo page links here.\n`,
  );
  // Missing status field + bad updated format + missing source file.
  writeFileSync(
    join(wiki, "topics", "broken-frontmatter.md"),
    `---\ntitle: Broken frontmatter\ntype: wiki\nupdated: January 2\ntags: [demo]\nsources: [does-not-exist.md]\n---\n\n# Broken frontmatter\n\nLinked from [[alpha]]? No — from index below.\n`,
  );
  // Bad status vocabulary.
  writeFileSync(
    join(wiki, "topics", "bad-status.md"),
    `---\ntitle: Bad status\ntype: wiki\nstatus: paused\nupdated: 2026-01-02\ntags: [demo]\nsources: [README.md]\n---\n\n# Bad status\n`,
  );
  // Ambiguous leaf: second "alpha.md" in another dir breaks the unique-leaf
  // fallback used by index.md's [[alpha]].
  mkdirSync(join(wiki, "other"), { recursive: true });
  writeFileSync(
    join(wiki, "other", "alpha.md"),
    `---\ntitle: Other alpha\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: [demo]\nsources: [README.md]\n---\n\n# Other alpha\n`,
  );
  // Broken wikilink + broken markdown link, linked into the graph via index.
  writeFileSync(
    join(wiki, "topics", "dead-links.md"),
    `---\ntitle: Dead links\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: [demo]\nsources: [README.md]\n---\n\n# Dead links\n\nSee [[totally-missing-page]] and [gone](gone-file.md).\n`,
  );
  const indexPath = join(wiki, "index.md");
  writeFileSync(
    indexPath,
    readFileSync(indexPath, "utf8") +
      "\n- [[dead-links]]\n- [[broken-frontmatter]]\n- [[bad-status]]\n- [[other/alpha]]\n",
  );
  // Bad log heading grammar.
  const logPath = join(wiki, "log.md");
  writeFileSync(
    logPath,
    readFileSync(logPath, "utf8") + "\n## bad heading without the grammar\n",
  );
  // No frontmatter at all: cascades missing + unterminated + per-field errors.
  writeFileSync(join(wiki, "topics", "no-frontmatter.md"), "# No frontmatter\n");
  // Opened but never terminated frontmatter.
  writeFileSync(
    join(wiki, "topics", "unterminated.md"),
    "---\ntitle: Unterminated\n\n# Unterminated\n",
  );
  // Empty required list field.
  writeFileSync(
    join(wiki, "topics", "empty-tags.md"),
    `---\ntitle: Empty tags\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: []\nsources: [README.md]\n---\n\n# Empty tags\n`,
  );
  // Broken wikilink that exists only inside related: frontmatter.
  writeFileSync(
    join(wiki, "topics", "related-broken.md"),
    `---\ntitle: Related broken\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: [demo]\nsources: [README.md]\nrelated: ["[[missing-related-target]]"]\n---\n\n# Related broken\n`,
  );
  writeFileSync(
    indexPath,
    readFileSync(indexPath, "utf8") +
      "- [[no-frontmatter]]\n- [[unterminated]]\n- [[empty-tags]]\n- [[related-broken]]\n",
  );
  capture("wiki-lint-errors", dir, ["scripts/wiki-lint.ts"]);
}

// --- Contract errors --------------------------------------------------------

{
  const dir = buildBase("errors-contract");
  sh(dir, "git remote set-url origin git@github.com:someone-else/elsewhere.git");
  const contractPath = join(dir, "workspace.contract.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.sharedAncestor = "a".repeat(40);
  contract.forbiddenOwnerPaths.push("secret/");
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  writeFileSync(join(dir, "IDENTITY.md"), "# Forbidden file\n");
  mkdirSync(join(dir, "secret"), { recursive: true });
  writeFileSync(join(dir, "secret", "creds.md"), "# Tracked under a forbidden prefix\n");
  sh(dir, "git rm -q SOUL.md");
  sh(dir, "git rm -q -r user/");
  sh(dir, "git add -A");
  sh(dir, 'git commit -qm "seed contract errors"', "2026-01-05T00:00:00Z");
  capture("contract-check-errors", dir, ["scripts/workspace-contract.ts", "--check"]);
}

// --- Usage and malformed-config errors --------------------------------------

{
  const dir = buildBase("errors-usage");
  capture("contract-usage-error", dir, ["scripts/workspace-contract.ts"]);
  writeFileSync(
    join(dir, "workspace.contract.json"),
    '{ "version": 1, "handoff": [] }\n',
  );
  capture("contract-malformed", dir, ["scripts/workspace-contract.ts", "--check"]);
}

// --- Stale report -----------------------------------------------------------

{
  const dir = buildBase("stale");
  const topics = join(dir, "memory", "wiki", "topics");
  // Page with 7 stale sources: exercises the slice(0, 5) truncation and the
  // "+N more" suffix. Untracked wiki pages are fine — stale walks the disk
  // and only consults git history for SOURCE dates.
  writeFileSync(
    join(topics, "multi-stale.md"),
    `---\ntitle: Multi stale\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: [demo]\nsources:\n  - AGENTS.md\n  - CONTRIBUTING.md\n  - MEMORY.md\n  - README.md\n  - SOUL.md\n  - TOOLS.md\n  - USER.md\n---\n\n# Multi stale\n`,
  );
  // Second stale page with an older newest-source date: exercises the
  // newest-desc report ordering across pages.
  writeFileSync(
    join(topics, "second-stale.md"),
    `---\ntitle: Second stale\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: [demo]\nsources: [docs/README.md]\n---\n\n# Second stale\n`,
  );
  writeFileSync(
    join(dir, "docs", "README.md"),
    "# Docs\n\nTouched at the earlier of the two stale dates.\n",
  );
  sh(dir, "git add docs/README.md");
  sh(dir, 'git commit -qm "february source change"', "2026-02-01T00:00:00Z");
  for (const file of [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "MEMORY.md",
    "README.md",
    "SOUL.md",
    "TOOLS.md",
    "USER.md",
  ]) {
    writeFileSync(
      join(dir, file),
      `${readFileSync(join(dir, file), "utf8")}\nTouched after the updated date.\n`,
    );
  }
  sh(dir, "git add -u");
  sh(dir, 'git commit -qm "march source changes"', "2026-03-01T00:00:00Z");
  capture("wiki-stale-flagged", dir, ["scripts/wiki-stale.ts"]);
}

console.log(`captured goldens into ${relative(process.cwd(), goldenDir)}`);

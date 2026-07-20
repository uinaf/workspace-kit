// Single source of truth for parity scenarios. Both runners consume this:
// parity/capture.ts drives the frozen legacy scripts (bun) and writes
// goldens; test/golden-parity.test.ts drives the kit CLI (node) and compares
// against those goldens. Node-clean: no bun APIs.
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative } from "node:path";

export type RunResult = { stdout: string; stderr: string; status: number | null };
// Commands use the kit's semantic argv; the legacy runner translates.
export type Runner = (command: string[], cwd: string) => RunResult;
export type Sink = {
  emit(name: string, result: RunResult, dir: string): void;
  snapshot(name: string, dir: string, subdirs: string[]): void;
  status(name: string, dir: string, statusText: string): void;
};

// Scenarios whose outputs are legacy-only by design (usage text differs
// between the legacy script and the kit CLI; exit codes still match).
export const PARITY_EXEMPT = new Set(["contract-usage-error"]);

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// Explicit allowlist — never spread process.env: a stray FORCE_COLOR or
// locale in the invoking shell would poison outputs with ANSI codes or
// ICU-collated ordering.
export function makeEnv(): Record<string, string> {
  return {
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
}

export function sh(cwd: string, command: string, date?: string): string {
  const env = date ? { ...makeEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : makeEnv();
  return execSync(command, { cwd, env, encoding: "utf8" });
}

export function normalize(text: string, dir: string, workRoot: string, today: string): string {
  return text
    .replaceAll(dir, "<WORK>")
    .replaceAll(workRoot, "<WORKROOT>")
    .replaceAll(today, "<TODAY>");
}

// The workspace.json equivalent of every list the legacy scripts hardcode.
const FIXTURE_CONFIG = {
  required: [
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "CONTRIBUTING.md",
    "SOUL.md",
    "USER.md",
    "MEMORY.md",
    "TOOLS.md",
    ".env.example",
    "projects.json",
    "workspace.contract.json",
    "docs/README.md",
    "memory/wiki/index.md",
    "memory/wiki/schema.md",
    "memory/wiki/log.md",
  ],
  links: [{ path: "CLAUDE.md", target: "AGENTS.md" }],
  registry: {
    file: "projects.json",
    entry: { required: ["name", "repo", "path", "owns"], optional: ["branch"] },
  },
  dailyLogs: { root: "memory", contexts: "memory/contexts" },
  wiki: { root: "memory/wiki" },
  contract: { file: "workspace.contract.json" },
  handoff: {
    paths: [
      "AGENTS.md",
      "HEARTBEAT.md",
      "IDENTITY.md",
      "MEMORY.md",
      "SOUL.md",
      "TOOLS.md",
      "USER.md",
      "avatar.png",
      "projects.json",
      "workspace.contract.json",
    ],
    prefixes: [".agents/skills/", "docs/reference/", "docs/runbooks/", "memory/", "user/"],
  },
};

export type BuildOptions = { workRoot: string; fixtureSrc: string; legacyDir: string };

export function buildBase(opts: BuildOptions, name: string): string {
  const dir = join(opts.workRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(opts.fixtureSrc, dir, { recursive: true, verbatimSymlinks: true });
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  for (const file of [
    "doctor.ts",
    "wiki-lint.ts",
    "wiki-backfill.ts",
    "wiki-stale.ts",
    "workspace-contract.ts",
  ]) {
    cpSync(join(opts.legacyDir, file), join(dir, "scripts", file));
  }
  cpSync(
    join(opts.legacyDir, "lib", "frontmatter.ts"),
    join(dir, "scripts", "lib", "frontmatter.ts"),
  );
  writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(FIXTURE_CONFIG, null, 2)}\n`);
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

export function snapshotTree(dir: string, subdirs: string[]): string {
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
      chunks.push(readFileSync(path, "utf8"));
    }
  }
  return chunks.join("\n");
}

const HANDOFF_BLOCKED_ARGS = [
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
];

export function runScenarios(opts: BuildOptions & { runner: Runner; sink: Sink }): void {
  const { runner, sink } = opts;
  const run = (name: string, dir: string, command: string[]) =>
    sink.emit(name, runner(command, dir), dir);

  // --- Green path ---------------------------------------------------------
  {
    const dir = buildBase(opts, "green");
    run("doctor-green", dir, ["doctor"]);
    run("wiki-lint-green", dir, ["wiki", "lint"]);
    run("contract-check-green", dir, ["contract", "check"]);
    run("wiki-stale-green", dir, ["wiki", "stale"]);
    run("handoff-allowed", dir, [
      "contract",
      "handoff",
      "scripts/example.ts",
      "docs/specs/example.md",
      "Makefile",
    ]);
    run("handoff-blocked", dir, ["contract", "handoff", ...HANDOFF_BLOCKED_ARGS]);
  }

  // --- Backfill + post-backfill lint + idempotency --------------------------
  {
    const dir = buildBase(opts, "backfill");
    run("backfill-first-run", dir, ["wiki", "backfill"]);
    sink.snapshot("backfill-generated", dir, ["memory/wiki/sources", "memory/wiki/tags"]);
    run("wiki-lint-post-backfill", dir, ["wiki", "lint"]);
    run("backfill-second-run", dir, ["wiki", "backfill"]);
    sink.status("backfill-worktree-status", dir, sh(dir, "git status --porcelain"));
  }

  // --- Peer check -----------------------------------------------------------
  {
    const base = buildBase(opts, "peer-base");
    const ancestor = sh(base, "git rev-parse HEAD~1").trim();
    const peer = join(opts.workRoot, "peer-clone");
    rmSync(peer, { recursive: true, force: true });
    sh(opts.workRoot, `git clone -q --no-hardlinks ${JSON.stringify(base)} peer-clone`);
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
    run("peer-check-green", base, ["contract", "peer", peer]);

    const shared = join(opts.workRoot, "peer-shared");
    rmSync(shared, { recursive: true, force: true });
    sh(opts.workRoot, `git clone -q --no-hardlinks ${JSON.stringify(base)} peer-shared`);
    sh(shared, "git remote set-url origin git@github.com:fixture-owner/peer-workspace.git");
    const sharedContractPath = join(shared, "workspace.contract.json");
    const sharedContract = JSON.parse(readFileSync(sharedContractPath, "utf8"));
    sharedContract.repository = "fixture-owner/peer-workspace";
    sharedContract.peerRepository = "fixture-owner/fixture-workspace";
    writeFileSync(sharedContractPath, `${JSON.stringify(sharedContract, null, 2)}\n`);
    sh(shared, "git add workspace.contract.json");
    sh(shared, 'git commit -qm "peer identity"', "2026-01-04T00:00:00Z");
    run("peer-check-shared", base, ["contract", "peer", shared]);
  }

  // --- Green https remote form ----------------------------------------------
  {
    const dir = buildBase(opts, "green-https");
    sh(dir, "git remote set-url origin https://github.com/fixture-owner/fixture-workspace.git");
    run("contract-check-green-https", dir, ["contract", "check"]);
  }

  // --- Doctor cascade: failing wiki child ------------------------------------
  {
    const dir = buildBase(opts, "doctor-cascade");
    const alphaPath = join(dir, "memory", "wiki", "topics", "alpha.md");
    writeFileSync(alphaPath, readFileSync(alphaPath, "utf8").replace("status: active\n", ""));
    run("doctor-cascade-errors", dir, ["doctor"]);
  }

  // --- Structure errors (doctor) ---------------------------------------------
  {
    const dir = buildBase(opts, "errors-structure");
    rmSync(join(dir, "CONTRIBUTING.md"));
    rmSync(join(dir, "CLAUDE.md"));
    writeFileSync(join(dir, "CLAUDE.md"), "# Not a symlink\n");
    const projects = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8"));
    delete projects.examples[0].owns;
    projects.examples[1].branch = "";
    writeFileSync(join(dir, "projects.json"), `${JSON.stringify(projects, null, 2)}\n`);
    writeFileSync(join(dir, "memory", "2026-01-02.md"), "no heading here\n");
    run("doctor-structure-errors", dir, ["doctor"]);
  }

  // --- Wiki lint errors -------------------------------------------------------
  {
    const dir = buildBase(opts, "errors-wiki");
    const wiki = join(dir, "memory", "wiki");
    writeFileSync(
      join(wiki, "topics", "orphan.md"),
      `---\ntitle: Orphan\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: [demo]\nsources: [README.md]\n---\n\n# Orphan\n\nNo page links here.\n`,
    );
    writeFileSync(
      join(wiki, "topics", "broken-frontmatter.md"),
      `---\ntitle: Broken frontmatter\ntype: wiki\nupdated: January 2\ntags: [demo]\nsources: [does-not-exist.md]\n---\n\n# Broken frontmatter\n\nLinked from [[alpha]]? No — from index below.\n`,
    );
    writeFileSync(
      join(wiki, "topics", "bad-status.md"),
      `---\ntitle: Bad status\ntype: wiki\nstatus: paused\nupdated: 2026-01-02\ntags: [demo]\nsources: [README.md]\n---\n\n# Bad status\n`,
    );
    mkdirSync(join(wiki, "other"), { recursive: true });
    writeFileSync(
      join(wiki, "other", "alpha.md"),
      `---\ntitle: Other alpha\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: [demo]\nsources: [README.md]\n---\n\n# Other alpha\n`,
    );
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
    const logPath = join(wiki, "log.md");
    writeFileSync(
      logPath,
      readFileSync(logPath, "utf8") + "\n## bad heading without the grammar\n",
    );
    writeFileSync(join(wiki, "topics", "no-frontmatter.md"), "# No frontmatter\n");
    writeFileSync(
      join(wiki, "topics", "unterminated.md"),
      "---\ntitle: Unterminated\n\n# Unterminated\n",
    );
    writeFileSync(
      join(wiki, "topics", "empty-tags.md"),
      `---\ntitle: Empty tags\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: []\nsources: [README.md]\n---\n\n# Empty tags\n`,
    );
    writeFileSync(
      join(wiki, "topics", "related-broken.md"),
      `---\ntitle: Related broken\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: [demo]\nsources: [README.md]\nrelated: ["[[missing-related-target]]"]\n---\n\n# Related broken\n`,
    );
    writeFileSync(
      indexPath,
      readFileSync(indexPath, "utf8") +
        "- [[no-frontmatter]]\n- [[unterminated]]\n- [[empty-tags]]\n- [[related-broken]]\n",
    );
    run("wiki-lint-errors", dir, ["wiki", "lint"]);
  }

  // --- Contract errors --------------------------------------------------------
  {
    const dir = buildBase(opts, "errors-contract");
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
    run("contract-check-errors", dir, ["contract", "check"]);
  }

  // --- Usage and malformed-config errors --------------------------------------
  {
    const dir = buildBase(opts, "errors-usage");
    run("contract-usage-error", dir, ["contract"]);
    writeFileSync(join(dir, "workspace.contract.json"), '{ "version": 1, "handoff": [] }\n');
    run("contract-malformed", dir, ["contract", "check"]);
  }

  // --- Stale report -----------------------------------------------------------
  {
    const dir = buildBase(opts, "stale");
    const topics = join(dir, "memory", "wiki", "topics");
    writeFileSync(
      join(topics, "multi-stale.md"),
      `---\ntitle: Multi stale\ntype: wiki\nstatus: active\nupdated: 2026-01-02\ntags: [demo]\nsources:\n  - AGENTS.md\n  - CONTRIBUTING.md\n  - MEMORY.md\n  - README.md\n  - SOUL.md\n  - TOOLS.md\n  - USER.md\n---\n\n# Multi stale\n`,
    );
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
    run("wiki-stale-flagged", dir, ["wiki", "stale"]);
  }
}

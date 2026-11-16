// Single source of truth for parity scenarios. Both runners consume this:
// parity/capture.ts drives the frozen legacy scripts (bun) and writes
// goldens; test/golden-parity.test.ts drives the kit CLI (node) and compares
// against those goldens. Node-clean: no bun APIs.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

export type RunResult = { stdout: string; stderr: string; status: number | null };
// Commands use the kit's semantic argv; the legacy runner translates.
export type Runner = (command: string[], cwd: string) => RunResult;
export type Sink = {
  emit(name: string, result: RunResult, dir: string): void;
};

// Scenarios whose outputs are legacy-only by design (usage text differs
// between the legacy script and the kit CLI; exit codes still match).
export const PARITY_EXEMPT = new Set(["contract-usage-error"]);

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// Never spread process.env. FORCE_COLOR or the invoking shell's locale would
// poison outputs with ANSI codes or ICU-collated ordering.
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
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(
    join(opts.legacyDir, "workspace-contract.ts"),
    join(dir, "scripts", "workspace-contract.ts"),
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
    run("contract-check-green", dir, ["contract", "check"]);
    run("handoff-allowed", dir, [
      "contract",
      "handoff",
      "scripts/example.ts",
      "docs/specs/example.md",
      "Makefile",
    ]);
    run("handoff-blocked", dir, ["contract", "handoff", ...HANDOFF_BLOCKED_ARGS]);
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
}

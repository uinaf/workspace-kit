#!/usr/bin/env node
// workspace-kit CLI. Default output is parity-locked to the legacy
// workspace scripts (see parity/): errors one per line on stderr, exit 1;
// terse "<check> ok" lines on stdout; exit 2 on usage errors.
import { spawnSync } from "node:child_process";
import { chdir } from "node:process";
import {
  CONFIG_FILE,
  compareVersions,
  loadWorkspaceConfig,
  readRawConfig,
  unknownConfigKeys,
  type WorkspaceConfig,
} from "./config.ts";
import { structureErrors } from "./checks/structure.ts";
import { wikiLintErrors } from "./checks/wikiLint.ts";
import { wikiStaleReport } from "./checks/wikiStale.ts";
import { wikiBackfill } from "./checks/wikiBackfill.ts";
import {
  isPrivateHandoffPath,
  loadContract,
  peerErrors,
  workspaceErrors,
} from "./checks/contract.ts";
import { docsLinkErrors } from "./checks/docsLinks.ts";
import { limitWarnings } from "./checks/limits.ts";
import { initWorkspace } from "./init.ts";
import { kitVersion } from "./version.ts";
import {
  assertWorkspaceLinkTarget,
  createWorkspaceLink,
  readWorkspaceLink,
  unlinkWorkspaceLink,
  workspaceLstat,
} from "./lib/workspaceFs.ts";

const USAGE = `usage: workspace-kit <command>

commands:
  doctor [--json]          run all checks configured in ${CONFIG_FILE}
  wiki lint                lint the wiki layer
  wiki stale               report wiki pages older than their sources
  wiki backfill [--dry-run]  regenerate the wiki source/tag catalogs
  limits                   report soft size-limit warnings (never fails)
  contract check           validate this repository's workspace contract
  contract peer <path>     validate both contracts and history separation
  contract handoff <path...>  screen proposed handoff paths
  links check | fix        verify or recreate configured alias symlinks
  docs links               check relative links in tracked markdown
  config validate          validate ${CONFIG_FILE} itself
  init [--profile personal|runtime|work] [--dir <path>]  scaffold a workspace
  --version                print the kit version
`;

function usageExit(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

function failWith(message: string): never {
  console.error(message);
  process.exit(1);
}

function doctorFailure(message: string, json: boolean): never {
  if (json) {
    console.log(
      JSON.stringify({
        status: "fail",
        failed: 1,
        warnings: 0,
        checks: {},
        errors: [message],
      }),
    );
    process.exit(1);
  }
  failWith(message);
}

function chdirToRepoRoot(): void {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status === 0) chdir(result.stdout.trim());
}

function loadConfigOrFail(json = false): WorkspaceConfig {
  let config: WorkspaceConfig;
  try {
    config = loadWorkspaceConfig();
  } catch (error) {
    doctorFailure(error instanceof Error ? error.message : String(error), json);
  }
  if (config.minVersion && compareVersions(kitVersion(), config.minVersion) < 0) {
    doctorFailure(
      `${CONFIG_FILE} requires workspace-kit >= ${config.minVersion} (running ${kitVersion()})`,
      json,
    );
  }
  return config;
}

function requireSection<T>(value: T | undefined, section: string): T {
  if (value === undefined) {
    failWith(`${CONFIG_FILE} has no ${section} section`);
  }
  return value;
}

// Runs wiki lint exactly like the legacy standalone script: errors to
// stderr + exit-style status, "wiki-lint ok" on stdout when green.
function runWikiLint(wiki: import("./config.ts").WikiConfig): number {
  const result = wikiLintErrors(wiki);
  if (result.fatal) {
    console.error(result.fatal);
    return 1;
  }
  if (result.errors.length > 0) {
    console.error(result.errors.join("\n"));
    return 1;
  }
  console.log("wiki-lint ok");
  return 0;
}

function runContractCheck(file: string): number {
  try {
    const contract = loadContract(".", file);
    const errors = workspaceErrors(".", file);
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      return 1;
    }
    console.log(`workspace boundary ok (${contract.repository})`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function doctor(config: WorkspaceConfig, json: boolean): never {
  const bad: string[] = [];
  const checks: Record<string, string> = {};
  const detail: string[] = [];

  const structural = structureErrors(config);
  bad.push(...structural);
  detail.push(...structural);
  checks.structure = structural.length === 0 ? "ok" : "fail";

  const stdout = (line: string) => {
    if (!json) console.log(line);
  };
  const stderr = (lines: string[]) => {
    detail.push(...lines);
    if (!json) console.error(lines.join("\n"));
  };

  if (config.wiki) {
    const result = wikiLintErrors(config.wiki);
    const errors = result.fatal ? [result.fatal] : result.errors;
    if (errors.length > 0) {
      stderr(errors);
      bad.push("wiki-lint failed (exit 1)");
      checks.wiki = "fail";
    } else {
      stdout("wiki-lint ok");
      checks.wiki = "ok";
    }
  }

  if (config.contract) {
    try {
      const contract = loadContract(".", config.contract.file);
      const errors = workspaceErrors(".", config.contract.file);
      if (errors.length > 0) {
        stderr(errors);
        bad.push("workspace contract failed (exit 1)");
        checks.contract = "fail";
      } else {
        stdout(`workspace boundary ok (${contract.repository})`);
        checks.contract = "ok";
      }
    } catch (error) {
      stderr([error instanceof Error ? error.message : String(error)]);
      bad.push("workspace contract failed (exit 1)");
      checks.contract = "fail";
    }
  }

  if (config.docsLinks?.enabled) {
    const errors = docsLinkErrors(config.docsLinks);
    if (errors.length > 0) {
      stderr(errors);
      bad.push("docs links failed (exit 1)");
      checks.docsLinks = "fail";
    } else {
      stdout("docs-links ok");
      checks.docsLinks = "ok";
    }
  }

  // Soft limits are warnings by design: printed, counted, never fatal.
  const warnings = config.limits ? limitWarnings(config.limits) : [];
  if (warnings.length > 0 && !json) console.error(warnings.join("\n"));

  if (json) {
    const failed = Object.values(checks).filter((v) => v === "fail").length;
    console.log(
      JSON.stringify({
        status: bad.length > 0 ? "fail" : "pass",
        failed,
        warnings: warnings.length,
        checks,
        errors: detail,
      }),
    );
    process.exit(bad.length > 0 ? 1 : 0);
  }

  if (bad.length > 0) {
    console.error(bad.join("\n"));
    process.exit(1);
  }
  console.log("doctor ok");
  process.exit(0);
}

function main(): void {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  if (command === "--version") {
    console.log(kitVersion());
    process.exit(0);
  }
  if (!command || command === "-h" || command === "--help") usageExit();

  if (command === "init") {
    let profile = "personal";
    let dir = ".";
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--profile" && rest[i + 1]) {
        profile = rest[i + 1]!;
        i += 1;
      } else if (rest[i] === "--dir" && rest[i + 1]) {
        dir = rest[i + 1]!;
        i += 1;
      } else {
        usageExit();
      }
    }
    if (!["personal", "runtime", "work"].includes(profile)) usageExit();
    let result;
    try {
      result = initWorkspace(dir, profile as "personal" | "runtime" | "work");
    } catch (error) {
      failWith(error instanceof Error ? error.message : String(error));
    }
    for (const line of result.created) console.log(`created ${line}`);
    for (const line of result.skipped) console.log(`kept existing ${line}`);
    console.log(`workspace scaffolded (${profile} profile)`);
    if (result.created.includes(".githooks/pre-commit")) {
      console.log("enable the hook with: git config core.hooksPath .githooks");
    }
    process.exit(0);
  }

  chdirToRepoRoot();

  if (command === "doctor") {
    const json = rest.includes("--json");
    if (rest.some((arg) => arg !== "--json")) usageExit();
    try {
      doctor(loadConfigOrFail(json), json);
    } catch (error) {
      doctorFailure(error instanceof Error ? error.message : String(error), json);
    }
  }

  if (command === "wiki") {
    const [mode, ...args] = rest;
    const config = loadConfigOrFail();
    const wiki = requireSection(config.wiki, "wiki");
    if (mode === "lint" && args.length === 0) {
      process.exit(runWikiLint(wiki));
    }
    if (mode === "stale" && args.length === 0) {
      const report = wikiStaleReport(wiki.root);
      if (report.fatal) failWith(report.fatal);
      for (const line of report.err) console.error(line);
      for (const line of report.out) console.log(line);
      process.exit(0);
    }
    if (mode === "backfill" && args.every((a) => a === "--dry-run")) {
      const result = wikiBackfill({ root: wiki.root, dryRun: args.includes("--dry-run") });
      for (const line of result.planned) console.log(line);
      for (const line of result.out) console.log(line);
      process.exit(0);
    }
    usageExit();
  }

  if (command === "contract") {
    const [mode, ...args] = rest;
    const config = loadConfigOrFail();

    if (mode === "check" && args.length === 0) {
      const contract = requireSection(config.contract, "contract");
      process.exit(runContractCheck(contract.file));
    }

    if (mode === "peer" && args.length === 1) {
      const contract = requireSection(config.contract, "contract");
      try {
        const current = loadContract(".", contract.file);
        const peer = loadContract(args[0]!);
        const errors = peerErrors(".", args[0]!, contract.file);
        if (errors.length > 0) {
          console.error(errors.join("\n"));
          process.exit(1);
        }
        console.log(
          `workspace histories are separate (${current.repository} <-> ${peer.repository})`,
        );
        process.exit(0);
      } catch (error) {
        failWith(error instanceof Error ? error.message : String(error));
      }
    }

    if (mode === "handoff" && args.length > 0) {
      const handoff = requireSection(config.handoff, "handoff");
      const blocked = args.filter((path) => isPrivateHandoffPath(path, handoff));
      if (blocked.length > 0) {
        console.error(blocked.map((path) => `owner-private handoff path: ${path}`).join("\n"));
        process.exit(1);
      }
      console.log(`handoff paths eligible for review:\n${args.join("\n")}`);
      process.exit(0);
    }

    usageExit();
  }

  if (command === "links") {
    const [mode, ...args] = rest;
    if (args.length > 0) usageExit();
    const config = loadConfigOrFail();
    const links = requireSection(config.links, "links");
    if (mode === "check") {
      const bad: string[] = [];
      for (const { path, target } of links) {
        try {
          assertWorkspaceLinkTarget(".", path, target);
        } catch (error) {
          bad.push(
            `${path} has unsafe target ${target}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        const stat = workspaceLstat(".", path, "link path");
        if (!stat) {
          bad.push(`missing ${path}`);
        } else if (!stat.isSymbolicLink()) {
          bad.push(`${path} should be a symlink to ${target}`);
        } else {
          const actual = readWorkspaceLink(".", path);
          if (actual !== target) bad.push(`${path} points to ${actual}, expected ${target}`);
        }
      }
      if (bad.length > 0) {
        console.error(bad.join("\n"));
        process.exit(1);
      }
      console.log("links ok");
      process.exit(0);
    }
    if (mode === "fix") {
      const current = links.map((link) => {
        assertWorkspaceLinkTarget(".", link.path, link.target);
        const stat = workspaceLstat(".", link.path, "link path");
        if (stat && !stat.isSymbolicLink()) {
          failWith(`${link.path} exists and is not a symlink; refusing to replace it`);
        }
        return {
          ...link,
          actual: stat?.isSymbolicLink() ? readWorkspaceLink(".", link.path) : undefined,
        };
      });
      for (const { path, target, actual } of current) {
        if (actual === target) continue;
        try {
          if (actual !== undefined) unlinkWorkspaceLink(".", path);
          createWorkspaceLink(".", path, target);
        } catch (error) {
          failWith(
            `could not link ${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        console.log(`linked ${path} -> ${target}`);
      }
      console.log("links ok");
      process.exit(0);
    }
    usageExit();
  }

  if (command === "docs") {
    const [mode, ...args] = rest;
    if (mode !== "links" || args.length > 0) usageExit();
    const config = loadConfigOrFail();
    const docsLinks = requireSection(config.docsLinks, "docsLinks");
    const errors = docsLinkErrors(docsLinks);
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    console.log("docs-links ok");
    process.exit(0);
  }

  if (command === "limits") {
    if (rest.length > 0) usageExit();
    const config = loadConfigOrFail();
    const rules = requireSection(config.limits, "limits");
    const warnings = limitWarnings(rules);
    if (warnings.length > 0) console.error(warnings.join("\n"));
    else console.log("limits ok");
    process.exit(0);
  }

  if (command === "config") {
    const [mode, ...args] = rest;
    if (mode !== "validate" || args.length > 0) usageExit();
    loadConfigOrFail(); // includes the minVersion gate
    try {
      for (const key of unknownConfigKeys(readRawConfig())) {
        console.error(`warning: unrecognized key ${key} (ignored by this kit version)`);
      }
    } catch {
      // unreachable: loadConfigOrFail already parsed the file
    }
    console.log("config ok");
    process.exit(0);
  }

  usageExit();
}

try {
  main();
} catch (error) {
  failWith(error instanceof Error ? error.message : String(error));
}

#!/usr/bin/env node
// workspace-kit CLI. Default output is parity-locked to the legacy
// workspace scripts (see parity/): errors one per line on stderr, exit 1;
// terse "<check> ok" lines on stdout; exit 2 on usage errors.
import { spawnSync } from "node:child_process";
import { chdir } from "node:process";
import {
  CONFIG_FILE,
  compareVersions,
  parseWorkspaceConfig,
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
import { confidentialReport, confidentialSummary } from "./checks/confidential.ts";
import { docsLinkErrors } from "./checks/docsLinks.ts";
import { limitWarnings } from "./checks/limits.ts";
import { projectRegistryErrors } from "./checks/registry.ts";
import { projectRegistryEntries } from "./checks/registry.ts";
import { initWorkspace } from "./init.ts";
import { installHooks } from "./hooks.ts";
import {
  cloneProjects,
  pullProjects,
  resolveProjectPath,
  statusProjects,
} from "./registryLifecycle.ts";
import { syncWorkspaceSkills, workspaceSkillErrors } from "./skills.ts";
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
  verify [--json]          run the complete offline validation gate
  doctor [--json]          run all checks configured in ${CONFIG_FILE}
  wiki lint                lint the wiki layer
  wiki stale               report wiki pages older than their sources
  wiki backfill [--dry-run|--check]  regenerate or verify wiki source/tag catalogs
  limits                   report soft size-limit warnings (never fails)
  contract check           validate this repository's workspace contract
  contract peer <path>     validate both contracts and history separation
  contract handoff <path...>  screen proposed handoff paths
  links check | fix        verify or recreate configured alias symlinks
  docs links               check relative links in tracked markdown
  confidential check       verify declared confidential paths stay encrypted
  registry validate        validate project-registry policy and local checkouts
  registry clone | status | pull  operate configured project checkouts
  registry path <category/name> [--mode <mode>]  resolve a configured checkout
  hooks install            configure this checkout's tracked Git hooks
  skills check | sync      verify or install configured workspace-local skills
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

type LoadedConfig = { config: WorkspaceConfig; unknownKeys: string[] };

function loadConfigStateOrFail(json = false): LoadedConfig {
  let raw: unknown;
  let config: WorkspaceConfig;
  try {
    raw = readRawConfig();
    config = parseWorkspaceConfig(raw);
  } catch (error) {
    doctorFailure(error instanceof Error ? error.message : String(error), json);
  }
  if (config.minVersion && compareVersions(kitVersion(), config.minVersion) < 0) {
    doctorFailure(
      `${CONFIG_FILE} requires workspace-kit >= ${config.minVersion} (running ${kitVersion()})`,
      json,
    );
  }
  return { config, unknownKeys: unknownConfigKeys(raw) };
}

function loadConfigOrFail(json = false): WorkspaceConfig {
  return loadConfigStateOrFail(json).config;
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

type OutputEvent = {
  stream: "stdout" | "stderr";
  text: string;
};

type DoctorReport = {
  bad: string[];
  checks: Record<string, string>;
  detail: string[];
  events: OutputEvent[];
  warnings: string[];
};

function emitOutputEvents(events: readonly OutputEvent[]): void {
  for (const event of events) {
    if (event.stream === "stdout") {
      console.log(event.text);
    } else {
      console.error(event.text);
    }
  }
}

function appendUnique(target: string[], values: readonly string[]): string[] {
  const seen = new Set(target);
  const added: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    target.push(value);
    added.push(value);
  }
  return added;
}

function doctorReport(config: WorkspaceConfig): DoctorReport {
  const bad: string[] = [];
  const checks: Record<string, string> = {};
  const detail: string[] = [];
  const events: OutputEvent[] = [];

  const structural = structureErrors(config);
  bad.push(...structural);
  detail.push(...structural);
  checks.structure = structural.length === 0 ? "ok" : "fail";

  const stdout = (line: string) => events.push({ stream: "stdout", text: line });
  const stderr = (lines: string[]) => {
    detail.push(...lines);
    if (lines.length > 0) events.push({ stream: "stderr", text: lines.join("\n") });
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

  if (config.skills) {
    const errors = workspaceSkillErrors(".", config.skills);
    if (errors.length > 0) {
      stderr(errors);
      bad.push("skills check failed (exit 1)");
      checks.skills = "fail";
    } else {
      stdout("skills ok");
      checks.skills = "ok";
    }
  }

  if (config.confidential) {
    const result = confidentialReport(config.confidential);
    if (result.errors.length > 0) {
      stderr(result.errors);
      bad.push("confidential check failed (exit 1)");
      checks.confidential = "fail";
    } else {
      stdout(confidentialSummary(config.confidential, result));
      checks.confidential = "ok";
    }
  }

  // Soft limits are warnings by design: printed, counted, never fatal.
  const warnings = config.limits ? limitWarnings(config.limits) : [];

  return { bad, checks, detail, events, warnings };
}

function doctor(config: WorkspaceConfig, json: boolean): never {
  const report = doctorReport(config);

  if (!json) emitOutputEvents(report.events);
  const warnings = report.warnings;
  if (warnings.length > 0 && !json) console.error(warnings.join("\n"));

  if (json) {
    const failed = Object.values(report.checks).filter((v) => v === "fail").length;
    console.log(
      JSON.stringify({
        status: report.bad.length > 0 ? "fail" : "pass",
        failed,
        warnings: warnings.length,
        checks: report.checks,
        errors: report.detail,
      }),
    );
    process.exit(report.bad.length > 0 ? 1 : 0);
  }

  if (report.bad.length > 0) {
    console.error(report.bad.join("\n"));
    process.exit(1);
  }
  console.log("doctor ok");
  process.exit(0);
}

function verify(state: LoadedConfig, json: boolean): never {
  const report = doctorReport(state.config);
  const checks: Record<string, string> = { config: "ok", ...report.checks };
  const events: OutputEvent[] = [{ stream: "stdout", text: "config ok" }, ...report.events];
  const errors = [...report.detail];
  const failures = [...report.bad];
  const warnings = [
    ...state.unknownKeys.map(
      (key) => `warning: unrecognized key ${key} (ignored by this kit version)`,
    ),
    ...report.warnings,
  ];

  if (state.config.registry?.project) {
    const registryErrors = projectRegistryErrors(".", state.config.registry);
    checks.registry = registryErrors.length === 0 ? "ok" : "fail";
    if (registryErrors.length === 0) {
      events.push({ stream: "stdout", text: "registry ok" });
    } else {
      const added = appendUnique(errors, registryErrors);
      if (added.length > 0) events.push({ stream: "stderr", text: added.join("\n") });
      failures.push("registry validation failed (exit 1)");
    }
  }

  if (state.config.wiki) {
    try {
      const result = wikiBackfill({ root: state.config.wiki.root, dryRun: true });
      checks.wikiBackfill = result.planned.length === 0 ? "ok" : "fail";
      if (result.planned.length === 0) {
        events.push({ stream: "stdout", text: "wiki-backfill ok" });
      } else {
        const added = appendUnique(errors, result.planned);
        if (added.length > 0) events.push({ stream: "stderr", text: added.join("\n") });
        failures.push("wiki backfill check failed (exit 1)");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.wikiBackfill = "fail";
      const added = appendUnique(errors, [message]);
      if (added.length > 0) events.push({ stream: "stderr", text: added.join("\n") });
      failures.push("wiki backfill check failed (exit 1)");
    }
  }

  if (json) {
    const failed = Object.values(checks).filter((value) => value === "fail").length;
    console.log(
      JSON.stringify({
        status: failures.length === 0 ? "pass" : "fail",
        failed,
        warnings: warnings.length,
        checks,
        errors,
      }),
    );
    process.exit(failures.length === 0 ? 0 : 1);
  }

  emitOutputEvents(events);
  if (warnings.length > 0) console.error(warnings.join("\n"));
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("verify ok");
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
    console.log("next: replace the AGENTS.md TODOs using @uinaf/workspace-kit/docs/convention.md");
    if (result.created.includes(".githooks/pre-commit")) {
      console.log("enable the hook with: npm run hooks:install");
    }
    process.exit(0);
  }

  chdirToRepoRoot();

  if (command === "verify") {
    const json = rest.includes("--json");
    if (rest.some((arg) => arg !== "--json")) usageExit();
    try {
      verify(loadConfigStateOrFail(json), json);
    } catch (error) {
      doctorFailure(error instanceof Error ? error.message : String(error), json);
    }
  }

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
      const report = wikiStaleReport(wiki.root, {
        revisionStaleness: wiki.revisionStaleness,
      });
      if (report.fatal) failWith(report.fatal);
      for (const line of report.err) console.error(line);
      for (const line of report.out) console.log(line);
      process.exit(0);
    }
    const dryRun = args.length === 1 && args[0] === "--dry-run";
    const check = args.length === 1 && args[0] === "--check";
    if (mode === "backfill" && (args.length === 0 || dryRun || check)) {
      const result = wikiBackfill({ root: wiki.root, dryRun: dryRun || check });
      for (const line of result.planned) console.log(line);
      for (const line of result.out) console.log(line);
      process.exit(check && result.planned.length > 0 ? 1 : 0);
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

  if (command === "confidential") {
    const [mode, ...args] = rest;
    if (mode !== "check" || args.length > 0) usageExit();
    const config = loadConfigOrFail();
    const confidential = requireSection(config.confidential, "confidential");
    const result = confidentialReport(confidential);
    if (result.errors.length > 0) {
      console.error(result.errors.join("\n"));
      process.exit(1);
    }
    console.log(confidentialSummary(confidential, result));
    process.exit(0);
  }

  if (command === "registry") {
    const [mode, ...args] = rest;
    const config = loadConfigOrFail();
    const registry = requireSection(config.registry, "registry");
    const errors = projectRegistryErrors(".", registry);
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    if (mode === "validate" && args.length === 0) {
      console.log("registry ok");
      process.exit(0);
    }
    const entries = projectRegistryEntries(".", registry);
    if (mode === "clone" && args.length === 0) process.exit(cloneProjects(entries));
    if (mode === "status" && args.length === 0) process.exit(statusProjects(entries));
    if (mode === "pull" && args.length === 0) process.exit(pullProjects(entries));
    if (mode === "path") {
      const label = args[0];
      if (!label) usageExit();
      let requiredMode: string | undefined;
      if (args.length === 3 && args[1] === "--mode" && args[2]) {
        requiredMode = args[2];
      } else if (args.length !== 1) {
        usageExit();
      }
      try {
        console.log(resolveProjectPath(entries, label, requiredMode));
        process.exit(0);
      } catch (error) {
        failWith(error instanceof Error ? error.message : String(error));
      }
    }
    usageExit();
  }

  if (command === "hooks") {
    const [mode, ...args] = rest;
    if (mode !== "install" || args.length > 0) usageExit();
    try {
      console.log(installHooks(process.cwd()));
      process.exit(0);
    } catch (error) {
      failWith(error instanceof Error ? error.message : String(error));
    }
  }

  if (command === "skills") {
    const [mode, ...args] = rest;
    if (args.length > 0 || (mode !== "check" && mode !== "sync")) usageExit();
    const config = loadConfigOrFail();
    const skills = requireSection(config.skills, "skills");
    if (mode === "check") {
      const errors = workspaceSkillErrors(".", skills);
      if (errors.length > 0) {
        console.error(errors.join("\n"));
        process.exit(1);
      }
      console.log("skills ok");
      process.exit(0);
    }

    const failures = syncWorkspaceSkills(".", skills);
    if (failures.length > 0) {
      console.error(`skill sync failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exit(1);
    }
    console.log("skills synced");
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
    const state = loadConfigStateOrFail();
    for (const key of state.unknownKeys) {
      console.error(`warning: unrecognized key ${key} (ignored by this kit version)`);
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

// Workspace scaffolder. Writes owner-editable structural skeletons and
// kit-owned validation commands. Existing files remain unchanged.
import { mkdirSync, realpathSync } from "node:fs";
import { CONSUMER_PACKAGE_MANAGER } from "./checks/packageManager.ts";
import { parseWorkspaceConfig, type MemoryConfig } from "./config.ts";
import { kitVersion } from "./version.ts";
import { wikiBackfill } from "./checks/wikiBackfill.ts";
import {
  createWorkspaceLink,
  readWorkspaceText,
  workspaceLstat,
  writeWorkspaceText,
} from "./lib/workspaceFs.ts";

export type Profile = "personal" | "runtime" | "work";
export type InitResult = { created: string[]; skipped: string[] };

function memoryInstructions(memory: MemoryConfig | undefined): string {
  if (memory?.strategy === "hindsight") {
    const retrieval =
      memory.integration === "coding-agent"
        ? "Search Hindsight knowledge pages before re-deriving repository history. Use deeper reflection only when those pages are insufficient."
        : "Use the OpenClaw Hindsight plugin's bank for the active session context. Do not select another repository or channel bank.";
    return `## Memory

This repository uses the \`${memory.integration}\` Hindsight integration under
the \`${memory.namespace}\` namespace. ${retrieval}
Keep current policy and operational contracts in repository documentation;
Hindsight owns retained experience and recall.
`;
  }
  return `## Memory

TODO: define how daily evidence is promoted into the repository-maintained wiki.
`;
}

function agentsSkeleton(memory: MemoryConfig | undefined): string {
  return `# AGENTS.md

<!-- Owner-authored: workspace-kit scaffolds structure only and never edits
     this file again. Replace every TODO with your own operating rules. -->

## Start Here

TODO: what this workspace is, who owns it, and what belongs here.

## Session Start

TODO: what an agent should read first, and when.

${memoryInstructions(memory)}

## Working Agreement

TODO: planning, approval, and scope rules for agents working here.

## Skill Ownership

TODO: name any repo-local skill roots, what belongs in them, and where shared
skills are owned. Installed machine-global copies are not workspace source.

## Validation

Run \`pnpm verify\` before committing.

## Boundaries

TODO: what is private, what may leave this workspace, and how.
`;
}

function packageDefinition(profile: Profile) {
  const scripts: Record<string, string> = {
    doctor: "workspace-kit doctor",
    test: "pnpm verify",
    verify: "workspace-kit verify",
  };
  if (profile === "personal" || profile === "runtime") {
    scripts["registry:check"] = "workspace-kit registry validate";
    scripts["registry:clone"] = "workspace-kit registry clone";
    scripts["registry:status"] = "workspace-kit registry status";
    scripts["registry:pull"] = "workspace-kit registry pull";
    scripts["hooks:install"] = "workspace-kit hooks install";
  }
  return {
    private: true,
    scripts,
    devDependencies: { "@uinaf/workspace-kit": kitVersion() },
    engines: { node: ">=24.18.0" },
    packageManager: CONSUMER_PACKAGE_MANAGER,
  };
}

function packageSkeleton(profile: Profile): string {
  return `${JSON.stringify(packageDefinition(profile), null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCompatiblePackage(root: string, profile: Profile): void {
  if (!workspaceLstat(root, "package.json")) return;
  let existing: unknown;
  try {
    existing = JSON.parse(readWorkspaceText(root, "package.json"));
  } catch (error) {
    throw new Error(`package.json is not usable by init: ${String(error)}`);
  }
  const expected = packageDefinition(profile);
  const scripts = isRecord(existing) && isRecord(existing.scripts) ? existing.scripts : {};
  const dependencies =
    isRecord(existing) && isRecord(existing.devDependencies) ? existing.devDependencies : {};
  const scriptsMatch = Object.entries(expected.scripts).every(
    ([name, command]) => scripts[name] === command,
  );
  const packageManager =
    isRecord(existing) && typeof existing.packageManager === "string"
      ? existing.packageManager
      : undefined;
  if (
    !scriptsMatch ||
    dependencies["@uinaf/workspace-kit"] !== kitVersion() ||
    packageManager !== expected.packageManager
  ) {
    throw new Error(
      `package.json is not compatible with init --profile ${profile}; follow the existing-workspace adoption steps in docs/convention.md`,
    );
  }
}

function wikiPage(title: string, type: string, body: string, today: string): string {
  return `---
title: ${title}
type: ${type}
status: active
updated: ${today}
tags: [${type}]
sources: [AGENTS.md]
---

${body}`;
}

export function initWorkspace(
  dir: string,
  profile: Profile,
  requestedMemory?: MemoryConfig,
): InitResult {
  const created: string[] = [];
  const skipped: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new Error(
      `${dir} is not a usable directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (profile === "work" && requestedMemory?.strategy === "llm-wiki") {
    throw new Error("init --profile work does not scaffold the llm-wiki memory layout");
  }
  const validatedRequestedMemory =
    requestedMemory?.strategy === "hindsight"
      ? parseWorkspaceConfig({ memory: requestedMemory }).memory
      : requestedMemory;
  const root = realpathSync(dir);
  assertCompatiblePackage(root, profile);
  const existingConfig = workspaceLstat(root, "workspace.json")
    ? parseWorkspaceConfig(JSON.parse(readWorkspaceText(root, "workspace.json")))
    : undefined;
  const existingMemory =
    existingConfig?.memory ??
    (existingConfig?.dailyLogs || existingConfig?.wiki
      ? ({ strategy: "llm-wiki" } as const)
      : undefined);
  if (
    existingConfig &&
    validatedRequestedMemory &&
    JSON.stringify(validatedRequestedMemory) !== JSON.stringify(existingMemory)
  ) {
    throw new Error(
      "requested memory configuration conflicts with workspace.json; update the existing workspace explicitly",
    );
  }
  const memory = existingConfig
    ? existingMemory
    : (validatedRequestedMemory ??
      (profile === "personal" || profile === "runtime"
        ? ({ strategy: "llm-wiki" } as const)
        : undefined));
  const seedWikiCatalog =
    memory?.strategy === "llm-wiki" &&
    !workspaceLstat(root, "workspace.json") &&
    !workspaceLstat(root, "memory/wiki/sources") &&
    !workspaceLstat(root, "memory/wiki/tags");

  const put = (rel: string, content: string, mode?: number): void => {
    // lstat-based existence: a pre-existing dangling symlink must count as
    // occupied, or a normal file write would write THROUGH it to an
    // attacker-chosen location in a hostile checkout.
    if (workspaceLstat(root, rel)) {
      skipped.push(rel);
      return;
    }
    writeWorkspaceText(
      root,
      rel,
      content,
      mode === undefined ? { exclusive: true } : { exclusive: true, mode },
    );
    created.push(rel);
  };

  const link = (rel: string, target: string): void => {
    if (workspaceLstat(root, rel)) {
      skipped.push(rel);
      return;
    }
    createWorkspaceLink(root, rel, target);
    created.push(rel);
  };

  put("AGENTS.md", agentsSkeleton(memory));
  link("CLAUDE.md", "AGENTS.md");
  put("package.json", packageSkeleton(profile));
  put("docs/README.md", "# Docs\n\nTODO: index the documents that live under docs/.\n");

  const required = ["AGENTS.md", "CLAUDE.md", "package.json", "docs/README.md", "workspace.json"];
  const links = [{ path: "CLAUDE.md", target: "AGENTS.md" }];
  const config: Record<string, unknown> = {
    minVersion: kitVersion(),
    required,
    links,
    packageManager: { enforce: true },
  };
  if (memory) config.memory = memory;

  if (profile === "personal" || profile === "runtime") {
    put("README.md", "# Workspace\n\nTODO: one paragraph on what this repository is.\n");
    put(".env.example", "# Names only — never values.\n");
    put("projects.json", "{}\n");
    if (memory?.strategy === "llm-wiki") {
      put(
        "memory/wiki/index.md",
        wikiPage(
          "Wiki index",
          "wiki-index",
          "# Wiki index\n\nTODO: link topic pages as they appear.\n",
          today,
        ),
      );
      put(
        "memory/wiki/schema.md",
        wikiPage(
          "Wiki schema",
          "wiki-schema",
          "# Wiki schema\n\nTODO: describe the frontmatter and page conventions this wiki follows.\n",
          today,
        ),
      );
      put("memory/wiki/log.md", wikiPage("Wiki log", "wiki-log", "# Wiki log\n", today));
    }
    put(
      ".githooks/pre-commit",
      `#!/bin/sh
set -e
cd "$(git rev-parse --show-toplevel)"
if ! command -v node >/dev/null 2>&1; then
  echo "pre-commit: node not found; skipping workspace-kit checks" >&2
  exit 0
fi
pnpm verify
`,
      0o755,
    );
    required.push("README.md", ".env.example", "projects.json");
    if (memory?.strategy === "llm-wiki") {
      required.push("memory/wiki/index.md", "memory/wiki/schema.md", "memory/wiki/log.md");
    }
    config.registry = {
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
    };
    if (memory?.strategy === "llm-wiki") {
      config.dailyLogs = { root: "memory", contexts: "memory/contexts" };
      config.wiki = { root: "memory/wiki" };
    }
    config.handoff = {
      paths: [
        "AGENTS.md",
        "MEMORY.md",
        "SOUL.md",
        "TOOLS.md",
        "USER.md",
        "HEARTBEAT.md",
        "IDENTITY.md",
        "projects.json",
        "workspace.contract.json",
        "workspace.json",
      ],
      prefixes: [
        ".agents/skills/",
        "skills/",
        "docs/reference/",
        "docs/runbooks/",
        "memory/",
        "user/",
      ],
    };
    // contract: deliberately absent until an origin remote and a peer exist.
  }

  if (profile === "runtime") {
    put("skills/skills.json", '{\n  "skills": []\n}\n');
    put(".agents/skills/.gitkeep", "");
    link(".claude/skills", "../.agents/skills");
    put(
      "HEARTBEAT.md",
      "# HEARTBEAT.md\n\nTODO: the minimal liveness checks this runtime should run.\n",
    );
    put("IDENTITY.md", "# IDENTITY.md\n\nTODO: this runtime's identity.\n");
    required.push(
      "skills/skills.json",
      ".agents/skills",
      ".claude/skills",
      "HEARTBEAT.md",
      "IDENTITY.md",
    );
    links.push({ path: ".claude/skills", target: "../.agents/skills" });
    config.skills = {};
  }

  put("workspace.json", `${JSON.stringify(config, null, 2)}\n`);
  if (seedWikiCatalog && created.includes("workspace.json")) {
    const options = { root: "memory/wiki", repoRoot: root };
    const plan = wikiBackfill({ ...options, dryRun: true });
    wikiBackfill({ ...options, dryRun: false });
    created.push(...plan.planned.map((line) => line.replace(/^would write /, "")));
  }

  return { created, skipped };
}

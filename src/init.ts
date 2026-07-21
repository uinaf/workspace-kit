// Workspace scaffolder. Writes structural skeletons only — instruction
// content is owner-authored; the kit never writes behavioral prose. Existing
// files are never overwritten.
import { mkdirSync, realpathSync } from "node:fs";
import { kitVersion } from "./version.ts";
import { createWorkspaceLink, workspaceLstat, writeWorkspaceText } from "./lib/workspaceFs.ts";

export type Profile = "personal" | "runtime" | "work";
export type InitResult = { created: string[]; skipped: string[] };

function agentsSkeleton(profile: Profile): string {
  const registryValidation =
    profile === "personal" || profile === "runtime"
      ? "\nRun `npx @uinaf/workspace-kit registry validate` before committing registry changes."
      : "";
  return `# AGENTS.md

<!-- Owner-authored: workspace-kit scaffolds structure only and never edits
     this file again. Replace every TODO with your own operating rules. -->

## Start Here

TODO: what this workspace is, who owns it, and what belongs here.

## Session Start

TODO: what an agent should read first, and when.

## Working Agreement

TODO: planning, approval, and scope rules for agents working here.

## Validation

Run \`npx @uinaf/workspace-kit doctor\` before committing.
${registryValidation}

## Boundaries

TODO: what is private, what may leave this workspace, and how.
`;
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

export function initWorkspace(dir: string, profile: Profile): InitResult {
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
  const root = realpathSync(dir);

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

  put("AGENTS.md", agentsSkeleton(profile));
  link("CLAUDE.md", "AGENTS.md");
  put("docs/README.md", "# Docs\n\nTODO: index the documents that live under docs/.\n");

  const required = ["AGENTS.md", "CLAUDE.md", "docs/README.md", "workspace.json"];
  const config: Record<string, unknown> = {
    minVersion: kitVersion(),
    required,
    links: [{ path: "CLAUDE.md", target: "AGENTS.md" }],
  };

  if (profile === "personal" || profile === "runtime") {
    put("README.md", "# Workspace\n\nTODO: one paragraph on what this repository is.\n");
    put(".env.example", "# Names only — never values.\n");
    put("projects.json", "{}\n");
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
    put(
      ".githooks/pre-commit",
      `#!/bin/sh
set -e
cd "$(git rev-parse --show-toplevel)"
if ! command -v node >/dev/null 2>&1; then
  echo "pre-commit: node not found; skipping workspace-kit checks" >&2
  exit 0
fi
npx --yes @uinaf/workspace-kit@${kitVersion()} doctor
npx --yes @uinaf/workspace-kit@${kitVersion()} registry validate
`,
      0o755,
    );
    required.push("README.md", ".env.example", "projects.json");
    required.push("memory/wiki/index.md", "memory/wiki/schema.md", "memory/wiki/log.md");
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
    config.dailyLogs = { root: "memory", contexts: "memory/contexts" };
    config.wiki = { root: "memory/wiki" };
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
      prefixes: [".agents/skills/", "docs/reference/", "docs/runbooks/", "memory/", "user/"],
    };
    // contract: deliberately absent until an origin remote and a peer exist.
  }

  if (profile === "runtime") {
    put(
      "HEARTBEAT.md",
      "# HEARTBEAT.md\n\nTODO: the minimal liveness checks this runtime should run.\n",
    );
    put("IDENTITY.md", "# IDENTITY.md\n\nTODO: this runtime's identity.\n");
    required.push("HEARTBEAT.md", "IDENTITY.md");
  }

  put("workspace.json", `${JSON.stringify(config, null, 2)}\n`);

  return { created, skipped };
}

// Workspace scaffolder. Writes owner-editable structural skeletons and
// kit-owned validation commands. Existing files remain unchanged.
import { mkdirSync, realpathSync } from "node:fs";
import { CONSUMER_PACKAGE_MANAGER } from "./checks/packageManager.ts";
import { parseWorkspaceConfig } from "./config.ts";
import { kitVersion } from "./version.ts";
import { registryPointers } from "./registryPointers.ts";
import {
  createWorkspaceLink,
  readWorkspaceText,
  workspaceLstat,
  writeWorkspaceText,
} from "./lib/workspaceFs.ts";

export type Profile = "personal" | "runtime" | "work";
export type InitResult = { created: Array<string>; skipped: Array<string> };

const AGENTS_TEMPLATE = `# AGENTS.md

<!-- Owner-authored: workspace-kit scaffolds structure only and never edits
     this file again. Replace every TODO with your own operating rules. -->

## Start Here

TODO: what this workspace is, who owns it, and what belongs here.

## Session Start

TODO: what an agent should read first, and when.

## Projects

Repository pointers: [docs/projects/README.md](docs/projects/README.md).
Edit \`projects.json\`, then run \`pnpm registry:pointers\`.

__KNOWLEDGE__
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

const MEMORY_SECTION = `## Memory

TODO: where durable knowledge lives and how agents update it.
`;

const WIKI_SECTION = `## Knowledge

The wiki is \`docs/\`: [docs/index.md](docs/index.md) lists every page in one
line each, and [docs/log.md](docs/log.md) records each change.

- Read the index before adding a page; extend a page instead of duplicating it.
- List every new page in the index in the same change.
- When sources disagree, record both claims with their sources; never
  overwrite one silently.
- Append \`## [YYYY-MM-DD] summary\` to the log for each change.
`;

const WIKI_INDEX = `# Index

One line per page: a link and what it covers.

- [Log](log.md): dated record of wiki changes.
`;

const WIKI_LOG = "# Log\n";

function packageDefinition(profile: Profile) {
  const scripts: Record<string, string> = {
    doctor: "workspace-kit doctor",
    test: "pnpm verify",
    verify: "workspace-kit verify",
    "registry:check": "workspace-kit registry validate",
    "registry:clone": "workspace-kit registry clone",
    "registry:status": "workspace-kit registry status",
    "registry:pull": "workspace-kit registry pull",
    "registry:pointers": "workspace-kit registry pointers",
  };
  if (profile === "personal" || profile === "runtime") {
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

export function initWorkspace(
  dir: string,
  profile: Profile,
  options: { wiki?: boolean } = {},
): InitResult {
  const created: Array<string> = [];
  const skipped: Array<string> = [];

  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new Error(
      `${dir} is not a usable directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = realpathSync(dir);
  assertCompatiblePackage(root, profile);
  const existingConfig = workspaceLstat(root, "workspace.json")
    ? parseWorkspaceConfig(JSON.parse(readWorkspaceText(root, "workspace.json")))
    : undefined;
  if (existingConfig && options.wiki && !existingConfig.wiki) {
    throw new Error(
      "--wiki conflicts with workspace.json, which has no wiki section; update the existing workspace explicitly",
    );
  }
  const wiki = existingConfig ? existingConfig.wiki !== undefined : options.wiki === true;

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

  put("AGENTS.md", AGENTS_TEMPLATE.replace("__KNOWLEDGE__", wiki ? WIKI_SECTION : MEMORY_SECTION));
  link("CLAUDE.md", "AGENTS.md");
  put("package.json", packageSkeleton(profile));
  const docsIndex = wiki ? "docs/index.md" : "docs/README.md";
  if (wiki) {
    put("docs/index.md", WIKI_INDEX);
    put("docs/log.md", WIKI_LOG);
  } else {
    put("docs/README.md", "# Docs\n\nTODO: index the documents that live under docs/.\n");
  }

  const required = ["AGENTS.md", "CLAUDE.md", "package.json", docsIndex, "workspace.json"];
  const links = [{ path: "CLAUDE.md", target: "AGENTS.md" }];
  const config: Record<string, unknown> = {
    minVersion: kitVersion(),
    required,
    links,
    packageManager: { enforce: true },
  };
  if (wiki) config.wiki = { root: "docs" };
  const seedPointers =
    !workspaceLstat(root, "workspace.json") && !workspaceLstat(root, "docs/projects");

  put("projects.json", "{}\n");
  required.push("projects.json");
  const registry = {
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
    pointers: { dir: "docs/projects" },
  };
  config.registry = registry;

  if (profile === "personal" || profile === "runtime") {
    put("README.md", "# Workspace\n\nTODO: one paragraph on what this repository is.\n");
    put(".env.example", "# Names only — never values.\n");
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
    required.push("README.md", ".env.example");
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
        "docs/projects/",
        "docs/reference/",
        "docs/runbooks/",
        "memory/",
        "user/",
        ...(wiki ? ["docs/"] : []),
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
  const parsedRegistry = parseWorkspaceConfig(config).registry;
  if (seedPointers && parsedRegistry && created.includes("workspace.json")) {
    const plan = registryPointers(root, parsedRegistry, { check: false });
    created.push(...plan.planned.map((line) => line.replace(/^would write /, "")));
  }

  return { created, skipped };
}

import {
  normalizeLinkTarget,
  normalizeWorkspacePath,
  readWorkspaceText,
} from "./lib/workspaceFs.ts";
import { normalizeGitHost } from "./lib/gitRemote.ts";

export type LinkRule = { path: string; target: string };
export type ProjectRegistryConfig = {
  pathPrefix: string;
  modes: string[];
  originHosts: string[];
  catalog?: { field: string; modes: string[] };
};
export type RegistryConfig = {
  file: string;
  entry: { required: string[]; optional: string[] };
  project?: ProjectRegistryConfig;
};
export type DailyLogsConfig = { root: string; contexts: string };
export type WikiConfig = {
  root: string;
  requiredFields: string[];
  indexCoverage: boolean;
  logChronology: boolean;
  revisionStaleness: boolean;
};
export type LimitRule = { pattern: string; maxLines: number };
export type ContractConfig = { file: string };
export type HandoffConfig = { paths: string[]; prefixes: string[] };
export type DocsLinksConfig = { enabled: boolean; exclude: string[] };

export type WorkspaceConfig = {
  minVersion?: string;
  required?: string[];
  forbidden?: string[];
  links?: LinkRule[];
  registry?: RegistryConfig;
  dailyLogs?: DailyLogsConfig;
  wiki?: WikiConfig;
  limits?: LimitRule[];
  contract?: ContractConfig;
  handoff?: HandoffConfig;
  docsLinks?: DocsLinksConfig;
};

export const CONFIG_FILE = "workspace.json";

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${field} must be an array of strings`);
  }
  return value as string[];
}

function workspacePathList(value: unknown, field: string): string[] {
  return stringList(value, field).map((path, index) =>
    normalizeWorkspacePath(path, `${field}[${index}]`),
  );
}

export function portablePathIdentity(path: string): string {
  // Uppercase collapses Unicode aliases that lowercasing misses (for example,
  // long s/S and final sigma/sigma) on common case-insensitive filesystems.
  return path.normalize("NFC").toUpperCase().normalize("NFC");
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

function nonEmptyUniqueStringList(value: unknown, field: string): string[] {
  const values = stringList(value, field);
  if (values.length === 0 || values.some((item) => item.length === 0)) {
    fail(`${field} must be a non-empty array of non-empty strings`);
  }
  if (new Set(values).size !== values.length) fail(`${field} must not contain duplicates`);
  return values;
}

function homePathPrefix(value: unknown, field: string): string {
  const prefix = text(value, field);
  if (
    !prefix.startsWith("~/") ||
    prefix.length <= 2 ||
    !prefix.endsWith("/") ||
    prefix.includes("\\") ||
    prefix.includes("\0") ||
    prefix.includes("//") ||
    prefix
      .slice(2, -1)
      .split("/")
      .some((part) => part === "." || part === ".." || /[ .]$/.test(part))
  ) {
    fail(`${field} must be a portable, traversal-free home-relative directory ending in /`);
  }
  return prefix;
}

type ConfigShape = true | { readonly [key: string]: ConfigShape } | readonly [ConfigShape];

const CONFIG_SHAPE: ConfigShape = {
  $schema: true,
  minVersion: true,
  required: true,
  forbidden: true,
  links: [{ path: true, target: true }],
  registry: {
    file: true,
    entry: { required: true, optional: true },
    project: {
      pathPrefix: true,
      modes: true,
      originHosts: true,
      catalog: { field: true, modes: true },
    },
  },
  dailyLogs: { root: true, contexts: true },
  wiki: {
    root: true,
    requiredFields: true,
    indexCoverage: true,
    logChronology: true,
    revisionStaleness: true,
  },
  limits: [{ pattern: true, maxLines: true }],
  contract: { file: true },
  handoff: { paths: true, prefixes: true },
  docsLinks: { enabled: true, exclude: true },
};

function collectUnknownKeys(value: unknown, shape: ConfigShape, path: string, out: string[]): void {
  if (shape === true) return;
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return;
    value.forEach((entry, index) => collectUnknownKeys(entry, shape[0], `${path}[${index}]`, out));
    return;
  }
  if (!isRecord(value)) return;

  const fields = shape as { readonly [key: string]: ConfigShape };
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(fields, key)) {
      out.push(childPath);
      continue;
    }
    collectUnknownKeys(child, fields[key] as ConfigShape, childPath, out);
  }
}

// Unknown keys are tolerated at load (additive schema evolution across
// staggered kit versions); `config validate` surfaces them as warnings.
export function unknownConfigKeys(value: unknown): string[] {
  const out: string[] = [];
  collectUnknownKeys(value, CONFIG_SHAPE, "", out);
  return out;
}

export function parseWorkspaceConfig(value: unknown): WorkspaceConfig {
  if (!isRecord(value)) fail(`${CONFIG_FILE} must be a JSON object`);
  const out: WorkspaceConfig = {};

  if ("minVersion" in value) {
    const minVersion = text(value.minVersion, "minVersion");
    if (!/^\d+\.\d+\.\d+$/.test(minVersion)) {
      fail("minVersion must be a semver version (X.Y.Z)");
    }
    out.minVersion = minVersion;
  }
  if ("required" in value) out.required = workspacePathList(value.required, "required");
  if ("forbidden" in value) out.forbidden = workspacePathList(value.forbidden, "forbidden");

  if ("links" in value) {
    if (!Array.isArray(value.links)) fail("links must be an array");
    const linkPaths = new Map<string, number>();
    out.links = value.links.map((entry, index) => {
      if (!isRecord(entry)) fail(`links[${index}] must be an object`);
      const path = normalizeWorkspacePath(
        text(entry.path, `links[${index}].path`),
        `links[${index}].path`,
      );
      const pathIdentity = portablePathIdentity(path);
      const previous = linkPaths.get(pathIdentity);
      if (previous !== undefined) {
        fail(`links[${index}].path duplicates links[${previous}].path`);
      }
      linkPaths.set(pathIdentity, index);
      return {
        path,
        target: normalizeLinkTarget(
          path,
          text(entry.target, `links[${index}].target`),
          `links[${index}].target`,
        ),
      };
    });
  }

  if ("registry" in value) {
    if (!isRecord(value.registry)) fail("registry must be an object");
    const entry = value.registry.entry;
    if (!isRecord(entry)) fail("registry.entry must be an object");
    const registry: RegistryConfig = {
      file: normalizeWorkspacePath(text(value.registry.file, "registry.file"), "registry.file"),
      entry: {
        required: stringList(entry.required, "registry.entry.required"),
        optional: "optional" in entry ? stringList(entry.optional, "registry.entry.optional") : [],
      },
    };
    if ("project" in value.registry) {
      if (!isRecord(value.registry.project)) fail("registry.project must be an object");
      const project = value.registry.project;
      const modes = nonEmptyUniqueStringList(project.modes, "registry.project.modes");
      const originHosts = (
        "originHosts" in project
          ? nonEmptyUniqueStringList(project.originHosts, "registry.project.originHosts")
          : ["github.com"]
      ).map(
        (host) =>
          normalizeGitHost(host) ?? fail("registry.project.originHosts must contain valid hosts"),
      );
      registry.project = {
        pathPrefix: homePathPrefix(project.pathPrefix, "registry.project.pathPrefix"),
        modes,
        originHosts,
      };
      if ("catalog" in project) {
        if (!isRecord(project.catalog)) fail("registry.project.catalog must be an object");
        const field = text(project.catalog.field, "registry.project.catalog.field");
        if (!registry.entry.required.includes(field) && !registry.entry.optional.includes(field)) {
          fail(`registry.project.catalog.field must be declared in registry.entry`);
        }
        const catalogModes = nonEmptyUniqueStringList(
          project.catalog.modes,
          "registry.project.catalog.modes",
        );
        if (catalogModes.some((mode) => !modes.includes(mode))) {
          fail("registry.project.catalog.modes must be included in registry.project.modes");
        }
        registry.project.catalog = { field, modes: catalogModes };
      }
    }
    out.registry = registry;
  }

  if ("dailyLogs" in value) {
    if (!isRecord(value.dailyLogs)) fail("dailyLogs must be an object");
    out.dailyLogs = {
      root: normalizeWorkspacePath(text(value.dailyLogs.root, "dailyLogs.root"), "dailyLogs.root"),
      contexts: normalizeWorkspacePath(
        text(value.dailyLogs.contexts, "dailyLogs.contexts"),
        "dailyLogs.contexts",
      ),
    };
  }

  if ("wiki" in value) {
    if (!isRecord(value.wiki)) fail("wiki must be an object");
    const wiki = value.wiki;
    for (const flag of ["indexCoverage", "logChronology", "revisionStaleness"]) {
      if (flag in wiki && typeof wiki[flag] !== "boolean") {
        fail(`wiki.${flag} must be a boolean`);
      }
    }
    out.wiki = {
      root: normalizeWorkspacePath(text(wiki.root, "wiki.root"), "wiki.root"),
      requiredFields:
        "requiredFields" in wiki
          ? stringList(wiki.requiredFields, "wiki.requiredFields")
          : ["title", "type", "status", "updated", "tags", "sources"],
      indexCoverage: wiki.indexCoverage === true,
      logChronology: wiki.logChronology === true,
      revisionStaleness: wiki.revisionStaleness === true,
    };
  }

  if ("limits" in value) {
    if (!Array.isArray(value.limits)) fail("limits must be an array");
    out.limits = value.limits.map((entry, index) => {
      if (!isRecord(entry)) fail(`limits[${index}] must be an object`);
      if (
        typeof entry.maxLines !== "number" ||
        !Number.isInteger(entry.maxLines) ||
        entry.maxLines < 1
      ) {
        fail(`limits[${index}].maxLines must be a positive integer`);
      }
      return {
        pattern: text(entry.pattern, `limits[${index}].pattern`),
        maxLines: entry.maxLines,
      };
    });
  }

  if ("contract" in value) {
    if (!isRecord(value.contract)) fail("contract must be an object");
    out.contract = {
      file: normalizeWorkspacePath(text(value.contract.file, "contract.file"), "contract.file"),
    };
  }

  if ("handoff" in value) {
    if (!isRecord(value.handoff)) fail("handoff must be an object");
    out.handoff = {
      paths:
        "paths" in value.handoff ? workspacePathList(value.handoff.paths, "handoff.paths") : [],
      prefixes:
        "prefixes" in value.handoff
          ? workspacePathList(value.handoff.prefixes, "handoff.prefixes")
          : [],
    };
  }

  if ("docsLinks" in value) {
    if (!isRecord(value.docsLinks)) fail("docsLinks must be an object");
    if ("enabled" in value.docsLinks && typeof value.docsLinks.enabled !== "boolean") {
      fail("docsLinks.enabled must be a boolean");
    }
    out.docsLinks = {
      enabled: value.docsLinks.enabled === true,
      exclude:
        "exclude" in value.docsLinks
          ? workspacePathList(value.docsLinks.exclude, "docsLinks.exclude")
          : [],
    };
  }

  return out;
}

export function readRawConfig(repoRoot = "."): unknown {
  let raw: string;
  try {
    raw = readWorkspaceText(repoRoot, CONFIG_FILE, "config file");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === `${CONFIG_FILE}: file is missing`) fail(`missing ${CONFIG_FILE}`);
    fail(message);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${CONFIG_FILE} is not valid JSON`);
  }
}

export function loadWorkspaceConfig(repoRoot = "."): WorkspaceConfig {
  return parseWorkspaceConfig(readRawConfig(repoRoot));
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type LinkRule = { path: string; target: string };
export type RegistryConfig = {
  file: string;
  entry: { required: string[]; optional: string[] };
};
export type DailyLogsConfig = { root: string; contexts: string };
export type WikiConfig = {
  root: string;
  requiredFields: string[];
  indexCoverage: boolean;
  logChronology: boolean;
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

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

const KNOWN_KEYS = new Set([
  "$schema",
  "minVersion",
  "required",
  "forbidden",
  "links",
  "registry",
  "dailyLogs",
  "wiki",
  "limits",
  "contract",
  "handoff",
  "docsLinks",
]);

// Unknown keys are tolerated at load (additive schema evolution across
// staggered kit versions); `config validate` surfaces them as warnings.
export function unknownConfigKeys(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value).filter((key) => !KNOWN_KEYS.has(key));
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
  if ("required" in value) out.required = stringList(value.required, "required");
  if ("forbidden" in value) out.forbidden = stringList(value.forbidden, "forbidden");

  if ("links" in value) {
    if (!Array.isArray(value.links)) fail("links must be an array");
    out.links = value.links.map((entry, index) => {
      if (!isRecord(entry)) fail(`links[${index}] must be an object`);
      return {
        path: text(entry.path, `links[${index}].path`),
        target: text(entry.target, `links[${index}].target`),
      };
    });
  }

  if ("registry" in value) {
    if (!isRecord(value.registry)) fail("registry must be an object");
    const entry = value.registry.entry;
    if (!isRecord(entry)) fail("registry.entry must be an object");
    out.registry = {
      file: text(value.registry.file, "registry.file"),
      entry: {
        required: stringList(entry.required, "registry.entry.required"),
        optional:
          "optional" in entry
            ? stringList(entry.optional, "registry.entry.optional")
            : [],
      },
    };
  }

  if ("dailyLogs" in value) {
    if (!isRecord(value.dailyLogs)) fail("dailyLogs must be an object");
    out.dailyLogs = {
      root: text(value.dailyLogs.root, "dailyLogs.root"),
      contexts: text(value.dailyLogs.contexts, "dailyLogs.contexts"),
    };
  }

  if ("wiki" in value) {
    if (!isRecord(value.wiki)) fail("wiki must be an object");
    const wiki = value.wiki;
    for (const flag of ["indexCoverage", "logChronology"]) {
      if (flag in wiki && typeof wiki[flag] !== "boolean") {
        fail(`wiki.${flag} must be a boolean`);
      }
    }
    out.wiki = {
      root: text(wiki.root, "wiki.root"),
      requiredFields:
        "requiredFields" in wiki
          ? stringList(wiki.requiredFields, "wiki.requiredFields")
          : ["title", "type", "status", "updated", "tags", "sources"],
      indexCoverage: wiki.indexCoverage === true,
      logChronology: wiki.logChronology === true,
    };
  }

  if ("limits" in value) {
    if (!Array.isArray(value.limits)) fail("limits must be an array");
    out.limits = value.limits.map((entry, index) => {
      if (!isRecord(entry)) fail(`limits[${index}] must be an object`);
      if (typeof entry.maxLines !== "number" || !Number.isInteger(entry.maxLines) || entry.maxLines < 1) {
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
    out.contract = { file: text(value.contract.file, "contract.file") };
  }

  if ("handoff" in value) {
    if (!isRecord(value.handoff)) fail("handoff must be an object");
    out.handoff = {
      paths: "paths" in value.handoff ? stringList(value.handoff.paths, "handoff.paths") : [],
      prefixes:
        "prefixes" in value.handoff
          ? stringList(value.handoff.prefixes, "handoff.prefixes")
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
          ? stringList(value.docsLinks.exclude, "docsLinks.exclude")
          : [],
    };
  }

  return out;
}

export function readRawConfig(repoRoot = "."): unknown {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, CONFIG_FILE), "utf8");
  } catch {
    fail(`missing ${CONFIG_FILE}`);
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

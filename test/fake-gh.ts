// Stands in for `gh api` in release-handoff.test.ts. It serves the GitHub git-data endpoints the
// release config calls from the bare repository at FIXTURE_REMOTE and applies GitHub's
// fast-forward rule to ref updates. If the FIXTURE_RACE file exists, main moves to the commit it
// names just before the version commit is created, once.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Fields = Record<string, unknown>;

const remote = required("FIXTURE_REMOTE");
const prefix = `repos/${required("GITHUB_REPOSITORY")}/`;

function required(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set`);
  return value;
}

function fail(message: string): never {
  process.stderr.write(`gh: ${message}\n`);
  process.exit(1);
}

function git(args: string[], input?: string, index?: string): string {
  return execFileSync(
    "git",
    [
      "--git-dir",
      remote,
      "-c",
      "user.name=GitHub",
      "-c",
      "user.email=noreply@github.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      encoding: "utf8",
      input: input ?? "",
      env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
    },
  ).trim();
}

function text(fields: Fields, key: string): string {
  const value = fields[key];
  if (typeof value !== "string") fail(`field ${key} must be a string`);
  return value;
}

function list(fields: Fields, key: string): unknown[] {
  const value = fields[key];
  if (!Array.isArray(value)) fail(`field ${key} must be an array`);
  return value;
}

// gh api: -f sends strings, -F reads @file and converts booleans, `key[]` appends, and
// `key[][sub]` fills the last object until `sub` repeats.
function addField(fields: Fields, field: string, typed: boolean): void {
  const at = field.indexOf("=");
  const key = field.slice(0, at);
  const raw = field.slice(at + 1);
  const value =
    typed && raw.startsWith("@")
      ? readFileSync(raw.slice(1), "utf8")
      : typed && (raw === "true" || raw === "false")
        ? raw === "true"
        : raw;
  const nested = /^(\w+)\[\]\[(\w+)\]$/.exec(key);
  const appended = /^(\w+)\[\]$/.exec(key);
  if (nested?.[1] && nested[2]) {
    const items = (fields[nested[1]] ??= []) as Fields[];
    const last = items.at(-1);
    if (last && !(nested[2] in last)) last[nested[2]] = value;
    else items.push({ [nested[2]]: value });
  } else if (appended?.[1]) {
    ((fields[appended[1]] ??= []) as unknown[]).push(value);
  } else {
    fields[key] = value;
  }
}

function createTree(fields: Fields): string {
  const scratch = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const index = join(scratch, "index");
  try {
    git(["read-tree", text(fields, "base_tree")], undefined, index);
    for (const entry of list(fields, "tree") as Fields[]) {
      const blob = git(["hash-object", "-w", "--stdin"], text(entry, "content"));
      const cacheinfo = `${text(entry, "mode")},${blob},${text(entry, "path")}`;
      git(["update-index", "--add", "--cacheinfo", cacheinfo], undefined, index);
    }
    return git(["write-tree"], undefined, index);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function createCommit(fields: Fields): string {
  const race = process.env.FIXTURE_RACE;
  if (race && existsSync(race)) {
    git(["update-ref", "refs/heads/main", readFileSync(race, "utf8").trim()]);
    rmSync(race);
  }
  const parents = list(fields, "parents").flatMap((parent) => ["-p", String(parent)]);
  return git(["commit-tree", text(fields, "tree"), ...parents, "-m", text(fields, "message")]);
}

function updateMain(fields: Fields): string {
  const current = git(["rev-parse", "refs/heads/main"]);
  const next = text(fields, "sha");
  const fastForward =
    spawnSync("git", ["--git-dir", remote, "merge-base", "--is-ancestor", current, next]).status ===
    0;
  if (fields.force !== true && !fastForward) fail("Update is not a fast forward (HTTP 422)");
  git(["update-ref", "refs/heads/main", next, current]);
  return next;
}

const [command, ...args] = process.argv.slice(2);
if (command !== "api") fail(`unsupported command ${command}`);

let method = "";
let endpoint = "";
let jq = "";
let silent = false;
const fields: Fields = {};
for (let index = 0; index < args.length; index++) {
  const arg = args[index] ?? "";
  if (arg === "-X") method = args[++index] ?? "";
  else if (arg === "--jq") jq = args[++index] ?? "";
  else if (arg === "--silent") silent = true;
  else if (arg === "-f" || arg === "-F") addField(fields, args[++index] ?? "", arg === "-F");
  else endpoint = arg;
}
method ||= Object.keys(fields).length > 0 ? "POST" : "GET";
if (!endpoint.startsWith(prefix)) fail(`unexpected endpoint ${endpoint}`);

let response: unknown;
switch (`${method} ${endpoint.slice(prefix.length)}`) {
  case "GET git/ref/heads/main":
    response = { object: { sha: git(["rev-parse", "refs/heads/main"]) } };
    break;
  case "POST git/trees":
    response = { sha: createTree(fields) };
    break;
  case "POST git/commits":
    response = { sha: createCommit(fields) };
    break;
  case "PATCH git/refs/heads/main":
    response = { object: { sha: updateMain(fields) } };
    break;
  default:
    fail(`unexpected request ${method} ${endpoint}`);
}

if (jq) {
  const value = jq
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((node, key) => (node as Fields)[key], response);
  process.stdout.write(`${String(value)}\n`);
} else if (!silent) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

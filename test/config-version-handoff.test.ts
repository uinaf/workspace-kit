import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vite-plus/test";
import { isPrivateHandoffPath, loadContract } from "../src/checks/contract.ts";
import { parseWorkspaceConfig, unknownConfigKeys } from "../src/config.ts";
import { resolveKitVersion } from "../src/version.ts";

test("config reports nested unknown keys and canonicalizes repository paths", () => {
  const raw = {
    required: ["./AGENTS.md"],
    forbidden: ["private\\secrets.md"],
    links: [{ path: "./nested//CLAUDE.md", target: "..\\AGENTS.md", targt: "typo" }],
    registry: {
      file: "./projects.json",
      entry: { required: ["name"], optional: [] },
      project: {
        pathPrefix: "~/projects/",
        modes: ["managed"],
        originHosts: ["GitLab.com"],
      },
    },
    dailyLogs: { root: "./memory", contexts: "memory\\contexts" },
    wiki: {
      root: "./memory//wiki",
      indexCoverage: false,
      revisionStaleness: true,
      indexCoverge: true,
    },
    contract: { file: ".\\workspace.contract.json" },
    handoff: { paths: [], prefixes: ["memory/"], prefxies: [] },
  };

  assert.deepEqual(unknownConfigKeys(raw), [
    "links[0].targt",
    "wiki.indexCoverge",
    "handoff.prefxies",
  ]);

  const parsed = parseWorkspaceConfig(raw);
  assert.deepEqual(parsed.required, ["AGENTS.md"]);
  assert.deepEqual(parsed.forbidden, ["private/secrets.md"]);
  assert.deepEqual(parsed.links, [{ path: "nested/CLAUDE.md", target: "../AGENTS.md" }]);
  assert.equal(parsed.registry?.file, "projects.json");
  assert.deepEqual(parsed.registry?.project?.originHosts, ["gitlab.com"]);
  assert.deepEqual(parsed.dailyLogs, { root: "memory", contexts: "memory/contexts" });
  assert.equal(parsed.wiki?.root, "memory/wiki");
  assert.equal(parsed.wiki?.revisionStaleness, true);
  assert.equal(parsed.contract?.file, "workspace.contract.json");
});

test("revision staleness is opt-in and must be boolean", () => {
  const parsed = parseWorkspaceConfig({ wiki: { root: "memory/wiki" } });
  assert.equal(parsed.wiki?.revisionStaleness, false);
  assert.throws(
    () =>
      parseWorkspaceConfig({
        wiki: { root: "memory/wiki", revisionStaleness: "true" },
      }),
    /wiki\.revisionStaleness must be a boolean/,
  );
});

test("config rejects duplicate origin hosts after normalization", () => {
  assert.throws(
    () =>
      parseWorkspaceConfig({
        registry: {
          file: "projects.json",
          entry: { required: [], optional: [] },
          project: {
            pathPrefix: "~/projects/",
            modes: ["managed"],
            originHosts: ["Git.Example.com", "git.example.com"],
          },
        },
      }),
    /registry\.project\.originHosts must not contain duplicates after normalization/,
  );
});

test("config rejects repository paths and link targets that escape the workspace", () => {
  assert.throws(
    () => parseWorkspaceConfig({ required: ["../outside"] }),
    /required\[0\] must stay inside the workspace/,
  );
  assert.throws(
    () =>
      parseWorkspaceConfig({
        links: [{ path: "nested/CLAUDE.md", target: "../../outside" }],
      }),
    /links\[0\]\.target must stay inside the workspace/,
  );
  assert.throws(
    () => parseWorkspaceConfig({ contract: { file: "C:\\outside.json" } }),
    /contract\.file must stay inside the workspace/,
  );
  assert.throws(
    () => parseWorkspaceConfig({ handoff: { paths: [], prefixes: ["../memory"] } }),
    /handoff\.prefixes\[0\] must stay inside the workspace/,
  );
});

test("config rejects identical and conflicting duplicate link paths", () => {
  assert.throws(
    () =>
      parseWorkspaceConfig({
        links: [
          { path: "CLAUDE.md", target: "AGENTS.md" },
          { path: "./CLAUDE.md", target: "AGENTS.md" },
        ],
      }),
    /links\[1\]\.path duplicates links\[0\]\.path/,
  );
  assert.throws(
    () =>
      parseWorkspaceConfig({
        links: [
          { path: "CLAUDE.md", target: "AGENTS.md" },
          { path: "CLAUDE.md", target: "docs/README.md" },
        ],
      }),
    /links\[1\]\.path duplicates links\[0\]\.path/,
  );
  assert.throws(
    () =>
      parseWorkspaceConfig({
        links: [
          { path: "Alias.md", target: "AGENTS.md" },
          { path: "alias.md", target: "docs/README.md" },
        ],
      }),
    /links\[1\]\.path duplicates links\[0\]\.path/,
  );
  assert.throws(
    () =>
      parseWorkspaceConfig({
        links: [
          { path: "S.md", target: "AGENTS.md" },
          { path: "ſ.md", target: "docs/README.md" },
        ],
      }),
    /links\[1\]\.path duplicates links\[0\]\.path/,
  );
});

test("contract files are read within their own workspace boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-contract-root-"));
  try {
    assert.throws(
      () => loadContract(root, "../outside.json"),
      /contract file must stay inside the workspace/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff screening canonicalizes portable paths and matches prefix roots", () => {
  const handoff = { paths: ["./AGENTS.md"], prefixes: ["./memory//"] };
  for (const path of [
    "AGENTS.md",
    "agents.md",
    "memory",
    "MEMORY",
    "memory\\notes.md",
    "MEMORY\\notes.md",
    "C:private\\file.md",
    "C:\\private\\file.md",
    "\\\\server\\share\\file.md",
    "x\\.env.local",
    "x\\.ENV.LOCAL",
    ".",
  ]) {
    assert.equal(isPrivateHandoffPath(path, handoff), true, path);
  }
  assert.equal(isPrivateHandoffPath("memory-old/notes.md", handoff), false);
  assert.equal(isPrivateHandoffPath("scripts/example.ts", handoff), false);
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function writePackage(root: string, version: string): void {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version })}\n`);
}

test("source version requires full tag history and prefers a newer stamped package", () => {
  const packageOnly = mkdtempSync(join(tmpdir(), "kit-version-package-"));
  const checkout = mkdtempSync(join(tmpdir(), "kit-version-checkout-"));
  const cloneParent = mkdtempSync(join(tmpdir(), "kit-version-clone-"));
  try {
    writePackage(packageOnly, "0.2.0");
    assert.throws(
      () => resolveKitVersion(packageOnly),
      /use a full Git checkout with release tags/,
    );

    writePackage(checkout, "0.1.0");
    git(checkout, ["init", "-q"]);
    git(checkout, ["add", "package.json"]);
    git(checkout, [
      "-c",
      "user.name=Fixture User",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "initial",
    ]);
    git(checkout, ["-c", "tag.gpgSign=false", "tag", "v0.3.0"]);
    assert.equal(resolveKitVersion(checkout), "0.3.0");

    writeFileSync(join(checkout, "marker.txt"), "after release\n");
    git(checkout, ["add", "marker.txt"]);
    git(checkout, [
      "-c",
      "user.name=Fixture User",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "after release",
    ]);
    const shallow = join(cloneParent, "shallow");
    git(cloneParent, [
      "clone",
      "-q",
      "--depth",
      "1",
      "--no-tags",
      pathToFileURL(checkout).href,
      shallow,
    ]);
    assert.throws(() => resolveKitVersion(shallow), /shallow checkout/);

    writePackage(checkout, "0.4.0");
    assert.equal(resolveKitVersion(checkout), "0.4.0");
  } finally {
    rmSync(packageOnly, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
    rmSync(cloneParent, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { docsLinkErrors } from "../src/checks/docsLinks.ts";
import { parseWorkspaceConfig, type DocsLinksConfig } from "../src/config.ts";

const config: DocsLinksConfig = { enabled: true, exclude: [] };

function repository(): string {
  const dir = mkdtempSync(join(tmpdir(), "docs-links-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function put(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function track(dir: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
}

function check(dir: string, checkConfig = config): string[] {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return docsLinkErrors(checkConfig);
  } finally {
    process.chdir(previous);
  }
}

test("docs links supports its bounded inline and reference destination syntax", () => {
  const dir = repository();
  put(dir, "AGENTS.md", "# Agents\n");
  put(dir, "docs/a(b).md", "# Parentheses\n");
  put(dir, "docs/a b.md", "# Space\n");
  put(dir, "docs/a#b.md", "# Hash\n");
  put(dir, "assets/image(one).png", "not really a png\n");
  put(
    dir,
    "docs/links.md",
    [
      "# Links",
      "",
      "[nested [label]](a(b).md)",
      "[angle](<a b.md>)",
      "[encoded](a%23b.md?raw=1#preview)",
      "[titled](../AGENTS.md (Agent guide))",
      "![image](../assets/image(one).png)",
      "[agent][guide]",
      '[guide]: ../AGENTS.md "Guide"',
      "",
      "`[inline code](missing.md)`",
      "",
      "~~~md",
      "[tilde fence](missing.md)",
      "~~~",
      "",
      "```md",
      "[backtick fence](missing.md)",
      "```",
      "",
    ].join("\n"),
  );
  track(dir);

  assert.deepEqual(check(dir), []);
});

test("docs links reports broken inline, image, reference, and malformed destinations", () => {
  const dir = repository();
  put(
    dir,
    "README.md",
    [
      "[inline](gone(one).md)",
      "![image](<missing image.png>)",
      "[reference][missing]",
      "[missing]: absent.md",
      "[malformed](%zz)",
      "",
    ].join("\n"),
  );
  track(dir);

  assert.deepEqual(check(dir), [
    "README.md: broken link (gone(one).md)",
    "README.md: broken link (missing image.png)",
    "README.md: broken link (absent.md)",
    "README.md: broken link (%zz)",
  ]);
});

test("docs links skips tracked symlink leaves and reports missing tracked Markdown", () => {
  const dir = repository();
  put(dir, "README.md", "# Readme\n");
  mkdirSync(join(dir, "docs"), { recursive: true });
  symlinkSync("missing.md", join(dir, "docs", "linked.md"));
  put(dir, "docs/deleted.md", "[missing](gone.md)\n");
  track(dir);
  rmSync(join(dir, "docs", "deleted.md"));

  assert.deepEqual(check(dir), ["docs/deleted.md: tracked Markdown file is missing"]);
});

test("docs links resolves Git paths with POSIX semantics and exact traversal checks", () => {
  const dir = repository();
  put(dir, "..notes.md", "# Notes\n");
  put(dir, "README.md", "[notes](..notes.md)\n[escape](../outside.md)\n");
  track(dir);

  assert.deepEqual(check(dir), ["README.md: broken link (../outside.md)"]);
});

test("docs links rejects non-portable tracked Markdown paths", () => {
  if (process.platform === "win32") return;
  const dir = repository();
  put(dir, "docs/literal.md", "# Portable spelling\n");
  put(dir, "docs\\literal.md", "[silently missed before](missing.md)\n");
  track(dir);

  assert.deepEqual(check(dir), ["docs\\literal.md: tracked Markdown path is not portable"]);
});

test("docs link exclusions match only the configured path boundary", () => {
  const dir = repository();
  put(dir, "docs/generated/broken.md", "[ignored](missing.md)\n");
  put(dir, "docs/generated-old.md", "[checked](missing.md)\n");
  track(dir);

  const parsed = parseWorkspaceConfig({
    docsLinks: { enabled: true, exclude: ["docs/generated/"] },
  });
  assert.ok(parsed.docsLinks);
  assert.deepEqual(check(dir, parsed.docsLinks), [
    "docs/generated-old.md: broken link (missing.md)",
  ]);
});

test("docs links does not treat GFM footnote prose as a reference destination", () => {
  const dir = repository();
  put(dir, "README.md", "Text with a footnote[^1].\n\n[^1]: prose.md is not a link.\n");
  track(dir);

  assert.deepEqual(check(dir), []);
});

import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { parseGitRemote } from "../src/lib/gitRemote.ts";

test("Git remotes normalize supported forms and nested repository paths", () => {
  assert.deepEqual(parseGitRemote("https://github.com/owner/repository.git"), {
    host: "github.com",
    repository: "owner/repository",
  });
  assert.deepEqual(parseGitRemote("git@GitLab.com:group/subgroup/repository.git"), {
    host: "gitlab.com",
    repository: "group/subgroup/repository",
  });
  assert.deepEqual(parseGitRemote("ssh://git@git.example.com/platform/ai/service"), {
    host: "git.example.com",
    repository: "platform/ai/service",
  });
});

test("Git remotes reject unsafe or ambiguous origins", () => {
  for (const remote of [
    "https://user@github.com/owner/repository.git",
    "https://github.com/owner/repository.git?ref=main",
    "https://github.com/owner/repository.git#readme",
    "https://github.com/owner//repository.git",
    "https://github.com/owner/../repository.git",
    "https://github.com/owner/repository.git.git",
  ]) {
    assert.equal(parseGitRemote(remote), undefined, remote);
  }
});

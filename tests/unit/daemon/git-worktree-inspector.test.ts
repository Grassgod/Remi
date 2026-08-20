import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  chmodSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IsomorphicGitWorktreeInspector } from "@daemon/agent-runtime/workspace/git-worktree-inspector.js";

describe("IsomorphicGitWorktreeInspector", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reads native Git worktree metadata and detects local and unpushed changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-git-inspector-"));
    roots.push(root);
    const workspace = join(root, "MUL-1");
    const repo = join(workspace, "repo");
    const source = join(root, "source");
    const remote = join(root, "origin.git");
    git(root, ["init", "--bare", remote]);
    git(root, ["init", "--initial-branch=main", source]);
    git(source, ["config", "user.email", "agent@example.test"]);
    git(source, ["config", "user.name", "Agent"]);
    writeFileSync(join(source, "README.md"), "initial\n");
    git(source, ["add", "README.md"]);
    git(source, ["commit", "-m", "initial"]);
    git(source, ["remote", "add", "origin", remote]);
    git(source, ["push", "-u", "origin", "main"]);
    git(source, ["gc", "--aggressive", "--prune=now"]);
    mkdirSync(workspace);
    git(source, ["worktree", "add", "-b", "agent/MUL-1", repo, "main"]);
    const index = resolve(repo, git(repo, ["rev-parse", "--git-dir"]), "index");
    utimesSync(join(repo, "README.md"), new Date(), new Date(Date.now() + 60_000));
    const indexBefore = readFileSync(index);
    const indexMtimeBefore = statSync(index, { bigint: true }).mtimeNs;

    const inspector = new IsomorphicGitWorktreeInspector();
    try {
      expect(await inspector.hasDirtyWorktree(workspace)).toBe(false);
      expect(readFileSync(index).equals(indexBefore)).toBe(true);
      expect(statSync(index, { bigint: true }).mtimeNs).toBe(indexMtimeBefore);

      writeFileSync(join(repo, "local.txt"), "dirty\n");
      expect(await inspector.hasDirtyWorktree(workspace)).toBe(true);
      git(repo, ["add", "local.txt"]);
      git(repo, ["commit", "-m", "local"]);
      expect(await inspector.hasDirtyWorktree(workspace)).toBe(true);

      git(repo, ["push", "-u", "origin", "agent/MUL-1"]);
      expect(await inspector.hasDirtyWorktree(workspace)).toBe(false);
    } finally {
      inspector.close();
    }
  });

  it("fails closed for repositories containing Git links", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-gitlink-inspector-"));
    roots.push(root);
    const workspace = join(root, "MUL-2");
    const repo = join(workspace, "repo");
    const source = join(root, "source");
    const submodule = join(root, "submodule");
    git(root, ["init", "--initial-branch=main", submodule]);
    git(submodule, ["config", "user.email", "agent@example.test"]);
    git(submodule, ["config", "user.name", "Agent"]);
    writeFileSync(join(submodule, "README.md"), "submodule\n");
    git(submodule, ["add", "README.md"]);
    git(submodule, ["commit", "-m", "initial submodule"]);
    git(root, ["init", "--initial-branch=main", source]);
    git(source, ["config", "user.email", "agent@example.test"]);
    git(source, ["config", "user.name", "Agent"]);
    git(source, ["-c", "protocol.file.allow=always", "submodule", "add", submodule, "vendor/submodule"]);
    git(source, ["commit", "-m", "add submodule"]);
    mkdirSync(workspace);
    git(source, ["worktree", "add", "-b", "agent/MUL-2", repo, "main"]);

    const inspector = new IsomorphicGitWorktreeInspector();
    expect(await inspector.hasDirtyWorktree(workspace)).toBe(true);
  });

  it("fails closed for a Git link present only in the index", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-staged-gitlink-inspector-"));
    roots.push(root);
    const workspace = join(root, "MUL-3");
    const repo = join(workspace, "repo");
    const submodule = join(root, "submodule");
    git(root, ["init", "--initial-branch=main", submodule]);
    git(submodule, ["config", "user.email", "agent@example.test"]);
    git(submodule, ["config", "user.name", "Agent"]);
    writeFileSync(join(submodule, "README.md"), "submodule\n");
    git(submodule, ["add", "README.md"]);
    git(submodule, ["commit", "-m", "initial submodule"]);
    const submoduleHead = git(submodule, ["rev-parse", "HEAD"]);
    mkdirSync(workspace);
    git(workspace, ["init", "--initial-branch=main", repo]);
    git(repo, ["config", "user.email", "agent@example.test"]);
    git(repo, ["config", "user.name", "Agent"]);
    writeFileSync(join(repo, "README.md"), "parent\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial parent"]);
    git(repo, ["update-index", "--add", "--cacheinfo", `160000,${submoduleHead},vendor/pending`]);

    const inspector = new IsomorphicGitWorktreeInspector();
    expect(await inspector.hasDirtyWorktree(workspace)).toBe(true);
  });

  it("fails closed before parsing an oversized packed object store", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-large-pack-inspector-"));
    roots.push(root);
    const workspace = join(root, "MUL-4");
    const repo = join(workspace, "repo");
    mkdirSync(workspace);
    git(workspace, ["init", "--initial-branch=main", repo]);
    git(repo, ["config", "user.email", "agent@example.test"]);
    git(repo, ["config", "user.name", "Agent"]);
    writeFileSync(join(repo, "README.md"), "parent\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial parent"]);
    mkdirSync(join(repo, ".git", "objects", "pack"), { recursive: true });
    const oversized = join(repo, ".git", "objects", "pack", "oversized.pack");
    writeFileSync(oversized, "");
    truncateSync(oversized, 256 * 1024 * 1024 + 1);

    const inspector = new IsomorphicGitWorktreeInspector();
    expect(await inspector.hasDirtyWorktree(workspace)).toBe(true);
  });

  it("fails closed when Git metadata cannot be inspected", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-unreadable-git-inspector-"));
    roots.push(root);
    const workspace = join(root, "MUL-5");
    const repo = join(workspace, "repo");
    mkdirSync(workspace);
    git(workspace, ["init", "--initial-branch=main", repo]);
    chmodSync(repo, 0o000);
    try {
      const inspector = new IsomorphicGitWorktreeInspector();
      expect(await inspector.hasDirtyWorktree(workspace)).toBe(true);
    } finally {
      chmodSync(repo, 0o700);
    }
  });

  it("fails closed for an invalid workspace", async () => {
    const inspector = new IsomorphicGitWorktreeInspector();
    expect(await inspector.hasDirtyWorktree("invalid\nworkspace")).toBe(true);
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

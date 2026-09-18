import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiRepoCache } from "@multiremi/repo-cache.js";
import { removeOwnedDirectorySync } from "@daemon/agent-runtime/workspace/safe-remove.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    execFileSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("read-only detached Issue worktrees", () => {
  it("captures the local unpushed parent commit, supports git reads, and leaves hooks/excludes untouched", async () => {
    const { cache, barePath, source, parentPath, params } = await fixture();
    writeFileSync(join(parentPath, "README.md"), "local committed code\n");
    git(parentPath, ["commit", "-am", "unpushed parent work"]);
    const commit = git(parentPath, ["rev-parse", "HEAD"]);
    expect(commit).not.toBe(git(source, ["rev-parse", "HEAD"]));
    writeFileSync(join(parentPath, "README.md"), "uncommitted parent code\n");
    const hook = join(barePath, "hooks", "prepare-commit-msg");
    writeFileSync(hook, "#!/bin/sh\n# unchanged hook\n");
    const exclude = join(barePath, "info", "exclude");
    const previousExclude = readFileSync(exclude, "utf8");

    const result = await cache.createWorktree(params);

    expect(result).toMatchObject({
      branchName: "HEAD", branch_name: "HEAD", baseRef: params.ref,
      baseCommit: commit, base_commit: commit, created: true,
    });
    expect(readFileSync(join(result.path, "README.md"), "utf8")).toBe("local committed code\n");
    expect(readFileSync(join(parentPath, "README.md"), "utf8")).toBe("uncommitted parent code\n");
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\n# unchanged hook\n");
    expect(readFileSync(exclude, "utf8")).toBe(previousExclude);
    expect(statSync(result.path).mode & 0o777).toBe(0o555);
    expect(statSync(join(result.path, "README.md")).mode & 0o777).toBe(0o444);
    expect(statSync(join(result.path, ".git")).mode & 0o777).toBe(0o444);
    expect(git(result.path, ["log", "-1", "--format=%H"])).toBe(commit);
    expect(git(result.path, ["blame", "--", "README.md"])).toContain("local committed code");
    expect(git(result.path, ["show", "HEAD:README.md"])).toBe("local committed code");
    expect(git(result.path, ["diff", "--", "README.md"])).toBe("");
    expect(git(result.path, ["status", "--porcelain"])).toBe("");
    // chmod cannot deny root; non-root Linux execution verifies real EACCES.
    if (process.getuid?.() !== 0) {
      expect(() => writeFileSync(join(result.path, "README.md"), "mutated\n")).toThrow();
      expect(() => writeFileSync(join(result.path, "new.txt"), "new\n")).toThrow();
      // Git may still update bare-side HEAD/index and even exit successfully;
      // chmod protects the checkout files, not mutable Git metadata. Mutation
      // commands remain forbidden by the side-conversation prompt.
      try { git(result.path, ["checkout", "HEAD~1"]); } catch {}
      expect(readFileSync(join(result.path, "README.md"), "utf8")).toBe("local committed code\n");
    }
  });

  it("reuses the original detached HEAD after the parent moves or its ref disappears", async () => {
    const { cache, barePath, parentPath, params } = await fixture();
    const first = await cache.createWorktree(params);
    writeFileSync(join(parentPath, "README.md"), "advanced parent\n");
    git(parentPath, ["commit", "-am", "advance parent"]);
    expect(git(parentPath, ["rev-parse", "HEAD"])).not.toBe(first.baseCommit!);
    for (const reuseExisting of [true, false]) {
      expect(await cache.createWorktree({ ...params, reuseExisting })).toEqual({ ...first, created: false });
    }
    git(barePath, ["update-ref", "-d", params.ref]);
    expect(await cache.createWorktree(params)).toEqual({ ...first, created: false });
    expect(git(first.path, ["rev-parse", "HEAD"])).toBe(first.baseCommit!);
  });

  it("resolves explicit OIDs without fetching or selecting a fallback ref", async () => {
    const { cache, source, parentPath, params } = await fixture();
    const commit = git(parentPath, ["rev-parse", "HEAD"]);
    rmSync(source, { recursive: true, force: true });
    expect(await cache.createWorktree({ ...params, ref: commit })).toMatchObject({ baseCommit: commit });
    const nextDir = join(params.workDir, "next");
    for (const ref of [undefined, "main", "agent/MUL-324"]) {
      await expect(cache.createWorktree({ ...params, workDir: nextDir, ref })).rejects
        .toThrow("requires an explicit full ref or commit OID");
    }
    await expect(cache.createWorktree({ ...params, workDir: nextDir, ref: "refs/heads/agent/MISSING" }))
      .rejects.toThrow("rev-parse");
    expect(existsSync(nextDir)).toBe(false);
  });

  it("rejects existing attached worktrees and worktrees registered to another cache", async () => {
    const { cache, source, parentDir, parentPath, params, root } = await fixture();
    await expect(cache.createWorktree({ ...params, workDir: parentDir })).rejects
      .toThrow("refusing to detach an existing branch");
    expect(git(parentPath, ["symbolic-ref", "--short", "HEAD"])).toBe("agent/MUL-324");
    expect(statSync(parentPath).mode & 0o200).toBe(0o200);
    const first = await cache.createWorktree(params);
    const otherCache = new MultiremiRepoCache(join(root, "other-cache"));
    await otherCache.sync("local", [{ url: source }]);
    await expect(otherCache.createWorktree(params)).rejects.toThrow("another repository");
    expect(git(first.path, ["rev-parse", "HEAD"])).toBe(first.baseCommit!);
  });

  it("refuses an occupied or symlinked snapshot path", async () => {
    const { cache, params, root } = await fixture();
    mkdirSync(params.workDir);
    const path = cache.expectedWorktreePath(params.workDir, params.repoUrl);
    mkdirSync(path);
    writeFileSync(join(path, "keep.txt"), "keep\n");
    await expect(cache.createWorktree(params)).rejects.toThrow("not a registered worktree");
    expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("keep\n");
    rmSync(path, { recursive: true });
    symlinkSync(join(root, "missing-target"), path);
    await expect(cache.createWorktree(params)).rejects.toThrow("unsafe managed worktree path");
  });

  it("lets discussion cleanup remove a read-only worktree and prunes its registration on the next add", async () => {
    const { cache, barePath, params, root } = await fixture();
    const first = await cache.createWorktree(params);
    expect(removeOwnedDirectorySync(root, params.workDir)).toBe(true);
    expect(git(barePath, ["worktree", "list", "--porcelain"])).toContain(first.path);
    const next = await cache.createWorktree({ ...params, workDir: join(root, "next-side") });
    const registered = git(barePath, ["worktree", "list", "--porcelain"]);
    expect(registered).not.toContain(first.path);
    expect(registered).toContain(next.path);
    expect(next.baseCommit).toBe(first.baseCommit);
  });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "multiremi-detached-worktree-"));
  roots.push(root);
  const source = join(root, "source");
  git(root, ["init", "-b", "main", source]);
  writeFileSync(join(source, "README.md"), "initial source\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "initial"]);
  const cache = new MultiremiRepoCache(join(root, "cache"));
  await cache.sync("local", [{ url: source }]);
  const barePath = cache.lookup("local", source)!;
  const parentDir = join(root, "parent");
  mkdirSync(parentDir);
  const parentPath = cache.expectedWorktreePath(parentDir, source);
  git(barePath, ["worktree", "add", "-b", "agent/MUL-324", parentPath, "refs/remotes/origin/main"]);
  const params = {
    workspaceId: "local", repoUrl: source, workDir: join(root, "side"),
    ref: "refs/heads/agent/MUL-324", detach: true, skipFetch: true,
  };
  return { cache, barePath, source, parentDir, parentPath, params, root };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*",
      GIT_AUTHOR_NAME: "Multiremi Test", GIT_AUTHOR_EMAIL: "multiremi@example.test",
      GIT_COMMITTER_NAME: "Multiremi Test", GIT_COMMITTER_EMAIL: "multiremi@example.test",
    },
  }).trim();
}

import { test, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { prepareWorkdir, cacheKey, removeWorktree } from "../src/agent/repo.js";

async function run(args: string[], cwd?: string) {
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  await p.exited;
}

test("cacheKey is a deterministic, filesystem-safe name per repo URL", () => {
  expect(cacheKey("https://github.com/org/repo.git")).toBe("github.com+org+repo.git");
  expect(cacheKey("git@code.byted.org:team/svc.git")).toBe("code.byted.org+team+svc.git");
});

test("prepareWorkdir bare-clones a repo and checks out an isolated worktree", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "multimira-repo-"));
  const src = join(tmp, "src");
  await mkdir(src, { recursive: true });

  // a real source repo with one commit
  await run(["git", "init", "-q", "-b", "main"], src);
  await run(["git", "config", "user.email", "t@t.com"], src);
  await run(["git", "config", "user.name", "t"], src);
  await Bun.write(join(src, "README.md"), "hello world");
  await run(["git", "add", "."], src);
  await run(["git", "commit", "-q", "-m", "init"], src);

  try {
    const base = join(tmp, "daemon");
    const r1 = await prepareWorkdir(base, src, "task-aaa");
    // the worktree exists and contains the committed file
    expect(existsSync(r1.workdir)).toBe(true);
    expect(existsSync(join(r1.workdir, "README.md"))).toBe(true);
    expect(await Bun.file(join(r1.workdir, "README.md")).text()).toBe("hello world");
    expect(r1.branch).toBe("multimira/task-aaa");

    // a second task gets its own isolated worktree off the same cache
    const r2 = await prepareWorkdir(base, src, "task-bbb");
    expect(r2.workdir).not.toBe(r1.workdir);
    expect(existsSync(join(r2.workdir, "README.md"))).toBe(true);
    expect(r2.barePath).toBe(r1.barePath); // shared bare cache

    await removeWorktree(r1.barePath, r1.workdir);
    expect(existsSync(join(r1.workdir, "README.md"))).toBe(false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

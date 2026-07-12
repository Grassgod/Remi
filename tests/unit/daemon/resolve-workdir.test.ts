/**
 * Unit tests for resolveWorkDir (persistent workspace path resolution).
 *
 * Pool scheduling makes agent.cwd machine-relative — an agent isn't bound to a
 * machine, so its configured cwd may not exist on whichever pool machine claims
 * the task. resolveWorkDir must only honour agent.cwd when the path is present
 * on this machine, otherwise fall through to the default per-task directory
 * (rather than running in — and mkdir-ing — a wrong/empty path). An explicit
 * machine-affine task.workDir always wins.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkDir } from "@daemon/agent-runtime/workspace/persistent.js";
import type { AgentTask } from "@daemon/contracts/types.js";

const ROOT = "/tmp/multiremi-ws-root";

function task(partial: Record<string, unknown>): AgentTask {
  return { id: "t1", workspaceId: "ws1", workDir: null, agent: null, ...partial } as unknown as AgentTask;
}

test("explicit task.workDir wins over everything (daemon-owned, may create)", () => {
  expect(resolveWorkDir(task({ workDir: "/explicit/dir", agent: { cwd: "/other" } }), ROOT)).toEqual({
    workDir: "/explicit/dir",
    ensureDir: true,
  });
});

test("uses agent.cwd when it is an existing directory, but never recreates it (ensureDir=false)", () => {
  const real = mkdtempSync(join(tmpdir(), "cwd-real-"));
  expect(resolveWorkDir(task({ agent: { cwd: real } }), ROOT)).toEqual({ workDir: real, ensureDir: false });
});

test("falls through to the default per-task dir when agent.cwd is absent here", () => {
  const base = mkdtempSync(join(tmpdir(), "cwd-base-"));
  const missing = join(base, "nope"); // parent exists, child does not
  expect(resolveWorkDir(task({ id: "t9", workspaceId: "wsX", agent: { cwd: missing } }), ROOT)).toEqual({
    workDir: join(ROOT, "wsX", "t9"),
    ensureDir: true,
  });
});

test("ignores an agent.cwd that is a file (not a directory) and uses the default dir", () => {
  const base = mkdtempSync(join(tmpdir(), "cwd-file-"));
  const filePath = join(base, "a-file");
  writeFileSync(filePath, "");
  expect(resolveWorkDir(task({ id: "t7", workspaceId: "wsF", agent: { cwd: filePath } }), ROOT)).toEqual({
    workDir: join(ROOT, "wsF", "t7"),
    ensureDir: true,
  });
});

test("defaults to the per-task dir when neither workDir nor agent.cwd is set", () => {
  expect(resolveWorkDir(task({ id: "t2", workspaceId: "wsY" }), ROOT)).toEqual({
    workDir: join(ROOT, "wsY", "t2"),
    ensureDir: true,
  });
});

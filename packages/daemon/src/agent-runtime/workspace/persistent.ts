/**
 * Persistent workspace path resolution.
 *
 * Computes the (non-ephemeral) working directory for a task: an explicit
 * task.workDir wins, then the agent's fixed cwd, then the default per-task
 * directory under the workspaces root.
 *
 * Pool scheduling makes agent.cwd machine-relative: an agent is no longer
 * bound to one machine, so its configured cwd (a machine-local absolute path)
 * may not exist on whichever pool machine claimed the task. Only honour it when
 * the path is actually present here; otherwise fall through to the default
 * per-task directory instead of running in — and mkdir-ing — a wrong/empty
 * path. task.workDir is machine-affine (the server only stamps a session /
 * local_directory work_dir onto a task pinned to that machine), so it is used
 * as-is.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";

/**
 * `ensureDir` marks a directory the daemon owns and may create: the default
 * per-task dir (generated, won't exist yet) and a machine-affine task.workDir
 * (its machine is pinned; recreated on resume if cleaned up). A validated
 * agent.cwd is NOT ours to create — recreating a vanished machine-local path is
 * exactly what pool scheduling must avoid — so it carries ensureDir=false and
 * the run fails loudly rather than mkdir-ing a wrong/empty path.
 */
export interface ResolvedWorkDir {
  workDir: string;
  ensureDir: boolean;
}

export function resolveWorkDir(
  task: AgentTask,
  workspacesRoot = join(homedir(), ".remi", "multiremi", "workspaces"),
): ResolvedWorkDir {
  if (task.workDir) return { workDir: task.workDir, ensureDir: true };
  // agent.cwd is a machine-local absolute path; under pool scheduling it may
  // not exist on the machine that claimed this task. Honour it only when it is
  // an actual directory here (a file / symlink-to-file would break mkdir and is
  // not a usable cwd), otherwise fall through to the default per-task dir.
  if (task.agent?.cwd && isExistingDir(task.agent.cwd)) {
    return { workDir: task.agent.cwd, ensureDir: false };
  }
  return { workDir: join(workspacesRoot, task.workspaceId, task.id), ensureDir: true };
}

function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

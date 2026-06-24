/**
 * Persistent workspace path resolution.
 *
 * Computes the (non-ephemeral) working directory for a task: an explicit
 * task.workDir wins, then the agent's fixed cwd, then the default per-task
 * directory under the workspaces root. Extracted verbatim from
 * src/multiremi/worker/daemon.ts in D6 (behavior unchanged).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";

export function resolveWorkDir(
  task: AgentTask,
  workspacesRoot = join(homedir(), ".remi", "multiremi", "workspaces"),
): string {
  if (task.workDir) return task.workDir;
  if (task.agent?.cwd) return task.agent.cwd;
  return join(workspacesRoot, task.workspaceId, task.id);
}

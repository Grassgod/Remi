/**
 * Persistent workspace path resolution.
 *
 * Computes the stable daemon-owned working directory for every Task surface:
 * `work/<subject>` for the execution that holds the subject's workspace, and
 * the lane generation's private work set for an Issue discussion execution. Current
 * local_directory assignments are resolved and locked separately.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";
import { laneForTask, laneWorkDirectory, subjectForTask, usesSharedWorkspace, workDirectory } from "./layout.js";

/**
 * `ensureDir` marks a directory the daemon owns and may create.
 */
export interface ResolvedWorkDir {
  workDir: string;
  ensureDir: boolean;
}

export function resolveWorkDir(
  task: AgentTask,
  workspacesRoot = join(homedir(), ".remi", "multiremi", "workspaces"),
): ResolvedWorkDir {
  if (usesSharedWorkspace(task)) {
    return { workDir: workDirectory(workspacesRoot, subjectForTask(task)), ensureDir: true };
  }
  const lane = laneForTask(task);
  if (!lane) throw new Error("discussion task requires an agent");
  if (lane.subject.kind === "issue" && !(task.issueSessionId ?? task.issue_session_id)) {
    throw new Error("discussion task requires an issue session id");
  }
  return { workDir: laneWorkDirectory(workspacesRoot, lane), ensureDir: true };
}

/** Lexical guard; the execution resolver also checks real paths and ownership. */
export function isPathWithinWorkspacesRoot(path: string, workspacesRoot: string): boolean {
  if (!isAbsolute(path)) return false;
  const child = relative(resolve(workspacesRoot), resolve(path));
  return Boolean(child) && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

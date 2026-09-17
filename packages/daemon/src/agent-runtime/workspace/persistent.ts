/**
 * Persistent workspace path resolution.
 *
 * Computes the stable daemon-owned working directory for every Task surface.
 * Chat paths inherited from a provider must remain inside the daemon root.
 * Current local_directory assignments are resolved and locked separately.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";

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
  if (task.chatSessionId) {
    return {
      workDir: task.workDir && isPathWithinWorkspacesRoot(task.workDir, workspacesRoot) ? task.workDir : join(
        workspacesRoot,
        "chats",
        safePathSegment(task.chatSessionId, "chat session id"),
      ),
      ensureDir: true,
    };
  }
  if (task.issue?.key) {
    const issueKey = safePathSegment(task.issue.key, "issue key");
    if (task.holdsWorkspace === false || task.holds_workspace === false) {
      const issueSessionId = task.issueSessionId ?? task.issue_session_id;
      if (!issueSessionId) throw new Error("discussion task requires an issue session id");
      return {
        workDir: join(
          workspacesRoot,
          "discussions",
          issueKey,
          safePathSegment(issueSessionId, "issue session id"),
        ),
        ensureDir: true,
      };
    }
    return { workDir: join(workspacesRoot, "issues", issueKey), ensureDir: true };
  }
  if (task.workDir) return { workDir: task.workDir, ensureDir: true };
  return { workDir: join(workspacesRoot, "tasks", safePathSegment(task.id, "task id")), ensureDir: true };
}

/** Lexical guard; the execution resolver also checks real paths and ownership. */
export function isPathWithinWorkspacesRoot(path: string, workspacesRoot: string): boolean {
  if (!isAbsolute(path)) return false;
  const child = relative(resolve(workspacesRoot), resolve(path));
  return Boolean(child) && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function safePathSegment(value: string, label: string): string {
  const key = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!key || key === "." || key === "..") throw new Error(`invalid ${label} for workspace path: ${JSON.stringify(value)}`);
  return key;
}

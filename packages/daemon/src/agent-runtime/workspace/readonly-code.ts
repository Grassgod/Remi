import type { AgentTask } from "@daemon/contracts/types.js";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { hasReadOnlyCodeSnapshot } from "../prompts/side-conversation.js";
import type { TaskRepoSnapshot } from "../prompts/ephemeral.js";
import { MultiremiRepoCache, normalizeRepoList } from "../repo/checkout.js";
import { writeTaskGcContext } from "../skills/ephemeral.js";

/** Prepare a frozen, local-only view without registering a shared Issue workspace. */
export async function prepareReadOnlyCodeWorkspace(
  workDir: string,
  task: AgentTask,
  cache: MultiremiRepoCache,
  signal?: AbortSignal,
): Promise<{ snapshots: TaskRepoSnapshot[]; checkouts: []; repos: []; warnings: [] }> {
  if (!hasReadOnlyCodeSnapshot(task)
    || !(task.holdsWorkspace === false || task.holds_workspace === false)
    || !task.issue?.key) {
    throw new Error("Read-only code snapshots require an inherited discussion Session");
  }
  for (const path of [workDir, join(workDir, ".multiremi")]) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new Error(`Unsafe read-only discussion workspace: ${path}`);
    }
  }
  // This is the discussion root, not the provider's private .runtime/.../work cwd.
  // Mark it before Git creates anything so partial preparation is collectible too.
  writeTaskGcContext(workDir, task);
  const snapshots: TaskRepoSnapshot[] = [];
  for (const repo of normalizeRepoList(task.repos)) {
    signal?.throwIfAborted();
    if (!cache.lookup(task.workspaceId, repo.url)) {
      throw new Error(`Parent repository is not available on this runtime: ${repo.url}`);
    }
    // Refuse occupied paths or worktrees registered to a different repository.
    cache.hasWorktree({ workspaceId: task.workspaceId, repoUrl: repo.url, workDir });
    const result = await cache.createWorktree({
      workspaceId: task.workspaceId,
      repoUrl: repo.url,
      workDir,
      ref: `refs/heads/agent/${task.issue.key}`,
      detach: true,
      skipFetch: true,
      reuseExisting: true,
      signal,
    });
    if (!result.baseCommit) throw new Error(`Read-only code snapshot has no commit: ${repo.url}`);
    snapshots.push({ repoUrl: repo.url, path: result.path, commit: result.baseCommit });
  }
  return { snapshots, checkouts: [], repos: [], warnings: [] };
}

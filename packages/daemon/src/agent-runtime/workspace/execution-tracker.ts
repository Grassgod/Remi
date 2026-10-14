import { resolve } from "node:path";

/**
 * The executions running on one workspaces root.
 *
 * Provider daemons of one process share a root but not a daemon instance, so the
 * tracker is keyed by root. Reclaim reads it to keep a running subject and to
 * leave a running execution's private temp directory alone.
 */
export class ExecutionTracker {
  private readonly subjectByTask = new Map<string, string>();

  /** Mark an execution as running; the returned function marks it finished. */
  begin(subjectId: string, taskId: string): () => void {
    this.subjectByTask.set(taskId, subjectId);
    return () => {
      this.subjectByTask.delete(taskId);
    };
  }

  taskRunning(taskId: string): boolean {
    return this.subjectByTask.has(taskId);
  }

  subjectRunning(subjectId: string): boolean {
    for (const running of this.subjectByTask.values()) if (running === subjectId) return true;
    return false;
  }
}

const trackers = new Map<string, ExecutionTracker>();

export function executionTrackerFor(root: string): ExecutionTracker {
  const key = resolve(root);
  let tracker = trackers.get(key);
  if (!tracker) {
    tracker = new ExecutionTracker();
    trackers.set(key, tracker);
  }
  return tracker;
}

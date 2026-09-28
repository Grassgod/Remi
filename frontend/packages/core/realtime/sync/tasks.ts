import { normalizeTaskMessage } from "../../chat/normalize-message";
import { appendTaskMessagesToHydratedCache, chatKeys, isTaskMessageTaskId } from "../../chat/queries";
import type { TaskMessagePayload } from "../../types";
import type { SyncContext, SyncModule } from "./types";

/**
 * Live task transcript writes.
 *
 * task:message is written directly into the task-messages cache so the live
 * timeline updates in place, and stays out of the generic prefix-invalidate
 * path (see SPECIFIC_EVENTS in prefix-refresh.ts).
 *
 * Coalesce bursts of task:message frames (a running agent streams many text
 * chunks) into one cache write per task every ~80ms. Each write rebuilds
 * the transcript timeline downstream, so per-frame writes would thrash long
 * transcripts; virtualization only bounds the DOM, not this cost.
 */
export function createTaskHandlers({ qc }: SyncContext): SyncModule {
  const taskMessageBuffer = new Map<string, TaskMessagePayload[]>();
  let taskMessageFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushTaskMessages = () => {
    taskMessageFlushTimer = null;
    for (const [taskId, pending] of taskMessageBuffer) {
      appendTaskMessagesToHydratedCache(qc, taskId, pending);
    }
    taskMessageBuffer.clear();
  };

  return {
    handlers: {
      "task:message": (p) => {
        if (p && typeof p === "object" && "degraded" in p && p.degraded === true) {
          if (!("task_id" in p) || typeof p.task_id !== "string" || !isTaskMessageTaskId(p.task_id)
            || !("seq_start" in p) || !Number.isSafeInteger(p.seq_start) || Number(p.seq_start) < 1
            || !("seq_end" in p) || !Number.isSafeInteger(p.seq_end) || Number(p.seq_end) < Number(p.seq_start)) return;
          taskMessageBuffer.delete(p.task_id);
          void qc.invalidateQueries({ queryKey: chatKeys.taskMessages(p.task_id) });
          return;
        }
        const payload = normalizeTaskMessage(p);
        const pending = taskMessageBuffer.get(payload.task_id) ?? [];
        pending.push(payload);
        taskMessageBuffer.set(payload.task_id, pending);
        if (!taskMessageFlushTimer) taskMessageFlushTimer = setTimeout(flushTaskMessages, 80);
      },
    },
    // Land whatever is still buffered before the subscription goes away, so a
    // workspace switch mid-stream doesn't drop the tail of the transcript.
    dispose: () => {
      if (taskMessageFlushTimer) clearTimeout(taskMessageFlushTimer);
      flushTaskMessages();
    },
  };
}

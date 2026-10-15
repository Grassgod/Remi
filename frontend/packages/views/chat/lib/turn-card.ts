import { isTraceContextUsage, type TraceContextUsage } from "@multiremi/contracts/trace";

/**
 * Whether a turn card row is still in flight. A card with a status is
 * terminal once completed, failed or cancelled; an older card without one is
 * terminal once it carries its elapsed time or a failure.
 */
export function isNonterminalTurn(metadata?: Record<string, unknown>): boolean {
  if (typeof metadata?.status === "string") return !["completed", "failed", "cancelled"].includes(metadata.status);
  return metadata?.elapsed_ms == null && metadata?.failure_reason == null;
}

type TurnRow = { kind: string; task_id?: string | null; metadata?: Record<string, unknown> };

/** The last live usage the ring showed, and the attempt it came from. */
export interface HeldRingUsage {
  taskId: string;
  usage: TraceContextUsage;
}

/**
 * Where the context ring reads from (spec §4.2). While the pending task's turn
 * runs — and its card has not landed terminal — the ring follows that
 * attempt's live trace (`liveTaskId`). `last` is the newest terminal turn
 * card's `metadata.context_usage`, or null when that card predates it. The
 * ring never reads a finished trace.
 *
 * `held` is the last live value: chat-done clears the pending task before the
 * turn's own card lands, so until a terminal card for `held.taskId` is in the
 * log, `last` keeps that value instead of falling back to the previous turn's.
 */
export function contextRingSource(
  rows: readonly TurnRow[],
  pendingTaskId: string | null,
  held: HeldRingUsage | null = null,
): { liveTaskId: string | null; last: TraceContextUsage | null } {
  const landed = (taskId: string) => rows.some((row) => row.kind === "turn" && row.task_id === taskId && !isNonterminalTurn(row.metadata));
  const settled = !!pendingTaskId && landed(pendingTaskId);
  let last: TraceContextUsage | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind !== "turn" || isNonterminalTurn(row.metadata)) continue;
    last = isTraceContextUsage(row.metadata?.context_usage) ? row.metadata.context_usage : null;
    break;
  }
  const liveTaskId = pendingTaskId && !pendingTaskId.startsWith("optimistic-") && !settled ? pendingTaskId : null;
  if (!liveTaskId && held && !landed(held.taskId)) last = held.usage;
  return { liveTaskId, last };
}

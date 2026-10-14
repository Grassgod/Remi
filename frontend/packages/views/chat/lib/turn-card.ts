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

/**
 * Where the context ring reads from (spec §4.2). While the pending task's turn
 * runs — and its card has not landed terminal — the ring follows that
 * attempt's live trace (`liveTaskId`). `last` is the newest terminal turn
 * card's `metadata.context_usage`, or null when that card predates it. The
 * ring never reads a finished trace.
 */
export function contextRingSource(
  rows: readonly TurnRow[],
  pendingTaskId: string | null,
): { liveTaskId: string | null; last: TraceContextUsage | null } {
  const settled = !!pendingTaskId && rows.some((row) => row.kind === "turn" && row.task_id === pendingTaskId && !isNonterminalTurn(row.metadata));
  let last: TraceContextUsage | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind !== "turn" || isNonterminalTurn(row.metadata)) continue;
    last = isTraceContextUsage(row.metadata?.context_usage) ? row.metadata.context_usage : null;
    break;
  }
  const liveTaskId = pendingTaskId && !pendingTaskId.startsWith("optimistic-") && !settled ? pendingTaskId : null;
  return { liveTaskId, last };
}

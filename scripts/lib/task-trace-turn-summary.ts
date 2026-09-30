/**
 * The `turn` card fields of one backfilled task (MUL-432 segment 1, item 8):
 * `event_count`, `tool_call_count`, `type_histogram` and `model`, derived from
 * the events exactly as they are rendered into `traces/<task_id>.jsonl`.
 *
 * The counting is the shared `trace-derive` functions', the ones the daemon's
 * completion report uses, so a backfilled card and a live one bucket the same
 * way: `tool` only on `tool_use` / `tool_result`, the model from the last
 * `execution` event whose meta names both provider and model. `final_reply_md`
 * and `final_entry_id` are not touched; they stay as MUL-427's conversation
 * backfill wrote them.
 */
import type { TraceEvent } from "../../packages/contracts/src/trace.js";
import { countToolCalls, deriveTraceModel, traceTypeHistogram } from "../../packages/shared/src/trace-derive.js";
import type { TraceBackfillTurnSummary } from "../../packages/server/src/store/repos/trace-backfill-progress-repo.js";

/** A rendered event: `traceEventFromRow`'s output or a line read back from a member. */
export interface TraceTurnSummaryEvent {
  seq: unknown;
  ts: unknown;
  type: unknown;
  tool?: unknown;
  meta?: unknown;
}

export class TraceTurnSummaryBuilder {
  private readonly events: TraceEvent[] = [];

  constructor(private readonly taskId: string) {}

  /**
   * Add the next event in file order. Only what the four fields read is kept —
   * type, tool, and the meta of `execution` events — so a long trace does not
   * hold its content in memory.
   */
  add(event: TraceTurnSummaryEvent): void {
    const meta = event.meta && typeof event.meta === "object" && !Array.isArray(event.meta)
      ? event.meta as Record<string, unknown>
      : null;
    this.events.push({
      seq: Number(event.seq),
      ts: String(event.ts ?? ""),
      type: String(event.type),
      tool: typeof event.tool === "string" ? event.tool : null,
      meta: event.type === "execution" ? meta : null,
    });
  }

  finish(): TraceBackfillTurnSummary {
    return {
      taskId: this.taskId,
      eventCount: this.events.length,
      toolCallCount: countToolCalls(this.events),
      typeHistogram: traceTypeHistogram(this.events),
      model: deriveTraceModel(this.events),
    };
  }
}

/** The summary of a task that has no rows, the one its `none` pointer stands for. */
export function emptyTraceTurnSummary(taskId: string): TraceBackfillTurnSummary {
  return new TraceTurnSummaryBuilder(taskId).finish();
}

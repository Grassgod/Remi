/**
 * Derived read-side values over a task's trace: the final reply text, the tool
 * call count, and the `(type, tool)` histogram (MUL-402 ruling 5, A11).
 *
 * Answer semantics also drive the live Feishu and browser projections, so a
 * task's turn card, its Feishu card and the backfilled history agree.
 *
 * Lives in `@multiremi/shared` because the daemon computes these at task
 * completion (for `task.complete` / `task.fail`) and MUL-402's backfill recomputes
 * them for historical turns from the same rows. Two implementations would mean the
 * new cards and the backfilled cards disagree.
 */

import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { extractTraceFinalAnswer, TraceFinalReplyAccumulator } from "./trace-semantics.js";

/** One `(type, tool)` bucket, matching `api/helpers/organizer.ts:52-58`. */
export interface TraceTypeHistogramBucket {
  type: string;
  tool: string | null;
  count: number;
}

/** What a `task.complete` / `task.fail` frame reports about the trace. */
export interface TraceSummary {
  head: number;
  event_count: number;
  tool_call_count: number;
  type_histogram: TraceTypeHistogramBucket[];
}

/**
 * The task's final answer text, in markdown, or null when there is none.
 *
 * The shared answer accumulator also drives Feishu and the browser, so the
 * turn card, the Feishu card and the backfilled history agree:
 *
 *   - a top-level `text` with phase `final` / `final_answer` appends to `final`;
 *   - a top-level `text` with `meta.phase === "commentary"` flushes the candidate
 *     run and starts no new one (commentary renders as reasoning, not as answer);
 *   - any other top-level `text` appends to `candidate`;
 *   - a thought/tool/request/plan/compaction event ends the candidate run;
 *   - nested prose (a `meta.parent_tool_call_id`) never contributes.
 *
 * `final` wins when it has non-whitespace content; otherwise the surviving
 * candidate does. The result is trimmed, matching `answer()`, which returns
 * `final.trim() || candidate.trim() || fallback.trim()`.
 */
export function deriveFinalReply(events: readonly TraceEvent[]): string | null {
  return extractTraceFinalAnswer(events);
}

/** Use/result snapshots share an invocation ID; legacy ID-less uses each count once. */
export function countToolCalls(events: readonly TraceEvent[]): number {
  const ids = new Set<string>();
  let legacy = 0;
  for (const event of events) {
    if (event.type !== "tool_use" && event.type !== "tool_result") continue;
    if (event.tool_call_id) ids.add(event.tool_call_id);
    else if (event.type === "tool_use") legacy += 1;
  }
  return ids.size + legacy;
}

/** Streaming completion figures without retaining the full trace or tool output. */
export function createTraceSummaryAccumulator() {
  const reply = new TraceFinalReplyAccumulator();
  const ids = new Set<string>();
  const buckets = new Map<string, TraceTypeHistogramBucket>();
  let legacy = 0;
  let eventCount = 0;
  let model: { provider: string; model: string } | null = null;
  return {
    add(event: TraceEvent): void {
      eventCount += 1;
      reply.add(event);
      if (event.type === "tool_use" || event.type === "tool_result") {
        if (event.tool_call_id) ids.add(event.tool_call_id);
        else if (event.type === "tool_use") legacy += 1;
      }
      const tool = event.type === "tool_use" || event.type === "tool_result" ? event.tool ?? null : null;
      const key = `${event.type}\u0000${tool ?? ""}`;
      const bucket = buckets.get(key) ?? { type: event.type, tool, count: 0 };
      bucket.count += 1;
      buckets.set(key, bucket);
      const execution = deriveTraceModel([event]);
      if (execution) model = execution;
    },
    completion(head: number) {
      return {
        trace: { head, event_count: eventCount, tool_call_count: ids.size + legacy,
          type_histogram: [...buckets.values()].map(bucket => ({ ...bucket })) },
        final_reply_md: reply.answer(),
        model: model ? { ...model } : null,
      };
    },
  };
}

/**
 * Bucket events by `(type, tool)`.
 *
 * `tool` is only meaningful on `tool_use` / `tool_result` (A11); every other type
 * buckets under a null tool even if a stray `tool` field is present, so the
 * histogram cannot grow a spurious dimension from a malformed event.
 *
 * Buckets are ordered by first appearance, which keeps the output stable for a
 * given trace and comparable between two runs over the same data.
 */
export function traceTypeHistogram(events: readonly TraceEvent[]): TraceTypeHistogramBucket[] {
  const buckets = new Map<string, TraceTypeHistogramBucket>();
  for (const event of events) {
    const tool = event.type === "tool_use" || event.type === "tool_result"
      ? event.tool ?? null
      : null;
    const key = `${event.type}\u0000${tool ?? ""}`;
    const bucket = buckets.get(key) ?? { type: event.type, tool, count: 0 };
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}

/** The `trace` block a `task.complete` / `task.fail` frame carries. */
export function summarizeTrace(events: readonly TraceEvent[], head: number): TraceSummary {
  return {
    head,
    event_count: events.length,
    tool_call_count: countToolCalls(events),
    type_histogram: traceTypeHistogram(events),
  };
}

/**
 * The model that produced the turn, from the last `execution` event's meta.
 *
 * The daemon appends an `execution` event when the model is known
 * (`worker/daemon.ts:4433`, `acp-event-mapper.ts:103`). Returns null when no
 * execution event carried both fields, so the card shows nothing rather than a
 * half-filled model.
 */
export function deriveTraceModel(
  events: readonly TraceEvent[],
): { provider: string; model: string } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "execution") continue;
    const provider = event.meta?.provider;
    const model = event.meta?.model;
    if (typeof provider === "string" && provider && typeof model === "string" && model) {
      return { provider, model };
    }
  }
  return null;
}

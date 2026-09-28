/**
 * Derived read-side values over a task's trace: the final reply text, the tool
 * call count, and the `(type, tool)` histogram (MUL-402 ruling 5, A11).
 *
 * `deriveFinalReply` is an extraction of the rule the Feishu CoT timeline already
 * applies to a live message stream — `connectors/src/feishu/cot-timeline.ts:47-58`
 * — so a task's turn card, its Feishu card and the backfilled history all agree.
 * The connector is not changed by A-0 and does not call this yet; the equivalence
 * test pins the two behaviours together so a future edit to either shows up.
 *
 * Lives in `@multiremi/shared` because the daemon computes these at task
 * completion (for `task.complete` / `task.fail`) and MUL-402's backfill recomputes
 * them for historical turns from the same rows. Two implementations would mean the
 * new cards and the backfilled cards disagree.
 */

import type { TraceEvent } from "@multiremi/contracts/trace.js";

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

/** An event belongs to a nested subagent's prose when it names a parent call. */
function isNested(event: TraceEvent): boolean {
  return Boolean(event.meta?.parent_tool_call_id);
}

/**
 * The types that end a candidate text run.
 *
 * This is the exact list `cot-timeline.ts:56` flushes on, and it is NOT "every
 * non-text event": `tool_result`, `usage`, `execution`, `steer` and the
 * `*_response` types leave the candidate run intact. That matters — a stream of
 * `text`, `usage`, `text` is one run, while `text`, `tool_use`, `text` is two.
 */
const CANDIDATE_FLUSH_TYPES: ReadonlySet<string> = new Set([
  "thinking",
  "tool_use",
  "permission_request",
  "question_request",
  "plan",
  "compaction",
]);

/**
 * The task's final answer text, in markdown, or null when there is none.
 *
 * This mirrors `FeishuCotTimeline`'s `accept` / `answer` pair
 * (`connectors/src/feishu/cot-timeline.ts:47-58` and `:32`) event for event, so
 * the turn card, the Feishu card and the backfilled history agree:
 *
 *   - a top-level `text` with `meta.phase === "final"` appends to `final`;
 *   - a top-level `text` with `meta.phase === "commentary"` flushes the candidate
 *     run and starts no new one (commentary renders as reasoning, not as answer);
 *   - any other top-level `text` appends to `candidate`;
 *   - a `CANDIDATE_FLUSH_TYPES` event ends the candidate run;
 *   - nested prose (a `meta.parent_tool_call_id`) never contributes.
 *
 * `final` wins when it has non-whitespace content; otherwise the surviving
 * candidate does. The result is trimmed, matching `answer()`, which returns
 * `final.trim() || candidate.trim() || fallback.trim()`.
 */
export function deriveFinalReply(events: readonly TraceEvent[]): string | null {
  let final = "";
  let candidate = "";

  for (const event of events) {
    // A nested event returns before the flush switch in the timeline
    // (`cot-timeline.ts:42-46`), so it neither contributes nor ends a run.
    if (isNested(event)) continue;
    if (event.type !== "text") {
      if (CANDIDATE_FLUSH_TYPES.has(event.type)) candidate = "";
      continue;
    }
    const phase = event.meta?.phase;
    if (phase === "final") final += event.content ?? "";
    else if (phase === "commentary") candidate = "";
    else candidate += event.content ?? "";
  }

  return final.trim() || candidate.trim() || null;
}

/** Number of `tool_use` events, the value the turn card's tool counter shows. */
export function countToolCalls(events: readonly TraceEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === "tool_use") count += 1;
  }
  return count;
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

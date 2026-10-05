import type { TraceEvent } from "@multiremi/contracts/trace";

export const TRACE_VIEW_WINDOW_SIZE = 2_000;
export const TRACE_LIVE_WINDOW_SIZE = 200;
export const TRACE_HISTORY_WINDOW_BYTES = 8 * 1024 * 1024;
export const TRACE_LIVE_WINDOW_BYTES = 2 * 1024 * 1024;

/** Merge by sequence and carry known call context before evicting old rows. */
export function mergeTraceWindow(current: readonly TraceEvent[], incoming: readonly TraceEvent[], limit = TRACE_VIEW_WINDOW_SIZE, maxBytes = TRACE_HISTORY_WINDOW_BYTES): TraceEvent[] {
  const bySeq = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySeq.set(event.seq, event);
  const calls = new Map<string, TraceEvent>();
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq).map((event) => {
    const id = event.tool_call_id;
    if (!id || (event.type !== "tool_use" && event.type !== "tool_result")) return event;
    const previous = calls.get(id);
    const concrete = (name: string | null | undefined) => !!name && !["unknown", "tool"].includes(name.toLowerCase());
    const enriched = previous ? {
      ...event,
      tool: concrete(event.tool) ? event.tool : previous.tool ?? event.tool,
      input: previous.input || event.input ? { ...previous.input, ...event.input } : event.input,
      meta: previous.meta || event.meta ? { ...previous.meta, ...event.meta } : event.meta,
    } : event;
    calls.set(id, enriched);
    return enriched;
  });
  let bytes = 0;
  let first = events.length;
  const encoder = new TextEncoder();
  for (let index = events.length - 1; index >= 0 && events.length - index <= limit; index--) {
    const size = encoder.encode(JSON.stringify(events[index])).byteLength;
    // Keep one legal large event readable even if it exceeds this view budget.
    if (first < events.length && bytes + size > maxBytes) break;
    bytes += size;
    first = index;
  }
  return events.slice(first);
}

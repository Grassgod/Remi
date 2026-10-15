// Turn + items trace budgets for the server read-path fixtures (PR 2).
//
// The store caps every event body at TRACE_EVENT_MAX_BYTES (1 MiB) and then adds
// `ts` and `seq`, so the largest stored line is a little over the server's 1 MiB
// page budget. Each case below sits exactly at the ceiling: its stored line is the
// "oversized first event" a page must still return alone, byte-for-byte.
import type { TraceCommandItem, TraceEvent, TraceEventInput, TraceSubagentItem, TraceTurn } from "@multiremi/contracts/trace.js";
import { TRACE_EVENT_MAX_BYTES } from "@shared/trace-sanitize.js";

export const traceJsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The store's clock in these fixtures; an ISO timestamp as `new Date().toISOString()` writes it. */
export const TRACE_BUDGET_FIXTURE_TS = "2026-09-28T00:00:00.000Z";

/**
 * Upper bound of one stored line: a body at the ceiling plus the `ts` the store
 * writes (24 characters) and the largest `seq`. The two keys are spliced into
 * the body's object, so the bytes are the body's plus `{ts, seq}`'s minus one
 * pair of braces plus one comma.
 */
export const TRACE_STORED_EVENT_MAX_BYTES = TRACE_EVENT_MAX_BYTES
  + traceJsonBytes({ ts: TRACE_BUDGET_FIXTURE_TS, seq: Number.MAX_SAFE_INTEGER }) - 2 + 1;

export function fixtureTurn(id: string, patch: Partial<TraceTurn> = {}): TraceTurn {
  return {
    id, turn_id: `turn_${id}`, agent_id: "agt_fixture", agent_name: "Fixture", provider: "codex",
    requested_model: null, model: null, status: "running", error: null,
    started_at: TRACE_BUDGET_FIXTURE_TS, completed_at: null, duration_ms: null, final_item_id: null,
    final_started_at: null, context_usage: null,
    stats: { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [] },
    ...patch,
  };
}

export function commandItem(id: string, command: string): TraceCommandItem {
  return {
    id, parent_id: null, type: "command", status: "completed",
    started_at: TRACE_BUDGET_FIXTURE_TS, completed_at: TRACE_BUDGET_FIXTURE_TS,
    tool: "Bash", source: "shell", command, cwd: null, actions: [], output: null, exit_code: 0, duration_ms: 1,
  };
}

/**
 * A finished subagent whose `prompt` carries `text`. The prompt is not a capped
 * field (a command line is, at 16 KiB), so the item reaches the store, the
 * readers and the page budgets at its full size.
 */
export function bulkItem(id: string, text: string): TraceSubagentItem {
  return {
    id, parent_id: null, type: "subagent", status: "completed",
    started_at: TRACE_BUDGET_FIXTURE_TS, completed_at: TRACE_BUDGET_FIXTURE_TS,
    tool: "Agent", title: null, prompt: text, output: null, duration_ms: 1,
  };
}

/** `item.completed` of a finished agent message. */
export function messageEvent(id: string, text: string): TraceEventInput {
  return {
    type: "item.completed",
    item: {
      id, parent_id: null, type: "agent_message", status: "completed", phase: "unknown", text,
      started_at: TRACE_BUDGET_FIXTURE_TS, completed_at: TRACE_BUDGET_FIXTURE_TS,
    },
  };
}

/** The `turn.started` a running trace begins with. */
export function turnStartedEvent(id: string): TraceEventInput {
  return { type: "turn.started", turn: fixtureTurn(id) };
}

const ascii = (bytes: number) => "a".repeat(bytes);
// "\u0001" serializes as a six-byte escape; the remainder is plain spaces.
const escaped = (bytes: number) => "\u0001".repeat(Math.floor(bytes / 6)) + " ".repeat(bytes % 6);

/** An `item.completed` subagent whose body is exactly the ceiling, carried by its uncapped prompt. */
function ceilingPrompt(id: string, pad: (bytes: number) => string): TraceEventInput {
  const base = { type: "item.completed" as const, item: bulkItem(id, "") };
  return { ...base, item: { ...base.item, prompt: pad(TRACE_EVENT_MAX_BYTES - traceJsonBytes(base)) } };
}

/** A body of a type this contract does not know: opaque to the store, the hub and `view=events`. */
function ceilingFuture(): TraceEventInput {
  const base = { type: "item.future", blob: "" };
  return { ...base, blob: ascii(TRACE_EVENT_MAX_BYTES - traceJsonBytes(base)) } as unknown as TraceEventInput;
}

export const oversizedTraceCases: Array<{ name: string; input: TraceEventInput }> = [
  { name: "ceiling prompt", input: ceilingPrompt("agent_ceiling", ascii) },
  { name: "JSON-expanded prompt", input: ceilingPrompt("agent_escaped", escaped) },
  { name: "unknown future type", input: ceilingFuture() },
];

/** The serialized size of a stored line, the number every case is measured by. */
export function storedEventBytes(event: TraceEvent | Record<string, unknown>): number {
  return traceJsonBytes(event);
}

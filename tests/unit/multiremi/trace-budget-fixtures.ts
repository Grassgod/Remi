import { TRACE_EVENT_STATUSES, type TraceEvent, type TraceEventInput } from "@multiremi/contracts/trace.js";
import { sanitizeStoredEvent } from "@multiremi/worker/trace-store.js";
import {
  TRACE_CONTENT_MAX_BYTES, TRACE_OUTPUT_MAX_BYTES, TRACE_TOOL_MAX_BYTES,
  TRACE_INPUT_MAX_BYTES, TRACE_META_MAX_BYTES, TRACE_TRUNCATION_MARKER,
} from "@shared/trace-sanitize.js";

export const traceJsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const emptyStringBytes = traceJsonBytes("");
const nullablePlaceholder = traceJsonBytes(null) > emptyStringBytes ? null : "";
type NullableTraceField = Exclude<keyof TraceEvent, "seq" | "ts" | "type">;
const nullableSkeleton = {
  tool: nullablePlaceholder, content: nullablePlaceholder, output: nullablePlaceholder,
  input: nullablePlaceholder, meta: nullablePlaceholder, tool_call_id: nullablePlaceholder,
  status: nullablePlaceholder,
} satisfies Record<NullableTraceField, null | string>;
const maxStringBytes = (cap: number) => Math.max(traceJsonBytes(null), emptyStringBytes + 6 * cap
  + traceJsonBytes(TRACE_TRUNCATION_MARKER) - emptyStringBytes);
const fieldMaxBytes: Record<NullableTraceField, number> = {
  tool: maxStringBytes(TRACE_TOOL_MAX_BYTES), content: maxStringBytes(TRACE_CONTENT_MAX_BYTES),
  output: maxStringBytes(TRACE_OUTPUT_MAX_BYTES),
  input: Math.max(traceJsonBytes(null), TRACE_INPUT_MAX_BYTES),
  meta: Math.max(traceJsonBytes(null), TRACE_META_MAX_BYTES),
  tool_call_id: traceJsonBytes(nullablePlaceholder),
  status: Math.max(traceJsonBytes(null), ...TRACE_EVENT_STATUSES.map(traceJsonBytes)),
};

// Conditional bound: type/tool_call_id/ts string contents are empty, all other
// sanitized fields are maximal. A does not cap those three strings; B4 accepts
// arbitrarily long fractional seconds. Count their names/quotes, never contents.
// Every nullable skeleton uses the larger JSON representation of null and "".
// Replace each placeholder with its full capped representation: UTF-8 strings
// can expand x6 and carry A's write marker; input/meta have serialized JSON caps.
export const TRACE_SANITIZED_EVENT_MAX_BYTES = traceJsonBytes({
  seq: Number.MAX_SAFE_INTEGER,
  ts: "", type: "", ...nullableSkeleton,
}) + (Object.keys(nullableSkeleton) as NullableTraceField[]).reduce((bytes, field) =>
  bytes + fieldMaxBytes[field] - traceJsonBytes(nullableSkeleton[field]), 0);

export function traceFiniteEventBytes(event: TraceEvent): number {
  return traceJsonBytes(event) - [event.type, event.tool_call_id, event.ts].reduce<number>((bytes, value) =>
    bytes + (typeof value === "string" ? traceJsonBytes(value) - emptyStringBytes : 0), 0);
}

export const TRACE_BUDGET_FIXTURE_TS = "2026-09-28T00:00:00Z";

function escapedObject(maxBytes: number): Record<string, unknown> {
  const payloadBytes = maxBytes - Buffer.byteLength(JSON.stringify({ value: "" }));
  return { value: "\u0001".repeat(Math.floor(payloadBytes / 6)) + " ".repeat(payloadBytes % 6) };
}

export function maximalNullableTraceInput(ts: string): Omit<TraceEvent, "seq"> {
  return sanitizeStoredEvent({
    type: "x", tool_call_id: null, status: "in_progress",
    tool: "\u0001".repeat(TRACE_TOOL_MAX_BYTES + 1),
    content: "\u0001".repeat(TRACE_CONTENT_MAX_BYTES + 1),
    output: "\u0001".repeat(TRACE_OUTPUT_MAX_BYTES + 1),
    input: escapedObject(TRACE_INPUT_MAX_BYTES), meta: escapedObject(TRACE_META_MAX_BYTES),
  }, ts);
}

export const oversizedTraceCases: Array<{ name: string; input: TraceEventInput }> = [
  { name: "QA tool_call_id", input: {
    type: "tool_result", tool: "Bash", tool_call_id: "i".repeat(1024 * 1024 + 1000),
    status: "completed", output: "",
  } },
  { name: "QA JSON-expanded content", input: { type: "text", content: "\u0001".repeat(180_000) } },
  { name: "contract-limit event", input: {
    type: "tool_result", tool_call_id: "call_contract", status: "in_progress",
    tool: "\u0001".repeat(TRACE_TOOL_MAX_BYTES),
    content: "\u0001".repeat(TRACE_CONTENT_MAX_BYTES),
    output: "\u0001".repeat(TRACE_OUTPUT_MAX_BYTES),
    input: escapedObject(TRACE_INPUT_MAX_BYTES), meta: escapedObject(TRACE_META_MAX_BYTES),
  } },
  { name: "nullable skeleton", input: maximalNullableTraceInput("9999-12-31T23:59:59.999999Z") },
  ...[121, 4 * 1024].map((bytes) => ({
    name: `${bytes}-byte ts`,
    input: maximalNullableTraceInput(`2026-01-01T00:00:00.${"0".repeat(bytes - "2026-01-01T00:00:00.Z".length)}Z`),
  })),
];

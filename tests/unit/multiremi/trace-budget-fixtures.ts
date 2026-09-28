import { TRACE_EVENT_STATUSES, type TraceEventInput } from "@multiremi/contracts/trace.js";
import {
  TRACE_CONTENT_MAX_BYTES, TRACE_OUTPUT_MAX_BYTES, TRACE_TOOL_MAX_BYTES,
  TRACE_INPUT_MAX_BYTES, TRACE_META_MAX_BYTES, TRACE_TRUNCATION_MARKER,
} from "@shared/trace-sanitize.js";

// Finite bound for sanitized fields and the JSON skeleton, excluding the values
// of the uncapped type/tool_call_id strings. This is not a universal event cap.
export const TRACE_SANITIZED_EVENT_MAX_BYTES = Buffer.byteLength(JSON.stringify({
  seq: Number.MAX_SAFE_INTEGER,
  ts: new Date(8.64e15).toISOString(),
  type: "", tool_call_id: "",
  tool: "", content: "", output: "", input: null, meta: null,
  status: TRACE_EVENT_STATUSES.reduce((longest, value) => value.length > longest.length ? value : longest),
}), "utf8")
  + 6 * (TRACE_CONTENT_MAX_BYTES + TRACE_OUTPUT_MAX_BYTES + TRACE_TOOL_MAX_BYTES)
  + 3 * (Buffer.byteLength(JSON.stringify(TRACE_TRUNCATION_MARKER), "utf8") - 2)
  + TRACE_INPUT_MAX_BYTES + TRACE_META_MAX_BYTES - 2 * Buffer.byteLength("null");

export const TRACE_BUDGET_FIXTURE_TS = "2026-09-28T00:00:00Z";

function escapedObject(maxBytes: number): Record<string, unknown> {
  const payloadBytes = maxBytes - Buffer.byteLength(JSON.stringify({ value: "" }));
  return { value: "\u0001".repeat(Math.floor(payloadBytes / 6)) + " ".repeat(payloadBytes % 6) };
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
];

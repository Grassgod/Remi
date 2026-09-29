import { expect, it } from "bun:test";
import { isTraceFileEvent } from "@multiremi/contracts/trace-file.js";
import { sanitizeStoredEvent } from "@multiremi/worker/trace-store.js";
import {
  maximalNullableTraceInput, TRACE_SANITIZED_EVENT_MAX_BYTES,
  traceFiniteEventBytes, traceJsonBytes,
} from "./trace-budget-fixtures.js";

it("bounds the nullable skeleton and exceeds the old empty-string skeleton", () => {
  const ts = "9999-12-31T23:59:59.999999Z";
  const input = maximalNullableTraceInput(ts);
  expect(sanitizeStoredEvent(input, ts)).toEqual(input);
  const event = { ...input, ts, seq: Number.MAX_SAFE_INTEGER };
  expect(isTraceFileEvent(event)).toBe(true);
  expect(event.tool_call_id).toBeNull();
  const finite = traceFiniteEventBytes(event);
  expect(finite).toBeLessThanOrEqual(TRACE_SANITIZED_EVENT_MAX_BYTES);
  const oldEmptySkeletonBound = TRACE_SANITIZED_EVENT_MAX_BYTES - (traceJsonBytes(null) - traceJsonBytes(""));
  expect(finite).toBeGreaterThan(oldEmptySkeletonBound);
  // QA4 counted ts contents: its 27-byte / 121-byte results differ by 94 bytes.
  expect(finite + traceJsonBytes(ts) - traceJsonBytes("")).toBe(2_297_041);
  const longTs = `2026-01-01T00:00:00.${"0".repeat(100)}Z`;
  expect(finite + traceJsonBytes(longTs) - traceJsonBytes("")).toBe(2_297_135);
});

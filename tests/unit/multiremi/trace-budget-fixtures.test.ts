import { expect, it, spyOn } from "bun:test";
import { isTraceFileEvent } from "@multiremi/contracts/trace-file.js";
import { capTraceEvent, TRACE_EVENT_MAX_BYTES } from "@shared/trace-sanitize.js";
import { InMemoryTraceStore } from "@multiremi/worker/trace-store.js";
import { TRACE_READ_MAX_BYTES } from "@multiremi/trace/trace-reader.js";
import {
  oversizedTraceCases, TRACE_BUDGET_FIXTURE_TS, TRACE_STORED_EVENT_MAX_BYTES, storedEventBytes, traceJsonBytes,
} from "./trace-budget-fixtures.js";

for (const { name, input } of oversizedTraceCases) {
  it(`${name} sits exactly at the event ceiling and stores over the page budget`, () => {
    // The fixture is what the store keeps: the caps leave it untouched.
    expect(capTraceEvent(input)).toBe(input);
    expect(traceJsonBytes(input)).toBe(TRACE_EVENT_MAX_BYTES);
    const store = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
    const [stored] = store.append("tsk_budget", [input]).events;
    expect(isTraceFileEvent(stored)).toBe(true);
    expect(storedEventBytes(stored!)).toBeGreaterThan(TRACE_READ_MAX_BYTES);
    expect(storedEventBytes(stored!)).toBeLessThanOrEqual(TRACE_STORED_EVENT_MAX_BYTES);
  });
}

it("one byte over the ceiling, an item loses its largest field and an opaque body is dropped", () => {
  const store = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const { input } of oversizedTraceCases) {
      const over = JSON.parse(JSON.stringify(input)) as Record<string, any>;
      if (over.item) over.item.prompt += "a";
      else over.blob += "a";
      expect(traceJsonBytes(over)).toBe(TRACE_EVENT_MAX_BYTES + 1);
      const stored = store.append("tsk_over", [over as never]).events;
      if (over.item) expect(stored).toMatchObject([{ item: { id: over.item.id, prompt: null } }]);
      else expect(stored).toEqual([]);
    }
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("Trace event dropped"))).toHaveLength(1);
  } finally {
    warn.mockRestore();
  }
  expect(store.head("tsk_over")).toEqual({ head: 2, closed: false });
});

it("bounds a stored line by the ceiling plus the largest ts and seq", () => {
  const largest = TRACE_EVENT_MAX_BYTES + traceJsonBytes({ ts: TRACE_BUDGET_FIXTURE_TS, seq: Number.MAX_SAFE_INTEGER }) - 1;
  expect(TRACE_STORED_EVENT_MAX_BYTES).toBe(largest);
  expect(TRACE_STORED_EVENT_MAX_BYTES - TRACE_READ_MAX_BYTES).toBeLessThan(64);
});

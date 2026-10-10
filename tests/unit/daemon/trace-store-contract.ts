import { describe, expect, it } from "bun:test";
import type { TraceStore } from "@multiremi/worker/trace-store.js";
import { traceEventBytes } from "@multiremi/worker/trace-store.js";
import { TRACE_TRUNCATION_MARKER } from "@shared/trace-sanitize.js";

const NOW = "2026-09-27T00:00:00.000Z";

export function describeTraceStoreContract(
  name: string,
  create: () => TraceStore,
  sparse: () => TraceStore,
): void {
  describe(`${name} TraceStore contract`, () => {
    it("assigns continuous seq and enforces field caps and base64 elision", () => {
      const store = create();
      expect(store.append("tsk_one", [{ type: "text", content: "one" }, { type: "text", content: "two" }]).events.map((e) => e.seq)).toEqual([1, 2]);
      const [event] = store.append("tsk_one", [{
        type: "tool_use", tool: "t".repeat(600), content: "c".repeat(270_000),
        input: { payload: "A".repeat(5000) }, output: "o".repeat(70_000),
        meta: { payload: "!".repeat(70_000) },
      }]).events;
      expect(event!.seq).toBe(3);
      expect(event!.tool!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
      expect(event!.content).toBe("c".repeat(256 * 1024) + TRACE_TRUNCATION_MARKER);
      expect(event!.output!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
      expect(event!.input).toEqual({ payload: "[base64-elided]" });
      expect(event!.meta).toBeNull();
    });

    for (const status of ["completed", "failed", "cancelled"] as const) {
      it(`closes ${status} once, keeps its head, and forgets`, () => {
        const store = create();
        store.append("tsk_one", [{ type: "text", content: status }]);
        store.close("tsk_one", { status, ended_at: NOW });
        // Assert the first close before an idempotent retry can mask a defect.
        expect(store.head("tsk_one")).toEqual({ head: 1, closed: true });
        expect(store.append("tsk_one", [{ type: "text", content: "late" }])).toEqual({ head: 1, events: [] });
        store.close("tsk_one", { status: "failed", ended_at: NOW });
        expect(store.head("tsk_one")).toEqual({ head: 1, closed: true });
        expect(store.append("tsk_one", [{ type: "text", content: "late" }])).toEqual({ head: 1, events: [] });
        expect(store.read("tsk_one").events.map((event) => event.content)).toEqual([status]);
        store.forget("tsk_one");
        expect(store.head("tsk_one")).toBeNull();
        expect(store.read("tsk_one")).toEqual({ events: [], head: 0, eof: true });
      });
    }

    it("pages sparse seq using afterSeq, never an array offset", () => {
      const store = sparse();
      expect(store.read("tsk_one", 0, 1).events.map((e) => e.seq)).toEqual([1]);
      expect(store.read("tsk_one", 1, 1)).toMatchObject({ events: [{ seq: 10 }], eof: false });
      expect(store.read("tsk_one", 10, 1)).toMatchObject({ events: [{ seq: 20 }], eof: true });
    });

    it("normalizes every limit edge to a bounded page", () => {
      const store = create();
      store.append("tsk_one", Array.from({ length: 525 }, () => ({ type: "text", content: "x" })));
      for (const [limit, count] of [
        [undefined, 200], [NaN, 200], [Infinity, 500], [-Infinity, 1],
        [0, 1], [-4, 1], [1.9, 1], [501, 500], [5000, 500],
      ] as const) {
        const page = store.read("tsk_one", 0, limit);
        expect(page.events).toHaveLength(count);
        expect(page.eof).toBe(false);
      }
      expect(store.read("tsk_one", 0, 525).events).toHaveLength(500);
    });

    it("normalizes afterSeq and maxBytes, and admits one oversized event", () => {
      const store = create();
      const events = store.append("tsk_one", [
        { type: "text", content: "a" }, { type: "text", content: "b" }, { type: "text", content: "c" },
      ]).events;
      for (const cursor of [undefined, NaN, -1, -Infinity]) {
        expect(store.read("tsk_one", cursor, 1).events.map((e) => e.seq)).toEqual([1]);
      }
      expect(store.read("tsk_one", 1.9, 1).events.map((e) => e.seq)).toEqual([2]);
      expect(store.read("tsk_one", Infinity)).toEqual({ events: [], head: 3, eof: true });
      expect(store.read("tsk_one", 3)).toEqual({ events: [], head: 3, eof: true });
      for (const budget of [undefined, NaN, Infinity]) {
        expect(store.read("tsk_one", 0, 3, budget).events).toHaveLength(3);
      }
      for (const budget of [0, -1, -Infinity, 0.9, 1]) {
        expect(store.read("tsk_one", 0, 3, budget).events).toEqual([events[0]]);
      }
      const two = traceEventBytes(events[0]!) + traceEventBytes(events[1]!);
      expect(store.read("tsk_one", 0, 3, two).events).toEqual(events.slice(0, 2));
      expect(store.read("tsk_one", 0, 3, two + 0.9).events).toEqual(events.slice(0, 2));
      expect(store.read("tsk_one", 2, 1, 0)).toEqual({ events: [events[2]], head: 3, eof: true });
    });
  });
}

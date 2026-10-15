import { describe, expect, it, spyOn } from "bun:test";
import type { TraceEventInput, TraceItem, TraceTurn, TraceTurnSnapshot } from "@multiremi/contracts/trace.js";
import { TRACE_SNAPSHOT_PART_MAX_BYTES } from "@multiremi/contracts/trace-file.js";
import type { TraceStore } from "@multiremi/worker/trace-store.js";
import { traceEventBytes } from "@multiremi/worker/trace-store.js";
import { TRACE_EVENT_MAX_BYTES, TRACE_ITEM_TEXT_MAX_BYTES, TRACE_TRUNCATION_MARKER } from "@shared/trace-sanitize.js";

export const CONTRACT_NOW = "2026-09-27T00:00:00.000Z";

export function contractTurn(patch: Partial<TraceTurn> = {}): TraceTurn {
  return {
    id: "tsk_one", turn_id: "turn_one", agent_id: "agt", agent_name: "Remi", provider: "claude", requested_model: null,
    model: null, status: "running", error: null, started_at: CONTRACT_NOW, completed_at: null, duration_ms: null,
    final_item_id: null, final_started_at: null, context_usage: null,
    stats: { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [] }, ...patch,
  };
}

export function contractMessage(id: string, text: string, patch: Partial<TraceItem> = {}): TraceItem {
  return { id, parent_id: null, status: "completed", started_at: CONTRACT_NOW, completed_at: CONTRACT_NOW,
    type: "agent_message", text, phase: "unknown", ...patch } as TraceItem;
}

/** One `item.completed` body per text; the store's contract treats bodies as opaque beyond the caps. */
export function contractEvents(...texts: string[]): TraceEventInput[] {
  return texts.map((text, index) => ({ type: "item.completed", item: contractMessage(`msg:${index}:${text.slice(0, 8)}`, text) }));
}

export function contractSnapshot(items: TraceItem[], head: number): TraceTurnSnapshot {
  return { turn: contractTurn({ status: "completed", completed_at: CONTRACT_NOW }), items, head, closed: true };
}

function textOf(event: unknown): string | undefined {
  const item = (event as { item?: { text?: string } }).item;
  return item?.text;
}

export function describeTraceStoreContract(
  name: string,
  create: () => TraceStore,
  sparse: () => TraceStore,
): void {
  describe(`${name} TraceStore contract`, () => {
    it("assigns continuous seq and the write time, overriding producer values", () => {
      const store = create();
      const appended = store.append("tsk_one", [
        ...contractEvents("one"),
        { ...contractEvents("two")[0]!, seq: 99, ts: "2020-01-01T00:00:00.000Z" } as unknown as TraceEventInput,
      ]);
      expect(appended.events.map((e) => e.seq)).toEqual([1, 2]);
      expect(appended.events.every((e) => e.ts === CONTRACT_NOW)).toBe(true);
      expect(store.read("tsk_one").events.map((e) => [e.seq, e.ts])).toEqual([[1, CONTRACT_NOW], [2, CONTRACT_NOW]]);
      expect(store.format("tsk_one")).toBe("v2");
      expect(store.format("tsk_unknown")).toBeNull();
    });

    it("re-applies the item caps and the event ceiling", () => {
      const store = create();
      const [capped] = store.append("tsk_one", contractEvents("c".repeat(TRACE_ITEM_TEXT_MAX_BYTES + 10))).events;
      expect(textOf(capped)).toBe("c".repeat(TRACE_ITEM_TEXT_MAX_BYTES) + TRACE_TRUNCATION_MARKER);
      expect((capped as unknown as { item: { truncated?: true } }).item.truncated).toBe(true);
      // An event that cannot be brought under 1 MiB is dropped, takes no seq, and says so.
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const opaque = { type: "future.event", blob: "x".repeat(1024 * 1024 + 1) } as unknown as TraceEventInput;
        expect(store.append("tsk_one", [opaque]).events).toEqual([]);
        const options = Array.from({ length: 3000 }, (_, i) => ({ option_id: `o${i}`, name: "n".repeat(512), kind: "allow_once" }));
        const permission = { type: "item.started", item: { id: "perm:big", parent_id: null, status: "in_progress",
          started_at: CONTRACT_NOW, completed_at: null, type: "permission", tool_item_id: null, title: "t", message_id: null,
          options, decision: null, outcome: null, responded_by: null, reply_message_id: null } } as TraceEventInput;
        expect(store.append("tsk_one", [permission]).events).toEqual([]);
        const drops = warn.mock.calls.filter((call) => String(call[0]).includes("Trace event dropped"));
        expect(drops).toHaveLength(2);
        expect(drops[0]![1]).toMatchObject({ taskId: "tsk_one", type: "future.event", itemId: null });
        expect(drops[1]![1]).toMatchObject({ taskId: "tsk_one", type: "item.started", itemId: "perm:big", itemType: "permission" });
      } finally {
        warn.mockRestore();
      }
      expect(store.head("tsk_one")).toEqual({ head: 1, closed: false });
      // Other unknown bodies pass through untouched: payloads are opaque to the store.
      const [future] = store.append("tsk_one", [{ type: "future.event", note: "kept" } as unknown as TraceEventInput]).events;
      expect(future).toMatchObject({ seq: 2, type: "future.event", note: "kept" });
    });

    it("stores a 600 KiB heredoc command with its command capped instead of dropping it", () => {
      const store = create();
      const heredoc = `cat <<'EOF' > big.txt\n${"x".repeat(600 * 1024)}\nEOF`;
      const item = { id: "toolu_big", parent_id: null, status: "completed", started_at: CONTRACT_NOW, completed_at: CONTRACT_NOW,
        type: "command", tool: "Bash", source: "shell", command: heredoc, cwd: "/repo", actions: [{ type: "unknown", command: heredoc }],
        output: "", exit_code: 0, duration_ms: 5 } as TraceItem;
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const [stored] = store.append("tsk_one", [{ type: "item.completed", item }]).events;
        expect(stored).toMatchObject({ seq: 1, type: "item.completed", item: { id: "toolu_big", command_truncated: true, exit_code: 0 } });
        expect(traceEventBytes(stored!)).toBeLessThan(TRACE_EVENT_MAX_BYTES);
        expect(warn.mock.calls.some((call) => String(call[0]).includes("Trace event dropped"))).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    for (const status of ["completed", "failed", "cancelled"] as const) {
      it(`closes ${status} once with its snapshot, keeps its head, and forgets`, () => {
        const store = create();
        store.append("tsk_one", contractEvents(status));
        expect(store.snapshotPart("tsk_one", 0)).toBeNull();
        store.close("tsk_one", { status, ended_at: CONTRACT_NOW, snapshot: contractSnapshot([contractMessage("m", status)], 1) });
        // Assert the first close before an idempotent retry can mask a defect.
        expect(store.head("tsk_one")).toEqual({ head: 1, closed: true });
        expect(store.snapshotPart("tsk_one", 0)).toMatchObject({ part: 0, parts: 1, head: 1, items: [{ id: "m", text: status }] });
        expect(store.snapshotPart("tsk_one", 1)).toBeNull();
        expect(store.append("tsk_one", contractEvents("late"))).toEqual({ head: 1, events: [] });
        store.close("tsk_one", { status: "failed", ended_at: CONTRACT_NOW, snapshot: contractSnapshot([], 1) });
        expect(store.head("tsk_one")).toEqual({ head: 1, closed: true });
        expect(store.snapshotPart("tsk_one", 0)?.items).toHaveLength(1);
        expect(store.read("tsk_one").events.map(textOf)).toEqual([status]);
        store.forget("tsk_one");
        expect(store.head("tsk_one")).toBeNull();
        expect(store.read("tsk_one")).toEqual({ events: [], head: 0, eof: true });
      });
    }

    it("closes a trace without a turn with no snapshot parts", () => {
      const store = create();
      store.append("tsk_one", []);
      store.close("tsk_one", { status: "failed", ended_at: CONTRACT_NOW, snapshot: null });
      expect(store.head("tsk_one")).toEqual({ head: 0, closed: true });
      expect(store.snapshotPart("tsk_one", 0)).toBeNull();
    });

    it("splits a large snapshot into consecutive parts of at most 768 KiB", () => {
      const store = create();
      const items = Array.from({ length: 5 }, (_, index) => contractMessage(`m${index}`, String(index).repeat(250 * 1024)));
      store.append("tsk_one", items.map((item) => ({ type: "item.completed", item })));
      store.close("tsk_one", { status: "completed", ended_at: CONTRACT_NOW, snapshot: contractSnapshot(items, 5) });
      const parts = [];
      for (let part = 0; ; part++) {
        const snapshot = store.snapshotPart("tsk_one", part);
        if (!snapshot) break;
        parts.push(snapshot);
      }
      expect(parts.length).toBe(parts[0]!.parts);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.flatMap((part) => part.items.map((item) => item.id))).toEqual(items.map((item) => item.id));
      for (const part of parts) {
        expect(part.turn.status).toBe("completed");
        expect(part.head).toBe(5);
        expect(Buffer.byteLength(JSON.stringify({ snapshot: part }), "utf8")).toBeLessThanOrEqual(TRACE_SNAPSHOT_PART_MAX_BYTES);
      }
    });

    it("pages sparse seq using afterSeq, never an array offset", () => {
      const store = sparse();
      expect(store.read("tsk_one", 0, 1).events.map((e) => e.seq)).toEqual([1]);
      expect(store.read("tsk_one", 1, 1)).toMatchObject({ events: [{ seq: 10 }], eof: false });
      expect(store.read("tsk_one", 10, 1)).toMatchObject({ events: [{ seq: 20 }], eof: true });
    });

    it("normalizes every limit edge to a bounded page", () => {
      const store = create();
      store.append("tsk_one", Array.from({ length: 525 }, () => contractEvents("x")[0]!));
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
      const events = store.append("tsk_one", contractEvents("a", "b", "c")).events;
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
        expect(store.read("tsk_one", 0, 3, budget).events).toEqual([events[0]!]);
      }
      const two = traceEventBytes(events[0]!) + traceEventBytes(events[1]!);
      expect(store.read("tsk_one", 0, 3, two).events).toEqual(events.slice(0, 2));
      expect(store.read("tsk_one", 0, 3, two + 0.9).events).toEqual(events.slice(0, 2));
      expect(store.read("tsk_one", 2, 1, 0)).toEqual({ events: [events[2]!], head: 3, eof: true });
    });
  });
}

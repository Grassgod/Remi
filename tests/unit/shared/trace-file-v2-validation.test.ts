import { describe, expect, it } from "bun:test";
import type { TraceItem, TraceTurn } from "@multiremi/contracts/trace";
import {
  TRACE_FILE_FORMAT,
  TRACE_FILE_FORMAT_V1,
  TRACE_FILE_FORMAT_V2,
  TRACE_FILE_FORMATS,
  checkTraceFileLines,
  isTraceFileSnapshotLine,
  isTraceFileTrailer,
  isTraceFileTrailerV2,
  type TraceFileHeaderV2,
  type TraceFileSnapshotLine,
  type TraceFileTrailerV2,
} from "@multiremi/contracts/trace-file.js";

const NOW = "2026-10-15T00:00:00.000Z";
const turn: TraceTurn = {
  id: "tsk_one", turn_id: null, agent_id: "agt_one", agent_name: null, provider: "codex", requested_model: null,
  model: "gpt-5.5", status: "completed", error: null, started_at: NOW, completed_at: NOW, duration_ms: 0,
  final_item_id: "msg:1", final_started_at: NOW, context_usage: { used: 10, size: 100 },
  stats: { item_count: 1, tool_call_count: 0, process_item_count: 0, type_histogram: [{ type: "agent_message", tool: null, count: 1 }] },
};
const item: TraceItem = {
  id: "msg:1", parent_id: null, status: "completed", started_at: NOW, completed_at: NOW, seq: 2,
  type: "agent_message", text: "done", phase: "final",
};

const headerV2: TraceFileHeaderV2 = {
  format: TRACE_FILE_FORMAT_V2, task_id: "tsk_one", session_id: "ises_one", agent_id: "agt_one", provider: "codex", started_at: NOW,
};
const header = JSON.stringify(headerV2);
const headerV1 = JSON.stringify({ ...headerV2, format: TRACE_FILE_FORMAT_V1 });
const events = [
  JSON.stringify({ seq: 1, ts: NOW, type: "item.completed", item }),
  JSON.stringify({ seq: 2, ts: NOW, type: "turn.completed", turn }),
];
const snapshot = (part: number, parts: number, head = 2, items: TraceItem[] = [item]): string =>
  JSON.stringify({ snapshot: { part, parts, head, turn, items } } satisfies TraceFileSnapshotLine);
const trailer = (snapshotParts?: number, head = 2): string => JSON.stringify({
  end: { status: "completed", head, event_count: head, ended_at: NOW, ...(snapshotParts === undefined ? {} : { snapshot_parts: snapshotParts }) },
});

describe("trace file v2 framing", () => {
  it("pins both formats", () => {
    expect(TRACE_FILE_FORMAT_V1).toBe("multiremi.trace.v1");
    expect(TRACE_FILE_FORMAT_V2).toBe("multiremi.trace.v2");
    // The daemon writes v2 only; v1 files are read-only history.
    expect(TRACE_FILE_FORMAT).toBe(TRACE_FILE_FORMAT_V2);
    expect([...TRACE_FILE_FORMATS]).toEqual(["multiremi.trace.v1", "multiremi.trace.v2"]);
  });

  it("accepts snapshot lines between the last event and a trailer that counts them", () => {
    expect(checkTraceFileLines([header, ...events, snapshot(0, 2), snapshot(1, 2, 2, []), trailer(2)], { taskId: "tsk_one" })).toEqual({
      ok: true, value: { head: 2, event_count: 2, closed: true, duplicate_seqs: [], format: "v2", snapshot_parts: 2 },
    });
    expect(checkTraceFileLines([header, ...events, snapshot(0, 1), trailer(1)])).toMatchObject({ ok: true, value: { closed: true } });
  });

  it("records the v1 format and keeps v1 validation unchanged", () => {
    const v1Event = JSON.stringify({ seq: 1, ts: NOW, type: "text", content: "first" });
    expect(checkTraceFileLines([headerV1, v1Event, trailer(undefined, 1)])).toEqual({
      ok: true, value: { head: 1, event_count: 1, closed: true, duplicate_seqs: [], format: "v1", snapshot_parts: 0 },
    });
    // A snapshot line is not part of v1: it is an invalid event there.
    expect(checkTraceFileLines([headerV1, ...events, snapshot(0, 1)])).toEqual({ ok: false, reason: "invalid event at line 4" });
    expect(checkTraceFileLines([JSON.stringify({ ...headerV2, format: "multiremi.trace.v3" }), ...events]).ok).toBe(false);
  });

  it("rejects events after a snapshot line", () => {
    expect(checkTraceFileLines([header, events[0]!, snapshot(0, 1, 1), events[1]!, trailer(1)]))
      .toEqual({ ok: false, reason: "event after snapshot at line 4" });
  });

  it("rejects a snapshot at another head or out of order", () => {
    expect(checkTraceFileLines([header, ...events, snapshot(0, 1, 1), trailer(1)]).ok).toBe(false);
    expect(checkTraceFileLines([header, ...events, snapshot(1, 2), snapshot(0, 2), trailer(2)]).ok).toBe(false);
    expect(checkTraceFileLines([header, ...events, snapshot(0, 2), snapshot(1, 3), trailer(2)]).ok).toBe(false);
  });

  it("requires the v2 trailer to count every snapshot line", () => {
    expect(checkTraceFileLines([header, ...events, snapshot(0, 1), trailer()]))
      .toEqual({ ok: false, reason: "v2 trailer without snapshot_parts" });
    expect(checkTraceFileLines([header, ...events, snapshot(0, 1), trailer(2)]).ok).toBe(false);
    // Announced two parts, wrote one.
    expect(checkTraceFileLines([header, ...events, snapshot(0, 2), trailer(1)]).ok).toBe(false);
    expect(checkTraceFileLines([header, ...events, trailer(0)])).toMatchObject({ ok: true, value: { closed: true, snapshot_parts: 0 } });
  });

  it("reads an interrupted close as open, with the snapshot lines it got", () => {
    expect(checkTraceFileLines([header, ...events, snapshot(0, 2)])).toEqual({
      ok: true, value: { head: 2, event_count: 2, closed: false, duplicate_seqs: [], format: "v2", snapshot_parts: 1 },
    });
  });

  it("validates a snapshot line on its own", () => {
    const line = JSON.parse(snapshot(0, 1)) as unknown;
    expect(isTraceFileSnapshotLine(line)).toBe(true);
    expect(isTraceFileSnapshotLine({ ...(line as object), seq: 3 })).toBe(false);
    expect(isTraceFileSnapshotLine({ snapshot: { part: 1, parts: 1, head: 2, turn, items: [] } })).toBe(false);
    expect(isTraceFileSnapshotLine({ snapshot: { part: 0, parts: 1, head: 2, turn: { ...turn, status: "done" }, items: [] } })).toBe(false);
    // A damaged item of a known type rejects the line.
    expect(isTraceFileSnapshotLine({ snapshot: { part: 0, parts: 1, head: 2, turn, items: [{ ...item, phase: "final_answer" }] } })).toBe(false);
    expect(isTraceFileSnapshotLine({ snapshot: { part: 0, parts: 1, head: 2, turn, items: [{ ...item, status: "running" }] } })).toBe(false);
    expect(isTraceFileSnapshotLine({ snapshot: { part: 0, parts: 1, head: 2, turn, items: ["msg:1"] } })).toBe(false);
  });

  it("drops snapshot items of unknown types instead of rejecting the line (spec §13)", () => {
    const newer = { snapshot: { part: 0, parts: 1, head: 2, turn, items: [
      { ...item, id: "agent_card", type: "agent_card", agents: [] }, item,
    ] } };
    expect(isTraceFileSnapshotLine(newer)).toBe(true);
    expect(newer.snapshot.items).toEqual([item]);
    // The file inspection reads such a line as an ordinary snapshot part.
    expect(checkTraceFileLines([header, ...events, JSON.stringify(newer), trailer(1)])).toMatchObject({
      ok: true, value: { closed: true, snapshot_parts: 1 },
    });
    // A known list is left as it is.
    const known = JSON.parse(snapshot(0, 1)) as TraceFileSnapshotLine;
    const before = known.snapshot.items;
    expect(isTraceFileSnapshotLine(known)).toBe(true);
    expect(known.snapshot.items).toBe(before);
  });

  it("validates the v2 trailer shape", () => {
    const v2: TraceFileTrailerV2 = { end: { status: "cancelled", head: 0, event_count: 0, ended_at: NOW, snapshot_parts: 1 } };
    expect(isTraceFileTrailerV2(v2)).toBe(true);
    expect(isTraceFileTrailer(v2)).toBe(true);
    expect(isTraceFileTrailerV2({ end: { ...v2.end, snapshot_parts: -1 } })).toBe(false);
    expect(isTraceFileTrailerV2({ end: { ...v2.end, snapshot_parts: undefined } })).toBe(false);
  });
});

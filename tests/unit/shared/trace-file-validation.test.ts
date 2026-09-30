import { describe, expect, it } from "bun:test";
import { checkTraceFileLines, isTraceFileTrailer, TRACE_FILE_FORMAT } from "@multiremi/contracts/trace-file.js";

const NOW = "2026-09-27T00:00:00.000Z";
const header = JSON.stringify({ format: TRACE_FILE_FORMAT, task_id: "tsk_one", session_id: "ises_one", agent_id: "agt_one", provider: "codex", started_at: NOW });
const event = JSON.stringify({ seq: 1, ts: NOW, type: "text", content: "first" });
const trailer = JSON.stringify({ end: { status: "completed", head: 1, event_count: 1, ended_at: NOW } });

describe("trace file integrity", () => {
  it("requires valid framing and actual event counts to establish closure", () => {
    expect(checkTraceFileLines([header, event, trailer], { taskId: "tsk_one", sessionId: "ises_one" })).toMatchObject({ ok: true, value: { closed: true, head: 1, event_count: 1 } });
    expect(checkTraceFileLines(["{\"bad\":true}", event, trailer]).ok).toBe(false);
    expect(checkTraceFileLines([header, event, JSON.stringify({ end: { status: "completed", head: 2, event_count: 2, ended_at: NOW } })]).ok).toBe(false);
    expect(checkTraceFileLines([header, JSON.stringify({ seq: 10, ts: NOW, type: "text" }), event, trailer]).ok).toBe(false);
  });

  it("recovers open duplicates and half lines but never calls ambiguous framing closed", () => {
    expect(checkTraceFileLines([header, event, event], { incompleteTail: true })).toMatchObject({
      ok: true, value: { head: 1, event_count: 1, closed: false, duplicate_seqs: [1] },
    });
    expect(checkTraceFileLines([header, event, event, trailer]).ok).toBe(false);
    expect(checkTraceFileLines([header, event, trailer], { incompleteTail: true }).ok).toBe(false);
  });

  it("rejects incomplete trailers and invalid calendar dates", () => {
    expect(isTraceFileTrailer({ end: {} })).toBe(false);
    expect(isTraceFileTrailer({ end: { status: "running", head: 0, event_count: 0, ended_at: NOW } })).toBe(false);
    expect(isTraceFileTrailer({ end: { status: "completed", head: 0, event_count: 1, ended_at: NOW } })).toBe(false);
    expect(isTraceFileTrailer({ end: { status: "completed", head: 1, event_count: 1, ended_at: "2026-02-31T00:00:00Z" } })).toBe(false);
  });
});

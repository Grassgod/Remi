import { afterEach, describe, expect, it } from "bun:test";
import { organizerTaskInspection } from "@multiremi/api/helpers/organizer.js";
import type { TraceReader } from "@multiremi/trace/trace-reader.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const agent = store.createAgent({ name: "Organizer target", provider: "codex", workspaceId: "local" });
  const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "inspect" });
  store.appendTaskMessages(task.id, [{ type: "text", content: "legacy" }, { type: "tool_use", tool: "Bash" }]);
  return { store, task };
}

describe("organizer trace inspection", () => {
  it("uses injected turn-card counts for terminal tasks", async () => {
    const { store, task } = fixture();
    const inspection = await organizerTaskInspection(store, { ...task, status: "completed" }, {
      getTurnStats: () => ({ toolCallCount: 7, eventCount: 30, typeHistogram: [{ type: "tool_use", tool: "Read", count: 7 }] }),
    });
    expect(inspection).toMatchObject({
      tool_call_count: 7, event_count: 30,
      message_type_histogram: [{ type: "tool_use", tool: "Read", count: 7 }],
    });
  });

  it("falls back to legacy rows when a terminal card has no statistics", async () => {
    const { store, task } = fixture();
    const inspection = await organizerTaskInspection(store, { ...task, status: "completed" }, { getTurnStats: () => null });
    expect(inspection).toMatchObject({ tool_call_count: 1, event_count: 2, last_message: { seq: 2 } });
    expect(inspection.message_type_histogram).toEqual([
      { type: "text", tool: null, count: 1 }, { type: "tool_use", tool: "Bash", count: 1 },
    ]);
  });

  it("uses a readTrace tail window for running tasks", async () => {
    const { store, task } = fixture();
    const cursors: number[] = [];
    const readTrace = {
      readTrace: async (_taskId: string, afterSeq = 0) => {
        cursors.push(afterSeq);
        return {
          events: afterSeq === Number.MAX_SAFE_INTEGER ? [] : [{ seq: 300, ts: "2026-09-28T00:00:00Z", type: "tool_use", tool: "Read" }],
          next_after_seq: 300, head: 300, eof: true, closed: false,
          source: "daemon" as const, state: "ok" as const,
        };
      },
    } as Pick<TraceReader, "readTrace">;
    const inspection = await organizerTaskInspection(store, { ...task, status: "running" }, { readTrace });
    expect(cursors).toEqual([Number.MAX_SAFE_INTEGER, 100]);
    expect(inspection).toMatchObject({ tool_call_count: 1, event_count: 1, last_message: { seq: 300 }, message_type_histogram: [{ type: "tool_use", tool: "Read", count: 1 }] });
  });

  it("keeps the legacy detail when hot reading is unreachable", async () => {
    const { store, task } = fixture();
    const readTrace = {
      readTrace: async () => ({ events: [], next_after_seq: 0, head: 0, eof: true, closed: false, source: "daemon" as const, state: "unreachable" as const }),
    } as Pick<TraceReader, "readTrace">;
    const inspection = await organizerTaskInspection(store, { ...task, status: "running" }, { readTrace });
    expect(inspection).toMatchObject({ event_count: 2, last_message: { seq: 2 } });
  });
});

import { createResponsibleTestIssue } from './helpers.js';
import { turnApiPath } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { organizerTaskInspection, organizerTurnStats } from "@multiremi/api/helpers/organizer.js";
import { createMultiremiApp } from "@multiremi/api.js";
import type { TraceReader } from "@multiremi/trace/trace-reader.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

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
  for (const counts of [
    { toolCallCount: 7, eventCount: 30, typeHistogram: [{ type: "tool_use", tool: "Read", count: 7 }] },
    { toolCallCount: 0, eventCount: 0, typeHistogram: [] },
    { toolCallCount: null, eventCount: null, typeHistogram: null },
  ]) {
    it(`wires persisted turn-card statistics through the default inspection HTTP source (${counts.eventCount})`, async () => {
      const store = createStore();
      store.ensureLocalWorkspace();
      const runtime = store.registerRuntime({ name: "Organizer stats runtime", provider: "codex", workspaceId: "local" });
      const agent = store.createAgent({ name: "Organizer stats target", provider: "codex", runtimeId: runtime.id, workspaceId: "local" });
      const issue = createResponsibleTestIssue(store, { title: "Organizer stats", workspaceId: "local" });
      const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "inspect" });
      store.appendTaskMessages(task.id, [{ type: "text", content: "legacy" }, { type: "tool_use", tool: "Bash" }]);
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);
      store.completeTask(task.id, { output: "" });
      db!.transaction(() => store.recordAttemptOutcomeWithinTransaction(task.id, counts))();
      const app = createMultiremiApp({ store, authToken: "root-secret" });
      const response = await app.request(turnApiPath(store, task.id, "?attempts=true"), { headers: { Authorization: "Bearer root-secret" } });
      expect(response.status).toBe(200);
      // #7/#9: execution counters are returned on attempts and the dynamic turn card.
      const detail=await response.json();expect(detail.turn.id).toBe(store.getTurnForAttempt(task.id)!.id);
      expect(detail.attempts).toContainEqual(expect.objectContaining({id:task.id,event_count:counts.eventCount,tool_call_count:counts.toolCallCount}));
      const card=store.listConversationLogEntries(task.issueSessionId!).find(entry=>entry.kind==='turn')!;
      expect(card.metadata).toMatchObject({event_count:counts.eventCount,tool_call_count:counts.toolCallCount,type_histogram:counts.typeHistogram});
    });
  }

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

  it("uses persisted turn-card statistics without a legacy last_message", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Organizer tail", provider: "codex", workspaceId: "local" });
    const issue = createResponsibleTestIssue(store, { title: "Organizer tail", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "inspect" });
    store.appendTaskMessages(task.id, [{ type: "text", content: "legacy" }, { type: "tool_use", tool: "Bash" }]);
    db!.run("UPDATE multiremi_turn_attempts SET status = 'completed' WHERE id = ?", [task.id]);
    db!.run("UPDATE multiremi_turns SET status = 'completed' WHERE current_attempt_id = ?", [task.id]);
    db!.transaction(() => store.recordAttemptOutcomeWithinTransaction(task.id, {
      toolCallCount: 7, eventCount: 30, typeHistogram: [{ type: "tool_use", tool: "Read", count: 7 }],
    }))();
    expect(organizerTurnStats(store, task.id)).toMatchObject({ toolCallCount: 7, eventCount: 30 });
    const terminal = store.getTask(task.id)!;
    const previous = await organizerTaskInspection(store, terminal, { getTurnStats: () => null });
    const inspection = await organizerTaskInspection(store, terminal, { getTurnStats: (id) => organizerTurnStats(store, id) });
    expect(previous.last_message).toBeNull();
    expect(inspection.last_message).toBeNull();
    expect(inspection).toMatchObject({
      tool_call_count: 7, event_count: 30,
      message_type_histogram: [{ type: "tool_use", tool: "Read", count: 7 }],
    });
  });

  it("does not fall back to legacy rows when a terminal card has no statistics", async () => {
    const { store, task } = fixture();
    const inspection = await organizerTaskInspection(store, { ...task, status: "completed" }, { getTurnStats: () => null });
    expect(inspection).toMatchObject({ tool_call_count: 0, event_count: 0, last_message: null });
    expect(inspection.message_type_histogram).toEqual([]);
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

  it("does not surface legacy detail when hot reading is unreachable", async () => {
    const { store, task } = fixture();
    const readTrace = {
      readTrace: async () => ({ events: [], next_after_seq: 0, head: 0, eof: true, closed: false, source: "daemon" as const, state: "unreachable" as const }),
    } as Pick<TraceReader, "readTrace">;
    const inspection = await organizerTaskInspection(store, { ...task, status: "running" }, { readTrace });
    expect(inspection).toMatchObject({ event_count: 0, last_message: null });
  });
});

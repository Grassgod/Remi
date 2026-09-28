import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { DAEMON_PROTOCOL_ERROR_CODES, DAEMON_RETRYABLE_ERROR_CODES, DAEMON_TERMINAL_ERROR_CODES } from "@multiremi/contracts/daemon-protocol.js";
import { reportFrame } from "../../fixtures/report-session.js";
import type { DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import { DaemonTraceTransport } from "@multiremi/worker/trace-transport.js";
import type { DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  const store = new MultiremiStore(db);
  const runtime = store.registerRuntime({ id: "runtime", name: "reports", provider: "claude", daemonId: "reports-daemon" });
  const agent = store.createAgent({ name: "Reports", provider: "claude", maxConcurrentTasks: 10 });
  const task = store.createTask({ agentId: agent.id, prompt: "report" });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  return { db, store, runtime, agent, task,
    report: (type: string, p: Record<string, unknown> = {}) => reportFrame(store, type, { task_id: task.id, ...p }, { runtimeId: runtime.id }),
  };
}

describe("v2 reports", () => {
  it("absorbs identical progress and normalized usage subset replays before Store writes", async () => {
    const { store, task, report } = fixture();
    store.startTask(task.id);
    const progress = spyOn(store, "reportProgress");
    const usage = spyOn(store, "reportTaskUsage");
    try {
      for (let index = 0; index < 2; index++) {
        expect(await report("task.progress", { summary: "first", step: 1, total: 2 })).toEqual({ ok: true });
      }
      expect(progress).toHaveBeenCalledTimes(1);
      expect(await report("task.progress", { summary: "last", step: 2, total: 2 })).toEqual({ ok: true });
      expect(progress).toHaveBeenCalledTimes(2);
      const a = { provider: "claude", model: "a", input_tokens: 5, output_tokens: 2 };
      const b = { provider: "claude", model: "b", input_tokens: 7, output_tokens: 3 };
      for (const entries of [[a], [b], [a], [b], [{ ...a, input_tokens: 999 }, a]]) {
        expect(await report("task.usage", { usage: entries })).toEqual({ ok: true });
      }
      expect(usage).toHaveBeenCalledTimes(2);
      expect(store.getTask(task.id)?.usage.map(entry => [entry.model, entry.inputTokens, entry.outputTokens])).toEqual([
        ["a", 5, 2], ["b", 7, 3],
      ]);
      expect(store.getTask(task.id)?.progressSummary).toBe("last");
    } finally { progress.mockRestore(); usage.mockRestore(); }
  });

  for (const type of ["task.complete", "task.fail"]) {
    it(`delivers all daemon-derived completion fields to the round-card hook for ${type}`, async () => {
      const { store, task, runtime } = fixture();
      store.startTask(task.id);
      const peer = { onWelcome: () => () => {}, onFrame: () => () => {}, connectionState: () => "disconnected" };
      const trace = new DaemonTraceTransport(peer as unknown as DaemonProtocolClient);
      const received: Array<{ taskId: string; fields: DaemonTaskCompletionFields | null }> = [];
      try {
        trace.append(task.id, runtime.id, [
          { type: "execution", meta: { provider: "claude", model: "fixture-model" } },
          { type: "tool_use", tool: "Read" },
          { type: "text", content: "final **answer**", meta: { phase: "final" } },
        ]);
        const fields = trace.completion(task.id);
        expect(await reportFrame(store, type, { task_id: task.id, output: "answer", error: "failure", ...fields }, {
          runtimeId: runtime.id, onRoundCard: (taskId, fields) => received.push({ taskId, fields }),
        })).toEqual({ ok: true });
        expect(received).toEqual([{ taskId: task.id, fields: {
          trace: { head: 3, event_count: 3, closed: true, tool_call_count: 1,
            type_histogram: [{ type: "execution", tool: null, count: 1 }, { type: "tool_use", tool: "Read", count: 1 }, { type: "text", tool: null, count: 1 }] },
          final_reply_md: "final **answer**", model: { provider: "claude", model: "fixture-model" },
        } }]);
      } finally { await trace.stop(); }
    });
  }

  it("validates card fields before terminal effects, preserving sparse historical trace heads", async () => {
    const { store, task, runtime } = fixture();
    store.startTask(task.id);
    const fields = { trace: { head: 9, event_count: 2, closed: true, tool_call_count: 1,
      type_histogram: [{ type: "text", tool: null, count: 1 }, { type: "tool_use", tool: "Read", count: 1 }] },
      final_reply_md: null, model: null };
    const received: unknown[] = [];
    for (const patch of [
      { trace: { ...fields.trace, head: -1 } },
      { trace: { ...fields.trace, event_count: 1.5 } },
      { trace: { ...fields.trace, closed: false } },
      { trace: { ...fields.trace, tool_call_count: "1" } },
      { trace: { ...fields.trace, type_histogram: [{ type: "text", tool: null, count: -1 }] } },
      { trace: { ...fields.trace, type_histogram: [{ type: "text", tool: 1, count: 1 }] } },
      { final_reply_md: 3 }, { model: { provider: "claude" } },
    ]) {
      expect(await reportFrame(store, "task.complete", { task_id: task.id, ...fields, ...patch }, {
        runtimeId: runtime.id, onRoundCard: (_taskId, value) => received.push(value),
      })).toEqual({ ok: false, code: "invalid_report", retryable: false });
      expect(store.getTask(task.id)?.status).toBe("running");
      expect(received).toEqual([]);
    }
    expect(await reportFrame(store, "task.complete", { task_id: task.id, ...fields }, {
      runtimeId: runtime.id, onRoundCard: (_taskId, value) => received.push(value),
    })).toEqual({ ok: true });
    expect(received).toEqual([fields]);
  });

  it("reuses the task write methods, preserves usage and prompt idempotency, and absorbs terminal replays", async () => {
    const { store, task, report } = fixture();
    expect(await report("task.start")).toEqual({ ok: true });
    expect(await report("task.start")).toMatchObject({ ok: true, code: "start_replayed" });
    const prompt = "assembled prompt";
    const sha256 = new Bun.CryptoHasher("sha256").update(prompt).digest("hex");
    for (let i = 0; i < 2; i++) {
      expect(await report("task.prompt", { prompt, sha256, mode: "bootstrap" })).toEqual({ ok: true });
      expect(await report("task.usage", { usage: [{ provider: "claude", model: "model", input_tokens: 5, output_tokens: 2 }] })).toEqual({ ok: true });
    }
    expect(await report("task.session_pin", { session_id: "session", work_dir: "/tmp/task" })).toEqual({ ok: true });
    expect(await report("task.progress", { summary: "done", step: 3, total: 3 })).toEqual({ ok: true });
    expect(await report("task.complete", { output: "done", session_id: "session", work_dir: "/tmp/task" })).toEqual({ ok: true });
    expect(await report("task.complete", { output: "duplicate" })).toEqual({ ok: true });
    expect(await report("task.fail", { error: "late" })).toEqual({ ok: true });
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "done", sessionId: "session", workDir: "/tmp/task" });
    expect(store.getTask(task.id)?.usage).toHaveLength(1);
    expect(store.getTask(task.id)?.usage[0]).toMatchObject({ inputTokens: 5, outputTokens: 2 });
    expect(store.getTaskPrompt(task.id)?.prompt).toBe(prompt);
  });

  it("names steer_pending without categorizing it as retryable or terminal", async () => {
    expect(DAEMON_PROTOCOL_ERROR_CODES).toContain("steer_pending");
    expect(DAEMON_RETRYABLE_ERROR_CODES).not.toContain("steer_pending" as never);
    expect(DAEMON_TERMINAL_ERROR_CODES).not.toContain("steer_pending" as never);
    const { store, task, report } = fixture();
    store.startTask(task.id);
    const steer = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "follow up" });
    expect(await report("task.complete", { output: "old" })).toEqual({ ok: false, code: "steer_pending", retryable: false });
    expect(store.getTask(task.id)?.status).toBe("running");
    store.consumeTaskSteerMessages(task.id, [steer.id]);
    expect(await report("task.complete", { output: "new" })).toEqual({ ok: true });
    expect(store.getTask(task.id)?.status).toBe("completed");
  });

  it("rejects missing tasks, invalid reports and runtime impersonation with deterministic codes", async () => {
    const { store, task, report } = fixture();
    expect(await report("task.progress", { task_id: "missing" })).toEqual({ ok: false, code: "task_not_found", retryable: false });
    expect(await report("task.prompt", { mode: "other" })).toEqual({ ok: false, code: "invalid_report", retryable: false });
    expect(await reportFrame(store, "task.complete", { task_id: "missing" }, { runtimeId: "missing-runtime" })).toMatchObject({ code: "task_not_found" });
    store.registerRuntime({ id: "other", provider: "claude", name: "other", daemonId: "other-daemon" });
    expect(await reportFrame(store, "task.complete", { task_id: task.id }, { runtimeId: "other" })).toEqual({ ok: false, code: "authority_revoked", retryable: false });
  });
});

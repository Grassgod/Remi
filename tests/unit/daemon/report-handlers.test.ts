import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { DAEMON_PROTOCOL_ERROR_CODES, DAEMON_RETRYABLE_ERROR_CODES, DAEMON_TERMINAL_ERROR_CODES } from "@multiremi/contracts/daemon-protocol.js";
import { reportFrame } from "../../fixtures/report-session.js";
import type { DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import { DaemonTraceTransport } from "@multiremi/worker/trace-transport.js";
import type { DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";

const databases: Database[] = [];
const cardFields: DaemonTaskCompletionFields = {
  trace: { head: 9, event_count: 2, closed: true, tool_call_count: 1,
    type_histogram: [{ type: "text", tool: null, count: 1 }, { type: "tool_use", tool: "Read", count: 1 }] },
  final_reply_md: null, model: null,
};
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

  for (const type of ["task.complete", "task.fail"]) {
    for (const missing of ["trace", "final_reply_md", "model"]) {
      it(`keeps ${type} effective with missing ${missing}, a blank card and a task-scoped warning`, async () => {
        const { store, task, runtime } = fixture();
        store.startTask(task.id);
        const fields: Record<string, unknown> = { ...cardFields };
        delete fields[missing];
        const received: unknown[] = [];
        const closed: unknown[] = [];
        const warning = spyOn(console, "warn").mockImplementation(() => {});
        try {
          expect(await reportFrame(store, type, { task_id: task.id, ...fields }, {
            runtimeId: runtime.id, onRoundCard: (id, value) => received.push({ id, value }),
            onTraceClosed: (...args) => closed.push(args),
          })).toEqual({ ok: true });
          expect(store.getTask(task.id)?.status).toBe(type === "task.complete" ? "completed" : "failed");
          expect(received).toEqual([{ id: task.id, value: null }]);
          expect(closed).toEqual([]);
          expect(warning.mock.calls).toEqual([[expect.stringContaining("missing round-card fields"), { taskId: task.id }]]);
        } finally { warning.mockRestore(); }
      });
    }

    it(`degrades malformed card fields without blocking ${type} or exposing raw trace downstream`, async () => {
      const error = spyOn(console, "error").mockImplementation(() => {});
      try {
        for (const [field, patch] of [
          ["trace", { trace: { ...cardFields.trace, head: -1 } }],
          ["trace", { trace: { ...cardFields.trace, event_count: 1.5 } }],
          ["trace", { trace: { ...cardFields.trace, closed: false } }],
          ["trace", { trace: { ...cardFields.trace, tool_call_count: "1" } }],
          ["trace", { trace: { ...cardFields.trace, type_histogram: [{ type: "text", tool: null, count: -1 }] } }],
          ["trace", { trace: { ...cardFields.trace, type_histogram: [{ type: "text", tool: 1, count: 1 }] } }],
          ["final_reply_md", { final_reply_md: 3 }], ["model", { model: { provider: "claude" } }],
        ] as const) {
          const { store, task, runtime } = fixture();
          store.startTask(task.id);
          const received: unknown[] = [];
          const closed: unknown[] = [];
          error.mockClear();
          expect(await reportFrame(store, type, { task_id: task.id, ...cardFields, ...patch }, {
            runtimeId: runtime.id, onRoundCard: (id, value) => received.push({ id, value }),
            onTraceClosed: (...args) => closed.push(args),
          })).toEqual({ ok: true });
          expect(store.getTask(task.id)?.status).toBe(type === "task.complete" ? "completed" : "failed");
          expect(received).toEqual([{ id: task.id, value: null }]);
          expect(closed).toEqual([]);
          expect(error.mock.calls).toEqual([[expect.stringContaining("malformed round-card field"), { taskId: task.id, field }]]);
        }
      } finally { error.mockRestore(); }
    });

    it(`keeps frame-level rejections side-effect free for ${type}`, async () => {
      const { store, task, runtime } = fixture();
      store.startTask(task.id);
      store.registerRuntime({ id: "other", provider: "claude", name: "other", daemonId: "other-daemon" });
      const complete = spyOn(store, "completeTask");
      const fail = spyOn(store, "failTask");
      const received: unknown[] = [];
      const closed: unknown[] = [];
      try {
        for (const [taskId, runtimeId, code] of [["", runtime.id, "invalid_report"],
          ["missing", runtime.id, "task_not_found"], [task.id, "other", "authority_revoked"]]) {
          expect(await reportFrame(store, type, { task_id: taskId, ...cardFields }, {
            runtimeId, onRoundCard: (...args) => received.push(args), onTraceClosed: (...args) => closed.push(args),
          })).toEqual({ ok: false, code, retryable: false });
        }
        expect(store.getTask(task.id)?.status).toBe("running");
        expect(complete).not.toHaveBeenCalled();
        expect(fail).not.toHaveBeenCalled();
        expect(received).toEqual([]);
        expect(closed).toEqual([]);
      } finally { complete.mockRestore(); fail.mockRestore(); }
    });
  }

  it("passes validated sparse historical trace heads to downstream hooks", async () => {
    const { store, task, runtime } = fixture();
    store.startTask(task.id);
    const received: unknown[] = [];
    const closed: unknown[] = [];
    expect(await reportFrame(store, "task.complete", { task_id: task.id, ...cardFields }, {
      runtimeId: runtime.id, onRoundCard: (_taskId, value) => received.push(value),
      onTraceClosed: (...args) => closed.push(args),
    })).toEqual({ ok: true });
    expect(received).toEqual([cardFields]);
    expect(closed).toEqual([[task.id, 9, runtime.id]]);
  });

  for (const [type, initialStatus] of [
    ["task.complete", "running"], ["task.fail", "dispatched"],
    ["task.fail", "running"], ["task.fail", "waiting_local_directory"],
  ] as const) {
    it(`calls the round-card hook once for ${type} from ${initialStatus}, despite two replays`, async () => {
      const { store, task, runtime } = fixture();
      if (initialStatus === "running") store.startTask(task.id);
      if (initialStatus === "waiting_local_directory") store.markTaskWaitingLocalDirectory(task.id, "fixture");
      expect(store.getTask(task.id)?.status).toBe(initialStatus);
      const received: unknown[] = [];
      const write = spyOn(store, type === "task.complete" ? "completeTask" : "failTask");
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          expect(await reportFrame(store, type, { task_id: task.id, output: "done", error: "failed", ...cardFields }, {
            runtimeId: runtime.id, onRoundCard: (id, fields) => received.push({ id, fields }),
          })).toEqual({ ok: true });
        }
        expect(store.getTask(task.id)?.status).toBe(type === "task.complete" ? "completed" : "failed");
        expect(write).toHaveBeenCalledTimes(1);
        expect(received).toEqual([{ id: task.id, fields: cardFields }]);
      } finally { write.mockRestore(); }
    });
  }

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

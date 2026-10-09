import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { DAEMON_PROTOCOL_ERROR_CODES, DAEMON_RETRYABLE_ERROR_CODES, DAEMON_TERMINAL_ERROR_CODES } from "@multiremi/contracts/daemon-protocol.js";
import { reportFrame } from "../../fixtures/report-session.js";
import type { DaemonTaskCompletionFields, DaemonTurnInput } from "@multiremi/contracts/daemon-protocol.js";
import { DaemonTraceTransport } from "@multiremi/worker/trace-transport.js";
import type { DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";

const databases: Database[] = [];
const inputs = new WeakMap<MultiremiStore, DaemonTurnInput>();
const cardFields: DaemonTaskCompletionFields = {
  trace: { head: 9, event_count: 2, closed: true, tool_call_count: 1,
    type_histogram: [{ type: "text", tool: null, count: 1 }, { type: "tool_use", tool: "Read", count: 1 }] },
  final_reply_md: "done", model: null,
};
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = openSqliteDatabase(":memory:"); databases.push(db);
  const store = new MultiremiStore(db);
  const runtime = store.registerRuntime({ id: "runtime", name: "reports", provider: "claude", daemonId: "reports-daemon" });
  const agent = store.createAgent({ name: "Reports", provider: "claude", maxConcurrentTasks: 10 });
  const task = store.createTask({ agentId: agent.id, prompt: "report" });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  inputs.set(store, store.getDaemonTurnBridge().offerInput(store.getTaskWithAgent(task.id)!));
  return { db, store, runtime, agent, task,
    report: (type: string, p: Record<string, unknown> = {}) => sendReport(store, type, { task_id: task.id, ...p }, { runtimeId: runtime.id }),
  };
}

function sendReport(store: MultiremiStore, type: string, fields: Record<string, unknown>, options: Parameters<typeof reportFrame>[3]) {
  if (type !== "turn.complete") return reportFrame(store, type, fields, options);
  const input = inputs.get(store)!;
  const { task_id, output, error: _error, ...metadata } = fields;
  return reportFrame(store, type, { ...metadata, turn_id: input.turn_id, attempt_id: task_id,
    input_to_seq: Math.max(input.input_to_seq, store.getTurn(input.turn_id)?.input_to_seq ?? 0),
    reply: { body_md: typeof metadata.final_reply_md === "string" ? metadata.final_reply_md : output ?? "done", message_kind: "final" },
  }, options);
}

function success(store: MultiremiStore, type: string) {
  if (type !== "turn.complete") return { ok: true };
  const turn = store.getTurn(inputs.get(store)!.turn_id)!;
  expect(turn.reply_message_id).toBeString();
  return { ok: true, turn_id: turn.id, reply_message_id: turn.reply_message_id };
}
function usageState(db: Database, taskId: string) {
  const tables = ["multiremi_usage_runs", "multiremi_usage_units", "multiremi_usage_unit_receipts",
    "multiremi_usage_task_scopes", "multiremi_usage_run_scopes", "multiremi_usage_legacy_audit",
    "multiremi_usage_legacy_versions", "multiremi_usage_legacy_sources"];
  return { task: db.query("SELECT * FROM multiremi_turn_attempts WHERE id=?").get(taskId) as Record<string, unknown>,
    ledger: Object.fromEntries(tables.map(table => [table,
      db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
        ? db.query(`SELECT * FROM ${table} WHERE task_id=? ORDER BY rowid`).all(taskId) : []])) };
}

describe("v2 reports", () => {
  it("pins the provider session under the workspace lock before the turn write and ignores a terminal replay", async () => {
    const { db, store, task, report } = fixture();
    expect(await report("task.start", { usage_run_id: "pin-provider-run" })).toMatchObject({ execution_authorized: true });
    const ctx = (store as unknown as { ctx: { lockWorkspaceRuntimeLifecycle: (workspaceId: string) => void } }).ctx;
    const lock = ctx.lockWorkspaceRuntimeLifecycle.bind(ctx), run = db.run.bind(db);
    let workspaceLocked = false, pinWrites = 0;
    const locked = spyOn(ctx, "lockWorkspaceRuntimeLifecycle").mockImplementation(workspaceId => {
      expect(db.inTransaction).toBe(true);
      expect(workspaceId).toBe("local");
      lock(workspaceId);
      workspaceLocked = true;
    });
    const write = spyOn(db, "run").mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.startsWith("UPDATE multiremi_turns SET current_attempt_id=current_attempt_id")) {
        expect(db.inTransaction).toBe(true);
        expect(workspaceLocked).toBe(true);
        pinWrites++;
      }
      return run(sql, params as never);
    });
    try {
      expect(store.pinTaskSession(task.id, "provider-original", "/tmp/provider-original")).toMatchObject({ sessionId: "provider-original", workDir: "/tmp/provider-original" });
      expect(pinWrites).toBe(1);
    } finally { write.mockRestore(); locked.mockRestore(); }
    store.cancelTask(task.id);
    expect(store.pinTaskSession(task.id, "late-provider", "/tmp/late-provider")).toMatchObject({ status: "cancelled", sessionId: "provider-original", workDir: "/tmp/provider-original" });
  });

  it("restores a queued sent offer and binds a modern run before authorizing execution", async () => {
    const { db, store, task, runtime, report } = fixture();
    store.recordTaskOffered(task.id, runtime.id);
    expect(store.requeueTaskOffer(task.id, runtime.id)).toBe(true);
    expect(await report("task.start", { usage_run_id: "recovered-run" })).toEqual({ ok: true, execution_authorized: true });
    expect(store.getTask(task.id)?.status).toBe("running");
    expect(db.query("SELECT runtime_id,workspace_id FROM multiremi_usage_run_scopes WHERE task_id=? AND run_id=?").get(task.id, "recovered-run"))
      .toEqual({ runtime_id: runtime.id, workspace_id: "local" });
  });

  it("rejects a bound runtime moved to a different workspace before late usage", async () => {
    const { db, store, task, runtime, report } = fixture();
    expect(await report("task.start", { usage_run_id: "bound-run" })).toMatchObject({ execution_authorized: true });
    store.createWorkspace({ id: "moved-workspace", name: "Moved", slug: "moved-workspace" });
    db.run("UPDATE multiremi_runtimes SET workspace_id=? WHERE id=?", ["moved-workspace", runtime.id]);
    expect(await report("task.usage", { usageSnapshot: { version: 2, runId: "bound-run", revision: 1, complete: false, units: [] } }))
      .toEqual({ ok: false, code: "authority_revoked", retryable: false });
    expect(db.query("SELECT revision FROM multiremi_usage_runs WHERE task_id=? AND run_id=?").get(task.id, "bound-run")).toEqual({ revision: 0 });
  });

  it("rechecks bound late-usage daemon identity under the workspace lock", async () => {
    const { db, store, task, runtime, report } = fixture();
    expect(await report("task.start", { usage_run_id: "bound-run" })).toMatchObject({ execution_authorized: true });
    const ctx = (store as unknown as { ctx: { lockWorkspaceRuntimeLifecycle: (workspaceId: string) => void } }).ctx;
    const lock = ctx.lockWorkspaceRuntimeLifecycle.bind(ctx);
    const changed = spyOn(ctx, "lockWorkspaceRuntimeLifecycle").mockImplementationOnce(workspaceId => {
      lock(workspaceId);
      db.run("UPDATE multiremi_runtimes SET daemon_id=? WHERE id=?", ["replacement-daemon", runtime.id]);
    });
    try {
      expect(await report("task.usage", { usageSnapshot: { version: 2, runId: "bound-run", revision: 1, complete: false, units: [] } }))
        .toEqual({ ok: false, code: "authority_revoked", retryable: false });
      expect(db.query("SELECT revision FROM multiremi_usage_runs WHERE task_id=? AND run_id=?").get(task.id, "bound-run")).toEqual({ revision: 0 });
    } finally { changed.mockRestore(); }
  });

  it("freezes an authenticated run at start and accepts only its original runtime's late usage", async () => {
    const { db, store, task, runtime, report } = fixture();
    expect(await report("task.start", { usage_run_id: "accepted-run" })).toEqual({ ok: true, execution_authorized: true });
    expect(await report("task.start", { usage_run_id: "accepted-run" })).toEqual({ ok: true, code: "start_replayed", execution_authorized: true });
    const other = store.registerRuntime({ id: "other", name: "retry", provider: "claude", daemonId: "other-daemon" });
    runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET runtime_id=? WHERE id=?", [other.id, task.id]);
    expect(await report("task.start", { usage_run_id: "accepted-run" })).toEqual({ ok: true, code: "start_replayed", execution_authorized: false });
    const usageSnapshot = { version: 2, runId: "accepted-run", revision: 1, complete: true, units: [{
      unitId: "request", revision: 1, provider: "claude", model: "opus", scope: "request", source: "provider_request", accuracy: "exact",
      inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 12,
      contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: "2026-10-01T00:00:00Z",
    }] };
    expect(await report("task.usage", { usageSnapshot })).toEqual({ ok: true });
    expect(db.query("SELECT runtime_id FROM multiremi_usage_units WHERE task_id=?").get(task.id)).toEqual({ runtime_id: runtime.id });
    expect(await reportFrame(store, "task.usage", { task_id: task.id, usageSnapshot }, { runtimeId: other.id })).toEqual({ ok: false, code: "authority_revoked", retryable: false });
    expect(store.getRuntime(runtime.id)?.inputTokens).toBe(10);
    expect(store.getRuntime(other.id)?.inputTokens).toBe(0);
    expect(store.getTask(task.id)?.usage[0]?.totalTokens).toBe(12);
    expect(store.getTaskStatusSnapshot(task.id)?.usage[0]?.totalTokens).toBe(12);
  });

  it("makes infrastructure failures retryable while rejecting malformed snapshots", async () => {
    const { store, report } = fixture();
    const usageSnapshot = { version: 2, runId: "run", revision: 1, complete: false, units: [] };
    const write = spyOn(store, "reportTaskUsageSnapshot").mockImplementation(() => { throw new Error("temporary database outage"); });
    try {
      expect(await report("task.usage", { usageSnapshot })).toMatchObject({ ok: false, code: "server_error", retryable: true });
      expect(await report("task.usage", { usageSnapshot: { ...usageSnapshot, revision: -1 } })).toEqual({ ok: false, code: "invalid_report", retryable: false });
    } finally { write.mockRestore(); }
  });

  it("keeps normalized usage subset replays side-effect free after Store source verification", async () => {
    const { db, store, task, report } = fixture();
    store.startTask(task.id);
    const progress = spyOn(store, "reportProgress");
    const realUsage = store.reportTaskUsage.bind(store);
    const changed: ReturnType<typeof usageState>[] = [];
    const usage = spyOn(store, "reportTaskUsage").mockImplementation((id, entries) => {
      const before = usageState(db, id);
      const result = realUsage(id, entries);
      const after = usageState(db, id);
      if (before.task.usage === after.task.usage) expect(after).toEqual(before);
      else changed.push(after);
      return result;
    });
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
      // Source/canonical verification may run on every replay. Only the first
      // two distinct aggregates may change persisted facts or revision receipts.
      const settled = usageState(db, task.id);
      for (let index = 0; index < 120; index++) {
        expect(await report("task.usage", { usage: index % 2 ? [a] : [b] })).toEqual({ ok: true });
      }
      expect(usageState(db, task.id)).toEqual(settled);
      expect(changed).toHaveLength(2);
      expect(db.query("SELECT revision FROM multiremi_usage_runs WHERE task_id=? AND run_id='legacy'").get(task.id)).toEqual({ revision: 2 });
      expect(db.query(`SELECT COUNT(*) AS units,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,MAX(revision) AS revision
        FROM multiremi_usage_units WHERE task_id=? AND run_id='legacy'`).get(task.id)).toEqual({ units: 2, input_tokens: 12, output_tokens: 5, revision: 2 });
      expect(store.getTask(task.id)?.usage.map(entry => [entry.model, entry.inputTokens, entry.outputTokens])).toEqual([
        ["a", 5, 2], ["b", 7, 3],
      ]);
      expect(store.getTask(task.id)?.progressSummary).toBe("last");
    } finally { progress.mockRestore(); usage.mockRestore(); }
  });

  for (const type of ["turn.complete", "task.fail"]) {
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
        expect(await sendReport(store, type, { task_id: task.id, output: "answer", error: "failure", ...fields }, {
          runtimeId: runtime.id, onRoundCard: (taskId, fields) => received.push({ taskId, fields }),
        })).toEqual(success(store, type));
        expect(received).toEqual([{ taskId: task.id, fields: {
          trace: { head: 3, event_count: 3, closed: true, tool_call_count: 1,
            type_histogram: [{ type: "execution", tool: null, count: 1 }, { type: "tool_use", tool: "Read", count: 1 }, { type: "text", tool: null, count: 1 }] },
          final_reply_md: "final **answer**", model: { provider: "claude", model: "fixture-model" },
        } }]);
      } finally { await trace.stop(); }
    });
  }

  for (const type of ["turn.complete", "task.fail"]) {
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
          expect(await sendReport(store, type, { task_id: task.id, ...fields }, {
            runtimeId: runtime.id, onRoundCard: (id, value) => received.push({ id, value }),
            onTraceClosed: (...args) => closed.push(args),
          })).toEqual(success(store, type));
          expect(store.getTask(task.id)?.status).toBe(type === "turn.complete" ? "completed" : "failed");
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
          expect(await sendReport(store, type, { task_id: task.id, ...cardFields, ...patch }, {
            runtimeId: runtime.id, onRoundCard: (id, value) => received.push({ id, value }),
            onTraceClosed: (...args) => closed.push(args),
          })).toEqual(success(store, type));
          expect(store.getTask(task.id)?.status).toBe(type === "turn.complete" ? "completed" : "failed");
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
          ["missing", runtime.id, type === "turn.complete" ? "stale_attempt" : "task_not_found"],
          [task.id, "other", type === "turn.complete" ? "stale_attempt" : "authority_revoked"]]) {
          expect(await sendReport(store, type, { task_id: taskId, ...cardFields }, {
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
    expect(await sendReport(store, "turn.complete", { task_id: task.id, ...cardFields }, {
      runtimeId: runtime.id, onRoundCard: (_taskId, value) => received.push(value),
      onTraceClosed: (...args) => closed.push(args),
    })).toEqual(success(store, "turn.complete"));
    expect(received).toEqual([cardFields]);
    expect(closed).toEqual([[task.id, 9, runtime.id]]);
  });

  for (const [type, initialStatus] of [
    ["turn.complete", "running"], ["task.fail", "dispatched"],
    ["task.fail", "running"], ["task.fail", "waiting_local_directory"],
  ] as const) {
    it(`calls the round-card hook once for ${type} from ${initialStatus}, despite two replays`, async () => {
      const { store, task, runtime } = fixture();
      store.recordTaskOffered(task.id, runtime.id);
      if (initialStatus === "running") store.startTask(task.id);
      if (initialStatus === "waiting_local_directory") store.markTaskWaitingLocalDirectory(task.id, "fixture");
      expect(store.getTask(task.id)?.status).toBe(initialStatus);
      const received: unknown[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await sendReport(store, type, { task_id: task.id, output: "done", error: "failed", ...cardFields }, {
          runtimeId: runtime.id, onRoundCard: (id, fields) => received.push({ id, fields }),
        })).toEqual(success(store, type));
      }
      expect(store.getTask(task.id)?.status).toBe(type === "turn.complete" ? "completed" : "failed");
      expect(received).toEqual([{ id: task.id, fields: cardFields }]);
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
    expect(await report("turn.complete", { output: "done", session_id: "session", work_dir: "/tmp/task" })).toEqual(success(store, "turn.complete"));
    expect(await report("turn.complete", { output: "duplicate" })).toEqual(success(store, "turn.complete"));
    expect(await report("task.fail", { error: "late" })).toEqual({ ok: true });
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "done", sessionId: "session", workDir: "/tmp/task" });
    expect(store.getTask(task.id)?.usage).toHaveLength(1);
    expect(store.getTask(task.id)?.usage[0]).toMatchObject({ inputTokens: 5, outputTokens: 2 });
    expect(store.getTaskPrompt(task.id)?.prompt).toBe(prompt);
  });

  it("names turn_input_pending without categorizing it as retryable or terminal", async () => {
    expect(DAEMON_PROTOCOL_ERROR_CODES).toContain("turn_input_pending");
    expect(DAEMON_RETRYABLE_ERROR_CODES).not.toContain("turn_input_pending" as never);
    expect(DAEMON_TERMINAL_ERROR_CODES).not.toContain("turn_input_pending" as never);
    const { store, task, report, runtime } = fixture();
    store.startTask(task.id);
    const steer = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "follow up" });
    store.getDaemonTurnBridge().snapshot({ runtimeId: runtime.id, daemonId: "reports-daemon", workspaceId: "local" }, new Set([task.id]));
    expect(await report("turn.complete", { output: "old" })).toEqual({ ok: false, code: "turn_input_pending", retryable: false });
    expect(store.getTask(task.id)?.status).toBe("running");
    const input = store.getDaemonTurnBridge().offerInput(store.getTaskWithAgent(task.id)!);
    expect(await reportFrame(store, "turn.input", { turn_id: input.turn_id, attempt_id: task.id,
      input_to_seq: input.input_to_seq, message_ids: input.input_messages.map(message => message.id) }, { runtimeId: runtime.id }))
      .toEqual({ ok: true, input_to_seq: input.input_to_seq });
    expect(store.getTaskSteerMessage(steer.id)?.consumedAt).toBeTruthy();
    expect(await report("turn.complete", { output: "new" })).toEqual(success(store, "turn.complete"));
    expect(store.getTask(task.id)?.status).toBe("completed");
  });

  it("rejects missing tasks, invalid reports and runtime impersonation with deterministic codes", async () => {
    const { store, task, report } = fixture();
    expect(await report("task.progress", { task_id: "missing" })).toEqual({ ok: false, code: "task_not_found", retryable: false });
    expect(await report("task.prompt", { mode: "other" })).toEqual({ ok: false, code: "invalid_report", retryable: false });
    expect(await sendReport(store, "turn.complete", { task_id: "missing" }, { runtimeId: "missing-runtime" }))
      .toEqual({ ok: false, code: "authority_revoked", retryable: false });
    store.registerRuntime({ id: "other", provider: "claude", name: "other", daemonId: "other-daemon" });
    expect(await sendReport(store, "turn.complete", { task_id: task.id }, { runtimeId: "other" }))
      .toEqual({ ok: false, code: "stale_attempt", retryable: false });
  });

  it("quarantines retired completion frames without completing the turn", async () => {
    const { store, task, runtime } = fixture();
    store.startTask(task.id);
    expect(await reportFrame(store, "task.complete", { task_id: task.id, output: "old format" }, { runtimeId: runtime.id }))
      .toEqual({ ok: false, code: "report_shape_retired", retryable: false });
    expect(store.getTask(task.id)?.status).toBe("running");
  });
});

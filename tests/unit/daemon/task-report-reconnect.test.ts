import { expect, it, spyOn } from "bun:test";
import { reportFrame } from "../../fixtures/report-session.js";
import { pendingTurnBackendTests } from "../multiremi/pending-turn-test-backends.js";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";

pendingTurnBackendTests("task reports after offer reconnect", (databaseFixture) => {
function fixture() {
  const { db, store } = databaseFixture();
  const runtime = store.registerRuntime({ id: "rt_reconnect", name: "Reconnect", provider: "claude", daemonId: "daemon_reconnect",
    metadata: { parallel_agent_execution: 1 } });
  const agent = store.createAgent({ name: "Reconnect", provider: "claude", runtimeId: runtime.id });
  const task = store.createTask({ agentId: agent.id, prompt: "synthetic reconnect" });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  const report = (type: string, patch: Record<string, unknown> = {}) => reportFrame(store, type,
    { task_id: task.id, ...patch }, { runtimeId: runtime.id });
  const sendEnvelope = (to: Parameters<typeof store.sendEnvelopeWithinTransaction>[0]["to"], key: string) => {
    const ctx = (store as unknown as { ctx: StoreContext }).ctx;
    const events = createCommitEventQueue();
    const delivery = databaseFixture().transaction(() => store.sendEnvelopeWithinTransaction({
      to, kind: "report", outcome: "done", wake: "now", body: `Inbox ${key}`, dedupeKey: key, source: {},
    }, [], events)[0]!);
    ctx.emitCommitEvents(events);
    return delivery;
  };
  return { db, store, runtime, task, report, sendEnvelope };
}

  it("restores a queued sent offer directly, without waiting for re-claim", async () => {
    const { store, runtime, task, report } = fixture();
    store.recordTaskOffered(task.id, runtime.id);
    expect(store.requeueTaskOffer(task.id, runtime.id)).toBe(true);
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", startedAt: null });
    expect(store.getTask(task.id)?.offeredAt).not.toBeNull();
    expect(await report("task.start")).toEqual({ ok: true });
    expect(store.getTask(task.id)?.status).toBe("running");
    const startedAt = store.getTask(task.id)?.startedAt;
    expect(startedAt).not.toBeNull();
    expect(await report("task.start")).toEqual({ ok: true, code: "start_replayed" });
    expect(store.getTask(task.id)?.startedAt).toBe(startedAt);
  });

  for (const operation of ["start", "complete", "fail"] as const) {
    it(`restores ${operation} in the caller's single transaction and publishes after commit`, () => {
      const { db, store, runtime, task } = fixture();
      store.recordTaskOffered(task.id, runtime.id);
      store.requeueTaskOffer(task.id, runtime.id);
      const authority = { runtimeId: runtime.id, workspaceId: "local", daemonId: runtime.daemonId! };
      const transactionDb = (store as unknown as { db: typeof db }).db;
      const transaction = transactionDb.transaction.bind(transactionDb);
      let depth = 0;
      let maxDepth = 0;
      const events: string[] = [];
      store.onTaskEvent(event => events.push(event.type));
      transactionDb.transaction = ((fn: (...args: unknown[]) => unknown) => {
        const runner = transaction(fn);
        return (...args: unknown[]) => {
          depth++; maxDepth = Math.max(maxDepth, depth);
          try { return runner(...args); } finally { depth--; }
        };
      }) as typeof transactionDb.transaction;
      try {
        transactionDb.transaction(() => {
          if (operation === "start") store.startTaskFromDaemon(task.id, authority);
          if (operation === "complete") store.completeTaskFromDaemon(task.id, { output: "done" }, authority);
          if (operation === "fail") store.failTaskFromDaemon(task.id, { error: "failure" }, authority);
          expect(events).toEqual([]);
        })();
      } finally { transactionDb.transaction = transaction; }
      expect(maxDepth).toBe(1);
      expect(events).toEqual([operation === "start" ? "task:running" : operation === "complete" ? "task:completed" : "task:failed"]);
    });
  }

  it("completes a sent dispatched offer whose start report was lost exactly once", async () => {
    const { store, runtime, task, report } = fixture();
    store.recordTaskOffered(task.id, runtime.id);
    store.acceptTaskOffer(task.id, runtime.id);
    expect(await report("task.complete", { output: "recovered answer" })).toEqual({ ok: true });
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "recovered answer" });
    const completedAt = store.getTask(task.id)?.completedAt;
    expect(await report("task.complete", { output: "duplicate changed answer" })).toEqual({ ok: true });
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "recovered answer", completedAt });
  });

  it("does not acknowledge completion or queued start without a prior sent offer", async () => {
    const { store, runtime, task, report } = fixture();
    expect(await report("task.complete", { output: "unconfirmed" })).toMatchObject({ ok: false, retryable: true });
    expect(store.getTask(task.id)?.status).toBe("dispatched");
    store.requeueTaskOffer(task.id, runtime.id);
    expect(await report("task.start")).toMatchObject({ ok: false, code: "server_error", retryable: true });
    expect(await report("task.complete", { output: "queued" })).toMatchObject({ ok: false, retryable: true });
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", result: null });
    expect(await report("task.fail", { error: "unconfirmed" })).toMatchObject({ ok: false, retryable: true });
  });

  it("completes directly from a network-requeued sent offer, with no second acceptance", async () => {
    const { store, runtime, task, report } = fixture();
    store.recordTaskOffered(task.id, runtime.id);
    store.requeueTaskOffer(task.id, runtime.id);
    const fingerprint = store.getTask(task.id)?.executionFingerprint;
    expect(await report("task.complete", { output: "late completion" })).toEqual({ ok: true });
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "late completion", executionFingerprint: fingerprint });
    expect(store.getTask(task.id)?.startedAt).not.toBeNull();
  });

  it("fails a network-requeued sent offer once when preparation failed before start", async () => {
    const { store, runtime, task, report } = fixture();
    store.recordTaskOffered(task.id, runtime.id);
    store.requeueTaskOffer(task.id, runtime.id);
    expect(await report("task.fail", { error: "preparation failed" })).toEqual({ ok: true });
    const failed = store.getTask(task.id);
    expect(failed).toMatchObject({ status: "failed", error: "preparation failed" });
    expect(await report("task.fail", { error: "duplicate" })).toEqual({ ok: true });
    expect(store.getTask(task.id)).toEqual(failed);
  });

  for (const type of ["task.start", "task.complete", "task.fail"]) {
    it(`rechecks the daemon identity under the workspace lock for ${type}`, async () => {
      const { db, store, runtime, task } = fixture();
      store.recordTaskOffered(task.id, runtime.id);
      const ctx = (store as any).ctx;
      const lock = ctx.lockWorkspaceRuntimeLifecycle.bind(ctx);
      let spy: ReturnType<typeof spyOn> | undefined;
      try {
        expect(await reportFrame(store, type, { task_id: task.id, output: "late" }, { runtimeId: runtime.id,
          beforeFrame: () => {
            spy = spyOn(ctx, "lockWorkspaceRuntimeLifecycle").mockImplementationOnce((workspaceId: unknown) => {
              lock(workspaceId);
              db.run("UPDATE multiremi_runtimes SET daemon_id = ? WHERE id = ?", ["replacement_daemon", runtime.id]);
            });
          },
        })).toEqual({ ok: false, code: "authority_revoked", retryable: false });
        expect(store.getTask(task.id)).toMatchObject({ status: "dispatched", startedAt: null, result: null });
      } finally { spy?.mockRestore(); }
    });
  }

  it("revokes the prior offer when an agent rebind re-pools queued work", async () => {
    const { db, store, runtime, task, report } = fixture();
    store.recordTaskOffered(task.id, runtime.id);
    store.requeueTaskOffer(task.id, runtime.id);
    db.run("UPDATE multiremi_tasks SET execution_fingerprint = NULL WHERE id = ?", [task.id]);
    const other = store.registerRuntime({ id: "rt_rebound", name: "Rebound", provider: "claude", daemonId: "daemon_rebound" });
    store.updateAgent(task.agentId, { runtimeId: other.id });
    expect(store.getTask(task.id)).toMatchObject({ offeredAt: null, acceptedAt: null });
    expect(await report("task.start")).toMatchObject({ ok: false });
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", startedAt: null });
  });

  it("cancels frozen sent execution when its agent is rebound", async () => {
    const { store, runtime, task, report } = fixture();
    store.recordTaskOffered(task.id, runtime.id);
    store.requeueTaskOffer(task.id, runtime.id);
    const other = store.registerRuntime({ id: "rt_rebound", name: "Rebound", provider: "claude", daemonId: "daemon_rebound" });
    store.updateAgent(task.agentId, { runtimeId: other.id });
    const cancelled = store.getTask(task.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(await report("task.complete", { output: "old" })).toEqual({ ok: true });
    expect(store.getTask(task.id)).toEqual(cancelled);
  });

  it("does not transfer execution evidence through runtime merge", async () => {
    const { store, runtime, task } = fixture();
    store.recordTaskOffered(task.id, runtime.id);
    store.requeueTaskOffer(task.id, runtime.id);
    const other = store.registerRuntime({ id: "rt_merged", name: "Merged", provider: "claude", daemonId: "daemon_merged" });
    store.mergeRuntimeInto(runtime.id, other.id);
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", runtimeId: other.id, offeredAt: null, acceptedAt: null });
    expect(await reportFrame(store, "task.complete", { task_id: task.id, output: "old" }, { runtimeId: other.id }))
      .toMatchObject({ ok: false, code: "server_error", retryable: true });
    expect(store.getTask(task.id)?.result).toBeNull();
  });

  it("refuses editing a network-requeued sent chat turn instead of redispatching a changed input under its old ID", async () => {
    const { db, store, runtime } = fixture();
    // Complete the fixture's one-off turn before creating this chat queue.
    const first = store.listTasks()[0]!;
    store.startTask(first.id); store.completeTask(first.id, { output: "done" });
    const agent = store.getAgent(first.agentId)!;
    const chat = store.createChatSession({ agentId: agent.id });
    const active = store.sendChatMessage(chat.id, { content: "first" });
    const pending = store.sendChatMessage(chat.id, { content: "old input" });
    expect(store.claimTask(runtime.id)?.id).toBe(active.task.id);
    store.startTask(active.task.id); store.completeTask(active.task.id, { output: "done" });
    expect(store.claimTask(runtime.id)?.id).toBe(pending.task.id);
    store.recordTaskOffered(pending.task.id, runtime.id);
    store.requeueTaskOffer(pending.task.id, runtime.id);
    // Editing APIs operate on the pending queue behind the current first turn.
    const newFirst = store.sendChatMessage(chat.id, { content: "new first" });
    db.run("UPDATE multiremi_tasks SET priority = 100 WHERE id = ?", [newFirst.task.id]);
    const before = store.getTask(pending.task.id);
    expect(() => store.updateQueuedChatTask(chat.id, pending.task.id, "revised input")).toThrow("already dispatched");
    expect(store.getTask(pending.task.id)).toEqual(before);
    expect(await reportFrame(store, "task.complete", { task_id: pending.task.id, output: "original answer" }, { runtimeId: runtime.id }))
      .toEqual({ ok: true });
    expect(store.getTask(pending.task.id)).toMatchObject({ status: "completed", result: "original answer", prompt: "old input" });
  });

  it("keeps a sent Issue projection frozen and re-rings later inbox input under a new task ID", async () => {
    const { db, store, runtime, task, sendEnvelope } = fixture();
    store.startTask(task.id); store.completeTask(task.id, { output: "done" });
    const issue = store.createIssue({ title: "Reconnect inbox", status: "in_progress", assigneeType: "agent", assigneeId: task.agentId });
    const to = { role: "issue_owner" as const, issueId: issue.id };
    const original = sendEnvelope(to, "original");
    expect(original.action).toBe("created");
    const oldId = original.task!.id;
    expect(store.claimTask(runtime.id)?.id).toBe(oldId);
    store.recordTaskOffered(oldId, runtime.id); store.requeueTaskOffer(oldId, runtime.id);
    const before = store.getTask(oldId);
    const oldWake = db.query("SELECT wake_seq FROM multiremi_tasks WHERE id = ?").get(oldId);
    const later = sendEnvelope(to, "later");
    expect(later.action).toBe("none");
    expect(sendEnvelope(to, "later").deduplicated).toBe(true);
    expect(store.getTask(oldId)).toEqual(before);
    expect(db.query("SELECT wake_seq FROM multiremi_tasks WHERE id = ?").get(oldId)).toEqual(oldWake);
    expect(await reportFrame(store, "task.complete", { task_id: oldId, output: "original only" }, { runtimeId: runtime.id })).toEqual({ ok: true });
    const next = store.listTasksForIssue(issue.id).find(turn => turn.status === "queued")!;
    expect(next).toBeDefined(); expect(next.id).not.toBe(oldId);
    expect(db.query("SELECT wake_seq FROM multiremi_tasks WHERE id = ?").get(next.id)).toMatchObject({ wake_seq: later.entry.seq });
    expect(store.describeTaskPlacement(next.id)).toMatchObject([{ runtimeId: runtime.id, placementOk: true, routingOk: true }]);
    expect(store.claimTask(runtime.id)?.id).toBe(next.id);
    store.recordTaskOffered(next.id, runtime.id);
    expect(await reportFrame(store, "task.start", { task_id: next.id }, { runtimeId: runtime.id })).toEqual({ ok: true });
    expect(await reportFrame(store, "task.complete", { task_id: next.id, output: "later answer" }, { runtimeId: runtime.id })).toEqual({ ok: true });
    expect(store.getTask(next.id)?.result).toBe("later answer");
  });

  it("steers a network-requeued sent Chat turn and prevents its old completion from swallowing new inbox input", async () => {
    const { store, runtime, task, sendEnvelope } = fixture();
    store.startTask(task.id); store.completeTask(task.id, { output: "done" });
    const chat = store.createChatSession({ agentId: task.agentId });
    const to = { role: "chat" as const, chatSessionId: chat.id, agentId: task.agentId };
    const original = sendEnvelope(to, "original");
    const oldId = original.task!.id;
    expect(store.claimTask(runtime.id)?.id).toBe(oldId);
    store.recordTaskOffered(oldId, runtime.id); store.requeueTaskOffer(oldId, runtime.id);
    const before = store.getTask(oldId);
    expect(sendEnvelope(to, "later").action).toBe("steered");
    expect(sendEnvelope(to, "later").deduplicated).toBe(true);
    expect(store.getTask(oldId)).toEqual(before);
    const steers = store.listPendingTaskSteerMessages(oldId);
    expect(steers).toHaveLength(1); expect(steers[0]!.content).toContain("later");
    expect(await reportFrame(store, "task.complete", { task_id: oldId, output: "stale" }, { runtimeId: runtime.id }))
      .toEqual({ ok: false, code: "steer_pending", retryable: false });
    expect(store.getTask(oldId)).toEqual(before);
    store.consumeTaskSteerMessages(oldId, steers.map(steer => steer.id));
    expect(await reportFrame(store, "task.complete", { task_id: oldId, output: "steered answer" }, { runtimeId: runtime.id })).toEqual({ ok: true });
    expect(store.getTask(oldId)?.result).toBe("steered answer");
  });

  it("clears queued execution evidence when its daemon is retired", () => {
    const { store, runtime, task } = fixture();
    store.recordTaskOffered(task.id, runtime.id);
    store.requeueTaskOffer(task.id, runtime.id);
    // Retirement cannot discard a hot trace. Mark this synthetic empty trace explicitly empty.
    store.markTaskTraceNone(task.id);
    const plan = store.getDaemonRetirementPlan("local", runtime.daemonId!);
    expect(plan.canRetire).toBe(true);
    store.retireDaemon("local", runtime.daemonId!, plan.snapshot, "local");
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", runtimeId: null, offeredAt: null, acceptedAt: null });
  });

  it("does not restart or complete a cancelled turn", async () => {
    const { store, runtime, task, report } = fixture();
    store.recordTaskOffered(task.id, runtime.id);
    store.acceptTaskOffer(task.id, runtime.id);
    store.cancelTask(task.id);
    const before = store.getTask(task.id);
    expect(await report("task.start")).toEqual({ ok: true, code: "start_replayed" });
    expect(await report("task.complete", { output: "late answer" })).toEqual({ ok: true });
    expect(store.getTask(task.id)).toEqual(before);
  });

  it("rejects reports after runtime reassignment without mutating the new owner's turn", async () => {
    const { db, store, task, report } = fixture();
    store.registerRuntime({ id: "rt_other", name: "Other", provider: "claude", daemonId: "daemon_other" });
    db.run("UPDATE multiremi_tasks SET runtime_id = ? WHERE id = ?", ["rt_other", task.id]);
    for (const type of ["task.start", "task.complete"]) {
      expect(await report(type, { output: "foreign" })).toEqual({ ok: false, code: "authority_revoked", retryable: false });
    }
    expect(store.getTask(task.id)).toMatchObject({ status: "dispatched", runtimeId: "rt_other", startedAt: null, result: null });
  });

  it("rejects task/runtime workspace mismatch even for an otherwise authorized daemon", async () => {
    const { db, store, task, report } = fixture();
    store.createWorkspace({ id: "foreign", name: "Foreign" });
    db.run("UPDATE multiremi_tasks SET workspace_id = ? WHERE id = ?", ["foreign", task.id]);
    for (const type of ["task.start", "task.complete"]) {
      expect(await report(type, { output: "foreign" })).toEqual({ ok: false, code: "authority_revoked", retryable: false });
    }
    expect(store.getTask(task.id)).toMatchObject({ status: "dispatched", startedAt: null, result: null });
  });
});

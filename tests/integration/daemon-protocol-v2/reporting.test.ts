import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const fixtures: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const h of fixtures.splice(0)) await h.dispose(); });
async function fixture(options: Parameters<typeof DaemonProtocolHarness.create>[0] = {}) {
  const h = await DaemonProtocolHarness.create({ outboxBackoffMs: [5],
    onReady: daemon => { (daemon as any).claimsPaused = true; }, ...options });
  fixtures.push(h);
  return h;
}
function outbox(h: DaemonProtocolHarness): MultiremiTaskReportOutbox { return (h.daemon as any).ensureOutbox(); }
function runtime(h: DaemonProtocolHarness): string { return (h.daemon as any).options.runtimeId; }
function task(h: DaemonProtocolHarness) {
  const agent = h.store.createAgent({ name: "Report injection", provider: "claude", maxConcurrentTasks: 5 });
  const value = h.store.createTask({ agentId: agent.id, prompt: "report injection" });
  expect(h.store.claimTask(runtime(h))?.id).toBe(value.id);
  return value;
}

describe("v2 report reconciliation with real sockets and DB", () => {
  for (const injection of ["socket", "daemon", "server"] as const) {
    it(`reconciles all emitted report keys exactly once over 20 ${injection} injections`, async () => {
      let interruptTask: string | null = null;
      const faultReplies: Array<ReturnType<typeof spyOn>> = [];
      const h = await fixture({ beforeSend(frame, socket, harness) {
        if (["task.start", "task.progress", "task.usage", "task.complete"].includes(frame.t)) socket.native.send(JSON.stringify(frame));
        if (frame.t === "task.usage" && frame.p.task_id === interruptTask) {
          const session = harness.sessions.at(-1)!;
          const real = session.sendReply.bind(session);
          faultReplies.push(spyOn(session, "sendReply").mockImplementation((re, payload) => {
            if (re === String(frame.seq) && (payload as { ok?: unknown }).ok === true && interruptTask === frame.p.task_id) {
              interruptTask = null;
              socket.close(4001);
              return false;
            }
            return real(re, payload);
          }));
        }
      } });
      await h.startDaemon();
      const sent = new Set<string>();
      const arrived = new Set<string>();
      const completed = new Map<string, number>();
      const realComplete = h.store.completeTask.bind(h.store);
      const complete = spyOn(h.store, "completeTask").mockImplementation((id, input) => {
        completed.set(id, (completed.get(id) ?? 0) + 1);
        return realComplete(id, input);
      });
      const progress = spyOn(h.store, "reportProgress");
      const usageReport = spyOn(h.store, "reportTaskUsage");
      try {
        for (let round = 0; round < 20; round++) {
          const t = task(h);
          const box = outbox(h);
          interruptTask = t.id;
          const payload = { runtime_id: runtime(h) };
          const rows = [box.enqueue(t.id, "start", payload),
            box.enqueue(t.id, "progress", { ...payload, summary: `early-${round}`, step: 1, total: 2 }),
            box.enqueue(t.id, "progress", { ...payload, summary: `step-${round}`, step: 2, total: 2 }),
            box.enqueue(t.id, "usage", { ...payload, usage: [{ provider: "claude", model: "fixture-a", inputTokens: 5, outputTokens: 2 }] }),
            box.enqueue(t.id, "usage", { ...payload, usage: [{ provider: "claude", model: "fixture-b", inputTokens: 7, outputTokens: 3 }] }),
            box.enqueue(t.id, "complete", { ...payload, output: `result-${round}` })];
          rows.forEach(id => sent.add(`${t.id}:${id}`));
          await waitFor(() => h.client.connectionState() === "disconnected" && h.store.getTask(t.id)?.usage?.length === 1,
            "usage committed without ACK", 5_000);
          if (injection === "daemon") await h.restartDaemon();
          else if (injection === "server") await h.restartServer();
          else await h.reconnect();
          await waitFor(() => h.store.getTask(t.id)?.status === "completed" && outbox(h).stats().pending === 0, "terminal report and res", 5_000);
          expect(h.store.getTask(t.id)).toMatchObject({ status: "completed", result: `result-${round}`, progressSummary: `step-${round}` });
          const usage = h.store.getTask(t.id)!.usage!;
          expect(usage).toHaveLength(2);
          expect(usage.reduce((sum, entry) => sum + entry.inputTokens, 0)).toBe(12);
          expect(usage.reduce((sum, entry) => sum + entry.outputTokens, 0)).toBe(5);
          expect(completed.get(t.id)).toBe(1);
          expect(progress.mock.calls.filter(([id]) => id === t.id)).toHaveLength(2);
          expect(usageReport.mock.calls.filter(([id]) => id === t.id)).toHaveLength(2);
          const entries = h.ledger.filter(entry => entry.partition === t.id && entry.seq !== null);
          entries.forEach(entry => arrived.add(`${t.id}:${entry.seq}`));
          const unique = [...new Map(entries.map(entry => [entry.seq, entry])).values()];
          expect(unique.at(-1)?.type).toBe("task.complete");
          const effects = h.effectiveLedger.filter(entry => entry.partition === t.id);
          for (const seq of rows) expect(effects.filter(entry => entry.seq === seq)).toHaveLength(1);
          expect(effects.at(-1)?.type).toBe("task.complete");
          expect(entries.length).toBeGreaterThan(effects.length);
        }
        expect([...arrived].sort()).toEqual([...sent].sort());
        const applied = h.effectiveLedger.filter(entry => sent.has(`${entry.partition}:${entry.seq}`))
          .map(entry => `${entry.partition}:${entry.seq}`);
        expect(applied.sort()).toEqual([...sent].sort());
        expect(sent.size).toBe(120);
        expect(h.errors).toEqual([]);
        const reads = [...h.snapshotReadMs].sort((a, b) => a - b);
        console.info("Report Store snapshot read timings (ms)", JSON.stringify({ injection, count: reads.length,
          min: reads[0], p50: reads[Math.floor(reads.length * 0.5)], p95: reads[Math.floor(reads.length * 0.95)],
          max: reads.at(-1), total: reads.reduce((sum, ms) => sum + ms, 0) }));
      } finally {
        complete.mockRestore(); progress.mockRestore(); usageReport.mockRestore();
        for (const reply of faultReplies) reply.mockRestore();
      }
    }, 30_000);
  }

  it("keeps the socket alive when an oversized completion blocks one partition", async () => {
    const h = await fixture(); await h.startDaemon();
    const large = task(h); const other = task(h);
    const box = outbox(h); const p = { runtime_id: runtime(h) };
    box.enqueue(large.id, "complete", { ...p, output: "x".repeat(1024 * 1024) });
    box.enqueue(other.id, "start", p); box.enqueue(other.id, "complete", { ...p, output: "delivered" });
    expect(await box.waitForTaskDrain(large.id)).toBe("blocked");
    await box.waitForTaskDrain(other.id);
    expect(h.store.getTask(other.id)?.status).toBe("completed");
    expect(h.client.connectionState()).toBe("connected");
    expect(h.sockets).toHaveLength(1);
    expect(h.ledger.some(entry => entry.partition === large.id)).toBe(false);
  });

  it("purges an already deleted task after reconnect while delivering another partition", async () => {
    const h = await fixture(); await h.startDaemon();
    const other = task(h); await h.disconnect();
    const box = outbox(h); const p = { runtime_id: runtime(h) };
    box.enqueue("deleted", "complete", { ...p, output: "deleted" });
    box.enqueue("deleted", "progress", p);
    box.enqueue(other.id, "start", p); box.enqueue(other.id, "complete", { ...p, output: "ok" });
    await h.reconnect(); await box.flushAll();
    expect(box.stats()).toMatchObject({ pending: 0, blocked: 0 });
    expect(h.store.getTask(other.id)?.status).toBe("completed");
  });

  it("restores GC operation errors through real RPC replies without purging a report partition", async () => {
    const h = await fixture(); await h.startDaemon();
    const box = outbox(h);
    const purge = spyOn(box, "purgeTask");
    const client = (h.daemon as any).client as MultiremiDaemonClient;
    try {
      await expect(client.reportIssueWorkspaceCleaned("deleted-issue", runtime(h), {
        archiveId: "archive", sourceRevision: "revision", sha256: "a".repeat(64),
      })).rejects.toMatchObject({ name: "MultiremiDaemonHttpError", status: 404, code: "issue_not_found" });
      expect(purge).not.toHaveBeenCalled();
      expect(h.ledger.some(entry => entry.type === "gc.workspace_cleaned" && entry.seq === null)).toBe(true);
      expect(h.client.connectionState()).toBe("connected");
    } finally { purge.mockRestore(); }
  });

  it("includes historical completions in hello, waits for both providers, and sends the imported row once", async () => {
    let historicalTask = "";
    const recover = spyOn(MultiremiDaemonClient.prototype, "recoverOrphans");
    try {
      const h = await fixture({ providers: ["claude", "codex"], runtimeIds: ["historical-runtime", "codex-runtime"],
        async beforeStart(h) {
          h.store.registerRuntime({ id: "historical-runtime", name: "historical", provider: "claude", daemonId: "dmn_fixture", workspaceId: "local" });
          const agent = h.store.createAgent({ name: "Historical", provider: "claude" });
          const t = h.store.createTask({ agentId: agent.id, prompt: "history" });
          h.store.claimTask("historical-runtime"); h.store.startTask(t.id); historicalTask = t.id;
          const legacy = new MultiremiTaskReportOutbox({ path: `${h.root}/claude-outbox.db`, canSend: () => false, deliver: async () => {} });
          legacy.enqueue(t.id, "complete", { output: "historical" }); await legacy.close();
        },
      });
      await h.startDaemon();
      await waitFor(() => h.store.getTask(historicalTask)?.status === "completed", "historical completion");
      await outbox(h).waitForTaskDrain(historicalTask);
      const hello = h.ledger.find(entry => entry.type === "hello")!.frame;
      expect(hello.p.runtimes.map((r: any) => r.runtime_id).sort()).toEqual(["codex-runtime", "historical-runtime"]);
      expect(hello.p.runtimes.find((r: any) => r.runtime_id === "historical-runtime").active_task_ids).toContain(historicalTask);
      expect(h.ledger.filter(entry => entry.type === "task.complete" && entry.partition === historicalTask)).toHaveLength(1);
      expect(recover.mock.calls.some(([id]) => id === "historical-runtime")).toBe(false);
      expect((h.daemons[0] as any).protocolLane.runtime().active_task_ids).not.toContain(historicalTask);
    } finally { recover.mockRestore(); }
  });

  it("hands an online steer conflict back to the executor and fails an orphaned replay", async () => {
    const h = await fixture(); await h.startDaemon();
    const t = task(h); h.store.startTask(t.id);
    const steer = h.store.createTaskSteerMessage({ taskId: t.id, kind: "steer", content: "new turn" });
    const box = outbox(h); const p = { runtime_id: runtime(h) };
    const completion = box.enqueueAndWait(t.id, "complete", { ...p, output: "old" });
    box.enqueue(t.id, "progress", { ...p, summary: "injected steer" });
    await expect(completion).rejects.toMatchObject({ code: "steer_pending" });
    await box.waitForTaskDrain(t.id);
    h.store.consumeTaskSteerMessages(t.id, [steer.id]);
    await box.enqueueAndWait(t.id, "complete", { ...p, output: "new" });
    expect(h.store.getTask(t.id)).toMatchObject({ status: "completed", result: "new" });
    const replay = task(h); h.store.startTask(replay.id);
    h.store.createTaskSteerMessage({ taskId: replay.id, kind: "steer", content: "orphan" });
    await h.disconnect();
    box.enqueue(replay.id, "complete", { ...p, output: "orphaned" });
    await h.restartDaemon(); await outbox(h).waitForTaskDrain(replay.id);
    expect(h.store.getTask(replay.id)).toMatchObject({ status: "failed", failureReason: "runtime_recovery" });
    expect(outbox(h).stats().blocked).toBe(0);
  });

  it("continues the live provider after a completion steer conflict and reaches exactly one terminal state", async () => {
    let turns = 0;
    let injected = false;
    const prompts: string[] = [];
    const h = await fixture({ onReady: () => {},
      beforeSend(frame, _socket, h) {
        if (frame.t === "task.complete" && !injected) {
          injected = true;
          h.store.createTaskSteerMessage({ taskId: frame.p.task_id, kind: "steer", content: "use the new answer" });
        }
      },
      providerFactory: () => ({
        async *sendStream(prompt) {
          prompts.push(String(prompt)); turns++;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: turns === 1 ? "old answer" : "new answer" }] } as any;
        },
        getLastResponse: () => ({ text: turns === 1 ? "old answer" : "new answer", sessionId: "live-session", usage: [], toolCalls: [] } as any),
        close: async () => {},
      }),
    });
    const agent = h.store.createAgent({ name: "Live steer", provider: "claude" });
    const t = h.store.createTask({ agentId: agent.id, prompt: "answer" });
    let terminalEffects = 0;
    const complete = h.store.completeTask.bind(h.store);
    const spy = spyOn(h.store, "completeTask").mockImplementation((id, input) => {
      const result = complete(id, input);
      if (id === t.id) terminalEffects++;
      return result;
    });
    try {
      await h.startDaemon();
      await waitFor(() => h.store.getTask(t.id)?.status === "completed", "live steered completion", 5_000);
      await outbox(h).waitForTaskDrain(t.id);
      expect(turns).toBe(2);
      expect(prompts[1]).toContain("use the new answer");
      expect(h.store.getTask(t.id)).toMatchObject({ status: "completed", result: "new answer" });
      expect(h.daemon.traceStore().read(t.id).events).toContainEqual(expect.objectContaining({ type: "text", content: "old answer" }));
      expect(terminalEffects).toBe(1);
      expect(h.ledger.filter(entry => entry.type === "task.complete" && entry.partition === t.id)).toHaveLength(2);
      expect(outbox(h).stats().blocked).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it("preserves a lease-lost result through real WS acknowledgement and removes only its outbox row", async () => {
    const h = await fixture(); await h.startDaemon();
    const client = (h.daemon as any).client as MultiremiDaemonClient;
    await expect(client.prepareFeishuBotOutboundMention(runtime(h), "deleted-delivery", "former-lease", null))
      .rejects.toMatchObject({ name: "MultiremiDaemonHttpError", status: 409, code: "stale_lease" });
    await expect(client.reportFeishuBotOutboundResult(runtime(h), "deleted-delivery", { status: "streaming", claimToken: "former-lease" }))
      .rejects.toMatchObject({ name: "MultiremiDaemonHttpError", status: 409, code: "stale_lease" });
    await client.updateRuntimeModels(runtime(h), [{ id: "after-stale", label: "After stale", provider: "anthropic", default: true }]);
    await outbox(h).flushAll();
    expect(h.store.listRuntimeModels(runtime(h)).map(model => model.id)).toEqual(["after-stale"]);
    expect(outbox(h).stats()).toMatchObject({ pending: 0, blocked: 0 });
    expect(h.client.connectionState()).toBe("connected");
  });

  it("does not hold startup or recover an unreported completion while the socket is not ready", async () => {
    let historicalTask = "";
    const recover = spyOn(MultiremiDaemonClient.prototype, "recoverOrphans");
    try {
      const h = await fixture({ providers: ["claude", "codex"], runtimeIds: ["offline-runtime", "other-runtime"],
        beforeSend: frame => frame.t === "hello" ? false : undefined,
        async beforeStart(h) {
          h.store.registerRuntime({ id: "offline-runtime", name: "offline", provider: "claude", daemonId: "dmn_fixture", workspaceId: "local" });
          const agent = h.store.createAgent({ name: "Offline executor", provider: "claude" });
          const t = h.store.createTask({ agentId: agent.id, prompt: "already finished" });
          h.store.claimTask("offline-runtime"); h.store.startTask(t.id); historicalTask = t.id;
          const legacy = new MultiremiTaskReportOutbox({ path: `${h.root}/claude-outbox.db`, canSend: () => false, deliver: async () => {} });
          legacy.enqueue(t.id, "complete", { output: "offline result" }); await legacy.close();
        },
      });
      await h.startDaemon({ waitForSocket: false });
      expect(h.client.connectionState()).toBe("connecting");
      expect(recover.mock.calls.some(([id]) => id === "offline-runtime")).toBe(false);
      expect(outbox(h).taskIdsWithPendingTerminal("offline-runtime")).toContain(historicalTask);
      expect(h.store.getTask(historicalTask)?.status).toBe("running");
    } finally { recover.mockRestore(); }
  });
});

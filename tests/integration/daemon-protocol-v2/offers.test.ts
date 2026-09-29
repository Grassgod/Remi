import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const harnesses: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) await h.dispose(); });

describe("A-3 real task offers", () => {
  it("offers and accepts a queued task without an HTTP claim or dispatch lease", async () => {
    const h = await DaemonProtocolHarness.create(); harnesses.push(h);
    const claim = spyOn(MultiremiDaemonClient.prototype, "claimTask");
    try {
      await h.startDaemon(); await h.settleHeartbeat();
      const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
      const agent = h.store.createAgent({ name: "no-op", provider: "claude", runtimeId, workspaceId: "local" });
      const task = h.store.createTask({ agentId: agent.id, prompt: "no-op" });
      await waitFor(() => h.store.getTask(task.id)?.status === "completed", "offered task completion");
      expect(claim).not.toHaveBeenCalled();
      expect(h.sockets.flatMap(socket => socket.frames).filter(frame => frame.t === "task.offer" && frame.p.id === task.id)).toHaveLength(1);
      expect(h.ledger.filter(entry => entry.type === "res" && entry.frame.p.ok === true)).toHaveLength(1);
      expect(h.store.getTask(task.id)).toMatchObject({ result: "fixture" });
      expect(h.store.getTask(task.id)?.offeredAt).toBeString();
      expect(h.store.getTask(task.id)?.acceptedAt).toBeString();
    } finally { claim.mockRestore(); }
  });

  for (const fault of ["disconnect", "daemon restart", "server restart"] as const) {
    it(`accepts every task exactly once through 20 ${fault} injections`, async () => {
      // All 20 injections can leave terminal reports in flight; keep capacity independent of host CPU count.
      const h = await DaemonProtocolHarness.create({ daemonOptions: { maxConcurrency: 20 } }); harnesses.push(h);
      await h.startDaemon(); await h.settleHeartbeat();
      const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
      const agent = h.store.createAgent({ name: "injected no-op", provider: "claude", runtimeId, workspaceId: "local" });
      for (let round = 0; round < 20; round++) {
        if (fault === "disconnect") { await h.disconnect(); await h.reconnect(); }
        else if (fault === "daemon restart") await h.restartDaemon();
        else await h.restartServer();
        const task = h.store.createTask({ agentId: agent.id, prompt: `no-op ${round}` });
        await waitFor(() => h.store.getTask(task.id)?.status === "completed", `${fault} task ${round}`, 5_000);
        const offers = h.sockets.flatMap(socket => socket.frames).filter(frame => frame.t === "task.offer" && frame.p.id === task.id);
        expect(offers).toHaveLength(1);
        const offer = offers[0]!;
        const replies = h.ledger.filter(entry => entry.type === "res" && entry.frame.re === String(offer.seq)
          && entry.sessionId === h.layer.registry.sessionForRuntime(runtimeId)!.sessionId);
        expect(replies.map(entry => entry.frame.p.ok)).toEqual([true]);
        expect(h.store.getTask(task.id)).toMatchObject({ runtimeId, result: "fixture" });
      }
      expect(h.store.listTasks().filter(task => task.status === "completed")).toHaveLength(20);
      expect(h.errors).toEqual([]);
    }, 60_000);
  }

  it("once exits successfully when its welcome-to-offer window is empty", async () => {
    const h = await DaemonProtocolHarness.create({ daemonOptions: { once: true, onceOfferTimeoutMs: 100 } }); harnesses.push(h);
    await h.startDaemon();
    const started = performance.now();
    await h.waitForDaemonExit();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(h.received.filter(frame => frame.t === "task.offer")).toEqual([]);
  });

  it("once runs one offered task, then exits successfully", async () => {
    const h = await DaemonProtocolHarness.create({ daemonOptions: { once: true, onceOfferTimeoutMs: 1_000 } }); harnesses.push(h);
    await h.startDaemon();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    const agent = h.store.createAgent({ name: "once", provider: "claude", runtimeId, workspaceId: "local" });
    const task = h.store.createTask({ agentId: agent.id, prompt: "once" });
    await h.waitForDaemonExit();
    expect(h.store.getTask(task.id)).toMatchObject({ status: "completed", result: "fixture" });
    expect(h.received.filter(frame => frame.t === "task.offer")).toHaveLength(1);
  });

  it("once rejects a second offer as draining and leaves it queued", async () => {
    let finish!: () => void;
    const finishing = new Promise<void>(resolve => { finish = resolve; });
    const h = await DaemonProtocolHarness.create({ daemonOptions: {
      once: true, onceOfferTimeoutMs: 1_000, maxConcurrency: 2,
      providerFactory: () => ({
        async *sendStream() { await finishing; yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "fixture" }] } as any; },
        getLastResponse: () => ({ text: "fixture", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
        close: async () => {},
      }),
    } }); harnesses.push(h);
    try {
      await h.startDaemon();
      const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
      const firstAgent = h.store.createAgent({ name: "first once", provider: "claude", runtimeId, workspaceId: "local" });
      const secondAgent = h.store.createAgent({ name: "second once", provider: "claude", runtimeId, workspaceId: "local" });
      const first = h.store.createTask({ agentId: firstAgent.id, prompt: "first" });
      await waitFor(() => h.store.getTask(first.id)?.status === "running", "first once running");
      const second = h.store.createTask({ agentId: secondAgent.id, prompt: "second" });
      await waitFor(() => h.ledger.some(entry => entry.type === "res" && entry.frame.p.code === "draining"), "second once rejection");
      expect(h.store.getTask(second.id)?.status).toBe("queued");
      finish(); await h.waitForDaemonExit();
      expect(h.store.getTask(first.id)?.status).toBe("completed");
      expect(h.store.getTask(second.id)?.status).toBe("queued");
    } finally { finish(); }
  });
});

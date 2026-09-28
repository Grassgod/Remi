import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DAEMON_HEARTBEAT_INTERVAL_MS } from "@multiremi/contracts/daemon-protocol.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const fixtures: DaemonProtocolHarness[] = [];
async function fixture(options: Parameters<typeof DaemonProtocolHarness.create>[0] = {}) {
  const h = await DaemonProtocolHarness.create(options);
  fixtures.push(h);
  return h;
}
afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.dispose();
});

describe("daemon protocol v2 real connection", () => {
  it("handshakes all provider lanes on one socket and continuously heartbeats without HTTP heartbeats", async () => {
    const heartbeat = spyOn(MultiremiDaemonClient.prototype, "heartbeatRuntime");
    try {
      const h = await fixture({ providers: ["claude", "codex"] });
      await h.startDaemon();
      await h.settleHeartbeat();
      expect(h.sockets).toHaveLength(1);
      expect(h.daemons[1]!.daemonProtocolClient()).toBe(h.client);
      const hello = h.ledger.find(entry => entry.type === "hello")!.frame;
      expect(hello.p.runtimes.map((rt: any) => rt.provider).sort()).toEqual(["claude", "codex"]);
      expect(h.layer.registry.size).toBe(1);
      for (let round = 0; round < 3; round++) {
        h.clock.advance(DAEMON_HEARTBEAT_INTERVAL_MS);
        await h.settleHeartbeat();
      }
      expect(h.ledger.filter(entry => entry.type === "hb")).toHaveLength(4);
      expect(heartbeat).not.toHaveBeenCalled();
      expect((await h.health()).protocol).toMatchObject({ state: "ok", server_min: 2, self: 2, next_probe_at: null });
    } finally { heartbeat.mockRestore(); }
  });

  it("survives 20 injected disconnects without leaking sockets, listeners, timers or pending RPCs", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    let seed = 418;
    for (let round = 0; round < 20; round++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      h.clock.advance(seed % 1_000);
      await h.disconnect();
      await h.reconnect();
      expect(h.layer.registry.size).toBe(1);
      expect(h.client.diagnostics()).toEqual({ timers: 2, sockets: 1, pending_rpcs: 0, background: 0 });
      expect(h.clock.pendingTimerCount).toBe(2);
      for (const socket of h.sockets.slice(0, -1)) {
        expect(socket.closed).toBe(true);
        expect([...socket.listeners.values()].every(set => set.size === 0)).toBe(true);
      }
    }
    expect(h.ledger.filter(entry => entry.type === "hello")).toHaveLength(21);
    await h.stopDaemon();
    expect(h.client.diagnostics()).toEqual({ timers: 0, sockets: 0, pending_rpcs: 0, background: 0 });
    expect(h.clock.pendingTimerCount).toBe(0);
  });

  it("records task and runtime partition keys with sequence numbers at real API ingress", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    // Business dispatch remains A-3/A-5; this only checks the ingress ledger.
    h.client.send({ t: "task.progress", rt: runtimeId, seq: 1, p: { task_id: "tsk_ledger", step: 1 } });
    h.client.send({ t: "runtime.update_result", rt: runtimeId, seq: 2, p: { id: "update-ledger", status: "completed" } });
    await waitFor(() => h.ledger.filter(entry => entry.seq !== null).length === 2, "server ingress ledger");
    expect(h.ledger.filter(entry => entry.seq !== null).map(({ partition, seq }) => ({ partition, seq }))).toEqual([
      { partition: "tsk_ledger", seq: 1 }, { partition: `rt:${runtimeId}`, seq: 2 },
    ]);
  });

  it("supports daemon stop/start and real API restart on the same port", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    await h.restartDaemon();
    await h.settleHeartbeat();
    expect(h.layer.registry.size).toBe(1);
    const port = h.server.port;
    await h.restartServer();
    expect(h.server.port).toBe(port);
    expect(h.layer.registry.size).toBe(1);
    expect(h.ledger.filter(entry => entry.type === "hello")).toHaveLength(3);
  });

  it("stops all lane claims after 4426 and probes the HTTP upgrade channel once per 60 seconds", async () => {
    const heartbeat = spyOn(MultiremiDaemonClient.prototype, "heartbeatRuntime");
    const claim = spyOn(MultiremiDaemonClient.prototype, "claimTask");
    try {
      const h = await fixture({ providers: ["claude", "codex"] });
      await h.startDaemon();
      await h.settleHeartbeat();
      h.sockets[0]!.close(4426);
      await waitFor(() => h.client.connectionState() === "upgrade_wait", "upgrade_wait");
      // Let a claim already in flight before the rejection finish.
      await Bun.sleep(50);
      const claims = claim.mock.calls.length;
      h.clock.advance(59_999);
      expect(heartbeat).not.toHaveBeenCalled();
      expect((await h.health()).protocol).toEqual({ state: "rejected", server_min: 2, self: 2, next_probe_at: new Date(h.clock.now() + 1).toISOString() });
      h.clock.advance(1);
      await h.client.drain();
      expect(heartbeat.mock.calls).toHaveLength(2);
      h.clock.advance(60_000);
      await h.client.drain();
      expect(heartbeat.mock.calls).toHaveLength(4);
      expect(claim.mock.calls).toHaveLength(claims);
      expect(h.sockets).toHaveLength(1);
    } finally { heartbeat.mockRestore(); claim.mockRestore(); }
  });

  it("re-registers a runtime deleted before hello, reconnects with the new ID and receives an offer", async () => {
    const deletedId = "rt_deleted_previous_registration";
    const recoverOrphans = MultiremiDaemonClient.prototype.recoverOrphans;
    let releaseRecovery!: () => void;
    const recovery = new Promise<void>(resolve => { releaseRecovery = resolve; });
    let recovering = false;
    let recoveries = 0;
    const recover = spyOn(MultiremiDaemonClient.prototype, "recoverOrphans").mockImplementation(async function (this: MultiremiDaemonClient, runtimeId) {
      if (++recoveries === 2) { recovering = true; await recovery; }
      return await recoverOrphans.call(this, runtimeId);
    });
    const claim = spyOn(MultiremiDaemonClient.prototype, "claimTask");
    try {
      const h = await fixture({ onReady: (daemon, h) => {
        // Simulate the stale cached ID of an older registration. Current register
        // deterministically returns a different canonical (daemon, provider) ID.
        h.store.registerRuntime({ id: deletedId, name: "previous", provider: "claude", workspaceId: "local", daemonId: "dmn_fixture" });
        expect(h.store.deleteRuntime(deletedId)).toBe(true);
        (daemon as unknown as { options: { runtimeId: string } }).options.runtimeId = deletedId;
      } });
      await h.startDaemon();
      await waitFor(() => recovering, "orphan recovery after runtime_gone");
      // A-5 refreshes WS identity at registration, before replay/model reports.
      // Claims still wait for the existing runtime recovery callback below.
      await waitFor(() => h.ledger.filter(entry => entry.type === "hello").length === 2
        && h.client.connectionState() === "connected", "registered identity before orphan recovery finishes");
      await Bun.sleep(50);
      const claims = claim.mock.calls.length;
      await Bun.sleep(50);
      expect(claim.mock.calls).toHaveLength(claims);
      releaseRecovery();
      await waitFor(() => h.ledger.filter(entry => entry.type === "hello").length === 2 && h.client.connectionState() === "connected", "runtime re-registration hello");
      await h.settleHeartbeat();
      const gone = h.sockets[0]!.frames.find(frame => frame.t === "res" && frame.p.runtime_acks?.some((ack: any) => ack.runtime_gone));
      expect(gone?.p.runtime_acks[0]).toMatchObject({ runtime_id: deletedId, status: "runtime_gone", runtime_gone: true });
      const newId = h.ledger.filter(entry => entry.type === "hello")[1]!.frame.p.runtimes[0].runtime_id;
      expect(newId).not.toBe(deletedId);
      expect(h.store.getRuntime(newId)?.daemonId).toBe("dmn_fixture");
      expect(h.layer.registry.sessionForRuntime(deletedId)).toBeNull();
      const session = h.layer.registry.sessionForRuntime(newId)! as typeof h.sessions[number];
      expect(session.sendEvent({ t: "task.offer", rt: newId, p: { task_id: "offer-after-register" } }).ok).toBe(true);
      await waitFor(() => h.received.some(frame => frame.t === "task.offer"), "new runtime offer");
      expect(h.received.at(-1)).toMatchObject({ rt: newId, p: { task_id: "offer-after-register" } });
      h.clock.advance(100);
      await waitFor(() => session.unacknowledgedFrameCount === 0, "independent offer acknowledgement");
      expect(recover).toHaveBeenCalledTimes(2);
    } finally { releaseRecovery(); recover.mockRestore(); claim.mockRestore(); }
  });

  it("recovers registry contention only after runtime_gone, registration and a fresh hello", async () => {
    let heldHeartbeat: { text: string; socket: WebSocket } | null = null;
    let hold = true;
    const h = await fixture({ runtimeId: "rt_contended", beforeSend: (frame, socket) => {
      if (frame.t === "hb" && hold) { heldHeartbeat = { text: JSON.stringify(frame), socket: socket.native }; return false; }
    } });
    h.store.registerRuntime({ id: "rt_contended", name: "contended", provider: "claude", workspaceId: "local" });
    const incumbent = new WebSocket(`${h.url.replace("http:", "ws:")}/api/daemon/ws?protocol=2`, { headers: { Authorization: "Bearer fixture-master" } } as never);
    try {
      await new Promise<void>((resolve, reject) => { incumbent.addEventListener("open", () => resolve(), { once: true }); incumbent.addEventListener("error", reject, { once: true }); });
      incumbent.send(JSON.stringify({ v: 2, t: "hello", ts: Date.now(), p: { protocol: 2, daemon_id: "dmn_incumbent", cli_version: "0.2.83", launched_by: null, runtimes: [{ runtime_id: "rt_contended", provider: "claude", max_concurrency: 1, active_task_ids: [] }], caps: [] } }));
      await waitFor(() => h.layer.registry.daemonIdForRuntime("rt_contended") === "dmn_incumbent", "incumbent runtime ownership");
      await h.startDaemon();
      const later = h.layer.registry.get("dmn_fixture")! as typeof h.sessions[number];
      expect(later.unavailableRuntimeIds).toEqual(["rt_contended"]);
      incumbent.close();
      await waitFor(() => h.layer.registry.get("dmn_incumbent") === null, "incumbent disconnect");
      expect(later.unavailableRuntimeIds).toEqual(["rt_contended"]);
      expect(h.layer.registry.sessionForRuntime("rt_contended")).toBeNull();
      expect(heldHeartbeat).not.toBeNull();
      hold = false;
      const held = heldHeartbeat as unknown as { text: string; socket: WebSocket };
      held.socket.send(held.text);
      await waitFor(() => h.ledger.filter(entry => entry.type === "hello" && entry.frame.p.daemon_id === "dmn_fixture").length === 2 && h.client.connectionState() === "connected", "contention recovery hello");
      await h.settleHeartbeat();
      expect(h.sockets[0]!.frames.some(frame => frame.p?.runtime_acks?.some((ack: any) => ack.runtime_gone))).toBe(true);
      const recovered = h.layer.registry.sessionForRuntime("rt_contended")! as typeof h.sessions[number];
      expect(recovered).not.toBe(later);
      expect(recovered.unavailableRuntimeIds).toEqual([]);
      expect(recovered.sendEvent({ t: "task.offer", rt: "rt_contended", p: { task_id: "offer-after-contention" } }).ok).toBe(true);
      await waitFor(() => h.received.some(frame => frame.p?.task_id === "offer-after-contention"), "contention recovery offer");
    } finally { incumbent.close(); }
  });

  it("keeps teardown ordering even when an injected assertion or wait fails", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    try { throw new Error("injected test failure"); }
    catch { await h.dispose(); }
    expect(h.teardownSteps).toEqual(["stop daemon", "drain background", "stop server", "close Store"]);
    expect(h.clock.pendingTimerCount).toBe(0);
  });
});

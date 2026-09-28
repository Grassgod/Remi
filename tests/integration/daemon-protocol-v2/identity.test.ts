import { expect, it } from "bun:test";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

it("keeps the implicit daemon identity across two providers, stale runtime recovery and complete instance replacement", async () => {
  let injectStale = false;
  const oldId = "rt_deleted_identity_probe";
  const h = await DaemonProtocolHarness.create({
    providers: ["claude", "codex"], omitDaemonId: true,
    onReady: daemon => {
      if (injectStale && (daemon as any).options.provider === "claude") {
        injectStale = false;
        (daemon as any).options.runtimeId = oldId;
      }
    },
  });
  try {
    await h.startDaemon();
    await h.settleHeartbeat();
    const initial = h.ledger.find(entry => entry.type === "hello")!.frame.p;
    await h.stopDaemon();
    h.store.registerRuntime({ id: oldId, name: "Deleted runtime", provider: "claude", daemonId: initial.daemon_id });
    expect(h.store.deleteRuntime(oldId)).toBeTrue();
    injectStale = true;
    await h.startDaemon();
    await waitFor(() => h.ledger.filter(entry => entry.type === "hello").length >= 3, "runtime recovery fresh hello");
    await h.settleHeartbeat();
    const stale = h.ledger.filter(entry => entry.type === "hello")[1]!.frame.p;
    expect(stale.runtimes.some((runtime: any) => runtime.runtime_id === oldId)).toBeTrue();
    expect(h.sockets.some(socket => socket.frames.some(frame => frame.t === "res" && frame.p?.runtime_acks?.some((ack: any) => ack.runtime_id === oldId && ack.status === "runtime_gone")))).toBeTrue();
    const recovered = h.ledger.filter(entry => entry.type === "hello")[2]!.frame.p;
    expect(recovered.runtimes.every((runtime: any) => h.store.getRuntime(runtime.runtime_id))).toBeTrue();
    const previous = [...h.daemons];
    await h.recreateDaemon();
    await h.settleHeartbeat();
    expect(h.daemons.every(daemon => !previous.includes(daemon))).toBeTrue();
    const rebuilt = h.ledger.filter(entry => entry.type === "hello").at(-1)!.frame.p;
    for (const hello of [initial, stale, recovered, rebuilt]) {
      expect(hello.daemon_id).toBe(initial.daemon_id);
      expect(hello.runtimes.map((runtime: any) => runtime.provider).sort()).toEqual(["claude", "codex"]);
      expect(hello.runtimes).toHaveLength(2);
    }
    expect(h.layer.registry.size).toBe(1);
  } finally { await h.dispose(); }
});

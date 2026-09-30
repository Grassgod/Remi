import { afterEach, describe, expect, it } from "bun:test";
import { DaemonProtocolClient, type DaemonProtocolSocketLike } from "@multiremi/worker/daemon-protocol-client.js";
import { registerDaemonOfferHandler, type OfferRejection } from "@multiremi/worker/daemon-offers.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";

class OfferSocket implements DaemonProtocolSocketLike {
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  listeners = new Map<string, Set<(event: any) => void>>();
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() {}
  addEventListener(type: string, callback: (event: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(callback);
  }
  removeEventListener(type: string, callback: (event: any) => void) { this.listeners.get(type)?.delete(callback); }
  emit(type: string, event: any) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
  frame(frame: Record<string, unknown>) { this.emit("message", { data: JSON.stringify({ v: 2, ...frame }) }); }
}

const clients: DaemonProtocolClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) { client.close(); await client.drain(); } });

function fixture() {
  const socket = new OfferSocket();
  const client = new DaemonProtocolClient({ serverUrl: "http://fixture", daemonId: "dmn_unit", cliVersion: "0.2.83",
    clock: new ManualDaemonProtocolClock(), connect: () => socket });
  clients.push(client);
  const lane = { runtime: () => ({ runtime_id: "rt_unit", provider: "claude", max_concurrency: 1, active_task_ids: [] }),
    heartbeat: () => ({ active_task_count: 0 }), onHeartbeatAck: async () => {}, probeUpgrade: async () => {}, onTerminal: async () => {} };
  client.addLane(lane); client.startLane(lane);
  socket.emit("open", {}); socket.frame({ t: "welcome", p: { protocol: 2, session_id: "unit" } });
  const hb = socket.sent.find(frame => frame.t === "hb")!;
  socket.frame({ t: "res", re: hb.id, p: { ok: true, runtime_acks: [] } });
  let rejection: OfferRejection | null = null;
  const handled: string[] = [];
  registerDaemonOfferHandler(client, { runtimeId: () => "rt_unit", rejection: () => rejection, run: task => { handled.push(task.id); } });
  let seq = 0;
  const offer = async (id: string, rt = "rt_unit") => {
    socket.frame({ t: "task.offer", seq: ++seq, rt, p: { id, runtime_id: rt, agent_id: "agt_unit", prompt: "work", agent: { provider: "claude" } } });
    await client.drain();
    return socket.sent.findLast(frame => frame.t === "res" && frame.re === String(seq));
  };
  return { handled, offer, reject: (code: OfferRejection | null) => { rejection = code; } };
}

describe("daemon task offers", () => {
  it("accepts and executes an entity once, including a replay after capacity fills", async () => {
    const h = fixture();
    expect((await h.offer("tsk_one"))?.p).toEqual({ ok: true });
    h.reject("capacity");
    expect((await h.offer("tsk_one"))?.p).toEqual({ ok: true });
    expect(h.handled).toEqual(["tsk_one"]);
  });
  for (const code of ["capacity", "claims_paused", "draining", "binary_skill_files_unsupported"] as const) {
    it(`rejects ${code} without consuming the entity's dedupe key`, async () => {
      const h = fixture(); h.reject(code);
      expect((await h.offer("tsk_one"))?.p).toEqual({ ok: false, code });
      expect(h.handled).toEqual([]);
      h.reject(null);
      expect((await h.offer("tsk_one"))?.p).toEqual({ ok: true });
      expect(h.handled).toEqual(["tsk_one"]);
    });
  }
  it("ignores another runtime's offer", async () => {
    const h = fixture();
    expect(await h.offer("tsk_foreign", "rt_foreign")).toBeUndefined();
    expect(h.handled).toEqual([]);
  });
});

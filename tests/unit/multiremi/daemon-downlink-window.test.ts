import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DaemonDownlinks, type DaemonDownlinkEntity } from "@multiremi/api/daemon-protocol/downlinks.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

const layers: DaemonProtocolLayer[] = [];
afterEach(async () => {
  for (const layer of layers.splice(0)) { layer.closeAll(); layer.stop(); await layer.drain(); }
  resetMultiremiTestEnv();
});

async function fixture() {
  const store = createLocalStore();
  store.registerRuntime({ id: "rt_window", name: "Window", provider: "claude", daemonId: "dmn_window" });
  const layer = new DaemonProtocolLayer({ store }); layers.push(layer);
  const entities: DaemonDownlinkEntity[] = [];
  const clock = new ManualDaemonProtocolClock();
  const downlinks = new DaemonDownlinks({ layer, clock, snapshot: () => entities });
  let status: number | null = null;
  const frames: Array<Record<string, any>> = [];
  const connect = async () => {
    const session = layer.openSession({ send(text) { frames.push(JSON.parse(text)); return status ?? text.length; }, close() {} },
      { accessToken: null, masterToken: true });
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2, daemon_id: "dmn_window",
      cli_version: DAEMON_MIN_CLI_VERSION, caps: [], runtimes: [{ runtime_id: "rt_window", provider: "claude",
        max_concurrency: 1, active_task_ids: [] }] } }));
    await layer.drain();
    return session;
  };
  const session = await connect();
  return { layer, clock, downlinks, entities, frames, session, connect,
    async kick() { downlinks.kick("rt_window"); await layer.drain(); },
    async ack(seq: number) {
      await session.handleMessage(JSON.stringify({ v: 2, t: "ack", ack: seq, p: {} })); await layer.drain();
    },
    setSendStatus(value: number | null) { status = value; },
  };
}

describe("A-4 downlink window execution", () => {
  it("waits for an ACK when the window is full and never claims an unsent entity", async () => {
    const h = await fixture(); let claimed = 0;
    for (let i = 0; i < 64; i++) expect(h.session.sendEvent({ t: "runtime.command", p: { id: `filler_${i}` } }).ok).toBe(true);
    h.entities.push({ key: "next", type: "runtime.command", payload: { id: "next" }, claimed: () => { claimed++; } });
    await h.kick(); await h.kick();
    expect(h.frames.filter(frame => frame.p.id === "next")).toEqual([]); expect(claimed).toBe(0);
    await h.ack(64);
    const next = h.frames.find(frame => frame.p.id === "next")!;
    expect(next.seq).toBe(65); expect(claimed).toBe(0);
    await h.ack(next.seq); await h.ack(next.seq); await h.kick();
    expect(claimed).toBe(1); expect(h.frames.filter(frame => frame.p.id === "next")).toHaveLength(1);
  });

  it("waits for drain while paused without resending the accepted frame", async () => {
    const h = await fixture(); let firstClaims = 0; let secondClaims = 0;
    h.entities.push({ key: "first", type: "runtime.command", payload: { id: "first" }, claimed: () => { firstClaims++; } },
      { key: "second", type: "runtime.command", payload: { id: "second" }, claimed: () => { secondClaims++; } });
    h.setSendStatus(-1); await h.kick();
    expect(h.frames.filter(frame => frame.p.id === "first")).toHaveLength(1);
    expect(h.frames.filter(frame => frame.p.id === "second")).toHaveLength(0);
    h.setSendStatus(null); await h.kick();
    expect(h.frames.filter(frame => frame.p.id === "second")).toHaveLength(0);
    h.session.handleDrain(); await h.layer.drain();
    expect(h.frames.filter(frame => frame.p.id === "first")).toHaveLength(1);
    expect(h.frames.filter(frame => frame.p.id === "second")).toHaveLength(1);
    expect([firstClaims, secondClaims]).toEqual([0, 0]);
    await h.ack(h.session.lastSentSeq); expect([firstClaims, secondClaims]).toEqual([1, 1]);
  });

  it("reconstructs an unacknowledged entity after close without claiming it first", async () => {
    const h = await fixture(); let claimed = 0;
    h.entities.push({ key: "pending", type: "runtime.command", payload: { id: "pending" }, claimed: () => { claimed++; } });
    await h.kick(); const first = h.frames.find(frame => frame.p.id === "pending")!;
    h.session.handleSocketClose(); await h.kick();
    expect(claimed).toBe(0); expect(h.frames.filter(frame => frame.p.id === "pending")).toHaveLength(1);
    const reconnected = await h.connect();
    const replay = h.frames.filter(frame => frame.p.id === "pending");
    expect(replay).toHaveLength(2); expect(replay[1]!.p).toEqual(first.p);
    await reconnected.handleMessage(JSON.stringify({ v: 2, t: "ack", ack: replay[1]!.seq, p: {} }));
    await h.layer.drain(); expect(claimed).toBe(1);
  });

  it("retains the ACK claim until a transient DB failure has been retried", async () => {
    const h = await fixture(); let failing = true; let claimed = 0;
    h.entities.push({ key: "db_retry", type: "runtime.command", payload: { id: "db_retry" }, claimed: () => {
      if (failing) throw new Error("Injected transaction failure"); claimed++;
    } });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.kick(); await h.ack(h.session.lastSentSeq);
      expect(claimed).toBe(0); expect(h.frames.filter(frame => frame.p.id === "db_retry")).toHaveLength(1);
      failing = false; h.clock.advance(1_000); await h.layer.drain();
      expect(claimed).toBe(1); await h.kick(); expect(claimed).toBe(1);
      expect(h.frames.filter(frame => frame.p.id === "db_retry")).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it("discards an oversized entity once, logs its identity and proceeds", async () => {
    const h = await fixture(); let discarded = 0; let claimed = 0;
    h.entities.push({ key: "huge", type: "runtime.command", payload: { id: "huge", command: "x".repeat(1_048_576) },
      discard: () => { discarded++; }, claimed: () => { throw new Error("Oversized frame must not wait for ACK"); } },
    { key: "small", type: "runtime.command", payload: { id: "small" }, claimed: () => { claimed++; } });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.kick(); await h.kick();
      expect(discarded).toBe(1); expect(h.frames.some(frame => frame.p.id === "huge")).toBe(false);
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ event: "daemon_downlink_too_large", entity_id: "huge" });
      await h.ack(h.session.lastSentSeq); expect(claimed).toBe(1);
    } finally { warn.mockRestore(); }
  });
});

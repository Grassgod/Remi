import { afterEach, expect, it } from "bun:test";
import { DaemonDownlinks } from "@multiremi/api/daemon-protocol/downlinks.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { createLocalStore, resetMultiremiTestEnv } from "../multiremi/helpers.js";

afterEach(resetMultiremiTestEnv);

it("flushes execution input before deriving independent queues and preserves configuration across ACK scans", async () => {
  const store = createLocalStore();
  const runtimeId = "rt_priority";
  store.registerRuntime({ id: runtimeId, name: "Priority", provider: "claude", daemonId: "dmn_priority" });
  const layer = new DaemonProtocolLayer({ store });
  const frames: Record<string, any>[] = [];
  let messagePending = true;
  let revision = 1;
  let independentQueueRead = false;
  let inputFlushed = false;
  const downlinks = new DaemonDownlinks({ layer, snapshot: function* (_runtimeId, _session, _active, mode) {
    if (messagePending) yield { key: "input:1", type: "turn.message", payload: { message: { id: "msg_input" } },
      claimed: () => { messagePending = false; } };
    expect(inputFlushed).toBe(true);
    independentQueueRead = true;
    if (mode === "full") yield { key: `settings:${revision}`, type: "workspace.settings",
      payload: { revision }, configuration: true };
  } });
  const session = layer.openSession({ send(text) {
    const frame = JSON.parse(text); frames.push(frame);
    if (frame.t === "turn.message") {
      expect(independentQueueRead).toBe(false);
      setImmediate(() => { inputFlushed = true; });
    }
    return text.length;
  }, close() {} }, { accessToken: null, masterToken: true });
  try {
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2,
      daemon_id: "dmn_priority", cli_version: DAEMON_MIN_CLI_VERSION, caps: [], runtimes: [{
        runtime_id: runtimeId, provider: "claude", max_concurrency: 1, active_task_ids: [], capabilities: {},
      }] } }));
    await layer.drain();
    expect(independentQueueRead).toBe(true);
    expect(frames.filter(frame => frame.t === "workspace.settings").map(frame => frame.p.revision)).toEqual([1]);
    await session.handleMessage(JSON.stringify({ v: 2, t: "ack", ack: session.lastSentSeq, p: {} }));
    await layer.drain();
    expect(messagePending).toBe(false);
    downlinks.kick(runtimeId, "pending"); await layer.drain();
    downlinks.kick(runtimeId); await layer.drain();
    expect(frames.filter(frame => frame.t === "turn.message")).toHaveLength(1);
    expect(frames.filter(frame => frame.t === "workspace.settings")).toHaveLength(1);
    revision = 2;
    downlinks.kick(runtimeId, "pending"); downlinks.kick(runtimeId); await layer.drain();
    expect(frames.filter(frame => frame.t === "workspace.settings").map(frame => frame.p.revision)).toEqual([1, 2]);
  } finally { layer.closeAll(); layer.stop(); await layer.drain(); }
});

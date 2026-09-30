import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { startMultiremiServer } from "../../fixtures/daemon-protocol.js";
import { createLocalStore, resetMultiremiTestEnv } from "../multiremi/helpers.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonProtocolClient, type DaemonProtocolLane } from "@multiremi/worker/daemon-protocol-client.js";
import { DaemonTaskDownlinks } from "@multiremi/worker/daemon-downlinks.js";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";

afterEach(resetMultiremiTestEnv);

async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Task downlink did not settle");
    await Bun.sleep(1);
  }
}

function fixture() {
  const store = createLocalStore();
  const rt = "rt_task_inputs";
  store.registerRuntime({ id: rt, name: rt, provider: "claude", daemonId: "dmn_task_inputs",
    workspaceId: "local", maxConcurrency: 4, metadata: { parallel_agent_execution: 1 } });
  const agent = store.createAgent({ name: "Task inputs", provider: "claude", runtimeId: rt, maxConcurrentTasks: 4 });
  const active: string[] = [];
  const task = () => {
    const row = store.createTask({ agentId: agent.id, prompt: "Task input fixture" });
    expect(store.claimTask(rt)?.id).toBe(row.id);
    store.startTask(row.id); active.push(row.id);
    return row;
  };
  let layer!: DaemonProtocolLayer;
  const server = startMultiremiServer({ store, hostname: "127.0.0.1", port: 0, authToken: "task-input-fixture",
    onDaemonProtocol: value => { layer = value; } });
  const clock = new ManualDaemonProtocolClock();
  const sockets: WebSocket[] = [];
  const frames: Array<Record<string, any>> = [];
  const errors: Error[] = [];
  const client = new DaemonProtocolClient({ serverUrl: `http://127.0.0.1:${server.port}`, token: "task-input-fixture",
    daemonId: "dmn_task_inputs", cliVersion: DAEMON_MIN_CLI_VERSION, clock, random: () => 0.5,
    onError: error => { errors.push(error); }, onFrame: frame => { frames.push(frame.raw); },
    connect: (url, init) => {
      const socket = new WebSocket(url, init as never); sockets.push(socket); return socket;
    } });
  const inbox = new DaemonTaskDownlinks(client, () => rt);
  const lane: DaemonProtocolLane = {
    runtime: () => ({ runtime_id: rt, provider: "claude", max_concurrency: 4, active_task_ids: [...active] }),
    heartbeat: () => ({ active_task_count: active.length }),
    onHeartbeatAck: async () => {}, probeUpgrade: async () => {}, onTerminal: async () => {},
    onStateChange: () => inbox.connectionChanged(),
    onConnected: () => { client.send({ t: "runtime.ready", rt, p: { active_task_ids: lane.runtime()!.active_task_ids } }); },
  };
  client.addLane(lane);
  const disconnect = async () => {
    sockets.at(-1)!.close(4001);
    await waitFor(() => client.connectionState() === "disconnected" && layer.registry.size === 0);
    await client.drain(); await layer.drain();
  };
  return { store, rt, task, inbox, frames, errors,
    async start() { client.startLane(lane); await waitFor(() => client.connectionState() === "connected"); await client.drain(); await layer.drain(); },
    disconnect,
    async reconnect() { clock.advance(1_000); await waitFor(() => client.connectionState() === "connected"); await client.drain(); await layer.drain(); },
    async close() {
      client.stopLane(lane); await client.drain();
      await waitFor(() => sockets.every(socket => socket.readyState === WebSocket.CLOSED) && layer.registry.size === 0);
      layer.closeAll(); await layer.drain(); server.stop(true);
    },
  };
}

describe("A-4 task push inbox over native WS", () => {
  it("processes offline steer, human settlement and cancellation once across two reconnect snapshots", async () => {
    const h = fixture();
    const steerTask = h.task(); const humanTask = h.task(); const cancelledTask = h.task();
    const request = h.store.createTaskHumanRequest({ taskId: humanTask.id, kind: "question", payload: { question: "Continue?" } });
    let steerCount = 0; let cancelCount = 0;
    const unsubscribe = h.inbox.subscribeTaskSteerMessages(steerTask.id, () => { steerCount++; });
    const unwatch = h.inbox.observeCancellation(cancelledTask.id, status => { expect(status).toBe("cancelled"); cancelCount++; });
    const human = h.inbox.waitForHumanDecision(request.id, new AbortController().signal, 2_000);
    try {
      await h.start(); await h.disconnect();
      const steer = h.store.createTaskSteerMessage({ taskId: steerTask.id, kind: "steer", content: "Offline directive" });
      const settled = h.store.respondTaskHumanRequest(request.id, { response: { answer: "Yes" }, respondedBy: "fixture" });
      h.store.cancelTask(cancelledTask.id);
      expect(steerCount).toBe(0); expect(cancelCount).toBe(0);
      await h.reconnect();
      await waitFor(() => steerCount === 1 && cancelCount === 1);
      expect(await human).toEqual(settled);
      expect(h.inbox.pendingTaskSteerMessages(steerTask.id).map(message => message.id)).toEqual([steer.id]);
      await h.disconnect(); await h.reconnect();
      await waitFor(() => h.frames.filter(frame => frame.t === "task.steer").length === 2);
      expect(steerCount).toBe(1); expect(cancelCount).toBe(1);
      expect(await h.inbox.waitForHumanDecision(request.id, new AbortController().signal, 100)).toEqual(settled);
      await h.inbox.consumeTaskSteerMessages(steerTask.id, [steer.id]);
      await h.inbox.consumeTaskSteerMessages(steerTask.id, [steer.id]);
      expect(h.store.listPendingTaskSteerMessages(steerTask.id)).toEqual([]);
      expect(h.inbox.pendingTaskSteerMessages(steerTask.id)).toEqual([]);
      expect(h.store.getTaskHumanRequest(request.id)).toEqual(settled);
      expect(h.errors).toEqual([]);
    } finally { unsubscribe(); unwatch(); await h.close(); }
  });

  it("ignores a non-running task cancellation without purging its pending terminal outbox row", async () => {
    const h = fixture(); const task = h.task(); h.store.completeTask(task.id, { output: "Done" });
    let release!: () => void;
    const delivered = new Promise<void>(resolve => { release = resolve; });
    const outbox = new MultiremiTaskReportOutbox({ path: ":memory:", deliver: () => delivered });
    const purge = spyOn(outbox, "purgeTask");
    outbox.enqueue(task.id, "complete", { output: "Done" });
    try {
      await h.start(); await waitFor(() => h.frames.some(frame => frame.t === "task.cancelled"));
      await h.disconnect(); await h.reconnect();
      await waitFor(() => h.frames.filter(frame => frame.t === "task.cancelled").length === 2);
      expect(purge).not.toHaveBeenCalled();
      expect(outbox.taskIdsWithPendingTerminal()).toEqual([task.id]);
      expect(outbox.stats().pendingTerminal).toBe(1);
      expect(h.errors).toEqual([]);
    } finally { await h.close(); release(); await outbox.close(); purge.mockRestore(); }
  });
});

import { createResponsibleTestIssue } from "../multiremi/helpers.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { startMultiremiServer } from "../../fixtures/daemon-protocol.js";
import { createLocalStore, resetMultiremiTestEnv } from "../multiremi/helpers.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import type { DaemonTurnBridge } from "@multiremi/api/daemon-protocol/turn-bridge.js";
import type { UnifiedMessage } from "@multiremi/contracts/unified-model.js";
import { DaemonProtocolSession } from "@multiremi/api/daemon-protocol/session.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonProtocolClient, type DaemonProtocolLane } from "@multiremi/worker/daemon-protocol-client.js";
import { DaemonTaskDownlinks } from "@multiremi/worker/daemon-downlinks.js";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";
import { registerDaemonOfferHandler, type DaemonTurnTask } from "@multiremi/worker/daemon-offers.js";
import { runtimeInputSnapshot } from "@multiremi/api/daemon-protocol/runtime-input-snapshot.js";

afterEach(resetMultiremiTestEnv);

it("reads plugin desired state only for a runtime that advertises the plugin protocol", () => {
  const store = createLocalStore();
  store.registerRuntime({ id: "rt_no_plugin_protocol", name: "No plugin support", provider: "claude" });
  store.registerRuntime({ id: "rt_plugin_protocol", name: "Plugin support", provider: "claude", metadata: { agent_plugin_protocol: 1 } });
  const desired = spyOn(store, "getRuntimeAgentPluginDesiredSnapshot");
  try {
    expect(runtimeInputSnapshot(store, "rt_no_plugin_protocol").some(entity => entity.type === "plugin.desired_revision")).toBe(false);
    expect(desired).not.toHaveBeenCalled();
    expect(runtimeInputSnapshot(store, "rt_plugin_protocol").some(entity => entity.type === "plugin.desired_revision")).toBe(true);
    expect(desired).toHaveBeenCalledTimes(1);
    expect(desired).toHaveBeenCalledWith("rt_plugin_protocol");
  } finally { desired.mockRestore(); }
});

it("reads fresh pending commands without rehydrating unchanged runtime configuration", () => {
  const store = createLocalStore();
  store.registerRuntime({ id: "rt_pending_only", name: "Pending", provider: "claude" });
  const command = store.createRuntimeCommandRequest("rt_pending_only", { command: "printf fresh", args: [] });
  const maintenance = spyOn(store, "getPlatformMaintenance");
  try {
    const pending = runtimeInputSnapshot(store, "rt_pending_only", undefined, "pending");
    expect(pending.find(entity => entity.type === "runtime.command")?.payload.id).toBe(command.id);
    expect(maintenance).not.toHaveBeenCalled();
    const full = runtimeInputSnapshot(store, "rt_pending_only");
    expect(full.some(entity => entity.type === "platform.drain")).toBe(true);
    expect(maintenance).toHaveBeenCalledTimes(1);
    store.reportRuntimeCommandResult("rt_pending_only", command.id, { status: "completed", exitCode: 0 });
    expect(runtimeInputSnapshot(store, "rt_pending_only", undefined, "pending")
      .some(entity => entity.type === "runtime.command")).toBe(false);
  } finally { maintenance.mockRestore(); }
});

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
  const messages: ReturnType<DaemonTurnBridge["snapshot"]>["messages"] = [];
  const wraps: ReturnType<DaemonTurnBridge["snapshot"]>["wrapUps"] = [];
  const bridge: DaemonTurnBridge = {
    offerInput: () => { throw new Error("No offer expected in active-task fixture"); },
    snapshot: () => ({ messages: [...messages], wrapUps: [...wraps] }),
    rpc: (type, payload) => {
      if (type === "turn.input") {
        for (let index = messages.length - 1; index >= 0; index--) {
          if (payload.message_ids instanceof Array && payload.message_ids.includes(messages[index]!.message.id)) messages.splice(index, 1);
        }
      }
      return type === "turn.decision" ? { ok: true, message: message(1, {
        id: "decision_live", message_kind: "decision", body_md: String(payload.body_md), metadata: payload.metadata as Record<string, unknown>,
      }) } : { ok: true };
    },
    complete: () => ({ ok: true }),
  };
  const task = () => {
    const row = store.createTask({ agentId: agent.id, prompt: "Task input fixture" });
    expect(store.claimTask(rt)?.id).toBe(row.id);
    store.startTask(row.id); active.push(row.id);
    inbox.bindTurn({ turn_id: `turn_${row.id}`, attempt_id: row.id, input_from_seq: 0, input_to_seq: 1, input_messages: [] });
    return row;
  };
  let layer!: DaemonProtocolLayer;
  const server = startMultiremiServer({ store, hostname: "127.0.0.1", port: 0, authToken: "task-input-fixture",
    daemonTurnBridge: bridge, onDaemonProtocol: value => { layer = value; } });
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
  return { store, rt, task, inbox, client, frames, errors, messages, wraps,
    push(attemptId: string, input: UnifiedMessage) {
      const session = layer.registry.sessionForRuntime(rt);
      if (!(session instanceof DaemonProtocolSession)) throw new Error("No runtime session");
      session.sendEvent({ t: "turn.message", rt, p: { turn_id: `turn_${attemptId}`, attempt_id: attemptId, message: input } });
    },
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

const message = (seq: number, overrides: Partial<UnifiedMessage> = {}): UnifiedMessage => ({
  id: `msg_${seq}`, kind: "message", seq, session_id: "ises_fixture", body_md: "Yes",
  sender_type: "member", sender_id: "member_fixture", message_kind: "reply", metadata: {},
  created_at: "2026-10-05T00:00:00Z", ...overrides,
} as UnifiedMessage);

describe("turn input push inbox over native WS", () => {
  it("starts with the Store bridge and persists offers, input, permissions, wrap-up and completion", async () => {
    const store = createLocalStore();
    const rt = "rt_store_inputs", daemonId = "dmn_store_inputs";
    store.registerRuntime({ id: rt, daemonId, name: rt, provider: "claude", workspaceId: "local",
      metadata: { parallel_agent_execution: 1 } });
    const agent = store.createAgent({ name: "Store inputs", provider: "claude", runtimeId: rt });
    const issue = createResponsibleTestIssue(store, { title: "Store inputs", assigneeType: "agent", assigneeId: agent.id, responsibleMemberId: "mem_local_local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const send = (body: string) => store.sendMessage({ session_id: session.id,
      sender: { type: "member", id: "mem_local_local" }, to: { type: "agent", ref: agent.id },
      message_kind: "request", wake_requested: "now", body_md: body });
    const seed = send("Prior attempt input");
    // A retry gives this turn a distinct current attempt and exercises both IDs.
    store.recordSessionAgentRangeRead(session.id, agent.id, { seq: 1, offset: 0 }, { seq: seed.message.seq + 1, offset: 0 });
    store.cancelTurn(seed.turn_id!);
    store.retryTurn(seed.turn_id!, true);
    const initial = send("Start from the canonical message");
    let layer!: DaemonProtocolLayer;
    const server = startMultiremiServer({ store, hostname: "127.0.0.1", port: 0, authToken: "store-input-fixture",
      onDaemonProtocol: value => { layer = value; } });
    const sockets: WebSocket[] = [], frames: Array<Record<string, any>> = [], errors: Error[] = [];
    const active: string[] = [];
    let offered: DaemonTurnTask | undefined;
    const client = new DaemonProtocolClient({ serverUrl: `http://127.0.0.1:${server.port}`, token: "store-input-fixture",
      daemonId, cliVersion: DAEMON_MIN_CLI_VERSION,
      onError: error => { errors.push(error); }, onFrame: frame => { frames.push(frame.raw); },
      connect: (url, init) => { const socket = new WebSocket(url, init as never); sockets.push(socket); return socket; } });
    const inbox = new DaemonTaskDownlinks(client, () => rt);
    registerDaemonOfferHandler(client, { runtimeId: () => rt, rejection: () => null,
      run: task => { offered = task; active.push(task.id); inbox.bindTurn(task); } });
    const lane: DaemonProtocolLane = {
      runtime: () => ({ runtime_id: rt, provider: "claude", max_concurrency: 1, active_task_ids: [...active] }),
      heartbeat: () => ({ active_task_count: active.length }),
      onHeartbeatAck: async () => {}, probeUpgrade: async () => {}, onTerminal: async () => {},
      onStateChange: () => inbox.connectionChanged(),
      onConnected: () => { client.send({ t: "runtime.ready", rt, p: { active_task_ids: [...active] } }); },
    };
    client.addLane(lane);
    try {
      client.startLane(lane);
      await waitFor(() => offered !== undefined);
      const task = offered!;
      expect(task.turn_id).toBe(initial.turn_id!);
      expect(task.attempt_id).toBe(store.getTurn(task.turn_id)!.current_attempt_id!);
      expect(task.turn_id).not.toBe(task.attempt_id);
      expect(task.input_messages.some(m => m.id === initial.message.id && m.body_md.includes(initial.message.body_md))).toBe(true);
      const wire = frames.find(frame => frame.t === "task.offer")!.p;
      expect(wire).not.toHaveProperty("id"); expect(wire).not.toHaveProperty("prompt");
      expect(await client.event({ t: "task.start", seq: 1, rt, p: { task_id: task.id } })).toMatchObject({ ok: true });
      await inbox.consumeTaskSteerMessages(task.id, task.input_messages.map(m => m.id));
      expect(store.getTurn(task.turn_id)!.input_to_seq).toBe(task.input_to_seq);

      const interrupt = send("Process this live input");
      await waitFor(() => inbox.pendingTaskSteerMessages(task.id).some(m => m.id === interrupt.message.id));
      await inbox.consumeTaskSteerMessages(task.id, [interrupt.message.id]);
      expect(store.getTurn(task.turn_id)!.input_to_seq).toBe(interrupt.message.seq);

      inbox.beginDecision(task.id);
      inbox.beginQuestionWait(task.id, "store-permission-question", "store-permission-wait");
      const created = await inbox.rpc("turn.decision", { ...inbox.turnInput(task.id), body_md: "Allow tool?",
        message_id: "store-permission-question", wait_id: "store-permission-wait",
        dedupe_key: "store-permission", options: [{ label: "Allow", value: "allow" }],
        metadata: { kind: "permission", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
      const decision = created.message as UnifiedMessage;
      inbox.registerDecision(decision, task.id);
      expect(store.getTurn(task.turn_id)!.status).toBe("awaiting_human");
      expect(store.getMessage(decision.id)!.message_kind).toBe("decision");
      const answered = store.answerQuestion(decision.id, { expected_route_revision: store.getQuestion(decision.id)!.route_revision,
        body_md: "Allow", response: { option_id: "allow" } }, { type: "member", id: "mem_local_local" });
      const reply = await inbox.waitForDecisionReply(decision.id, new AbortController().signal, 2_000);
      expect(reply?.id).toBe(answered.message.id);
      expect(store.getTurn(task.turn_id)!.status).toBe("running");
      expect(await inbox.rpc("turn.decision.get", { ...inbox.turnInput(task.id), message_id: decision.id })).toMatchObject({
        ok: true, status: "resolved", reply: { id: answered.message.id } });
      inbox.confirmDecisionReply(task.id, reply!); inbox.finishDecision(task.id);
      await inbox.consumeTaskSteerMessages(task.id, []);
      expect(store.getTurn(task.turn_id)!.input_to_seq).toBe(answered.message.seq);

      store.wrapUpTurn(task.turn_id);
      await waitFor(() => inbox.pendingTaskSteerMessages(task.id).some(m => m.kind === "force_answer"));
      const completion = { ...inbox.turnInput(task.id), reply: { body_md: "Store-backed final reply", message_kind: "final" } };
      const done = await client.event({ t: "turn.complete", seq: 2, rt, p: completion });
      expect(done).toMatchObject({ ok: true, turn_id: task.turn_id });
      expect(store.getTurn(task.turn_id)).toMatchObject({ status: "completed", reply_message_id: done.reply_message_id });
      expect(store.getMessage(String(done.reply_message_id))).toMatchObject({ body_md: completion.reply.body_md, message_kind: "final" });
      expect(store.getMessage(decision.id)!.message_kind).toBe("decision");
      expect(await client.event({ t: "turn.complete", seq: 3, rt, p: completion })).toEqual(done);
      expect(errors).toEqual([]);
    } finally {
      client.stopLane(lane); await client.drain();
      await waitFor(() => sockets.every(socket => socket.readyState === WebSocket.CLOSED) && layer.registry.size === 0);
      layer.closeAll(); await layer.drain(); server.stop(true);
    }
  });

  it("resumes a permission decision from a reply message without get polling", async () => {
    const h = fixture(); const task = h.task(); const rpc = spyOn(h.client, "rpc");
    try {
      await h.start();
      h.inbox.beginDecision(task.id);
      const result = await h.inbox.rpc("turn.decision", { ...h.inbox.turnInput(task.id),
        dedupe_key: "permission_live", body_md: "Allow tool?", options: [{ label: "Allow", value: "allow" }],
        metadata: { kind: "permission" }, timeout_ms: 1000 });
      const decision = result.message as UnifiedMessage;
      h.inbox.registerDecision(decision, task.id);
      const waiting = h.inbox.waitForDecisionReply(decision.id, new AbortController().signal, 1000);
      const reply = message(2, { reply_to_id: decision.id, metadata: { option_id: "allow" } });
      h.push(task.id, reply);
      expect(await waiting).toEqual(reply);
      expect(h.frames.filter(frame => frame.t === "turn.message" && frame.p.message.id === reply.id)).toHaveLength(1);
      expect(rpc.mock.calls.filter(([type]) => type === "turn.decision.get")).toHaveLength(0);
      h.inbox.confirmDecisionReply(task.id, reply); h.inbox.finishDecision(task.id);
      await h.inbox.consumeTaskSteerMessages(task.id, []);
      expect(h.inbox.turnInput(task.id).input_to_seq).toBe(2);
      expect(h.errors).toEqual([]);
    } finally { await h.close(); rpc.mockRestore(); }
  });

  it("bounds cached decision replies without losing a live waiter", async () => {
    const handlers = new Map<string, (frame: any) => void>();
    const client = { registerFrameHandler: (type: string, callback: (frame: any) => void) => handlers.set(type, callback) } as unknown as DaemonProtocolClient;
    const inbox = new DaemonTaskDownlinks(client, () => "rt_bot");
    inbox.bindTurn({ turn_id: "turn_live", attempt_id: "tsk_live", input_from_seq: 0, input_to_seq: 1, input_messages: [] });
    const waiting = inbox.waitForDecisionReply("decision_live", new AbortController().signal, 1000);
    for (let index = 0; index < 1025; index++) handlers.get("turn.message")!({ rt: "rt_bot", payload: {
      turn_id: "turn_live", attempt_id: "tsk_live", message: message(index + 2, { reply_to_id: `decision_${index}` }),
    } });
    const live = message(1027, { reply_to_id: "decision_live" });
    handlers.get("turn.message")!({ rt: "rt_bot", payload: { turn_id: "turn_live", attempt_id: "tsk_live", message: live } });
    expect(await waiting).toEqual(live);
    const cache = (inbox as unknown as { decisionReplies: Map<string, UnifiedMessage> }).decisionReplies;
    expect(cache.size).toBe(1024);
    expect(cache.has("decision_0")).toBe(false);
    expect(cache.has("decision_1024")).toBe(true);
    expect(handlers.has("task.human_request.settled")).toBe(false);
  });

  it("processes offline input, permission replies, wrap-up and cancellation once across reconnect snapshots", async () => {
    const h = fixture(); const rpc = spyOn(h.client, "rpc");
    const inputTask = h.task(); const humanTask = h.task(); const cancelledTask = h.task();
    const decision = message(1, { id: "decision_offline", message_kind: "decision" });
    h.inbox.registerDecision(decision, humanTask.id);
    const waiting = h.inbox.waitForDecisionReply(decision.id, new AbortController().signal, 2000);
    let inputCount = 0; let cancelCount = 0;
    const unsubscribe = h.inbox.subscribeTaskSteerMessages(inputTask.id, () => inputCount++);
    const unwatch = h.inbox.observeCancellation(cancelledTask.id, status => { expect(status).toBe("cancelled"); cancelCount++; });
    try {
      await h.start(); await h.disconnect();
      const input = message(2, { body_md: "Offline directive", message_kind: "request" });
      const reply = message(2, { id: "msg_reply", reply_to_id: decision.id, metadata: { option_id: "allow" } });
      h.messages.push({ turn_id: `turn_${inputTask.id}`, attempt_id: inputTask.id, message: input },
        { turn_id: `turn_${humanTask.id}`, attempt_id: humanTask.id, message: reply });
      h.wraps.push({ turn_id: `turn_${inputTask.id}`, attempt_id: inputTask.id, requested_at: "2026-10-05T01:00:00Z" });
      h.store.cancelTask(cancelledTask.id);
      expect(inputCount).toBe(0); expect(cancelCount).toBe(0);
      await h.reconnect(); await waitFor(() => inputCount === 2 && cancelCount === 1);
      expect(await waiting).toEqual(reply);
      h.inbox.confirmDecisionReply(humanTask.id, reply);
      expect(h.inbox.pendingTaskSteerMessages(inputTask.id).map(item => item.id)).toEqual([input.id, "wrap_up:2026-10-05T01:00:00Z"]);
      await h.disconnect(); await h.reconnect();
      await waitFor(() => h.frames.filter(frame => frame.t === "turn.message").length === 4);
      expect(inputCount).toBe(2); expect(cancelCount).toBe(1);
      expect(await h.inbox.waitForDecisionReply(decision.id, new AbortController().signal, 100)).toEqual(reply);
      await h.inbox.consumeTaskSteerMessages(inputTask.id, [input.id, "wrap_up:2026-10-05T01:00:00Z"]);
      await h.inbox.consumeTaskSteerMessages(inputTask.id, [input.id]);
      await h.inbox.consumeTaskSteerMessages(humanTask.id, []);
      expect(h.messages).toEqual([]);
      expect(h.inbox.pendingTaskSteerMessages(inputTask.id)).toEqual([]);
      expect(rpc.mock.calls.filter(([type]) => type === "turn.decision.get")).toHaveLength(0);
      expect(h.errors).toEqual([]);
    } finally { unsubscribe(); unwatch(); await h.close(); rpc.mockRestore(); }
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

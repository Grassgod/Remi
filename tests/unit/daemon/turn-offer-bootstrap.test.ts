import { expect, it } from "bun:test";
import { pendingTurnBackendTests } from "../multiremi/pending-turn-test-backends.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonTaskOffers, daemonTurnOfferPayload } from "@multiremi/api/daemon-protocol/task-offers.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { useTaskSessionInput } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { normalizeDaemonTurnOffer } from "@multiremi/worker/daemon-offers.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";

pendingTurnBackendTests("cold bootstrap offer acceptance", fixture => {
  for (const accepted of [false, true]) it(`${accepted ? "acceptance resets" : "rejection preserves"} reading after preparing a cold replacement`, async () => {
    const { store, db } = fixture();
    const runtimeId = "rt_bootstrap", daemonId = "daemon_bootstrap";
    store.registerRuntime({ id: runtimeId, daemonId, name: "Bootstrap", provider: "codex", workspaceId: "local",
      metadata: { parallel_agent_execution: 1 } });
    const agent = store.createAgent({ name: "Bootstrap", provider: "codex", runtimeId });
    const issue = store.createIssue({ title: "Cold offer" });
    const conversation = store.getOrCreateDefaultIssueSession(issue.id);
    const original = store.sendMessage({ session_id: conversation.id, sender: { type: "member", id: "mem_local_local" },
      to: { type: "agent", ref: agent.id }, message_kind: "request", wake_requested: "now", body_md: "original input ".repeat(2_000) });
    const first = store.claimTask(runtimeId)!;
    store.startTask(first.id);
    const initial = store.getDaemonTurnBridge().offerInput(store.getTaskWithAgent(first.id)!);
    store.recordSessionAgentRangeRead(conversation.id, agent.id, { seq: 1, offset: 0 }, { seq: initial.input_to_seq + 1, offset: 0 }, first.id);
    const before = store.getSessionAgentReadProgress(conversation.id, agent.id);
    expect(before.seq).toBeGreaterThan(0);
    store.cancelTurn(original.turn_id!);
    const replacement = store.retryTurn(original.turn_id!, true);
    const layer = new DaemonProtocolLayer({ store });
    new DaemonTaskOffers({ store, layer, prepare: async task => {
      const execution = daemonTaskClaimResponse(store, task, store.getTaskTriggerMetadata(task));
      useTaskSessionInput(store, task, execution);
      return daemonTurnOfferPayload(execution, store.getDaemonTurnBridge().offerInput(task));
    } });
    const frames: Array<Record<string, any>> = [];
    const socket = layer.openSession({ send: text => { frames.push(JSON.parse(text)); return text.length; }, close() {} },
      { accessToken: null, masterToken: true });
    try {
      await socket.handleMessage(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2, daemon_id: daemonId,
        cli_version: DAEMON_MIN_CLI_VERSION, caps: ["offer"],
        runtimes: [{ runtime_id: runtimeId, provider: "codex", max_concurrency: 1, active_task_ids: [] }] } }));
      await layer.drain();
      const frame = frames.find(value => value.t === "task.offer")!;
      expect(frame, JSON.stringify({ frames: frames.map(value => ({ t: value.t, code: value.p?.code })),
        status: store.getTask(replacement.current_attempt_id!)?.status })).toBeDefined();
      const offer = normalizeDaemonTurnOffer(frame.p);
      expect(offer.attempt_id).toBe(replacement.current_attempt_id!);
      expect(offer.input_from_seq).toBe(0);
      expect(offer.input_messages.find(message => message.id === original.message.id)?.body_md).toContain("original input");
      expect(offer.input_messages.find(message => message.id === original.message.id)?.body_md).toContain("还有");
      expect(JSON.parse(frame.p.session_projection.jsonl.split("\n")[0]).from_seq).toBe(0);
      expect(store.getSessionAgentReadProgress(conversation.id, agent.id)).toEqual(before);
      await socket.handleMessage(JSON.stringify({ v: 2, t: "res", re: String(frame.seq), ack: frame.seq,
        p: accepted ? { ok: true } : { ok: false, code: "capacity" } }));
      await layer.drain();
      expect(store.getSessionAgentReadProgress(conversation.id, agent.id)).toEqual(accepted ? { seq: 0, offset: 0 } : before);
      const attempt = db.query("SELECT input_ack_seq,input_read_seq,input_read_offset FROM multiremi_turn_attempts WHERE id=?").get(offer.attempt_id);
      expect(attempt).toMatchObject({ input_ack_seq: 0, input_read_seq: 0, input_read_offset: 0 });
      expect(store.getTask(offer.attempt_id)?.status).toBe(accepted ? "dispatched" : "queued");
    } finally { layer.closeAll(); layer.stop(); await layer.drain(); }
  }, 120_000);
});

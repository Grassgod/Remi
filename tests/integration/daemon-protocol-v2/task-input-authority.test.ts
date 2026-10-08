import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DaemonDownlinks } from "@multiremi/api/daemon-protocol/downlinks.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const fixtures: DaemonProtocolHarness[] = [];
async function fixture(workspace: "local" | "foreign") {
  const h = await DaemonProtocolHarness.create();
  fixtures.push(h);
  await h.startDaemon(); await h.settleHeartbeat();
  const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id as string;
  const workspaceId = workspace === "local" ? "local"
    : h.store.createWorkspace({ name: "Other tenant", slug: "turn-input-other" }).id;
  // A codex task cannot reach the claude worker. Persist an inconsistent
  // runtime assignment to exercise the tenant check itself.
  const agent = h.store.createAgent({ name: "Turn-input authority", provider: "codex", workspaceId });
  const task = h.store.createTask({ agentId: agent.id, prompt: "authority boundary" });
  runTurnExecutionMutation(h.db, "UPDATE multiremi_turn_execution_records SET runtime_id = ?, status = 'running' WHERE id = ?", [runtimeId, task.id]);
  const request = h.store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { question: "Proceed?" } });
  const steer = h.store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "continue" });
  const input = h.store.getDaemonTurnBridge().offerInput(h.store.getTaskWithAgent(task.id)!);
  await h.layer.drain();
  return { h, runtimeId, task, request, steer, input };
}
async function rpc(h: DaemonProtocolHarness, runtimeId: string, type: string, payload: Record<string, unknown>) {
  const id = crypto.randomUUID();
  h.client.send({ t: type, id, rt: runtimeId, p: payload });
  await waitFor(() => h.sockets[0]!.frames.some(frame => frame.t === "res" && frame.re === id), `${type} reply`);
  return h.sockets[0]!.frames.find(frame => frame.t === "res" && frame.re === id)!.p;
}
afterEach(async () => { for (const h of fixtures.splice(0)) await h.dispose(); });

describe("turn input RPC workspace authority over a real v2 socket", () => {
  for (const type of ["turn.input", "turn.decision", "turn.decision.expire"] as const) {
    it(`denies cross-workspace ${type} without consuming, inserting or pushing`, async () => {
      const { h, runtimeId, request, input } = await fixture("foreign");
      const beforeFrames = h.sockets[0]!.frames.length;
      const before = h.store.getTurn(input.turn_id)!;
      const requests = h.store.listTaskHumanRequests(input.attempt_id);
      const kick = spyOn(DaemonDownlinks.prototype, "kick");
      try {
        const payload = type === "turn.input" ? { ...input, message_ids: input.input_messages.map(m => m.id) }
          : type === "turn.decision.expire" ? { ...input, message_id: request.id, status: "cancelled" }
          : { ...input, dedupe_key: "cross-workspace-decision", body_md: "Denied?", options: [], metadata: { kind: "question" } };
        expect(await rpc(h, runtimeId, type, payload)).toEqual({ ok: false, code: "stale_attempt", retryable: false });
        await h.layer.drain();
        expect(h.store.getTurn(input.turn_id)).toEqual(before);
        expect(h.store.listTaskHumanRequests(input.attempt_id)).toEqual(requests);
        expect(h.store.getTaskHumanRequest(request.id)?.status).toBe("pending");
        expect(kick).toHaveBeenCalledTimes(1);
        expect(h.sockets[0]!.frames.slice(beforeFrames).filter(frame => frame.t !== "res")).toHaveLength(0);
      } finally { kick.mockRestore(); }
    });
  }
  it("allows the same three turn input RPCs within the credential workspace", async () => {
    const { h, runtimeId, request, input } = await fixture("local");
    expect(await rpc(h, runtimeId, "turn.input", { ...input, attempt_id: "tsk_missing", message_ids: [] }))
      .toEqual({ ok: false, code: "stale_attempt", retryable: false });
    const turn = h.store.getTurn(input.turn_id)!;
    h.store.recordSessionAgentRangeRead(turn.session_id, turn.agent_id, { seq: 1, offset: 0 },
      { seq: input.input_to_seq + 1, offset: 0 }, input.attempt_id);
    expect(await rpc(h, runtimeId, "turn.input", { ...input, message_ids: input.input_messages.map(m => m.id) }))
      .toEqual({ ok: true, input_to_seq: input.input_to_seq });
    expect(await rpc(h, runtimeId, "turn.decision", {
      ...input, dedupe_key: "same-workspace-decision", body_md: "Allowed?", options: [],
      metadata: { kind: "question", questions: [{ question: "Allowed?", options: [] }] },
    })).toMatchObject({ ok: true, message: { message_kind: "decision", body_md: "Allowed?" } });
    expect(await rpc(h, runtimeId, "turn.decision.expire", { ...input, message_id: request.id, status: "cancelled" }))
      .toMatchObject({ ok: true, message: { id: request.id, metadata: { human_request: { status: "cancelled" } } } });
  });
});

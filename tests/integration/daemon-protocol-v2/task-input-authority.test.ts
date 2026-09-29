import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DaemonDownlinks } from "@multiremi/api/daemon-protocol/downlinks.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const fixtures: DaemonProtocolHarness[] = [];

async function fixture(workspace: "local" | "foreign") {
  const h = await DaemonProtocolHarness.create();
  fixtures.push(h);
  await h.startDaemon();
  await h.settleHeartbeat();
  const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id as string;
  const workspaceId = workspace === "local" ? "local"
    : h.store.createWorkspace({ name: "Other tenant", slug: "task-input-other" }).id;
  // A codex task is not eligible for the fixture's claude worker. The database-only
  // assignment models the inconsistent persisted runtime identity found by QA.
  const agent = h.store.createAgent({ name: "task-input authority", provider: "codex", workspaceId });
  const task = h.store.createTask({ agentId: agent.id, prompt: "authority boundary" });
  const request = h.store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { question: "Proceed?" } });
  const steer = h.store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "continue" });
  h.db.run("UPDATE multiremi_tasks SET runtime_id = ? WHERE id = ?", [runtimeId, task.id]);
  await h.layer.drain();
  return { h, runtimeId, task, request, steer };
}

async function rpc(h: DaemonProtocolHarness, runtimeId: string, type: string, payload: Record<string, unknown>) {
  const id = crypto.randomUUID();
  h.client.send({ t: type, id, rt: runtimeId, p: payload });
  await waitFor(() => h.sockets[0]!.frames.some(frame => frame.t === "res" && frame.re === id), `${type} reply`);
  return h.sockets[0]!.frames.find(frame => frame.t === "res" && frame.re === id)!.p;
}

afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.dispose();
});

describe("task input RPC workspace authority over a real v2 socket", () => {
  it("denies cross-workspace steer.consume without consuming, kicking or pushing", async () => {
    const { h, runtimeId, task, steer } = await fixture("foreign");
    const beforeFrames = h.sockets[0]!.frames.length;
    const kick = spyOn(DaemonDownlinks.prototype, "kick");
    try {
      expect(await rpc(h, runtimeId, "steer.consume", { task_id: task.id, steer_ids: [steer.id] }))
        .toMatchObject({ ok: false, code: "authority_revoked", http_status: 403 });
      await h.layer.drain();
      expect(h.store.listPendingTaskSteerMessages(task.id).map(message => message.id)).toEqual([steer.id]);
      // The session's generic drain hook kicks once after every RPC; a write-handler
      // kick would be a second call and would attempt an extra downlink snapshot.
      expect(kick).toHaveBeenCalledTimes(1);
      expect(h.sockets[0]!.frames.slice(beforeFrames).filter(frame => frame.t !== "res")).toHaveLength(0);
    } finally { kick.mockRestore(); }
  });

  it("denies cross-workspace human_request.create without inserting, kicking or pushing", async () => {
    const { h, runtimeId, task } = await fixture("foreign");
    const requestId = "hrq_cross_workspace_rejected";
    const beforeFrames = h.sockets[0]!.frames.length;
    const beforeRequests = h.store.listTaskHumanRequests(task.id);
    const kick = spyOn(DaemonDownlinks.prototype, "kick");
    try {
      expect(await rpc(h, runtimeId, "human_request.create", {
        task_id: task.id, request_id: requestId, kind: "question", payload: { question: "Denied?" },
      })).toMatchObject({ ok: false, code: "authority_revoked", http_status: 403 });
      await h.layer.drain();
      expect(h.store.getTaskHumanRequest(requestId)).toBeNull();
      expect(h.store.listTaskHumanRequests(task.id)).toEqual(beforeRequests);
      expect(kick).toHaveBeenCalledTimes(1);
      expect(h.sockets[0]!.frames.slice(beforeFrames).filter(frame => frame.t !== "res")).toHaveLength(0);
    } finally { kick.mockRestore(); }
  });

  it("denies cross-workspace human_request.expire without changing status, kicking or pushing", async () => {
    const { h, runtimeId, task, request } = await fixture("foreign");
    const beforeFrames = h.sockets[0]!.frames.length;
    const kick = spyOn(DaemonDownlinks.prototype, "kick");
    try {
      expect(await rpc(h, runtimeId, "human_request.expire", {
        task_id: task.id, request_id: request.id, status: "cancelled",
      })).toMatchObject({ ok: false, code: "authority_revoked", http_status: 403 });
      await h.layer.drain();
      expect(h.store.getTaskHumanRequest(request.id)?.status).toBe("pending");
      expect(kick).toHaveBeenCalledTimes(1);
      expect(h.sockets[0]!.frames.slice(beforeFrames).filter(frame => frame.t !== "res")).toHaveLength(0);
    } finally { kick.mockRestore(); }
  });

  it("allows the same three task input RPCs within the credential workspace", async () => {
    const { h, runtimeId, task, request, steer } = await fixture("local");
    expect(await rpc(h, runtimeId, "steer.consume", { task_id: "tsk_missing", steer_ids: [steer.id] }))
      .toMatchObject({ ok: false, code: "task_not_found", http_status: 404, http_code: null });
    expect(await rpc(h, runtimeId, "steer.consume", { task_id: task.id, steer_ids: [steer.id] }))
      .toMatchObject({ ok: true, consumed: [{ id: steer.id }] });
    const requestId = "hrq_same_workspace_allowed";
    expect(await rpc(h, runtimeId, "human_request.create", {
      task_id: task.id, request_id: requestId, kind: "question", payload: { question: "Allowed?" },
    })).toMatchObject({ ok: true, request: { id: requestId, status: "pending" } });
    expect(await rpc(h, runtimeId, "human_request.expire", {
      task_id: task.id, request_id: request.id, status: "cancelled",
    })).toMatchObject({ ok: true, request: { id: request.id, status: "cancelled" } });
  });
});

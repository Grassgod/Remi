import { describe, expect, it } from "bun:test";
import { MultiremiDaemonClient, MultiremiDaemonHttpError } from "@multiremi/client.js";
import { DaemonProtocolRpcError } from "@multiremi/worker/daemon-protocol-client.js";

/** The reclaim checks reach the server over the report channel's RPC, never the report outbox. */
function client(rpc: (type: string, payload: Record<string, unknown>) => Promise<unknown>) {
  const rpcClient = new MultiremiDaemonClient("http://unused");
  rpcClient.setReportTransport({
    report: async () => { throw new Error("GC must not enter the report outbox"); },
    bestEffort: () => {}, upgradeWaiting: () => false,
    rpc: rpc as never,
  });
  return rpcClient;
}

async function errorOf(action: () => Promise<unknown>): Promise<MultiremiDaemonHttpError> {
  try { await action(); } catch (error) {
    expect(error).toBeInstanceOf(MultiremiDaemonHttpError);
    return error as MultiremiDaemonHttpError;
  }
  throw new Error("GC operation unexpectedly succeeded");
}

describe("GC checks over RPC", () => {
  it("sends each check to its own frame and returns the server's answer", async () => {
    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const rpc = client(async (type, payload) => {
      calls.push({ type, payload });
      return { ok: true, status: "done", updated_at: "2000-01-01T00:00:00.000Z" };
    });
    expect(await rpc.getIssueGcCheck("iss_1")).toMatchObject({ status: "done" });
    expect(await rpc.getChatSessionGcCheck("chat_1")).toMatchObject({ status: "done" });
    expect(await rpc.getTaskGcCheck("tsk_1")).toMatchObject({ status: "done" });
    expect(calls).toEqual([
      { type: "gc.check_issue", payload: { issue_id: "iss_1" } },
      { type: "gc.check_chat_session", payload: { session_id: "chat_1" } },
      { type: "gc.check_task", payload: { task_id: "tsk_1" } },
    ]);
  });

  it("preserves the business error of the former HTTP endpoint", async () => {
    const rpc = client(async () => {
      throw new DaemonProtocolRpcError("task_not_found", false, {
        status: 404, code: "issue_not_found", message: "Issue not found",
      });
    });
    const error = await errorOf(() => rpc.getIssueGcCheck("deleted-issue"));
    expect(error.status).toBe(404);
    expect(error.code).toBe("issue_not_found");
    expect(JSON.parse(error.responseBody)).toEqual({ error: "Issue not found", code: "issue_not_found" });
  });

  it("takes the generic status failure path when operation_error is absent", async () => {
    const rpc = client(async () => { throw new DaemonProtocolRpcError("task_not_found", false); });
    const error = await errorOf(() => rpc.getChatSessionGcCheck("chat_gone"));
    expect(error).toMatchObject({ status: 404, code: null });
    expect(error.message).toContain("404");
  });

  it("maps revoked authority and server failures to their HTTP statuses", async () => {
    for (const [code, status] of [["authority_revoked", 403], ["invalid_report", 400], ["server_error", 500]] as const) {
      const rpc = client(async () => { throw new DaemonProtocolRpcError(code, false); });
      expect((await errorOf(() => rpc.getTaskGcCheck("tsk_1"))).status).toBe(status);
    }
  });

  it("lets an unmapped failure through unchanged", async () => {
    const failure = new DaemonProtocolRpcError("something_new", true);
    const rpc = client(async () => { throw failure; });
    await expect(rpc.getTaskGcCheck("tsk_1")).rejects.toBe(failure);
  });

  it("reports a reclaimed subject over RPC and surfaces the server's rejection", async () => {
    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const payload = {
      runtime_id: "rt_1",
      subject: { kind: "issue" as const, id: "iss_1" },
      snapshot: null,
      unsaved_work: false,
      freed_bytes: 2048,
    };
    const rpc = client(async (type, body) => {
      calls.push({ type, payload: body });
      return { ok: true };
    });
    await rpc.reportSubjectReclaimed(payload);
    expect(calls).toEqual([{ type: "gc.subject_reclaimed", payload }]);

    const rejecting = client(async () => {
      throw new DaemonProtocolRpcError("task_not_found", false, { status: 404, code: "issue_not_found", message: "Issue not found" });
    });
    expect((await errorOf(() => rejecting.reportSubjectReclaimed(payload))).status).toBe(404);
  });

  it("returns the Chat check fields the retention decision needs", async () => {
    const reply = {
      ok: true, status: "archived", updated_at: "2026-10-01T00:00:00.000Z", pinned: true,
      origin: { autopilot_id: "ap_1", run_id: "run_1" }, last_activity_at: "2026-10-02T00:00:00.000Z",
    };
    const rpc = client(async () => reply);
    expect(await rpc.getChatSessionGcCheck("chat_1")).toEqual(reply);
  });

  it("sends the storage report as a best-effort frame and a GC run result as a task-less report", async () => {
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const reports: Array<{ type: string; partition: string; payload: Record<string, unknown> }> = [];
    const rpcClient = new MultiremiDaemonClient("http://unused");
    rpcClient.setReportTransport({
      report: async (type, partition, payload) => { reports.push({ type, partition, payload }); return { ok: true }; },
      bestEffort: (type, payload) => { frames.push({ type, payload }); },
      upgradeWaiting: () => false,
      rpc: async () => ({ ok: true }),
    });
    const report = {
      version: 1 as const, generated_at: "2026-10-13T00:00:00.000Z", mode: "periodic" as const, root: "/r", bytes: null, bytes_measured_at: null,
      subjects: { total: 0, active: 0, ended: 0, reclaimed: 0 }, retained: {}, reclaimed_this_round: 0,
      forgotten_this_round: 0, freed_bytes: 0, plan: [], errors: [],
    };

    rpcClient.reportStorageReport("rt_1", report);
    await rpcClient.reportGcRunResult("rt_1", "gcr_1", { status: "completed", report, error: null });

    expect(frames).toEqual([{ type: "gc.storage_report", payload: { runtime_id: "rt_1", report } }]);
    expect(reports).toEqual([{
      type: "runtime.gc_run_result",
      partition: "rt:rt_1",
      payload: { status: "completed", report, error: null, request_id: "gcr_1", runtime_id: "rt_1" },
    }]);
  });
  it("bounds the periodic storage report as it does a run result, so it fits one frame", async () => {
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const reports: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const rpcClient = new MultiremiDaemonClient("http://unused");
    rpcClient.setReportTransport({
      report: async (type, _partition, payload) => { reports.push({ type, payload }); return { ok: true }; },
      bestEffort: (type, payload) => { frames.push({ type, payload }); },
      upgradeWaiting: () => false,
      rpc: async () => ({ ok: true }),
    });
    // The first round after an upgrade can reclaim thousands of subjects, each with a long message on failure.
    const plan = Array.from({ length: 4000 }, (_, index) => ({
      subject: { kind: "chat" as const, id: `chat_${index}` }, action: "reclaim" as const, reason: "ended_ttl", bytes: index, unsaved_work: false,
    }));
    const errors = Array.from({ length: 300 }, (_, index) => ({ subject_id: `chat_${index}`, message: "e".repeat(5000) }));
    const report = {
      version: 1 as const, generated_at: "2026-10-13T00:00:00.000Z", mode: "periodic" as const, root: "/r", bytes: null,
      bytes_measured_at: null, subjects: { total: 4000, active: 0, ended: 4000, reclaimed: 0 }, retained: {},
      reclaimed_this_round: 4000, forgotten_this_round: 0, freed_bytes: 0, plan, errors,
    };

    rpcClient.reportStorageReport("rt_1", report);
    await rpcClient.reportGcRunResult("rt_1", "gcr_1", { status: "completed", report, error: null });

    const periodic = frames[0]!.payload.report as typeof report;
    const requested = reports[0]!.payload.report as typeof report;
    for (const bounded of [periodic, requested]) {
      expect(bounded.plan).toHaveLength(2000);
      expect(bounded.errors).toHaveLength(100);
      expect(bounded.errors[0]!.message).toHaveLength(1000);
      expect(JSON.stringify(bounded).length).toBeLessThan(1024 * 1024);
      // What the counts say is untouched by the bound on the lists.
      expect(bounded.reclaimed_this_round).toBe(4000);
    }
    expect(periodic).toEqual(requested);
    expect(frames[0]!.payload.runtime_id).toBe("rt_1");
  });
});

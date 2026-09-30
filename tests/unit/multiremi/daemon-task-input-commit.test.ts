import { afterAll, describe, expect, it } from "bun:test";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type { TasksRepo } from "@multiremi/store/repos/tasks-repo.js";
import { traceBackfillBackends } from "./trace-backfill-backends.js";
import { configureKindBot } from "./feishu-outbound-kind-fixture.js";
import { openRuntimeDownlinks } from "../../fixtures/runtime-downlinks.js";

const backends = await traceBackfillBackends("inputcommit");
afterAll(async () => { for (const backend of backends) await backend.dispose(); });

for (const backend of backends) describe.skipIf(!backend.available)(`daemon input commit (${backend.name})`, () => {
  it("publishes exactly one task-input event from the public steer wrapper", async () => {
    const opened = await backend.open();
    try {
      const { store } = opened;
      const runtime = store.registerRuntime({ name: "Input host", provider: "codex", workspaceId: "local" });
      const agent = store.createAgent({ name: "Input worker", provider: "codex", runtimeId: runtime.id });
      const task = store.createTask({ agentId: agent.id, prompt: "Work" });
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);
      const db = (store as unknown as { db: SqlDatabase }).db;
      const events: Array<{ taskId: unknown; inTransaction: boolean }> = [];
      const off = store.onWorkspaceEvent(event => {
        if (event.type === "daemon:task_input") events.push({ taskId: event.payload.task_id, inTransaction: Boolean(db.inTransaction) });
      });
      try {
        store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "New input" });
        expect(events).toEqual([{ taskId: task.id, inTransaction: false }]);
        expect(store.listTaskSteerMessages(task.id).map(row => row.content)).toEqual(["New input"]);
      } finally { off(); }
    } finally { await opened.close(); }
  }, 60_000);

  it("notifies each cancelled request once when terminal cancellation is called twice in one transaction", async () => {
    const opened = await backend.open();
    try {
      const { store } = opened;
      const agent = store.createAgent({ name: "Question worker", provider: "codex" });
      const task = store.createTask({ agentId: agent.id, prompt: "Ask" });
      const request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { question: "Continue?" } });
      const { db, tasks } = store as unknown as { db: SqlDatabase; tasks: TasksRepo };
      const events: Array<{ id: string; type: string; inTransaction: boolean }> = [];
      const off = store.onHumanRequest(event => events.push({ id: event.request.id, type: event.type, inTransaction: Boolean(db.inTransaction) }));
      try {
        db.transaction(() => {
          tasks.cancelPendingHumanRequestsWithinTransaction(task.id);
          tasks.cancelPendingHumanRequestsWithinTransaction(task.id);
          expect(events).toEqual([]);
        })();
        expect(events).toEqual([{ id: request.id, type: "cancelled", inTransaction: false }]);
        expect(store.getTaskHumanRequest(request.id)?.status).toBe("cancelled");
      } finally { off(); }
    } finally { await opened.close(); }
  }, 60_000);

  it("delivers CoT and messages over v2 while an interaction card waits for a human", async () => {
    const opened = await backend.open();
    const previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    const previousJobs = process.env.MULTIREMI_BACKGROUND_JOBS;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.MULTIREMI_BACKGROUND_JOBS = "1";
    let connection: Awaited<ReturnType<typeof openRuntimeDownlinks>> | undefined;
    try {
      const f = configureKindBot(opened.store);
      const first = f.inbound("waiting_card");
      for (const row of f.store.claimFeishuBotOutbounds("local", f.runtimeId)) f.store.reportFeishuBotOutbound("local", f.runtimeId, row.id,
        { claimToken: row.claimToken, status: "sent", externalMessageId: `om_${row.id}` });
      const request = f.store.createTaskHumanRequest({ taskId: first.taskId, kind: "question", payload: { questions: [{ question: "Continue?" }] } });
      connection = await openRuntimeDownlinks(f.store, f.runtimeId, { activeTaskIds: [first.taskId], capabilities: { feishu_concierge_protocol: 6 } });
      const card = connection.frames.find(frame => frame.t === "feishu.outbound" && frame.p.kind === "interaction_card")!;
      expect(card.p.human_request_id).toBe(request.id);
      await connection.ack();
      expect(f.store.getTaskHumanRequest(request.id)?.status).toBe("pending");
      const second = f.inbound("parallel_cot");
      await connection.kick();
      const cot = connection.frames.find(frame => frame.t === "feishu.outbound" && frame.p.task_id === second.taskId && frame.p.kind === "cot")!;
      expect(cot).toBeDefined();
      await connection.ack();
      await connection.ack();
      const receipt = connection.frames.find(frame => frame.t === "feishu.outbound" && frame.p.task_id === second.taskId && frame.p.kind === "receipt")!;
      expect(receipt.p.receipt_state).toBe("received");
      expect(f.store.getTaskHumanRequest(request.id)?.status).toBe("pending");
      expect(opened.db.query("SELECT status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(card.p.id)).toEqual({ status: "sending" });
    } finally {
      await connection?.close();
      if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
      if (previousJobs === undefined) delete process.env.MULTIREMI_BACKGROUND_JOBS; else process.env.MULTIREMI_BACKGROUND_JOBS = previousJobs;
      await opened.close();
    }
  }, 60_000);
});

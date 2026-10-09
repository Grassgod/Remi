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

  it("cancels the native wait once after commit while retaining the unanswered business question", async () => {
    const opened = await backend.open();
    try {
      const { store } = opened;
      const runtime = store.registerRuntime({ name: "Question host", provider: "codex", workspaceId: "local", daemonId: "daemon_input_commit" });
      const agent = store.createAgent({ name: "Question worker", provider: "codex", runtimeId: runtime.id });
      const issue = store.createIssue({ title: "Question source", assigneeType: "agent", assigneeId: agent.id, responsibleMemberId: "mem_local_local" });
      const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Ask" });
      expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
      const question = store.getDaemonTurnBridge().rpc("turn.decision", { turn_id: store.getTurnForAttempt(task.id)!.id, attempt_id: task.id,
        wait_id: "input-commit-native-wait", dedupe_key: "input-commit-question", body_md: "Continue?", options: [],
        metadata: { kind: "question", questions: [{ question: "Continue?" }] } },
        { runtimeId: runtime.id, daemonId: "daemon_input_commit", workspaceId: "local" });
      expect(question.ok).toBe(true);
      const request = store.getTaskHumanRequest(String(question.message_id))!;
      const { db, tasks } = store as unknown as { db: SqlDatabase; tasks: TasksRepo };
      const events: Array<{ id: string; type: string; inTransaction: boolean }> = [];
      const off = store.onHumanRequest(event => events.push({ id: event.request.id, type: event.type, inTransaction: Boolean(db.inTransaction) }));
      try {
        expect(() => db.transaction(() => {
          tasks.cancelPendingHumanRequestsWithinTransaction(task.id);
          expect(events).toEqual([]);
          throw new Error("rollback cancellation");
        })()).toThrow("rollback cancellation");
        expect(events).toEqual([]);
        expect(store.getQuestion(request.id)?.wait_status).toBe("waiting");
        db.transaction(() => {
          tasks.cancelPendingHumanRequestsWithinTransaction(task.id);
          tasks.cancelPendingHumanRequestsWithinTransaction(task.id);
          expect(events).toEqual([]);
        })();
        expect(events).toEqual([{ id: request.id, type: "cancelled", inTransaction: false }]);
        expect(store.getTaskHumanRequest(request.id)?.status).toBe("pending");
        expect(store.getQuestion(request.id)).toMatchObject({ status: "pending", wait_status: "detached", wait_reason: "provider_exit" });
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
      Object.assign(f.config, f.store.upsertFeishuBotConfig("local", { agentId: f.agent.id, runtimeId: f.runtimeId,
        appId: f.config.appId, appSecretOp: "keep", domain: "feishu", enabled: true, responsibleMemberId: "mem_local_local" }));
      f.store.reportFeishuBotRuntimeStatus("local", f.runtimeId, { appliedRevision: f.config.revision, state: "online" });
      const first = f.inbound("waiting_card");
      for (const row of f.store.claimFeishuBotOutbounds("local", f.runtimeId)) f.store.reportFeishuBotOutbound("local", f.runtimeId, row.id,
        { claimToken: row.claimToken, status: "sent", externalMessageId: `om_${row.id}` });
      const question = f.store.getDaemonTurnBridge().rpc("turn.decision", { turn_id: f.store.getTurnForAttempt(first.taskId)!.id,
        attempt_id: first.taskId, wait_id: "cot-card-native-wait", dedupe_key: "cot-card-question", body_md: "Continue?", options: [],
        metadata: { kind: "question", questions: [{ question: "Continue?" }] } },
        { runtimeId: f.runtimeId, daemonId: `daemon_${f.runtimeId}`, workspaceId: "local" });
      expect(question.ok).toBe(true);
      const request = f.store.getTaskHumanRequest(String(question.message_id))!;
      expect(f.store.getQuestion(request.id)?.wait_status).toBe("waiting");
      f.store.materializeFeishuTaskDeliveries(first.taskId);
      connection = await openRuntimeDownlinks(f.store, f.runtimeId, { activeTaskIds: [first.taskId],
        activeQuestionWaits: [{ message_id: request.id, attempt_id: first.taskId, wait_id: "cot-card-native-wait" }], capabilities: { feishu_concierge_protocol: 6 } });
      const card = connection.frames.find(frame => frame.t === "feishu.outbound" && frame.p.kind === "interaction_card")!;
      expect(card.p.human_request_id).toBe(request.id);
      await connection.ack();
      expect(f.store.getTaskHumanRequest(request.id)?.status).toBe("pending");
      expect(f.store.getQuestion(request.id)?.wait_status).toBe("waiting");
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

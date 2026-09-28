import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { configureKindBot } from "./feishu-outbound-kind-fixture.js";

let key: string | undefined;
let jobs: string | undefined;
let kinds: string | undefined;
beforeEach(() => {
  key = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  jobs = process.env.MULTIREMI_BACKGROUND_JOBS;
  kinds = process.env.MULTIREMI_FEISHU_OUTBOUND_KINDS;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.MULTIREMI_BACKGROUND_JOBS = "1";
  process.env.MULTIREMI_FEISHU_OUTBOUND_KINDS = "1";
});
afterEach(() => {
  if (key === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = key;
  if (jobs === undefined) delete process.env.MULTIREMI_BACKGROUND_JOBS; else process.env.MULTIREMI_BACKGROUND_JOBS = jobs;
  if (kinds === undefined) delete process.env.MULTIREMI_FEISHU_OUTBOUND_KINDS; else process.env.MULTIREMI_FEISHU_OUTBOUND_KINDS = kinds;
  resetMultiremiTestEnv();
});
const rows = (taskId: string) => db!.query(`SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? ORDER BY kind, unit_key`).all(taskId) as any[];
const claim = (f: ReturnType<typeof configureKindBot>, now?: Date) => f.store.claimFeishuBotOutbounds(f.workspaceId, f.runtimeId, now);
const report = (f: ReturnType<typeof configureKindBot>, row: { id: string; claimToken: string }, status: "sent" | "failed", retryable?: boolean) =>
  f.store.reportFeishuBotOutbound(f.workspaceId, f.runtimeId, row.id, { claimToken: row.claimToken, status, externalMessageId: `sent_${row.id}`, retryable });

describe("Feishu outbound kind leases", () => {
  it("queues separate result and receipt rows after terminal commit and isolates a permanent receipt failure", () => {
    const f = configureKindBot(createLocalStore());
    const taskId = f.inbound("isolation").taskId;
    const initial = claim(f);
    expect(initial.map(row => row.kind).sort()).toEqual(["cot", "receipt"]);
    for (const row of initial) expect(report(f, row, "sent")).toBe(true);
    f.store.completeTask(taskId, { output: "Final answer" });
    expect(rows(taskId).find(row => row.kind === "result_card").cascade_failure).toBe(0);
    const result = claim(f).find(row => row.kind === "result_card")!;
    expect(result).toBeDefined();
    const binding = db!.query("SELECT * FROM multiremi_feishu_bot_chat_bindings").all();
    expect(report(f, result, "sent")).toBe(true);
    const receipt = claim(f).find(row => row.kind === "receipt")!;
    expect(receipt.receiptState).toBe("completed");
    expect(report(f, receipt, "failed", false)).toBe(true);
    expect(rows(taskId).find(row => row.kind === "result_card").status).toBe("sent");
    expect(rows(taskId).filter(row => row.kind === "receipt").map(row => row.status).sort()).toEqual(["failed", "sent"]);
    expect(db!.query("SELECT * FROM multiremi_feishu_bot_chat_bindings").all()).toEqual(binding);
    expect(f.store.listFeishuBotAudit("local").find(row => row.action === "receipt_failed")?.details.delivery_id).toBe(receipt.id);
    expect(claim(f)).toEqual([]);
  });

  it("keeps each row's claim token, lease and exponential backoff independent", () => {
    const f = configureKindBot(createLocalStore());
    const firstTask = f.inbound("first").taskId;
    f.inbound("second");
    const batch = claim(f);
    expect(batch).toHaveLength(4);
    expect(new Set(batch.map(row => row.claimToken)).size).toBe(4);
    const failed = batch.find(row => row.taskId === firstTask && row.kind === "receipt")!;
    const others = db!.query("SELECT id, leased_until, claim_token, attempt_count FROM multiremi_feishu_bot_outbound_deliveries WHERE id <> ? ORDER BY id").all(failed.id);
    expect(report(f, failed, "failed", true)).toBe(true);
    expect(db!.query("SELECT id, leased_until, claim_token, attempt_count FROM multiremi_feishu_bot_outbound_deliveries WHERE id <> ? ORDER BY id").all(failed.id)).toEqual(others);
    expect(claim(f)).toEqual([]);
    const retry = claim(f, new Date(Date.now() + 6_000));
    expect(retry).toHaveLength(1);
    expect(retry[0]!.id).toBe(failed.id);
    expect(retry[0]!.claimToken).not.toBe(failed.claimToken);
    expect(report(f, failed, "sent")).toBe(false);
  });

  it("allows a result after its CoT failed and never uses a receipt as predecessor", () => {
    const f = configureKindBot(createLocalStore());
    const taskId = f.inbound("cotfail").taskId;
    const initial = claim(f);
    f.store.completeTask(taskId, { output: "Still deliver this" });
    const cot = initial.find(row => row.kind === "cot")!;
    expect(report(f, cot, "failed", false)).toBe(true);
    const result = claim(f).find(row => row.kind === "result_card")!;
    expect(result).toBeDefined();
    expect(rows(taskId).find(row => row.id === result.id).status).toBe("sending");
    const receiptIds = rows(taskId).filter(row => row.kind === "receipt").map(row => row.id);
    expect(rows(taskId).some(row => receiptIds.includes(row.previous_delivery_id))).toBe(false);
  });

  it("pins an undeclared daemon's original Task flow across retries and upgrade", () => {
    const f = configureKindBot(createLocalStore());
    const taskId = f.inbound("legacy").taskId;
    const legacy = f.store.claimFeishuBotOutbound("local", f.runtimeId, undefined, true, true, true)!;
    expect(legacy.kind).toBeUndefined();
    expect(legacy.taskId).toBe(taskId);
    expect(legacy.receiptMessageIds).toEqual(["om_kind_legacy"]);
    expect(report(f, legacy, "failed", true)).toBe(true);
    f.store.completeTask(taskId, { output: "Legacy answer" });
    const upgraded = claim(f, new Date(Date.now() + 6_000));
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0]).toMatchObject({ id: legacy.id, taskId });
    expect(upgraded[0]!.kind).toBeUndefined();
    expect(rows(taskId)).toHaveLength(1);
    expect(report(f, upgraded[0]!, "sent")).toBe(true);
    expect(claim(f)).toEqual([]);
  });

  it("keeps simultaneous old/new claims disjoint and preserves split rows during a downgrade", () => {
    const f = configureKindBot(createLocalStore());
    const oldTask = f.inbound("oldonline").taskId;
    const old = f.store.claimFeishuBotOutbound("local", f.runtimeId, undefined, true, true, true)!;
    const newTask = f.inbound("newonline").taskId;
    const capable = claim(f);
    expect(capable.map(row => row.taskId)).toEqual([newTask, newTask]);
    expect(f.store.claimFeishuBotOutbound("local", f.runtimeId, new Date(Date.now() + 121_000), true, true, true)?.taskId).toBe(oldTask);
    expect(rows(newTask).map(row => row.delivery_mode)).toEqual(["split", "split"]);
    const resumed = claim(f, new Date(Date.now() + 121_000));
    expect(new Set(resumed.map(row => row.id))).toEqual(new Set(capable.map(row => row.id)));
    expect(report(f, old, "sent")).toBe(false);
  });

  it("jobs=0 writes and claims no outbox rows, then background reconciliation catches up", () => {
    const f = configureKindBot(createLocalStore());
    process.env.MULTIREMI_BACKGROUND_JOBS = "0";
    const taskId = f.inbound("disabled").taskId;
    f.store.createTaskHumanRequest({ taskId, kind: "question", payload: { questions: [{ question: "Continue?" }] } });
    f.store.completeTask(taskId, { output: "Deferred answer" });
    expect(rows(taskId)).toEqual([]);
    expect(claim(f)).toEqual([]);
    process.env.MULTIREMI_BACKGROUND_JOBS = "1";
    expect(claim(f).map(row => row.kind).sort()).toEqual(["cot", "receipt"]);
    expect(rows(taskId).find(row => row.kind === "result_card")).toBeDefined();
  });

  it("stops at six expired split leases, audits the receipt once, and rejects late reports", () => {
    const f = configureKindBot(createLocalStore());
    const taskId = f.inbound("expired").taskId;
    const start = Date.now() + 1_000;
    let batch = claim(f, new Date(start));
    const receiptId = batch.find(row => row.kind === "receipt")!.id;
    for (let attempt = 1; attempt < 6; attempt++) {
      const late = batch.find(row => row.id === receiptId)!;
      const now = new Date(start + attempt * 121_000);
      expect(f.store.reportFeishuBotOutbound("local", f.runtimeId, receiptId,
        { claimToken: late.claimToken, status: "sent" }, now)).toBe(false);
      batch = claim(f, now);
      expect(batch.find(row => row.id === receiptId)).toBeDefined();
    }
    expect(claim(f, new Date(start + 6 * 121_000))).toEqual([]);
    expect(rows(taskId).map(row => [row.status, row.attempt_count])).toEqual([["failed", 6], ["failed", 6]]);
    expect(f.store.listFeishuBotAudit("local").filter(row => row.action === "receipt_failed")).toHaveLength(1);
    claim(f, new Date(start + 7 * 121_000));
    expect(f.store.listFeishuBotAudit("local").filter(row => row.action === "receipt_failed")).toHaveLength(1);
  });

  it("rolls new Tasks back to legacy while draining already split Tasks without resending their result", () => {
    const f = configureKindBot(createLocalStore());
    const splitTask = f.inbound("beforerollback").taskId;
    for (const row of claim(f)) expect(report(f, row, "sent")).toBe(true);
    process.env.MULTIREMI_FEISHU_OUTBOUND_KINDS = "0";
    f.store.completeTask(splitTask, { output: "Drain this result" });
    const legacyTask = f.inbound("afterrollback").taskId;
    const batch = claim(f);
    expect(batch.find(row => row.taskId === legacyTask)?.kind).toBeUndefined();
    expect(batch.find(row => row.taskId === splitTask)?.kind).toBe("result_card");
    for (const row of batch) expect(report(f, row, "sent")).toBe(true);
    for (const row of claim(f)) expect(report(f, row, "sent")).toBe(true);
    expect(rows(legacyTask)).toHaveLength(1);
    expect(rows(splitTask).find(row => row.kind === "result_card").status).toBe("sent");
    expect(claim(f)).toEqual([]);
  });

  it("persists attachment intent with jobs=0 and replays a crashed operation without duplicating or resetting delivered rows", () => {
    const f = configureKindBot(createLocalStore());
    const taskId = f.inbound("deferredfiles").taskId;
    for (const row of claim(f)) expect(report(f, row, "sent")).toBe(true);
    process.env.MULTIREMI_BACKGROUND_JOBS = "0";
    const batch = f.store.sendChatAttachments(taskId, [{ filename: "report.html", sizeBytes: 4,
      contentType: "text/html", url: "/api/attachments/local-test/content" }], "Report attached");
    expect(batch.delivery_ids).toHaveLength(1);
    expect(db!.query("SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(batch.delivery_ids[0]!)).toBeNull();
    expect(claim(f)).toEqual([]);
    process.env.MULTIREMI_BACKGROUND_JOBS = "1";
    const file = claim(f).find(row => row.id === batch.delivery_ids[0])!;
    expect(file.attachments?.[0]?.filename).toBe("report.html");
    expect(file.body).toBe("Report attached");
    expect(report(f, file, "sent")).toBe(true);
    db!.run(`UPDATE multiremi_feishu_bot_outbound_operations SET status = 'processing',
      claim_token = 'crashed', leased_until = '2000-01-01' WHERE kind = 'attachments'`);
    expect(claim(f)).toEqual([]);
    expect(db!.query("SELECT id, status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").all(file.id))
      .toEqual([{ id: file.id, status: "sent" }]);
    expect(db!.query("SELECT status FROM multiremi_feishu_bot_outbound_operations WHERE kind = 'attachments'").get())
      .toEqual({ status: "done" });
  });

  it("preserves the inbound group recipient when a jobs=0 process leaves the carrier to the background writer", () => {
    const f = configureKindBot(createLocalStore());
    process.env.MULTIREMI_BACKGROUND_JOBS = "0";
    const submitted = f.store.submitFeishuBotMessage("local", f.runtimeId, { revision: f.config.revision,
      externalSessionKey: "oc_group:thread:om_group", chatId: "oc_group", chatType: "group", threadId: "om_group",
      externalMessageId: "om_group", senderOpenId: "ou_group_requester", text: "Group reply", deliveryMode: "native_cot_v1" });
    expect(rows(submitted.taskId)).toEqual([]);
    process.env.MULTIREMI_BACKGROUND_JOBS = "1";
    const cot = claim(f).find(row => row.kind === "cot")!;
    expect(cot.mention).toEqual({ mode: "person", openId: "ou_group_requester", resolvedOpenId: "ou_group_requester" });
    expect(cot.interactionOpenId).toBe("ou_group_requester");
  });

  it("follows a retargeted Task for split receipts without recreating the original carrier or changing legacy ingress fields", () => {
    const f = configureKindBot(createLocalStore());
    const taskId = f.inbound("retrylineage").taskId;
    const initial = claim(f);
    for (const row of initial) expect(report(f, row, "sent")).toBe(true);
    const task = f.store.getTask(taskId)!;
    const retry = f.store.createTask({ agentId: f.agent.id, workspaceId: "local", chatSessionId: task.chatSessionId, prompt: "Retry" });
    f.store.retargetFeishuRoundPushTaskWithinTransaction(taskId, retry.id);
    f.store.completeTask(taskId, { output: "Original run ends" });
    expect(f.store.claimTask(f.runtimeId)?.id).toBe(retry.id);
    f.store.startTask(retry.id);
    const retryCot = claim(f).find(row => row.kind === "cot")!;
    expect(retryCot.id).toBe(initial.find(row => row.kind === "cot")!.id);
    expect(report(f, retryCot, "sent")).toBe(true);
    f.store.completeTask(retry.id, { output: "Retried answer" });
    const result = claim(f).find(row => row.kind === "result_card")!;
    expect(result.taskId).toBe(retry.id);
    expect(report(f, result, "sent")).toBe(true);
    const receipt = claim(f).find(row => row.kind === "receipt")!;
    expect(receipt.targetMessageId).toBe("om_kind_retrylineage");
    expect(receipt.receiptState).toBe("completed");
    expect(rows(taskId)).toEqual([]);
    expect(db!.query("SELECT task_id, outbound_task_id FROM multiremi_feishu_bot_deliveries WHERE external_message_id = ?")
      .get("om_kind_retrylineage")).toEqual({ task_id: taskId, outbound_task_id: retry.id });
  });
});

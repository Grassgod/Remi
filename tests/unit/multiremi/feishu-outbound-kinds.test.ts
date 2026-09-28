import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { configureKindBot } from "./feishu-outbound-kind-fixture.js";

let key: string | undefined;
let jobs: string | undefined;
beforeEach(() => {
  key = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  jobs = process.env.MULTIREMI_BACKGROUND_JOBS;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.MULTIREMI_BACKGROUND_JOBS = "1";
});
afterEach(() => {
  if (key === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = key;
  if (jobs === undefined) delete process.env.MULTIREMI_BACKGROUND_JOBS; else process.env.MULTIREMI_BACKGROUND_JOBS = jobs;
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
});

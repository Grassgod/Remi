import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { reportFrame } from "../../fixtures/report-session.js";
import { DAEMON_TASK_POLL_APP_ID, seedDaemonTaskPollFixture } from "../../fixtures/multiremi/daemon-task-poll-fixture.js";
import { FEISHU_CONCIERGE_PROTOCOL_VERSION } from "@multiremi/contracts/types.js";

let db: Database | undefined;
let encryptionKey: string | undefined;
beforeEach(() => {
  encryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
});
afterEach(() => {
  db?.close(); db = undefined;
  if (encryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = encryptionKey;
});

describe("trace RPC read authority", () => {
  it("keeps the owning daemon and concierge host reads without granting foreign execution writes", async () => {
    db = openSqliteDatabase(":memory:"); const store = new MultiremiStore(db);
    const f = await seedDaemonTaskPollFixture(store, { run: (sql, params) => { db!.run(sql, params as any[]); } });
    const host = { runtimeId: f.foreignRuntimeId, headers: { Authorization: `Bearer ${f.foreignDaemonToken}` },
      capabilities: { feishu_concierge_protocol: FEISHU_CONCIERGE_PROTOCOL_VERSION } };
    const owner = { runtimeId: f.runtimeId, headers: { Authorization: `Bearer ${f.daemonToken}` },
      capabilities: { feishu_concierge_protocol: FEISHU_CONCIERGE_PROTOCOL_VERSION } };
    expect(await reportFrame(store, "trace.head", { task_id: f.taskId }, host)).toMatchObject({ ok: false, code: "authority_revoked" });
    expect(await reportFrame(store, "trace.head", { task_id: f.taskId }, owner)).toMatchObject({ ok: true, head: 0 });
    store.upsertFeishuBotConfig("local", { agentId: f.agentId, runtimeId: f.foreignRuntimeId,
      appId: DAEMON_TASK_POLL_APP_ID, appSecretOp: "keep", enabled: true, domain: "feishu" });
    const submitted = store.submitFeishuBotMessage("local", f.foreignRuntimeId, {
      revision: store.getFeishuBotConfig("local")!.revision, externalSessionKey: "oc_trace_host",
      externalMessageId: "om_trace_host", chatId: "oc_trace_host", chatType: "p2p", text: "host trace",
    });
    store.registerRuntime({ id: "rt_trace_executor", name: "Trace executor", provider: "codex", workspaceId: "local",
      daemonId: "trace-executor", ownerId: "local" });
    expect(store.claimTask("rt_trace_executor")?.id).toBe(submitted.taskId);
    store.startTask(submitted.taskId);
    expect(await reportFrame(store, "trace.head", { task_id: submitted.taskId }, host)).toMatchObject({ ok: true, head: 0 });
    expect(await reportFrame(store, "trace.subscribe", { task_id: submitted.taskId, from_seq: 0 }, host)).toMatchObject({ ok: true, head: 0 });
    expect(await reportFrame(store, "trace.append", { task_id: submitted.taskId, closed: false,
      events: [{ seq: 1, type: "text", ts: "2026-09-28T00:00:00Z" }] }, host)).toMatchObject({ ok: false, code: "authority_revoked" });
    store.upsertFeishuBotConfig("local", { agentId: f.agentId, runtimeId: f.runtimeId,
      appId: DAEMON_TASK_POLL_APP_ID, appSecretOp: "keep", enabled: true, domain: "feishu" });
    expect(await reportFrame(store, "trace.subscribe", { task_id: submitted.taskId, from_seq: 0 }, host)).toMatchObject({ ok: false, code: "authority_revoked" });
    expect(await reportFrame(store, "trace.fetch", { task_id: submitted.taskId, after_seq: 0 }, host)).toMatchObject({ ok: false, code: "authority_revoked" });
  });
});

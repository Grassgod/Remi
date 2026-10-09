import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_topics459_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const JSON_HEADERS = { "Content-Type": "application/json", Authorization: "Bearer MASTER" };

async function probe(): Promise<boolean> {
  const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
  try {
    await admin`SELECT 1`;
    return true;
  } catch {
    if (process.env.MULTIREMI_TEST_POSTGRES_URL) throw new Error("Configured test PostgreSQL is unavailable");
    return false;
  } finally {
    await admin.end();
  }
}

const available = await probe();

describe.skipIf(!available)("Invalid stored Feishu Issue topics on PostgreSQL (MUL-459)", () => {
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;
  let revision: number;
  let projectId: string;
  let previousEncryptionKey: string | undefined;

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    const url = new URL(PG_ADMIN_URL);
    url.pathname = `/${TEST_DB}`;
    db = new PostgresSyncDatabase(url.toString());
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    const agent = store.createAgent({ name: "PG Concierge", provider: "codex", workspaceId: "local" });
    store.registerRuntime({ id: "rt_pg459", name: "Bot", provider: "codex", workspaceId: "local", daemonId: "d-pg459" });
    store.heartbeatRuntime("rt_pg459", { supportsFeishuBotConfig: true });
    const config = store.upsertFeishuBotConfig("local", {
      agentId: agent.id, runtimeId: "rt_pg459", appId: "cli_pg459", domain: "feishu", enabled: true,
      senderAccessPolicy: "allowlist", appSecretOp: "set", appSecret: "pg459-test-fixture-secret", responsibleMemberId: 'mem_local_local',
    });
    revision = config.revision;
    store.reportFeishuBotRuntimeStatus("local", "rt_pg459", { appliedRevision: revision, state: "online" });
    store.submitFeishuBotMessage("local", "rt_pg459", {
      revision, externalSessionKey: "oc_pg_discovery", externalMessageId: "om_pg_discovery",
      senderOpenId: "ou_pg459_sender", text: "Hello",
    });
    store.setFeishuBotSenderAllowed("local", store.listFeishuBotSenders("local")[0]!.id, true, "local");
    projectId = store.createProject({ title: "PG topic project", workspaceId: "local" }).id;
  });

  afterAll(async () => {
    db?.close();
    if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  for (const scenario of ["missing recipient", "invalid recipient", "invalid projects"] as const) {
    it(`accepts a group message and creates its Issue (${scenario})`, () => {
      store.updateWorkspace("local", { settings: { issueTopics: {
        enabled: true, chatId: "oc_pg459", notifyMode: "person",
        ...(scenario === "missing recipient" ? {} : { notifyOpenId: "invalid-private-recipient" }),
        projectIds: scenario === "invalid projects" ? [42] : [projectId],
      } } });
      const messageId = `om_pg459_${scenario.replaceAll(" ", "_")}`;
      const result = store.submitFeishuBotMessage("local", "rt_pg459", {
        revision, chatType: "group", chatId: "oc_pg459", externalSessionKey: `oc_pg459:thread:${messageId}`,
        externalMessageId: messageId, senderOpenId: "ou_pg459_sender", text: "Create the PG Issue",
      });
      expect(result.senderAllowed).toBe(true);
      const issueId = store.getFeishuIssueIdForChatSession(result.chatSessionId)!;
      expect(store.getIssue(issueId)).toMatchObject({
        title: "Create the PG Issue", projectId: scenario === "invalid projects" ? null : projectId,
      });
      expect(store.getTask(result.taskId)?.issueId).toBe(issueId);
      const duplicate = store.submitFeishuBotMessage("local", "rt_pg459", {
        revision, chatType: "group", chatId: "oc_pg459", externalSessionKey: `oc_pg459:thread:${messageId}`,
        externalMessageId: messageId, senderOpenId: "ou_pg459_sender", text: "Create the PG Issue",
      });
      expect(duplicate).toMatchObject({ duplicate: true, taskId: result.taskId });
    });
  }

  for (const recipient of [undefined, "invalid-private-recipient"]) {
    it(`reads invalid settings, rejects an incomplete repair, and saves a replacement (${recipient === undefined ? "missing" : "invalid"})`, async () => {
      store.updateWorkspace("local", { settings: { preserved: "setting", issueTopics: {
        enabled: true, chatId: "oc_pg459", notifyMode: "person", notifyOpenId: recipient,
      } } });
      const app = createMultiremiApp({ store, authToken: "MASTER" });
      const path = "/api/workspaces/local/issue-topics";
      const initial = await app.request(path, { headers: JSON_HEADERS });
      expect(initial.status).toBe(200);
      const body = await initial.json();
      expect(body.config).toMatchObject({ enabled: true, chat_id: "oc_pg459", notify_mode: "person", notify_open_id: null });
      expect(body.invalid).toEqual({
        code: "issue_topic_config_invalid",
        message: "issueTopics.notifyOpenId must be a bot-scoped open_id when notifyMode is person",
      });
      const incomplete = await app.request(path, {
        method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ enabled: true, chat_id: "oc_pg459" }),
      });
      expect(incomplete.status).toBe(400);
      expect(await incomplete.json()).toEqual({ code: body.invalid.code, error: body.invalid.message });
      const repaired = await app.request(path, {
        method: "PUT", headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: true, chat_id: "oc_pg459", notify_mode: "person", notify_open_id: "ou_repaired" }),
      });
      expect(repaired.status).toBe(200);
      const saved = await repaired.json();
      expect(saved).not.toHaveProperty("invalid");
      expect(saved.config.notify_open_id).toBe("ou_repaired");
      expect(store.getWorkspace("local")?.settings.preserved).toBe("setting");
      expect(JSON.stringify(store.getWorkspace("local")?.settings)).not.toContain("invalid-private-recipient");
      expect(await (await app.request(path, { headers: JSON_HEADERS })).json()).toEqual(saved);
    });
  }
});

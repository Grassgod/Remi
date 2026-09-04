import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
const JSON_HEADERS = { "Content-Type": "application/json", Authorization: "Bearer MASTER" };
let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

function scaffold(options: { online?: boolean } = {}): {
  store: MultiremiStore;
  revision: number;
} {
  const store = createLocalStore();
  const owner = store.getCurrentUser();
  store.getOrCreateUser({
    externalId: "ou_issue_topic_owner",
    feishuUnionId: "on_issue_topic_owner",
    email: owner.email,
    name: owner.name,
  });
  const agent = store.createAgent({ name: "Concierge", provider: "codex", workspaceId: "local" });
  store.registerRuntime({
    id: "rt_bot",
    name: "Bot host",
    provider: "codex",
    workspaceId: "local",
    daemonId: "bot-host",
  });
  store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id,
    runtimeId: "rt_bot",
    appId: "cli_issue_topics",
    appSecretOp: "set",
    appSecret: APP_SECRET,
    domain: "feishu",
    enabled: true,
  });
  if (options.online !== false) {
    store.reportFeishuBotRuntimeStatus("local", "rt_bot", {
      appliedRevision: config.revision,
      state: "online",
    });
  }
  return { store, revision: config.revision };
}

function configureTopics(store: MultiremiStore, projectIds?: string[]): void {
  const workspace = store.getWorkspace("local")!;
  store.updateWorkspace("local", {
    settings: {
      ...workspace.settings,
      issueTopics: {
        enabled: true,
        chatId: "oc_issue_topics",
        ...(projectIds ? { projectIds } : {}),
      },
    },
  });
}

describe("Feishu Issue topics", () => {
  it("creates one root delivery and reconciles its binding for inbound replies", async () => {
    const { store, revision } = scaffold();
    configureTopics(store);
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const response = await app.request("/api/issues", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Ship issue topics", description: "Keep this Issue visible in Feishu." }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    const issue = store.getIssue(body.id)!;

    expect(store.prepareFeishuIssueTopicWithinTransaction(issue)).toBe(false);
    expect(store.prepareFeishuIssueTopicWithinTransaction(issue)).toBe(false);
    expect(store.listChatSessions("local").filter((chat) => chat.issueId === issue.id)).toHaveLength(1);
    expect(db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = 'local'",
    ).get()).toEqual({ count: 1 });

    const delivery = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(delivery).toMatchObject({
      chatId: "oc_issue_topics",
      threadId: null,
      replyToMessageId: null,
      body: expect.stringContaining("Ship issue topics"),
    });
    expect(store.reportFeishuBotOutbound("local", "rt_bot", delivery.id, {
      claimToken: delivery.claimToken,
      status: "sent",
      externalMessageId: "om_issue_root",
    })).toBe(true);

    const binding = db!.query(
      `SELECT external_session_key, thread_id, reply_to_message_id, chat_session_id
       FROM multiremi_feishu_bot_chat_bindings WHERE workspace_id = 'local'`,
    ).get() as Record<string, unknown>;
    expect(binding).toMatchObject({
      external_session_key: "oc_issue_topics:thread:om_issue_root",
      thread_id: "om_issue_root",
      reply_to_message_id: "om_issue_root",
    });

    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      externalSessionKey: "oc_issue_topics:thread:om_issue_root",
      externalMessageId: "om_issue_reply",
      replyToMessageId: "om_issue_reply",
      chatId: "oc_issue_topics",
      threadId: "om_issue_root",
      text: "Continue this Issue.",
    });
    expect(inbound.chatSessionId).toBe(String(binding.chat_session_id));
    expect(store.getChatSession(inbound.chatSessionId)?.issueId).toBe(issue.id);
  });

  it("skips a second topic when the Issue was created from a Feishu Chat task", async () => {
    const { store, revision } = scaffold();
    configureTopics(store);
    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      externalSessionKey: "oc_source:thread:om_source_root",
      externalMessageId: "om_source_message",
      replyToMessageId: "om_source_message",
      chatId: "oc_source",
      threadId: "om_source_root",
      senderUnionId: "on_issue_topic_owner",
      text: "Create an Issue from this topic.",
    });
    const task = store.getTask(inbound.taskId)!;
    const credential = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const response = await app.request("/api/issues", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({ title: "Created inside Feishu" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.chat_issue_binding.status).toBe("bound");
    expect(store.getChatSession(inbound.chatSessionId)?.issueId).toBe(body.id);
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    expect(store.listChatSessions("local").filter((chat) => chat.issueId === body.id)).toHaveLength(1);
  });

  it("does not affect Issue creation when topics are unconfigured or the bot is offline", async () => {
    const unconfigured = scaffold();
    let app = createMultiremiApp({ store: unconfigured.store, authToken: "MASTER" });
    let response = await app.request("/api/issues", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "No topic configuration" }),
    });
    expect(response.status).toBe(201);
    expect(unconfigured.store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();

    resetMultiremiTestEnv();
    const offline = scaffold({ online: false });
    configureTopics(offline.store);
    app = createMultiremiApp({ store: offline.store, authToken: "MASTER" });
    response = await app.request("/api/issues", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Offline concierge" }),
    });
    expect(response.status).toBe(201);
    expect(db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = 'local'",
    ).get()).toEqual({ count: 0 });
  });

  it("reads and validates project-filtered workspace configuration", async () => {
    const { store } = scaffold();
    const project = store.createProject({ title: "Topic project", workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const initial = await app.request("/api/workspaces/local/issue-topics", { headers: JSON_HEADERS });
    expect(await initial.json()).toEqual({
      workspace_id: "local",
      config: { enabled: false, chat_id: "", project_ids: null },
    });
    const updated = await app.request("/api/workspaces/local/issue-topics", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: true, chat_id: " oc_filtered ", project_ids: [project.id, project.id] }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      workspace_id: "local",
      config: { enabled: true, chat_id: "oc_filtered", project_ids: [project.id] },
    });

    const rejected = await app.request("/api/workspaces/local/issue-topics", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: true, chat_id: "oc_filtered", project_ids: ["prj_missing"] }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: "issue_topic_config_invalid" });
  });
});

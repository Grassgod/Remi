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

function prepareReport(store: MultiremiStore) {
  const agent = store.getFeishuBotConfig("local")!.agentId;
  const issue = store.createIssue({ title: "Review requested", workspaceId: "local", assigneeType: "agent", assigneeId: agent });
  store.prepareFeishuIssueTopicWithinTransaction(issue);
  const root = store.claimFeishuBotOutbound("local", "rt_bot")!;
  expect(root.bodyOrigin).toBe("issue");
  expect(root.mention).toBeUndefined();
  store.reportFeishuBotOutbound("local", "rt_bot", root.id, { claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${issue.id}` });
  const leader = store.createTask({ agentId: agent, issueId: issue.id, prompt: "Work on Issue" });
  const wake = store.prepareFeishuIssueRoundPushesWithinTransaction({ issue, leaderTask: leader });
  expect(wake).toHaveLength(1);
  return wake[0]!;
}

describe("Feishu Issue topics", () => {
  it("checkpoints the recipient before send and keeps it after retry and owner changes", () => {
    const { store } = scaffold();
    configureTopics(store);
    const wake = prepareReport(store);
    const first = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(first).toMatchObject({ taskId: wake.id, mention: { mode: "group_owner" } });
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, "stale", "ou_owner")).toBeNull();
    expect(store.prepareFeishuBotOutboundMention("local", "rt_other", first.id, first.claimToken, "ou_owner")).toBeNull();
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, first.claimToken, "ou_owner"))
      .toEqual({ openId: "ou_owner" });
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, first.claimToken, "ou_new_owner"))
      .toEqual({ openId: "ou_owner" });
    store.reportFeishuBotOutbound("local", "rt_bot", first.id, { claimToken: first.claimToken, status: "failed", error: "network" });
    const retry = store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 10000), true)!;
    expect(retry.id).toBe(first.id);
    expect(retry.mention).toEqual({ mode: "group_owner", resolvedOpenId: "ou_owner" });
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, first.claimToken, "ou_new_owner")).toBeNull();
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", retry.id, retry.claimToken, "ou_new_owner"))
      .toEqual({ openId: "ou_owner" });
  });

  it("rejects expired leases and persists a missing-owner outcome", () => {
    const { store } = scaffold();
    configureTopics(store);
    prepareReport(store);
    const first = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, first.claimToken, "ou_owner", new Date(Date.now() + 121000))).toBeNull();
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, first.claimToken, null)).toEqual({ openId: null });
    store.reportFeishuBotOutbound("local", "rt_bot", first.id, { claimToken: first.claimToken, status: "failed" });
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 10000), true)?.mention)
      .toEqual({ mode: "group_owner", resolvedOpenId: null });
  });

  for (const mode of ["person", "none"] as const) {
    it(`snapshots ${mode} policy without silently reverting to group_owner`, () => {
      const { store } = scaffold();
      store.updateWorkspace("local", { settings: { issueTopics: { enabled: true, chatId: "oc_issue_topics",
        notifyMode: mode, ...(mode === "person" ? { notifyOpenId: "ou_reviewer" } : {}) } } });
      prepareReport(store);
      const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
      expect(delivery.mention?.mode).toBe(mode);
      expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", delivery.id, delivery.claimToken, "ou_wrong")).toBeNull();
      configureTopics(store);
      expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", delivery.id, delivery.claimToken, mode === "person" ? "ou_reviewer" : null))
        .toEqual({ openId: mode === "person" ? "ou_reviewer" : null });
    });
  }

  it("does not add a mention to an old card or report in a different group", () => {
    const { store } = scaffold();
    configureTopics(store);
    const wake = prepareReport(store);
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET external_message_id = 'om_old_card' WHERE task_id = ?", [wake.id]);
    const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(delivery.mention).toEqual({ mode: "group_owner", resolvedOpenId: null });
    store.reportFeishuBotOutbound("local", "rt_bot", delivery.id, { claimToken: delivery.claimToken, status: "sent", externalMessageId: "om_old_card" });
    prepareReport(store);
    store.updateWorkspace("local", { settings: { issueTopics: { enabled: true, chatId: "oc_different" } } });
    expect(store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)?.mention).toBeUndefined();
  });

  it("uses the existing authenticated result endpoint to prepare a recipient", async () => {
    const { store } = scaffold();
    configureTopics(store);
    prepareReport(store);
    const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    const token = await store.createAccessToken({ name: "bot-host", type: "daemon", workspaceId: "local", daemonId: "bot-host" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const request = (body: object) => app.request(`/api/daemon/runtimes/rt_bot/feishu-bot/outbound/${delivery.id}/result`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ status: "prepared", claim_token: delivery.claimToken, ...body }),
    });
    expect((await request({ mention_open_id: "all" })).status).toBe(400);
    expect((await request({ mention_open_id: "ou_owner", claim_token: "stale" })).status).toBe(409);
    const response = await request({ mention_open_id: "ou_owner" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", mention_open_id: "ou_owner" });
  });
  it("stores explicit notification targets and preserves them for older clients", async () => {
    const { store } = scaffold();
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const path = "/api/workspaces/local/issue-topics";
    const save = (body: unknown) => app.request(path, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
    expect((await (await app.request(path, { headers: JSON_HEADERS })).json()).config.notify_mode).toBe("group_owner");
    const response = await save({ enabled: true, chat_id: "oc_issue_topics", notify_mode: "person", notify_open_id: "ou_reviewer" });
    expect(response.status).toBe(200);
    expect((await response.json()).config).toMatchObject({ notify_mode: "person", notify_open_id: "ou_reviewer" });
    const oldClient = await save({ enabled: true, chat_id: "oc_issue_topics" });
    expect((await oldClient.json()).config).toMatchObject({ notify_mode: "person", notify_open_id: "ou_reviewer" });
    for (const body of [
      { notify_mode: "all" },
      { notify_mode: null },
      { notify_mode: "person", notify_open_id: "all" },
      { notify_mode: "person", notify_open_id: "ou_x><at id=all" },
      { notify_mode: "person", notify_open_id: "" },
    ]) expect((await save({ enabled: true, chat_id: "oc_issue_topics", ...body })).status).toBe(400);
    expect((await (await save({ enabled: true, chat_id: "oc_issue_topics", notify_mode: "none" })).json()).config)
      .toMatchObject({ notify_mode: "none", notify_open_id: null });
  });

  it("refreshes the exact no-mention group in directives without redeploying the bot", () => {
    const { store, revision } = scaffold();
    const directive = () => store.feishuBotDirectiveForRuntime("local", "rt_bot");
    expect(directive()?.no_mention_chat_ids).toEqual([]);
    configureTopics(store);
    expect(directive()).toMatchObject({ revision, no_mention_chat_ids: ["oc_issue_topics"] });
    store.updateWorkspace("local", { settings: { issueTopics: { enabled: true, chatId: "oc_new" } } });
    expect(directive()).toMatchObject({ revision, no_mention_chat_ids: ["oc_new"] });
    store.updateWorkspace("local", { settings: { issueTopics: { enabled: false, chatId: "oc_new" } } });
    expect(directive()).toMatchObject({ revision, no_mention_chat_ids: [] });
  });

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
      bodyOrigin: "issue",
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

  it("wakes the bound topic Agent when an Issue task asks a human", () => {
    const { store } = scaffold();
    configureTopics(store);
    const wake = prepareReport(store);
    const roundDelivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    store.reportFeishuBotOutbound("local", "rt_bot", roundDelivery.id, {
      claimToken: roundDelivery.claimToken,
      status: "sent",
      externalMessageId: "om_round_push",
    });
    const sourceTask = store.createTask({ agentId: store.getFeishuBotConfig("local")!.agentId, issueId: store.getTask(wake.id)!.issueId,
      workspaceId: "local", prompt: "Run the Issue" });
    const request = store.createTaskHumanRequest({
      taskId: sourceTask.id,
      kind: "question",
      payload: {
        message: "Should I continue?",
        questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
      },
    });

    const topicWake = store.listTasks().find(task => task.id !== wake.id && task.id !== sourceTask.id);
    expect(topicWake).toMatchObject({ chatSessionId: store.getTask(wake.id)!.chatSessionId, holdsWorkspace: false });
    expect(topicWake?.prompt).toContain(`Human request id: ${request.id}`);
    const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(delivery.taskId).toBe(topicWake?.id);
    expect(delivery.body).toContain("Should I continue?");

    // Replaying the same request report is idempotent and does not enqueue a
    // second wake Task or outbound delivery.
    expect(store.prepareFeishuBotHumanRequestPush(request)?.id).toBe(topicWake?.id);
    expect(store.listTasks().filter(task => task.prompt.includes(`Human request id: ${request.id}`))).toHaveLength(1);
  });

  it("keeps a private Feishu chat independent when its Agent creates an Issue", async () => {
    const { store, revision } = scaffold();
    configureTopics(store);
    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      chatType: "p2p",
      externalSessionKey: "oc_private",
      externalMessageId: "om_private_message",
      replyToMessageId: "om_private_message",
      chatId: "oc_private",
      senderUnionId: "on_issue_topic_owner",
      text: "Create an Issue, but keep this private chat independent.",
    });
    const task = store.getTask(inbound.taskId)!;
    const credential = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const response = await app.request("/api/issues", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({ title: "Created from a private chat" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.chat_issue_binding).toEqual({
      status: "independent",
      chat_session_id: inbound.chatSessionId,
      issue_id: body.id,
      existing_issue_id: null,
    });
    expect(store.getChatSession(inbound.chatSessionId)?.issueId).toBeNull();

    const delivery = store.claimFeishuBotOutbound("local", "rt_bot");
    expect(delivery).toMatchObject({
      chatId: "oc_issue_topics",
      threadId: null,
      body: expect.stringContaining("Created from a private chat"),
      bodyOrigin: "issue",
    });
    expect(store.listChatSessions("local").filter((chat) => chat.issueId === body.id)).toHaveLength(1);
  });

  it("turns a new configured group topic into one Issue and reuses it for replies", () => {
    const { store, revision } = scaffold();
    configureTopics(store);
    const first = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      chatType: "group",
      externalSessionKey: "oc_issue_topics:thread:om_group_root",
      externalMessageId: "om_group_root",
      replyToMessageId: "om_group_root",
      chatId: "oc_issue_topics",
      senderUnionId: "on_issue_topic_owner",
      text: "Implement natural Issue creation from this group topic.",
    });

    const chat = store.getChatSession(first.chatSessionId)!;
    const issue = store.getIssue(chat.issueId!)!;
    expect(issue).toMatchObject({
      title: "Implement natural Issue creation from this group topic.",
      status: "in_progress",
      assigneeType: "agent",
    });
    expect(store.getTask(first.taskId)?.issueId).toBe(issue.id);
    expect(store.listIssues({ workspaceId: "local" })).toHaveLength(1);
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();

    const duplicate = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      chatType: "group",
      externalSessionKey: "oc_issue_topics:thread:om_group_root",
      externalMessageId: "om_group_root",
      replyToMessageId: "om_group_root",
      chatId: "oc_issue_topics",
      senderUnionId: "on_issue_topic_owner",
      text: "Implement natural Issue creation from this group topic.",
    });
    expect(duplicate).toMatchObject({ duplicate: true, taskId: first.taskId, chatSessionId: first.chatSessionId });

    const reply = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      chatType: "group",
      externalSessionKey: "oc_issue_topics:thread:om_group_root",
      externalMessageId: "om_group_reply",
      replyToMessageId: "om_group_reply",
      chatId: "oc_issue_topics",
      threadId: "om_group_root",
      senderUnionId: "on_issue_topic_owner",
      text: "Add this detail to the same Issue.",
    });
    expect(reply).toMatchObject({ steered: true, taskId: first.taskId, chatSessionId: first.chatSessionId });
    expect(store.listIssues({ workspaceId: "local" })).toHaveLength(1);
    expect(store.listTasks().filter((task) => task.chatSessionId === first.chatSessionId)).toHaveLength(1);
  });

  it("skips a second topic when the Issue was created from a Feishu Chat task", async () => {
    const { store, revision } = scaffold();
    configureTopics(store);
    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      externalSessionKey: "oc_source:thread:om_source_root",
      chatType: "group",
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
      config: { enabled: false, chat_id: "", project_ids: null, notify_mode: "group_owner", notify_open_id: null },
    });
    const updated = await app.request("/api/workspaces/local/issue-topics", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: true, chat_id: " oc_filtered ", project_ids: [project.id, project.id] }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      workspace_id: "local",
      config: { enabled: true, chat_id: "oc_filtered", project_ids: [project.id], notify_mode: "group_owner", notify_open_id: null },
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

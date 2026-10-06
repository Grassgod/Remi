import { afterEach, expect, test } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createLocalStore();
  const creator = store.getOrCreateUser({ email: "chat-reader@example.test", name: "Chat creator" });
  store.createWorkspaceMember({ workspaceId: "local", userId: creator.id, name: creator.name, role: "member" });
  const runtime = store.registerRuntime({ name: "Chat reader", provider: "codex", ownerId: "local", daemonId: "reader" });
  const agent = store.createAgent({ name: "Chat reader", provider: "codex", runtimeId: runtime.id, visibility: "workspace" });
  const app = createMultiremiApp({ store, authToken: "test-master" });
  return { store, creator, runtime, agent, app };
}

async function ownChat(f: ReturnType<typeof fixture>) {
  const chat = f.store.createChatSession({ agentId: f.agent.id, creatorId: f.creator.id });
  const first = f.store.sendChatMessage(chat.id, { body: "FIRST_UNREAD" });
  f.store.sendChatMessage(chat.id, { body: "SECOND_UNREAD" });
  const task = f.store.claimTask(f.runtime.id)!;
  expect(task.id).toBe(first.task.id);
  const credential = await f.store.createTaskAccessToken(task, f.runtime.ownerId!);
  return { chat, first, task, headers: { Authorization: `Bearer ${credential.token}` } };
}

function logPaths(chatId: string, messageId: string, to: number) {
  return [
    `/api/sessions/${chatId}/log/entry?from=0&to=${to}`,
    `/api/sessions/${chatId}/log/entry?id=${messageId}`,
    `/api/sessions/${chatId}/log/locate?id=${messageId}`,
    `/api/sessions/${chatId}/log?before=20&after=0`,
  ];
}

test("a task reads its bound web Chat and records only its agent's unread progress", async () => {
  const f = fixture();
  const { chat, first, task, headers } = await ownChat(f);
  expect(chat.creatorId).not.toBe(f.runtime.ownerId);
  expect(task.chatSessionId).toBe(chat.id);
  const to = f.store.getConversationLogHead(chat.id)!.headSeq;
  expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
  const response = await f.app.request(`/api/sessions/${chat.id}/log/entry?from=0&to=${to}`, { headers });
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.entries.map((entry: { body_md: string }) => entry.body_md)).toEqual(["FIRST_UNREAD", "SECOND_UNREAD"]);
  expect(page.next_cursor).toBeNull();
  expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: to, offset: 0 });
  const otherAgent = f.store.createAgent({ name: "Independent reader", provider: "codex" });
  expect(f.store.getSessionAgentReadProgress(chat.id, otherAgent.id)).toEqual({ seq: 0, offset: 0 });

  const located = await f.app.request(`/api/sessions/${chat.id}/log/locate?id=${first.message.id}`, { headers });
  expect(located.status).toBe(200);
  expect(await located.json()).toMatchObject({ seq: f.store.locateConversationLogEntry(chat.id, first.message.id)!.seq });
  const expanded = await f.app.request(`/api/sessions/${chat.id}/log/entry?id=${first.message.id}`, { headers });
  expect(expanded.status).toBe(200);
  expect(await expanded.json()).toMatchObject({ id: first.message.id, body_md: "FIRST_UNREAD" });
  const window = await f.app.request(`/api/sessions/${chat.id}/log?before=20&after=0`, { headers });
  expect(window.status).toBe(200);
  expect((await window.json()).entries).toContainEqual(expect.objectContaining({ id: first.message.id, body_md: "FIRST_UNREAD" }));
});

test("a personal Feishu bot task reads its bound Chat with the real external creator and binding", async () => {
  const f = fixture();
  const previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
  try {
    f.store.heartbeatRuntime(f.runtime.id, { supportsFeishuBotConfig: true });
    const config = f.store.upsertFeishuBotConfig("local", { agentId: f.agent.id, runtimeId: f.runtime.id,
      enabled: true, appId: "cli_log_reader", appSecretOp: "set", appSecret: "test-secret", domain: "feishu" });
    f.store.reportFeishuBotRuntimeStatus("local", f.runtime.id, { state: "online", appliedRevision: config.revision });
    const submit = (senderOpenId: string, externalMessageId: string, text: string) => f.store.submitFeishuBotMessage("local", f.runtime.id, {
      revision: config.revision, externalSessionKey: senderOpenId, externalMessageId,
      chatType: "p2p", chatId: `oc_${senderOpenId}`, senderOpenId, text,
    });
    const first = submit("ou_reader", "om_first", "FEISHU_FIRST_UNREAD");
    submit("ou_reader", "om_second", "FEISHU_SECOND_UNREAD");
    const chat = f.store.getChatSession(first.chatSessionId)!;
    expect(chat.creatorId).toBe("feishu:open:cli_log_reader:ou_reader");
    expect(chat.creatorId).not.toBe(f.runtime.ownerId);
    expect(db!.query("SELECT app_id, external_session_key, chat_id, issue_id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?")
      .get(chat.id)).toMatchObject({ app_id: "cli_log_reader", external_session_key: "ou_reader", chat_id: "oc_ou_reader", issue_id: null });
    const task = f.store.claimTask(f.runtime.id)!;
    expect(task.id).toBe(first.taskId);
    const credential = await f.store.createTaskAccessToken(task, f.runtime.ownerId!);
    const headers = { Authorization: `Bearer ${credential.token}` };
    const to = f.store.getConversationLogHead(chat.id)!.headSeq;
    const read = await f.app.request(`/api/sessions/${chat.id}/log/entry?from=0&to=${to}`, { headers });
    expect(read.status).toBe(200);
    expect((await read.json()).entries.map((entry: { body_md: string }) => entry.body_md))
      .toEqual(["FEISHU_FIRST_UNREAD", "FEISHU_SECOND_UNREAD"]);
    expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: to, offset: 0 });

    const unrelated = submit("ou_other_member", "om_other", "PRIVATE_FEISHU_MESSAGE");
    const otherChat = f.store.getChatSession(unrelated.chatSessionId)!;
    expect(otherChat.creatorId).toBe("feishu:open:cli_log_reader:ou_other_member");
    const message = f.store.listChatMessages(otherChat.id)[0]!;
    for (const path of logPaths(otherChat.id, message.id, f.store.getConversationLogHead(otherChat.id)!.headSeq)) {
      const denied = await f.app.request(path, { headers });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "not your chat session" });
    }
    expect(f.store.getSessionAgentReadProgress(otherChat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
  } finally {
    if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  }
});

for (const creator of ["same", "other"] as const) test(`a task cannot read another Chat in its workspace (${creator} creator)`, async () => {
  const f = fixture();
  const { headers } = await ownChat(f);
  const chat = f.store.createChatSession({ agentId: f.agent.id, creatorId: creator === "same" ? f.creator.id : "other-user" });
  const sent = f.store.sendChatMessage(chat.id, { body: "PRIVATE_MESSAGE" });
  for (const path of logPaths(chat.id, sent.message.id, f.store.getConversationLogHead(chat.id)!.headSeq)) {
    const response = await f.app.request(path, { headers });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not your chat session" });
  }
  expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
});

for (const mismatch of ["task", "token", "chat"] as const) test(`a bound Chat does not bypass a ${mismatch} workspace mismatch`, async () => {
  const f = fixture();
  const own = await ownChat(f);
  const other = f.store.createWorkspace({ name: "Other workspace", slug: "other-reader" });
  let headers = own.headers;
  if (mismatch === "token") {
    const credential = await f.store.createTaskAccessToken({ ...own.task, workspaceId: other.id }, f.runtime.ownerId!);
    headers = { Authorization: `Bearer ${credential.token}` };
  } else if (mismatch === "task") {
    db!.run("UPDATE multiremi_tasks SET workspace_id = ? WHERE id = ?", [other.id, own.task.id]);
  } else {
    db!.run("UPDATE multiremi_chat_sessions SET workspace_id = ? WHERE id = ?", [other.id, own.chat.id]);
  }
  const to = f.store.getConversationLogHead(own.chat.id)!.headSeq;
  for (const path of logPaths(own.chat.id, own.first.message.id, to)) {
    const response = await f.app.request(path, { headers });
    expect(response.status).toBe(mismatch === "task" ? 403 : 404);
  }
  expect(f.store.getSessionAgentReadProgress(own.chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
});

test("human PAT log access remains creator-scoped", async () => {
  const f = fixture();
  const own = await ownChat(f);
  const owner = await f.store.createAccessToken({ name: "Creator", type: "pat", workspaceId: "local", userId: f.creator.id });
  const other = f.store.getOrCreateUser({ email: "other-reader@example.test", name: "Other member" });
  f.store.createWorkspaceMember({ workspaceId: "local", userId: other.id, name: other.name, role: "admin" });
  const stranger = await f.store.createAccessToken({ name: "Other member", type: "pat", workspaceId: "local", userId: other.id });
  const to = f.store.getConversationLogHead(own.chat.id)!.headSeq;
  for (const path of logPaths(own.chat.id, own.first.message.id, to)) {
    expect((await f.app.request(path, { headers: { Authorization: `Bearer ${owner.token}` } })).status).toBe(200);
    const denied = await f.app.request(path, { headers: { Authorization: `Bearer ${stranger.token}` } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "not your chat session" });
  }
  expect(f.store.getSessionAgentReadProgress(own.chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
});

test("an unbound task retains the existing creator fallback", async () => {
  const f = fixture();
  const { headers } = await ownChat(f);
  const chat = f.store.createChatSession({ agentId: f.agent.id, creatorId: f.runtime.ownerId! });
  const sent = f.store.sendChatMessage(chat.id, { body: "RUNTIME_OWNER_CHAT" });
  for (const path of logPaths(chat.id, sent.message.id, f.store.getConversationLogHead(chat.id)!.headSeq)) {
    expect((await f.app.request(path, { headers })).status).toBe(200);
  }
});

test("Issue task credentials still read Issue ranges and persist unread progress", async () => {
  const f = fixture();
  const issue = f.store.createIssue({ title: "Issue regression" });
  const session = f.store.getOrCreateDefaultIssueSession(issue.id);
  f.store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "ISSUE_UNREAD" });
  const task = f.store.createTask({ agentId: f.agent.id, issueId: issue.id, prompt: "Read issue" });
  const claimed = f.store.claimTask(f.runtime.id)!;
  expect(claimed.id).toBe(task.id);
  const credential = await f.store.createTaskAccessToken(claimed, f.runtime.ownerId!);
  const to = f.store.getConversationLogHead(session.id)!.headSeq;
  const response = await f.app.request(`/api/sessions/${session.id}/log/entry?from=0&to=${to}`,
    { headers: { Authorization: `Bearer ${credential.token}` } });
  expect(response.status).toBe(200);
  expect((await response.json()).entries).toContainEqual(expect.objectContaining({ body_md: "ISSUE_UNREAD" }));
  expect(f.store.getSessionAgentReadProgress(session.id, f.agent.id)).toEqual({ seq: to, offset: 0 });
});

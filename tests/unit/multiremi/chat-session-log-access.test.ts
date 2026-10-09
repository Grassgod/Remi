import { createResponsibleTestIssue } from './helpers.js';
import { afterEach, expect, test } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { useTaskSessionInput } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { createLocalStore, db, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

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

async function ownChat(f: ReturnType<typeof fixture>, creatorId = f.creator.id) {
  const chat = f.store.createChatSession({ agentId: f.agent.id, creatorId });
  const first = f.store.sendChatMessage(chat.id, { body: "FIRST_UNREAD" });
  const second = f.store.sendChatMessage(chat.id, { body: "SECOND_UNREAD" });
  const task = f.store.claimTask(f.runtime.id)!;
  expect(task.id).toBe(first.task.id);
  const credential = await f.store.createTaskAccessToken(task, f.runtime.ownerId!);
  return { chat, first, second, task, headers: { Authorization: `Bearer ${credential.token}` } };
}

function logPaths(chatId: string, messageId: string, to: number) {
  return [
    `/api/sessions/${chatId}/messages`,
    `/api/messages/${messageId}`,
    `/api/sessions/${chatId}/messages?from=0&to=${to}`,
    `/api/sessions/${chatId}/log/entry?id=${messageId}`,
    `/api/sessions/${chatId}/log/locate?id=${messageId}`,
    `/api/sessions/${chatId}/log?before=20&after=0`,
  ];
}

async function verifyExpansions(f: ReturnType<typeof fixture>, chatId: string, messageId: string,
  body: string, headers: { Authorization: string }) {
  const location = f.store.locateConversationLogEntry(chatId, messageId)!;
  const progress = f.store.getSessionAgentReadProgress(chatId, f.agent.id);
  const listed = await f.app.request(`/api/sessions/${chatId}/messages`, { headers });
  expect(listed.status).toBe(200);
  expect((await listed.json()).messages).toContainEqual(expect.objectContaining({ id: messageId, body_md: body }));
  expect(f.store.getSessionAgentReadProgress(chatId, f.agent.id)).toEqual(progress);
  const message = await f.app.request(`/api/messages/${messageId}`, { headers });
  expect(message.status).toBe(200);
  expect((await message.json()).message).toMatchObject({ id: messageId, body_md: body });
  expect(f.store.getSessionAgentReadProgress(chatId, f.agent.id)).toEqual(progress);
  const located = await f.app.request(`/api/sessions/${chatId}/log/locate?id=${messageId}`, { headers });
  expect(located.status).toBe(200);
  expect(await located.json()).toEqual({ id: messageId, seq: location.seq, head_seq: location.head_seq });
  expect(f.store.getSessionAgentReadProgress(chatId, f.agent.id)).toEqual(progress);
  for (const query of [`id=${messageId}`, `seq=${location.seq}`]) {
    const expanded = await f.app.request(`/api/sessions/${chatId}/log/entry?${query}`, { headers });
    expect(expanded.status).toBe(200);
    expect(await expanded.json()).toMatchObject({ id: messageId, body_md: body });
    expect(f.store.getSessionAgentReadProgress(chatId, f.agent.id)).toEqual(progress);
  }
  const window = await f.app.request(`/api/sessions/${chatId}/log?anchor=${location.seq}&before=2&after=20`, { headers });
  expect(window.status).toBe(200);
  const result = await window.json();
  expect(result).toMatchObject({ has_more_before: false, has_more_after: false });
  expect(result.entries).toContainEqual(expect.objectContaining({ id: messageId, body_md: body }));
  const seqs = result.entries.map((entry: { seq: number }) => entry.seq);
  expect(seqs).toEqual([...seqs].sort((a: number, b: number) => a - b));
  expect(f.store.getSessionAgentReadProgress(chatId, f.agent.id)).toEqual(progress);
}

for (const creator of ["runtime-owner", "other-user"] as const) test(`a task reads its bound web Chat (${creator}) and records only its agent's unread progress`, async () => {
  const f = fixture();
  const { chat, first, second, task, headers } = await ownChat(f, creator === "runtime-owner" ? f.runtime.ownerId! : f.creator.id);
  expect(chat.creatorId).toBe(creator === "runtime-owner" ? f.runtime.ownerId! : f.creator.id);
  expect(task.chatSessionId).toBe(chat.id);
  const offer = daemonTaskClaimResponse(f.store, task, f.store.getTaskTriggerMetadata(task));
  useTaskSessionInput(f.store, task, offer);
  const inputRange = JSON.parse((offer.session_projection as { jsonl: string }).jsonl.split("\n")[0]!);
  const to = f.store.getConversationLogHead(chat.id)!.headSeq;
  expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
  await verifyExpansions(f, chat.id, first.message.id, "FIRST_UNREAD", headers);
  const response = await f.app.request(`/api/sessions/${chat.id}/messages?from=0&to=${to}`, { headers });
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page).toMatchObject({ session_id: chat.id, from_seq: 0, to_seq: to });
  expect(page.from_seq).toBeLessThanOrEqual(inputRange.from_seq);
  expect(page.to_seq).toBeGreaterThanOrEqual(inputRange.to_seq);
  // Turn rows share the canonical log, so message sequences need not be adjacent.
  const firstSeq = f.store.locateConversationLogEntry(chat.id, first.message.id)!.seq;
  const secondSeq = f.store.locateConversationLogEntry(chat.id, second.message.id)!.seq;
  expect(page.entries.map((entry: { seq: number }) => entry.seq)).toEqual([firstSeq, secondSeq]);
  expect(page.entries.map((entry: { body_md: string }) => entry.body_md)).toEqual(["FIRST_UNREAD", "SECOND_UNREAD"]);
  expect(page.next_cursor).toBeNull();
  expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: to, offset: 0 });
  const otherAgent = f.store.createAgent({ name: "Independent reader", provider: "codex" });
  expect(f.store.getSessionAgentReadProgress(chat.id, otherAgent.id)).toEqual({ seq: 0, offset: 0 });

  const tail = await f.app.request(`/api/sessions/${chat.id}/messages?from=${firstSeq}&to=${secondSeq}`, { headers });
  expect(tail.status).toBe(200);
  expect((await tail.json()).entries.map((entry: { body_md: string }) => entry.body_md)).toEqual(["SECOND_UNREAD"]);
  expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: to, offset: 0 });
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
    const firstMessage = f.store.listChatMessages(chat.id)[0]!;
    await verifyExpansions(f, chat.id, firstMessage.id, "FEISHU_FIRST_UNREAD", headers);
    const read = await f.app.request(`/api/sessions/${chat.id}/messages?from=0&to=${to}`, { headers });
    expect(read.status).toBe(200);
    expect((await read.json()).entries.map((entry: { body_md: string }) => entry.body_md))
      .toEqual(["FEISHU_FIRST_UNREAD", "FEISHU_SECOND_UNREAD"]);
    expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: to, offset: 0 });

    f.store.startTask(task.id);
    f.store.consumeTaskSteerMessages(task.id, f.store.listPendingTaskSteerMessages(task.id).map(message => message.id));
    f.store.completeTask(task.id, { output: "FEISHU_DONE", sessionId: "provider-reader", workDir: "/tmp/chat-log-reader" });
    submit("ou_reader", "om_next", "FEISHU_NEXT_UNREAD");
    const next = f.store.claimTask(f.runtime.id)!;
    expect(next.chatSessionId).toBe(chat.id);
    const offer = daemonTaskClaimResponse(f.store, next, f.store.getTaskTriggerMetadata(next));
    useTaskSessionInput(f.store, next, offer);
    const range = JSON.parse((offer.session_projection as { jsonl: string }).jsonl.split("\n")[0]!);
    expect(range).toMatchObject({ type: "unread_range", session_id: chat.id, from_seq: to });
    expect(range.to_seq).toBeGreaterThan(to);
    const nextCredential = await f.store.createTaskAccessToken(next, f.runtime.ownerId!);
    const nextHeaders = { Authorization: `Bearer ${nextCredential.token}` };

    const unrelated = submit("ou_other_member", "om_other", "PRIVATE_FEISHU_MESSAGE");
    const otherChat = f.store.getChatSession(unrelated.chatSessionId)!;
    expect(otherChat.creatorId).toBe("feishu:open:cli_log_reader:ou_other_member");
    const message = f.store.listChatMessages(otherChat.id)[0]!;
    for (const path of logPaths(otherChat.id, message.id, f.store.getConversationLogHead(otherChat.id)!.headSeq)) {
      const denied = await f.app.request(path, { headers: nextHeaders });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "not your chat session" });
    }
    expect(f.store.getSessionAgentReadProgress(otherChat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
    expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: to, offset: 0 });

    const ownerChat = f.store.createChatSession({ agentId: f.agent.id, creatorId: f.runtime.ownerId! });
    const ownerMessage = f.store.sendChatMessage(ownerChat.id, { body: "PRIVATE_RUNTIME_OWNER_MESSAGE" });
    for (const path of logPaths(ownerChat.id, ownerMessage.message.id, f.store.getConversationLogHead(ownerChat.id)!.headSeq)) {
      const denied = await f.app.request(path, { headers: nextHeaders });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "not your chat session" });
    }
    expect(f.store.getSessionAgentReadProgress(ownerChat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
    expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: to, offset: 0 });
  } finally {
    if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  }
});

for (const creator of ["same", "other"] as const) test(`a task cannot read another Chat in its workspace (${creator} creator)`, async () => {
  const f = fixture();
  const { headers, task } = await ownChat(f);
  const chat = f.store.createChatSession({ agentId: f.agent.id, creatorId: creator === "same" ? f.creator.id : "other-user" });
  const sent = f.store.sendChatMessage(chat.id, { body: "PRIVATE_MESSAGE" });
  expect(task.agentId).toBe(sent.task.agentId);
  expect(task.chatSessionId).not.toBe(sent.task.chatSessionId);
  expect(chat.creatorId).not.toBe(f.runtime.ownerId);
  for (const path of logPaths(chat.id, sent.message.id, f.store.getConversationLogHead(chat.id)!.headSeq)) {
    const response = await f.app.request(path, { headers });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not your chat session" });
  }
  expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
});

for (const mismatch of ["task", "token", "chat"] as const) test(`a bound Chat does not bypass a ${mismatch} workspace mismatch after authentication`, async () => {
  const f = fixture();
  const own = await ownChat(f);
  const other = f.store.createWorkspace({ name: "Other workspace", slug: "other-reader" });
  let headers = own.headers;
  if (mismatch === "token") {
    const credential = await f.store.createTaskAccessToken({ ...own.task, workspaceId: other.id }, f.runtime.ownerId!);
    headers = { Authorization: `Bearer ${credential.token}` };
  } else if (mismatch === "task") {
    db!.run("UPDATE multiremi_turns SET workspace_id = ? WHERE current_attempt_id = ?", [other.id, own.task.id]);
  } else {
    db!.run("UPDATE multiremi_chat_sessions SET workspace_id = ? WHERE id = ?", [other.id, own.chat.id]);
  }
  if (mismatch !== "chat") {
    const verify = f.store.verifyAccessToken.bind(f.store);
    // Authenticate a real current attempt, then introduce the route's mismatch.
    // Pre-existing credential mismatches are independently rejected below.
    f.store.verifyAccessToken = async (rawToken, allowedTypes) => {
      db!.run("UPDATE multiremi_turns SET workspace_id = ? WHERE current_attempt_id = ?",
        [mismatch === "token" ? other.id : "local", own.task.id]);
      const verified = await verify(rawToken, allowedTypes);
      expect(verified).not.toBeNull();
      db!.run("UPDATE multiremi_turns SET workspace_id = ? WHERE current_attempt_id = ?",
        [mismatch === "task" ? other.id : "local", own.task.id]);
      return verified;
    };
  }
  const to = f.store.getConversationLogHead(own.chat.id)!.headSeq;
  for (const path of logPaths(own.chat.id, own.first.message.id, to)) {
    const response = await f.app.request(path, { headers });
    expect(response.status).toBe(mismatch === "task" ? 403 : 404);
  }
  expect(f.store.getSessionAgentReadProgress(own.chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
});

for (const mismatch of ["task", "token"] as const) test(`authentication rejects an existing ${mismatch} workspace mismatch before reading Chat logs`, async () => {
  const f = fixture();
  const own = await ownChat(f);
  const other = f.store.createWorkspace({ name: "Credential mismatch", slug: "credential-mismatch" });
  let headers = own.headers;
  if (mismatch === "task") {
    db!.run("UPDATE multiremi_turns SET workspace_id = ? WHERE current_attempt_id = ?", [other.id, own.task.id]);
  } else {
    const credential = await f.store.createTaskAccessToken({ ...own.task, workspaceId: other.id }, f.runtime.ownerId!);
    headers = { Authorization: `Bearer ${credential.token}` };
  }
  for (const path of logPaths(own.chat.id, own.first.message.id, f.store.getConversationLogHead(own.chat.id)!.headSeq)) {
    const denied = await f.app.request(path, { headers });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized" });
    expect(f.store.getSessionAgentReadProgress(own.chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
  }
});

for (const credentialType of ["pat", "jwt"] as const) test(`human ${credentialType} log access remains creator-scoped`, async () => {
  const f = fixture();
  const own = await ownChat(f);
  const tokenFor = async (userId: string) => credentialType === "jwt"
    ? signTestJwt({ sub: userId, exp: Math.floor(Date.now() / 1000) + 60 })
    : (await f.store.createAccessToken({ name: "Human reader", type: "pat", workspaceId: "local", userId })).token;
  const ownerToken = await tokenFor(f.creator.id);
  const other = f.store.getOrCreateUser({ email: "other-reader@example.test", name: "Other member" });
  f.store.createWorkspaceMember({ workspaceId: "local", userId: other.id, name: other.name, role: "admin" });
  const strangerToken = await tokenFor(other.id);
  const to = f.store.getConversationLogHead(own.chat.id)!.headSeq;
  for (const path of logPaths(own.chat.id, own.first.message.id, to)) {
    expect((await f.app.request(path, { headers: { Authorization: `Bearer ${ownerToken}` } })).status).toBe(200);
    const denied = await f.app.request(path, { headers: { Authorization: `Bearer ${strangerToken}` } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "not your chat session" });
  }
  db!.run("DELETE FROM multiremi_workspace_members WHERE workspace_id = ? AND user_id = ?", ["local", other.id]);
  for (const path of logPaths(own.chat.id, own.first.message.id, to)) {
    expect((await f.app.request(path, { headers: { Authorization: `Bearer ${strangerToken}` } })).status).toBe(404);
  }
  expect(f.store.getSessionAgentReadProgress(own.chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
});

test("bound Chat range pagination records partial offsets and repeated reads never move backwards", async () => {
  const f = fixture();
  const body = "LONG_CHAT_MESSAGE_".repeat(5_000);
  const chat = f.store.createChatSession({ agentId: f.agent.id, creatorId: f.creator.id });
  const sent = f.store.sendChatMessage(chat.id, { body });
  const task = f.store.claimTask(f.runtime.id)!;
  expect(task.id).toBe(sent.task.id);
  const credential = await f.store.createTaskAccessToken(task, f.runtime.ownerId!);
  const headers = { Authorization: `Bearer ${credential.token}` };
  const to = f.store.getConversationLogHead(chat.id)!.headSeq;
  let cursor: string | null = null;
  let text = "";
  do {
    const params = new URLSearchParams({ from: "0", to: String(to) });
    if (cursor) params.set("cursor", cursor);
    const response = await f.app.request(`/api/sessions/${chat.id}/messages?${params}`, { headers });
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ id: sent.message.id, body_offset: text.length });
    text += page.entries[0].body_md;
    cursor = page.next_cursor;
    expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id))
      .toEqual(cursor ? { seq: 0, offset: text.length } : { seq: to, offset: 0 });
  } while (cursor);
  expect(text).toBe(body);
  const repeated = await f.app.request(`/api/sessions/${chat.id}/messages?from=0&to=${to}`, { headers });
  expect(repeated.status).toBe(200);
  expect((await repeated.json()).next_cursor).not.toBeNull();
  expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: to, offset: 0 });
});

test("a valid task credential cannot read a Chat in a different workspace", async () => {
  const f = fixture();
  const own = await ownChat(f);
  const workspace = f.store.createWorkspace({ name: "Foreign workspace", slug: "foreign-reader" });
  const agent = f.store.createAgent({ name: "Foreign reader", provider: "codex", workspaceId: workspace.id });
  const chat = f.store.createChatSession({ agentId: agent.id, workspaceId: workspace.id, creatorId: "foreign-user" });
  const sent = f.store.sendChatMessage(chat.id, { body: "FOREIGN_PRIVATE_MESSAGE" });
  for (const path of logPaths(chat.id, sent.message.id, f.store.getConversationLogHead(chat.id)!.headSeq)) {
    const denied = await f.app.request(path, { headers: own.headers });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "workspace not found" });
  }
  expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
  expect(f.store.getSessionAgentReadProgress(own.chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
});

test("bound Chat log reads retain parameter validation and missing-entry errors", async () => {
  const f = fixture();
  const own = await ownChat(f);
  for (const query of ["", "seq=-1", "seq=1&id=missing", "from=0", "from=2&to=1"]) {
    const endpoint = query.startsWith("from=") ? "messages" : "log/entry";
    expect((await f.app.request(`/api/sessions/${own.chat.id}/${endpoint}?${query}`, { headers: own.headers })).status).toBe(400);
  }
  for (const endpoint of ["log", "log/entry", "log/locate"]) {
    const retired = await f.app.request(`/api/sessions/${own.chat.id}/${endpoint}?from=0&to=2`, { headers: own.headers });
    expect(retired.status).toBe(400);
    expect(await retired.json()).toEqual({ error: "log is display-only; use remi message list <conversation> --from <seq> --to <seq>" });
  }
  for (const path of ["log/entry?id=missing", "log/entry?seq=999", "log/locate?id=missing"]) {
    expect((await f.app.request(`/api/sessions/${own.chat.id}/${path}`, { headers: own.headers })).status).toBe(404);
  }
  expect((await f.app.request(`/api/sessions/${own.chat.id}/log/locate`, { headers: own.headers })).status).toBe(400);
  expect((await f.app.request(`/api/sessions/${own.chat.id}/log?before=100&after=1`, { headers: own.headers })).status).toBe(400);
  for (const path of logPaths("chat_missing", "missing", 1)) {
    if (path.startsWith("/api/messages/")) continue;
    const denied = await f.app.request(path, { headers: own.headers });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "not your chat session" });
  }
  expect(f.store.getSessionAgentReadProgress(own.chat.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
});

test("deleted Chat logs stay inaccessible to retained task credentials without advancing unread progress", async () => {
  const f = fixture();
  const own = await ownChat(f);
  const seq = f.store.locateConversationLogEntry(own.chat.id, own.first.message.id)!.seq;
  const to = f.store.getConversationLogHead(own.chat.id)!.headSeq;
  const allowed = await f.app.request(`/api/sessions/${own.chat.id}/messages?from=0&to=${seq}`, { headers: own.headers });
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).entries).toContainEqual(expect.objectContaining({ body_md: "FIRST_UNREAD" }));
  const progress = f.store.getSessionAgentReadProgress(own.chat.id, f.agent.id);
  expect(progress).toEqual({ seq, offset: 0 });
  expect(progress.seq).toBeLessThan(to);

  expect(f.store.deleteChatSession(own.chat.id)).toBe(true);
  expect(f.store.getChatSession(own.chat.id)).toBeNull();
  const retainedTask = f.store.getTask(own.task.id)!;
  expect(retainedTask).toMatchObject({ chatSessionId: own.chat.id, agentId: f.agent.id, workspaceId: own.chat.workspaceId });
  expect(f.store.getConversationLogEntry(own.chat.id, seq)).toMatchObject({ id: own.first.message.id, body_md: "FIRST_UNREAD" });
  expect(f.store.getConversationLogEntry(own.chat.id, to)).toMatchObject({ body_md: "SECOND_UNREAD" });
  expect(f.store.getSessionAgentReadProgress(own.chat.id, f.agent.id)).toEqual(progress);
  expect(await f.store.verifyAccessToken(own.headers.Authorization.slice("Bearer ".length), ["task"])).toBeNull();

  // A fresh valid token proves the retained log is blocked by the Chat guard.
  const credential = await f.store.createTaskAccessToken(retainedTask, f.runtime.ownerId!);
  expect(await f.store.verifyAccessToken(credential.token, ["task"]))
    .toMatchObject({ taskId: retainedTask.id, agentId: f.agent.id, workspaceId: own.chat.workspaceId });
  const headers = { Authorization: `Bearer ${credential.token}` };
  const paths = [...logPaths(own.chat.id, own.first.message.id, to), `/api/sessions/${own.chat.id}/log/entry?seq=${seq}`];
  for (const path of paths) {
    const revoked = await f.app.request(path, { headers: own.headers });
    expect(revoked.status, path).toBe(401);
    const revokedBody = await revoked.text();
    expect(revokedBody).not.toContain("FIRST_UNREAD");
    expect(revokedBody).not.toContain("SECOND_UNREAD");
    expect(f.store.getSessionAgentReadProgress(own.chat.id, f.agent.id)).toEqual(progress);

    const denied = await f.app.request(path, { headers });
    expect(denied.status, path).toBe(404);
    expect(await denied.json()).toEqual({ error: "chat session not found" });
    expect(f.store.getSessionAgentReadProgress(own.chat.id, f.agent.id)).toEqual(progress);
  }
});

for (const creator of ["runtime-owner", "other-user"] as const) test(`a task cannot inherit creator access to another Chat (${creator} source)`, async () => {
  const f = fixture();
  const own = await ownChat(f, creator === "runtime-owner" ? f.runtime.ownerId! : f.creator.id);
  const { headers } = own;
  const chat = f.store.createChatSession({ agentId: f.agent.id, creatorId: f.runtime.ownerId! });
  const sent = f.store.sendChatMessage(chat.id, { body: "RUNTIME_OWNER_CHAT" });
  const turn = f.store.getTurnForAttempt(sent.task.id)!;
  const otherAgent = f.store.createAgent({ name: "Other lane", provider: "codex" });
  const snapshot = () => ({
    rows: ["multiremi_conversation_log", "multiremi_turns", "multiremi_turn_attempts", "multiremi_attachments", "multiremi_conversation_heads"]
      .map(table => Number((db!.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)),
    sourceHead: f.store.getConversationLogHead(own.chat.id),
    targetHead: f.store.getConversationLogHead(chat.id),
    turn: f.store.getTurn(turn.id),
    progress: [own.chat.id, chat.id].flatMap(id => [f.agent.id, otherAgent.id]
      .map(agentId => f.store.getSessionAgentReadProgress(id, agentId))),
  });
  const before = snapshot();
  const seq = f.store.locateConversationLogEntry(chat.id, sent.message.id)!.seq;
  const paths = [...logPaths(chat.id, sent.message.id, f.store.getConversationLogHead(chat.id)!.headSeq),
    `/api/sessions/${chat.id}/log/entry?seq=${seq}`, `/api/turns/${turn.id}`];
  for (const path of paths) {
    const denied = await f.app.request(path, { headers });
    expect(denied.status, path).toBe(403);
    expect(await denied.json()).toEqual({ error: "not your chat session" });
    expect(snapshot()).toEqual(before);
  }
  for (const path of [`/api/sessions/${chat.id}/messages`, `/api/turns/${turn.id}/cancel`]) {
    const denied = await f.app.request(path, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ body_md: "Forbidden" }),
    });
    expect(denied.status, path).toBe(403);
    expect(snapshot()).toEqual(before);
  }
  const form = new FormData();
  form.set("message", JSON.stringify({ body_md: "Forbidden upload" }));
  form.append("file", new File(["private bytes"], "denied.txt"));
  expect((await f.app.request(`/api/sessions/${chat.id}/messages`, { method: "POST", headers, body: form })).status).toBe(403);
  const inbox = await f.app.request("/api/inbox", { headers });
  expect(inbox.status).toBe(200);
  expect((await inbox.text())).not.toContain("RUNTIME_OWNER_CHAT");
  expect(snapshot()).toEqual(before);
});

test("Issue task credentials still read Issue ranges and persist unread progress", async () => {
  const f = fixture();
  const issue = createResponsibleTestIssue(f.store, { title: "Issue regression" });
  const session = f.store.getOrCreateDefaultIssueSession(issue.id);
  f.store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "ISSUE_UNREAD" });
  const task = f.store.createTask({ agentId: f.agent.id, issueId: issue.id, prompt: "Read issue" });
  const claimed = f.store.claimTask(f.runtime.id)!;
  expect(claimed.id).toBe(task.id);
  const credential = await f.store.createTaskAccessToken(claimed, f.runtime.ownerId!);
  const to = f.store.getConversationLogHead(session.id)!.headSeq;
  const response = await f.app.request(`/api/sessions/${session.id}/messages?from=0&to=${to}`,
    { headers: { Authorization: `Bearer ${credential.token}` } });
  expect(response.status).toBe(200);
  expect((await response.json()).entries).toContainEqual(expect.objectContaining({ body_md: "ISSUE_UNREAD" }));
  expect(f.store.getSessionAgentReadProgress(session.id, f.agent.id)).toEqual({ seq: to, offset: 0 });
  const workspace = f.store.createWorkspace({ name: "Foreign issues", slug: "foreign-issues" });
  const foreignIssue = createResponsibleTestIssue(f.store, { workspaceId: workspace.id, title: "Foreign unread issue" });
  const foreignSession = f.store.getOrCreateDefaultIssueSession(foreignIssue.id);
  const denied = await f.app.request(`/api/sessions/${foreignSession.id}/messages?from=0&to=1`,
    { headers: { Authorization: `Bearer ${credential.token}` } });
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "workspace not found" });
  expect(f.store.getSessionAgentReadProgress(foreignSession.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
});

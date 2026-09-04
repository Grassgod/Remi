// Chat session persistence/resume plus the creator-scoped HTTP surfaces.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import {
  buildChatBootstrapTranscript,
  CHAT_BOOTSTRAP_MAX_BYTES,
  CHAT_BOOTSTRAP_MAX_MESSAGES,
  CHAT_BOOTSTRAP_OMITTED_NOTICE,
} from "@multiremi/store/repos/chat-repo.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — chat sessions and private agent access", () => {
  it("bounds cold bootstrap history by newest 64 messages and 64 KiB", () => {
    const messages = Array.from({ length: 80 }, (_, index) => ({
      id: `msg_${index}`,
      chatSessionId: "chat_1",
      taskId: `tsk_${index}`,
      role: index % 2 ? "assistant" : "user",
      body: `message-${index} ${"x".repeat(1400)}`,
      failureReason: null,
      elapsedMs: null,
      createdAt: new Date(index * 1000).toISOString(),
    })) as any;

    const result = buildChatBootstrapTranscript(messages);
    expect(result.omitted).toBe(true);
    expect(result.includedMessages).toBeLessThanOrEqual(CHAT_BOOTSTRAP_MAX_MESSAGES);
    expect(new TextEncoder().encode(result.transcript).byteLength).toBeLessThanOrEqual(CHAT_BOOTSTRAP_MAX_BYTES);
    expect(result.transcript).toStartWith(CHAT_BOOTSTRAP_OMITTED_NOTICE);
    expect(result.transcript).toContain("message-79");
    expect(result.transcript).not.toContain("message-0 ");

    const oversized = buildChatBootstrapTranscript([{ ...messages[0], body: "中文".repeat(50_000) }]);
    expect(new TextEncoder().encode(oversized.transcript).byteLength).toBeLessThanOrEqual(CHAT_BOOTSTRAP_MAX_BYTES);
    expect(oversized.transcript).toContain("[Message truncated.]");
  });

  it("persists chat sessions and resumes provider context across turns", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "Private plan" });

    const first = store.sendChatMessage(session.id, { body: "How should we approach this?" });
    expect(first.message.role).toBe("user");
    expect(first.task.chatSessionId).toBe(session.id);

    expect(store.claimTask(runtime.id)?.id).toBe(first.task.id);
    store.startTask(first.task.id);
    store.completeTask(first.task.id, {
      output: "Start with a small patch.",
      sessionId: "provider-session-1",
      workDir: "/tmp/multiremi-chat",
    });

    const messages = store.listChatMessages(session.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.body).toBe("Start with a small patch.");
    expect(store.getChatSession(session.id)?.sessionId).toBe("provider-session-1");

    const second = store.sendChatMessage(session.id, { body: "Continue" });
    expect(second.task.sessionId).toBe("provider-session-1");
    expect(second.task.workDir).toBe("/tmp/multiremi-chat");
    expect(store.claimTask(runtime.id)?.id).toBe(second.task.id);
    store.startTask(second.task.id);
    store.failTask(second.task.id, {
      error: "Invalid request",
      sessionId: "unsafe-provider-session",
      workDir: "/tmp/unsafe-chat",
      failureReason: "api_invalid_request",
    });

    const failedMessages = store.listChatMessages(session.id);
    expect(failedMessages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(failedMessages[3]?.failureReason).toBe("api_invalid_request");
    expect(failedMessages[3]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(store.getChatSession(session.id)?.sessionId).toBe("provider-session-1");
    expect(store.getChatSession(session.id)?.workDir).toBe("/tmp/multiremi-chat");
    expect(store.getChatSession(session.id)?.hasUnread).toBe(true);
    store.markChatSessionRead(session.id);
    expect(store.getChatSession(session.id)?.hasUnread).toBe(false);
  });

  it("stamps a bound Issue onto Chat tasks without creating an Issue Session", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Bound chat", provider: "codex" });
    const issue = store.createIssue({ title: "Bound Issue", workspaceId: "local" });
    const session = store.createChatSession({ agentId: agent.id, issueId: issue.id });

    const sent = store.sendChatMessage(session.id, { body: "Continue the Issue" });

    expect(sent.task.issueId).toBe(issue.id);
    expect(sent.task.issueSessionId).toBeNull();
    expect(store.getTaskWithAgent(sent.task.id)?.issue?.key).toBe(issue.key);
  });

  it("scopes chat session HTTP routes to the current creator", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Chat runtime", provider: "codex" });
    const agent = store.createAgent({ name: "Chat Codex", provider: "codex", visibility: "workspace", runtimeId: runtime.id });
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "member" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "Bob", type: "pat", workspaceId: "local", userId: "bob" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const aliceHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${aliceToken.token}` };
    const bobHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${bobToken.token}` };
    const aliceAuthHeaders = { Authorization: `Bearer ${aliceToken.token}` };
    const bobAuthHeaders = { Authorization: `Bearer ${bobToken.token}` };

    const created = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ agent_id: agent.id, creator_id: "bob", title: "Alice private chat" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(Object.keys(createdBody).sort()).toEqual([
      "agent_id",
      "created_at",
      "creator_id",
      "has_unread",
      "id",
      "issue_id",
      "status",
      "title",
      "updated_at",
      "workspace_id",
    ]);
    expect(createdBody.creator_id).toBe("alice");
    expect(createdBody.agent_id).toBe(agent.id);
    expect(createdBody.issue_id).toBeNull();
    expect(createdBody.has_unread).toBe(false);

    const aliceList = await app.request("/api/chat/sessions", { headers: aliceAuthHeaders });
    expect((await aliceList.json()).map((session: any) => session.id)).toEqual([createdBody.id]);
    const bobList = await app.request("/api/chat/sessions", { headers: bobAuthHeaders });
    expect(await bobList.json()).toEqual([]);
    const bobMultiremiList = await app.request("/api/multiremi/chats", { headers: bobAuthHeaders });
    expect(await bobMultiremiList.json()).toMatchObject({ sessions: [], total: 0 });

    const attachment = store.createAttachment({
      chatSessionId: createdBody.id,
      workspaceId: "local",
      filename: "brief.txt",
      url: "/api/attachments/att_chat_brief/content",
      contentType: "text/plain",
      sizeBytes: 12,
    });
    const sent = await app.request(`/api/chat/sessions/${createdBody.id}/messages`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ content: "Use Go-compatible content", attachment_ids: [attachment.id] }),
    });
    expect(sent.status).toBe(201);
    const sentBody = await sent.json();
    expect(Object.keys(sentBody).sort()).toEqual(["created_at", "message_id", "task_id"]);
    expect(store.getTask(sentBody.task_id)?.chatSessionId).toBe(createdBody.id);
    const messages = await app.request(`/api/chat/sessions/${createdBody.id}/messages`, { headers: aliceAuthHeaders });
    const messagesBody = await messages.json();
    expect(Object.keys(messagesBody[0]).sort()).toEqual([
      "attachments",
      "chat_session_id",
      "content",
      "created_at",
      "elapsed_ms",
      "failure_reason",
      "id",
      "role",
      "task_id",
    ]);
    expect(messagesBody[0]).toMatchObject({
      chat_session_id: createdBody.id,
      content: "Use Go-compatible content",
      role: "user",
      task_id: sentBody.task_id,
    });
    expect(messagesBody[0].attachments[0]).toMatchObject({
      id: attachment.id,
      chat_session_id: createdBody.id,
      chat_message_id: messagesBody[0].id,
      filename: "brief.txt",
      content_type: "text/plain",
      size_bytes: 12,
      download_url: `/api/attachments/${attachment.id}/download`,
    });
    expect(Object.keys(messagesBody[0].attachments[0]).filter((key) => /[A-Z]/.test(key))).toEqual([]);
    expect(store.getAttachment(attachment.id)?.chatMessageId).toBe(messagesBody[0].id);
    const invalidPageLimit = await app.request(`/api/chat/sessions/${createdBody.id}/messages/page?limit=101`, {
      headers: aliceAuthHeaders,
    });
    expect(invalidPageLimit.status).toBe(400);
    expect(await invalidPageLimit.json()).toEqual({ error: "invalid limit" });

    const pendingAlice = await app.request("/api/chat/pending-tasks", { headers: aliceAuthHeaders });
    expect((await pendingAlice.json()).tasks.map((task: any) => task.chat_session_id)).toEqual([createdBody.id]);
    const pendingBob = await app.request("/api/chat/pending-tasks", { headers: bobAuthHeaders });
    expect(await pendingBob.json()).toEqual({ tasks: [] });

    expect(store.claimTask(runtime.id)?.id).toBe(sentBody.task_id);
    store.startTask(sentBody.task_id);
    store.completeTask(sentBody.task_id, { output: "Done with chat", sessionId: "provider-chat-session" });
    const unreadDetail = await app.request(`/api/chat/sessions/${createdBody.id}`, { headers: aliceAuthHeaders });
    expect((await unreadDetail.json()).has_unread).toBe(true);
    const terminalMessages = await app.request(`/api/chat/sessions/${createdBody.id}/messages`, { headers: aliceAuthHeaders });
    const terminalMessagesBody = await terminalMessages.json();
    expect(terminalMessagesBody[1]).toMatchObject({
      role: "assistant",
      content: "Done with chat",
      failure_reason: null,
      task_id: sentBody.task_id,
    });
    expect(terminalMessagesBody[1].elapsed_ms).toBeGreaterThanOrEqual(0);
    expect((await app.request(`/api/chat/sessions/${createdBody.id}/read`, {
      method: "POST",
      headers: aliceAuthHeaders,
    })).status).toBe(204);
    const readDetail = await app.request(`/api/chat/sessions/${createdBody.id}`, { headers: aliceAuthHeaders });
    expect((await readDetail.json()).has_unread).toBe(false);

    const bobForbiddenRequests: Array<[string, string, unknown?]> = [
      ["GET", `/api/chat/sessions/${createdBody.id}`],
      ["PATCH", `/api/chat/sessions/${createdBody.id}`, { title: "Bob rename" }],
      ["GET", `/api/chat/sessions/${createdBody.id}/messages`],
      ["GET", `/api/chat/sessions/${createdBody.id}/messages/page?limit=1`],
      ["POST", `/api/chat/sessions/${createdBody.id}/messages`, { content: "Bob should not send" }],
      ["GET", `/api/chat/sessions/${createdBody.id}/pending-task`],
      ["POST", `/api/chat/sessions/${createdBody.id}/read`],
      ["DELETE", `/api/chat/sessions/${createdBody.id}`],
      ["GET", `/api/multiremi/chats/${createdBody.id}`],
      ["PATCH", `/api/multiremi/chats/${createdBody.id}`, { title: "Bob Multiremi rename" }],
      ["GET", `/api/multiremi/chats/${createdBody.id}/messages`],
      ["POST", `/api/multiremi/chats/${createdBody.id}/messages`, { content: "Bob Multiremi send" }],
    ];
    for (const [method, path, body] of bobForbiddenRequests) {
      const response = await app.request(path, {
        method,
        headers: body ? bobHeaders : bobAuthHeaders,
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "not your chat session" });
    }

    const pendingBeforeDelete = await app.request(`/api/chat/sessions/${createdBody.id}/messages`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ content: "Pending before delete" }),
    });
    expect(pendingBeforeDelete.status).toBe(201);
    const pendingBeforeDeleteBody = await pendingBeforeDelete.json();
    expect(store.getTask(pendingBeforeDeleteBody.task_id)?.chatSessionId).toBe(createdBody.id);

    const aliceSession = await app.request(`/api/chat/sessions/${createdBody.id}`, { headers: aliceAuthHeaders });
    expect((await aliceSession.json()).id).toBe(createdBody.id);
    expect((await app.request(`/api/chat/sessions/${createdBody.id}`, {
      method: "DELETE",
      headers: aliceAuthHeaders,
    })).status).toBe(204);
    expect(store.getChatSession(createdBody.id)).toBeNull();
    expect(store.getTask(sentBody.task_id)?.status).toBe("completed");
    expect(store.getTask(sentBody.task_id)?.chatSessionId).toBeNull();
    expect(store.getTask(pendingBeforeDeleteBody.task_id)?.status).toBe("cancelled");
    expect(store.getTask(pendingBeforeDeleteBody.task_id)?.chatSessionId).toBeNull();
    expect(store.getAttachment(attachment.id)).toBeNull();
  });

  it("rechecks private agent access across chat and agent HTTP surfaces", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "member" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "Bob", type: "pat", workspaceId: "local", userId: "bob" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const aliceRuntime = store.registerRuntime({
      id: "rt_private_alice",
      name: "Alice private runtime",
      provider: "codex",
      workspaceId: "local",
      ownerId: "alice",
      visibility: "private",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const aliceHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${aliceToken.token}` };
    const aliceAuthHeaders = { Authorization: `Bearer ${aliceToken.token}` };
    const bobAuthHeaders = { Authorization: `Bearer ${bobToken.token}` };
    const adminAuthHeaders = { Authorization: `Bearer ${adminToken.token}` };

    const createdAgent = await app.request("/api/agents", {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({
        name: "Private Codex",
        provider: "claude",
        runtime_id: aliceRuntime.id,
        owner_id: "bob",
        visibility: "private",
      }),
    });
    expect(createdAgent.status).toBe(201);
    const agent = await createdAgent.json();
    expect(agent.owner_id).toBe("alice");
    // Pool model: the legacy runtime_id only picks the provider; no binding.
    expect(agent.runtime_id).toBe("");
    expect(agent.provider).toBe("codex");
    expect(store.getAgent(agent.id)?.provider).toBe("codex");
    expect(store.getAgent(agent.id)?.runtimeId).toBeNull();
    expect(agent.visibility).toBe("private");

    expect((await app.request(`/api/agents/${agent.id}`, { headers: aliceAuthHeaders })).status).toBe(200);
    expect((await app.request(`/api/agents/${agent.id}`, { headers: adminAuthHeaders })).status).toBe(200);
    const bobAgentList = await app.request("/api/agents", { headers: bobAuthHeaders });
    expect((await bobAgentList.json()).map((item: any) => item.id)).not.toContain(agent.id);
    const bobAgentDetail = await app.request(`/api/agents/${agent.id}`, { headers: bobAuthHeaders });
    expect(bobAgentDetail.status).toBe(403);
    expect(await bobAgentDetail.json()).toEqual({ error: "you do not have access to this agent" });

    const bobChatCreate = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bobToken.token}` },
      body: JSON.stringify({ agent_id: agent.id, title: "Bob should not start" }),
    });
    expect(bobChatCreate.status).toBe(403);
    expect(await bobChatCreate.json()).toEqual({ error: "you do not have access to this agent" });

    const aliceChatCreate = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ agent_id: agent.id, title: "Alice private chat" }),
    });
    expect(aliceChatCreate.status).toBe(201);
    const chat = await aliceChatCreate.json();
    const aliceCleanupChatCreate = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ agent_id: agent.id, title: "Alice private cleanup" }),
    });
    expect(aliceCleanupChatCreate.status).toBe(201);
    const cleanupChat = await aliceCleanupChatCreate.json();
    const sent = await app.request(`/api/chat/sessions/${chat.id}/messages`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ content: "queued before access changes" }),
    });
    expect(sent.status).toBe(201);

    store.updateAgent(agent.id, { ownerId: "carol" });
    const aliceHiddenList = await app.request("/api/chat/sessions", { headers: aliceAuthHeaders });
    expect(await aliceHiddenList.json()).toEqual([]);
    const aliceHiddenPending = await app.request("/api/chat/pending-tasks", { headers: aliceAuthHeaders });
    expect(await aliceHiddenPending.json()).toEqual({ tasks: [] });
    const aliceHiddenChat = await app.request(`/api/chat/sessions/${chat.id}`, { headers: aliceAuthHeaders });
    expect(aliceHiddenChat.status).toBe(403);
    expect(await aliceHiddenChat.json()).toEqual({ error: "you do not have access to this agent" });
    const aliceHiddenDelete = await app.request(`/api/chat/sessions/${cleanupChat.id}`, {
      method: "DELETE",
      headers: aliceAuthHeaders,
    });
    expect(aliceHiddenDelete.status).toBe(204);
    expect(store.getChatSession(cleanupChat.id)).toBeNull();

    store.updateAgent(agent.id, { visibility: "workspace" });
    const aliceVisibleAgain = await app.request(`/api/chat/sessions/${chat.id}`, { headers: aliceAuthHeaders });
    expect(aliceVisibleAgain.status).toBe(200);
    expect((await aliceVisibleAgain.json()).id).toBe(chat.id);
  });
});

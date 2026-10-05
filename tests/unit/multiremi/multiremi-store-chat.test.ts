import { requestMessageBody, turnApiPath, sentTask, mutateExecutionFixture } from "./unified-test-paths.js";
// Chat session persistence/resume plus the creator-scoped HTTP surfaces.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — chat sessions and private agent access", () => {
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

    // Preserve insertion order even when the database timestamp cannot break ties.
    (store as any).db.run(
      "UPDATE multiremi_chat_messages SET created_at = ? WHERE chat_session_id = ?",
      ["2026-09-05T00:00:00.000Z", session.id],
    );

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

  it("keeps Chat tasks independent from Issue ownership", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Private chat", provider: "codex" });
    const issue = store.createIssue({ title: "Separate work", workspaceId: "local" });
    const session = store.createChatSession({ agentId: agent.id });
    const sent = store.sendChatMessage(session.id, { body: "Continue chatting" });

    expect(sent.task.issueId).toBeNull();
    expect(sent.task.issueSessionId).toBeNull();
    expect(store.getTaskWithAgent(sent.task.id)).toMatchObject({
      issue: null, project: null, projectResources: [], projectContexts: [], repos: [],
    });
    expect(store.getChatSession(session.id)).not.toHaveProperty("issueId");
    expect(() => store.createTask({ agentId: agent.id, chatSessionId: session.id,
      issueId: issue.id, prompt: "Attach Issue" })).toThrow("Only Feishu Issue topics");
    expect(store.getAgentChatNotificationChannel(session.id)).toBeNull();
  });

  it("retries a legacy private Chat failure without its old Issue or provider context", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const runtime = store.registerRuntime({ name: "Local", provider: "codex" });
    const issue = store.createIssue({ title: "Former accidental binding" });
    const chat = store.createChatSession({ agentId: agent.id });
    const sent = store.sendChatMessage(chat.id, { body: "Continue" });
    store.claimTask(runtime.id);
    store.startTask(sent.task.id);
    // An in-flight pre-upgrade task keeps its audit association after migration.
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET issue_id = ? WHERE id = ?", [issue.id, sent.task.id]);
    store.failTask(sent.task.id, {
      error: "Timed out during upgrade", failureReason: "timeout",
      sessionId: "legacy-issue-provider", workDir: "/tmp/private-chat",
    });
    const retry = store.listTasks().find((task) => task.parentTaskId === sent.task.id)!;
    expect(retry).toMatchObject({ chatSessionId: chat.id, issueId: null, issueSessionId: null, sessionId: null });
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(retry.id);
    expect(claimed.sessionId).toBeNull();
    expect(claimed.issue).toBeNull();
    expect(store.buildTaskSessionProjection(claimed.id)?.mode).toBe("bootstrap");
    expect(store.getTask(sent.task.id)?.issueId).toBe(issue.id);
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
      "last_message",
      "pinned",
      "project_id",
      "runtime_workspace_id",
      "status",
      "title",
      "unread_count",
      "updated_at",
      "workspace_id",
    ]);
    expect(createdBody.creator_id).toBe("alice");
    expect(createdBody.agent_id).toBe(agent.id);
    expect(createdBody.project_id).toBeNull();
    expect(createdBody).not.toHaveProperty("issue_id");
    expect(createdBody.runtime_workspace_id).toBeNull();
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
    const sent = await app.request(`/api/sessions/${createdBody.id}/messages`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify(requestMessageBody(store, { content: "Use Go-compatible content", attachment_ids: [attachment.id] }, { type: "agent", ref: store.getChatSession(createdBody.id)!.agentId })),
    });
    expect(sent.status).toBe(200);
    const sentBody = await sent.json();
    expect(Object.keys(sentBody).sort()).toEqual(["message", "turn_id", "wake_applied", "wake_reason"]);
    expect(store.getTask(sentTask(store, sentBody).id)?.chatSessionId).toBe(createdBody.id);
    const messagesBody = store.listChatMessagesFromLog(createdBody.id);
    expect(messagesBody[0]).toMatchObject({
      chatSessionId: createdBody.id,
      body: "Use Go-compatible content",
      role: "user",
      taskId: sentTask(store, sentBody).id,
    });
    expect(store.getAttachment(attachment.id)?.chatMessageId).toBe(messagesBody[0].id);
    const log = await (await app.request(`/api/sessions/${createdBody.id}/log?before=10`, { headers: aliceAuthHeaders })).json();
    expect(log.entries.find((entry: { id: string }) => entry.id === messagesBody[0].id)?.metadata.attachments)
      .toMatchObject([{ id: attachment.id, filename: "brief.txt" }]);
    expect((await app.request(`/api/sessions/${createdBody.id}/messages`, { headers: aliceAuthHeaders })).status).toBe(200);
    expect((await app.request(`/api/chat/sessions/${createdBody.id}/messages/page?limit=101`, { headers: aliceAuthHeaders })).status).toBe(404);

    const pendingAlice = await app.request("/api/turns?status=pending", { headers: aliceAuthHeaders });
    expect((await pendingAlice.json()).turns.map((task: any) => task.chat_session_id)).toEqual([createdBody.id]);
    const pendingBob = await app.request("/api/turns?status=pending", { headers: bobAuthHeaders });
    expect(await pendingBob.json()).toEqual({ turns: [], next_cursor: null });

    expect(store.claimTask(runtime.id)?.id).toBe(sentTask(store, sentBody).id);
    store.startTask(sentTask(store, sentBody).id);
    store.completeTask(sentTask(store, sentBody).id, { output: "Done with chat", sessionId: "provider-chat-session" });
    const unreadDetail = await app.request(`/api/chat/sessions/${createdBody.id}`, { headers: aliceAuthHeaders });
    expect((await unreadDetail.json()).has_unread).toBe(true);
    const terminalMessagesBody = store.listChatMessagesFromLog(createdBody.id);
    expect(terminalMessagesBody[1]).toMatchObject({
      role: "assistant",
      body: "Done with chat",
      failureReason: null,
      taskId: sentTask(store, sentBody).id,
    });
    expect(terminalMessagesBody[1].elapsedMs).toBeGreaterThanOrEqual(0);
    expect((await app.request("/api/inbox/read", {
      method: "POST",
      headers: aliceAuthHeaders,
    body: JSON.stringify({ session_id: createdBody.id }) })).status).toBe(204);
    const readDetail = await app.request(`/api/chat/sessions/${createdBody.id}`, { headers: aliceAuthHeaders });
    expect((await readDetail.json()).has_unread).toBe(false);

    const bobForbiddenRequests: Array<[string, string, unknown?]> = [
      ["GET", `/api/chat/sessions/${createdBody.id}`],
      ["PATCH", `/api/chat/sessions/${createdBody.id}`, { title: "Bob rename" }],
      ["GET", `/api/sessions/${createdBody.id}/log`],
      ["POST", `/api/sessions/${createdBody.id}/messages`, { content: "Bob should not send" }],
      ["GET", `/api/sessions/${createdBody.id}/messages?unread_by=${store.getChatSession(createdBody.id)!.agentId}`],
      ["POST", "/api/inbox/read"],
      ["DELETE", `/api/chat/sessions/${createdBody.id}`],
      ["GET", `/api/multiremi/chats/${createdBody.id}`],
      ["PATCH", `/api/multiremi/chats/${createdBody.id}`, { title: "Bob Multiremi rename" }],
      ["GET", `/api/sessions/${createdBody.id}/messages`],
      ["POST", `/api/sessions/${createdBody.id}/messages`, { content: "Bob Multiremi send" }],
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

    const pendingBeforeDelete = await app.request(`/api/sessions/${createdBody.id}/messages`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify(requestMessageBody(store, { content: "Pending before delete" }, { type: "agent", ref: store.getChatSession(createdBody.id)!.agentId })),
    });
    expect(pendingBeforeDelete.status).toBe(200);
    const pendingBeforeDeleteBody = await pendingBeforeDelete.json();
    expect(store.getTask(sentTask(store, pendingBeforeDeleteBody).id)?.chatSessionId).toBe(createdBody.id);

    store.appendTaskMessages(sentTask(store, sentBody).id, [{ type: "text", content: "private transcript" }]);
    expect((await app.request(turnApiPath(store, sentTask(store, sentBody).id, "/trace"), { headers: bobAuthHeaders })).status).toBe(403);
    const aliceSession = await app.request(`/api/chat/sessions/${createdBody.id}`, { headers: aliceAuthHeaders });
    expect((await aliceSession.json()).id).toBe(createdBody.id);
    expect((await app.request(`/api/chat/sessions/${createdBody.id}`, {
      method: "DELETE",
      headers: aliceAuthHeaders,
    })).status).toBe(204);
    expect(store.getChatSession(createdBody.id)).toBeNull();
    expect(store.getTask(sentTask(store, sentBody).id)?.status).toBe("completed");
    expect(store.getTask(sentTask(store, sentBody).id)?.chatSessionId).toBe(createdBody.id);
    expect(store.getTask(sentTask(store, pendingBeforeDeleteBody).id)?.status).toBe("cancelled");
    expect(store.getTask(sentTask(store, pendingBeforeDeleteBody).id)?.chatSessionId).toBe(createdBody.id);
    expect(store.getAttachment(attachment.id)).toBeNull();
    for (const headers of [aliceAuthHeaders, bobAuthHeaders]) {
      expect((await app.request(turnApiPath(store, sentTask(store, sentBody).id, "/trace"), { headers })).status).toBe(403);
      expect((await app.request(turnApiPath(store, sentTask(store, sentBody).id, "/trace"), { headers })).status).toBe(403);
    }
    const recreated = await app.request("/api/chat/sessions", {
      method: "POST", headers: bobHeaders, body: JSON.stringify({ id: createdBody.id, agent_id: agent.id }),
    });
    expect(recreated.status).toBe(409);
    expect(store.getChatSession(createdBody.id)).toBeNull();
    expect((await app.request(turnApiPath(store, sentTask(store, sentBody).id, "/trace"), { headers: bobAuthHeaders })).status).toBe(403);
  });

  it("rechecks private agent access across chat and agent HTTP surfaces", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "admin", userId: "admin", name: "Admin", role: "admin" });
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
        provider: "codex",
        runtime_id: aliceRuntime.id,
        owner_id: "bob",
        visibility: "private",
      }),
    });
    expect(createdAgent.status).toBe(201);
    const agent = await createdAgent.json();
    expect(agent.owner_id).toBe("alice");
    // A runtime selection preserves the private execution target.
    expect(agent.runtime_id).toBe(aliceRuntime.id);
    expect(agent.provider).toBe("codex");
    expect(store.getAgent(agent.id)?.provider).toBe("codex");
    expect(store.getAgent(agent.id)?.runtimeId).toBe(aliceRuntime.id);
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
    const sent = await app.request(`/api/sessions/${chat.id}/messages`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify(requestMessageBody(store, { content: "queued before access changes" }, { type: "agent", ref: store.getChatSession(chat.id)!.agentId })),
    });
    expect(sent.status).toBe(200);

    // A new owner cannot inherit Alice's private Runtime target.
    store.updateAgent(agent.id, { ownerId: "carol", runtimeId: null });
    const aliceHiddenList = await app.request("/api/chat/sessions", { headers: aliceAuthHeaders });
    expect(await aliceHiddenList.json()).toEqual([]);
    const aliceHiddenPending = await app.request("/api/turns?status=pending", { headers: aliceAuthHeaders });
    expect(await aliceHiddenPending.json()).toEqual({ turns: [], next_cursor: null });
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

import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function setup() {
  const store = createStore();
  const agent = store.createAgent({ name: "Chat", provider: "codex", maxConcurrentTasks: 4, visibility: "workspace" });
  const runtime = store.registerRuntime({ name: "Chat runtime", provider: "codex", maxConcurrency: 4 });
  const chat = store.createChatSession({ agentId: agent.id });
  return { store, agent, runtime, chat };
}

const jsonHeaders = { "Content-Type": "application/json" };

describe("Chat queues", () => {
  it("claims same-millisecond inputs FIFO and refreshes provider affinity after the preceding turn", () => {
    const { store, agent, runtime, chat } = setup();
    const otherRuntime = store.registerRuntime({ name: "Other runtime", provider: "codex", maxConcurrency: 4 });
    const first = store.sendChatMessage(chat.id, { content: "first input" });
    const second = store.sendChatMessage(chat.id, { content: "later input" });
    const third = store.sendChatMessage(chat.id, { content: "third input" });
    db!.run("UPDATE multiremi_tasks SET created_at = ? WHERE chat_session_id = ?", [first.task.createdAt, chat.id]);
    expect(first.queued).toBe(false);
    expect(second.queued).toBe(true);
    expect(store.getPendingChatTask(chat.id)?.id).toBe(first.task.id);
    expect(store.listQueuedChatTasks(chat.id).map((entry) => entry.task_id)).toEqual([second.task.id, third.task.id]);
    const projection = JSON.stringify(store.buildTaskSessionProjection(first.task.id));
    expect(projection).not.toContain("later input");
    expect(projection).not.toContain("third input");
    expect(store.claimTask(runtime.id)?.id).toBe(first.task.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.claimTask(otherRuntime.id)).toBeNull();
    store.startTask(first.task.id);
    store.completeTask(first.task.id, { output: "first answer", sessionId: "first-provider-session", workDir: "/tmp/first-chat" });
    expect(store.claimTask(otherRuntime.id)).toBeNull();
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(second.task.id);
    expect(claimed.sessionId).toBe("first-provider-session");
    expect(claimed.workDir).toBe("/tmp/first-chat");
    expect(store.buildTaskSessionProjection(claimed.id)?.mode).toBe("delta");
    expect(JSON.stringify(store.buildTaskSessionProjection(claimed.id))).not.toContain("third input");
    store.startTask(second.task.id);
    store.completeTask(second.task.id, { output: "second answer", sessionId: "second-provider-session" });
    expect(store.claimTask(runtime.id)?.sessionId).toBe("second-provider-session");
    expect(store.getAgent(agent.id)?.maxConcurrentTasks).toBe(4);
  });

  it("keeps a resume-unsafe retry cold even without an execution fingerprint", () => {
    const { store, runtime, chat } = setup();
    const first = store.sendChatMessage(chat.id, { content: "warmup" });
    store.claimTask(runtime.id);
    store.startTask(first.task.id);
    store.completeTask(first.task.id, { output: "warm", sessionId: "previous-session", workDir: "/tmp/previous" });
    const next = store.sendChatMessage(chat.id, { content: "fails" });
    store.claimTask(runtime.id);
    store.startTask(next.task.id);
    const queued = store.sendChatMessage(chat.id, { content: "after retry" });
    db!.run("UPDATE multiremi_tasks SET execution_fingerprint = NULL WHERE id = ?", [next.task.id]);
    store.failTask(next.task.id, { error: "context overflow", failureReason: "agent_error.context_overflow", sessionId: "unsafe-session" });
    const retry = store.listTasks().find((task) => task.parentTaskId === next.task.id)!;
    expect(retry).toBeDefined();
    expect(retry.executionFingerprint).toBeNull();
    expect(retry.sessionId).toBeNull();
    expect(store.getPendingChatTask(chat.id)?.id).toBe(retry.id);
    expect(store.listQueuedChatTasks(chat.id).map((task) => task.task_id)).toEqual([queued.task.id]);
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(retry.id);
    expect(claimed.sessionId).toBeNull();
    expect(claimed.workDir).toBeNull();
    expect(store.buildTaskSessionProjection(claimed.id)?.mode).toBe("bootstrap");
  });

  it("interrupts a pending retry when prioritizing the next user input", () => {
    const { store, runtime, chat } = setup();
    const first = store.sendChatMessage(chat.id, { content: "original" });
    store.claimTask(runtime.id);
    store.startTask(first.task.id);
    const followUp = store.sendChatMessage(chat.id, { content: "urgent" });
    store.failTask(first.task.id, { error: "context overflow", failureReason: "agent_error.context_overflow" });
    const retry = store.listTasks().find((task) => task.parentTaskId === first.task.id)!;
    expect(store.getPendingChatTask(chat.id)?.id).toBe(retry.id);
    expect(store.prioritizeQueuedChatTask(chat.id, followUp.task.id)).toEqual({ task_id: followUp.task.id, active_task_id: retry.id });
    expect(store.getTask(retry.id)?.status).toBe("cancelled");
    expect(store.getTask(retry.id)?.prompt).toBe("original");
    expect(store.listChatMessages(chat.id).find((message) => message.id === first.message.id)?.body).toBe("original");
    expect(store.listQueuedChatTasks(chat.id)).toEqual([]);
    expect(store.claimTask(runtime.id)?.id).toBe(followUp.task.id);
  });

  it("edits pending input atomically, cancels removed inputs, and prioritizes on the server", () => {
    const { store, runtime, chat } = setup();
    const first = store.sendChatMessage(chat.id, { content: "first" });
    const second = store.sendChatMessage(chat.id, { content: "second" });
    const third = store.sendChatMessage(chat.id, { content: "third" });
    expect(store.claimTask(runtime.id)?.id).toBe(first.task.id);
    store.startTask(first.task.id);
    store.appendTaskMessages(first.task.id, [{ type: "text", content: "Partial output" }]);
    const edited = store.updateQueuedChatTask(chat.id, second.task.id, "  revised second  ");
    expect(edited).toMatchObject({ task_id: second.task.id, content: "revised second", attachment_ids: [] });
    expect(store.getTask(second.task.id)?.prompt).toBe("revised second");
    expect(store.listChatMessages(chat.id).find((entry) => entry.id === second.message.id)?.body).toBe("revised second");
    expect(() => store.updateQueuedChatTask(chat.id, first.task.id, "cannot change running")).toThrow("no longer queued");
    const events: string[] = [];
    store.onTaskEvent(({ type, task }) => { if (type === "task:cancelled") events.push(task.id); });
    expect(store.prioritizeQueuedChatTask(chat.id, third.task.id)).toEqual({ task_id: third.task.id, active_task_id: first.task.id });
    expect(store.getTask(first.task.id)?.status).toBe("cancelled");
    expect(store.listTaskMessages(first.task.id)[0]?.content).toBe("Partial output");
    expect(events).toEqual([first.task.id]);
    expect(store.getPendingChatTask(chat.id)?.id).toBe(third.task.id);
    expect(store.listPendingChatTasks().map((task) => task.id)).toEqual([third.task.id]);
    store.removeQueuedChatTasks(chat.id, second.task.id);
    expect(store.getTask(second.task.id)?.status).toBe("cancelled");
    expect(store.getTask(second.task.id)?.prompt).toBe("revised second");
    expect(store.listChatMessages(chat.id).some((entry) => entry.id === second.message.id)).toBe(false);
    expect(store.claimTask(runtime.id)?.id).toBe(third.task.id);
    expect(store.listQueuedChatTasks(chat.id)).toEqual([]);
  });

  it("preserves explicit runtime and session input on tasks created outside Chat messages", () => {
    const { store, agent, runtime, chat } = setup();
    const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "explicit", runtimeId: runtime.id, sessionId: "explicit-session", workDir: "/tmp/explicit" });
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(task.id);
    expect(claimed.sessionId).toBe("explicit-session");
    expect(claimed.workDir).toBe("/tmp/explicit");
  });

  it("rolls back the message and task when attachment linking fails", () => {
    const { store, chat } = setup();
    const queued: string[] = [];
    store.onTaskEnqueued((task) => queued.push(task.id));
    expect(() => store.sendChatMessage(chat.id, { content: "invalid attachment", attachment_ids: ["missing"] })).toThrow();
    expect(store.listTasks()).toEqual([]);
    expect(store.listChatMessages(chat.id)).toEqual([]);
    expect(store.getChatSession(chat.id)?.latestTaskId).toBeNull();
    expect(queued).toEqual([]);
  });

  it("persists pin, reports unread counts and preview, and archives all pending work", async () => {
    const { store, runtime, chat } = setup();
    store.updateChatSession(chat.id, { pinned: true });
    expect(new MultiremiStore(db!).getChatSession(chat.id)?.pinned).toBe(true);
    for (let index = 0; index < 2; index++) {
      const sent = store.sendChatMessage(chat.id, { content: `input ${index}` });
      store.claimTask(runtime.id);
      store.startTask(sent.task.id);
      store.completeTask(sent.task.id, { output: `answer ${index}`, sessionId: `session-${index}` });
    }
    expect(store.getChatSession(chat.id)?.unreadCount).toBe(2);
    expect(store.getChatSession(chat.id)?.lastMessage).toMatchObject({ content: "answer 1", role: "assistant" });
    store.markChatSessionRead(chat.id);
    expect(store.getChatSession(chat.id)?.unreadCount).toBe(0);
    const first = store.sendChatMessage(chat.id, { content: "running" });
    const second = store.sendChatMessage(chat.id, { content: "waiting" });
    store.claimTask(runtime.id);
    store.updateChatSession(chat.id, { status: "archived" });
    expect(store.getTask(first.task.id)?.status).toBe("cancelled");
    expect(store.getTask(second.task.id)?.status).toBe("cancelled");
    expect(store.claimTask(runtime.id)).toBeNull();
    const app = createMultiremiApp({ store });
    const rejected = await app.request(`/api/chat/sessions/${chat.id}/messages`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ content: "no" }) });
    expect(rejected.status).toBe(409);
    const archived = await app.request("/api/chat/sessions?status=archived");
    expect((await archived.json()).map((entry: any) => entry.id)).toEqual([chat.id]);
    expect(await (await app.request("/api/chat/sessions?status=active")).json()).toEqual([]);
    const restored = await app.request(`/api/chat/sessions/${chat.id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ status: "active" }) });
    expect(restored.status).toBe(200);
    expect((await restored.json()).pinned).toBe(true);
    expect(store.sendChatMessage(chat.id, { content: "restored" }).queued).toBe(false);
  });

  it("deletes the Chat and cancels all pending work before publishing cancellation", () => {
    const { store, runtime, chat } = setup();
    const first = store.sendChatMessage(chat.id, { content: "running" });
    const second = store.sendChatMessage(chat.id, { content: "waiting" });
    store.claimTask(runtime.id);
    store.startTask(first.task.id);
    const observed: Array<{ deleted: boolean; statuses: string[] }> = [];
    store.onTaskEvent(({ type }) => {
      if (type === "task:cancelled") observed.push({
        deleted: store.getChatSession(chat.id) == null,
        statuses: [first.task.id, second.task.id].map((id) => store.getTask(id)!.status),
      });
    });
    expect(store.deleteChatSession(chat.id)).toBe(true);
    expect(observed).toEqual([
      { deleted: true, statuses: ["cancelled", "cancelled"] },
      { deleted: true, statuses: ["cancelled", "cancelled"] },
    ]);
    expect(store.getTask(second.task.id)?.chatSessionId).toBe(chat.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(() => store.sendChatMessage(chat.id, { content: "late" })).toThrow("Chat session not found");
  });

  it("enforces queue ownership, stale-state conflicts, and the public response shapes", async () => {
    const { store, agent } = setup();
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "admin" });
    const alice = await store.createAccessToken({ name: "Alice", type: "pat", userId: "alice", workspaceId: "local" });
    const bob = await store.createAccessToken({ name: "Bob", type: "pat", userId: "bob", workspaceId: "local" });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: "alice" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { ...jsonHeaders, Authorization: `Bearer ${alice.token}` };
    const send = async (content: string) => {
      const response = await app.request(`/api/chat/sessions/${chat.id}/messages`, { method: "POST", headers, body: JSON.stringify({ content }) });
      expect(response.status).toBe(201);
      return response.json();
    };
    const first = await send("first");
    const second = await send("second");
    expect(first).toMatchObject({ queued: false, supports_queue: true });
    expect(second).toMatchObject({ queued: true, supports_queue: true });
    const pending = await app.request(`/api/chat/sessions/${chat.id}/pending-task`, { headers });
    expect(await pending.json()).toMatchObject({ task_id: first.task_id, supports_queue: true, queued_tasks: [{ task_id: second.task_id, content: "second", attachment_ids: [] }] });
    for (const method of ["PATCH", "DELETE", "POST"]) {
      const suffix = method === "POST" ? "/prioritize" : "";
      const denied = await app.request(`/api/chat/sessions/${chat.id}/queue/${second.task_id}${suffix}`, {
        method, headers: { ...jsonHeaders, Authorization: `Bearer ${bob.token}` }, ...(method === "PATCH" ? { body: JSON.stringify({ content: "not yours" }) } : {}),
      });
      expect(denied.status).toBe(403);
    }
    const foreign = store.createChatSession({ agentId: agent.id, creatorId: "alice" });
    const foreignTask = store.sendChatMessage(foreign.id, { content: "foreign" });
    const rejected = await app.request(`/api/chat/sessions/${chat.id}/queue/${foreignTask.task.id}`, { method: "DELETE", headers });
    expect(rejected.status).toBe(409);
    const edit = await app.request(`/api/chat/sessions/${chat.id}/queue/${second.task_id}`, { method: "PATCH", headers, body: JSON.stringify({ content: "edited" }) });
    expect(await edit.json()).toMatchObject({ task_id: second.task_id, content: "edited", attachment_ids: [] });
    const prioritized = await app.request(`/api/chat/sessions/${chat.id}/queue/${second.task_id}/prioritize`, { method: "POST", headers });
    expect(await prioritized.json()).toEqual({ task_id: second.task_id, active_task_id: null });
    const cleared = await app.request(`/api/chat/sessions/${chat.id}/queue`, { method: "DELETE", headers });
    expect(cleared.status).toBe(204);
    expect(store.getTask(first.task_id)?.status).toBe("cancelled");
    const stale = await app.request(`/api/chat/sessions/${chat.id}/queue/${first.task_id}`, { method: "DELETE", headers });
    expect(stale.status).toBe(409);
    const invalid = await app.request(`/api/chat/sessions/${chat.id}`, { method: "PATCH", headers, body: JSON.stringify({ pinned: "yes" }) });
    expect(invalid.status).toBe(400);
  });

  it("keeps same-millisecond messages, previews, and legacy page cursors in insertion order", async () => {
    const { store, runtime, chat } = setup();
    const first = store.sendChatMessage(chat.id, { content: "first" });
    store.claimTask(runtime.id);
    store.startTask(first.task.id);
    store.completeTask(first.task.id, { output: "answer", sessionId: "ordered-session" });
    const answer = store.listChatMessages(chat.id)[1]!;
    db!.run("UPDATE multiremi_chat_messages SET id = ? WHERE id = ?", ["msg_z_first", first.message.id]);
    db!.run("UPDATE multiremi_chat_messages SET id = ? WHERE id = ?", ["msg_a_answer", answer.id]);
    db!.run("UPDATE multiremi_chat_messages SET created_at = ? WHERE chat_session_id = ?", [first.message.createdAt, chat.id]);
    expect(store.listChatMessages(chat.id).map((message) => message.body)).toEqual(["first", "answer"]);
    expect(store.getChatSession(chat.id)?.lastMessage?.content).toBe("answer");
    const app = createMultiremiApp({ store });
    const newest = await (await app.request(`/api/chat/sessions/${chat.id}/messages/page?limit=1`)).json();
    expect(newest.messages[0].id).toBe("msg_a_answer");
    const query = new URLSearchParams({ limit: "1", before_id: newest.next_cursor.id, before_created_at: newest.next_cursor.created_at });
    const older = await (await app.request(`/api/chat/sessions/${chat.id}/messages/page?${query}`)).json();
    expect(older.messages.map((message: any) => message.content)).toEqual(["first"]);
    expect(older.has_more).toBe(false);
  });

  it("migrates legacy Chat order once and continues the sequence after reopening", () => {
    const { chat } = setup();
    db!.run("INSERT INTO multiremi_chat_messages (id, chat_session_id, role, body, created_at) VALUES (?, ?, 'user', 'legacy user', ?)", ["msg_z_legacy", chat.id, "2026-01-01T00:00:00.000Z"]);
    db!.run("INSERT INTO multiremi_chat_messages (id, chat_session_id, role, body, created_at) VALUES (?, ?, 'assistant', 'legacy answer', ?)", ["msg_a_legacy", chat.id, "2026-01-01T00:00:00.001Z"]);
    db!.run("DELETE FROM multiremi_schema_migrations WHERE id = '20260905_chat_message_sequence'");
    db!.run("DROP INDEX idx_multiremi_chat_messages_session_sequence");
    db!.run("ALTER TABLE multiremi_chat_messages DROP COLUMN sequence");
    db!.run("ALTER TABLE multiremi_chat_sessions DROP COLUMN message_sequence");
    const migrated = new MultiremiStore(db!);
    expect(migrated.listChatMessages(chat.id).map((message) => message.body)).toEqual(["legacy user", "legacy answer"]);
    expect(migrated.getChatSession(chat.id)?.lastMessage?.content).toBe("legacy answer");
    migrated.sendChatMessage(chat.id, { content: "new input" });
    expect(db!.query("SELECT sequence FROM multiremi_chat_messages WHERE chat_session_id = ? ORDER BY sequence").all(chat.id)).toEqual([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }]);
    const reopened = new MultiremiStore(db!);
    expect(reopened.listChatMessages(chat.id).map((message) => message.body)).toEqual(["legacy user", "legacy answer", "new input"]);
  });

  it("uses workspace headers for Chat requests and preserves explicit workspace precedence", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Design", slug: "design" });
    const agent = store.createAgent({ name: "Designer", provider: "codex", workspaceId: workspace.id });
    const app = createMultiremiApp({ store });
    const headers = { ...jsonHeaders, "X-Workspace-Slug": "design" };
    const response = await app.request("/api/chat/sessions", { method: "POST", headers, body: JSON.stringify({ agent_id: agent.id }) });
    expect(response.status).toBe(201);
    const chat = await response.json();
    expect(chat.workspace_id).toBe(workspace.id);
    const list = await app.request("/api/chat/sessions", { headers });
    expect((await list.json()).map((entry: any) => entry.id)).toEqual([chat.id]);
    const sent = store.sendChatMessage(chat.id, { content: "design" });
    const pending = await app.request("/api/chat/pending-tasks", { headers });
    expect((await pending.json()).tasks.map((entry: any) => entry.task_id)).toEqual([sent.task.id]);
    const unknown = await app.request("/api/chat/sessions", { headers: { "X-Workspace-Slug": "missing" } });
    expect(unknown.status).toBe(404);
    const conflicting = await app.request("/api/chat/sessions?workspace_id=local", { headers });
    expect(conflicting.status).toBe(200);
    expect(await conflicting.json()).toEqual([]);
    const byId = await app.request("/api/chat/sessions", { headers: { "X-Workspace-ID": workspace.id } });
    expect((await byId.json()).map((entry: any) => entry.id)).toEqual([chat.id]);
  });
});

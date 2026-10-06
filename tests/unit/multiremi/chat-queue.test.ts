import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { requestMessageBody, mutateExecutionFixture } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

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
  it("merges same-millisecond pending inputs in message order and resumes the next round", () => {
    const {store,agent,runtime,chat}=setup();
    const first=store.sendChatMessage(chat.id,{content:"first input"});
    const second=store.sendChatMessage(chat.id,{content:"later input"});
    const third=store.sendChatMessage(chat.id,{content:"third input"});
    expect(second.task.id).toBe(first.task.id); expect(third.task.id).toBe(first.task.id);
    expect(store.listChatMessages(chat.id).map(message=>message.body)).toEqual(["first input","later input","third input"]);
    expect(store.listConversationLogEntries(chat.id).filter(entry=>entry.kind==="turn")).toHaveLength(1);
    expect(store.claimTask(runtime.id)?.id).toBe(first.task.id); expect(store.claimTask(runtime.id)).toBeNull();
    store.buildTaskSessionProjection(first.task.id);store.startTask(first.task.id);
    store.completeTask(first.task.id,{output:"first answer",sessionId:"first-provider-session",workDir:"/tmp/first-chat"});
    const next=store.sendChatMessage(chat.id,{content:"next round"});
    const claimed=store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(next.task.id);expect(claimed.sessionId).toBe("first-provider-session");expect(claimed.workDir).toBe("/tmp/first-chat");
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
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET execution_fingerprint = NULL WHERE id = ?", [next.task.id]);
    store.failTask(next.task.id, { error: "context overflow", failureReason: "agent_error.context_overflow", sessionId: "unsafe-session" });
    const retry = store.getTask(store.getTurnForAttempt(next.task.id)!.current_attempt_id!)!;
    expect(retry).toBeDefined();
    expect(retry.executionFingerprint).toBeNull();
    expect(retry.sessionId).toBeNull();
    expect(store.getPendingChatTask(chat.id)?.id).toBe(retry.id);
    expect(queued.task.id).toBe(next.task.id);
    expect(store.listQueuedChatTasks(chat.id)).toEqual([]);
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(retry.id);
    expect(claimed.sessionId).toBeNull();
    expect(claimed.workDir).toBeNull();
    expect(store.buildTaskSessionProjection(claimed.id)?.mode).toBe("bootstrap");
  });

  // #3: per-input task priority/edit/delete operations retired with merged turns.
  // Canonical message ownership, edits, deletion and resend FIFO are covered
  // below on SQLite and PostgreSQL through the public message API.

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
    const rejected = await app.request(`/api/sessions/${chat.id}/messages`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(requestMessageBody(store, { content: "no" }, { type: "agent", ref: store.getChatSession(chat.id)!.agentId })) });
    expect(rejected.status).toBe(409);
    const archived = await app.request("/api/chat/sessions?status=archived");
    expect((await archived.json()).map((entry: any) => entry.id)).toEqual([chat.id]);
    expect(await (await app.request("/api/chat/sessions?status=active")).json()).toEqual([]);
    const restored = await app.request(`/api/chat/sessions/${chat.id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ status: "active" }) });
    expect(restored.status).toBe(200);
    expect((await restored.json()).pinned).toBe(true);
    expect(store.sendChatMessage(chat.id, { content: "restored" }).queued).toBe(false);
  });

  it("publishes the chat-cancel events only after the archive/delete transaction commits", () => {
    // MUL-400 S1 QA round 4: these main-existing cancel paths now own a commit
    // event queue. The observable change is that every task/activity event they
    // produce is delivered after `db.inTransaction` is false, and a rollback
    // leaves no phantom event behind.
    const { store, runtime, chat } = setup();
    const first = store.sendChatMessage(chat.id, { content: "running" });
    const second = store.sendChatMessage(chat.id, { content: "waiting" });
    store.claimTask(runtime.id);
    store.startTask(first.task.id);

    const events: Array<{ type: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      if (event.type === "activity:created" || event.type === "chat:session_updated") {
        events.push({ type: event.type, inTransaction: db!.inTransaction });
      }
    });
    try {
      store.updateChatSession(chat.id, { status: "archived" });
    } finally {
      unsubscribe();
    }
    expect(store.getTask(first.task.id)?.status).toBe("cancelled");
    expect(store.getTask(second.task.id)?.status).toBe("cancelled");
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((event) => event.inTransaction)).toHaveLength(0);

    // Delete path: same contract.
    const other = setup();
    const one = other.store.sendChatMessage(other.chat.id, { content: "running" });
    other.store.claimTask(other.runtime.id);
    other.store.startTask(one.task.id);
    const deletedEvents: Array<{ type: string; inTransaction: boolean }> = [];
    const unsubscribeDelete = other.store.onWorkspaceEvent((event) => {
      if (event.type === "activity:created" || event.type === "chat:session_deleted") {
        deletedEvents.push({ type: event.type, inTransaction: db!.inTransaction });
      }
    });
    try {
      other.store.deleteChatSession(other.chat.id);
    } finally {
      unsubscribeDelete();
    }
    expect(deletedEvents.length).toBeGreaterThan(0);
    expect(deletedEvents.filter((event) => event.inTransaction)).toHaveLength(0);
  });

  it("drops the chat-cancel queue when the archive transaction rolls back", () => {
    const { store, runtime, chat } = setup();
    const first = store.sendChatMessage(chat.id, { content: "running" });
    store.claimTask(runtime.id);
    store.startTask(first.task.id);

    const events: Array<{ type: string; action: string }> = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (event.type === "activity:created") events.push({ type: event.type, action: entry?.action ?? "" });
    });
    // Fail after the cancel inside the transaction, before it commits.
    const original = store.updateChatSession.bind(store);
    let threw = false;
    try {
      const internals = store as unknown as {
        chat: { pendingTasks: (id: string) => Array<{ id: string }> };
      };
      const originalPending = internals.chat.pendingTasks.bind(internals.chat);
      internals.chat.pendingTasks = (id: string) => {
        const tasks = originalPending(id);
        if (tasks.length > 0) throw new Error("chat archive rollback injection");
        return tasks;
      };
      try {
        store.updateChatSession(chat.id, { status: "archived" });
      } finally {
        internals.chat.pendingTasks = originalPending;
      }
    } catch (err) {
      threw = true;
      expect((err as Error).message).toBe("chat archive rollback injection");
    } finally {
      void original;
      unsubscribe();
    }
    expect(threw).toBe(true);
    expect(store.getTask(first.task.id)?.status).not.toBe("cancelled");
    expect(events).toHaveLength(0);
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
    expect(second.task.id).toBe(first.task.id);
    expect(observed).toEqual([{deleted:true,statuses:["cancelled","cancelled"]}]);
    expect(store.getTask(second.task.id)?.chatSessionId).toBe(chat.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(() => store.sendChatMessage(chat.id, { content: "late" })).toThrow("Chat session not found");
  });


  it("keeps same-millisecond messages and previews in insertion order after retiring the page route", async () => {
    const { store, runtime, chat } = setup();
    const first = store.sendChatMessage(chat.id, { content: "first" });
    store.claimTask(runtime.id);
    store.startTask(first.task.id);
    store.completeTask(first.task.id, { output: "answer", sessionId: "ordered-session" });
    const answer = store.listChatMessages(chat.id)[1]!;
    db!.run("UPDATE multiremi_conversation_log SET id = ? WHERE id = ?", ["msg_z_first", first.message.id]);
    db!.run("UPDATE multiremi_conversation_log SET id = ? WHERE id = ?", ["msg_a_answer", answer.id]);
    db!.run("UPDATE multiremi_conversation_log SET created_at = ? WHERE session_id = ?", [first.message.createdAt, chat.id]);
    expect(store.listChatMessages(chat.id).map((message) => message.body)).toEqual(["first", "answer"]);
    expect(store.getChatSession(chat.id)?.lastMessage?.content).toBe("answer");
    const app = createMultiremiApp({ store });
    expect(store.listChatMessages(chat.id).map((message) => message.id)).toEqual(["msg_z_first", "msg_a_answer"]);
    expect((await app.request(`/api/chat/sessions/${chat.id}/messages/page?limit=1`)).status).toBe(404);
  });

  it("continues canonical Chat sequence after reopening", () => {
    const {store,agent,chat}=setup();
    for(const [role,body] of [["user","legacy user"],["assistant","legacy answer"]] as const) store.sendMessage({session_id:chat.id,sender:role==="assistant"?{type:"agent",id:agent.id}:{type:"member",id:"mem_local_local"},to:{type:"none"},body_md:body,message_kind:role==="assistant"?"reply":"request",wake_requested:"inbox_only"});
    const migrated=new MultiremiStore(db!);
    expect(migrated.listChatMessages(chat.id).map(message=>message.body)).toEqual(["legacy user","legacy answer"]);
    migrated.sendChatMessage(chat.id,{content:"new input"});
    const rows=db!.query("SELECT seq FROM multiremi_conversation_log WHERE session_id=? AND kind='message' ORDER BY seq").all(chat.id) as {seq:number}[];
    expect(rows.map(row=>row.seq)).toEqual([1,2,3]);
    expect(new MultiremiStore(db!).listChatMessages(chat.id).map(message=>message.body)).toEqual(["legacy user","legacy answer","new input"]);
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
    const pending = await app.request("/api/turns?status=pending", { headers });
    expect((await pending.json()).turns.map((entry: any) => entry.id)).toEqual([store.getTurnForAttempt(sent.task.id)!.id]);
    const unknown = await app.request("/api/chat/sessions", { headers: { "X-Workspace-Slug": "missing" } });
    expect(unknown.status).toBe(404);
    const conflicting = await app.request("/api/chat/sessions?workspace_id=local", { headers });
    expect(conflicting.status).toBe(200);
    expect(await conflicting.json()).toEqual([]);
    const byId = await app.request("/api/chat/sessions", { headers: { "X-Workspace-ID": workspace.id } });
    expect((await byId.json()).map((entry: any) => entry.id)).toEqual([chat.id]);
  });
});

pendingTurnBackendTests("Chat queue unified API", fixture => {
  it("enforces message ownership, unread conflicts and delete/resend FIFO through the public API", async () => {
    const { store } = fixture();
    const agent = store.createAgent({ name: "Queue API", provider: "codex", visibility: "workspace" });
    store.ensureLocalWorkspace();
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "admin" });
    const alice = await store.createAccessToken({ name: "Alice", type: "pat", userId: "alice", workspaceId: "local" });
    const bob = await store.createAccessToken({ name: "Bob", type: "pat", userId: "bob", workspaceId: "local" });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: "alice" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { ...jsonHeaders, Authorization: `Bearer ${alice.token}` };
    const send = async (body_md: string, extra = {}) => {
      const response = await app.request(`/api/sessions/${chat.id}/messages`, { method: "POST", headers,
        body: JSON.stringify({ body_md, to: { type: "agent", ref: agent.id }, ...extra }) });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    };
    const first = await send("first"), second = await send("second");
    expect(first.message).toMatchObject({ body_md: "first", to_agent_id: agent.id, message_kind: "request" });
    expect(second.message).toMatchObject({ body_md: "second", to_agent_id: agent.id });
    const unread = await app.request(`/api/sessions/${chat.id}/messages?unread_by=${agent.id}`, { headers });
    expect((await unread.json()).messages.map((m: any) => m.id)).toEqual([first.message.id, second.message.id]);
    for (const method of ["PATCH", "DELETE"]) {
      const denied = await app.request(`/api/messages/${second.message.id}`, {
        method, headers: { ...jsonHeaders, Authorization: `Bearer ${bob.token}` },
        ...(method === "PATCH" ? { body: JSON.stringify({ body_md: "not yours" }) } : {}),
      });
      expect(denied.status).toBe(403);
    }
    const foreign = store.createChatSession({ agentId: agent.id, creatorId: "alice" });
    const foreignMessage = store.sendChatMessage(foreign.id, { content: "foreign" }).message;
    const rejected = await app.request(`/api/sessions/${chat.id}/messages`, { method: "POST", headers,
      body: JSON.stringify({ body_md: "wrong conversation", reply_to_id: foreignMessage.id }) });
    expect(rejected.status).toBe(400);
    expect(store.getMessage(foreignMessage.id)?.deleted_at).toBeNull();
    const edit = await app.request(`/api/messages/${second.message.id}`, { method: "PATCH", headers,
      body: JSON.stringify({ body_md: "edited" }) });
    expect(edit.status).toBe(200);
    expect((await edit.json()).message).toMatchObject({ id: second.message.id, body_md: "edited", attachments: [] });
    const removed = await app.request(`/api/messages/${second.message.id}`, { method: "DELETE", headers });
    expect(removed.status).toBe(200);
    const resent = await send("edited");
    expect(resent.message.id).not.toBe(second.message.id);
    expect(resent.message.seq).toBeGreaterThan(second.message.seq);
    const remaining = await app.request(`/api/sessions/${chat.id}/messages?unread_by=${agent.id}`, { headers });
    expect((await remaining.json()).messages.map((m: any) => m.id)).toEqual([first.message.id, resent.message.id]);
    store.recordSessionAgentInlineRead(chat.id, agent.id, [first.message.seq], first.message.seq);
    const stale = await app.request(`/api/messages/${first.message.id}`, { method: "DELETE", headers });
    expect(stale.status).toBe(409);
    expect(store.getMessage(first.message.id)?.deleted_at).toBeNull();
    const invalid = await app.request(`/api/chat/sessions/${chat.id}`, { method: "PATCH", headers, body: JSON.stringify({ pinned: "yes" }) });
    expect(invalid.status).toBe(400);
  });

});

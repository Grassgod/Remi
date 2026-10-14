import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { autopilotSessionId } from "@multiremi/contracts/unified-model.js";
import { taskOfferResponse } from "../../fixtures/task-offer.js";
import { createResponsibleTestAutopilot, createLocalStore as createStore, resetMultiremiTestEnv } from "./helpers.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

let previousEncryptionKey: string | undefined;
beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});
afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

pendingTurnBackendTests("automation run Chats", fixture => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const jsonHeaders = { "Content-Type": "application/json" };
  const OWNER_MEMBER = "mem_local_local";

  const setup = (executionMode: "run_only" | "create_issue" = "run_only", sessionPolicy?: "reuse_latest") => {
    const { store } = fixture();
    const agent = store.createAgent({ name: "Automation agent", provider: "codex", maxConcurrentTasks: 4, visibility: "workspace" });
    const runtime = store.registerRuntime({ name: "Automation runtime", provider: "codex", maxConcurrency: 4 });
    const autopilot = createResponsibleTestAutopilot(store, {
      title: "Nightly digest", description: "Summarise the night", assigneeId: agent.id, executionMode,
      ...(sessionPolicy ? { sessionPolicy } : {}),
    });
    return { store, agent, runtime, autopilot };
  };

  /** Claim, start and finish the run's current attempt. */
  function finish(store: MultiremiStore, runtimeId: string, taskId: string, outcome: "completed" | "failed" = "completed") {
    expect(store.claimTask(runtimeId)?.id).toBe(taskId);
    store.buildTaskSessionProjection(taskId);
    store.startTask(taskId);
    if (outcome === "completed") store.completeTask(taskId, { output: "All good", sessionId: `provider-${taskId}` });
    else store.failTask(taskId, { error: "boom", failureReason: "agent_error.unknown" });
  }

  const ageChat = (chatId: string, daysAgo: number) => {
    const at = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
    fixture().db.run("UPDATE multiremi_chat_sessions SET created_at = ?, updated_at = ? WHERE id = ?", [at, at, chatId]);
    fixture().db.run("UPDATE multiremi_conversation_log SET created_at = ? WHERE session_id = ?", [at, chatId]);
  };

  describe("run_only automation runs open a Chat", () => {
    it("creates a Chat with origin, title, agent and creator, and keeps the request and attempt in it", () => {
      const { store, agent, autopilot } = setup();
      const run = store.runAutopilot(autopilot.id);

      expect(run.chatSessionId).toBeString();
      const chat = store.getChatSession(run.chatSessionId!)!;
      expect(chat.origin).toEqual({ autopilot_id: autopilot.id, run_id: run.id });
      expect(chat.agentId).toBe(agent.id);
      expect(chat.title).toMatch(/^Nightly digest · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      const owner = store.getWorkspaceMember(OWNER_MEMBER)!;
      expect(chat.creatorId).toBe(owner.userId ?? owner.id);

      const task = store.getTask(run.taskId!)!;
      expect(task.chatSessionId).toBe(chat.id);
      expect(task.issueId).toBeNull();
      expect(store.getTurnForAttempt(task.id)!.session_id).toBe(chat.id);

      const request = store.listConversationLogEntries(chat.id).find(entry => entry.kind === "message")!;
      expect(request).toMatchObject({ body_md: "Summarise the night", author_type: "timer", author_id: autopilot.id });
      const trigger = store.listConversationLogEntries(autopilotSessionId(autopilot.id)).find(entry => entry.kind === "message")!;
      expect(trigger.metadata).toMatchObject({ turn_id: task.id, session_id: chat.id });
      expect(trigger.metadata.run_result ?? null).toBeNull();
      expect(store.listConversationLogEntries(autopilotSessionId(autopilot.id)).some(entry => entry.kind === "turn")).toBe(false);
    });

    it("gives the Chat to the creating member, else the workspace owner", () => {
      const { store, agent, autopilot } = setup();
      const teammate = store.createWorkspaceMember({ id: "mem_teammate", name: "Teammate", workspaceId: "local", role: "member", userId: "usr_teammate" });
      const creatorOf = () => store.getChatSession(store.runAutopilot(autopilot.id).chatSessionId!)!.creatorId;

      fixture().db.run("UPDATE multiremi_autopilots SET created_by_type = 'member', created_by_id = ? WHERE id = ?", [teammate.id, autopilot.id]);
      expect(creatorOf()).toBe("usr_teammate");

      // The deprecated responsible member column is never read.
      fixture().db.run("UPDATE multiremi_autopilots SET responsible_member_id = ?, created_by_type = 'agent', created_by_id = ? WHERE id = ?", [teammate.id, agent.id, autopilot.id]);
      expect(creatorOf()).toBe("local");
    });

    it("leaves create_issue runs without a Chat", () => {
      const { store, autopilot } = setup("create_issue");
      const run = store.runAutopilot(autopilot.id);
      expect(run.issueId).toBeString();
      expect(run.chatSessionId).toBeNull();
      expect(store.listChatSessions("local", { origin: "all" })).toHaveLength(0);
    });

    it("opens a new Chat for every run without reuse_latest", () => {
      const { store, autopilot } = setup();
      const first = store.runAutopilot(autopilot.id);
      const second = store.runAutopilot(autopilot.id);
      expect(second.chatSessionId).not.toBe(first.chatSessionId);
    });

    it("hands the claiming agent the run and its Chat", async () => {
      const { store, runtime, autopilot } = setup();
      const run = store.runAutopilot(autopilot.id);
      const body = await (await taskOfferResponse(store, runtime.id)).json() as { task: Record<string, string> };
      expect(body.task.autopilot_run_id).toBe(run.id);
      expect(body.task.chat_session_id).toBe(run.chatSessionId!);
    });
  });

  describe("session_policy reuse_latest", () => {
    it("continues the latest run's Chat and reopens it when it was archived", () => {
      const { store, runtime, autopilot } = setup("run_only", "reuse_latest");
      const first = store.runAutopilot(autopilot.id);
      finish(store, runtime.id, first.taskId!);
      store.updateChatSession(first.chatSessionId!, { status: "archived" });

      const second = store.runAutopilot(autopilot.id);
      expect(second.chatSessionId).toBe(first.chatSessionId);
      const chat = store.getChatSession(first.chatSessionId!)!;
      expect(chat.status).toBe("active");
      expect(chat.origin).toEqual({ autopilot_id: autopilot.id, run_id: first.id });
      expect(store.getTask(second.taskId!)!.chatSessionId).toBe(chat.id);
      expect(store.listChatMessages(chat.id).filter(message => message.role === "system").map(message => message.body))
        .toEqual(["Summarise the night", "Summarise the night"]);
      expect(store.listChatSessions("local", { origin: "automation" })).toHaveLength(1);
    });

    it("opens a new Chat when the latest one is gone or belongs to another agent", () => {
      const { store, autopilot } = setup("run_only", "reuse_latest");
      const first = store.runAutopilot(autopilot.id);
      expect(store.deleteChatSession(first.chatSessionId!)).toBe(true);
      expect(store.getAutopilotRun(first.id)!.chatSessionId).toBeNull();
      const second = store.runAutopilot(autopilot.id);
      expect(second.chatSessionId).not.toBe(first.chatSessionId);
      expect(store.getChatSession(second.chatSessionId!)).not.toBeNull();

      const other = store.createAgent({ name: "Other", provider: "codex", visibility: "workspace" });
      fixture().db.run("UPDATE multiremi_chat_sessions SET agent_id = ? WHERE id = ?", [other.id, second.chatSessionId]);
      const third = store.runAutopilot(autopilot.id);
      expect(third.chatSessionId).not.toBe(second.chatSessionId);
    });

    it("does not fall back to an older run's Chat when the latest run's Chat was deleted", () => {
      const { store, agent, autopilot } = setup("run_only", "reuse_latest");
      const first = store.runAutopilot(autopilot.id);
      const other = store.createAgent({ name: "Other", provider: "codex", visibility: "workspace" });
      fixture().db.run("UPDATE multiremi_chat_sessions SET agent_id = ? WHERE id = ?", [other.id, first.chatSessionId]);
      const second = store.runAutopilot(autopilot.id);
      expect(second.chatSessionId).not.toBe(first.chatSessionId);
      fixture().db.run("UPDATE multiremi_chat_sessions SET agent_id = ? WHERE id = ?", [agent.id, first.chatSessionId]);
      expect(store.deleteChatSession(second.chatSessionId!)).toBe(true);

      const third = store.runAutopilot(autopilot.id);
      expect(third.chatSessionId).not.toBe(first.chatSessionId);
      expect(third.chatSessionId).not.toBe(second.chatSessionId);
      expect(store.getChatSession(third.chatSessionId!)).not.toBeNull();
    });
  });

  describe("quiet runs", () => {
    async function markQuiet(store: MultiremiStore, turnId: string, token?: string) {
      const app = createMultiremiApp({ store, authToken: "master" });
      return app.request(`/api/turns/${turnId}/automation/quiet`, {
        method: "POST", headers: { ...jsonHeaders, Authorization: `Bearer ${token ?? "master"}` },
      });
    }

    it("archives the Chat when a quiet run completes", async () => {
      const { store, runtime, autopilot } = setup();
      const run = store.runAutopilot(autopilot.id);
      const task = store.getTask(run.taskId!)!;
      const token = (await store.createTaskAccessToken(task, "local")).token;
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);

      const response = await markQuiet(store, store.getTurnForAttempt(task.id)!.id, token);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(store.getAutopilotRun(run.id)!.quiet).toBe(true);
      expect(store.getChatSession(run.chatSessionId!)!.status).toBe("active");

      store.completeTask(task.id, { output: "Nothing to report" });
      expect(store.getAutopilotRun(run.id)!.status).toBe("completed");
      expect(store.getChatSession(run.chatSessionId!)!.status).toBe("archived");
      expect(store.listChatSessions("local", { origin: "all" })).toHaveLength(0);
      expect(store.listChatSessions("local", { origin: "all", includeArchived: true })).toHaveLength(1);
    });

    it("sends no run notification and leaves the archived Chat's reply read", async () => {
      const { store, runtime, autopilot } = setup();
      const quiet = store.runAutopilot(autopilot.id);
      await markQuiet(store, store.getTurnForAttempt(quiet.taskId!)!.id);
      finish(store, runtime.id, quiet.taskId!);
      expect(store.listInboxItems(OWNER_MEMBER).filter(item => !item.read)).toEqual([]);
      expect(store.listInboxItems(OWNER_MEMBER).map(item => item.type)).not.toContain("autopilot_run_completed");

      const loud = store.runAutopilot(autopilot.id);
      finish(store, runtime.id, loud.taskId!);
      const unread = store.listInboxItems(OWNER_MEMBER).filter(item => !item.read);
      expect(unread.map(item => item.type).sort()).toEqual(["autopilot_run_completed", "reply"]);
      expect(unread.find(item => item.type === "autopilot_run_completed")?.details).toMatchObject({ chat_session_id: loud.chatSessionId });
    });

    it("keeps a completed run's Chat active and unread when it was not marked quiet", () => {
      const { store, runtime, autopilot } = setup();
      const run = store.runAutopilot(autopilot.id);
      finish(store, runtime.id, run.taskId!);
      const chat = store.getChatSession(run.chatSessionId!)!;
      expect(chat.status).toBe("active");
      expect(chat.hasUnread).toBe(true);
      expect(chat.unreadCount).toBe(1);
    });

    it("never archives a failed run, even if it was marked quiet", async () => {
      const { store, runtime, autopilot } = setup();
      const run = store.runAutopilot(autopilot.id);
      const turnId = store.getTurnForAttempt(run.taskId!)!.id;
      expect((await markQuiet(store, turnId)).status).toBe(200);
      finish(store, runtime.id, run.taskId!, "failed");
      expect(store.getAutopilotRun(run.id)).toMatchObject({ quiet: true, status: "failed" });
      expect(store.getChatSession(run.chatSessionId!)!.status).toBe("active");
    });

    it("leaves a pinned Chat alone and archives one marked quiet after the fact", async () => {
      const { store, runtime, autopilot } = setup();
      const pinned = store.runAutopilot(autopilot.id);
      store.updateChatSession(pinned.chatSessionId!, { pinned: true });
      await markQuiet(store, store.getTurnForAttempt(pinned.taskId!)!.id);
      finish(store, runtime.id, pinned.taskId!);
      expect(store.getChatSession(pinned.chatSessionId!)!.status).toBe("active");

      const late = store.runAutopilot(autopilot.id);
      finish(store, runtime.id, late.taskId!);
      expect(store.getChatSession(late.chatSessionId!)!.status).toBe("active");
      expect((await markQuiet(store, store.getTurnForAttempt(late.taskId!)!.id)).status).toBe(200);
      expect(store.getChatSession(late.chatSessionId!)!.status).toBe("archived");
    });

    it("refuses turns that are not automation runs and tokens of other turns", async () => {
      const { store, agent, autopilot } = setup();
      const plain = store.createChatSession({ agentId: agent.id });
      const sent = store.sendChatMessage(plain.id, { content: "hello" });
      expect((await markQuiet(store, store.getTurnForAttempt(sent.task.id)!.id)).status).toBe(404);
      expect((await markQuiet(store, "turn_missing")).status).toBe(404);

      const run = store.runAutopilot(autopilot.id);
      const otherToken = (await store.createTaskAccessToken(store.getTask(sent.task.id)!, "local")).token;
      const response = await markQuiet(store, store.getTurnForAttempt(run.taskId!)!.id, otherToken);
      expect([403, 404]).toContain(response.status);
      expect(store.getAutopilotRun(run.id)!.quiet).toBe(false);
    });
  });

  describe("Chat lifecycle", () => {
    function workspaceWithIdleDays(store: MultiremiStore, days: number | null) {
      const workspace = store.getWorkspace("local")!;
      const { storage: _storage, ...settings } = workspace.settings;
      store.updateWorkspace("local", { settings: days === null ? settings : { ...settings, storage: { chat_idle_days: days } } });
    }

    it("archives idle Chats after chat_idle_days, sparing pinned, busy and recent ones", () => {
      const { store, agent } = setup();
      const chat = (content: string) => {
        const created = store.createChatSession({ agentId: agent.id });
        const sent = store.sendChatMessage(created.id, { content });
        return { id: created.id, taskId: sent.task.id };
      };
      const idle = chat("idle");
      const pinned = chat("pinned");
      const busy = chat("busy");
      const recent = chat("recent");
      for (const entry of [idle, pinned, busy]) store.cancelTask(entry.taskId);
      fixture().db.run("UPDATE multiremi_turn_attempts SET status = 'cancelled' WHERE id IN (?, ?)", [idle.taskId, pinned.taskId]);
      store.updateChatSession(pinned.id, { pinned: true });
      for (const entry of [idle, pinned, busy]) ageChat(entry.id, 20);
      ageChat(recent.id, 3);
      // `busy` keeps a queued task, which a sweep must not cancel.
      store.sendChatMessage(busy.id, { content: "still working" });
      ageChat(busy.id, 20);

      expect(store.archiveIdleChats(Date.now())).toEqual([idle.id]);
      expect(store.getChatSession(idle.id)!.status).toBe("archived");
      for (const entry of [pinned, busy, recent]) expect(store.getChatSession(entry.id)!.status).toBe("active");
      expect(store.archiveIdleChats(Date.now())).toEqual([]);
    });

    it("honours a workspace's chat_idle_days, and 0 turns the sweep off", () => {
      const { store, agent } = setup();
      const created = store.createChatSession({ agentId: agent.id });
      ageChat(created.id, 30);

      workspaceWithIdleDays(store, 0);
      expect(store.archiveIdleChats(Date.now())).toEqual([]);
      workspaceWithIdleDays(store, 45);
      expect(store.archiveIdleChats(Date.now())).toEqual([]);
      workspaceWithIdleDays(store, 7);
      expect(store.archiveIdleChats(Date.now())).toEqual([created.id]);
    });

    it("does not archive a Chat that was just reopened by hand", () => {
      const { store, agent } = setup();
      const created = store.createChatSession({ agentId: agent.id });
      ageChat(created.id, 30);
      store.updateChatSession(created.id, { status: "archived" });
      store.updateChatSession(created.id, { status: "active" });
      expect(store.archiveIdleChats(Date.now())).toEqual([]);
    });

    it("reopens an archived Chat on a member message", async () => {
      const { store, agent } = setup();
      const created = store.createChatSession({ agentId: agent.id });
      store.updateChatSession(created.id, { status: "archived" });
      const events: Array<{ type: string; inTransaction: boolean }> = [];
      store.onWorkspaceEvent(event => { if (event.type === "chat:session_updated") events.push({ type: event.type, inTransaction: Boolean(fixture().db.inTransaction) }); });
      const sent = store.sendChatMessage(created.id, { content: "are you there?" });
      expect(sent.session.status).toBe("active");
      expect(store.getChatSession(created.id)!.status).toBe("active");
      expect(events.at(-1)).toEqual({ type: "chat:session_updated", inTransaction: false });

      store.updateChatSession(created.id, { status: "archived" });
      const app = createMultiremiApp({ store });
      const response = await app.request(`/api/sessions/${created.id}/messages`, {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ body_md: "hello again", to: { type: "agent", ref: agent.id }, message_kind: "request", wake_requested: "now" }),
      });
      expect(response.status).toBe(200);
      expect(store.getChatSession(created.id)!.status).toBe("active");
    });

    it("does not reopen an archived Chat for an agent message", async () => {
      const { store, agent } = setup();
      const created = store.createChatSession({ agentId: agent.id });
      store.updateChatSession(created.id, { status: "archived" });
      const app = createMultiremiApp({ store });
      const response = await app.request(`/api/sessions/${created.id}/messages`, {
        method: "POST", headers: { ...jsonHeaders, "X-Agent-ID": agent.id },
        body: JSON.stringify({ body_md: "late note", to: { type: "none" }, message_kind: "reply", wake_requested: "inbox_only" }),
      });
      expect(response.status).toBe(409);
      expect(store.getChatSession(created.id)!.status).toBe("archived");
    });
  });

  describe("Chat list origin filter", () => {
    it("hides automation Chats by default and shows them with origin=automation or all", async () => {
      const { store, agent, autopilot } = setup();
      const own = store.createChatSession({ agentId: agent.id });
      const automated = store.runAutopilot(autopilot.id).chatSessionId!;
      const app = createMultiremiApp({ store });
      const ids = async (path: string) => ((await (await app.request(path)).json()) as Array<{ id: string }>).map(entry => entry.id);

      expect(await ids("/api/chat/sessions")).toEqual([own.id]);
      expect(await ids("/api/chat/sessions?origin=user")).toEqual([own.id]);
      expect(await ids("/api/chat/sessions?origin=automation")).toEqual([automated]);
      expect((await ids("/api/chat/sessions?origin=all")).sort()).toEqual([own.id, automated].sort());

      const [wire] = (await (await app.request("/api/chat/sessions?origin=automation")).json()) as Array<{ origin: unknown }>;
      expect(wire?.origin).toMatchObject({ autopilot_id: autopilot.id });
      expect(((await (await app.request("/api/chat/sessions")).json()) as Array<{ origin: unknown }>)[0]?.origin).toBeNull();
      expect((await app.request("/api/chat/sessions?origin=bogus")).status).toBe(400);
      expect(((await (await app.request("/api/multiremi/chats")).json()) as { sessions: unknown[] }).sessions).toHaveLength(1);
    });

    it("exposes the run's chat_session_id on the run wire", async () => {
      const { store, autopilot } = setup();
      const run = store.runAutopilot(autopilot.id);
      const app = createMultiremiApp({ store });
      const { runs } = await (await app.request(`/api/autopilots/${autopilot.id}/runs`)).json() as { runs: Array<{ id: string; chat_session_id: string | null }> };
      expect(runs.find(entry => entry.id === run.id)?.chat_session_id).toBe(run.chatSessionId!);
      const single = await (await app.request(`/api/autopilots/${autopilot.id}/runs/${run.id}`)).json() as { chat_session_id: string | null };
      expect(single.chat_session_id).toBe(run.chatSessionId!);
    });
  });
});

describe("Feishu messages into an archived Chat", () => {
  function feishuStore() {
    const store = createStore();
    const owner = store.getCurrentUser();
    store.getOrCreateUser({ externalId: "ou_reopen_owner", feishuUnionId: "on_reopen_owner", email: owner.email, name: "Workspace Owner" });
    const agent = store.createAgent({ name: "Remi", provider: "codex", workspaceId: "local", maxConcurrentTasks: 4 });
    store.registerRuntime({ id: "rt_bot", name: "Bot host", provider: "codex", workspaceId: "local", daemonId: "bot-host", maxConcurrency: 4 });
    store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true });
    const config = store.upsertFeishuBotConfig("local", {
      agentId: agent.id, runtimeId: "rt_bot", appId: "cli_reopen", senderAccessPolicy: "agent",
      appSecretOp: "set", appSecret: "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA", domain: "feishu", enabled: true,
    });
    const submit = (messageId: string) => store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision, externalSessionKey: "oc_reopen:thread:fixed", externalMessageId: messageId,
      chatType: "group", chatId: "oc_reopen", threadId: "omt_fixed", senderOpenId: "ou_reopen_owner",
      senderName: "ou_reopen_owner", text: `message ${messageId}`, deliveryMode: "native_cot_v1",
    });
    return { store, submit };
  }

  it("reopens the Chat when a new message arrives", () => {
    const { store, submit } = feishuStore();
    const first = submit("om_1");
    store.updateChatSession(first.chatSessionId, { status: "archived" });

    const second = submit("om_2");
    expect(second.chatSessionId).toBe(first.chatSessionId);
    expect(store.getChatSession(first.chatSessionId)!.status).toBe("active");
  });
});

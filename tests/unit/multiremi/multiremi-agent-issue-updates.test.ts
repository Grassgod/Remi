import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import { MultiremiStore } from "@multiremi/store.js";
import { resetMultiremiTestEnv } from "./helpers.js";

let db: Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
  resetMultiremiTestEnv();
});

function createStore(options: {
  debounceMs?: number;
  rateLimitWindowMs?: number;
  maxDeliveries?: number;
} = {}): MultiremiStore {
  db = new Database(":memory:");
  const store = new MultiremiStore(db, {
    agentIssueUpdateDebounceMs: options.debounceMs,
    agentIssueUpdateRateLimitWindowMs: options.rateLimitWindowMs,
    agentIssueUpdateMaxDeliveries: options.maxDeliveries,
  });
  store.ensureLocalWorkspace();
  return store;
}

function scaffold(store: MultiremiStore) {
  const agent = store.createAgent({
    name: "Issue update agent",
    provider: "codex",
    workspaceId: "local",
  });
  const issue = store.createIssue({ title: "Bound progress", workspaceId: "local" });
  const chat = store.createChatSession({
    agentId: agent.id,
    issueId: issue.id,
    workspaceId: "local",
    creatorId: "local",
    title: "Bound progress chat",
  });
  return { agent, issue, chat };
}

describe("agent-facing Issue update delivery", () => {
  it("keeps every bound Chat opted out until explicitly enabled", () => {
    const store = createStore();
    const { issue, chat } = scaffold(store);

    expect(store.getAgentIssueUpdateSubscription(chat.id)).toMatchObject({
      chatSessionId: chat.id,
      issueId: issue.id,
      channelId: null,
      enabled: false,
      debounceWindowSeconds: 30,
      rateLimitWindowSeconds: 3_600,
      maxDeliveriesPerWindow: 12,
    });

    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "local",
      body: "This must not wake the agent.",
    });

    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 60_000))).toEqual({
      delivered: 0,
      dropped: 0,
    });
    expect(store.listChatMessages(chat.id)).toHaveLength(0);
    expect(store.listTasksForIssue(issue.id)).toHaveLength(0);
  });

  it("filters repeated updates produced by the target agent", () => {
    const store = createStore({ debounceMs: 10 });
    const { agent, issue, chat } = scaffold(store);
    store.setAgentIssueUpdateSubscription({ chatSessionId: chat.id, enabled: true });

    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: agent.id,
      body: "First agent result",
    });
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: agent.id,
      body: "Second agent result",
    });
    const sourceTask = store.createTask({ agentId: agent.id, prompt: "Produce a system-authored result" });
    store.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: "system",
      type: "comment_created",
      body: "System wrapper around the target agent's result",
      data: { taskId: sourceTask.id },
    });

    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 1_000))).toEqual({
      delivered: 0,
      dropped: 0,
    });
    expect(store.listChatMessages(chat.id)).toHaveLength(0);
    expect(store.listTasksForIssue(issue.id)).toHaveLength(0);
  });

  it("exposes an explicit human-only subscription toggle", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "API agent", provider: "codex", workspaceId: "local" });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: "local" });
    const owner = store.getCurrentUser();
    const token = await store.createAccessToken({
      name: "Issue update API test",
      type: "pat",
      workspaceId: "local",
      userId: owner.id,
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const authHeaders = { Authorization: `Bearer ${token.token}` };
    const jsonHeaders = { ...authHeaders, "Content-Type": "application/json" };

    const initial = await app.request(`/api/chat/sessions/${chat.id}/issue-updates`, { headers: authHeaders });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ subscription: { enabled: false, issue_id: null } });

    const unboundEnable = await app.request(`/api/chat/sessions/${chat.id}/issue-updates`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    expect(unboundEnable.status).toBe(400);

    const issue = store.createIssue({ title: "API binding", workspaceId: "local" });
    store.updateChatSession(chat.id, { issueId: issue.id });
    const enabled = await app.request(`/api/chat/sessions/${chat.id}/issue-updates`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      subscription: {
        enabled: true,
        issue_id: issue.id,
        debounce_window_seconds: 30,
        rate_limit_window_seconds: 3_600,
        max_deliveries_per_window: 12,
      },
    });
    expect(store.getAgentChatNotificationChannel(chat.id)).toMatchObject({
      kind: "agent_chat",
      enabled: true,
      target: { chatId: chat.id },
    });
  });

  it("debounces dense Issue activity into one Chat task", () => {
    const store = createStore({ debounceMs: 1_000 });
    const { issue, chat } = scaffold(store);
    store.setAgentIssueUpdateSubscription({ chatSessionId: chat.id, enabled: true });

    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "member_alice",
      body: "First progress detail",
    });
    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "member_bob",
      body: "Latest progress detail",
    });

    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 100))).toEqual({
      delivered: 0,
      dropped: 0,
    });
    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 2_000))).toEqual({
      delivered: 1,
      dropped: 0,
    });
    const messages = store.listChatMessages(chat.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.body).toContain("Updates aggregated: 2");
    expect(messages[0]?.body).toContain("Latest progress detail");
    expect(store.listTasksForIssue(issue.id)).toHaveLength(1);
  });

  it("drops an aggregate after the per-Issue delivery limit is reached", () => {
    const store = createStore({ debounceMs: 10, rateLimitWindowMs: 60_000, maxDeliveries: 1 });
    const { issue, chat } = scaffold(store);
    store.setAgentIssueUpdateSubscription({ chatSessionId: chat.id, enabled: true });

    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "member_alice",
      body: "First allowed update",
    });
    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 1_000))).toEqual({
      delivered: 1,
      dropped: 0,
    });

    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "member_bob",
      body: "Rate limited update",
    });
    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 2_000))).toEqual({
      delivered: 0,
      dropped: 1,
    });
    expect(store.listChatMessages(chat.id)).toHaveLength(1);
    expect(store.listTasksForIssue(issue.id)).toHaveLength(1);
  });

  it("places a human Issue comment into the bound Chat's next delta prompt", () => {
    const store = createStore({ debounceMs: 10 });
    const runtime = store.registerRuntime({
      id: "rt_issue_updates",
      name: "Issue update runtime",
      provider: "codex",
      workspaceId: "local",
    });
    const { issue, chat } = scaffold(store);

    const warmup = store.sendChatMessage(chat.id, { body: "Establish the Chat session" });
    expect(store.claimTask(runtime.id)?.id).toBe(warmup.task.id);
    store.startTask(warmup.task.id);
    store.completeTask(warmup.task.id, {
      output: "Chat session established",
      sessionId: "sess_issue_updates",
      workDir: "/tmp/multiremi-agent-issue-updates",
    });
    store.setAgentIssueUpdateSubscription({ chatSessionId: chat.id, enabled: true });

    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "member_reviewer",
      body: "The reviewer approved the API contract.",
    });
    const issueSessionCountBeforeDelivery = store.listIssueSessions(issue.id).length;
    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 1_000))).toEqual({
      delivered: 1,
      dropped: 0,
    });

    const notificationTask = store.claimTask(runtime.id)!;
    expect(notificationTask).toMatchObject({
      chatSessionId: chat.id,
      issueId: issue.id,
      issueSessionId: null,
      sessionId: "sess_issue_updates",
      workDir: "/tmp/multiremi-agent-issue-updates",
    });
    const wire = daemonTaskClaimResponse(store, notificationTask);
    expect((wire.session_projection as { mode?: string } | undefined)?.mode).toBe("delta");
    const prompt = buildTaskPrompt({
      ...notificationTask,
      sessionProjection: wire.session_projection,
      chatMessage: wire.chat_message,
    } as any);
    expect(prompt).toContain(`## Issue\nKey: ${issue.key}`);
    expect(prompt).toContain("The reviewer approved the API contract.");
    expect(prompt).not.toContain("## Agent Instructions");
    expect(store.listIssueSessions(issue.id)).toHaveLength(issueSessionCountBeforeDelivery);
  });
});

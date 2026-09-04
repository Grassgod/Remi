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

function createStore(options: { debounceMs?: number } = {}): MultiremiStore {
  db = new Database(":memory:");
  const store = new MultiremiStore(db, {
    agentIssueUpdateDebounceMs: options.debounceMs,
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
  it("enables Issue updates when a Chat is bound without creating a task", () => {
    const store = createStore();
    const { issue, chat } = scaffold(store);

    expect(store.getAgentIssueUpdateSubscription(chat.id)).toMatchObject({
      chatSessionId: chat.id,
      issueId: issue.id,
      channelId: `nch_agent_chat_${chat.id}`,
      enabled: true,
      debounceWindowSeconds: 30,
    });

    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "local",
      body: "This should be recorded without waking the agent.",
    });

    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 60_000))).toEqual({
      delivered: 1,
      dropped: 0,
    });
    expect(store.listChatMessages(chat.id)).toEqual([
      expect.objectContaining({ role: "system", taskId: null }),
    ]);
    expect(store.listTasksForIssue(issue.id)).toHaveLength(0);

    const runtime = store.registerRuntime({ name: "Cold Chat runtime", provider: "codex" });
    const userTurn = store.sendChatMessage(chat.id, { body: "Open the bound Issue." });
    expect(store.claimTask(runtime.id)?.id).toBe(userTurn.task.id);
    const claimed = store.getTaskWithAgent(userTurn.task.id)!;
    const wire = daemonTaskClaimResponse(store, claimed);
    expect((wire.session_projection as { mode?: string } | undefined)?.mode).toBe("bootstrap");
    const prompt = buildTaskPrompt({
      ...claimed,
      sessionProjection: wire.session_projection,
      chatMessage: wire.chat_message,
      boundIssueUpdates: wire.bound_issue_updates,
      boundIssueUpdatesOmittedCount: wire.bound_issue_updates_omitted_count,
    } as any);
    expect(prompt).toContain("## Bound Issue Updates");
    expect(prompt).toContain("This should be recorded without waking the agent.");
  });

  it("delivers same-agent Issue-lane updates while filtering the target Chat lane", () => {
    const store = createStore({ debounceMs: 10 });
    const { agent, issue, chat } = scaffold(store);
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const issueTask = store.createSessionTask(session.id, {
      agentId: agent.id,
      prompt: "Summarize the Issue lane",
    });
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: agent.id,
      taskId: issueTask.id,
      body: "Issue-lane summary from the same agent",
    });
    const chatTask = store.sendChatMessage(chat.id, { body: "Update the Issue" }).task;
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: agent.id,
      taskId: chatTask.id,
      body: "Chat-lane comment that must not feed back",
    });

    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 1_000))).toEqual({
      delivered: 1,
      dropped: 0,
    });
    const delivered = store.listChatMessages(chat.id).filter((message) => message.role === "system");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.body).toContain("Issue-lane summary from the same agent");
    expect(delivered[0]?.body).not.toContain("Chat-lane comment that must not feed back");
  });

  it("delivers published Session results with task lineage and the existing body cap", async () => {
    const store = createStore({ debounceMs: 10 });
    const { agent, issue, chat } = scaffold(store);
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const issueTask = store.createSessionTask(session.id, {
      agentId: agent.id,
      prompt: "Publish the implementation result",
    });
    const credential = await store.createTaskAccessToken(issueTask, "local");
    const app = createMultiremiApp({ store });
    const oversizedBody = `${"result-detail ".repeat(700)}SHOULD_BE_TRUNCATED`;

    const response = await app.request(`/api/issues/${issue.id}/sessions/${session.id}/results`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Implementation complete", body: oversizedBody }),
    });
    expect(response.status).toBe(201);
    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 1_000))).toEqual({
      delivered: 1,
      dropped: 0,
    });
    const pending = store.listChatMessages(chat.id).filter((message) => message.role === "system");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.body).toContain("Published result: Implementation complete");
    expect(pending[0]?.body).not.toContain("SHOULD_BE_TRUNCATED");

    const userTurn = store.sendChatMessage(chat.id, { body: "What did the team finish?" });
    const wire = daemonTaskClaimResponse(store, store.getTaskWithAgent(userTurn.task.id)!);
    expect(wire.bound_issue_updates).toEqual([
      expect.stringContaining("Published result: Implementation complete"),
    ]);
    const prompt = buildTaskPrompt({
      ...store.getTaskWithAgent(userTurn.task.id)!,
      sessionProjection: wire.session_projection,
      chatMessage: wire.chat_message,
      boundIssueUpdates: wire.bound_issue_updates,
      boundIssueUpdatesOmittedCount: wire.bound_issue_updates_omitted_count,
    } as any);
    expect(prompt).toContain("## Bound Issue Updates");
    expect(prompt).toContain("Published result: Implementation complete");
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
    const defaultEnabled = await app.request(`/api/chat/sessions/${chat.id}/issue-updates`, {
      headers: authHeaders,
    });
    expect(defaultEnabled.status).toBe(200);
    expect(await defaultEnabled.json()).toMatchObject({
      subscription: {
        enabled: true,
        issue_id: issue.id,
        debounce_window_seconds: 30,
      },
    });

    const disabled = await app.request(`/api/chat/sessions/${chat.id}/issue-updates`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      subscription: {
        enabled: false,
        issue_id: issue.id,
        debounce_window_seconds: 30,
      },
    });
    const enabled = await app.request(`/api/chat/sessions/${chat.id}/issue-updates`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(store.getAgentChatNotificationChannel(chat.id)).toMatchObject({
      kind: "agent_chat",
      enabled: true,
      target: { chatId: chat.id },
    });

    const sourceTask = store.createTask({
      agentId: agent.id,
      chatSessionId: chat.id,
      prompt: "Update the bound Issue",
    });
    const taskToken = await store.createTaskAccessToken(sourceTask, owner.id);
    const taskHeaders = { Authorization: `Bearer ${taskToken.token}` };
    expect((await app.request(
      `/api/chat/sessions/${chat.id}/issue-updates`,
      { headers: taskHeaders },
    )).status).toBe(403);
    expect((await app.request(`/api/chat/sessions/${chat.id}/issue-updates`, {
      method: "PUT",
      headers: { ...taskHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })).status).toBe(403);

    const label = store.createLabel({ name: "Agent-applied", color: "#336699", workspaceId: "local" });
    const labelResponse = await app.request(`/api/issues/${issue.id}/labels`, {
      method: "POST",
      headers: { ...taskHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ label_id: label.id }),
    });
    expect(labelResponse.status).toBe(200);
    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 60_000))).toEqual({
      delivered: 0,
      dropped: 0,
    });
    expect(store.listChatMessages(chat.id)).toHaveLength(0);

    const channel = store.getAgentChatNotificationChannel(chat.id)!;
    const genericPatch = await app.request(`/api/multiremi/notification-channels/${channel.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    expect(genericPatch.status).toBe(400);

    expect(store.deleteChatSession(chat.id)).toBe(true);
    expect(store.getAgentChatNotificationChannel(chat.id)).toBeNull();
  });

  it("debounces dense Issue activity into one Chat message", () => {
    const store = createStore({ debounceMs: 1_000 });
    const { issue, chat } = scaffold(store);

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
    expect(messages[0]?.taskId).toBeNull();
    expect(store.listTasksForIssue(issue.id)).toHaveLength(0);
  });

  it("delivers a human Issue comment on the next user turn and clears it only after success", () => {
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
    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "member_reviewer",
      body: "The reviewer approved the API contract.",
    });
    const issueSessionCountBeforeDelivery = store.listIssueSessions(issue.id).length;
    const taskCountBeforeDelivery = store.listTasks().length;
    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 1_000))).toEqual({
      delivered: 1,
      dropped: 0,
    });
    expect(store.listTasks()).toHaveLength(taskCountBeforeDelivery);
    expect(store.listChatMessages(chat.id).at(-1)).toMatchObject({
      role: "system",
      taskId: null,
    });

    const userTurn = store.sendChatMessage(chat.id, { body: "Review the latest status." });
    const claimedUserTurn = store.claimTask(runtime.id)!;
    expect(claimedUserTurn).toMatchObject({
      id: userTurn.task.id,
      chatSessionId: chat.id,
      issueId: issue.id,
      issueSessionId: null,
      sessionId: "sess_issue_updates",
      workDir: "/tmp/multiremi-agent-issue-updates",
    });
    const wire = daemonTaskClaimResponse(store, claimedUserTurn);
    expect((wire.session_projection as { mode?: string } | undefined)?.mode).toBe("delta");
    const prompt = buildTaskPrompt({
      ...claimedUserTurn,
      sessionProjection: wire.session_projection,
      chatMessage: wire.chat_message,
      boundIssueUpdates: wire.bound_issue_updates,
      boundIssueUpdatesOmittedCount: wire.bound_issue_updates_omitted_count,
    } as any);
    expect(prompt).toContain(`## Issue\nKey: ${issue.key}`);
    expect(prompt).toContain("## Bound Issue Updates");
    expect(prompt).toContain("The reviewer approved the API contract.");
    expect(prompt.match(/The reviewer approved the API contract\./g)).toHaveLength(1);
    expect(wire.chat_message).toBe("Review the latest status.");
    expect(prompt).not.toContain("## Chat Message");
    expect(prompt).not.toContain("## Agent Instructions");
    expect(store.listIssueSessions(issue.id)).toHaveLength(issueSessionCountBeforeDelivery);

    store.startTask(claimedUserTurn.id);
    store.failTask(claimedUserTurn.id, {
      error: "Transient provider failure",
      failureReason: "timeout",
    });
    const retry = store.listTasks().find((task) => task.parentTaskId === claimedUserTurn.id)!;
    expect(retry).toBeDefined();
    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
    const retryWire = daemonTaskClaimResponse(store, store.getTaskWithAgent(retry.id)!);
    expect(retryWire.bound_issue_updates).toEqual(expect.arrayContaining([
      expect.stringContaining("The reviewer approved the API contract."),
    ]));

    store.startTask(retry.id);
    store.completeTask(retry.id, {
      output: "Reviewed the latest status.",
      sessionId: "sess_issue_updates",
      workDir: "/tmp/multiremi-agent-issue-updates",
    });

    const nextTurn = store.sendChatMessage(chat.id, { body: "Continue." });
    expect(store.claimTask(runtime.id)?.id).toBe(nextTurn.task.id);
    const nextWire = daemonTaskClaimResponse(store, store.getTaskWithAgent(nextTurn.task.id)!);
    expect(nextWire.bound_issue_updates).toBeUndefined();
    expect(nextWire.bound_issue_updates_omitted_count).toBeUndefined();
  });

  it("caps a long pending update backlog without waking the agent", () => {
    const store = createStore({ debounceMs: 1 });
    const runtime = store.registerRuntime({
      id: "rt_issue_update_flood",
      name: "Issue update flood runtime",
      provider: "codex",
      workspaceId: "local",
    });
    const { issue, chat } = scaffold(store);

    const warmup = store.sendChatMessage(chat.id, { body: "Warm the Chat session." });
    expect(store.claimTask(runtime.id)?.id).toBe(warmup.task.id);
    store.startTask(warmup.task.id);
    store.completeTask(warmup.task.id, {
      output: "Ready.",
      sessionId: "sess_issue_update_flood",
      workDir: "/tmp/multiremi-agent-issue-update-flood",
    });
    const taskCountBeforeUpdates = store.listTasks().length;

    for (let index = 0; index < 100; index += 1) {
      store.createIssueComment(issue.id, {
        authorType: "member",
        authorId: "member_reviewer",
        body: `Flood update ${index}`,
      });
      expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 10_000))).toEqual({
        delivered: 1,
        dropped: 0,
      });
    }

    expect(store.listTasks()).toHaveLength(taskCountBeforeUpdates);
    expect(store.listChatMessages(chat.id).filter((message) => message.role === "system")).toHaveLength(100);

    const userTurn = store.sendChatMessage(chat.id, { body: "Summarize the accumulated progress." });
    expect(store.claimTask(runtime.id)?.id).toBe(userTurn.task.id);
    const claimedUserTurn = store.getTaskWithAgent(userTurn.task.id)!;
    const wire = daemonTaskClaimResponse(store, claimedUserTurn);
    expect(wire.bound_issue_updates).toHaveLength(12);
    expect(wire.bound_issue_updates_omitted_count).toBe(88);
    const prompt = buildTaskPrompt({
      ...claimedUserTurn,
      sessionProjection: wire.session_projection,
      chatMessage: wire.chat_message,
      boundIssueUpdates: wire.bound_issue_updates,
      boundIssueUpdatesOmittedCount: wire.bound_issue_updates_omitted_count,
    } as any);
    expect(prompt).toContain("88 earlier bound Issue update(s) omitted.");
    expect(prompt).toContain("Flood update 99");
    expect(prompt).not.toContain("Flood update 0\n");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(64 * 1024);
  });
});

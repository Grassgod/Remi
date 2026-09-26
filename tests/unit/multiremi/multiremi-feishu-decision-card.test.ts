/**
 * MUL-407 (parent MUL-400 E5): an Issue task's human request becomes a decision
 * card in the Issue's Feishu topic instead of waking a relay Agent to ask in
 * prose. These tests cover the parts the acceptance criteria name: who may
 * reach another daemon's request, the downgrade path for older hosts, the text
 * degradation, reminder dedupe, and the terminal in-place rewrite.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import {
  FEISHU_DECISION_CARD_CAPABILITY,
  FEISHU_DECISION_CARD_PROTOCOL_VERSION,
} from "@multiremi/contracts/types.js";
import { ISSUE_DECISION_REMINDER_LEAD_MS } from "@multiremi/store/repos/feishu-bot-repo.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
let previousEncryptionKey: string | undefined;
let previousPublicUrl: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  previousPublicUrl = process.env.MULTIREMI_PUBLIC_URL;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.MULTIREMI_PUBLIC_URL = "https://remi.example.com";
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  if (previousPublicUrl === undefined) delete process.env.MULTIREMI_PUBLIC_URL;
  else process.env.MULTIREMI_PUBLIC_URL = previousPublicUrl;
  resetMultiremiTestEnv();
});

/**
 * One bot host plus one separate executor daemon, an Issue topic that has its
 * root message, and a Question type with a single option.
 */
function scaffold(options: { hostSupportsCard?: boolean; notifyMode?: "group_owner" | "person" | "none" } = {}) {
  const store = createLocalStore();
  const agentId = store.createAgent({ name: "Concierge", provider: "codex", workspaceId: "local" }).id;
  store.registerRuntime({ id: "rt_bot", name: "Bot host", provider: "codex", workspaceId: "local", daemonId: "bot-host" });
  store.heartbeatRuntime("rt_bot", {
    supportsFeishuBotConfig: true,
    ...(options.hostSupportsCard === false ? {} : { supportsDecisionCard: true }),
  });
  const config = store.upsertFeishuBotConfig("local", {
    agentId,
    runtimeId: "rt_bot",
    appId: "cli_decision_card",
    appSecretOp: "set",
    appSecret: APP_SECRET,
    domain: "feishu",
    enabled: true,
  });
  store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: config.revision, state: "online" });
  const workspace = store.getWorkspace("local")!;
  store.updateWorkspace("local", {
    settings: {
      ...workspace.settings,
      issueTopics: {
        enabled: true,
        chatId: "oc_decision_card",
        ...(options.notifyMode ? { notifyMode: options.notifyMode } : {}),
        ...(options.notifyMode === "person" ? { notifyOpenId: "ou_the_person" } : {}),
      },
    },
  });
  return { store, agentId, app: createMultiremiApp({ store, authToken: "MASTER" }) };
}

/** An Issue whose topic root message has been sent, so replies have a seed. */
function issueWithTopic(store: MultiremiStore, agentId: string, title = "Decision card issue") {
  const issue = store.createIssue({ title, workspaceId: "local", assigneeType: "agent", assigneeId: agentId });
  store.prepareFeishuIssueTopicWithinTransaction(issue);
  const root = store.claimFeishuBotOutbound("local", "rt_bot")!;
  store.reportFeishuBotOutbound("local", "rt_bot", root.id, {
    claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${issue.id}`,
  });
  return issue;
}

/** A task that runs on another machine, exactly as production does. */
function sourceTask(store: MultiremiStore, agentId: string, issueId: string): string {
  const task = store.createTask({ agentId, issueId, workspaceId: "local", prompt: "Work the Issue" });
  store.registerRuntime({ id: `rt_worker_${task.id}`, name: "Executor", provider: "claude", workspaceId: "local", daemonId: `worker-${task.id}` });
  db!.run("UPDATE multiremi_tasks SET runtime_id = ? WHERE id = ?", [`rt_worker_${task.id}`, task.id]);
  return task.id;
}

function askQuestion(store: MultiremiStore, taskId: string, timeoutMs?: number) {
  return store.createTaskHumanRequest({
    taskId,
    kind: "question",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    payload: {
      message: "Should I continue?",
      questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
    },
  });
}

describe("Feishu decision cards for Issue human requests", () => {
  it("queues one decision_card delivery instead of waking a relay Agent", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const before = store.listTasks().length;
    const taskId = sourceTask(store, agentId, issue.id);
    expect(store.listTasks()).toHaveLength(before + 1);
    const request = askQuestion(store, taskId);

    // The only new Task is the source one: no relay wake was created.
    expect(store.listTasks().map((task) => task.id)).toEqual([taskId]);
    const delivery = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(delivery.kind).toBe("decision_card");
    expect(delivery.humanRequestId).toBe(request.id);
    expect(delivery.chatId).toBe("oc_decision_card");
    expect(delivery.replyToMessageId).toBe(`om_root_${issue.id}`);
    // The card and its text twin travel in one body so a terminal send failure
    // can degrade without a second round trip.
    const body = JSON.parse(delivery.body) as { card: Record<string, unknown>; fallback_text: string };
    expect(body.card.schema).toBe("2.0");
    expect(body.card.config).toMatchObject({ update_multi: true });
    expect(JSON.stringify(body.card)).toContain("Continue?");
    expect(body.fallback_text).toContain("Continue?");
    expect(body.fallback_text).toContain("1. Yes");
    expect(body.fallback_text).toContain(`https://remi.example.com/local/issues/${issue.id}`);
    // The push row is the idempotency record and it points at the delivery, not
    // at a wake Task.
    expect(db!.query(
      "SELECT wake_task_id, delivery_id FROM multiremi_feishu_bot_human_request_pushes WHERE request_id = ?",
    ).get(request.id)).toEqual({ wake_task_id: null, delivery_id: delivery.id });
  });

  it("falls back to the relay wake when the bot host predates decision cards", () => {
    const { store, agentId } = scaffold({ hostSupportsCard: false });
    expect(store.getRuntime("rt_bot")!.metadata[FEISHU_DECISION_CARD_CAPABILITY]).toBeUndefined();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const before = store.listTasks().length;
    const request = askQuestion(store, taskId);

    // The pre-MUL-407 behavior: a workspace-free relay Task carries the prompt.
    expect(store.listTasks()).toHaveLength(before + 1);
    const wake = store.listTasks().find((task) => task.prompt.includes(`Human request id: ${request.id}`))!;
    expect(wake).toBeDefined();
    const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(delivery.taskId).toBe(wake.id);
    expect(delivery.kind).toBeUndefined();
    expect(delivery.body).toContain("Should I continue?");
    expect(db!.query(
      "SELECT wake_task_id, delivery_id FROM multiremi_feishu_bot_human_request_pushes WHERE request_id = ?",
    ).get(request.id)).toEqual({ wake_task_id: wake.id, delivery_id: null });
  });

  it("declares the capability in heartbeat metadata and drops it when the host stops reporting it", async () => {
    const { store, app } = scaffold();
    const token = await store.createAccessToken({
      name: "bot-host", type: "daemon", workspaceId: "local", daemonId: "bot-host",
    });
    const headers = { Authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    const beat = (body: Record<string, unknown>) => app.request("/api/daemon/heartbeat", {
      method: "POST", headers, body: JSON.stringify({ runtime_id: "rt_bot", ...body }),
    });
    await beat({ feishu_concierge_protocol: 6, feishu_decision_card: FEISHU_DECISION_CARD_PROTOCOL_VERSION });
    expect(store.getRuntime("rt_bot")!.metadata[FEISHU_DECISION_CARD_CAPABILITY]).toBe(1);
    // Silence is an answer: a downgraded build must not keep receiving cards.
    await beat({ feishu_concierge_protocol: 6 });
    expect(store.getRuntime("rt_bot")!.metadata[FEISHU_DECISION_CARD_CAPABILITY]).toBe(0);
  });

  it("skips the topic entirely when the Issue has no seed and records why", () => {
    const { store, agentId } = scaffold();
    const issue = store.createIssue({ title: "No topic yet", workspaceId: "local" });
    db!.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
      (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, issue_id, chat_id, thread_id, created_at, updated_at)
      VALUES ('fcb_no_seed', 'local', 'cli_decision_card', ?, 'pending:no_seed',
        'chat_unseeded', ?, 'oc_decision_card', NULL, ?, ?)`,
    [agentId, issue.id, "2026-09-27T00:00:00.000Z", "2026-09-27T00:00:00.000Z"]);
    db!.run(`INSERT INTO multiremi_chat_sessions (id, workspace_id, agent_id, creator_id, title, status, created_at, updated_at)
      VALUES ('chat_unseeded', 'local', ?, 'local', 'Unseeded topic', 'active', ?, ?)`,
    [agentId, "2026-09-27T00:00:00.000Z", "2026-09-27T00:00:00.000Z"]);
    const task = store.createTask({ agentId, issueId: issue.id, workspaceId: "local", prompt: "Work" });
    const request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });

    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    const activity = store.listIssueActivity(issue.id).find((entry) => entry.type === "decision_card_skipped");
    expect(activity).toMatchObject({ body: request.id });
    expect((activity?.data as Record<string, unknown>).reason).toBe("no_topic");
  });

  it("degrades to text when the notification mode names nobody", () => {
    const { store, agentId } = scaffold({ notifyMode: "none" });
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const before = store.listTasks().length;
    const request = askQuestion(store, taskId);

    // No card, no relay wake: the request stays on the web workbench only.
    expect(store.listTasks()).toHaveLength(before);
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    expect(db!.query(
      "SELECT wake_task_id, delivery_id FROM multiremi_feishu_bot_human_request_pushes WHERE request_id = ?",
    ).get(request.id)).toEqual({ wake_task_id: null, delivery_id: null });
  });

  it("writes the terminal card in place whether the answer came from Feishu or the web", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const sent = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: sent.claimToken, status: "sent", externalMessageId: "om_decision_card",
    });

    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "Yes" } }, respondedBy: "feishu:open:ou_owner" });
    const patch = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(patch.kind).toBe("decision_card_patch");
    expect(patch.targetMessageId).toBe("om_decision_card");
    const card = JSON.parse(patch.body) as Record<string, any>;
    const text = JSON.stringify(card);
    expect(text).toContain("已提交");
    expect(text).toContain("Yes");
    // The answerer is escaped, so `ou_owner` arrives as `ou&#95;owner`.
    expect(text).toContain("ou&#95;owner");
    // Idempotent: a second terminal write must not queue a second patch.
    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "No" } } });
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
  });

  it("marks a timeout card as unanswered and never as an approval", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const sent = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: sent.claimToken, status: "sent", externalMessageId: "om_timed_out_card",
    });

    store.expireTaskHumanRequest(request.id, "timeout");
    const patch = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(patch.kind).toBe("decision_card_patch");
    const text = JSON.stringify(JSON.parse(patch.body));
    expect(text).toContain("已超时，未回答");
    expect(text).toContain("不会被自动批准");
  });

  it("sends exactly one reminder in the ten minutes before the deadline", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id), 60 * 60 * 1000);
    const sent = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: sent.claimToken, status: "sent", externalMessageId: "om_reminder_card",
    });

    const expiresAt = new Date(store.getTaskHumanRequest(request.id)!.expiresAt!).getTime();
    // Outside the window the claim must not materialize anything.
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - ISSUE_DECISION_REMINDER_LEAD_MS - 60_000))).toBeNull();
    // Inside it, one text nudge.
    const reminder = store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 60_000))!;
    expect(reminder.kind).toBe("decision_reminder");
    expect(reminder.body).toContain("超时");
    expect(reminder.humanRequestId).toBe(request.id);
    store.reportFeishuBotOutbound("local", "rt_bot", reminder.id, {
      claimToken: reminder.claimToken, status: "sent", externalMessageId: "om_reminder",
    });
    // Polling again, even past the deadline, must not produce a second one.
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt + 60_000))).toBeNull();
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_task_human_requests WHERE id = ?").get(request.id))
      .toMatchObject({ reminder_sent_at: expect.any(String) });
  });

  it("never reminds for a request that was answered first", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id), 60 * 60 * 1000);
    const sent = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: sent.claimToken, status: "sent", externalMessageId: "om_answered_card",
    });
    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "Yes" } } });
    // Drain the terminal patch, then look for a reminder inside the window.
    const patch = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(patch.kind).toBe("decision_card_patch");
    store.reportFeishuBotOutbound("local", "rt_bot", patch.id, {
      claimToken: patch.claimToken, status: "sent", externalMessageId: "om_answered_card",
    });
    const expiresAt = new Date(store.getTaskHumanRequest(request.id)!.expiresAt!).getTime();
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 60_000))).toBeNull();
  });

  it("lets the topic's host read and answer another daemon's Issue request, and nothing more", async () => {
    const { store, agentId, app } = scaffold();
    store.registerRuntime({ id: "rt_exec", name: "Executor", provider: "claude", workspaceId: "local", daemonId: "executor" });
    const executor = await store.createAccessToken({ name: "executor", type: "daemon", workspaceId: "local", daemonId: "executor" });
    const issue = issueWithTopic(store, agentId);
    // Execution is pinned to another machine, exactly as it is in production.
    const taskId = sourceTask(store, agentId, issue.id);
    db!.run("UPDATE multiremi_tasks SET runtime_id = ? WHERE id = ?", ["rt_exec", taskId]);
    const request = askQuestion(store, taskId);
    const hostToken = await store.createAccessToken({ name: "bot-host", type: "daemon", workspaceId: "local", daemonId: "bot-host" });
    const host = { Authorization: `Bearer ${hostToken.token}`, "content-type": "application/json" };
    const exec = { Authorization: `Bearer ${executor.token}`, "content-type": "application/json" };
    const requestPath = `/api/daemon/tasks/${taskId}/human-requests/${request.id}`;

    // (1) The topic's host may read the request.
    const read = await app.request(requestPath, { headers: host });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ request: { id: request.id, status: "pending" } });
    // (2) The topic's host may answer it.
    const respond = await app.request(`${requestPath}/respond`, {
      method: "POST", headers: host,
      body: JSON.stringify({ response: { answers: { "Continue?": "Yes" } } }),
    });
    expect(respond.status).toBe(200);
    expect(store.getTaskHumanRequest(request.id)?.status).toBe("responded");
    // (3) The topic's host still may not create or expire requests.
    const create = await app.request(`/api/daemon/tasks/${taskId}/human-requests`, {
      method: "POST", headers: host, body: JSON.stringify({ kind: "question", payload: {} }),
    });
    expect(create.status).toBe(403);
    const second = store.createTaskHumanRequest({ taskId, kind: "question", payload: {} });
    const expire = await app.request(`/api/daemon/tasks/${taskId}/human-requests/${second.id}/expire`, {
      method: "POST", headers: host, body: JSON.stringify({ status: "cancelled" }),
    });
    expect(expire.status).toBe(403);
    expect(store.getTaskHumanRequest(second.id)?.status).toBe("pending");
    // (4) An unrelated daemon gets nothing, and the executing daemon keeps full control.
    const other = await store.createAccessToken({ name: "other", type: "daemon", workspaceId: "local", daemonId: "bot-host" });
    expect((await app.request(requestPath, {
      headers: { Authorization: `Bearer ${other.token}`, "content-type": "application/json" },
    })).status).toBe(200);
    expect((await app.request(`${requestPath}/expire`, {
      method: "POST", headers: exec, body: JSON.stringify({ status: "cancelled" }),
    })).status).toBe(200);
  });

  it("keeps a receipt or reaction failure out of the card's delivery state", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const sent = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: sent.claimToken, status: "sent", externalMessageId: "om_receipt_card",
    });
    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "Yes" } } });

    // A stale/duplicate receipt report cannot move a delivery that already sent.
    expect(store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: "foc_stale", status: "failed", error: "receipt update failed",
    })).toBe(false);
    expect(db!.query("SELECT status, external_message_id, last_error FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?")
      .get(sent.id)).toEqual({ status: "sent", external_message_id: "om_receipt_card", last_error: null });
    // The patch lane is queued independently of the receipt outcome.
    expect(store.claimFeishuBotOutbound("local", "rt_bot")!.kind).toBe("decision_card_patch");
  });
});

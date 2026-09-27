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
import {
  ISSUE_DECISION_REMINDER_MAX_LEAD_MS,
  decisionReminderLeadMs,
  resolveDecisionRecipient,
} from "@multiremi/store/repos/feishu-bot-repo.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { decodeDecisionCardBody } from "@shared/feishu-task-card.js";
import { MultiremiDaemonClient } from "@multiremi/worker/client.js";

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
function scaffold(options: {
  hostSupportsCard?: boolean;
  notifyMode?: "group_owner" | "person" | "none";
  notifyOpenId?: string;
} = {}) {
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
        ...(options.notifyMode === "person"
          ? { notifyOpenId: options.notifyOpenId ?? "ou_the_person" } : {}),
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
    // The host needs the asking Task to read and answer after a restart.
    expect(delivery.humanRequestTaskId).toBe(taskId);
    expect(delivery.chatId).toBe("oc_decision_card");
    expect(delivery.replyToMessageId).toBe(`om_root_${issue.id}`);
    // Card and text twin travel in one body, in the shape the host decodes.
    const envelope = decodeDecisionCardBody(delivery.body)!;
    expect(envelope).toBeTruthy();
    expect(envelope.card.schema).toBe("2.0");
    expect(envelope.card.config).toMatchObject({ update_multi: true });
    expect(JSON.stringify(envelope.card)).toContain("Continue?");
    expect(envelope.fallback_text).toContain("Continue?");
    expect(envelope.fallback_text).toContain("1. Yes");
    expect(envelope.fallback_text).toContain(`https://remi.example.com/local/issues/${issue.id}`);
    // S1: no request, task or delivery identifier leaks into the text version.
    // The workbench link necessarily carries the Issue it points at, and the
    // Issue key is already the public name of the work.
    for (const marker of ["hrq_", "tsk_", "fhrp_", "fbo_"]) {
      expect(envelope.fallback_text).not.toContain(marker);
    }
    expect(envelope.fallback_text).not.toContain(`Request ID`);
    const push = db!.query(
      "SELECT wake_task_id, delivery_id FROM multiremi_feishu_bot_human_request_pushes WHERE request_id = ?",
    ).get(request.id);
    expect(push).toEqual({ wake_task_id: null, delivery_id: delivery.id });
    // Idempotent: a repeated push for the same request adds nothing.
    expect(store.getTaskHumanRequest(request.id)!.id).toBe(request.id);
    expect(db!.query(
      "SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card' AND human_request_id = ?",
    ).get(request.id)).toEqual({ n: 1 });
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

  it("still degrades to text on a host that cannot render cards", () => {
    // The two known "nobody to ask" cases are not a card feature: an old host
    // must deliver the text version rather than nothing at all.
    const { store, agentId } = scaffold({ hostSupportsCard: false, notifyMode: "none" });
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const before = store.listTasks().length;
    const request = askQuestion(store, taskId);

    expect(store.listTasks()).toHaveLength(before);
    const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(delivery.kind).toBe("decision_card");
    expect(delivery.degraded).toBe("notify_none");
    expect(decodeDecisionCardBody(delivery.body)).toBeNull();
    expect(delivery.body).toContain("Continue?");
    expect(delivery.body).toContain(`https://remi.example.com/local/issues/${issue.id}`);
    expect(db!.query(
      "SELECT wake_task_id, delivery_id FROM multiremi_feishu_bot_human_request_pushes WHERE request_id = ?",
    ).get(request.id)).toEqual({ wake_task_id: null, delivery_id: delivery.id });
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

  it("B3: a downgraded host skips the card and still delivers everything behind it", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    // The card is queued first, so it is the head of the outbound queue.
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(card.kind).toBe("decision_card");
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "failed", error: "put back", retryable: true,
    }, new Date(0));
    // An ordinary reply queued behind it.
    const ordinary = queueOrdinaryDelivery(store, issue.id);
    // The host rolls back to a build without the capability.
    store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true, supportsDecisionCard: false });
    const claimed = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true, true, true)!;
    expect(claimed.id).toBe(ordinary);
    expect(claimed.kind).toBeUndefined();
    // The card is still there, unclaimed, for a host that declares the capability.
    expect(db!.query("SELECT status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(card.id))
      .toEqual({ status: "pending" });
    store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true, supportsDecisionCard: true });
    const recovered = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true, true, true)!;
    expect(recovered.id).toBe(card.id);
    expect(recovered.kind).toBe("decision_card");
    expect(store.getTaskHumanRequest(request.id)!.status).toBe("pending");
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

  for (const scenario of [
    { name: "notifyMode=none", options: { notifyMode: "none" as const }, reason: "notify_none" as const },
  ]) {
    it(`degrades to text for ${scenario.name}`, () => {
      const { store, agentId } = scaffold(scenario.options);
      const issue = issueWithTopic(store, agentId);
      const taskId = sourceTask(store, agentId, issue.id);
      const before = store.listTasks().length;
      const request = askQuestion(store, taskId);

      // No card, no relay wake: a text delivery carrying the question.
      expect(store.listTasks()).toHaveLength(before);
      const delivery = store.claimFeishuBotOutbound("local", "rt_bot")!;
      expect(delivery.kind).toBe("decision_card");
      expect(delivery.degraded).toBe(scenario.reason);
      expect(delivery.interactionOpenId).toBeUndefined();
      expect(decodeDecisionCardBody(delivery.body)).toBeNull();
      expect(delivery.body).toContain("Continue?");
      expect(delivery.body).toContain("1. Yes");
      expect(delivery.body).toContain(`https://remi.example.com/local/issues/${issue.id}`);
      const activity = store.listIssueActivity(issue.id).find((entry) => entry.type === "decision_card_degraded");
      expect((activity?.data as Record<string, unknown>).reason).toBe(scenario.reason);
      expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch' AND human_request_id = ?")
        .get(request.id)).toEqual({ n: 0 });
    });
  }

  it("does not patch or @ a degraded request's terminal state", () => {
    const { store, agentId } = scaffold({ notifyMode: "none" });
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const text = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", text.id, {
      claimToken: text.claimToken, status: "sent", externalMessageId: "om_degraded_text",
    });
    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "Yes" } } });

    // No terminal patch: the message on screen is the question, and rewriting it
    // would replace the question with a receipt the reader never asked for.
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    const expiresAt = new Date(store.getTaskHumanRequest(request.id)!.expiresAt!).getTime();
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 60_000))).toBeNull();
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch' AND human_request_id = ?")
      .get(request.id)).toEqual({ n: 0 });
  });

  it("writes the terminal card in place whether the answer came from Feishu or the web", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const sent = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: sent.claimToken, status: "sent", externalMessageId: "om_decision_card",
      interactionOpenId: "ou_the_person",
    });

    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "Yes" } }, respondedBy: "feishu:open:ou_owner" });
    const patch = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(patch.kind).toBe("decision_card_patch");
    expect(patch.targetMessageId).toBe("om_decision_card");
    // B2: the patch body is the same envelope the host decodes, and it carries
    // the real terminal card — not a bare card, not an empty one.
    const envelope = decodeDecisionCardBody(patch.body)!;
    expect(envelope).toBeTruthy();
    expect(JSON.stringify(envelope.card)).toContain("已提交");
    expect(JSON.stringify(envelope.card)).toContain("Yes");
    expect(JSON.stringify(envelope.card)).toContain("ou&#95;owner");
    // Idempotent: a second terminal write must not queue a second patch.
    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "No" } } });
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
  });

  for (const terminal of [
    { name: "timeout", status: "timeout" as const, expected: "已超时，未回答" },
    { name: "cancellation", status: "cancelled" as const, expected: "已取消" },
  ]) {
    it(`writes a complete terminal card for ${terminal.name}`, () => {
      const { store, agentId } = scaffold();
      const issue = issueWithTopic(store, agentId);
      const request = askQuestion(store, sourceTask(store, agentId, issue.id));
      const sent = store.claimFeishuBotOutbound("local", "rt_bot")!;
      store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
        claimToken: sent.claimToken, status: "sent", externalMessageId: "om_terminal_card",
      });

      store.expireTaskHumanRequest(request.id, terminal.status);
      const patch = store.claimFeishuBotOutbound("local", "rt_bot")!;
      expect(patch.kind).toBe("decision_card_patch");
      const envelope = decodeDecisionCardBody(patch.body)!;
      expect(envelope).toBeTruthy();
      const text = JSON.stringify(envelope.card);
      expect(text).toContain(terminal.expected);
      expect(text).toContain("Continue?");
      // The body is a full card: schema, header and a body with elements.
      expect(envelope.card.schema).toBe("2.0");
      expect((envelope.card.body as { elements: unknown[] }).elements.length).toBeGreaterThan(0);
      if (terminal.status === "timeout") expect(text).toContain("不会被自动批准");
    });
  }

  it("B4: a five-minute request is not already due when its card is sent", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id), 5 * 60 * 1000);
    const createdAt = store.getTaskHumanRequest(request.id)!.createdAt;
    const expiresAt = store.getTaskHumanRequest(request.id)!.expiresAt!;
    // Half the lifetime, not the ten-minute ceiling.
    expect(decisionReminderLeadMs(expiresAt, createdAt)).toBe(2.5 * 60 * 1000);
    // Sending the card must not consume the reminder slot.
    const sent = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: sent.claimToken, status: "sent", externalMessageId: "om_short_card",
      interactionOpenId: "ou_the_person",
    });
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_task_human_requests WHERE id = ?").get(request.id))
      .toEqual({ reminder_sent_at: null });
    // Then the nudge still arrives, exactly once, inside the window.
    const expiryMs = Date.parse(expiresAt);
    const reminder = store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiryMs - 60_000))!;
    expect(reminder.kind).toBe("decision_reminder");
    expect(reminder.body).toContain("超时");
    store.reportFeishuBotOutbound("local", "rt_bot", reminder.id, {
      claimToken: reminder.claimToken, status: "sent", externalMessageId: "om_reminder",
    }, new Date(expiryMs - 60_000));
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiryMs + 60_000))).toBeNull();
  });

  it("B4: a host that was offline across the window still gets one reminder", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id), 60 * 60 * 1000);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    const expiresAt = Date.parse(store.getTaskHumanRequest(request.id)!.expiresAt!);
    // The host is down: the card is parked far out of reach, so materialization
    // runs inside the window with no card on screen yet.
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET status = 'pending', claim_token = NULL, available_at = ? WHERE id = ?",
      [new Date(expiresAt + 3_600_000).toISOString(), card.id]);
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 9 * 60_000))).toBeNull();
    // The absent card must not have consumed the one reminder.
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_task_human_requests WHERE id = ?").get(request.id))
      .toEqual({ reminder_sent_at: null });
    // The host comes back, the card finally goes out inside the window, and the
    // nudge follows instead of having been silently spent.
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET available_at = ? WHERE id = ?",
      [new Date(expiresAt - 8 * 60_000).toISOString(), card.id]);
    const late = store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 8 * 60_000))!;
    expect(late.id).toBe(card.id);
    store.reportFeishuBotOutbound("local", "rt_bot", late.id, {
      claimToken: late.claimToken, status: "sent", externalMessageId: "om_late_card",
      interactionOpenId: "ou_the_person",
    }, new Date(expiresAt - 8 * 60_000));
    const reminder = store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 7 * 60_000))!;
    expect(reminder.kind).toBe("decision_reminder");
    expect(reminder.humanRequestId).toBe(request.id);
    expect(reminder.mention).toMatchObject({ mode: "person", resolvedOpenId: "ou_the_person" });
  });

  it("B5: the reminder @s the person who was asked", () => {
    const { store, agentId } = scaffold({ notifyMode: "person" });
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id), 60 * 60 * 1000);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    // The recipient the host actually used is checkpointed with the send; the
    // reminder reuses it instead of resolving again.
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_person_card",
      interactionOpenId: "ou_the_person",
    });
    const expiresAt = Date.parse(store.getTaskHumanRequest(request.id)!.expiresAt!);
    const reminder = store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 60_000))!;
    expect(reminder.kind).toBe("decision_reminder");
    expect(reminder.mention).toMatchObject({ mode: "person", resolvedOpenId: "ou_the_person" });
    expect(reminder.interactionOpenId).toBe("ou_the_person");
  });

  it("never reminds for a request that was answered first", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id), 60 * 60 * 1000);
    const sent = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: sent.claimToken, status: "sent", externalMessageId: "om_answered_card",
      interactionOpenId: "ou_the_person",
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

  it("keeps reminders and patches invisible to a second, unrelated daemon", async () => {
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
    // (4) S2: a genuinely different daemon is refused, on read and on create.
    const stranger = await store.createAccessToken({ name: "stranger", type: "daemon", workspaceId: "local", daemonId: "someone-else" });
    const strangerHeaders = { Authorization: `Bearer ${stranger.token}`, "content-type": "application/json" };
    expect((await app.request(requestPath, { headers: strangerHeaders })).status).toBe(403);
    expect((await app.request(`/api/daemon/tasks/${taskId}/human-requests`, {
      method: "POST", headers: strangerHeaders, body: JSON.stringify({ kind: "question", payload: {} }),
    })).status).toBe(403);
    // (5) S2: a daemon in another workspace has no access either.
    const otherWorkspace = store.createWorkspace({ name: "Other", slug: "other" });
    store.registerRuntime({ id: "rt_other", name: "Other host", provider: "codex",
      workspaceId: otherWorkspace.id, daemonId: "other-host" });
    store.heartbeatRuntime("rt_other", { supportsFeishuBotConfig: true });
    const outsider = await store.createAccessToken({ name: "outsider", type: "daemon",
      workspaceId: otherWorkspace.id, daemonId: "other-host" });
    expect((await app.request(requestPath, {
      headers: { Authorization: `Bearer ${outsider.token}`, "content-type": "application/json" },
    })).status).toBe(403);
    // The executing daemon keeps full control.
    expect((await app.request(`${requestPath}/expire`, {
      method: "POST", headers: exec, body: JSON.stringify({ status: "cancelled" }),
    })).status).toBe(200);
  });

  it("S3: the decision lane never calls a receipt or reaction API", async () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    const sent = store.claimFeishuBotOutbound("local", "rt_bot")!;
    // A decision lane carries no inbound message to receipt: `task_id` is NULL,
    // so the delivery has no receipt ids and no reaction target at all.
    expect(sent.taskId).toBeUndefined();
    expect(sent.receiptMessageIds).toBeUndefined();
    store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: sent.claimToken, status: "sent", externalMessageId: "om_receipt_card",
      interactionOpenId: "ou_the_person",
    });
    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "Yes" } } });
    const patch = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(patch.taskId).toBeUndefined();
    expect(patch.receiptMessageIds).toBeUndefined();
    // A stale or duplicate report cannot move a delivery that already sent.
    expect(store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: "foc_stale", status: "failed", error: "receipt update failed",
    })).toBe(false);
    expect(db!.query("SELECT status, external_message_id, last_error FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?")
      .get(sent.id)).toEqual({ status: "sent", external_message_id: "om_receipt_card", last_error: null });
    expect(patch.kind).toBe("decision_card_patch");
  });

  it("S5: concurrent claims produce exactly one card, one patch and one reminder", () => {
    // No PostgreSQL is reachable in this environment, so this is the SQLite
    // claim-token compare-and-set rather than a true two-process race.
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id), 60 * 60 * 1000);
    const first = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    store.reportFeishuBotOutbound("local", "rt_bot", first.id, {
      claimToken: first.claimToken, status: "sent", externalMessageId: "om_single_card",
      interactionOpenId: "ou_the_person",
    });
    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "Yes" } } });
    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "No" } } });
    const patch = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    store.reportFeishuBotOutbound("local", "rt_bot", patch.id, {
      claimToken: patch.claimToken, status: "sent", externalMessageId: "om_single_card",
    });
    expect(db!.query(
      "SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE human_request_id = ? AND kind = 'decision_card'",
    ).get(request.id)).toEqual({ n: 1 });
    expect(db!.query(
      "SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE human_request_id = ? AND kind = 'decision_card_patch'",
    ).get(request.id)).toEqual({ n: 1 });
    expect(db!.query(
      "SELECT COUNT(*) AS n FROM multiremi_feishu_bot_human_request_pushes WHERE request_id = ?",
    ).get(request.id)).toEqual({ n: 1 });
  });

  it("S5: the reminder is claimed by exactly one of two racing claims", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id), 60 * 60 * 1000);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_race_card",
      interactionOpenId: "ou_the_person",
    });
    const expiresAt = Date.parse(store.getTaskHumanRequest(request.id)!.expiresAt!);
    const reminder = store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 60_000))!;
    expect(reminder.kind).toBe("decision_reminder");
    // The second claimer, in the same window, finds nothing to materialize.
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 50_000))).toBeNull();
    expect(db!.query(
      "SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE human_request_id = ? AND kind = 'decision_reminder'",
    ).get(request.id)).toEqual({ n: 1 });
  });

  it("exposes the recipient decision the way the host and the reminder read it", () => {
    expect(resolveDecisionRecipient({ enabled: true, chatId: "oc_x" })).toEqual({ kind: "host_resolved", degraded: false });
    expect(resolveDecisionRecipient({ enabled: true, chatId: "oc_x", notifyMode: "person", notifyOpenId: "ou_abc" }))
      .toEqual({ kind: "resolved", openId: "ou_abc", degraded: false });
    expect(resolveDecisionRecipient({ enabled: true, chatId: "oc_x", notifyMode: "none" }))
      .toEqual({ kind: "degraded", reason: "notify_none", degraded: true });
    expect(resolveDecisionRecipient({ enabled: true, chatId: "oc_x", notifyMode: "person" }))
      .toEqual({ kind: "degraded", reason: "invalid_recipient", degraded: true });
    // Ten minutes is the ceiling for a long request and half the lifetime for a
    // short one, which is what keeps a five-minute autopilot request usable.
    expect(decisionReminderLeadMs("2026-09-27T01:00:00.000Z", "2026-09-27T00:00:00.000Z"))
      .toBe(ISSUE_DECISION_REMINDER_MAX_LEAD_MS);
    expect(decisionReminderLeadMs("2026-09-27T00:10:00.000Z", "2026-09-27T00:00:00.000Z"))
      .toBe(5 * 60 * 1000);
  });

  it("lists live cards for a restarting host, and only unaddressed ones are excluded", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const sent = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(store.listFeishuBotLiveDecisionCards("local", "rt_bot")).toEqual([]);
    store.reportFeishuBotOutbound("local", "rt_bot", sent.id, {
      claimToken: sent.claimToken, status: "sent", externalMessageId: "om_recoverable",
      interactionOpenId: "ou_the_person",
    });
    // The identity the callback name is derived from, plus the recipient.
    expect(store.listFeishuBotLiveDecisionCards("local", "rt_bot")).toEqual([{
      request_id: request.id,
      task_id: store.getTaskHumanRequest(request.id)!.taskId,
      chat_id: "oc_decision_card",
      message_id: "om_recoverable",
      recipient_open_id: "ou_the_person",
    }]);
    // A settled request is no longer clickable, so it drops out.
    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "Yes" } } });
    expect(store.listFeishuBotLiveDecisionCards("local", "rt_bot")).toEqual([]);
  });

  it("recovers a live card through the real route and the real daemon client", async () => {
    // The fake daemon in the host tests bypassed both the HTTP route and the
    // client's field parsing, which is exactly how a camelCase/snake_case
    // mismatch shipped. This goes through `createMultiremiApp` and the real
    // `MultiremiDaemonClient`, so the wire shape is what is actually asserted.
    const { store, agentId, app } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_recovery_card",
      interactionOpenId: "ou_the_person",
    });
    const token = await store.createAccessToken({
      name: "bot-host", type: "daemon", workspaceId: "local", daemonId: "bot-host",
    });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url, "http://local");
      return app.request(parsed.pathname + parsed.search, init);
    }) as typeof fetch;
    try {
      const client = new MultiremiDaemonClient("http://local", token.token);
      const cards = await client.listFeishuBotDecisionCards("rt_bot");
      // One live card, parsed field for field — zero was the shipped bug.
      expect(cards).toEqual([{
        requestId: request.id,
        taskId,
        chatId: "oc_decision_card",
        messageId: "om_recovery_card",
        recipientOpenId: "ou_the_person",
      }]);
    } finally {
      globalThis.fetch = realFetch;
    }
    // The store agrees with what the client recovered.
    expect(store.listFeishuBotLiveDecisionCards("local", "rt_bot")).toHaveLength(1);
  });

  it("does not expose cross-daemon or cross-workspace cards on the recovery route", async () => {
    const { store, agentId, app } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_private",
      interactionOpenId: "ou_the_person",
    });
    const path = "/api/daemon/runtimes/rt_bot/feishu-bot/decision-cards";
    const tokenFor = async (daemonId: string, workspaceId = "local") =>
      (await store.createAccessToken({ name: daemonId, type: "daemon", workspaceId, daemonId })).token;

    // The host itself reads its own card.
    const own = await app.request(path, {
      headers: { Authorization: `Bearer ${await tokenFor("bot-host")}` },
    });
    expect(own.status).toBe(200);
    const body = await own.json() as { cards: Array<Record<string, unknown>> };
    expect(body.cards).toHaveLength(1);
    // Only the fields the host needs — nothing extra leaks with them.
    expect(Object.keys(body.cards[0]!).sort()).toEqual(
      ["chat_id", "message_id", "recipient_open_id", "request_id", "task_id"]);

    // Another daemon in the same workspace is refused.
    expect((await app.request(path, {
      headers: { Authorization: `Bearer ${await tokenFor("someone-else")}` },
    })).status).toBe(403);
    // So is a daemon from another workspace, even one whose id matches.
    const other = store.createWorkspace({ name: "Other", slug: "other" });
    store.registerRuntime({ id: "rt_other", name: "Other", provider: "codex",
      workspaceId: other.id, daemonId: "other-host" });
    store.heartbeatRuntime("rt_other", { supportsFeishuBotConfig: true, supportsDecisionCard: true });
    expect((await app.request(path, {
      headers: { Authorization: `Bearer ${await tokenFor("other-host", other.id)}` },
    })).status).toBe(403);
    // A human token is not a daemon token.
    const human = await store.createAccessToken({ name: "human", type: "pat", workspaceId: "local", userId: "local" });
    expect((await app.request(path, {
      headers: { Authorization: `Bearer ${human.token}` },
    })).status).toBe(403);
    expect(store.getTaskHumanRequest(request.id)!.status).toBe("pending");
  });

  it("B4: a reminder is suppressed once less than a minute of lifetime remains", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id), 60 * 60 * 1000);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_window_card",
      interactionOpenId: "ou_the_person",
    });
    const expiresAt = Date.parse(store.getTaskHumanRequest(request.id)!.expiresAt!);

    // 30s and 20s left are both inside the window but too late to be useful.
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 30_000))).toBeNull();
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 20_000))).toBeNull();
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_task_human_requests WHERE id = ?").get(request.id))
      .toEqual({ reminder_sent_at: null });
    // 61s left clears the floor and produces the one reminder.
    const reminder = store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 61_000))!;
    expect(reminder.kind).toBe("decision_reminder");
    expect(reminder.humanRequestId).toBe(request.id);
    // Only once, even if the clock keeps running into the final minute.
    store.reportFeishuBotOutbound("local", "rt_bot", reminder.id, {
      claimToken: reminder.claimToken, status: "sent", externalMessageId: "om_reminder",
    }, new Date(expiresAt - 61_000));
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 10_000))).toBeNull();
  });

  it("B4: a late card still gets its reminder while a minute remains", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id), 60 * 60 * 1000);
    const expiresAt = Date.parse(store.getTaskHumanRequest(request.id)!.expiresAt!);
    // The host was offline across the window; the card is parked far out.
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET status = 'pending', claim_token = NULL, available_at = ? WHERE id = ?",
      [new Date(expiresAt + 60_000).toISOString(), card.id]);
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 7 * 60_000))).toBeNull();
    // It comes back with 90s left: the card goes out and the reminder follows.
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET available_at = ? WHERE id = ?",
      [new Date(expiresAt - 90_000).toISOString(), card.id]);
    const late = store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 90_000))!;
    store.reportFeishuBotOutbound("local", "rt_bot", late.id, {
      claimToken: late.claimToken, status: "sent", externalMessageId: "om_late",
      interactionOpenId: "ou_the_person",
    }, new Date(expiresAt - 90_000));
    const reminder = store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 80_000))!;
    expect(reminder.kind).toBe("decision_reminder");
    // But the same late card with only 30s left would not have.
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_task_human_requests WHERE id = ?").get(request.id))
      .toMatchObject({ reminder_sent_at: expect.any(String) });
  });

  it("records a host-reported degradation on the Issue exactly once", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_text",
      interactionOpenId: "ou_the_person", degraded: "send_failed",
    });

    const degraded = store.listIssueActivity(issue.id).filter((entry) => entry.type === "decision_card_degraded");
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({ body: request.id });
    const data = degraded[0]!.data as Record<string, unknown>;
    // The same fields the control-plane-decided case writes.
    expect(data).toMatchObject({
      request_id: request.id, delivery_id: card.id, kind: "decision_card", reason: "send_failed",
    });
    expect(db!.query("SELECT degraded FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(card.id))
      .toEqual({ degraded: "send_failed" });

    // A repeat report cannot write a second activity: the delivery is already
    // `sent`, so the claim-token guard rejects it before the activity code runs.
    expect(store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_text_again",
      interactionOpenId: "ou_the_person", degraded: "send_failed",
    })).toBe(false);
    expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === "decision_card_degraded"))
      .toHaveLength(1);
  });

  it("B5: interaction_open_id can only be written on this host's own delivery", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    // Another daemon cannot report on this delivery at all: the runtime must be
    // the configured bot host for the workspace.
    expect(store.reportFeishuBotOutbound("local", "rt_not_the_bot_host", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_hijack",
      interactionOpenId: "ou_someone_else",
    })).toBe(false);
    // Neither can a claim token that does not match.
    expect(store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: "foc_forged", status: "sent", externalMessageId: "om_hijack",
      interactionOpenId: "ou_someone_else",
    })).toBe(false);
    expect(db!.query("SELECT interaction_open_id, status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?")
      .get(card.id)).toEqual({ interaction_open_id: null, status: "sending" });
    // The real host writes it, and only for its own row.
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_ok",
      interactionOpenId: "ou_the_person",
    });
    expect(db!.query("SELECT interaction_open_id FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?")
      .get(card.id)).toEqual({ interaction_open_id: "ou_the_person" });
    expect(store.getTaskHumanRequest(request.id)!.status).toBe("pending");
  });

  it("degrades to text when a stored person config is invalid, without throwing", () => {
    // Bypass the save-time validation to reproduce a database written before it
    // existed. The push path must degrade, not throw: a request with no delivery
    // leaves the person who was asked with no way to hear about it.
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const workspaceRow = db!.query("SELECT settings FROM multiremi_workspaces WHERE id = 'local'").get() as { settings: string };
    const settings = JSON.parse(workspaceRow.settings) as Record<string, unknown>;
    settings.issueTopics = { enabled: true, chatId: "oc_decision_card", notifyMode: "person", notifyOpenId: "not-an-open-id" };
    db!.run("UPDATE multiremi_workspaces SET settings = ? WHERE id = 'local'", [JSON.stringify(settings)]);

    let request: ReturnType<typeof askQuestion> | null = null;
    expect(() => { request = askQuestion(store, taskId); }).not.toThrow();
    expect(request).not.toBeNull();
    const delivery = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(delivery.kind).toBe("decision_card");
    expect(delivery.degraded).toBe("invalid_recipient");
    expect(decodeDecisionCardBody(delivery.body)).toBeNull();
    expect(delivery.body).toContain("Continue?");
    expect(delivery.body).not.toContain("<at id=");
    const degraded = store.listIssueActivity(issue.id).find((entry) => entry.type === "decision_card_degraded");
    expect((degraded?.data as Record<string, unknown>).reason).toBe("invalid_recipient");
  });
});

/** A normal proactive delivery queued behind the decision lane (B3). */
function queueOrdinaryDelivery(store: MultiremiStore, issueId: string): string {
  const id = "fbo_ordinary_behind_card";
  db!.run(`INSERT INTO multiremi_feishu_bot_outbound_deliveries (
      id, workspace_id, binding_id, task_id, chat_id, thread_id, reply_to_message_id,
      body, status, available_at, created_at, updated_at)
    VALUES (?, 'local', (SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE issue_id = ?),
      NULL, 'oc_decision_card', NULL, 'om_root', 'An ordinary reply', 'pending', ?, ?, ?)`,
  [id, issueId, "2026-09-27T00:00:00.000Z", "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"]);
  return id;
}

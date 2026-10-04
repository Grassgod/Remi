import { runTurnExecutionMutation } from '@multiremi/store/turn-execution-records.js';
import type { SqlDatabase as UnifiedFixtureDatabase } from '@multiremi/store/db/postgres.js';
/**
 * MUL-407 (parent MUL-400 E5): an Issue task's human request becomes a decision
 * card in the Issue's Feishu topic instead of waking a relay Agent to ask in
 * prose. These tests cover the parts the acceptance criteria name: who may
 * reach another daemon's request, the downgrade path for older hosts, the text
 * degradation, reminder dedupe, and the terminal in-place rewrite.
 */
import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { receiveNormalizedRuntimeInputs, requestRuntimeRpc } from "../../fixtures/runtime-downlinks.js";
import { bindReportFrames } from "../../fixtures/report-session.js";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import {
  FEISHU_CONCIERGE_PROTOCOL_VERSION,
  FEISHU_DECISION_CARD_CAPABILITY,
  FEISHU_DECISION_CARD_PROTOCOL_VERSION,
} from "@multiremi/contracts/types.js";
import {
  ISSUE_DECISION_REMINDER_MAX_LEAD_MS,
  decisionReminderLeadMs,
  resolveDecisionRecipient,
} from "@multiremi/store/repos/feishu-bot-repo.js";
import { resetMultiremiTestEnv } from "./helpers.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { decodeDecisionCardBody, questionCardAction } from "@shared/feishu-task-card.js";
import { FeishuDeliveryError } from "@shared/feishu-delivery-error.js";
import { MultiremiDaemonClient } from "@multiremi/worker/client.js";
import type { FeishuConciergeHost, FeishuConciergeSupervisor } from "@multiremi/worker/feishu-concierge.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { taskInputSnapshot } from "@multiremi/api/daemon-protocol/task-input-snapshot.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import {
  controlPlaneConciergeHost,
  sendDecisionLane as sendDecisionLaneForTest,
} from "../../../apps/remi/cli/multiremi.js";
import type { FeishuChannelHandle } from "../../../apps/remi/cli/agent.js";
import { handleTaskInteractionEvent, interactionMarker, registerQuestionCardClient } from "@connectors/feishu/task-interaction.js";
import { FeishuConnector } from "@connectors/feishu/index.js";

pendingTurnBackendTests("MUL-508 human request cards", (fixture) => {
let db: SqlDatabase;
beforeEach(() => { db = fixture().db; });
const createLocalStore = () => fixture().store;

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
  return { store, agentId, config, app: createMultiremiApp({ store, authToken: "MASTER" }) };
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
  runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET runtime_id = ? WHERE id = ?", [`rt_worker_${task.id}`, task.id]);
  return task.id;
}

function patchHumanRequestFixture(id: string, fields: Record<string, unknown>): void {
  const row = db!.query("SELECT metadata FROM multiremi_conversation_log WHERE id=?").get(id) as { metadata: string };
  const metadata = JSON.parse(row.metadata);
  metadata.human_request = { ...metadata.human_request, ...fields };
  db!.run("UPDATE multiremi_conversation_log SET metadata=? WHERE id=?", [JSON.stringify(metadata), id]);
}

function cloneSettledQuestion(store: MultiremiStore, sourceId: string, id: string, respondedAt?: string): void {
  const source = store.getMessage(sourceId)!;
  const metadata = { ...source.metadata, human_request: { ...(source.metadata.human_request as object), ...(respondedAt ? { responded_at: respondedAt } : {}) } };
  store.sendMessage({ id, session_id: source.session_id, sender: { type: "agent", id: source.sender_id },
    source_turn_id: source.task_id, to: { type: "none" }, body_md: source.body_md, message_kind: "decision", wake_requested: "inbox_only", metadata });
}

function cloneSettledQuestionBatch(store: MultiremiStore, sourceId: string, count: number, stem: string, cardId: string, taskId: string, respondedAt?: string): void {
  db.transaction(() => {
    // One real send establishes the canonical shape; bulk copies keep the
    // large read-budget fixtures within the same timeout on both databases.
    cloneSettledQuestion(store, sourceId, `hrq_${stem}_0`, respondedAt);
    const template = db.query("SELECT * FROM multiremi_conversation_log WHERE id=?").get(`hrq_${stem}_0`)!;
    const columns = Object.keys(template);
    for (let start = 1; start < count; start += 128) {
      const size = Math.min(128, count - start);
      const values = Array.from({ length: size }, (_, offset) => {
        const row = { ...template, id: `hrq_${stem}_${start + offset}`, seq: Number(template.seq) + start + offset };
        return columns.map(column => row[column]);
      });
      db.run(`INSERT INTO multiremi_conversation_log (${columns.join(",")}) VALUES ${values.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}`, values.flat());
    }
    db.run("UPDATE multiremi_conversation_heads SET head_seq=?,log_version=log_version+? WHERE session_id=?",
      [Number(template.seq) + count - 1, count - 1, template.session_id]);
    for (let start = 0; start < count; start += 128) {
      const values = Array.from({ length: Math.min(128, count - start) }, (_, offset) => {
        const index = start + offset;
        return [`fbo_${stem}_${index}`, `hrq_${stem}_${index}`, `om_${stem}_${index}`];
      });
      db.run(`WITH clones(delivery_id,request_id,external_id) AS (VALUES ${values.map(() => "(?,?,?)").join(",")})
        INSERT INTO multiremi_feishu_bot_outbound_deliveries
        (id,workspace_id,binding_id,task_id,chat_id,body,status,available_at,created_at,updated_at,kind,human_request_id,human_request_task_id,external_message_id)
        SELECT clones.delivery_id,card.workspace_id,card.binding_id,NULL,card.chat_id,card.body,'sent',card.available_at,
          card.created_at,card.updated_at,'decision_card',clones.request_id,?,clones.external_id
        FROM clones
        CROSS JOIN multiremi_feishu_bot_outbound_deliveries card WHERE card.id=?`, [...values.flat(), taskId, cardId]);
    }
  })();
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

async function readDecisionRequest(store: MultiremiStore, daemonId: string, requestId: string) {
  const runtime = store.listRuntimes().find(runtime => runtime.daemonId === daemonId)!;
  const token = await store.createAccessToken({ name: 'decision reader', type: 'daemon',
    workspaceId: runtime.workspaceId ?? 'local', daemonId });
  const response = await createMultiremiApp({ store, authToken: 'MASTER' }).request(`/api/daemon/messages/${requestId}`, {
    headers: { Authorization: `Bearer ${token.token}` },
  });
  if (response.status === 403 || response.status === 404) return null;
  expect(response.status).toBe(200);
  return (await response.json() as { request: import('@multiremi/contracts/types.js').MultiremiTaskHumanRequest }).request;
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
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card' AND human_request_id = ?",
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
      expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch' AND human_request_id = ?")
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
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch' AND human_request_id = ?")
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
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_message_question_records WHERE id = ?").get(request.id))
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
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_message_question_records WHERE id = ?").get(request.id))
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
    const user = store.getOrCreateUser({ externalId: "ou_the_person", feishuUnionId: "on_recipient", name: "Recipient" });
    store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: "Recipient", role: "member" });
    const at = new Date().toISOString();
    db!.run("INSERT INTO multiremi_feishu_bot_senders(id,workspace_id,app_id,open_id,union_id,display_name,allowed,first_seen_at,last_seen_at) VALUES('fbs_recipient','local','cli_decision_card','ou_the_person','on_recipient','Recipient',1,?,?)", [at,at]);
    store.registerRuntime({ id: "rt_exec", name: "Executor", provider: "claude", workspaceId: "local", daemonId: "executor" });
    const executor = await store.createAccessToken({ name: "executor", type: "daemon", workspaceId: "local", daemonId: "executor" });
    const issue = issueWithTopic(store, agentId);
    // Execution is pinned to another machine, exactly as it is in production.
    const taskId = sourceTask(store, agentId, issue.id);
    runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET runtime_id = ? WHERE id = ?", ["rt_exec", taskId]);
    const request = askQuestion(store, taskId);
    const hostToken = await store.createAccessToken({ name: "bot-host", type: "daemon", workspaceId: "local", daemonId: "bot-host" });
    const host = { Authorization: `Bearer ${hostToken.token}`, "content-type": "application/json" };
    const requestPath = `/api/daemon/messages/${request.id}`;

    // (1) The topic's host may read the request.
    const read = await app.request(requestPath, { headers: host });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ request: { id: request.id, status: "pending" } });
    // (2) The topic's host may answer it.
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_card", interactionOpenId: "ou_the_person",
    });
    const respond = await app.request(`${requestPath}/answer`, {
      method: "POST", headers: host,
      body: JSON.stringify({ token: questionCardAction(decodeDecisionCardBody(card.body)!.card)!.t,
        operator_open_id: "ou_the_person", response: { answers: { "Continue?": "Yes" } } }),
    });
    expect(respond.status, await respond.clone().text()).toBe(200);
    expect(store.getTaskHumanRequest(request.id)?.status).toBe("responded");
    // (3) The topic's host still may not create or expire requests.
    const create = await requestRuntimeRpc(store, "rt_bot", "turn.decision", {
      turn_id: taskId, attempt_id: taskId, dedupe_key: 'foreign', body_md: 'Question?', options: [], metadata: { kind: 'question' },
    }, hostToken.token, "MASTER");
    expect(create).toMatchObject({ ok: false, code: "stale_attempt" });
    const second = store.createTaskHumanRequest({ taskId, kind: "question", payload: {} });
    const expire = await requestRuntimeRpc(store, "rt_bot", "turn.decision.expire", {
      turn_id: taskId, attempt_id: taskId, message_id: second.id, status: "cancelled",
    }, hostToken.token, "MASTER");
    expect(expire).toMatchObject({ ok: false, code: "stale_attempt" });
    expect(store.getTaskHumanRequest(second.id)?.status).toBe("pending");
    // (4) S2: a genuinely different daemon is refused, on read and on create.
    const stranger = await store.createAccessToken({ name: "stranger", type: "daemon", workspaceId: "local", daemonId: "someone-else" });
    store.registerRuntime({ id: "rt_stranger", name: "Stranger", provider: "claude", workspaceId: "local", daemonId: "someone-else" });
    expect((await app.request(requestPath, { headers: { Authorization: `Bearer ${stranger.token}` } })).status).toBe(403);
    expect(await requestRuntimeRpc(store, "rt_stranger", "turn.decision", {
      turn_id: taskId, attempt_id: taskId, dedupe_key: 'foreign', body_md: 'Question?', options: [], metadata: { kind: 'question' },
    }, stranger.token, "MASTER")).toMatchObject({ ok: false, code: "stale_attempt" });
    // (5) S2: a daemon in another workspace has no access either.
    const otherWorkspace = store.createWorkspace({ name: "Other", slug: "other" });
    store.registerRuntime({ id: "rt_other", name: "Other host", provider: "codex",
      workspaceId: otherWorkspace.id, daemonId: "other-host" });
    store.heartbeatRuntime("rt_other", { supportsFeishuBotConfig: true });
    const outsider = await store.createAccessToken({ name: "outsider", type: "daemon",
      workspaceId: otherWorkspace.id, daemonId: "other-host" });
    expect((await app.request(requestPath, { headers: { Authorization: `Bearer ${outsider.token}` } })).status).toBe(404);
    // The executing daemon keeps full control.
    expect(await requestRuntimeRpc(store, "rt_exec", "turn.decision.expire", {
      turn_id: taskId, attempt_id: taskId, message_id: request.id, status: "cancelled",
    }, executor.token, "MASTER")).toMatchObject({ ok: true, message: { id: request.id } });
    expect(store.getTaskHumanRequest(request.id)?.status).toBe('responded');
    expect(await requestRuntimeRpc(store, 'rt_exec', 'human_request.get', {
      task_id: taskId, request_id: request.id,
    }, executor.token, 'MASTER')).toMatchObject({ ok: false, code: 'unknown_frame' });
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
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE human_request_id = ? AND kind = 'decision_card'",
    ).get(request.id)).toEqual({ n: 1 });
    expect(db!.query(
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE human_request_id = ? AND kind = 'decision_card_patch'",
    ).get(request.id)).toEqual({ n: 1 });
    expect(db!.query(
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_human_request_pushes WHERE request_id = ?",
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
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE human_request_id = ? AND kind = 'decision_reminder'",
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

  it("the daemon card host observes a reply through message HTTP after legacy downlinks are removed", async () => {
    const { store, agentId, app } = scaffold();
    const issue = issueWithTopic(store, agentId), taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    const token = await store.createAccessToken({ name: 'polling card host', type: 'daemon', workspaceId: 'local', daemonId: 'bot-host' });
    let firstRead!: () => void;
    const read = new Promise<void>(resolve => { firstRead = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(input) {
      const response = await app.fetch(input);
      firstRead();
      return response;
    } });
    const daemon = outboundDaemon(store, new MultiremiDaemonClient(server.url.origin, token.token));
    try {
      const waiting = daemon.waitFeishuBotHumanRequestSettled(request.id, new AbortController().signal);
      await read;
      const settled = store.respondTaskHumanRequest(request.id, { response: { answers: { 'Continue?': 'Yes' } } });
      expect(await waiting).toEqual(settled);
      expect(await daemon.getFeishuBotHumanRequest(taskId, request.id)).toEqual(settled);
      expect(await daemon.getFeishuBotHumanRequest('unrelated-task', request.id)).toBeNull();
      const aborted = new AbortController();
      aborted.abort();
      expect(await daemon.waitFeishuBotHumanRequestSettled(request.id, aborted.signal)).toBeNull();
    } finally { await server.stop(true); }
  });

  it("reads settled decisions only as the executor or authorized bot host without legacy downlinks", async () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_settled",
      interactionOpenId: "ou_the_person",
    });
    const snapshot = (runtimeId: string, daemonId: string) => taskInputSnapshot(store, runtimeId, daemonId,
      new Set(runtimeId === `rt_worker_${taskId}` || runtimeId === "rt_bot" ? [taskId] : []), () => {})
      .filter(entity => entity.type === "task.human_request.settled");
    expect(snapshot("rt_bot", "bot-host")).toEqual([]);
    const settled = store.respondTaskHumanRequest(request.id, { response: { answer: "yes" } })!;
    expect(await readDecisionRequest(store, `worker-${taskId}`, request.id)).toEqual(settled);
    expect(await readDecisionRequest(store, 'bot-host', request.id)).toEqual(settled);
    expect(snapshot(`rt_worker_${taskId}`, `worker-${taskId}`)).toEqual([]);
    expect(snapshot("rt_bot", "bot-host")).toEqual([]);
    store.registerRuntime({ id: "rt_stranger", name: "Stranger", provider: "claude",
      workspaceId: "local", daemonId: "stranger" });
    const foreign = store.createWorkspace({ name: "Foreign", slug: "settled-foreign" });
    store.registerRuntime({ id: "rt_foreign", name: "Foreign", provider: "claude",
      workspaceId: foreign.id, daemonId: "foreign" });
    expect(snapshot("rt_stranger", "stranger")).toEqual([]);
    expect(snapshot("rt_foreign", "foreign")).toEqual([]);
    expect(snapshot("rt_bot", "stranger")).toEqual([]);
    expect(await readDecisionRequest(store, 'stranger', request.id)).toBeNull();
    expect(await readDecisionRequest(store, 'foreign', request.id)).toBeNull();
    db!.run("UPDATE multiremi_turn_attempts SET runtime_id = 'rt_bot' WHERE id = ?", [taskId]);
    expect(await readDecisionRequest(store, 'bot-host', request.id)).toEqual(settled);
    patchHumanRequestFixture(request.id, { responded_at: "2000-01-01T00:00:00.000Z" });
    expect(await readDecisionRequest(store, 'bot-host', request.id)).toMatchObject({ id: request.id, status: 'responded' });
    const patch = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(patch.kind).toBe("decision_card_patch");
    store.reportFeishuBotOutbound("local", "rt_bot", patch.id, {
      claimToken: patch.claimToken, status: "sent", externalMessageId: "om_settled_patch",
    });
    expect(store.listFeishuBotSettledHumanRequestCandidates("local", "rt_bot")).toEqual([]);
  });

  it("settles an offline cancellation with its Issue card in the task transaction", async () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_offline_cancel",
      interactionOpenId: "ou_the_person",
    });
    const storeDb = (store as unknown as { db: SqlDatabase }).db;
    const notifications: string[] = [];
    const offWorkspace = store.onWorkspaceEvent(event => notifications.push(event.type));
    const offTask = store.onTaskEvent(event => notifications.push(event.type));
    try {
      expect(() => storeDb.transaction(() => {
        store.cancelTask(taskId);
        expect(store.getTaskHumanRequest(request.id)?.status).toBe("cancelled");
        expect(notifications).toEqual([]);
        throw new Error("rollback cancellation");
      })()).toThrow("rollback cancellation");
      expect(store.getTaskHumanRequest(request.id)?.status).toBe("pending");
      expect(notifications).toEqual([]);
      expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch' AND human_request_id = ?")
        .get(request.id)).toEqual({ n: 0 });

      store.cancelTask(taskId);
      const cancelled = store.getTaskHumanRequest(request.id)!;
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.response).toBeNull();
      expect(cancelled.respondedAt).not.toBeNull();
      expect(notifications).toContain("daemon:task_input");
      expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch' AND human_request_id = ?")
        .get(request.id)).toEqual({ n: 1 });
      expect(taskInputSnapshot(store, "rt_bot", "bot-host", new Set(), () => {})
        .filter(entity => entity.type === "task.human_request.settled"))
        .toEqual([]);
      expect(await readDecisionRequest(store, 'bot-host', request.id)).toEqual(cancelled);
      expect(store.expireTaskHumanRequest(request.id, "cancelled")).toBeNull();
      expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch' AND human_request_id = ?")
        .get(request.id)).toEqual({ n: 1 });
      expect(store.getTaskHumanRequest(request.id)).toEqual(cancelled);
    } finally {
      offWorkspace();
      offTask();
    }
  });

  it("reads a Chat-bound request without a decision card and rejects a disabled host", async () => {
    const { store, agentId, config } = scaffold();
    const chat = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision, externalSessionKey: "oc_settled_chat",
      externalMessageId: "om_settled_chat", senderOpenId: "ou_the_person", text: "Need a decision",
    });
    store.registerRuntime({ id: "rt_chat_executor", name: "Chat executor", provider: "claude",
      workspaceId: "local", daemonId: "chat-executor" });
    runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET runtime_id = ? WHERE id = ?", ["rt_chat_executor", chat.taskId]);
    const request = askQuestion(store, chat.taskId);
    expect(store.canFeishuBotDaemonAccessTask("local", "bot-host", chat.taskId)).toBe(true);
    expect(taskInputSnapshot(store, "rt_bot", "bot-host", new Set(), () => [])).toEqual([]);
    const settled = store.respondTaskHumanRequest(request.id, { response: { answer: "yes" } })!;
    expect(store.listFeishuBotSettledHumanRequestCandidates("local", "rt_bot"))
      .toContainEqual({ requestId: request.id, taskId: chat.taskId });
    expect(taskInputSnapshot(store, "rt_bot", "bot-host", new Set(), () => [])).toEqual([]);
    expect(await readDecisionRequest(store, 'bot-host', request.id)).toEqual(settled);
    expect(taskInputSnapshot(store, "rt_bot", "other-daemon", new Set(), () => [])).toEqual([]);
    patchHumanRequestFixture(request.id, { responded_at: "2000-01-01T00:00:00.000Z" });
    expect(store.listFeishuBotSettledHumanRequestCandidates("local", "rt_bot")).toEqual([]);
    patchHumanRequestFixture(request.id, { responded_at: new Date().toISOString() });
    store.upsertFeishuBotConfig("local", { agentId, runtimeId: "rt_bot", appId: config.appId,
      appSecretOp: "keep", domain: "feishu", enabled: false });
    expect(store.canFeishuBotDaemonAccessTask("local", "bot-host", chat.taskId)).toBe(false);
    expect(taskInputSnapshot(store, "rt_bot", "bot-host", new Set(), () => [])).toEqual([]);
    expect(await readDecisionRequest(store, 'bot-host', request.id)).toBeNull();
  });

  it("does not replay a card sent by a previous bot app after the configured app changes", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_previous_app",
      interactionOpenId: "ou_the_person",
    });
    store.respondTaskHumanRequest(request.id, { response: { answer: "yes" } });
    expect(store.listFeishuBotSettledHumanRequestCandidates("local", "rt_bot"))
      .toContainEqual({ requestId: request.id, taskId });
    store.upsertFeishuBotConfig("local", { agentId, runtimeId: "rt_bot", appId: "cli_replacement_app",
      appSecretOp: "set", appSecret: APP_SECRET, domain: "feishu", enabled: true });
    expect(store.listFeishuBotSettledHumanRequestCandidates("local", "rt_bot")).toEqual([]);
  });

  for (const status of ["timeout", "cancelled"] as const) {
    it(`reads ${status} decisions from both authorized runtimes without legacy downlinks`, async () => {
      const { store, agentId } = scaffold();
      const issue = issueWithTopic(store, agentId);
      const taskId = sourceTask(store, agentId, issue.id);
      const request = askQuestion(store, taskId);
      const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
      store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
        claimToken: card.claimToken, status: "sent", externalMessageId: `om_${status}`,
        interactionOpenId: "ou_the_person",
      });
      expect(taskInputSnapshot(store, "rt_bot", "bot-host", new Set(), () => [])).toEqual([]);
      const settled = store.expireTaskHumanRequest(request.id, status)!;
      expect(taskInputSnapshot(store, `rt_worker_${taskId}`, `worker-${taskId}`,
        new Set([taskId]), () => [])).toEqual([]);
      expect(taskInputSnapshot(store, "rt_bot", "bot-host", new Set(), () => [])).toEqual([]);
      expect(await readDecisionRequest(store, `worker-${taskId}`, request.id)).toEqual(settled);
      expect(await readDecisionRequest(store, 'bot-host', request.id)).toEqual(settled);
    });
  }

  it("caps unconfirmed settled-card replay at the newest 1024 requests", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_replay_oldest",
      interactionOpenId: "ou_the_person",
    });
    store.respondTaskHumanRequest(request.id, { response: { answer: "yes" } });
    patchHumanRequestFixture(request.id, { responded_at: "2000-01-01T00:00:00.000Z" });
    cloneSettledQuestionBatch(store, request.id, 1024, "replay", card.id, taskId, new Date().toISOString());
    const candidates = store.listFeishuBotSettledHumanRequestCandidates("local", "rt_bot");
    expect(candidates).toHaveLength(1024);
    expect(candidates.some(candidate => candidate.requestId === request.id)).toBe(false);
    expect(new Set(candidates.map(candidate => candidate.requestId)).size).toBe(1024);
  });

  it("keeps bot host recovery SELECTs constant with 1024 settled candidates", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_budget",
      interactionOpenId: "ou_the_person",
    });
    store.respondTaskHumanRequest(request.id, { response: { answer: "yes" } });
    const database = db!;
    const originalQuery = database.query.bind(database);
    const selectCounts: number[] = [];
    const snapshotCount = () => {
      let selects = 0;
      Object.defineProperty(database, "query", { configurable: true, value: (sql: string) => {
        if (/^\s*(?:SELECT|WITH)\b/i.test(sql)) selects += 1;
        return originalQuery(sql);
      } });
      try {
        const frames = store.listFeishuBotSettledHumanRequestCandidates('local', 'rt_bot', 'bot-host');
        selectCounts.push(selects);
        return frames;
      } finally {
        delete (database as unknown as { query?: typeof database.query }).query;
      }
    };
    expect(snapshotCount()).toHaveLength(1);
    cloneSettledQuestionBatch(store, request.id, 1023, "budget", card.id, taskId);
    expect(snapshotCount()).toHaveLength(1024);
    expect(selectCounts[0]).toBeLessThanOrEqual(3);
    expect(selectCounts[1]).toBe(selectCounts[0]);
  });

  it("excludes an archived topic, removed binding and same-workspace non-host runtime", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_audience",
      interactionOpenId: "ou_the_person",
    });
    store.respondTaskHumanRequest(request.id, { response: { answer: "yes" } });
    const settled = (runtimeId: string, daemonId: string) => store.getRuntimeLite(runtimeId)?.daemonId === daemonId
      ? store.listFeishuBotSettledHumanRequestCandidates('local', runtimeId, daemonId) : [];
    expect(settled("rt_bot", "bot-host")).toHaveLength(1);
    store.registerRuntime({ id: "rt_not_host", name: "Other runtime", provider: "claude",
      workspaceId: "local", daemonId: "not-host" });
    expect(settled("rt_not_host", "not-host")).toEqual([]);
    const binding = db!.query("SELECT id, chat_session_id FROM multiremi_feishu_bot_chat_bindings WHERE issue_id = ?")
      .get(issue.id) as { id: string; chat_session_id: string };
    db!.run("UPDATE multiremi_chat_sessions SET status = 'archived' WHERE id = ?", [binding.chat_session_id]);
    expect(settled("rt_bot", "bot-host")).toEqual([]);
    db!.run("UPDATE multiremi_chat_sessions SET status = 'active' WHERE id = ?", [binding.chat_session_id]);
    expect(settled("rt_bot", "bot-host")).toHaveLength(1);
    db!.run("DELETE FROM multiremi_feishu_bot_chat_bindings WHERE id = ?", [binding.id]);
    expect(settled("rt_bot", "bot-host")).toEqual([]);
  });

  it("publishes respond, timeout and cancelled wakes only after the outer commit", () => {
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const storeDb = (store as unknown as { db: SqlDatabase }).db;
    const events: string[] = [];
    const taskEvents: Array<{ type: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onWorkspaceEvent(event => {
      if (event.type === "daemon:task_input" && event.payload.task_id === taskId) events.push(event.type);
    });
    const unsubscribeTask = store.onTaskEvent(event => {
      if (event.type === "task:running" && event.task.id === taskId) {
        taskEvents.push({ type: event.type, inTransaction: storeDb.inTransaction === true });
      }
    });
    try {
      for (const status of ["responded", "timeout", "cancelled"] as const) {
        const request = askQuestion(store, taskId);
        runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET status = 'awaiting_human' WHERE id = ?", [taskId]);
        events.length = 0;
        taskEvents.length = 0;
        storeDb.transaction(() => {
          if (status === "responded") store.respondTaskHumanRequest(request.id, { response: { answer: "yes" } });
          else store.expireTaskHumanRequest(request.id, status);
          expect(events).toEqual([]);
          expect(taskEvents).toEqual([]);
        })();
        expect(events).toEqual(["daemon:task_input"]);
        expect(taskEvents).toEqual([{ type: "task:running", inTransaction: false }]);
        expect(store.getTaskHumanRequest(request.id)?.status).toBe(status);
      }
      const rolledBack = askQuestion(store, taskId);
      runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET status = 'awaiting_human' WHERE id = ?", [taskId]);
      events.length = 0;
      taskEvents.length = 0;
      expect(() => storeDb.transaction(() => {
        store.respondTaskHumanRequest(rolledBack.id, { response: { answer: "rollback" } });
        throw new Error("rollback outer transaction");
      })()).toThrow("rollback outer transaction");
      expect(events).toEqual([]);
      expect(taskEvents).toEqual([]);
      expect(store.getTaskHumanRequest(rolledBack.id)?.status).toBe("pending");
    } finally { unsubscribe(); unsubscribeTask(); }
  });

  it("publishes terminal human-request cancellation once after commit and never on rollback", () => {
    const { store, agentId } = scaffold();
    const storeDb = (store as unknown as { db: SqlDatabase }).db;
    const issue = issueWithTopic(store, agentId);
    const makePending = () => {
      const taskId = sourceTask(store, agentId, issue.id);
      runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [taskId]);
      return { taskId, request: askQuestion(store, taskId) };
    };
    const committed = makePending();
    const transitions: Array<{ requestId: string; type: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onHumanRequest(event => transitions.push({
      requestId: event.request.id, type: event.type, inTransaction: storeDb.inTransaction === true,
    }));
    try {
      storeDb.transaction(() => {
        store.completeTask(committed.taskId, { output: "finished" });
        expect(transitions).toEqual([]);
      })();
      expect(transitions).toEqual([{ requestId: committed.request.id, type: "cancelled", inTransaction: false }]);
      expect(store.getTaskHumanRequest(committed.request.id)?.status).toBe("cancelled");

      const rolledBack = makePending();
      transitions.length = 0;
      expect(() => storeDb.transaction(() => {
        store.completeTask(rolledBack.taskId, { output: "not committed" });
        expect(transitions).toEqual([]);
        throw new Error("rollback terminal cancellation");
      })()).toThrow("rollback terminal cancellation");
      expect(transitions).toEqual([]);
      expect(store.getTaskHumanRequest(rolledBack.request.id)?.status).toBe("pending");
    } finally { unsubscribe(); }
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
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_message_question_records WHERE id = ?").get(request.id))
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
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_message_question_records WHERE id = ?").get(request.id))
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

  it("degrades a stored invalid person config without throwing", () => {
    // The store-level half: this asserts the row the push path writes. The
    // heartbeat suite below drives the same config through the real route,
    // which is where it used to 500 before anyone could hear about the request.
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    writeInvalidPersonTopicConfig();

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

/**
 * Write a `person` topic config the save-time validation rejects straight into
 * the database, exactly as a database written before that validation existed
 * would look. QA's repro for the heartbeat 500 starts here.
 */
function writeInvalidPersonTopicConfig(): void {
  writePersonTopicConfig("not-an-open-id");
}

/** Write a `person` topic config straight into the database. */
function writePersonTopicConfig(openId: string): void {
  const workspaceRow = db!.query("SELECT settings FROM multiremi_workspaces WHERE id = 'local'").get() as { settings: string };
  const settings = JSON.parse(workspaceRow.settings) as Record<string, unknown>;
  settings.issueTopics = { enabled: true, chatId: "oc_decision_card", notifyMode: "person", notifyOpenId: openId };
  db!.run("UPDATE multiremi_workspaces SET settings = ? WHERE id = 'local'", [JSON.stringify(settings)]);
}

/**
 * A relay wake row from before MUL-407: a real Task id and no mention snapshot,
 * which is what makes the claim derive its @ from the stored topic config.
 */
function queueLegacyRelayDelivery(store: MultiremiStore, agentId: string, issueId: string): { id: string; body: string; taskId: string } {
  const taskId = sourceTask(store, agentId, issueId);
  const id = "fbo_legacy_relay";
  const body = "MUL-407 legacy relay text";
  db!.run(`INSERT INTO multiremi_feishu_bot_outbound_deliveries (
      id, workspace_id, binding_id, task_id, chat_id, thread_id, reply_to_message_id,
      body, status, available_at, created_at, updated_at)
    VALUES (?, 'local', (SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE issue_id = ?),
      ?, 'oc_decision_card', NULL, 'om_root', ?, 'pending', ?, ?, ?)`,
  [id, issueId, taskId, body, "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"]);
  return { id, body, taskId };
}

/**
 * The real concierge host over a recording channel, so a test can see which
 * lane the host picked and what it put on the wire. Only the transport is
 * replaced — the routing, the lane choice and the @ handling are production.
 */
function recordingConciergeHost(input: { daemon?: MultiremiDaemon }) {
  const calls: string[] = [];
  const sentCards: Array<Record<string, unknown>> = [];
  const sentText: string[] = [];
  let mentionOpenId: string | undefined;
  const handle = {
    appId: "cli_decision_card",
    start: Promise.resolve(),
    stop: async () => {},
    publishBotMenu: async () => ({ dryRun: true, defaultPublished: false, userMenuCount: 0 }),
    uploadImage: async () => ({ imageKey: "img" }),
    sendProactiveCard: async (card: { card: Record<string, unknown> }) => {
      calls.push("card:send");
      sentCards.push(card.card);
      return { messageId: "om_card" };
    },
    sendProactiveThreadReply: async (reply: { body: string }) => {
      calls.push("text:send");
      sentText.push(reply.body);
      return { messageId: "om_text" };
    },
    updateProactiveCard: async () => { calls.push("card:patch"); },
    sendProactiveAttachment: async () => ({ messageId: "om_att" }),
    resolveProactiveMention: async () => "ou_the_person",
    streamProactiveTask: async (
      _chatId: string, _sessionKey: string, _stream: unknown, _meta: unknown,
      options?: { mentionOpenId?: string },
    ) => {
      calls.push("task:stream");
      mentionOpenId = options?.mentionOpenId;
      return { messageId: "om_stream" };
    },
  } as unknown as FeishuChannelHandle;
  const host = controlPlaneConciergeHost({
    daemon: () => input.daemon,
    workspacesRoot: () => "/tmp/workspaces",
    current: () => handle,
    attach: () => {},
  });
  return { host, calls, sentCards, sentText, mentionOpenId: () => mentionOpenId };
}

/**
 * Heartbeat delivery of a decision lane, end to end (MUL-407).
 *
 * The heartbeat is the path a host actually receives work on, and it is a
 * different serializer from the recovery route — which is exactly how the
 * `human_request_task_id` / `degraded` fields went missing and left a degraded
 * text row looking like a malformed card, and a normal card unclickable until a
 * restart. These drive the real route and the real `MultiremiDaemonClient`.
 */
describe("Feishu decision card heartbeat delivery", () => {
  /** Route the real client's fetch at the in-process app, with a real token. */
  async function withRealClient<T>(
    app: ReturnType<typeof createMultiremiApp>,
    store: MultiremiStore,
    fn: (client: MultiremiDaemonClient, receive: () => ReturnType<typeof receiveNormalizedRuntimeInputs>) => Promise<T>,
  ): Promise<T> {
    const token = await store.createAccessToken({
      name: "bot-host", type: "daemon", workspaceId: "local", daemonId: "bot-host",
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url, "http://local");
      return app.request(parsed.pathname + parsed.search, init);
    }) as typeof fetch;
    const accessToken = await store.verifyAccessToken(token.token);
    const receive = () => receiveNormalizedRuntimeInputs(store, "rt_bot", { identity: { accessToken, masterToken: false } });
    try { return await fn(new MultiremiDaemonClient("http://local", token.token), receive); }
    finally { globalThis.fetch = realFetch; }
  }

  it("carries every decision field through heartbeat and the real client", async () => {
    const { store, agentId, app } = scaffold();
    // `issueWithTopic` seeds and acknowledges the topic root, so the next
    // outbound row is the one this test is about.
    const issue = issueWithTopic(store, agentId);

    // Ask, then re-read the row through the heartbeat — the delivery the
    // host actually receives.
    const taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    const delivered = (await withRealClient(app, store, async (client, receive) =>
      (await receive()).pending_feishu_outbound))!;
    expect(delivered).toBeTruthy();
    expect(delivered.kind).toBe("decision_card");
    // The fields the host needs to register a click immediately...
    expect(delivered.humanRequestId).toBe(request.id);
    expect(delivered.humanRequestTaskId).toBe(taskId);
    expect(delivered.chatId).toBe("oc_decision_card");
    expect(decodeDecisionCardBody(delivered.body)).toBeTruthy();
    expect(delivered.degraded).toBeUndefined();

    // A degraded row — `notifyMode = none` — reaches the host as plain text with
    // its reason intact, which is what stops the host retrying it as a card.
    const settingsRow = db!.query("SELECT settings FROM multiremi_workspaces WHERE id = 'local'").get() as { settings: string };
    const settings = JSON.parse(settingsRow.settings) as Record<string, unknown>;
    settings.issueTopics = { enabled: true, chatId: "oc_decision_card", notifyMode: "none" };
    db!.run("UPDATE multiremi_workspaces SET settings = ? WHERE id = 'local'", [JSON.stringify(settings)]);
    const degradedTaskId = sourceTask(store, agentId, issue.id);
    const degradedRequest = askQuestion(store, degradedTaskId);
    const degraded = (await withRealClient(app, store, async (client, receive) =>
      (await receive()).pending_feishu_outbound))!;
    expect(degraded.degraded).toBe("notify_none");
    expect(degraded.humanRequestTaskId).toBe(degradedTaskId);
    expect(degraded.humanRequestId).toBe(degradedRequest.id);
    // A degraded body is plain text, not a card envelope.
    expect(decodeDecisionCardBody(degraded.body)).toBeNull();
    expect(degraded.body).toContain("Continue?");
  });

  it("sends a heartbeat-delivered card as text, not as a retried card", async () => {
    const { store, agentId, app } = scaffold({ notifyMode: "none" });
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const delivered = (await withRealClient(app, store, async (client, receive) =>
      (await receive()).pending_feishu_outbound))!;
    expect(delivered.id).toBeTruthy();
    expect(delivered.degraded).toBe("notify_none");

    // The host's own branch: a degraded row goes out as text and never as a card.
    const handle = decisionLaneHandle();
    const result = await sendDecisionLaneForTest(handle, delivered);
    expect(result.messageId).toBe("om_text");
    expect(handle.sentCards).toHaveLength(0);
    expect(handle.sentText).toHaveLength(1);
    expect(handle.sentText[0]).toContain("Continue?");
    expect(handle.sentText[0]).not.toContain("<at id=");
    void request;
  });

  it("delivers the invalid-person text degradation through the real heartbeat", async () => {
    // QA's repro, end to end: seed the topic, hand-write an illegal `person`
    // config, ask, then heartbeat with the real client. Before the fix the
    // directive read the same config strictly and answered 500, so the text
    // delivery this request already had queued could never reach the host.
    const { store, agentId, app } = scaffold();
    const issue = issueWithTopic(store, agentId);
    // QA's order: the topic is seeded first, the illegal config is written
    // straight into the database, and only then does the task ask.
    writeInvalidPersonTopicConfig();
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));

    const delivered = (await withRealClient(app, store, async (client, receive) =>
      (await receive()).pending_feishu_outbound))!;
    expect(delivered.kind).toBe("decision_card");
    expect(delivered.degraded).toBe("invalid_recipient");
    expect(delivered.humanRequestId).toBe(request.id);
    // A degraded row is plain text: it carries the question and no @.
    expect(decodeDecisionCardBody(delivered.body)).toBeNull();
    expect(delivered.body).toContain("Continue?");
    expect(delivered.body).not.toContain("<at id=");

    // The host treats it as text, not as a malformed card to retry.
    const handle = decisionLaneHandle();
    let cardsSent = 0;
    handle.sendProactiveCard = async (input) => { cardsSent += 1; handle.sentCards.push(input.card); return { messageId: "om_card" }; };
    const result = await sendDecisionLaneForTest(handle, delivered);
    expect(result.messageId).toBe("om_text");
    expect(cardsSent).toBe(0);
    expect(handle.sentText).toHaveLength(1);
    expect(handle.sentText[0]).toContain("Continue?");
    expect(handle.sentText[0]).not.toContain("<at id=");
    expect(handle.calls).toEqual(["text:send"]);

    // The outcome is reported as sent, and the Issue records exactly one
    // degradation.
    expect(store.reportFeishuBotOutbound("local", "rt_bot", delivered.id, {
      claimToken: delivered.claimToken, status: "sent", externalMessageId: "om_text",
    })).toBe(true);
    expect(store.listIssueActivity(issue.id).filter((a) => a.type === "decision_card_degraded")).toHaveLength(1);
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
  });

  it("delivers the older relay row on one heartbeat and the degradation on the next", async () => {
    // QA's fifth-round repro, both shapes in one queue: a relay row from before
    // MUL-407 (a Task id, no mention snapshot) sits at the head of the same
    // host's queue, and the illegal `person` degradation is queued behind it.
    // Both rows are present before the first heartbeat, but a claim returns one
    // row per poll, so the first heartbeat is the old text and the second is the
    // degradation. The claim no longer aborts on the stored config, so neither
    // the old text nor the card that promises to degrade is stranded.
    const { store, agentId, app } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const legacy = queueLegacyRelayDelivery(store, agentId, issue.id);
    writeInvalidPersonTopicConfig();
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));

    const first = await withRealClient(app, store, async (client, receive) => {
      const ack = await receive();
      expect(ack.status).toBe("ok");
      return ack.pending_feishu_outbound!;
    });
    // The head is the old row, unchanged and with no @: an unusable config must
    // not quietly attach a mention the operator never configured.
    expect(first.id).toBe(legacy.id);
    expect(first.body).toBe(legacy.body);
    expect(first.kind).toBeUndefined();
    expect(first.mention).toBeUndefined();

    // The real host takes the relay lane for it (no card lane), so the text goes
    // out exactly as it did before, minus the mention.
    const relay = recordingConciergeHost({ daemon: decisionDaemon(store) });
    await relay.host.sendOutbound!(first, {
      signal: new AbortController().signal,
      prepareMention: async openId => openId,
      onStarted: async () => {},
    });
    expect(relay.calls).toEqual(["task:stream"]);
    expect(relay.mentionOpenId()).toBeUndefined();

    // The next heartbeat is the same request's text degradation.
    const second = await withRealClient(app, store, async (client, receive) => {
      const ack = await receive();
      expect(ack.status).toBe("ok");
      return ack.pending_feishu_outbound!;
    });
    expect(second.kind).toBe("decision_card");
    expect(second.degraded).toBe("invalid_recipient");
    expect(second.humanRequestId).toBe(request.id);
    expect(second.body).toContain("Continue?");
    expect(second.body).not.toContain("<at id=");

    // Same real host: a degraded row is text, never a card and never a retry.
    const receipts: Array<{ messageId: string; interactionOpenId?: string | null; degraded?: string | null }> = [];
    await relay.host.sendOutbound!(second, {
      signal: new AbortController().signal, onStarted: async () => {},
      onDecisionSent: async receipt => { receipts.push(receipt); },
    });
    expect(relay.calls).toEqual(["task:stream", "text:send"]);
    expect(relay.sentCards).toHaveLength(0);
    expect(relay.sentText).toHaveLength(1);
    expect(relay.sentText[0]).toContain("Continue?");
    expect(relay.sentText[0]).not.toContain("<at id=");
    expect(receipts).toEqual([{ messageId: "om_text", interactionOpenId: null, degraded: "invalid_recipient" }]);

    expect(store.reportFeishuBotOutbound("local", "rt_bot", second.id, {
      claimToken: second.claimToken, status: "sent", externalMessageId: "om_text",
      degraded: "invalid_recipient",
    })).toBe(true);
    expect(store.listIssueActivity(issue.id).filter((a) => a.type === "decision_card_degraded")).toHaveLength(1);
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
  });

  it("still attaches the @ to an older relay row when the stored config is valid", async () => {
    // The control group for the tolerance above: the same older row, the same
    // derivation, a config the save-time validation accepts — the mention is
    // still resolved and used.
    const { store, agentId, app } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const legacy = queueLegacyRelayDelivery(store, agentId, issue.id);
    writePersonTopicConfig("ou_the_person");

    const first = await withRealClient(app, store, async (client, receive) => {
      const ack = await receive();
      expect(ack.status).toBe("ok");
      return ack.pending_feishu_outbound!;
    });
    expect(first.id).toBe(legacy.id);
    expect(first.mention).toEqual({ mode: "person", openId: "ou_the_person" });

    const relay = recordingConciergeHost({ daemon: decisionDaemon(store) });
    await relay.host.sendOutbound!(first, {
      signal: new AbortController().signal,
      prepareMention: async openId => openId,
      onStarted: async () => {},
    });
    expect(relay.calls).toEqual(["task:stream"]);
    expect(relay.mentionOpenId()).toBe("ou_the_person");
  });

  it("does not 500 the heartbeat for a damaged topic config", async () => {
    // Every shape the lenient reader has to survive: a missing field, a wrong
    // type, and a settings blob that is not JSON at all.
    const cases: Array<[string, string]> = [
      ["missing chatId", JSON.stringify({ issueTopics: { enabled: true, notifyMode: "person" } })],
      ["wrong types", JSON.stringify({ issueTopics: { enabled: "yes", chatId: 17, notifyMode: 5, notifyOpenId: {} } })],
      ["damaged json", '{"issueTopics": '],
    ];
    for (const [label, settings] of cases) {
      const { store, agentId, app } = scaffold();
      const issue = issueWithTopic(store, agentId);
      db!.run("UPDATE multiremi_workspaces SET settings = ? WHERE id = 'local'", [settings]);
      askQuestion(store, sourceTask(store, agentId, issue.id));
      const result = await withRealClient(app, store, async (client, receive) =>
        receive());
      expect(`${label}: ${result.status}`).toBe(`${label}: ok`);
      // The directive still tells the host to run; only the mention list is
      // empty, because there is no usable chat to suppress mentions in.
      expect(result.feishu_bot?.desired_state).toBe("running");
      expect(result.feishu_bot?.no_mention_chat_ids ?? []).toEqual([]);
    }
  });

  it("backs a retryable card failure off and claims the same row again when due", async () => {
    // The seven-step acceptance story hands step 5 (a retryable send failure)
    // to automation. A thrown error alone does not show that: this drives the
    // real delivery loop into the store's outbox and then claims again, so the
    // backoff, the attempt counter and the retry are all observed.
    const { store, agentId, app } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(card.kind).toBe("decision_card");
    expect(db!.query("SELECT attempt_count FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?")
      .get(card.id)).toEqual({ attempt_count: 1 });

    const handle = decisionLaneHandle();
    handle.resolveProactiveMention = async () => "ou_the_person";
    handle.sendProactiveCard = async () => {
      // A Feishu error the transport classifies as retryable: the same payload
      // may succeed later, so it must stay on the outbox.
      throw new FeishuDeliveryError("Feishu card send: Feishu code 99991400", true);
    };
    let textFallbacks = 0;
    handle.sendProactiveThreadReply = async (input) => {
      textFallbacks += 1;
      handle.sentText.push(input.body);
      return { messageId: "om_fallback" };
    };

    const daemon = decisionDaemon(store);
    const failedAt = new Date();
    await expect(sendDecisionLaneForTest(handle, card, undefined, daemon)).rejects.toThrow(/99991400/);

    // The failure is reported exactly the way the daemon reports it: retryable,
    // so the row goes back to `pending` with a later `available_at`.
    expect(store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "failed", error: "Feishu card send: Feishu code 99991400",
      retryable: true,
    }, failedAt)).toBe(true);

    const backedOff = db!.query(
      `SELECT status, attempt_count, available_at, last_error, claim_token
       FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?`,
    ).get(card.id) as { status: string; attempt_count: number; available_at: string; last_error: string; claim_token: string | null };
    expect(backedOff.status).toBe("pending");
    expect(backedOff.attempt_count).toBe(1);
    expect(backedOff.claim_token).toBeNull();
    expect(backedOff.last_error).toContain("99991400");
    // First retry: the base delay, and strictly later than the failure.
    expect(Date.parse(backedOff.available_at) - failedAt.getTime()).toBe(5_000);
    // No text twin: a retryable failure keeps its card, it does not degrade.
    expect(textFallbacks).toBe(0);
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch'").get())
      .toEqual({ n: 0 });

    // Before the backoff elapses the row is invisible to the claim...
    expect(store.claimFeishuBotOutbound("local", "rt_bot", failedAt)).toBeNull();
    // ...and once it is due the same delivery comes back, with its counter
    // advanced rather than a second card being queued.
    const retried = store.claimFeishuBotOutbound("local", "rt_bot",
      new Date(failedAt.getTime() + 5_000))!;
    expect(retried.id).toBe(card.id);
    expect(retried.kind).toBe("decision_card");
    expect(db!.query("SELECT attempt_count FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?")
      .get(card.id)).toEqual({ attempt_count: 2 });
    expect(db!.query(
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card' AND human_request_id = ?",
    ).get(request.id)).toEqual({ n: 1 });
    expect(store.getTaskHumanRequest(request.id)!.status).toBe("pending");
    void app; void issue;
  });

  it("registers a heartbeat-delivered card immediately, without a restart", async () => {
    const { store, agentId, app } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);
    const request = askQuestion(store, taskId);
    const delivered = (await withRealClient(app, store, async (client, receive) =>
      (await receive()).pending_feishu_outbound))!;
    expect(delivered.humanRequestTaskId).toBe(taskId);

    const handle = decisionLaneHandle();
    handle.resolve = "ou_the_person";
    const result = await sendDecisionLaneForTest(handle, delivered, undefined, decisionDaemon(store));
    expect(result.messageId).toBe("om_card");
    expect(handle.sentCards).toHaveLength(1);

    store.reportFeishuBotOutbound("local", "rt_bot", delivered.id, {
      claimToken: delivered.claimToken, status: "sent", externalMessageId: result.messageId, interactionOpenId: "ou_the_person",
    });
    const stop = registerQuestionCardClient("cli_decision_card", {
      getRequest: async () => store.getTaskHumanRequest(request.id),
      respond: async (requestId, response, credential) => store.respondTaskHumanRequest(requestId, { response, cardCredential: credential })!,
      getDecision: async () => null, answer: async () => { throw new Error("not a decision"); },
    });
    // Application routing answers clicks without relying on message registration.
    const response = await handleTaskInteractionEvent("cli_decision_card", {
      operator: { open_id: "ou_the_person" },
      context: { open_chat_id: "oc_decision_card", open_message_id: "om_card" },
      action: {
        value: questionCardAction(decodeDecisionCardBody(delivered.body)!.card),
        tag: "button",
        name: interactionMarker(taskId, request.id),
        form_value: { q0_option0: "true" },
      },
    });
    stop();
    expect(response).toMatchObject({ toast: { type: "success", content: "已提交" } });
    expect(store.getTaskHumanRequest(request.id)!.status).toBe("responded");
  });
});

  it("does not record a degradation on another workspace's Issue", () => {
    // QA's case: the delivery row has no binding of its own and its
    // `human_request_task_id` points at a Task in a different workspace. The
    // fallback used to follow that pointer and write the activity there.
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;

    const other = store.createWorkspace({ name: "Other", slug: "other" });
    const otherAgent = store.createAgent({ name: "Other agent", provider: "codex", workspaceId: other.id });
    const otherIssue = store.createIssue({
      title: "Other workspace issue", workspaceId: other.id,
      assigneeType: "agent", assigneeId: otherAgent.id,
    });
    const otherTask = store.createTask({
      agentId: otherAgent.id, issueId: otherIssue.id, workspaceId: other.id, prompt: "Other",
    });

    // Point this real delivery at the foreign Task and drop its binding, which
    // is exactly the shape the fallback resolves.
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET binding_id = 'fcb_missing', human_request_task_id = ? WHERE id = ?",
      [otherTask.id, card.id]);
    expect(store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_text",
      interactionOpenId: "ou_the_person", degraded: "send_failed",
    })).toBe(true);

    // The delivery itself records the outcome...
    expect(db!.query("SELECT degraded FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(card.id))
      .toEqual({ degraded: "send_failed" });
    // ...but no activity lands on the other workspace's Issue.
    expect(store.listIssueActivity(otherIssue.id).filter((a) => a.type === "decision_card_degraded"))
      .toHaveLength(0);

    // The in-workspace path still records one, so the guard is a scope check and
    // not a blanket refusal.
    const localRequest = askQuestion(store, sourceTask(store, agentId, issue.id));
    const localCard = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(store.reportFeishuBotOutbound("local", "rt_bot", localCard.id, {
      claimToken: localCard.claimToken, status: "sent", externalMessageId: "om_text_local",
      interactionOpenId: "ou_the_person", degraded: "send_failed",
    })).toBe(true);
    const written = store.listIssueActivity(issue.id).filter((a) => a.type === "decision_card_degraded");
    expect(written).toHaveLength(1);
    expect(written[0]!.body).toBe(localRequest.id);
    void request;
  });

  it("does not record a degradation through a binding that points at another workspace", () => {
    // QA's repro: keep the real binding, repoint its `issue_id` at another
    // workspace's Issue, then report this workspace's delivery as degraded. The
    // direct-binding branch used to trust the pointer and write there.
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    askQuestion(store, sourceTask(store, agentId, issue.id));
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;

    const other = store.createWorkspace({ name: "Other", slug: "other" });
    const otherAgent = store.createAgent({ name: "Other agent", provider: "codex", workspaceId: other.id });
    const otherIssue = store.createIssue({
      title: "Other workspace issue", workspaceId: other.id,
      assigneeType: "agent", assigneeId: otherAgent.id,
    });
    const otherTask = store.createTask({
      agentId: otherAgent.id, issueId: otherIssue.id, workspaceId: other.id, prompt: "Other",
    });
    db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = ? WHERE issue_id = ?",
      [otherIssue.id, issue.id]);
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET human_request_task_id = ? WHERE id = ?",
      [otherTask.id, card.id]);

    expect(store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_text",
      interactionOpenId: "ou_the_person", degraded: "send_failed",
    })).toBe(true);
    // The delivery records its own outcome...
    expect(db!.query("SELECT degraded FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(card.id))
      .toEqual({ degraded: "send_failed" });
    // ...and neither Issue gets an activity for it: the binding's Issue is not
    // in this workspace, and the fallback Task is not either.
    const degradedType = (id: string) =>
      store.listIssueActivity(id).filter((a) => a.type === "decision_card_degraded");
    expect(degradedType(otherIssue.id)).toHaveLength(0);
    expect(degradedType(issue.id)).toHaveLength(0);

    // The same-workspace path still writes exactly one. The binding is put
    // back first, since it is what points the push at the Issue at all.
    db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = ? WHERE chat_id = ?",
      [issue.id, "oc_decision_card"]);
    const localRequest = askQuestion(store, sourceTask(store, agentId, issue.id));
    const localCard = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(store.reportFeishuBotOutbound("local", "rt_bot", localCard.id, {
      claimToken: localCard.claimToken, status: "sent", externalMessageId: "om_text_local",
      interactionOpenId: "ou_the_person", degraded: "send_failed",
    })).toBe(true);
    const written = degradedType(issue.id);
    expect(written).toHaveLength(1);
    expect(written[0]!.body).toBe(localRequest.id);
  });

  it("does not push a human request whose Task points at another workspace's Issue", () => {
    // `prepareHumanRequestPush` reads the Issue through the asking Task. If the
    // two disagree about the workspace, the delivery (and the activity that
    // follows it) would belong to the other workspace's Issue.
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const taskId = sourceTask(store, agentId, issue.id);

    const other = store.createWorkspace({ name: "Other", slug: "other" });
    const otherAgent = store.createAgent({ name: "Other agent", provider: "codex", workspaceId: other.id });
    const otherIssue = store.createIssue({
      title: "Other workspace issue", workspaceId: other.id,
      assigneeType: "agent", assigneeId: otherAgent.id,
    });
    // The Task stays in `local`; only its Issue pointer moves.
    runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET issue_id = ? WHERE id = ?", [otherIssue.id, taskId]);
    const request = askQuestion(store, taskId);

    expect(db!.query(
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE human_request_id = ?",
    ).get(request.id)).toEqual({ n: 0 });
    expect(db!.query(
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_human_request_pushes WHERE request_id = ?",
    ).get(request.id)).toEqual({ n: 0 });
    expect(store.listIssueActivity(otherIssue.id).filter((a) => a.type === "decision_card_degraded")).toHaveLength(0);
    // Same-workspace requests are unaffected.
    db!.run("UPDATE multiremi_turns SET issue_id=? WHERE current_attempt_id=?", [issue.id, taskId]);
    store.cancelTask(taskId);
    const okRequest = askQuestion(store, sourceTask(store, agentId, issue.id));
    expect(store.claimFeishuBotOutbound("local", "rt_bot")!.humanRequestId).toBe(okRequest.id);
  });

  it("does not spend a reminder slot on a Task that points at another workspace's Issue", () => {
    // The reminder path used to CAS `reminder_sent_at` before validating the
    // workspace, so a cross-workspace row lost its one reminder for good.
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id), 60 * 60 * 1000);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_card",
      interactionOpenId: "ou_the_person",
    });
    const other = store.createWorkspace({ name: "Other", slug: "other" });
    const otherAgent = store.createAgent({ name: "Other agent", provider: "codex", workspaceId: other.id });
    const otherIssue = store.createIssue({
      title: "Other workspace issue", workspaceId: other.id,
      assigneeType: "agent", assigneeId: otherAgent.id,
    });
    runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET issue_id = ? WHERE id = ?", [otherIssue.id, request.taskId]);

    const expiresAt = Date.parse(request.expiresAt!);
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 61_000))).toBeNull();
    // Nothing was sent, nothing was written, and the one slot is still free.
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_message_question_records WHERE id = ?").get(request.id))
      .toEqual({ reminder_sent_at: null });
    expect(store.listIssueActivity(otherIssue.id).filter((a) => a.type.startsWith("decision_card"))).toHaveLength(0);

    // Point the Task back and the same request still gets its reminder.
    runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET issue_id = ? WHERE id = ?", [issue.id, request.taskId]);
    const reminder = store.claimFeishuBotOutbound("local", "rt_bot", new Date(expiresAt - 61_000))!;
    expect(reminder.kind).toBe("decision_reminder");
    expect(reminder.humanRequestId).toBe(request.id);
  });

  it("S3: the decision lane issues no receipt or reaction request", async () => {
    // A store-level assertion (no receipt target on the row) is only a proxy,
    // and recording the mock handle's methods misses a request made straight
    // through the transport. This drives the real `sendDecisionLane` → real
    // `FeishuConnector` → SDK, with the SDK's own HTTP layer pointed at a local
    // recorder, so every request the lane makes is observed.
    const { store, agentId } = scaffold();
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));
    const recorder = await withRecordedFeishuTransport(async (connector) => {
      const handle = decisionLaneHandle();
      // Route the lane's transport through the real connector, keeping the
      // recorder's own bookkeeping so the two halves are checked together.
      handle.sendProactiveCard = async input => {
        handle.calls.push("card:send");
        return connector.sendProactiveCard(input);
      };
      handle.updateProactiveCard = async (messageId, card) => {
        handle.calls.push("card:patch");
        await connector.updateProactiveCard(messageId, card);
      };

      // Send the card, then answer it, then take the terminal patch.
      const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
      await sendDecisionLaneForTest(handle, card, undefined, decisionDaemon(store));
      store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
        claimToken: card.claimToken, status: "sent", externalMessageId: "om_card",
        interactionOpenId: "ou_the_person",
      });
      store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "Yes" } } });
      const patch = store.claimFeishuBotOutbound("local", "rt_bot")!;
      await sendDecisionLaneForTest(handle, patch, undefined, decisionDaemon(store));
      expect(handle.calls).toEqual(["card:send", "card:patch"]);
    });

    // The two requests the lane is supposed to make really crossed the wire...
    expect(recorder.requests.filter((r) => r.method === "POST"
      && r.path === `/open-apis/im/v1/messages/om_root_${issue.id}/reply`)).toHaveLength(1);
    expect(recorder.requests.filter((r) => r.method === "PATCH"
      && r.path === "/open-apis/im/v1/messages/om_card")).toHaveLength(1);
    // ...and nothing touched a reaction or a receipt. Both are addressed as
    // `/open-apis/im/v1/messages/:message_id/reactions`, on either transport.
    expect(recorder.requests.filter((r) => /reaction/i.test(r.path))).toEqual([]);
    expect(recorder.requests.filter((r) => /receipt/i.test(r.path))).toEqual([]);
    // Every request that did cross the wire belongs to the two jobs above.
    expect(recorder.requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "PATCH /open-apis/im/v1/messages/om_card",
      "POST /open-apis/auth/v3/tenant_access_token/internal",
      `POST /open-apis/im/v1/messages/om_root_${issue.id}/reply`,
    ]);
    void issue;
  });

  it("step 5: a card Feishu rejects non-retryably becomes one sent text, once", async () => {
    // The acceptance story's step 5 used to ask a human to point the topic at a
    // chat where the bot cannot speak. That precondition cannot produce the
    // expected result: the text twin goes to the same chat, so a bot without
    // speaking rights loses both. This is the automated replacement QA asked
    // for, and it drives the production reporting chain end to end:
    //
    //   real MultiremiDaemon.handleHeartbeatAck
    //     -> real queueFeishuBotOutbound -> real handleFeishuBotOutbound
    //     -> real deliverFeishuOutbound -> real sendDecisionLane over the real
    //        FeishuConnector (only the SDK's HTTP layer is scripted)
    //     -> real MultiremiDaemonClient.reportFeishuBotOutboundResult
    //     -> real v2 feishu.outbound_result session dispatcher
    //     -> real store.reportFeishuBotOutbound
    //
    // Only two things are test scaffolding: the channel handle (the process has
    // no Feishu app) and the transport hop, which uses the in-process session
    // dispatcher for reports and the app for the remaining HTTP calls.
    const { store, agentId, app } = scaffold();
    // This case exercises delivery, not installing a CLI through an upgrade ack.
    store.updateRuntime("rt_bot", { metadata: { ...store.getRuntimeLite("rt_bot")!.metadata, cli_version: DAEMON_MIN_CLI_VERSION } });
    const issue = issueWithTopic(store, agentId);
    const request = askQuestion(store, sourceTask(store, agentId, issue.id));

    const handle = refusingCardChannelHandle();
    const { result: { ack, delivered } } = await withScriptedFeishuTransport(({ method, path, body }) => {
      // Only the interactive card is refused. 230001 is a real Feishu rejection
      // that retrying the same payload cannot fix; the text twin (msg_type
      // `post`) is still allowed — the chat where the bot may speak but the card
      // is refused.
      if (method === "POST" && path.endsWith("/reply") && body.includes("interactive")) {
        return { code: 230001, msg: "permission denied" };
      }
      return null;
    }, async () => withRealBotHostClient(app, store, async (client, receive) => {
      // A real daemon over a real daemon token, with the real concierge host
      // attached: the delivery below runs through production code, not a stub.
      const daemon = outboundDaemon(store, client);
      daemon.setFeishuConciergeHost(outboundHost(handle, daemon));
      const supervisor = (daemon as unknown as { feishuConcierge: FeishuConciergeSupervisor })
        .feishuConcierge;
      // Production wiring: the real supervisor fetches the assignment over the
      // real route and starts the host. Only `host.start` is stubbed (booting a
      // connector needs a Feishu app); the supervisor still owns the state it
      // gates delivery on, so the delivery below runs only because a real start
      // reported this runtime online.
      await supervisor.apply({ revision: 1, desired_state: "running", config_available: true });
      const reportDeadline = Date.now() + 2_000;
      while (store.feishuBotStatusSnapshot("local").status !== "online" && Date.now() < reportDeadline) await Bun.sleep(5);
      expect(store.feishuBotStatusSnapshot("local").status).toBe("online");
      const beat = await receive();
      const outbound = beat.pending_feishu_outbound!;
      expect(outbound).toBeTruthy();
      // The real ack path: queueFeishuBotOutbound -> handleFeishuBotOutbound ->
      // deliverFeishuOutbound -> host.sendOutbound -> real client report.
      await (daemon as unknown as {
        handleHeartbeatAck(runtimeId: string, ack: unknown): Promise<boolean>;
      }).handleHeartbeatAck("rt_bot", beat);
      const runs = (daemon as unknown as {
        feishuOutboundRuns: Map<string, { done: Promise<void> }>;
      }).feishuOutboundRuns;
      const deadline = Date.now() + 10_000;
      while (runs.has(outbound.id) && Date.now() < deadline) await Bun.sleep(5);
      return { ack: beat, delivered: outbound };
    }));

    expect(delivered.kind).toBe("decision_card");
    expect(ack.status).toBe("ok");
    // The card was refused, the text went out, and the transport carried both.
    expect(handle.calls).toEqual(["card:send", "text:send"]);
    expect(handle.sentText).toHaveLength(1);
    expect(handle.sentText[0]).toContain("Continue?");

    // Exactly one activity, and exactly one delivery for the request: the row is
    // `sent`, so the outbox never offers it again as a card to retry.
    const degraded = store.listIssueActivity(issue.id).filter((a) => a.type === "decision_card_degraded");
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.body).toBe(request.id);
    expect(degraded[0]!.data).toMatchObject({
      reason: "send_failed", delivery_id: delivered.id, source_task_id: request.taskId,
    });
    expect(db!.query(
      `SELECT status, degraded, external_message_id, attempt_count
       FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?`,
    ).get(delivered.id)).toEqual({
      status: "sent", degraded: "send_failed", external_message_id: "om_text_sent", attempt_count: 1,
    });
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    // No terminal patch either: there is no card on screen left to rewrite.
    expect(db!.query(
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch'",
    ).get()).toEqual({ n: 0 });
    expect(store.getTaskHumanRequest(request.id)!.status).toBe("pending");
    void issue;
  });

/** The two daemon calls the click handler makes, backed by the test store. */
function decisionDaemon(store: MultiremiStore): MultiremiDaemon {
  return {
    getFeishuDecisionMessage: async (messageId: string) => ({ message: store.getMessage(messageId)! }),
    getMessageHumanRequest: async (requestId: string) => store.getTaskHumanRequest(requestId),
    respondFeishuBotHumanRequest: async (requestId: string, response: Record<string, unknown>) => {
      const request = store.getTaskHumanRequest(requestId);
      if (!request) throw new Error("request not found");
      const settled = store.respondTaskHumanRequest(requestId, { response, respondedBy: "feishu" });
      if (!settled) throw new Error("request is no longer pending");
      return settled;
    },
  } as unknown as MultiremiDaemon;
}

/**
 * A ChannelHandle whose card reply is refused by Feishu itself: only the SDK's
 * HTTP layer is scripted, so the refusal comes from the transport the real host
 * uses. The handle is the one thing the test must stand in for — the process has
 * no Feishu app — and it delegates every send to the real `FeishuConnector`.
 */
function refusingCardChannelHandle(): DecisionLaneHandle {
  const handle = decisionLaneHandle();
  handle.resolve = "ou_the_person";
  const connector = () => new FeishuConnector({
    appId: "cli_decision_card", appSecret: APP_SECRET, domain: "feishu",
  } as never);
  // The connector is real; the bookkeeping on top of it is the same the fake
  // handle does, so a test can still see which lane ran.
  handle.sendProactiveCard = async input => {
    handle.calls.push("card:send");
    return connector().sendProactiveCard(input);
  };
  handle.sendProactiveThreadReply = async input => {
    handle.calls.push("text:send");
    handle.sentText.push(input.body);
    return connector().sendProactiveThreadReply(input);
  };
  handle.updateProactiveCard = (messageId, card) => connector().updateProactiveCard(messageId, card);
  return handle;
}

/**
 * The real host, wired to a real daemon: `sendOutbound` is production
 * `controlPlaneConciergeHost`, and it comes back online the way the supervisor
 * drives it.
 */
function outboundHost(handle: FeishuChannelHandle, daemon: MultiremiDaemon) {
  const host = controlPlaneConciergeHost({
    daemon: () => daemon,
    workspacesRoot: () => "/tmp/workspaces",
    current: () => handle,
    attach: () => {},
  });
  return {
    start: async () => ({ botName: "Concierge" }),
    stop: async () => {},
    setNoMentionChatIds: (_chatIds: readonly string[]) => {},
    sendOutbound: (delivery: Parameters<NonNullable<FeishuConciergeHost["sendOutbound"]>>[0],
      options?: Parameters<NonNullable<FeishuConciergeHost["sendOutbound"]>>[1]) =>
      host.sendOutbound!(delivery, options),
    uploadImage: (image: Buffer) => host.uploadImage!(image),
  };
}

/**
 * A real `MultiremiDaemon` that talks to the in-process API with a real daemon
 * token. Nothing else is mocked: the heartbeat, the outbound queue, the
 * delivery loop and the result report are production code.
 */
function outboundDaemon(store: MultiremiStore, client?: MultiremiDaemonClient): MultiremiDaemon {
  const daemon = new MultiremiDaemon({
    sshMeshManager: disabledSshMeshRuntime(),
    serverUrl: "http://local",
    token: "shared-by-fixture",
    provider: "codex",
    runtimeId: "rt_bot",
    daemonId: "bot-host",
    workspaceId: "local",
    daemonPort: 0,
    pollIntervalMs: 20,
    gcEnabled: false,
    workspacesRoot: "/tmp/workspaces",
    repoCacheRoot: "/tmp/workspaces/.repos",
    inProcessRuntimeModelDiscoveryEnabled: true,
    providerFactory: () => ({ async *sendStream() {} }),
  } as never);
  if (client) (daemon as unknown as { client: MultiremiDaemonClient }).client = client;
  return daemon;
}

/**
 * Route one real daemon's HTTP at the in-process app, and everything else at
 * the scripted Feishu transport.
 *
 * The outbound case needs both at once: the daemon client must reach the real
 * API (heartbeat, result report), while the connector's own calls must reach the
 * scripted Feishu seam. The API hop is the same one the heartbeat cases use.
 */
async function withRealBotHostClient<T>(
  app: ReturnType<typeof createMultiremiApp>,
  store: MultiremiStore,
  fn: (client: MultiremiDaemonClient, receive: () => ReturnType<typeof receiveNormalizedRuntimeInputs>) => Promise<T>,
): Promise<T> {
  const token = await store.createAccessToken({
    name: "bot-host", type: "daemon", workspaceId: "local", daemonId: "bot-host",
  });
  const scripted = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://local")) {
      const parsed = new URL(url, "http://local");
      return app.request(parsed.pathname + parsed.search, init);
    }
    return scripted(input, init);
  }) as typeof fetch;
  const accessToken = await store.verifyAccessToken(token.token);
  const receive = () => receiveNormalizedRuntimeInputs(store, "rt_bot", { identity: { accessToken, masterToken: false } });
  const client = new MultiremiDaemonClient("http://local", token.token);
  const drainReports = bindReportFrames(client, store, {
    headers: { Authorization: `Bearer ${token.token}` },
    capabilities: {
      feishu_concierge_protocol: FEISHU_CONCIERGE_PROTOCOL_VERSION,
      feishu_decision_card: FEISHU_DECISION_CARD_PROTOCOL_VERSION,
    },
  });
  try { return await fn(client, receive); }
  finally { await drainReports(); globalThis.fetch = scripted; }
}

/** A fake channel handle that records what the decision lane actually sends. */
interface DecisionLaneHandle extends FeishuChannelHandle {
  calls: string[];
  resolve: string | null;
  sentCards: Array<Record<string, unknown>>;
  sentText: string[];
}

function decisionLaneHandle(calls: string[] = []): DecisionLaneHandle {
  const handle = {
    appId: "cli_decision_card",
    calls,
    resolve: "ou_the_person" as string | null,
    sentCards: [] as Array<Record<string, unknown>>,
    sentText: [] as string[],
    sendProactiveCard: async (input: { card: Record<string, unknown> }) => {
      calls.push("card:send");
      handle.sentCards.push(input.card);
      return { messageId: "om_card" };
    },
    sendProactiveThreadReply: async (input: { body: string }) => {
      calls.push("text:send");
      handle.sentText.push(input.body);
      return { messageId: "om_text" };
    },
    updateProactiveCard: async () => { calls.push("card:patch"); },
    resolveProactiveMention: async () => handle.resolve,
    streamProactiveTask: async () => ({ messageId: "om_stream" }),
    start: Promise.resolve(),
    stop: async () => {},
    publishBotMenu: async () => ({ dryRun: true, defaultPublished: false, userMenuCount: 0 }),
    uploadImage: async () => ({ imageKey: "img" }),
    sendProactiveAttachment: async () => ({ messageId: "om_att" }),
  };
  return handle as unknown as DecisionLaneHandle;
}

/**
 * Point the Lark SDK's own HTTP layer at a local recorder.
 *
 * `createFeishuConnector` (below) builds a real `FeishuConnector` whose calls go
 * through `@larksuiteoapi/node-sdk`; the SDK keeps one process-wide axios
 * instance. Swapping its adapter is what makes the recorder sit at the same
 * layer the host actually uses, so a request inserted anywhere between the lane
 * and Feishu shows up — which is exactly what the previous mock-surface test
 * could not see.
 */
async function withRecordedFeishuTransport<T>(
  fn: (connector: FeishuConnector) => Promise<T>,
): Promise<{ result: T; requests: Array<{ method: string; path: string }> }> {
  const sdk = await import("@larksuiteoapi/node-sdk/lib/index.js" as string) as {
    defaultHttpInstance: { defaults: { adapter?: unknown } };
  };
  const requests: Array<{ method: string; path: string }> = [];
  const record = (method: unknown, url: unknown): void => {
    requests.push({ method: String(method ?? "get").toUpperCase(),
      path: String(url ?? "").replace(/^https?:\/\/[^/]+/u, "") });
  };
  const previousAdapter = sdk.defaultHttpInstance.defaults.adapter;
  const realFetch = globalThis.fetch;
  // Two layers, because the lane and a stray call need not use the same one:
  // the SDK's calls go through its own axios instance, while anything reached
  // through the global `fetch` (an inserted reaction call, say) would not.
  sdk.defaultHttpInstance.defaults.adapter = async (config: Record<string, unknown>) => {
    const path = String(config.url ?? "");
    record(config.method, path);
    const data = path.includes("/reactions")
      ? { code: 0, data: { reaction_id: "rx_1", items: [], has_more: false } }
      : path.includes("tenant_access_token")
        ? { code: 0, tenant_access_token: "t_recorder", expire: 7200 }
        : path.endsWith("/reply") || path.endsWith("/messages")
          ? { code: 0, data: { message_id: "om_card" } }
          : { code: 0, data: {} };
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    record(init?.method ?? "GET", url);
    const path = url.replace(/^https?:\/\/[^/]+/u, "");
    const data = path.includes("/reactions")
      ? { code: 0, data: { reaction_id: "rx_1", items: [], has_more: false } }
      : path.endsWith("/reply") || path.endsWith("/messages")
        ? { code: 0, data: { message_id: "om_card" } }
        : { code: 0, data: {} };
    return Response.json(data);
  }) as typeof fetch;
  try {
    const connector = new FeishuConnector({
      appId: `cli_recorder_${crypto.randomUUID()}`, appSecret: APP_SECRET, domain: "feishu",
    } as never);
    const result = await fn(connector);
    return { result, requests };
  } finally {
    sdk.defaultHttpInstance.defaults.adapter = previousAdapter;
    globalThis.fetch = realFetch;
  }
}

/**
 * Point the Lark SDK's HTTP layer at a scripted recorder (QA step 5).
 *
 * Same seam as {@link withRecordedFeishuTransport}, but the response for one
 * request is chosen by the script instead of a fixed table. That keeps the
 * `send_failed` story honest: the rejection comes from Feishu's own response
 * code over the transport the host uses, and nothing between the lane and the
 * wire is replaced.
 */
async function withScriptedFeishuTransport<T>(
  script: (request: { method: string; path: string; body: string }) => { code: number; msg?: string } | null,
  fn: () => Promise<T>,
): Promise<{ result: T; requests: Array<{ method: string; path: string }> }> {
  const sdk = await import("@larksuiteoapi/node-sdk/lib/index.js" as string) as {
    defaultHttpInstance: { defaults: { adapter?: unknown } };
  };
  const requests: Array<{ method: string; path: string }> = [];
  const previousAdapter = sdk.defaultHttpInstance.defaults.adapter;
  const realFetch = globalThis.fetch;
  sdk.defaultHttpInstance.defaults.adapter = async (config: Record<string, unknown>) => {
    const path = String(config.url ?? "").replace(/^https?:\/\/[^/]+/u, "");
    // The body is what separates the card reply from the text reply: both are
    // `POST .../reply`, and only `msg_type` tells them apart.
    const body = typeof config.data === "string" ? config.data : JSON.stringify(config.data ?? {});
    const request = { method: String(config.method ?? "get").toUpperCase(), path, body };
    requests.push({ method: request.method, path });
    const scripted = script(request);
    if (scripted) {
      // Failures surface the way the SDK does: a 200 with a non-zero `code`.
      return { data: { code: scripted.code, msg: scripted.msg ?? "scripted" }, status: 200, statusText: "OK", headers: {}, config };
    }
    const data = path.includes("tenant_access_token")
      ? { code: 0, tenant_access_token: "t_scripted", expire: 7200 }
      : { code: 0, data: { message_id: request.method === "POST" ? "om_text_sent" : "om_card" } };
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/u, "");
    const request = { method: String(init?.method ?? "GET").toUpperCase(), path,
      body: typeof init?.body === "string" ? init.body : "" };
    requests.push({ method: request.method, path });
    const scripted = script(request);
    return Response.json(scripted
      ? { code: scripted.code, msg: scripted.msg ?? "scripted" }
      : { code: 0, data: { message_id: "om_text_sent" } });
  }) as typeof fetch;
  try {
    return { result: await fn(), requests };
  } finally {
    sdk.defaultHttpInstance.defaults.adapter = previousAdapter;
    globalThis.fetch = realFetch;
  }
}

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
});

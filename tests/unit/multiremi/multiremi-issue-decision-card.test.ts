import { createResponsibleTestIssue } from './helpers.js';
import { runTurnExecutionMutation } from '@multiremi/store/turn-execution-records.js';
import type { SqlDatabase as UnifiedFixtureDatabase } from '@multiremi/store/db/postgres.js';
/**
 * MUL-412 (parent MUL-400 S5b / E4 x E5): an E4 decision that is handed to a
 * person becomes a card in the Issue topic's Feishu thread, answered there,
 * and rewritten in place when it settles.
 *
 * The suite is split the way the acceptance criteria are: who gets a card and
 * when, what a click may and may not do, the in-place terminal rewrite, the one
 * reminder, the two text-degradation paths, and the transaction rules the S1
 * hard constraint puts on every writer of a delivery row.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { resetMultiremiTestEnv } from "./helpers.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { decodeDecisionCardBody, questionCardAction } from "@shared/feishu-task-card.js";
import {
  decisionInteractionMarker,
  handleIssueDecisionInteractionEvent,
} from "@connectors/feishu/task-interaction.js";
import { registerIssueDecisionCardFixture as registerIssueDecisionCardInteraction, resetQuestionCardHostFixtures } from "../connectors/question-card-host-fixture.js";
import { FEISHU_ISSUE_DECISION_CARD_CAPABILITY } from "@multiremi/contracts/types.js";
import { MultiremiDaemonClient } from "@multiremi/worker/client.js";
import { bootstrapPreUnifiedSchema } from "@multiremi/store/migrations.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { restoreMul412Baseline828291b9Schema, tableColumns } from "./mul412-schema-fixture.js";
import { historicalWriters } from "./unified-model-test-backends.js";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";

pendingTurnBackendTests("MUL-508 Issue decision cards", (fixture) => {
let db: UnifiedFixtureDatabase;
beforeEach(() => { db = fixture().db; });
const createLocalStore = () => fixture().store;

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
const CARD_OPEN_ID = "ou_the_person";
const OPERATOR_MISMATCH_TOAST = "本次没有提交：这条只能由卡片上点名的人回答。请转告对方在卡片上回答；如果你也是这张单的负责人，可以到网页端回答。";
const DECISION_FINISHED_TOAST = "本次没有提交：这个决定已经结束了。请到网页端查看最新结果，不需要再提交。";
const DECISION_NOT_SUBMITTED_TOAST = "本次没有提交：这次没能提交。这个决定可能还没结束，请到网页端查看；如果还在等回答，请在网页端回答。";
const CARD_RECOVERING_TOAST = "本次没有提交：卡片正在恢复，或这个决定已经处理。请稍后重试，或到网页端查看。";

const DECISION_SIDE_EFFECT_TABLES = [
  "multiremi_message_decision_records",
  "multiremi_issue_activity",
  "multiremi_conversation_log",
  "multiremi_session_lanes",
  "multiremi_feishu_bot_outbound_deliveries",
  "multiremi_feishu_bot_outbound_operations",
  "multiremi_turns",
  "multiremi_turn_attempts",
  "multiremi_session_events",
] as const;

function decisionSideEffectCounts(): Record<string, number> {
  return Object.fromEntries(DECISION_SIDE_EFFECT_TABLES.map(table => {
    const row = db!.query(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${table}`).get() as { n: number };
    return [table, Number(row.n)];
  }));
}

async function daemonClientOverTcp<T>(
  store: MultiremiStore,
  run: (client: MultiremiDaemonClient) => Promise<T>,
): Promise<T> {
  const api = app(store);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: request => api.fetch(request),
  });
  const host = await daemonToken(store);
  try {
    return await run(new MultiremiDaemonClient(server.url.origin, host.token));
  } finally {
    await server.stop(true);
  }
}

let previousEncryptionKey: string | undefined;
let previousPublicUrl: string | undefined;
let previousLarkAppId: string | undefined;
let previousLarkAppSecret: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  previousPublicUrl = process.env.MULTIREMI_PUBLIC_URL;
  previousLarkAppId = process.env.MULTIREMI_LARK_APP_ID;
  previousLarkAppSecret = process.env.MULTIREMI_LARK_APP_SECRET;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.MULTIREMI_PUBLIC_URL = "https://remi.example.com";
  process.env.MULTIREMI_LARK_APP_ID = "cli_issue_decision";
  process.env.MULTIREMI_LARK_APP_SECRET = APP_SECRET;
});

afterEach(() => {
  resetQuestionCardHostFixtures();
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  if (previousPublicUrl === undefined) delete process.env.MULTIREMI_PUBLIC_URL;
  else process.env.MULTIREMI_PUBLIC_URL = previousPublicUrl;
  if (previousLarkAppId === undefined) delete process.env.MULTIREMI_LARK_APP_ID;
  else process.env.MULTIREMI_LARK_APP_ID = previousLarkAppId;
  if (previousLarkAppSecret === undefined) delete process.env.MULTIREMI_LARK_APP_SECRET;
  else process.env.MULTIREMI_LARK_APP_SECRET = previousLarkAppSecret;
  resetMultiremiTestEnv();
});

/**
 * One workspace with a configured bot host, an Issue topic that already has its
 * root message, and a member whose Feishu open_id resolves the way production
 * does (the users table carries the SSO `external_id`).
 */
function scaffold(options: {
  hostSupportsIssueDecisions?: boolean;
  notifyMode?: "group_owner" | "person" | "none";
  notifyOpenId?: string;
} = {}) {
  const store = createLocalStore();
  const member = store.findWorkspaceMemberForUser("local", "local")!;
  const user = store.getOrCreateUser({
    externalId: CARD_OPEN_ID, feishuUnionId: "on_card_person", name: "Synthetic card human", email: "card-human@example.com",
  });
  db!.run("UPDATE multiremi_workspace_members SET user_id = ? WHERE id = ?", [user.id, member.id]);
  const parentRuntime = store.registerRuntime({ name: "Parent owner host", provider: "codex", workspaceId: "local", daemonId: "parent-owner-host" });
  const agentId = store.createAgent({ name: "Concierge", provider: "codex", workspaceId: "local", runtimeId: parentRuntime.id }).id;
  store.registerRuntime({ id: "rt_bot", name: "Bot host", provider: "codex", workspaceId: "local", daemonId: "bot-host", maxConcurrency: 16 });
  const sourceId = store.createAgent({ name: "Historical source Remi", provider: "codex", workspaceId: "local", runtimeId: "rt_bot", maxConcurrentTasks: 16 }).id;
  store.heartbeatRuntime("rt_bot", {
    supportsFeishuBotConfig: true,
    ...(options.hostSupportsIssueDecisions === false ? {} : { supportsIssueDecisionCard: true }),
  });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: sourceId, responsibleMemberId: member.id, runtimeId: "rt_bot", appId: "cli_issue_decision", appSecretOp: "set",
    appSecret: APP_SECRET, domain: "feishu", enabled: true,
  });
  store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: config.revision, state: "online" });
  const at = new Date().toISOString();
  db!.run(`INSERT INTO multiremi_feishu_bot_senders (id,workspace_id,app_id,open_id,union_id,display_name,allowed,first_seen_at,last_seen_at)
    VALUES ('card_person_sender','local','cli_issue_decision',?,'on_card_person','Synthetic card human',1,?,?)`, [CARD_OPEN_ID, at, at]);
  const workspace = store.getWorkspace("local")!;
  store.updateWorkspace("local", {
    settings: {
      ...workspace.settings,
      issueTopics: {
        enabled: true, chatId: "oc_issue_decision",
        ...(options.notifyMode ? { notifyMode: options.notifyMode } : {}),
        ...(options.notifyMode === "person" ? { notifyOpenId: options.notifyOpenId ?? CARD_OPEN_ID } : {}),
      },
    },
  });
  return { store, agentId, member };
}

/** An Issue whose topic root message has been sent, so replies have a seed. */
function issueWithTopic(store: MultiremiStore, title = "Decision parent", assignee?: { type: "agent"; id: string }) {
  const issue = createResponsibleTestIssue(store, {
    title, workspaceId: "local", responsibleMemberId: "mem_local_local",
    ...(assignee ? { assigneeType: assignee.type, assigneeId: assignee.id } : {}),
  });
  store.prepareFeishuIssueTopicWithinTransaction(issue);
  const root = store.claimFeishuBotOutbound("local", "rt_bot")!;
  store.reportFeishuBotOutbound("local", "rt_bot", root.id, {
    claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${issue.id}`,
  });
  return issue;
}

/** A child Issue with a running task, which is what raises decisions. */
function childWithTask(store: MultiremiStore, agentId: string, parentId: string, delegateFromParent = false) {
  const parentAgentId = agentId;
  agentId = store.getFeishuBotConfig("local")!.agentId!;
  const child = createResponsibleTestIssue(store, {
    title: "Decision source", workspaceId: "local", parentIssueId: parentId,
    assigneeType: "agent", assigneeId: agentId,
  });
  let task;
  if (delegateFromParent) {
    const owner = parentTask(store, parentAgentId, parentId);
    store.sendMessage({ session_id: store.getOrCreateDefaultIssueSession(child.id).id, sender: { type: "agent", id: parentAgentId }, source_turn_id: store.getTurnForAttempt(owner.id)!.id,
      to: { type: "agent", ref: agentId }, message_kind: "request", wake_requested: "now", body_md: "Execute the parent's actual delegated source work" });
    task = store.claimTask("rt_bot")!;
    expect(task.agentId).toBe(agentId);
    expect(task.delegationId).toBeTruthy();
  } else {
    task = store.createTask({ agentId, issueId: child.id, workspaceId: "local", prompt: "Work" });
    expect(store.claimTask("rt_bot")?.id).toBe(task.id);
  }
  store.startTask(task.id);
  return { child, task };
}

/** The parent's owner-task round: escalating and agent-answering require it. */
function parentTask(store: MultiremiStore, agentId: string, parentId: string) {
  const runtime = store.registerRuntime({ name: "Historical parent host", provider: "codex", daemonId: "parent-host" });
  store.updateAgent(agentId, { runtimeId: runtime.id });
  const pending = store.listTasksForIssue(parentId).find(task => task.agentId === agentId && task.status === "queued");
  const task = pending ?? store.createTask({ agentId, issueId: parentId, workspaceId: "local", prompt: "Own the parent" });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
  return task;
}

function raiseDecision(
  store: MultiremiStore,
  agentId: string,
  childId: string,
  taskId: string,
  input: { kind: string; title: string; options?: string[]; executionScope?: string },
) {
  // Explicit historical decision_record fixture. No retired writer and no
  // invented native callback: production reads and mutations use the same Q.
  const child = store.getIssue(childId)!;
  const parent = store.getIssue(child.parentIssueId ?? child.id)!;
  const task = store.getTask(taskId)!;
  const turn = store.getTurnForAttempt(taskId)!;
  const session = store.getOrCreateDefaultIssueSession(parent.id);
  const human = ["permission", "production_change"].includes(input.kind);
  const at = new Date().toISOString();
  const original = store.sendMessage({ session_id: session.id, sender: { type: "agent", id: task.agentId }, source_turn_id: turn.id,
    ...(input.executionScope ? { execution_scope: input.executionScope } : {}),
    to: human ? { type: "member", ref: parent.responsibleMemberId! } : { type: "none" }, message_kind: "decision", wake_requested: "inbox_only", body_md: `${input.title} context`, options: input.options?.map(label => ({ label, value: label })),
    metadata: { decision_record: { issue_id: parent.id, source_issue_id: childId, source_task_id: taskId, kind: input.kind, title: input.title, body: `${input.title} context`, options: input.options ?? [],
      status: human ? "escalated" : "pending", created_by_agent_id: task.agentId, owner_agent_id: human ? null : parent.assigneeId, history: [], created_at: at, updated_at: at } } }).message;
  if (!human) store.sendMessage({ session_id: store.getOrCreateDefaultIssueSession(parent.id).id, sender: { type: "platform", id: null }, to: { type: "agent", ref: agentId },
    message_kind: "request", wake_requested: "now", body_md: `Historical question ${original.id}`, metadata: { root_question_id: original.id, question_route_revision: 1, question_notification: true } });
  const decision = store.getIssueDecision(parent.id, original.id)!;
  if (human) db.transaction(() => store.prepareIssueDecisionCardWithinTransaction(parent, decision, createCommitEventQueue()))();
  return decision;
}

function answerDecision(store: MultiremiStore, _issueId: string, id: string, input: { answer: string; reason: string; overturn?: string }, actor: { type: "agent" | "member"; id: string; taskId?: string | null }) {
  const q = store.getQuestion(id)!;
  store.answerQuestion(id, { expected_route_revision: q.route_revision, response: { answer: input.answer }, body_md: input.answer, reason: input.reason },
    { type: actor.type, id: actor.id }, actor.taskId ? store.getTurnForAttempt(actor.taskId)!.id : undefined);
  return store.getIssueDecisionAnywhere(id)!;
}
function escalateDecision(store: MultiremiStore, _issueId: string, id: string, actor: { type: "agent"; id: string; taskId: string }) {
  return store.escalateQuestion(id, { expected_route_revision: store.getQuestion(id)!.route_revision, reason: "Parent execution owner requires the designated human" },
    { type: actor.type, id: actor.id }, store.getTurnForAttempt(actor.taskId)!.id);
}
function closeDecision(store: MultiremiStore, _issueId: string, id: string, actor: { type: "agent"; id: string; taskId: string }) {
  const source = store.getTask(actor.taskId)!;
  return store.closeQuestion(id, { expected_route_revision: store.getQuestion(id)!.route_revision, reason: "Original source explicitly withdrew the historical question" },
    { type: "agent", id: source.agentId }, store.getTurnForAttempt(actor.taskId)!.id);
}

function sendCard(store: MultiremiStore, messageId = "om_card", openId = CARD_OPEN_ID, sentAt?: Date) {
  const card = store.claimFeishuBotOutbound("local", "rt_bot");
  if (!card) return null;
  if (card.kind === "decision_card" && card.decisionId && card.interactionOpenId !== openId) {
    // Explicit pre-upgrade signed-card fixture: old cards could name a topic
    // recipient. Retain that frozen token to test actual identity rejection;
    // new production dispatch always resolves the designated root human.
    const envelope = decodeDecisionCardBody(card.body)!;
    const action = questionCardAction(envelope.card)!;
    action.t = store.issueMessageCardToken(card.decisionId, openId);
    card.body = JSON.stringify({ ...JSON.parse(card.body), card: envelope.card });
    db.run('UPDATE multiremi_feishu_bot_outbound_deliveries SET body=?,interaction_open_id=? WHERE id=?', [card.body, openId, card.id]);
  }
  store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
    claimToken: card.claimToken, status: "sent", externalMessageId: messageId, interactionOpenId: openId,
  }, sentAt);
  return card;
}

function daemonToken(store: MultiremiStore, daemonId = "bot-host") {
  return store.createAccessToken({ name: daemonId, type: "daemon", workspaceId: "local", daemonId });
}

function cardAction(decisionId: string): Record<string, unknown> {
  const row = db!.query("SELECT body FROM multiremi_feishu_bot_outbound_deliveries WHERE decision_id = ? AND kind = 'decision_card' ORDER BY created_at DESC LIMIT 1")
    .get(decisionId) as { body: string } | null;
  const card = row && decodeDecisionCardBody(row.body)?.card;
  if (!card) throw new Error("fixture decision card missing");
  const value = questionCardAction(card);
  if (!value) throw new Error("fixture card action missing");
  return value;
}

describe("MUL-412 issue decision cards", () => {
  it("upgrades the SQLite 828291b9 schema twice without losing existing rows", () => {
    const db = openSqliteDatabase(":memory:");
    bootstrapPreUnifiedSchema(db);
    const legacy = historicalWriters(db);
    const agent = legacy.createAgent({ name: "Upgrade", provider: "codex" });
    const parent = legacy.createIssue({ title: "SQLite upgrade", assigneeType: "agent", assigneeId: agent.id });
    const task = legacy.createTask({ agentId: agent.id, issueId: parent.id, prompt: "Legacy" });
    const decision = { id: "dcs_828_upgrade" }, deliveryId = "fbo_828_upgrade", at = new Date().toISOString();
    db.run("INSERT INTO multiremi_chat_sessions(id,workspace_id,agent_id,title,created_at,updated_at) VALUES('chat_upgrade','local',?,'Upgrade',?,?)", [agent.id,at,at]);
    db.run("INSERT INTO multiremi_feishu_bot_chat_bindings(id,workspace_id,app_id,agent_id,external_session_key,chat_session_id,created_at,updated_at) VALUES('binding_upgrade','local','cli_upgrade',?,'upgrade','chat_upgrade',?,?)", [agent.id,at,at]);
    db.run("INSERT INTO multiremi_issue_decisions(id,workspace_id,issue_id,source_issue_id,source_task_id,kind,title,body,options,status,created_by_agent_id,created_at,updated_at) VALUES(?,'local',?,?,?,'production_change','Keep this row','','[]','escalated',?,?,?)",
      [decision.id,parent.id,parent.id,task.id,agent.id,at,at]);
    db.run("INSERT INTO multiremi_feishu_bot_outbound_deliveries(id,workspace_id,binding_id,chat_id,body,status,available_at,created_at,updated_at,kind,decision_id,decision_issue_id) VALUES(?,'local','binding_upgrade','oc_upgrade','card','sending',?,?,?,'decision_card',?,?)",
      [deliveryId,at,at,at,decision.id,parent.id]);
    restoreMul412Baseline828291b9Schema(db!);
    expect(tableColumns(db!, "multiremi_issue_decisions")).not.toContain("reminder_sent_at");
    expect(tableColumns(db!, "multiremi_feishu_bot_outbound_deliveries")).not.toContain("decision_id");
    expect(tableColumns(db!, "multiremi_issues")).not.toContain("parent_done_grant_at");

    // Each construction runs the complete current migration. The second run is
    // the idempotency pass required by the upgrade gate.
    new MultiremiStore(db!);
    new MultiremiStore(db!);
    expect(tableColumns(db!, "multiremi_message_decision_records")).toContain("reminder_sent_at");
    expect(tableColumns(db!, "multiremi_feishu_bot_outbound_deliveries"))
      .toEqual(expect.arrayContaining(["decision_id", "decision_issue_id"]));
    expect(tableColumns(db!, "multiremi_issues"))
      .toEqual(expect.arrayContaining(["parent_done_grant_at", "parent_done_grant_by", "parent_done_grant_agent_id"]));
    expect(db!.query("SELECT title, status FROM multiremi_message_decision_records WHERE id = ?").get(decision.id))
      .toEqual({ title: "Keep this row", status: "escalated" });
    expect(db!.query("SELECT id, status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(deliveryId))
      .toEqual({ id: deliveryId, status: "sending" });
    expect(db!.query(
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_multiremi_feishu_bot_outbound_decision'",
    ).get()).toEqual({ n: 1 });
    db.close();
  });

  it("sends a card when the owner agent escalates a decision to a person", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Escalated decision", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    // An ordinary criteria question first goes to the parent's owner Agent.
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "criteria", title: "Merge the change" });
    expect(decision.status).toBe("pending");
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card'").get())
      .toEqual({ n: 0 });
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("pending");

    const ownerTask = parentTask(store, agentId, parent.id);
    escalateDecision(store, parent.id, decision.id, { type: "agent", id: agentId, taskId: ownerTask.id });
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(card.kind).toBe("decision_card");
    expect(card.decisionId).toBe(decision.id);
    // The card goes to the Issue the decision hangs on — the parent — and uses
    // its topic's reply anchor, not the source Issue's.
    expect(card.decisionIssueId).toBe(parent.id);
    expect(card.replyToMessageId).toBe(`om_root_${parent.id}`);
    const envelope = decodeDecisionCardBody(card.body)!;
    expect(envelope.card.schema).toBe("2.0");
    expect(JSON.stringify(envelope.card)).toContain("Merge the change");
    expect(envelope.fallback_text).toContain("Merge the change");
    expect(envelope.fallback_text).toContain(`https://remi.example.com/local/issues/${parent.id}`);
    // A decision has no deadline, so no expiry rides the delivery.
    expect(card.expiresAt ?? null).toBeNull();
    expect(store.listIssueActivity(parent.id).some(entry => entry.type === "decision_card_queued")).toBe(true);
  });

  it("grants historical source access only to the exact live original attempt", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Exact historical source", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const originalTurn = store.getTurnForAttempt(task.id)!;
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Sensitive original question" });
    expect(store.canAccessQuestionFromTurn(decision.id, task.agentId, originalTurn.id)).toBe(true);
    expect(() => store.answerQuestion(decision.id, { expected_route_revision: 1, response: { answer: "yes" } }, { type: "agent", id: task.agentId }, originalTurn.id)).toThrow();
    expect(store.getQuestion(decision.id)?.status).toBe("pending");
    const otherSession = store.createIssueSession(child.id, { title: "Unrelated source lane", holdsWorkspace: false });
    const other = store.createTask({ agentId: task.agentId, issueId: child.id, issueSessionId: otherSession.id, workspaceId: "local", prompt: "Different lane" });
    expect(store.claimTask("rt_bot")?.id).toBe(other.id); store.startTask(other.id);
    const otherTurn = store.getTurnForAttempt(other.id)!;
    expect(store.canAccessQuestionFromTurn(decision.id, task.agentId, otherTurn.id)).toBe(false);
    const original = store.getMessage(decision.id)!;
    const metadata = structuredClone(original.metadata);
    (metadata.decision_record as { source_task_id: string }).source_task_id = other.id;
    db!.run("UPDATE multiremi_conversation_log SET metadata = ? WHERE id = ?", [JSON.stringify(metadata), decision.id]);
    expect(store.canAccessQuestionFromTurn(decision.id, task.agentId, originalTurn.id)).toBe(false);
    expect(store.canAccessQuestionFromTurn(decision.id, task.agentId, otherTurn.id)).toBe(false);
    db!.run("UPDATE multiremi_conversation_log SET metadata = ? WHERE id = ?", [JSON.stringify(original.metadata), decision.id]);
    db!.run("UPDATE multiremi_turns SET current_attempt_id = ? WHERE id = ?", [other.id, originalTurn.id]);
    expect(store.canAccessQuestionFromTurn(decision.id, task.agentId, originalTurn.id)).toBe(false);
    db!.run("UPDATE multiremi_turns SET current_attempt_id = ? WHERE id = ?", [task.id, originalTurn.id]);
    expect(store.canAccessQuestionFromTurn(decision.id, task.agentId, originalTurn.id)).toBe(true);
    db!.run("UPDATE multiremi_turn_attempts SET status = 'completed' WHERE id = ?", [task.id]);
    expect(store.canAccessQuestionFromTurn(decision.id, task.agentId, originalTurn.id)).toBe(false);
    db!.run("UPDATE multiremi_turn_attempts SET status = 'running' WHERE id = ?", [task.id]);
    store.completeTask(task.id, { output: "Original source completed" });
    expect(store.canAccessQuestionFromTurn(decision.id, task.agentId, originalTurn.id)).toBe(false);
    expect(() => closeDecision(store, parent.id, decision.id, { type: "agent", id: task.agentId, taskId: task.id })).toThrow();
    expect(store.getQuestion(decision.id)?.status).toBe("pending");
  });

  it("returns each historical answer revision and close to its actual source lane without native recovery", () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Ordinary source results", { type: "agent", id: agentId });
    const { task, child } = childWithTask(store, agentId, parent.id);
    const sourceTurn = store.getTurnForAttempt(task.id)!;
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "First result" });
    answerDecision(store, parent.id, decision.id, { answer: "Initial answer", reason: "Reviewed" }, { type: "member", id: member.id });
    const before = store.getQuestion(decision.id)!;
    expect(() => answerDecision(store, parent.id, decision.id, { answer: "Replay", reason: "Replay" }, { type: "member", id: member.id })).toThrow();
    store.answerQuestion(decision.id, { expected_route_revision: before.route_revision, expected_answer_revision: before.answer_revision, revise: true, reason: "New evidence", response: { answer: "Revised answer" }, body_md: "Revised answer" }, { type: "member", id: member.id });
    const question = store.getQuestion(decision.id)!;
    const notifications = question.history.filter(event => event.type === "notify");
    expect(notifications).toHaveLength(2);
    for (const event of notifications) {
      const message = store.getMessage(event.source_message_id!)!;
      expect(event).toMatchObject({ reason: "historical_source_notified", source_session_id: task.issueSessionId });
      expect(message).toMatchObject({ session_id: task.issueSessionId, to_agent_id: task.agentId, message_kind: "request", reply_to_id: null, wake_applied: "now" });
      expect(message.metadata).toMatchObject({ root_question_id: decision.id, execution_scope: sourceTurn.execution_scope });
      expect(message.metadata.question_continuation).toBeUndefined();
    }
    expect(store.getMessage(notifications[1].source_message_id!)?.body_md).toContain("Revised answer");
    expect(store.getMessage(question.answer!.reply_message_id)).toMatchObject({ session_id: question.session_id, to_agent_id: null, body_md: "Revised answer" });
    expect(question).toMatchObject({ wait_status: "none", recovery: { consumer_turn_id: null, consumer_attempt_id: null, continuation_message_id: null } });
    const withdrawn = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Obsolete result" });
    closeDecision(store, parent.id, withdrawn.id, { type: "agent", id: task.agentId, taskId: task.id });
    const closed = store.getQuestion(withdrawn.id)!;
    expect(closed).toMatchObject({ status: "closed", wait_status: "none" });
    const closeNotification = closed.history.find(event => event.type === "notify")!;
    expect(store.getMessage(closeNotification.source_message_id!)).toMatchObject({ session_id: task.issueSessionId, to_agent_id: task.agentId, wake_applied: "now" });
    expect(store.getMessage(closeNotification.source_message_id!)?.body_md).toContain("已关闭");
  });

  it("delivers one reply for a historical source on the exact same session and scope", () => {
    const { store, agentId, member } = scaffold();
    const issue = issueWithTopic(store, "Same lane reply", { type: "agent", id: agentId });
    const sourceAgentId = store.getFeishuBotConfig("local")!.agentId!;
    const task = store.createTask({ agentId: sourceAgentId, issueId: issue.id, workspaceId: "local", prompt: "Ask from the root lane" });
    expect(store.claimTask("rt_bot")?.id).toBe(task.id); store.startTask(task.id);
    const decision = raiseDecision(store, agentId, issue.id, task.id, { kind: "production_change", title: "Same source" });
    answerDecision(store, issue.id, decision.id, { answer: "Proceed", reason: "Reviewed" }, { type: "member", id: member.id });
    const question = store.getQuestion(decision.id)!;
    const event = question.history.find(item => item.type === "notify")!;
    expect(event.source_message_id).toBe(question.answer!.reply_message_id);
    expect(store.getMessage(event.source_message_id!)).toMatchObject({ session_id: task.issueSessionId, to_agent_id: task.agentId, wake_applied: "now" });
    expect(store.listMessages(task.issueSessionId!).filter(message => message.metadata.question_source_notification)).toHaveLength(0);
    expect(question).toMatchObject({ wait_status: "none", recovery: { consumer_attempt_id: null } });
  });

  it("isolates a failed ordinary source dispatch with a readable result and no partial wake", () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Source dispatch savepoint", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id, true);
    const sourceScope = store.getTurnForAttempt(task.id)!.execution_scope;
    expect(sourceScope).toBe(task.delegationId!);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Durable result" });
    const log = (store as unknown as { ctx: StoreContext }).ctx.conversationLog();
    const append = log.appendWithinTransaction.bind(log);
    let failureInjected = false, wakes = 0;
    const stop = store.onTaskEnqueued(() => { wakes++; });
    log.appendWithinTransaction = (...args) => {
      const result = append(...args);
      if (args[0].metadata?.question_source_notification && !args[0].metadata.question_source_notification_unavailable) {
        failureInjected = true;
        throw Object.assign(new Error("Synthetic dispatch failure after source row insertion"), { code: "fixture_dispatch_failed" });
      }
      return result;
    };
    try { answerDecision(store, parent.id, decision.id, { answer: "Preserved answer", reason: "Reviewed" }, { type: "member", id: member.id }); }
    finally { log.appendWithinTransaction = append; stop(); }
    expect(failureInjected).toBe(true);
    expect(wakes).toBe(0);
    const question = store.getQuestion(decision.id)!;
    expect(question).toMatchObject({ status: "answered", wait_status: "none", answer: { body_md: "Preserved answer" }, recovery: { consumer_attempt_id: null } });
    const event = question.history.find(item => item.type === "notify")!;
    expect(event).toMatchObject({ reason: "historical_source_dispatch_failed:fixture_dispatch_failed", source_session_id: task.issueSessionId });
    const fallback = store.getMessage(event.source_message_id!)!;
    expect(fallback).toMatchObject({ to_agent_id: null, message_kind: "status", wake_applied: "inbox_only" });
    expect(fallback.metadata.execution_scope).toBe(sourceScope);
    expect(fallback.body_md).toContain("Preserved answer");
    expect(fallback.body_md).toContain(event.reason!);
    expect(store.listMessages(task.issueSessionId!).filter(message => message.metadata.question_source_notification)).toEqual([fallback]);
  });

  it("keeps a historical parent reply separate when the actual source has another scope on the same session", () => {
    const { store, agentId, member } = scaffold();
    const issue = issueWithTopic(store, "Same session, different scopes", { type: "agent", id: agentId });
    const sourceAgentId = store.getFeishuBotConfig("local")!.agentId!;
    const task = store.createTask({ agentId: sourceAgentId, issueId: issue.id, workspaceId: "local", prompt: "Original source scope" });
    expect(store.claimTask("rt_bot")?.id).toBe(task.id); store.startTask(task.id);
    const decision = raiseDecision(store, agentId, issue.id, task.id, { kind: "production_change", title: "Parent-scope original Q" });
    const original = store.getMessage(decision.id)!;
    db!.run("UPDATE multiremi_conversation_log SET metadata = ? WHERE id = ?", [JSON.stringify({ ...original.metadata, execution_scope: "historical-parent-scope" }), decision.id]);
    answerDecision(store, issue.id, decision.id, { answer: "Scoped source result", reason: "Reviewed" }, { type: "member", id: member.id });
    const question = store.getQuestion(decision.id)!;
    const reply = store.getMessage(question.answer!.reply_message_id)!;
    const notification = store.getMessage(question.history.find(event => event.type === "notify")!.source_message_id!)!;
    expect(reply).toMatchObject({ session_id: task.issueSessionId, to_agent_id: null, reply_to_id: decision.id });
    expect(reply.metadata.execution_scope).toBe("historical-parent-scope");
    expect(notification.id).not.toBe(reply.id);
    expect(notification).toMatchObject({ session_id: task.issueSessionId, to_agent_id: task.agentId, reply_to_id: null, wake_applied: "now" });
    expect(notification.metadata.execution_scope).toBe(store.getTurnForAttempt(task.id)!.execution_scope);
    expect(question).toMatchObject({ wait_status: "none", recovery: { consumer_attempt_id: null } });
  });

  it("keeps an unavailable historical source result on the original Q scope instead of the default parent lane", () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Unverifiable historical source", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id, true);
    const sourceScope = store.getTurnForAttempt(task.id)!.execution_scope;
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Preserved unknown source", executionScope: sourceScope });
    const original = store.getMessage(decision.id)!;
    // Explicit retained historical reference: no existing source attempt can
    // substantiate this old id. Keep the original Q and never guess a lane.
    db!.run("UPDATE multiremi_conversation_log SET metadata = ? WHERE id = ?", [JSON.stringify({ ...original.metadata, decision_record: { ...(original.metadata.decision_record as object), source_task_id: "tsk_missing_retained_historical_source" } }), decision.id]);
    const before = decisionSideEffectCounts();
    let wakes = 0;
    const stop = store.onTaskEnqueued(() => { wakes++; });
    try { answerDecision(store, parent.id, decision.id, { answer: "Retained valid answer", reason: "Reviewed" }, { type: "member", id: member.id }); }
    finally { stop(); }
    const question = store.getQuestion(decision.id)!;
    const event = question.history.find(item => item.type === "notify")!;
    expect(event).toMatchObject({ reason: "historical_source_facts_unavailable", source_session_id: original.session_id });
    const fallback = store.getMessage(event.source_message_id!)!;
    expect(fallback).toMatchObject({ session_id: original.session_id, to_agent_id: null, message_kind: "status", wake_applied: "inbox_only" });
    expect(fallback.metadata.execution_scope).toBe(sourceScope);
    expect(fallback.body_md).toContain("Retained valid answer");
    expect(question).toMatchObject({ status: "answered", answer: { body_md: "Retained valid answer" }, wait_status: "none", recovery: { consumer_turn_id: null, consumer_attempt_id: null } });
    expect(store.getMessage(decision.id)?.body_md).toBe(original.body_md);
    expect(wakes).toBe(0);
    const after = decisionSideEffectCounts();
    expect(after.multiremi_turns).toBe(before.multiremi_turns);
    expect(after.multiremi_turn_attempts).toBe(before.multiremi_turn_attempts);
  });

  it("sends a card when a decision is handed to a person directly", () => {
    const { store, agentId } = scaffold();
    // No parent at all: the decision hangs on the source Issue itself and is
    // escalated on creation, which is the "directly to a person" case.
    const issue = issueWithTopic(store, "Direct decision", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, issue.id);
    // production_change never lands on an agent, even with a parent owner.
    const prod = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy to prod" });
    expect(prod.status).toBe("escalated");
    expect(prod.issueId).toBe(issue.id);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(card.kind).toBe("decision_card");
    expect(card.decisionId).toBe(prod.id);
    expect(card.decisionIssueId).toBe(issue.id);
  });

  it("persists a historical card intent until actual Remi presents a separate summary for the same Q", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Historical presentation gate", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const remi = store.createAgent({ name: "Presentation Remi", provider: "codex", workspaceId: "local", runtimeId: "rt_bot" });
    const bot = store.upsertFeishuBotConfig("local", { agentId: remi.id, runtimeId: "rt_bot", appId: "cli_issue_decision", appSecretOp: "set", appSecret: APP_SECRET, domain: "feishu", enabled: true });
    store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: bot.revision, state: "online" });
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "criteria", title: "Immutable original question", options: ["yes", "no"] });
    const owner = parentTask(store, agentId, parent.id);
    escalateDecision(store, parent.id, decision.id, { type: "agent", id: agentId, taskId: owner.id });
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_operations WHERE unit_key = ?").get(decision.id)).toMatchObject({ n: 1 });
    const remiTask = store.claimTask("rt_bot")!;
    expect(remiTask.agentId).toBe(remi.id); store.startTask(remiTask.id);
    store.presentQuestion(decision.id, { expected_route_revision: store.getQuestion(decision.id)!.route_revision, summary: "Separate Remi recommendation" }, { type: "agent", id: remi.id }, store.getTurnForAttempt(remiTask.id)!.id);
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(card).toMatchObject({ kind: "decision_card", decisionId: decision.id, interactionOpenId: CARD_OPEN_ID });
    expect(card.body).toContain("Separate Remi recommendation");
    expect(card.body).toContain("Immutable original question");
    expect(questionCardAction(decodeDecisionCardBody(card.body)!.card)).toMatchObject({ message_id: decision.id, route_revision: 2 });
    expect(store.getQuestion(decision.id)).toMatchObject({ original_message: "Immutable original question context", wait_status: "none", summary: { body_md: "Separate Remi recommendation", agent_id: remi.id } });
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE decision_id = ? AND kind = 'decision_card'").get(decision.id)).toMatchObject({ n: 1 });
  });

  it("issues a current card after an explicit route transfer and rejects the old card and missing revision", async () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Versioned historical card", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Current route only", options: ["yes"] });
    const first = sendCard(store, "om_route_one")!;
    const oldAction = questionCardAction(decodeDecisionCardBody(first.body)!.card)!;
    const host = await daemonToken(store);
    const answer = (body: Record<string, unknown>) => app(store).request(`/api/daemon/messages/${decision.id}/answer`, { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const missingRevision = await answer({ answer: "yes", token: oldAction.t, operator_open_id: CARD_OPEN_ID });
    expect(missingRevision.status).toBe(400);
    expect(await missingRevision.text()).toContain("question_route_revision_required");
    store.transferQuestion(decision.id, { expected_route_revision: 1, reason: "Explicitly reconfirm current responsibility" }, { type: "member", id: member.id });
    const second = sendCard(store, "om_route_two")!;
    expect(second).toMatchObject({ kind: "decision_card", decisionId: decision.id });
    const currentAction = questionCardAction(decodeDecisionCardBody(second.body)!.card)!;
    expect(currentAction).toMatchObject({ message_id: decision.id, route_revision: 2 });
    expect(currentAction.t).not.toBe(oldAction.t);
    const stale = await answer({ answer: "yes", token: oldAction.t, expected_route_revision: 1, operator_open_id: CARD_OPEN_ID });
    expect(stale.status).toBe(403);
    expect(store.getQuestion(decision.id)?.status).toBe("pending");
    const current = await answer({ answer: "yes", token: currentAction.t, expected_route_revision: 2, operator_open_id: CARD_OPEN_ID });
    expect(current.status, await current.clone().text()).toBe(200);
    expect(store.getQuestion(decision.id)?.answer?.actor).toEqual({ type: "member", id: member.id });
  });

  it("does not card a decision the parent's owner agent answers itself", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Self-answered", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "criteria", title: "Acceptance terms" });
    expect(decision.status).toBe("pending");
    const ownerTask = parentTask(store, agentId, parent.id);
    answerDecision(store, parent.id, decision.id, {
      answer: "Keep them", reason: "The document is the spec", overturn: "A member can revise it",
    }, { type: "agent", id: agentId, taskId: ownerTask.id });
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("answered");
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind LIKE 'decision%'").get())
      .toEqual({ n: 0 });
  });

  it("skips the card and records why when the Issue topic has no seed message", () => {
    const { store, agentId } = scaffold();
    // No `prepareFeishuIssueTopicWithinTransaction`, so the binding exists
    // without a `reply_to_message_id`: there is no thread to reply into.
    const parent = createResponsibleTestIssue(store, { title: "Unsown topic", workspaceId: "local", assigneeType: "agent", assigneeId: agentId, responsibleMemberId: "mem_local_local" });
    // Seed the binding (so it is live and active) but leave its thread anchor
    // unset, which is what an Issue created before the topic root went out
    // looks like. The seed delivery itself is drained first so the queue is
    // empty before the decision is raised.
    store.prepareFeishuIssueTopicWithinTransaction(parent);
    const seed = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", seed.id, {
      claimToken: seed.claimToken, status: "sent", externalMessageId: `om_seed_${parent.id}`,
    });
    db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET reply_to_message_id = NULL, thread_id = NULL WHERE issue_id = ?", [parent.id]);
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Ship it" });
    expect(decision.status).toBe("escalated");
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    const activity = store.listIssueActivity(parent.id).find(entry => entry.type === "decision_card_skipped");
    expect(activity).toBeTruthy();
    expect(activity!.data as Record<string, unknown>).toMatchObject({
      decision_id: decision.id, reason: "no_topic",
    });
    // The decision itself is untouched: it still shows on the web workbench.
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("escalated");
  });

  it("writes no delivery at all for a host that cannot render decision cards", () => {
    const { store, agentId } = scaffold({ hostSupportsIssueDecisions: false });
    expect(store.getRuntime("rt_bot")!.metadata[FEISHU_ISSUE_DECISION_CARD_CAPABILITY]).toBeUndefined();
    const parent = issueWithTopic(store, "Old host", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Ship it" });
    expect(decision.status).toBe("escalated");
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    expect(db!.query(
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE decision_id IS NOT NULL",
    ).get()).toEqual({ n: 0 });
    // Skipped without a card: the skip activity is only for a missing topic.
    expect(store.listIssueActivity(parent.id).filter(entry => entry.type === "decision_card_skipped")).toHaveLength(0);
    expect(store.getQuestion(decision.id)).toMatchObject({ status: "pending", stage: "human", wait_status: "none", current_handler: { type: "member", id: "mem_local_local" } });
  });

  it("answers a card click through the same store write as the HTTP answer route", async () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Card click", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    // Model the source task as in flight. Keep the original continuation
    // assertions while moving the fixture write to the unified attempt model.
    runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [task.id]);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?", options: ["yes", "no"] });
    sendCard(store, "om_answer_card");
    const host = await daemonToken(store);
    const wakeTaskIds: string[] = [];
    const stopWake = store.onTaskEnqueued(task => wakeTaskIds.push(task.id));
    const answerPath = `/api/daemon/messages/${decision.id}/answer`;
    const response = await app(store).request(answerPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes\n自定义回答：after CI", token: cardAction(decision.id).t, expected_route_revision: cardAction(decision.id).route_revision, operator_open_id: CARD_OPEN_ID }),
    });
    // Ordinary source delivery may enqueue the next lane round after this
    // running source finishes; it never restores a historical native callback.
    store.completeTask(task.id, { output: "decision requested" });
    stopWake();
    expect(response.status, await response.clone().text()).toBe(200);
    const settled = store.getIssueDecision(parent.id, decision.id)!;
    expect(settled.status).toBe("answered");
    expect(settled.answer?.answererType).toBe("member");
    expect(settled.answer?.answererId).toBe(member.id);
    expect(settled.answeredByMemberId).toBe(member.id);
    expect(settled.history).toHaveLength(1);
    expect(settled.answer?.answer).toBe("yes\n自定义回答：after CI");

    // Everything S4's HTTP answer produces is produced here too.
    expect(store.getQuestion(decision.id)?.history).toEqual(expect.arrayContaining([expect.objectContaining({ type: "answer", actor: { type: "member", id: member.id } })]));
    const sourceOwnerTask = store.listTasksForIssue(child.id).find(item => item.status === "queued");
    expect(sourceOwnerTask).toBeTruthy();
    const notification = store.getQuestion(decision.id)!.history.find(event => event.type === "notify")!;
    const sourceReply = store.getMessage(notification.source_message_id!)!;
    expect(notification).toMatchObject({ reason: "historical_source_notified", source_session_id: task.issueSessionId });
    expect(sourceReply).toMatchObject({ session_id: task.issueSessionId, to_agent_id: task.agentId, wake_applied: "now" });
    expect(sourceReply.body_md).toContain(decision.id);
    expect(sourceReply.body_md).toContain("after CI");
    expect(sourceOwnerTask).toMatchObject({ delegationId: null, delegatedByAgentId: null, delegatedFromIssueSessionId: null, delegationSkipReason: null });
    expect(store.getQuestion(decision.id)).toMatchObject({ wait_status: "none", wait_reason: "historical_decision_without_native_call", recovery: { consumer_turn_id: null, consumer_attempt_id: null, continuation_message_id: null } });
    const inbox = store.listMessageInbox(member.id, "local");
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({
      id: decision.id, message_kind: "decision", session_id: store.getMessage(decision.id)!.session_id,
    });
    expect(store.listMessages(store.getMessage(decision.id)!.session_id).filter(message => message.reply_to_id === decision.id)).toHaveLength(1);
    expect(wakeTaskIds).toEqual([sourceOwnerTask!.id]);
    // The card row was sent above; its id is what the terminal patch targets.
    const patch = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(patch.kind).toBe("decision_card_patch");
    expect(patch.targetMessageId).toBe("om_answer_card");
    expect(JSON.stringify(JSON.parse(patch.body).card)).toContain("已回答");
  });

  it("rejects an operator who is not the person the card names", async () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Wrong person", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store)!;
    const host = await daemonToken(store);
    // A stranger with no account at all.
    const response = await app(store).request(`/api/daemon/messages/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", token: cardAction(decision.id).t, expected_route_revision: cardAction(decision.id).route_revision, operator_open_id: "ou_somebody_else" }),
    });
    expect(response.status).toBe(403);
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("escalated");

    // And a *resolved* member who simply is not the person the card named —
    // this is the S5a rule, not the identity mapping: a workspace member may
    // not answer somebody else's card.
    const otherUser = store.getOrCreateUser({ externalId: "ou_other_member", name: "Other", email: "other@example.com" });
    const other = store.createWorkspaceMember({
      workspaceId: "local", userId: otherUser.id, name: "Other", email: "other@example.com", role: "member",
    });
    expect(store.resolveFeishuDecisionOperatorMember("local", "cli_issue_decision", "ou_other_member"))
      .toEqual({ status: "resolved", member: other });
    const notAddressed = await app(store).request(
      `/api/daemon/messages/${decision.id}/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes", token: cardAction(decision.id).t, expected_route_revision: cardAction(decision.id).route_revision, operator_open_id: "ou_other_member" }),
      },
    );
    expect(notAddressed.status).toBe(403);
    expect(await notAddressed.json()).toMatchObject({ code: "recipient_mismatch" });
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("escalated");
  });

  it("refuses an operator that is archived, maps to nothing, or resolves to an agent", async () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Unmapped", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store)!;
    const host = await daemonToken(store);
    const answer = (openId: string) => app(store).request(
      `/api/daemon/messages/${decision.id}/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes", token: cardAction(decision.id).t, expected_route_revision: cardAction(decision.id).route_revision, operator_open_id: openId }),
      },
    );

    // Archived: the binding still resolves to a member row, but that member is
    // no longer live. A non-owner member is used because the workspace refuses
    // to archive its last owner.
    const bobUser = store.getOrCreateUser({ externalId: "ou_bob", name: "Bob", email: "bob@example.com" });
    const bob = store.createWorkspaceMember({
      workspaceId: "local", userId: bobUser.id, name: "Bob", email: "bob@example.com", role: "member",
    });
    const bobIssue = issueWithTopic(store, "Archived member card", { type: "agent", id: agentId });
    const bobChild = childWithTask(store, agentId, bobIssue.id);
    const bobDecision = raiseDecision(store, agentId, bobChild.child.id, bobChild.task.id, {
      kind: "production_change", title: "Ship?",
    });
    sendCard(store, "om_bob", "ou_bob")!;
    store.archiveWorkspaceMember(bob.id);
    const archived = await app(store).request(
      `/api/daemon/messages/${bobDecision.id}/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes", token: cardAction(bobDecision.id).t, expected_route_revision: cardAction(bobDecision.id).route_revision, operator_open_id: "ou_bob" }),
      },
    );
    expect(archived.status).toBe(403);
    expect(await archived.json()).toMatchObject({ code: "decision_member_unmapped" });
    expect(store.getIssueDecision(bobIssue.id, bobDecision.id)!.status).toBe("escalated");

    // An agent's own account is not an answerer. The member row is given the
    // Agent's id, which is how an Agent's identity shows up in this table.
    const agentUser = store.getOrCreateUser({ externalId: "ou_agent_self", name: "Concierge", email: "agent-self@example.com" });
    const agentMember = store.createWorkspaceMember({
      id: agentId, workspaceId: "local", userId: agentUser.id, name: "Concierge",
      email: "agent-self@example.com", role: "member",
    });
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET interaction_open_id = ? WHERE decision_id = ?",
      ["ou_agent_self", decision.id]);
    db!.run("UPDATE multiremi_conversation_log SET card_token_recipient = ? WHERE id = ?", ["ou_agent_self", decision.id]);
    const asAgent = await answer("ou_agent_self");
    expect(agentMember.id).toBe(agentId);
    expect(asAgent.status).toBe(403);
    expect(await asAgent.json()).toMatchObject({ code: "decision_member_unmapped" });
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("escalated");
    const stranger = issueWithTopic(store, "Stranger card", { type: "agent", id: agentId });
    const strangerChild = childWithTask(store, agentId, stranger.id);
    const strangerDecision = raiseDecision(store, agentId, strangerChild.child.id, strangerChild.task.id, {
      kind: "production_change", title: "Ship?",
    });
    sendCard(store, "om_stranger", "ou_never_seen")!;
    const unmapped = await app(store).request(
      `/api/daemon/messages/${strangerDecision.id}/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes", token: cardAction(strangerDecision.id).t, expected_route_revision: cardAction(strangerDecision.id).route_revision, operator_open_id: "ou_never_seen" }),
      },
    );
    expect(unmapped.status).toBe(403);
    expect(await unmapped.json()).toMatchObject({ code: "decision_member_unmapped" });
    expect(store.getIssueDecision(stranger.id, strangerDecision.id)!.status).toBe("escalated");
  });

  it("does not reuse another app's sender open_id and writes nothing on rejection", async () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Cross-app identity", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Deploy?",
    });
    const otherAppUser = store.getOrCreateUser({
      externalId: "ou_other_app_sso", feishuUnionId: "on_cross_app", name: "Other app user", email: "other-app@example.com",
    });
    store.createWorkspaceMember({
      workspaceId: "local", userId: otherAppUser.id, name: "Other app user", email: "other-app@example.com", role: "member",
    });
    const now = new Date().toISOString();
    db!.run(
      `INSERT INTO multiremi_feishu_bot_senders
       (id, workspace_id, app_id, open_id, union_id, display_name, allowed, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ["fbs_other_app", "local", "cli_another_app", "ou_cross_app", "on_cross_app", "Other app user", now, now],
    );
    sendCard(store, "om_cross_app", "ou_cross_app")!;
    const before = {
      decision: store.getIssueDecision(parent.id, decision.id),
      parentActivity: store.listIssueActivity(parent.id).length,
      childActivity: store.listIssueActivity(child.id).length,
      inbox: store.listInboxItems(member.id).length,
      deliveries: (db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries").get() as { n: number }).n,
      tasks: store.listTasksForIssue(child.id).length,
    };
    let wakes = 0;
    const events: string[] = [];
    const stopWake = store.onTaskEnqueued(() => { wakes += 1; });
    const stopEvents = store.onWorkspaceEvent(event => events.push(event.type));
    const host = await daemonToken(store);
    const response = await app(store).request(`/api/daemon/messages/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", token: cardAction(decision.id).t, expected_route_revision: cardAction(decision.id).route_revision, operator_open_id: "ou_cross_app" }),
    });
    stopWake();
    stopEvents();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "decision_member_unmapped" });
    expect(store.getIssueDecision(parent.id, decision.id)).toEqual(before.decision);
    expect(store.listIssueActivity(parent.id)).toHaveLength(before.parentActivity);
    expect(store.listIssueActivity(child.id)).toHaveLength(before.childActivity);
    expect(store.listInboxItems(member.id)).toHaveLength(before.inbox);
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries").get())
      .toEqual({ n: before.deliveries });
    expect(store.listTasksForIssue(child.id)).toHaveLength(before.tasks);
    expect(wakes).toBe(0);
    expect(events).toEqual([]);
  });

  it("does not treat SSO external_id as evidence when the SSO app differs", async () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Different SSO app", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Deploy?",
    });
    sendCard(store, "om_sso_mismatch")!;
    process.env.MULTIREMI_LARK_APP_ID = "cli_different_sso_app";
    // Remove the independent same-app union evidence: this case isolates SSO.
    db.run("DELETE FROM multiremi_feishu_bot_senders WHERE id='card_person_sender'");
    const before = {
      parentActivity: store.listIssueActivity(parent.id).length,
      childActivity: store.listIssueActivity(child.id).length,
      inbox: store.listInboxItems(member.id).length,
      deliveries: (db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries").get() as { n: number }).n,
    };
    let wakes = 0;
    const events: string[] = [];
    const stopWake = store.onTaskEnqueued(() => { wakes += 1; });
    const stopEvents = store.onWorkspaceEvent(event => events.push(event.type));
    const host = await daemonToken(store);
    const response = await app(store).request(`/api/daemon/messages/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", token: cardAction(decision.id).t, expected_route_revision: cardAction(decision.id).route_revision, operator_open_id: CARD_OPEN_ID }),
    });
    stopWake();
    stopEvents();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "decision_member_unmapped" });
    expect(store.getIssueDecision(parent.id, decision.id)).toMatchObject({ status: "escalated", history: [] });
    expect(store.listIssueActivity(parent.id)).toHaveLength(before.parentActivity);
    expect(store.listIssueActivity(child.id)).toHaveLength(before.childActivity);
    expect(store.listInboxItems(member.id)).toHaveLength(before.inbox);
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries").get())
      .toEqual({ n: before.deliveries });
    expect(wakes).toBe(0);
    expect(events).toEqual([]);
  });

  it("resolves sender union_id only after the same app has seen the open_id", async () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Same-app identity", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const senderUser = store.getOrCreateUser({
      externalId: "ou_sender_sso", feishuUnionId: "on_same_app", name: "Sender member", email: "same-app@example.com",
    });
    const senderMember = store.createWorkspaceMember({
      workspaceId: "local", userId: senderUser.id, name: "Sender member", email: "same-app@example.com", role: "member",
    });
    const now = new Date().toISOString();
    db!.run(
      `INSERT INTO multiremi_feishu_bot_senders
       (id, workspace_id, app_id, open_id, union_id, display_name, allowed, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ["fbs_same_app", "local", "cli_issue_decision", "ou_same_app", "on_same_app", "Sender member", now, now],
    );
    store.updateIssue(parent.id, { responsibleMemberId: senderMember.id, actorType: "member", actorId: "mem_local_local" });
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store, "om_same_app", "ou_same_app")!;
    const host = await daemonToken(store);
    const response = await app(store).request(`/api/daemon/messages/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", token: cardAction(decision.id).t, expected_route_revision: cardAction(decision.id).route_revision, operator_open_id: "ou_same_app" }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(store.getIssueDecision(parent.id, decision.id)!.answeredByMemberId).toBe(senderMember.id);
  });

  it("rejects an open_id that maps to multiple live members without any write", async () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Ambiguous identity", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Deploy?",
    });
    const firstUser = store.getOrCreateUser({ externalId: "ou_ambiguous", name: "First", email: "first@example.com" });
    const secondUser = store.getOrCreateUser({ externalId: "ou_second_before_collision", name: "Second", email: "second@example.com" });
    db!.run("UPDATE multiremi_users SET external_id = ? WHERE id = ?", ["ou_ambiguous", secondUser.id]);
    for (const [userId, name, email] of [
      [firstUser.id, "First", "first@example.com"],
      [secondUser.id, "Second", "second@example.com"],
    ]) {
      store.createWorkspaceMember({ workspaceId: "local", userId, name, email, role: "member" });
    }
    sendCard(store, "om_ambiguous", "ou_ambiguous")!;
    const before = {
      decision: store.getIssueDecision(parent.id, decision.id),
      parentActivity: store.listIssueActivity(parent.id).length,
      childActivity: store.listIssueActivity(child.id).length,
      inbox: store.listInboxItems(member.id).length,
      deliveries: (db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries").get() as { n: number }).n,
      tasks: store.listTasksForIssue(child.id).length,
    };
    let wakes = 0;
    const events: string[] = [];
    const stopWake = store.onTaskEnqueued(() => { wakes += 1; });
    const stopEvents = store.onWorkspaceEvent(event => events.push(event.type));
    const host = await daemonToken(store);
    const response = await app(store).request(`/api/daemon/messages/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", token: cardAction(decision.id).t, expected_route_revision: cardAction(decision.id).route_revision, operator_open_id: "ou_ambiguous" }),
    });
    stopWake();
    stopEvents();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "decision_member_ambiguous" });
    expect(store.getIssueDecision(parent.id, decision.id)).toEqual(before.decision);
    expect(store.listIssueActivity(parent.id)).toHaveLength(before.parentActivity);
    expect(store.listIssueActivity(child.id)).toHaveLength(before.childActivity);
    expect(store.listInboxItems(member.id)).toHaveLength(before.inbox);
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries").get())
      .toEqual({ n: before.deliveries });
    expect(store.listTasksForIssue(child.id)).toHaveLength(before.tasks);
    expect(wakes).toBe(0);
    expect(events).toEqual([]);
  });

  it("detects multiple members reached through one same-app sender union_id", () => {
    const { store } = scaffold();
    const firstUser = store.getOrCreateUser({
      externalId: "ou_union_first", feishuUnionId: "on_ambiguous", name: "Union first", email: "union-first@example.com",
    });
    const secondUser = store.getOrCreateUser({
      externalId: "ou_union_second", feishuUnionId: "on_before_collision", name: "Union second", email: "union-second@example.com",
    });
    // Production historically allowed duplicate union ids; current fresh
    // schemas may have a uniqueness index, so remove it to exercise the legacy
    // rows the resolver must still reject safely.
    db!.run("DROP INDEX IF EXISTS idx_multiremi_users_feishu_union_id");
    db!.run("UPDATE multiremi_users SET feishu_union_id = ? WHERE id = ?", ["on_ambiguous", secondUser.id]);
    for (const [userId, name, email] of [
      [firstUser.id, "Union first", "union-first@example.com"],
      [secondUser.id, "Union second", "union-second@example.com"],
    ]) {
      store.createWorkspaceMember({ workspaceId: "local", userId, name, email, role: "member" });
    }
    const now = new Date().toISOString();
    db!.run(
      `INSERT INTO multiremi_feishu_bot_senders
       (id, workspace_id, app_id, open_id, union_id, display_name, allowed, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ["fbs_union_ambiguous", "local", "cli_issue_decision", "ou_union_ambiguous", "on_ambiguous", "Ambiguous", now, now],
    );
    expect(store.resolveFeishuDecisionOperatorMember("local", "cli_issue_decision", "ou_union_ambiguous"))
      .toEqual({ status: "ambiguous" });
  });

  it("cannot be answered with a task token, and a host outside the topic cannot read or answer", async () => {
    const { store, agentId } = scaffold();
    store.registerRuntime({ id: "rt_other", name: "Other host", provider: "codex", workspaceId: "local", daemonId: "other-host" });
    const parent = issueWithTopic(store, "Scoped", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store)!;
    const taskToken = await store.createTaskAccessToken(task, "local");
    const readPath = `/api/daemon/messages/${decision.id}`;
    const writePath = `${readPath}/answer`;

    // A task credential is not a card credential: S4 keeps the answer
    // member-or-parent-owner-only, and the daemon route does not accept it.
    const asTask = await app(store).request(writePath, {
      method: "POST",
      headers: { Authorization: `Bearer ${taskToken.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", token: cardAction(decision.id).t, expected_route_revision: cardAction(decision.id).route_revision, operator_open_id: CARD_OPEN_ID }),
    });
    expect(asTask.status).toBe(403);

    // A daemon that hosts no topic for this Issue may not reach either verb.
    const other = await daemonToken(store, "other-host");
    const read = await app(store).request(readPath, { headers: { Authorization: `Bearer ${other.token}` } });
    expect(read.status).toBe(403);
    const write = await app(store).request(writePath, {
      method: "POST",
      headers: { Authorization: `Bearer ${other.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", token: cardAction(decision.id).t, expected_route_revision: cardAction(decision.id).route_revision, operator_open_id: CARD_OPEN_ID }),
    });
    expect(write.status).toBe(403);
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("escalated");

    // The topic's own host may read it, which is what a click needs.
    const host = await daemonToken(store);
    const allowed = await app(store).request(readPath, { headers: { Authorization: `Bearer ${host.token}` } });
    expect(allowed.status).toBe(200);
  });

  it("ignores an answerer named in the request body", async () => {
    const { store, agentId, member } = scaffold();
    // A second member who must not be able to attribute an answer.
    const otherUser = store.getOrCreateUser({ externalId: "ou_other_member", name: "Other", email: "other@example.com" });
    const otherMember = store.createWorkspaceMember({
      workspaceId: "local", userId: otherUser.id, name: "Other", email: "other@example.com", role: "member",
    });
    const parent = issueWithTopic(store, "Forged body", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store)!;
    const host = await daemonToken(store);
    const response = await app(store).request(`/api/daemon/messages/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        answer: "yes", token: cardAction(decision.id).t, operator_open_id: CARD_OPEN_ID,
        expected_route_revision: cardAction(decision.id).route_revision,
        answered_by_member_id: otherMember.id, answererId: otherMember.id, answerer_id: otherMember.id,
        answererType: "agent", memberId: otherMember.id,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const settled = store.getIssueDecision(parent.id, decision.id)!;
    expect(settled.answeredByMemberId).toBe(member.id);
    expect(settled.answer?.answererId).toBe(member.id);
    expect(settled.answeredByMemberId).not.toBe(otherMember.id);
  });

  it("patches the existing card after a unified member revision and rejects callback replay", async () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Member revision", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store, "om_revision_card")!;
    const action = cardAction(decision.id);
    answerDecision(store, parent.id, decision.id, { answer: "Yes", reason: "Reviewed" }, { type: "member", id: member.id, taskId: null });
    const firstPatch = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(firstPatch.kind).toBe("decision_card_patch");
    const token = await store.createAccessToken({ name: "Revision member", type: "pat", workspaceId: "local", userId: store.getWorkspaceMember(member.id)!.userId! });
    const sessionId = store.getMessage(decision.id)!.session_id;
    const response = await app(store).request(`/api/sessions/${sessionId}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reply_to_id: decision.id, message_kind: "reply", body_md: "Hold for QA", expected_route_revision: store.getQuestion(decision.id)!.route_revision, expected_answer_revision: store.getQuestion(decision.id)!.answer_revision, revise: true, reason: "Human revises after QA review" }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const reply = (await response.json()).message;
    expect(store.getMessage(reply.id)).toMatchObject({ reply_to_id: decision.id, body_md: "Hold for QA", sender_id: member.id });
    expect(store.getIssueDecision(parent.id, decision.id)?.history).toHaveLength(2);
    const patches = db.query("SELECT body,target_message_id FROM multiremi_feishu_bot_outbound_deliveries WHERE kind='decision_card_patch' AND decision_id=?").all(decision.id);
    expect(patches).toHaveLength(2);
    expect(patches.every(p => p.target_message_id === "om_revision_card")).toBe(true);
    expect(patches.some(p => String(p.body).includes("Hold for QA"))).toBe(true);
    // A member may revise while the previous patch is leased. The new patch
    // waits for that delivery so the screen cannot regress to the old answer.
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    store.reportFeishuBotOutbound("local", "rt_bot", firstPatch.id, {
      claimToken: firstPatch.claimToken, status: "sent", externalMessageId: "om_revision_card",
    });
    const revisedPatch = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(revisedPatch.kind).toBe("decision_card_patch");
    expect(revisedPatch.targetMessageId).toBe("om_revision_card");
    expect(revisedPatch.body).toContain("Hold for QA");
    const counts = decisionSideEffectCounts();
    const host = await daemonToken(store);
    const replay = await app(store).request(`/api/daemon/messages/${decision.id}/answer`, {
      method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "Yes", token: action.t, operator_open_id: CARD_OPEN_ID }),
    });
    expect(replay.status).toBe(403);
    expect(decisionSideEffectCounts()).toEqual(counts);
    expect(store.getIssueDecision(parent.id, decision.id)?.history).toHaveLength(2);
  });

  it("chains later revisions after the newest patch when a legacy patch has no unit key", async () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Legacy patch revision", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store, "om_legacy_revision")!;
    answerDecision(store, parent.id, decision.id, { answer: "First", reason: "Reviewed" }, { type: "member", id: member.id, taskId: null });
    db.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET unit_key='' WHERE kind='decision_card_patch' AND decision_id=?", [decision.id]);
    const token = await store.createAccessToken({ name: "Legacy revision member", type: "pat", workspaceId: "local", userId: store.getWorkspaceMember(member.id)!.userId! });
    for (const body_md of ["Second", "Third"]) {
      const response = await app(store).request(`/api/sessions/${store.getMessage(decision.id)!.session_id}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reply_to_id: decision.id, body_md, expected_route_revision: store.getQuestion(decision.id)!.route_revision, expected_answer_revision: store.getQuestion(decision.id)!.answer_revision, revise: true, reason: "Human explicitly changes the previous answer" }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const patches = db.query("SELECT id,unit_key,previous_delivery_id FROM multiremi_feishu_bot_outbound_deliveries WHERE kind='decision_card_patch' AND decision_id=?").all(decision.id);
    const legacy = patches.find(p => p.unit_key === "")!;
    const second = patches.find(p => p.unit_key === "decision_state:0000000002")!;
    const third = patches.find(p => p.unit_key === "decision_state:0000000003")!;
    expect(patches).toHaveLength(3);
    expect(second.previous_delivery_id).toBe(legacy.id);
    expect(third.previous_delivery_id).toBe(second.id);
    for (const patch of [legacy, second, third]) {
      const claimed = store.claimFeishuBotOutbound("local", "rt_bot")!;
      expect(claimed.id).toBe(patch.id);
      expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
      store.reportFeishuBotOutbound("local", "rt_bot", claimed.id, {
        claimToken: claimed.claimToken, status: "sent", externalMessageId: "om_legacy_revision",
      });
    }
  });

  it("lands one answer for a double tap and for a replayed callback", async () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Replay", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store)!;
    const host = await daemonToken(store);
    const answer = (text: string) => app(store).request(
      `/api/daemon/messages/${decision.id}/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: text, token: cardAction(decision.id).t, expected_route_revision: cardAction(decision.id).route_revision, operator_open_id: CARD_OPEN_ID }),
      },
    );
    // Two callbacks in flight at once, then the same callback replayed.
    const [first, second] = await Promise.all([answer("yes"), answer("yes")]);
    expect([first.status, second.status].sort()).toEqual([200, 403]);
    expect(await (first.status === 403 ? first : second).json()).toMatchObject({ code: "token_consumed" });
    const third = await answer("no");
    expect(third.status).toBe(403);
    expect(await third.json()).toMatchObject({ code: "token_consumed" });
    const settled = store.getIssueDecision(parent.id, decision.id)!;
    expect(settled.status).toBe("answered");
    // One write: one history entry, one activity pair, one delivery patch.
    expect(settled.history).toHaveLength(1);
    expect(settled.answer?.answer).toBe("yes");
    expect(store.getQuestion(decision.id)?.history.filter(event => event.type === "answer")).toHaveLength(1);
    expect(store.listMessages(store.getMessage(decision.id)!.session_id).filter(message => message.reply_to_id === decision.id)).toHaveLength(1);
    expect(db!.query(
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch' AND decision_id = ?",
    ).get(decision.id)).toEqual({ n: 1 });
  });

  it("rewrites the card in place for a web answer and for a withdrawal", () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Web answer", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    const card = sendCard(store, "om_web_card")!;
    // Answered from the web workbench, not the card: the patch must still land,
    // and it must be queued inside the same transaction as the answer.
    answerDecision(store, parent.id, decision.id, { answer: "yes", reason: "Looks good", overturn: "" }, {
      type: "member", id: member.id, taskId: null,
    });
    const patch = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(patch.kind).toBe("decision_card_patch");
    expect(patch.targetMessageId).toBe("om_web_card");
    const terminal = JSON.stringify(JSON.parse(patch.body).card);
    expect(terminal).toContain("已回答");
    expect(terminal).toContain("yes");
    // The receipt names the answerer; card text escapes markdown punctuation,
    // so compare on the escaped form.
    expect(terminal).toContain("答者：");
    expect(terminal).toContain(member.id.replace(/_/g, "&#95;"));
    // Idempotent: a second terminal write queues nothing further.
    expect(() => answerDecision(store, parent.id, decision.id, { answer: "no", reason: "changed", overturn: "" }, {
      type: "member", id: member.id, taskId: null,
    })).toThrow("question_already_settled");
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();

    // Withdrawal is its own terminal state; the card is rewritten, not left
    // actionable, and never says "timed out" (E4 has no expiry).
    const second = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Withdraw me" });
    sendCard(store, "om_withdraw_card")!;
    closeDecision(store, parent.id, second.id, { type: "agent", id: agentId, taskId: task.id });
    const withdrawn = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(withdrawn.kind).toBe("decision_card_patch");
    expect(withdrawn.targetMessageId).toBe("om_withdraw_card");
    const text = JSON.stringify(JSON.parse(withdrawn.body).card);
    expect(text).toContain("已撤回");
    expect(text).not.toContain("已超时");
    expect(card.kind).toBe("decision_card");
  });

  it("never writes an expiry for a decision card", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "No timeout", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    const card = sendCard(store, "om_no_timeout")!;
    expect(card.expiresAt ?? null).toBeNull();
    expect(db!.query(
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_message_decision_records WHERE status = 'timeout'",
    ).get()).toEqual({ n: 0 });
    // Far past any plausible deadline the card is still the live question.
    const muchLater = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(store.getIssueDecision(parent.id, store.listFeishuIssueDecisionCards("local", "rt_bot")[0]!.decision_id)!.status)
      .toBe("escalated");
    expect(muchLater.getTime()).toBeGreaterThan(Date.now());
  });

  it("reminds exactly once, fifty minutes after the card was sent", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Reminder", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store)!;
    // Not yet: the nudge is not due.
    const early = new Date(Date.now() + 49 * 60 * 1000);
    expect(store.claimFeishuBotOutbound("local", "rt_bot", early)).toBeNull();
    const due = new Date(Date.now() + 51 * 60 * 1000);
    const reminder = store.claimFeishuBotOutbound("local", "rt_bot", due)!;
    expect(reminder.kind).toBe("decision_reminder");
    expect(reminder.decisionId).toBe(decision.id);
    expect(reminder.body).toContain("Deploy?");
    // It @s the person the card was addressed to.
    expect(reminder.mention).toMatchObject({ mode: "person", resolvedOpenId: CARD_OPEN_ID });
    store.reportFeishuBotOutbound("local", "rt_bot", reminder.id, {
      claimToken: reminder.claimToken, status: "sent", externalMessageId: "om_reminder",
    }, due);
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(due.getTime() + 60 * 60 * 1000))).toBeNull();
    expect(store.listIssueActivity(parent.id).filter(entry => entry.type === "decision_card_reminder")).toHaveLength(1);
    // The decision row is the once-only CAS after the delivery-based due check.
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_message_decision_records WHERE id = ?").get(decision.id))
      .toMatchObject({ reminder_sent_at: due.toISOString() });
  });

  it("starts the fifty-minute clock when an old pending decision is finally carded", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Old pending decision", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "criteria", title: "Merge?" });
    expect(decision.status).toBe("pending");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db!.run("UPDATE multiremi_conversation_log SET created_at = ?, updated_at = ? WHERE id = ?",
      [twoHoursAgo, twoHoursAgo, decision.id]);
    const ownerTask = parentTask(store, agentId, parent.id);
    escalateDecision(store, parent.id, decision.id, { type: "agent", id: agentId, taskId: ownerTask.id });
    const sentAt = new Date();
    sendCard(store, "om_old_pending", CARD_OPEN_ID, sentAt)!;
    expect(store.claimFeishuBotOutbound("local", "rt_bot", sentAt)).toBeNull();
    expect(store.claimFeishuBotOutbound(
      "local", "rt_bot", new Date(sentAt.getTime() + 49 * 60 * 1000),
    )).toBeNull();
    const reminder = store.claimFeishuBotOutbound(
      "local", "rt_bot", new Date(sentAt.getTime() + 50 * 60 * 1000),
    );
    expect(reminder).toMatchObject({ kind: "decision_reminder", decisionId: decision.id });
  });

  it("starts the fifty-minute clock when an offline host sends the queued card late", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Late card", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Deploy?",
    });
    const sentAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    // Until the host comes back this is still the original queued card. There is
    // no successful sent_at, so materializing the reminder is impossible.
    const card = store.claimFeishuBotOutbound("local", "rt_bot", sentAt)!;
    expect(card.kind).toBe("decision_card");
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_late_card", interactionOpenId: CARD_OPEN_ID,
    }, sentAt);
    expect(store.claimFeishuBotOutbound("local", "rt_bot", sentAt)).toBeNull();
    expect(store.claimFeishuBotOutbound(
      "local", "rt_bot", new Date(sentAt.getTime() + 49 * 60 * 1000),
    )).toBeNull();
    expect(store.claimFeishuBotOutbound(
      "local", "rt_bot", new Date(sentAt.getTime() + 50 * 60 * 1000),
    )).toMatchObject({ kind: "decision_reminder", decisionId: decision.id });
  });

  it("never reminds for a decision that was answered first", () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Answered early", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store, "om_early_card")!;
    answerDecision(store, parent.id, decision.id, { answer: "yes", reason: "ok", overturn: "" }, {
      type: "member", id: member.id, taskId: null,
    });
    const patch = store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 51 * 60 * 1000), true, true, true)!;
    expect(patch.kind).toBe("decision_card_patch");
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 52 * 60 * 1000))).toBeNull();
  });

  it("never reminds for a decision that was withdrawn first", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Withdrawn early", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store, "om_withdrawn_early")!;
    closeDecision(store, parent.id, decision.id, { type: "agent", id: agentId, taskId: task.id });
    const patch = store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 51 * 60 * 1000), true, true, true)!;
    expect(patch.kind).toBe("decision_card_patch");
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 52 * 60 * 1000))).toBeNull();
  });

  for (const mode of [
    { notifyMode: "none" as const, reason: "unresolved_recipient" as const, remove: "sender" },
    { notifyMode: "person" as const, notifyOpenId: "not-an-open-id", reason: "unresolved_recipient" as const, remove: "user" },
  ]) {
    it(`degrades to text when the designated human lacks verified ${mode.remove} mapping`, () => {
      const { store, agentId, member } = scaffold({ notifyMode: mode.notifyMode, notifyOpenId: mode.notifyOpenId });
      const parent = issueWithTopic(store, "Degraded", { type: "agent", id: agentId });
      const { child, task } = childWithTask(store, agentId, parent.id);
      if (mode.remove === "sender") db.run("DELETE FROM multiremi_feishu_bot_senders WHERE id='card_person_sender'");
      else db.run("UPDATE multiremi_users SET feishu_union_id=NULL WHERE id=?", [store.getWorkspaceMember(member.id)!.userId!]);
      const decision = raiseDecision(store, agentId, child.id, task.id, {
        kind: "production_change", title: "Deploy?", options: ["yes", "no"],
      });
      const delivery = store.claimFeishuBotOutbound("local", "rt_bot")!;
      expect(delivery.kind).toBe("decision_card");
      expect(delivery.degraded).toBe(mode.reason);
      // Plain text, not a card envelope: the host posts it verbatim.
      expect(decodeDecisionCardBody(delivery.body)).toBeNull();
      expect(delivery.body).toContain("Deploy?");
      expect(delivery.body).toContain("1. yes");
      expect(delivery.body).toContain(`https://remi.example.com/local/issues/${parent.id}`);
      const degraded = store.listIssueActivity(parent.id).find(entry => entry.type === "decision_card_degraded");
      expect(degraded).toBeTruthy();
      store.reportFeishuBotOutbound("local", "rt_bot", delivery.id, {
        claimToken: delivery.claimToken, status: "sent", externalMessageId: "om_text",
      });
      // A degraded decision has no card on screen, so no patch and no reminder.
      answerDecision(store, parent.id, decision.id, { answer: "yes", reason: "ok", overturn: "" }, {
        type: "member", id: member.id, taskId: null,
      });
      const later = store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 2 * 60 * 60 * 1000));
      expect(later ?? null).toBeNull();
    });
  }

  it("falls back to text when the host reports a terminal Feishu rejection", async () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Send failure", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    // The host already sent the text twin; it reports the degrade with the send.
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_fallback_text",
      interactionOpenId: null, degraded: "send_failed",
    });
    const activity = store.listIssueActivity(parent.id).find(entry => entry.type === "decision_card_degraded");
    expect(activity).toBeTruthy();
    expect(activity!.data as Record<string, unknown>).toMatchObject({
      decision_id: decision.id, reason: "send_failed",
    });
    // No reminder and no patch follow a degraded card.
    expect(store.listFeishuIssueDecisionCards("local", "rt_bot")).toEqual([]);
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 2 * 60 * 60 * 1000))).toBeNull();
  });

  it("keeps a retryable send failure on the outbox backoff", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Retryable", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
      claimToken: card.claimToken, status: "failed", error: "99991400 rate limited", retryable: true,
    });
    const row = db!.query(
      "SELECT status, attempt_count, degraded FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?",
    ).get(card.id) as { status: string; attempt_count: number; degraded: string | null };
    expect(row.status).toBe("pending");
    expect(row.attempt_count).toBe(1);
    expect(row.degraded).toBeNull();
    // No degradation activity: the row will be retried as a card.
    expect(store.listIssueActivity(parent.id).some(entry => entry.type === "decision_card_degraded")).toBe(false);
  });

  it("leaves no delivery row and no event when the escalation transaction fails midway", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Atomic escalate", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "criteria", title: "Merge?" });
    const ownerTask = parentTask(store, agentId, parent.id);
    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent(event => events.push(event.type));
    // The new writer durably queues presentation before dispatch. Fail after
    // that INSERT; neither intent, route, notification nor events may commit.
    const bot = (store as unknown as { ctx: StoreContext }).ctx.feishuBot();
    const original = bot.enqueueQuestionPresentationWithinTransaction.bind(bot);
    bot.enqueueQuestionPresentationWithinTransaction = (...args) => {
      original(...args);
      throw new Error("injected escalation failure");
    };
    let thrown: Error | null = null;
    try {
      escalateDecision(store, parent.id, decision.id, { type: "agent", id: agentId, taskId: ownerTask.id });
    } catch (error) {
      thrown = error as Error;
    } finally {
      bot.enqueueQuestionPresentationWithinTransaction = original;
      unsubscribe();
    }
    expect(thrown?.message).toBe("injected escalation failure");
    // Nothing survived: not the escalation, not the delivery, not an activity.
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("pending");
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE decision_id = ?")
      .get(decision.id)).toEqual({ n: 0 });
    expect(store.listIssueActivity(parent.id).filter(entry => entry.type === "decision_card_queued")).toHaveLength(0);
    expect(db.query('SELECT id FROM multiremi_feishu_bot_outbound_operations WHERE unit_key=?').all(decision.id)).toEqual([]);
    expect(store.getQuestion(decision.id)?.history).toEqual([]);
    expect(events.filter(type => type.startsWith("decision") || type === "activity:created")).toHaveLength(0);
    // The queue is still usable afterwards, and the row goes out once.
    escalateDecision(store, parent.id, decision.id, { type: "agent", id: agentId, taskId: ownerTask.id });
    expect(store.claimFeishuBotOutbound("local", "rt_bot")!.kind).toBe("decision_card");
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card' AND decision_id = ?")
      .get(decision.id)).toEqual({ n: 1 });
  });

  it("leaves no delivery row and no event when the answer transaction fails midway", () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Atomic answer", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store, "om_atomic")!;
    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent(event => events.push(event.type));
    const bot = (store as unknown as { ctx: StoreContext }).ctx.feishuBot();
    const original = bot.enqueueIssueDecisionCardPatchWithinTransaction.bind(bot);
    bot.enqueueIssueDecisionCardPatchWithinTransaction = (...args) => {
      original(...args);
      throw new Error("injected answer failure");
    };
    let thrown: Error | null = null;
    try {
      answerDecision(store, parent.id, decision.id, { answer: "yes", reason: "ok", overturn: "" },
        { type: "member", id: member.id, taskId: null });
    } catch (error) {
      thrown = error as Error;
    } finally {
      bot.enqueueIssueDecisionCardPatchWithinTransaction = original;
      unsubscribe();
    }
    expect(thrown?.message).toBe("injected answer failure");
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("escalated");
    expect(store.getIssueDecision(parent.id, decision.id)!.history).toHaveLength(0);
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch'")
      .get()).toEqual({ n: 0 });
    expect(store.listIssueActivity(parent.id).filter(entry => entry.type === "decision_answered")).toHaveLength(0);
    expect(events.filter(type => type.startsWith("decision") || type === "activity:created")).toHaveLength(0);
    // A retry after the rollback commits cleanly and queues exactly one patch.
    answerDecision(store, parent.id, decision.id, { answer: "yes", reason: "ok", overturn: "" },
      { type: "member", id: member.id, taskId: null });
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("answered");
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch'")
      .get()).toEqual({ n: 1 });
  });

  it("declares the decision-card capability separately from the human-request one", () => {
    const { store } = scaffold();
    // The heartbeat flag is what the queue filters on.
    expect(store.getRuntime("rt_bot")!.metadata[FEISHU_ISSUE_DECISION_CARD_CAPABILITY]).toBe(1);
    store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true, supportsIssueDecisionCard: false });
    expect(store.getRuntime("rt_bot")!.metadata[FEISHU_ISSUE_DECISION_CARD_CAPABILITY]).toBe(0);
    expect(store.supportsFeishuIssueDecisionCard("local", "rt_bot")).toBe(false);
  });

  it("lists only live decision cards for a restarting host, and only for a capable one", () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Recovery", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    const card = sendCard(store, "om_recoverable")!;
    expect(store.listFeishuIssueDecisionCards("local", "rt_bot")).toEqual([{
      decision_id: decision.id,
      issue_id: parent.id,
      chat_id: "oc_issue_decision",
      message_id: "om_recoverable",
      recipient_open_id: CARD_OPEN_ID,
    }]);
    expect(card.decisionId).toBe(decision.id);
    // A settled decision drops out: the button is no longer actionable.
    answerDecision(store, parent.id, decision.id, { answer: "yes", reason: "ok", overturn: "" }, {
      type: "member", id: member.id, taskId: null,
    });
    expect(store.listFeishuIssueDecisionCards("local", "rt_bot")).toEqual([]);
    // A host that never declared the capability recovers nothing.
    expect(store.listFeishuIssueDecisionCards("local", "nonexistent")).toEqual([]);
  });

  it("turns a channel click into the same answer, and refuses a strangled one", async () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Channel click", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Deploy?", options: ["yes", "no"],
    });
    sendCard(store, "om_clickable")!;
    const host = await daemonToken(store);
    const client = {
      getFeishuIssueDecision: async (decisionId: string) => {
        const response = await app(store).request(
          `/api/daemon/messages/${decisionId}`,
          { headers: { Authorization: `Bearer ${host.token}` } },
        );
        return response.ok ? (await response.json()).decision : null;
      },
      answerFeishuIssueDecision: async (decisionId: string, input: { answer: string; operatorOpenId: string; token: string; routeRevision?: number }) => {
        const response = await app(store).request(`/api/daemon/messages/${decisionId}/answer`, {
          method: "POST",
          headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
          body: JSON.stringify({ answer: input.answer, token: input.token, expected_route_revision: input.routeRevision, operator_open_id: input.operatorOpenId }),
        });
        if (!response.ok) {
          const error = await response.json();
          throw Object.assign(new Error(String(error.code ?? "request failed")), { code: error.code, status: response.status });
        }
        return (await response.json()).decision;
      },
    };
    registerIssueDecisionCardInteraction({
      appId: "cli_issue_decision", chatId: "oc_issue_decision", messageId: "om_clickable",
      recipientOpenId: CARD_OPEN_ID,
      getDecision: () => client.getFeishuIssueDecision(decision.id),
      submit: (answer, operatorOpenId, token, routeRevision) => client.answerFeishuIssueDecision(decision.id, { answer, operatorOpenId, token, routeRevision }),
    });
    const marker = decisionInteractionMarker(parent.id, decision.id);
    const wrongOperator = await handleIssueDecisionInteractionEvent("cli_issue_decision", {
      operator: { open_id: "ou_somebody_else" },
      context: { open_message_id: "om_clickable", open_chat_id: "oc_issue_decision" },
      action: { value: cardAction(decision.id), name: marker, form_value: { [`${marker}_answer`]: "yes" } },
    });
    expect(wrongOperator).toEqual({
      toast: { type: "error", content: OPERATOR_MISMATCH_TOAST },
    });
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("escalated");

    const click = await handleIssueDecisionInteractionEvent("cli_issue_decision", {
      operator: { open_id: CARD_OPEN_ID },
      context: { open_message_id: "om_clickable", open_chat_id: "oc_issue_decision" },
      action: { value: cardAction(decision.id), name: marker, form_value: { [`${marker}_answer`]: "自定义：先灰度" } },
    });
    expect(JSON.stringify(click)).toContain("已提交");
    const settled = store.getIssueDecision(parent.id, decision.id)!;
    expect(settled.status).toBe("answered");
    expect(settled.answer?.answer).toBe("自定义：先灰度");
    expect(settled.answeredByMemberId).toBe(member.id);
  });

  for (const failure of ["archived runtime workspace", "agent moved to another machine"] as const) {
    it(`preserves the valid historical answer and records ordinary source dispatch failure for ${failure}`, async () => {
      const { store, agentId } = scaffold();
      const parent = issueWithTopic(store, `Rolled back: ${failure}`, { type: "agent", id: agentId });
      const sourceAgentId = store.getFeishuBotConfig("local")!.agentId!;
      const runtimeWorkspace = store.runtimeWorkspaces.create("rt_bot", {
        name: `MUL-412 ${failure}`,
        root_path: `/tmp/mul412-${failure.replaceAll(" ", "-")}`,
      });
      const child = createResponsibleTestIssue(store, {
        title: "Decision source", workspaceId: "local", parentIssueId: parent.id,
        assigneeType: "agent", assigneeId: sourceAgentId, runtimeWorkspaceId: runtimeWorkspace.id,
      });
      const task = store.createTask({ agentId: sourceAgentId, issueId: child.id, workspaceId: "local", prompt: "Work" });
      const decision = raiseDecision(store, agentId, child.id, task.id, {
        kind: "production_change", title: "Deploy?", options: ["yes"],
      });
      sendCard(store, `om_${failure.replaceAll(" ", "_")}`)!;
      runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET status = 'completed' WHERE id = ?", [task.id]);
      if (failure === "archived runtime workspace") {
        store.runtimeWorkspaces.archive(runtimeWorkspace.id);
      } else {
        const other = store.registerRuntime({
          id: "rt_other_machine", name: "Other machine", provider: "codex",
          workspaceId: "local", daemonId: "other-machine",
        });
        store.updateAgent(sourceAgentId, { runtimeId: other.id });
      }

      const before = decisionSideEffectCounts();
      let wakes = 0;
      const events: string[] = [];
      const stopWake = store.onTaskEnqueued(() => { wakes += 1; });
      const stopEvents = store.onWorkspaceEvent(event => events.push(event.type));
      const messageId = `om_${failure.replaceAll(" ", "_")}`;
      const marker = decisionInteractionMarker(parent.id, decision.id);
      const registration = {
        current: null as ReturnType<typeof registerIssueDecisionCardInteraction> | null,
      };
      try {
        const result = await daemonClientOverTcp(store, async client => {
          registration.current = registerIssueDecisionCardInteraction({
            appId: "cli_issue_decision", chatId: "oc_issue_decision", messageId,
            recipientOpenId: CARD_OPEN_ID,
            getDecision: () => client.getFeishuIssueDecision(decision.id),
            submit: (answer, operatorOpenId, token, routeRevision) => client.answerFeishuIssueDecision(
              decision.id, { answer, operatorOpenId, token, routeRevision },
            ),
          });
          return handleIssueDecisionInteractionEvent("cli_issue_decision", {
            operator: { open_id: CARD_OPEN_ID },
            context: { open_message_id: messageId, open_chat_id: "oc_issue_decision" },
            action: { value: cardAction(decision.id), name: `${marker}_o0`, form_value: {} },
          });
        });
        expect(result?.toast).toEqual({ type: "success", content: "已提交" });
        expect(result).toHaveProperty("card");
      } finally {
        registration.current?.dispose();
        stopWake();
        stopEvents();
      }
      expect(store.getIssueDecision(parent.id, decision.id)).toMatchObject({ status: "answered", history: [expect.objectContaining({ answer: "yes" })] });
      const q = store.getQuestion(decision.id)!;
      expect(q).toMatchObject({ wait_status: "none", recovery: { consumer_turn_id: null, consumer_attempt_id: null, continuation_message_id: null } });
      const notification = q.history.find(event => event.type === "notify")!;
      expect(notification.reason).toStartWith("historical_source_dispatch_failed:");
      expect(store.getMessage(notification.source_message_id!)?.body_md).toContain("yes");
      const after = decisionSideEffectCounts();
      expect(after.multiremi_turns).toBe(before.multiremi_turns);
      expect(after.multiremi_turn_attempts).toBe(before.multiremi_turn_attempts);
      expect(wakes).toBe(0);
      expect(events).toContain("decision:updated");
    });
  }

  it("keeps a source-Q disappearance 404 non-terminal after a successful GET", async () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Missing card context", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Deploy?", options: ["yes"],
    });
    const messageId = "om_context_removed";
    sendCard(store, messageId)!;
    const marker = decisionInteractionMarker(parent.id, decision.id);
    let before: Record<string, number> | null = null;
    let wakes = 0;
    const events: string[] = [];
    const stopWake = store.onTaskEnqueued(() => { wakes += 1; });
    const stopEvents = store.onWorkspaceEvent(event => events.push(event.type));
    const registration = {
      current: null as ReturnType<typeof registerIssueDecisionCardInteraction> | null,
    };
    try {
      const result = await daemonClientOverTcp(store, async client => {
        registration.current = registerIssueDecisionCardInteraction({
          appId: "cli_issue_decision", chatId: "oc_issue_decision", messageId,
          recipientOpenId: CARD_OPEN_ID,
          getDecision: async () => {
            const current = await client.getFeishuIssueDecision(decision.id);
            db!.run("DELETE FROM multiremi_conversation_log WHERE id = ?", [decision.id]);
            before = decisionSideEffectCounts();
            return current;
          },
          submit: (answer, operatorOpenId, token, routeRevision) => client.answerFeishuIssueDecision(
            decision.id, { answer, operatorOpenId, token, routeRevision },
          ),
        });
        return handleIssueDecisionInteractionEvent("cli_issue_decision", {
          operator: { open_id: CARD_OPEN_ID },
          context: { open_message_id: messageId, open_chat_id: "oc_issue_decision" },
          action: { value: cardAction(decision.id), name: `${marker}_o0`, form_value: {} },
        });
      });
      expect(result?.toast).toEqual({ type: "error", content: DECISION_NOT_SUBMITTED_TOAST });
      expect(result).not.toHaveProperty("card");
    } finally {
      registration.current?.dispose();
      stopWake();
      stopEvents();
    }
    expect(before).not.toBeNull();
    expect(decisionSideEffectCounts()).toEqual(before!);
    expect(store.getIssueDecision(parent.id, decision.id)).toBeNull();
    expect(wakes).toBe(0);
    expect(events).toEqual([]);
  });

  for (const missing of ["issue", "decision"] as const) {
    it(`keeps a GET 404 for a missing ${missing} non-terminal`, async () => {
      const { store, agentId } = scaffold();
      const parent = issueWithTopic(store, `Missing ${missing}`, { type: "agent", id: agentId });
      const issueId = missing === "issue" ? "iss_missing" : parent.id;
      const decisionId = "dcs_missing";
      const messageId = `om_missing_${missing}`;
      const marker = decisionInteractionMarker(issueId, decisionId);
      const registration = {
        current: null as ReturnType<typeof registerIssueDecisionCardInteraction> | null,
      };
      try {
        const result = await daemonClientOverTcp(store, async client => {
          registration.current = registerIssueDecisionCardInteraction({
            appId: "cli_issue_decision", chatId: "oc_issue_decision", messageId,
            recipientOpenId: CARD_OPEN_ID,
            getDecision: () => client.getFeishuIssueDecision(decisionId),
            submit: (answer, operatorOpenId, token, routeRevision) => client.answerFeishuIssueDecision(
              decisionId, { answer, operatorOpenId, token, routeRevision },
            ),
          });
          return handleIssueDecisionInteractionEvent("cli_issue_decision", {
            operator: { open_id: CARD_OPEN_ID },
            context: { open_message_id: messageId, open_chat_id: "oc_issue_decision" },
            action: { value: { t: "missing-card-fixture", message_id: decisionId }, name: marker, form_value: { [`${marker}_answer`]: "yes" } },
          });
        });
        expect(result?.toast).toEqual({ type: "error", content: DECISION_NOT_SUBMITTED_TOAST });
        expect(result).not.toHaveProperty("card");
      } finally {
        registration.current?.dispose();
      }
    });
  }

  it("re-reads a withdrawal inserted at the answer boundary and returns a terminal receipt", async () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Withdraw race", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Deploy?", options: ["yes"],
    });
    const messageId = "om_withdraw_race";
    sendCard(store, messageId)!;
    const marker = decisionInteractionMarker(parent.id, decision.id);
    const originalAnswer = store.answerMessageDecision.bind(store);
    const injectedAnswer: typeof store.answerMessageDecision = (...args) => {
      closeDecision(store, parent.id, decision.id, { type: "agent", id: agentId, taskId: task.id });
      return originalAnswer(...args);
    };
    store.answerMessageDecision = injectedAnswer;
    const registration = {
      current: null as ReturnType<typeof registerIssueDecisionCardInteraction> | null,
    };
    try {
      const result = await daemonClientOverTcp(store, async client => {
        registration.current = registerIssueDecisionCardInteraction({
          appId: "cli_issue_decision", chatId: "oc_issue_decision", messageId,
          recipientOpenId: CARD_OPEN_ID,
          getDecision: () => client.getFeishuIssueDecision(decision.id),
          submit: (answer, operatorOpenId, token, routeRevision) => client.answerFeishuIssueDecision(
            decision.id, { answer, operatorOpenId, token, routeRevision },
          ),
        });
        return handleIssueDecisionInteractionEvent("cli_issue_decision", {
          operator: { open_id: CARD_OPEN_ID },
          context: { open_message_id: messageId, open_chat_id: "oc_issue_decision" },
          action: { value: cardAction(decision.id), name: `${marker}_o0`, form_value: {} },
        });
      });
      expect(result?.toast).toEqual({ type: "info", content: DECISION_FINISHED_TOAST });
      expect(result).toHaveProperty("card");
      expect(store.getIssueDecision(parent.id, decision.id)?.status).toBe("withdrawn");
    } finally {
      registration.current?.dispose();
      store.answerMessageDecision = originalAnswer;
    }
  });

  it("rejects an already-answered concurrent callback and renders its receipt", async () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Answer race", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Deploy?", options: ["yes"],
    });
    const messageId = "om_answer_race";
    sendCard(store, messageId)!;
    const marker = decisionInteractionMarker(parent.id, decision.id);
    let raced = false;
    const registration = {
      current: null as ReturnType<typeof registerIssueDecisionCardInteraction> | null,
    };
    try {
      const result = await daemonClientOverTcp(store, async client => {
        registration.current = registerIssueDecisionCardInteraction({
          appId: "cli_issue_decision", chatId: "oc_issue_decision", messageId,
          recipientOpenId: CARD_OPEN_ID,
          getDecision: async () => {
            const current = await client.getFeishuIssueDecision(decision.id);
            if (!raced) {
              raced = true;
              await client.answerFeishuIssueDecision(decision.id, {
                answer: "yes", operatorOpenId: CARD_OPEN_ID, token: String(cardAction(decision.id).t),
                routeRevision: Number(cardAction(decision.id).route_revision),
              });
            }
            return current;
          },
          submit: (answer, operatorOpenId, token, routeRevision) => client.answerFeishuIssueDecision(
            decision.id, { answer, operatorOpenId, token, routeRevision },
          ),
        });
        return handleIssueDecisionInteractionEvent("cli_issue_decision", {
          operator: { open_id: CARD_OPEN_ID },
          context: { open_message_id: messageId, open_chat_id: "oc_issue_decision" },
          action: { value: cardAction(decision.id), name: `${marker}_o0`, form_value: {} },
        });
      });
      expect(result?.toast).toEqual({ type: "info", content: DECISION_FINISHED_TOAST });
      expect(result).toHaveProperty("card");
      expect(store.getIssueDecision(parent.id, decision.id)).toMatchObject({ status: "answered" });
      expect(store.getIssueDecision(parent.id, decision.id)?.history).toHaveLength(1);
    } finally {
      registration.current?.dispose();
    }
  });

  it("covers every Issue-decision handler return with a complete toast", async () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Handler return table", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Deploy?", options: ["yes"],
    });
    const marker = decisionInteractionMarker(parent.id, decision.id);
    const rows = [
      { name: "non-fd action", route: "ignored", expected: null, ignored: true },
      { name: "card not registered", route: "missing_entry", expected: { type: "info", content: CARD_RECOVERING_TOAST } },
      { name: "server operator mismatch", route: "operator", expected: { type: "error", content: OPERATOR_MISMATCH_TOAST } },
      { name: "GET failure", route: "get_error", expected: { type: "error", content: "本次没有提交：提交失败，请稍后重试（错误码：handler_read_failed）。" } },
      { name: "GET null", route: "get_null", expected: { type: "info", content: CARD_RECOVERING_TOAST } },
      { name: "GET terminal", route: "get_answered", expected: { type: "info", content: DECISION_FINISHED_TOAST }, receipt: true },
      { name: "button mismatch", route: "button_mismatch", expected: { type: "error", content: "本次没有提交：这个按钮和卡片上当前的问题对不上，可能是旧卡片。请到网页端回答。" } },
      { name: "invalid custom answer", route: "invalid_custom", expected: { type: "error", content: "本次没有提交：自定义回答的格式无法识别。请重新填写文字后再提交，或到网页端回答。" } },
      { name: "choices but empty", route: "empty_choices", expected: { type: "error", content: "本次没有提交：请选择一项，或填写自定义回答后再提交。" } },
      { name: "no choices and empty", route: "empty_no_choices", expected: { type: "error", content: "本次没有提交：请填写回答后再提交。" } },
      { name: "POST answered", route: "post_answered", expected: { type: "success", content: "已提交" }, receipt: true, submitted: true },
      { name: "POST withdrawn", route: "post_withdrawn", expected: { type: "info", content: DECISION_FINISHED_TOAST }, receipt: true },
      { name: "POST still escalated", route: "post_escalated", expected: { type: "error", content: DECISION_NOT_SUBMITTED_TOAST } },
      { name: "POST failure", route: "post_error", expected: { type: "error", content: DECISION_NOT_SUBMITTED_TOAST } },
    ] as const;
    let activeRoute: typeof rows[number]["route"] = "ignored";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.method === "GET") {
          if (activeRoute === "get_error") {
            return Response.json({ error: "fixture", code: "handler_read_failed" }, { status: 500 });
          }
          if (activeRoute === "get_null") return Response.json({ decision: null });
          const status = activeRoute === "get_answered" ? "answered" : "escalated";
          const options = activeRoute === "empty_no_choices" ? [] : decision.options;
          return Response.json({ decision: { ...decision, status, options } });
        }
        if (activeRoute === "post_error") return Response.json({ error: "decision not found" }, { status: 404 });
        if (activeRoute === "operator") return Response.json({ code: "recipient_mismatch" }, { status: 403 });
        if (activeRoute === "get_answered") return Response.json({ code: "token_consumed" }, { status: 403 });
        const status = activeRoute === "post_withdrawn"
          ? "withdrawn"
          : activeRoute === "post_escalated" ? "escalated" : "answered";
        return Response.json({ decision: { ...decision, status } });
      },
    });
    const client = new MultiremiDaemonClient(server.url.origin, "daemon-test-token");
    try {
      for (const [index, row] of rows.entries()) {
        activeRoute = row.route;
        const messageId = `om_handler_return_${index}`;
        const shouldRegister = row.route !== "missing_entry" && row.route !== "ignored";
        const registration = shouldRegister ? registerIssueDecisionCardInteraction({
          appId: "cli_issue_decision", chatId: "oc_issue_decision", messageId,
          recipientOpenId: CARD_OPEN_ID,
          getDecision: () => client.getFeishuIssueDecision(decision.id),
          submit: (answer, operatorOpenId, token, routeRevision) => client.answerFeishuIssueDecision(
            decision.id, { answer, operatorOpenId, token, routeRevision },
          ),
        }) : null;
        const actionName = row.route === "ignored"
          ? "fr_not_an_issue_decision"
          : row.route === "button_mismatch" ? "fd_stale_button"
            : row.route === "empty_choices" || row.route === "empty_no_choices"
              ? marker : `${marker}_o0`;
        const formValue = row.route === "invalid_custom"
          ? { [`${marker}_answer`]: { unsupported: true } }
          : {};
        try {
          const result = await handleIssueDecisionInteractionEvent("cli_issue_decision", {
            operator: { open_id: row.route === "operator" ? "ou_somebody_else" : CARD_OPEN_ID },
            context: { open_message_id: messageId, open_chat_id: "oc_issue_decision" },
            action: { value: cardAction(decision.id), name: actionName, form_value: formValue },
          });
          if (row.expected === null) {
            expect(result, row.name).toBeNull();
            continue;
          }
          expect(result?.toast, row.name).toEqual(row.expected);
          expect(Boolean(result && "card" in result), row.name).toBe("receipt" in row && row.receipt === true);
          if (!("submitted" in row && row.submitted)) {
            const toast = result?.toast as { content?: unknown } | undefined;
            expect(typeof toast?.content, row.name).toBe("string");
            if (typeof toast?.content !== "string") throw new Error(`${row.name}: toast content is missing`);
            expect(toast.content.startsWith("本次没有提交："), row.name).toBe(true);
            expect(toast.content, row.name).toContain("请");
          }
        } finally {
          registration?.dispose();
        }
      }
    } finally {
      await server.stop(true);
    }
  });

  it("maps all 24 callback failure and terminal combinations to complete user-facing toasts", async () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Callback errors", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Deploy?", options: ["yes"],
    });
    const marker = decisionInteractionMarker(parent.id, decision.id);
    const action = (messageId: string) => ({
      operator: { open_id: CARD_OPEN_ID },
      context: { open_message_id: messageId, open_chat_id: "oc_issue_decision" },
      action: { value: cardAction(decision.id), name: `${marker}_o0`, form_value: {} },
    });
    type Stage = "read" | "submit";
    const cases = [
      {
        name: "GET unmapped", stage: "read", response: "http", status: 403, code: "decision_member_unmapped",
        expected: "本次没有提交：飞书身份还未关联到 Remi 成员。请先用飞书登录一次网页端，或在本话题给机器人发一条消息后再试；也可以直接去网页端回答。",
      },
      {
        name: "POST unmapped", stage: "submit", response: "http", status: 403, code: "decision_member_unmapped",
        expected: "本次没有提交：飞书身份还未关联到 Remi 成员。请先用飞书登录一次网页端，或在本话题给机器人发一条消息后再试；也可以直接去网页端回答。",
      },
      {
        name: "GET ambiguous", stage: "read", response: "http", status: 403, code: "decision_member_ambiguous",
        expected: "本次没有提交：飞书身份关联到多个 Remi 成员。请去网页端回答。",
      },
      {
        name: "POST ambiguous", stage: "submit", response: "http", status: 403, code: "decision_member_ambiguous",
        expected: "本次没有提交：飞书身份关联到多个 Remi 成员。请去网页端回答。",
      },
      {
        name: "GET mismatch", stage: "read", response: "http", status: 403, code: "decision_operator_mismatch",
        expected: OPERATOR_MISMATCH_TOAST,
      },
      {
        name: "POST mismatch", stage: "submit", response: "http", status: 403, code: "decision_operator_mismatch",
        expected: OPERATOR_MISMATCH_TOAST,
      },
      { name: "GET 404", stage: "read", response: "http", status: 404, code: null, expected: DECISION_NOT_SUBMITTED_TOAST },
      { name: "POST 404", stage: "submit", response: "http", status: 404, code: null, expected: DECISION_NOT_SUBMITTED_TOAST },
      { name: "GET 409", stage: "read", response: "http", status: 409, code: null, expected: DECISION_NOT_SUBMITTED_TOAST },
      { name: "POST 409", stage: "submit", response: "http", status: 409, code: null, expected: DECISION_NOT_SUBMITTED_TOAST },
      {
        name: "POST plugin version unavailable", stage: "submit", response: "http", status: 409,
        code: "plugin_version_unavailable",
        expected: "本次没有提交：这次没能提交（错误码：plugin_version_unavailable）。这个决定可能还没结束，请到网页端查看；如果还在等回答，请在网页端回答。",
      },
      {
        name: "GET 500", stage: "read", response: "http", status: 500, code: "decision_backend_failed",
        expected: "本次没有提交：提交失败，请稍后重试（错误码：decision_backend_failed）。",
      },
      {
        name: "POST 500", stage: "submit", response: "http", status: 500, code: "decision_backend_failed",
        expected: "本次没有提交：提交失败，请稍后重试（错误码：decision_backend_failed）。",
      },
      { name: "GET connection refused", stage: "read", response: "refused", expected: "本次没有提交：提交失败，请稍后重试（错误码：ConnectionRefused）。" },
      { name: "POST connection refused", stage: "submit", response: "refused", expected: "本次没有提交：提交失败，请稍后重试（错误码：ConnectionRefused）。" },
      { name: "GET timeout", stage: "read", response: "timeout", expected: "本次没有提交：提交失败，请稍后重试。" },
      { name: "POST timeout", stage: "submit", response: "timeout", expected: "本次没有提交：提交失败，请稍后重试。" },
      { name: "GET non-JSON error", stage: "read", response: "non_json_error", expected: "本次没有提交：提交失败，请稍后重试。" },
      { name: "POST non-JSON error", stage: "submit", response: "non_json_error", expected: "本次没有提交：提交失败，请稍后重试。" },
      { name: "GET 200 non-JSON", stage: "read", response: "non_json_ok", expected: "本次没有提交：提交失败，请稍后重试。" },
      { name: "POST 200 non-JSON", stage: "submit", response: "non_json_ok", expected: "本次没有提交：提交失败，请稍后重试。" },
      { name: "GET answered", stage: "read", response: "decision", decisionStatus: "answered", expected: DECISION_FINISHED_TOAST, toastType: "info", receipt: true },
      { name: "GET withdrawn", stage: "read", response: "decision", decisionStatus: "withdrawn", expected: DECISION_FINISHED_TOAST, toastType: "info", receipt: true },
      { name: "POST withdrawn", stage: "submit", response: "decision", decisionStatus: "withdrawn", expected: DECISION_FINISHED_TOAST, toastType: "info", receipt: true },
    ] as const;
    expect(cases).toHaveLength(24);

    let activeCase: typeof cases[number] | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const testCase = activeCase;
        if (!testCase) return new Response("no callback case", { status: 500 });
        const stage: Stage = request.method === "POST" ? "submit" : "read";
        const targeted = stage === testCase.stage;
        if (!targeted) {
          return Response.json({ decision: { ...decision, status: "escalated" } });
        }
        if (testCase.response === "timeout") {
          await Bun.sleep(100);
          return Response.json({ decision: { ...decision, status: "escalated" } });
        }
        if (testCase.response === "non_json_error") {
          return new Response("not JSON", { status: 500 });
        }
        if (testCase.response === "non_json_ok") {
          return new Response("not JSON", { status: 200 });
        }
        if (testCase.response === "decision") {
          return Response.json({ decision: { ...decision, status: testCase.decisionStatus } });
        }
        if (testCase.response === "http") {
          return Response.json({
            error: "raw server detail must not reach the toast",
            code: testCase.code,
          }, { status: testCase.status });
        }
        return new Response("refused scenarios must use the closed listener", { status: 500 });
      },
    });
    const closedServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
    const refusedOrigin = closedServer.url.origin;
    await closedServer.stop(true);
    const client = new MultiremiDaemonClient(server.url.origin, "daemon-test-token", { requestTimeoutMs: 25 });
    const refusedClient = new MultiremiDaemonClient(refusedOrigin, "daemon-test-token", { requestTimeoutMs: 100 });
    try {
      for (const [index, testCase] of cases.entries()) {
        activeCase = testCase;
        const messageId = `om_callback_error_${index}`;
        const readClient = testCase.response === "refused" && testCase.stage === "read" ? refusedClient : client;
        const submitClient = testCase.response === "refused" && testCase.stage === "submit" ? refusedClient : client;
        const registration = registerIssueDecisionCardInteraction({
          appId: "cli_issue_decision",
          chatId: "oc_issue_decision",
          messageId,
          recipientOpenId: CARD_OPEN_ID,
          getDecision: () => readClient.getFeishuIssueDecision(decision.id),
          submit: (answer, operatorOpenId, token, routeRevision) => submitClient.answerFeishuIssueDecision(
            decision.id,
            { answer, operatorOpenId, token, routeRevision },
          ),
        });
        try {
          const result = await handleIssueDecisionInteractionEvent("cli_issue_decision", action(messageId));
          expect(result?.toast, testCase.name).toEqual({
            type: "toastType" in testCase ? testCase.toastType : "error",
            content: testCase.expected,
          });
          expect(Boolean(result && "card" in result), testCase.name)
            .toBe("receipt" in testCase && testCase.receipt === true);
          if (testCase.response === "http" && (testCase.status === 404 || testCase.status === 409)) {
            expect(store.getIssueDecision(parent.id, decision.id)?.status, testCase.name).toBe("escalated");
          }
        } finally {
          registration.dispose();
        }
      }
    } finally {
      activeCase = null;
      await server.stop(true);
    }
  });
});

/** A master-token app over the same store, for the HTTP assertions. */
function app(store: MultiremiStore) {
  return createMultiremiApp({ store, authToken: "MASTER" });
}
});

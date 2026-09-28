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
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { decodeDecisionCardBody } from "@shared/feishu-task-card.js";
import {
  decisionInteractionMarker,
  handleIssueDecisionInteractionEvent,
  registerIssueDecisionCardInteraction,
} from "@connectors/feishu/task-interaction.js";
import { FEISHU_ISSUE_DECISION_CARD_CAPABILITY } from "@multiremi/contracts/types.js";
import { MultiremiDaemonClient } from "@multiremi/worker/client.js";
import { restoreMul412Baseline828291b9Schema, tableColumns } from "./mul412-schema-fixture.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
const CARD_OPEN_ID = "ou_the_person";
const OPERATOR_MISMATCH_TOAST = "本次没有提交：这条只能由卡片上点名的人回答。请转告对方在卡片上回答；如果你也是这张单的负责人，可以到网页端回答。";
const DECISION_FINISHED_TOAST = "本次没有提交：这个决定已经结束了。请到网页端查看最新结果，不需要再提交。";

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
    externalId: CARD_OPEN_ID, name: "贺华杰", email: "hehuajie@example.com",
  });
  db!.run("UPDATE multiremi_workspace_members SET user_id = ? WHERE id = ?", [user.id, member.id]);
  const agentId = store.createAgent({ name: "Concierge", provider: "codex", workspaceId: "local" }).id;
  store.registerRuntime({ id: "rt_bot", name: "Bot host", provider: "codex", workspaceId: "local", daemonId: "bot-host" });
  store.heartbeatRuntime("rt_bot", {
    supportsFeishuBotConfig: true,
    ...(options.hostSupportsIssueDecisions === false ? {} : { supportsIssueDecisionCard: true }),
  });
  const config = store.upsertFeishuBotConfig("local", {
    agentId, runtimeId: "rt_bot", appId: "cli_issue_decision", appSecretOp: "set",
    appSecret: APP_SECRET, domain: "feishu", enabled: true,
  });
  store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: config.revision, state: "online" });
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
  const issue = store.createIssue({
    title, workspaceId: "local",
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
function childWithTask(store: MultiremiStore, agentId: string, parentId: string) {
  const child = store.createIssue({
    title: "Decision source", workspaceId: "local", parentIssueId: parentId,
    assigneeType: "agent", assigneeId: agentId,
  });
  const task = store.createTask({ agentId, issueId: child.id, workspaceId: "local", prompt: "Work" });
  return { child, task };
}

/** The parent's owner-task round: escalating and agent-answering require it. */
function parentTask(store: MultiremiStore, agentId: string, parentId: string) {
  return store.createTask({ agentId, issueId: parentId, workspaceId: "local", prompt: "Own the parent" });
}

function raiseDecision(
  store: MultiremiStore,
  agentId: string,
  childId: string,
  taskId: string,
  input: { kind: string; title: string; options?: string[] },
) {
  return store.createIssueDecision(childId, {
    kind: input.kind, title: input.title, body: `${input.title} context`,
    ...(input.options ? { options: input.options } : {}),
  }, { type: "agent", id: agentId, taskId });
}

function sendCard(store: MultiremiStore, messageId = "om_card", openId = CARD_OPEN_ID, sentAt?: Date) {
  const card = store.claimFeishuBotOutbound("local", "rt_bot");
  if (!card) return null;
  store.reportFeishuBotOutbound("local", "rt_bot", card.id, {
    claimToken: card.claimToken, status: "sent", externalMessageId: messageId, interactionOpenId: openId,
  }, sentAt);
  return card;
}

function daemonToken(store: MultiremiStore, daemonId = "bot-host") {
  return store.createAccessToken({ name: daemonId, type: "daemon", workspaceId: "local", daemonId });
}

describe("MUL-412 issue decision cards", () => {
  it("upgrades the SQLite 828291b9 schema twice without losing existing rows", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "SQLite upgrade", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Keep this row",
    });
    const card = store.claimFeishuBotOutbound("local", "rt_bot")!;
    const deliveryId = card.id;
    restoreMul412Baseline828291b9Schema(db!);
    expect(tableColumns(db!, "multiremi_issue_decisions")).not.toContain("reminder_sent_at");
    expect(tableColumns(db!, "multiremi_feishu_bot_outbound_deliveries")).not.toContain("decision_id");
    expect(tableColumns(db!, "multiremi_issues")).not.toContain("parent_done_grant_at");

    // Each construction runs the complete current migration. The second run is
    // the idempotency pass required by the upgrade gate.
    new MultiremiStore(db!);
    new MultiremiStore(db!);
    expect(tableColumns(db!, "multiremi_issue_decisions")).toContain("reminder_sent_at");
    expect(tableColumns(db!, "multiremi_feishu_bot_outbound_deliveries"))
      .toEqual(expect.arrayContaining(["decision_id", "decision_issue_id"]));
    expect(tableColumns(db!, "multiremi_issues"))
      .toEqual(expect.arrayContaining(["parent_done_grant_at", "parent_done_grant_by", "parent_done_grant_agent_id"]));
    expect(db!.query("SELECT title, status FROM multiremi_issue_decisions WHERE id = ?").get(decision.id))
      .toEqual({ title: "Keep this row", status: "escalated" });
    expect(db!.query("SELECT id, status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(deliveryId))
      .toEqual({ id: deliveryId, status: "sending" });
    expect(db!.query(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_multiremi_feishu_bot_outbound_decision'",
    ).get()).toEqual({ n: 1 });
  });

  it("sends a card when the owner agent escalates a decision to a person", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Escalated decision", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    // A merge decision first goes to the parent's owner agent, so no card.
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "merge", title: "Merge the change" });
    expect(decision.status).toBe("pending");
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card'").get())
      .toEqual({ n: 0 });
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("pending");

    const ownerTask = parentTask(store, agentId, parent.id);
    store.escalateIssueDecision(parent.id, decision.id, { type: "agent", id: agentId, taskId: ownerTask.id });
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

  it("does not card a decision the parent's owner agent answers itself", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Self-answered", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "criteria", title: "Acceptance terms" });
    expect(decision.status).toBe("pending");
    const ownerTask = parentTask(store, agentId, parent.id);
    store.answerIssueDecision(parent.id, decision.id, {
      answer: "Keep them", reason: "The document is the spec", overturn: "A member can revise it",
    }, { type: "agent", id: agentId, taskId: ownerTask.id });
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("answered");
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind LIKE 'decision%'").get())
      .toEqual({ n: 0 });
  });

  it("skips the card and records why when the Issue topic has no seed message", () => {
    const { store, agentId } = scaffold();
    // No `prepareFeishuIssueTopicWithinTransaction`, so the binding exists
    // without a `reply_to_message_id`: there is no thread to reply into.
    const parent = store.createIssue({ title: "Unsown topic", workspaceId: "local", assigneeType: "agent", assigneeId: agentId });
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
      "SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE decision_id IS NOT NULL",
    ).get()).toEqual({ n: 0 });
    // Skipped without a card: the skip activity is only for a missing topic.
    expect(store.listIssueActivity(parent.id).filter(entry => entry.type === "decision_card_skipped")).toHaveLength(0);
    expect(store.listIssueActivity(parent.id).some(entry => entry.type === "decision_escalated")).toBe(true);
  });

  it("answers a card click through the same store write as the HTTP answer route", async () => {
    const { store, agentId, member } = scaffold();
    const parent = issueWithTopic(store, "Card click", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    // Model the source task as in flight. The answer must enqueue one fresh
    // continuation and wake it, rather than merely append to an existing queued
    // task (which deliberately emits no second wake).
    db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [task.id]);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?", options: ["yes", "no"] });
    sendCard(store, "om_answer_card");
    const host = await daemonToken(store);
    const wakeTaskIds: string[] = [];
    const stopWake = store.onTaskEnqueued(task => wakeTaskIds.push(task.id));
    const answerPath = `/api/daemon/issues/${parent.id}/decisions/${decision.id}/answer`;
    const response = await app(store).request(answerPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes\n自定义回答：after CI", operator_open_id: CARD_OPEN_ID }),
    });
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
    expect(store.listIssueActivity(parent.id).some(entry => entry.type === "decision_answered")).toBe(true);
    expect(store.listIssueActivity(child.id).some(entry => entry.type === "decision_received")).toBe(true);
    const sourceOwnerTask = store.listTasksForIssue(child.id).find(item => item.status === "queued");
    expect(sourceOwnerTask).toBeTruthy();
    expect(sourceOwnerTask!.prompt).toContain(decision.id);
    expect(sourceOwnerTask).toMatchObject({
      delegationId: null,
      delegatedByAgentId: null,
      delegatedFromIssueSessionId: null,
      delegationSkipReason: null,
      wakeSource: null,
    });
    expect(store.listInboxItems(member.id)).toHaveLength(1);
    expect(store.listInboxItems(member.id)[0]).toMatchObject({
      type: "decision_requested", issueId: parent.id,
    });
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
    const response = await app(store).request(`/api/daemon/issues/${parent.id}/decisions/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", operator_open_id: "ou_somebody_else" }),
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
      `/api/daemon/issues/${parent.id}/decisions/${decision.id}/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes", operator_open_id: "ou_other_member" }),
      },
    );
    expect(notAddressed.status).toBe(403);
    expect(await notAddressed.json()).toMatchObject({ code: "decision_operator_mismatch" });
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
      `/api/daemon/issues/${parent.id}/decisions/${decision.id}/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes", operator_open_id: openId }),
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
      `/api/daemon/issues/${bobIssue.id}/decisions/${bobDecision.id}/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes", operator_open_id: "ou_bob" }),
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
      `/api/daemon/issues/${stranger.id}/decisions/${strangerDecision.id}/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes", operator_open_id: "ou_never_seen" }),
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
      deliveries: (db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries").get() as { n: number }).n,
      tasks: store.listTasksForIssue(child.id).length,
    };
    let wakes = 0;
    const events: string[] = [];
    const stopWake = store.onTaskEnqueued(() => { wakes += 1; });
    const stopEvents = store.onWorkspaceEvent(event => events.push(event.type));
    const host = await daemonToken(store);
    const response = await app(store).request(`/api/daemon/issues/${parent.id}/decisions/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", operator_open_id: "ou_cross_app" }),
    });
    stopWake();
    stopEvents();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "decision_member_unmapped" });
    expect(store.getIssueDecision(parent.id, decision.id)).toEqual(before.decision);
    expect(store.listIssueActivity(parent.id)).toHaveLength(before.parentActivity);
    expect(store.listIssueActivity(child.id)).toHaveLength(before.childActivity);
    expect(store.listInboxItems(member.id)).toHaveLength(before.inbox);
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries").get())
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
    const before = {
      parentActivity: store.listIssueActivity(parent.id).length,
      childActivity: store.listIssueActivity(child.id).length,
      inbox: store.listInboxItems(member.id).length,
      deliveries: (db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries").get() as { n: number }).n,
    };
    let wakes = 0;
    const events: string[] = [];
    const stopWake = store.onTaskEnqueued(() => { wakes += 1; });
    const stopEvents = store.onWorkspaceEvent(event => events.push(event.type));
    const host = await daemonToken(store);
    const response = await app(store).request(`/api/daemon/issues/${parent.id}/decisions/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", operator_open_id: CARD_OPEN_ID }),
    });
    stopWake();
    stopEvents();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "decision_member_unmapped" });
    expect(store.getIssueDecision(parent.id, decision.id)).toMatchObject({ status: "escalated", history: [] });
    expect(store.listIssueActivity(parent.id)).toHaveLength(before.parentActivity);
    expect(store.listIssueActivity(child.id)).toHaveLength(before.childActivity);
    expect(store.listInboxItems(member.id)).toHaveLength(before.inbox);
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries").get())
      .toEqual({ n: before.deliveries });
    expect(wakes).toBe(0);
    expect(events).toEqual([]);
  });

  it("resolves sender union_id only after the same app has seen the open_id", async () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Same-app identity", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, {
      kind: "production_change", title: "Deploy?",
    });
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
    sendCard(store, "om_same_app", "ou_same_app")!;
    const host = await daemonToken(store);
    const response = await app(store).request(`/api/daemon/issues/${parent.id}/decisions/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", operator_open_id: "ou_same_app" }),
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
      deliveries: (db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries").get() as { n: number }).n,
      tasks: store.listTasksForIssue(child.id).length,
    };
    let wakes = 0;
    const events: string[] = [];
    const stopWake = store.onTaskEnqueued(() => { wakes += 1; });
    const stopEvents = store.onWorkspaceEvent(event => events.push(event.type));
    const host = await daemonToken(store);
    const response = await app(store).request(`/api/daemon/issues/${parent.id}/decisions/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", operator_open_id: "ou_ambiguous" }),
    });
    stopWake();
    stopEvents();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "decision_member_ambiguous" });
    expect(store.getIssueDecision(parent.id, decision.id)).toEqual(before.decision);
    expect(store.listIssueActivity(parent.id)).toHaveLength(before.parentActivity);
    expect(store.listIssueActivity(child.id)).toHaveLength(before.childActivity);
    expect(store.listInboxItems(member.id)).toHaveLength(before.inbox);
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries").get())
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
    const readPath = `/api/daemon/issues/${parent.id}/decisions/${decision.id}`;
    const writePath = `${readPath}/answer`;

    // A task credential is not a card credential: S4 keeps the answer
    // member-or-parent-owner-only, and the daemon route does not accept it.
    const asTask = await app(store).request(writePath, {
      method: "POST",
      headers: { Authorization: `Bearer ${taskToken.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", operator_open_id: CARD_OPEN_ID }),
    });
    expect(asTask.status).toBe(403);

    // A daemon that hosts no topic for this Issue may not reach either verb.
    const other = await daemonToken(store, "other-host");
    const read = await app(store).request(readPath, { headers: { Authorization: `Bearer ${other.token}` } });
    expect(read.status).toBe(403);
    const write = await app(store).request(writePath, {
      method: "POST",
      headers: { Authorization: `Bearer ${other.token}`, "content-type": "application/json" },
      body: JSON.stringify({ answer: "yes", operator_open_id: CARD_OPEN_ID }),
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
    const response = await app(store).request(`/api/daemon/issues/${parent.id}/decisions/${decision.id}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        answer: "yes", operator_open_id: CARD_OPEN_ID,
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

  it("lands one answer for a double tap and for a replayed callback", async () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Replay", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Deploy?" });
    sendCard(store)!;
    const host = await daemonToken(store);
    const answer = (text: string) => app(store).request(
      `/api/daemon/issues/${parent.id}/decisions/${decision.id}/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: text, operator_open_id: CARD_OPEN_ID }),
      },
    );
    // Two callbacks in flight at once, then the same callback replayed.
    const [first, second] = await Promise.all([answer("yes"), answer("yes")]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = await answer("no");
    expect(third.status).toBe(200);
    const settled = store.getIssueDecision(parent.id, decision.id)!;
    expect(settled.status).toBe("answered");
    // One write: one history entry, one activity pair, one delivery patch.
    expect(settled.history).toHaveLength(1);
    expect(settled.answer?.answer).toBe("yes");
    expect(store.listIssueActivity(parent.id).filter(entry => entry.type === "decision_answered")).toHaveLength(1);
    expect(store.listIssueActivity(child.id).filter(entry => entry.type === "decision_received")).toHaveLength(1);
    expect(db!.query(
      "SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch' AND decision_id = ?",
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
    store.answerIssueDecision(parent.id, decision.id, { answer: "yes", reason: "Looks good", overturn: "" }, {
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
    store.answerIssueDecision(parent.id, decision.id, { answer: "no", reason: "changed", overturn: "" }, {
      type: "member", id: member.id, taskId: null,
    });
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();

    // Withdrawal is its own terminal state; the card is rewritten, not left
    // actionable, and never says "timed out" (E4 has no expiry).
    const second = raiseDecision(store, agentId, child.id, task.id, { kind: "production_change", title: "Withdraw me" });
    sendCard(store, "om_withdraw_card")!;
    store.withdrawIssueDecision(parent.id, second.id, { type: "agent", id: agentId, taskId: task.id });
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
      "SELECT COUNT(*) AS n FROM multiremi_issue_decisions WHERE status = 'timeout'",
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
    expect(db!.query("SELECT reminder_sent_at FROM multiremi_issue_decisions WHERE id = ?").get(decision.id))
      .toMatchObject({ reminder_sent_at: due.toISOString() });
  });

  it("starts the fifty-minute clock when an old pending decision is finally carded", () => {
    const { store, agentId } = scaffold();
    const parent = issueWithTopic(store, "Old pending decision", { type: "agent", id: agentId });
    const { child, task } = childWithTask(store, agentId, parent.id);
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "merge", title: "Merge?" });
    expect(decision.status).toBe("pending");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db!.run("UPDATE multiremi_issue_decisions SET created_at = ?, updated_at = ? WHERE id = ?",
      [twoHoursAgo, twoHoursAgo, decision.id]);
    const ownerTask = parentTask(store, agentId, parent.id);
    store.escalateIssueDecision(parent.id, decision.id, { type: "agent", id: agentId, taskId: ownerTask.id });
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
    store.answerIssueDecision(parent.id, decision.id, { answer: "yes", reason: "ok", overturn: "" }, {
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
    store.withdrawIssueDecision(parent.id, decision.id, { type: "agent", id: agentId, taskId: task.id });
    const patch = store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 51 * 60 * 1000), true, true, true)!;
    expect(patch.kind).toBe("decision_card_patch");
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 52 * 60 * 1000))).toBeNull();
  });

  for (const mode of [
    { notifyMode: "none" as const, reason: "notify_none" as const },
    { notifyMode: "person" as const, notifyOpenId: "not-an-open-id", reason: "invalid_recipient" as const },
  ]) {
    it(`degrades to text when the topic has nobody to ask (${mode.reason})`, () => {
      const { store, agentId, member } = scaffold({ notifyMode: mode.notifyMode, notifyOpenId: mode.notifyOpenId });
      const parent = issueWithTopic(store, "Degraded", { type: "agent", id: agentId });
      const { child, task } = childWithTask(store, agentId, parent.id);
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
      store.answerIssueDecision(parent.id, decision.id, { answer: "yes", reason: "ok", overturn: "" }, {
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
    const decision = raiseDecision(store, agentId, child.id, task.id, { kind: "merge", title: "Merge?" });
    const ownerTask = parentTask(store, agentId, parent.id);
    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent(event => events.push(event.type));
    // Fail after the card delivery row is written but before COMMIT: the S1
    // hard constraint says a failed transaction leaves neither the row nor any
    // event behind. `appendIssueActivity` is the writer the card lane uses
    // after its INSERT.
    type ActivityInput = { type: string };
    const ctx = (store as unknown as {
      ctx: { appendIssueActivity: (...args: unknown[]) => void };
    }).ctx;
    const original = ctx.appendIssueActivity.bind(ctx);
    ctx.appendIssueActivity = (...args: unknown[]) => {
      const input = args[1] as ActivityInput;
      if (input.type === "decision_card_queued") throw new Error("injected escalation failure");
      original(...args);
    };
    let thrown: Error | null = null;
    try {
      store.escalateIssueDecision(parent.id, decision.id, { type: "agent", id: agentId, taskId: ownerTask.id });
    } catch (error) {
      thrown = error as Error;
    } finally {
      ctx.appendIssueActivity = original;
      unsubscribe();
    }
    expect(thrown?.message).toBe("injected escalation failure");
    // Nothing survived: not the escalation, not the delivery, not an activity.
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("pending");
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE decision_id = ?")
      .get(decision.id)).toEqual({ n: 0 });
    expect(store.listIssueActivity(parent.id).filter(entry => entry.type === "decision_card_queued")).toHaveLength(0);
    expect(events.filter(type => type.startsWith("decision") || type === "activity:created")).toHaveLength(0);
    // The queue is still usable afterwards, and the row goes out once.
    store.escalateIssueDecision(parent.id, decision.id, { type: "agent", id: agentId, taskId: ownerTask.id });
    expect(store.claimFeishuBotOutbound("local", "rt_bot")!.kind).toBe("decision_card");
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card' AND decision_id = ?")
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
    type ActivityInput = { type: string };
    const ctx = (store as unknown as {
      ctx: { appendIssueActivity: (...args: unknown[]) => void };
    }).ctx;
    const original = ctx.appendIssueActivity.bind(ctx);
    ctx.appendIssueActivity = (...args: unknown[]) => {
      const input = args[1] as ActivityInput;
      if (input.type === "decision_received") throw new Error("injected answer failure");
      original(...args);
    };
    let thrown: Error | null = null;
    try {
      store.answerIssueDecision(parent.id, decision.id, { answer: "yes", reason: "ok", overturn: "" },
        { type: "member", id: member.id, taskId: null });
    } catch (error) {
      thrown = error as Error;
    } finally {
      ctx.appendIssueActivity = original;
      unsubscribe();
    }
    expect(thrown?.message).toBe("injected answer failure");
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("escalated");
    expect(store.getIssueDecision(parent.id, decision.id)!.history).toHaveLength(0);
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch'")
      .get()).toEqual({ n: 0 });
    expect(store.listIssueActivity(parent.id).filter(entry => entry.type === "decision_answered")).toHaveLength(0);
    expect(events.filter(type => type.startsWith("decision") || type === "activity:created")).toHaveLength(0);
    // A retry after the rollback commits cleanly and queues exactly one patch.
    store.answerIssueDecision(parent.id, decision.id, { answer: "yes", reason: "ok", overturn: "" },
      { type: "member", id: member.id, taskId: null });
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("answered");
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card_patch'")
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
    store.answerIssueDecision(parent.id, decision.id, { answer: "yes", reason: "ok", overturn: "" }, {
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
      getFeishuIssueDecision: async (issueId: string, decisionId: string) => {
        const response = await app(store).request(
          `/api/daemon/issues/${issueId}/decisions/${decisionId}`,
          { headers: { Authorization: `Bearer ${host.token}` } },
        );
        return response.ok ? (await response.json()).decision : null;
      },
      answerFeishuIssueDecision: async (issueId: string, decisionId: string, input: { answer: string; operatorOpenId: string }) => {
        const response = await app(store).request(`/api/daemon/issues/${issueId}/decisions/${decisionId}/answer`, {
          method: "POST",
          headers: { Authorization: `Bearer ${host.token}`, "content-type": "application/json" },
          body: JSON.stringify({ answer: input.answer, operator_open_id: input.operatorOpenId }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()).decision;
      },
    };
    registerIssueDecisionCardInteraction({
      appId: "cli_issue_decision", chatId: "oc_issue_decision", messageId: "om_clickable",
      recipientOpenId: CARD_OPEN_ID,
      getDecision: () => client.getFeishuIssueDecision(parent.id, decision.id),
      submit: (answer, operatorOpenId) => client.answerFeishuIssueDecision(parent.id, decision.id, { answer, operatorOpenId }),
    });
    const marker = decisionInteractionMarker(parent.id, decision.id);
    const wrongOperator = await handleIssueDecisionInteractionEvent("cli_issue_decision", {
      operator: { open_id: "ou_somebody_else" },
      context: { open_message_id: "om_clickable", open_chat_id: "oc_issue_decision" },
      action: { name: marker, form_value: { [`${marker}_answer`]: "yes" } },
    });
    expect(wrongOperator).toEqual({
      toast: { type: "error", content: OPERATOR_MISMATCH_TOAST },
    });
    expect(store.getIssueDecision(parent.id, decision.id)!.status).toBe("escalated");

    const click = await handleIssueDecisionInteractionEvent("cli_issue_decision", {
      operator: { open_id: CARD_OPEN_ID },
      context: { open_message_id: "om_clickable", open_chat_id: "oc_issue_decision" },
      action: { name: marker, form_value: { [`${marker}_answer`]: "自定义：先灰度" } },
    });
    expect(JSON.stringify(click)).toContain("已提交");
    const settled = store.getIssueDecision(parent.id, decision.id)!;
    expect(settled.status).toBe("answered");
    expect(settled.answer?.answer).toBe("自定义：先灰度");
    expect(settled.answeredByMemberId).toBe(member.id);
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
      action: { name: `${marker}_o0`, form_value: {} },
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
      { name: "GET 404", stage: "read", response: "http", status: 404, code: null, expected: DECISION_FINISHED_TOAST },
      { name: "POST 404", stage: "submit", response: "http", status: 404, code: null, expected: DECISION_FINISHED_TOAST },
      { name: "GET 409", stage: "read", response: "http", status: 409, code: null, expected: DECISION_FINISHED_TOAST },
      { name: "POST 409", stage: "submit", response: "http", status: 409, code: null, expected: DECISION_FINISHED_TOAST },
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
      { name: "GET answered", stage: "read", response: "decision", decisionStatus: "answered", expected: DECISION_FINISHED_TOAST, toastType: "info" },
      { name: "GET withdrawn", stage: "read", response: "decision", decisionStatus: "withdrawn", expected: DECISION_FINISHED_TOAST, toastType: "info" },
      { name: "POST withdrawn", stage: "submit", response: "decision", decisionStatus: "withdrawn", expected: DECISION_FINISHED_TOAST, toastType: "info" },
    ] as const;
    expect(cases).toHaveLength(23);

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
          getDecision: () => readClient.getFeishuIssueDecision(parent.id, decision.id),
          submit: (answer, operatorOpenId) => submitClient.answerFeishuIssueDecision(
            parent.id,
            decision.id,
            { answer, operatorOpenId },
          ),
        });
        try {
          const result = await handleIssueDecisionInteractionEvent("cli_issue_decision", action(messageId));
          expect(result?.toast, testCase.name).toEqual({
            type: "toastType" in testCase ? testCase.toastType : "error",
            content: testCase.expected,
          });
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

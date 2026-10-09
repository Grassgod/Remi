import { createResponsibleTestIssue } from './helpers.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore as createStore, resetMultiremiTestEnv } from "./helpers.js";
import { inboxReportBody } from "./inbox-test-assertions.js";

afterEach(resetMultiremiTestEnv);
// The answered-window cases pin "now" so created_at / answered_at are ordered.
afterEach(() => setSystemTime());

// #1/#4: the decision itself addresses its first human recipient; additional
// audiences receive canonical status messages rather than duplicate ledger rows.
function decisionInbox(store:MultiremiStore,memberId:string){
  return store.listMessageInbox(memberId,"local").items.filter(message=>
    message.message_kind==='decision' || (message.metadata.inbox_item as any)?.type==='decision_requested');
}

async function exerciseDecisions(store: MultiremiStore): Promise<void> {
  store.ensureLocalWorkspace();
  const member = store.findWorkspaceMemberForUser("local", "local")!;
  const owner = store.createAgent({ name: "Decision parent owner", provider: "codex", ownerId: member.id });
  const sourceAgent = store.createAgent({ name: "Decision source owner", provider: "codex" });
  const unrelated = store.createAgent({ name: "Unrelated agent", provider: "codex" });
  const parent = createResponsibleTestIssue(store, { title: "Decision parent", assigneeType: "agent", assigneeId: owner.id });
  const source = createResponsibleTestIssue(store, { title: "Decision source", parentIssueId: parent.id, assigneeType: "agent", assigneeId: sourceAgent.id });
  const ownerTask = store.createTask({ agentId: owner.id, issueId: parent.id, prompt: "Current parent round" });
  const sourceTask = store.createTask({ agentId: sourceAgent.id, issueId: source.id, prompt: "Current source round" });
  const foreignTask = store.createTask({ agentId: unrelated.id, issueId: parent.id, prompt: "Unrelated round" });
  store.addIssueSubscriber(parent.id, member.id);
  const [ownerToken, sourceToken, foreignToken, memberToken] = await Promise.all([
    store.createTaskAccessToken(ownerTask, "local"),
    store.createTaskAccessToken(sourceTask, "local"),
    store.createTaskAccessToken(foreignTask, "local"),
    store.createAccessToken({ name: "Decision member", type: "pat", workspaceId: "local", userId: "local" }),
  ]);
  const app = createMultiremiApp({ store, authToken: "test-master" });
  const events: string[] = [];
  const unsubscribe = store.onWorkspaceEvent((event) => events.push(event.type));
  const request = (path: string, token: string, body?: unknown) => app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const create = async (issueId: string, token: string, kind: string, title: string) => {
    // Domain creation is a fixture: the unified public decision creator does
    // not synthesize the old source/owner/escalation metadata.
    const actor = token === sourceToken.token ? { type: "agent" as const, id: sourceAgent.id, taskId: sourceTask.id }
      : { type: "member" as const, id: member.id, taskId: null };
    return store.createIssueDecision(issueId, { kind, title, body: `${title} context` }, actor);
  };
  try {
    const first = await create(source.id, sourceToken.token, "merge", "Merge the change");
    const second = await create(source.id, sourceToken.token, "permission", "Access the resource");
    expect(first).toMatchObject({ status: "pending", issueId: parent.id, createdByAgentId: sourceAgent.id, sourceTaskId: sourceTask.id });
    expect(store.listTasksForIssue(parent.id).filter((task) => task.agentId === owner.id && task.status === "queued")).toHaveLength(1);
    const parentMessages = await request(`/api/sessions/${store.getMessage(first.id)!.session_id}/messages?unread_by=${owner.id}`, ownerToken.token);
    expect(parentMessages.status).toBe(200);
    const parentInbox = await parentMessages.text();
    expect(parentInbox).toContain(first.id);
    expect(parentInbox).toContain(second.id);
    expect(store.getTask(ownerTask.id)!.prompt).toBe(ownerTask.prompt);
    expect(decisionInbox(store,member.id)).toHaveLength(0);

    const answerPath = `/api/sessions/${store.getMessage(first.id)!.session_id}/messages`;
    for (const token of [sourceToken.token, foreignToken.token]) {
      const denied = await request(answerPath, token, { reply_to_id: first.id, body_md: "spoofed", response: { reason: "r", overturn: "o" }, answererType: "member", answererId: member.id });
      expect(denied.status).toBe(403);
    }
    const missingReason = await request(answerPath, ownerToken.token, { reply_to_id: first.id, body_md: "yes", answererType: "member", answererId: member.id });
    expect(missingReason.status).toBe(400);
    const ownerAnswer = await request(answerPath, ownerToken.token, {
      reply_to_id: first.id, body_md: "Merge after CI", response: { reason: "Checks passed", overturn: "A member can reverse this if QA fails" },
      answererType: "member", answererId: member.id,
    });
    expect(ownerAnswer.status, await ownerAnswer.clone().text()).toBe(200);
    expect(store.getIssueDecision(parent.id, first.id)).toMatchObject({
      status: "answered", answeredByMemberId: null, answer: { answererType: "agent", answererId: owner.id,
        answer: "Merge after CI", reason: "Checks passed", overturn: "A member can reverse this if QA fails" },
    });
    expect(inboxReportBody(store, sourceTask)).toContain(`decision:${first.id}`);
    expect(store.getTurnForAttempt(sourceTask.id)).toMatchObject({status:"awaiting_human",current_attempt_id:sourceTask.id,waiting_on_message_id:second.id});
    expect(store.listIssueActivity(parent.id).some((entry) => entry.type === "decision_answered" && entry.actorType === "agent")).toBe(true);
    expect(store.listIssueActivity(source.id).some((entry) => entry.type === "decision_received")).toBe(true);

    const revised = await request(answerPath, memberToken.token, {
      reply_to_id: first.id, body_md: "Hold for QA", response: { reason: "Human review" }, answererType: "agent", answererId: unrelated.id,
    });
    expect(revised.status, await revised.clone().text()).toBe(200);
    const history = store.getIssueDecision(parent.id, first.id)!.history;
    expect(history.map((entry) => entry.answererType)).toEqual(["agent", "member"]);
    expect(history[1]?.answererId).toBe(member.id);
    expect(store.getIssueDecision(parent.id, first.id)?.answeredByMemberId).toBe(member.id);
    expect(store.getIssueDecision(parent.id, first.id)?.answeredAt).toBe(history[1]?.answeredAt);
    expect(inboxReportBody(store, ownerTask)).toContain(`member changed your answer to decision ${first.id}`);
    expect(inboxReportBody(store, sourceTask)).toContain("Hold for QA");

    store.escalateIssueDecision(parent.id, second.id, { type: "agent", id: owner.id, taskId: ownerTask.id });
    expect(store.getIssueDecision(parent.id, second.id)?.status).toBe("escalated");
    expect((await request(`/api/sessions/${store.getMessage(second.id)!.session_id}/messages`, ownerToken.token, {
      reply_to_id: second.id, body_md: "no", response: { reason: "r", overturn: "o" },
    })).status).toBe(403);
    const prod = await create(source.id, sourceToken.token, "production_change", "Deploy to production");
    expect(prod.status).toBe("escalated");
    expect((await request(`/api/sessions/${store.getMessage(prod.id)!.session_id}/messages`, ownerToken.token, {
      reply_to_id: prod.id, body_md: "yes", response: { reason: "r", overturn: "o" },
    })).status).toBe(403);
    const items = decisionInbox(store,member.id);
    expect(items).toHaveLength(2);
    expect(items.every(item => item.message_kind=== "decision" || (item.metadata.inbox_item as any)?.severity=== "action")).toBe(true);
    expect(store.listIssueActivity(parent.id).some((entry) => entry.type === "decision_escalated")).toBe(true);

    const criteriaPending = await create(source.id, sourceToken.token, "criteria", "Acceptance terms");
    const questionPending = await create(source.id, sourceToken.token, "question", "Which branch");

    const parentHuman = store.createTask({ agentId: owner.id, issueId: parent.id, prompt: "Human request" });
    const human = store.createTaskHumanRequest({ taskId: parentHuman.id, kind: "question", payload: { message: "Pick a date" } });
    const list = await request(`/api/sessions/${store.getMessage(first.id)!.session_id}/messages?message_kind=decision`, memberToken.token);
    expect(list.status).toBe(200);
    expect((await list.json()).messages.map((message: { id: string }) => message.id))
      .toEqual(expect.arrayContaining([first.id, second.id, prod.id, human.id, criteriaPending.id, questionPending.id]));
    const model = store.listIssueDecisions(parent.id);
    expect(model.count).toBe(3);
    expect(model.waiting_on_human.map((entry: { id: string }) => entry.id)).toEqual([second.id, prod.id, human.id]);
    expect(model.owner_and_answered.answered[0].id).toBe(first.id);
    expect(model.owner_and_answered.pending.map((entry: { id: string }) => entry.id)).toEqual([questionPending.id, criteriaPending.id]);
    const detail = await request(`/api/issues/${parent.id}`, memberToken.token);
    expect((await detail.json()).pending_decision_count).toBe(3);
    const native = await request(`/api/multiremi/issues/${parent.id}`, memberToken.token);
    expect((await native.json()).issue.pending_decision_count).toBe(3);

    const memberAnswer = await request(`/api/sessions/${store.getMessage(prod.id)!.session_id}/messages`, memberToken.token, {
      reply_to_id: prod.id, body_md: "Approved for the maintenance window", answererType: "agent", answererId: unrelated.id,
    });
    expect(memberAnswer.status).toBe(200);
    expect(store.getIssueDecision(parent.id, prod.id)?.answer?.answererType).toBe("member");

    const noParent = createResponsibleTestIssue(store, { title: "No parent" });
    expect((await create(noParent.id, memberToken.token, "criteria", "Define done")).status).toBe("escalated");
    const humanParent = createResponsibleTestIssue(store, { title: "Member parent", assigneeType: "member", assigneeId: member.id });
    const humanChild = createResponsibleTestIssue(store, { title: "Member child", parentIssueId: humanParent.id });
    expect((await create(humanChild.id, memberToken.token, "question", "Choose direction")).status).toBe("escalated");
    const squad = store.createSquad({ name: "Decision squad", leaderId: owner.id });
    const squadParent = createResponsibleTestIssue(store, { title: "Squad parent", assigneeType: "squad", assigneeId: squad.id });
    const squadChild = createResponsibleTestIssue(store, { title: "Squad child", parentIssueId: squadParent.id });
    expect((await create(squadChild.id, memberToken.token, "criteria", "Set acceptance")).status).toBe("pending");

    const pending = await create(source.id, sourceToken.token, "criteria", "Withdraw this");
    store.withdrawIssueDecision(parent.id, pending.id, { type: "agent", id: sourceAgent.id, taskId: sourceTask.id });
    expect(store.getIssueDecision(parent.id, pending.id)?.status).toBe("withdrawn");
    expect(events).toContain("decision:created");
    expect(events).toContain("decision:updated");
  } finally {
    unsubscribe();
  }
}

/**
 * Advance a mocked clock by one second per call. `nowIso()` reads Date.now(), so
 * this makes created_at / answered_at deterministic for the window ordering.
 */
function steppedClock(startAt = Date.parse("2026-09-27T00:00:00.000Z")): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    const at = new Date(startAt + tick * 1000);
    setSystemTime(at);
    return at.toISOString();
  };
}

interface DecisionApi {
  request: (path: string, token: string, body?: unknown) => Promise<Response>;
  create: (issueId: string, token: string, input: { kind: string; title: string }) => Promise<ReturnType<MultiremiStore["createIssueDecision"]>>;
}

function decisionApi(store: MultiremiStore): DecisionApi {
  const app = createMultiremiApp({ store, authToken: "test-master" });
  return {
    async create(issueId, token, input) {
      const credential = (await store.verifyAccessToken(token))!;
      const actor = credential.type === "task"
        ? { type: "agent" as const, id: credential.agentId!, taskId: credential.taskId }
        : { type: "member" as const, id: store.findWorkspaceMemberForUser(credential.userId!, credential.workspaceId!)!.id, taskId: null };
      return store.createIssueDecision(issueId, input, actor);
    },
    // `app.request` is overloaded and returns a bare Response when the init is
    // passed as the second argument, so normalize it to a Promise here.
    request: async (path, token, body) => await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

const KIND_ORDER = ["permission", "merge", "production_change", "question", "criteria", "other"] as const;

function expectKindSorted(entries: Array<{ kind: string }>): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = KIND_ORDER.indexOf(entries[index - 1]!.kind as (typeof KIND_ORDER)[number]);
    const current = KIND_ORDER.indexOf(entries[index]!.kind as (typeof KIND_ORDER)[number]);
    expect(previous, `kind order broke at index ${index}: ${entries[index - 1]!.kind} -> ${entries[index]!.kind}`)
      .toBeLessThanOrEqual(current);
  }
}

/**
 * QA round 1 blocking 1: the "recently answered" window must follow answered_at,
 * not created_at, and member revisions must refresh it. Also covers the answer
 * history exposure added for MUL-414 and the exact-50 + kind-ordering contract.
 */
async function exerciseAnsweredWindow(store: MultiremiStore): Promise<void> {
  const tick = steppedClock();
  store.ensureLocalWorkspace();
  const member = store.findWorkspaceMemberForUser("local", "local")!;
  const owner = store.createAgent({ name: "Window owner", provider: "codex", ownerId: member.id });
  const sourceAgent = store.createAgent({ name: "Window source", provider: "codex" });
  const parent = createResponsibleTestIssue(store, { title: "Window parent", assigneeType: "agent", assigneeId: owner.id });
  const source = createResponsibleTestIssue(store, { title: "Window source issue", parentIssueId: parent.id, assigneeType: "agent", assigneeId: sourceAgent.id });
  const ownerTask = store.createTask({ agentId: owner.id, issueId: parent.id, prompt: "Parent round" });
  const [ownerToken, memberToken] = await Promise.all([
    store.createTaskAccessToken(ownerTask, "local"),
    store.createAccessToken({ name: "Window member", type: "pat", workspaceId: "local", userId: "local" }),
  ]);
  const api = decisionApi(store);

  // 52 merge decisions, answered 2..52 first and 1 last: the exact QA probe.
  const decisions: Array<{ id: string }> = [];
  for (let index = 1; index <= 52; index += 1) {
    tick();
    const response = await api.create(source.id, memberToken.token, {
      kind: "merge", title: `Merge decision ${index}`,
    });
    decisions.push(response);
  }
  const answer = async (token: string, decision: { id: string }, text: string, reason: string, overturn?: string) => {
    tick();
    const response = await api.request(`/api/sessions/${store.getMessage(decision.id)!.session_id}/messages`, token, {
      reply_to_id: decision.id, body_md: text, response: { reason, overturn },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  for (let index = 1; index < decisions.length; index += 1) {
    await answer(ownerToken.token, decisions[index]!, `answer ${index + 1}`, "checked", "a member may overturn this");
  }
  await answer(ownerToken.token, decisions[0]!, "answer 1", "checked", "a member may overturn this");

  const list = async () => {
    const sessionId = store.getOrCreateDefaultIssueSession(parent.id).id;
    const response = await api.request(`/api/sessions/${sessionId}/messages?message_kind=decision&limit=500`, memberToken.token);
    expect(response.status).toBe(200);
    const messages = (await response.json()).messages as Array<{ id: string; metadata: { decision_record: { history: unknown[] } } }>;
    for (const message of messages) expect(message.metadata.decision_record.history)
      .toEqual(store.getIssueDecision(parent.id, message.id)!.history);
    return store.listIssueDecisions(parent.id);
  };

  const afterProbe = await list();
  // 52 answers, a 50 window: the two oldest *answers* (#2 and #3) drop out and
  // the last-answered #1 stays, even though it was the first one created.
  expect(afterProbe.owner_and_answered.answered).toHaveLength(50);
  expect(afterProbe.owner_and_answered.answered.map((entry) => entry.id)).toEqual([
    decisions[0]!.id,
    ...decisions.slice(3).map((decision) => decision.id),
  ]);
  expect(afterProbe.owner_and_answered.answered.some((entry) => entry.id === decisions[1]!.id)).toBe(false);
  expect(afterProbe.owner_and_answered.answered.some((entry) => entry.id === decisions[2]!.id)).toBe(false);
  expectKindSorted(afterProbe.owner_and_answered.answered);
  // Answer history rides along and never hides the owner's original call.
  expect(afterProbe.owner_and_answered.answered[0]!.history).toHaveLength(1);
  expect(afterProbe.owner_and_answered.answered[0]!.history![0]).toMatchObject({ answererType: "agent", answer: "answer 1" });

  // A member revision refreshes answered_at, so the revised row re-enters the
  // window and the now-oldest answer (#4) is the one pushed out.
  await answer(memberToken.token, decisions[1]!, "member revision", "human review");
  const afterRevision = await list();
  expect(afterRevision.owner_and_answered.answered).toHaveLength(50);
  expect(afterRevision.owner_and_answered.answered.map((entry) => entry.id)).toEqual([
    decisions[0]!.id,
    decisions[1]!.id,
    ...decisions.slice(4).map((decision) => decision.id),
  ]);
  const revised = await list().then((model) => model.owner_and_answered.answered.find((entry) => entry.id === decisions[1]!.id)!);
  expect(revised.history!.map((entry) => (entry as { answererType: string }).answererType)).toEqual(["agent", "member"]);
  const revisedStored = store.getIssueDecision(parent.id, decisions[1]!.id)!;
  expect(revisedStored.answeredAt).toBe((revisedStored.history[1] as { answeredAt: string }).answeredAt);
  expect(revisedStored.answeredAt).toBe(revised.answer!.answeredAt);
  // A never-answered decision reports an empty trail, not a missing key.
  const pending = await api.create(source.id, memberToken.token, {
    kind: "criteria", title: "Still pending",
  });
  const pendingId = pending.id;
  const withPending = await list();
  expect(withPending.owner_and_answered.pending.find((entry) => entry.id === pendingId)!.history).toEqual([]);

  // Mixed kinds still cap at 50 and sort by kind before creation time: the
  // last-created permission must lead the group.
  for (const kind of ["question", "criteria", "permission"] as const) {
    tick();
    const created = await api.create(source.id, memberToken.token, { kind, title: `${kind} decision` });
    const id = created.id;
    await answer(ownerToken.token, { id }, `${kind} answered`, "checked", "a member may overturn this");
  }
  const mixed = await list();
  expect(mixed.owner_and_answered.answered).toHaveLength(50);
  expectKindSorted(mixed.owner_and_answered.answered);
  // 55 answers, a 50 window: the five oldest by answered_at fall away, leaving
  // one of each new kind plus 47 merges. kind order then puts permission first
  // and criteria last.
  expect(mixed.owner_and_answered.answered[0]!.kind).toBe("permission");
  expect(mixed.owner_and_answered.answered.at(-1)!.kind).toBe("criteria");
  const byKind = new Map<string, number>();
  for (const entry of mixed.owner_and_answered.answered) byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
  expect(Object.fromEntries([...byKind].sort())).toEqual({ criteria: 1, merge: 47, permission: 1, question: 1 });
  const merges = mixed.owner_and_answered.answered.filter((entry) => entry.kind === "merge");
  expect(merges).toHaveLength(47);
  // answered_at order is now newest->oldest: permission, criteria, question,
  // #2 (revised), #1, then #52..#8. The window keeps 50 rows, so the five
  // oldest merges #7..#3 drop: #8 survives and #7 does not.
  expect(merges.some((entry) => entry.id === decisions[7]!.id)).toBe(true);
  expect(merges.some((entry) => entry.id === decisions[6]!.id)).toBe(false);
  expect(merges.some((entry) => entry.id === decisions[1]!.id)).toBe(true);
}

/**
 * QA round 1 blocking 2: an escalated decision must land in somebody's inbox
 * even when the parent has no member assignee, no resolvable agent owner and no
 * subscriber. Creator first, then workspace owners; explicit recipients win.
 */
async function exerciseDecisionRecipientFallback(store: MultiremiStore): Promise<void> {
  store.ensureLocalWorkspace();
  const workspaceOwner = store.findWorkspaceMemberForUser("local", "local")!;
  const creator = store.createWorkspaceMember({ workspaceId: "local", name: "Fallback creator", userId: "fallback-creator", role: "member" });
  const bystander = store.createWorkspaceMember({ workspaceId: "local", name: "Fallback bystander", userId: "fallback-bystander", role: "member" });
  const ownerAgent = store.createAgent({ name: "Fallback owner agent", provider: "codex", ownerId: workspaceOwner.id });
  const agentless = store.createAgent({ name: "Fallback ownerless agent", provider: "codex", ownerId: "ghost-user-without-member" });
  const [memberToken, ownerToken, agentlessToken] = await Promise.all([
    store.createAccessToken({ name: "Fallback member", type: "pat", workspaceId: "local", userId: "local" }),
    store.createTaskAccessToken(
      store.createTask({
        agentId: ownerAgent.id,
        issueId: createResponsibleTestIssue(store, { title: "Fallback owner parent", assigneeType: "agent", assigneeId: ownerAgent.id }).id,
        prompt: "Owner round",
      }),
      "local",
    ),
    store.createAccessToken({ name: "Fallback agentless", type: "pat", workspaceId: "local", userId: "local" }),
  ]);
  void agentlessToken;
  const api = decisionApi(store);
  const eventTypes: string[] = [];
  const unsubscribe = store.onWorkspaceEvent((event) => eventTypes.push(event.type));
  const decisionRequested = (member: { id: string }, issueId: string) =>
    decisionInbox(store,member.id).filter(message=>store.getIssueSession(message.session_id)?.issueId===issueId);
  try {
    // Case 1, the exact QA probe: member PAT raises production_change on a
    // childless issue with no assignee and no subscribers.
    const probe = createResponsibleTestIssue(store, { title: "Fallback probe issue", createdBy: creator.id });
    store.removeIssueSubscriber(probe.id, creator.id);
    const escalated = await api.create(probe.id, memberToken.token, {
      kind: "production_change", title: "Deploy the fallback",
    });
    expect(escalated.status).toBe("escalated");
    const creatorItems = decisionRequested(creator, probe.id);
    expect(creatorItems).toHaveLength(1);
    expect(creatorItems[0]!.message_kind).toBe("decision");
    expect(creatorItems[0]!.metadata.decision_record).toMatchObject({ kind: "production_change",status:"escalated" });
    expect(eventTypes.filter((type) => type === "inbox:new").length).toBeGreaterThanOrEqual(1);
    expect(decisionRequested(workspaceOwner, probe.id)).toHaveLength(0);
    expect(decisionRequested(bystander, probe.id)).toHaveLength(0);

    // Case 2: an agent creator (or an archived member creator) resolves to
    // nobody, so every workspace owner takes it and non-owners do not.
    const agentCreated = createResponsibleTestIssue(store, { title: "Fallback agent-created issue", createdBy: agentless.id });
    const agentEscalated = await api.create(agentCreated.id, memberToken.token, {
      kind: "production_change", title: "Deploy from an agent-created issue",
    });
    expect(agentEscalated.status).toBe("escalated");
    expect(decisionRequested(workspaceOwner, agentCreated.id)).toHaveLength(1);
    expect(decisionRequested(bystander, agentCreated.id)).toHaveLength(0);

    const archivedCreator = store.createWorkspaceMember({ workspaceId: "local", name: "Archived creator", userId: "fallback-archived", role: "member" });
    const archivedIssue = createResponsibleTestIssue(store, { title: "Fallback archived creator issue", createdBy: archivedCreator.id });
    store.removeIssueSubscriber(archivedIssue.id, archivedCreator.id);
    store.archiveWorkspaceMember(archivedCreator.id);
    const archivedEscalated = await api.create(archivedIssue.id, memberToken.token, {
      kind: "production_change", title: "Deploy after the creator left",
    });
    expect(archivedEscalated.status).toBe("escalated");
    expect(decisionRequested(workspaceOwner, archivedIssue.id)).toHaveLength(1);
    expect(store.listMessages(store.getOrCreateDefaultIssueSession(archivedIssue.id).id)
      .filter(message=>message.to_member_id===archivedCreator.id)).toHaveLength(0);

    // Case 3: an explicit member subscriber suppresses the fallback entirely.
    const subscribed = createResponsibleTestIssue(store, { title: "Fallback subscribed issue", createdBy: creator.id });
    store.removeIssueSubscriber(subscribed.id, creator.id);
    store.addIssueSubscriber(subscribed.id, bystander.id);
    const subscribedEscalated = await api.create(subscribed.id, memberToken.token, {
      kind: "production_change", title: "Deploy with a subscriber",
    });
    expect(subscribedEscalated.status).toBe("escalated");
    expect(decisionRequested(bystander, subscribed.id)).toHaveLength(1);
    expect(decisionRequested(creator, subscribed.id)).toHaveLength(0);
    expect(decisionRequested(workspaceOwner, subscribed.id)).toHaveLength(0);

    // Case 4: the escalate path falls back too. The owner agent's ownerId does
    // not resolve to a member and the parent has no subscribers.
    const escalateParent = createResponsibleTestIssue(store, {
      title: "Fallback escalation parent", assigneeType: "agent", assigneeId: agentless.id, createdBy: creator.id,
    });
    store.removeIssueSubscriber(escalateParent.id, creator.id);
    const escalateChild = createResponsibleTestIssue(store, { title: "Fallback escalation child", parentIssueId: escalateParent.id });
    const pending = await api.create(escalateChild.id, memberToken.token, {
      kind: "question", title: "Who decides this",
    });
    const pendingId = pending.id;
    const escalateTask = store.createTask({ agentId: agentless.id, issueId: escalateParent.id, prompt: "Escalation round" });
    const escalateToken = await store.createTaskAccessToken(escalateTask, "local");
    store.escalateIssueDecision(escalateParent.id, pendingId, { type: "agent", id: agentless.id, taskId: escalateTask.id });
    expect(store.getIssueDecision(escalateParent.id, pendingId)?.status).toBe("escalated");
    expect(decisionRequested(creator, escalateParent.id)).toHaveLength(1);
    expect(decisionRequested(bystander, escalateParent.id)).toHaveLength(0);
    expect(decisionRequested(workspaceOwner, escalateParent.id)).toHaveLength(0);
    void ownerToken;
  } finally {
    unsubscribe();
  }
}

describe("MUL-400 S4 decisions on SQLite", () => {
  it("covers parent ownership, identity, escalation, revision, read model, and events", async () => {
    await exerciseDecisions(createStore());
  });

  it("windows recently answered decisions by answered_at and exposes history", async () => {
    await exerciseAnsweredWindow(createStore());
  });

  it("falls back to the issue creator, then workspace owners, when an escalated decision has no explicit audience", async () => {
    await exerciseDecisionRecipientFallback(createStore());
  });
});

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let pgAvailable = false;
if (pgAdminUrl) {
  try {
    const probe = new Bun.SQL(pgAdminUrl, { max: 1 });
    await probe`SELECT 1`;
    await probe.end();
    pgAvailable = true;
  } catch { /* The PG suite reports a skip when this machine has no instance. */ }
}

describe.skipIf(!pgAvailable)("MUL-400 S4 decisions on PostgreSQL", () => {
  const databaseName = `mul410_decisions_${process.pid}`;
  let admin: Bun.SQL;
  let database: PostgresSyncDatabase;
  let store: MultiremiStore;
  let maxDepth = 0;
  const controls: { sql: string; invocationDepth: number; callbackDepth: number; inTransaction: boolean }[] = [];

  beforeAll(async () => {
    admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    const url = new URL(pgAdminUrl!);
    url.pathname = `/${databaseName}`;
    database = new PostgresSyncDatabase(url.toString());
    const original = database.transaction.bind(database);
    let depth = 0;
    let callbackDepth = 0;
    const target = database as unknown as { execute(sql: string, params: unknown[]): unknown };
    const execute = target.execute.bind(database);
    target.execute = (sql, params) => {
      const command = sql.trim().toUpperCase();
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START TRANSACTION|END|ABORT)\b/.test(command)) {
        controls.push({ sql: command, invocationDepth: depth, callbackDepth, inTransaction: database.inTransaction });
      }
      return execute(sql, params);
    };
    (database as unknown as { transaction: unknown }).transaction = (fn: () => unknown) => {
      const run = original(() => {
        callbackDepth++;
        try { return fn(); } finally { callbackDepth--; }
      });
      // Every frame counts, a nested SAVEPOINT included (ADR 0011).
      return () => {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        try { return run(); } finally { depth--; }
      };
    };
    store = new MultiremiStore(database);
  });

  afterAll(async () => {
    database?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("runs the acceptance flow without nested transactions", async () => {
    controls.length = 0;
    await exerciseDecisions(store);
    expect(maxDepth).toBe(1);
    let outerOpen = false;
    const savepoints: string[] = [];
    expect(controls.some((control) => control.sql === "BEGIN")).toBe(true);
    for (const control of controls) {
      const detail = `PG transaction control: ${control.sql}`;
      if (control.sql === "BEGIN") {
        expect(outerOpen, detail).toBe(false);
        expect(control.inTransaction, detail).toBe(false);
        expect(control.invocationDepth, detail).toBe(1);
        expect(control.callbackDepth, detail).toBe(0);
        outerOpen = true;
      } else if (control.sql === "COMMIT" || control.sql === "ROLLBACK") {
        expect(outerOpen, detail).toBe(true);
        expect(control.inTransaction, detail).toBe(true);
        expect(control.invocationDepth, detail).toBe(1);
        expect(control.callbackDepth, detail).toBe(0);
        expect(savepoints, detail).toHaveLength(0);
        outerOpen = false;
      } else {
        expect(outerOpen, detail).toBe(true);
        expect(control.inTransaction, detail).toBe(true);
        expect(control.invocationDepth, detail).toBeGreaterThan(1);
        expect(control.sql, detail).toMatch(/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) \w+$/);
        const name = control.sql.split(" ").at(-1)!;
        if (control.sql.startsWith("SAVEPOINT ")) savepoints.push(name);
        else {
          // RELEASE or ROLLBACK TO ends the level; main's skeleton sends no RELEASE after a ROLLBACK TO.
          expect(savepoints.at(-1), detail).toBe(name);
          savepoints.pop();
        }
      }
    }
    expect(outerOpen).toBe(false);
    expect(savepoints).toHaveLength(0);
  });

  // The 55-answer PG fixture also persists an inbox entry and wake for each reply.
  it("windows recently answered decisions by answered_at and exposes history", async () => {
    await exerciseAnsweredWindow(store);
  }, 15_000);

  it("falls back to the issue creator, then workspace owners, when an escalated decision has no explicit audience", async () => {
    await exerciseDecisionRecipientFallback(store);
  });
});

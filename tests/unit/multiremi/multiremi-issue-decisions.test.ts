import { createResponsibleTestIssue } from './helpers.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiIssueDecision } from '@multiremi/contracts/types.js';
import { createLocalStore as createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);
// The answered-window cases pin "now" so created_at / answered_at are ordered.
afterEach(() => setSystemTime());

// #1/#4: the decision itself addresses its first human recipient; additional
// audiences receive canonical status messages rather than duplicate ledger rows.
function decisionInbox(store:MultiremiStore,memberId:string){
  return store.listMessageInbox(memberId,"local").items.filter(message=>
    message.message_kind==='decision' || message.metadata.question_notification === true || (message.metadata.inbox_item as any)?.type==='decision_requested');
}

/** Real AUQ source lanes and current-revision notified handler lanes. */
async function exerciseDecisions(store: MultiremiStore): Promise<void> {
  store.ensureLocalWorkspace();
  const member = store.getWorkspaceMember('mem_local_local')!;
  const runtime = store.registerRuntime({ name: 'Question executor', provider: 'codex', daemonId: 'decision-acceptance', maxConcurrency: 16 });
  const owner = store.createAgent({ name: 'Parent owner', provider: 'codex', runtimeId: runtime.id });
  const sourceAgent = store.createAgent({ name: 'Source owner', provider: 'codex', runtimeId: runtime.id });
  const unrelated = store.createAgent({ name: 'Unrelated agent', provider: 'codex', runtimeId: runtime.id });
  const parent = store.createIssue({ title: 'Question parent', assigneeType: 'agent', assigneeId: owner.id, responsibleMemberId: member.id });
  const source = store.createIssue({ title: 'Question source', parentIssueId: parent.id, assigneeType: 'agent', assigneeId: sourceAgent.id });
  const originalSession = store.createIssueSession(source.id, { title: 'Original private question', holdsWorkspace: false });
  const sourceTask = store.createTask({ agentId: sourceAgent.id, issueId: source.id, issueSessionId: originalSession.id, prompt: 'Work child' });
  expect(store.claimTask(runtime.id)?.id).toBe(sourceTask.id); store.startTask(sourceTask.id);
  const sourceTurn = store.getTurnForAttempt(sourceTask.id)!;
  const foreignSession = store.createIssueSession(parent.id, { title: 'Unrelated lane', holdsWorkspace: false });
  const foreignTask = store.createTask({ agentId: unrelated.id, issueId: parent.id, issueSessionId: foreignSession.id, prompt: 'Unrelated work', priority: 100 });
  expect(store.claimTask(runtime.id)?.id).toBe(foreignTask.id); store.startTask(foreignTask.id);
  const app = createMultiremiApp({ store, authToken: 'test-master' });
  const memberToken = await store.createAccessToken({ name: 'Explicit human', type: 'pat', userId: 'local', workspaceId: 'local' });
  const [sourceToken, foreignToken] = await Promise.all([
    store.createTaskAccessToken(store.getTask(sourceTask.id)!, 'local'),
    store.createTaskAccessToken(store.getTask(foreignTask.id)!, 'local'),
  ]);
  const request = (id: string, token: string, body?: unknown, action = 'answer') => app.request(
    `/api/messages/${id}/question${body === undefined ? '' : '/' + action}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const events: string[] = [];
  const off = store.onWorkspaceEvent(event => events.push(event.type));
  const ask = (kind: string, title: string) => {
    const created = store.getDaemonTurnBridge().rpc('turn.decision', {
      turn_id: sourceTurn.id, attempt_id: sourceTask.id, body_md: title,
      dedupe_key: title, wait_id: `wait:${title}`, timeout_ms: 60_000,
      options: [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }],
      metadata: { kind, message: title, questions: [{ question: title, options: [{ label: 'Yes' }, { label: 'No' }] }] },
    }, { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: 'local' });
    expect(created.ok).toBe(true);
    return store.getQuestion(String(created.message_id))!;
  };
  try {
    const first = ask('question', 'Choose branch');
    expect(first).toMatchObject({ source_issue_id: source.id, session_id: originalSession.id, stage: 'parent_owner',
      current_handler: { type: 'agent', id: owner.id }, wait_status: 'waiting' });
    const notification = store.listMessages(store.getOrCreateDefaultIssueSession(parent.id).id)
      .find(message => message.metadata.root_question_id === first.id && message.to_agent_id === owner.id)!;
    expect(notification.reply_to_id).toBeNull();
    expect(notification.metadata.question_route_revision).toBe(1);
    const handlerTask = store.claimTask(runtime.id)!;
    expect(handlerTask.agentId).toBe(owner.id); store.startTask(handlerTask.id);
    const handlerToken = await store.createTaskAccessToken(store.getTask(handlerTask.id)!, 'local');
    const handlerTurn = store.getTurnForAttempt(handlerTask.id)!;
    expect((await request(first.id, handlerToken.token)).status).toBe(200);
    for (const token of [sourceToken.token, foreignToken.token]) {
      const denied = await request(first.id, token, { expected_route_revision: 1, response: { answers: { 'Choose branch': 'spoofed' } },
        answererType: 'member', answererId: member.id });
      expect(denied.status).toBe(403);
    }
    expect((await request(first.id, handlerToken.token, { response: { answer: 'Yes' } })).status).toBe(400);
    const answer = await request(first.id, handlerToken.token, { expected_route_revision: 1, response: { answers: { 'Choose branch': 'Yes' } }, body_md: 'Use branch A' });
    expect(answer.status, await answer.clone().text()).toBe(200);
    expect(store.getQuestion(first.id)).toMatchObject({ status: 'answered', answer_revision: 1,
      answer: { actor: { type: 'agent', id: owner.id }, response: { answers: { 'Choose branch': 'Yes' } } } });
    expect(store.getTurnForAttempt(sourceTask.id)).toMatchObject({ status: 'running', current_attempt_id: sourceTask.id, waiting_on_message_id: null });
    const consumer = store.getDaemonTurnBridge().rpc('turn.decision.consume', { turn_id: sourceTurn.id,
      attempt_id: sourceTask.id, message_id: first.id, wait_id: 'wait:Choose branch', reply_message_id: store.getQuestion(first.id)!.answer!.reply_message_id },
    { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: 'local' });
    expect(consumer.ok).toBe(true);
    expect(store.getQuestion(first.id)?.wait_status).toBe('consumed');
    const repeat = await request(first.id, handlerToken.token, { expected_route_revision: 1, response: { answers: { 'Choose branch': 'No' } } });
    expect(repeat.status).toBe(409);
    const beforeRevision = store.getQuestion(first.id)!;
    const revised = await request(first.id, memberToken.token, { expected_route_revision: 1,
      expected_answer_revision: 1, revise: true, reason: 'Human review', response: { answers: { 'Choose branch': 'No' } }, body_md: 'Hold for QA' });
    expect(revised.status, await revised.clone().text()).toBe(200);
    expect(store.getQuestion(first.id)?.history.filter(event => event.type === 'answer' || event.type === 'revise').map(event => event.actor?.type)).toEqual(['agent', 'member']);
    expect(store.getQuestion(first.id)?.answer_revision).toBe(beforeRevision.answer_revision + 1);

    const second = ask('question', 'Escalate this choice');
    const escalation = await request(second.id, handlerToken.token, { expected_route_revision: 1, reason: 'Needs human decision' }, 'escalate');
    expect(escalation.status, await escalation.clone().text()).toBe(200);
    expect(store.getQuestion(second.id)).toMatchObject({ stage: 'human', route_revision: 2, current_handler: { type: 'member', id: member.id } });
    expect((await request(second.id, handlerToken.token, { expected_route_revision: 2, response: { answer: 'No' } })).status).toBe(403);
    for (const kind of ['permission', 'merge', 'production_change']) {
      const sensitive = ask(kind, `Authorize ${kind}`);
      expect(sensitive).toMatchObject({ stage: 'human', current_handler: { type: 'member', id: member.id } });
      expect((await request(sensitive.id, handlerToken.token, { expected_route_revision: 1, response: { answer: 'Yes' } })).status).toBe(403);
      if (kind === 'production_change') {
        const approval = await request(sensitive.id, memberToken.token, { expected_route_revision: 1, response: { answers: { [`Authorize ${kind}`]: 'Yes' } } });
        expect(approval.status, await approval.clone().text()).toBe(200);
        expect(store.getQuestion(sensitive.id)?.answer?.actor).toEqual({ type: 'member', id: member.id });
      }
    }
    const pending = ask('question', 'Close without losing history');
    const closed = await request(pending.id, memberToken.token, { expected_route_revision: 1, reason: 'Plan withdrawn explicitly' }, 'close');
    expect(closed.status, await closed.clone().text()).toBe(200);
    expect(store.getQuestion(pending.id)).toMatchObject({ status: 'closed', wait_status: 'detached' });
    expect(store.getMessage(pending.id)?.body_md).toBe('Close without losing history');
    const list = await app.request(`/api/issues/${parent.id}/questions`, { headers: { Authorization: `Bearer ${memberToken.token}` } });
    expect(list.status).toBe(200);
    expect((await list.json()).questions.map((q: { id: string }) => q.id)).toEqual(expect.arrayContaining([first.id, second.id, pending.id]));
    expect(decisionInbox(store, member.id).length).toBeGreaterThanOrEqual(3);
    expect(store.getTask(handlerTask.id)?.prompt).toBe(handlerTask.prompt);
    expect(handlerTurn.session_id).toBe(notification.session_id);
    expect(events).toContain('decision:created');
    expect(events).toContain('decision:updated');
  } finally { off(); }
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
  create: (issueId: string, token: string, input: { kind: string; title: string }) => Promise<MultiremiIssueDecision>;
}

function historicalDecisionApi(store: MultiremiStore): DecisionApi {
  const app = createMultiremiApp({ store, authToken: "test-master" });
  return {
    async create(issueId, token, input) {
      // This helper exclusively seeds pre-Q history for read-window probes;
      // all new business AUQs use the native bridge in exerciseDecisions.
      expect(await store.verifyAccessToken(token)).not.toBeNull();
      const source = store.getIssue(issueId)!;
      const target = source.parentIssueId ? store.getIssue(source.parentIssueId)! : source;
      const session = store.getOrCreateDefaultIssueSession(target.id);
      const result = store.sendMessage({ session_id: session.id, sender: { type: 'agent', id: source.assigneeId! },
        to: { type: 'none' }, message_kind: 'decision', wake_requested: 'inbox_only', body_md: input.title,
        metadata: { decision_record: { kind: input.kind, title: input.title, body: input.title,
          source_issue_id: source.id, source_task_id: null, status: 'pending', owner_agent_id: target.assigneeId,
          history: [] } } });
      expect(store.getMessage(result.message.id)?.metadata.question).toBeUndefined();
      expect(store.getQuestion(result.message.id)?.wait_status).toBe('none');
      return store.getIssueDecision(target.id, result.message.id)!;
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
  const parent = createResponsibleTestIssue(store, { title: "Window parent", assigneeType: "agent", assigneeId: owner.id, responsibleMemberId: member.id });
  const source = createResponsibleTestIssue(store, { title: "Window source issue", parentIssueId: parent.id, assigneeType: "agent", assigneeId: sourceAgent.id });
  const ownerTask = store.createTask({ agentId: owner.id, issueId: parent.id, prompt: "Parent round" });
  const [ownerToken, memberToken] = await Promise.all([
    store.createTaskAccessToken(ownerTask, "local"),
    store.createAccessToken({ name: "Window member", type: "pat", workspaceId: "local", userId: "local" }),
  ]);
  const api = historicalDecisionApi(store);

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
    if (token === ownerToken.token) {
      // Historical Agent answers existed before human-required authorization.
      // Preserve their original author/time; do not authorize a new Agent merge.
      const message = store.getMessage(decision.id)!;
      const answer = { answererType: 'agent', answererId: owner.id, answer: text, reason, overturn: overturn ?? null, answeredAt: new Date().toISOString() };
      const old = message.metadata.decision_record as Record<string, unknown>;
      const db = (store as unknown as { db: import('@multiremi/store/db/postgres.js').SqlDatabase }).db;
      db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?', [JSON.stringify({ ...message.metadata,
        decision_record: { ...old, status: 'answered', answer, history: [answer], answered_at: answer.answeredAt } }), decision.id]);
    } else {
      const q = store.getQuestion(decision.id)!;
      const response = await api.request(`/api/messages/${decision.id}/question/answer`, token, {
        expected_route_revision: q.route_revision, expected_answer_revision: q.answer_revision, revise: true,
        body_md: text, response: { answer: text }, reason,
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
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

/** Root human facts supersede the old creator/subscriber/workspace-owner guesses. */
async function exerciseDecisionRecipientFallback(store: MultiremiStore): Promise<void> {
  store.ensureLocalWorkspace();
  const workspaceOwner = store.getWorkspaceMember('mem_local_local')!;
  const creator = store.createWorkspaceMember({ workspaceId: 'local', name: 'Creator', userId: 'explicit-creator', role: 'member' });
  const bystander = store.createWorkspaceMember({ workspaceId: 'local', name: 'Subscriber', userId: 'explicit-subscriber', role: 'member' });
  const runtime = store.registerRuntime({ name: 'Explicit responsibility executor', provider: 'codex', daemonId: 'explicit-human', maxConcurrency: 16, visibility: 'public' });
  const sourceAgent = store.createAgent({ name: 'Source with unrelated owner', provider: 'codex', runtimeId: runtime.id, ownerId: workspaceOwner.id, maxConcurrentTasks: 16 });
  const agentless = store.createAgent({ name: 'Parent with missing ownerId', provider: 'codex', runtimeId: runtime.id, ownerId: 'ghost-user', maxConcurrentTasks: 16 });
  let sequence = 0;
  const ask = (issueId: string, kind: string) => {
    const session = store.createIssueSession(issueId, { title: `Explicit Q ${++sequence}`, holdsWorkspace: false });
    const task = store.createTask({ agentId: sourceAgent.id, issueId, issueSessionId: session.id,
      prompt: 'Raise one Q', priority: 100 + sequence });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
    const turn = store.getTurnForAttempt(task.id)!;
    const created = store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id,
      body_md: `Question ${sequence}`, wait_id: `wait-explicit:${sequence}`, dedupe_key: `explicit:${sequence}`,
      options: [{ label: 'Yes', value: 'Yes' }], metadata: { kind, questions: [{ question: 'Approve?', options: [{ label: 'Yes' }] }] },
    }, { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: 'local' });
    expect(created.ok).toBe(true);
    return store.getQuestion(String(created.message_id))!;
  };
  const questionNotifications = (id: string, memberId: string) => decisionInbox(store, memberId).filter(message =>
    message.metadata.question_notification === true && message.metadata.root_question_id === id);
  const eventTypes: string[] = [];
  const off = store.onWorkspaceEvent(event => eventTypes.push(event.type));
  try {
    const probe = store.createIssue({ title: 'Creator differs from responsible human', createdBy: creator.id,
      assigneeType: 'agent', assigneeId: sourceAgent.id, responsibleMemberId: bystander.id });
    store.addIssueSubscriber(probe.id, creator.id);
    const explicit = ask(probe.id, 'production_change');
    expect(explicit).toMatchObject({ stage: 'human', current_handler: { type: 'member', id: bystander.id } });
    expect(questionNotifications(explicit.id, bystander.id)).toHaveLength(1);
    expect(questionNotifications(explicit.id, creator.id)).toHaveLength(0);
    expect(questionNotifications(explicit.id, workspaceOwner.id)).toHaveLength(0);
    expect(eventTypes).toContain('inbox:new');

    const agentCreated = store.createIssue({ title: 'Agent creator with explicit human', createdBy: agentless.id,
      assigneeType: 'agent', assigneeId: sourceAgent.id, responsibleMemberId: creator.id });
    const agentQ = ask(agentCreated.id, 'production_change');
    expect(agentQ.current_handler).toEqual({ type: 'member', id: creator.id });
    expect(questionNotifications(agentQ.id, workspaceOwner.id)).toHaveLength(0);

    const archived = store.createWorkspaceMember({ workspaceId: 'local', name: 'Archived explicit human', role: 'member' });
    const unavailableIssue = store.createIssue({ title: 'Human unavailable', createdBy: creator.id,
      assigneeType: 'agent', assigneeId: sourceAgent.id, responsibleMemberId: archived.id });
    const unavailable = ask(unavailableIssue.id, 'production_change');
    store.archiveWorkspaceMember(archived.id);
    expect(store.getQuestion(unavailable.id)).toMatchObject({ status: 'pending', stage: 'unavailable', current_handler: null });
    expect(questionNotifications(unavailable.id, creator.id)).toHaveLength(0);
    expect(questionNotifications(unavailable.id, workspaceOwner.id)).toHaveLength(0);
    expect(() => store.answerQuestion(unavailable.id, { expected_route_revision: store.getQuestion(unavailable.id)!.route_revision,
      response: { answer: 'Yes' } }, { type: 'member', id: workspaceOwner.id })).toThrow();

    const parent = store.createIssue({ title: 'Ownerless parent', createdBy: bystander.id,
      assigneeType: 'agent', assigneeId: agentless.id, responsibleMemberId: creator.id });
    store.addIssueSubscriber(parent.id, bystander.id);
    const child = store.createIssue({ title: 'Child asks parent', parentIssueId: parent.id,
      assigneeType: 'agent', assigneeId: sourceAgent.id });
    const pending = ask(child.id, 'question');
    expect(pending).toMatchObject({ stage: 'parent_owner', current_handler: { type: 'agent', id: agentless.id } });
    const notification = store.listMessages(store.getOrCreateDefaultIssueSession(parent.id).id)
      .find(message => message.metadata.root_question_id === pending.id && message.to_agent_id === agentless.id)!;
    const notifiedTurn = store.getTurn(String(notification.metadata.delivery_turn_id))!;
    // Earlier root fixtures legitimately queue execution-owner work. Claim this
    // Q's actual notification lane, rather than depending on database tie order.
    const db = (store as unknown as { db: import('@multiremi/store/db/postgres.js').SqlDatabase }).db;
    db.run('UPDATE multiremi_turns SET priority = 200 WHERE id = ?', [notifiedTurn.id]);
    const handler = store.claimTask(runtime.id)!;
    expect(handler.id).toBe(notifiedTurn.current_attempt_id!);
    expect(handler.agentId).toBe(agentless.id); store.startTask(handler.id);
    const turn = store.getTurnForAttempt(handler.id)!;
    const escalated = store.escalateQuestion(pending.id, { expected_route_revision: 1, reason: 'Need the specified human' },
      { type: 'agent', id: agentless.id }, turn.id);
    expect(escalated).toMatchObject({ stage: 'human', current_handler: { type: 'member', id: creator.id }, route_revision: 2 });
    expect(questionNotifications(pending.id, creator.id)).toHaveLength(1);
    expect(questionNotifications(pending.id, bystander.id)).toHaveLength(0);
    expect(questionNotifications(pending.id, workspaceOwner.id)).toHaveLength(0);
  } finally { off(); }
}

describe("MUL-400 S4 decisions on SQLite", () => {
  it("covers parent ownership, identity, escalation, revision, read model, and events", async () => {
    await exerciseDecisions(createStore());
  });

  it("windows recently answered decisions by answered_at and exposes history", async () => {
    await exerciseAnsweredWindow(createStore());
  });

  it("uses only the explicit root human and fails closed when that person is unavailable", async () => {
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

  it("uses only the explicit root human and fails closed when that person is unavailable", async () => {
    await exerciseDecisionRecipientFallback(store);
  });
});

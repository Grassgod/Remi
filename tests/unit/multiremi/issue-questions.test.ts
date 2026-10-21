import { expect, it } from 'bun:test';
import { pendingTurnBackendTests, type PendingTurnTestFixture } from './pending-turn-test-backends.js';
import { StoreContext, createCommitEventQueue } from '@multiremi/store/context.js';
import { Questions, refreshIssueQuestionsAfterResponsibilityChangeWithinTransaction } from '@multiremi/store/inbox/questions.js';
import { deriveIssueStatusWithinTransaction } from '@multiremi/store/inbox/issue-status.js';
import { MultiremiStore } from '@multiremi/store.js';
import { decodeDecisionCardBody, questionCardAction, interactionMarker } from '@shared/feishu-task-card.js';
import { handleTaskInteractionEvent, registerQuestionCardClient } from '@connectors/feishu/task-interaction.js';
import { createMultiremiApp } from '@multiremi/api.js';
import { MultiremiDaemonClient } from '@multiremi/worker/client.js';

type PermissionOption = { optionId: string; name: string; kind: string };
function setup(f: PendingTurnTestFixture, sameOwner = false, busyOwner = false, kind = 'question', permission?: PermissionOption[]) {
  const { store, db } = f;
  const runtime = store.registerRuntime({ name: 'questions host', provider: 'codex', daemonId: 'questions-daemon', maxConcurrency: 8 });
  const leader = store.createAgent({ name: 'Issue leader', provider: 'codex', maxConcurrentTasks: busyOwner ? 1 : 8 });
  const parentLeader = sameOwner ? leader : store.createAgent({ name: 'Parent leader', provider: 'codex', maxConcurrentTasks: 8 });
  const worker = store.createAgent({ name: 'Worker', provider: 'codex', maxConcurrentTasks: 8 });
  const parent = store.createIssue({ title: 'Root', assigneeType: 'agent', assigneeId: parentLeader.id });
  const issue = store.createIssue({ title: 'Child', parentIssueId: parent.id, assigneeType: 'agent', assigneeId: leader.id });
  const leaderRuntime = busyOwner ? store.registerRuntime({ name: 'Busy Leader host', provider: 'codex', daemonId: 'busy-leader-daemon', maxConcurrency: 8 }) : null;
  if (leaderRuntime) {
    store.updateAgent(leader.id, { runtimeId: leaderRuntime.id }); store.updateAgent(parentLeader.id, { runtimeId: leaderRuntime.id });
    store.updateAgent(worker.id, { runtimeId: runtime.id });
  }
  const busyTask = busyOwner ? store.createTask({ agentId: leader.id, issueId: issue.id, prompt: 'Already coordinating this Issue' }) : null;
  if (busyTask) { expect(store.claimTask(leaderRuntime!.id)?.id).toBe(busyTask.id); store.startTask(busyTask.id); }
  const task = store.createTask({ agentId: worker.id, issueId: issue.id, prompt: 'Original task' });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
  const turn = store.getTurnForAttempt(task.id)!;
  const bridge = store.getDaemonTurnBridge();
  const scope = { runtimeId: runtime.id, daemonId: 'questions-daemon', workspaceId: 'local' };
  const result = bridge.rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id, dedupe_key: `question:${task.id}`,
    wait_id: `wait_nonce_${task.id}`, body_md: permission ? 'Allow Write?' : 'Which approach?',
    options: permission ? permission.map(option => ({ label: option.name, value: option.optionId })) : [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }],
    metadata: permission ? { kind: 'permission', options: permission }
      : { kind, questions: [{ fieldKey: 'approach', question: { question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] } }] }, timeout_ms: 50 }, scope);
  expect(result.ok).toBeTrue();
  const q = store.getQuestion(String(result.message_id))!;
  const agentTurn = (id: string) => {
    let t = db.query("SELECT * FROM multiremi_turns WHERE agent_id=? AND status IN ('pending','running','awaiting_human') ORDER BY created_at DESC LIMIT 1").get(id);
    if (!t) throw new Error('No notification turn');
    db.run("UPDATE multiremi_turns SET status='running' WHERE id=?", [t.id]);
    return t.id as string;
  };
  const toHuman = () => {
    store.escalateQuestion(q.id, { expected_route_revision: 1, reason: 'Need parent' }, { type: 'agent', id: leader.id }, agentTurn(leader.id));
    if (!sameOwner) store.escalateQuestion(q.id, { expected_route_revision: 2, reason: 'Need a member' }, { type: 'agent', id: parentLeader.id }, agentTurn(parentLeader.id));
    return store.getQuestion(q.id)!;
  };
  const refresh = (issueId: string) => {
    const ctx = new StoreContext(db, () => store), events = createCommitEventQueue();
    db.transaction(() => {
      ctx.lockWorkspaceRuntimeLifecycle('local');
      refreshIssueQuestionsAfterResponsibilityChangeWithinTransaction(ctx, issueId, events);
    })();
    return store.getQuestion(q.id)!;
  };
  const member = (name: string) => {
    const user = store.getOrCreateUser({ externalId: `question_${name.toLowerCase().replaceAll(' ', '_')}`, name });
    return store.createWorkspaceMember({ workspaceId: 'local', userId: user.id, name, role: 'member' });
  };
  return { ...f, runtime, leader, parentLeader, worker, parent, issue, task, busyTask, turn, bridge, scope, q, agentTurn, toHuman, refresh, member };
}

pendingTurnBackendTests('one question through the responsibility chain', fixture => {
  it('keeps the source Issue in_progress while Leaders hold the question and parks it in_review at the human stage', () => {
    const h = setup(fixture());
    expect(h.store.getQuestion(h.q.id)).toMatchObject({ stage: 'issue_owner', current_handler: { type: 'agent', id: h.leader.id } });
    expect(h.store.getIssue(h.issue.id)?.status).toBe('in_progress');
    const human = h.toHuman();
    expect(human).toMatchObject({ stage: 'human', current_handler: null });
    // The Leaders' notification rounds end after escalating; only the worker still waits, now on a human.
    h.db.run("UPDATE multiremi_turns SET status='completed' WHERE agent_id IN (?,?) AND status='running'", [h.leader.id, h.parentLeader.id]);
    const ctx = new StoreContext(h.db, () => h.store), events = createCommitEventQueue();
    h.db.transaction(() => {
      ctx.lockWorkspaceRuntimeLifecycle('local');
      deriveIssueStatusWithinTransaction(ctx, h.issue.id, events);
    })();
    expect(h.store.getIssue(h.issue.id)?.status).toBe('in_review');
    h.store.answerQuestion(h.q.id, { expected_route_revision: human.route_revision, response: { answer: 'A' } }, { type: 'member', id: 'mem_local_local' });
    expect(h.store.getTurn(h.turn.id)?.status).toBe('running');
    expect(h.store.getIssue(h.issue.id)?.status).toBe('in_progress');
  });

  it('ordinary choices are excluded before the Question page limit without rewriting historical rows', () => {
    const h = setup(fixture());
    const original = h.store.getMessage(h.q.id)!;
    const ordinary: string[] = [];
    for (const historical of [false, true]) for (let i = 0; i < 2; i++) {
      const choice = h.store.sendMessage({ session_id: h.q.session_id, sender: { type: 'platform', id: null },
        to: { type: 'member', ref: 'mem_local_local' }, message_kind: 'decision', wake_requested: 'inbox_only',
        body_md: 'Ordinary selection', options: [{ label: 'Yes', value: 'yes' }] }).message;
      const metadata = historical ? { execution_scope: '', decision_record: { status: 'pending' } } : choice.metadata;
      h.db.run('UPDATE multiremi_conversation_log SET metadata=?,created_at=? WHERE id=?',
        [JSON.stringify(metadata), '2030-01-01T00:00:00.000Z', choice.id]);
      ordinary.push(choice.id);
    }
    const before = ordinary.map(id => h.store.getMessage(id)!.metadata);
    expect(ordinary.map(id => h.store.getQuestion(id))).toEqual([null, null, null, null]);
    expect(h.store.listIssueQuestions(h.issue.id, undefined, { limit: 1 }).map(question => question.id)).toEqual([h.q.id]);
    expect(ordinary.map(id => h.store.getMessage(id)!.metadata)).toEqual(before);
    expect(h.store.getMessage(h.q.id)?.body_md).toBe(original.body_md);
    expect(h.store.getQuestion(h.q.id)?.wait_status).toBe('waiting');
  });
  it('native AUQ uses the explicitly assigned second Squad rather than the Worker first membership', async () => {
    const { store, db } = fixture();
    const runtime = store.registerRuntime({ name: 'Two Squad Q host', provider: 'codex', daemonId: 'two-squad-q', maxConcurrency: 16 });
    const first = store.createAgent({ name: 'First Squad leader', provider: 'codex', runtimeId: runtime.id });
    const second = store.createAgent({ name: 'Assigned Squad leader', provider: 'codex', runtimeId: runtime.id });
    const worker = store.createAgent({ name: 'Worker in two Squads', provider: 'codex', runtimeId: runtime.id, visibility: 'private', ownerId: 'local' });
    const firstSquad = store.createSquad({ name: 'First membership', leaderId: first.id, memberIds: [worker.id] });
    const assignedSquad = store.createSquad({ name: 'Explicit assignment', leaderId: second.id, memberIds: [worker.id] });
    expect(firstSquad.id).not.toBe(assignedSquad.id);
    const issue = store.createIssue({ title: 'Second Squad owns this work', assigneeType: 'squad', assigneeId: assignedSquad.id });
    const session = store.createIssueSession(issue.id, { title: 'Original private Worker lane', holdsWorkspace: false });
    const task = store.createTask({ agentId: worker.id, issueId: issue.id, issueSessionId: session.id, prompt: 'Ask the actual Issue owner', priority: 200 });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
    const turn = store.getTurnForAttempt(task.id)!, bridge = store.getDaemonTurnBridge();
    const scope = { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: 'local' };
    const created = bridge.rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id, wait_id: `two-squad:${task.id}`,
      dedupe_key: `two-squad:${task.id}`, body_md: 'Choose the owner-approved approach', options: [{ label: 'A', value: 'A' }],
      metadata: { kind: 'question', questions: [{ question: 'Approach?', options: [{ label: 'A' }] }] } }, scope);
    expect(created.ok).toBe(true);
    const id = String(created.message_id), q = store.getQuestion(id)!;
    expect(q).toMatchObject({ session_id: session.id, source_agent_id: worker.id, stage: 'issue_owner',
      current_handler: { type: 'agent', id: second.id }, wait_status: 'waiting' });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const notifications = store.listMessages(main.id).filter(message => message.metadata.question_notification === true && message.metadata.root_question_id === id);
    expect(notifications.map(message => message.to_agent_id)).toEqual([second.id]);
    const unrelatedSession = store.createIssueSession(issue.id, { title: 'First Squad unrelated work', holdsWorkspace: false });
    const unrelated = store.createTask({ agentId: first.id, issueId: issue.id, issueSessionId: unrelatedSession.id, prompt: 'No Q was assigned here', priority: 300 });
    expect(store.claimTask(runtime.id)?.id).toBe(unrelated.id); store.startTask(unrelated.id);
    const wrongToken = await store.createTaskAccessToken(store.getTask(unrelated.id)!, 'local');
    const notified = store.getTurn(String(notifications[0]!.metadata.delivery_turn_id))!;
    db.run('UPDATE multiremi_turns SET priority=400 WHERE id=?', [notified.id]);
    const handler = store.claimTask(runtime.id)!;
    expect(handler.id).toBe(notified.current_attempt_id!); expect(handler.agentId).toBe(second.id); store.startTask(handler.id);
    const token = await store.createTaskAccessToken(store.getTask(handler.id)!, 'local');
    const api = createMultiremiApp({ store, authToken: 'two-squad-master' });
    const act = (credential: string, action?: string) => api.request(`/api/messages/${id}/question${action ? '/' + action : ''}`, {
      method: action ? 'POST' : 'GET', headers: { Authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      ...(action ? { body: JSON.stringify({ expected_route_revision: q.route_revision, response: { answers: { 'Approach?': 'A' } } }) } : {}) });
    expect((await act(wrongToken.token)).status).toBe(403);
    expect((await act(wrongToken.token, 'answer')).status).toBe(403);
    expect(store.getQuestion(id)?.status).toBe('pending');
    expect((await act(token.token)).status).toBe(200);
    expect((await act(token.token, 'answer')).status).toBe(200);
    expect(store.getQuestion(id)?.answer?.actor).toEqual({ type: 'agent', id: second.id });
    expect(bridge.rpc('turn.decision.consume', { turn_id: turn.id, attempt_id: task.id, message_id: id,
      wait_id: `two-squad:${task.id}`, reply_message_id: store.getQuestion(id)!.answer!.reply_message_id }, scope).ok).toBe(true);
    expect(store.getQuestion(id)?.wait_status).toBe('consumed');
  });
  it('HTTP hides the original Q after a real source Issue move across workspaces', async () => {
    const h = setup(fixture());
    const api = createMultiremiApp({ store: h.store, authToken: 'MASTER' });
    const headers = { Authorization: 'Bearer MASTER', 'content-type': 'application/json' };
    const read = () => api.request(`/api/messages/${h.q.id}/question`, { headers });
    expect((await read()).status).toBe(200);
    // The real move API requires the source Issue's executions to stop first.
    // Provider cancellation detaches this business Q; it does not erase it.
    for (const task of h.store.listTasksForIssue(h.issue.id)) if (!['completed', 'failed', 'cancelled'].includes(task.status)) h.store.cancelTask(task.id);
    expect(h.store.getQuestion(h.q.id)).toMatchObject({ status: 'pending', wait_status: 'detached' });
    const foreign = h.store.createWorkspace({ name: 'Moved Q source', slug: 'moved-q-source' });
    const agent = h.store.createAgent({ name: 'Moved execution owner', provider: 'codex', workspaceId: foreign.id });
    const detached = await api.request(`/api/issues/${h.issue.id}`, { method: 'PATCH', headers,
      body: JSON.stringify({ parent_issue_id: null }) });
    expect(detached.status).toBe(200);
    // The re-route emits a fresh Q notification; stop that newly queued
    // handler execution as well before the guarded workspace move.
    for (const task of h.store.listTasksForIssue(h.issue.id)) if (!['completed', 'failed', 'cancelled'].includes(task.status)) h.store.cancelTask(task.id);
    const moved = await api.request(`/api/issues/${h.issue.id}`, { method: 'PATCH', headers,
      body: JSON.stringify({ workspace_id: foreign.id, assignee_type: 'agent', assignee_id: agent.id }) });
    expect(moved.status, JSON.stringify(await moved.clone().json())).toBe(200);
    expect(h.store.getIssue(h.issue.id)?.workspaceId).toBe(foreign.id);
    expect((await read()).status).toBe(404);
    const oldList = await api.request(`/api/issues/${h.parent.id}/questions`, { headers });
    expect(oldList.status).toBe(200);
    expect((await oldList.json() as any).questions.some((question: any) => question.id === h.q.id)).toBe(false);
    const newList = await api.request(`/api/issues/${h.issue.id}/questions`, { headers });
    expect(newList.status).toBe(200);
    expect((await newList.json() as any).questions.some((question: any) => question.id === h.q.id)).toBe(false);
    expect((await api.request(`/api/messages/${h.q.id}/question/answer`, { method: 'POST', headers,
      body: JSON.stringify({ expected_route_revision: h.store.getQuestion(h.q.id)!.route_revision, response: { answer: 'A' } }) })).status).toBe(404);
    expect(h.store.getQuestion(h.q.id)?.answer_revision).toBe(0);
    expect(h.store.getMessage(h.q.id)?.body_md).toBe('Which approach?');
  });

  for (const kind of ['production_change', 'merge']) {
    it(`${kind} requests climb the execution-owner chain like any question`, () => {
      const h = setup(fixture(), false, false, kind);
      expect(h.store.getQuestion(h.q.id)).toMatchObject({ stage: 'issue_owner', current_handler: { type: 'agent', id: h.leader.id }, route_reason: null });
      expect((h.store.getMessage(h.q.id)!.metadata.question as any).human_required).toBe(false);
      expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'member', id: 'mem_local_local' })).toThrow('question_handler_required');
      expect(h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id)).question.answer?.actor)
        .toEqual({ type: 'agent', id: h.leader.id });
    });
  }
  for (const response of [{ selected_options: ['allow'] }, { option_id: 'allow' }]) it(`the Leader answers a permission request with ${Object.keys(response)[0]} and the reply carries option_id`, () => {
    const h = setup(fixture(), false, false, 'permission', [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }]);
    const id = h.q.id;
    expect(h.store.getQuestion(id)).toMatchObject({ kind: 'permission', stage: 'issue_owner', current_handler: { type: 'agent', id: h.leader.id }, wait_status: 'waiting' });
    const notification = h.store.listMessages(h.store.getOrCreateDefaultIssueSession(h.issue.id).id)
      .find(message => message.metadata.root_question_id === id && message.metadata.question_notification === true)!;
    expect(notification.to_agent_id).toBe(h.leader.id);
    expect(notification.body_md).toContain('selected_options');
    expect(notification.body_md).toContain('option_id');
    expect(notification.body_md).toContain(`remi message question escalate ${id}`);
    const leaderTurn = h.agentTurn(h.leader.id);
    expect(() => h.store.answerQuestion(id, { expected_route_revision: 1, response: { option_id: 'missing' } }, { type: 'agent', id: h.leader.id }, leaderTurn)).toThrow('invalid human response');
    const answered = h.store.answerQuestion(id, { expected_route_revision: 1, response }, { type: 'agent', id: h.leader.id }, leaderTurn);
    expect(JSON.parse(answered.message.body_md)).toMatchObject({ option_id: 'allow' });
    expect(answered.message).toMatchObject({ reply_to_id: id, to_agent_id: h.worker.id, wake_applied: 'now' });
    expect(answered.question).toMatchObject({ status: 'answered', answer: { actor: { type: 'agent', id: h.leader.id }, response: { option_id: 'allow' } } });
  });
  it('keeps a capacity-busy Leader responsible and delivers Q into its existing coordination turn', () => {
    const h = setup(fixture(), false, true);
    expect(h.store.getQuestion(h.q.id)).toMatchObject({ current_handler: { type: 'agent', id: h.leader.id }, stage: 'issue_owner' });
    const live = h.store.listTasksForIssue(h.issue.id).filter(task => task.agentId === h.leader.id && task.status === 'running');
    expect(live.map(task => task.id)).toEqual([h.busyTask!.id]);
    const busyTurn = h.store.getTurnForAttempt(h.busyTask!.id)!;
    const reply = h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: h.leader.id }, busyTurn.id);
    expect(reply.question.answer?.actor).toEqual({ type: 'agent', id: h.leader.id });
    expect(reply.message.session_id).toBe(h.q.session_id); expect(reply.message.reply_to_id).toBe(h.q.id);
  });
  it('HTTP lets the routed Agent answer another private Agent Q but keeps private source turn details protected', async () => {
    const h = setup(fixture());
    h.store.updateAgent(h.worker.id, { visibility: 'private', ownerId: 'local' });
    const user = h.store.getOrCreateUser({ externalId: 'question_answer_http_member', name: 'Question handler caller' });
    h.store.createWorkspaceMember({ workspaceId: 'local', userId: user.id, name: 'Question handler caller', role: 'member' });
    const turn = h.store.getTurn(h.agentTurn(h.leader.id))!;
    const access = await h.store.createTaskAccessToken(h.store.getTask(turn.current_attempt_id!)!, user.id);
    const api = createMultiremiApp({ store: h.store, authToken: 'MASTER' });
    const publicSource = await api.request(`/api/messages/${h.q.id}`, { headers: { Authorization: 'Bearer MASTER' } });
    expect(publicSource.status).toBe(200);
    const sourceMetadata = (await publicSource.json() as any).message.metadata;
    expect(sourceMetadata.wait_id).toBeUndefined(); expect(sourceMetadata.question.wait.wait_id).toBeUndefined();
    expect(sourceMetadata.question.wait.runtime_id).toBeUndefined();
    const headers = { Authorization: `Bearer ${access.token}`, 'content-type': 'application/json' };
    expect((await api.request(`/api/turns/${h.turn.id}`, { headers })).status).toBe(404);
    const response = await api.request(`/api/messages/${h.q.id}/question/answer`, { method: 'POST', headers,
      body: JSON.stringify({ expected_route_revision: 1, response: { answers: { 'Which approach?': 'A' } } }) });
    expect(response.status).toBe(200);
    expect(h.store.getQuestion(h.q.id)?.answer?.actor).toEqual({ type: 'agent', id: h.leader.id });
    expect(h.store.getQuestion(h.q.id)?.answer_revision).toBe(1);
  });
  it('HTTP grants only the routed original private Q to handlers and Remi without granting the source transcript', async () => {
    const h = setup(fixture());
    h.store.updateAgent(h.worker.id, { visibility: 'private', ownerId: 'local' });
    const user = h.store.getOrCreateUser({ externalId: 'question_http_member', name: 'Question caller' });
    h.store.createWorkspaceMember({ workspaceId: 'local', userId: user.id, name: 'Question caller', role: 'member' });
    const api = createMultiremiApp({ store: h.store, authToken: 'MASTER' });
    const agentToken = async (agentId: string) => {
      const turn = h.store.getTurn(h.agentTurn(agentId))!;
      return (await h.store.createTaskAccessToken(h.store.getTask(turn.current_attempt_id!)!, user.id)).token;
    };
    const request = (token: string, path: string, data?: unknown) => api.request(path, {
      method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const leaderToken = await agentToken(h.leader.id);
    const wrongLaneTokens = async (actorId: string, issueId: string, notifiedSessionId: string) => {
      const side = h.store.createIssueSession(issueId, { title: 'Unnotified inherited side', parentSessionId: notifiedSessionId, inheritMode: 'follow' });
      const otherIssue = h.store.createIssue({ title: 'Unrelated responsibility', assigneeType: 'agent', assigneeId: actorId });
      const lanes = [
        { issueId, issueSessionId: side.id },
        { issueId, issueSessionId: notifiedSessionId, execution_scope: `unnotified:${h.q.id}` },
        { issueId: otherIssue.id },
      ];
      const tokens: string[] = [];
      for (const lane of lanes) {
        const sessionId = lane.issueSessionId ?? h.store.getOrCreateDefaultIssueSession(lane.issueId).id;
        const sent = h.store.sendMessage({ session_id: sessionId, sender: { type: 'member', id: 'mem_local_local' },
          to: { type: 'agent', ref: actorId }, message_kind: 'request', wake_requested: 'now',
          body_md: 'Unrelated work cannot borrow Q authority', execution_scope: lane.execution_scope ?? '' });
        const task = h.store.getTask(h.store.getTurn(sent.turn_id!)!.current_attempt_id!)!;
        const turn = h.store.getTurnForAttempt(task.id)!;
        expect(turn.session_id).toBe(sessionId); expect(turn.execution_scope).toBe(lane.execution_scope ?? '');
        h.db.run("UPDATE multiremi_turns SET status='running' WHERE id=?", [turn.id]);
        h.db.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?", [task.id]);
        tokens.push((await h.store.createTaskAccessToken(h.store.getTask(task.id)!, user.id)).token);
      }
      return tokens;
    };
    for (const token of await wrongLaneTokens(h.leader.id, h.issue.id, h.q.session_id)) {
      expect((await request(token, `/api/messages/${h.q.id}/question`)).status).toBe(403);
      expect((await request(token, `/api/messages/${h.q.id}/question/answer`, { expected_route_revision: 1, response: { answer: 'A' } })).status).toBe(403);
      expect(h.store.getQuestion(h.q.id)?.answer_revision).toBe(0);
    }
    expect((await request(leaderToken, `/api/messages/${h.q.id}`)).status).toBe(404);
    const exact = await request(leaderToken, `/api/messages/${h.q.id}/question`);
    expect(exact.status).toBe(200); expect((await exact.json() as any).question.id).toBe(h.q.id);
    expect((await request(leaderToken, `/api/messages/${h.q.id}/question/escalate`, { expected_route_revision: 1, reason: 'Ask parent' })).status).toBe(200);
    const parentToken = await agentToken(h.parentLeader.id);
    expect((await request(parentToken, `/api/messages/${h.q.id}/question`)).status).toBe(200);
    expect((await request(leaderToken, `/api/messages/${h.q.id}/question`)).status).toBe(403);
    const previous = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
    try {
      const remi = h.store.createAgent({ name: 'Remi', provider: 'codex' });
      h.store.heartbeatRuntime(h.runtime.id, { supportsFeishuBotConfig: true, supportsDecisionCard: true });
      h.store.upsertFeishuBotConfig('local', { agentId: remi.id, runtimeId: h.runtime.id, appId: 'cli_question_private', appSecretOp: 'set', appSecret: 'synthetic', enabled: true, domain: 'feishu' });
      // Reaching the human stage asks the configured Remi to present the same Q in the source Issue's Main.
      expect((await request(parentToken, `/api/messages/${h.q.id}/question/escalate`, { expected_route_revision: 2, reason: 'Ask a member' })).status).toBe(200);
      expect(h.store.getQuestion(h.q.id)).toMatchObject({ stage: 'human', current_handler: null, route_revision: 3 });
      const sourceMain = h.store.getOrCreateDefaultIssueSession(h.issue.id).id;
      expect(h.store.listMessages(sourceMain).filter(message => message.metadata.question_present_request === true && message.metadata.root_question_id === h.q.id)
        .map(message => [message.to_agent_id, message.metadata.question_route_revision])).toEqual([[remi.id, 3]]);
      const remiToken = await agentToken(remi.id);
      for (const token of await wrongLaneTokens(remi.id, h.issue.id, sourceMain)) {
        expect((await request(token, `/api/messages/${h.q.id}/question`)).status).toBe(403);
        expect((await request(token, `/api/messages/${h.q.id}/question/present`, { expected_route_revision: 3, summary: 'Unnotified context' })).status).toBe(403);
      }
      expect((await request(remiToken, `/api/messages/${h.q.id}/question`)).status).toBe(200);
      expect((await request(remiToken, `/api/messages/${h.q.id}`)).status).toBe(404);
      expect((await request(remiToken, `/api/messages/${h.q.id}/question/present`, { expected_route_revision: 3, summary: 'Same original private question summary' })).status).toBe(200);
      expect((await request(remiToken, `/api/messages/${h.q.id}/question/answer`, { expected_route_revision: 3, response: { answer: 'A' } })).status).toBe(403);
      // The retired transfer route explains its replacement instead of mutating the Q.
      const transfer = await api.request(`/api/messages/${h.q.id}/question/transfer`, { method: 'POST', headers: { Authorization: 'Bearer MASTER', 'content-type': 'application/json' },
        body: JSON.stringify({ expected_route_revision: 3, reason: 'Retired' }) });
      expect(transfer.status).toBe(410);
      expect(await transfer.json()).toMatchObject({ code: 'route_retired' });
      expect(h.store.getQuestion(h.q.id)?.route_revision).toBe(3);
      const foreign = h.store.createWorkspace({ name: 'Foreign question HTTP', slug: 'foreign-question-http' });
      const foreignAgent = h.store.createAgent({ name: 'Foreign actor', provider: 'codex', workspaceId: foreign.id });
      const foreignIssue = h.store.createIssue({ title: 'Foreign', workspaceId: foreign.id });
      const foreignTask = h.store.createTask({ agentId: foreignAgent.id, issueId: foreignIssue.id, prompt: 'Other work' });
      const foreignToken = (await h.store.createTaskAccessToken(foreignTask, 'local')).token;
      expect((await request(foreignToken, `/api/messages/${h.q.id}/question`)).status).toBe(404);
    } finally {
      if (previous === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previous;
    }
  }, 120_000);
  it('persists a valid answer when the source Agent is archived and permits one controlled retry after restoring it', () => {
    const h = setup(fixture());
    h.bridge.rpc('turn.decision.expire', { turn_id: h.turn.id, attempt_id: h.task.id, message_id: h.q.id, status: 'timeout' }, h.scope);
    h.store.archiveAgent(h.worker.id);
    const answer = h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id));
    expect(answer.question).toMatchObject({ status: 'answered', wait_status: 'detached', wait_reason: 'question_source_agent_unavailable', answer_revision: 1 });
    expect(h.db.query('SELECT id FROM multiremi_conversation_log WHERE dedupe_key=?').all(`question-continuation:${h.q.id}`)).toHaveLength(0);
    const reopened = new MultiremiStore(h.db);
    expect(reopened.getQuestion(h.q.id)?.answer?.response).toEqual({ answer: 'A', answers: { 'Which approach?': 'A' } });
    reopened.restoreAgent(h.worker.id);
    const resumed = reopened.continueQuestion(h.q.id, { expected_route_revision: 1 }, { type: 'member', id: 'mem_local_local' });
    expect(resumed.wait_status).toBe('continuation_pending');
    expect(resumed.recovery.consumer_turn_id).toBeString(); expect(resumed.recovery.consumer_attempt_id).toBeNull();
    expect(resumed.recovery.reply_message_id).toBe(answer.message.id); expect(resumed.recovery.continuation_message_id).toBeString();
    reopened.continueQuestion(h.q.id, { expected_route_revision: 1 }, { type: 'member', id: 'mem_local_local' });
    expect(h.db.query('SELECT id FROM multiremi_conversation_log WHERE dedupe_key=?').all(`question-continuation:${h.q.id}`)).toHaveLength(1);
    const consumer = h.store.getTurn((h.store.getMessage(h.q.id)!.metadata.question as any).wait.consumer_turn_id)!;
    expect(consumer.agent_id).toBe(h.worker.id);
  });
  it('re-routes a saved answer awaiting recovery without asking Agents again and lets any active member continue it', () => {
    const h = setup(fixture());
    h.bridge.rpc('turn.decision.expire', { turn_id: h.turn.id, attempt_id: h.task.id, message_id: h.q.id, status: 'timeout' }, h.scope);
    h.store.archiveAgent(h.worker.id);
    const saved = h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id));
    expect(saved.question.wait_status).toBe('detached');
    const creator = h.member('Root creator'), subscriber = h.member('Child subscriber'), other = h.member('Unreminded member');
    h.db.run('UPDATE multiremi_issues SET created_by=? WHERE id=?', [creator.userId, h.parent.id]);
    h.store.addIssueSubscriber(h.issue.id, subscriber.id);
    const next = h.store.createAgent({ name: 'Next child owner', provider: 'codex' });
    const beforeNotifications = h.db.query("SELECT COUNT(*) AS count FROM multiremi_conversation_log WHERE dedupe_key LIKE 'question-route:%' AND to_agent_id IS NOT NULL").get().count;
    h.store.updateIssue(h.issue.id, { assigneeType: 'agent', assigneeId: next.id, actorType: 'member', actorId: 'mem_local_local' });
    const moved = h.store.getQuestion(h.q.id, { type: 'member', id: other.id })!;
    expect(moved).toMatchObject({ status: 'answered', wait_status: 'detached', route_revision: 2, answer_revision: 1, answer: saved.question.answer,
      stage: 'issue_owner', current_handler: { type: 'agent', id: next.id } });
    // Continuation authority belongs to the human stage, whichever stage holds the Q.
    expect(moved.actions.allowed).toEqual(['continue']);
    expect(h.db.query("SELECT COUNT(*) AS count FROM multiremi_conversation_log WHERE dedupe_key LIKE 'question-route:%' AND to_agent_id IS NOT NULL").get().count).toBe(beforeNotifications);
    const notices = h.db.query("SELECT * FROM multiremi_conversation_log WHERE dedupe_key LIKE ? ORDER BY seq").all(`question-recovery-route:${h.q.id}:2:%`);
    expect(notices.map(notice => [notice.to_member_id, notice.dedupe_key])).toEqual([
      [creator.id, `question-recovery-route:${h.q.id}:2:${creator.id}`], [subscriber.id, `question-recovery-route:${h.q.id}:2:${subscriber.id}`]]);
    for (const notice of notices) {
      expect(notice.session_id).toBe(h.store.getOrCreateDefaultIssueSession(h.issue.id).id);
      expect(notice.reply_to_id).toBeNull(); expect(notice.wake_requested).toBe('inbox_only');
      // Timelines drop a notice whose original Q row lives in the same session.
      expect(JSON.parse(notice.metadata)).toMatchObject({ root_question_id: h.q.id, source_question_session_id: h.q.session_id });
    }
    // Continuation is a member decision: an Agent has no current-turn path into it.
    expect(() => h.store.continueQuestion(h.q.id, { expected_route_revision: 2 }, { type: 'agent', id: next.id })).toThrow('question_agent_current_turn_required');
    h.store.archiveWorkspaceMember(subscriber.id);
    expect(() => h.store.continueQuestion(h.q.id, { expected_route_revision: 2 }, { type: 'member', id: subscriber.id })).toThrow('question_actor_workspace_mismatch');
    h.store.restoreAgent(h.worker.id);
    const resumed = h.store.continueQuestion(h.q.id, { expected_route_revision: 2 }, { type: 'member', id: other.id });
    expect(resumed.wait_status).toBe('continuation_pending'); expect(resumed.answer_revision).toBe(1);
    h.store.continueQuestion(h.q.id, { expected_route_revision: 2 }, { type: 'member', id: creator.id });
    expect(h.db.query('SELECT id FROM multiremi_conversation_log WHERE dedupe_key=?').all(`question-continuation:${h.q.id}`)).toHaveLength(1);
  });
  it('real Feishu host callback rejects wrong operators and rotated cards then consumes the current same-Q answer once', async () => {
    const h = setup(fixture());
    const previous = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
    let stop: (() => void) | undefined, server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const remi = h.store.createAgent({ name: 'Remi', provider: 'codex' });
      const member = h.store.getWorkspaceMember('mem_local_local')!;
      // The card goes to the root creator, who maps to exactly one open_id.
      h.db.run('UPDATE multiremi_issues SET created_by=? WHERE id=?', [member.userId, h.parent.id]);
      h.db.run('UPDATE multiremi_users SET feishu_union_id=? WHERE id=?', ['on_question_human', member.userId]);
      const at = new Date().toISOString();
      h.db.run("INSERT INTO multiremi_feishu_bot_senders(id,workspace_id,app_id,open_id,union_id,display_name,allowed,first_seen_at,last_seen_at) VALUES('fbs_question','local','cli_question_host','ou_question_human','on_question_human','Human',1,?,?)", [at, at]);
      h.store.heartbeatRuntime(h.runtime.id, { supportsFeishuBotConfig: true, supportsDecisionCard: true });
      const config = h.store.upsertFeishuBotConfig('local', { agentId: remi.id, runtimeId: h.runtime.id, appId: 'cli_question_host',
        appSecretOp: 'set', appSecret: 'synthetic-question-test-secret', enabled: true, domain: 'feishu' });
      h.store.reportFeishuBotRuntimeStatus('local', h.runtime.id, { appliedRevision: config.revision, state: 'online' });
      h.store.updateWorkspace('local', { settings: { issueTopics: { enabled: true, chatId: 'oc_question' } } });
      h.store.prepareFeishuIssueTopicWithinTransaction(h.issue);
      const topic = h.store.claimFeishuBotOutbound('local', h.runtime.id)!;
      h.store.reportFeishuBotOutbound('local', h.runtime.id, topic.id, { claimToken: topic.claimToken, status: 'sent', externalMessageId: 'om_question_topic' });
      h.store.escalateQuestion(h.q.id, { expected_route_revision: 1, reason: 'Need parent' }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id));
      h.store.escalateQuestion(h.q.id, { expected_route_revision: 2, reason: 'Need human' }, { type: 'agent', id: h.parentLeader.id }, h.agentTurn(h.parentLeader.id));
      h.store.presentQuestion(h.q.id, { expected_route_revision: 3, summary: 'Remi summary' }, { type: 'agent', id: remi.id }, h.agentTurn(remi.id));
      const first = h.store.claimFeishuBotOutbound('local', h.runtime.id)!;
      expect(first.humanRequestId).toBe(h.q.id);
      expect(h.store.getMessage(h.q.id)?.card_token_recipient).toBe('ou_question_human');
      const oldAction = questionCardAction(decodeDecisionCardBody(first.body)!.card)!;
      h.store.reportFeishuBotOutbound('local', h.runtime.id, first.id, { claimToken: first.claimToken, status: 'sent', externalMessageId: 'om_question_card', interactionOpenId: 'ou_question_human' });
      const access = await h.store.createAccessToken({ name: 'questions-daemon', type: 'daemon', workspaceId: 'local', daemonId: 'questions-daemon' });
      const api = createMultiremiApp({ store: h.store, authToken: 'MASTER' });
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => api.fetch(request) });
      const client = new MultiremiDaemonClient(server.url.origin, access.token);
      stop = registerQuestionCardClient('cli_question_host', { getRequest: id => client.getMessageHumanRequest(id),
        respond: (id, response, credential) => client.respondTaskHumanRequest(id, response, credential),
        getDecision: async () => null, answer: async () => { throw new Error('retired decision route'); } });
      const click = (value: Record<string, unknown>, operator = 'ou_question_human') => handleTaskInteractionEvent('cli_question_host', {
        operator: { open_id: operator }, context: { open_message_id: 'om_question_card', open_chat_id: 'oc_question' },
        action: { name: interactionMarker(h.task.id, h.q.id), value, form_value: { q0_option0: true } },
      });
      expect((await click(oldAction, 'ou_stranger'))?.toast).toMatchObject({ type: 'error' });
      expect(h.store.getQuestion(h.q.id)?.status).toBe('pending');
      // An execution-owner change re-routes the escalated Q at the human stage and rotates its card.
      h.store.updateIssue(h.parent.id, { assigneeType: 'agent', assigneeId: h.store.createAgent({ name: 'Replacement root owner', provider: 'codex' }).id,
        actorType: 'member', actorId: member.id });
      expect(h.store.getQuestion(h.q.id)).toMatchObject({ stage: 'human', current_handler: null, route_revision: 4 });
      expect(h.store.getMessage(h.q.id)?.card_token_hash).toBeNull();
      expect((await click(oldAction))?.toast).toMatchObject({ type: 'error' });
      h.store.presentQuestion(h.q.id, { expected_route_revision: 4, summary: 'Updated Remi summary' }, { type: 'agent', id: remi.id }, h.agentTurn(remi.id));
      const current = h.store.claimFeishuBotOutbound('local', h.runtime.id)!;
      const currentAction = questionCardAction(decodeDecisionCardBody(current.body)!.card)!;
      h.store.reportFeishuBotOutbound('local', h.runtime.id, current.id, { claimToken: current.claimToken, status: 'sent', externalMessageId: 'om_question_card_current', interactionOpenId: 'ou_question_human' });
      const durablePatches = () => h.db.query("SELECT id FROM multiremi_feishu_bot_outbound_operations WHERE kind='decision_patch' AND unit_key=? UNION ALL SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE kind='decision_card_patch' AND human_request_id=?").all(h.q.id, h.q.id);
      expect(() => h.db.transaction(() => {
        h.store.answerQuestion(h.q.id, { expected_route_revision: 4, response: { answers: { 'Which approach?': 'A' } } }, { type: 'member', id: member.id });
        expect(durablePatches()).toHaveLength(1);
        throw new Error('Rollback both answer and durable terminal card intent');
      })()).toThrow('Rollback both answer and durable terminal card intent');
      expect(h.store.getQuestion(h.q.id)?.status).toBe('pending');
      expect(h.store.getMessage(h.q.id)?.card_token_consumed_at).toBeNull();
      expect(durablePatches()).toHaveLength(0);
      expect((await click(currentAction))?.toast).toMatchObject({ type: 'success' });
      expect(h.store.getQuestion(h.q.id)).toMatchObject({ status: 'answered', answer_revision: 1, answer: { actor: { type: 'member', id: member.id }, response: { answers: { 'Which approach?': 'A' } } } });
      const replay = await click(currentAction);
      expect(replay?.toast).not.toMatchObject({ type: 'success' });
      expect(h.store.getQuestion(h.q.id)?.history.filter(event => event.type === 'answer')).toHaveLength(1);
      expect(h.store.getMessage(h.q.id)?.card_token_consumed_at).not.toBeNull();
      expect(durablePatches()).toHaveLength(1);
    } finally {
      stop?.(); await server?.stop(true);
      if (previous === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previous;
    }
  }, 120_000);
  it('waits for Remi summary before same-Q presentation and preserves the original options in degraded text', () => {
    const h = setup(fixture());
    const previous = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
    try {
      const remi = h.store.createAgent({ name: 'Remi', provider: 'codex' });
      h.store.heartbeatRuntime(h.runtime.id, { supportsFeishuBotConfig: true, supportsDecisionCard: true });
      const config = h.store.upsertFeishuBotConfig('local', { agentId: remi.id, runtimeId: h.runtime.id, appId: 'cli_question',
        appSecretOp: 'set', appSecret: 'synthetic-question-test-secret', enabled: true, domain: 'feishu' });
      h.store.reportFeishuBotRuntimeStatus('local', h.runtime.id, { appliedRevision: config.revision, state: 'online' });
      h.store.updateWorkspace('local', { settings: { issueTopics: { enabled: true, chatId: 'oc_question' } } });
      h.store.prepareFeishuIssueTopicWithinTransaction(h.issue);
      const topic = h.store.claimFeishuBotOutbound('local', h.runtime.id)!;
      expect(topic).toBeTruthy();
      h.store.reportFeishuBotOutbound('local', h.runtime.id, topic.id, { claimToken: topic.claimToken, status: 'sent', externalMessageId: 'om_question_topic' });
      h.store.escalateQuestion(h.q.id, { expected_route_revision: 1, reason: 'Need parent' }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id));
      h.store.escalateQuestion(h.q.id, { expected_route_revision: 2, reason: 'Need human' }, { type: 'agent', id: h.parentLeader.id }, h.agentTurn(h.parentLeader.id));
      const pending = h.store.getTaskHumanRequest(h.q.id)!;
      expect(pending.expiresAt).toBeNull();
      expect(Date.parse(String(pending.payload.question_summary_wait_until))).toBeGreaterThan(Date.now());
      h.store.prepareFeishuBotHumanRequestPush(pending);
      h.store.pendingFeishuBotOutbound('local', h.runtime.id);
      expect(h.db.query('SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE human_request_id=?').all(h.q.id)).toHaveLength(0);
      const summary = 'Remi explains the background and recommends A';
      h.store.presentQuestion(h.q.id, { expected_route_revision: 3, summary }, { type: 'agent', id: remi.id }, h.agentTurn(remi.id));
      const delivery = h.store.claimFeishuBotOutbound('local', h.runtime.id)!;
      expect(delivery?.humanRequestId).toBe(h.q.id);
      expect(delivery.degraded).toBe('unresolved_recipient');
      expect(delivery.body).toContain(h.q.id);
      expect(delivery.body).toContain(summary);
      expect(delivery.body).toContain('Which approach?');
      expect(h.store.getQuestion(h.q.id)?.original_questions).toEqual(h.q.original_questions);
      expect(h.store.getMessage(h.q.id)?.card_token_hash).toBeNull();
      expect(decodeDecisionCardBody(delivery.body)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previous;
    }
  });
  it('reads historical AUQ context without writing or inventing a live provider wait', () => {
    const h = setup(fixture());
    const metadata = { human_request: { kind: 'question', status: 'pending', payload: {
      message: 'Original historical question', context: { text: 'Original context', truncated: true },
      questions: [{ fieldKey: 'place', otherFieldKey: 'other_place', question: { question: 'Where?', options: [{ label: 'Paris' }] } }],
    } } };
    const historical = h.store.sendMessage({ session_id: h.q.session_id, sender: { type: 'agent', id: h.worker.id }, source_turn_id: h.turn.id,
      to: { type: 'none' }, message_kind: 'decision', wake_requested: 'inbox_only', body_md: 'Original historical question', metadata }).message;
    const before = h.store.getMessage(historical.id)!;
    const question = h.store.getQuestion(historical.id)!;
    expect(question).toMatchObject({ kind: 'question', status: 'pending', wait_status: 'detached', wait_reason: 'historical_native_wait_unverified', original_context: metadata.human_request.payload.context });
    expect(question.original_questions).toEqual(metadata.human_request.payload.questions);
    expect(h.store.getMessage(historical.id)?.metadata).toEqual(before.metadata);
    expect(h.store.getMessage(historical.id)?.revision).toBe(before.revision);
    expect(() => h.store.deleteMessage(historical.id)).toThrow('Original questions and their history are immutable');
  });
  it('preserves unknown historical answer identities and settled records that lack answer content', () => {
    const h = setup(fixture());
    const user = h.store.getOrCreateUser({ externalId: 'history_name_impostor', name: 'Unknown history actor' });
    const member = h.store.createWorkspaceMember({ workspaceId: 'local', userId: user.id, name: 'Unknown history actor', role: 'member' });
    for (const response of [{ answer: 'A' }, null]) {
      const historical = h.store.sendMessage({ session_id: h.q.session_id, sender: { type: 'agent', id: h.worker.id }, source_turn_id: h.turn.id,
        to: { type: 'none' }, message_kind: 'decision', wake_requested: 'inbox_only', body_md: 'Historical settled Q',
        metadata: { human_request: { kind: 'question', status: 'responded', responded_by: 'Unknown history actor', response,
          payload: { questions: [{ question: 'Which approach?', options: [{ label: 'A' }] }] } } } }).message;
      const before = h.store.getMessage(historical.id)!;
      const question = h.store.getQuestion(historical.id)!;
      expect(question).toMatchObject({ status: 'answered', wait_status: 'none' });
      if (response) { expect(question.answer?.actor.id).toBe('Unknown history actor'); expect(question.answer?.actor.id).not.toBe(member.id); }
      else { expect(question.answer).toBeNull(); expect(question.history).toEqual([]); }
      expect(h.store.getMessage(historical.id)?.metadata).toEqual(before.metadata); expect(h.store.getMessage(historical.id)?.revision).toBe(before.revision);
    }
  });
  it('retires independent IssueDecision writers while preserving historical answer reasons and no fake wait', () => {
    const h = setup(fixture());
    const oldAnswer = { answererType: 'agent', answererId: h.parentLeader.id, answer: 'A', reason: 'Original reason', overturn: 'Ask root human', answeredAt: '2026-01-01T00:00:00Z' };
    const old = h.store.sendMessage({ session_id: h.q.session_id, sender: { type: 'agent', id: h.worker.id }, source_turn_id: h.turn.id,
      to: { type: 'none' }, message_kind: 'decision', wake_requested: 'inbox_only', body_md: 'Original decision',
      metadata: { decision_record: { source_issue_id: h.issue.id, kind: 'question', status: 'answered', answer: oldAnswer, history: [oldAnswer] } } }).message;
    const question = h.store.getQuestion(old.id)!;
    expect(question).toMatchObject({ wait_status: 'none', status: 'answered', answer: { body_md: 'A', actor: { id: h.parentLeader.id } } });
    expect(question.history[0]?.reason).toBe('Original reason');
    expect((h.store.getMessage(old.id)!.metadata.decision_record as any).history[0].overturn).toBe('Ask root human');
    expect(() => h.store.createIssueDecision(h.issue.id, { kind: 'question', title: 'Second Q' }, { type: 'agent', id: h.worker.id, taskId: h.task.id })).toThrow('IssueDecision writers are retired');
    expect(() => h.store.answerIssueDecision(h.issue.id, old.id, { answer: 'B', reason: 'Retired' }, { type: 'member', id: 'mem_local_local', taskId: null })).toThrow('IssueDecision writers are retired');
  });
  it('bounds SQL pages and responsibility refresh to related Issues', () => {
    const h = setup(fixture());
    const unrelated = h.store.createIssue({ title: 'Unrelated' });
    const otherSession = h.store.getOrCreateDefaultIssueSession(unrelated.id);
    const unrelatedQ = h.store.sendMessage({ session_id: otherSession.id, sender: { type: 'platform', id: null }, to: { type: 'none' },
      message_kind: 'decision', wake_requested: 'inbox_only', body_md: 'Must not resolve', metadata: { human_request: { kind: 'question', status: 'pending', payload: { message: 'Must not resolve' } } } }).message;
    const second = h.store.sendMessage({ session_id: h.q.session_id, sender: { type: 'platform', id: null }, to: { type: 'none' }, message_kind: 'decision',
      wake_requested: 'inbox_only', body_md: 'Historical local Q', metadata: { human_request: { kind: 'question', status: 'pending', payload: { message: 'Historical local Q' } } } }).message;
    const withoutQuestion = h.store.sendMessage({ session_id: h.q.session_id, sender: { type: 'platform', id: null }, to: { type: 'none' }, message_kind: 'decision',
      wake_requested: 'inbox_only', body_md: 'Unrelated decision message without a Question' }).message;
    h.db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?', [JSON.stringify({}), withoutQuestion.id]);
    const resolve = h.store.resolveIssueResponsibility.bind(h.store);
    h.store.resolveIssueResponsibility = id => { if (id === unrelated.id) throw new Error('Unrelated responsibility query'); return resolve(id); };
    const first = h.store.listIssueQuestions(h.parent.id, undefined, { limit: 1 });
    const next = h.store.listIssueQuestions(h.parent.id, undefined, { limit: 1, before: first[0]!.id });
    expect(new Set([...first, ...next].map(q => q.id))).toEqual(new Set([h.q.id, second.id]));
    expect(h.store.listIssueQuestions(h.parent.id, undefined, { limit: 1, before: next[0]!.id })).toEqual([]);
    const ctx = new StoreContext(h.db, () => h.store), events = createCommitEventQueue();
    h.db.transaction(() => refreshIssueQuestionsAfterResponsibilityChangeWithinTransaction(ctx, h.issue.id, events))();
    expect(h.store.getMessage(unrelatedQ.id)?.metadata.question).toBeUndefined();
  });
  for (const failure of ['parent_missing', 'parent_cycle', 'workspace_mismatch'] as const) it(`a ${failure} parent chain hands the Q to the human stage at the break`, () => {
    const h = setup(fixture());
    const other = h.store.createWorkspace({ name: `Broken chain ${failure}`, slug: `broken-chain-${failure.replaceAll('_', '-')}` });
    if (failure === 'parent_missing') h.db.run('UPDATE multiremi_issues SET parent_issue_id=? WHERE id=?', ['iss_missing_question_parent', h.issue.id]);
    if (failure === 'parent_cycle') h.db.run('UPDATE multiremi_issues SET parent_issue_id=? WHERE id=?', [h.issue.id, h.parent.id]);
    if (failure === 'workspace_mismatch') h.db.run('UPDATE multiremi_issues SET workspace_id=? WHERE id=?', [other.id, h.parent.id]);
    const reason = failure === 'parent_missing' ? 'iss_missing_question_parent:parent_missing'
      : failure === 'parent_cycle' ? `${h.issue.id}:parent_cycle` : `${h.parent.id}:workspace_mismatch`;
    // The owners before the break still answer in order; the break itself hands over to a member.
    const owners = failure === 'parent_cycle' ? [h.leader.id, h.parentLeader.id] : [h.leader.id];
    const q = h.refresh(h.issue.id);
    expect(q).toMatchObject({ stage: 'issue_owner', current_handler: { type: 'agent', id: h.leader.id }, route_reason: reason, route_revision: 2 });
    expect((h.store.getMessage(h.q.id)!.metadata.question as any).route.map((step: any) => step.handler?.id ?? step.stage)).toEqual([...owners, 'human']);
    let revision = 2;
    for (const owner of owners) h.store.escalateQuestion(h.q.id, { expected_route_revision: revision++, reason: 'Cannot decide here' }, { type: 'agent', id: owner }, h.agentTurn(owner));
    const human = h.store.getQuestion(h.q.id, { type: 'member', id: 'mem_local_local' })!;
    expect(human).toMatchObject({ stage: 'human', current_handler: null, route_reason: reason, actions: { allowed: ['answer', 'close'] } });
    expect(h.store.answerQuestion(h.q.id, { expected_route_revision: revision, response: { answer: 'A' } }, { type: 'member', id: 'mem_local_local' }).question.status).toBe('answered');
  });
  it('hands the Q to the human stage when a level has no execution owner, without skipping it', () => {
    const h = setup(fixture());
    h.db.run('UPDATE multiremi_issues SET assignee_type=NULL,assignee_id=NULL WHERE id=?', [h.parent.id]);
    const q = h.refresh(h.parent.id);
    expect(q).toMatchObject({ stage: 'issue_owner', current_handler: { id: h.leader.id }, route_reason: `${h.parent.id}:execution_owner_missing` });
    const human = h.store.escalateQuestion(h.q.id, { expected_route_revision: 2, reason: 'Parent has no owner' }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id));
    expect(human).toMatchObject({ stage: 'human', current_handler: null, route_revision: 3, route_reason: `${h.parent.id}:execution_owner_missing` });
    // Configuring the missing owner does not pull an explicit escalation back to the Agents.
    h.store.updateIssue(h.parent.id, { assigneeType: 'agent', assigneeId: h.parentLeader.id, actorType: 'member', actorId: 'mem_local_local' });
    expect(h.store.getQuestion(h.q.id)).toMatchObject({ stage: 'human', current_handler: null, route_revision: 4, route_reason: null });
  });
  it('starts a Q of a team without a Leader at the human stage and returns it to the Leader once configured', () => {
    const { store, db } = fixture();
    const runtime = store.registerRuntime({ name: 'Leaderless host', provider: 'codex', daemonId: 'leaderless-daemon', maxConcurrency: 8 });
    const lead = store.createAgent({ name: 'Leader to remove', provider: 'codex' });
    const worker = store.createAgent({ name: 'Leaderless worker', provider: 'codex', runtimeId: runtime.id });
    const team = store.createSquad({ name: 'Leaderless team', leaderId: lead.id, memberIds: [worker.id] });
    const issue = store.createIssue({ title: 'Team work', assigneeType: 'squad', assigneeId: team.id });
    db.run('UPDATE multiremi_squads SET leader_id=NULL WHERE id=?', [team.id]);
    const task = store.createTask({ agentId: worker.id, issueId: issue.id, prompt: 'Ask the team' });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
    const turn = store.getTurnForAttempt(task.id)!;
    const created = store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id, dedupe_key: `leaderless:${task.id}`, wait_id: `leaderless:${task.id}`,
      body_md: 'Which team decision?', options: [{ label: 'A', value: 'A' }], metadata: { kind: 'question', questions: [{ question: 'Which team decision?', options: [{ label: 'A' }] }] } },
      { runtimeId: runtime.id, daemonId: 'leaderless-daemon', workspaceId: 'local' });
    const id = String(created.message_id);
    // No member of the team stands in for its missing Leader.
    expect(store.getQuestion(id)).toMatchObject({ stage: 'human', current_handler: null, route_reason: `${issue.id}:leader_missing`, route_revision: 1 });
    expect(store.getMessage(id)?.to_agent_id).toBeNull();
    store.updateSquad(team.id, { leaderId: lead.id });
    expect(store.getQuestion(id)).toMatchObject({ stage: 'issue_owner', current_handler: { type: 'agent', id: lead.id }, route_reason: null, route_revision: 2 });
  });
  it('keeps a Q whose source moved to another workspace frozen for every actor', () => {
    const h = setup(fixture());
    const other = h.store.createWorkspace({ name: 'Other', slug: 'question-other' });
    const agent = h.store.createAgent({ name: 'Foreign actor', provider: 'codex', workspaceId: other.id });
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: agent.id })).toThrow('question_actor_workspace_mismatch');
    h.db.run('UPDATE multiremi_issues SET workspace_id=? WHERE id=?', [other.id, h.issue.id]);
    expect(h.store.getQuestion(h.q.id, { type: 'member', id: 'mem_local_local' })).toMatchObject({ current_handler: null, stage: 'unavailable', route_reason: 'source_workspace_changed', actions: { allowed: [] } });
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'member', id: 'mem_local_local' })).toThrow('question_source_workspace_changed');
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id))).toThrow('question_source_workspace_changed');
    expect(h.refresh(h.issue.id)).toMatchObject({ stage: 'unavailable', route_revision: 1 });
  });
  it('worker routes from the Issue, retains original Q and writes the owner answer to its source session', () => {
    const h = setup(fixture());
    expect(h.q).toMatchObject({ current_handler: { type: 'agent', id: h.leader.id }, stage: 'issue_owner', status: 'pending', wait_status: 'waiting' });
    const actor = { type: 'agent' as const, id: h.leader.id };
    const answered = h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answers: { approach: 'A' } } }, actor, h.agentTurn(h.leader.id));
    expect(answered.message.session_id).toBe(h.q.session_id);
    expect(answered.message.reply_to_id).toBe(h.q.id);
    expect(h.store.getQuestion(h.q.id)).toMatchObject({ status: 'answered', wait_status: 'waiting', answer: { response: { answers: { 'Which approach?': 'A' } } } });
    expect(h.bridge.rpc('turn.decision.consume', { turn_id: h.turn.id, attempt_id: h.task.id, message_id: h.q.id, reply_message_id: answered.message.id, wait_id: `wait_nonce_${h.task.id}` }, h.scope)).toEqual({ ok: true });
    expect(h.store.getQuestion(h.q.id)?.wait_status).toBe('consumed');
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'B' } }, actor, h.agentTurn(h.leader.id))).toThrow('question_already_settled');
  });
  it('escalates the same Q through the parent owner to the human stage, retaining options and refusing stale handlers', () => {
    const h = setup(fixture());
    expect((h.store.getMessage(h.q.id)!.metadata.question as any).route).toEqual([
      { handler: { type: 'agent', id: h.leader.id }, issue_id: h.issue.id, stage: 'issue_owner' },
      { handler: { type: 'agent', id: h.parentLeader.id }, issue_id: h.parent.id, stage: 'parent_owner' },
      { handler: null, issue_id: h.parent.id, stage: 'human' }]);
    const first = h.store.escalateQuestion(h.q.id, { expected_route_revision: 1, reason: 'Need parent decision' }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id));
    expect(first).toMatchObject({ id: h.q.id, current_handler: { id: h.parentLeader.id }, route_revision: 2, stage: 'parent_owner' });
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id))).toThrow('question_route_changed');
    const human = h.store.escalateQuestion(h.q.id, { expected_route_revision: 2, reason: 'Need a member' }, { type: 'agent', id: h.parentLeader.id }, h.agentTurn(h.parentLeader.id));
    expect(human).toMatchObject({ id: h.q.id, current_handler: null, route_revision: 3, stage: 'human', route_reason: null });
    expect(human.options).toEqual(h.q.options); expect(human.original_questions).toEqual(h.q.original_questions);
    expect(human.history.at(-1)).toMatchObject({ type: 'transfer', actor: null, handler: null, source_session_id: h.store.getOrCreateDefaultIssueSession(h.issue.id).id });
    const notifications = h.db.query("SELECT session_id,reply_to_id,metadata FROM multiremi_conversation_log WHERE message_kind='request'").all().filter(m => JSON.parse(m.metadata ?? '{}').root_question_id === h.q.id);
    expect(notifications.some(m => m.session_id !== h.q.session_id)).toBeTrue();
    expect(notifications.every(m => m.reply_to_id === null)).toBeTrue();
    // Nobody created the root as a member and nobody subscribed: the Q waits without a reminder.
    expect(h.db.query('SELECT id FROM multiremi_conversation_log WHERE dedupe_key LIKE ?').all(`question-route:${h.q.id}:3:%`)).toEqual([]);
    expect(Number(h.db.query("SELECT COUNT(*) AS n FROM multiremi_conversation_log WHERE message_kind='decision'").get().n)).toBe(1);
    expect(() => h.store.escalateQuestion(h.q.id, { expected_route_revision: 3, reason: 'Nobody above' }, { type: 'agent', id: h.parentLeader.id }, h.agentTurn(h.parentLeader.id))).toThrow();
  });
  it('lets any active member of the workspace answer, revise or close at the human stage, and nobody else', async () => {
    const h = setup(fixture());
    h.toHuman();
    const first = h.member('First member'), second = h.member('Second member'), archived = h.member('Archived member');
    h.store.archiveWorkspaceMember(archived.id);
    const foreign = h.store.createWorkspace({ name: 'Foreign members', slug: 'question-foreign-members' });
    const foreignOwner = h.store.listWorkspaceMembers(foreign.id).find(member => member.role === 'owner')!;
    expect(h.store.getQuestion(h.q.id, { type: 'member', id: first.id })?.actions.allowed).toEqual(['answer', 'close']);
    expect(h.store.getQuestion(h.q.id, { type: 'member', id: archived.id })?.actions.allowed).toEqual([]);
    expect(h.store.getQuestion(h.q.id, { type: 'member', id: foreignOwner.id })?.actions.allowed).toEqual([]);
    expect(h.store.getQuestion(h.q.id, { type: 'agent', id: h.parentLeader.id })?.actions.allowed).toEqual([]);
    const answer = (sender: { type: 'member' | 'agent' | 'platform'; id: string | null }, turnId?: string) =>
      () => h.store.answerQuestion(h.q.id, { expected_route_revision: 3, response: { answer: 'A' } }, sender as any, turnId);
    expect(answer({ type: 'member', id: archived.id })).toThrow('question_actor_workspace_mismatch');
    expect(answer({ type: 'member', id: foreignOwner.id })).toThrow('question_actor_workspace_mismatch');
    expect(answer({ type: 'platform', id: null })).toThrow('question_actor_required');
    // The source Agent's own task credential reads its lane but holds no member authority.
    expect(answer({ type: 'agent', id: h.worker.id }, h.turn.id)).toThrow('question_handler_required');
    expect(answer({ type: 'agent', id: h.parentLeader.id }, h.agentTurn(h.parentLeader.id))).toThrow();
    const answered = h.store.answerQuestion(h.q.id, { expected_route_revision: 3, response: { answers: { 'Which approach?': 'A' } } }, { type: 'member', id: first.id });
    expect(answered.question).toMatchObject({ status: 'answered', answer: { actor: { type: 'member', id: first.id } } });
    expect(h.store.getQuestion(h.q.id, { type: 'member', id: second.id })?.actions.allowed).toEqual(['revise']);
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 3, expected_answer_revision: 1, revise: true, reason: 'Archived',
      response: { answers: { 'Which approach?': 'B' } } }, { type: 'member', id: archived.id })).toThrow('question_actor_workspace_mismatch');
    const revised = h.store.answerQuestion(h.q.id, { expected_route_revision: 3, expected_answer_revision: 1, revise: true, reason: 'B is safer',
      response: { answers: { 'Which approach?': 'B' } } }, { type: 'member', id: second.id });
    expect(revised.question).toMatchObject({ answer_revision: 2, answer: { actor: { type: 'member', id: second.id }, response: { answers: { 'Which approach?': 'B' } } } });
    expect(h.store.listMessages(h.q.session_id).find(message => message.dedupe_key === `question-revision:${h.q.id}:${revised.message.id}`)?.body_md).toStartWith('成员修订了问题');
  });
  it('lets any active member close a Q at the human stage', () => {
    const h = setup(fixture());
    h.toHuman();
    const archived = h.member('Archived closer');
    h.store.archiveWorkspaceMember(archived.id);
    expect(() => h.store.closeQuestion(h.q.id, { expected_route_revision: 3, reason: 'No longer needed' }, { type: 'agent', id: h.parentLeader.id }, h.agentTurn(h.parentLeader.id))).toThrow();
    expect(() => h.store.closeQuestion(h.q.id, { expected_route_revision: 3, reason: 'No longer needed' }, { type: 'member', id: archived.id })).toThrow('question_actor_workspace_mismatch');
    const closer = h.member('Closing member');
    expect(h.store.closeQuestion(h.q.id, { expected_route_revision: 3, reason: 'No longer needed' }, { type: 'member', id: closer.id })).toMatchObject({ status: 'closed', wait_status: 'detached' });
    // The live provider call is released with a cancellation, never an answer.
    expect(h.store.listMessages(h.q.session_id).find(message => message.reply_to_id === h.q.id)?.metadata).toMatchObject({ question_closed: true, human_response: { cancelled: true } });
  });
  it('keeps an Agent-stage Q read-only for members, including after the Agent answers', () => {
    const h = setup(fixture());
    const reader = h.member('Agent stage reader');
    expect(h.store.getQuestion(h.q.id, { type: 'member', id: reader.id })).toMatchObject({ stage: 'issue_owner', actions: { allowed: [] } });
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'member', id: reader.id })).toThrow('question_handler_required');
    expect(() => h.store.closeQuestion(h.q.id, { expected_route_revision: 1, reason: 'Members do not close Agent-stage Qs' }, { type: 'member', id: reader.id })).toThrow('question_close_authority_required');
    h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id));
    expect(h.store.getQuestion(h.q.id, { type: 'member', id: reader.id })?.actions.allowed).toEqual([]);
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, expected_answer_revision: 1, revise: true, reason: 'Override',
      response: { answer: 'B' } }, { type: 'member', id: reader.id })).toThrow('question_revision_human_required');
  });
  it('keeps a member answer revisable when configuring the missing owner moves its detached Q back to the Agent', () => {
    const { store, db } = fixture();
    const runtime = store.registerRuntime({ name: 'Unowned root host', provider: 'codex', daemonId: 'unowned-root-daemon', maxConcurrency: 8 });
    const worker = store.createAgent({ name: 'Unowned root worker', provider: 'codex', runtimeId: runtime.id });
    const owner = store.createAgent({ name: 'Configured later', provider: 'codex' });
    const issue = store.createIssue({ title: 'Root without an owner' });
    const task = store.createTask({ agentId: worker.id, issueId: issue.id, prompt: 'Ask before an owner exists' });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
    const turn = store.getTurnForAttempt(task.id)!;
    const scope = { runtimeId: runtime.id, daemonId: 'unowned-root-daemon', workspaceId: 'local' };
    const bridge = store.getDaemonTurnBridge();
    const id = String(bridge.rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id, dedupe_key: `unowned-root:${task.id}`, wait_id: `unowned-root:${task.id}`,
      body_md: 'Which root decision?', options: [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }],
      metadata: { kind: 'question', questions: [{ question: 'Which root decision?', options: [{ label: 'A' }, { label: 'B' }] }] } }, scope).message_id);
    expect(store.getQuestion(id)).toMatchObject({ stage: 'human', current_handler: null, route_reason: `${issue.id}:execution_owner_missing`, route_revision: 1 });
    bridge.rpc('turn.decision.expire', { turn_id: turn.id, attempt_id: task.id, message_id: id, status: 'cancelled' }, scope);
    store.answerQuestion(id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'member', id: 'mem_local_local' });
    store.updateIssue(issue.id, { assigneeType: 'agent', assigneeId: owner.id, actorType: 'member', actorId: 'mem_local_local' });
    const user = store.getOrCreateUser({ externalId: 'question_unowned_reviser', name: 'Unowned reviser' });
    const reviser = store.createWorkspaceMember({ workspaceId: 'local', userId: user.id, name: user.name, role: 'member' });
    // The re-route moved the current step to the new owner; the saved answer still came from the human stage.
    expect(store.getQuestion(id, { type: 'member', id: reviser.id })).toMatchObject({ status: 'answered', wait_status: 'detached', stage: 'issue_owner',
      current_handler: { type: 'agent', id: owner.id }, route_revision: 2, actions: { allowed: ['revise', 'continue'] } });
    expect(store.getQuestion(id, { type: 'agent', id: owner.id })?.actions.allowed).toEqual([]);
    const revised = store.answerQuestion(id, { expected_route_revision: 2, expected_answer_revision: 1, revise: true, reason: 'B fits the owner',
      response: { answer: 'B' } }, { type: 'member', id: reviser.id });
    expect(revised.question).toMatchObject({ answer_revision: 2, answer: { actor: { type: 'member', id: reviser.id }, response: { answer: 'B' } } });
    expect(Number(db.query("SELECT COUNT(*) AS n FROM multiremi_conversation_log WHERE dedupe_key LIKE ?").get(`question-revision:${id}:%`).n)).toBe(1);
  });
  it('keeps an Agent answer unrevisable when unassigning its level moves the detached Q to the human stage', () => {
    const h = setup(fixture());
    h.bridge.rpc('turn.decision.expire', { turn_id: h.turn.id, attempt_id: h.task.id, message_id: h.q.id, status: 'cancelled' }, h.scope);
    h.store.escalateQuestion(h.q.id, { expected_route_revision: 1, reason: 'Need parent' }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id));
    h.store.answerQuestion(h.q.id, { expected_route_revision: 2, response: { answer: 'A' } }, { type: 'agent', id: h.parentLeader.id }, h.agentTurn(h.parentLeader.id));
    h.db.run('UPDATE multiremi_issues SET assignee_type=NULL,assignee_id=NULL WHERE id=?', [h.parent.id]);
    const reader = h.member('Agent answer reader');
    expect(h.refresh(h.parent.id)).toMatchObject({ status: 'answered', wait_status: 'detached', stage: 'human', current_handler: null, route_revision: 3,
      answer: { actor: { type: 'agent', id: h.parentLeader.id } } });
    // Continuation stays a member decision; the Agent's answer stays as given.
    expect(h.store.getQuestion(h.q.id, { type: 'member', id: reader.id })?.actions.allowed).toEqual(['continue']);
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 3, expected_answer_revision: 1, revise: true, reason: 'Override',
      response: { answer: 'B' } }, { type: 'member', id: reader.id })).toThrow('question_revision_human_required');
  });
  it('reminds the root creator and the source Issue member subscribers at the human stage without limiting who acts', () => {
    const h = setup(fixture());
    const creator = h.member('Root creator'), subscriber = h.member('Child subscriber'), gone = h.member('Archived subscriber'), other = h.member('Unreminded member');
    h.db.run('UPDATE multiremi_issues SET created_by=? WHERE id=?', [creator.userId, h.parent.id]);
    h.store.addIssueSubscriber(h.issue.id, subscriber.id); h.store.addIssueSubscriber(h.issue.id, gone.id); h.store.addIssueSubscriber(h.issue.id, creator.id);
    h.store.archiveWorkspaceMember(gone.id);
    const human = h.toHuman();
    const sourceMain = h.store.getOrCreateDefaultIssueSession(h.issue.id).id;
    const reminders = h.db.query('SELECT * FROM multiremi_conversation_log WHERE dedupe_key LIKE ? ORDER BY seq').all(`question-route:${h.q.id}:3:%`);
    expect(reminders.map(row => [row.to_member_id, row.dedupe_key])).toEqual([
      [creator.id, `question-route:${h.q.id}:3:${creator.id}`], [subscriber.id, `question-route:${h.q.id}:3:${subscriber.id}`]]);
    for (const row of reminders) {
      expect(row).toMatchObject({ session_id: sourceMain, message_kind: 'request', wake_requested: 'inbox_only', to_agent_id: null, reply_to_id: null });
      expect(JSON.parse(row.metadata)).toMatchObject({ root_question_id: h.q.id, question_notification: true, question_route_revision: 3 });
    }
    expect(human.history.at(-1)).toMatchObject({ type: 'transfer', handler: null, source_message_id: reminders[0]!.id, source_session_id: sourceMain });
    expect(h.store.answerQuestion(h.q.id, { expected_route_revision: 3, response: { answer: 'A' } }, { type: 'member', id: other.id }).question.answer?.actor.id).toBe(other.id);
  });
  it('upgrades a stored designated-human route on read and re-routes it once before the first mutation', () => {
    const h = setup(fixture());
    h.toHuman();
    const stored = structuredClone(h.store.getMessage(h.q.id)!.metadata) as Record<string, any>;
    // A record written before this change names the root human and hashes it into its revision.
    stored.question.route = stored.question.route.map((step: any) => step.stage === 'human' ? { ...step, handler: { type: 'member', id: 'mem_local_local' } } : step);
    stored.question.responsibility_revision = 'designated-human-revision';
    stored.question.route_reason = `${h.parent.id}:human_unavailable`;
    h.db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?', [JSON.stringify(stored), h.q.id]);
    const before = h.store.getMessage(h.q.id)!;
    const reader = h.member('Legacy reader');
    expect(h.store.getQuestion(h.q.id, { type: 'member', id: reader.id })).toMatchObject({ stage: 'human', current_handler: null, route_reason: null, route_revision: 3,
      actions: { allowed: ['answer', 'close'] } });
    // A read never writes the upgrade.
    expect(h.store.getMessage(h.q.id)!.revision).toBe(before.revision);
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 3, response: { answer: 'A' } }, { type: 'member', id: reader.id })).toThrow('question_route_changed');
    const rerouted = h.store.getQuestion(h.q.id, { type: 'member', id: reader.id })!;
    expect(rerouted).toMatchObject({ stage: 'human', current_handler: null, route_revision: 4, status: 'pending' });
    expect(rerouted.history.at(-2)).toMatchObject({ type: 'transfer', actor: null, reason: 'responsibility_revision_stale' });
    expect((h.store.getMessage(h.q.id)!.metadata.question as any)).toMatchObject({ human_required: true, route: [{}, {}, { handler: null, stage: 'human' }] });
    expect(h.store.answerQuestion(h.q.id, { expected_route_revision: 4, response: { answer: 'A' } }, { type: 'member', id: reader.id }).question.status).toBe('answered');
  });
  it('upgrades a stored designated-human route still at an Agent step without pinning it to the human stage', () => {
    const h = setup(fixture());
    const stored = structuredClone(h.store.getMessage(h.q.id)!.metadata) as Record<string, any>;
    stored.question.route = stored.question.route.map((step: any) => step.stage === 'human' ? { ...step, handler: { type: 'member', id: 'mem_local_local' } } : step);
    stored.question.responsibility_revision = 'designated-human-revision';
    h.db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?', [JSON.stringify(stored), h.q.id]);
    expect(h.store.getQuestion(h.q.id)).toMatchObject({ stage: 'issue_owner', current_handler: { type: 'agent', id: h.leader.id } });
    h.db.run('UPDATE multiremi_issues SET assignee_type=NULL,assignee_id=NULL WHERE id=?', [h.issue.id]);
    expect(h.refresh(h.issue.id)).toMatchObject({ stage: 'human', current_handler: null, route_reason: `${h.issue.id}:execution_owner_missing` });
    expect((h.store.getMessage(h.q.id)!.metadata.question as any).human_required).toBe(false);
    // Configuring an owner returns it to the Agent, exactly like a Q written after the change.
    const next = h.store.createAgent({ name: 'Configured child owner', provider: 'codex' });
    h.store.updateIssue(h.issue.id, { assigneeType: 'agent', assigneeId: next.id, actorType: 'member', actorId: 'mem_local_local' });
    expect(h.store.getQuestion(h.q.id)).toMatchObject({ stage: 'issue_owner', current_handler: { type: 'agent', id: next.id }, route_reason: null });
  });
  it('upgrades a frozen Q of a root without a designated human to the human stage', () => {
    const h = setup(fixture());
    h.toHuman();
    const stored = structuredClone(h.store.getMessage(h.q.id)!.metadata) as Record<string, any>;
    stored.question.route = stored.question.route.filter((step: any) => step.stage !== 'human');
    stored.question.route_index = stored.question.route.length;
    stored.question.route_reason = `${h.parent.id}:human_missing`;
    h.db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?', [JSON.stringify(stored), h.q.id]);
    expect(h.store.getQuestion(h.q.id, { type: 'member', id: 'mem_local_local' })).toMatchObject({ stage: 'human', current_handler: null, route_reason: null,
      actions: { allowed: ['answer', 'close'] } });
    expect(h.store.answerQuestion(h.q.id, { expected_route_revision: 3, response: { answer: 'A' } }, { type: 'member', id: 'mem_local_local' }).question.status).toBe('answered');
  });
  it('skips the same agent across adjacent responsibility levels and never asks the source agent', () => {
    const h = setup(fixture(), true);
    const q = h.store.escalateQuestion(h.q.id, { expected_route_revision: 1, reason: 'Human needed' }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id));
    expect(q.stage).toBe('human');
    expect(q.history.filter(e => e.handler?.id === h.leader.id)).toHaveLength(1);
  });
  it('timeout detaches the provider wait while the Q persists; answer schedules one new consumer and acknowledgement settles it', () => {
    const h = setup(fixture());
    h.bridge.rpc('turn.decision.expire', { turn_id: h.turn.id, attempt_id: h.task.id, message_id: h.q.id, status: 'timeout' }, h.scope);
    expect(h.store.getQuestion(h.q.id)).toMatchObject({ status: 'pending', wait_status: 'detached', wait_reason: 'timeout' });
    const actor = { type: 'agent' as const, id: h.leader.id };
    const answer = h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, actor, h.agentTurn(h.leader.id));
    expect(answer.question.wait_status).toBe('continuation_pending');
    expect(answer.message.to_agent_id).toBeNull();
    const record = (h.store.getMessage(h.q.id)!.metadata.question as any);
    expect(record.wait.consumer_turn_id).not.toBe(h.turn.id);
    const ctx = new StoreContext(h.db, () => h.store), events = createCommitEventQueue();
    const consumer = h.store.getTurn(record.wait.consumer_turn_id)!;
    h.db.transaction(() => new Questions(ctx).consumeWithinTransaction(h.q.id, consumer.id, consumer.current_attempt_id!, record.wait.continuation_message_id, events))();
    expect(h.store.getQuestion(h.q.id)?.wait_status).toBe('continuation_consumed');
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'B' } }, actor, h.agentTurn(h.leader.id))).toThrow('question_already_settled');
    expect(h.db.query("SELECT id FROM multiremi_conversation_log WHERE dedupe_key=?").all(`question-continuation:${h.q.id}`)).toHaveLength(1);
  });
  it('source attempt replacement after restart preserves Q and cannot pretend its original callback resumed', () => {
    const h = setup(fixture());
    h.store.recoverOrphans(h.runtime.id);
    const reopened = new MultiremiStore(h.db);
    expect(reopened.getQuestion(h.q.id)).toMatchObject({ status: 'pending', wait_status: 'detached', wait_reason: 'provider_exit' });
    const reply = reopened.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id));
    expect(reply.question.wait_status).toBe('continuation_pending');
    expect(reply.message.to_agent_id).toBeNull();
  });
  it('a responsibility re-route invalidates old tokens and route revisions without rewriting frozen recipients', () => {
    const h = setup(fixture());
    const token = h.store.issueMessageCardToken(h.q.id, 'ou_previous');
    const oldRecipient = h.store.getMessage(h.q.id)!.to_agent_id;
    h.db.run('UPDATE multiremi_issues SET assignee_id=? WHERE id=?', [h.parentLeader.id, h.issue.id]);
    const ctx = new StoreContext(h.db, () => h.store), events = createCommitEventQueue();
    h.db.transaction(() => refreshIssueQuestionsAfterResponsibilityChangeWithinTransaction(ctx, h.issue.id, events, { type: 'member', id: 'mem_local_local' }))();
    expect(h.store.getQuestion(h.q.id)).toMatchObject({ current_handler: { id: h.parentLeader.id }, route_revision: 2 });
    expect(h.store.getMessage(h.q.id)!.card_token_hash).toBeNull(); expect(token).toBeTruthy();
    expect(h.store.getMessage(h.q.id)!.to_agent_id).toBe(oldRecipient);
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id))).toThrow('question_route_changed');
  });
  it('rejects member and agent impostors, inactive turns, and cross workspace actors', () => {
    const h = setup(fixture());
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'member', id: 'mem_local_local' })).toThrow('question_handler_required');
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: h.leader.id })).toThrow('question_agent_current_turn_required');
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'member', id: 'mem_other_workspace' })).toThrow('question_actor_workspace_mismatch');
  });
}, { isolation: "snapshot" });

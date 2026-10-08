import { expect, it } from 'bun:test';
import { pendingTurnBackendTests, type PendingTurnTestFixture } from './pending-turn-test-backends.js';
import { StoreContext, createCommitEventQueue } from '@multiremi/store/context.js';
import { Questions, refreshIssueQuestionsAfterResponsibilityChangeWithinTransaction } from '@multiremi/store/inbox/questions.js';
import { MultiremiStore } from '@multiremi/store.js';

function setup(f: PendingTurnTestFixture, sameOwner = false) {
  const { store, db } = f;
  const runtime = store.registerRuntime({ name: 'questions host', provider: 'codex', daemonId: 'questions-daemon', maxConcurrency: 8 });
  const leader = store.createAgent({ name: 'Issue leader', provider: 'codex', maxConcurrentTasks: 8 });
  const parentLeader = sameOwner ? leader : store.createAgent({ name: 'Parent leader', provider: 'codex', maxConcurrentTasks: 8 });
  const worker = store.createAgent({ name: 'Worker', provider: 'codex', maxConcurrentTasks: 8 });
  const parent = store.createIssue({ title: 'Root', assigneeType: 'agent', assigneeId: parentLeader.id });
  db.run('UPDATE multiremi_issues SET responsible_member_id=? WHERE id=?', ['mem_local_local', parent.id]);
  const issue = store.createIssue({ title: 'Child', parentIssueId: parent.id, assigneeType: 'agent', assigneeId: leader.id });
  const task = store.createTask({ agentId: worker.id, issueId: issue.id, prompt: 'Original task' });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
  const turn = store.getTurnForAttempt(task.id)!;
  const bridge = store.getDaemonTurnBridge();
  const scope = { runtimeId: runtime.id, daemonId: 'questions-daemon', workspaceId: 'local' };
  const result = bridge.rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id, dedupe_key: `question:${task.id}`,
    body_md: 'Which approach?', options: [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }],
    metadata: { kind: 'question', questions: [{ fieldKey: 'approach', question: { question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] } }] }, timeout_ms: 50 }, scope);
  expect(result.ok).toBeTrue();
  const q = store.getQuestion(String(result.message_id))!;
  const agentTurn = (id: string) => {
    let t = db.query("SELECT * FROM multiremi_turns WHERE agent_id=? AND status IN ('pending','running','awaiting_human') ORDER BY created_at DESC LIMIT 1").get(id);
    if (!t) throw new Error('No notification turn');
    db.run("UPDATE multiremi_turns SET status='running' WHERE id=?", [t.id]);
    return t.id as string;
  };
  return { ...f, runtime, leader, parentLeader, worker, parent, issue, task, turn, bridge, scope, q, agentTurn };
}

pendingTurnBackendTests('one question through the responsibility chain', fixture => {
  it('worker routes from the Issue, retains original Q and writes the owner answer to its source session', () => {
    const h = setup(fixture());
    expect(h.q).toMatchObject({ current_handler: { type: 'agent', id: h.leader.id }, stage: 'issue_owner', status: 'pending', wait_status: 'waiting' });
    const actor = { type: 'agent' as const, id: h.leader.id };
    const answered = h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answers: { approach: 'A' } } }, actor, h.agentTurn(h.leader.id));
    expect(answered.message.session_id).toBe(h.q.session_id);
    expect(answered.message.reply_to_id).toBe(h.q.id);
    expect(h.store.getQuestion(h.q.id)).toMatchObject({ status: 'answered', wait_status: 'waiting', answer: { response: { answers: { 'Which approach?': 'A' } } } });
    expect(h.bridge.rpc('turn.decision.consume', { turn_id: h.turn.id, attempt_id: h.task.id, message_id: h.q.id, reply_message_id: answered.message.id }, h.scope)).toEqual({ ok: true });
    expect(h.store.getQuestion(h.q.id)?.wait_status).toBe('consumed');
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'B' } }, actor, h.agentTurn(h.leader.id))).toThrow('question_already_settled');
  });
  it('escalates the same Q through parent to explicit human, retaining options and refusing stale handlers', () => {
    const h = setup(fixture());
    const first = h.store.escalateQuestion(h.q.id, { expected_route_revision: 1, reason: 'Need parent decision' }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id));
    expect(first).toMatchObject({ id: h.q.id, current_handler: { id: h.parentLeader.id }, route_revision: 2, stage: 'parent_owner' });
    expect(() => h.store.answerQuestion(h.q.id, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'agent', id: h.leader.id }, h.agentTurn(h.leader.id))).toThrow('question_route_changed');
    const human = h.store.escalateQuestion(h.q.id, { expected_route_revision: 2, reason: 'Need human' }, { type: 'agent', id: h.parentLeader.id }, h.agentTurn(h.parentLeader.id));
    expect(human).toMatchObject({ id: h.q.id, current_handler: { type: 'member', id: 'mem_local_local' }, route_revision: 3, stage: 'human' });
    expect(human.options).toEqual(h.q.options); expect(human.original_questions).toEqual(h.q.original_questions);
    const notifications = h.db.query("SELECT session_id,reply_to_id,metadata FROM multiremi_conversation_log WHERE message_kind='request'").all().filter(m => JSON.parse(m.metadata ?? '{}').root_question_id === h.q.id);
    expect(notifications.some(m => m.session_id !== h.q.session_id)).toBeTrue();
    expect(notifications.every(m => m.reply_to_id === null)).toBeTrue();
    expect(Number(h.db.query("SELECT COUNT(*) AS n FROM multiremi_conversation_log WHERE message_kind='decision'").get().n)).toBe(1);
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
  it('explicit transfer invalidates old tokens and route revisions without rewriting frozen recipients', () => {
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
});

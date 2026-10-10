import { expect, it } from 'bun:test';
import { pendingTurnBackendTests, type PendingTurnTestFixture } from './pending-turn-test-backends.js';

function nativeQuestion(f: PendingTurnTestFixture, nested = false, privateSource = false) {
  const { store, db } = f;
  const runtime = store.registerRuntime({ name: 'Native user host', provider: 'codex', daemonId: 'native-user', maxConcurrency: 16 });
  const leader = store.createAgent({ name: 'Leader', provider: 'codex', runtimeId: runtime.id, visibility: 'workspace' });
  const parentLeader = store.createAgent({ name: 'Parent leader', provider: 'codex', runtimeId: runtime.id, visibility: 'workspace' });
  const worker = store.createAgent({ name: 'Worker', provider: 'codex', runtimeId: runtime.id,
    visibility: privateSource ? 'private' : 'workspace', ownerId: 'local' });
  const root = store.createIssue({ title: 'Root without human configuration', assigneeType: 'agent', assigneeId: parentLeader.id });
  const issue = nested ? store.createIssue({ title: 'Child', parentIssueId: root.id, assigneeType: 'agent', assigneeId: leader.id }) : root;
  const agent = nested || privateSource ? worker : parentLeader;
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: 'Ask a native question' });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  store.startTask(task.id);
  const turn = store.getTurnForAttempt(task.id)!;
  const bridge = store.getDaemonTurnBridge();
  const scope = { runtimeId: runtime.id, daemonId: 'native-user', workspaceId: 'local' };
  const result = bridge.rpc('turn.decision', {
    turn_id: turn.id, attempt_id: task.id, wait_id: `native:${task.id}`, dedupe_key: `native:${task.id}`,
    body_md: 'Which approach?', options: [{ label: 'A', value: 'A' }],
    metadata: { kind: privateSource ? 'permission' : 'question', questions: [{ question: 'Which approach?', options: [{ label: 'A' }] }] },
  }, scope);
  expect(result.ok).toBe(true);
  const id = String(result.message_id);
  const handlerTurn = (agentId: string) => {
    const row = db.query("SELECT id FROM multiremi_turns WHERE agent_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(agentId)!;
    db.run("UPDATE multiremi_turns SET status='running' WHERE id=?", [row.id]);
    return String(row.id);
  };
  return { ...f, root, issue, leader, parentLeader, worker, task, turn, bridge, scope, id, handlerTurn };
}

pendingTurnBackendTests('Native user questions without designated humans', fixture => {
  it('creates ordinary and automation-style roots without assigning a human', () => {
    const { store } = fixture();
    for (const createdBy of [undefined, 'local']) {
      const issue = store.createIssue({ title: 'No human selector', createdBy });
      expect(issue.responsibleMemberId).toBeNull();
      expect(store.resolveIssueResponsibility(issue.id).unresolved.some(item => item.reason.startsWith('human_'))).toBe(false);
    }
    const agent = store.createAgent({ name: 'Automation leader', provider: 'codex' });
    for (const responsibleMemberId of [undefined, 'mem_local_local']) {
      const automation = store.createAutopilot({ title: 'Native root creation', assigneeId: agent.id, responsibleMemberId });
      const run = store.runAutopilot(automation.id, { source: 'api' });
      expect(run.issueId).toBeTruthy();
      expect(store.getIssue(run.issueId!)?.responsibleMemberId).toBeNull();
    }
  });

  it('lets a Leader ask and receive a real native answer without configuring a person', () => {
    const h = nativeQuestion(fixture());
    const actor = { type: 'member' as const, id: 'mem_local_local' };
    const question = h.store.getQuestion(h.id, actor)!;
    expect(question).toMatchObject({ stage: 'human', current_handler: null, route_reason: null, wait_status: 'waiting' });
    expect(question.actions.allowed).toContain('answer');
    const answered = h.store.answerQuestion(h.id, { expected_route_revision: question.route_revision,
      response: { answers: { 'Which approach?': 'A' } } }, actor).question;
    expect(answered.status).toBe('answered');
    expect(h.store.getMessage(answered.answer!.reply_message_id)?.reply_to_id).toBe(h.id);
    expect(h.store.getMessage(answered.answer!.reply_message_id)?.session_id).toBe(question.session_id);
    const consumed = h.bridge.rpc('turn.decision.consume', { turn_id: h.turn.id, attempt_id: h.task.id,
      message_id: h.id, wait_id: `native:${h.task.id}`, reply_message_id: answered.answer!.reply_message_id }, h.scope);
    expect(consumed.ok).toBe(true);
    expect(h.store.getQuestion(h.id)?.wait_status).toBe('consumed');
  });

  it('preserves Worker → Leader → parent Leader → native user escalation', () => {
    const h = nativeQuestion(fixture(), true);
    let q = h.store.getQuestion(h.id)!;
    expect(q.current_handler?.id).toBe(h.leader.id);
    const notification = h.store.listMessages(h.store.getOrCreateDefaultIssueSession(h.issue.id).id)
      .find(message => message.metadata.question_notification && message.metadata.root_question_id === h.id)!;
    const handlerTurnId = h.handlerTurn(h.leader.id);
    const handlerAttempt = h.store.getTurn(handlerTurnId)!.current_attempt_id!;
    expect(h.store.canReadQuestionNotification(notification.id, { userId: null, admin: false, attemptId: handlerAttempt })).toBe(true);
    q = h.store.escalateQuestion(h.id, { expected_route_revision: q.route_revision, reason: 'Parent decision needed' },
      { type: 'agent', id: h.leader.id }, handlerTurnId);
    expect(q.current_handler?.id).toBe(h.parentLeader.id);
    q = h.store.escalateQuestion(h.id, { expected_route_revision: q.route_revision, reason: 'Ask the user' },
      { type: 'agent', id: h.parentLeader.id }, h.handlerTurn(h.parentLeader.id));
    expect(q).toMatchObject({ id: h.id, stage: 'human', current_handler: null });
    expect(h.store.getQuestion(h.id, { type: 'member', id: 'mem_local_local' })?.actions.allowed).toContain('answer');
  });

  it('does not appoint another member behind the native user entry', () => {
    const h = nativeQuestion(fixture());
    const member = h.store.createWorkspaceMember({ id: 'native-peer', name: 'Peer', userId: 'peer-user', role: 'member' });
    const q = h.store.getQuestion(h.id, { type: 'member', id: member.id })!;
    expect(q.current_handler).toBeNull();
    expect(q.actions.allowed).toContain('answer');
    expect(h.store.getIssue(h.root.id)?.responsibleMemberId).toBeNull();
  });

  it('keeps private source and workspace boundaries on native user answers', () => {
    const h = nativeQuestion(fixture(), false, true);
    const peer = h.store.createWorkspaceMember({ id: 'private-peer', name: 'Peer', userId: 'peer-user', role: 'member' });
    const q = h.store.getQuestion(h.id, { type: 'member', id: peer.id })!;
    expect(q.actions.allowed).not.toContain('answer');
    expect(() => h.store.answerQuestion(h.id, { expected_route_revision: q.route_revision, response: {} },
      { type: 'member', id: peer.id })).toThrow('question_handler_required');
    const foreign = h.store.createWorkspace({ id: 'native-foreign', name: 'Other', slug: 'native-foreign' });
    const outsider = h.store.createWorkspaceMember({ id: 'outsider', name: 'Outsider', workspaceId: foreign.id });
    expect(() => h.store.answerQuestion(h.id, { expected_route_revision: q.route_revision, response: {} },
      { type: 'member', id: outsider.id })).toThrow('question_actor_workspace_mismatch');
  });

  it('recovers a pre-hotfix Q blocked by human_missing without replacing its wait or history', () => {
    const h = nativeQuestion(fixture());
    const message = h.store.getMessage(h.id)!;
    const record = { ...(message.metadata.question as Record<string, unknown>), native_user_entry: undefined, route: [],
      route_reason: `${h.root.id}:human_missing`, responsibility_revision: 'old-designated-human-policy' };
    h.db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?', [JSON.stringify({ ...message.metadata, question: record }), h.id]);
    const rawBefore = h.db.query('SELECT metadata FROM multiremi_conversation_log WHERE id=?').get(h.id)!.metadata;
    const q = h.store.getQuestion(h.id, { type: 'member', id: 'mem_local_local' })!;
    expect(q).toMatchObject({ id: h.id, stage: 'human', current_handler: null, route_reason: null, wait_status: 'waiting' });
    expect(h.db.query('SELECT metadata FROM multiremi_conversation_log WHERE id=?').get(h.id)!.metadata).toBe(rawBefore);
    expect(h.store.answerQuestion(h.id, { expected_route_revision: q.route_revision, response: { answers: { 'Which approach?': 'A' } } },
      { type: 'member', id: 'mem_local_local' }).question.status).toBe('answered');
    expect(h.store.getIssue(h.root.id)?.responsibleMemberId).toBeNull();
  });

  it('allows ordinary single and batch completion without mandatory human acceptance', () => {
    const { store } = fixture();
    const first = store.createIssue({ title: 'Ordinary completion' });
    const second = store.createIssue({ title: 'Batch completion' });
    expect(store.updateIssue(first.id, { status: 'done', actorType: 'member', actorId: 'mem_local_local' })?.status).toBe('done');
    store.batchUpdateIssues({ issueIds: [second.id], updates: { status: 'done', actorType: 'member', actorId: 'mem_local_local' } });
    expect(store.getIssue(second.id)?.status).toBe('done');
  });
});

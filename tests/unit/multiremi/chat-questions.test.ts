import { expect, it } from 'bun:test';
import { pendingTurnBackendTests, type PendingTurnTestFixture } from './pending-turn-test-backends.js';
import { StoreContext, createCommitEventQueue } from '@multiremi/store/context.js';
import { refreshChatQuestionsAfterResponsibilityChangeWithinTransaction } from '@multiremi/store/inbox/questions.js';

function setup(f: PendingTurnTestFixture, transport = false, native = true, creatorId = 'local') {
  const { store, db } = f;
  const runtime = store.registerRuntime({ name: 'Chat Q host', provider: 'codex', daemonId: 'chat-q-daemon', maxConcurrency: 8 });
  const agent = store.createAgent({ name: 'Chat source', provider: 'codex' });
  const chat = store.createChatSession({ agentId: agent.id, creatorId, title: 'Original Chat' });
  if (transport) {
    const at = new Date().toISOString();
    db.run('INSERT INTO multiremi_feishu_bot_chat_bindings(id,workspace_id,app_id,agent_id,external_session_key,chat_session_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      ['fbb_chat_q', 'local', 'cli_chat_q', agent.id, 'transport_chat_q', chat.id, at, at]);
  }
  const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: 'Original Chat work' });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
  const turn = store.getTurnForAttempt(task.id)!;
  let questionId: string;
  if (native) {
    const response = store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id, wait_id: `chat_wait_${task.id}`, dedupe_key: `chat_question_${task.id}`, options: [{ label: 'A', value: 'A' }],
      body_md: 'Choose Chat direction', metadata: { kind: 'question', questions: [{ fieldKey: 'direction', question: { question: 'Choose Chat direction', options: [{ label: 'A' }] } }] } },
      { runtimeId: runtime.id, daemonId: 'chat-q-daemon', workspaceId: 'local' });
    expect(response).toMatchObject({ ok: true }); questionId = String(response.message_id);
  } else questionId = store.createTaskHumanRequest({ taskId: task.id, kind: 'question', payload: { questions: [{ fieldKey: 'direction', question: { question: 'Choose Chat direction', options: [{ label: 'A' }] } }] } }).id;
  const ctx = new StoreContext(db, () => store);
  const refresh = (filter: { transportOnly?: boolean; memberId?: string; agentId?: string } = {}) => refreshChatQuestionsAfterResponsibilityChangeWithinTransaction(ctx, 'local', createCommitEventQueue(), undefined, 'chat_responsibility_transferred', filter);
  return { ...f, ctx, runtime, agent, chat, task, turn, questionId, refresh };
}

pendingTurnBackendTests('Chat question explicit responsibility', fixture => {
  it('an unresolved creator identity cannot become a same-name member through fuzzy lookup', () => {
    const f = fixture();
    const user = f.store.getOrCreateUser({ externalId: 'chat_q_name_impostor', name: 'Ambiguous Chat creator' });
    f.store.createWorkspaceMember({ workspaceId: 'local', userId: user.id, name: 'Ambiguous Chat creator', role: 'member' });
    const h = setup(f, false, true, 'Ambiguous Chat creator');
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: null, route_reason: 'explicit_human_responsibility_required' });
    const before = h.store.getMessage(h.questionId)!.revision;
    h.store.getQuestion(h.questionId);
    expect(h.store.getMessage(h.questionId)!.revision).toBe(before);
  });
  it('ordinary Chat uses its explicit creator and source Agent/member changes migrate the same Q', () => {
    const h = setup(fixture());
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: { type: 'member', id: 'mem_local_local' }, wait_status: 'waiting', route_revision: 1 });
    h.db.transaction(() => { h.store.archiveAgent(h.agent.id); h.refresh({ agentId: h.agent.id }); })();
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: { id: 'mem_local_local' }, route_revision: 2 });
    const ownerUser = h.store.getOrCreateUser({ externalId: 'chat_q_other_owner', name: 'Other workspace owner' });
    h.store.createWorkspaceMember({ workspaceId: 'local', userId: ownerUser.id, name: 'Other workspace owner', role: 'owner' });
    h.db.transaction(() => { h.store.archiveWorkspaceMember('mem_local_local'); h.refresh({ memberId: 'mem_local_local' }); })();
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: null, stage: 'unavailable', route_reason: 'explicit_human_responsibility_required', route_revision: 3 });
    expect(h.store.getQuestion(h.questionId)?.history.filter(e => e.reason === 'chat_responsibility_transferred')).toHaveLength(2);
  });
  it('transport creator is never human authority, config changes rotate old cards atomically, and no-op config facts do not transfer', () => {
    const h = setup(fixture(), true);
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: null, route_reason: 'explicit_human_responsibility_required' });
    expect(() => h.store.answerQuestion(h.questionId, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'member', id: 'mem_local_local' })).toThrow('question_handler_required');
    const user = h.store.getOrCreateUser({ externalId: 'chat_q_designated', name: 'Designated Chat human' });
    const human = h.store.createWorkspaceMember({ workspaceId: 'local', userId: user.id, name: 'Designated Chat human', role: 'member' });
    const prior = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
    const set = (memberId: string | null) => {
      h.ctx.lockWorkspaceRuntimeLifecycle('local');
      return h.store.upsertFeishuBotConfig('local', { agentId: h.agent.id, runtimeId: h.runtime.id, appId: 'cli_chat_q',
        appSecretOp: 'set', appSecret: 'synthetic-chat-question', domain: 'feishu', enabled: false, responsibleMemberId: memberId });
    };
    try {
      h.db.transaction(() => { set(human.id); h.refresh({ transportOnly: true }); })();
      expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: { id: human.id }, route_revision: 2 });
      const token = h.store.issueMessageCardToken(h.questionId, 'ou_chat_designated'); expect(token).toBeTruthy();
      const cardHash = h.store.getMessage(h.questionId)!.card_token_hash;
      expect(() => h.db.transaction(() => { set('mem_local_local'); h.refresh({ transportOnly: true }); throw new Error('Rollback config and Q'); })()).toThrow('Rollback config and Q');
      expect(h.store.getFeishuBotConfig('local')?.responsibleMemberId).toBe(human.id);
      expect(h.store.getQuestion(h.questionId)?.route_revision).toBe(2); expect(h.store.getMessage(h.questionId)!.card_token_hash).toBe(cardHash);
      h.db.transaction(() => { set(human.id); h.refresh({ transportOnly: true }); })();
      expect(h.store.getQuestion(h.questionId)?.route_revision).toBe(2);
      h.db.transaction(() => { set('mem_local_local'); h.refresh({ transportOnly: true }); })();
      expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: { id: 'mem_local_local' }, route_revision: 3 });
      expect(h.store.getMessage(h.questionId)!.card_token_hash).toBeNull();
      expect(() => h.store.answerQuestion(h.questionId, { expected_route_revision: 2, response: { answer: 'A' } }, { type: 'member', id: human.id })).toThrow('question_route_changed');
      expect(() => h.store.answerQuestion(h.questionId, { expected_route_revision: 3, response: { answer: 'A' } }, { type: 'member', id: human.id })).toThrow('question_handler_required');
    } finally { if (prior === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = prior; }
  });
  it('a Chat Q stays in its Chat: no Remi summary, no Remi Chat, answerable there, while an Issue Q still asks Remi', async () => {
    const f = fixture();
    const prior = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64');
    try {
      const remiHost = f.store.registerRuntime({ name: 'Remi host', provider: 'codex', daemonId: 'chat-q-remi', maxConcurrency: 8 });
      const remi = f.store.createAgent({ name: 'Remi', provider: 'codex', runtimeId: remiHost.id });
      f.store.upsertFeishuBotConfig('local', { agentId: remi.id, runtimeId: remiHost.id, appId: 'cli_chat_q_remi',
        appSecretOp: 'set', appSecret: 'synthetic-chat-question', domain: 'feishu', enabled: false });
      const remiChats = () => f.db.query('SELECT id FROM multiremi_chat_sessions WHERE agent_id=?').all(remi.id);
      const remiTurns = () => f.db.query('SELECT id FROM multiremi_turns WHERE agent_id=?').all(remi.id);
      const presentRequests = (id: string) => f.db.query(`SELECT id,session_id FROM multiremi_conversation_log WHERE kind='message' AND metadata LIKE ? AND metadata LIKE '%question_present_request%'`).all(`%${id}%`);

      const h = setup(f);
      expect(h.store.getQuestion(h.questionId)).toMatchObject({ session_id: h.chat.id, stage: 'human',
        current_handler: { type: 'member', id: 'mem_local_local' }, summary: null, wait_status: 'waiting' });
      expect((h.store.getMessage(h.questionId)!.metadata.question as { summary_wait_until?: string | null }).summary_wait_until).toBeNull();
      expect(h.store.getTaskHumanRequest(h.questionId)!.payload.question_summary_wait_until).toBeNull();
      expect(remiChats()).toEqual([]);
      expect(remiTurns()).toEqual([]);
      expect(presentRequests(h.questionId)).toEqual([]);

      // The Chat's creator reads and answers the same Q from the original Chat.
      const { createMultiremiApp } = await import('@multiremi/api.js');
      const pat = await h.store.createAccessToken({ type: 'pat', name: 'Chat creator', userId: 'local', workspaceId: 'local' });
      const app = createMultiremiApp({ store: h.store, authToken: 'chat-q-master' });
      const headers = { Authorization: `Bearer ${pat.token}`, 'Content-Type': 'application/json' };
      const log = await (await app.request(`/api/sessions/${h.chat.id}/log?before=30`, { headers })).json() as { entries: Array<{ id: string }> };
      expect(log.entries.map(entry => entry.id)).toContain(h.questionId);
      const view = await (await app.request(`/api/messages/${h.questionId}/question`, { headers })).json() as { question: { actions: { allowed: string[] } } };
      expect(view.question.actions.allowed).toContain('answer');
      const answered = await app.request(`/api/messages/${h.questionId}/question/answer`, { method: 'POST', headers,
        body: JSON.stringify({ expected_route_revision: 1, response: { answers: { 'Choose Chat direction': 'A' } } }) });
      expect(answered.status, await answered.clone().text()).toBe(200);
      expect(h.store.getQuestion(h.questionId)).toMatchObject({ status: 'answered', answer: { actor: { type: 'member', id: 'mem_local_local' } } });
      expect((await answered.json() as { message: { session_id: string } }).message.session_id).toBe(h.chat.id);
      expect(h.store.getTurn(h.turn.id)?.status).toBe('running');
      expect(remiChats()).toEqual([]);
      expect(remiTurns()).toEqual([]);

      // An Issue Q at the human stage keeps Remi's summary step in its Issue.
      const issue = f.createIssue({ title: 'No execution owner' });
      const issueTask = h.store.createTask({ agentId: h.agent.id, issueId: issue.id, prompt: 'Issue work' });
      expect(h.store.claimTask(h.runtime.id)?.id).toBe(issueTask.id); h.store.startTask(issueTask.id);
      const issueTurn = h.store.getTurnForAttempt(issueTask.id)!;
      const created = h.store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: issueTurn.id, attempt_id: issueTask.id, wait_id: `issue_wait_${issueTask.id}`,
        dedupe_key: `issue_question_${issueTask.id}`, options: [{ label: 'A', value: 'A' }], body_md: 'Choose Issue direction',
        metadata: { kind: 'question', questions: [{ fieldKey: 'direction', question: { question: 'Choose Issue direction', options: [{ label: 'A' }] } }] } },
        { runtimeId: h.runtime.id, daemonId: 'chat-q-daemon', workspaceId: 'local' });
      expect(created).toMatchObject({ ok: true });
      const issueQ = String(created.message_id);
      expect(h.store.getQuestion(issueQ)).toMatchObject({ stage: 'human', current_handler: null });
      expect(Date.parse(String(h.store.getTaskHumanRequest(issueQ)!.payload.question_summary_wait_until))).toBeGreaterThan(Date.now());
      expect(presentRequests(issueQ).map(row => row.session_id)).toEqual([h.store.getOrCreateDefaultIssueSession(issue.id).id]);
      expect(remiChats()).toEqual([]);
    } finally { if (prior === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = prior; }
  });
  it('compatibility creation without a native wait nonce cannot treat running DB status as a live callback', () => {
    const h = setup(fixture(), false, false);
    expect(h.store.getTask(h.task.id)?.status).toBe('awaiting_human');
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ wait_status: 'detached', wait_reason: 'native_wait_unverified' });
    const answer = h.store.answerQuestion(h.questionId, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'member', id: 'mem_local_local' });
    expect(answer.question).toMatchObject({ status: 'answered', wait_status: 'continuation_pending' });
    expect(answer.message.to_agent_id).toBeNull();
    expect(h.store.getTask(h.task.id)?.status).toBe('cancelled');
    const consumer = h.store.getTurn(answer.question.recovery.consumer_turn_id!)!;
    expect(consumer).toMatchObject({ session_id: h.chat.id, agent_id: h.agent.id });
    expect(h.store.getTask(consumer.current_attempt_id!)?.continuedFromTaskId).toBe(h.task.id);
  });
});

import { expect, it } from 'bun:test';
import { pendingTurnBackendTests, type PendingTurnTestFixture } from './pending-turn-test-backends.js';
import { StoreContext, createCommitEventQueue } from '@multiremi/store/context.js';
import { refreshChatQuestionsAfterResponsibilityChangeWithinTransaction } from '@multiremi/store/inbox/questions.js';

function setup(f: PendingTurnTestFixture, transport = false, native = true) {
  const { store, db } = f;
  const runtime = store.registerRuntime({ name: 'Chat Q host', provider: 'codex', daemonId: 'chat-q-daemon', maxConcurrency: 8 });
  const agent = store.createAgent({ name: 'Chat source', provider: 'codex' });
  const chat = store.createChatSession({ agentId: agent.id, creatorId: 'local', title: 'Original Chat' });
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

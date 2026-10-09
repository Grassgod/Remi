import { afterEach, expect, it } from 'bun:test';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { resetMultiremiTestEnv } from './helpers.js';
import { ISSUE_DECISION_CARD_REMINDER_DELAY_MS } from '@multiremi/store/repos/feishu-bot-repo.js';
import { decodeDecisionCardBody, questionCardAction } from '@shared/feishu-task-card.js';

afterEach(resetMultiremiTestEnv);
pendingTurnBackendTests('persistent native Q reminders', fixture => {
  function setup() {
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
    const { store, db } = fixture();
    const person = store.getOrCreateUser({ externalId: 'ou_reminder_human', name: 'Explicit human', feishuUnionId: 'on_reminder_human' });
    db.run('UPDATE multiremi_workspace_members SET user_id=? WHERE id=?', [person.id, 'mem_local_local']);
    const at = new Date().toISOString();
    db.run(`INSERT INTO multiremi_feishu_bot_senders(id,workspace_id,app_id,open_id,union_id,display_name,allowed,first_seen_at,last_seen_at)
      VALUES('fbs_reminder_human','local','cli_reminder','ou_reminder_human','on_reminder_human','Human',1,?,?)`, [at, at]);
    const runtime = store.registerRuntime({ name: 'Reminder host', provider: 'codex', daemonId: 'dmn_reminder_host' });
    const agent = store.createAgent({ name: 'Self-asking Remi', provider: 'codex', runtimeId: runtime.id });
    store.heartbeatRuntime(runtime.id, { supportsFeishuBotConfig: true, supportsDecisionCard: true });
    const config = store.upsertFeishuBotConfig('local', { agentId: agent.id, runtimeId: runtime.id, appId: 'cli_reminder',
      appSecretOp: 'set', appSecret: 'synthetic-reminder-secret', domain: 'feishu', enabled: true, responsibleMemberId: 'mem_local_local' });
    store.reportFeishuBotRuntimeStatus('local', runtime.id, { appliedRevision: config.revision, state: 'online' });
    store.updateWorkspace('local', { settings: { issueTopics: { enabled: true, chatId: 'oc_reminder' } } });
    const issue = store.createIssue({ title: 'Persistent question', assigneeType: 'agent', assigneeId: agent.id, responsibleMemberId: 'mem_local_local' });
    store.prepareFeishuIssueTopicWithinTransaction(issue);
    const root = store.claimFeishuBotOutbound('local', runtime.id)!;
    store.reportFeishuBotOutbound('local', runtime.id, root.id, { claimToken: root.claimToken, status: 'sent', externalMessageId: 'om_reminder_root' });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: 'Ask once' });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
    const turn = store.getTurnForAttempt(task.id)!;
    const created = store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id,
      body_md: 'Continue the original work?', dedupe_key: `reminder:${task.id}`, wait_id: `wait:${task.id}`, timeout_ms: 300_000,
      options: [{ label: 'Yes', value: 'Yes' }], metadata: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] },
    }, { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: 'local' });
    expect(created.ok).toBe(true);
    const id = String(created.message_id);
    const card = store.claimFeishuBotOutbound('local', runtime.id)!;
    const action = questionCardAction(decodeDecisionCardBody(card.body)!.card)!;
    const sentAt = new Date(Date.now() + 1_000);
    store.reportFeishuBotOutbound('local', runtime.id, card.id, { claimToken: card.claimToken, status: 'sent',
      externalMessageId: 'om_reminder_card', interactionOpenId: 'ou_reminder_human' }, sentAt);
    return { store, db, runtime, issue, id, card, action, sentAt, dueAt: sentAt.getTime() + ISSUE_DECISION_CARD_REMINDER_DELAY_MS };
  }
  it('schedules one fixed-window nudge for a Q that remains pending after native timeout', () => {
    const h = setup();
    expect(h.store.getTaskHumanRequest(h.id)?.expiresAt).toBeNull();
    expect(h.store.nextFeishuBotOutboundWakeAt(h.runtime.id)).toBe(h.dueAt);
    h.store.expireTaskHumanRequest(h.id, 'timeout');
    expect(h.store.getQuestion(h.id)).toMatchObject({ status: 'pending', wait_status: 'detached' });
    expect(h.store.claimFeishuBotOutbound('local', h.runtime.id, new Date(h.dueAt - 1))).toBeNull();
    const reminder = h.store.claimFeishuBotOutbound('local', h.runtime.id, new Date(h.dueAt))!;
    expect(reminder).toMatchObject({ kind: 'decision_reminder', humanRequestId: h.id, interactionOpenId: 'ou_reminder_human' });
    expect(reminder.expiresAt ?? null).toBeNull();
    expect(h.store.claimFeishuBotOutbound('local', h.runtime.id, new Date(h.dueAt))).toBeNull();
    h.store.reportFeishuBotOutbound('local', h.runtime.id, reminder.id, { claimToken: reminder.claimToken,
      status: 'sent', externalMessageId: 'om_reminder_once', interactionOpenId: 'ou_reminder_human' }, new Date(h.dueAt));
    expect(h.store.claimFeishuBotOutbound('local', h.runtime.id, new Date(h.dueAt + 86_400_000))).toBeNull();
    expect(h.store.getMessage(h.id)?.card_token_hash).not.toBeNull();
    expect(h.store.getQuestion(h.id)?.status).toBe('pending');
    expect(h.store.listIssueActivity(h.issue.id).filter(event => event.type === 'decision_card_reminder')).toHaveLength(1);
  });
  it('an answer before the nudge commits one patch and leaves the reminder slot unused', () => {
    const h = setup();
    h.store.answerQuestion(h.id, { expected_route_revision: 1, response: { answers: { 'Continue?': 'Yes' } } }, { type: 'member', id: 'mem_local_local' });
    const patch = h.store.claimFeishuBotOutbound('local', h.runtime.id, new Date(h.dueAt))!;
    expect(patch.kind).toBe('decision_card_patch');
    expect(h.store.claimFeishuBotOutbound('local', h.runtime.id, new Date(h.dueAt))).toBeNull();
    expect(h.db.query('SELECT reminder_sent_at FROM multiremi_message_question_records WHERE id=?').get(h.id)?.reminder_sent_at).toBeNull();
    // No daemon consumed the live answer in this card-host check.
    expect(h.store.getQuestion(h.id)).toMatchObject({ status: 'answered', wait_status: 'waiting' });
  });
  it('rolls token rotation and the one-shot slot back with the reminder intent', () => {
    const h = setup();
    const token = h.store.getMessage(h.id)?.card_token_hash;
    expect(() => h.db.transaction(() => {
      const reminder = h.store.claimFeishuBotOutbound('local', h.runtime.id, new Date(h.dueAt))!;
      expect(reminder.kind).toBe('decision_reminder');
      expect(h.store.getMessage(h.id)?.card_token_hash).not.toBe(token);
      throw new Error('Injected crash before reminder commit');
    })()).toThrow('Injected crash before reminder commit');
    expect(h.store.getMessage(h.id)?.card_token_hash).toBe(token);
    expect(h.db.query('SELECT reminder_sent_at FROM multiremi_message_question_records WHERE id=?').get(h.id)?.reminder_sent_at).toBeNull();
    expect(h.db.query("SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE human_request_id=? AND kind='decision_reminder'").all(h.id)).toHaveLength(0);
    expect(h.store.listIssueActivity(h.issue.id).filter(event => event.type === 'decision_card_reminder')).toHaveLength(0);
    expect(h.store.claimFeishuBotOutbound('local', h.runtime.id, new Date(h.dueAt))?.kind).toBe('decision_reminder');
    expect(h.store.claimFeishuBotOutbound('local', h.runtime.id, new Date(h.dueAt))).toBeNull();
  });
});

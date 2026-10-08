import { expect, it } from 'bun:test';
import type { Envelope } from '@multiremi/contracts/inbox.js';
import type { SendMessageInput } from '@multiremi/contracts/unified-model.js';
import { createCommitEventQueue, type StoreContext } from '@multiremi/store/context.js';
import { sendMessageWithinTransaction } from '@multiremi/store/inbox/send-message.js';
import { runTurnExecutionMutation } from '@multiremi/store/turn-execution-records.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('transactional inbox writers', fixture => {
  function setup() {
    const f = fixture();
    const agent = f.store.createAgent({ name: 'Inbox owner', provider: 'codex' });
    const issue = f.store.createIssue({ title: 'Inbox', status: 'in_progress', assigneeType: 'agent', assigneeId: agent.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const chat = f.store.createChatSession({ agentId: agent.id });
    const ctx = (f.store as unknown as { ctx: StoreContext }).ctx;
    const queue = createCommitEventQueue();
    const env: Envelope = { to: { role: 'agent', agentId: agent.id, issueSessionId: session.id },
      kind: 'report', outcome: 'done', wake: 'now', body: 'A complete report', source: {} };
    const send = (changes: Partial<Envelope> = {}) => f.transaction(() => f.store.sendEnvelopeWithinTransaction({ ...env, ...changes }, [], queue))[0]!;
    const messageInput: SendMessageInput = { session_id: session.id, sender: { type: 'platform', id: null },
      to: { type: 'agent', ref: agent.id }, message_kind: 'report', wake_requested: 'now', body_md: env.body };
    const message = (changes: Partial<SendMessageInput> = {}) => f.transaction(() => sendMessageWithinTransaction(ctx, { ...messageInput, ...changes }, queue));
    const queued = () => f.store.listTurns({ workspace_id: 'local' }).filter(turn => turn.status === 'pending');
    const status = (id: string, value: string) => runTurnExecutionMutation(f.db, 'UPDATE multiremi_turn_execution_records SET status=? WHERE id=?', [value, id]);
    const attempt = (id: string) => f.store.getTurn(id)!.current_attempt_id!;
    const wakeSeq = (id: string) => f.store.getTurn(id)!.wake_seq;
    return { ...f, agent, issue, session, chat, ctx, queue, env, send, message, messageInput, queued, status, attempt, wakeSeq };
  }

  it('rejects both writers outside a transaction without a write', () => {
    const f = setup();
    const before = f.store.getConversationLogHead(f.session.id);
    expect(() => sendMessageWithinTransaction(f.ctx, f.messageInput, f.queue)).toThrow(/transaction/i);
    expect(() => f.store.sendEnvelopeWithinTransaction(f.env, [], f.queue)).toThrow(/transaction/i);
    expect(f.store.getConversationLogHead(f.session.id)).toEqual(before);
    expect(f.queued()).toHaveLength(0);
  });

  it('coalesces an existing pending turn, raises wake_seq monotonically and audits the merge', () => {
    const f = setup();
    const first = f.message({ dedupe_key: 'merge-first' });
    const next = f.message({ body_md: 'Later report' });
    const duplicate = f.message({ dedupe_key: 'merge-first', body_md: 'Duplicate must not replace the original' });
    expect(next.turn_id).toBe(first.turn_id);
    expect(duplicate.turn_id).toBe(first.turn_id);
    expect(f.queued()).toHaveLength(1);
    expect(f.wakeSeq(first.turn_id!)).toBe(next.message.seq);
    const merges = f.store.listIssueActivity(f.issue.id).filter(row => row.type === 'turn_merged');
    expect(merges.map(row => row.data)).toEqual([{ message_id: next.message.id, seq: next.message.seq, reason: next.wake_reason, task_id: first.turn_id }]);
    expect(f.queue.enqueuedTasks).toHaveLength(1);
    expect(f.store.getTurn(first.turn_id!)!.trigger_message_id).toBe(first.message.id);
    expect(f.store.getIssue(f.issue.id)!.status).toBe('in_progress');
  });

  it('T4: next_turn rides pending Issue work and returns none for running or idle lanes', () => {
    const f = setup();
    expect(f.message({ wake_requested: 'next_turn' }).turn_id).toBeUndefined();
    const first = f.message();
    const next = f.message({ wake_requested: 'next_turn' });
    expect(next.turn_id).toBe(first.turn_id);
    expect(f.wakeSeq(first.turn_id!)).toBe(next.message.seq);
    f.status(f.attempt(first.turn_id!), 'running');
    expect(f.message({ wake_requested: 'next_turn' }).turn_id).toBeUndefined();
    expect(f.queued()).toHaveLength(0);
  });

  it('T4: now during running work delivers into that turn without a second pending round', () => {
    const f = setup();
    const first = f.message();
    f.status(f.attempt(first.turn_id!), 'running');
    const next = f.message();
    expect(next.turn_id).toBe(first.turn_id);
    expect(f.queued()).toHaveLength(0);
    expect(f.store.getTurn(first.turn_id!)!.status).toBe('running');
    expect(f.store.listIssueActivity(f.issue.id).filter(row => row.type === 'message_delivered_running').map(row => row.data))
      .toEqual([{ message_id: next.message.id, seq: next.message.seq, reason: next.wake_reason, task_id: first.turn_id }]);
  });

  it('keeps execution scopes independent and coalesces Chat-only turns', () => {
    const f = setup();
    const main = f.message();
    const alpha = f.message({ execution_scope: 'alpha' });
    const beta = f.message({ execution_scope: 'beta' });
    expect(new Set([main.turn_id, alpha.turn_id, beta.turn_id]).size).toBe(3);
    expect(f.message({ execution_scope: 'alpha' }).turn_id).toBe(alpha.turn_id);
    const chat = f.message({ session_id: f.chat.id });
    expect(f.message({ session_id: f.chat.id }).turn_id).toBe(chat.turn_id);
    expect(f.queued()).toHaveLength(4);
    expect(f.store.getTurn(chat.turn_id!)!.session_id).toBe(f.chat.id);
  });

  it('writes Issue report headers and returns duplicates without allocating seq', () => {
    const f = setup();
    const first = f.send({ dedupeKey: 'report:1', outcome: 'failed' });
    const before = f.store.getConversationLogHead(f.session.id);
    const duplicate = f.send({ dedupeKey: 'report:1', outcome: 'failed', body: 'Must not replace the original' });
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.entry).toEqual(first.entry);
    expect(f.store.getConversationLogHead(f.session.id)).toEqual(before);
    expect(f.store.getMessage(first.entry.id)).toMatchObject({ sender_type: 'platform', to_agent_id: f.agent.id,
      message_kind: 'report', wake_requested: 'now', wake_applied: 'now', body_md: f.env.body,
      metadata: { message_outcome: 'failed', priority: 2 } });
    expect(Object.hasOwn(JSON.parse(String(f.db.query('SELECT metadata FROM multiremi_conversation_log WHERE id=?').get(first.entry.id)!.metadata)), 'envelope')).toBe(false);
    expect(f.store.getIssueComment(first.entry.id)!.type).toBe('system');
    expect(f.queued()).toHaveLength(1);
  });

  it('T4: merges human input and continuation input into the same pending work', () => {
    const f = setup();
    const first = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: 'Human request' });
    const later = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: 'Later request' });
    expect(later.id).toBe(first.id);
    const report = f.send();
    expect(report.task!.id).toBe(first.id);
    expect(f.store.getTurnForAttempt(first.id)!.trigger_message_id).toBe(f.store.getTurnForAttempt(later.id)!.trigger_message_id);
    expect(f.queued()).toHaveLength(1);
    f.status(first.id, 'completed');
    const continued = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: 'Continuation', continuedFromTaskId: first.id });
    expect(continued.id).not.toBe(first.id);
    expect(f.send().task!.id).toBe(continued.id);
  });

  it('T4: serializes delivery after a claim and rejects a foreign recipient before writing', () => {
    const f = setup();
    const first = f.message();
    f.status(f.attempt(first.turn_id!), 'running');
    expect(f.message().turn_id).toBe(first.turn_id);
    const otherWorkspace = f.store.createWorkspace({ name: 'Other' });
    const other = f.store.createAgent({ name: 'Foreign', provider: 'codex', workspaceId: otherWorkspace.id });
    const before = f.store.getConversationLogHead(f.session.id);
    expect(() => f.message({ to: { type: 'agent', ref: other.id } })).toThrow(/workspace/i);
    expect(f.store.getConversationLogHead(f.session.id)).toEqual(before);
    expect(f.queued()).toHaveLength(0);
  });

  it('T5: creates, coalesces and delivers Chat input in the caller transaction', () => {
    const f = setup();
    const first = f.message({ session_id: f.chat.id });
    expect(f.message({ session_id: f.chat.id }).turn_id).toBe(first.turn_id);
    f.status(f.attempt(first.turn_id!), 'running');
    const next = f.message({ session_id: f.chat.id, body_md: 'Deliver the new report' });
    expect(next.turn_id).toBe(first.turn_id);
    expect(f.store.listMessages(f.chat.id).filter(row => row.body_md === 'Deliver the new report')).toHaveLength(1);
    const before = f.store.getConversationLogHead(f.chat.id);
    expect(() => f.transaction(() => {
      f.message({ session_id: f.chat.id, body_md: 'Rolled back input' });
      throw new Error('abort input');
    })).toThrow('abort input');
    expect(f.store.getConversationLogHead(f.chat.id)).toEqual(before);
    expect(f.queued()).toHaveLength(0);
  });

  it('T5: keeps transport contexts in separate conversation lanes', () => {
    const f = setup();
    const privateTask = f.store.sendChatMessage(f.chat.id, { content: 'Private conversation' }).task;
    f.status(privateTask.id, 'running');
    const boundChat = f.store.createChatSession({ agentId: f.agent.id });
    const result = f.message({ session_id: boundChat.id });
    expect(f.attempt(result.turn_id!)).not.toBe(privateTask.id);
    expect(f.store.getTurnForAttempt(privateTask.id)!.session_id).toBe(f.chat.id);
    expect(f.store.getTurn(result.turn_id!)!.session_id).toBe(boundChat.id);
    expect(f.store.listMessages(f.chat.id).map(row => row.body_md)).toEqual(['Private conversation']);
  });

  it('T5: next_turn on Chat joins pending work and never creates an idle or running turn', () => {
    const f = setup();
    expect(f.message({ session_id: f.chat.id, wake_requested: 'next_turn' }).turn_id).toBeUndefined();
    const first = f.message({ session_id: f.chat.id });
    expect(f.message({ session_id: f.chat.id, wake_requested: 'next_turn' }).turn_id).toBe(first.turn_id);
    f.status(f.attempt(first.turn_id!), 'running');
    expect(f.message({ session_id: f.chat.id, wake_requested: 'next_turn' }).turn_id).toBeUndefined();
    expect(f.queued()).toHaveLength(0);
  });

  it('writes Chat report messages on the same log axis without duplicate seq', () => {
    const f = setup();
    const changes: Partial<Envelope> = { to: { role: 'chat', agentId: f.agent.id, chatSessionId: f.chat.id }, dedupeKey: 'chat:1' };
    const first = f.send(changes);
    const before = f.store.getConversationLogHead(f.chat.id);
    expect(f.send(changes).entry).toEqual(first.entry);
    expect(f.store.getConversationLogHead(f.chat.id)).toEqual(before);
    expect(f.store.getChatMessage(first.entry.id)).toMatchObject({ role: 'system', body: f.env.body });
    expect(f.store.getMessage(first.entry.id)).toMatchObject({ seq: first.entry.seq, sender_type: 'platform',
      to_agent_id: f.agent.id, message_kind: 'report', metadata: { priority: 3 } });
    expect(f.queued()).toHaveLength(1);
  });

  it('preserves Markdown whitespace and publishes only after commit', () => {
    const f = setup();
    const events: string[] = [];
    const unsubscribe = f.store.onWorkspaceEvent(event => events.push(event.type));
    const body = '  indented Markdown\n\nlast line\n';
    try {
      const delivery = f.transaction(() => {
        const result = f.store.sendEnvelopeWithinTransaction({ ...f.env, body,
          to: { role: 'chat', agentId: f.agent.id, chatSessionId: f.chat.id }, wake: 'inbox_only' }, [], f.queue)[0]!;
        expect(events).toEqual([]);
        return result;
      });
      expect(delivery.entry.body_md).toBe(body);
      expect(f.store.getChatMessage(delivery.entry.id)!.body).toBe(body);
      expect(events).toEqual([]);
      f.ctx.emitCommitEvents(f.queue);
      expect(events).toEqual(['inbox:new']);
    } finally { unsubscribe(); }
  });

  it('inbox_only writes both session kinds without creating turns', () => {
    const f = setup();
    const issue = f.send({ wake: 'inbox_only' });
    const chat = f.send({ wake: 'inbox_only', to: { role: 'chat', agentId: f.agent.id, chatSessionId: f.chat.id } });
    expect(issue.task).toBeNull();
    expect(chat.task).toBeNull();
    expect(issue.entry.metadata.priority).toBe(4);
    expect(chat.entry.metadata.priority).toBe(4);
    expect(f.queued()).toHaveLength(0);
  });

  it('keeps the original trigger while merging an arriving recovery report', () => {
    const f = setup();
    const recovery = f.message({ body_md: 'Original recovery input' });
    const delivery = f.send();
    expect(delivery.action).toBe('coalesced');
    expect(delivery.task!.id).toBe(f.attempt(recovery.turn_id!));
    expect(f.store.getTurn(recovery.turn_id!)!.trigger_message_id).toBe(recovery.message.id);
    expect(delivery.entry.body_md).toBe(f.env.body);
    expect(f.wakeSeq(recovery.turn_id!)).toBe(delivery.entry.seq);
    expect(f.store.getTurnInput(recovery.turn_id!)!.messages.map(row => row.body_md)).toContain('Original recovery input');
    expect(f.queued()).toHaveLength(1);
  });

  it('uses sessionId in dedupe keys and resolves Issue owners and parent owners', () => {
    const f = setup();
    const child = f.store.createIssue({ title: 'Child', parentIssueId: f.issue.id });
    const side = f.store.createIssueSession(f.issue.id, { title: 'Side', inheritMode: 'none' });
    const owner = f.send({ to: { role: 'issue_owner', issueId: f.issue.id }, dedupeKey: 'same', wake: 'inbox_only' });
    const parent = f.send({ to: { role: 'parent_owner', childIssueId: child.id }, dedupeKey: 'same', wake: 'inbox_only' });
    expect(parent.entry.id).toBe(owner.entry.id);
    expect(f.send({ to: { role: 'agent', agentId: f.agent.id, issueSessionId: side.id }, dedupeKey: 'same', wake: 'inbox_only' }).entry.id).not.toBe(owner.entry.id);
  });

  it('rolls back messages, pending turns and notifications with the outer transaction', () => {
    const f = setup();
    const before = f.store.getConversationLogHead(f.session.id);
    const chatBefore = f.store.getConversationLogHead(f.chat.id);
    const events: string[] = [];
    const unsubscribe = f.store.onWorkspaceEvent(event => events.push(event.type));
    try {
      expect(() => f.transaction(() => {
        f.send();
        f.send({ to: { role: 'chat', agentId: f.agent.id, chatSessionId: f.chat.id } });
        expect(f.queued()).toHaveLength(2);
        expect(events).toEqual([]);
        throw new Error('abort');
      })).toThrow('abort');
      expect(events).toEqual([]);
    } finally { unsubscribe(); }
    expect(f.queued()).toHaveLength(0);
    expect(f.store.getConversationLogHead(f.session.id)).toEqual(before);
    expect(f.store.getConversationLogHead(f.chat.id)).toEqual(chatBefore);
  });

  it('addresses delegation reports to the originating Issue session', () => {
    const f = setup();
    const worker = f.store.createAgent({ name: 'Delegate', provider: 'codex' });
    const parent = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: 'Original round' });
    const child = f.store.createIssue({ title: 'Delegated issue', parentIssueId: f.issue.id });
    const source = f.store.createTask({ agentId: worker.id, issueId: child.id, prompt: 'Delegated round', parentTaskId: parent.id,
      delegationId: 'return_address', delegatedByAgentId: f.agent.id, delegatedFromIssueSessionId: f.session.id });
    const delivery = f.send({ to: { role: 'delegator', delegationId: 'return_address' }, source: { taskId: source.id } });
    expect(delivery.recipient.issueSessionId).toBe(f.session.id);
    expect(delivery.recipient.agentId).toBe(f.agent.id);
    expect(delivery.task!.id).toBe(parent.id);
    expect(delivery.action).toBe('coalesced');
  });

  it('fans relay addresses out as independent Chat messages', () => {
    const f = setup();
    const secondChat = f.store.createChatSession({ agentId: f.agent.id });
    for (const [i, chat] of [f.chat, secondChat].entries()) {
      f.db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
        (id,workspace_id,app_id,agent_id,external_session_key,chat_session_id,issue_id,created_at,updated_at)
        VALUES(?,?,'relay_test',?,?,?,?,?,?)`, [`relay_${i}`, f.agent.workspaceId, f.agent.id, `relay_${i}`, chat.id, f.issue.id,
        '2026-09-29T00:00:00.000Z', '2026-09-29T00:00:00.000Z']);
    }
    const deliveries = f.transaction(() => f.store.sendEnvelopeWithinTransaction({ ...f.env, to: { role: 'relay', issueId: f.issue.id }, dedupeKey: 'fanout' }, [], f.queue));
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]!.entry.id).not.toBe(deliveries[1]!.entry.id);
    expect(deliveries.map(row => row.recipient.chatSessionId).sort()).toEqual([f.chat.id, secondChat.id].sort());
    expect(deliveries.map(row => row.action)).toEqual(['created', 'created']);
    expect(deliveries.map(row => row.task!.issueSessionId)).toEqual([null, null]);
    expect(f.queued()).toHaveLength(2);
    expect(f.transaction(() => f.store.sendEnvelopeWithinTransaction({ ...f.env, to: { role: 'relay', issueId: f.issue.id }, dedupeKey: 'fanout' }, [], f.queue)).map(row => row.deduplicated)).toEqual([true, true]);
  });
});

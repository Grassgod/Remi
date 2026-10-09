import { createResponsibleTestIssue } from './helpers.js';
import { expect, it } from 'bun:test';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { MultiremiStore } from '@multiremi/store.js';
import { daemonTaskClaimResponse } from '@multiremi/api/wire/tasks.js';
import { useTaskSessionInput } from '@multiremi/api/daemon-protocol/offer-budget.js';

pendingTurnBackendTests('MUL-506 actual reader and provider checkpoints', fixture => {
  function setup(chat = false, body = 'original input') {
    const f = fixture();
    const agent = f.store.createAgent({ name: 'Reader', provider: 'codex' });
    const issue = createResponsibleTestIssue(f.store, { title: 'Read progress' });
    const session = chat ? f.store.createChatSession({ agentId: agent.id }) : f.store.getOrCreateDefaultIssueSession(issue.id);
    f.store.registerRuntime({ id: 'rt_read', daemonId: 'daemon_read', name: 'Reader runtime', provider: 'codex', workspaceId: 'local' });
    const sent = f.store.sendMessage({ session_id: session.id, sender: { type: 'member', id: 'mem_local_local' }, to: { type: 'agent', ref: agent.id }, message_kind: 'request', wake_requested: 'now', body_md: body });
    const attempt = f.store.claimTask('rt_read')!;
    f.store.startTask(attempt.id);
    f.store.getDaemonTurnBridge().offerInput(f.store.getTaskWithAgent(attempt.id)!);
    const lane = () => f.db.query("SELECT cursor_seq,cursor_offset,provider_cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=''").get(session.id, agent.id)!;
    return { ...f, issue, agent, session, sent, attempt, lane };
  }

  it('a member using the local alias does not receive a duplicate subscription notice for their own comment', () => {
    const f = setup();
    f.store.addIssueSubscriber(f.issue.id, 'mem_local_local');
    const before = f.store.listInboxItems('mem_local_local').length;
    const comment = f.store.createIssueComment(f.issue.id, { authorType: 'member', authorId: 'local', body: 'own unread input' });
    expect(f.store.getMessage(comment.id)?.body_md).toBe('own unread input');
    expect(f.store.listInboxItems('mem_local_local')).toHaveLength(before);
  });

  for (const chat of [false, true]) it(`historical ${chat ? 'Chat' : 'Issue'} migration separates actual partial reading from the legacy provider position once`, () => {
    const f = setup(chat, 'x'.repeat(70_000));
    const head = f.store.getConversationLogHead(f.session.id)!.headSeq;
    f.db.run("UPDATE multiremi_session_lanes SET cursor_seq=? WHERE session_id=? AND reader_id=?", [head, f.session.id, f.agent.id]);
    f.db.run('UPDATE multiremi_conversation_heads SET agent_read_state=? WHERE session_id=?', [JSON.stringify({ [f.agent.id]: { seq: 0, offset: 32_000 } }), f.session.id]);
    f.db.run('DELETE FROM multiremi_schema_migrations WHERE id IN (?,?)', ['20261005_fold_agent_read_state', '20261005_separate_lane_provider_progress']);
    f.db.exec('ALTER TABLE multiremi_session_lanes DROP COLUMN cursor_offset');
    f.db.exec('ALTER TABLE multiremi_turns DROP COLUMN trigger_message_id');
    new MultiremiStore(f.db);
    expect(f.lane()).toMatchObject({ cursor_seq: 0, cursor_offset: 32_000, provider_cursor_seq: head });
    f.store.completeTask(f.attempt.id, { output: 'finished', sessionId: 'reader-provider', workDir: '/reader' });
    new MultiremiStore(f.db);
    expect(f.lane()).toMatchObject({ cursor_seq: 0, cursor_offset: 32_000, provider_cursor_seq: head });
    const newcomer = f.store.createAgent({ name: 'New reader', provider: 'codex' });
    expect(f.store.getSessionAgentReadProgress(f.session.id, newcomer.id)).toEqual({ seq: 0, offset: 0 });
  });

  for (const partial of [false, true]) it(`warm completion preserves ${partial ? 'partial' : 'unread'} actual progress independently of the provider`, () => {
    const f = setup(false, 'x'.repeat(70_000));
    if (partial) f.store.recordSessionAgentRangeRead(f.session.id, f.agent.id, { seq: 1, offset: 0 }, { seq: 1, offset: 32_000 }, f.attempt.id);
    const before = f.store.getSessionAgentReadProgress(f.session.id, f.agent.id);
    expect(before).toEqual({ seq: 0, offset: partial ? 32_000 : 0 });
    const head = f.store.getConversationLogHead(f.session.id)!.headSeq;
    f.store.completeTask(f.attempt.id, { output: 'finished', sessionId: 'reader-provider', workDir: '/reader' });
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual(before);
    expect(f.lane()).toMatchObject({ cursor_seq: 0, cursor_offset: before.offset, provider_cursor_seq: head });
  });

  for (const accepted of [false, true]) it(`cold bootstrap ${accepted ? 'acceptance resets' : 'rejection preserves'} actual reading`, () => {
    const f = setup();
    const head = f.store.getConversationLogHead(f.session.id)!.headSeq;
    f.store.recordSessionAgentRangeRead(f.session.id, f.agent.id, { seq: 1, offset: 0 }, { seq: head + 1, offset: 0 }, f.attempt.id);
    const before = f.store.getSessionAgentReadProgress(f.session.id, f.agent.id);
    f.store.resetSessionAgentLane(f.session.id, f.agent.id);
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual(before);
    const retried = f.store.retryTurn(f.sent.turn_id!, true);
    expect(f.store.claimTask('rt_read')?.id).toBe(retried.current_attempt_id!);
    const bridge = f.store.getDaemonTurnBridge();
    const offered = bridge.offerInput(f.store.getTaskWithAgent(retried.current_attempt_id!)!);
    expect(offered.input_from_seq).toBe(0);
    expect(offered.input_messages.some(message => message.id === f.sent.message.id)).toBe(true);
    const claimed = f.store.getTaskWithAgent(retried.current_attempt_id!)!;
    const response = daemonTaskClaimResponse(f.store, claimed, f.store.getTaskTriggerMetadata(claimed));
    useTaskSessionInput(f.store, claimed, response);
    const sessionProjection = response.session_projection as { mode: string; jsonl: string };
    expect(sessionProjection.mode).toBe('bootstrap');
    const projection = sessionProjection.jsonl.split('\n').map(line => JSON.parse(line));
    expect(projection[0].from_seq).toBe(0);
    expect(projection[0].instruction).toContain(`--from 0 --to ${head}`);
    expect(projection.some(entry => entry.type === 'triggering_message' && entry.body === 'original input')).toBe(true);
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual(before);
    if (accepted) f.store.recordSessionAgentInlineRead(f.session.id, f.agent.id, [], head, true, retried.current_attempt_id!);
    const progress = accepted ? { seq: 0, offset: 0 } : before;
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual(progress);
    expect(f.lane()).toMatchObject({ cursor_seq: progress.seq, cursor_offset: progress.offset });
    const input = bridge.offerInput(f.store.getTaskWithAgent(retried.current_attempt_id!)!);
    expect(input.input_from_seq).toBe(0);
    expect(input.input_messages.some(message => message.id === f.sent.message.id)).toBe(true);
    if (accepted) {
      f.store.recordSessionAgentRangeRead(f.session.id, f.agent.id, { seq: 1, offset: 0 }, { seq: 2, offset: 0 }, retried.current_attempt_id!);
      expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual({ seq: 1, offset: 0 });
      f.store.recordSessionAgentRangeRead(f.session.id, f.agent.id, { seq: 1, offset: 0 }, { seq: head + 1, offset: 0 }, retried.current_attempt_id!);
      expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual(before);
    }
  });

  for (const retire of [false, true]) it(`${retire ? 'daemon retirement' : 'runtime deletion'} resets provider state and preserves actual partial reading`, async () => {
    const f = setup(false, 'x'.repeat(70_000));
    f.store.recordSessionAgentRangeRead(f.session.id, f.agent.id, { seq: 1, offset: 0 }, { seq: 1, offset: 32_000 }, f.attempt.id);
    const before = f.store.getSessionAgentReadProgress(f.session.id, f.agent.id);
    f.store.completeTask(f.attempt.id, { output: 'finished', sessionId: 'retired-provider', workDir: '/reader' });
    if (retire) {
      f.store.markTaskTraceNone(f.attempt.id);
      await f.store.createAccessToken({ name: 'Reader fixture', type: 'daemon', workspaceId: 'local', daemonId: 'daemon_read' });
      const plan = f.store.getDaemonRetirementPlan('local', 'daemon_read');
      expect(f.store.retireDaemon('local', 'daemon_read', plan.snapshot, 'local').status).toBe('retired');
    } else {
      f.store.registerRuntime({ id: 'rt_reader_other', name: 'Another reader provider', provider: 'claude', workspaceId: 'local', daemonId: 'daemon_read' });
      expect(f.store.deleteRuntime('rt_read')).toBe(true);
    }
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual(before);
    expect(f.lane()).toMatchObject({ cursor_seq: 0, cursor_offset: 32_000, provider_cursor_seq: 0 });
  });
});

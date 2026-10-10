import { expect, it } from 'bun:test';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('MUL-493 B4 Chat terminal re-ring', fixture => {
  function setup() {
    const { store } = fixture();
    const agent = store.createAgent({ name: 'Chat reader', provider: 'codex' });
    const session = store.createChatSession({ agentId: agent.id });
    const runtime = store.registerRuntime({
      id: 'rt_chat_rering', daemonId: 'daemon_chat_rering', name: 'Chat runtime',
      provider: 'codex', workspaceId: 'local',
    });
    const send = (body: string, wake: 'now' | 'next_turn' = 'now') => store.sendMessage({
      session_id: session.id, sender: { type: 'member', id: 'mem_local_local' },
      to: { type: 'agent', ref: agent.id }, message_kind: 'request',
      wake_requested: wake, body_md: body,
    });
    const first = send('First now request');
    expect(first.message.seq).toBe(1);
    const attempt = store.claimTask(runtime.id)!;
    expect(attempt.issueId).toBeNull();
    store.startTask(attempt.id);
    const bridge = store.getDaemonTurnBridge();
    const scope = { workspaceId: 'local', runtimeId: runtime.id, daemonId: runtime.daemonId! };
    const offer = bridge.offerInput(store.getTaskWithAgent(attempt.id)!);
    expect(offer.input_to_seq).toBe(2);
    store.recordSessionAgentRangeRead(session.id, agent.id, { seq: 1, offset: 0 }, { seq: 3, offset: 0 }, attempt.id);
    expect(bridge.rpc('turn.input', {
      turn_id: first.turn_id!, attempt_id: attempt.id, input_to_seq: offer.input_to_seq,
      message_ids: offer.input_messages.map(message => message.id),
    }, scope).ok).toBe(true);
    expect(store.getSessionAgentReadProgress(session.id, agent.id)).toEqual({ seq: 2, offset: 0 });
    expect(store.getTurn(first.turn_id!)?.input_to_seq).toBe(2);
    const late = send('Late now request');
    expect(late.message.seq).toBe(3);
    expect(late.turn_id).toBe(first.turn_id);
    return { store, agent, session, runtime, first, attempt, bridge, scope, offer, late };
  }

  for (const status of ['completed', 'cancelled', 'failed'] as const) {
    it(`${status} re-rings unread seq 3 and a successor reads it`, () => {
      const f = setup();
      if (status !== 'completed') {
        const snapshot = f.bridge.snapshot(f.scope, new Set([f.attempt.id]));
        expect(snapshot.messages.map(message => message.message.id)).toEqual([f.late.message.id]);
        expect(f.store.getTask(f.attempt.id)?.projectionToSeq).toBe(3);
        expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual({ seq: 2, offset: 0 });
        expect(f.store.getTurn(f.first.turn_id!)?.input_to_seq).toBe(2);
      }
      if (status === 'completed') {
        expect(f.bridge.complete({
          payload: {
            turn_id: f.first.turn_id!, attempt_id: f.attempt.id, input_to_seq: 2,
            reply: { body_md: 'First request completed', message_kind: 'final' },
          }, completionFields: null,
        }, f.scope).ok).toBe(true);
      } else if (status === 'cancelled') {
        f.store.cancelTurn(f.first.turn_id!);
      } else {
        f.store.failTask(f.attempt.id, { error: 'Non-retryable failure', failureReason: 'agent_error' });
      }
      expect(f.store.getTurn(f.first.turn_id!)?.status).toBe(status);
      expect(f.store.listTurnAttempts(f.first.turn_id!)).toHaveLength(1);
      expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual({ seq: 2, offset: 0 });
      const turns = f.store.listTurns({ workspace_id: 'local', session_id: f.session.id });
      expect(turns).toHaveLength(2);
      const successor = turns.find(turn => turn.id !== f.first.turn_id)!;
      expect(successor.status).toBe('pending');
      expect(successor.trigger_message_id).toBe(f.late.message.id);
      const attempt = f.store.claimTask(f.runtime.id)!;
      expect(attempt.id).toBe(successor.current_attempt_id!);
      f.store.startTask(attempt.id);
      const offer = f.bridge.offerInput(f.store.getTaskWithAgent(attempt.id)!);
      expect(offer.input_messages.some(message => message.id === f.late.message.id && message.seq === 3)).toBe(true);
      f.store.recordSessionAgentRangeRead(f.session.id, f.agent.id, { seq: 1, offset: 0 }, { seq: 4, offset: 0 }, attempt.id);
      expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual({ seq: 3, offset: 0 });
      expect(f.bridge.rpc('turn.input', {
        turn_id: successor.id, attempt_id: attempt.id, input_to_seq: offer.input_to_seq,
        message_ids: offer.input_messages.map(message => message.id),
      }, f.scope).ok).toBe(true);
      expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id).seq).toBeGreaterThanOrEqual(3);
      expect(f.store.getTurn(successor.id)!.input_to_seq).toBeGreaterThanOrEqual(3);
      expect(f.store.listMessages(f.session.id, { unread_by: f.agent.id }).some(message => message.id === f.late.message.id)).toBe(false);
    }, 120_000);
  }

  it('cancel with a replacement keeps unread seq 3 in the same turn', () => {
    const f = setup();
    const replacement = f.store.retryTurn(f.first.turn_id!, true);
    expect(replacement.current_attempt_id).not.toBe(f.attempt.id);
    expect(f.store.listTurns({ workspace_id: 'local', session_id: f.session.id })).toHaveLength(1);
    expect(f.store.listTurnAttempts(f.first.turn_id!)).toHaveLength(2);
  }, 120_000);

  it('retryable failure keeps unread seq 3 in the same turn', () => {
    const f = setup();
    f.store.failTask(f.attempt.id, { error: 'Provider throttled', failureReason: 'agent_error.provider_capacity_or_rate_limit' });
    expect(f.store.getTurn(f.first.turn_id!)?.current_attempt_id).not.toBe(f.attempt.id);
    expect(f.store.listTurns({ workspace_id: 'local', session_id: f.session.id })).toHaveLength(1);
    expect(f.store.listTurnAttempts(f.first.turn_id!)).toHaveLength(2);
  }, 120_000);
}, { isolation: 'committed-baseline' });

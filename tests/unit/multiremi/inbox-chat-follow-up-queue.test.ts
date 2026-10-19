import { expect, it } from 'bun:test';
import { QueuedMessageError } from '@multiremi/store/inbox/queued-messages.js';
import { QUEUE_MAX_LIVE_ITEMS } from '@multiremi/contracts/queued-message.js';
import { MultiremiStore } from '@multiremi/store.js';
import { CHAT_FOLLOW_UP_QUEUE_MIGRATION } from '@multiremi/store/unified-model-schema.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

const MEMBER = 'mem_local_local';

function queueError(run: () => unknown): QueuedMessageError {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(QueuedMessageError);
    return error as QueuedMessageError;
  }
  throw new Error('expected a QueuedMessageError');
}

pendingTurnBackendTests('ADR 0020 Chat follow-up queue', fixture => {
  function setup() {
    const { store, db } = fixture();
    const agent = store.createAgent({ name: 'Queue reader', provider: 'codex' });
    const chat = store.createChatSession({ agentId: agent.id });
    const runtime = store.registerRuntime({
      id: 'rt_chat_queue', daemonId: 'daemon_chat_queue', name: 'Queue runtime', provider: 'codex', workspaceId: 'local',
    });
    const send = (body: string) => store.sendMessage({
      session_id: chat.id, sender: { type: 'member', id: MEMBER }, to: { type: 'agent', ref: agent.id },
      message_kind: 'request', wake_requested: 'now', body_md: body,
    });
    const enqueue = (body: string, extra: { client_id?: string; attachment_ids?: string[] } = {}) => store.enqueueQueuedMessage({
      session_id: chat.id, sender_member_id: MEMBER, body_md: body, client_id: extra.client_id ?? `client-${body}`, attachment_ids: extra.attachment_ids,
    });
    /** A running turn whose trigger is `body`. */
    const running = (body = 'First request') => {
      const sent = send(body);
      const attempt = store.claimTask(runtime.id)!;
      store.startTask(attempt.id);
      return { turnId: sent.turn_id!, attemptId: attempt.id, message: sent.message };
    };
    const turns = () => store.listTurns({ workspace_id: 'local', session_id: chat.id });
    const memberMessages = () => store.listMessages(chat.id).filter(message => message.sender_type === 'member');
    const pause = () => store.listQueuedMessages(chat.id).paused;
    const row = (id: string) => db.query('SELECT status,released_via,released_message_id FROM multiremi_queued_messages WHERE id=?').get(id);
    return { store, db, agent, chat, runtime, send, enqueue, running, turns, memberMessages, pause, row };
  }

  it('keeps a message queued outside the log while a turn runs', () => {
    const f = setup();
    const first = f.running();
    const { item, released } = f.enqueue('Follow up');
    expect(released).toBeNull();
    expect(item).toMatchObject({ status: 'queued', body_md: 'Follow up', revision: 1, client_id: 'client-Follow up', released_message_id: null });
    expect(f.memberMessages().map(message => message.id)).toEqual([first.message.id]);
    expect(f.turns()).toHaveLength(1);
    expect(f.store.listQueuedMessages(f.chat.id)).toEqual({ items: [item], paused: null });
    // A steer sent after the queued row only sees the steer; the queued row is not an input gap.
    const steer = f.send('Steer now');
    expect(steer.turn_id).toBe(first.turnId);
    const snapshot = f.store.getDaemonTurnBridge().snapshot({ workspaceId: 'local', runtimeId: f.runtime.id, daemonId: f.runtime.daemonId! }, new Set([first.attemptId]));
    expect(snapshot.messages.map(entry => entry.message.id)).toEqual([steer.message.id]);
  }, 120_000);

  it('releases immediately on an idle lane as an ordinary now request', () => {
    const f = setup();
    const { item, released } = f.enqueue('Idle follow up');
    expect(item).toMatchObject({ status: 'released', released_via: 'turn' });
    expect(released!.message).toMatchObject({ body_md: 'Idle follow up', sender_type: 'member', sender_id: MEMBER,
      to_agent_id: f.agent.id, message_kind: 'request', wake_applied: 'now', dedupe_key: `queue:${item.id}` });
    expect(released!.message.metadata).toMatchObject({ queued_message_id: item.id, queued_at: item.created_at });
    expect(item.released_message_id).toBe(released!.message.id);
    const [turn] = f.turns();
    expect(released!.turn_id).toBe(turn!.id);
    expect(turn).toMatchObject({ status: 'pending', trigger_message_id: released!.message.id });
    expect(f.store.listQueuedMessages(f.chat.id)).toEqual({ items: [], paused: null });
  }, 120_000);

  it('releases one queued row per completed turn, in send order, each after the previous reply', () => {
    const f = setup();
    const first = f.running();
    const queued = ['Q1', 'Q2', 'Q3'].map(body => f.enqueue(body).item);
    let current: { turnId: string; attemptId: string } = first;
    for (const [index, item] of queued.entries()) {
      const before = f.turns().map(turn => turn.id);
      f.store.completeTask(current.attemptId, { output: `Answer ${index}` });
      expect(f.store.getTurn(current.turnId)?.status).toBe('completed');
      // Only the next row left the queue; the others keep waiting in order.
      expect(f.store.listQueuedMessages(f.chat.id).items.map(entry => entry.id)).toEqual(queued.slice(index + 1).map(entry => entry.id));
      const log = f.store.listMessages(f.chat.id);
      const released = log.filter(message => message.metadata.queued_message_id);
      expect(released.map(message => message.body_md)).toEqual(queued.slice(0, index + 1).map(entry => entry.body_md));
      const message = released.at(-1)!;
      expect(message.seq).toBeGreaterThan(log.filter(entry => entry.sender_type === 'agent').at(-1)!.seq);
      expect(f.row(item.id)).toMatchObject({ status: 'released', released_via: 'turn', released_message_id: message.id });
      for (const later of queued.slice(index + 1)) expect(f.row(later.id)).toMatchObject({ status: 'queued', released_message_id: null });
      // Exactly one new turn, triggered by this row alone.
      const created = f.turns().filter(turn => !before.includes(turn.id));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ status: 'pending', trigger_message_id: message.id, wake_seq: message.seq });
      expect(message.metadata.delivery_turn_id).toBe(created[0]!.id);
      const attempt = f.store.claimTask(f.runtime.id)!;
      expect(attempt.id).toBe(created[0]!.current_attempt_id!);
      f.store.startTask(attempt.id);
      // The offer's unread part holds this one queued body; earlier queued rows were read by earlier turns.
      const previousInput = Number(f.store.getTurn(current.turnId)!.input_to_seq);
      const offer = f.store.getDaemonTurnBridge().offerInput(f.store.getTaskWithAgent(attempt.id)!);
      const unreadQueued = offer.input_messages.filter(entry => entry.seq > previousInput && released.some(own => own.id === entry.id));
      expect(unreadQueued.map(entry => entry.id)).toEqual([message.id]);
      expect(unreadQueued[0]!.body_md).toContain(item.body_md);
      current = { turnId: created[0]!.id, attemptId: attempt.id };
    }
    f.store.completeTask(current.attemptId, { output: 'Last answer' });
    expect(f.store.listQueuedMessages(f.chat.id)).toEqual({ items: [], paused: null });
    expect(f.turns().filter(turn => turn.status === 'pending')).toEqual([]);
    expect(f.turns()).toHaveLength(4);
  }, 120_000);

  it('an idle enqueue releases only the first queued row; the rest wait for completion', () => {
    const f = setup();
    const a = f.enqueue('Idle A');
    const b = f.enqueue('Idle B');
    expect(a.item.status).toBe('released');
    expect(b).toMatchObject({ item: { status: 'queued' }, released: null });
    expect(f.turns()).toHaveLength(1);
    const attempt = f.store.claimTask(f.runtime.id)!;
    expect(attempt.id).toBe(f.store.getTurn(a.released!.turn_id!)!.current_attempt_id!);
    f.store.startTask(attempt.id);
    f.store.completeTask(attempt.id, { output: 'A answer' });
    expect(f.row(b.item.id)).toMatchObject({ status: 'released', released_via: 'turn' });
    // Rows kept while the Chat was archived go first: the new row waits behind them.
    const second = f.turns().find(turn => turn.status === 'pending')!;
    const running = f.store.claimTask(f.runtime.id)!;
    expect(running.id).toBe(second.current_attempt_id!);
    f.store.startTask(running.id);
    const kept = ['Kept 1', 'Kept 2'].map(body => f.enqueue(body).item);
    f.store.updateChatSession(f.chat.id, { status: 'archived' });
    f.store.updateChatSession(f.chat.id, { status: 'active' });
    expect(f.turns().filter(turn => ['pending', 'running'].includes(turn.status))).toEqual([]);
    expect(f.store.listQueuedMessages(f.chat.id)).toMatchObject({ paused: null, items: kept.map(item => ({ id: item.id, status: 'queued' })) });
    const fresh = f.enqueue('After restore');
    expect(fresh).toMatchObject({ item: { status: 'queued' }, released: null });
    expect(f.row(kept[0]!.id)).toMatchObject({ status: 'released', released_via: 'turn' });
    expect(f.store.listQueuedMessages(f.chat.id).items.map(item => item.id)).toEqual([kept[1]!.id, fresh.item.id]);
    expect(f.turns().filter(turn => turn.status === 'pending')).toHaveLength(1);
  }, 120_000);

  for (const [label, stop, reason] of [
    ['a failed turn', 'fail', 'turn_ended'],
    ['a cancelled turn', 'cancel', 'turn_ended'],
    ['a member stop', 'member', 'interrupted'],
  ] as const) {
    it(`pauses after ${label}; ${reason === 'turn_ended' ? 'the next completed turn releases' : 'only resume releases'}`, () => {
      const f = setup();
      const events: Array<{ inTransaction: boolean }> = [];
      const first = f.running();
      const queued = f.enqueue('After stop').item;
      const next = f.enqueue('Second after stop').item;
      const unsubscribe = f.store.onWorkspaceEvent(event => {
        if (event.type === 'chat:queue_updated' && event.chatSessionId === f.chat.id) events.push({ inTransaction: !!f.db.inTransaction });
      });
      try {
        if (stop === 'fail') f.store.failTask(first.attemptId, { error: 'Non-retryable failure', failureReason: 'agent_error' });
        else f.store.cancelTurn(first.turnId, { byMember: stop === 'member' });
      } finally { unsubscribe(); }
      expect(f.store.getTurn(first.turnId)?.status).toBe(stop === 'fail' ? 'failed' : 'cancelled');
      expect(f.pause()).toMatchObject({ reason });
      expect(events.length).toBeGreaterThan(0);
      expect(events.every(event => !event.inTransaction)).toBe(true);
      expect(f.store.listQueuedMessages(f.chat.id).items.map(item => item.id)).toEqual([queued.id, next.id]);
      expect(f.turns().filter(turn => turn.status === 'pending')).toEqual([]);
      // A direct steer still starts work. Its completion clears turn_ended and releases;
      // a member's interrupted pause leaves the queue alone until resume.
      const direct = f.send('Direct message');
      const attempt = f.store.claimTask(f.runtime.id)!;
      expect(attempt.id).toBe(f.store.getTurn(direct.turn_id!)!.current_attempt_id!);
      f.store.startTask(attempt.id);
      f.store.completeTask(attempt.id, { output: 'Direct answer' });
      if (reason === 'turn_ended') {
        // The clearing completion releases one row; the next waits for that turn.
        expect(f.pause()).toBeNull();
        expect(f.row(queued.id)).toMatchObject({ status: 'released', released_via: 'turn' });
        expect(f.row(next.id)).toMatchObject({ status: 'queued' });
        expect(f.turns().filter(turn => turn.status === 'pending')).toHaveLength(1);
        return;
      }
      expect(f.store.listQueuedMessages(f.chat.id).items.map(item => item.status)).toEqual(['queued', 'queued']);
      expect(f.memberMessages().some(message => message.metadata.queued_message_id)).toBe(false);
      // Resume on the idle lane releases the first row only.
      const resumed = f.store.resumeQueuedMessages(f.chat.id, MEMBER);
      expect(resumed.paused).toBeNull();
      expect(resumed.items.map(item => item.id)).toEqual([next.id]);
      expect(resumed.released.map(entry => entry.message.body_md)).toEqual(['After stop']);
      const pending = f.store.getTurn(resumed.released[0]!.turn_id!)!;
      expect(pending.status).toBe('pending');
      const resumedAttempt = f.store.claimTask(f.runtime.id)!;
      expect(resumedAttempt.id).toBe(pending.current_attempt_id!);
      f.store.startTask(resumedAttempt.id);
      f.store.completeTask(resumedAttempt.id, { output: 'After stop answer' });
      expect(f.row(next.id)).toMatchObject({ status: 'released', released_via: 'turn' });
    }, 120_000);
  }

  it('a successful retry of the failed turn clears turn_ended and releases the queue', () => {
    const f = setup();
    const first = f.running();
    const queued = f.enqueue('After the retry').item;
    f.store.failTask(first.attemptId, { error: 'Non-retryable failure', failureReason: 'agent_error' });
    expect(f.pause()).toMatchObject({ reason: 'turn_ended' });
    const retried = f.store.retryChatTurnForCreator({ turnId: first.turnId, userId: 'local', cold: false });
    expect(retried.current_attempt_id).not.toBe(first.attemptId);
    const attempt = f.store.claimTask(f.runtime.id)!;
    expect(attempt.id).toBe(retried.current_attempt_id!);
    f.store.startTask(attempt.id);
    expect(f.row(queued.id)).toMatchObject({ status: 'queued' });
    f.store.completeTask(attempt.id, { output: 'Retried answer' });
    expect(f.store.getTurn(first.turnId)?.status).toBe('completed');
    expect(f.pause()).toBeNull();
    expect(f.row(queued.id)).toMatchObject({ status: 'released', released_via: 'turn' });
    expect(f.turns().filter(turn => turn.status === 'pending')).toHaveLength(1);
  }, 120_000);

  it('a completed turn keeps interrupted and send_failed pauses', () => {
    const f = setup();
    const first = f.running();
    const queued = f.enqueue('Still paused').item;
    f.store.cancelTurn(first.turnId, { byMember: true });
    const second = f.running('Second request');
    f.store.completeTask(second.attemptId, { output: 'Answer' });
    expect(f.pause()).toMatchObject({ reason: 'interrupted' });
    f.db.run("UPDATE multiremi_session_lanes SET queue_pause_reason='send_failed' WHERE session_id=? AND reader_type='agent'", [f.chat.id]);
    const third = f.running('Third request');
    f.store.completeTask(third.attemptId, { output: 'Answer' });
    expect(f.pause()).toMatchObject({ reason: 'send_failed' });
    expect(f.row(queued.id)).toMatchObject({ status: 'queued' });
  }, 120_000);

  it('does not pause on a member stop or failure when the queue is empty', () => {
    const f = setup();
    const first = f.running();
    f.store.cancelTurn(first.turnId, { byMember: true });
    expect(f.pause()).toBeNull();
    const second = f.running('Second request');
    f.store.failTask(second.attemptId, { error: 'Non-retryable failure', failureReason: 'agent_error' });
    expect(f.pause()).toBeNull();
  }, 120_000);

  it('resume while a turn runs only clears the pause and retries failed rows', () => {
    const f = setup();
    const first = f.running();
    const queued = f.enqueue('Wait for the turn').item;
    f.store.cancelTurn(first.turnId, { byMember: true });
    const second = f.running('Second request');
    const resumed = f.store.resumeQueuedMessages(f.chat.id, MEMBER);
    expect(resumed).toMatchObject({ paused: null, released: [] });
    expect(resumed.items.map(item => item.id)).toEqual([queued.id]);
    f.store.completeTask(second.attemptId, { output: 'Second answer' });
    expect(f.row(queued.id)).toMatchObject({ status: 'released', released_via: 'turn' });
  }, 120_000);

  it('steers one queued row into the running turn and repeats idempotently', () => {
    const f = setup();
    const first = f.running();
    const earlier = f.enqueue('Earlier').item;
    const later = f.enqueue('Promote me').item;
    const last = f.enqueue('Last').item;
    // The second row overtakes the first, which keeps waiting for completion.
    const steered = f.store.steerQueuedMessage(f.chat.id, later.id, MEMBER);
    if (!steered.message) throw new Error('steer failed');
    expect(steered.item).toMatchObject({ id: later.id, status: 'released', released_via: 'steer' });
    expect(steered.message).toMatchObject({ body_md: 'Promote me', wake_applied: 'now', dedupe_key: `queue:${later.id}` });
    expect(steered.turn_id).toBe(first.turnId);
    const again = f.store.steerQueuedMessage(f.chat.id, later.id, MEMBER);
    expect(again.message?.id).toBe(steered.message.id);
    expect(f.memberMessages().filter(message => message.metadata.queued_message_id === later.id)).toHaveLength(1);
    expect(f.store.listQueuedMessages(f.chat.id).items.map(item => item.id)).toEqual([earlier.id, last.id]);
    // The steered row reached the running turn; completion releases only the earlier row.
    f.store.completeTask(first.attemptId, { output: 'Answer' });
    expect(f.row(earlier.id)).toMatchObject({ status: 'released', released_via: 'turn' });
    expect(f.row(last.id)).toMatchObject({ status: 'queued' });
    const pending = f.turns().filter(turn => turn.status === 'pending');
    expect(pending).toHaveLength(1);
    // Steering the last row joins the pending turn the earlier row created.
    const joined = f.store.steerQueuedMessage(f.chat.id, last.id, MEMBER);
    expect(joined).toMatchObject({ item: { status: 'released', released_via: 'steer' }, turn_id: pending[0]!.id });
    expect(f.store.listQueuedMessages(f.chat.id).items).toEqual([]);
    expect(f.turns().filter(turn => turn.status === 'pending')).toHaveLength(1);
  }, 120_000);

  it('steer and edits answer 409 once the turn consumed the row, and 404 for a deleted row', () => {
    const f = setup();
    const released = f.enqueue('Released by the turn').item;
    expect(released.status).toBe('released');
    expect(queueError(() => f.store.steerQueuedMessage(f.chat.id, released.id, MEMBER))).toMatchObject({ status: 409, code: 'queued_message_consumed' });
    expect(queueError(() => f.store.updateQueuedMessage(f.chat.id, released.id, MEMBER, { body_md: 'late edit' })))
      .toMatchObject({ status: 409, code: 'queued_message_consumed' });
    expect(queueError(() => f.store.deleteQueuedMessage(f.chat.id, released.id, MEMBER))).toMatchObject({ status: 409, code: 'queued_message_consumed' });
    const deleted = f.enqueue('Deleted').item;
    expect(deleted.status).toBe('queued');
    f.store.deleteQueuedMessage(f.chat.id, deleted.id, MEMBER);
    expect(queueError(() => f.store.steerQueuedMessage(f.chat.id, deleted.id, MEMBER))).toMatchObject({ status: 404, code: 'queued_message_not_found' });
    expect(queueError(() => f.store.updateQueuedMessage(f.chat.id, deleted.id, MEMBER, { body_md: 'x' }))).toMatchObject({ status: 404 });
    expect(queueError(() => f.store.steerQueuedMessage(f.chat.id, 'qmsg_missing', MEMBER))).toMatchObject({ status: 404 });
  }, 120_000);

  it('edits with an optional revision check and deletes idempotently', () => {
    const f = setup();
    f.running();
    const item = f.enqueue('Draft').item;
    const edited = f.store.updateQueuedMessage(f.chat.id, item.id, MEMBER, { body_md: 'Edited draft', expected_revision: 1 });
    expect(edited).toMatchObject({ body_md: 'Edited draft', revision: 2, status: 'queued' });
    expect(queueError(() => f.store.updateQueuedMessage(f.chat.id, item.id, MEMBER, { body_md: 'Stale', expected_revision: 1 })))
      .toMatchObject({ status: 409, code: 'revision_conflict' });
    expect(f.store.updateQueuedMessage(f.chat.id, item.id, MEMBER, { body_md: 'Unchecked' }).revision).toBe(3);
    const bob = f.store.createWorkspaceMember({ workspaceId: 'local', userId: 'bob', name: 'Bob', role: 'member' });
    expect(queueError(() => f.store.updateQueuedMessage(f.chat.id, item.id, bob.id, { body_md: 'Not yours' }))).toMatchObject({ status: 403 });
    expect(queueError(() => f.store.deleteQueuedMessage(f.chat.id, item.id, bob.id))).toMatchObject({ status: 403 });
    const removed = f.store.deleteQueuedMessage(f.chat.id, item.id, MEMBER);
    expect(removed).toMatchObject({ status: 'deleted', body_md: 'Unchecked' });
    expect(f.store.deleteQueuedMessage(f.chat.id, item.id, MEMBER)).toEqual(removed);
    expect(f.store.listQueuedMessages(f.chat.id).items).toEqual([]);
    expect(f.memberMessages().some(message => message.metadata.queued_message_id)).toBe(false);
  }, 120_000);

  it('a failed release marks the row failed, pauses the lane and stops; resolving the row continues', () => {
    const f = setup();
    const first = f.running();
    const attachment = f.store.createAttachment({ workspaceId: 'local', chatSessionId: f.chat.id, uploaderType: 'member',
      uploaderId: MEMBER, filename: 'notes.txt', url: '/uploads/notes.txt', contentType: 'text/plain', sizeBytes: 4 });
    const broken = f.enqueue('With attachment', { attachment_ids: [attachment.id] }).item;
    expect(broken.attachments).toEqual([{ id: attachment.id, filename: 'notes.txt', content_type: 'text/plain', size: 4 }]);
    const later = f.enqueue('Later').item;
    // Another message takes the attachment first, so the release send rejects it.
    const thief = f.send('Steals the attachment');
    f.db.run('UPDATE multiremi_attachments SET chat_message_id=? WHERE id=?', [thief.message.id, attachment.id]);
    f.store.completeTask(first.attemptId, { output: 'Answer' });
    const queue = f.store.listQueuedMessages(f.chat.id);
    expect(queue.paused).toMatchObject({ reason: 'send_failed' });
    expect(queue.items.map(item => [item.id, item.status])).toEqual([[broken.id, 'failed'], [later.id, 'queued']]);
    expect(queue.items[0]!.error).toContain('Attachment');
    expect(f.memberMessages().some(message => message.metadata.queued_message_id)).toBe(false);
    expect(f.store.listMessages(f.chat.id).some(message => message.dedupe_key === `queue:${broken.id}`)).toBe(false);
    // The completed turn's re-ring for the unread steer still runs; the queue does not overtake the failed row.
    const pending = f.turns().filter(turn => turn.status === 'pending');
    expect(pending).toHaveLength(1);
    f.store.cancelTurn(pending[0]!.id);
    expect(f.pause()).toMatchObject({ reason: 'send_failed' });
    // Deleting the failed row is the remedy: the queue continues by itself on the idle lane.
    f.store.deleteQueuedMessage(f.chat.id, broken.id, MEMBER);
    expect(f.pause()).toBeNull();
    expect(f.row(later.id)).toMatchObject({ status: 'released', released_via: 'turn' });
  }, 120_000);

  it('deleting a failed row in an archived Chat clears send_failed without releasing or reopening the Chat', () => {
    const f = setup();
    const first = f.running();
    const attachment = f.store.createAttachment({ workspaceId: 'local', chatSessionId: f.chat.id, uploaderType: 'member',
      uploaderId: MEMBER, filename: 'x.txt', url: '/uploads/x.txt', contentType: 'text/plain', sizeBytes: 1 });
    const broken = f.enqueue('Broken', { attachment_ids: [attachment.id] }).item;
    const later = f.enqueue('Later').item;
    const thief = f.send('Steals the attachment');
    f.db.run('UPDATE multiremi_attachments SET chat_message_id=? WHERE id=?', [thief.message.id, attachment.id]);
    f.store.completeTask(first.attemptId, { output: 'Answer' });
    expect(f.pause()).toMatchObject({ reason: 'send_failed' });
    const successor = f.turns().find(turn => turn.status === 'pending')!;
    f.store.cancelTurn(successor.id);
    f.store.updateChatSession(f.chat.id, { status: 'archived' });
    const before = f.store.listMessages(f.chat.id).length;
    // Tidying the queue stays allowed in an archived Chat.
    expect(f.store.deleteQueuedMessage(f.chat.id, broken.id, MEMBER).status).toBe('deleted');
    expect(f.pause()).toBeNull();
    expect(f.row(later.id)).toMatchObject({ status: 'queued' });
    expect(f.store.getChatSession(f.chat.id)?.status).toBe('archived');
    expect(f.store.listMessages(f.chat.id)).toHaveLength(before);
    expect(f.turns().filter(turn => turn.status === 'pending')).toEqual([]);
    expect(f.store.updateQueuedMessage(f.chat.id, later.id, MEMBER, { body_md: 'Edited while archived' }).status).toBe('queued');
    expect(f.store.getChatSession(f.chat.id)?.status).toBe('archived');
  }, 120_000);

  it('a failed steer keeps the failure and an edit resets the row to queued', () => {
    const f = setup();
    f.running();
    const attachment = f.store.createAttachment({ workspaceId: 'local', chatSessionId: f.chat.id, uploaderType: 'member',
      uploaderId: MEMBER, filename: 'a.txt', url: '/uploads/a.txt', contentType: 'text/plain', sizeBytes: 1 });
    const item = f.enqueue('Steer me', { attachment_ids: [attachment.id] }).item;
    f.db.run('DELETE FROM multiremi_attachments WHERE id=?', [attachment.id]);
    const failed = f.store.steerQueuedMessage(f.chat.id, item.id, MEMBER);
    expect(failed.message).toBeNull();
    expect(failed.item).toMatchObject({ status: 'failed' });
    expect(f.pause()).toMatchObject({ reason: 'send_failed' });
    const edited = f.store.updateQueuedMessage(f.chat.id, item.id, MEMBER, { body_md: 'Fixed', attachment_ids: [] });
    expect(edited).toMatchObject({ status: 'queued', error: null, body_md: 'Fixed' });
    // No failed row remains: the send_failed pause clears; the running turn keeps the row queued.
    expect(f.pause()).toBeNull();
    expect(f.store.listQueuedMessages(f.chat.id).items.map(entry => entry.status)).toEqual(['queued']);
  }, 120_000);

  it('dedupes a second release of the same row on the queue dedupe key', () => {
    const f = setup();
    const { item, released } = f.enqueue('Once');
    const before = f.store.listMessages(f.chat.id).length;
    f.db.run("UPDATE multiremi_queued_messages SET status='queued',released_message_id=NULL,released_via=NULL,released_at=NULL WHERE id=?", [item.id]);
    f.store.cancelTurn(released!.turn_id!);
    const again = f.store.resumeQueuedMessages(f.chat.id, MEMBER);
    expect(again.released.map(entry => entry.message.id)).toEqual([released!.message.id]);
    expect(f.store.listMessages(f.chat.id)).toHaveLength(before);
    expect(f.row(item.id)).toMatchObject({ status: 'released', released_message_id: released!.message.id });
  }, 120_000);

  it('enqueue is idempotent by client_id and validates content, attachments and the lane limit', () => {
    const f = setup();
    const idle = f.enqueue('Idle', { client_id: 'same-client' });
    const retry = f.enqueue('Different body', { client_id: 'same-client' });
    expect(retry.item.id).toBe(idle.item.id);
    expect(retry.released?.message.id).toBe(idle.released!.message.id);
    f.store.claimTask(f.runtime.id);
    expect(queueError(() => f.enqueue('   ', { client_id: 'blank' }))).toMatchObject({ status: 400, code: 'invalid_queue_input' });
    expect(queueError(() => f.enqueue('Too many', { attachment_ids: Array.from({ length: 11 }, (_, i) => `att_${i}`) })))
      .toMatchObject({ status: 400, code: 'invalid_queue_input' });
    expect(queueError(() => f.enqueue('Missing attachment', { attachment_ids: ['att_missing'] }))).toMatchObject({ status: 400 });
    const shared = f.store.createAttachment({ workspaceId: 'local', chatSessionId: f.chat.id, uploaderType: 'member',
      uploaderId: MEMBER, filename: 's.txt', url: '/uploads/s.txt', contentType: 'text/plain', sizeBytes: 1 });
    f.enqueue('Holds attachment', { attachment_ids: [shared.id] });
    expect(queueError(() => f.enqueue('Same attachment', { attachment_ids: [shared.id] }))).toMatchObject({ status: 400 });
    for (let index = f.store.listQueuedMessages(f.chat.id).items.length; index < QUEUE_MAX_LIVE_ITEMS; index++) f.enqueue(`Row ${index}`);
    expect(f.store.listQueuedMessages(f.chat.id).items).toHaveLength(QUEUE_MAX_LIVE_ITEMS);
    expect(queueError(() => f.enqueue('One too many'))).toMatchObject({ status: 400, code: 'queue_full' });
    expect(f.store.listQueuedMessages(f.chat.id).items.map(item => item.body_md).slice(0, 2)).toEqual(['Holds attachment', 'Row 1']);
  }, 120_000);

  it('rejects reuse of a deleted row client_id, inactive members and another Chat attachment', () => {
    const f = setup();
    f.running();
    const item = f.enqueue('Deleted soon', { client_id: 'reused' }).item;
    f.store.deleteQueuedMessage(f.chat.id, item.id, MEMBER);
    expect(queueError(() => f.enqueue('Again', { client_id: 'reused' }))).toMatchObject({ status: 409, code: 'queued_message_deleted' });
    const bob = f.store.createWorkspaceMember({ workspaceId: 'local', userId: 'bob', name: 'Bob', role: 'member' });
    const bobs = f.store.enqueueQueuedMessage({ session_id: f.chat.id, sender_member_id: bob.id, body_md: 'Bob row', client_id: 'bob' }).item;
    f.store.archiveWorkspaceMember(bob.id);
    for (const run of [() => f.store.updateQueuedMessage(f.chat.id, bobs.id, bob.id, { body_md: 'x' }),
      () => f.store.deleteQueuedMessage(f.chat.id, bobs.id, bob.id), () => f.store.steerQueuedMessage(f.chat.id, bobs.id, bob.id)]) {
      expect(queueError(run)).toMatchObject({ status: 403, code: 'queue_actor_required' });
    }
    const other = f.store.createChatSession({ agentId: f.agent.id });
    const foreign = f.store.createAttachment({ workspaceId: 'local', chatSessionId: other.id, uploaderType: 'member',
      uploaderId: MEMBER, filename: 'other.txt', url: '/uploads/other.txt', contentType: 'text/plain', sizeBytes: 1 });
    expect(queueError(() => f.enqueue('Other Chat file', { attachment_ids: [foreign.id] }))).toMatchObject({ status: 400, code: 'invalid_queue_input' });
    expect(queueError(() => f.store.updateQueuedMessage(f.chat.id, bobs.id, MEMBER, { body_md: 'x' }))).toMatchObject({ status: 403 });
    // A row of Chat B is not addressable through Chat A.
    const otherRow = f.store.enqueueQueuedMessage({ session_id: other.id, sender_member_id: MEMBER, body_md: 'B row', client_id: 'b' }).item;
    expect(queueError(() => f.store.deleteQueuedMessage(f.chat.id, otherRow.id, MEMBER))).toMatchObject({ status: 404 });
  }, 120_000);

  it('emits no chat:queue_updated when the transaction throws after queue writes', () => {
    const f = setup();
    const events: string[] = [];
    const unsubscribe = f.store.onWorkspaceEvent(event => { if (event.type === 'chat:queue_updated' || event.type === 'inbox:new') events.push(event.type); });
    let id = '';
    try {
      expect(() => fixture().transaction(() => {
        // Idle lane: enqueue writes the row, releases it and creates a turn, then a later step fails.
        const { item, released } = f.enqueue('Rolled back');
        id = item.id;
        expect(released).not.toBeNull();
        f.store.updateQueuedMessage(f.chat.id, item.id, MEMBER, { body_md: 'stale', expected_revision: 1 });
      })).toThrow();
    } finally { unsubscribe(); }
    expect(events).toEqual([]);
    expect(f.row(id)).toBeNull();
    expect(f.store.listMessages(f.chat.id)).toEqual([]);
    expect(f.turns()).toEqual([]);
  }, 120_000);

  it('upgrades an existing unified database once on the startup migration chain', () => {
    const f = setup();
    f.running();
    f.db.exec('DROP TABLE multiremi_queued_messages');
    for (const column of ['queue_paused_at', 'queue_pause_reason']) f.db.exec(`ALTER TABLE multiremi_session_lanes DROP COLUMN ${column}`);
    f.db.run('DELETE FROM multiremi_schema_migrations WHERE id=?', [CHAT_FOLLOW_UP_QUEUE_MIGRATION]);
    const upgraded = new MultiremiStore(f.db);
    const columns = (f.db.query('PRAGMA table_info(multiremi_session_lanes)').all() as Array<{ name: string }>).map(column => column.name);
    expect(columns).toEqual(expect.arrayContaining(['queue_paused_at', 'queue_pause_reason']));
    expect(f.db.query('SELECT id FROM multiremi_schema_migrations WHERE id=?').get(CHAT_FOLLOW_UP_QUEUE_MIGRATION)).toBeTruthy();
    // Existing lanes keep working and a second startup is a no-op.
    const item = upgraded.enqueueQueuedMessage({ session_id: f.chat.id, sender_member_id: MEMBER, body_md: 'After upgrade', client_id: 'upgrade' }).item;
    expect(item.status).toBe('queued');
    new MultiremiStore(f.db);
    expect(upgraded.listQueuedMessages(f.chat.id).items.map(entry => entry.id)).toEqual([item.id]);
  }, 120_000);

  it('rejects an archived Chat or an Issue session, and deleting the Chat removes its rows', () => {
    const f = setup();
    f.running();
    const item = f.enqueue('Kept until delete').item;
    f.store.updateChatSession(f.chat.id, { status: 'archived' });
    expect(queueError(() => f.enqueue('Archived'))).toMatchObject({ status: 409, code: 'chat_archived' });
    expect(queueError(() => f.store.resumeQueuedMessages(f.chat.id, MEMBER))).toMatchObject({ status: 409, code: 'chat_archived' });
    expect(queueError(() => f.store.steerQueuedMessage(f.chat.id, item.id, MEMBER))).toMatchObject({ status: 409, code: 'chat_archived' });
    // The archived Chat's cancelled turn neither releases nor pauses the queue.
    expect(f.store.listQueuedMessages(f.chat.id)).toMatchObject({ paused: null, items: [{ id: item.id, status: 'queued' }] });
    const issue = fixture().createIssue({ title: 'Not a Chat' });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    expect(queueError(() => f.store.listQueuedMessages(session.id))).toMatchObject({ status: 400, code: 'not_a_chat' });
    f.store.deleteChatSession(f.chat.id);
    expect(Number(f.db.query('SELECT COUNT(*) AS n FROM multiremi_queued_messages WHERE session_id=?').get(f.chat.id)?.n)).toBe(0);
  }, 120_000);
});

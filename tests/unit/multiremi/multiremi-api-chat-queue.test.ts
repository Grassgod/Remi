import { expect, it } from 'bun:test';
import { createMultiremiApp } from '@multiremi/api.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

pendingTurnBackendTests('ADR 0020 Chat follow-up queue API', fixture => {
  async function setup() {
    const { store, db } = fixture();
    store.ensureLocalWorkspace();
    const aliceMember = store.createWorkspaceMember({ workspaceId: 'local', userId: 'alice', name: 'Alice', role: 'member' });
    const bobMember = store.createWorkspaceMember({ workspaceId: 'local', userId: 'bob', name: 'Bob', role: 'admin' });
    const alice = await store.createAccessToken({ name: 'Alice', type: 'pat', userId: 'alice', workspaceId: 'local' });
    const bob = await store.createAccessToken({ name: 'Bob', type: 'pat', userId: 'bob', workspaceId: 'local' });
    const agent = store.createAgent({ name: 'Queue API', provider: 'codex', visibility: 'workspace' });
    const runtime = store.registerRuntime({ id: 'rt_queue_api', daemonId: 'daemon_queue_api', name: 'Queue API runtime', provider: 'codex', workspaceId: 'local' });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: 'alice' });
    const app = createMultiremiApp({ store, authToken: 'root-secret' });
    const request = (method: string, path: string, body?: unknown, token = alice.token) => app.request(path, {
      method, headers: { ...jsonHeaders, Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const base = `/api/sessions/${chat.id}/queue`;
    const enqueue = async (body_md: string, client_id = `client-${body_md}`, extra: Record<string, unknown> = {}) => {
      const response = await request('POST', base, { body_md, client_id, ...extra });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    };
    /** Alice's own direct message, claimed and started. */
    const running = async () => {
      const sent = await request('POST', `/api/sessions/${chat.id}/messages`, { body_md: 'Run this', to: { type: 'agent', ref: agent.id } });
      expect(sent.status).toBe(200);
      const { turn_id } = await sent.json();
      const attempt = store.claimTask(runtime.id)!;
      store.startTask(attempt.id);
      return { turnId: turn_id as string, attemptId: attempt.id };
    };
    return { store, db, app, agent, chat, runtime, alice, bob, aliceMember, bobMember, request, base, enqueue, running };
  }

  it('requires Chat creator access and a member credential', async () => {
    const f = await setup();
    const empty = await f.request('GET', f.base);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [], paused: null });
    expect((await f.request('GET', f.base, undefined, f.bob.token)).status).toBe(403);
    expect((await f.request('POST', f.base, { body_md: 'x', client_id: 'bob' }, f.bob.token)).status).toBe(403);
    expect((await f.app.request(f.base)).status).toBe(401);
    // The Chat's own task credential may read the Chat, never act on the member's queue.
    const { turnId } = await f.running();
    const task = await f.store.createAccessToken({ type: 'task', name: 'Chat task', taskId: f.store.getTurn(turnId)!.current_attempt_id!,
      agentId: f.agent.id, userId: 'alice', workspaceId: 'local' });
    for (const [method, path, body] of [['GET', f.base, undefined], ['POST', f.base, { body_md: 'agent', client_id: 'agent' }],
      ['POST', `${f.base}/resume`, {}]] as const) {
      const response = await f.request(method, path, body, task.token);
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('queue_actor_required');
    }
    const issue = fixture().createIssue({ title: 'Issue session' });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const notChat = await f.request('GET', `/api/sessions/${session.id}/queue`);
    expect(notChat.status).toBe(400);
    expect((await notChat.json()).code).toBe('not_a_chat');
  }, 120_000);

  it('validates the enqueue body and enforces the attachment and lane limits', async () => {
    const f = await setup();
    await f.running();
    for (const body of [{ body_md: 'no client' }, { client_id: 'c1' }, { body_md: 'x', client_id: 'c2', attachment_ids: 'nope' },
      { body_md: 'x', client_id: 'c3', attachment_ids: ['att_missing'] }]) {
      expect((await f.request('POST', f.base, body)).status).toBe(400);
    }
    const blank = await f.request('POST', f.base, { body_md: '  ', client_id: 'blank' });
    expect(blank.status).toBe(400);
    expect((await blank.json()).code).toBe('invalid_queue_input');
    const attachments = Array.from({ length: 11 }, (_, index) => f.store.createAttachment({ workspaceId: 'local', chatSessionId: f.chat.id,
      uploaderType: 'member', uploaderId: f.aliceMember.id, filename: `${index}.txt`, url: `/uploads/${index}.txt`, contentType: 'text/plain', sizeBytes: 1 }).id);
    const tooMany = await f.request('POST', f.base, { body_md: 'files', client_id: 'files', attachment_ids: attachments });
    expect(tooMany.status).toBe(400);
    const withFiles = await f.enqueue('files', 'files-ok', { attachment_ids: attachments.slice(0, 10) });
    expect(withFiles.item.attachments).toHaveLength(10);
    expect(withFiles.item.attachments[0]).toEqual({ id: attachments[0], filename: '0.txt', content_type: 'text/plain', size: 1 });
    for (let index = 1; index < 50; index++) f.store.enqueueQueuedMessage({ session_id: f.chat.id, sender_member_id: f.aliceMember.id, body_md: `row ${index}`, client_id: `row-${index}` });
    const full = await f.request('POST', f.base, { body_md: 'overflow', client_id: 'overflow' });
    expect(full.status).toBe(400);
    expect((await full.json()).code).toBe('queue_full');
    const listed = await (await f.request('GET', f.base)).json();
    expect(listed.items).toHaveLength(50);
    expect(Object.keys(listed.items[0]).sort()).toEqual(['attachments', 'body_md', 'client_id', 'created_at', 'error', 'id', 'released_at',
      'released_message_id', 'released_via', 'revision', 'session_id', 'status', 'updated_at']);
  }, 120_000);

  it('releases on an idle lane, is idempotent by client_id and answers 409 for an archived Chat', async () => {
    const f = await setup();
    const events: string[] = [];
    const unsubscribe = f.store.onWorkspaceEvent(event => { if (event.type === 'chat:queue_updated') events.push(String(event.payload.chat_session_id)); });
    let first;
    try { first = await f.enqueue('idle', 'idle-client'); } finally { unsubscribe(); }
    expect(events).toEqual([f.chat.id]);
    expect(first.item).toMatchObject({ status: 'released', released_via: 'turn' });
    expect(first.released.message).toMatchObject({ body_md: 'idle', wake_applied: 'now', attachments: [], reactions: [] });
    expect(first.released.message.card_token_hash).toBeUndefined();
    expect(typeof first.released.turn_id).toBe('string');
    const again = await f.enqueue('changed', 'idle-client');
    expect(again.item.id).toBe(first.item.id);
    expect(again.released.message.id).toBe(first.released.message.id);
    f.store.updateChatSession(f.chat.id, { status: 'archived' });
    const archived = await f.request('POST', f.base, { body_md: 'archived', client_id: 'archived' });
    expect(archived.status).toBe(409);
    expect((await archived.json()).code).toBe('chat_archived');
  }, 120_000);

  it('maps row operations to 403, 404 and 409 and keeps delete and steer idempotent', async () => {
    const f = await setup();
    const { attemptId } = await f.running();
    const draft = (await f.enqueue('draft')).item;
    const patched = await f.request('PATCH', `${f.base}/${draft.id}`, { body_md: 'edited', expected_revision: 1 });
    expect(patched.status).toBe(200);
    expect((await patched.json()).item).toMatchObject({ body_md: 'edited', revision: 2 });
    const stale = await f.request('PATCH', `${f.base}/${draft.id}`, { body_md: 'stale', expected_revision: 1 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('revision_conflict');
    expect((await f.request('PATCH', `${f.base}/${draft.id}`, { body_md: 'x', expected_revision: 'one' })).status).toBe(400);
    expect((await f.request('PATCH', `${f.base}/${draft.id}`, {})).status).toBe(400);
    expect((await f.request('PATCH', `${f.base}/qmsg_missing`, { body_md: 'x' })).status).toBe(404);
    // A row another member queued in this Chat stays theirs.
    const foreign = f.store.enqueueQueuedMessage({ session_id: f.chat.id, sender_member_id: f.bobMember.id, body_md: 'bob', client_id: 'bob' }).item;
    for (const [method, path] of [['PATCH', `${f.base}/${foreign.id}`], ['DELETE', `${f.base}/${foreign.id}`], ['POST', `${f.base}/${foreign.id}/steer`]] as const) {
      const response = await f.request(method, path, method === 'PATCH' ? { body_md: 'mine' } : {});
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('not_queued_message_sender');
    }
    const steered = await f.request('POST', `${f.base}/${draft.id}/steer`, {});
    expect(steered.status).toBe(200);
    const steer = await steered.json();
    expect(steer.item).toMatchObject({ status: 'released', released_via: 'steer' });
    expect(steer.message).toMatchObject({ body_md: 'edited', wake_applied: 'now', attachments: [] });
    expect(steer.turn_id).toBe(f.store.getTurnForAttempt(attemptId)!.id);
    const repeat = await (await f.request('POST', `${f.base}/${draft.id}/steer`, {})).json();
    expect(repeat.message.id).toBe(steer.message.id);
    for (const [method, path] of [['PATCH', `${f.base}/${draft.id}`], ['DELETE', `${f.base}/${draft.id}`]] as const) {
      const response = await f.request(method, path, method === 'PATCH' ? { body_md: 'late' } : undefined);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('queued_message_consumed');
    }
    const doomed = (await f.enqueue('doomed')).item;
    const deleted = await f.request('DELETE', `${f.base}/${doomed.id}`);
    expect(deleted.status).toBe(200);
    const deletedAgain = await f.request('DELETE', `${f.base}/${doomed.id}`);
    expect(deletedAgain.status).toBe(200);
    expect((await deletedAgain.json()).item).toEqual((await deleted.json()).item);
    const steerDeleted = await f.request('POST', `${f.base}/${doomed.id}/steer`, {});
    expect(steerDeleted.status).toBe(404);
    expect((await steerDeleted.json()).code).toBe('queued_message_not_found');
    // Released by the turn, not by its sender: steering it is a consumed conflict.
    // Bob withdraws his earlier row so the completion releases this one (one row per turn).
    f.store.deleteQueuedMessage(f.chat.id, foreign.id, f.bobMember.id);
    const followUp = (await f.enqueue('released by turn')).item;
    expect(followUp.status).toBe('queued');
    f.store.completeTask(attemptId, { output: 'done' });
    expect((await (await f.request('GET', f.base)).json()).items).toEqual([]);
    const consumed = await f.request('POST', `${f.base}/${followUp.id}/steer`, {});
    expect(consumed.status).toBe(409);
    expect((await consumed.json()).code).toBe('queued_message_consumed');
  }, 120_000);

  it('answers 404 for a row of another Chat and 409 for a reused deleted client_id', async () => {
    const f = await setup();
    await f.running();
    const other = f.store.createChatSession({ agentId: f.agent.id, creatorId: 'alice' });
    const foreign = (await (await f.request('POST', `/api/sessions/${other.id}/queue`, { body_md: 'chat B', client_id: 'b-1' })).json()).item;
    expect(foreign.session_id).toBe(other.id);
    for (const [method, path, body] of [['PATCH', `${f.base}/${foreign.id}`, { body_md: 'through A' }],
      ['DELETE', `${f.base}/${foreign.id}`, undefined], ['POST', `${f.base}/${foreign.id}/steer`, {}]] as const) {
      const response = await f.request(method, path, body);
      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('queued_message_not_found');
    }
    // Chat B was idle, so its row released at once; Chat A's URL left it untouched.
    expect(f.db.query('SELECT status,revision FROM multiremi_queued_messages WHERE id=?').get(foreign.id))
      .toMatchObject({ status: foreign.status, revision: foreign.revision });
    const doomed = (await f.enqueue('doomed', 'doomed-client')).item;
    expect((await f.request('DELETE', `${f.base}/${doomed.id}`)).status).toBe(200);
    const reused = await f.request('POST', f.base, { body_md: 'again', client_id: 'doomed-client' });
    expect(reused.status).toBe(409);
    expect((await reused.json()).code).toBe('queued_message_deleted');
  }, 120_000);

  it('answers 409 with the failed row when a steer cannot be sent', async () => {
    const f = await setup();
    await f.running();
    const attachment = f.store.createAttachment({ workspaceId: 'local', chatSessionId: f.chat.id, uploaderType: 'member',
      uploaderId: f.aliceMember.id, filename: 'gone.txt', url: '/uploads/gone.txt', contentType: 'text/plain', sizeBytes: 1 });
    const item = (await f.enqueue('broken', 'broken', { attachment_ids: [attachment.id] })).item;
    f.db.run('DELETE FROM multiremi_attachments WHERE id=?', [attachment.id]);
    const failed = await f.request('POST', `${f.base}/${item.id}/steer`, {});
    expect(failed.status).toBe(409);
    const body = await failed.json();
    expect(body).toMatchObject({ code: 'queued_message_send_failed', item: { id: item.id, status: 'failed' } });
    expect((await (await f.request('GET', f.base)).json()).paused).toMatchObject({ reason: 'send_failed' });
  }, 120_000);

  it('pauses on a member stop but not on the agent stopping its own turn, and resume releases one row', async () => {
    const f = await setup();
    const first = await f.running();
    const queued = (await f.enqueue('after stop')).item;
    const waiting = (await f.enqueue('waits for the next turn')).item;
    expect((await f.request('POST', `/api/turns/${first.turnId}/cancel`, {})).status).toBe(200);
    expect((await (await f.request('GET', f.base)).json()).paused).toMatchObject({ reason: 'interrupted' });
    const resumed = await f.request('POST', `${f.base}/resume`, {});
    expect(resumed.status).toBe(200);
    const result = await resumed.json();
    expect(result).toMatchObject({ paused: null, items: [{ id: waiting.id, status: 'queued' }] });
    expect(result.released.map((entry: any) => entry.message.metadata.queued_message_id)).toEqual([queued.id]);
    expect(result.released[0].message.attachments).toEqual([]);
    // The agent cancelling its own turn is not a member stop: the queue pauses as turn_ended.
    const attempt = f.store.claimTask(f.runtime.id)!;
    f.store.startTask(attempt.id);
    await f.enqueue('after agent stop');
    const task = await f.store.createAccessToken({ type: 'task', name: 'Chat task', taskId: attempt.id, agentId: f.agent.id, userId: 'alice', workspaceId: 'local' });
    expect((await f.request('POST', `/api/turns/${f.store.getTurnForAttempt(attempt.id)!.id}/cancel`, {}, task.token)).status).toBe(200);
    expect((await (await f.request('GET', f.base)).json()).paused).toMatchObject({ reason: 'turn_ended' });
  }, 120_000);
}, { isolation: "snapshot", file: import.meta.path });

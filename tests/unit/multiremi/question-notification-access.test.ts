import { beforeEach, afterEach, expect, it } from 'bun:test';
import { createMultiremiApp, startMultiremiServer } from '@multiremi/api.js';
import { createReadPool } from '@multiremi/store/db/read-pool.js';
import { createHub } from '@multiremi/api/hub/hub-core.js';
import { createLocalHubTransport } from '@multiremi/api/hub/hub-transport.js';
import { createConversationLogFillReader } from '@multiremi/api/hub/conversation-log-fill-reader.js';
import { createBrowserLogProjection } from '@multiremi/api/hub/browser-log-projection.js';
import { createResponsibleTestIssue, authenticateBrowserWebSocket } from './helpers.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('private native Q notifications', fixture => {
  let previousEncryptionKey: string | undefined;
  beforeEach(() => { previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64'); });
  afterEach(() => { if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey; });
  it('a public parent lane does not reveal the private original Q to an unrelated member', async () => {
    const { store, db, databaseUrl } = fixture();
    const humanUser = store.getOrCreateUser({ externalId: 'notification-human', name: 'Human' });
    const human = store.createWorkspaceMember({ userId: humanUser.id, name: 'Human', role: 'member' });
    const observerUser = store.getOrCreateUser({ externalId: 'notification-observer', name: 'Observer' });
    store.createWorkspaceMember({ userId: observerUser.id, name: 'Observer', role: 'member' });
    const runtime = store.registerRuntime({ name: 'Notification host', provider: 'codex', daemonId: 'notification-native', ownerId: humanUser.id });
    const worker = store.createAgent({ name: 'Private source', visibility: 'private', ownerId: humanUser.id, provider: 'codex' });
    const parent = createResponsibleTestIssue(store, { title: 'Public parent', responsibleMemberId: human.id, assigneeType: 'agent', assigneeId: worker.id });
    const child = createResponsibleTestIssue(store, { title: 'Private source work', parentIssueId: parent.id, assigneeType: 'agent', assigneeId: worker.id });
    const parentSession = store.getOrCreateDefaultIssueSession(parent.id);
    const task = store.createTask({ issueId: child.id, agentId: worker.id, prompt: 'Source' });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
    const turn = store.getTurnForAttempt(task.id)!;
    const created = store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id,
      wait_id: 'notification-private', dedupe_key: 'notification-private', body_md: 'PRIVATE-NATIVE-NOTIFICATION-BODY',
      options: [{ label: 'Allow', value: 'allow_once' }], metadata: { kind: 'permission',
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }] } },
      { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: 'local' });
    expect(created.ok).toBe(true);
    const id = String(created.message_id);
    // A normal forwarded notification retains source visibility without appointing a human.
    const notification = store.sendMessage({ session_id: parentSession.id, sender: { type: 'platform', id: null },
      to: { type: 'member', ref: human.id }, message_kind: 'request', wake_requested: 'inbox_only',
      body_md: 'PRIVATE-NATIVE-NOTIFICATION-BODY', metadata: { question_notification: true, root_question_id: id,
        question_route_revision: store.getQuestion(id)!.route_revision } }).message;
    expect(notification).toBeDefined(); expect(notification.body_md).toContain('PRIVATE-NATIVE-NOTIFICATION-BODY');
    const app = createMultiremiApp({ store, authToken: 'notification-master' });
    const rootToken = await store.createAccessToken({ type: 'pat', name: 'Human', userId: humanUser.id, workspaceId: 'local' });
    const observerToken = await store.createAccessToken({ type: 'pat', name: 'Observer', userId: observerUser.id, workspaceId: 'local' });
    const get = (path: string, token: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    expect((await get(`/api/messages/${id}/question`, rootToken.token)).status).toBe(200);
    expect((await get(`/api/messages/${notification.id}`, rootToken.token)).status).toBe(200);
    expect((await get(`/api/messages/${id}/question`, observerToken.token)).status).toBe(404);
    expect((await get(`/api/messages/${notification.id}`, observerToken.token)).status).toBe(404);
    expect((await get(`/api/messages/${id}`, rootToken.token)).status).toBe(200);
    const rootInbox = await (await get('/api/inbox?limit=1', rootToken.token)).json() as any;
    expect(rootInbox.items.map((row: any) => row.id)).toEqual([notification.id]);
    expect(rootInbox).toMatchObject({ unread_count: 1, attention_count: 0, next_cursor: null });
    expect(await (await get('/api/inbox?limit=1', observerToken.token)).json()).toMatchObject({ items: [], unread_count: 0, attention_count: 0, next_cursor: null });
    const missing = store.sendMessage({ session_id: parentSession.id, sender: { type: 'platform', id: null }, to: { type: 'member', ref: human.id },
      message_kind: 'request', wake_requested: 'inbox_only', body_md: 'PRIVATE-MISSING-Q',
      metadata: { question_notification: true, root_question_id: 'cmt_missing', question_route_revision: 1 } }).message;
    const ordinary = store.sendMessage({ session_id: parentSession.id, sender: { type: 'platform', id: null }, to: { type: 'member', ref: human.id },
      message_kind: 'decision', wake_requested: 'inbox_only', body_md: 'Ordinary choice', options: [{ label: 'Yes', value: 'yes' }] }).message;
    const notQuestion = store.sendMessage({ session_id: parentSession.id, sender: { type: 'platform', id: null }, to: { type: 'member', ref: human.id },
      message_kind: 'request', wake_requested: 'inbox_only', body_md: 'PRIVATE-NON-Q',
      metadata: { question_present_request: true, root_question_id: ordinary.id, question_route_revision: 1 } }).message;
    for (const row of [missing, notQuestion]) expect((await get(`/api/messages/${row.id}`, rootToken.token)).status).toBe(404);
    const page = await (await get('/api/inbox?limit=1', rootToken.token)).json() as any;
    expect(page.items.map((row: any) => row.id)).toEqual([ordinary.id]); expect(page.unread_count).toBe(2);
    const next = await (await get(`/api/inbox?limit=1&cursor=${page.next_cursor}`, rootToken.token)).json() as any;
    expect(next.items.map((row: any) => row.id)).toEqual([notification.id]); expect(next.unread_count).toBe(2); expect(next.next_cursor).toBeNull();

    const pool = createReadPool({ databaseUrl, sqliteDb: db });
    const projected = await createBrowserLogProjection(store, pool)({ data: { kind: 'browser', authenticated: true,
      workspaceId: 'local', userId: humanUser.id } } as any, parentSession.id,
      [{ seq: notification.seq, kind: 'entry', payload: store.getConversationLogEntryById(notification.id)! }]);
    expect(projected[0]?.payload).toMatchObject({ visibility: 'shown' });
    const hub = createHub({ transport: createLocalHubTransport(), fill: createConversationLogFillReader(store, pool) });
    const detach = store.subscribeConversationLog({ onEntry: (session, row) => { hub.onEntry(session, 'target_seq' in row ? { ...row, session_id: session } : row); hub.flushNow(); } });
    const server = startMultiremiServer({ store, liveHub: hub, readPool: pool, authToken: 'notification-master', scheduler: null, port: 0, hostname: '127.0.0.1' });
    const sockets: WebSocket[] = [];
    const wait = async (check: () => boolean, label: string) => {
      const deadline = Date.now() + 2500;
      while (!check()) { if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`); await Bun.sleep(10); }
    };
    const connect = async (token: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=local`); sockets.push(socket);
      const events: any[] = []; socket.addEventListener('message', event => events.push(JSON.parse(String(event.data))));
      await authenticateBrowserWebSocket(socket, token);
      const frames = () => events.filter(event => event.type === 'stream.data').flatMap(event => event.payload.frames);
      socket.send(JSON.stringify({ type: 'stream.subscribe', payload: { stream: 'log', id: parentSession.id, from_seq: 0 } }));
      try { await wait(() => frames().some(frame => frame.seq === notQuestion.seq), 'notification replay'); }
      catch { throw new Error(JSON.stringify({ events: events.map(event => ({ type: event.type, code: event.payload?.code,
        seqs: event.payload?.frames?.map((frame: any) => frame.seq) })) })); }
      return { frames };
    };
    try {
      const rootSocket = await connect(rootToken.token), observerSocket = await connect(observerToken.token);
      expect(rootSocket.frames().find(frame => frame.seq === notification.seq)?.payload).toMatchObject({ visibility: 'shown', body_md: notification.body_md });
      for (const row of [notification, missing, notQuestion]) expect(observerSocket.frames().find(frame => frame.seq === row.seq)?.payload).toMatchObject({ visibility: 'hidden' });
      expect(JSON.stringify(observerSocket.frames())).not.toContain('PRIVATE');
      fixture().transaction(() => store.updateConversationLogWithinTransaction(parentSession.id, notification.seq,
        { fields: { body_md: 'PRIVATE-NATIVE-NOTIFICATION-UPDATE' } }));
      hub.flushNow();
      await wait(() => rootSocket.frames().some(frame => frame.kind === 'patch' && frame.seq === notification.seq && frame.payload.revision === notification.revision + 1), 'authorized notification patch');
      await wait(() => observerSocket.frames().some(frame => frame.seq === notification.seq && frame.payload.revision === notification.revision + 1), 'hidden notification patch');
      expect(JSON.stringify(observerSocket.frames())).not.toContain('PRIVATE');
      const marker = store.appendConversationLog({ sessionId: parentSession.id, kind: 'message_edited', authorType: 'system',
        metadata: { target_seq: notification.seq, previous_body: 'PRIVATE-NATIVE-NOTIFICATION-BODY' } });
      hub.flushNow();
      await wait(() => rootSocket.frames().some(frame => frame.seq === marker.seq), 'authorized notification edit history');
      await wait(() => observerSocket.frames().some(frame => frame.seq === marker.seq), 'hidden notification edit history');
      expect(rootSocket.frames().find(frame => frame.seq === marker.seq)?.payload).toMatchObject({ id: marker.id,
        metadata: { previous_body: 'PRIVATE-NATIVE-NOTIFICATION-BODY' } });
      expect(observerSocket.frames().find(frame => frame.seq === marker.seq)?.payload).toMatchObject({ visibility: 'hidden' });
      expect(observerSocket.frames().find(frame => frame.seq === marker.seq)?.payload).not.toHaveProperty('metadata');
      expect(JSON.stringify(observerSocket.frames())).not.toContain('PRIVATE');
      // Lifecycle markers remain unlocatable; the authorized WS still receives
      // their full history while the observer receives only the sequence hole.
      for (const token of [rootToken.token, observerToken.token])
        expect((await get(`/api/sessions/${parentSession.id}/log/entry?id=${marker.id}`, token)).status).toBe(404);
      const related = store.sendMessage({ session_id: parentSession.id, sender: { type: 'platform', id: null },
        to: { type: 'member', ref: human.id }, message_kind: 'status', wake_requested: 'inbox_only', reply_to_id: notification.id,
        body_md: 'PRIVATE-NATIVE-NOTIFICATION-REPLY' }).message;
      expect((await get(`/api/messages/${related.id}`, rootToken.token)).status).toBe(200);
      expect((await get(`/api/messages/${related.id}`, observerToken.token)).status).toBe(404);
      const after = await (await get('/api/inbox?limit=1', observerToken.token)).json() as any;
      expect(after).toMatchObject({ items: [], unread_count: 0, attention_count: 0, next_cursor: null });
      const rootAfter = await (await get('/api/inbox?limit=1', rootToken.token)).json() as any;
      expect(rootAfter.items.map((row: any) => row.id)).toEqual([related.id]); expect(rootAfter.unread_count).toBe(3);
    } finally { sockets.forEach(socket => socket.close()); server.stop(true); detach(); hub.shutdown(); await pool.close(); }
  }, 20_000);
  it('native Issue questions do not appoint Remi or borrow its token owner as an answerer', async () => {
    const { store, db } = fixture();
    const user = store.getOrCreateUser({ externalId: 'native-source-owner', name: 'Source owner' });
    const human = store.createWorkspaceMember({ userId: user.id, name: 'Source owner', role: 'member' });
    const runtime = store.registerRuntime({ name: 'Native presenter host', provider: 'codex', daemonId: 'native-presenter', maxConcurrency: 8, ownerId: user.id });
    const worker = store.createAgent({ name: 'Private source', provider: 'codex', visibility: 'private', ownerId: user.id });
    const remi = store.createAgent({ name: 'Remi', provider: 'codex', visibility: 'workspace', ownerId: user.id, maxConcurrentTasks: 8 });
    store.upsertFeishuBotConfig('local', { agentId: remi.id, runtimeId: runtime.id, appId: 'cli_native_presenter', enabled: false,
      appSecretOp: 'set', appSecret: 'synthetic-only', domain: 'feishu' });
    const issue = store.createIssue({ title: 'Native permission', assigneeType: 'agent', assigneeId: worker.id });
    const task = store.createTask({ agentId: worker.id, issueId: issue.id, prompt: 'Original source' });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
    const turn = store.getTurnForAttempt(task.id)!;
    const created = store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id,
      wait_id: 'native-source-permission', dedupe_key: 'native-source-permission', body_md: 'PRIVATE-NATIVE-PERMISSION',
      options: [{ label: 'Allow', value: 'allow_once' }], metadata: { kind: 'permission',
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }] } },
      { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: 'local' });
    expect(created.ok).toBe(true); const id = String(created.message_id);
    expect(store.getQuestion(id)).toMatchObject({ stage: 'human', current_handler: null });
    const presented = store.claimTask(runtime.id)!;
    expect(presented.agentId).toBe(remi.id); store.startTask(presented.id);
    const presentationCredential = await store.createTaskAccessToken(store.getTask(presented.id)!, user.id);
    const unrelatedMessage = store.sendMessage({ session_id: store.getOrCreateDefaultIssueSession(issue.id).id, sender: { type: 'platform', id: null },
      to: { type: 'agent', ref: remi.id }, message_kind: 'request', wake_requested: 'now', execution_scope: 'unrelated-remi', body_md: 'Unrelated Remi work' });
    const unrelatedTurn = store.getTurn(unrelatedMessage.turn_id!)!;
    const unrelated = store.getTask(unrelatedTurn.current_attempt_id!)!;
    expect(unrelatedTurn.execution_scope).toBe('unrelated-remi');
    db.run("UPDATE multiremi_turns SET status='running' WHERE id=?", [unrelatedTurn.id]);
    db.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?", [unrelated.id]);
    const credential = await store.createTaskAccessToken(store.getTask(unrelated.id)!, user.id);
    const app = createMultiremiApp({ store, authToken: 'native-presenter-master' });
    const request = (path: string, token: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    expect((await request(`/api/messages/${id}/question`, credential.token)).status).toBe(403);
    expect((await request(`/api/messages/${id}/question`, presentationCredential.token)).status).toBe(200);
    const present = await app.request(`/api/messages/${id}/question/present`, { method: 'POST',
      headers: { Authorization: `Bearer ${presentationCredential.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_route_revision: 1, summary: 'Present the same native question' }) });
    expect(present.status).toBe(200);
    const answer = await app.request(`/api/messages/${id}/question/answer`, { method: 'POST',
      headers: { Authorization: `Bearer ${presentationCredential.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_route_revision: 1, response: { answer: 'Allow' } }) });
    expect(answer.status).toBe(403);
    const humanCredential = await store.createAccessToken({ type: 'pat', name: 'Source user', userId: user.id, workspaceId: 'local' });
    const question = await (await request(`/api/messages/${id}/question`, humanCredential.token)).json() as any;
    expect(question.question.actions.allowed).toContain('answer');
    expect(store.getWorkspaceMember(human.id)?.userId).toBe(user.id);
  });
});

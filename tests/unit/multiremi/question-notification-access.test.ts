import { expect, it } from 'bun:test';
import { createMultiremiApp, startMultiremiServer } from '@multiremi/api.js';
import { createReadPool } from '@multiremi/store/db/read-pool.js';
import { createHub } from '@multiremi/api/hub/hub-core.js';
import { createLocalHubTransport } from '@multiremi/api/hub/hub-transport.js';
import { createConversationLogFillReader } from '@multiremi/api/hub/conversation-log-fill-reader.js';
import { createBrowserLogProjection } from '@multiremi/api/hub/browser-log-projection.js';
import { createResponsibleTestIssue, authenticateBrowserWebSocket } from './helpers.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('private native Q notifications', fixture => {
  it('a public parent lane does not reveal the private original Q to an unrelated member', async () => {
    const { store, db, databaseUrl } = fixture();
    const humanUser = store.getOrCreateUser({ externalId: 'notification-human', name: 'Human' });
    const human = store.createWorkspaceMember({ userId: humanUser.id, name: 'Human', role: 'member' });
    const observerUser = store.getOrCreateUser({ externalId: 'notification-observer', name: 'Observer' });
    store.createWorkspaceMember({ userId: observerUser.id, name: 'Observer', role: 'member' });
    const runtime = store.registerRuntime({ name: 'Notification host', provider: 'codex', daemonId: 'notification-native' });
    const worker = store.createAgent({ name: 'Private source', visibility: 'private', ownerId: 'local', provider: 'codex' });
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
    const notification = store.listMessages(parentSession.id).find(row => row.metadata.question_notification && row.metadata.root_question_id === id)!;
    expect(notification).toBeDefined(); expect(notification.body_md).toContain('PRIVATE-NATIVE-NOTIFICATION-BODY');
    const app = createMultiremiApp({ store, authToken: 'notification-master' });
    const rootToken = await store.createAccessToken({ type: 'pat', name: 'Human', userId: humanUser.id, workspaceId: 'local' });
    const observerToken = await store.createAccessToken({ type: 'pat', name: 'Observer', userId: observerUser.id, workspaceId: 'local' });
    const get = (path: string, token: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    expect((await get(`/api/messages/${id}/question`, rootToken.token)).status).toBe(200);
    expect((await get(`/api/messages/${notification.id}`, rootToken.token)).status).toBe(200);
    expect((await get(`/api/messages/${id}/question`, observerToken.token)).status).toBe(404);
    expect((await get(`/api/messages/${notification.id}`, observerToken.token)).status).toBe(404);
    expect((await get(`/api/messages/${id}`, rootToken.token)).status).toBe(404);
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
  it('Remi reads and presents from the actual current notification scope without inheriting its human token owner', async () => {
    const { store } = fixture();
    const previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const user = store.getOrCreateUser({ externalId: 'presenter-root', name: 'Root' });
      const human = store.createWorkspaceMember({ userId: user.id, name: 'Root', role: 'member' });
      const runtime = store.registerRuntime({ name: 'Presenter host', provider: 'codex', daemonId: 'notification-presenter', maxConcurrency: 16 });
      const worker = store.createAgent({ name: 'Private source', provider: 'codex', visibility: 'private', ownerId: 'local', runtimeId: runtime.id });
      const remi = store.createAgent({ name: 'Presenter', provider: 'codex', maxConcurrentTasks: 8, runtimeId: runtime.id });
      store.upsertFeishuBotConfig('local', { agentId: remi.id, runtimeId: runtime.id, appId: 'cli_notification_test', enabled: false,
        appSecretOp: 'set', appSecret: 'synthetic-only', domain: 'feishu', responsibleMemberId: human.id });
      const issue = createResponsibleTestIssue(store, { title: 'Private question for root', assigneeType: 'agent', assigneeId: worker.id, responsibleMemberId: human.id });
      const session = store.getOrCreateDefaultIssueSession(issue.id);
      const task = store.createTask({ agentId: worker.id, issueId: issue.id, prompt: 'Private question' });
      expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
      const turn = store.getTurnForAttempt(task.id)!;
      const created = store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id,
        wait_id: 'presenter-private', dedupe_key: 'presenter-private', body_md: 'PRIVATE-PRESENTER-QUESTION',
        options: [{ label: 'Allow', value: 'allow_once' }], metadata: { kind: 'permission', options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }] } },
        { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: 'local' });
      expect(created.ok).toBe(true); const id = String(created.message_id);
      const notification = store.listMessages(session.id).find(row => row.metadata.question_present_request && row.metadata.root_question_id === id)!;
      const notified = store.claimTask(runtime.id)!; expect(notified.agentId).toBe(remi.id); store.startTask(notified.id);
      const credential = await store.createTaskAccessToken(store.getTask(notified.id)!, user.id);
      const app = createMultiremiApp({ store, authToken: 'presenter-master' });
      const call = (path: string, token: string, body?: unknown) => app.request(path, { method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect((await call(`/api/messages/${notification.id}`, credential.token)).status).toBe(200);
      expect((await call(`/api/messages/${id}/question`, credential.token)).status).toBe(200);
      expect((await call(`/api/messages/${id}`, credential.token)).status).toBe(404);
      const side = store.sendMessage({ session_id: session.id, execution_scope: 'unrelated-presenter-scope',
        sender: { type: 'member', id: human.id }, to: { type: 'agent', ref: remi.id }, message_kind: 'request', wake_requested: 'now', body_md: 'Unrelated work' });
      const sideTask = store.claimTask(runtime.id)!; expect(sideTask.id).toBe(store.getTurn(side.turn_id!)!.current_attempt_id!); store.startTask(sideTask.id);
      const wrong = await store.createTaskAccessToken(store.getTask(sideTask.id)!, user.id);
      expect((await call(`/api/messages/${notification.id}`, wrong.token)).status).toBe(404);
      expect((await call(`/api/messages/${id}/question`, wrong.token)).status).toBe(403);
      expect((await call(`/api/messages/${id}/question/present`, credential.token,
        { expected_route_revision: 1, summary: 'Same Q, authorized presenter.' })).status).toBe(200);
      expect(store.getQuestion(id)?.summary?.agent_id).toBe(remi.id);
      const rootToken = await store.createAccessToken({ type: 'pat', name: 'Root', userId: user.id, workspaceId: 'local' });
      store.updateIssue(issue.id, { responsibleMemberId: 'mem_local_local', actorType: 'member', actorId: human.id });
      expect((await call(`/api/messages/${notification.id}`, credential.token)).status).toBe(404);
      expect((await call(`/api/messages/${notification.id}`, rootToken.token)).status).toBe(404);
      expect((await call(`/api/messages/${id}/question`, rootToken.token)).status).toBe(404);
      expect(store.getMessage(notification.id)).not.toBeNull();
    } finally { if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey; }
  }, 20_000);
});

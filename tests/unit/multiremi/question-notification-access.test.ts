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
  it('an Agent-step notification never reveals the private original Q to members; the human stage is shared', async () => {
    const { store, db, databaseUrl } = fixture();
    const humanUser = store.getOrCreateUser({ externalId: 'notification-human', name: 'Human' });
    const human = store.createWorkspaceMember({ userId: humanUser.id, name: 'Human', role: 'member' });
    const observerUser = store.getOrCreateUser({ externalId: 'notification-observer', name: 'Observer' });
    store.createWorkspaceMember({ userId: observerUser.id, name: 'Observer', role: 'member' });
    const runtime = store.registerRuntime({ name: 'Notification host', provider: 'codex', daemonId: 'notification-native' });
    const worker = store.createAgent({ name: 'Private source', visibility: 'private', ownerId: 'local', provider: 'codex' });
    const leader = store.createAgent({ name: 'Public parent owner', provider: 'codex' });
    const parent = createResponsibleTestIssue(store, { title: 'Public parent', createdBy: humanUser.id, assigneeType: 'agent', assigneeId: leader.id });
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
    // The permission request goes to the parent's execution owner first, in the parent's Main.
    const notification = store.listMessages(parentSession.id).find(row => row.metadata.question_notification && row.metadata.root_question_id === id)!;
    expect(notification).toMatchObject({ to_agent_id: leader.id, to_member_id: null });
    expect(notification.body_md).toContain('PRIVATE-NATIVE-NOTIFICATION-BODY');
    const app = createMultiremiApp({ store, authToken: 'notification-master' });
    const humanToken = await store.createAccessToken({ type: 'pat', name: 'Human', userId: humanUser.id, workspaceId: 'local' });
    const observerToken = await store.createAccessToken({ type: 'pat', name: 'Observer', userId: observerUser.id, workspaceId: 'local' });
    const get = (path: string, token: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    for (const token of [humanToken.token, observerToken.token]) {
      // At the Agent stage a member reads only through the original (private) conversation.
      expect((await get(`/api/messages/${id}/question`, token)).status).toBe(404);
      expect((await get(`/api/messages/${notification.id}`, token)).status).toBe(404);
      expect((await get(`/api/messages/${id}`, token)).status).toBe(404);
      expect(await (await get('/api/inbox?limit=1', token)).json()).toMatchObject({ items: [], unread_count: 0, attention_count: 0, next_cursor: null });
    }
    const missing = store.sendMessage({ session_id: parentSession.id, sender: { type: 'platform', id: null }, to: { type: 'member', ref: human.id },
      message_kind: 'request', wake_requested: 'inbox_only', body_md: 'PRIVATE-MISSING-Q',
      metadata: { question_notification: true, root_question_id: 'cmt_missing', question_route_revision: 1 } }).message;
    const ordinary = store.sendMessage({ session_id: parentSession.id, sender: { type: 'platform', id: null }, to: { type: 'member', ref: human.id },
      message_kind: 'decision', wake_requested: 'inbox_only', body_md: 'Ordinary choice', options: [{ label: 'Yes', value: 'yes' }] }).message;
    const notQuestion = store.sendMessage({ session_id: parentSession.id, sender: { type: 'platform', id: null }, to: { type: 'member', ref: human.id },
      message_kind: 'request', wake_requested: 'inbox_only', body_md: 'PRIVATE-NON-Q',
      metadata: { question_present_request: true, root_question_id: ordinary.id, question_route_revision: 1 } }).message;
    for (const row of [missing, notQuestion]) expect((await get(`/api/messages/${row.id}`, humanToken.token)).status).toBe(404);
    const page = await (await get('/api/inbox?limit=5', humanToken.token)).json() as any;
    expect(page.items.map((row: any) => row.id)).toEqual([ordinary.id]); expect(page.unread_count).toBe(1);

    const pool = createReadPool({ databaseUrl, sqliteDb: db });
    const projected = await createBrowserLogProjection(store, pool)({ data: { kind: 'browser', authenticated: true,
      workspaceId: 'local', userId: humanUser.id } } as any, parentSession.id,
      [{ seq: notification.seq, kind: 'entry', payload: store.getConversationLogEntryById(notification.id)! }]);
    expect(projected[0]?.payload).toMatchObject({ visibility: 'hidden' });
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
      const humanSocket = await connect(humanToken.token), observerSocket = await connect(observerToken.token);
      for (const socket of [humanSocket, observerSocket]) {
        for (const row of [notification, missing, notQuestion]) expect(socket.frames().find(frame => frame.seq === row.seq)?.payload).toMatchObject({ visibility: 'hidden' });
        expect(JSON.stringify(socket.frames())).not.toContain('PRIVATE');
      }
      fixture().transaction(() => store.updateConversationLogWithinTransaction(parentSession.id, notification.seq,
        { fields: { body_md: 'PRIVATE-NATIVE-NOTIFICATION-UPDATE' } }));
      hub.flushNow();
      for (const [socket, label] of [[humanSocket, 'human'], [observerSocket, 'observer']] as const) {
        await wait(() => socket.frames().some(frame => frame.seq === notification.seq && frame.payload.revision === notification.revision + 1), `${label} hidden notification patch`);
        expect(JSON.stringify(socket.frames())).not.toContain('PRIVATE');
      }
      const marker = store.appendConversationLog({ sessionId: parentSession.id, kind: 'message_edited', authorType: 'system',
        metadata: { target_seq: notification.seq, previous_body: 'PRIVATE-NATIVE-NOTIFICATION-BODY' } });
      hub.flushNow();
      for (const [socket, label] of [[humanSocket, 'human'], [observerSocket, 'observer']] as const) {
        await wait(() => socket.frames().some(frame => frame.seq === marker.seq), `${label} hidden notification edit history`);
        expect(socket.frames().find(frame => frame.seq === marker.seq)?.payload).toMatchObject({ visibility: 'hidden' });
        expect(socket.frames().find(frame => frame.seq === marker.seq)?.payload).not.toHaveProperty('metadata');
        expect(JSON.stringify(socket.frames())).not.toContain('PRIVATE');
      }
      for (const token of [humanToken.token, observerToken.token])
        expect((await get(`/api/sessions/${parentSession.id}/log/entry?id=${marker.id}`, token)).status).toBe(404);
    } finally { sockets.forEach(socket => socket.close()); server.stop(true); detach(); hub.shutdown(); await pool.close(); }

    // The parent owner escalates: at the human stage any active member reads the Q,
    // and the root creator is reminded in the source Issue's Main.
    db.run("UPDATE multiremi_turns SET status='running' WHERE agent_id=? AND status IN ('pending','running')", [leader.id]);
    const leaderTurn = db.query("SELECT id FROM multiremi_turns WHERE agent_id=? AND status='running' ORDER BY created_at DESC LIMIT 1").get(leader.id)!;
    expect(store.escalateQuestion(id, { expected_route_revision: 1, reason: 'Members decide permissions here' }, { type: 'agent', id: leader.id }, String(leaderTurn.id)))
      .toMatchObject({ stage: 'human', current_handler: null, route_revision: 2 });
    const reminder = store.listMessages(store.getOrCreateDefaultIssueSession(child.id).id)
      .find(row => row.metadata.question_notification === true && row.metadata.root_question_id === id && row.to_member_id === human.id)!;
    expect(reminder).toMatchObject({ dedupe_key: `question-route:${id}:2:${human.id}`, to_agent_id: null });
    for (const token of [humanToken.token, observerToken.token]) {
      expect((await get(`/api/messages/${id}/question`, token)).status).toBe(200);
      expect((await get(`/api/messages/${reminder.id}`, token)).status).toBe(200);
      expect((await get(`/api/messages/${notification.id}`, token)).status).toBe(404);
    }
    expect(((await (await get('/api/inbox?limit=5', humanToken.token)).json()) as any).items.map((row: any) => row.id)).toContain(reminder.id);
    expect(((await (await get('/api/inbox?limit=5', observerToken.token)).json()) as any).items).toEqual([]);
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
      const issue = createResponsibleTestIssue(store, { title: 'Private question for root', assigneeType: 'agent', assigneeId: worker.id });
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
      // The present request belongs to Remi's lane: the member behind the task token reads
      // the shared human-stage Q, never the Agent-addressed request.
      const memberToken = await store.createAccessToken({ type: 'pat', name: 'Member', userId: user.id, workspaceId: 'local' });
      expect((await call(`/api/messages/${notification.id}`, memberToken.token)).status).toBe(404);
      expect((await call(`/api/messages/${id}/question`, memberToken.token)).status).toBe(200);
      // A re-route moves the Q to a new revision; the old present request no longer grants the Remi lane access.
      store.updateIssue(issue.id, { assigneeType: 'agent', assigneeId: store.createAgent({ name: 'Replacement owner', provider: 'codex' }).id,
        actorType: 'member', actorId: human.id });
      expect(store.getQuestion(id)).toMatchObject({ stage: 'human', route_revision: 2 });
      expect((await call(`/api/messages/${notification.id}`, credential.token)).status).toBe(404);
      expect(store.getMessage(notification.id)).not.toBeNull();
    } finally { if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey; }
  }, 20_000);
});

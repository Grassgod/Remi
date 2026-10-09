import { expect, it } from 'bun:test';
import { createMultiremiApp } from '@multiremi/api.js';
import { MultiremiStore } from '@multiremi/store.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('explicit Issue workspace Main rotation', (fixture, backend) => {
  for (const prefix of ['/api/issues', '/api/multiremi/issues']) {
    it(`${prefix} preserves source history, creates a target Main and rolls back a failed dispatch`, async () => {
      const { store, db } = fixture();
      const sourceAgent = store.createAgent({ name: 'Source execution', provider: 'codex' });
      const issue = store.createIssue({ title: 'Movable Issue', responsibleMemberId: 'mem_local_local', assigneeType: 'agent', assigneeId: sourceAgent.id });
      const sourceMain = store.getOrCreateDefaultIssueSession(issue.id);
      const oldComment = store.createIssueComment(issue.id, { body: 'SOURCE_ONLY_PRIVATE_HISTORY' });
      const runtime = store.registerRuntime({ name: 'Source Q Runtime', provider: 'codex', daemonId: 'rotation-source', maxConcurrency: 8 });
      const sourceTask = store.createTask({ agentId: sourceAgent.id, issueId: issue.id, prompt: 'SOURCE_ONLY_PRIVATE_TASK' });
      expect(store.claimTask(runtime.id)?.id).toBe(sourceTask.id);
      store.startTask(sourceTask.id);
      const sourceTurn = store.getTurnForAttempt(sourceTask.id)!;
      const decision = store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: sourceTurn.id, attempt_id: sourceTask.id,
        dedupe_key: 'move-source-question', body_md: 'SOURCE_ONLY_PRIVATE_QUESTION', options: [{ label: 'A', value: 'A' }],
        metadata: { kind: 'question' }, timeout_ms: 1_000,
      }, { runtimeId: runtime.id, daemonId: 'rotation-source', workspaceId: 'local' });
      expect(decision.ok).toBeTrue();
      const questionId = String(decision.message_id);
      const oldDelivery = store.submitIssueDelivery(issue.id, { summary: 'SOURCE_ONLY_PRIVATE_FORMAL_DELIVERY' },
        { type: 'agent', id: sourceAgent.id, taskId: sourceTask.id });
      // Cancellation can append a detached-Q status notification after the
      // first task snapshot. Stop that real notification too before moving.
      for (let pass = 0; pass < 3; pass++) for (const task of store.listTasksForIssue(issue.id)) {
        if (!['completed', 'failed', 'cancelled'].includes(task.status)) store.cancelTask(task.id);
      }
      expect(store.listTasksForIssue(issue.id).every(task => ['completed', 'failed', 'cancelled'].includes(task.status))).toBeTrue();
      const target = store.createWorkspace({ name: 'Target workspace', slug: `main-rotation-${prefix.includes('multiremi') ? 'native' : 'compat'}` });
      const targetUser = store.getOrCreateUser({ externalId: 'main-rotation-target-user', name: 'Target reader' });
      const targetHuman = store.createWorkspaceMember({ workspaceId: target.id, userId: targetUser.id, name: 'Target reader', role: 'owner' });
      const targetAgent = store.createAgent({ name: 'Target execution', provider: 'codex', workspaceId: target.id });
      const app = createMultiremiApp({ store, authToken: 'MASTER', shareSecret: 'main-rotation-share' });
      const move = () => app.request(`${prefix}/${issue.id}`, { method: 'PATCH', headers: { Authorization: 'Bearer MASTER', 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: target.id, responsible_member_id: targetHuman.id, assignee_type: 'agent', assignee_id: targetAgent.id }) });
      const oldQuestion = store.getMessage(questionId)!;
      const beforeMove = store.getIssue(issue.id)!;
      const beforeMain = store.getIssueSession(sourceMain.id)!;
      db.run('UPDATE multiremi_issue_activity SET workspace_id=NULL WHERE issue_id=? AND body=?', [issue.id, oldComment.body]);
      const beforeOrigins = db.query('SELECT id,workspace_id FROM multiremi_issue_activity WHERE issue_id=? ORDER BY id').all(issue.id);
      const oldActivity = store.listIssueActivity(issue.id);
      const events: unknown[] = [];
      store.onWorkspaceEvent(event => events.push(event));
      if (backend === 'PostgreSQL') {
        db.run(`CREATE FUNCTION reject_rotation_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.agent_id='${targetAgent.id}' THEN RAISE EXCEPTION 'rotation dispatch fault'; END IF; RETURN NEW; END $$`);
        db.exec('CREATE TRIGGER reject_rotation_dispatch BEFORE INSERT ON multiremi_turns FOR EACH ROW EXECUTE FUNCTION reject_rotation_dispatch()');
      } else db.exec(`CREATE TRIGGER reject_rotation_dispatch BEFORE INSERT ON multiremi_turns WHEN NEW.agent_id='${targetAgent.id}' BEGIN SELECT RAISE(ABORT,'rotation dispatch fault'); END`);
      const failed = await move();
      expect(failed.status, await failed.clone().text()).toBe(500);
      expect(await failed.text()).toContain('rotation dispatch fault');
      expect(store.getIssue(issue.id)).toEqual(beforeMove);
      expect(store.getIssueSession(sourceMain.id)).toEqual(beforeMain);
      expect(store.listIssueSessions(issue.id, true).map(session => session.id)).toEqual([sourceMain.id]);
      expect(store.listIssueActivity(issue.id)).toEqual(oldActivity);
      expect(db.query('SELECT id,workspace_id FROM multiremi_issue_activity WHERE issue_id=? ORDER BY id').all(issue.id)).toEqual(beforeOrigins);
      expect(store.getMessage(questionId)).toEqual(oldQuestion);
      expect(db.query('SELECT session_id FROM multiremi_conversation_heads WHERE workspace_id=?').all(target.id)).toEqual([]);
      expect(events).toEqual([]);
      if (backend === 'PostgreSQL') db.exec('DROP TRIGGER reject_rotation_dispatch ON multiremi_turns');
      else db.exec('DROP TRIGGER reject_rotation_dispatch');
      const moved = await move();
      expect(moved.status, await moved.clone().text()).toBe(200);
      const main = store.getOrCreateDefaultIssueSession(issue.id);
      expect(main.id).not.toBe(sourceMain.id);
      expect(main).toMatchObject({ workspaceId: target.id, isDefault: true, parentSessionId: null, inheritMode: 'none' });
      expect(store.getIssueSession(sourceMain.id)).toMatchObject({ workspaceId: 'local', isDefault: false });
      expect(store.getMessage(oldComment.id)?.body_md).toBe('SOURCE_ONLY_PRIVATE_HISTORY');
      expect(store.getMessage(questionId)?.session_id).toBe(sourceMain.id);
      expect(store.getMessage(oldDelivery.id)?.body_md).toBe('SOURCE_ONLY_PRIVATE_FORMAL_DELIVERY');
      expect(store.listIssueDeliveries(issue.id)).toEqual([]);
      expect(store.getTask(sourceTask.id)).toMatchObject({ workspaceId: 'local', issueSessionId: sourceMain.id, status: 'cancelled' });
      expect(store.listTasksForIssue(issue.id)).toHaveLength(1);
      expect(store.listTasksForIssue(issue.id)[0]).toMatchObject({ agentId: targetAgent.id, workspaceId: target.id, issueSessionId: main.id });
      expect(store.listIssueActivity(issue.id).filter(entry => entry.type === 'issue_main_session_rotated')).toHaveLength(1);
      const targetToken = await store.createAccessToken({ type: 'pat', name: 'Target reader PAT', workspaceId: target.id, userId: targetUser.id });
      const targetHeaders = { Authorization: `Bearer ${targetToken.token}` };
      for (const path of [`/api/multiremi/issues/${issue.id}`, `/api/issues/${issue.id}/sessions?include_archived=true`,
        `/api/issues/${issue.id}/timeline`, `/api/issues/${issue.id}/timeline?limit=100`, `/api/issues/${issue.id}/deliveries`]) {
        const response = await app.request(path, { headers: targetHeaders });
        expect(response.status, path).toBe(200);
        expect(await response.text(), path).not.toContain('SOURCE_ONLY_PRIVATE');
      }
      for (const suffix of ['', '/participants']) {
        expect((await app.request(`/api/issues/${issue.id}/sessions/${sourceMain.id}${suffix}`, { headers: targetHeaders })).status).toBe(404);
      }
      for (const suffix of ['/events', '/tasks']) {
        const retired = await app.request(`/api/issues/${issue.id}/sessions/${sourceMain.id}${suffix}`, { headers: targetHeaders });
        expect(retired.status).toBe(410);
        expect(await retired.json()).toMatchObject({ code: 'route_retired' });
      }
      expect((await app.request(`/api/issues/${issue.id}/timeline?issue_session_id=${sourceMain.id}`, { headers: targetHeaders })).status).toBe(404);
      expect((await app.request(`/api/sessions/${sourceMain.id}/messages`, { headers: targetHeaders })).status).toBe(404);
      expect((await app.request(`/api/messages/${questionId}/question`, { headers: targetHeaders })).status).toBe(404);
      const sourceToken = await store.createAccessToken({ type: 'pat', name: 'Source reader PAT', workspaceId: 'local', userId: 'local' });
      const sourceMessages = await app.request(`/api/sessions/${sourceMain.id}/messages`, { headers: { Authorization: `Bearer ${sourceToken.token}` } });
      expect(sourceMessages.status).toBe(200);
      expect(await sourceMessages.text()).toContain('SOURCE_ONLY_PRIVATE_HISTORY');
      const shared = await app.request(`/api/issues/${issue.id}/share`, { method: 'POST', headers: targetHeaders });
      expect(shared.status).toBe(201);
      const token = (await shared.json() as { share: { token: string } }).share.token;
      const bundle = await app.request(`/api/shares/${token}`, { headers: { 'X-Remi-Share': token } });
      expect(bundle.status).toBe(200);
      expect(await bundle.text()).not.toContain('SOURCE_ONLY_PRIVATE');
    });
  }
  it('upgrades a real unified snapshot with no activity origin and freezes legacy facts only during explicit movement', () => {
    const f = fixture();
    const agent = f.store.createAgent({ name: 'Legacy source execution', provider: 'codex' });
    const issue = f.store.createIssue({ title: 'Legacy origin', responsibleMemberId: 'mem_local_local', assigneeType: 'agent', assigneeId: agent.id });
    const comment = f.store.createIssueComment(issue.id, { body: 'SOURCE_ONLY_PRIVATE_LEGACY_BODY' });
    const sourceSession = f.store.getOrCreateDefaultIssueSession(issue.id);
    for (const task of f.store.listTasksForIssue(issue.id)) if (!['completed', 'failed', 'cancelled'].includes(task.status)) f.store.cancelTask(task.id);
    const originalData = f.db.query('SELECT id,body,data FROM multiremi_issue_activity WHERE issue_id=?').all(issue.id);
    // Reproduce the actual previous unified shape: this additive column did
    // not exist. Two complete bootstraps must preserve its original evidence.
    f.db.exec('ALTER TABLE multiremi_issue_activity DROP COLUMN workspace_id');
    const first = new MultiremiStore(f.db);
    const store = new MultiremiStore((first as unknown as { db: typeof f.db }).db);
    expect(f.db.query('SELECT id,body,data FROM multiremi_issue_activity WHERE issue_id=?').all(issue.id)).toEqual(originalData);
    expect(f.db.query('SELECT DISTINCT workspace_id FROM multiremi_issue_activity WHERE issue_id=?').all(issue.id)).toEqual([{ workspace_id: null }]);
    const target = store.createWorkspace({ name: 'Legacy target', slug: 'legacy-origin-target' });
    const human = store.createWorkspaceMember({ workspaceId: target.id, name: 'Explicit legacy target human' });
    store.updateIssue(issue.id, { workspaceId: target.id, responsibleMemberId: human.id, actorType: 'member', actorId: 'mem_local_local' });
    expect(f.db.query('SELECT body,data,workspace_id FROM multiremi_issue_activity WHERE id=?').get(originalData.find(row => row.body === comment.body)!.id))
      .toEqual({ body: comment.body, data: originalData.find(row => row.body === comment.body)!.data, workspace_id: 'local' });
    expect(store.getIssueSession(sourceSession.id)?.workspaceId).toBe('local');
    const targetComments = store.listIssueComments(issue.id);
    expect(targetComments).toHaveLength(1);
    expect(targetComments[0]).toMatchObject({ type: 'system', issueSessionId: store.getOrCreateDefaultIssueSession(issue.id).id });
    expect(JSON.stringify(targetComments)).not.toContain('SOURCE_ONLY_PRIVATE');
    expect(JSON.stringify(store.listIssueActivity(issue.id))).not.toContain('SOURCE_ONLY_PRIVATE');
    f.db.run("INSERT INTO multiremi_issue_activity(id,issue_id,type,body,created_at) VALUES(?,?,'legacy_unknown',?,?)", ['unknown_origin', issue.id, 'SOURCE_ONLY_PRIVATE_UNKNOWN', new Date().toISOString()]);
    expect(JSON.stringify(store.listIssueActivity(issue.id))).not.toContain('SOURCE_ONLY_PRIVATE');
  });
});

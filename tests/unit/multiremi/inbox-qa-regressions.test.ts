import { createResponsibleTestIssue } from './helpers.js';
import { it, expect, spyOn } from 'bun:test';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
// Reproductions from QA cmt_p5e4j4bnm9hd; execute unchanged behavior on both backends.
pendingTurnBackendTests('MUL-506 independent QA probes', (fixture, backend) => {
    function setup() {
        const f = fixture(), a = f.store.createAgent({ name: 'QA owner', provider: 'codex' }), issue = f.store.createIssue({ title: 'QA probes', assigneeType: 'agent', assigneeId: a.id, responsibleMemberId: 'mem_local_local' }), session = f.store.getOrCreateDefaultIssueSession(issue.id);
        f.store.registerRuntime({ id: 'rt_qa', daemonId: 'daemon_qa', name: 'QA fixture', provider: 'codex', workspaceId: 'local' });
        const message = { session_id: session.id, sender: { type: 'member' as const, id: 'mem_local_local' }, to: { type: 'agent' as const, ref: a.id }, message_kind: 'request' as const, wake_requested: 'now' as const, body_md: 'start' };
        const sent = f.store.sendMessage(message), attempt = f.store.claimTask('rt_qa')!;
        f.store.startTask(attempt.id);
        const bridge = f.store.getDaemonTurnBridge(), scope = { workspaceId: 'local', runtimeId: 'rt_qa', daemonId: 'daemon_qa' }, offer = bridge.offerInput(f.store.getTaskWithAgent(attempt.id)!);
        return { ...f, a, issue, session, message, sent, attempt, bridge, scope, offer };
    }
    it('a compatibility AUQ without a native callback can be answered once and receives a cold continuation', () => {
        const f = setup();
        const request = f.store.createTaskHumanRequest({ taskId: f.attempt.id, kind: 'question', payload: { questions: [{ question: 'Approve?', options: [{ label: 'Yes' }] }] } });
        const decision = { message: { id: request.id } };
        expect(f.store.getQuestion(decision.message.id)).toMatchObject({ status: 'pending', wait_status: 'detached', wait_reason: 'native_wait_unverified' });
        expect(f.store.getTurn(f.sent.turn_id!)?.status).toBe('awaiting_human');
        const revision = f.store.getQuestion(decision.message.id)!.route_revision;
        expect(() => f.store.answerMessageDecision(decision.message.id, { sender: { type: 'member', id: 'mem_local_local' }, expected_route_revision: revision, body_md: 'Yes', response: { answer: 'Yes' } })).not.toThrow();
        expect(f.store.getTurn(f.sent.turn_id!)?.status).toBe('cancelled');
        expect(f.store.getQuestion(decision.message.id)).toMatchObject({ status: 'answered', wait_status: 'continuation_pending' });
        expect(f.store.getQuestion(decision.message.id)?.recovery.consumer_turn_id).not.toBe(f.sent.turn_id!);
        expect(() => f.store.answerMessageDecision(decision.message.id, { sender: { type: 'member', id: 'mem_local_local' }, expected_route_revision: revision, body_md: 'Again' })).toThrow('settled');
    });
    it('a receipt in another execution scope cannot acknowledge this provider folded body', () => {
        const f = setup();
        const scoped = f.store.sendMessage({ ...f.message, execution_scope: 'independent', body_md: 'x'.repeat(20000) });
        const initial = f.bridge.offerInput(f.store.getTaskWithAgent(f.attempt.id)!);
        f.store.recordSessionAgentRangeRead(f.session.id, f.a.id, { seq: 1, offset: 0 }, { seq: initial.input_to_seq + 1, offset: 0 });
        expect(f.bridge.complete({ payload: { turn_id: f.sent.turn_id!, attempt_id: f.attempt.id, input_to_seq: initial.input_to_seq, reply: { body_md: 'first provider complete', message_kind: 'reply' } }, completionFields: null }, f.scope).ok).toBe(true);
        const other = f.store.claimTask('rt_qa')!;
        f.store.startTask(other.id);
        const offer = f.bridge.offerInput(f.store.getTaskWithAgent(other.id)!);
        expect(offer.input_messages.find(m => m.id === scoped.message.id)?.body_md).toContain('没看');
        const receipt = f.bridge.rpc('turn.input', { turn_id: scoped.turn_id, attempt_id: other.id, input_to_seq: offer.input_to_seq, message_ids: offer.input_messages.map(m => m.id) }, f.scope);
        expect(receipt.code).toBe('input_gap');
        expect(f.store.getTurn(scoped.turn_id!)?.input_to_seq).toBeNull();
        f.store.recordSessionAgentRangeRead(f.session.id, f.a.id, { seq: 1, offset: 0 }, { seq: offer.input_to_seq + 1, offset: 0 }, other.id);
        expect(f.bridge.rpc('turn.input', { turn_id: scoped.turn_id, attempt_id: other.id, input_to_seq: offer.input_to_seq, message_ids: offer.input_messages.map(m => m.id) }, f.scope).ok).toBe(true);
    });
});
pendingTurnBackendTests('MUL-506 scoped decision QA', (fixture, backend) => {
    for (const kind of ['permission', 'question'] as const)
        it(`${kind} answer resumes the original delegated lane without creating a second pending turn`, () => {
            const f = fixture(), a = f.store.createAgent({ name: 'Scoped QA', provider: 'codex' }), issue = f.store.createIssue({ title: 'Scoped question', assigneeType: 'agent', assigneeId: a.id, responsibleMemberId: 'mem_local_local' }), s = f.store.getOrCreateDefaultIssueSession(issue.id);
            f.store.registerRuntime({ id: 'rt_scope', daemonId: 'daemon_scope', name: 'QA scoped fixture', provider: 'codex', workspaceId: 'local' });
            const sent = f.store.sendMessage({ session_id: s.id, sender: { type: 'member', id: 'mem_local_local' }, to: { type: 'agent', ref: a.id }, message_kind: 'request', wake_requested: 'now', body_md: 'scope work', execution_scope: 'dlg_qa' }), attempt = f.store.claimTask('rt_scope')!;
            f.store.startTask(attempt.id);
            const bridge = f.store.getDaemonTurnBridge(), scope = { workspaceId: 'local', runtimeId: 'rt_scope', daemonId: 'daemon_scope' }, decision = bridge.rpc('turn.decision', { turn_id: sent.turn_id, attempt_id: attempt.id, wait_id: `scoped-native-wait:${kind}`, dedupe_key: 'scoped_permission', body_md: 'Permit?', options: [{ label: 'Yes', value: 'yes' }], metadata: kind === 'permission' ? { kind, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] } : { kind, questions: [{ question: 'Permit?', options: [{ label: 'Yes' }] }] } }, scope);
            expect(decision.ok).toBe(true);
            const answer = f.store.answerMessageDecision(String(decision.message_id), { sender: { type: 'member', id: 'mem_local_local' }, expected_route_revision: f.store.getQuestion(String(decision.message_id))!.route_revision, body_md: 'Yes', response: kind === 'permission' ? { option_id: 'yes' } : { answers: { 'Permit?': 'Yes' } } });
            expect(f.store.getTurn(sent.turn_id!)?.status).toBe('running');
            expect(f.store.listTurns({ workspace_id: 'local', session_id: s.id }).filter(t => t.status === 'pending')).toHaveLength(0);
            expect(answer.turn_id).toBe(sent.turn_id!);
        });
});
pendingTurnBackendTests('MUL-506 cross issue decision QA', (fixture, backend) => {
    it('answer of a parent decision re-derives the unassigned source Issue when its turn resumes', () => {
        const f = fixture(), a = f.store.createAgent({ name: 'QA child worker', provider: 'codex' }), b = f.store.createAgent({ name: 'QA parent owner', provider: 'codex' }), parent = f.store.createIssue({ title: 'QA decision parent', assigneeType: 'agent', assigneeId: b.id, responsibleMemberId: 'mem_local_local' }), child = f.store.createIssue({ title: 'QA unassigned source', parentIssueId: parent.id }), s = f.store.getOrCreateDefaultIssueSession(child.id);
        f.store.registerRuntime({ id: 'rt_cross', daemonId: 'daemon_cross', name: 'QA cross fixture', provider: 'codex', workspaceId: 'local', maxConcurrency: 8 });
        const sent = f.store.sendMessage({ session_id: s.id, sender: { type: 'member', id: 'mem_local_local' }, to: { type: 'agent', ref: a.id }, message_kind: 'request', wake_requested: 'now', body_md: 'do work' }), attempt = f.store.claimTask('rt_cross')!;
        f.store.startTask(attempt.id);
        const d = f.store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: sent.turn_id, attempt_id: attempt.id, wait_id: 'cross-issue-native-wait', dedupe_key: 'cross-issue-question', body_md: 'Which branch?', options: [], metadata: { kind: 'question', questions: [{ question: 'Which branch?' }] } }, { runtimeId: 'rt_cross', daemonId: 'daemon_cross', workspaceId: 'local' });
        expect(d.ok).toBe(true);
        expect(f.store.getQuestion(String(d.message_id))).toMatchObject({ session_id: s.id, stage: 'parent_owner', current_handler: { type: 'agent', id: b.id } });
        expect(f.store.getTurn(sent.turn_id!)?.status).toBe('awaiting_human');
        expect(f.store.getIssue(child.id)?.status).toBe('in_review');
        const parentAttempt = f.store.claimTask('rt_cross')!;
        expect(parentAttempt.agentId).toBe(b.id); f.store.startTask(parentAttempt.id);
        const answered = f.store.answerQuestion(String(d.message_id), { expected_route_revision: 1, response: { answers: { 'Which branch?': 'Use this branch' } } }, { type: 'agent', id: b.id }, f.store.getTurnForAttempt(parentAttempt.id)!.id);
        expect(answered.message.session_id).toBe(s.id); expect(answered.message.reply_to_id).toBe(String(d.message_id));
        expect(f.store.getTurn(sent.turn_id!)?.status).toBe('running');
        expect(f.store.getIssue(child.id)?.status).toBe('in_progress');
    });
});
pendingTurnBackendTests('MUL-506 cold retry input QA', (fixture, backend) => {
    it('a fresh cold attempt receives the context the previous provider acknowledged', () => {
        const f = fixture(), a = f.store.createAgent({ name: 'QA cold', provider: 'codex' }), issue = f.store.createIssue({ title: 'Cold context', assigneeType: 'agent', assigneeId: a.id, responsibleMemberId: 'mem_local_local' }), s = f.store.getOrCreateDefaultIssueSession(issue.id);
        f.store.registerRuntime({ id: 'rt_cold', daemonId: 'daemon_cold', name: 'QA cold fixture', provider: 'codex', workspaceId: 'local' });
        const sent = f.store.sendMessage({ session_id: s.id, sender: { type: 'member', id: 'mem_local_local' }, to: { type: 'agent', ref: a.id }, message_kind: 'request', wake_requested: 'now', body_md: 'critical original instructions' }), attempt = f.store.claimTask('rt_cold')!;
        f.store.startTask(attempt.id);
        const bridge = f.store.getDaemonTurnBridge(), scope = { workspaceId: 'local', runtimeId: 'rt_cold', daemonId: 'daemon_cold' }, offer = bridge.offerInput(f.store.getTaskWithAgent(attempt.id)!);
        expect(bridge.rpc('turn.input', { turn_id: sent.turn_id, attempt_id: attempt.id, input_to_seq: offer.input_to_seq, message_ids: offer.input_messages.map(m => m.id) }, scope).ok).toBe(true);
        f.store.cancelTurn(sent.turn_id!);
        const retried = f.store.retryTurn(sent.turn_id!, true), replacement = f.store.getTaskWithAgent(retried.current_attempt_id!)!;
        const claimed = f.store.claimTask('rt_cold');
        expect(claimed?.id).toBe(replacement.id);
        f.store.startTask(replacement.id);
        const coldOffer = bridge.offerInput(f.store.getTaskWithAgent(replacement.id)!);
        expect(coldOffer.input_from_seq).toBe(0);
        expect(coldOffer.input_messages.some(m => m.id === sent.message.id)).toBe(true);
        expect(f.store.getSessionAgentReadProgress(s.id, a.id)).toEqual({ seq: offer.input_to_seq, offset: 0 });
        f.store.recordSessionAgentInlineRead(s.id, a.id, [], coldOffer.input_to_seq, true, replacement.id);
        expect(f.store.getSessionAgentReadProgress(s.id, a.id)).toEqual({ seq: 0, offset: 0 });
        expect(bridge.rpc('turn.input', { turn_id: sent.turn_id, attempt_id: replacement.id, input_to_seq: coldOffer.input_to_seq, message_ids: coldOffer.input_messages.map(m => m.id) }, scope).ok).toBe(true);
        expect(bridge.complete({ payload: { turn_id: sent.turn_id!, attempt_id: replacement.id, input_to_seq: coldOffer.input_to_seq, reply: { body_md: 'cold completed', message_kind: 'reply' } }, completionFields: null }, scope).ok).toBe(true);
        expect(f.store.getTurn(sent.turn_id!)?.status).toBe('completed');
    });
});
pendingTurnBackendTests('MUL-506 dependency audit QA', (fixture, backend) => {
    function setup() { const f = fixture(), a = f.store.createAgent({ name: 'QA dependency owner', provider: 'codex' }), prerequisite = f.store.createIssue({ title: 'Unfinished prerequisite', status: 'in_progress', responsibleMemberId: 'mem_local_local' }), issue = f.store.createIssue({ title: 'Waiting work', status: 'backlog', blockedBy: [prerequisite.id], assigneeType: 'agent', assigneeId: a.id, responsibleMemberId: 'mem_local_local' }); return { ...f, a, issue, prerequisite }; }
    it('a member force comment keeps one dependency override audit with the user actor', () => {
        const f = setup(), member = f.store.getWorkspaceMember('mem_local_local')!;
        expect(member.userId).toBe('local');
        f.store.createIssueComment(f.issue.id, { body: 'Start despite prerequisite', authorType: 'member', authorId: member.id });
        const audit = f.store.listIssueActivity(f.issue.id).filter(e => e.type === 'dependency_force_started');
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actorType: 'member', actorId: member.userId, body: 'comment' });
        expect(audit[0]!.data).toMatchObject({ source: 'comment', previous_status: 'backlog', unmet_prerequisites: [{ issue_id: f.prerequisite.id }], comment_id: expect.any(String), task_id: expect.any(String) });
    });
    it('the dependency gate kill switch still allows a platform request', () => { const f = setup(), prior = process.env.MULTIREMI_DEPENDENCY_GATE; process.env.MULTIREMI_DEPENDENCY_GATE = '0'; try {
        const result = f.store.sendMessage({ session_id: f.store.getOrCreateDefaultIssueSession(f.issue.id).id, sender: { type: 'platform', id: null }, to: { type: 'agent', ref: f.a.id }, message_kind: 'request', wake_requested: 'now', body_md: 'gate disabled' });
        expect(result.wake_applied).toBe('now');
        expect(result.turn_id).toBeTruthy();
    }
    finally {
        if (prior === undefined)
            delete process.env.MULTIREMI_DEPENDENCY_GATE;
        else
            process.env.MULTIREMI_DEPENDENCY_GATE = prior;
    } });
});
pendingTurnBackendTests('MUL-506 retry report link QA', (fixture, backend) => {
    it('a retried delegate with no reply points to its stable turn', () => {
        const f = fixture();
        const rtA = f.store.registerRuntime({ id: 'rt_report_a', daemonId: 'daemon_report_a', name: 'QA reporter', provider: 'codex', workspaceId: 'local' }), rtB = f.store.registerRuntime({ id: 'rt_report_b', daemonId: 'daemon_report_b', name: 'QA worker', provider: 'codex', workspaceId: 'local' });
        const a = f.store.createAgent({ name: 'Report origin', provider: 'codex', runtimeId: rtA.id }), b = f.store.createAgent({ name: 'Retried delegate', provider: 'codex', runtimeId: rtB.id }), parent = f.store.createIssue({ title: 'Report target', assigneeType: 'agent', assigneeId: a.id, responsibleMemberId: 'mem_local_local' }), child = f.store.createIssue({ title: 'Retried report source', assigneeType: 'agent', assigneeId: b.id, responsibleMemberId: 'mem_local_local' });
        const source = f.store.createTask({ agentId: a.id, issueId: parent.id, prompt: 'delegate' });
        expect(f.store.claimTask(rtA.id)?.id).toBe(source.id);
        f.store.startTask(source.id);
        const delegated = f.store.createTask({ agentId: b.id, issueId: child.id, parentTaskId: source.id, prompt: 'deliver' });
        expect(f.store.claimTask(rtB.id)?.id).toBe(delegated.id);
        f.store.startTask(delegated.id);
        f.store.failTask(delegated.id, { error: 'temporary provider outage', failureReason: 'runtime_offline' });
        const current = f.store.getTurn(delegated.id)!;
        expect(current.current_attempt_id).not.toBe(delegated.id);
        const retry = f.store.claimTask(rtB.id)!;
        expect(retry.id).toBe(current.current_attempt_id!);
        f.store.startTask(retry.id);
        const run = f.db.run.bind(f.db), fault = spyOn(f.db, 'run').mockImplementation((sql: string, params?: any) => { if (sql.includes('INSERT INTO multiremi_conversation_log') && params?.[3] === 'message' && params?.[5] === 'agent' && params?.[24] === 'reply')
            throw new Error('QA staged reply unavailable'); return run(sql, params); });
        try {
            f.store.completeTask(retry.id, { output: 'durable completion result' });
        }
        finally {
            fault.mockRestore();
        }
        expect(f.store.getTurn(delegated.id)?.reply_message_id).toBeNull();
        const report = f.store.listMessages(source.issueSessionId!).find(m => m.message_kind === 'report' && (m.metadata.message_source as any)?.taskId === retry.id)!;
        const match = /remi turn get ([^\s]+)/.exec(report.body_md);
        expect(match?.[1]).toBe(delegated.id);
        expect(f.store.getTurn(match![1]!)?.status).toBe('completed');
        expect(f.store.getTurn(retry.id)).toBeNull();
    });
});

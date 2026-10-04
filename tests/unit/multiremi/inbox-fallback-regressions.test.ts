import { it, expect } from 'bun:test';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
pendingTurnBackendTests('MUL-506 actual fallback replacement QA', (fixture, backend) => {
    for (const acknowledgeInitial of [false, true]) {
        it(`fallback replacement runs after initial input acknowledged=${acknowledgeInitial}`, () => {
            const { store } = fixture();
            const model = (id: string) => ({
                id, label: id, provider: 'anthropic' as const, default: id === 'primary-gpt',
                thinking: { status: 'supported' as const, supportedLevels: [{ value: 'high', label: 'high' }], defaultLevel: 'high' },
            });
            const runtime = store.registerRuntime({
                id: 'rt_fallback', daemonId: 'daemon_fallback', name: 'QA fallback runtime',
                provider: 'claude', workspaceId: 'local', maxConcurrency: 4,
                models: [model('primary-gpt'), model('fallback-deepseek')],
            });
            const agent = store.createAgent({
                name: 'QA fallback owner', provider: 'claude', runtimeId: runtime.id,
                model: 'primary-gpt', thinkingLevel: 'high',
                fallbackModel: 'fallback-deepseek', fallbackThinkingLevel: 'high',
            });
            const issue = store.createIssue({ title: 'Fallback same-turn recovery', assigneeType: 'agent', assigneeId: agent.id });
            const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: 'Finish original instructions after fallback' });
            expect(store.claimTask(runtime.id)?.id).toBe(task.id);
            store.startTask(task.id);
            const bridge = store.getDaemonTurnBridge();
            const scope = { workspaceId: 'local', runtimeId: runtime.id, daemonId: runtime.daemonId! };
            const offer = bridge.offerInput(store.getTaskWithAgent(task.id)!);
            if (acknowledgeInitial) {
                expect(bridge.rpc('turn.input', {
                    turn_id: task.id, attempt_id: task.id, input_to_seq: offer.input_to_seq,
                    message_ids: offer.input_messages.map(m => m.id),
                }, scope).ok).toBe(true);
            }
            const before = store.getIssue(issue.id)!;
            store.failTask(task.id, {
                error: 'gateway error: 503 no available accounts for model primary-gpt',
                failureReason: 'agent_error.provider_no_available_account',
            });
            const turn = store.getTurn(task.id)!;
            const replacement = store.getTask(turn.current_attempt_id!)!;
            expect(replacement.id).not.toBe(task.id);
            expect(replacement.executionModel).toBe('fallback-deepseek');
            expect(replacement.fallbackSwitched).toBe(true);
            expect(store.listTurnAttempts(task.id)).toHaveLength(2);
            expect(store.listTurns({ workspace_id: 'local', issue_id: issue.id })).toHaveLength(1);
            expect(store.getIssue(issue.id)?.status).toBe(before.status);
            expect(store.getIssue(issue.id)?.updatedAt).toBe(before.updatedAt);
            const claimed = store.claimTask(runtime.id);
            expect(claimed?.id).toBe(replacement.id);
            expect(store.getIssue(issue.id)?.status).toBe(before.status);
            store.startTask(replacement.id);
            expect(store.getIssue(issue.id)?.status).toBe(before.status);
            const nextOffer = bridge.offerInput(store.getTaskWithAgent(replacement.id)!);
            expect(nextOffer.input_messages.some(m => m.body_md.includes('Finish original instructions'))).toBe(true);
            expect(bridge.rpc('turn.input', {
                turn_id: task.id, attempt_id: replacement.id, input_to_seq: nextOffer.input_to_seq,
                message_ids: nextOffer.input_messages.map(m => m.id),
            }, scope).ok).toBe(true);
            expect(bridge.complete({
                payload: { turn_id: task.id, attempt_id: replacement.id, input_to_seq: nextOffer.input_to_seq, reply: { body_md: 'fallback completed', message_kind: 'reply' } },
                completionFields: null,
            }, scope).ok).toBe(true);
            expect(store.getTurn(task.id)?.status).toBe('completed');
            expect(store.getTask(replacement.id)?.status).toBe('completed');
            expect(store.getAgent(agent.id)?.model).toBe('primary-gpt');
        }, 30000);
    }
});

import { expect } from 'bun:test';
import type { MultiremiStore } from '@multiremi/store.js';

let sequence = 0;

/** A real bridge request with a live provider wait and one explicit fixture question. */
export function createNativeTestQuestion(store: MultiremiStore, taskId: string, kind: 'question' | 'permission' = 'question') {
  const task = store.getTask(taskId)!;
  const runtime = store.getRuntime(task.runtimeId!)!;
  const turn = store.getTurnForAttempt(taskId)!;
  const nonce = `native-question-fixture:${++sequence}`;
  const result = store.getDaemonTurnBridge().rpc('turn.decision', {
    turn_id: turn.id, attempt_id: taskId, wait_id: nonce, dedupe_key: nonce, body_md: 'Continue?', options: [],
    metadata: kind === 'permission'
      ? { kind, options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }] }
      : { kind, questions: [{ question: 'Continue?' }] },
  }, { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: task.workspaceId });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return store.getTaskHumanRequest(String(result.message_id))!;
}

export function answerNativeTestQuestion(store: MultiremiStore, id: string, answer = 'Yes') {
  const question = store.getQuestion(id)!;
  expect(question.current_handler?.type).toBe('member');
  return store.respondTaskHumanRequest(id, { respondedBy: question.current_handler!.id,
    expectedRouteRevision: question.route_revision,
    response: question.kind === 'permission' ? { option_id: 'allow_once' } : { answers: { 'Continue?': answer } } });
}

import { createResponsibleTestIssue } from './helpers.js';
import { seedHistoricalDecision } from './fixtures/historical-decision.js';
import { afterEach, expect, it, setSystemTime } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

afterEach(() => setSystemTime());

pendingTurnBackendTests("Historical Issue question revisions", fixture => {
  async function setup() {
    const { store, db } = fixture();
    const member = store.findWorkspaceMemberForUser("local", "local")!;
    const runtime = store.registerRuntime({ name: 'Question revision host', provider: 'codex', daemonId: 'revision-host', maxConcurrency: 8 });
    const owner = store.createAgent({ name: "Parent owner", provider: "codex", runtimeId: runtime.id });
    const worker = store.createAgent({ name: "Source owner", provider: "codex", runtimeId: runtime.id });
    const parent = createResponsibleTestIssue(store, { title: "Parent", assigneeType: "agent", assigneeId: owner.id, responsibleMemberId: member.id });
    const source = createResponsibleTestIssue(store, { title: "Source", parentIssueId: parent.id, assigneeType: "agent", assigneeId: worker.id });
    const sourceTask = store.createTask({ agentId: worker.id, issueId: source.id, prompt: "Ask" });
    expect(store.claimTask(runtime.id)?.id).toBe(sourceTask.id); store.startTask(sourceTask.id);
    const decision = seedHistoricalDecision(store, source.id, { kind: "criteria", title: "Ready for review?" },
      { type: "agent", id: worker.id, taskId: sourceTask.id });
    const sessionId = store.getMessage(decision.id)!.session_id;
    const notice = store.sendMessage({ session_id: sessionId, sender: { type: 'platform', id: null },
      to: { type: 'agent', ref: owner.id }, message_kind: 'request', wake_requested: 'now', body_md: 'Review original question',
      metadata: { root_question_id: decision.id, question_notification: true, question_route_revision: 1 } });
    const task = store.claimTask(runtime.id)!;
    expect(task.id).toBe(store.getTurn(notice.turn_id!)!.current_attempt_id!); store.startTask(task.id);
    const token = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store });
    const answer = async (body_md: string, options: { auth?: string; revise?: boolean; answerRevision?: number } = {}) => {
      const question = store.getQuestion(decision.id)!;
      const response = await app.request(`/api/messages/${decision.id}/question/answer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.auth ? { Authorization: `Bearer ${options.auth}` } : {}) },
        body: JSON.stringify({ body_md, response: { answer: body_md }, expected_route_revision: question.route_revision,
          ...(options.revise ? { revise: true, expected_answer_revision: options.answerRevision ?? question.answer_revision, reason: 'Human review changed the answer' } : {}) }),
      });
      return { status: response.status, data: await response.json() as any };
    };
    return { store, db, member, owner, worker, parent, source, sourceTask, decision, sessionId, token, app, answer };
  }

  it("appends explicit human revisions and returns each answer to the original source", async () => {
    const f = await setup();
    setSystemTime(new Date("2026-10-01T00:00:00Z"));
    expect((await f.answer('Ready after CI', { auth: f.token.token })).status).toBe(200);
    const original = f.store.getQuestion(f.decision.id)!;
    expect(original).toMatchObject({ status: 'answered', answer_revision: 1, wait_status: 'none' });
    const before = f.store.getConversationLogHead(f.sessionId)!.headSeq;
    expect((await f.answer('Implicit overwrite')).status).toBe(403);
    expect((await f.answer('Stale revision', { revise: true, answerRevision: 0 })).status).toBe(409);
    expect((await f.answer('Agent cannot revise', { auth: f.token.token, revise: true })).status).toBe(403);
    expect(f.store.getConversationLogHead(f.sessionId)!.headSeq).toBe(before);
    setSystemTime(new Date("2026-10-01T00:00:01Z"));
    const revised = await f.answer('Hold for QA', { revise: true });
    expect(revised.status, JSON.stringify(revised.data)).toBe(200);
    const after = f.store.getQuestion(f.decision.id)!;
    expect(after).toMatchObject({ status: 'answered', answer_revision: 2, wait_status: 'none',
      answer: { body_md: 'Hold for QA', actor: { type: 'member', id: f.member.id }, at: '2026-10-01T00:00:01.000Z' } });
    const answers = after.history.filter(event => event.type === 'answer' || event.type === 'revise');
    expect(answers.map(event => event.answer?.actor.type)).toEqual(['agent', 'member']);
    expect(answers[0]).toEqual(original.history.find(event => event.type === 'answer')!);
    expect(f.store.getMessage(after.answer!.reply_message_id)).toMatchObject({ message_kind: 'status', reply_to_id: f.decision.id,
      body_md: 'Hold for QA', sender_type: 'member', sender_id: f.member.id, session_id: f.sessionId });
    const sourceSession = f.store.getTask(f.sourceTask.id)!.issueSessionId!;
    const sourceNotices = () => f.store.listMessages(sourceSession).filter(message => message.metadata.question_source_notification && message.metadata.root_question_id === f.decision.id);
    expect(sourceNotices()).toHaveLength(2);
    expect(sourceNotices().every(message => message.to_agent_id === f.worker.id)).toBe(true);
    expect(sourceNotices().some(message => message.body_md.includes('Hold for QA'))).toBe(true);
    setSystemTime(new Date("2026-10-01T00:00:02Z"));
    expect((await f.answer('Wait for final QA', { revise: true })).status).toBe(200);
    expect(f.store.getQuestion(f.decision.id)?.answer_revision).toBe(3);
    expect(sourceNotices()).toHaveLength(3);
    expect(f.store.getQuestion(f.decision.id)?.recovery.consumer_attempt_id).toBeNull();
  });

  it("keeps explicitly closed historical questions and settled ordinary choices unchanged on duplicate answers", async () => {
    const f = await setup();
    f.store.closeQuestion(f.decision.id, { expected_route_revision: 1, reason: 'Human withdrew the historical question' },
      { type: 'member', id: f.member.id });
    const plain = f.store.sendMessage({ session_id: f.sessionId, sender: { type: 'agent', id: f.owner.id },
      to: { type: 'member', ref: f.member.id }, message_kind: 'decision', wake_requested: 'inbox_only', body_md: 'Plain?' }).message;
    const reply = () => f.app.request(`/api/sessions/${f.sessionId}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reply_to_id: plain.id, body_md: 'Yes' }) });
    expect((await reply()).status).toBe(200);
    const head = f.store.getConversationLogHead(f.sessionId)!.headSeq;
    expect((await f.answer('Second answer')).status).toBe(403);
    expect((await reply()).status).toBe(409);
    expect(f.store.getConversationLogHead(f.sessionId)!.headSeq).toBe(head);
    expect(f.store.getQuestion(f.decision.id)).toMatchObject({ status: 'closed', answer: null, wait_status: 'none' });
    expect(f.store.getQuestion(plain.id)).toBeNull();
  });
});

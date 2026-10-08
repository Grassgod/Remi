import type { QuestionActor, QuestionAnswer, QuestionAnswerInput, QuestionHistoryEvent, QuestionMutationInput, QuestionStage, QuestionView, QuestionWaitStatus } from '@multiremi/contracts';
import type { SendMessageInput, UnifiedMessage } from '@multiremi/contracts/unified-model.js';
import type { CommitEventQueue, StoreContext } from '../context.js';
import { createCommitEventQueue } from '../context.js';
import { afterCommit } from '../db/postgres.js';
import { nowIso } from '@multiremi/ids.js';
import { getMessage, sendMessageWithinTransaction } from './send-message.js';
import { normalizeHumanResponse } from './human-response.js';
import { assertQuestionCardToken, type QuestionCardCredential } from '../question-card-token.js';
import { deriveIssueStatusWithinTransaction } from './issue-status.js';

type RouteStep = { handler: QuestionActor; issue_id: string | null; stage: QuestionStage };
interface QuestionRecord {
  version: 1;
  workspace_id: string;
  source_issue_id: string | null;
  source_attempt_id: string | null;
  responsibility_revision: string | null;
  human_required: boolean;
  route: RouteStep[];
  route_index: number;
  route_revision: number;
  route_reason: string | null;
  status: QuestionView['status'];
  summary: QuestionView['summary'];
  summary_wait_until?: string | null;
  answer: QuestionAnswer | null;
  answer_revision: number;
  history: QuestionHistoryEvent[];
  wait: { status: QuestionWaitStatus; reason: string | null; wait_id?: string; runtime_id?: string; reply_message_id?: string; consumer_turn_id?: string; consumer_attempt_id?: string; continuation_message_id?: string; consumed_at?: string };
}
export class QuestionError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message = code) { super(message); }
}
const same = (a: QuestionActor | null | undefined, b: QuestionActor | null | undefined) => !!a && !!b && a.type === b.type && a.id === b.id;

/** All state lives on the original decision row. Related messages are durable notifications. */
export class Questions {
  constructor(private ctx: StoreContext) {}
  private transaction<T>(fn: (events: CommitEventQueue) => T): T {
    const events = createCommitEventQueue();
    const result = this.ctx.db.inTransaction ? fn(events) : this.ctx.db.transaction(() => fn(events))();
    afterCommit(this.ctx.db, () => this.ctx.emitCommitEvents(events));
    return result;
  }
  private route(issueId: string | null, sourceAgent: string | null, humanRequired: boolean, sessionId?: string, workspaceId?: string): { steps: RouteStep[]; revision: string | null; reason: string | null } {
    if (!issueId) {
      const chat = sessionId ? this.ctx.chat().getChatSession(sessionId) : null;
      const member = chat?.creatorId ? this.ctx.workspaces().getWorkspaceMemberByRef(chat.creatorId, chat.workspaceId) : null;
      return member && !member.archivedAt && (!workspaceId || member.workspaceId === workspaceId) ? { steps: [{ handler: { type: 'member', id: member.id }, issue_id: null, stage: 'human' }], revision: null, reason: null }
        : { steps: [], revision: null, reason: 'explicit_human_responsibility_required' };
    }
    const responsibility = this.ctx.resolveIssueResponsibility(issueId);
    if (workspaceId && responsibility.workspaceId !== workspaceId) return { steps: [], revision: responsibility.revision, reason: 'source_workspace_changed' };
    const reason = responsibility.unresolved.map(x => `${x.issueId}:${x.reason}`).join(',') || null;
    if (responsibility.unresolved.some(x => ['parent_cycle', 'parent_missing', 'workspace_mismatch', 'issue_missing', 'human_missing', 'human_unavailable'].includes(x.reason)))
      return { steps: [], revision: responsibility.revision, reason };
    const steps: RouteStep[] = [];
    const seen = new Set<string>(sourceAgent ? [`agent:${sourceAgent}`] : []);
    if (!humanRequired) for (const [index, node] of responsibility.chain.entries()) {
      const actor = node.executionOwner;
      if (!actor || seen.has(`${actor.type}:${actor.id}`)) continue;
      seen.add(`${actor.type}:${actor.id}`);
      steps.push({ handler: { type: actor.type, id: actor.id }, issue_id: node.issueId, stage: index === 0 ? 'issue_owner' : 'parent_owner' });
    }
    const human = responsibility.rootHuman;
    if (human) steps.push({ handler: { type: 'member', id: human.id }, issue_id: responsibility.rootIssueId, stage: 'human' });
    return { steps, revision: responsibility.revision, reason: reason ?? (steps.length ? null : 'responsibility_unavailable') };
  }
  private read(id: string): { message: UnifiedMessage; record: QuestionRecord } | null {
    const message = getMessage(this.ctx, id);
    if (!message || message.deleted_at || message.message_kind !== 'decision') return null;
    const stored = message.metadata.question as QuestionRecord | undefined;
    if (stored?.version === 1) return { message, record: stored };
    const old = message.metadata.decision_record as Record<string, any> | undefined;
    const human = message.metadata.human_request as Record<string, any> | undefined;
    // Historical decisions have no native waiting call. Keep their identity and answers.
    if (!old && !human) return null;
    const session = this.ctx.issueSessions().getIssueSession(message.session_id);
    const chat = session ? null : this.ctx.chat().getChatSession(message.session_id);
    if (!session && !chat) return null;
    const workspaceId = session?.workspaceId ?? chat!.workspaceId;
    if (human && !old) {
      const source = message.task_id ? this.ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(message.task_id) : null;
      const humanRequired = human.kind === 'permission' || message.metadata.requires_human_authorization === true;
      const route = this.route(source?.issue_id ?? session?.issueId ?? null, message.sender_id, humanRequired, message.session_id, workspaceId);
      const response = human.response && typeof human.response === 'object' ? human.response : null;
      const member = human.responded_by ? this.ctx.workspaces().getWorkspaceMemberByRef(String(human.responded_by), workspaceId) : null;
      const answer: QuestionAnswer | null = response ? { response, body_md: JSON.stringify(response), actor: { type: 'member', id: member?.id ?? String(human.responded_by ?? '') }, at: String(human.responded_at ?? message.created_at), reply_message_id: '' } : null;
      const closed = human.status === 'cancelled';
      return { message, record: { version: 1, workspace_id: workspaceId, source_issue_id: source?.issue_id ?? session?.issueId ?? null,
        source_attempt_id: source?.current_attempt_id ?? null, responsibility_revision: route.revision, human_required: humanRequired,
        route: route.steps, route_index: 0, route_revision: 1, route_reason: route.reason, status: answer ? 'answered' : closed ? 'closed' : 'pending', summary: null, answer, answer_revision: answer ? 1 : 0,
        history: answer ? [{ type: 'answer', at: answer.at, actor: answer.actor, route_revision: 1, answer }] : [],
        wait: { status: answer || closed ? 'none' : 'detached', reason: 'historical_native_wait_unverified' } } };
    }
    const legacy = old!;
    const required = legacy.status === 'escalated' || ['permission', 'merge', 'production_change'].includes(legacy.kind);
    const route = this.route(String(legacy.source_issue_id ?? session!.issueId), message.sender_id, required, message.session_id, workspaceId);
    const oldAnswers = Array.isArray(legacy.history) ? legacy.history : [];
    const answer = (value: any): QuestionAnswer => ({ body_md: String(value.text ?? value.answer ?? ''), response: { answer: String(value.text ?? value.answer ?? '') },
      actor: { type: value.answererType === 'agent' ? 'agent' : 'member', id: String(value.answererId ?? legacy.answered_by_member_id ?? '') },
      at: String(value.at ?? value.answeredAt ?? legacy.answered_at ?? message.created_at), reply_message_id: '' });
    return { message, record: { version: 1, workspace_id: workspaceId, source_issue_id: String(legacy.source_issue_id ?? session!.issueId), source_attempt_id: null,
      responsibility_revision: route.revision, human_required: required, route: route.steps, route_index: 0, route_revision: 1, route_reason: route.reason,
      status: legacy.status === 'answered' ? 'answered' : legacy.status === 'withdrawn' ? 'closed' : 'pending', summary: null,
      answer: legacy.answer ? answer(legacy.answer) : null, answer_revision: oldAnswers.length || (legacy.answer ? 1 : 0), history: oldAnswers.map((a: any) => ({ type: 'answer', at: answer(a).at, actor: answer(a).actor, route_revision: 1, reason: a.reason, overturn: a.overturn, answer: answer(a) })),
      wait: { status: 'none', reason: 'historical_decision_without_native_call' } } };
  }
  private lock(id: string) {
    let result = this.read(id);
    if (!result) throw new QuestionError(404, 'question_not_found');
    this.ctx.lockWorkspaceRuntimeLifecycle(result.record.workspace_id);
    this.ctx.db.run('UPDATE multiremi_conversation_log SET revision=revision WHERE id=?', [id]);
    result = this.read(id)!;
    if (!this.integrity(result.message, result.record)) throw new QuestionError(403, 'question_source_workspace_changed');
    return result;
  }
  private integrity(message: UnifiedMessage, record: QuestionRecord): boolean {
    const facts = this.ctx.db.query('SELECT h.workspace_id,i.workspace_id AS source_workspace FROM multiremi_conversation_heads h LEFT JOIN multiremi_issues i ON i.id=? WHERE h.session_id=?').get(record.source_issue_id, message.session_id);
    return facts?.workspace_id === record.workspace_id && (!record.source_issue_id || facts?.source_workspace === record.workspace_id);
  }
  private waiting(message: UnifiedMessage, record: QuestionRecord): QuestionRecord['wait'] {
    if (record.wait.status !== 'waiting') return record.wait;
    const turn = message.task_id ? this.ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(message.task_id) : null;
    if (!turn || turn.current_attempt_id !== record.source_attempt_id || !['running', 'awaiting_human'].includes(turn.status))
      return { ...record.wait, status: 'detached', reason: !turn ? 'source_turn_missing' : turn.current_attempt_id !== record.source_attempt_id ? 'provider_attempt_replaced' : `source_turn_${turn.status}` };
    return record.wait;
  }
  private actor(record: QuestionRecord, sender: SendMessageInput['sender'], sourceTurnId?: string): QuestionActor {
    if ((sender.type !== 'agent' && sender.type !== 'member') || !sender.id) throw new QuestionError(403, 'question_actor_required');
    const actor = sender.type === 'agent' ? this.ctx.agents().getAgent(sender.id) : this.ctx.workspaces().getWorkspaceMember(sender.id);
    if (!actor || actor.workspaceId !== record.workspace_id || actor.archivedAt) throw new QuestionError(403, 'question_actor_workspace_mismatch');
    if (sender.type === 'agent') {
      const turn = sourceTurnId ? this.ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(sourceTurnId) : null;
      if (!turn || turn.agent_id !== sender.id || turn.workspace_id !== record.workspace_id || !['running', 'awaiting_human'].includes(turn.status)) throw new QuestionError(403, 'question_agent_current_turn_required');
    }
    return { type: sender.type, id: sender.id };
  }
  private current(record: QuestionRecord, actor: QuestionActor, revision: number) {
    if (!Number.isSafeInteger(revision) || revision !== record.route_revision) throw new QuestionError(409, 'question_route_changed');
    if (!same(record.route[record.route_index]?.handler, actor)) throw new QuestionError(403, 'question_handler_required');
    if (record.source_issue_id && this.ctx.resolveIssueResponsibility(record.source_issue_id).revision !== record.responsibility_revision) throw new QuestionError(409, 'question_responsibility_changed', 'Responsibility changed; explicitly transfer this question before answering');
  }
  private save(message: UnifiedMessage, record: QuestionRecord, events: CommitEventQueue) {
    const metadata: Record<string, any> = { ...message.metadata, question: record };
    if (metadata.human_request) metadata.human_request = { ...metadata.human_request, expires_at: null, status: record.status === 'pending' ? 'pending' : record.status === 'answered' ? 'responded' : 'cancelled',
      ...(record.answer ? { response: record.answer.response, responded_by: record.answer.actor.id, responded_at: record.answer.at } : {}),
      payload: { ...metadata.human_request.payload, root_question_id: message.id, route_revision: record.route_revision, question_summary: record.summary?.body_md ?? null, question_summary_wait_until: record.summary_wait_until ?? null } };
    if (metadata.decision_record) {
      const history = record.history.filter(event => event.answer).map(event => ({ answererType: event.answer!.actor.type, answererId: event.answer!.actor.id,
        answer: event.answer!.body_md, reason: event.reason ?? '', overturn: event.overturn ?? null, answeredAt: event.answer!.at }));
      metadata.decision_record = { ...metadata.decision_record, status: record.status === 'pending' ? record.route[record.route_index]?.stage === 'human' ? 'escalated' : 'pending' : record.status === 'answered' ? 'answered' : 'withdrawn',
        ...(history.length ? { answer: history.at(-1), history } : {}) };
    }
    this.ctx.conversationLog().updateConversationLogWithinTransaction(message.session_id, message.seq, { fields: { metadata, resolved_at: record.status === 'pending' ? null : nowIso() } });
    events.workspace.push({ type: 'inbox:new', workspaceId: record.workspace_id, actorType: 'system', actorId: null, payload: { index_only: true, root_question_id: message.id } });
    const relatedIssues = new Set([record.source_issue_id, ...record.route.map(r => r.issue_id)]);
    for (const issue_id of relatedIssues) if (issue_id) events.workspace.push({ type: 'decision:updated', workspaceId: record.workspace_id, actorType: 'system', actorId: null, payload: { issue_id, root_question_id: message.id } });
    if (record.source_issue_id) deriveIssueStatusWithinTransaction(this.ctx, record.source_issue_id, events);
  }
  private event(record: QuestionRecord, type: QuestionHistoryEvent['type'], actor: QuestionActor | null, fields: Partial<QuestionHistoryEvent> = {}) {
    record.history.push({ type, at: nowIso(), actor, route_revision: record.route_revision, ...fields });
  }
  private notify(message: UnifiedMessage, record: QuestionRecord, events: CommitEventQueue) {
    const step = record.route[record.route_index];
    if (!step) return;
    const session = step.issue_id ? this.ctx.issueSessions().getOrCreateDefaultIssueSessionWithinTransaction(step.issue_id).id : message.session_id;
    const reuseOriginal = step.handler.type === 'member' && session === message.session_id && record.route_revision === 1 && message.to_member_id === step.handler.id;
    const notification = reuseOriginal ? message : sendMessageWithinTransaction(this.ctx, { session_id: session, sender: { type: 'platform', id: null },
      to: { type: step.handler.type, ref: step.handler.id }, message_kind: 'request', wake_requested: step.handler.type === 'agent' ? 'now' : 'inbox_only',
      dedupe_key: `question-route:${message.id}:${record.route_revision}`,
      body_md: `问题 ${message.id} 等待您处理。原问题：\n${message.body_md}\n使用 remi message question get ${message.id} 查看原题和选项；答复或升级时必须提交路由版本 ${record.route_revision}。`,
      metadata: { root_question_id: message.id, question_route_revision: record.route_revision, question_notification: true, source_question_session_id: message.session_id } }, events).message;
    this.event(record, record.history.length ? 'transfer' : 'created', null, { handler: step.handler, source_message_id: notification.id, source_session_id: notification.session_id });
    if (step.stage === 'human') {
      const bot = this.ctx.feishuBot().getFeishuBotConfig(record.workspace_id);
      const remi = bot?.agentId ? this.ctx.agents().getAgent(bot.agentId) : null;
      if (remi && !remi.archivedAt && remi.workspaceId === record.workspace_id && remi.id !== message.sender_id) {
        record.summary_wait_until = new Date(Date.now() + 60_000).toISOString();
        sendMessageWithinTransaction(this.ctx, { session_id: session, sender: { type: 'platform', id: null }, to: { type: 'agent', ref: remi.id }, message_kind: 'request', wake_requested: 'now',
          dedupe_key: `question-present:${message.id}:${record.route_revision}`, metadata: { root_question_id: message.id, question_route_revision: record.route_revision, question_present_request: true },
          body_md: `请读取原问题 ${message.id}（remi message question get ${message.id}），总结背景、原选项与建议，然后用 remi message question present ${message.id} --revision ${record.route_revision} --summary <总结> 呈现同一个问题。指定人类责任人 ${step.handler.id}；不要另建 AUQ，也不要代答批准。` }, events);
      } else record.summary_wait_until = null;
      // This intent is durable, but dispatch waits for Remi present or its
      // explicit deadline; the web always retains the original question.
      const request = this.ctx.tasks().getTaskHumanRequest(message.id);
      if (request) this.ctx.feishuBot().enqueueQuestionPresentationWithinTransaction(message.id);
    }
  }
  createWithinTransaction(input: SendMessageInput, sourceAttemptId: string, events: CommitEventQueue) {
    const turn = input.source_turn_id ? this.ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(input.source_turn_id) : null;
    if (!turn || turn.current_attempt_id !== sourceAttemptId) throw new QuestionError(409, 'question_source_attempt_changed');
    const humanRequired = input.metadata?.kind === 'permission' || input.metadata?.requires_human_authorization === true;
    const route = this.route(turn.issue_id, turn.agent_id, humanRequired, input.session_id, turn.workspace_id);
    const record: QuestionRecord = { version: 1, workspace_id: turn.workspace_id, source_issue_id: turn.issue_id, source_attempt_id: sourceAttemptId,
      responsibility_revision: route.revision, human_required: humanRequired, route: route.steps, route_index: 0, route_revision: 1, route_reason: route.reason,
      status: 'pending', summary: null, answer: null, answer_revision: 0, history: [], wait: { status: 'waiting', reason: null,
        wait_id: typeof input.metadata?.wait_id === 'string' ? input.metadata.wait_id : undefined,
        runtime_id: this.ctx.tasks().getTask(sourceAttemptId)?.runtimeId ?? undefined } };
    const result = sendMessageWithinTransaction(this.ctx, { ...input, to: route.steps[0] ? { type: route.steps[0].handler.type, ref: route.steps[0].handler.id } : { type: 'none' },
      wake_requested: 'inbox_only', metadata: { ...input.metadata, question: record } }, events);
    if ((result.message.metadata.question as QuestionRecord | undefined)?.history?.length) return result;
    this.event(record, 'created', { type: 'agent', id: turn.agent_id });
    this.notify(result.message, record, events);
    this.save(result.message, record, events);
    return { ...result, message: getMessage(this.ctx, result.message.id)! };
  }
  get(id: string, actor?: QuestionActor): QuestionView | null {
    const loaded = this.read(id); if (!loaded) return null;
    const { message, record } = loaded, valid = this.integrity(message, record), step = valid ? record.route[record.route_index] : undefined, wait = this.waiting(message, record);
    const allowed: QuestionView['actions']['allowed'] = [];
    const rootHuman = record.route.find(r => r.stage === 'human')?.handler;
    if (actor && same(step?.handler, actor) && record.status === 'pending') { allowed.push('answer', 'transfer'); if (actor.type === 'agent') allowed.push('escalate'); }
    if (valid && actor && record.status === 'pending' && (same(step?.handler, actor) || same(rootHuman, actor) || actor.type === 'agent' && actor.id === message.sender_id)) allowed.push('close');
    if (valid && actor && same(rootHuman, actor) && record.status === 'answered') { allowed.push('revise'); if (wait.status === 'detached' && message.sender_id) allowed.push('continue'); }
    const bot = actor?.type === 'agent' ? this.ctx.feishuBot().getFeishuBotConfig(record.workspace_id) : null;
    if (actor?.type === 'agent' && actor.id === bot?.agentId && record.status === 'pending' && step?.stage === 'human') allowed.push('present');
    const humanRequest = message.metadata.human_request as { kind?: string; payload?: { questions?: unknown[]; context?: { text: string; truncated?: boolean } } } | undefined;
    return { id: message.id, kind: humanRequest ? humanRequest.kind === 'permission' ? 'permission' : 'question' : 'decision', session_id: message.session_id, workspace_id: record.workspace_id, source_issue_id: record.source_issue_id,
      source_agent_id: message.sender_type === 'agent' ? message.sender_id : null, source_turn_id: message.task_id, source_attempt_id: record.source_attempt_id,
      original_questions: Array.isArray(humanRequest?.payload?.questions) ? humanRequest.payload.questions : [], original_message: message.body_md, original_context: humanRequest?.payload?.context ?? null, options: message.options,
      summary: record.summary, current_handler: step?.handler ?? null, stage: step?.stage ?? 'unavailable', route_revision: record.route_revision, route_reason: valid ? record.route_reason : 'source_workspace_changed', status: record.status,
      wait_status: wait.status, wait_reason: wait.reason ?? record.route_reason, answer: record.answer, answer_revision: record.answer_revision, history: record.history, actions: { allowed } };
  }
  private subtreeSql(): string {
    return 'WITH RECURSIVE subtree(id) AS (SELECT id FROM multiremi_issues WHERE id=? AND workspace_id=? UNION SELECT i.id FROM multiremi_issues i JOIN subtree s ON i.parent_issue_id=s.id WHERE i.workspace_id=?)';
  }
  private jsonText(alias: string, path: string): string {
    return this.ctx.db.dialect === 'postgres' ? `${alias}.metadata::jsonb #>> '{${path.replaceAll('.', ',')}}'` : `json_extract(${alias}.metadata,'$.${path}')`;
  }
  list(issueId: string, actor?: QuestionActor, input: { limit?: number; before?: string } = {}): QuestionView[] {
    const issue = this.ctx.issues().getIssue(issueId); if (!issue) return [];
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
    const cursor = input.before ? this.ctx.db.query('SELECT m.created_at,m.id FROM multiremi_conversation_log m JOIN multiremi_conversation_heads h ON h.session_id=m.session_id WHERE m.id=? AND h.workspace_id=?').get(input.before, issue.workspaceId) : null;
    if (input.before && !cursor) throw new QuestionError(400, 'question_cursor_invalid');
    const ids = this.ctx.db.query(`${this.subtreeSql()}, sessions AS (SELECT id FROM multiremi_issue_sessions WHERE issue_id IN (SELECT id FROM subtree) AND workspace_id=?),
      candidates(id) AS (SELECT id FROM multiremi_conversation_log WHERE session_id IN (SELECT id FROM sessions) AND message_kind='decision'
        UNION SELECT ${this.jsonText('n', 'root_question_id')} FROM multiremi_conversation_log n WHERE n.session_id IN (SELECT id FROM sessions) AND n.deleted_at IS NULL)
      SELECT m.id FROM candidates c JOIN multiremi_conversation_log m ON m.id=c.id JOIN multiremi_conversation_heads h ON h.session_id=m.session_id
      WHERE h.workspace_id=? AND m.message_kind='decision' AND m.deleted_at IS NULL
      AND (CAST(${this.jsonText('m', 'question.version')} AS TEXT)='1' OR ${this.jsonText('m', 'human_request.status')} IS NOT NULL OR ${this.jsonText('m', 'decision_record.status')} IS NOT NULL)
      ${cursor ? 'AND (m.created_at<? OR (m.created_at=? AND m.id<?))' : ''} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`)
      .all(issue.id, issue.workspaceId, issue.workspaceId, issue.workspaceId, issue.workspaceId, ...(cursor ? [cursor.created_at,cursor.created_at,cursor.id] : []), limit);
    return ids.map(row => this.get(row.id, actor)).filter((q): q is QuestionView => !!q);
  }
  answer(id: string, input: QuestionAnswerInput, sender: SendMessageInput['sender'], sourceTurnId?: string, credential?: QuestionCardCredential) {
    return this.transaction(events => {
      const { message, record } = this.lock(id), actor = this.actor(record, sender, sourceTurnId);
      const revise = input.revise === true;
      if (revise) {
        if (credential || actor.type !== 'member' || !same(record.route.find(r => r.stage === 'human')?.handler, actor) || record.status !== 'answered') throw new QuestionError(403, 'question_revision_human_required');
        if (!input.reason?.trim()) throw new QuestionError(400, 'question_revision_reason_required');
        if (input.expected_answer_revision !== record.answer_revision) throw new QuestionError(409, 'question_answer_revision_changed');
        if (input.expected_route_revision !== record.route_revision) throw new QuestionError(409, 'question_route_changed');
      } else { this.current(record, actor, input.expected_route_revision); if (record.status !== 'pending') throw new QuestionError(409, 'question_already_settled'); }
      if (record.human_required && actor.type !== 'member') throw new QuestionError(403, 'question_human_authorization_required');
      if (credential) assertQuestionCardToken({ token_hash: message.card_token_hash, token_recipient: message.card_token_recipient, token_consumed_at: message.card_token_consumed_at, status: record.status }, credential, 'pending');
      const request = this.ctx.tasks().getTaskHumanRequest(id);
      const response = request ? normalizeHumanResponse(request, input.response) : input.response;
      const text = input.body_md?.trim() || JSON.stringify(response);
      if (!text) throw new QuestionError(400, 'question_answer_required');
      record.wait = this.waiting(message, record);
      const live = !revise && record.wait.status === 'waiting';
      const reply = sendMessageWithinTransaction(this.ctx, { session_id: message.session_id, sender,
        to: live && message.sender_id ? { type: 'agent', ref: message.sender_id } : { type: 'none' },
        message_kind: revise ? 'status' : 'reply', wake_requested: live ? 'now' : 'inbox_only', reply_to_id: id,
        execution_scope: String(message.metadata.execution_scope ?? ''), body_md: request ? JSON.stringify(response) : text,
        metadata: { root_question_id: id, human_response: response, question_revision: revise, question_route_revision: record.route_revision, answer_source_turn_id: sourceTurnId ?? null } }, events);
      record.answer = { response, body_md: text, actor, at: nowIso(), reply_message_id: reply.message.id };
      record.answer_revision++;
      record.status = 'answered';
      record.wait.reply_message_id = reply.message.id;
      this.event(record, revise ? 'revise' : 'answer', actor, { answer: record.answer, reason: input.reason, source_message_id: reply.message.id, source_session_id: message.session_id });
      this.ctx.db.run('UPDATE multiremi_conversation_log SET card_token_consumed_at=COALESCE(card_token_consumed_at,?) WHERE id=?', [nowIso(), id]);
      this.save(message, record, events);
      if (request) afterCommit(this.ctx.db, () => this.ctx.feishuBot().enqueueDecisionCardPatch(this.ctx.tasks().getTaskHumanRequest(id)!));
      if (revise && message.sender_id) sendMessageWithinTransaction(this.ctx, { session_id: message.session_id, sender, to: { type: 'agent', ref: message.sender_id }, message_kind: 'request', wake_requested: 'now',
        execution_scope: String(message.metadata.execution_scope ?? ''), body_md: `人类修订了问题 ${id} 的答案：${text}\n原因：${input.reason}。这是补充指令，不是重放原 AUQ。`, metadata: { root_question_id: id, question_answer_revision: true }, dedupe_key: `question-revision:${id}:${reply.message.id}` }, events);
      if (!revise && record.wait.status === 'detached' && !/cancelled|explicit_stop/.test(record.wait.reason ?? '')) this.scheduleContinuation(message, record, actor, events);
      return { ...reply, question: this.get(id, actor)! };
    });
  }
  escalate(id: string, input: QuestionMutationInput, sender: SendMessageInput['sender'], sourceTurnId?: string) {
    return this.transaction(events => {
      const { message, record } = this.lock(id), actor = this.actor(record, sender, sourceTurnId);
      this.current(record, actor, input.expected_route_revision);
      if (actor.type !== 'agent' || record.status !== 'pending' || !input.reason?.trim()) throw new QuestionError(400, 'question_escalation_reason_required');
      record.route_index++; record.route_revision++; record.summary = null;
      record.route_reason = record.route[record.route_index] ? null : 'upper_responsibility_unavailable';
      this.event(record, 'escalate', actor, { reason: input.reason, handler: record.route[record.route_index]?.handler ?? null });
      this.ctx.db.run('UPDATE multiremi_conversation_log SET card_token_hash=NULL,card_token_recipient=NULL,card_token_consumed_at=NULL WHERE id=?', [id]);
      this.notify(message, record, events); this.save(message, record, events); return this.get(id, actor)!;
    });
  }
  transfer(id: string, input: QuestionMutationInput, sender: SendMessageInput['sender'], sourceTurnId?: string) {
    return this.transaction(events => {
      const { message, record } = this.lock(id), actor = this.actor(record, sender, sourceTurnId);
      const newRoute = this.route(record.source_issue_id, message.sender_id, record.human_required, message.session_id, record.workspace_id);
      const rootHuman = record.route.find(r => r.stage === 'human')?.handler;
      const newHuman = newRoute.steps.find(r => r.stage === 'human')?.handler;
      if (input.expected_route_revision !== record.route_revision) throw new QuestionError(409, 'question_route_changed');
      if (!same(record.route[record.route_index]?.handler, actor) && !same(rootHuman, actor) && !same(newHuman, actor)) throw new QuestionError(403, 'question_transfer_authority_required');
      if (record.status !== 'pending' || !input.reason?.trim()) throw new QuestionError(400, 'question_transfer_reason_required');
      const index = this.transferredIndex(record, newRoute.steps);
      record.route = newRoute.steps; record.route_index = index; record.route_revision++; record.responsibility_revision = newRoute.revision; record.route_reason = newRoute.reason; record.summary = null;
      this.event(record, 'transfer', actor, { reason: input.reason, handler: record.route[index]?.handler ?? null });
      this.ctx.db.run('UPDATE multiremi_conversation_log SET card_token_hash=NULL,card_token_recipient=NULL,card_token_consumed_at=NULL WHERE id=?', [id]);
      this.notify(message, record, events); this.save(message, record, events); return this.get(id, actor)!;
    });
  }
  close(id: string, input: QuestionMutationInput, sender: SendMessageInput['sender'], sourceTurnId?: string) {
    return this.transaction(events => {
      const { message, record } = this.lock(id), actor = this.actor(record, sender, sourceTurnId);
      if (input.expected_route_revision !== record.route_revision) throw new QuestionError(409, 'question_route_changed');
      if (!same(record.route[record.route_index]?.handler, actor) && !same(record.route.find(r => r.stage === 'human')?.handler, actor) && !(actor.type === 'agent' && actor.id === message.sender_id)) throw new QuestionError(403, 'question_close_authority_required');
      if (record.status !== 'pending' || !input.reason?.trim()) throw new QuestionError(400, 'question_close_reason_required');
      const waiting = this.waiting(message, record).status === 'waiting';
      record.status = 'closed'; record.wait = { ...record.wait, status: 'detached', reason: 'explicit_stop' };
      this.event(record, 'close', actor, { reason: input.reason }); this.save(message, record, events);
      this.ctx.db.run('UPDATE multiremi_conversation_log SET card_token_consumed_at=COALESCE(card_token_consumed_at,?) WHERE id=?', [nowIso(), id]);
      if (waiting && message.sender_id) sendMessageWithinTransaction(this.ctx, { session_id: message.session_id, sender: { type: 'platform', id: null }, to: { type: 'agent', ref: message.sender_id },
        message_kind: 'reply', wake_requested: 'now', reply_to_id: id, execution_scope: String(message.metadata.execution_scope ?? ''), body_md: 'Question explicitly closed',
        metadata: { root_question_id: id, question_closed: true, human_response: { cancelled: true }, question_route_revision: record.route_revision } }, events);
      const request = this.ctx.tasks().getTaskHumanRequest(id);
      if (request) afterCommit(this.ctx.db, () => this.ctx.feishuBot().enqueueDecisionCardPatch(request));
      return this.get(id, actor)!;
    });
  }
  present(id: string, input: QuestionMutationInput & { summary: string }, sender: SendMessageInput['sender'], sourceTurnId?: string) {
    return this.transaction(events => {
      const { message, record } = this.lock(id), actor = this.actor(record, sender, sourceTurnId);
      const bot = this.ctx.feishuBot().getFeishuBotConfig(record.workspace_id);
      if (actor.type !== 'agent' || actor.id !== bot?.agentId || record.route[record.route_index]?.stage !== 'human') throw new QuestionError(403, 'question_present_remi_required');
      if (input.expected_route_revision !== record.route_revision || record.status !== 'pending') throw new QuestionError(409, 'question_route_changed');
      if (typeof input.summary !== 'string' || !input.summary.trim()) throw new QuestionError(400, 'question_summary_required');
      record.summary = { body_md: input.summary.trim(), agent_id: actor.id, at: nowIso() };
      record.summary_wait_until = null;
      this.event(record, 'present', actor); this.save(message, record, events);
      this.ctx.feishuBot().enqueueQuestionPresentationWithinTransaction(id);
      const request = this.ctx.tasks().getTaskHumanRequest(id);
      if (request) afterCommit(this.ctx.db, () => this.ctx.feishuBot().enqueueDecisionCardPatch(this.ctx.tasks().getTaskHumanRequest(id)!));
      return this.get(id, actor)!;
    });
  }
  detachWithinTransaction(id: string, reason: string, events: CommitEventQueue, autoContinuation = true) {
    const loaded = this.read(id); if (!loaded || loaded.record.wait.status !== 'waiting') return false;
    const { message, record } = loaded;
    // An answer committed before the timeout owns the original reply race.
    if (record.status === 'answered' && (reason === 'timeout' || reason === 'cancelled')) return true;
    record.wait = { ...record.wait, status: 'detached', reason };
    this.event(record, 'detach', null, { reason }); this.save(message, record, events);
    this.ctx.db.run("UPDATE multiremi_turns SET waiting_on_message_id=NULL,status=CASE WHEN status='awaiting_human' THEN 'running' ELSE status END WHERE waiting_on_message_id=?", [id]);
    if (autoContinuation && record.status === 'answered' && record.answer && !/cancelled|explicit_stop/.test(reason)) this.scheduleContinuation(message, record, record.answer.actor, events);
    return true;
  }
  continue(id: string, input: QuestionMutationInput, sender: SendMessageInput['sender']) {
    return this.transaction(events => {
      const { message, record } = this.lock(id), actor = this.actor(record, sender);
      if (input.expected_route_revision !== record.route_revision) throw new QuestionError(409, 'question_route_changed');
      if (actor.type !== 'member' || !same(record.route.find(r => r.stage === 'human')?.handler, actor)) throw new QuestionError(403, 'question_continuation_human_required');
      if (record.wait.status === 'continuation_pending' || record.wait.status === 'continuation_consumed') return this.get(id, actor)!;
      record.wait = this.waiting(message, record);
      if (record.status !== 'answered' || !record.answer || record.wait.status !== 'detached' || !message.sender_id) throw new QuestionError(409, 'question_continuation_unavailable');
      this.scheduleContinuation(message, record, actor, events);
      return this.get(id, actor)!;
    });
  }
  private scheduleContinuation(message: UnifiedMessage, record: QuestionRecord, actor: QuestionActor, events: CommitEventQueue) {
      const id = message.id;
      const agent = this.ctx.agents().getAgent(message.sender_id!);
      if (!agent || agent.archivedAt || agent.workspaceId !== record.workspace_id) throw new QuestionError(409, 'question_source_agent_unavailable');
      const source = record.source_attempt_id ? this.ctx.tasks().getTask(record.source_attempt_id) : null;
      if (source && !['completed', 'failed', 'cancelled'].includes(source.status)) this.ctx.tasks().cancelTask(source.id);
      const result = sendMessageWithinTransaction(this.ctx, { session_id: message.session_id, sender: { type: 'platform', id: null }, to: { type: 'agent', ref: agent.id }, message_kind: 'request', wake_requested: 'now',
        execution_scope: String(message.metadata.execution_scope ?? ''), dedupe_key: `question-continuation:${id}`, body_md: `原提问 ${id} 的 provider 调用已结束（${record.wait.reason}）。责任处理者已授权在新轮续接原会话任务。原问题：\n${message.body_md}\n已记录答案：\n${record.answer!.body_md}\n请读取原会话上下文继续处理；不要声称恢复已结束的旧 AUQ。`,
        metadata: { root_question_id: id, question_continuation: true, question_route_revision: record.route_revision, authorized_by: actor, original_source_turn_id: message.task_id } }, events,
        source ? { continuedFromTaskId: source.id, parentTaskId: source.parentTaskId, delegationId: source.delegationId,
          delegatedByAgentId: source.delegatedByAgentId, delegatedFromIssueSessionId: source.delegatedFromIssueSessionId,
          runtimeId: source.runtimeId, sessionId: source.sessionId, workDir: source.workDir,
          issueCreationRestricted: source.issueCreationRestricted, holdsWorkspace: source.holdsWorkspace, priority: source.priority } : {});
      if (!result.turn_id) throw new QuestionError(409, 'question_continuation_not_scheduled');
      record.wait = { status: 'continuation_pending', reason: record.wait.reason, consumer_turn_id: result.turn_id, continuation_message_id: result.message.id };
      this.event(record, 'continue', actor, { source_message_id: result.message.id, source_session_id: message.session_id }); this.save(message, record, events);
      return this.get(id, actor)!;
  }
  private transferredIndex(record: QuestionRecord, next: RouteStep[]): number {
    const previous = record.route[record.route_index];
    if (!previous) return 0;
    // Responsibility edits cannot lower a question's explicitly escalated authority.
    if (previous.stage === 'human') {
      const explicitlyEscalated = record.human_required || record.history.some(event => event.type === 'escalate');
      if (!explicitlyEscalated && record.route_reason) return 0;
      return next.findIndex(step => step.stage === 'human');
    }
    if (previous.stage === 'parent_owner') {
      const exact = next.findIndex(step => step.issue_id === previous.issue_id && step.stage === 'parent_owner');
      return exact >= 0 ? exact : next.findIndex(step => step.stage === 'human');
    }
    return 0;
  }
  refreshWithinTransaction(issueId: string, events: CommitEventQueue, actor?: QuestionActor, reason = 'issue_responsibility_transferred') {
    const issue = this.ctx.issues().getIssue(issueId); if (!issue) return;
    this.ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId);
    const ids = this.ctx.db.query(`${this.subtreeSql()} SELECT m.id FROM multiremi_issue_sessions s JOIN multiremi_conversation_log m ON m.session_id=s.id
      WHERE s.workspace_id=? AND m.message_kind='decision' AND m.resolved_at IS NULL AND m.deleted_at IS NULL
        AND (s.issue_id IN (SELECT id FROM subtree) OR ${this.jsonText('m', 'question.source_issue_id')} IN (SELECT id FROM subtree) OR ${this.jsonText('m', 'decision_record.source_issue_id')} IN (SELECT id FROM subtree))`)
      .all(issueId, issue.workspaceId, issue.workspaceId, issue.workspaceId);
    for (const row of ids) {
      const loaded = this.read(row.id); if (!loaded || loaded.record.status !== 'pending') continue;
      const { message, record } = loaded;
      if (!this.integrity(message, record)) continue;
      if (!record.source_issue_id) continue;
      const facts = this.ctx.resolveIssueResponsibility(record.source_issue_id);
      if (!facts.chain.some(x => x.issueId === issueId) && !record.route.some(x => x.issue_id === issueId)) continue;
      const route = this.route(record.source_issue_id, message.sender_id, record.human_required, message.session_id, record.workspace_id);
      if (route.revision === record.responsibility_revision) continue;
      const index = this.transferredIndex(record, route.steps);
      record.route = route.steps; record.route_index = index; record.route_revision++; record.responsibility_revision = route.revision; record.route_reason = route.reason; record.summary = null;
      this.event(record, 'transfer', actor ?? null, { reason, handler: record.route[index]?.handler ?? null });
      this.ctx.db.run('UPDATE multiremi_conversation_log SET card_token_hash=NULL,card_token_recipient=NULL,card_token_consumed_at=NULL WHERE id=?', [message.id]);
      this.notify(message, record, events); this.save(message, record, events);
    }
  }
  consumeWithinTransaction(id: string, turnId: string, attemptId: string, replyId: string, events: CommitEventQueue, waitId?: string) {
    const { message, record } = this.lock(id);
    if (record.wait.wait_id && record.wait.status !== 'continuation_pending' && record.wait.status !== 'continuation_consumed' && record.wait.wait_id !== waitId) throw new QuestionError(409, 'question_wait_binding_changed');
    if (record.wait.status === 'consumed' || record.wait.status === 'continuation_consumed') {
      if (record.wait.consumer_turn_id !== turnId || record.wait.consumer_attempt_id !== attemptId) throw new QuestionError(409, 'question_consumer_mismatch');
      return;
    }
    const continuation = record.wait.status === 'continuation_pending';
    if (continuation ? record.wait.consumer_turn_id !== turnId || record.wait.continuation_message_id !== replyId : message.task_id !== turnId || record.source_attempt_id !== attemptId || record.wait.reply_message_id !== replyId || record.wait.status !== 'waiting') throw new QuestionError(409, 'question_consumer_mismatch');
    record.wait = { ...record.wait, status: continuation ? 'continuation_consumed' : 'consumed', consumer_turn_id: turnId, consumer_attempt_id: attemptId, consumed_at: nowIso() };
    this.event(record, 'consume', null); this.save(message, record, events);
  }
  reconcileRuntimeWaits(runtimeId: string, waits: import('@multiremi/contracts/daemon-protocol.js').DaemonQuestionWait[]) {
    return this.transaction(events => {
      const runtime = this.ctx.runtimes().getRuntimeLite(runtimeId); if (!runtime) return;
      this.ctx.lockWorkspaceRuntimeLifecycle(runtime.workspaceId ?? 'local');
      const rows = this.ctx.db.query(`SELECT m.id FROM multiremi_conversation_log m
        WHERE m.message_kind='decision' AND m.deleted_at IS NULL AND ${this.jsonText('m', 'question.wait.runtime_id')}=?
        AND ${this.jsonText('m', 'question.wait.status')}='waiting'`).all(runtimeId);
      for (const row of rows) {
        const loaded = this.read(row.id); if (!loaded) continue;
        const { message, record } = loaded;
        if (record.wait.status !== 'waiting' || record.wait.runtime_id !== runtimeId || !record.wait.wait_id) continue;
        if (waits.some(wait => wait.message_id === message.id && wait.attempt_id === record.source_attempt_id && wait.wait_id === record.wait.wait_id)) continue;
        this.detachWithinTransaction(message.id, 'daemon_wait_lost', events, false);
        // The old native reply was addressed to the lost callback. It must not
        // become a second generic wake when cancelling advances the session.
        if (record.wait.reply_message_id) this.ctx.db.run("UPDATE multiremi_conversation_log SET wake_requested='inbox_only',wake_applied='inbox_only',wake_reason='question_wait_lost' WHERE id=?", [record.wait.reply_message_id]);
        // A new process cannot recover the old provider callback. Invalidate its
        // attempt before the ordinary orphan recovery can create a second consumer.
        const task = record.source_attempt_id ? this.ctx.tasks().getTask(record.source_attempt_id) : null;
        if (task && !['completed', 'failed', 'cancelled'].includes(task.status)) this.ctx.tasks().cancelTask(task.id);
        const detached = this.read(message.id)!;
        if (detached.record.status === 'answered' && detached.record.answer) this.scheduleContinuation(detached.message, detached.record, detached.record.answer.actor, events);
      }
    });
  }
}

export function refreshIssueQuestionsAfterResponsibilityChangeWithinTransaction(ctx: StoreContext, issueId: string, events: CommitEventQueue, actor?: QuestionActor, reason?: string): void {
  new Questions(ctx).refreshWithinTransaction(issueId, events, actor, reason);
}

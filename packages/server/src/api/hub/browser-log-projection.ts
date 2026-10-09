import type { HubFrame } from "@multiremi/contracts/live-hub.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { ReadPool } from "@multiremi/store/db/read-pool.js";
import { toConversationLogEntry } from "@multiremi/store/repos/conversation-log-repo.js";
import type { MultiremiWebSocketClient } from "../helpers/realtime-types.js";
import { conversationEntrySource, conversationEntryDecision, conversationEntryQuestionNotification, stripCardTokenFields, type ConversationVisibilityEntry } from "../helpers/conversations.js";
import { canUserViewTaskMessages, createTaskAuthMemo } from "../helpers/auth-guards.js";
import { createPostgresStreamAuthReader, createSqliteStreamAuthReader, decideLogSubscription, decideTraceSubscription } from "./stream-auth.js";
import { questionNotificationIdentity, questionNotificationFactsSql, canReadQuestionNotificationFacts } from '../../store/inbox/question-notification-visibility.js';

/** The Hub ring is shared. Project at the socket boundary for each recipient. */
export function createBrowserLogProjection(store: MultiremiStore, pool: ReadPool | null) {
  const postgres = pool?.postgres ? pool : null;
  const auth = postgres ? createPostgresStreamAuthReader(postgres) : createSqliteStreamAuthReader(store);
  return async (client: MultiremiWebSocketClient, sessionId: string, frames: readonly HubFrame[]): Promise<HubFrame[]> => {
    if (client.data.kind !== "browser" || !client.data.authenticated) return [];
    const subject = { userId: client.data.userId, workspaceId: client.data.workspaceId };
    const sessionFacts = await auth.logFacts(sessionId, subject);
    if (!sessionFacts.ok) throw new Error("Session visibility unavailable");
    if (!decideLogSubscription(subject, sessionFacts.facts).ok) return [];
    if (!frames.length) return [];
    const seqs = [...new Set(frames.map(frame => frame.seq))];
    const rows = postgres
      ? (await postgres.query<Record<string, unknown>>(
        `SELECT * FROM multiremi_conversation_log WHERE session_id=? AND seq IN (${seqs.map(() => "?").join(",")})`,
        [sessionId, ...seqs])).map(toConversationLogEntry)
      : seqs.flatMap(seq => store.getConversationLogEntry(sessionId, seq) ?? []);
    const bySeq = new Map(rows.map(row => [row.seq, row]));
    const byId = new Map(rows.map(row => [row.id, row]));
    let frontier = rows;
    for (let depth = 0; depth <= 4 && frontier.length; depth++) {
      const replies = [...new Set(frontier.flatMap(row => {
        const id = row.parent_id ?? (typeof row.metadata.message_id === "string" ? row.metadata.message_id : null);
        return id && !byId.has(id) ? [id] : [];
      }))];
      const targets = [...new Set(frontier.flatMap(row => Number.isSafeInteger(row.metadata.target_seq)
        && !bySeq.has(Number(row.metadata.target_seq)) ? [Number(row.metadata.target_seq)] : []))];
      // Load the exact original Q for source-return boundaries and the separate
      // handler/presenter grant; never grant the containing session or trace.
      const questionRefs = [...new Set(frontier.flatMap(row => (row.metadata.question_source_notification === true
        || row.metadata.question_notification === true || row.metadata.question_present_request === true)
        && typeof row.metadata.root_question_id === 'string' && !byId.has(row.metadata.root_question_id) ? [row.metadata.root_question_id] : []))];
      if (!replies.length && !targets.length && !questionRefs.length) break;
      const conditions: string[] = [], params: unknown[] = [];
      if (replies.length || targets.length) {
        conditions.push(`(session_id=? AND (${[
          ...(replies.length ? [`id IN (${replies.map(() => '?').join(',')})`] : []),
          ...(targets.length ? [`seq IN (${targets.map(() => '?').join(',')})`] : []),
        ].join(' OR ')}))`);
        params.push(sessionId, ...replies, ...targets);
      }
      if (questionRefs.length) { conditions.push(`id IN (${questionRefs.map(() => '?').join(',')})`); params.push(...questionRefs); }
      const related = postgres
        ? (await postgres.query<Record<string, unknown>>(
          `SELECT * FROM multiremi_conversation_log WHERE ${conditions.join(' OR ')}`, params)).map(toConversationLogEntry)
        : [...[...replies, ...questionRefs].flatMap(id => store.getConversationLogEntryById(id) ?? []),
          ...targets.flatMap(seq => store.getConversationLogEntry(sessionId, seq) ?? [])];
      for (const row of related) { byId.set(row.id, row); if (row.session_id === sessionId) bySeq.set(row.seq, row); }
      frontier = related;
    }
    const allowed = new Map<string, boolean>(), decisions = new Map<string, boolean>(), notifications = new Map<string, boolean>(), memo = createTaskAuthMemo();
    const visible = async (entry: ConversationVisibilityEntry) => {
      const notification = conversationEntryQuestionNotification(entry, id => byId.get(id), seq => bySeq.get(seq));
      if (notification === null) return false;
      if (notification) {
        if (!notification.id) return false;
        if (!notifications.has(notification.id)) {
          const access = { userId: subject.userId, admin: false };
          const original = typeof notification.metadata.root_question_id === 'string' ? byId.get(notification.metadata.root_question_id) : null;
          const identity = questionNotificationIdentity(notification, original);
          const query = identity ? questionNotificationFactsSql(identity, notification, access) : null;
          const facts = postgres && query ? await postgres.queryOne(query.sql, query.params) : null;
          notifications.set(notification.id, postgres ? !!identity && identity.workspaceId === subject.workspaceId
            && canReadQuestionNotificationFacts(identity, notification, access, facts) : store.canReadQuestionNotification(notification.id, access));
        }
        return notifications.get(notification.id)!;
      }
      const decision = conversationEntryDecision(entry, id => byId.get(id), seq => bySeq.get(seq));
      if (decision === null) return false;
      if (decision) {
        if (!decision.id) return false;
        if (!decisions.has(decision.id)) {
          if (postgres) {
            const row = await postgres.queryOne<{ id: string }>(`SELECT d.id FROM multiremi_message_decision_records d
              JOIN multiremi_issues source ON source.id=d.source_issue_id AND source.workspace_id=d.workspace_id
              JOIN multiremi_issues target ON target.id=d.issue_id AND target.workspace_id=d.workspace_id
              WHERE d.id=? AND d.workspace_id=?`, [decision.id, subject.workspaceId]);
            decisions.set(decision.id, !!row);
          } else {
            const session = store.getIssueSession(decision.session_id ?? "");
            decisions.set(decision.id, !!session && !!store.getIssueDecision(session.issueId, decision.id));
          }
        }
        if (!decisions.get(decision.id)) return false;
      }
      const sourceId = conversationEntrySource(entry, id => byId.get(id), seq => bySeq.get(seq));
      if (sourceId === undefined) return true;
      if (!sourceId) return false;
      if (!allowed.has(sourceId)) {
        if (postgres) {
          const turn = await postgres.queryOne<{ current_attempt_id: string | null }>(
            `SELECT current_attempt_id FROM multiremi_turns WHERE id=?
              OR id=(SELECT turn_id FROM multiremi_turn_attempts WHERE id=?)`, [sourceId, sourceId]);
          const result = turn?.current_attempt_id ? await auth!.traceFacts(turn.current_attempt_id, subject) : null;
          if (result && !result.ok) throw new Error("Source visibility unavailable");
          allowed.set(sourceId, !!result && result.ok && decideTraceSubscription(subject, result.facts).ok);
        } else {
          const turn = store.getTurn(sourceId) ?? store.getTurnForAttempt(sourceId);
          const task = turn?.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
          allowed.set(sourceId, !!task && task.workspaceId === subject.workspaceId
            && canUserViewTaskMessages(store, subject.userId, task, memo));
        }
      }
      return allowed.get(sourceId)!;
    };
    const projected: HubFrame[] = [];
    for (const frame of frames) {
      const row = bySeq.get(frame.seq);
      const payload = frame.payload as Record<string, any>;
      const candidate = row && (frame.kind === "patch" ? { ...row, ...payload.fields } : payload);
      // Check committed facts as well as the event: a partial patch or an old
      // retained frame cannot remove the source check. Missing rows fail closed.
      if (!row || !candidate || !await visible(row) || !await visible(candidate as ConversationVisibilityEntry)) {
        projected.push({ seq: frame.seq, kind: "entry", payload: {
          session_id: sessionId, seq: frame.seq, revision: Math.max(row?.revision ?? 1, Number(payload.revision) || 1), visibility: "hidden",
        } });
      } else {
        projected.push({ ...frame, payload: stripCardTokenFields(payload) });
      }
    }
    return projected;
  };
}

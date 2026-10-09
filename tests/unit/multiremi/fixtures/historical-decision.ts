import type { MultiremiStore } from '@multiremi/store.js';
import { createCommitEventQueue } from '@multiremi/store/context.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';

/** Persist a pre-Question business record for compatibility tests, without invoking retired writers. */
export function seedHistoricalDecision(store: MultiremiStore, sourceIssueId: string,
  input: { kind: string; title: string; body?: string; options?: string[] },
  actor: { type: 'agent' | 'member'; id: string; taskId?: string | null }) {
  const source = store.getIssue(sourceIssueId)!;
  const target = store.getIssue(source.parentIssueId ?? source.id)!;
  const session = store.getOrCreateDefaultIssueSession(target.id);
  const human = ['permission', 'merge', 'production_change'].includes(input.kind);
  const at = new Date().toISOString();
  const turn = actor.taskId ? store.getTurnForAttempt(actor.taskId) : null;
  const message = store.sendMessage({ session_id: session.id, sender: { type: actor.type, id: actor.id },
    ...(turn ? { source_turn_id: turn.id } : {}), to: { type: 'none' },
    message_kind: 'decision', wake_requested: 'inbox_only', body_md: input.body ?? input.title,
    options: input.options?.map(label => ({ label, value: label })), metadata: {
      decision_record: { issue_id: target.id, source_issue_id: source.id, source_task_id: actor.taskId ?? null,
        kind: input.kind, title: input.title, body: input.body ?? '', options: input.options ?? [],
        status: human ? 'escalated' : 'pending',
        created_by_agent_id: actor.type === 'agent' ? actor.id : null,
        created_by_member_id: actor.type === 'member' ? actor.id : null,
        owner_agent_id: human ? null : target.assigneeId, history: [], created_at: at, updated_at: at },
    } }).message;
  const decision = store.getIssueDecision(target.id, message.id)!;
  const db = (store as unknown as { db: SqlDatabase }).db;
  if (human) db.transaction(() => store.prepareIssueDecisionCardWithinTransaction(target, decision, createCommitEventQueue()))();
  return decision;
}

/** The designated human must map to exactly one sender within this bot's app. */
export function seedQuestionHumanMapping(db: Pick<SqlDatabase, 'run'>,
  workspaceId: string, appId: string, userId: string, openId: string) {
  const unionId = `synthetic_union_${userId}`;
  db.run('UPDATE multiremi_users SET feishu_union_id=? WHERE id=?', [unionId, userId]);
  const at = new Date().toISOString();
  db.run(`INSERT INTO multiremi_feishu_bot_senders
    (id,workspace_id,app_id,open_id,union_id,display_name,allowed,first_seen_at,last_seen_at)
    VALUES(?,?,?,?,?,'Explicit fixture human',1,?,?) ON CONFLICT(id) DO NOTHING`,
    [`fixture_sender_${userId}_${appId}`, workspaceId, appId, openId, unionId, at, at]);
}

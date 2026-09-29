import { createId, nowIso } from "@multiremi/ids.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

export const TASK_EXECUTION_SCOPE_MIGRATION = "20260929_tasks_execution_scope";

/** Historical derivation, used only when backfilling the stored lane key. */
export function executionScopeSql(alias: string): string {
  return `(CASE WHEN ${alias}.delegated_by_agent_id IS NOT NULL
    AND ${alias}.agent_id <> ${alias}.delegated_by_agent_id
    THEN COALESCE(${alias}.delegation_id, '') ELSE '' END)`;
}

export function createPendingTurnIndexesWithinTransaction(db: SqlDatabase): void {
  // Stage two tests use the original chat predicate. Its final scope awaits
  // the stage-three plan, which must preserve the user-visible Chat queue.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_tasks_one_pending_turn_session
      ON multiremi_tasks(issue_session_id, agent_id, execution_scope)
      WHERE status = 'queued' AND issue_session_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_tasks_one_pending_turn_chat
      ON multiremi_tasks(chat_session_id, agent_id)
      WHERE status = 'queued' AND chat_session_id IS NOT NULL AND issue_session_id IS NULL;
  `);
}

type PendingTurnRow = {
  id: string;
  workspace_id: string;
  issue_id: string | null;
  issue_session_id: string | null;
  chat_session_id: string | null;
  agent_id: string;
  execution_scope: string;
  delegation_id: string | null;
  prompt: string;
  agent_name: string | null;
};

/** Issue activity where available; Chat-only tasks retain a processed audit event. */
export function appendPendingTurnAuditWithinTransaction(
  db: SqlDatabase,
  task: { id: string; issueId: string | null; workspaceId: string },
  type: string,
  data: Record<string, unknown>,
  at = nowIso(),
): void {
  const payload = { task_id: task.id, ...data };
  if (task.issueId) {
    db.run(`INSERT INTO multiremi_issue_activity
      (id, issue_id, actor_type, actor_id, type, body, data, created_at)
      VALUES (?, ?, 'system', NULL, ?, NULL, ?, ?)`,
    [createId("act"), task.issueId, type, JSON.stringify(payload), at]);
  } else {
    db.run(`INSERT INTO multiremi_system_events
      (id, workspace_id, resource, event, resource_id, payload, status, available_at, created_at, processed_at)
      VALUES (?, ?, 'task', ?, ?, ?, 'processed', ?, ?, ?)`,
    [createId("evt"), task.workspaceId, type, task.id, JSON.stringify(payload), at, at, at]);
  }
}

export function collapsePendingTurnsWithinTransaction(db: SqlDatabase): void {
  const rows = db.query(`SELECT t.id, t.workspace_id, t.issue_id, t.issue_session_id,
    t.chat_session_id, t.agent_id, t.execution_scope, t.delegation_id, t.prompt,
    a.name AS agent_name FROM multiremi_tasks t
    LEFT JOIN multiremi_agents a ON a.id = t.agent_id
    WHERE t.status = 'queued' AND (t.issue_session_id IS NOT NULL OR t.chat_session_id IS NOT NULL)
    ORDER BY t.created_at ASC, t.id ASC`).all() as PendingTurnRow[];
  const lanes = new Map<string, PendingTurnRow[]>();
  for (const row of rows) {
    const key = JSON.stringify(row.issue_session_id != null
      ? ["issue", row.issue_session_id, row.agent_id, row.execution_scope]
      : ["chat", row.chat_session_id, row.agent_id]);
    const lane = lanes.get(key) ?? [];
    lane.push(row);
    lanes.set(key, lane);
  }
  const at = nowIso();
  for (const lane of lanes.values()) {
    if (lane.length < 2) continue;
    const [kept, ...collapsed] = lane as [PendingTurnRow, ...PendingTurnRow[]];
    // Match the old terminal-report layout without its body truncation: every
    // queued prompt must survive this irreversible data migration in full.
    const prompt = [kept.prompt, ...collapsed.map((row) => [
      `## Terminal Report: ${row.agent_name ?? row.agent_id}`,
      `Source task: ${row.id}`,
      "Status: queued",
      `Delegation: ${row.delegation_id ?? "none"}`,
      "",
      row.prompt,
    ].join("\n"))].join("\n\n");
    db.run("UPDATE multiremi_tasks SET prompt = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
      [prompt, at, kept.id]);
    for (const row of collapsed) {
      db.run("UPDATE multiremi_tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'",
        [at, row.id]);
      appendPendingTurnAuditWithinTransaction(db,
        { id: row.id, issueId: row.issue_id, workspaceId: row.workspace_id },
        "pending_turn_collapsed", { kept_task_id: kept.id }, at);
    }
  }
}

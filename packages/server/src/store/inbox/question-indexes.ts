import type { SqlDatabase } from '../db/postgres.js';

/** Bound Q reads to Issue sessions and related notification roots on both backends. */
export function ensureQuestionQueryIndexes(db: SqlDatabase): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_questions_session_page ON multiremi_conversation_log(session_id,created_at,id)
    WHERE message_kind='decision' AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_questions_issue_subtree ON multiremi_issues(workspace_id,parent_issue_id,id);`);
  const root = db.dialect === 'postgres' ? "(metadata::jsonb->>'root_question_id')" : "json_extract(metadata,'$.root_question_id')";
  db.exec(`CREATE INDEX IF NOT EXISTS idx_questions_session_notification ON multiremi_conversation_log(session_id,${root}) WHERE deleted_at IS NULL;`);
  const runtime = db.dialect === 'postgres' ? "(metadata::jsonb #>> '{question,wait,runtime_id}')" : "json_extract(metadata,'$.question.wait.runtime_id')";
  db.exec(`CREATE INDEX IF NOT EXISTS idx_questions_runtime_wait ON multiremi_conversation_log(${runtime}) WHERE message_kind='decision' AND deleted_at IS NULL;`);
}

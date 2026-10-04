import type { SqlDatabase } from "../db/postgres.js";
import { nowIso } from "@multiremi/ids.js";

export const FOLD_AGENT_READ_STATE_MIGRATION = "20261005_fold_agent_read_state";

/** Fold once under the startup migration lock, including partially consumed messages. */
export function foldAgentReadState(db: SqlDatabase): void {
  if (db.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(FOLD_AGENT_READ_STATE_MIGRATION)) return;
  db.transaction(() => {
    db.exec("ALTER TABLE multiremi_session_lanes ADD COLUMN cursor_offset INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE multiremi_turns ADD COLUMN trigger_message_id TEXT");
    const heads = db.query("SELECT session_id,agent_read_state FROM multiremi_conversation_heads").all();
    const at = nowIso();
    for (const head of heads) {
      const state = typeof head.agent_read_state === "string" ? JSON.parse(head.agent_read_state) : head.agent_read_state ?? {};
      for (const [agentId, value] of Object.entries(state)) {
        const progress = value as { seq: number; offset: number };
        db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at)
          VALUES(?,'agent',?,'',?,?) ON CONFLICT DO NOTHING`, [head.session_id, agentId, at, at]);
        db.run(`UPDATE multiremi_session_lanes SET
          cursor_offset=CASE WHEN cursor_seq < ? THEN ? WHEN cursor_seq = ? AND cursor_offset < ? THEN ? ELSE cursor_offset END,
          cursor_seq=CASE WHEN cursor_seq < ? THEN ? ELSE cursor_seq END
          WHERE session_id=? AND reader_type='agent' AND reader_id=?`,
          [progress.seq, progress.offset ?? 0, progress.seq, progress.offset ?? 0, progress.offset ?? 0, progress.seq, progress.seq, head.session_id, agentId]);
      }
    }
    db.run("UPDATE multiremi_turns SET trigger_message_id=trigger_comment_id WHERE trigger_comment_id IS NOT NULL");
    db.run("INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES(?,?)", [FOLD_AGENT_READ_STATE_MIGRATION, at]);
  })();
}

import type { SqlDatabase } from './db/postgres.js';

/** Preserve the pre-unification pagination access paths on the authoritative turns table. */
export function ensureTurnListIndexes(db: SqlDatabase): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_multiremi_turns_workspace_created
      ON multiremi_turns(workspace_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_multiremi_turns_workspace_status_created
      ON multiremi_turns(workspace_id, status, created_at DESC, id DESC);
  `);
}

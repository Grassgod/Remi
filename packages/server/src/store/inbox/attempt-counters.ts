import type { SqlDatabase } from '../db/postgres.js';
import { nowIso } from '@multiremi/ids.js';
/** Counts previously lived in JSON and accept every safe JavaScript integer. */
export function widenAttemptCounters(db: SqlDatabase): void {
    const id = '20261005_attempt_counters_bigint';
    if (db.query('SELECT id FROM multiremi_schema_migrations WHERE id=?').get(id))
        return;
    db.transaction(() => {
        if (db.dialect === 'postgres')
            db.exec(`ALTER TABLE multiremi_turn_attempts
      ALTER COLUMN event_count TYPE BIGINT, ALTER COLUMN tool_call_count TYPE BIGINT`);
        db.run('INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES(?,?)', [id, nowIso()]);
    })();
}
/** Execution checkpoints never overwrite the actual reader high water. */
export function separateLaneProviderProgress(db: SqlDatabase): void {
    const id = '20261005_separate_lane_provider_progress';
    if (db.query('SELECT id FROM multiremi_schema_migrations WHERE id=?').get(id))
        return;
    db.transaction(() => {
        const columns = new Set(db.query('PRAGMA table_info(multiremi_session_lanes)').all().map(row => row.name));
        if (!columns.has('provider_cursor_seq')) {
            db.exec('ALTER TABLE multiremi_session_lanes ADD COLUMN provider_cursor_seq INTEGER NOT NULL DEFAULT 0');
        }
        db.run("UPDATE multiremi_session_lanes SET provider_cursor_seq=cursor_seq WHERE reader_type='agent'");
        db.run('INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES(?,?)', [id, nowIso()]);
    })();
}

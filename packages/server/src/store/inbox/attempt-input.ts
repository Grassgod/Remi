import type { SqlDatabase } from '../db/postgres.js';
import type { StoreContext } from '../context.js';
import { nowIso } from '@multiremi/ids.js';
/** Business coverage stays monotonic; read receipts belong to a provider attempt. */
export function migrateAttemptInput(db: SqlDatabase): void {
    const id = '20261005_attempt_input_receipts';
    if (db.query('SELECT id FROM multiremi_schema_migrations WHERE id=?').get(id))
        return;
    db.transaction(() => {
        const columns = new Set(db.query('PRAGMA table_info(multiremi_turn_attempts)').all().map(row => row.name));
        for (const column of ['input_ack_seq', 'input_read_seq', 'input_read_offset', 'input_trigger_ack'])
            if (!columns.has(column))
                db.exec(`ALTER TABLE multiremi_turn_attempts ADD COLUMN ${column} INTEGER`);
        // Public decisions created before this fix must have the same stored state
        // as decisions emitted by the question and Issue adapters.
        for (const row of db.query("SELECT id,metadata,resolved_at FROM multiremi_conversation_log WHERE kind='message' AND message_kind='decision'").all()) {
            const metadata = JSON.parse(row.metadata ?? '{}');
            const key = metadata.human_request ? 'human_request' : 'decision_record';
            if (metadata[key]?.status == null) {
                metadata[key] = { ...metadata[key], status: row.resolved_at ? (key === 'human_request' ? 'responded' : 'answered') : 'pending' };
                db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?', [JSON.stringify(metadata), row.id]);
            }
        }
        db.run('INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES(?,?)', [id, nowIso()]);
    })();
}
/** Caller holds the lane mutex. Preparing a new provider leaves actual reading unchanged. */
export function attemptInputState(ctx: StoreContext, turn: any): {
    ack: number;
    read: number;
    offset: number;
} {
    const attempt = ctx.db.query('SELECT * FROM multiremi_turn_attempts WHERE id=?').get(turn.current_attempt_id);
    if (!attempt)
        throw new Error('stale_attempt');
    if (attempt.input_ack_seq == null) {
        const lane = ctx.db.query("SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?")
            .get(turn.session_id, turn.agent_id, turn.execution_scope);
        const from = attempt.session_id ? Number(lane?.cursor_seq ?? 0) : 0;
        ctx.db.run('UPDATE multiremi_turn_attempts SET input_ack_seq=?,input_read_seq=?,input_read_offset=0 WHERE id=?', [from, from, attempt.id]);
        return { ack: from, read: from, offset: 0 };
    }
    return { ack: Number(attempt.input_ack_seq), read: Number(attempt.input_read_seq ?? attempt.input_ack_seq), offset: Number(attempt.input_read_offset ?? 0) };
}
export function acknowledgeAttemptInput(ctx: StoreContext, turn: any, toSeq: number): void {
    const state = attemptInputState(ctx, turn);
    ctx.db.run('UPDATE multiremi_turn_attempts SET input_ack_seq=?,input_trigger_ack=1 WHERE id=?', [Math.max(state.ack, toSeq), turn.current_attempt_id]);
}

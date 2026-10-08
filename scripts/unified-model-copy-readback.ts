import { createHash } from "node:crypto";
import type { SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { reconcileUnifiedModel, tableExists, type UnifiedModelReport } from "../packages/server/src/store/unified-model-migration.js";

type Row = Record<string, any>;
export interface CopyBaseline {
  counts: Record<string, number>;
  issues: Row[];
  checkpoints: Row[];
  reads: Row[];
}
export const laneKey = (lane: Row) => JSON.stringify([lane.session_id, lane.reader_id ?? lane.agent_id, lane.execution_scope ?? ""]);
export function pages(db: SqlDatabase, sql: string, params: unknown[] = []): Row[] {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 64) {
    const page = db.query(`${sql} LIMIT 64 OFFSET ?`).all(...params, offset) as Row[];
    rows.push(...page);
    if (page.length < 64) return rows;
  }
}
export function inventory(db: SqlDatabase): Record<string, number> {
  const tables = db.dialect === "postgres"
    ? pages(db, "SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")
    : pages(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  return Object.fromEntries(tables.filter(t => /^multiremi_[a-z0-9_]+$/.test(t.name)).map(t =>
    [t.name, Number(db.query(`SELECT COUNT(*) AS n FROM ${t.name}`).get()?.n ?? 0)]));
}
export function issueSnapshot(db: SqlDatabase): Row[] {
  return pages(db, "SELECT id,status,assignee_type,assignee_id,parent_issue_id FROM multiremi_issues ORDER BY id");
}
export function copyReadPositions(baseline: CopyBaseline) {
  const positions = new Map<string, { seq: number; offset: number }>();
  for (const head of baseline.reads) {
    const state = typeof head.agent_read_state === "string" ? JSON.parse(head.agent_read_state) : head.agent_read_state ?? {};
    for (const [agentId, value] of Object.entries(state)) {
      const position = value as { seq: number; offset?: number };
      positions.set(laneKey({ session_id: head.session_id, agent_id: agentId }), { seq: position.seq, offset: position.offset ?? 0 });
    }
  }
  return positions;
}

/** Shared by each child's ready boundary and the final parent reconciliation. */
export function reconcileCopyReadback(db: SqlDatabase, before: UnifiedModelReport, original: CopyBaseline) {
  const readPositions = copyReadPositions(original);
  const report = reconcileUnifiedModel(db, before);
  const lanes = pages(db, "SELECT * FROM multiremi_session_lanes WHERE reader_type='agent' ORDER BY session_id,reader_id,execution_scope");
  const byKey = new Map(lanes.map(lane => [laneKey(lane), lane]));
  const mismatches = [...report.mismatches];
  for (const checkpoint of original.checkpoints) {
    const actual = byKey.get(laneKey(checkpoint));
    for (const key of ['parent_cursor_seq', 'wake_hint_seq', 'swept_to_seq', 'provider_session_id', 'work_dir', 'generation']) {
      if (!actual || actual[key] !== checkpoint[key]) mismatches.push(`checkpoint ${key}: ${laneKey(checkpoint)}`);
    }
    if (Number(actual?.provider_cursor_seq) !== Number(checkpoint.cursor_seq)) mismatches.push(`provider cursor: ${laneKey(checkpoint)}`);
  }
  for (const [key, position] of readPositions) {
    const actual = byKey.get(key);
    if (Number(actual?.cursor_seq) !== position.seq || Number(actual?.cursor_offset) !== position.offset) mismatches.push(`actual read progress: ${key}`);
  }
  const issues = issueSnapshot(db);
  const hash = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  if (hash(issues) !== hash(original.issues)) mismatches.push("stored Issue status/assignment/parent changed during startup");
  const counts = inventory(db);
  for (const name of ['multiremi_issues', 'multiremi_issue_sessions', 'multiremi_chat_sessions', 'multiremi_autopilots']) {
    if (counts[name] !== original.counts[name]) mismatches.push(`retained row count: ${name}`);
  }
  const unread = tableExists(db, 'multiremi_member_inbox_records')
    ? Number(db.query("SELECT COUNT(*) AS n FROM multiremi_member_inbox_records WHERE read=0").get()?.n ?? 0) : 0;
  if (unread) mismatches.push(`historical member notifications replayed: ${unread}`);
  return { ...report, mismatches, table_counts: counts, checkpoint_count: original.checkpoints.length,
    read_position_count: readPositions.size, partial_read_count: [...readPositions.values()].filter(p => p.offset > 0).length,
    issue_snapshot: issues };
}

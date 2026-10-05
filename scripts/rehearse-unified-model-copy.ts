/** Offline migration job. No API, scheduler, daemon, bot or provider is started. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { collectUnifiedBeforeReport, reconcileUnifiedModel, tableExists, unifiedModelPreflight } from "../packages/server/src/store/unified-model-migration.js";
import { runMigrations } from "../packages/server/src/store/migrations.js";
import { UNIFIED_MODEL_MIGRATION } from "../packages/server/src/store/unified-model-schema.js";
import { readOnlyConversationTransaction } from "./reconcile-conversation-log.js";

type Row = Record<string, any>;
function pages(db: SqlDatabase, sql: string, params: unknown[] = []): Row[] {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 64) {
    const page = db.query(`${sql} LIMIT 64 OFFSET ?`).all(...params, offset) as Row[];
    rows.push(...page);
    if (page.length < 64) return rows;
  }
}
function save(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
const hash = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const laneKey = (lane: Row) => JSON.stringify([lane.session_id, lane.reader_id ?? lane.agent_id, lane.execution_scope ?? ""]);

function inventory(db: SqlDatabase): Record<string, number> {
  const tables = db.dialect === "postgres"
    ? pages(db, "SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")
    : pages(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  return Object.fromEntries(tables.filter(t => /^multiremi_[a-z0-9_]+$/.test(t.name)).map(t =>
    [t.name, Number(db.query(`SELECT COUNT(*) AS n FROM ${t.name}`).get()?.n ?? 0)]));
}
function issueSnapshot(db: SqlDatabase): Row[] {
  return pages(db, "SELECT id,status,assignee_type,assignee_id,parent_issue_id FROM multiremi_issues ORDER BY id");
}
function issueSamples(db: SqlDatabase, issues: Row[]): Row[] {
  const picked: Row[] = [], groups = new Map<string, number>();
  for (const issue of issues) {
    const group = `${issue.status}/${issue.assignee_type ?? 'unassigned'}/${issue.parent_issue_id ? 'child' : 'root'}`;
    const used = groups.get(group) ?? 0;
    if (used >= 3) continue;
    groups.set(group, used + 1);
    picked.push(issue);
  }
  // Explicitly include retry chains, unanswered decisions and parents even if
  // they are rare in a large status group. No message bodies leave the copy.
  const extra = db.query(`SELECT DISTINCT i.id FROM multiremi_issues i WHERE
    EXISTS (SELECT 1 FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id WHERE t.issue_id=i.id AND a.attempt_no>1)
    OR EXISTS (SELECT 1 FROM multiremi_issue_sessions s JOIN multiremi_conversation_log m ON m.session_id=s.id
      WHERE s.issue_id=i.id AND m.message_kind='decision' AND m.resolved_at IS NULL AND m.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM multiremi_issues c WHERE c.parent_issue_id=i.id)
    ORDER BY i.id LIMIT 15`).all() as Row[];
  const ids = new Set([...picked.map(i => i.id), ...extra.map(i => i.id)]);
  return issues.filter(i => ids.has(i.id)).map(issue => ({
    ...issue,
    turns: pages(db, `SELECT t.id,t.agent_id,t.status,t.wake_source,t.session_id,t.trigger_message_id,
      (SELECT COUNT(*) FROM multiremi_turn_attempts a WHERE a.turn_id=t.id) AS attempts
      FROM multiremi_turns t WHERE t.issue_id=? ORDER BY t.created_at DESC,t.seq DESC,t.id DESC`, [issue.id]),
    decisions: pages(db, `SELECT m.id,m.sender_type,m.sender_id,m.resolved_at,
      CASE WHEN EXISTS(SELECT 1 FROM multiremi_conversation_log r WHERE r.reply_to_id=m.id AND r.message_kind='reply' AND r.deleted_at IS NULL) THEN 1 ELSE 0 END AS answered
      FROM multiremi_conversation_log m JOIN multiremi_issue_sessions s ON s.id=m.session_id
      WHERE s.issue_id=? AND m.kind='message' AND m.message_kind='decision' AND m.deleted_at IS NULL ORDER BY m.id`, [issue.id]),
    children: pages(db, "SELECT id,status FROM multiremi_issues WHERE parent_issue_id=? ORDER BY id", [issue.id]),
    review: "manual: apply inbox/issue-status.ts owner, trigger and child guards; migration does not rederive stored Issue status",
  }));
}

/** Fixed identity of the PG container created by the companion shell script. */
export function validateCopyDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error("MUL493_COPY_DATABASE_URL is required; ambient production database configuration is never used");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid copy database URL"); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== "mul493-copy-postgres"
      || url.port !== "5432" || url.username !== "mul493_rehearsal" || url.password
      || url.pathname !== "/mul493_rehearsal" || url.search || url.hash) {
    throw new Error("Only the isolated mul493-copy-postgres rehearsal database is allowed");
  }
  return value;
}

/** Exported for local synthetic fixtures; the CLI only opens the isolated PG. */
export function rehearseUnifiedModelCopy(db: SqlDatabase, reportDir: string): Row {
  if (db.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(UNIFIED_MODEL_MIGRATION)) {
    throw new Error("Copy is already migrated; restore the immutable pre-cutover backup for every run");
  }
  const preflight = readOnlyConversationTransaction(db, () => unifiedModelPreflight(db));
  save(reportDir, "preflight.json", preflight);
  if (preflight.some(c => !c.ok)) throw new Error("Copy is not drained; see preflight.json. Never delete or rewrite blockers to manufacture a pass");
  const before = readOnlyConversationTransaction(db, () => collectUnifiedBeforeReport(db));
  const original = readOnlyConversationTransaction(db, () => ({
    counts: inventory(db), issues: issueSnapshot(db),
    checkpoints: pages(db, `SELECT session_id,agent_id,execution_scope,cursor_seq,parent_cursor_seq,
      wake_hint_seq,swept_to_seq,provider_session_id,work_dir,generation
      FROM multiremi_session_agent_lanes ORDER BY session_id,agent_id,execution_scope`),
    reads: pages(db, "SELECT session_id,agent_read_state FROM multiremi_conversation_heads ORDER BY session_id"),
  }));
  save(reportDir, "copy-baseline.json", original);
  const readPositions = new Map<string, { seq: number; offset: number }>();
  for (const head of original.reads) {
    const state = typeof head.agent_read_state === "string" ? JSON.parse(head.agent_read_state) : head.agent_read_state ?? {};
    for (const [agentId, value] of Object.entries(state)) {
      const position = value as { seq: number; offset?: number };
      readPositions.set(laneKey({ session_id: head.session_id, agent_id: agentId }), { seq: position.seq, offset: position.offset ?? 0 });
    }
  }
  const previousDir = process.env.MULTIREMI_MIGRATION_REPORT_DIR;
  let migrationMs: number, restartMs: number;
  try {
    process.env.MULTIREMI_MIGRATION_REPORT_DIR = reportDir;
    let started = performance.now();
    runMigrations(db); // Same complete migration entry point as API startup.
    migrationMs = performance.now() - started;
    started = performance.now();
    runMigrations(db);
    restartMs = performance.now() - started;
  } finally {
    if (previousDir === undefined) delete process.env.MULTIREMI_MIGRATION_REPORT_DIR;
    else process.env.MULTIREMI_MIGRATION_REPORT_DIR = previousDir;
  }
  // MUL-507 separates provider checkpoints from actual consumption. Keep the
  // raw before/after reports, compare final read positions to agent_read_state,
  // and compare original checkpoints to provider_cursor_seq independently.
  const finalBefore = { ...before, lane_cursors: before.lane_cursors.map(lane => ({
    ...lane, cursor_seq: readPositions.get(laneKey(lane))?.seq ?? lane.cursor_seq,
  })) };
  const final = readOnlyConversationTransaction(db, () => {
    const report = reconcileUnifiedModel(db, finalBefore);
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
      issue_samples: issueSamples(db, issues) };
  });
  save(reportDir, "copy-reconciliation.json", final);
  const summary = { migration: UNIFIED_MODEL_MIGRATION, migrationMs, restartMs, counts: final.counts,
    mismatches: final.mismatches, issue_sample_count: final.issue_samples.length,
    issue_sampling: "manual review required", checkpoint_count: final.checkpoint_count,
    read_position_count: final.read_position_count, partial_read_count: final.partial_read_count };
  save(reportDir, "copy-timing.json", summary);
  if (final.mismatches.length) throw new Error("Copy reconciliation failed; inspect private copy-reconciliation.json");
  return summary;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, 'report-dir': { type: 'string' } } });
  if (values.help) {
    console.log("Usage: bun scripts/rehearse-unified-model-copy.ts --report-dir DIR\nOnly via rehearse-unified-model-copy.sh after approval; uses MUL493_COPY_DATABASE_URL, never MULTIREMI_DATABASE_URL.");
  } else {
    const url = validateCopyDatabaseUrl(process.env.MUL493_COPY_DATABASE_URL);
    if (!values['report-dir']) throw new Error("--report-dir is required");
    const { PostgresSyncDatabase } = await import('../packages/server/src/store/db/postgres.js');
    const db = new PostgresSyncDatabase(url);
    try {
      const identity = db.query("SELECT current_database() AS database,current_user AS role").get();
      if (identity?.database !== 'mul493_rehearsal' || identity?.role !== 'mul493_rehearsal') throw new Error("Copy database identity mismatch");
      console.log(JSON.stringify(rehearseUnifiedModelCopy(db, values['report-dir'])));
    } finally { db.close(); }
  }
}

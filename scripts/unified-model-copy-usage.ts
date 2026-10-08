import { createHash } from "node:crypto";
import type { SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER } from "../packages/server/src/store/usage-accounting.js";

type Row = Record<string, any>;
export interface CopyUsageSnapshot {
  markers: Row[];
  tables: Record<string, { count: number; content_sha256: string; columns: string[]; orphan_task_refs: number }>;
  unit_evidence: Row[];
}

/** Hash every column, reconstructing long JSON in bounded bridge replies. */
function tableSummary(db: SqlDatabase, table: string, taskTable: string): CopyUsageSnapshot["tables"][string] {
  const schema = db.query(`PRAGMA table_info(${table})`).all() as Row[];
  const columns = schema.map(c => String(c.name)).sort();
  // The PG adapter's table_info compatibility projection omits primary keys.
  const keys = db.dialect === "postgres"
    ? db.query(`SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a
        ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
        WHERE i.indisprimary AND i.indrelid=CAST(? AS regclass) ORDER BY a.attname`).all(table).map(c => String(c.name))
    : schema.filter(c => Number(c.pk) > 0).map(c => String(c.name)).sort();
  if (!keys.length) throw new Error(`Usage table has no stable primary key: ${table}`);
  const textColumns = new Set(schema.filter(c => /TEXT/i.test(c.type)).map(c => String(c.name)));
  const selected = columns.map(c => textColumns.has(c) ? `SUBSTR(${c},1,8192) AS ${c}` : c);
  const digest = createHash("sha256").update(JSON.stringify(columns) + "\n");
  const where = keys.map(k => `${k}=?`).join(" AND ");
  let count = 0;
  for (let offset = 0; ; offset += 64) {
    const page = db.query(`SELECT ${keys.join(",")} FROM ${table} ORDER BY ${keys.join(",")} LIMIT 64 OFFSET ?`).all(offset) as Row[];
    for (const key of page) {
      const params = keys.map(k => key[k]);
      const row = db.query(`SELECT ${selected.join(",")} FROM ${table} WHERE ${where}`).get(...params) as Row;
      for (const column of textColumns) {
        if (row[column] == null || String(row[column]).length < 8192) continue;
        for (let start = 8193; ; start += 8192) {
          const part = db.query(`SELECT SUBSTR(${column},?,8192) AS part FROM ${table} WHERE ${where}`).get(start, ...params)?.part;
          if (!part) break;
          row[column] += String(part);
          if (String(part).length < 8192) break;
        }
      }
      digest.update(JSON.stringify(columns.map(c => row[c])) + "\n");
      count++;
    }
    if (page.length < 64) break;
  }
  let orphanRefs = 0;
  for (const column of ["task_id", "owner_task_id"].filter(c => columns.includes(c))) {
    orphanRefs += Number(db.query(`SELECT COUNT(*) AS n FROM ${table} u LEFT JOIN ${taskTable} t
      ON t.id=u.${column} WHERE u.${column} IS NOT NULL AND t.id IS NULL`).get()?.n ?? 0);
  }
  return { count, content_sha256: digest.digest("hex"), columns, orphan_task_refs: orphanRefs };
}

export function collectCopyUsageSnapshot(db: SqlDatabase, taskTable: "multiremi_tasks" | "multiremi_turn_attempts"): CopyUsageSnapshot {
  const names = (db.dialect === "postgres"
    ? db.query("SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename").all()
    : db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) as Row[];
  const tables = Object.fromEntries(names.filter(t => /^multiremi_usage_[a-z0-9_]+$/.test(t.name))
    .map(t => [t.name, tableSummary(db, t.name, taskTable)]));
  const markers = db.query("SELECT id,applied_at FROM multiremi_schema_migrations WHERE id IN (?,?) ORDER BY id")
    .all(USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER);
  // These are scalar evidence totals, with unknowns kept explicit. The full
  // digest also covers attribution, receipts, owner/conflict and coverage rows.
  const unitEvidence = tables.multiremi_usage_units ? db.query(`SELECT source,accuracy,cost_currency,cost_source,
    cost_coverage_complete,COUNT(*) AS units,
    SUM(CASE WHEN source<>'context_snapshot' THEN COALESCE(input_tokens,0)+COALESCE(output_tokens,0)
      +COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0) ELSE 0 END) AS actual_tokens,
    SUM(context_tokens) AS context_tokens,SUM(reported_total_tokens) AS reported_total_tokens,SUM(cost_amount) AS cost_amount,
    SUM(CASE WHEN input_tokens IS NULL AND output_tokens IS NULL AND cache_read_tokens IS NULL
      AND cache_write_tokens IS NULL AND actual_unsplit_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_consumption_units,
    SUM(CASE WHEN cost_amount IS NULL THEN 1 ELSE 0 END) AS unknown_money_units
    FROM multiremi_usage_units GROUP BY source,accuracy,cost_currency,cost_source,cost_coverage_complete
    ORDER BY source,accuracy,cost_currency,cost_source,cost_coverage_complete`).all() : [];
  return { markers, tables, unit_evidence: unitEvidence };
}

export function reconcileCopyUsage(before: CopyUsageSnapshot, after: CopyUsageSnapshot): { mismatches: string[]; changed_tables: string[] } {
  const mismatches: string[] = [], changed: string[] = [];
  for (const name of new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])) {
    if (JSON.stringify(before.tables[name]) !== JSON.stringify(after.tables[name])) {
      changed.push(name);
      mismatches.push(`usage content changed: ${name}`);
    }
    if (after.tables[name]?.orphan_task_refs) mismatches.push(`usage attempt attribution missing: ${name}`);
  }
  if (JSON.stringify(before.markers) !== JSON.stringify(after.markers)) mismatches.push("usage cutover markers changed");
  if (JSON.stringify(before.unit_evidence) !== JSON.stringify(after.unit_evidence)) mismatches.push("usage actual/context/unknown/money evidence changed");
  return { mismatches, changed_tables: changed };
}

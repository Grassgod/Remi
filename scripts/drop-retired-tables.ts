import { parseArgs } from "node:util";
import { statSync, readFileSync } from "node:fs";
import { openSqliteDatabase } from "../packages/server/src/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { UNIFIED_MODEL_MIGRATION } from "../packages/server/src/store/unified-model-schema.js";
import { reconcileUnifiedModel, type UnifiedModelReport } from "../packages/server/src/store/unified-model-migration.js";

export const RETIRED_TABLE_SETS = {
  mul432: ["multiremi_session_events","multiremi_issue_comments","multiremi_chat_messages","multiremi_task_messages"],
  mul493: ["multiremi_task_steer_messages","multiremi_task_human_requests","multiremi_issue_decisions",
    "multiremi_inbox_items","multiremi_agent_issue_update_state","multiremi_task_prompts"],
} as const;
export const RETIRED_COLUMN_SETS={mul432:[],mul493:[{table:"multiremi_conversation_heads",column:"agent_read_state"}]} as const;
export type RetiredTableSet = keyof typeof RETIRED_TABLE_SETS;

/** Does not guess DB URLs and never falls back to the live Store or migrations. */
export function dropRetiredTables(db: SqlDatabase, input: {
  set: RetiredTableSet; execute?: boolean; confirmDrop?: boolean;
  reconciliation: UnifiedModelReport; backup?: string; now?: Date;
}): { dry_run: boolean; tables: string[]; columns: readonly {table:string;column:string}[]; minimum_age_days: number } {
  const tables = [...RETIRED_TABLE_SETS[input.set]];
  const columns = RETIRED_COLUMN_SETS[input.set];
  if (!tables.length) throw new Error("Unknown retired table set");
  const report = input.reconciliation;
  if (report.migration !== UNIFIED_MODEL_MIGRATION || report.phase !== "after" || report.mismatches.length
      || report.checks.some(c => !c.ok) || !report.checks.length) throw new Error("A successful unified-model reconciliation report is required");
  const now = input.now ?? new Date();
  const reportTime = Date.parse(report.generated_at);
  if (!Number.isFinite(reportTime) || reportTime > now.getTime() || now.getTime()-reportTime > 86_400_000) throw new Error("Reconciliation report must be from the last 24 hours");
  const migration = db.query("SELECT applied_at FROM multiremi_schema_migrations WHERE id=?").get(UNIFIED_MODEL_MIGRATION);
  const age = (now.getTime()-Date.parse(migration?.applied_at ?? ""))/86_400_000;
  if (!Number.isFinite(age) || age < 7) throw new Error("Unified model must have run for at least 7 days before dropping tables");
  const current = reconcileUnifiedModel(db);
  if (current.mismatches.length || current.attempt_ids_digest !== report.attempt_ids_digest
      || JSON.stringify(current.counts) !== JSON.stringify(report.counts)) throw new Error("Reconciliation no longer matches this database; generate a fresh report");
  if (!input.execute) return { dry_run: true, tables, columns, minimum_age_days: 7 };
  if (!input.confirmDrop) throw new Error("Execution requires --execute and --confirm-drop");
  if (!input.backup || !statSync(input.backup).isFile() || statSync(input.backup).size === 0) throw new Error("Execution requires a non-empty backup file");
  // No CASCADE. Surviving foreign keys deliberately stop deletion, rather than
  // dropping live constraints or data along with retired tables.
  db.transaction(() => {
    for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table}`);
    for(const {table,column} of RETIRED_COLUMN_SETS[input.set]){
      if(!db.query("SELECT id FROM multiremi_schema_migrations WHERE id='20261005_fold_agent_read_state'").get())throw new Error('Read-state fold must complete before retiring agent_read_state');
      if(db.query(`PRAGMA table_info(${table})`).all().some(row=>row.name===column))db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    const verified = reconcileUnifiedModel(db);
    if (verified.mismatches.length || verified.attempt_ids_digest !== current.attempt_ids_digest) throw new Error("Retired-table drop changed live model integrity");
  })();
  return { dry_run: false, tables, columns, minimum_age_days: 7 };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    set: { type: "string" }, sqlite: { type: "string" }, "postgres-env": { type: "string" },
    report: { type: "string" }, backup: { type: "string" }, execute: { type: "boolean" },
    "confirm-drop": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help || !values.set || !(values.set in RETIRED_TABLE_SETS) || !values.report
    || Boolean(values.sqlite) === Boolean(values["postgres-env"])) {
    console.log("Usage: bun run scripts/drop-retired-tables.ts --set mul432|mul493 (--sqlite PATH | --postgres-env ENV_NAME) --report REPORT [--execute --confirm-drop --backup BACKUP]");
    process.exit(values.help ? 0 : 2);
  }
  if (values["postgres-env"] && !process.env[values["postgres-env"]]) throw new Error("Selected PostgreSQL environment variable is not set");
  const db = values.sqlite ? openSqliteDatabase(values.sqlite,values.execute ? { readwrite: true } : { readonly: true })
    : new PostgresSyncDatabase(process.env[values["postgres-env"]!]!);
  try {
    if (!values.execute && db.dialect === "postgres") {
      console.log(JSON.stringify(db.transaction(() => {
        db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        return dropRetiredTables(db,{set:values.set as RetiredTableSet,reconciliation:JSON.parse(readFileSync(values.report!,"utf8"))});
      })()));
    } else console.log(JSON.stringify(dropRetiredTables(db,{ set:values.set as RetiredTableSet, execute:values.execute,
      confirmDrop:values["confirm-drop"],backup:values.backup,reconciliation:JSON.parse(readFileSync(values.report,"utf8")) })));
  } finally { db.close(); }
}

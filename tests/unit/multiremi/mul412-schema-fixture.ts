import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

/**
 * Restore the schema to the exact additive-column layout at 828291b9. Besides
 * MUL-412's three nullable columns and index, current main has MUL-457's three
 * parent-grant columns; removing both sets makes this a real 828 upgrade.
 */
export function restoreMul412Baseline828291b9Schema(db: SqlDatabase): void {
  db.exec("DROP INDEX IF EXISTS idx_multiremi_feishu_bot_outbound_decision");
  db.exec("ALTER TABLE multiremi_feishu_bot_outbound_deliveries DROP COLUMN decision_id");
  db.exec("ALTER TABLE multiremi_feishu_bot_outbound_deliveries DROP COLUMN decision_issue_id");
  db.exec("ALTER TABLE multiremi_issue_decisions DROP COLUMN reminder_sent_at");
  db.exec("ALTER TABLE multiremi_issues DROP COLUMN parent_done_grant_at");
  db.exec("ALTER TABLE multiremi_issues DROP COLUMN parent_done_grant_by");
  db.exec("ALTER TABLE multiremi_issues DROP COLUMN parent_done_grant_agent_id");
}

export function tableColumns(db: SqlDatabase, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
}

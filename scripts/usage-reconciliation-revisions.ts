import { createHash } from "node:crypto";
import type { SqlDatabase } from "../packages/server/src/store/db/postgres.js";

export interface UsageRevisionRow { run_id: string; unit_id?: string; revision: number | string; disposition?: string; }
export interface UsageRevisionState { receipts: UsageRevisionRow[]; units: UsageRevisionRow[]; runs: UsageRevisionRow[]; }
const floors = new WeakMap<UsageRevisionState, { runs: Map<string, number>; units: Map<string, number> }>();
export function usageRevisionStateSha256(state: UsageRevisionState): string {
  const rows = [
    ...state.receipts.map(row => ["receipt", row.run_id, row.unit_id, Number(row.revision), row.disposition]),
    ...state.units.map(row => ["unit", row.run_id, row.unit_id, Number(row.revision)]),
    ...state.runs.map(row => ["run", row.run_id, Number(row.revision)]),
  ].map(row => JSON.stringify(row)).sort();
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
export function readUsageRevisionState(db: SqlDatabase, taskId: string): UsageRevisionState {
  return {
    receipts: db.query("SELECT run_id,unit_id,revision,disposition FROM multiremi_usage_unit_receipts WHERE task_id=? AND run_id IN ('legacy','historical-evidence-v2')").all(taskId),
    units: db.query("SELECT run_id,unit_id,revision FROM multiremi_usage_units WHERE task_id=? AND run_id IN ('legacy','historical-evidence-v2')").all(taskId),
    runs: db.query("SELECT run_id,revision FROM multiremi_usage_runs WHERE task_id=? AND run_id IN ('legacy','historical-evidence-v2')").all(taskId),
  };
}
export function nextUsageRevision(state: UsageRevisionState, runId: string, unitId?: string): number {
  let indexed = floors.get(state);
  if (!indexed) {
    indexed = { runs: new Map(), units: new Map() };
    for (const row of [...state.receipts, ...state.units, ...state.runs]) {
      const value = Number(row.revision);
      indexed.runs.set(row.run_id, Math.max(indexed.runs.get(row.run_id) ?? 0, value));
      if (row.unit_id !== undefined) {
        const key = JSON.stringify([row.run_id, row.unit_id]);
        indexed.units.set(key, Math.max(indexed.units.get(key) ?? 0, value));
      }
    }
    floors.set(state, indexed);
  }
  const revision = (unitId === undefined ? indexed.runs.get(runId) : indexed.units.get(JSON.stringify([runId, unitId]))) ?? 0;
  const next = revision + 1;
  if (!Number.isSafeInteger(next) || next > 2_147_483_647) throw new Error("Historical usage revision exhausted; reviewed repair required");
  return next;
}

/** Global keyset scans keep replies bounded; only revision scalars enter memory. */
export async function readPlanUsageRevisionStates(sql: Bun.SQL): Promise<Map<string, UsageRevisionState>> {
  const states = new Map<string, UsageRevisionState>();
  for (const [kind, table, columns, keys] of [
    ["receipts", "multiremi_usage_unit_receipts", "task_id,run_id,unit_id,revision,disposition", ["task_id", "run_id", "unit_id"]],
    ["units", "multiremi_usage_units", "task_id,run_id,unit_id,revision", ["task_id", "run_id", "unit_id"]],
    ["runs", "multiremi_usage_runs", "task_id,run_id,revision", ["task_id", "run_id"]],
  ] as const) {
    let cursor: unknown[] | null = null;
    for (;;) {
      const boundary: string = cursor ? ` AND (${keys.join(",")})>(${keys.map((_, index) => `$${index + 1}`).join(",")})` : "";
      const rows: (UsageRevisionRow & { task_id: string; [key: string]: unknown })[] = await sql.unsafe(`SELECT ${columns} FROM ${table} WHERE run_id IN ('legacy','historical-evidence-v2')${boundary} ORDER BY ${keys.join(",")} LIMIT 1000`, cursor ?? []);
      for (const row of rows) {
        const state = states.get(row.task_id) ?? { receipts: [], units: [], runs: [] };
        state[kind].push(row as UsageRevisionRow); states.set(row.task_id, state);
      }
      if (rows.length < 1000) break;
      cursor = keys.map((key): unknown => rows.at(-1)![key]);
    }
  }
  return states;
}

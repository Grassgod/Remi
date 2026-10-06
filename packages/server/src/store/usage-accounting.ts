import type { TaskUsageSnapshot, TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import { createHash } from "node:crypto";
import { advisoryLock, advisoryXactLock, type SqlDatabase } from "@multiremi/store/db/postgres.js";

type Row = Record<string, unknown>;
export class UsageValidationError extends Error {}
export class UsageAccountingNotReadyError extends Error {}
export const USAGE_CUTOVER_MARKER = "20261006_usage_accounting_v2";
export interface UsageScopeEvidence { id: string | null; provenance: string; }
export interface UsageWriteOptions { historical?: boolean; runtimeScope?: UsageScopeEvidence; projectScope?: UsageScopeEvidence; identityLocksHeld?: boolean; }
const UNIT_FIELDS = ["provider", "model", "model_source", "purpose", "requested_model", "connection_id", "provider_session_id", "provider_request_id", "provider_observation_id", "identity_kind", "meter_evidence", "time_provenance", "scope", "source", "accuracy", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "actual_unsplit_tokens", "reported_total_tokens", "context_tokens", "context_window", "cost_amount", "cost_currency", "cost_source", "cost_coverage_expected_count", "cost_coverage_sha256", "occurred_at", "evidence_ref"];
const METER_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;
const meterJson = (unit: TaskUsageUnit) => unit.meterEvidence ? JSON.stringify({ epochId: unit.meterEvidence.epochId,
  before: METER_FIELDS.map(key => unit.meterEvidence!.before[key]), after: METER_FIELDS.map(key => unit.meterEvidence!.after[key]),
  last: unit.meterEvidence.last ? METER_FIELDS.map(key => unit.meterEvidence!.last![key]) : null }) : null;
const coverageHash = (ids: string[]) => createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex");
// Fixed-width UTF-16 code units preserve JavaScript sort order, including
// supplementary Unicode characters, independently of database collation.
const coverageSortKey = (id: string) => Array.from({ length: id.length }, (_, index) => id.charCodeAt(index).toString(16).padStart(4, "0")).join("");
const COVERAGE_PAGE_SIZE = 512;
function unitValues(u: TaskUsageUnit): unknown[] {
  return [u.provider, u.model, u.modelSource ?? "unknown", u.purpose ?? "agent", u.requestedModel ?? null, u.connectionId ?? null,
    u.providerSessionId ?? null, u.providerRequestId ?? null, u.providerObservationId ?? null, u.identityKind ?? (u.providerRequestId ? "request" : null), meterJson(u), u.timeProvenance ?? (u.source === "legacy_task" ? "task_attributed" : "observed_at"), u.scope, u.source, u.accuracy,
    u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.actualUnsplitTokens, u.reportedTotalTokens,
    u.contextTokens, u.contextWindow, u.costAmount, u.costCurrency, u.costSource ?? (u.costAmount !== null ? "provider_reported" : "unknown"),
    u.coverageExpectedCount ?? (u.coveredUnitIds === undefined ? null : u.coveredUnitIds.length),
    u.coverageSha256 ?? (u.coveredUnitIds === undefined ? null : coverageHash(u.coveredUnitIds)), new Date(u.occurredAt).toISOString(), u.evidenceRef ?? null];
}

function storedCoverageDigest(db: SqlDatabase, taskId: string, runId: string, monetaryUnitId: string): { count: number; sha256: string } {
  const collation = db.dialect === "postgres" ? 'COLLATE "C"' : "COLLATE BINARY";
  // Older link rows receive their deterministic key lazily in bounded pages.
  for (;;) {
    const missing = db.query(`SELECT covered_unit_id FROM multiremi_usage_cost_coverage
      WHERE task_id=? AND run_id=? AND monetary_unit_id=? AND covered_unit_sort_key IS NULL LIMIT ${COVERAGE_PAGE_SIZE}`).all(taskId, runId, monetaryUnitId) as Row[];
    if (!missing.length) break;
    for (const row of missing) db.run("UPDATE multiremi_usage_cost_coverage SET covered_unit_sort_key=? WHERE task_id=? AND run_id=? AND monetary_unit_id=? AND covered_unit_id=?",
      [coverageSortKey(String(row.covered_unit_id)), taskId, runId, monetaryUnitId, row.covered_unit_id]);
  }
  const hash = createHash("sha256");
  hash.update("[");
  let cursor: string | undefined, count = 0;
  for (;;) {
    const rows = db.query(`SELECT covered_unit_id,covered_unit_sort_key FROM multiremi_usage_cost_coverage
      WHERE task_id=? AND run_id=? AND monetary_unit_id=?${cursor === undefined ? "" : ` AND covered_unit_sort_key ${collation}>?`}
      ORDER BY covered_unit_sort_key ${collation} LIMIT ${COVERAGE_PAGE_SIZE}`).all(taskId, runId, monetaryUnitId, ...(cursor === undefined ? [] : [cursor])) as Row[];
    if (!rows.length) break;
    for (const row of rows) { if (count++) hash.update(","); hash.update(JSON.stringify(String(row.covered_unit_id))); }
    cursor = String(rows[rows.length - 1]!.covered_unit_sort_key);
  }
  hash.update("]");
  return { count, sha256: hash.digest("hex") };
}

export function ensureUsageAccountingSchema(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS multiremi_usage_runs (
      task_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, complete INTEGER NOT NULL,
      PRIMARY KEY(task_id, run_id), FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS multiremi_usage_task_scopes (
      task_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, runtime_id TEXT, project_id TEXT,
      active_run_id TEXT,
      runtime_provenance TEXT NOT NULL DEFAULT 'unknown', project_provenance TEXT NOT NULL DEFAULT 'unknown',
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS multiremi_usage_run_scopes (
      task_id TEXT NOT NULL,run_id TEXT NOT NULL,workspace_id TEXT NOT NULL,agent_id TEXT NOT NULL,runtime_id TEXT,project_id TEXT,
      runtime_provenance TEXT NOT NULL DEFAULT 'unknown', project_provenance TEXT NOT NULL DEFAULT 'unknown',
      PRIMARY KEY(task_id,run_id), FOREIGN KEY(task_id,run_id) REFERENCES multiremi_usage_runs(task_id,run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS multiremi_usage_units (
      task_id TEXT NOT NULL, run_id TEXT NOT NULL, unit_id TEXT NOT NULL, revision INTEGER NOT NULL,
      workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, runtime_id TEXT, project_id TEXT,
      runtime_provenance TEXT NOT NULL DEFAULT 'unknown', project_provenance TEXT NOT NULL DEFAULT 'unknown',
      provider TEXT NOT NULL, model TEXT, model_source TEXT NOT NULL DEFAULT 'unknown', purpose TEXT NOT NULL DEFAULT 'agent', requested_model TEXT, connection_id TEXT,
      provider_session_id TEXT,provider_request_id TEXT,provider_observation_id TEXT,identity_kind TEXT,meter_evidence TEXT,time_provenance TEXT NOT NULL DEFAULT 'observed_at',
      scope TEXT NOT NULL, source TEXT NOT NULL, accuracy TEXT NOT NULL,
      input_tokens BIGINT, output_tokens BIGINT, cache_read_tokens BIGINT, cache_write_tokens BIGINT,
      actual_unsplit_tokens BIGINT, reported_total_tokens BIGINT, context_tokens BIGINT, context_window BIGINT,
      cost_amount DOUBLE PRECISION, cost_currency TEXT, cost_source TEXT NOT NULL DEFAULT 'unknown',
      cost_coverage_expected_count INTEGER, cost_coverage_sha256 TEXT, cost_coverage_complete INTEGER NOT NULL DEFAULT 1,cost_coverage_received_count INTEGER,
      occurred_at TEXT NOT NULL, evidence_ref TEXT,
      PRIMARY KEY(task_id, run_id, unit_id), FOREIGN KEY(task_id, run_id) REFERENCES multiremi_usage_runs(task_id, run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_usage_units_workspace_time ON multiremi_usage_units(workspace_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_units_runtime_time ON multiremi_usage_units(workspace_id, runtime_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_units_project_time ON multiremi_usage_units(workspace_id, project_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_units_model ON multiremi_usage_units(workspace_id, provider, model, connection_id);
    CREATE TABLE IF NOT EXISTS multiremi_usage_unit_receipts (
      task_id TEXT NOT NULL,run_id TEXT NOT NULL,unit_id TEXT NOT NULL,revision INTEGER NOT NULL,
      disposition TEXT NOT NULL,normalized_json TEXT NOT NULL,
      PRIMARY KEY(task_id,run_id,unit_id), FOREIGN KEY(task_id,run_id) REFERENCES multiremi_usage_runs(task_id,run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS multiremi_usage_cost_coverage (
      task_id TEXT NOT NULL,run_id TEXT NOT NULL,monetary_unit_id TEXT NOT NULL,covered_unit_id TEXT NOT NULL,covered_unit_sort_key TEXT,
      PRIMARY KEY(task_id,run_id,monetary_unit_id,covered_unit_id),
      FOREIGN KEY(task_id,run_id,monetary_unit_id) REFERENCES multiremi_usage_units(task_id,run_id,unit_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_usage_cost_covered ON multiremi_usage_cost_coverage(task_id,run_id,covered_unit_id);
    CREATE TABLE IF NOT EXISTS multiremi_usage_request_owners (
      identity_key TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,provider TEXT NOT NULL,connection_id TEXT,
      provider_session_id TEXT NOT NULL,provider_request_id TEXT NOT NULL,task_id TEXT NOT NULL,run_id TEXT NOT NULL,
      token_unit_id TEXT,provider_money_unit_id TEXT,sdk_money_unit_id TEXT
    );
    CREATE TABLE IF NOT EXISTS multiremi_usage_identity_conflicts (
      task_id TEXT NOT NULL,run_id TEXT NOT NULL,unit_id TEXT NOT NULL,revision INTEGER NOT NULL,evidence_sha256 TEXT NOT NULL,
      identity_key TEXT NOT NULL,owner_task_id TEXT NOT NULL,owner_run_id TEXT NOT NULL,owner_unit_id TEXT,unit_json TEXT NOT NULL,previous_unit_json TEXT,recorded_at TEXT NOT NULL,
      PRIMARY KEY(task_id,run_id,unit_id,revision,evidence_sha256,identity_key)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_identity_conflict_task ON multiremi_usage_identity_conflicts(task_id,run_id);
    CREATE INDEX IF NOT EXISTS idx_usage_identity_conflict_owner ON multiremi_usage_identity_conflicts(owner_task_id,owner_run_id);
    CREATE INDEX IF NOT EXISTS idx_usage_request_namespace ON multiremi_usage_request_owners(workspace_id,provider,provider_session_id,provider_request_id);
    CREATE TABLE IF NOT EXISTS multiremi_usage_meter_owners (
      identity_key TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,provider TEXT NOT NULL,connection_id TEXT,
      provider_session_id TEXT NOT NULL,epoch_id TEXT NOT NULL,observation_id TEXT NOT NULL,
      task_id TEXT NOT NULL,run_id TEXT NOT NULL,unit_id TEXT NOT NULL,
      before_input BIGINT,after_input BIGINT,before_output BIGINT,after_output BIGINT,before_read BIGINT,after_read BIGINT,
      before_write BIGINT,after_write BIGINT,before_total BIGINT,after_total BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_meter_namespace ON multiremi_usage_meter_owners(workspace_id,provider,provider_session_id,epoch_id);
    CREATE TABLE IF NOT EXISTS multiremi_usage_legacy_audit (
      task_id TEXT PRIMARY KEY, original_usage TEXT, migrated_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS multiremi_usage_prices (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      connection_id TEXT, requested_model_alias INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL,
      input_per_million DOUBLE PRECISION, output_per_million DOUBLE PRECISION,
      cache_read_per_million DOUBLE PRECISION, cache_write_per_million DOUBLE PRECISION, unsplit_per_million DOUBLE PRECISION,
      source TEXT NOT NULL, source_url TEXT, effective_from TEXT NOT NULL, effective_to TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_prices_lookup ON multiremi_usage_prices(workspace_id, provider, model, connection_id, effective_from);
    CREATE TABLE IF NOT EXISTS multiremi_usage_price_revisions (workspace_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
  `);
  for (const table of ["multiremi_usage_task_scopes", "multiremi_usage_run_scopes", "multiremi_usage_units"]) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    for (const column of ["runtime_provenance", "project_provenance"]) if (!columns.some(field => field.name === column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'unknown'`);
  }
  const unitColumns = db.query("PRAGMA table_info(multiremi_usage_units)").all() as Array<{ name: string }>;
  const coverageColumns = db.query("PRAGMA table_info(multiremi_usage_cost_coverage)").all() as Array<{ name: string }>;
  if (!coverageColumns.some(field => field.name === "covered_unit_sort_key")) db.run("ALTER TABLE multiremi_usage_cost_coverage ADD COLUMN covered_unit_sort_key TEXT");
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_cost_order ON multiremi_usage_cost_coverage(task_id,run_id,monetary_unit_id,covered_unit_sort_key ${db.dialect === "postgres" ? 'COLLATE "C"' : "COLLATE BINARY"})`);
  if (!unitColumns.some(field => field.name === "cost_source")) db.run("ALTER TABLE multiremi_usage_units ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'unknown'");
  if (!unitColumns.some(field => field.name === "purpose")) db.run("ALTER TABLE multiremi_usage_units ADD COLUMN purpose TEXT NOT NULL DEFAULT 'agent'");
  for (const column of ["provider_session_id", "provider_request_id", "provider_observation_id", "identity_kind", "meter_evidence"]) if (!unitColumns.some(field => field.name === column)) db.run(`ALTER TABLE multiremi_usage_units ADD COLUMN ${column} TEXT`);
  if (!unitColumns.some(field => field.name === "time_provenance")) db.run("ALTER TABLE multiremi_usage_units ADD COLUMN time_provenance TEXT NOT NULL DEFAULT 'observed_at'");
  if (!unitColumns.some(field => field.name === "cost_coverage_expected_count")) db.run("ALTER TABLE multiremi_usage_units ADD COLUMN cost_coverage_expected_count INTEGER");
  if (!unitColumns.some(field => field.name === "cost_coverage_sha256")) db.run("ALTER TABLE multiremi_usage_units ADD COLUMN cost_coverage_sha256 TEXT");
  if (!unitColumns.some(field => field.name === "cost_coverage_complete")) db.run("ALTER TABLE multiremi_usage_units ADD COLUMN cost_coverage_complete INTEGER NOT NULL DEFAULT 1");
  if (!unitColumns.some(field => field.name === "cost_coverage_received_count")) db.run("ALTER TABLE multiremi_usage_units ADD COLUMN cost_coverage_received_count INTEGER");
  const taskScopeColumns = db.query("PRAGMA table_info(multiremi_usage_task_scopes)").all() as Array<{ name: string }>;
  if (!taskScopeColumns.some(field => field.name === "active_run_id")) db.run("ALTER TABLE multiremi_usage_task_scopes ADD COLUMN active_run_id TEXT");
  // A fresh database has no legacy facts to backfill. Existing installations
  // remain gated until the resumable scalar backfill has finished. Startup
  // performs that work after releasing the global schema migration lock.
  if (!db.query("SELECT id FROM multiremi_tasks LIMIT 1").get()) {
    db.run("INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING", [USAGE_CUTOVER_MARKER, new Date().toISOString()]);
  }
}

export function validateUsageSnapshot(input: unknown): TaskUsageSnapshot {
  if (!input || typeof input !== "object") throw new UsageValidationError("Invalid usage snapshot");
  const s = input as TaskUsageSnapshot;
  if (s.version !== 2 || typeof s.runId !== "string" || !s.runId.trim() || s.runId.length > 256
    || !Number.isSafeInteger(s.revision) || s.revision < 0 || typeof s.complete !== "boolean"
    || !Array.isArray(s.units) || s.units.length > 10_000) throw new UsageValidationError("Invalid usage snapshot");
  const ids = new Set<string>();
  for (const u of s.units) {
    if (!u || typeof u !== "object" || typeof u.unitId !== "string" || !u.unitId.trim() || u.unitId.length > 256 || ids.has(u.unitId)
      || !Number.isSafeInteger(u.revision) || u.revision < 0 || typeof u.provider !== "string" || !u.provider.trim()
      || (u.model !== null && typeof u.model !== "string")
      || !["request", "turn", "task"].includes(u.scope)
      || !["provider_request", "provider_turn", "legacy_task", "context_snapshot"].includes(u.source)
      || !["exact", "partial", "unknown"].includes(u.accuracy)
      || !Number.isFinite(Date.parse(u.occurredAt))) throw new UsageValidationError("Invalid usage unit");
    ids.add(u.unitId);
    if (u.modelSource !== undefined && !["provider_reported", "session_acknowledged", "configured", "unknown"].includes(u.modelSource)) throw new UsageValidationError("Invalid modelSource");
    if (u.purpose !== undefined && (typeof u.purpose !== "string" || !u.purpose.trim() || u.purpose.length > 64)) throw new UsageValidationError("Invalid purpose");
    if (u.timeProvenance !== undefined && !["provider_timestamp", "observed_at", "task_attributed", "unknown"].includes(u.timeProvenance)) throw new UsageValidationError("Invalid time provenance");
    const sessionId = u.providerSessionId ?? null, requestId = u.providerRequestId ?? null;
    if (u.identityKind !== undefined && !["request", "cumulative_meter"].includes(u.identityKind)) throw new UsageValidationError("Invalid identity kind");
    if (sessionId !== null && (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 512 || !["provider_request", "provider_turn"].includes(u.source) || u.scope === "task")) throw new UsageValidationError("Invalid provider identity");
    if (u.meterEvidence) {
      const meter = u.meterEvidence;
      if (!sessionId || requestId !== null || u.identityKind !== "cumulative_meter" || typeof u.providerObservationId !== "string" || !u.providerObservationId.trim() || u.providerObservationId.length > 512
        || typeof meter.epochId !== "string" || !meter.epochId.trim() || meter.epochId.length > 512 || !meter.before || !meter.after) throw new UsageValidationError("Invalid cumulative meter identity");
      let measured = false;
      for (const key of METER_FIELDS) {
        const before = meter.before[key], after = meter.after[key];
        if ((before === null) !== (after === null) || (before !== null && (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(after) || after! < before))) throw new UsageValidationError("Invalid cumulative meter interval");
        if (before !== null) measured = true;
        if (meter.last && meter.last[key] !== null && (!Number.isSafeInteger(meter.last[key]) || meter.last[key]! < 0)) throw new UsageValidationError("Invalid cumulative meter last observation");
        if (key !== "totalTokens" && u[key] !== null && (before === null || u[key] !== after! - before)) throw new UsageValidationError("Actual tokens disagree with cumulative meter interval");
      }
      for (const vector of [meter.before, meter.after, ...(meter.last ? [meter.last] : [])]) {
        const components = METER_FIELDS.slice(0, 4).map(key => vector[key]);
        if (vector.totalTokens !== null && components.every(value => value !== null) && vector.totalTokens !== components.reduce<number>((sum, value) => sum + value!, 0)) throw new UsageValidationError("Cumulative meter components do not reconcile");
      }
      if (!measured) throw new UsageValidationError("Unmeasured cumulative meter interval");
      const actual = [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.actualUnsplitTokens].reduce<number>((sum, value) => sum + (value ?? 0), 0);
      if (meter.before.totalTokens !== null && actual > meter.after.totalTokens! - meter.before.totalTokens) throw new UsageValidationError("Actual tokens exceed cumulative meter interval");
    } else if (u.providerObservationId !== undefined || u.identityKind === "cumulative_meter" || ((sessionId === null) !== (requestId === null))) throw new UsageValidationError("Invalid provider identity");
    if (requestId !== null && (typeof requestId !== "string" || !requestId.trim() || requestId.length > 512)) throw new UsageValidationError("Invalid provider request identity");
    if (u.costSource !== undefined && !["provider_reported", "sdk_estimate", "unknown"].includes(u.costSource)) throw new UsageValidationError("Invalid costSource");
    if (u.coveredUnitIds !== undefined && (!Array.isArray(u.coveredUnitIds) || u.coveredUnitIds.length > 10_000
      || new Set(u.coveredUnitIds).size !== u.coveredUnitIds.length
      || u.coveredUnitIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256)
      || u.costSource !== "provider_reported" || u.costAmount === null || u.scope === "task")) throw new UsageValidationError("Invalid monetary coverage");
    if ((u.coverageExpectedCount === undefined) !== (u.coverageSha256 === undefined)
      || (u.coverageExpectedCount !== undefined && (!Number.isSafeInteger(u.coverageExpectedCount) || u.coverageExpectedCount < 0 || u.coverageExpectedCount > 1_000_000
        || typeof u.coverageSha256 !== "string" || !/^[0-9a-f]{64}$/.test(u.coverageSha256)
        || u.coveredUnitIds === undefined || u.coveredUnitIds.length > u.coverageExpectedCount))) throw new UsageValidationError("Invalid monetary coverage commitment");
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "actualUnsplitTokens", "reportedTotalTokens", "contextTokens", "contextWindow"] as const) {
      if (u[key] !== null && (!Number.isSafeInteger(u[key]) || u[key]! < 0)) throw new UsageValidationError(`Invalid ${key}`);
    }
    if (u.costAmount !== null && (!Number.isFinite(u.costAmount) || u.costAmount < 0)) throw new UsageValidationError("Invalid costAmount");
    if (u.costCurrency !== null && (typeof u.costCurrency !== "string" || !/^[A-Z]{3}$/.test(u.costCurrency))) throw new UsageValidationError("Invalid costCurrency");
    if ((u.costAmount === null) !== (u.costCurrency === null)) throw new UsageValidationError("Cost amount and currency must be supplied together");
    if (u.costAmount !== null && u.costSource !== "unknown" && u.scope === "task") throw new UsageValidationError("Attributed monetary evidence requires request or turn scope");
    if (u.source === "context_snapshot" && [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.actualUnsplitTokens, u.costAmount].some((v) => v !== null)) throw new UsageValidationError("Context snapshots cannot contain actual usage");
    for (const key of ["requestedModel", "connectionId", "evidenceRef"] as const) {
      if (u[key] !== undefined && u[key] !== null && typeof u[key] !== "string") throw new UsageValidationError(`Invalid ${key}`);
    }
  }
  return s;
}

function saveIdentityConflict(db: SqlDatabase, taskId: string, runId: string, unit: TaskUsageUnit, previous: Row | null, identityKey: string, owner: Row): void {
  const payload = JSON.stringify(unit);
  db.run(`INSERT INTO multiremi_usage_identity_conflicts(task_id,run_id,unit_id,revision,evidence_sha256,identity_key,owner_task_id,owner_run_id,owner_unit_id,unit_json,previous_unit_json,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, [taskId, runId, unit.unitId, unit.revision, createHash("sha256").update(payload).digest("hex"), identityKey,
    owner.task_id, owner.run_id, owner.unit_id ?? owner.token_unit_id ?? owner.provider_money_unit_id ?? owner.sdk_money_unit_id ?? null, payload, previous ? JSON.stringify(previous) : null, new Date().toISOString()]);
}

function claimMeterIdentity(db: SqlDatabase, workspaceId: string, taskId: string, runId: string, unit: TaskUsageUnit, previous: Row | null): boolean {
  const meter = unit.meterEvidence!;
  const intervalColumns = ["input", "output", "read", "write", "total"];
  // Strict intervals (before,after] overlap only when they share consumption;
  // adjacent checkpoints can share a boundary without being duplicate usage.
  const intervals = METER_FIELDS.flatMap((key, index) => meter.before[key] === null || meter.after[key] === meter.before[key] ? [] : [{ name: intervalColumns[index]!, before: meter.before[key]!, after: meter.after[key]! }]);
  const overlaps = intervals.map(({ name }) => `(before_${name}<? AND after_${name}>?)`).join(" OR ");
  const epochClass = (value: string) => value === "initial" ? "initial" : value.split(":", 1)[0]!;
  const epochType = epochClass(meter.epochId);
  const ownerEpochType = "CASE WHEN epoch_id='initial' THEN 'initial' WHEN epoch_id LIKE 'compaction-item:%' THEN 'compaction-item' WHEN epoch_id LIKE 'compaction-turn:%' THEN 'compaction-turn' WHEN epoch_id LIKE 'compaction-timestamp:%' THEN 'compaction-timestamp' ELSE epoch_id END";
  // A timestamp and an item/turn ID can describe the same reset. Different
  // evidence formats do not prove separate physical epochs.
  const comparableEpoch = epochType.startsWith("compaction-") ? `(epoch_id=? OR (epoch_id LIKE 'compaction-%' AND ${ownerEpochType}<>?))` : "epoch_id=?";
  let cursor = "", conflicted = false;
  for (;;) {
    const owners = db.query(`SELECT identity_key,task_id,run_id,unit_id FROM multiremi_usage_meter_owners
    WHERE workspace_id=? AND provider=? AND provider_session_id=? AND ${comparableEpoch}
      AND (CAST(? AS TEXT) IS NULL OR connection_id IS NULL OR connection_id=?)
      AND NOT (task_id=? AND run_id=? AND unit_id=?)
      AND (observation_id=?${overlaps ? ` OR ${overlaps}` : ""}) AND identity_key>? ORDER BY identity_key LIMIT 512`).all(
    workspaceId, unit.provider, unit.providerSessionId, meter.epochId, ...(epochType.startsWith("compaction-") ? [epochType] : []), unit.connectionId ?? null, unit.connectionId ?? null,
    taskId, runId, unit.unitId, unit.providerObservationId, ...intervals.flatMap(interval => [interval.after, interval.before]), cursor) as Row[];
    if (!owners.length) break;
    for (const owner of owners) { saveIdentityConflict(db, taskId, runId, unit, previous, String(owner.identity_key), owner); conflicted = true; }
    cursor = String(owners[owners.length - 1]!.identity_key);
  }
  if (conflicted) return false;
  const identityKey = createHash("sha256").update(JSON.stringify([workspaceId, unit.provider, unit.connectionId ?? null, unit.providerSessionId, "cumulative_meter", meter.epochId, taskId, runId, unit.unitId])).digest("hex");
  const columns = ["identity_key", "workspace_id", "provider", "connection_id", "provider_session_id", "epoch_id", "observation_id", "task_id", "run_id", "unit_id", ...intervalColumns.flatMap(name => [`before_${name}`, `after_${name}`])];
  db.run(`INSERT INTO multiremi_usage_meter_owners(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})
    ON CONFLICT(identity_key) DO UPDATE SET observation_id=excluded.observation_id,${intervalColumns.flatMap(name => [`before_${name}=excluded.before_${name}`, `after_${name}=excluded.after_${name}`]).join(",")}`,
    [identityKey, workspaceId, unit.provider, unit.connectionId ?? null, unit.providerSessionId, meter.epochId, unit.providerObservationId, taskId, runId, unit.unitId,
      ...METER_FIELDS.flatMap(key => [meter.before[key], meter.after[key]])]);
  return true;
}

function claimProviderIdentity(db: SqlDatabase, workspaceId: string, taskId: string, runId: string, unit: TaskUsageUnit, previous: Row | null): boolean {
  if (unit.meterEvidence) return claimMeterIdentity(db, workspaceId, taskId, runId, unit, previous);
  if (!unit.providerSessionId || !unit.providerRequestId) return true;
  const roles: string[] = [];
  if ([unit.inputTokens, unit.outputTokens, unit.cacheReadTokens, unit.cacheWriteTokens, unit.actualUnsplitTokens, unit.reportedTotalTokens].some(value => value !== null) || unit.costAmount === null) roles.push("token_unit_id");
  if (unit.costAmount !== null && (unit.costSource ?? "provider_reported") === "provider_reported") roles.push("provider_money_unit_id");
  if (unit.costAmount !== null && unit.costSource === "sdk_estimate") roles.push("sdk_money_unit_id");
  if (!roles.length) return true; // Unscoped/unknown money is diagnostic only.
  let identityKey = createHash("sha256").update(JSON.stringify([workspaceId, unit.provider, unit.connectionId ?? null, unit.providerSessionId, unit.providerRequestId])).digest("hex");
  // A missing route cannot establish a separate request namespace. The batch
  // already holds its session/request transaction lock before this lookup.
  const candidate = db.query(`SELECT identity_key FROM multiremi_usage_request_owners
    WHERE workspace_id=? AND provider=? AND provider_session_id=? AND provider_request_id=?
      AND (CAST(? AS TEXT) IS NULL OR connection_id IS NULL OR connection_id=?) ORDER BY identity_key LIMIT 1`).get(workspaceId, unit.provider, unit.providerSessionId, unit.providerRequestId, unit.connectionId ?? null, unit.connectionId ?? null) as Row | null;
  if (candidate) identityKey = String(candidate.identity_key);
  // Unknown routes compete with every compatible owner, not an arbitrary
  // first match. Keep all attribution conflicts in bounded cursor pages.
  let cursor = "", conflicted = false;
  for (;;) {
    const owners = db.query(`SELECT identity_key,task_id,run_id,token_unit_id,provider_money_unit_id,sdk_money_unit_id FROM multiremi_usage_request_owners
      WHERE workspace_id=? AND provider=? AND provider_session_id=? AND provider_request_id=? AND identity_key>?
        AND (CAST(? AS TEXT) IS NULL OR connection_id IS NULL OR connection_id=?) ORDER BY identity_key LIMIT 512`).all(workspaceId, unit.provider, unit.providerSessionId, unit.providerRequestId, cursor, unit.connectionId ?? null, unit.connectionId ?? null) as Row[];
    if (!owners.length) break;
    for (const owner of owners) {
      const roleConflict = roles.find(role => owner[role] !== null && owner[role] !== unit.unitId);
      if (owner.task_id !== taskId || owner.run_id !== runId || roleConflict) {
        saveIdentityConflict(db, taskId, runId, unit, previous, String(owner.identity_key), { ...owner, unit_id: roleConflict ? owner[roleConflict] : undefined });
        conflicted = true;
      }
    }
    cursor = String(owners[owners.length - 1]!.identity_key);
  }
  if (conflicted) return false;
  db.run(`INSERT INTO multiremi_usage_request_owners(identity_key,workspace_id,provider,connection_id,provider_session_id,provider_request_id,task_id,run_id)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(identity_key) DO NOTHING`, [identityKey, workspaceId, unit.provider, unit.connectionId ?? null, unit.providerSessionId, unit.providerRequestId, taskId, runId]);
  const owner = db.query(`SELECT task_id,run_id,token_unit_id,provider_money_unit_id,sdk_money_unit_id FROM multiremi_usage_request_owners WHERE identity_key=?${db.dialect === "postgres" ? " FOR UPDATE" : ""}`).get(identityKey) as Row;
  const roleConflict = roles.find(role => owner[role] !== null && owner[role] !== unit.unitId);
  if (owner.task_id !== taskId || owner.run_id !== runId || roleConflict) {
    saveIdentityConflict(db, taskId, runId, unit, previous, identityKey, { ...owner, unit_id: roleConflict ? owner[roleConflict] : undefined });
    return false;
  }
  for (const role of roles) if (owner[role] === null) db.run(`UPDATE multiremi_usage_request_owners SET ${role}=? WHERE identity_key=?`, [unit.unitId, identityKey]);
  return true;
}

/** Prelock a reviewed batch before domain writes; callers retain the transaction. */
export function lockUsageIdentities(db: SqlDatabase, workspaceId: string, units: TaskUsageUnit[]): void {
  const identityLocks = new Set(units.filter(unit => unit.providerSessionId && (unit.providerRequestId || unit.meterEvidence)).map(unit =>
    createHash("sha256").update(JSON.stringify([workspaceId, unit.provider, unit.providerSessionId,
      // All epochs share a lock because differently represented compaction
      // evidence may describe the same reset and compete for overlapping usage.
      unit.meterEvidence ? "cumulative_meter" : unit.providerRequestId])).digest("hex").slice(0, 1)));
  // Fixed stripes keep a large reviewed history plan within PostgreSQL's
  // advisory-lock memory budget. Collisions serialize unrelated claims only;
  // exact ownership is still keyed by the full identity in the scalar table.
  for (const key of [...identityLocks].sort()) advisoryXactLock(db, `usage-request:${workspaceId}:${key}`);
}

/** One transaction serializes snapshot revisions; only newer unit revisions replace facts. */
export function writeUsageSnapshot(db: SqlDatabase, taskId: string, input: TaskUsageSnapshot, options: UsageWriteOptions = {}): boolean {
  const s = validateUsageSnapshot(input);
  return db.transaction(() => {
    const task = db.query(`SELECT t.id,t.workspace_id,t.agent_id,t.runtime_id,t.runtime_workspace_id,t.status,t.attempt,t.started_at,
      i.project_id AS issue_project_id,c.project_id AS chat_project_id,a.schedule_target,tr.runtime_id AS trace_runtime_id,b.cross_switch
      FROM multiremi_tasks t LEFT JOIN multiremi_issues i ON i.id=t.issue_id
      LEFT JOIN multiremi_chat_sessions c ON c.id=t.chat_session_id
      LEFT JOIN multiremi_autopilot_runs a ON a.id=(SELECT ar.id FROM multiremi_autopilot_runs ar WHERE ar.task_id=t.id ORDER BY ar.created_at DESC LIMIT 1)
      LEFT JOIN multiremi_task_traces tr ON tr.task_id=t.id LEFT JOIN multiremi_trace_backfill_tasks b ON b.task_id=t.id WHERE t.id=?`).get(taskId) as Row | null;
    if (!task) throw new Error(`Task not found: ${taskId}`);
    // Identity namespace locks precede all domain writes (W -> N -> D).
    if (!options.identityLocksHeld) {
      const existingScope = db.query("SELECT workspace_id FROM multiremi_usage_run_scopes WHERE task_id=? AND run_id=?").get(taskId, s.runId) as Row | null;
      lockUsageIdentities(db, String(existingScope?.workspace_id ?? task.workspace_id), s.units);
    }
    let scheduledProject: string | null = null;
    if (typeof task.schedule_target === "string") {
      try { const target: unknown = JSON.parse(task.schedule_target); if (target && typeof target === "object" && "kind" in target && target.kind === "project" && "id" in target && typeof target.id === "string") scheduledProject = target.id; } catch { /* Missing evidence stays unknown. */ }
    }
    const runtimeEvidence: UsageScopeEvidence = options.runtimeScope ?? (options.historical
      ? Number(task.cross_switch) === 1 ? { id: null, provenance: "unknown" }
        : task.trace_runtime_id && Number(task.attempt) === 1 ? { id: String(task.trace_runtime_id), provenance: "trace_owner" }
        : task.runtime_id && task.started_at && Number(task.attempt) === 1 ? { id: String(task.runtime_id), provenance: "task_record" }
        : { id: null, provenance: "unknown" }
      : { id: task.runtime_id ? String(task.runtime_id) : null, provenance: task.runtime_id ? "live_task" : "unknown" });
    const projectEvidence: UsageScopeEvidence = options.projectScope ?? (task.runtime_workspace_id ? { id: null, provenance: "unknown" }
      : options.historical ? scheduledProject ? { id: scheduledProject, provenance: "schedule_target" }
        : task.chat_project_id ? { id: String(task.chat_project_id), provenance: "chat_binding" } : { id: null, provenance: "unknown" }
      : { id: task.issue_project_id ? String(task.issue_project_id) : scheduledProject ?? (task.chat_project_id ? String(task.chat_project_id) : null),
        provenance: task.issue_project_id ? "live_task" : scheduledProject ? "schedule_target" : task.chat_project_id ? "chat_binding" : "unknown" });
    const candidateProjectId = projectEvidence.id;
    const projectId = candidateProjectId && db.query("SELECT id FROM multiremi_projects WHERE id=? AND workspace_id=?").get(candidateProjectId, task.workspace_id) ? candidateProjectId : null;
    const runtimeId = runtimeEvidence.id;
    const projectProvenance = projectId ? projectEvidence.provenance : "unknown";
    db.run("INSERT INTO multiremi_usage_task_scopes(task_id,workspace_id,agent_id,runtime_id,project_id,runtime_provenance,project_provenance) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING",
      [taskId, task.workspace_id, task.agent_id, runtimeId, projectId, runtimeEvidence.provenance, projectProvenance]);
    const newRun = db.run(`INSERT INTO multiremi_usage_runs(task_id,run_id,revision,complete) VALUES(?,?,?,?) ON CONFLICT(task_id,run_id) DO NOTHING`, [taskId, s.runId, -1, 0]).changes > 0;
    // The task lifecycle belongs to its latest active execution. Replays of
    // an older run cannot move it, and historical evidence cannot invent it.
    if (newRun && !options.historical && !["completed", "failed", "cancelled"].includes(String(task.status))) {
      db.run("UPDATE multiremi_usage_task_scopes SET runtime_id=?,project_id=?,runtime_provenance=?,project_provenance=?,active_run_id=? WHERE task_id=?", [runtimeId, projectId, runtimeEvidence.provenance, projectProvenance, s.runId, taskId]);
    }
    db.run("INSERT INTO multiremi_usage_run_scopes(task_id,run_id,workspace_id,agent_id,runtime_id,project_id,runtime_provenance,project_provenance) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id,run_id) DO NOTHING",
      [taskId, s.runId, task.workspace_id, task.agent_id, runtimeId, projectId, runtimeEvidence.provenance, projectProvenance]);
    const scope = db.query("SELECT workspace_id,agent_id,runtime_id,project_id,runtime_provenance,project_provenance FROM multiremi_usage_run_scopes WHERE task_id=? AND run_id=?").get(taskId, s.runId) as Row;
    // Lock the run for per-unit checks. Run revisions order metadata only;
    // an older frame may contain a distinct unit that must still be accepted.
    db.run("UPDATE multiremi_usage_runs SET revision=revision WHERE task_id=? AND run_id=?", [taskId, s.runId]);
    const run = db.query("SELECT revision,complete FROM multiremi_usage_runs WHERE task_id=? AND run_id=?").get(taskId, s.runId) as Row;
    let changed = Number(run.revision) < s.revision || (Number(run.revision) === s.revision && Number(run.complete) === 0 && s.complete);
    if (changed) db.run(`UPDATE multiremi_usage_runs SET revision=?, complete=? WHERE task_id=? AND run_id=?`, [s.revision, s.complete ? 1 : 0, taskId, s.runId]);
    for (const u of s.units) {
      const coverageExpectedCount = u.coverageExpectedCount ?? (u.coveredUnitIds === undefined ? null : u.coveredUnitIds.length);
      const coverageSha256 = u.coverageSha256 ?? (u.coveredUnitIds === undefined ? null : coverageHash(u.coveredUnitIds));
      const values = unitValues(u);
      const normalized = JSON.stringify(values);
      const columns = ["task_id", "run_id", "unit_id", "revision", "workspace_id", "agent_id", "runtime_id", "project_id", "runtime_provenance", "project_provenance", ...UNIT_FIELDS, "cost_coverage_complete", "cost_coverage_received_count"];
      const previous = db.query(`SELECT revision,cost_coverage_received_count,cost_coverage_complete,${UNIT_FIELDS.join(",")} FROM multiremi_usage_units WHERE task_id=? AND run_id=? AND unit_id=?`).get(taskId, s.runId, u.unitId) as Row | null;
      let receipt = db.query("SELECT revision,disposition,normalized_json FROM multiremi_usage_unit_receipts WHERE task_id=? AND run_id=? AND unit_id=?").get(taskId, s.runId, u.unitId) as Row | null;
      if (!receipt) {
        // Preserve revision floors from conflicts recorded before this schema
        // upgrade; a missing canonical row must never make a parked unit new.
        const parked = db.query("SELECT revision,unit_json FROM multiremi_usage_identity_conflicts WHERE task_id=? AND run_id=? AND unit_id=? ORDER BY revision DESC LIMIT 1").get(taskId, s.runId, u.unitId) as Row | null;
        if (parked && (!previous || Number(parked.revision) > Number(previous.revision))) {
          receipt = { revision: Number(parked.revision), disposition: "parked", normalized_json: JSON.stringify(unitValues(JSON.parse(String(parked.unit_json)) as TaskUsageUnit)) };
          db.run("INSERT INTO multiremi_usage_unit_receipts(task_id,run_id,unit_id,revision,disposition,normalized_json) VALUES(?,?,?,?,?,?)", [taskId, s.runId, u.unitId, receipt.revision, receipt.disposition, receipt.normalized_json]);
        }
      }
      if (receipt && Number(receipt.revision) > u.revision) continue;
      if (receipt && Number(receipt.revision) === u.revision) {
        if (receipt.normalized_json !== normalized) throw new UsageValidationError("Conflicting usage unit at the same revision");
        if (receipt.disposition === "parked") continue;
      }
      if (previous && Number(previous.revision) > u.revision) continue;
      let receivedCount = 0;
      if (previous && Number(previous.revision) === u.revision) {
        // Upgrade a previously stored full link set lazily under this run lock.
        if (previous.cost_coverage_expected_count === null && coverageExpectedCount !== null) {
          const prior = storedCoverageDigest(db, taskId, s.runId, u.unitId);
          previous.cost_coverage_expected_count = prior.count;
          previous.cost_coverage_sha256 = prior.sha256;
          previous.cost_coverage_received_count = prior.count;
        }
        const equal = UNIT_FIELDS.every((field, index) => {
          const a = previous[field], b = values[index];
          return typeof b === "number" ? Number(a) === b && a !== null : a === b;
        });
        if (!equal) throw new UsageValidationError("Conflicting usage unit at the same revision");
        if (coverageExpectedCount !== null) receivedCount = previous.cost_coverage_received_count === null
          ? Number((db.query("SELECT COUNT(*) AS n FROM multiremi_usage_cost_coverage WHERE task_id=? AND run_id=? AND monetary_unit_id=?").get(taskId, s.runId, u.unitId) as Row).n)
          : Number(previous.cost_coverage_received_count);
      }
      if (!claimProviderIdentity(db, String(scope.workspace_id), taskId, s.runId, u, previous)) {
        // Strong evidence can identify an earlier weak unit as an already owned
        // request. Retain that earlier observation in the conflict audit too.
        const weakDuplicate = previous && !previous.provider_session_id && !previous.provider_request_id && !previous.provider_observation_id
          && ["provider_request", "provider_turn"].includes(String(previous.source)) && previous.scope === u.scope
          && ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "actual_unsplit_tokens", "reported_total_tokens", "cost_amount", "cost_currency"].every(field => {
            const value = values[UNIT_FIELDS.indexOf(field)];
            return typeof value === "number" ? previous[field] !== null && Number(previous[field]) === value : previous[field] === value;
          });
        if (weakDuplicate) {
          db.run("DELETE FROM multiremi_usage_cost_coverage WHERE task_id=? AND run_id=? AND monetary_unit_id=?", [taskId, s.runId, u.unitId]);
          db.run("DELETE FROM multiremi_usage_units WHERE task_id=? AND run_id=? AND unit_id=?", [taskId, s.runId, u.unitId]);
        }
        db.run(`INSERT INTO multiremi_usage_unit_receipts(task_id,run_id,unit_id,revision,disposition,normalized_json) VALUES(?,?,?,?,?,?)
          ON CONFLICT(task_id,run_id,unit_id) DO UPDATE SET revision=excluded.revision,disposition=excluded.disposition,normalized_json=excluded.normalized_json`, [taskId, s.runId, u.unitId, u.revision, "parked", normalized]);
        changed = true;
        continue;
      }
      if (!previous || Number(previous.revision) !== u.revision) {
        changed = true;
        db.run(`INSERT INTO multiremi_usage_units(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})
          ON CONFLICT(task_id,run_id,unit_id) DO UPDATE SET revision=excluded.revision, ${UNIT_FIELDS.map((f) => `${f}=excluded.${f}`).join(",")},cost_coverage_complete=excluded.cost_coverage_complete,cost_coverage_received_count=0
          WHERE multiremi_usage_units.revision<excluded.revision`,
        [taskId, s.runId, u.unitId, u.revision, String(scope.workspace_id), String(scope.agent_id), scope.runtime_id ?? null, scope.project_id ?? null, scope.runtime_provenance, scope.project_provenance, ...values, coverageExpectedCount === null ? 1 : 0, 0]);
        if (u.coveredUnitIds !== undefined || previous?.cost_source === "provider_reported") db.run("DELETE FROM multiremi_usage_cost_coverage WHERE task_id=? AND run_id=? AND monetary_unit_id=?", [taskId, s.runId, u.unitId]);
      }
      if (coverageExpectedCount !== null) {
        for (const coveredId of u.coveredUnitIds ?? []) {
          const inserted = db.run("INSERT INTO multiremi_usage_cost_coverage(task_id,run_id,monetary_unit_id,covered_unit_id,covered_unit_sort_key) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING", [taskId, s.runId, u.unitId, coveredId, coverageSortKey(coveredId)]).changes;
          receivedCount += inserted;
          changed = inserted > 0 || changed;
        }
        if (receivedCount > coverageExpectedCount) throw new UsageValidationError("Conflicting monetary coverage commitment");
        if (receivedCount === coverageExpectedCount && (!previous || Number(previous.revision) !== u.revision || Number(previous.cost_coverage_complete) !== 1)) {
          const received = storedCoverageDigest(db, taskId, s.runId, u.unitId);
          if (received.count !== coverageExpectedCount || received.sha256 !== coverageSha256) throw new UsageValidationError("Conflicting monetary coverage commitment");
        }
        db.run("UPDATE multiremi_usage_units SET cost_coverage_expected_count=?,cost_coverage_sha256=?,cost_coverage_complete=?,cost_coverage_received_count=? WHERE task_id=? AND run_id=? AND unit_id=?",
          [coverageExpectedCount, coverageSha256, receivedCount === coverageExpectedCount ? 1 : 0, receivedCount, taskId, s.runId, u.unitId]);
      }
      db.run(`INSERT INTO multiremi_usage_unit_receipts(task_id,run_id,unit_id,revision,disposition,normalized_json) VALUES(?,?,?,?,?,?)
        ON CONFLICT(task_id,run_id,unit_id) DO UPDATE SET revision=excluded.revision,disposition=excluded.disposition,normalized_json=excluded.normalized_json`, [taskId, s.runId, u.unitId, u.revision, "accepted", normalized]);
    }
    return changed;
  })();
}

/** Legacy totals have ambiguous semantics; preserve them as evidence only. */
export function legacyUsageSnapshot(taskId: string, raw: unknown, occurredAt: string): TaskUsageSnapshot {
  let entries: unknown = raw;
  if (typeof entries === "string") { try { entries = JSON.parse(entries); } catch { entries = []; } }
  const units: TaskUsageUnit[] = [];
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Row;
    const token = (key: string) => typeof e[key] === "number" && Number.isSafeInteger(e[key]) && Number(e[key]) >= 0 ? Number(e[key]) : null;
    const split = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].map(token);
    const hasSplit = split.some((n) => n !== null && n > 0);
    units.push({ unitId: `legacy:${index}`, revision: 0, provider: typeof e.provider === "string" ? e.provider : "unknown",
      model: e.modelSource === "upstream" && typeof e.model === "string" && e.model.trim() ? e.model : null,
      requestedModel: typeof e.model === "string" && e.model.trim() ? e.model : null,
      modelSource: e.modelSource === "upstream" ? "provider_reported" : typeof e.model === "string" && e.model.trim() ? "configured" : "unknown",
      timeProvenance: "task_attributed",
      scope: "task", source: "legacy_task", accuracy: hasSplit ? "partial" : "unknown",
      inputTokens: hasSplit ? split[0]! : null, outputTokens: hasSplit ? split[1]! : null, cacheReadTokens: hasSplit ? split[2]! : null, cacheWriteTokens: hasSplit ? split[3]! : null,
      actualUnsplitTokens: null, reportedTotalTokens: token("totalTokens"), contextTokens: null, contextWindow: null,
      costAmount: null, costCurrency: null, occurredAt, evidenceRef: `legacy-task-usage:${taskId}` });
  }
  return { version: 2, runId: "legacy", revision: 0, complete: false, units };
}

export const USAGE_MIGRATION_LOCK = "multiremi:usage-legacy-migration:v1";

/** Migration checkpoints live outside the global schema migration lock. */
export function ensureLegacyUsageMigrationSchema(db: SqlDatabase): void {
  advisoryLock(db, USAGE_MIGRATION_LOCK, () => db.exec(`CREATE TABLE IF NOT EXISTS multiremi_usage_legacy_sources (
    task_id TEXT PRIMARY KEY, source_version INTEGER NOT NULL, source_usage TEXT, source_occurred_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS multiremi_usage_legacy_versions (
    task_id TEXT NOT NULL, source_version INTEGER NOT NULL, original_usage TEXT, source_occurred_at TEXT, recorded_at TEXT NOT NULL,
    PRIMARY KEY(task_id,source_version), FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
  )`));
}

const LEGACY_OCCURRED_AT = "COALESCE(t.completed_at,t.failed_at,t.cancelled_at,t.started_at,t.dispatched_at,t.updated_at,t.created_at)";
const LEGACY_PENDING = `(s.task_id IS NULL OR t.usage IS DISTINCT FROM s.source_usage OR ${LEGACY_OCCURRED_AT} IS DISTINCT FROM s.source_occurred_at)`;

export function hasPendingLegacyUsage(db: SqlDatabase): boolean {
  return Boolean(db.query(`SELECT t.id FROM multiremi_tasks t LEFT JOIN multiremi_usage_legacy_sources s ON s.task_id=t.id WHERE ${LEGACY_PENDING} LIMIT 1`).get());
}

/** Bounded backfill. Immutable originals and every observed source version survive retries. */
export function migrateLegacyUsage(db: SqlDatabase, options: { batchSize?: number; afterTaskId?: string; schemaReady?: boolean } = {}): { migrated: number; remaining: number; complete: boolean; lastTaskId?: string } {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new UsageValidationError("batchSize must be 1..5000");
  if (!options.schemaReady) ensureLegacyUsageMigrationSchema(db);
  return advisoryLock(db, USAGE_MIGRATION_LOCK, () => migrateLegacyUsageBatch(db, options, batchSize));
}

function migrateLegacyUsageBatch(db: SqlDatabase, options: { afterTaskId?: string }, batchSize: number) {
  // Startup uses a keyset pass, avoiding an ever-growing prefix scan per batch.
  const keyset = options.afterTaskId !== undefined;
  const rows = db.query(`SELECT t.id FROM multiremi_tasks t LEFT JOIN multiremi_usage_legacy_sources s ON s.task_id=t.id
    WHERE ${keyset ? "t.id > ?" : LEGACY_PENDING} ORDER BY t.id LIMIT ?`).all(...(keyset ? [options.afterTaskId, batchSize] : [batchSize])) as Row[];
  let migrated = 0;
  for (const selected of rows) {
    const migrateTask = db.transaction(() => {
      // Read the current source AFTER taking the task lock, never a stale batch payload.
      const row = db.query(`SELECT t.id,t.usage,${LEGACY_OCCURRED_AT} AS occurred_at FROM multiremi_tasks t WHERE t.id=?${db.dialect === "postgres" ? " FOR UPDATE" : ""}`).get(selected.id) as Row | null;
      if (!row) return 0;
      const state = db.query("SELECT * FROM multiremi_usage_legacy_sources WHERE task_id=?").get(row.id) as Row | null;
      const runs = db.query("SELECT run_id,revision FROM multiremi_usage_runs WHERE task_id=?").all(row.id) as Row[];
      const protectedUnit = db.query("SELECT unit_id FROM multiremi_usage_units WHERE task_id=? AND run_id='legacy' AND source<>'legacy_task' LIMIT 1").get(row.id);
      // Merely accepting a new execution (or observing some of its requests)
      // proves neither overlap nor complete coverage of the old aggregate.
      // Only reviewed identity-based reconciliation may retire that evidence.
      if (state && state.source_usage === row.usage && state.source_occurred_at === row.occurred_at) return 0;
      const timestamp = new Date().toISOString();
      db.run("INSERT INTO multiremi_usage_legacy_audit(task_id,original_usage,migrated_at) VALUES(?,?,?) ON CONFLICT(task_id) DO NOTHING", [row.id, row.usage ?? null, timestamp]);
      const original = db.query("SELECT original_usage,migrated_at FROM multiremi_usage_legacy_audit WHERE task_id=?").get(row.id) as Row;
      db.run("INSERT INTO multiremi_usage_legacy_versions(task_id,source_version,original_usage,source_occurred_at,recorded_at) VALUES(?,0,?,?,?) ON CONFLICT(task_id,source_version) DO NOTHING",
        [row.id, original.original_usage, null, original.migrated_at]);
      const version = state ? Number(state.source_version) + 1 : 1;
      const protectedRun = runs.some(run => run.run_id === "historical-evidence-v2"
        || (run.run_id === "legacy" && Number(run.revision) !== Number(state?.source_version ?? 0)));
      if (!protectedRun && !protectedUnit) {
        // Replace only the provisional legacy aggregate, including removed entries.
        db.run("DELETE FROM multiremi_usage_units WHERE task_id=? AND run_id='legacy'", [row.id]);
        db.run("DELETE FROM multiremi_usage_run_scopes WHERE task_id=? AND run_id='legacy'", [row.id]);
        db.run("DELETE FROM multiremi_usage_runs WHERE task_id=? AND run_id='legacy'", [row.id]);
        const snapshot = legacyUsageSnapshot(String(row.id), row.usage, String(row.occurred_at));
        snapshot.revision = version;
        for (const unit of snapshot.units) unit.revision = version;
        writeUsageSnapshot(db, String(row.id), snapshot, { historical: true });
      }
      db.run("INSERT INTO multiremi_usage_legacy_versions(task_id,source_version,original_usage,source_occurred_at,recorded_at) VALUES(?,?,?,?,?)", [row.id, version, row.usage ?? null, row.occurred_at, timestamp]);
      db.run(`INSERT INTO multiremi_usage_legacy_sources(task_id,source_version,source_usage,source_occurred_at) VALUES(?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET source_version=excluded.source_version,source_usage=excluded.source_usage,source_occurred_at=excluded.source_occurred_at`, [row.id, version, row.usage ?? null, row.occurred_at]);
      return 1;
    });
    migrated += (migrateTask as typeof migrateTask & { immediate?: () => number }).immediate?.() ?? migrateTask();
  }
  const lastTaskId = rows.length ? String(rows[rows.length - 1]!.id) : options.afterTaskId;
  // Internal keyset passes need only know whether another bounded batch exists;
  // counting the entire tail every batch would make startup quadratic.
  const remaining = keyset ? (db.query("SELECT id FROM multiremi_tasks WHERE id > ? LIMIT 1").get(lastTaskId) ? 1 : 0)
    : Number((db.query(`SELECT COUNT(*) AS n FROM multiremi_tasks t LEFT JOIN multiremi_usage_legacy_sources s ON s.task_id=t.id WHERE ${LEGACY_PENDING}`).get() as Row).n);
  if (remaining === 0) db.run("INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING", [USAGE_CUTOVER_MARKER, new Date().toISOString()]);
  return { migrated, remaining, complete: remaining === 0, lastTaskId };
}

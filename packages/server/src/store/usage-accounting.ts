import type { TaskUsageSnapshot, TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import { advisoryLock, type SqlDatabase } from "@multiremi/store/db/postgres.js";

type Row = Record<string, unknown>;
export class UsageValidationError extends Error {}
export class UsageAccountingNotReadyError extends Error {}
export const USAGE_CUTOVER_MARKER = "20261006_usage_accounting_v2";
export interface UsageScopeEvidence { id: string | null; provenance: string; }
export interface UsageWriteOptions { historical?: boolean; runtimeScope?: UsageScopeEvidence; projectScope?: UsageScopeEvidence; }
const UNIT_FIELDS = ["provider", "model", "model_source", "purpose", "requested_model", "connection_id", "scope", "source", "accuracy", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "actual_unsplit_tokens", "reported_total_tokens", "context_tokens", "context_window", "cost_amount", "cost_currency", "cost_source", "occurred_at", "evidence_ref"];

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
      scope TEXT NOT NULL, source TEXT NOT NULL, accuracy TEXT NOT NULL,
      input_tokens BIGINT, output_tokens BIGINT, cache_read_tokens BIGINT, cache_write_tokens BIGINT,
      actual_unsplit_tokens BIGINT, reported_total_tokens BIGINT, context_tokens BIGINT, context_window BIGINT,
      cost_amount DOUBLE PRECISION, cost_currency TEXT, cost_source TEXT NOT NULL DEFAULT 'unknown', occurred_at TEXT NOT NULL, evidence_ref TEXT,
      PRIMARY KEY(task_id, run_id, unit_id), FOREIGN KEY(task_id, run_id) REFERENCES multiremi_usage_runs(task_id, run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_usage_units_workspace_time ON multiremi_usage_units(workspace_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_units_runtime_time ON multiremi_usage_units(workspace_id, runtime_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_units_project_time ON multiremi_usage_units(workspace_id, project_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_units_model ON multiremi_usage_units(workspace_id, provider, model, connection_id);
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
  if (!unitColumns.some(field => field.name === "cost_source")) db.run("ALTER TABLE multiremi_usage_units ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'unknown'");
  if (!unitColumns.some(field => field.name === "purpose")) db.run("ALTER TABLE multiremi_usage_units ADD COLUMN purpose TEXT NOT NULL DEFAULT 'agent'");
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
    if (u.costSource !== undefined && !["provider_reported", "sdk_estimate", "unknown"].includes(u.costSource)) throw new UsageValidationError("Invalid costSource");
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
      const values = [u.provider, u.model, u.modelSource ?? "unknown", u.purpose ?? "agent", u.requestedModel ?? null, u.connectionId ?? null, u.scope, u.source, u.accuracy,
        u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.actualUnsplitTokens, u.reportedTotalTokens,
        u.contextTokens, u.contextWindow, u.costAmount, u.costCurrency, u.costSource ?? (u.costAmount !== null ? "provider_reported" : "unknown"), new Date(u.occurredAt).toISOString(), u.evidenceRef ?? null];
      const columns = ["task_id", "run_id", "unit_id", "revision", "workspace_id", "agent_id", "runtime_id", "project_id", "runtime_provenance", "project_provenance", ...UNIT_FIELDS];
      const previous = db.query(`SELECT revision,${UNIT_FIELDS.join(",")} FROM multiremi_usage_units WHERE task_id=? AND run_id=? AND unit_id=?`).get(taskId, s.runId, u.unitId) as Row | null;
      if (previous && Number(previous.revision) === u.revision) {
        const equal = UNIT_FIELDS.every((field, index) => {
          const a = previous[field], b = values[index];
          return typeof b === "number" ? Number(a) === b && a !== null : a === b;
        });
        if (!equal) throw new UsageValidationError("Conflicting usage unit at the same revision");
        continue;
      }
      if (previous && Number(previous.revision) > u.revision) continue;
      changed = true;
      db.run(`INSERT INTO multiremi_usage_units(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})
        ON CONFLICT(task_id,run_id,unit_id) DO UPDATE SET revision=excluded.revision, ${UNIT_FIELDS.map((f) => `${f}=excluded.${f}`).join(",")}
        WHERE multiremi_usage_units.revision<excluded.revision`,
      [taskId, s.runId, u.unitId, u.revision, String(scope.workspace_id), String(scope.agent_id), scope.runtime_id ?? null, scope.project_id ?? null, scope.runtime_provenance, scope.project_provenance, ...values]);
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
const LEGACY_SUPERSEDED = `(EXISTS(SELECT 1 FROM multiremi_usage_runs r WHERE r.task_id=t.id AND r.run_id='legacy' AND r.revision=s.source_version)
  AND EXISTS(SELECT 1 FROM multiremi_usage_runs r WHERE r.task_id=t.id AND r.run_id NOT IN ('legacy','historical-evidence-v2'))
  AND NOT EXISTS(SELECT 1 FROM multiremi_usage_runs r WHERE r.task_id=t.id AND r.run_id='historical-evidence-v2')
  AND NOT EXISTS(SELECT 1 FROM multiremi_usage_units u WHERE u.task_id=t.id AND u.run_id='legacy' AND u.source<>'legacy_task'))`;
const LEGACY_PENDING = `(s.task_id IS NULL OR t.usage IS DISTINCT FROM s.source_usage OR ${LEGACY_OCCURRED_AT} IS DISTINCT FROM s.source_occurred_at OR ${LEGACY_SUPERSEDED})`;

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
      const legacy = runs.find(run => run.run_id === "legacy");
      const superseded = legacy && Number(legacy.revision) === Number(state?.source_version ?? 0) && !protectedUnit
        && runs.some(run => run.run_id !== "legacy" && run.run_id !== "historical-evidence-v2")
        && !runs.some(run => run.run_id === "historical-evidence-v2");
      if (superseded) {
        // A modern snapshot can arrive after this task's earlier checkpoint.
        // Retire only our provisional aggregate, retaining all source audits.
        db.run("DELETE FROM multiremi_usage_units WHERE task_id=? AND run_id='legacy'", [row.id]);
        db.run("DELETE FROM multiremi_usage_run_scopes WHERE task_id=? AND run_id='legacy'", [row.id]);
        db.run("DELETE FROM multiremi_usage_runs WHERE task_id=? AND run_id='legacy'", [row.id]);
      }
      if (state && state.source_usage === row.usage && state.source_occurred_at === row.occurred_at) return superseded ? 1 : 0;
      const timestamp = new Date().toISOString();
      db.run("INSERT INTO multiremi_usage_legacy_audit(task_id,original_usage,migrated_at) VALUES(?,?,?) ON CONFLICT(task_id) DO NOTHING", [row.id, row.usage ?? null, timestamp]);
      const original = db.query("SELECT original_usage,migrated_at FROM multiremi_usage_legacy_audit WHERE task_id=?").get(row.id) as Row;
      db.run("INSERT INTO multiremi_usage_legacy_versions(task_id,source_version,original_usage,source_occurred_at,recorded_at) VALUES(?,0,?,?,?) ON CONFLICT(task_id,source_version) DO NOTHING",
        [row.id, original.original_usage, null, original.migrated_at]);
      const version = state ? Number(state.source_version) + 1 : 1;
      const protectedRun = runs.some(run => run.run_id !== "legacy" || Number(run.revision) !== Number(state?.source_version ?? 0));
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

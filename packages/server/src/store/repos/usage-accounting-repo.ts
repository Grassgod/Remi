import { createId, nowIso } from "@multiremi/ids.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { StoreContext } from "@multiremi/store/context.js";
import type { SetUsagePriceInput, UsageMetrics, UsagePrice, UsageReport } from "@multiremi/contracts/usage-accounting.js";
import { USAGE_CUTOVER_MARKER, UsageValidationError, UsageAccountingNotReadyError } from "@multiremi/store/usage-accounting.js";

type Row = Record<string, unknown>;
export interface UsageReportInput {
  workspaceId: string;
  projectId?: string | null;
  runtimeId?: string | null;
  days?: number | null;
  since?: string | null;
  until?: string | null;
  tz?: string | null;
  include?: "day_model";
  detailLimit?: number;
  detailCursor?: string | null;
}
const MODEL_DIMENSIONS = ["provider", "model", "requested_model", "model_provenance", "purpose", "connection_id"];
const DAY_MODEL_DIMENSIONS = ["date", ...MODEL_DIMENSIONS];
// Reuse the deployment's shared signing secret with a separate cryptographic domain.
// Unconfigured local processes have an ephemeral key and reject cursors after restart.
const cursorKey = process.env.JWT_SECRET
  ? createHash("sha256").update("usage-detail-cursor-v1\0").update(process.env.JWT_SECRET).digest()
  : randomBytes(32);
function cursorFingerprint(scope: unknown): string { return createHash("sha256").update(JSON.stringify(scope)).digest("hex"); }
function encodeCursor(fingerprint: string, last: string): string {
  const body = Buffer.from(JSON.stringify({ version: 1, fingerprint, last })).toString("base64url");
  return `${body}.${createHmac("sha256", cursorKey).update(body).digest("base64url")}`;
}
function decodeCursor(cursor: string, fingerprint: string): string {
  if (typeof cursor !== "string" || cursor.length > 32768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new UsageValidationError("Invalid detail cursor");
  const [body, signature] = cursor.split(".") as [string, string];
  const supplied = Buffer.from(signature, "base64url"), expected = createHmac("sha256", cursorKey).update(body).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new UsageValidationError("Invalid detail cursor");
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new UsageValidationError("Invalid detail cursor"); }
  const value = payload as { version?: unknown; fingerprint?: unknown; last?: unknown } | null;
  if (!value || value.version !== 1 || value.fingerprint !== fingerprint || typeof value.last !== "string" || value.last.length > 24000) throw new UsageValidationError("Detail cursor scope or price revision has changed");
  return value.last;
}
const COMPONENTS = [
  ["input_tokens", "input_per_million"], ["output_tokens", "output_per_million"],
  ["cache_read_tokens", "cache_read_per_million"], ["cache_write_tokens", "cache_write_per_million"],
  ["actual_unsplit_tokens", "unsplit_per_million"],
] as const;
const TOTAL = COMPONENTS.map(([token]) => `COALESCE(u.${token},0)`).join("+");
const PRICE_TOKENS = COMPONENTS.map(([token, rate]) => `CASE WHEN p.${rate} IS NOT NULL THEN COALESCE(u.${token},0) ELSE 0 END`).join("+");
const PRICE_AMOUNT = COMPONENTS.map(([token, rate]) => `COALESCE(u.${token},0)*COALESCE(p.${rate},0)`).join("+");
const PRICING_AVAILABLE = COMPONENTS.map(([token, rate]) => `(u.${token} IS NOT NULL AND p.${rate} IS NOT NULL)`).join(" OR ");

export class UsageAccountingRepo {
  constructor(private ctx: StoreContext) {}

  listPrices(workspaceId: string): UsagePrice[] {
    return (this.ctx.db.query("SELECT * FROM multiremi_usage_prices WHERE workspace_id=? ORDER BY provider,model,connection_id,effective_from DESC").all(workspaceId) as Row[]).map(r => ({ ...r, requested_model_alias: Number(r.requested_model_alias) === 1 })) as unknown as UsagePrice[];
  }

  setPrice(workspaceId: string, input: SetUsagePriceInput): UsagePrice {
    const p = validatePrice(input);
    return this.ctx.db.transaction(() => {
      // Workspace lock prevents concurrent overlapping appends on PostgreSQL.
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      this.ctx.db.run(`UPDATE multiremi_usage_prices SET effective_to=? WHERE workspace_id=? AND provider=? AND model=?
        AND COALESCE(connection_id,'')=COALESCE(?,'') AND requested_model_alias=? AND effective_to IS NULL AND effective_from<?`,
      [p.effective_from, workspaceId, p.provider, p.model, p.connection_id, p.requested_model_alias ? 1 : 0, p.effective_from]);
      const end = p.effective_to ?? "9999-12-31T23:59:59.999Z";
      const overlapping = this.ctx.db.query(`SELECT id FROM multiremi_usage_prices
        WHERE workspace_id=? AND provider=? AND model=? AND COALESCE(connection_id,'')=COALESCE(?,'') AND requested_model_alias=?
          AND effective_from<? AND COALESCE(effective_to,'9999-12-31T23:59:59.999Z')>?`).all(
        workspaceId, p.provider, p.model, p.connection_id, p.requested_model_alias ? 1 : 0, end, p.effective_from,
      );
      if (overlapping.length) throw new UsageValidationError("Price effective intervals overlap; close the previous version first");
      const price: UsagePrice = { ...p, id: createId("price"), workspace_id: workspaceId, created_at: nowIso() };
      const fields = Object.keys(price);
      this.ctx.db.run(`INSERT INTO multiremi_usage_prices(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`, fields.map((f) => f === "requested_model_alias" ? (price.requested_model_alias ? 1 : 0) : (price as unknown as Row)[f]));
      this.bumpPricingRevision(workspaceId);
      return price;
    })();
  }

  /** Closing a version preserves its prices and original start for historical reports. */
  closePrice(workspaceId: string, id: string, effectiveTo: string): UsagePrice {
    const end = validTimestamp(effectiveTo);
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const price = this.ctx.db.query("SELECT * FROM multiremi_usage_prices WHERE workspace_id=? AND id=?").get(workspaceId, id) as unknown as UsagePrice | null;
      if (!price) throw new UsageValidationError("Price not found");
      if (end <= price.effective_from || (price.effective_to && end > price.effective_to)) throw new UsageValidationError("A price version may only be closed or shortened after its start");
      this.ctx.db.run("UPDATE multiremi_usage_prices SET effective_to=? WHERE workspace_id=? AND id=?", [end, workspaceId, id]);
      this.bumpPricingRevision(workspaceId);
      return { ...price, requested_model_alias: Number(price.requested_model_alias) === 1, effective_to: end };
    })();
  }

  report(input: UsageReportInput): UsageReport {
    if (!this.ctx.db.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(USAGE_CUTOVER_MARKER)) throw new UsageAccountingNotReadyError("Usage history backfill has not completed");
    const asOf = nowIso();
    const tz = validTimezone(input.tz ?? "UTC");
    const days = input.days === null ? null : input.days ?? 30;
    if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > 3650)) throw new UsageValidationError("days must be 1..3650 or all");
    const since = input.since ? validTimestamp(input.since) : days === null ? null : localDayStart(addDate(dateInTz(new Date(), tz), -(days - 1)), tz);
    const until = input.until ? validTimestamp(input.until) : null;
    if (since && until && since >= until) throw new UsageValidationError("since must precede until");
    if (input.include !== undefined && input.include !== "day_model") throw new UsageValidationError("Invalid report include");
    if (input.include === undefined && (input.detailLimit !== undefined || input.detailCursor != null)) throw new UsageValidationError("Detail parameters require include=day_model");
    const detailLimit = input.detailLimit ?? 200;
    if (!Number.isSafeInteger(detailLimit) || detailLimit < 1 || detailLimit > 500) throw new UsageValidationError("detail_limit must be 1..500");
    const where = ["t.workspace_id=?"];
    const params: unknown[] = [input.workspaceId];
    const scheduleProject = this.ctx.db.dialect === "postgres"
      ? "CASE WHEN CAST(a.schedule_target AS JSONB)->>'kind'='project' THEN CAST(a.schedule_target AS JSONB)->>'id' ELSE NULL END"
      : "CASE WHEN json_valid(a.schedule_target) AND json_extract(a.schedule_target,'$.kind')='project' THEN json_extract(a.schedule_target,'$.id') ELSE NULL END";
    // Current bindings only describe tasks that have never begun reporting.
    // An existing frozen unknown scope must not fall back to a mutable Issue.
    const lifecycleProject = `CASE WHEN r.task_id IS NOT NULL THEN r.project_id WHEN t.runtime_workspace_id IS NOT NULL THEN NULL
      ELSE COALESCE(i.project_id,${scheduleProject},c.project_id) END`;
    if (input.projectId) { where.push(`(${lifecycleProject}=? OR EXISTS(SELECT 1 FROM multiremi_usage_units scope_unit WHERE scope_unit.task_id=t.id AND scope_unit.project_id=?))`); params.push(input.projectId, input.projectId); }
    if (input.runtimeId) { where.push("(t.runtime_id=? OR EXISTS(SELECT 1 FROM multiremi_usage_units scope_unit WHERE scope_unit.task_id=t.id AND scope_unit.runtime_id=?))"); params.push(input.runtimeId, input.runtimeId); }
    const factTime = "COALESCE(u.occurred_at,t.occurred_at)";
    const timeWhere: string[] = [], timeParams: unknown[] = [];
    if (since) { timeWhere.push(`${factTime}>=?`); timeParams.push(since); }
    if (until) { timeWhere.push(`${factTime}<?`); timeParams.push(until); }
    const timePredicate = timeWhere.length ? timeWhere.join(" AND ") : "1=1";
    const unitFilters: string[] = [], unitParams = [...timeParams];
    if (input.projectId) { unitFilters.push("u.project_id=?"); unitParams.push(input.projectId); }
    if (input.runtimeId) { unitFilters.push("u.runtime_id=?"); unitParams.push(input.runtimeId); }
    const unitPredicate = [timePredicate.replaceAll(factTime, "u.occurred_at"), ...unitFilters].join(" AND ");
    const lifeFilters: string[] = [], lifeParams = [...timeParams];
    if (input.runtimeId) { lifeFilters.push("t.runtime_id=?"); lifeParams.push(input.runtimeId); }
    if (input.projectId) { lifeFilters.push("t.lifecycle_project_id=?"); lifeParams.push(input.projectId); }
    const lifePredicate = [timePredicate.replaceAll(factTime, "t.occurred_at"), ...lifeFilters].join(" AND ");
    const runFilters: string[] = [], runParams: unknown[] = [];
    if (input.runtimeId) { runFilters.push("rs.runtime_id=?"); runParams.push(input.runtimeId); }
    if (input.projectId) { runFilters.push("rs.project_id=?"); runParams.push(input.projectId); }
    const relevantRun = (alias: string) => runFilters.length ? ` AND EXISTS(SELECT 1 FROM multiremi_usage_run_scopes rs WHERE rs.task_id=${alias}.task_id AND rs.run_id=${alias}.run_id AND ${runFilters.join(" AND ")})` : "";
    const tasksSql = `SELECT t.id,t.agent_id,t.runtime_id,t.status,t.started_at,t.dispatched_at,t.created_at,${lifecycleProject} AS lifecycle_project_id,
      COALESCE(t.completed_at,t.failed_at,t.cancelled_at,t.updated_at) AS ended_at,
      CASE WHEN t.status='completed' THEN COALESCE(t.completed_at,t.updated_at,t.created_at)
        WHEN t.status='failed' THEN COALESCE(t.failed_at,t.completed_at,t.updated_at,t.created_at)
        WHEN t.status='cancelled' THEN COALESCE(t.cancelled_at,t.completed_at,t.updated_at,t.created_at)
        ELSE '${asOf}' END AS occurred_at
      FROM multiremi_tasks t LEFT JOIN multiremi_usage_task_scopes r ON r.task_id=t.id
      LEFT JOIN multiremi_issues i ON i.id=t.issue_id LEFT JOIN multiremi_chat_sessions c ON c.id=t.chat_session_id
      LEFT JOIN multiremi_autopilot_runs a ON a.id=(SELECT ar.id FROM multiremi_autopilot_runs ar WHERE ar.task_id=t.id ORDER BY ar.created_at DESC LIMIT 1)
      WHERE ${where.join(" AND ")}`;
    return this.ctx.db.transaction(() => {
      if (this.ctx.db.dialect === "postgres") {
        this.ctx.db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        // This bounded interactive aggregate costs more to JIT-compile than
        // to execute. Scope the setting to this snapshot transaction only.
        this.ctx.db.exec("SET LOCAL jit=off");
      }
      const prices = this.ctx.db.query("SELECT revision FROM multiremi_usage_price_revisions WHERE workspace_id=?").get(input.workspaceId) as Row | null;
      const pricingRevision = String(prices?.revision ?? 0);
      const fingerprint = cursorFingerprint([input.workspaceId, input.projectId ?? null, input.runtimeId ?? null, since, until, tz, pricingRevision]);
      const after = input.detailCursor == null ? null : decodeCursor(input.detailCursor, fingerprint);
      const extent = this.ctx.db.query(`SELECT MIN(occurred_at) AS first,MAX(occurred_at) AS last FROM (SELECT ${factTime} AS occurred_at FROM (${tasksSql}) t
        LEFT JOIN multiremi_usage_units u ON u.task_id=t.id AND ${unitPredicate}
        WHERE u.task_id IS NOT NULL OR (${lifePredicate}) UNION ALL SELECT t.occurred_at FROM (${tasksSql}) t WHERE ${lifePredicate}) report_dates`).get(...params, ...unitParams, ...lifeParams, ...params, ...lifeParams) as Row;
      const dateExpr = this.dateExpression(tz, extent.first, extent.last);
      const seconds = this.ctx.db.dialect === "postgres"
        ? "GREATEST(0,EXTRACT(EPOCH FROM (CAST(t.ended_at AS TIMESTAMPTZ)-CAST(COALESCE(t.started_at,t.dispatched_at,t.created_at) AS TIMESTAMPTZ))))"
        : "MAX(0,(julianday(t.ended_at)-julianday(COALESCE(t.started_at,t.dispatched_at,t.created_at)))*86400)";
      const tokenEvidence = (alias: string) => `(${alias}.input_tokens IS NOT NULL OR ${alias}.output_tokens IS NOT NULL OR ${alias}.cache_read_tokens IS NOT NULL OR ${alias}.cache_write_tokens IS NOT NULL OR ${alias}.actual_unsplit_tokens IS NOT NULL)`;
      const identityConflict = "identity.task_id IS NOT NULL";
      let cte = `WITH tasks AS (${tasksSql}), identity_conflict_tasks AS (
        SELECT c.task_id,c.run_id FROM multiremi_usage_identity_conflicts c JOIN tasks scoped ON scoped.id=c.task_id
        UNION SELECT c.owner_task_id,c.owner_run_id FROM multiremi_usage_identity_conflicts c JOIN tasks scoped ON scoped.id=c.owner_task_id
      ), identity_conflict_scope AS (
        SELECT DISTINCT identity.task_id FROM identity_conflict_tasks identity WHERE 1=1 ${relevantRun("identity")}
      ), run_observations AS (
        SELECT observed.task_id,observed.run_id,MAX(CASE WHEN observed.source<>'context_snapshot' AND ${tokenEvidence("observed")} THEN 1 ELSE 0 END) AS has_actual
        FROM multiremi_usage_units observed JOIN tasks scoped ON scoped.id=observed.task_id GROUP BY observed.task_id,observed.run_id
      ), run_state AS (
        SELECT rr.task_id,MAX(CASE WHEN COALESCE(observed.has_actual,0)=0 THEN 1 ELSE 0 END) AS missing_actual,
          MIN(CASE WHEN rr.complete=1 AND observed.has_actual=1 THEN 1 ELSE 0 END) AS complete
        FROM multiremi_usage_runs rr JOIN tasks scoped ON scoped.id=rr.task_id
        LEFT JOIN run_observations observed ON observed.task_id=rr.task_id AND observed.run_id=rr.run_id
        WHERE 1=1 ${relevantRun("rr")} GROUP BY rr.task_id
      ), cost_links AS (
        SELECT l.task_id,l.run_id,l.monetary_unit_id,l.covered_unit_id FROM multiremi_usage_cost_coverage l JOIN tasks scoped ON scoped.id=l.task_id
        UNION SELECT own.task_id,own.run_id,own.unit_id,own.unit_id FROM multiremi_usage_units own JOIN tasks scoped ON scoped.id=own.task_id
          WHERE cost_source='provider_reported' AND cost_amount IS NOT NULL AND ${tokenEvidence("own")}
      ), cost_claims AS (
        SELECT task_id,run_id,covered_unit_id,COUNT(*) AS claim_count FROM cost_links GROUP BY task_id,run_id,covered_unit_id
      ), valid_charges AS (
        SELECT m.task_id,m.run_id,m.unit_id FROM multiremi_usage_units m JOIN tasks scoped ON scoped.id=m.task_id
        WHERE m.cost_source='provider_reported' AND m.cost_amount IS NOT NULL AND m.scope IN ('request','turn') AND m.cost_coverage_complete=1
          AND EXISTS(SELECT 1 FROM cost_links l WHERE l.task_id=m.task_id AND l.run_id=m.run_id AND l.monetary_unit_id=m.unit_id)
          AND NOT EXISTS(SELECT 1 FROM cost_links l
            LEFT JOIN multiremi_usage_units target ON target.task_id=l.task_id AND target.run_id=l.run_id AND target.unit_id=l.covered_unit_id
            LEFT JOIN cost_claims c ON c.task_id=l.task_id AND c.run_id=l.run_id AND c.covered_unit_id=l.covered_unit_id
            WHERE l.task_id=m.task_id AND l.run_id=m.run_id AND l.monetary_unit_id=m.unit_id
              AND (target.unit_id IS NULL OR target.source='context_snapshot' OR NOT ${tokenEvidence("target")}
                OR target.provider<>m.provider OR COALESCE(target.connection_id,'')<>COALESCE(m.connection_id,'') OR c.claim_count<>1
                OR (m.scope='request' AND m.provider_session_id IS NOT NULL AND target.provider_session_id IS NOT NULL
                  AND (m.provider_session_id<>target.provider_session_id OR m.provider_request_id<>target.provider_request_id
                    OR target.identity_kind='cumulative_meter'))))
      ), charge_groups AS (
        SELECT v.task_id,v.run_id,v.unit_id,target.provider,target.model,target.requested_model,target.model_source,target.purpose,target.connection_id
        FROM valid_charges v JOIN cost_links l ON l.task_id=v.task_id AND l.run_id=v.run_id AND l.monetary_unit_id=v.unit_id
        JOIN multiremi_usage_units target ON target.task_id=l.task_id AND target.run_id=l.run_id AND target.unit_id=l.covered_unit_id
        GROUP BY v.task_id,v.run_id,v.unit_id,target.provider,target.model,target.requested_model,target.model_source,target.purpose,target.connection_id
      ), charge_dimensions AS (
        SELECT task_id,run_id,unit_id,COUNT(*) AS model_groups,MIN(provider) AS provider,MIN(model) AS model,
          MIN(requested_model) AS requested_model,MIN(model_source) AS model_source,MIN(purpose) AS purpose,MIN(connection_id) AS connection_id
        FROM charge_groups GROUP BY task_id,run_id,unit_id
      ), covered_cost AS (
        SELECT l.task_id,l.run_id,l.covered_unit_id,MIN(d.model_groups) AS model_groups FROM cost_links l JOIN valid_charges v
          ON v.task_id=l.task_id AND v.run_id=l.run_id AND v.unit_id=l.monetary_unit_id
        JOIN charge_dimensions d ON d.task_id=v.task_id AND d.run_id=v.run_id AND d.unit_id=v.unit_id
        GROUP BY l.task_id,l.run_id,l.covered_unit_id
      ), unit_facts AS (
        SELECT t.id AS task_id,COALESCE(u.agent_id,t.agent_id) AS agent_id,CASE WHEN u.task_id IS NULL THEN t.runtime_id ELSE u.runtime_id END AS runtime_id,t.status,${dateExpr} AS date,
          CASE WHEN ${lifePredicate} THEN 1 ELSE 0 END AS lifecycle_in_window,
          COALESCE(${seconds},0) AS seconds,COALESCE(u.provider,'unknown') AS provider,
          CASE WHEN v.unit_id IS NULL THEN u.model WHEN d.model_groups=1 THEN d.model ELSE NULL END AS model,
          CASE WHEN v.unit_id IS NULL THEN u.requested_model WHEN d.model_groups=1 THEN d.requested_model ELSE NULL END AS requested_model,
          CASE WHEN v.unit_id IS NULL THEN COALESCE(u.model_source,'unknown') WHEN d.model_groups=1 THEN d.model_source ELSE 'unallocated_cost' END AS model_provenance,
          CASE WHEN v.unit_id IS NULL THEN COALESCE(u.purpose,'agent') WHEN d.model_groups=1 THEN d.purpose ELSE 'mixed' END AS purpose,
          u.connection_id,u.context_tokens,
          COALESCE(u.runtime_provenance,'unknown') AS runtime_provenance,
          CASE WHEN u.source='legacy_task' THEN 'task_attributed' ELSE u.time_provenance END AS time_provenance,
          CASE WHEN ${identityConflict} THEN 1 ELSE 0 END AS identity_conflict,
          COALESCE(u.input_tokens,0) AS actual_input_tokens,COALESCE(u.output_tokens,0) AS actual_output_tokens,
          COALESCE(u.cache_read_tokens,0) AS actual_cache_read_tokens,COALESCE(u.cache_write_tokens,0) AS actual_cache_write_tokens,
          COALESCE(u.actual_unsplit_tokens,0) AS actual_unsplit_tokens,(${TOTAL}) AS actual_total_tokens,
          CASE WHEN cc.covered_unit_id IS NOT NULL THEN (${TOTAL}) WHEN claim.covered_unit_id IS NULL AND p.source='configured' THEN (${PRICE_TOKENS}) ELSE 0 END AS priced_tokens,
          CASE WHEN v.unit_id IS NOT NULL OR u.cost_source='sdk_estimate' THEN u.cost_amount
            WHEN u.cost_amount IS NOT NULL OR cc.covered_unit_id IS NOT NULL OR claim.covered_unit_id IS NOT NULL THEN NULL
            WHEN ${PRICING_AVAILABLE} THEN (${PRICE_AMOUNT})/1000000.0 ELSE NULL END AS amount,
          CASE WHEN v.unit_id IS NOT NULL OR u.cost_source='sdk_estimate' THEN u.cost_currency
            WHEN u.cost_amount IS NOT NULL OR cc.covered_unit_id IS NOT NULL OR claim.covered_unit_id IS NOT NULL THEN NULL
            WHEN ${PRICING_AVAILABLE} THEN p.currency ELSE NULL END AS currency,
          CASE WHEN v.unit_id IS NOT NULL THEN 'provider_reported' ELSE COALESCE(p.source,'unknown') END AS quality,
          CASE WHEN u.cost_amount IS NOT NULL AND u.cost_source='provider_reported' AND v.unit_id IS NULL THEN 0 ELSE 1 END AS price_complete,
          CASE WHEN cc.model_groups>1 OR d.model_groups>1 THEN 0 ELSE 1 END AS cost_allocation_complete,
          CASE WHEN u.cost_amount IS NOT NULL THEN CASE WHEN u.cost_source='provider_reported' THEN 0 ELSE 2 END WHEN p.source='published' THEN 1 ELSE 0 END AS reference_amount,
          CASE WHEN ${identityConflict} OR u.task_id IS NULL OR COALESCE(observed.has_actual,0)=0 OR state.missing_actual=1
            OR (u.source<>'context_snapshot' AND u.accuracy<>'exact' AND (u.cost_amount IS NULL OR u.input_tokens IS NOT NULL OR u.output_tokens IS NOT NULL OR u.cache_read_tokens IS NOT NULL OR u.cache_write_tokens IS NOT NULL OR u.actual_unsplit_tokens IS NOT NULL OR u.reported_total_tokens IS NOT NULL)) THEN 1 ELSE 0 END AS unknown,
          COALESCE(state.complete,0) AS run_complete
        FROM tasks t LEFT JOIN multiremi_usage_units u ON u.task_id=t.id AND ${unitPredicate}
        LEFT JOIN identity_conflict_scope identity ON identity.task_id=t.id
        LEFT JOIN run_observations observed ON observed.task_id=u.task_id AND observed.run_id=u.run_id
        LEFT JOIN run_state state ON state.task_id=t.id
        LEFT JOIN valid_charges v ON v.task_id=u.task_id AND v.run_id=u.run_id AND v.unit_id=u.unit_id
        LEFT JOIN charge_dimensions d ON d.task_id=u.task_id AND d.run_id=u.run_id AND d.unit_id=u.unit_id
        LEFT JOIN covered_cost cc ON cc.task_id=u.task_id AND cc.run_id=u.run_id AND cc.covered_unit_id=u.unit_id
        LEFT JOIN cost_claims claim ON claim.task_id=u.task_id AND claim.run_id=u.run_id AND claim.covered_unit_id=u.unit_id
        LEFT JOIN multiremi_usage_prices p ON p.workspace_id=? AND p.provider=u.provider
          AND ((p.requested_model_alias=0 AND p.model=u.model) OR (p.requested_model_alias=1 AND u.model IS NULL AND p.model=u.requested_model))
          AND (p.source<>'published' OR u.model_source='provider_reported')
          AND COALESCE(p.connection_id,'')=COALESCE(u.connection_id,'')
          AND p.effective_from<=u.occurred_at AND (p.effective_to IS NULL OR p.effective_to>u.occurred_at)
        WHERE u.task_id IS NOT NULL OR (${lifePredicate})
      ), facts AS MATERIALIZED (
        SELECT task_id,agent_id,runtime_id,status,date,lifecycle_in_window,seconds,provider,model,requested_model,model_provenance,purpose,connection_id,runtime_provenance,time_provenance,currency,quality,reference_amount,
          ${["actual_input_tokens", "actual_output_tokens", "actual_cache_read_tokens", "actual_cache_write_tokens", "actual_unsplit_tokens", "actual_total_tokens", "priced_tokens"].map(field => `SUM(${field}) AS ${field}`).join(",")},
          MAX(context_tokens) AS context_tokens,MAX(identity_conflict) AS identity_conflict,MAX(unknown) AS unknown,
          MIN(run_complete) AS run_complete,MIN(price_complete) AS price_complete,MIN(cost_allocation_complete) AS cost_allocation_complete,SUM(amount) AS amount
        FROM unit_facts GROUP BY task_id,agent_id,runtime_id,status,date,lifecycle_in_window,seconds,provider,model,requested_model,model_provenance,purpose,connection_id,runtime_provenance,time_provenance,currency,quality,reference_amount
      )`;
      const queryParams = [...params, ...runParams, ...runParams, ...lifeParams, ...unitParams, input.workspaceId, ...lifeParams];
      const baseDimensions = [[], ["date"], ["agent_id"], MODEL_DIMENSIONS, ["runtime_id"]];
      const dimensions = input.include ? [...baseDimensions, DAY_MODEL_DIMENSIONS] : baseDimensions;
      const detailCollation = this.ctx.db.dialect === "postgres" ? '"C"' : "BINARY";
      // Hex UTF-8 components plus an explicit NULL marker form one portable, collision-free order.
      const detailKey = DAY_MODEL_DIMENSIONS.map(field => `CASE WHEN ${field} IS NULL THEN '0' ELSE '1'||${this.ctx.db.dialect === "postgres" ? `encode(convert_to(${field},'UTF8'),'hex')` : `lower(hex(${field}))`} END`).join("||'|'||");
      if (input.include) {
        const factFields = "task_id,agent_id,runtime_id,status,date,lifecycle_in_window,seconds,provider,model,requested_model,model_provenance,purpose,connection_id,runtime_provenance,time_provenance,currency,quality,reference_amount,actual_input_tokens,actual_output_tokens,actual_cache_read_tokens,actual_cache_write_tokens,actual_unsplit_tokens,actual_total_tokens,priced_tokens,context_tokens,identity_conflict,unknown,run_complete,price_complete,cost_allocation_complete,amount";
        cte += `, detail_groups AS MATERIALIZED (SELECT ${detailKey} AS detail_key FROM facts GROUP BY ${DAY_MODEL_DIMENSIONS.join(",")}),
          detail_keys AS MATERIALIZED (SELECT detail_key FROM detail_groups ${after === null ? "" : `WHERE detail_key COLLATE ${detailCollation}>?`} ORDER BY detail_key COLLATE ${detailCollation} LIMIT ${detailLimit + 1}),
          detail_page AS MATERIALIZED (SELECT detail_key FROM detail_keys ORDER BY detail_key COLLATE ${detailCollation} LIMIT ${detailLimit}),
          detail_facts AS MATERIALIZED (SELECT ${factFields} FROM facts WHERE (${detailKey}) IN (SELECT detail_key FROM detail_page))`;
        if (after !== null) queryParams.push(after);
      }
      const tokenFields = ["actual_input_tokens", "actual_output_tokens", "actual_cache_read_tokens", "actual_cache_write_tokens", "actual_unsplit_tokens", "actual_total_tokens", "priced_tokens"];
      const totalFields = [...tokenFields, "task_count", "unknown_task_count", "identity_conflict_task_count", "task_attributed_task_count", "task_attributed_tokens", "time_provenance", "context_peak_tokens", "run_complete", "price_complete", "cost_allocation_complete", "runtime_provenance", "completed", "failed", "cancelled", "active", "queued"];
      const branches: string[] = [];
      let summaryTotalsSql = "", summaryMonetarySql = "";
      const jsonRow = (fields: string[]) => this.ctx.db.dialect === "postgres" ? "row_to_json(result)::text" : `json_object(${fields.flatMap(field => [
        `'${field}'`, ["amount", "total_seconds"].includes(field)
          // SQLite JSON's default float rendering drops significant digits.
          // Encode these two floats as round-trip strings, then normalize below.
          ? `CASE WHEN ${field} IS NULL THEN NULL ELSE printf('%!.17g',${field}) END` : field,
      ]).join(",")})`;
      const branch = (dimension: number, kind: string, fields: string[], sql: string) => branches.push(`SELECT ${dimension} AS dimension,'${kind}' AS kind,${jsonRow(fields)} AS payload FROM (${sql}) result`);
      for (const [dimension, keys] of dimensions.entries()) {
        const keySelect = keys.length ? `${keys.join(",")},` : "";
        const group = keys.length ? `GROUP BY ${keys.join(",")}` : "";
        const totalsSql = `SELECT ${keySelect}
          ${["actual_input_tokens", "actual_output_tokens", "actual_cache_read_tokens", "actual_cache_write_tokens", "actual_unsplit_tokens", "actual_total_tokens", "priced_tokens"].map((f) => `COALESCE(SUM(${f}),0) AS ${f}`).join(",")},
          COUNT(DISTINCT task_id) AS task_count,COUNT(DISTINCT CASE WHEN unknown=1 THEN task_id END) AS unknown_task_count,
          COUNT(DISTINCT CASE WHEN identity_conflict=1 THEN task_id END) AS identity_conflict_task_count,
          COUNT(DISTINCT CASE WHEN time_provenance='task_attributed' THEN task_id END) AS task_attributed_task_count,
          COALESCE(SUM(CASE WHEN time_provenance='task_attributed' THEN actual_total_tokens ELSE 0 END),0) AS task_attributed_tokens,
          CASE WHEN MIN(time_provenance) IS NULL THEN NULL WHEN MIN(time_provenance)=MAX(time_provenance) THEN MIN(time_provenance) ELSE 'mixed' END AS time_provenance,
          MAX(context_tokens) AS context_peak_tokens,MIN(run_complete) AS run_complete,MIN(price_complete) AS price_complete,MIN(cost_allocation_complete) AS cost_allocation_complete,
          CASE WHEN MIN(runtime_provenance)=MAX(runtime_provenance) THEN MIN(runtime_provenance) ELSE 'mixed' END AS runtime_provenance,
          COUNT(DISTINCT CASE WHEN lifecycle_in_window=1 AND status='completed' THEN task_id END) AS completed,
          COUNT(DISTINCT CASE WHEN lifecycle_in_window=1 AND status='failed' THEN task_id END) AS failed,
          COUNT(DISTINCT CASE WHEN lifecycle_in_window=1 AND status='cancelled' THEN task_id END) AS cancelled,
          COUNT(DISTINCT CASE WHEN lifecycle_in_window=1 AND status IN ('dispatched','running','waiting_local_directory','awaiting_human') THEN task_id END) AS active,
          COUNT(DISTINCT CASE WHEN lifecycle_in_window=1 AND status IN ('queued','pending') THEN task_id END) AS queued
          FROM ${dimension === 5 ? "detail_facts" : "facts"} ${group}`;
        branch(dimension, "totals", [...keys, ...totalFields], totalsSql);
        const monetarySql = `SELECT ${keySelect}currency,reference_amount,SUM(amount) AS amount,MIN(quality) AS first_quality,MAX(quality) AS last_quality
          FROM ${dimension === 5 ? "detail_facts" : "facts"} WHERE currency IS NOT NULL AND amount IS NOT NULL GROUP BY ${[...keys, "currency", "reference_amount"].join(",")}`;
        branch(dimension, "monetary", [...keys, "currency", "reference_amount", "amount", "first_quality", "last_quality"], monetarySql);
        if (dimension === 0) { summaryTotalsSql = totalsSql; summaryMonetarySql = monetarySql; }
        if (dimension !== 5) branch(dimension, "durations", [...keys, "total_seconds"], `SELECT ${keySelect}SUM(seconds) AS total_seconds FROM (
          SELECT DISTINCT ${keySelect}task_id,CASE WHEN lifecycle_in_window=1 AND status IN ('completed','failed','cancelled') THEN seconds ELSE 0 END AS seconds FROM facts) task_durations ${group}`);
      }
      const dimensionFields = [...new Set(dimensions.flat())];
      if (this.ctx.db.dialect === "postgres") {
        // GROUPING distinguishes a real NULL dimension from a rolled-up one.
        // PostgreSQL can calculate the five views in one aggregate pass.
        const groupMask = `GROUPING(${dimensionFields.join(",")})`;
        const dimension = `CASE ${groupMask} ${baseDimensions.map((keys, index) => {
          const mask = dimensionFields.reduce((value, field, bit) => value + (keys.includes(field) ? 0 : 2 ** (dimensionFields.length - bit - 1)), 0);
          return `WHEN ${mask} THEN ${index}`;
        }).join(" ")} END`;
        const sets = (suffix: string[]) => `GROUP BY GROUPING SETS (${baseDimensions.map(keys => `(${[...keys, ...suffix].join(",")})`).join(",")})`;
        const prefix = `SELECT ${dimension} AS dimension,${dimensionFields.join(",")},`;
        const totalsSql = summaryTotalsSql.replace(/^SELECT /, prefix) + sets([]);
        const monetarySql = summaryMonetarySql.replace(/^SELECT /, prefix).replace("GROUP BY currency,reference_amount", sets(["currency", "reference_amount"]));
        const durationsSql = `SELECT dimension,${dimensionFields.join(",")},SUM(seconds) AS total_seconds FROM (
          ${prefix}task_id,MAX(CASE WHEN lifecycle_in_window=1 AND status IN ('completed','failed','cancelled') THEN seconds ELSE 0 END) AS seconds
          FROM facts ${sets(["task_id"])}) task_durations GROUP BY dimension,${dimensionFields.join(",")}`;
        const detailBranches = input.include ? branches.slice(-2) : [];
        branches.length = 0;
        for (const [kind, sql] of [["totals", totalsSql], ["monetary", monetarySql], ["durations", durationsSql]]) branches.push(
          `SELECT result.dimension,'${kind}' AS kind,(to_jsonb(result)-'dimension')::text AS payload FROM (${sql}) result`);
        branches.push(...detailBranches);
      }
      if (input.include) branch(5, "cursor", ["detail_key"], "SELECT detail_key FROM detail_keys");
      // One materialized SQL fact set serves all views; only aggregate rows
      // cross the DB bridge, and correlated run-evidence scans never repeat
      // per diagnostic unit or per view.
      const grouped = new Map<string, Row[]>();
      for (const raw of this.ctx.db.query(`${cte} ${branches.join(" UNION ALL ")}`).all(...queryParams) as Row[]) {
        const id = `${raw.dimension}:${raw.kind}`;
        const rows = grouped.get(id) ?? [];
        const row = JSON.parse(String(raw.payload)) as Row;
        for (const field of dimensionFields) if (!dimensions[Number(raw.dimension)]!.includes(field)) delete row[field];
        rows.push(row);
        grouped.set(id, rows);
      }
      const aggregate = (keys: string[]): Array<UsageMetrics & Row> => {
        const dimension = dimensions.findIndex(fields => fields.join(",") === keys.join(","));
        const totals = grouped.get(`${dimension}:totals`) ?? [];
        const monetary = grouped.get(`${dimension}:monetary`) ?? [];
        const durations = grouped.get(`${dimension}:durations`) ?? [];
        const key = (r: Row) => JSON.stringify(keys.map((k) => r[k] ?? null));
        const costs = new Map<string, { values: Record<string, number>; reference: Record<string, number>; sdk: Record<string, number>; qualities: Set<string> }>();
        for (const r of monetary) {
          const c = costs.get(key(r)) ?? { values: {}, reference: {}, sdk: {}, qualities: new Set<string>() };
          const amounts = Number(r.reference_amount) === 2 ? c.sdk : Number(r.reference_amount) === 1 ? c.reference : c.values;
          amounts[String(r.currency)] = Number(r.amount);
          if (Number(r.reference_amount) === 0) { c.qualities.add(String(r.first_quality)); c.qualities.add(String(r.last_quality)); }
          costs.set(key(r), c);
        }
        const durationMap = new Map(durations.map((r) => [key(r), Number(r.total_seconds ?? 0)]));
        return totals.map((r) => {
          const c = costs.get(key(r));
          const numericFields = new Set(["actual_input_tokens", "actual_output_tokens", "actual_cache_read_tokens", "actual_cache_write_tokens", "actual_unsplit_tokens", "actual_total_tokens", "priced_tokens", "task_count", "unknown_task_count", "context_peak_tokens", "identity_conflict_task_count", "task_attributed_task_count", "task_attributed_tokens"]);
          const metrics = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, numericFields.has(k) && v !== null ? Number(v) : v])) as Row;
          if (Number(r.identity_conflict_task_count) === 0) delete metrics.identity_conflict_task_count;
          if (Number(r.task_attributed_task_count) === 0) { delete metrics.task_attributed_task_count; delete metrics.task_attributed_tokens; }
          if (r.time_provenance === null) delete metrics.time_provenance;
          const status_counts = Object.fromEntries(["completed", "failed", "cancelled", "active", "queued"].map((s) => [s, Number(r[s] ?? 0)]));
          const allocationComplete = !keys.includes("model") || Number(r.cost_allocation_complete) === 1;
          if (allocationComplete) delete metrics.cost_allocation_complete;
          else metrics.cost_allocation_complete = false;
          for (const s of ["completed", "failed", "cancelled", "active", "queued", "run_complete", "price_complete"]) delete metrics[s];
          const unpriced_tokens = Number(r.actual_total_tokens) - Number(r.priced_tokens);
          return { ...metrics, total_seconds: durationMap.get(key(r)) ?? 0, known_cost_by_currency: c?.values ?? {}, reference_cost_by_currency: c?.reference ?? {}, sdk_estimate_cost_by_currency: c?.sdk ?? {}, unpriced_tokens,
            status_counts, price_quality: !c || c.qualities.size === 0 ? "unknown" : c.qualities.size > 1 ? "mixed" : [...c.qualities][0],
            complete: Number(r.task_count) === 0 || (Number(r.unknown_task_count) === 0 && unpriced_tokens === 0 && Number(r.run_complete) === 1 && Number(r.price_complete) === 1 && allocationComplete) } as unknown as UsageMetrics & Row;
        });
      };
      const summary = aggregate([])[0]!;
      const daily = aggregate(["date"]);
      const by_agent = aggregate(["agent_id"]);
      const by_model = aggregate(["provider", "model", "requested_model", "model_provenance", "purpose", "connection_id"]).map(r => ({ ...r, model_source: r.model !== null ? "reported" : r.requested_model !== null ? "requested" : "unknown" }));
      const by_runtime = aggregate(["runtime_id"]);
      const cursorKeys = (grouped.get("5:cursor") ?? []).map(row => String(row.detail_key)).sort();
      const day_model = input.include ? { rows: aggregate(DAY_MODEL_DIMENSIONS).map(row => {
        const { total_seconds: _duration, status_counts: _status, ...consumption } = row;
        return { ...consumption, model_source: row.model !== null ? "reported" : row.requested_model !== null ? "requested" : "unknown" };
      }).sort((a, b) => {
        const key = (row: Row) => DAY_MODEL_DIMENSIONS.map(field => row[field] === null ? "0" : `1${Buffer.from(String(row[field]), "utf8").toString("hex")}`).join("|");
        return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
      }), next_cursor: cursorKeys.length > detailLimit ? encodeCursor(fingerprint, cursorKeys[detailLimit - 1]!) : null } : undefined;
      const lifeAggregate = (keys: string[]) => {
        const fields = keys.length ? `${keys.map((k) => k === "date" ? `${dateExpr.replaceAll(factTime, "t.occurred_at")} AS date` : k).join(",")},` : "";
        const group = keys.length ? `GROUP BY ${keys.join(",")}` : "";
        return this.ctx.db.query(`SELECT ${fields}COUNT(*) AS task_count,
          COALESCE(SUM(CASE WHEN status IN ('completed','failed','cancelled') THEN ${seconds} ELSE 0 END),0) AS total_seconds,
          ${["completed", "failed", "cancelled"].map(s => `SUM(CASE WHEN status='${s}' THEN 1 ELSE 0 END) AS ${s}`).join(",")},
          SUM(CASE WHEN status IN ('dispatched','running','waiting_local_directory','awaiting_human') THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued
          FROM (${tasksSql}) t WHERE ${lifePredicate} ${group}`).all(...params, ...lifeParams).map((raw) => {
            const r = raw as Row;
            return { ...Object.fromEntries(keys.map(k => [k, r[k]])), task_count: Number(r.task_count), total_seconds: Number(r.total_seconds),
              status_counts: Object.fromEntries(["completed", "failed", "cancelled", "active", "queued"].map(s => [s, Number(r[s] ?? 0)])) };
          });
      };
      const lifeSummary = lifeAggregate([])[0]!;
      summary.status_counts = lifeSummary.status_counts as unknown as UsageMetrics["status_counts"];
      summary.total_seconds = lifeSummary.total_seconds;
      const task_daily = lifeAggregate(["date"]);
      const applyLife = (rows: Array<UsageMetrics & Row>, key: string, lifeRows: ReturnType<typeof lifeAggregate>) => {
        const index = new Map(lifeRows.map(r => [(r as Row)[key], r]));
        for (const row of rows) { const life = index.get(row[key]); row.total_seconds = life?.total_seconds ?? 0;
          row.status_counts = (life?.status_counts ?? { completed: 0, failed: 0, cancelled: 0, active: 0, queued: 0 }) as unknown as UsageMetrics["status_counts"]; }
      };
      applyLife(daily, "date", task_daily); applyLife(by_agent, "agent_id", lifeAggregate(["agent_id"])); applyLife(by_runtime, "runtime_id", lifeAggregate(["runtime_id"]));
      return { summary, daily, by_agent, by_model, by_runtime, task_daily, ...(day_model ? { day_model } : {}),
        time_basis: { consumption: "unit_occurred_at", terminal_tasks: "terminal_lifecycle_at", active_tasks: "current_snapshot", ...(summary.task_attributed_task_count ? { historical_aggregates: "task_attribution_at" } : {}) },
        coverage: { priced_tokens: summary.priced_tokens, unpriced_tokens: summary.unpriced_tokens,
          token_ratio: summary.actual_total_tokens ? summary.priced_tokens / summary.actual_total_tokens : null, unknown_task_count: summary.unknown_task_count },
        as_of: asOf, pricing_revision: pricingRevision,
        window: { since, until, days, tz, project_id: input.projectId ?? null, runtime_id: input.runtimeId ?? null } } as unknown as UsageReport;
    })();
  }

  private bumpPricingRevision(workspaceId: string): void {
    this.ctx.db.run("INSERT INTO multiremi_usage_price_revisions(workspace_id,revision) VALUES(?,1) ON CONFLICT(workspace_id) DO UPDATE SET revision=multiremi_usage_price_revisions.revision+1", [workspaceId]);
  }

  private dateExpression(tz: string, first: unknown, last: unknown): string {
    if (this.ctx.db.dialect === "postgres") return `TO_CHAR(CAST(COALESCE(u.occurred_at,t.occurred_at) AS TIMESTAMPTZ) AT TIME ZONE '${tz.replaceAll("'", "''")}','YYYY-MM-DD')`;
    if (tz === "UTC" || !first || !last) return "substr(COALESCE(u.occurred_at,t.occurred_at),1,10)";
    const cases: string[] = [];
    const lastDate = dateInTz(new Date(String(last)), tz);
    for (let date = dateInTz(new Date(String(first)), tz); date <= lastDate; date = addDate(date, 1)) {
      const end = localDayStart(addDate(date, 1), tz);
      cases.push(`WHEN COALESCE(u.occurred_at,t.occurred_at)<'${end}' THEN '${date}'`);
    }
    return `CASE ${cases.join(" ")} ELSE '${lastDate}' END`;
  }
}

function validTimestamp(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new UsageValidationError("Invalid timestamp");
  return new Date(value).toISOString();
}
function validTimezone(value: string): string {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return value; } catch { throw new UsageValidationError("Invalid timezone"); }
}
function dateInTz(date: Date, tz: string): string { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
function addDate(date: string, days: number): string { return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10); }
function localDayStart(date: string, tz: string): string {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  let low = midnight - 15 * 3600000, high = midnight + 15 * 3600000;
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (dateInTz(new Date(mid), tz) < date) low = mid; else high = mid; }
  return new Date(high).toISOString();
}
function validatePrice(input: SetUsagePriceInput): SetUsagePriceInput {
  if (!input || typeof input !== "object" || typeof input.provider !== "string" || !input.provider.trim()
    || typeof input.model !== "string" || !input.model.trim() || !/^[A-Z]{3}$/.test(input.currency)
    || !["configured", "published"].includes(input.source) || (input.connection_id !== null && typeof input.connection_id !== "string")
    || (input.source_url !== null && typeof input.source_url !== "string")) throw new UsageValidationError("Invalid price");
  for (const [, key] of COMPONENTS) { if (input[key] !== null && (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key]! < 0)) throw new UsageValidationError(`Invalid ${key}`); }
  const effective_from = validTimestamp(input.effective_from);
  const effective_to = input.effective_to === null ? null : validTimestamp(input.effective_to);
  if (effective_to && effective_to <= effective_from) throw new UsageValidationError("Price interval must have positive duration");
  if (input.source === "published" && !input.source_url) throw new UsageValidationError("Published pricing requires a source URL");
  if (input.requested_model_alias !== undefined && typeof input.requested_model_alias !== "boolean") throw new UsageValidationError("Invalid requested_model_alias");
  if (input.requested_model_alias && input.source !== "configured") throw new UsageValidationError("Requested model aliases require explicitly configured pricing");
  return { provider: input.provider.trim(), model: input.model.trim(), connection_id: input.connection_id, requested_model_alias: input.requested_model_alias ?? false, currency: input.currency,
    input_per_million: input.input_per_million, output_per_million: input.output_per_million,
    cache_read_per_million: input.cache_read_per_million, cache_write_per_million: input.cache_write_per_million,
    unsplit_per_million: input.unsplit_per_million, source: input.source, source_url: input.source_url, effective_from, effective_to };
}

import { createId, nowIso } from "@multiremi/ids.js";
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
      if (this.ctx.db.dialect === "postgres") this.ctx.db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const extent = this.ctx.db.query(`SELECT MIN(occurred_at) AS first,MAX(occurred_at) AS last FROM (SELECT ${factTime} AS occurred_at FROM (${tasksSql}) t
        LEFT JOIN multiremi_usage_units u ON u.task_id=t.id AND ${unitPredicate}
        WHERE u.task_id IS NOT NULL OR (${lifePredicate}) UNION ALL SELECT t.occurred_at FROM (${tasksSql}) t WHERE ${lifePredicate}) report_dates`).get(...params, ...unitParams, ...lifeParams, ...params, ...lifeParams) as Row;
      const dateExpr = this.dateExpression(tz, extent.first, extent.last);
      const seconds = this.ctx.db.dialect === "postgres"
        ? "GREATEST(0,EXTRACT(EPOCH FROM (CAST(t.ended_at AS TIMESTAMPTZ)-CAST(COALESCE(t.started_at,t.dispatched_at,t.created_at) AS TIMESTAMPTZ))))"
        : "MAX(0,(julianday(t.ended_at)-julianday(COALESCE(t.started_at,t.dispatched_at,t.created_at)))*86400)";
      const cte = `WITH tasks AS (${tasksSql}), facts AS (
        SELECT t.id AS task_id,COALESCE(u.agent_id,t.agent_id) AS agent_id,CASE WHEN u.task_id IS NULL THEN t.runtime_id ELSE u.runtime_id END AS runtime_id,t.status,${dateExpr} AS date,
          CASE WHEN ${lifePredicate} THEN 1 ELSE 0 END AS lifecycle_in_window,
          COALESCE(${seconds},0) AS seconds,COALESCE(u.provider,'unknown') AS provider,u.model,u.requested_model,COALESCE(u.model_source,'unknown') AS model_provenance,COALESCE(u.purpose,'agent') AS purpose,u.connection_id,u.context_tokens,
          COALESCE(u.runtime_provenance,'unknown') AS runtime_provenance,
          COALESCE(u.input_tokens,0) AS actual_input_tokens,COALESCE(u.output_tokens,0) AS actual_output_tokens,
          COALESCE(u.cache_read_tokens,0) AS actual_cache_read_tokens,COALESCE(u.cache_write_tokens,0) AS actual_cache_write_tokens,
          COALESCE(u.actual_unsplit_tokens,0) AS actual_unsplit_tokens,(${TOTAL}) AS actual_total_tokens,
          CASE WHEN u.cost_amount IS NOT NULL AND u.cost_source='provider_reported' THEN (${TOTAL}) WHEN p.source='configured' THEN (${PRICE_TOKENS}) ELSE 0 END AS priced_tokens,
          CASE WHEN u.cost_amount IS NOT NULL THEN CASE WHEN u.cost_source<>'unknown' THEN u.cost_amount ELSE NULL END WHEN ${PRICING_AVAILABLE} THEN (${PRICE_AMOUNT})/1000000.0 ELSE NULL END AS amount,
          CASE WHEN u.cost_amount IS NOT NULL THEN CASE WHEN u.cost_source<>'unknown' THEN u.cost_currency ELSE NULL END WHEN ${PRICING_AVAILABLE} THEN p.currency ELSE NULL END AS currency,
          CASE WHEN u.cost_amount IS NOT NULL THEN 'provider_reported' ELSE COALESCE(p.source,'unknown') END AS quality,
          CASE WHEN u.cost_amount IS NOT NULL THEN CASE WHEN u.cost_source='provider_reported' THEN 0 ELSE 2 END WHEN p.source='published' THEN 1 ELSE 0 END AS reference_amount,
          CASE WHEN u.task_id IS NULL OR NOT EXISTS(SELECT 1 FROM multiremi_usage_units observed WHERE observed.task_id=t.id AND observed.run_id=u.run_id
              AND observed.source<>'context_snapshot' AND (observed.input_tokens IS NOT NULL OR observed.output_tokens IS NOT NULL
                OR observed.cache_read_tokens IS NOT NULL OR observed.cache_write_tokens IS NOT NULL OR observed.actual_unsplit_tokens IS NOT NULL))
            OR EXISTS(SELECT 1 FROM multiremi_usage_runs missing_run WHERE missing_run.task_id=t.id ${relevantRun("missing_run")} AND NOT EXISTS(
              SELECT 1 FROM multiremi_usage_units evidence WHERE evidence.task_id=missing_run.task_id AND evidence.run_id=missing_run.run_id
              AND evidence.source<>'context_snapshot' AND (evidence.input_tokens IS NOT NULL OR evidence.output_tokens IS NOT NULL OR evidence.cache_read_tokens IS NOT NULL OR evidence.cache_write_tokens IS NOT NULL OR evidence.actual_unsplit_tokens IS NOT NULL)))
            OR (u.source<>'context_snapshot' AND u.accuracy<>'exact' AND (u.cost_amount IS NULL OR u.input_tokens IS NOT NULL OR u.output_tokens IS NOT NULL OR u.cache_read_tokens IS NOT NULL OR u.cache_write_tokens IS NOT NULL OR u.actual_unsplit_tokens IS NOT NULL OR u.reported_total_tokens IS NOT NULL)) THEN 1 ELSE 0 END AS unknown,
          CASE WHEN NOT EXISTS(SELECT 1 FROM multiremi_usage_runs rr WHERE rr.task_id=t.id ${relevantRun("rr")})
            OR EXISTS(SELECT 1 FROM multiremi_usage_runs rr WHERE rr.task_id=t.id ${relevantRun("rr")} AND (rr.complete=0 OR NOT EXISTS(
              SELECT 1 FROM multiremi_usage_units covered WHERE covered.task_id=rr.task_id AND covered.run_id=rr.run_id AND covered.source<>'context_snapshot'
              AND (covered.input_tokens IS NOT NULL OR covered.output_tokens IS NOT NULL OR covered.cache_read_tokens IS NOT NULL OR covered.cache_write_tokens IS NOT NULL OR covered.actual_unsplit_tokens IS NOT NULL)))) THEN 0 ELSE 1 END AS run_complete
        FROM tasks t LEFT JOIN multiremi_usage_units u ON u.task_id=t.id AND ${unitPredicate}
        LEFT JOIN multiremi_usage_prices p ON p.id=(SELECT pp.id FROM multiremi_usage_prices pp
          WHERE pp.workspace_id=? AND pp.provider=u.provider
            AND ((pp.requested_model_alias=0 AND pp.model=u.model) OR (pp.requested_model_alias=1 AND u.model IS NULL AND pp.model=u.requested_model))
            AND (pp.source<>'published' OR u.model_source='provider_reported')
            AND COALESCE(pp.connection_id,'')=COALESCE(u.connection_id,'')
            AND pp.effective_from<=u.occurred_at AND (pp.effective_to IS NULL OR pp.effective_to>u.occurred_at)
          ORDER BY pp.effective_from DESC LIMIT 1) WHERE u.task_id IS NOT NULL OR (${lifePredicate})
      )`;
      const queryParams = [...params, ...lifeParams, ...runParams, ...runParams, ...runParams, ...unitParams, input.workspaceId, ...lifeParams];
      const aggregate = (keys: string[]): Array<UsageMetrics & Row> => {
        const keySelect = keys.length ? `${keys.join(",")},` : "";
        const group = keys.length ? `GROUP BY ${keys.join(",")}` : "";
        const totals = this.ctx.db.query(`${cte} SELECT ${keySelect}
          ${["actual_input_tokens", "actual_output_tokens", "actual_cache_read_tokens", "actual_cache_write_tokens", "actual_unsplit_tokens", "actual_total_tokens", "priced_tokens"].map((f) => `COALESCE(SUM(${f}),0) AS ${f}`).join(",")},
          COUNT(DISTINCT task_id) AS task_count,COUNT(DISTINCT CASE WHEN unknown=1 THEN task_id END) AS unknown_task_count,
          MAX(context_tokens) AS context_peak_tokens,MIN(run_complete) AS run_complete,
          CASE WHEN MIN(runtime_provenance)=MAX(runtime_provenance) THEN MIN(runtime_provenance) ELSE 'mixed' END AS runtime_provenance,
          COUNT(DISTINCT CASE WHEN lifecycle_in_window=1 AND status='completed' THEN task_id END) AS completed,
          COUNT(DISTINCT CASE WHEN lifecycle_in_window=1 AND status='failed' THEN task_id END) AS failed,
          COUNT(DISTINCT CASE WHEN lifecycle_in_window=1 AND status='cancelled' THEN task_id END) AS cancelled,
          COUNT(DISTINCT CASE WHEN lifecycle_in_window=1 AND status IN ('dispatched','running','waiting_local_directory','awaiting_human') THEN task_id END) AS active,
          COUNT(DISTINCT CASE WHEN lifecycle_in_window=1 AND status IN ('queued','pending') THEN task_id END) AS queued
          FROM facts ${group}`).all(...queryParams) as Row[];
        const monetary = this.ctx.db.query(`${cte} SELECT ${keySelect}currency,reference_amount,SUM(amount) AS amount,MIN(quality) AS first_quality,MAX(quality) AS last_quality
          FROM facts WHERE currency IS NOT NULL GROUP BY ${[...keys, "currency", "reference_amount"].join(",")}`).all(...queryParams) as Row[];
        const durations = this.ctx.db.query(`${cte} SELECT ${keySelect}SUM(seconds) AS total_seconds FROM (
          SELECT DISTINCT ${keySelect}task_id,CASE WHEN lifecycle_in_window=1 AND status IN ('completed','failed','cancelled') THEN seconds ELSE 0 END AS seconds FROM facts) task_durations ${group}`).all(...queryParams) as Row[];
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
          const numericFields = new Set(["actual_input_tokens", "actual_output_tokens", "actual_cache_read_tokens", "actual_cache_write_tokens", "actual_unsplit_tokens", "actual_total_tokens", "priced_tokens", "task_count", "unknown_task_count", "context_peak_tokens"]);
          const metrics = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, numericFields.has(k) && v !== null ? Number(v) : v])) as Row;
          const status_counts = Object.fromEntries(["completed", "failed", "cancelled", "active", "queued"].map((s) => [s, Number(r[s] ?? 0)]));
          for (const s of ["completed", "failed", "cancelled", "active", "queued", "run_complete"]) delete metrics[s];
          const unpriced_tokens = Number(r.actual_total_tokens) - Number(r.priced_tokens);
          return { ...metrics, total_seconds: durationMap.get(key(r)) ?? 0, known_cost_by_currency: c?.values ?? {}, reference_cost_by_currency: c?.reference ?? {}, sdk_estimate_cost_by_currency: c?.sdk ?? {}, unpriced_tokens,
            status_counts, price_quality: !c || c.qualities.size === 0 ? "unknown" : c.qualities.size > 1 ? "mixed" : [...c.qualities][0],
            complete: Number(r.task_count) === 0 || (Number(r.unknown_task_count) === 0 && unpriced_tokens === 0 && Number(r.run_complete) === 1) } as unknown as UsageMetrics & Row;
        });
      };
      const summary = aggregate([])[0]!;
      const daily = aggregate(["date"]);
      const by_agent = aggregate(["agent_id"]);
      const by_model = aggregate(["provider", "model", "requested_model", "model_provenance", "purpose", "connection_id"]).map(r => ({ ...r, model_source: r.model !== null ? "reported" : r.requested_model !== null ? "requested" : "unknown" }));
      const by_runtime = aggregate(["runtime_id"]);
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
      const prices = this.ctx.db.query("SELECT revision FROM multiremi_usage_price_revisions WHERE workspace_id=?").get(input.workspaceId) as Row | null;
      return { summary, daily, by_agent, by_model, by_runtime, task_daily,
        time_basis: { consumption: "unit_occurred_at", terminal_tasks: "terminal_lifecycle_at", active_tasks: "current_snapshot" },
        coverage: { priced_tokens: summary.priced_tokens, unpriced_tokens: summary.unpriced_tokens,
          token_ratio: summary.actual_total_tokens ? summary.priced_tokens / summary.actual_total_tokens : null, unknown_task_count: summary.unknown_task_count },
        as_of: asOf, pricing_revision: String(prices?.revision ?? 0),
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

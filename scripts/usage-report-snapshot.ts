/** Read-only business snapshot, also runnable against the v0.2.89 modules. */
import { parseArgs } from "node:util";
import { StoreContext, type StoreContextHost } from "../packages/server/src/store/context.js";
import { PostgresSyncDatabase, type SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { openSqliteDatabase } from "../packages/server/src/store/db/sqlite.js";
import { UsageAccountingRepo } from "../packages/server/src/store/repos/usage-accounting-repo.js";
import { UsageRepo } from "../packages/server/src/store/repos/usage-repo.js";
import { RuntimesRepo } from "../packages/server/src/store/repos/runtimes-repo.js";
import { taskUsageProjection } from "../packages/server/src/store/usage-projection.js";

type SnapshotOptions = { until: string; tz?: string };

function dateInTimezone(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function snapshotWindowStart(until: string, days: number, tz: string): string {
  const day = dateInTimezone(new Date(until), tz);
  const date = new Date(Date.parse(`${day}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const midnight = Date.parse(`${date}T00:00:00Z`);
  let low = midnight - 15 * 3600000, high = midnight + 15 * 3600000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (dateInTimezone(new Date(middle), tz) < date) low = middle; else high = middle;
  }
  return new Date(high).toISOString();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function collectUsageReportSnapshot(db: SqlDatabase, options: SnapshotOptions): unknown {
  if (!options.until || !Number.isFinite(Date.parse(options.until))) throw new Error("--until must be an ISO timestamp");
  const until = new Date(options.until).toISOString(), tz = options.tz ?? "Asia/Shanghai";
  dateInTimezone(new Date(until), tz);
  const collect = () => {
    if (db.dialect === "postgres") db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const context = new StoreContext(db, () => runtimes as unknown as StoreContextHost);
    const runtimes = new RuntimesRepo(context);
    const usage = new UsageRepo(context), accounting = new UsageAccountingRepo(context);
    const report = (workspaceId: string, days: number | null, runtimeId?: string) => {
      const result = accounting.report({ workspaceId, runtimeId, days: null, until, tz,
        ...(days === null ? {} : { since: snapshotWindowStart(until, days, tz) }), include: "day_model", detailLimit: 200 });
      // Cursors carry a process-specific signature; compare their pagination meaning.
      const { as_of: _asOf, day_model, ...business } = result;
      return { ...business, ...(day_model ? { day_model: { rows: day_model.rows, has_more: day_model.next_cursor !== null } } : {}) };
    };
    const workspaceIds = db.query("SELECT id FROM multiremi_workspaces ORDER BY id").all().map(row => String(row.id));
    const runtimeRows = db.query("SELECT id,COALESCE(workspace_id,'local') AS workspace_id FROM multiremi_runtimes ORDER BY id").all();
    const reports = workspaceIds.map(workspaceId => ({ workspace_id: workspaceId,
      reports: Object.fromEntries([null, 30, 7].map(days => [days ?? "all", report(workspaceId, days)])) }));
    const runtimeSnapshots = runtimeRows.map(row => {
      const runtime = runtimes.getRuntime(String(row.id))!;
      const { taskCount, activeTaskCount, completedTaskCount, failedTaskCount, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = runtime;
      return { id: row.id, workspace_id: row.workspace_id, usage: usage.listRuntimeUsage(String(row.id)),
        summary: { taskCount, activeTaskCount, completedTaskCount, failedTaskCount, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
        report: report(String(row.workspace_id), null, String(row.id)) };
    });
    const taskIds = db.query("SELECT id FROM multiremi_turn_attempts ORDER BY id LIMIT 50").all().map(row => String(row.id));
    const projected = taskUsageProjection(db, taskIds);
    return canonical({ until, tz, reports, runtime_usage: usage.listRuntimeUsage(), runtimes: runtimeSnapshots,
      tasks: taskIds.map(id => ({ id, usage: projected.get(id) ?? [] })) });
  };
  if (db.dialect === "postgres") return db.transaction(collect)();
  const queryOnly = Number(db.query("PRAGMA query_only").get().query_only);
  db.exec("PRAGMA query_only=ON");
  try {
    const transaction = db.transaction(collect);
    return (transaction.deferred ?? transaction)();
  } finally { db.exec(`PRAGMA query_only=${queryOnly}`); }
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    sqlite: { type: "string" }, "postgres-env": { type: "string" }, until: { type: "string" },
    tz: { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: bun run scripts/usage-report-snapshot.ts (--sqlite PATH | --postgres-env ENV_NAME) --until ISO [--tz Asia/Shanghai] [--out JSON_PATH]");
    process.exit(0);
  }
  if (Boolean(values.sqlite) === Boolean(values["postgres-env"]) || !values.until) throw new Error("Select one explicit database and provide --until; ambient database configuration is never used");
  const url = values["postgres-env"] ? process.env[values["postgres-env"]] : undefined;
  if (values["postgres-env"] && (!url || !/^postgres(?:ql)?:\/\//.test(url))) throw new Error("The selected PostgreSQL environment variable is missing or invalid");
  const db = values.sqlite ? openSqliteDatabase(values.sqlite, { readonly: true }) : new PostgresSyncDatabase(url!);
  try {
    const json = JSON.stringify(collectUsageReportSnapshot(db, { until: values.until, tz: values.tz }), null, 2) + "\n";
    if (values.out) await Bun.write(values.out, json); else process.stdout.write(json);
  } finally { db.close(); }
}

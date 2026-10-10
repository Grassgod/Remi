import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { runCopyStartupWorker, type CopyStartupInput } from "../../scripts/unified-model-copy-startup.js";

// This driver accepts only explicit test fixtures. The production entrypoint
// still validates the fixed isolated copy URL before opening any connection.
const input = JSON.parse(await Bun.stdin.text()) as CopyStartupInput;
const target = JSON.parse(process.env.COPY_SYNTHETIC_TARGET!) as { dialect: string; path: string };
let httpCalls = 0, fetchCalls = 0;
Bun.serve = (() => { httpCalls++; throw new Error("Offline child attempted HTTP listen"); }) as typeof Bun.serve;
globalThis.fetch = (async () => { fetchCalls++; throw new Error("Offline child attempted external fetch"); }) as unknown as typeof fetch;
try {
  if (process.env.MULTIREMI_TOKEN || process.env.MULTIREMI_DATABASE_URL || process.env.FEISHU_APP_SECRET) {
    throw new Error("Offline child inherited ambient credentials/configuration");
  }
  if (target.dialect === "postgres" && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(target.path).hostname)) {
    throw new Error("Synthetic PostgreSQL must be local");
  }
  await runCopyStartupWorker(input, {
    databaseUrl: target.dialect === "postgres" ? target.path : undefined,
    open: () => {
      const db = target.dialect === "postgres" ? new PostgresSyncDatabase(target.path)
        : openSqliteDatabase(target.path) as unknown as SqlDatabase;
      let snapshots = 0;
      return new Proxy(db, { get(original, key) {
        if (key === "query") return (sql: string) => {
          if (sql.includes("SELECT id FROM multiremi_turn_attempts LIMIT 1") && process.env.COPY_SYNTHETIC_FAILURE === "gate") {
            throw new Error("synthetic schema startup failure");
          }
          const usageColumns = sql.includes("table_info(multiremi_usage_units)") ||
            (sql.includes("information_schema.columns") && sql.includes("multiremi_usage_units"));
          if (usageColumns && ++snapshots === 2) {
            if (process.env.COPY_SYNTHETIC_FAILURE === "readback") {
              original.run("UPDATE multiremi_usage_units SET evidence_ref='synthetic content drift'");
            }
            if (process.env.COPY_SYNTHETIC_FAILURE === "state") {
              original.run("UPDATE multiremi_session_lanes SET generation=999 WHERE reader_type='agent'");
              original.run("UPDATE multiremi_issues SET status='done'");
            }
          }
          return original.query(sql);
        };
        const value = Reflect.get(original, key);
        return typeof value === "function" ? value.bind(original) : value;
      } });
    },
    emit: event => process.send!({ ...event, timing: { ...event.timing, http_calls: httpCalls, fetch_calls: fetchCalls } }),
  });
  if (process.env.COPY_SYNTHETIC_FAILURE === "after_ready") throw new Error("synthetic cleanup failure after ready");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally { process.disconnect?.(); }

/** Optional bounded scalar preparation; API startup rechecks source versions before cutover. */
import { PostgresSyncDatabase } from "../packages/server/src/store/db/postgres.js";
import { ensureUsageAccountingSchema, migrateLegacyUsage } from "../packages/server/src/store/usage-accounting.js";

export function migrationBatchSize(value: unknown): number {
  const n = Number(value ?? 500);
  if (!Number.isSafeInteger(n) || n < 1 || n > 5_000) throw new Error("batch-size must be an integer between 1 and 5000");
  return n;
}

export async function mainMigrateUsageAccounting(): Promise<void> {
  const databaseUrl = process.env.MULTIREMI_DATABASE_URL;
  if (!databaseUrl) throw new Error("MULTIREMI_DATABASE_URL is required");
  const batchSize = migrationBatchSize(process.argv.find(arg => arg.startsWith("--batch-size="))?.slice(13));
  const execute = process.argv.includes("--execute");
  if (!execute) {
    const sql = new Bun.SQL(databaseUrl, { max: 1 });
    try {
      const rows = await sql.unsafe("SELECT count(*) AS tasks FROM multiremi_turn_execution_records");
      process.stdout.write(`${JSON.stringify({ mode: "read-only", tasks: Number(rows[0]?.tasks ?? 0), batchSize,
        next: "API startup performs required scalar cutover automatically. Optional preparation: review a backup and rerun with --execute; startup still rechecks source versions. Native/raw recovery uses reconcile-task-usage.ts." })}\n`);
    } finally { await sql.end(); }
    return;
  }
  const db = new PostgresSyncDatabase(databaseUrl);
  try {
    ensureUsageAccountingSchema(db);
    let migrated = 0;
    for (;;) {
      const batch = migrateLegacyUsage(db, { batchSize });
      migrated += batch.migrated;
      process.stdout.write(`${JSON.stringify({ mode: "execute", batch: batch.migrated, migrated, remaining: batch.remaining, complete: batch.complete })}\n`);
      if (batch.complete) break;
      if (!batch.migrated) throw new Error("Migration made no progress");
      // Yield between independently committed batches to avoid one long lock.
      await Bun.sleep(0);
    }
  } finally { db.close(); }
}
if (import.meta.main) await mainMigrateUsageAccounting();

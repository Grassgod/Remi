import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { MultiremiStore } from "@multiremi/store.js";

const [database, issueId, phase] = process.argv.slice(2);
if (!database || !issueId || !["before-insert", "after-insert", "after-commit"].includes(phase ?? "")) process.exit(2);
const db: SqlDatabase = /^postgres(?:ql)?:\/\//.test(database)
  ? new PostgresSyncDatabase(database)
  : openSqliteDatabase(database);
const store = new MultiremiStore(db);
const originalRun = db.run.bind(db);
const originalTransaction = db.transaction.bind(db);
const marker = "MUL486_CRASH_STEER";

function pauseAt(point: string): void {
  process.stdout.write(`${point}\n`);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const until = Date.now() + 60_000;
  while (Date.now() < until) Atomics.wait(sleeper, 0, 0, 20);
  process.exit(97);
}

db.run = (sql, params) => {
  const steerInsert = sql.includes("INSERT INTO multiremi_conversation_log")
    && Array.isArray(params) && params.includes(marker);
  if (steerInsert && phase === "before-insert") pauseAt(phase);
  const result = originalRun(sql, params);
  if (steerInsert && phase === "after-insert") pauseAt(phase);
  return result;
};
try {
  originalTransaction(() => store.sendEnvelopeWithinTransaction({
    to: { role: "relay", issueId }, kind: "report", outcome: "failed", wake: "now",
    dedupeKey: "relay-crash", body: marker, source: { issueId },
  }, [], createCommitEventQueue()))();
  if (phase === "after-commit") pauseAt(phase);
  process.stdout.write("completed\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(3);
} finally {
  db.close();
}

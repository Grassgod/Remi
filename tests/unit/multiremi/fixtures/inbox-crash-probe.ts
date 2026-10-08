import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { triggerInboxFlow, type InboxFlowFixture } from "./inbox-flow-fixture.js";

const [fixturePath, phase] = process.argv.slice(2);
const database = process.env.MULTIREMI_TEST_DATABASE_URL;
if (!database || !fixturePath || !["before-turn", "after-turn", "after-commit", "run"].includes(phase ?? "")) {
  throw new Error("Inbox probe requires a dedicated database, fixture and valid phase");
}
if (/^postgres(?:ql)?:/.test(database)
  && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(database).hostname)) {
  throw new Error("Inbox probes require a local dedicated PostgreSQL server");
}
const fixture = await Bun.file(fixturePath).json() as InboxFlowFixture;
const db: SqlDatabase = /^postgres(?:ql)?:/.test(database)
  ? new PostgresSyncDatabase(database) : openSqliteDatabase(database);
const store = new MultiremiStore(db);
let turnWritten = false;

function stop(): never {
  process.stdout.write(`${phase}\n`);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 50);
  process.exit(97);
}

const originalRun = db.run.bind(db);
db.run = (sql, params) => {
  const normalized = sql.replace(/\s+/g, " ").trim().toUpperCase();
  const turn = fixture.scenario === "human"
    ? normalized.startsWith("UPDATE MULTIREMI_TURNS SET WAKE_SEQ=")
      && normalized.includes("WAKE_SEQ") && Array.isArray(params) && params.includes(store.getTurnForAttempt(fixture.seededTaskId!)!.id)
    : /^INSERT INTO MULTIREMI_TURN_ATTEMPTS[ (]/.test(normalized);
  if (turn && phase === "before-turn") {
    if (!db.inTransaction) throw new Error("Before-turn probe is outside the state transaction");
    stop();
  }
  const result = originalRun(sql, params);
  if (turn) {
    turnWritten = true;
    if (phase === "after-turn") {
      if (!db.inTransaction) throw new Error("After-turn probe is outside the state transaction");
      stop();
    }
  }
  return result;
};
const originalTransaction = db.transaction.bind(db);
db.transaction = <T,>(fn: (...args: any[]) => T) => {
  const run = originalTransaction(fn);
  return (...args: any[]): T => {
    const result = run(...args);
    if (turnWritten && phase === "after-commit" && !db.inTransaction) stop();
    return result;
  };
};

process.stdout.write("ready\n");
await new Response(Bun.stdin.stream()).text();
try {
  triggerInboxFlow(store, fixture);
  process.stdout.write("completed\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Inbox probe failed: ${message.replace(/postgres(?:ql)?:\/\/\S+/g, "<test-postgres>")}`);
  process.exitCode = 3;
} finally {
  db.close();
}

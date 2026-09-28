import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlStatement } from "@multiremi/store/db/postgres.js";

const url = process.env.MUL412_CLAIM_PG_URL;
const workspaceId = process.env.MUL412_CLAIM_WORKSPACE_ID;
const runtimeId = process.env.MUL412_CLAIM_RUNTIME_ID;
const now = process.env.MUL412_CLAIM_NOW;
if (!url || !workspaceId || !runtimeId || !now) {
  throw new Error("missing MUL-412 concurrent claim worker input");
}

const db = new PostgresSyncDatabase(url);

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function stopAtBarrier(): void {
  process.kill(process.pid, "SIGSTOP");
}

try {
  const store = new MultiremiStore(db);
  const backend = db.query("SELECT pg_backend_pid() AS pid").get() as { pid: string | number };
  send({ type: "ready", pid: process.pid, backendPid: Number(backend.pid) });
  stopAtBarrier();

  const originalQuery = db.query.bind(db);
  let dueBarrierReached = false;
  db.query = (sql: string): SqlStatement => {
    const statement = originalQuery(sql);
    const isDueDecisionSelect = !dueBarrierReached
      && sql.includes("SELECT decision.id, decision.issue_id")
      && sql.includes("FROM multiremi_issue_decisions decision")
      && sql.includes("decision.reminder_sent_at IS NULL");
    if (!isDueDecisionSelect) return statement;
    return {
      get: (...params: unknown[]) => statement.get(...params),
      all: (...params: unknown[]) => {
        const rows = statement.all(...params) as Array<{ id: string }>;
        dueBarrierReached = true;
        send({ type: "due_selected", decisionIds: rows.map(row => String(row.id)) });
        stopAtBarrier();
        return rows;
      },
      run: (...params: unknown[]) => statement.run(...params),
      values: (...params: unknown[]) => statement.values(...params),
    };
  };

  const delivery = store.claimFeishuBotOutbound(workspaceId, runtimeId, new Date(now));
  send({
    type: "result",
    delivery: delivery ? { id: delivery.id, kind: delivery.kind } : null,
  });
} catch (error) {
  send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  db.close();
}

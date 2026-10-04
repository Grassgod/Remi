import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { readSync } from "node:fs";

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

function waitAtBarrier(): void {
  const byte = Buffer.allocUnsafe(1);
  while (true) {
    const size = readSync(0, byte, 0, 1, null);
    if (size === 0) throw new Error("claim worker stdin closed at barrier");
    if (byte[0] === 10) return;
  }
}

try {
  const store = new MultiremiStore(db);
  const backend = db.query("SELECT pg_backend_pid() AS pid").get() as { pid: string | number };
  send({ type: "ready", pid: process.pid, backendPid: Number(backend.pid) });
  waitAtBarrier();

  const originalRun = db.run.bind(db);
  let barrierReached = false;
  db.run = (sql, params) => {
    if (!barrierReached && sql === "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?") {
      barrierReached = true;
      // Both contenders must rendezvous before W; the second cannot reach a
      // due SELECT while the first holds that workspace lock.
      const rows = db.query("SELECT id FROM multiremi_message_decision_records WHERE workspace_id=? AND status='escalated' AND reminder_sent_at IS NULL ORDER BY id").all(workspaceId);
      send({ type: "lock_waiting", decisionIds: rows.map(row => String(row.id)) });
      waitAtBarrier();
    }
    return originalRun(sql, params);
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

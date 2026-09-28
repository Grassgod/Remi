import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

const url = process.env.MUL412_CLAIM_PG_URL;
const workspaceId = process.env.MUL412_CLAIM_WORKSPACE_ID;
const runtimeId = process.env.MUL412_CLAIM_RUNTIME_ID;
const now = process.env.MUL412_CLAIM_NOW;
const startAt = Number(process.env.MUL412_CLAIM_START_AT);
if (!url || !workspaceId || !runtimeId || !now || !Number.isFinite(startAt)) {
  throw new Error("missing MUL-412 concurrent claim worker input");
}

const db = new PostgresSyncDatabase(url);
const store = new MultiremiStore(db);
while (Date.now() < startAt) await Bun.sleep(Math.min(10, startAt - Date.now()));
const delivery = store.claimFeishuBotOutbound(workspaceId, runtimeId, new Date(now));
process.stdout.write(`${JSON.stringify(delivery ? { id: delivery.id, kind: delivery.kind } : null)}\n`);
db.close();

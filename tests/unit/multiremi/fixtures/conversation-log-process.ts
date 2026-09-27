import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

const [backend, target, operation, sessionId, countText] = Bun.argv.slice(2);
if (!backend || !target || !operation) throw new Error("Missing conversation log process arguments");
const db = backend === "pg" ? new PostgresSyncDatabase(target) : new Database(target);
if (backend === "sqlite") db.exec("PRAGMA busy_timeout = 30000");
try {
  const store = new MultiremiStore(db);
  if (operation === "append") {
    const count = Number(countText);
    for (let index = 0; index < count; index++) {
      store.appendConversationLog({
        sessionId: sessionId!, kind: "message", authorType: "system", bodyMd: `${process.pid}:${index}`,
      });
    }
  }
} finally {
  db.close();
}

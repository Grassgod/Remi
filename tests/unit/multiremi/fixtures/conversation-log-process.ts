import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

const [backend, target, operation, sessionId, countText] = Bun.argv.slice(2);
if (!backend || !target || !operation) throw new Error("Missing conversation log process arguments");
const db = backend === "pg" ? new PostgresSyncDatabase(target) : openSqliteDatabase(target);
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
  } else if (operation === "first-comment") {
    const session = store.getIssueSession(sessionId!);
    if (!session) throw new Error(`Missing session: ${sessionId}`);
    store.createIssueComment(session.issueId, { issueSessionId: sessionId!, body: `${process.pid}` });
  }
} finally {
  db.close();
}

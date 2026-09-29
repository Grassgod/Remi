import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { ConversationLogEntry, ConversationLogPatch } from "@multiremi/contracts/conversation-log";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const storeDb = (store: MultiremiStore): SqlDatabase => (store as unknown as { db: SqlDatabase }).db;

async function withStore(backend: "sqlite" | "pg", run: (store: MultiremiStore, db: SqlDatabase) => void): Promise<void> {
  if (backend === "sqlite") {
    const db = new Database(":memory:");
    try {
      const store = new MultiremiStore(db);
      run(store, storeDb(store));
    } finally { db.close(); }
    return;
  }
  const name = `mul444_log_commit_${process.pid}_${Math.floor(Math.random() * 1e8)}`;
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  const db = new PostgresSyncDatabase(url.toString());
  try {
    const store = new MultiremiStore(db);
    run(store, storeDb(store));
  } finally {
    db.close();
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}

describe("conversation log notifications after commit", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: rollback discards a notification and a reused seq publishes only its committed row`, async () => {
      await withStore(backend, (store, db) => {
        const sessionId = "ises_commit_rollback";
        const received: Array<ConversationLogEntry | ConversationLogPatch> = [];
        store.setConversationLogListener({ onEntry: (_sessionId, payload) => received.push(payload) });
        let rolledSeq = -1;
        expect(() => db.transaction(() => {
          rolledSeq = store.appendConversationLogWithinTransaction({ sessionId, kind: "message", authorType: "system", bodyMd: "rolled back" }).seq;
          expect(received).toHaveLength(0);
          throw new Error("rollback");
        })()).toThrow("rollback");
        expect(received).toHaveLength(0);
        const committed = store.appendConversationLog({ sessionId, kind: "message", authorType: "system", bodyMd: "committed" });
        expect(committed.seq).toBe(rolledSeq);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ seq: committed.seq, body_md: "committed" });
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: two appends and a patch publish in write order after commit`, async () => {
      await withStore(backend, (store, db) => {
        const sessionId = "ises_commit_order";
        const received: Array<ConversationLogEntry | ConversationLogPatch> = [];
        store.setConversationLogListener({ onEntry: (_sessionId, payload) => received.push(payload) });
        let firstSeq = -1;
        let secondSeq = -1;
        db.transaction(() => {
          firstSeq = store.appendConversationLogWithinTransaction({ sessionId, kind: "message", authorType: "system", bodyMd: "first" }).seq;
          secondSeq = store.appendConversationLogWithinTransaction({ sessionId, kind: "message", authorType: "system", bodyMd: "second" }).seq;
          store.updateConversationLogWithinTransaction(sessionId, firstSeq, { fields: { body_md: "edited" } });
          expect(received).toHaveLength(0);
        })();
        expect(received).toHaveLength(3);
        expect(received[0]).toMatchObject({ seq: firstSeq, body_md: "first" });
        expect(received[1]).toMatchObject({ seq: secondSeq, body_md: "second" });
        expect(received[2]).toMatchObject({ target_seq: firstSeq, fields: { body_md: "edited" } });
      });
    }, 30_000);
  }
});

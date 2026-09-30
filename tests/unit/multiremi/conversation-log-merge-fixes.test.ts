import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

async function withStore(backend: "sqlite" | "pg", run: (store: MultiremiStore, db: SqlDatabase) => void): Promise<void> {
  if (backend === "sqlite") {
    const db = new Database(":memory:");
    try { run(new MultiremiStore(db), db); } finally { db.close(); }
    return;
  }
  const name = `mul427_fixes_${process.pid}_${Math.floor(Math.random() * 1e8)}`;
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  const db = new PostgresSyncDatabase(url.toString());
  try { run(new MultiremiStore(db), db); } finally {
    db.close();
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}

describe("MUL-427 merge rulings", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: all three main-produced kinds preserve the dense seq axis and marker targets`, async () => {
      await withStore(backend, (store) => {
        const issue = store.createIssue({ title: "Ruling ③", workspaceId: "local" });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const first = store.createIssueComment(issue.id, { body: "First target" });
        const second = store.createIssueComment(issue.id, { body: "Second target" });
        store.resolveIssueComment(second.id, { actorType: "agent", actorId: "agt_resolver" });
        expect(store.getConversationLogEntryById(second.id)).toMatchObject({
          revision: 2, resolved_by_type: "agent", resolved_by_id: "agt_resolver",
        });
        store.unresolveIssueComment(second.id);
        expect(store.getConversationLogEntryById(second.id)).toMatchObject({
          revision: 3, resolved_at: null, resolved_by_type: null, resolved_by_id: null,
        });
        store.resolveIssueComment(first.id);
        const frozen = store.appendSessionEvent(session.id, {
          authorType: "system", kind: "follow_frozen", body: "Follow cost limit reached.",
          metadata: { follow_frozen_seq: 19 },
        });
        const events = store.listSessionEvents(session.id);
        const log = [store.getConversationLogEntry(session.id, 0)!, ...store.listConversationLogEntries(session.id)];
        expect(log).toHaveLength(events.length + 1);
        expect(log.map((entry) => entry.seq)).toEqual(Array.from({ length: log.length }, (_, i) => i));
        expect(log.map((entry) => entry.kind)).toEqual([
          "head", "message", "message", "thread_resolved", "thread_unresolved", "thread_resolved", "follow_frozen",
        ]);
        for (const event of events.filter((event) => event.kind.startsWith("thread_"))) {
          const entry = store.getConversationLogEntry(session.id, event.seq)!;
          expect(entry).toMatchObject({
            id: event.id, seq: event.seq, kind: event.kind, visibility: "hidden",
            author_type: event.authorType, author_id: event.authorId, body_md: event.body,
          });
          const commentId = event.metadata.comment_id as string;
          expect(entry.metadata.target_seq).toBe(store.getConversationLogEntryById(commentId)!.seq);
        }
        expect(store.getConversationLogEntry(session.id, frozen.seq)).toMatchObject({
          id: frozen.id, seq: frozen.seq, kind: "follow_frozen", visibility: "shown",
          author_type: "system", body_md: frozen.body, metadata: frozen.metadata,
        });
        expect(store.getConversationLogHead(session.id)?.headSeq).toBe(events.length);
      });
    }, 30_000);
  }
});

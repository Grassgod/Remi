import { describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { signIssueShareId } from "@multiremi/api/helpers/issue-share-tokens.js";
import type { MultiremiSessionEvent } from "@multiremi/contracts/types.js";
import { CONVERSATION_LOG_BACKFILL_MIGRATION } from "@multiremi/store/conversation-log-backfill.js";
import { MultiremiStore } from "@multiremi/store.js";
import { prepareConversationBackfillFixture } from "./fixtures/conversation-log-backfill.js";
import { conversationLogPgAdminUrl, withConversationLogStore } from "./fixtures/conversation-log-store.js";

describe("MUL-427 ruling (u): shared bundle event parity", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: backfilled share retains every visible event and only approved wire differences`, async () => {
      await withConversationLogStore(backend, async (store, db) => {
        const { session } = prepareConversationBackfillFixture(store, db);
        db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [CONVERSATION_LOG_BACKFILL_MIGRATION]);
        // Both versions repair default sessions and missing mirrors before serving bundles (i).
        const migrated = new MultiremiStore(db);
        const secret = "mul427-synthetic-share";
        const share = migrated.ensureIssueShare(session.issueId, "local", "local");
        const token = signIssueShareId(share.id, secret);
        const app = createMultiremiApp({ store: migrated, authToken: "mul427-synthetic-root", shareSecret: secret });
        const bundle = async () => {
          const response = await app.request(`/api/shares/${token}`, { headers: { "X-Remi-Share": token } });
          expect(response.status).toBe(200);
          return await response.json() as { sessions: Array<{ id: string; events: Record<string, any>[] }> };
        };
        const newBundle = await bundle();
        const newReader = migrated.listSessionEvents.bind(migrated);
        migrated.listSessionEvents = (sessionId) => db.query("SELECT * FROM multiremi_session_events WHERE session_id = ? AND seq > 0 ORDER BY seq")
          .all(sessionId).map((row: any): MultiremiSessionEvent => ({
            id: row.id, sessionId: row.session_id, seq: Number(row.seq), authorType: row.author_type,
            authorId: row.author_id, kind: row.kind, body: row.body, taskId: row.task_id,
            sourceCommentId: row.source_comment_id, metadata: JSON.parse(row.metadata), createdAt: row.created_at,
          }));
        let oldBundle: Awaited<ReturnType<typeof bundle>>;
        try { oldBundle = await bundle(); } finally { migrated.listSessionEvents = newReader; }
        expect(newBundle.sessions.map((entry) => entry.id)).toEqual(oldBundle.sessions.map((entry) => entry.id));
        for (let index = 0; index < oldBundle.sessions.length; index++) {
          const oldEvents = oldBundle.sessions[index]!.events;
          const newEvents = newBundle.sessions[index]!.events;
          expect(newEvents).toHaveLength(oldEvents.length);
          for (let eventIndex = 0; eventIndex < oldEvents.length; eventIndex++) {
            const oldEvent = oldEvents[eventIndex]!;
            const newEvent = newEvents[eventIndex]!;
            expect(newEvent.kind).toBe(oldEvent.kind === "task_assigned" ? "turn" : oldEvent.kind);
            expect(newEvent.id).toBe(oldEvent.source_comment_id ?? oldEvent.id);
            expect(newEvent.task_id).toBe(oldEvent.task_id);
            const metadata = { ...newEvent.metadata };
            if (metadata.target_seq !== undefined) {
              expect(["message_edited", "message_deleted", "thread_resolved", "thread_unresolved", "task_completed", "task_failed", "task_cancelled", "task_steer"])
                .toContain(newEvent.kind);
              expect(typeof metadata.target_seq).toBe("number");
              delete metadata.target_seq;
            }
            const normalized: Record<string, any> = { ...newEvent, id: oldEvent.id, kind: oldEvent.kind, metadata };
            expect(normalized).toEqual(oldEvent);
          }
          const visible = (events: Record<string, any>[]) => events.map(({ author_type, author_id, created_at, body }) =>
            ({ author_type, author_id, created_at, body }));
          expect(visible(newEvents)).toEqual(visible(oldEvents));
        }
        const events = newBundle.sessions.find((entry) => entry.id === session.id)!.events;
        expect(events).toHaveLength(18);
        expect(events.some((entry) => entry.source_comment_id === "cmt_orphan_valid")).toBe(true);
      });
    }, 30_000);
  }
});

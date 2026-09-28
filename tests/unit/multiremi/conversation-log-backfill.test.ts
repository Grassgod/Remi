import { describe, expect, it } from "bun:test";
import { backfillConversationLogWithinTransaction, CONVERSATION_LOG_BACKFILL_MIGRATION, ConversationBackfillMismatch,
  canonicalConversationJson, reconcileConversationLog } from "@multiremi/store/conversation-log-backfill.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { MultiremiStore } from "@multiremi/store.js";
import { conversationLogProjectionEvents } from "@multiremi/store/conversation-log-projection.js";
import { sessionEventCompatibilityResponse } from "@multiremi/api/wire/issues.js";
import { conversationLogPgAdminUrl as pgAdminUrl, withConversationLogStore as withStore } from "./fixtures/conversation-log-store.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";
import { prepareConversationBackfillFixture } from "./fixtures/conversation-log-backfill.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("MUL-427 B7: conversation backfill and reconciliation", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: old database first v2 startup repairs NULL Issue sessions and preserves Chat-owned topic transport`, async () => {
      await withStore(backend, (store, db) => {
        const agent = store.createAgent({ name: "Legacy startup worker", provider: "codex", workspaceId: "local" });
        const issue = store.createIssue({ title: "Legacy NULL sessions", workspaceId: "local" });
        const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: "local" });
        bindFeishuTopicFixture(store, db, chat.id, issue.id);
        const topic = store.sendChatMessage(chat.id, { content: "Historical topic message" });
        const at = "2026-08-01T00:00:00.000Z";
        db.run(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, issue_id, status, prompt, created_at, updated_at)
          VALUES ('tsk_old_issue', 'local', ?, ?, 'queued', 'Legacy task', ?, ?)`, [agent.id, issue.id, at, at]);
        db.run(`INSERT INTO multiremi_issue_comments (id, issue_id, author_type, author_id, task_id, body, type, created_at, updated_at)
          VALUES ('cmt_old_null', ?, 'agent', ?, 'tsk_old_issue', 'Legacy NULL comment', 'comment', ?, ?)`, [issue.id, agent.id, at, at]);
        db.exec("DELETE FROM multiremi_conversation_log; DELETE FROM multiremi_conversation_heads");
        db.run("DELETE FROM multiremi_issue_sessions WHERE issue_id = ?", [issue.id]);
        db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [CONVERSATION_LOG_BACKFILL_MIGRATION]);
        expect(db.query("SELECT issue_session_id FROM multiremi_issue_comments WHERE id = 'cmt_old_null'").get().issue_session_id).toBeNull();
        expect(db.query("SELECT issue_session_id FROM multiremi_tasks WHERE id = 'tsk_old_issue'").get().issue_session_id).toBeNull();
        const migrated = new MultiremiStore(db);
        const session = migrated.listIssueSessions(issue.id)[0]!;
        expect(migrated.getIssueComment("cmt_old_null")?.issueSessionId).toBe(session.id);
        expect(migrated.getTask("tsk_old_issue")?.issueSessionId).toBe(session.id);
        expect(migrated.getConversationLogEntryById("cmt_old_null")).toMatchObject({ session_id: session.id, task_id: "tsk_old_issue" });
        expect(migrated.listSessionEvents(session.id)).toEqual([expect.objectContaining({ sourceCommentId: "cmt_old_null", body: "Legacy NULL comment" })]);
        expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id = ?").get(CONVERSATION_LOG_BACKFILL_MIGRATION)).not.toBeNull();
        const assertTopicOwnership = () => {
          expect(migrated.getTask(topic.task.id)).toMatchObject({ issueId: issue.id, chatSessionId: chat.id, issueSessionId: null });
          expect(migrated.listConversationLogEntries(session.id).filter((row) => row.task_id === topic.task.id)).toEqual([]);
          expect(Number(db.query("SELECT COUNT(*) AS count FROM multiremi_session_events WHERE task_id = ?").get(topic.task.id).count)).toBe(0);
          expect(migrated.getConversationLogEntryById(topic.message.id)).toMatchObject({ session_id: chat.id, task_id: topic.task.id });
          expect(reconcileConversationLog(db)).toMatchObject({ mismatches: [], counts: { chatOwnedTopicTasks: 1,
            chatOwnedTopicIssueLogRows: 0, chatOwnedTopicChatLogRows: 1 } });
        };
        assertTopicOwnership();
        const rows = db.query("SELECT * FROM multiremi_conversation_log ORDER BY session_id, seq").all();
        new MultiremiStore(db);
        assertTopicOwnership();
        expect(db.query("SELECT * FROM multiremi_conversation_log ORDER BY session_id, seq").all()).toEqual(rows);
        expect(migrated.listSessionEvents(session.id)).toHaveLength(1);
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: complete fixture, pre-③ gaps and B1 NULL task links reconcile without mismatches`, async () => {
      await withStore(backend, (store, db) => {
        const { edited, deleted, root, child, chat, session, topic, preserved, preservedSystem } = prepareConversationBackfillFixture(store, db);
        const result = db.transaction(() => backfillConversationLogWithinTransaction(db))();
        expect(result.mismatches).toEqual([]);
        expect(result.counts.commentTaskIdsFilled).toBe(2);
        expect(result.counts.existingRowsSkipped).toBe(2);
        expect(result.counts.orphanCommentsAppended).toBe(1);
        expect(result.counts.orphanCommentsSkipped).toBe(1);
        expect(result.counts.deletedComments).toBe(1);
        expect(result.counts.editedComments).toBe(1);
        expect(result.counts.chatConflictSessions).toBe(1);
        expect(result.counts.tasksWithoutAssistant).toBe(2);
        expect(result.counts).toMatchObject({ chatOwnedTopicTasks: 1, chatOwnedTopicIssueLogRows: 0, chatOwnedTopicChatLogRows: 1 });
        expect(store.getTask(topic.task.id)?.issueSessionId).toBeNull();
        expect(result.counts.maxReadResultBytes + 1024).toBeLessThan(64 * 1024 * 1024);
        for (const before of [preserved, preservedSystem]) {
          const after = store.getConversationLogEntryById(before.id)!;
          expect(after.task_id).toBe(before.task_id);
          expect(after.revision).toBe(before.revision);
          expect(after.updated_at).toBe(before.updated_at);
        }
        const editedRow = store.getConversationLogEntryById(edited.id)!;
        expect(editedRow.body_md).toBe("Current wording");
        expect(editedRow.revision).toBe(3);
        expect(store.getConversationLogEntryById(deleted.id)).toMatchObject({ body_md: "", task_id: null,
          metadata: { deleted_body: "Deleted original" } });
        expect(store.getConversationLogEntryById(deleted.id)?.deleted_at).not.toBeNull();
        expect(store.getConversationLogEntryById(child.id)).toMatchObject({ parent_id: root.id });
        expect(store.getConversationLogEntryById(root.id)?.resolved_by_type).toBe("member");
        expect(store.getConversationLogHead(session.id)?.headSeq).toBe(99);
        const all = (store as unknown as { conversationLog: { listAll(id: string): ReturnType<typeof store.listConversationLogEntries> } }).conversationLog.listAll(session.id);
        expect(all.some((row) => row.kind === "session_created")).toBe(false);
        expect(all.find((row) => row.kind === "follow_frozen")?.metadata.follow_frozen_seq).toBe(3);
        for (const row of all.filter((row) => row.kind.startsWith("thread_"))) {
          expect(row.metadata.target_seq).toBe(store.getConversationLogEntryById(String(row.metadata.comment_id))!.seq);
        }
        expect(store.getConversationLogEntryById("msg_history_assistant")).toMatchObject({ kind: "turn",
          metadata: { final_reply_md: "assistant original", elapsed_ms: 12, failure_reason: null, status: "completed" } });
        expect(store.getConversationLogEntryById("msg_history_system")?.metadata).toMatchObject({ pending_agent_delivery: true, agent_delivery_task_id: "tsk_pending" });
        expect(db.query("SELECT message_sequence FROM multiremi_chat_sessions WHERE id = ?").get(chat.id).message_sequence).toBe(3);
        const reconciliation = reconcileConversationLog(db);
        expect(reconciliation.mismatches).toEqual([]);
        expect(reconciliation.sessions.every((summary) => summary.sourceDigest === summary.logDigest)).toBe(true);
        expect(reconciliation.sessions.find((summary) => summary.sessionId === session.id)!.actualCount)
          .toBe(Number(db.query("SELECT COUNT(*) AS count FROM multiremi_session_events WHERE session_id = ?").get(session.id).count) + 2);
        expect(reconciliation.sessions.find((summary) => summary.sessionId === chat.id)!.actualCount).toBe(4);
        expect(db.transaction(() => backfillConversationLogWithinTransaction(db))().counts.insertedRows).toBe(0);
        const orphanSeq = store.getConversationLogEntryById("cmt_orphan_valid")!.seq;
        store.createIssueComment(session.issueId, { body: "New write after orphan allocation" });
        expect(reconcileConversationLog(db).mismatches).toEqual([]);
        expect(store.getConversationLogEntryById("cmt_orphan_valid")!.seq).toBe(orphanSeq);
        expect(canonicalConversationJson(JSON.parse('{"z":2,"a":{"z":3,"a":1}}'))).toBe('{"a":{"a":1,"z":3},"z":2}');
      });
    }, 45_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: reconciliation CLI is read-only and emits JSON, Markdown and a self-contained preview`, async () => {
      await withStore(backend, async (store, db, target) => {
        prepareConversationBackfillFixture(store, db);
        db.transaction(() => backfillConversationLogWithinTransaction(db))();
        const dir = mkdtempSync(join(tmpdir(), "mul427-reconcile-"));
        try {
          const snapshot = () => ["multiremi_conversation_log", "multiremi_conversation_heads", "multiremi_schema_migrations",
            "multiremi_session_events", "multiremi_issue_comments", "multiremi_chat_messages"]
            .map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
          const before = snapshot();
          const sqlitePath = join(dir, "fixture.sqlite");
          if (backend === "sqlite") await Bun.write(sqlitePath, (db as import("bun:sqlite").Database).serialize());
          const out = join(dir, "report");
          const childProcess = Bun.spawn({ cmd: [Bun.which("bun")!, "run", "scripts/reconcile-conversation-log.ts",
            ...(backend === "sqlite" ? ["--sqlite", sqlitePath] : ["--postgres-env", "MUL427_CLI_TEST_DATABASE_URL"]), "--out", out],
            env: { ...process.env, MUL427_CLI_TEST_DATABASE_URL: backend === "pg" ? target : "" }, stdout: "pipe", stderr: "pipe" });
          const stdout = await new Response(childProcess.stdout).text();
          const stderr = await new Response(childProcess.stderr).text();
          expect(await childProcess.exited, stderr).toBe(0);
          expect(JSON.parse(stdout).mismatch).toBe(0);
          expect((await Bun.file(`${out}.json`).json()).runs[0].reconciliation.mismatches).toEqual([]);
          expect(await Bun.file(`${out}.md`).text()).toContain("Mismatch: **0**");
          const html = await Bun.file(`${out}.html`).text();
          expect(html).toContain("<!doctype html>");
          expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
          expect(snapshot()).toEqual(before);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: task conflicts and last-edit divergence are classified and roll back without repair`, async () => {
      await withStore(backend, (store, db) => {
        const issue = store.createIssue({ title: "Rejected mismatch", workspaceId: "local" });
        const comment = store.createIssueComment(issue.id, { body: "Original", taskId: "tsk_expected" });
        db.run("UPDATE multiremi_conversation_log SET task_id = 'tsk_conflict' WHERE id = ?", [comment.id]);
        expect(() => db.transaction(() => backfillConversationLogWithinTransaction(db))()).toThrow(ConversationBackfillMismatch);
        expect(store.getConversationLogEntryById(comment.id)?.task_id).toBe("tsk_conflict");
        db.run("UPDATE multiremi_conversation_log SET task_id = NULL WHERE id = ?", [comment.id]);
        store.updateIssueComment(comment.id, { body: "Edited" });
        db.run("UPDATE multiremi_issue_comments SET body = 'Diverged' WHERE id = ?", [comment.id]);
        try { db.transaction(() => backfillConversationLogWithinTransaction(db))(); throw new Error("expected mismatch"); }
        catch (error) {
          expect(error).toBeInstanceOf(ConversationBackfillMismatch);
          expect((error as ConversationBackfillMismatch).report.mismatches.map((entry) => entry.reason))
            .toContain(`last_edit_body_differs:${comment.id}`);
        }
        expect(store.getConversationLogEntryById(comment.id)?.task_id).toBeNull();
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: startup ledger is atomic on a late SQL failure and the next startup retries exactly once`, async () => {
      await withStore(backend, (store, db) => {
        const issue = store.createIssue({ title: "Startup rollback", workspaceId: "local" });
        const comment = store.createIssueComment(issue.id, { body: "Historical input", taskId: "tsk_startup" });
        db.run("DELETE FROM multiremi_conversation_log WHERE session_id = ?", [comment.issueSessionId]);
        db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [CONVERSATION_LOG_BACKFILL_MIGRATION]);
        const beforeHead = db.query("SELECT * FROM multiremi_conversation_heads WHERE session_id = ?").get(comment.issueSessionId);
        if (backend === "pg") {
          db.run("CREATE FUNCTION reject_backfill_row() RETURNS trigger AS $$ BEGIN IF NEW.kind <> 'head' THEN RAISE EXCEPTION 'backfill late rejected'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql");
          db.run("CREATE TRIGGER reject_backfill_row BEFORE INSERT ON multiremi_conversation_log FOR EACH ROW EXECUTE FUNCTION reject_backfill_row()");
        } else db.exec("CREATE TRIGGER reject_backfill_row BEFORE INSERT ON multiremi_conversation_log WHEN NEW.kind <> 'head' BEGIN SELECT RAISE(ABORT, 'backfill late rejected'); END");
        expect(() => runMigrations(db)).toThrow("backfill late rejected");
        expect(Number(db.query("SELECT COUNT(*) AS count FROM multiremi_conversation_log WHERE session_id = ?").get(comment.issueSessionId).count)).toBe(0);
        expect(db.query("SELECT * FROM multiremi_conversation_heads WHERE session_id = ?").get(comment.issueSessionId)).toEqual(beforeHead);
        expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id = ?").get(CONVERSATION_LOG_BACKFILL_MIGRATION)).toBeNull();
        db.exec(backend === "pg" ? "DROP TRIGGER reject_backfill_row ON multiremi_conversation_log" : "DROP TRIGGER reject_backfill_row");
        runMigrations(db);
        expect(store.getConversationLogEntryById(comment.id)?.task_id).toBe("tsk_startup");
        expect(reconcileConversationLog(db).mismatches).toEqual([]);
        const rows = db.query("SELECT * FROM multiremi_conversation_log ORDER BY session_id, seq").all();
        db.run("UPDATE multiremi_issue_comments SET body = 'No rerun' WHERE id = ?", [comment.id]);
        runMigrations(db);
        expect(db.query("SELECT * FROM multiremi_conversation_log ORDER BY session_id, seq").all()).toEqual(rows);
      });
    }, 45_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: old startup metadata and /events since/to bounds retain comments and hidden markers`, async () => {
      await withStore(backend, (store, db) => {
        const issue = store.createIssue({ title: "Wire boundaries", workspaceId: "local" });
        const comment = store.createIssueComment(issue.id, { body: "Original wire", taskId: "tsk_wire" });
        store.resolveIssueComment(comment.id);
        store.unresolveIssueComment(comment.id);
        db.run("UPDATE multiremi_session_events SET metadata = '{}' WHERE source_comment_id = ?", [comment.id]);
        db.run("DELETE FROM multiremi_conversation_log WHERE session_id = ?", [comment.issueSessionId]);
        db.transaction(() => backfillConversationLogWithinTransaction(db))();
        const newComment = store.createIssueComment(issue.id, { body: "New wire", taskId: "tsk_new_wire" });
        const all = store.listSessionEvents(comment.issueSessionId!);
        expect(all.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
        expect(all.map((event) => event.kind)).toEqual(["message", "thread_resolved", "thread_unresolved", "message"]);
        expect(all[0]!.metadata).toEqual({});
        expect(all[0]!.taskId).toBeNull();
        expect(all[3]!.sourceCommentId).toBe(newComment.id);
        expect(sessionEventCompatibilityResponse(all[3]!).task_id).toBeNull();
        expect(store.listSessionEvents(comment.issueSessionId!, { sinceSeq: 1, toSeq: 3 }).map((event) => event.seq)).toEqual([2, 3]);
        expect(store.listSessionEvents(comment.issueSessionId!, { sinceSeq: 3, toSeq: 3 })).toEqual([]);
        expect(store.listSessionEvents(comment.issueSessionId!, { sinceSeq: -1, toSeq: 1 }).map((event) => event.seq)).toEqual([1]);
        expect(conversationLogProjectionEvents([store.getConversationLogEntry(comment.issueSessionId!, 0)!])).toEqual([]);
      });
    }, 30_000);
  }

  it.skipIf(!pgAdminUrl)("pg: oversized Unicode bodies and escaped metadata backfill through the real worker shared buffer", async () => {
    await withStore("pg", (store, db, target) => {
      const issue = store.createIssue({ title: "Bounded bridge chunks", workspaceId: "local" });
      const session = store.getOrCreateDefaultIssueSession(issue.id);
      const body = "\u6f22\ud83d\ude00\u0001".repeat(128 * 1024);
      const comment = store.createIssueComment(issue.id, { body });
      const result = store.appendSessionEvent(session.id, { kind: "result_published", authorType: "system", body,
        metadata: { escaped: body, nul: "\u0000", nested: { z: 2, a: 1 } } });
      db.run("DELETE FROM multiremi_conversation_log WHERE session_id = ?", [session.id]);
      const bridgeBytes = 1024 * 1024;
      const small = new PostgresSyncDatabase(target, bridgeBytes);
      try {
        expect(() => small.query("SELECT body, metadata FROM multiremi_session_events WHERE id = ?").get(result.id))
          .toThrow("postgres bridge result too large");
        const migration = small.transaction(() => backfillConversationLogWithinTransaction(small))();
        expect(migration.mismatches).toEqual([]);
        expect(migration.counts.maxReadResultBytes + 1024).toBeLessThan(bridgeBytes);
        const report = reconcileConversationLog(small);
        expect(report.mismatches).toEqual([]);
        expect(report.counts.maxReadResultBytes + 1024).toBeLessThan(bridgeBytes);
        expect(report.sessions.every((row) => row.sourceDigest === row.logDigest)).toBe(true);
        expect(store.getConversationLogEntryById(comment.id)?.body_md).toBe(body);
        expect(store.getConversationLogEntryById(result.id)?.metadata).toEqual({ escaped: body, nul: "\u0000", nested: { z: 2, a: 1 } });
      } finally { small.close(); }
    });
  }, 45_000);
});

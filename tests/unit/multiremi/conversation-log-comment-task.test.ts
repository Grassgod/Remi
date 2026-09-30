import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";
import { sessionEventCompatibilityResponse } from "@multiremi/api/wire/issues.js";
import type { ConversationLogPatch } from "@multiremi/contracts/conversation-log";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import type { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

async function withStore(backend: "sqlite" | "pg", run: (store: MultiremiStore, db: SqlDatabase) => void): Promise<void> {
  if (backend === "sqlite") {
    const db = openSqliteDatabase(":memory:");
    try { run(new MultiremiStore(db), db); } finally { db.close(); }
    return;
  }
  const name = `mul427_comment_${process.pid}_${Math.floor(Math.random() * 1e8)}`;
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

describe("MUL-427 ruling (e): comment task associations", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: every comment mirror uses the comment task while legacy events stay NULL`, async () => {
      await withStore(backend, (store, db) => {
        const agent = store.createAgent({ name: "Comment author", provider: "codex", workspaceId: "local" });
        const issue = store.createIssue({ title: "Comment tasks", workspaceId: "local" });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Reply" });
        const member = store.createIssueComment(issue.id, { body: "Member comment", taskId: task.id });
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const issues = (store as unknown as { issues: IssuesRepo }).issues;
        const deferredEvents = createCommitEventQueue();
        const comment = db.transaction(() => issues.createIssueComment(issue.id, { body: "Agent comment", taskId: task.id,
          authorType: "agent", authorId: agent.id }, { withinTransaction: true, deferredEvents }))();
        ctx.emitCommitEvents(deferredEvents);
        const system = store.createTaskFailureSystemComment(issue.id, session.id, task.id, "System comment");
        for (const source of [member, comment, system]) {
          const event = store.listSessionEvents(session.id).find((event) => event.sourceCommentId === source.id)!;
          expect(event.taskId).toBeNull();
          expect(store.getConversationLogEntryById(source.id)?.task_id).toBe(task.id);
          const carryingTask = { ...event, taskId: task.id };
          expect(sessionEventCompatibilityResponse(carryingTask).task_id).toBeNull();
          const projection = buildSessionProjection({ sessionId: session.id, targetAgentId: agent.id,
            events: [carryingTask], cursorSeq: 0, providerSessionId: null, tokenBudget: 4096 });
          const line = JSON.parse(projection.jsonl.split("\n")[1]!);
          expect(line.source_comment_id).toBe(source.id);
          expect(line.task_id).toBeNull();
        }
        const matches = db.query(`SELECT COUNT(*) AS n FROM multiremi_conversation_log
          WHERE session_id = ? AND author_type = 'agent' AND author_id = ? AND task_id = ? AND kind = 'message'`)
          .get(session.id, agent.id, task.id) as { n: number };
        expect(Number(matches.n)).toBe(1);
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: deleting a comment clears the tombstone task and publishes the NULL patch`, async () => {
      await withStore(backend, (store) => {
        const issue = store.createIssue({ title: "Deleted task association", workspaceId: "local" });
        const comment = store.createIssueComment(issue.id, { body: "Task-linked comment", taskId: "tsk_deleted" });
        const before = store.getConversationLogEntryById(comment.id)!;
        expect(before.task_id).toBe("tsk_deleted");
        const patches: ConversationLogPatch[] = [];
        store.setConversationLogListener({ onEntry: (_sessionId, entry) => {
          if ("target_seq" in entry) patches.push(entry);
        } });
        store.deleteIssueComment(comment.id);
        const tombstone = store.getConversationLogEntryById(comment.id)!;
        expect(tombstone.task_id).toBeNull();
        expect(tombstone.deleted_at).not.toBeNull();
        expect(tombstone.body_md).toBe("");
        expect(tombstone.metadata.deleted_body).toBe("Task-linked comment");
        expect(tombstone.revision).toBe(before.revision + 1);
        expect(patches.find((patch) => patch.target_seq === before.seq)?.fields.task_id).toBeNull();
      });
    }, 30_000);
  }
});

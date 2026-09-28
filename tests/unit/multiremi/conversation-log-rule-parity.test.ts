import { describe, expect, it } from "bun:test";
import type { MultiremiSessionEvent } from "@multiremi/contracts/types.js";
import type { StoreContext } from "@multiremi/store/context.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { conversationLogPgAdminUrl as pgAdminUrl, withConversationLogStore as withStore } from "./fixtures/conversation-log-store.js";

export function legacyProjectionEvents(db: SqlDatabase, sessionId: string): MultiremiSessionEvent[] {
  return db.query("SELECT * FROM multiremi_session_events WHERE session_id = ? ORDER BY seq ASC").all(sessionId).map((row) => ({
    id: String(row.id), sessionId, seq: Number(row.seq), kind: String(row.kind),
    authorType: String(row.author_type), authorId: row.author_id as string | null,
    taskId: row.task_id as string | null, sourceCommentId: row.source_comment_id as string | null,
    body: String(row.body), metadata: JSON.parse(String(row.metadata)), createdAt: String(row.created_at),
  }));
}

describe("MUL-427: unchanged rules with legacy and log readers", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: the same mention and delegation inputs produce identical tasks and projections`, async () => {
      await withStore(backend, (store, db) => {
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const sessions = (store as unknown as { sessions: { projectionEvents(id: string): MultiremiSessionEvent[] } }).sessions;
        const runtime = store.registerRuntime({ id: "rt_rule_parity", name: "Parity runtime", provider: "codex", workspaceId: "local", maxConcurrency: 4,
          metadata: { parallel_agent_execution: 1, cli_version: "0.2.77" } });
        const leader = store.createAgent({ name: "Parity leader", provider: "codex", workspaceId: "local" });
        const worker = store.createAgent({ name: "Parity worker", provider: "codex", workspaceId: "local" });
        const squad = store.createSquad({ name: "Parity squad", leaderId: leader.id, memberIds: [worker.id], workspaceId: "local" });
        const issue = store.createIssue({ title: "Same rule inputs", workspaceId: "local", assigneeType: "squad", assigneeId: squad.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const parent = store.createSessionTask(session.id, { agentId: leader.id, prompt: "Coordinate the work" });
        expect(store.claimTask(runtime.id)?.id).toBe(parent.id);
        store.startTask(parent.id);
        const snapshots: unknown[] = [];
        for (const source of ["legacy", "log"] as const) {
          const query = db.query.bind(db);
          const getComment = ctx.getLogIssueComment.bind(ctx);
          const project = sessions.projectionEvents.bind(sessions);
          if (source === "legacy") {
            ctx.getLogIssueComment = (id) => ctx.getRawIssueComment(id);
            sessions.projectionEvents = (id) => legacyProjectionEvents(db, id);
            db.query = ((sql: string) => query(sql
              .replaceAll("FROM multiremi_conversation_log event", "FROM multiremi_session_events event")
              .replaceAll("FROM multiremi_conversation_log terminal_event", "FROM multiremi_session_events terminal_event"))) as typeof db.query;
          }
          const rollback = new Error("parity fixture rollback");
          try {
            db.transaction(() => {
              store.createIssueComment(issue.id, { authorType: "agent", authorId: leader.id,
                taskId: parent.id, body: `[@Worker](mention://agent/${worker.id}) Check the same input` });
              const child = store.listTasksForIssue(issue.id).find((task) => task.agentId === worker.id)!;
              expect(child).toBeDefined();
              const projection = store.buildTaskSessionProjection(child.id)!;
              expect(store.claimTask(runtime.id)?.id).toBe(child.id);
              store.startTask(child.id);
              store.completeTask(child.id, { output: "Identical terminal response" });
              const tasks = store.listTasksForIssue(issue.id);
              const events = legacyProjectionEvents(db, session.id);
              const replacements = events.flatMap((event) => [
                [event.id, `EVENT_${event.seq}`],
                ...(event.kind === "task_assigned" && event.taskId ? [[event.taskId, `TASK_${event.seq}`]] : []),
                ...(event.sourceCommentId ? [[event.sourceCommentId, `COMMENT_${event.seq}`]] : []),
              ]);
              let snapshot = JSON.stringify({
                tasks: tasks.map((task) => ({ id: task.id, agentId: task.agentId, status: task.status,
                  parentTaskId: task.parentTaskId, delegatedByAgentId: task.delegatedByAgentId,
                  triggerCommentId: task.triggerCommentId, prompt: task.prompt,
                  projectionFromSeq: task.projectionFromSeq, projectionToSeq: task.projectionToSeq })).sort((a, b) => a.agentId.localeCompare(b.agentId)),
                projection,
              });
              for (const [id, label] of replacements) snapshot = snapshot.replaceAll(id!, label!);
              snapshot = snapshot.replace(/dlg_[a-z0-9]+/g, "DELEGATION").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "TIME");
              snapshots.push(JSON.parse(snapshot));
              throw rollback;
            })();
          } catch (error) {
            if (error !== rollback) throw error;
          } finally {
            db.query = query;
            ctx.getLogIssueComment = getComment;
            sessions.projectionEvents = project;
          }
        }
        expect(snapshots[1]).toEqual(snapshots[0]);
      });
    }, 30_000);
  }
});

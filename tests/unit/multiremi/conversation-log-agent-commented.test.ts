import { createResponsibleTestIssue } from './helpers.js';
import { describe, expect, it } from "bun:test";
import { conversationLogPgAdminUrl as pgAdminUrl, withConversationLogStore as withStore } from "./fixtures/conversation-log-store.js";

export const AGENT_COMMENTED_EQUIVALENCE_CASES = [
  ["ordinary agent comment", true],
  ["ordinary member comment", false],
  ["automatic reply", true],
  ["task-linked system comment", false],
  ["agent-authored system comment", false],
  ["deleted comment", false],
  ["deleted comment with residual task id", false],
  ["edited comment", true],
  ["same issue side session", true],
  ["before since", false],
  ["at since boundary", true],
  ["null since includes older comment", true],
  ["different agent", false],
  ["different task", false],
  ["different issue", false],
  ["message event without a comment", false],
] as const;

describe("MUL-427 ruling (e): agentCommentedSince query equivalence", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: canonical comment predicates retain author, turn, visibility and time boundaries`, async () => {
      await withStore(backend, (store, db) => {
        const reader = (store as unknown as { tasks: {
          agentCommentedSince(issueId: string, agentId: string, since: string | null, taskId: string): boolean;
        } }).tasks;
        const agent = store.createAgent({ name: "Matrix author", provider: "codex", workspaceId: "local" });
        const otherAgent = store.createAgent({ name: "Other matrix author", provider: "codex", workspaceId: "local" });
        const runtime = store.registerRuntime({ id: "rt_comment_matrix", name: "Matrix runtime", provider: "codex", workspaceId: "local" });
        const sinceBoundary = "2026-01-02T00:00:00.000Z";
        for (const [name, expected] of AGENT_COMMENTED_EQUIVALENCE_CASES) {
          const issue = createResponsibleTestIssue(store, { title: name, workspaceId: "local" });
          const session = store.getOrCreateDefaultIssueSession(issue.id);
          let taskId = store.createSessionTask(session.id,{agentId:agent.id,prompt:"Matrix input"}).id;
          const sourceIssue = name === "different issue"
            ? createResponsibleTestIssue(store, { title: "Other issue", workspaceId: "local" }) : issue;
          const sourceSession = name === "same issue side session"
            ? store.createIssueSession(issue.id, { title: "Side" })
            : store.getOrCreateDefaultIssueSession(sourceIssue.id);
          let commentId: string | null = null;
          if (name === "automatic reply") {
            const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Automatic reply case" });
            taskId = task.id;
            expect(store.claimTask(runtime.id)?.id).toBe(task.id);
            store.startTask(task.id);
            store.completeTask(task.id, { output: "Automatic final reply" });
            commentId = store.listIssueComments(issue.id).find((comment) => comment.taskId === task.id)!.id;
          } else if (name === "message event without a comment") {
            store.appendSessionEvent(session.id, { authorType: "agent", authorId: agent.id,
              kind: "message", taskId, body: "An event alone is not a comment", createdAt: sinceBoundary });
          } else if (name.includes("system comment")) {
            commentId = store.createTaskFailureSystemComment(issue.id, session.id, taskId, "System reply").id;
            if (name === "agent-authored system comment") {

              db.run("UPDATE multiremi_conversation_log SET sender_type = 'agent', sender_id = ? WHERE id = ?", [agent.id, commentId]);
            }
          } else {
            const comment = store.createIssueComment(sourceIssue.id, {
              issueSessionId: sourceSession.id, body: name,
              taskId: ["different task","different agent"].includes(name) ? store.createSessionTask(sourceSession.id,{agentId:otherAgent.id,prompt:"Other matrix turn"}).id : taskId,
              authorType: name === "ordinary member comment" ? "member" : "agent",
              authorId: name === "ordinary member comment" ? "mem_local_local" : ["different agent","different task"].includes(name) ? otherAgent.id : agent.id,
            });
            commentId = comment.id;
            // Exercise defensive predicates on historical mismatched source/author rows.
            if(name==="different agent")db.run("UPDATE multiremi_conversation_log SET task_id=? WHERE id=?",[taskId,comment.id]);
            if(name==="different task")db.run("UPDATE multiremi_conversation_log SET sender_id=? WHERE id=?",[agent.id,comment.id]);
            if (name === "edited comment") store.updateIssueComment(comment.id, { body: "Edited current body" });
            if (name === "deleted comment") store.deleteIssueComment(comment.id);
            if (name === "deleted comment with residual task id") {
              // Ruling (e) clears task_id on tombstones before this query runs; keep a residual id so the
              // deleted_at guard is the only legacy predicate that can exclude the row.
              store.deleteIssueComment(comment.id);
              db.run("UPDATE multiremi_conversation_log SET task_id = ? WHERE id = ?", [taskId, comment.id]);
            }
          }
          if (commentId) {
            const createdAt = name === "before since" || name.startsWith("null since")
              ? "2026-01-01T00:00:00.000Z" : sinceBoundary;

            db.run("UPDATE multiremi_conversation_log SET created_at = ? WHERE id = ?", [createdAt, commentId]);
          }
          const since = name.startsWith("null since") ? null : sinceBoundary;
          expect({name,result:reader.agentCommentedSince(issue.id,agent.id,since,taskId)}).toEqual({name,result:expected});
          for(const queued of store.listTasksForIssue(issue.id).filter(task=>task.status==="queued"))store.cancelTask(queued.id);
        }
      });
    }, 60_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: completing a task after its agent comments does not add an automatic reply`, async () => {
      await withStore(backend, (store, db) => {
        const runtime = store.registerRuntime({ id: "rt_no_double_reply", name: "Reply runtime", provider: "codex", workspaceId: "local" });
        const agent = store.createAgent({ name: "Reply author", provider: "codex", workspaceId: "local" });
        const issue = createResponsibleTestIssue(store, { title: "One reply per round", workspaceId: "local" });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Respond" });
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);
        store.startTask(task.id);
        const comment = store.createIssueComment(issue.id, { authorType: "agent", authorId: agent.id,
          taskId: task.id, body: "Already posted this round" });
        expect(store.getConversationLogEntryById(comment.id)?.task_id).toBe(task.id);
        const matches = db.query(`SELECT COUNT(*) AS n FROM multiremi_conversation_log
          WHERE session_id = ? AND sender_id = ? AND task_id = ? AND kind = 'message' AND deleted_at IS NULL`)
          .get(session.id, agent.id, task.id) as { n: number };
        expect(Number(matches.n)).toBe(1);
        // Perturb the old source so completion proves the new query is used.
        db.run("UPDATE multiremi_issue_comments SET task_id = NULL WHERE id = ?", [comment.id]);
        store.completeTask(task.id, { output: "Accumulated transcript must not be posted again" });
        const actualCommentsAfterCompletion = store.listIssueComments(issue.id).filter((candidate) => candidate.authorId === agent.id).length;
        expect(actualCommentsAfterCompletion).toBe(1);
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: a deleted comment with a residual task id still gets the automatic reply`, async () => {
      await withStore(backend, (store, db) => {
        const runtime = store.registerRuntime({ id: "rt_deleted_reply", name: "Deleted reply runtime", provider: "codex", workspaceId: "local" });
        const agent = store.createAgent({ name: "Deleted reply author", provider: "codex", workspaceId: "local" });
        const issue = createResponsibleTestIssue(store, { title: "Deleted comment does not count", workspaceId: "local" });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Reply after deletion" });
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);
        store.startTask(task.id);
        const comment = store.createIssueComment(issue.id, { authorType: "agent", authorId: agent.id,
          taskId: task.id, body: "Deleted before the task completed" });
        store.deleteIssueComment(comment.id);
        // A tombstone keeps task_id NULL from ruling (e); restore it so only deleted_at excludes the row.
        db.run("UPDATE multiremi_conversation_log SET task_id = ? WHERE id = ?", [task.id, comment.id]);
        expect(Number(db.query(`SELECT COUNT(*) AS n FROM multiremi_conversation_log
          WHERE session_id = ? AND sender_id = ? AND task_id = ? AND kind = 'message' AND deleted_at IS NULL`)
          .get(session.id, agent.id, task.id)!.n)).toBe(0);
        store.completeTask(task.id, { output: "The automatic reply is still required" });
        const replies = store.listIssueComments(issue.id).filter((candidate) => candidate.authorId === agent.id);
        expect(replies.map((candidate) => candidate.id)).not.toContain(comment.id);
        expect(replies.length).toBe(1);
      });
    }, 30_000);
  }
});

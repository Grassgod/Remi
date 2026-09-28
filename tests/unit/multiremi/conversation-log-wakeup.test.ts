import { describe, expect, it } from "bun:test";
import type { MultiremiSessionEvent } from "@multiremi/contracts/types.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";
import { resolveProjectionTokenBudget } from "@multiremi/store/session-projection-budget.js";
import { conversationLogProjectionEvents } from "@multiremi/store/conversation-log-projection.js";
import { conversationLogPgAdminUrl as pgAdminUrl, withConversationLogStore as withStore } from "./fixtures/conversation-log-store.js";

describe("MUL-427: log-backed wakeups and projections", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: head creation and updates never wake a lane or advance its unread cursor`, async () => {
      await withStore(backend, (store) => {
        const agent = store.createAgent({ name: "Head observer", provider: "codex", workspaceId: "local" });
        const enqueued: string[] = [];
        const unsubscribe = store.onTaskEnqueued((task) => enqueued.push(task.id));
        try {
          const issue = store.createIssue({ title: "Only a head", workspaceId: "local" });
          const session = store.getOrCreateDefaultIssueSession(issue.id);
          const lane = store.getOrCreateSessionAgentLane(session.id, agent.id);
          store.updateIssue(issue.id, { title: "Head changed", description: "Still no event" });
          const head = store.getConversationLogEntry(session.id, 0)!;
          expect(store.listConversationLogEntries(session.id)).toEqual([]);
          expect(conversationLogProjectionEvents([head])).toEqual([]);
          const projection = buildSessionProjection({
            sessionId: session.id, targetAgentId: agent.id, cursorSeq: 0,
            providerSessionId: null, tokenBudget: 4096,
            events: [{ id: head.id, sessionId: session.id, seq: 0, kind: "head", authorType: "system",
              authorId: null, body: head.body_md, taskId: null, sourceCommentId: null, metadata: {}, createdAt: head.created_at }],
          });
          expect(projection.toSeq).toBe(0);
          expect(projection.jsonl.split("\n")).toHaveLength(1);
          expect(lane.cursorSeq).toBe(0);
          const side = store.createIssueSession(issue.id, { title: "Empty snapshot", parentSessionId: session.id });
          expect(side.inheritCutoffSeq).toBe(0);
          expect(side.inheritedEventCount).toBe(0);
          expect(store.listTasksForIssue(issue.id)).toEqual([]);
          expect(enqueued).toEqual([]);
        } finally { unsubscribe(); }
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: edited comments, tombstones and hidden markers produce byte-identical legacy projections`, async () => {
      await withStore(backend, (store, db) => {
        const runtime = store.registerRuntime({ id: "rt_projection_parity", name: "Projection runtime", provider: "codex", workspaceId: "local" });
        const agent = store.createAgent({ name: "Projection target", provider: "codex", workspaceId: "local" });
        const issue = store.createIssue({ title: "Reference parity", workspaceId: "local" });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const edited = store.createIssueComment(issue.id, { body: "Original before two edits" });
        store.updateIssueComment(edited.id, { body: "Intermediate" });
        store.updateIssueComment(edited.id, { body: "Current wording" });
        const deleted = store.createIssueComment(issue.id, { body: "Original tombstone body" });
        store.deleteIssueComment(deleted.id);
        store.resolveIssueComment(edited.id);
        store.unresolveIssueComment(edited.id);
        const previous = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Earlier assignment" });
        expect(store.claimTask(runtime.id)?.id).toBe(previous.id);
        store.startTask(previous.id);
        store.failTask(previous.id, { error: "Earlier failure" });
        store.appendSessionEvent(session.id, { authorType: "system", kind: "task_steer", taskId: previous.id,
          body: "Original steer", metadata: { source_task_id: previous.id } });
        const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Current request" });
        const rows = db.query("SELECT * FROM multiremi_session_events WHERE session_id = ? ORDER BY seq ASC").all(session.id);
        const legacy: MultiremiSessionEvent[] = rows.map((row) => ({
          id: String(row.id), sessionId: String(row.session_id), seq: Number(row.seq),
          authorType: String(row.author_type), authorId: row.author_id == null ? null : String(row.author_id),
          kind: String(row.kind), body: String(row.body), taskId: row.task_id == null ? null : String(row.task_id),
          sourceCommentId: row.source_comment_id == null ? null : String(row.source_comment_id),
          metadata: JSON.parse(String(row.metadata)), createdAt: String(row.created_at),
        }));
        const reference = buildSessionProjection({
          sessionId: session.id, targetAgentId: agent.id, events: legacy, cursorSeq: 0,
          providerSessionId: null, tokenBudget: resolveProjectionTokenBudget({ provider: agent.provider, model: agent.model, degradeLevel: 0 }),
          currentTaskId: task.id, resolveAuthorName: (type, id) => type === "agent" && id === agent.id ? agent.name : null,
        });
        expect(store.buildTaskSessionProjection(task.id)).toEqual(reference);
        expect(reference.jsonl).toContain("Original before two edits");
        expect(reference.jsonl).toContain("Original tombstone body");
        expect(reference.jsonl).toContain('"previous_body":"Intermediate"');
        db.run("UPDATE multiremi_session_events SET body = 'DO NOT READ THE OLD TABLE', metadata = '{}' WHERE session_id = ?", [session.id]);
        expect(store.buildTaskSessionProjection(task.id)).toEqual(reference);
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: pending chat deliveries read the system log metadata and body`, async () => {
      await withStore(backend, (store, db) => {
        const agent = store.createAgent({ name: "Chat recipient", provider: "codex", workspaceId: "local" });
        const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
        const { message } = store.createPendingAgentIssueUpdateWithinTransaction(chat.id, "Canonical update");
        db.run("UPDATE multiremi_chat_messages SET body = 'OLD BODY' WHERE id = ?", [message.id]);
        const batch = store.preparePendingAgentIssueUpdatesForTaskWithinTransaction(chat.id, "tsk_delivery");
        expect(batch.messages.map((candidate) => candidate.body)).toEqual(["Canonical update"]);
        expect(store.getConversationLogEntryById(message.id)?.metadata).toMatchObject({
          pending_agent_delivery: true, agent_delivery_task_id: "tsk_delivery",
        });
        expect(store.completePendingAgentIssueUpdatesForTaskWithinTransaction(chat.id, "tsk_delivery")).toBe(1);
        expect(store.preparePendingAgentIssueUpdatesForTaskWithinTransaction(chat.id, "tsk_next").messages).toEqual([]);
      });
    }, 30_000);
  }
});

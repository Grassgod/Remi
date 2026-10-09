import { createResponsibleTestIssue } from './helpers.js';
import { describe, expect, it } from "bun:test";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";
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
          const issue = createResponsibleTestIssue(store, { title: "Only a head", workspaceId: "local" });
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
          expect(projection.jsonl.split("\n")).toHaveLength(2);
          expect(JSON.parse(projection.jsonl.split("\n")[1]!)).toEqual({ type: "inbox_toc", entries: [] });
          expect(lane.cursorSeq).toBe(0);
          const side = store.createIssueSession(issue.id, { title: "Empty snapshot", parentSessionId: session.id });
          expect(side.inheritCutoffSeq).toBe(0);
          expect(side.inheritedEventCount).toBe(0);
          expect(store.listTasksForIssue(issue.id)).toEqual([]);
          expect(enqueued).toEqual([]);
        } finally { unsubscribe(); }
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: edited messages and tombstones are read from the canonical range`, async () => {
      await withStore(backend, (store, db) => {
        const agent=store.createAgent({name:"Canonical reader",provider:"codex"});
        const issue=createResponsibleTestIssue(store, {title:"Current input"});
        const session=store.getOrCreateDefaultIssueSession(issue.id);
        const edited=store.createIssueComment(issue.id,{body:"Original"});
        store.updateIssueComment(edited.id,{body:"Current body"});
        const deleted=store.createIssueComment(issue.id,{body:"Deleted body"});store.deleteIssueComment(deleted.id);
        const task=store.createSessionTask(session.id,{agentId:agent.id,prompt:"Read current input"});
        const projection=store.buildTaskSessionProjection(task.id)!;
        const rows=store.listConversationLogEntries(session.id,{sinceSeq:0,toSeq:projection.toSeq});
        expect(rows.find(row=>row.id===edited.id)?.body_md).toBe("Current body");
        expect(rows.find(row=>row.id===deleted.id)?.deleted_at).toBeTruthy();
        expect(rows.find(row=>row.id===deleted.id)?.body_md).toBe("");
        expect(store.getSessionAgentLane(session.id,agent.id)?.cursorSeq??0).toBe(0);
        db.run("UPDATE multiremi_session_events SET body='POISON OLD TABLE' WHERE session_id=?",[session.id]);
        expect(store.buildTaskSessionProjection(task.id)).toEqual(projection);
      });
    },60_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: Chat updates merge into one pending turn with frozen recipients`, async () => {
      await withStore(backend,(store,db)=>{
        const agent=store.createAgent({name:"Chat recipient",provider:"codex"});
        const chat=store.createChatSession({agentId:agent.id,workspaceId:"local",creatorId:"local"});
        const a=store.sendMessage({session_id:chat.id,sender:{type:"platform",id:null},to:{type:"agent",ref:agent.id},message_kind:"status",wake_requested:"now",body_md:"First update"});
        const b=store.sendMessage({session_id:chat.id,sender:{type:"platform",id:null},to:{type:"agent",ref:agent.id},message_kind:"status",wake_requested:"now",body_md:"Second update"});
        expect(b.turn_id).toBe(a.turn_id);
        expect(store.getMessage(a.message.id)?.to_agent_id).toBe(agent.id);
        expect(store.getMessage(b.message.id)?.to_agent_id).toBe(agent.id);
        expect(store.getTurn(a.turn_id!)?.wake_seq).toBe(b.message.seq);
        expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_chat_messages').get()?.n)).toBe(0);
      });
    },60_000);
  }
});

import { createResponsibleTestIssue } from './helpers.js';
import { describe, expect, it } from "bun:test";
import { StoreContext } from "@multiremi/store/context.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { withConversationLogStore, conversationLogPgAdminUrl } from "./fixtures/conversation-log-store.js";

describe("comment mutations own exactly one PG transaction", () => {
  for (const operation of ["edit", "delete", "resolve", "unresolve"] as const) {
    it.skipIf(!conversationLogPgAdminUrl)(`${operation}: comment, log patch and hidden marker commit at depth 1 and roll back together`, async () => {
      await withConversationLogStore("pg", (store, db) => {
        if (!(db instanceof PostgresSyncDatabase)) throw new Error("PG depth test requires a real handle");
        store.ensureLocalWorkspace();
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const issue = createResponsibleTestIssue(store, { title: "Comment atomicity", workspaceId: "local" });
        const comment = store.createIssueComment(issue.id, { body: "original", authorType: "member", authorId: "local" });
        if (operation === "unresolve") store.resolveIssueComment(comment.id);
        const mutate = () => {
          if (operation === "edit") store.updateIssueComment(comment.id, { body: "edited" });
          else if (operation === "delete") store.deleteIssueComment(comment.id);
          else if (operation === "resolve") store.resolveIssueComment(comment.id);
          else store.unresolveIssueComment(comment.id);
        };
        const prior = store.getIssueComment(comment.id);
        const events = store.listSessionEvents(comment.issueSessionId!);
        const received: string[] = [];
        store.onWorkspaceEvent(event => { expect(ctx.db.inTransaction).toBe(false); received.push(event.type); });
        // Failure after the session marker is written proves the entire mutation
        // rolls back, including the earlier in-place conversation-log patch.
        const append = store.appendSessionEventWithinTransaction.bind(store);
        store.appendSessionEventWithinTransaction = (...args) => {
          append(...args);
          throw new Error("rollback comment marker");
        };
        db.resetTransactionDepthStats();
        try { expect(mutate).toThrow("rollback comment marker"); }
        finally { store.appendSessionEventWithinTransaction = append; }
        expect(db.maxTransactionDepth).toBe(1);
        expect(store.getIssueComment(comment.id)).toEqual(prior);
        expect(store.listSessionEvents(comment.issueSessionId!)).toEqual(events);
        expect(received).toHaveLength(0);
        db.resetTransactionDepthStats();
        mutate();
        expect(db.maxTransactionDepth).toBe(1);
        expect(store.listSessionEvents(comment.issueSessionId!)).toHaveLength(events.length + 1);
        if (operation === "delete") expect(store.getIssueComment(comment.id)).toBeNull();
        else if (operation === "edit") expect(store.getIssueComment(comment.id)?.body).toBe("edited");
        else expect(Boolean(store.getIssueComment(comment.id)?.resolvedAt)).toBe(operation === "resolve");
      });
    }, 30_000);
  }
});


import { createResponsibleTestIssue } from './helpers.js';
import { afterEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createReadPool } from "@multiremi/store/db/read-pool.js";
import {
  createPostgresStreamAuthReader,
  createSqliteStreamAuthReader,
  decideLogSubscription,
} from "@multiremi/api/hub/stream-auth.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("MUL-509 moved Issue Session read parity", (fixture, backend) => {
  afterEach(() => fixture().store.stopNotificationDeliverySweeper());

  it("HTTP messages/log and WS log facts retain the Session workspace after updateIssue moves the Issue", async () => {
    const { store, db, databaseUrl } = fixture();
    const w1 = store.ensureLocalWorkspace();
    const w2 = store.createWorkspace({ name: "W2", slug: "session-read-w2" });
    const callers = [];
    for (const [workspace, readable] of [[w1, true], [w2, false]] as const) {
      const user = store.getOrCreateUser({ externalId: `session-reader-${workspace.id}`, name: workspace.name });
      const member = store.createWorkspaceMember({ workspaceId: workspace.id, userId: user.id, name: user.name, role: "member" });
      const access = await store.createAccessToken({ type: "pat", name: user.name, userId: user.id, workspaceId: workspace.id });
      callers.push({ user, member, workspace, readable, token: access.token });
    }
    const issue = createResponsibleTestIssue(store, { workspaceId: w1.id, title: "Move without migrating history",
      assigneeType: "member", assigneeId: callers[0]!.member.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const history = store.sendMessage({ session_id: session.id, sender: { type: "member", id: callers[0]!.member.id },
      to: { type: "none" }, body_md: "W1 conversation history", message_kind: "status", wake_requested: "inbox_only" }).message;

    // Exercise the real move transaction, including its W1 Session audit row.
    store.updateIssue(issue.id, { workspaceId: w2.id });
    expect(store.getIssue(issue.id)?.workspaceId).toBe(w2.id);
    expect(store.getOrCreateDefaultIssueSession(issue.id)).toMatchObject({ id: session.id, workspaceId: w1.id });
    const head = store.getConversationLogHead(session.id)!.headSeq;
    const audit = store.conversationLogWindow(session.id).entries.find(entry => entry.metadata.type === "workspace_move_cleared")!;
    expect(audit).toMatchObject({ author_type: "system", message_kind: "status", metadata: { field: "assignee" } });

    const app = createMultiremiApp({ store, authToken: "fixture-master" });
    const pool = createReadPool({ databaseUrl, sqliteDb: db });
    // Select explicitly: NODE_ENV=test otherwise uses the sync reader even on PG.
    const auth = backend === "PostgreSQL" ? createPostgresStreamAuthReader(pool) : createSqliteStreamAuthReader(store);
    expect(auth.backend).toBe(backend === "PostgreSQL" ? "postgres" : "sqlite");
    try {
      const routes = [
        `/api/sessions/${session.id}/messages`,
        `/api/sessions/${session.id}/messages?from=0&to=${head}`,
        `/api/messages/${history.id}`,
        `/api/sessions/${session.id}/log`,
        `/api/sessions/${session.id}/log/entry?id=${history.id}`,
        `/api/sessions/${session.id}/log/entry?id=${audit.id}`,
        `/api/sessions/${session.id}/log/locate?id=${history.id}`,
      ];
      for (const caller of callers) {
        const subject = { userId: caller.user.id, workspaceId: caller.workspace.id };
        const facts = await auth.logFacts(session.id, subject);
        expect(facts).toEqual({ ok: true, facts: { kind: "issue", workspaceId: w1.id,
          creatorId: null, requesterIsMember: caller.readable } });
        if (!facts.ok) throw new Error("WS log facts unavailable");
        const decision = decideLogSubscription(subject, facts.facts);
        expect(decision).toEqual(caller.readable ? { ok: true } : { ok: false, code: "forbidden" });
        // Even if W2-only could bind a W1 socket, membership still denies it.
        expect(decideLogSubscription({ ...subject, workspaceId: w1.id }, facts.facts).ok).toBe(caller.readable);
        for (const route of routes) {
          const response = await app.request(route, { headers: { Authorization: `Bearer ${caller.token}` } });
          expect(response.status, `${caller.workspace.name}: ${route}`).toBe(caller.readable ? 200 : 404);
          expect(response.status === 200).toBe(decision.ok);
          const body = await response.json();
          if (caller.readable && route.endsWith("/messages")) {
            expect(body).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ id: history.id, body_md: history.body_md })]) });
          } else if (caller.readable && route.endsWith("/log")) {
            expect(body).toMatchObject({ entries: expect.arrayContaining([
              expect.objectContaining({ id: history.id, body_md: history.body_md }),
              expect.objectContaining({ id: audit.id, author_type: "system" }),
            ]) });
          } else if (!caller.readable) {
            expect(JSON.stringify(body)).not.toContain(history.body_md);
          }
        }
        const before = store.getConversationLogHead(session.id)!.headSeq;
        const sent = await app.request(`/api/sessions/${session.id}/messages`, { method: "POST",
          headers: { Authorization: `Bearer ${caller.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ to: { type: "none" }, body_md: "Follow-up in W1", message_kind: "status", wake_requested: "inbox_only" }) });
        expect(sent.status).toBe(caller.readable ? 200 : 404);
        expect(store.getConversationLogHead(session.id)!.headSeq).toBe(before + (caller.readable ? 1 : 0));
      }
    } finally { await pool.close(); }
  });
});

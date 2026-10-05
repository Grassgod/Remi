import { expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import { createReadPool } from "@multiremi/store/db/read-pool.js";
import { createPostgresStreamAuthReader, createSqliteStreamAuthReader, decideLogSubscription } from "@multiremi/api/hub/stream-auth.js";
import { createBrowserLogProjection } from "@multiremi/api/hub/browser-log-projection.js";
import { createHub } from "@multiremi/api/hub/hub-core.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import { createConversationLogFillReader } from "@multiremi/api/hub/conversation-log-fill-reader.js";
import type { MultiremiWebSocketClient } from "@multiremi/api/helpers/realtime-types.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { authenticateBrowserWebSocket } from "./helpers.js";

pendingTurnBackendTests("MUL-508 access consistency", (fixture, backend) => {
  async function scaffold() {
    const { store, db, databaseUrl } = fixture();
    const user = store.getOrCreateUser({ externalId: "access-member", name: "Member" });
    const member = store.createWorkspaceMember({ userId: user.id, name: user.name, role: "member" });
    const agent = store.createAgent({ name: "Worker", provider: "codex", visibility: "workspace" });
    const issue = store.createIssue({ title: "Access", assigneeType: "agent", assigneeId: agent.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const pat = await store.createAccessToken({ name: "Member", type: "pat", userId: user.id, workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "access-master" });
    const request = async (path: string, method = "GET", body?: unknown, auth = pat.token) => {
      const response = await app.request(path, { method, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() as any };
    };
    const send = (body: string, to: { type: "member" | "agent"; ref: string }, sessionId = session.id) => store.sendMessage({
      session_id: sessionId, sender: { type: "member", id: member.id }, to, body_md: body, message_kind: "request", wake_requested: "inbox_only",
    }).message;
    const running = (chatSessionId?: string) => {
      const task = store.createTask({ agentId: agent.id, prompt: "Work", ...(chatSessionId ? { chatSessionId } : { issueId: issue.id }) });
      db.run("UPDATE multiremi_turns SET status='running' WHERE current_attempt_id=?", [task.id]);
      db.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?", [task.id]);
      return { task, turn: store.getTurnForAttempt(task.id)! };
    };
    const snapshot = () => ["multiremi_issue_sessions", "multiremi_conversation_heads", "multiremi_conversation_log", "multiremi_turns", "multiremi_turn_attempts", "multiremi_attachments"]
      .map(table => Number(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get().n));
    const lane = (id: string, type = "member", reader = member.id, scope = "") => Number(db.query(
      "SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type=? AND reader_id=? AND execution_scope=?",
    ).get(id, type, reader, scope)?.cursor_seq ?? 0);
    return { store, db, databaseUrl, user, member, agent, issue, session, pat, app, request, send, running, snapshot, lane };
  }
  async function stream(f: Awaited<ReturnType<typeof scaffold>>) {
    const pool = createReadPool({ databaseUrl: f.databaseUrl, sqliteDb: f.db });
    expect(pool.postgres).toBe(backend === "PostgreSQL");
    const auth = pool.postgres ? createPostgresStreamAuthReader(pool) : createSqliteStreamAuthReader(f.store);
    const client = (userId: string | null, workspaceId = "local"): MultiremiWebSocketClient => ({
      data: { kind: "browser", authenticated: true, connectedAt: new Date().toISOString(), userId, workspaceId, accessToken: null },
      sendText() {}, close() {},
    });
    const allowed = async (id: string, userId: string | null, workspaceId = "local") => {
      const facts = await auth.logFacts(id, { userId, workspaceId });
      expect(facts.ok).toBe(true);
      if (!facts.ok) throw new Error("stream facts unavailable");
      // Exercise both readers on exactly the same committed data.
      const syncFacts = await createSqliteStreamAuthReader(f.store).logFacts(id, { userId, workspaceId });
      if (!syncFacts.ok) throw new Error("sync stream facts unavailable");
      expect(facts.facts).toEqual(syncFacts.facts);
      return decideLogSubscription({ userId, workspaceId }, facts.facts).ok;
    };
    const project = async (id: string, messageId: string, userId: string | null, workspaceId = "local") => {
      const row = f.store.getConversationLogEntryById(messageId)!;
      return createBrowserLogProjection(f.store, pool)(client(userId, workspaceId), id, [{ seq: row.seq, kind: "entry", payload: row }]);
    };
    return { pool, auth, allowed, project };
  }

  it("B1: retry requires supervisor role and scope, preserves source visibility, and rejects side sessions", async () => {
    const f = await scaffold(), target = f.running();
    const normal = await f.store.createTaskAccessToken(target.task, "local");
    for (const credential of [f.pat.token, "access-master"]) {
      const capabilities = await f.request("/api/cli/capabilities", "GET", undefined, credential);
      expect(capabilities.data.commands.find((command: any) => command.id === "turn.retry")?.allowed).toBe(false);
    }
    const capabilities = await f.request("/api/cli/capabilities", "GET", undefined, normal.token);
    expect(capabilities.data.commands.find((command: any) => command.id === "turn.retry")?.allowed).toBe(true);
    const before = f.snapshot();
    for (const credential of [f.pat.token, "access-master", normal.token]) {
      const result = await f.request(`/api/turns/${target.turn.id}/retry`, "POST", {}, credential);
      expect(result.status).toBe(403); expect(result.data.code).toBe("organizer_supervisor_required");
      expect(f.snapshot()).toEqual(before);
    }
    f.db.run("UPDATE multiremi_access_tokens SET scopes=? WHERE id=?", ['["organizer:supervisor"]', normal.id]);
    expect((await f.request(`/api/turns/${target.turn.id}/retry`, "POST", {}, normal.token)).status).toBe(403);
    const supervisor = f.store.createAgent({ name: "Supervisor", provider: "codex", role: "supervisor", visibility: "workspace" });
    const supervisorIssue = f.store.createIssue({ title: "Supervision", assigneeType: "agent", assigneeId: supervisor.id });
    const task = f.store.createTask({ agentId: supervisor.id, issueId: supervisorIssue.id, prompt: "Supervise" });
    const withoutScope = await f.store.createAccessToken({ type: "task", name: "No scope", taskId: task.id, agentId: supervisor.id, workspaceId: "local", userId: "local" });
    expect((await f.request(`/api/turns/${target.turn.id}/retry`, "POST", {}, withoutScope.token)).status).toBe(403);
    const token = await f.store.createTaskAccessToken(task, "local");
    const restricted = await f.store.createTaskAccessToken(task, f.user.id);
    f.store.updateAgent(f.agent.id, { visibility: "private", ownerId: "local" });
    expect((await f.request(`/api/turns/${target.turn.id}/retry`, "POST", {}, restricted.token)).status).toBe(404);
    expect(f.store.listTurnAttempts(target.turn.id)).toHaveLength(1);
    f.store.updateAgent(f.agent.id, { visibility: "workspace" });
    const sourceSession = f.store.getOrCreateDefaultIssueSession(supervisorIssue.id);
    f.db.run("UPDATE multiremi_issue_sessions SET inherit_mode='summary' WHERE id=?", [sourceSession.id]);
    expect((await f.request(`/api/turns/${target.turn.id}/retry`, "POST", {}, token.token)).status).toBe(403);
    f.db.run("UPDATE multiremi_issue_sessions SET inherit_mode='none' WHERE id=?", [sourceSession.id]);
    const result = await f.request(`/api/turns/${target.turn.id}/retry`, "POST", { cold: true }, token.token);
    expect(result.status).toBe(200); expect(result.data.turn.id).toBe(target.turn.id);
    expect(result.data.turn.current_attempt_id).not.toBe(target.task.id);
    expect(f.store.listTurnAttempts(target.turn.id)).toHaveLength(2);
  });

  for (const kind of ["issue", "chat"] as const) it(`B2: ${kind} replacement revokes every old token atomically and rejects all token entrypoints`, async () => {
    const f = await scaffold();
    const chat = kind === "chat" ? f.store.createChatSession({ agentId: f.agent.id, creatorId: f.user.id }) : null;
    const sessionId = chat?.id ?? f.session.id;
    const target = f.running(chat?.id);
    const token = await f.store.createTaskAccessToken(target.task, "local");
    const otherToken = await f.store.createTaskAccessToken(target.task, "local");
    const message = f.store.sendMessage({ session_id: sessionId, sender: { type: "agent", id: f.agent.id }, to: { type: "none" }, body_md: "Editable", message_kind: "report", wake_requested: "inbox_only" }).message;
    const attachment = f.store.createAttachment({ workspaceId: "local", filename: "file.txt", contentType: "text/plain", sizeBytes: 4,
      url: "https://example.invalid/file.txt", ...(chat ? { chatSessionId: chat.id, chatMessageId: message.id } : { issueId: f.issue.id, commentId: message.id }) });
    expect((await f.request(`/api/messages/${message.id}`, "GET", undefined, token.token)).status).toBe(200);
    expect((await f.request(`/api/attachments/${attachment.id}`, "GET", undefined, token.token)).status).toBe(200);
    expect(() => fixture().transaction(() => { f.store.retryTurn(target.turn.id); throw new Error("replacement rollback"); })).toThrow("replacement rollback");
    expect(f.store.getTurn(target.turn.id)?.current_attempt_id).toBe(target.task.id);
    expect(f.store.getAccessToken(token.id)?.revokedAt).toBeNull();
    expect(await f.store.verifyAccessToken(token.token)).not.toBeNull();
    const replacement = f.store.retryTurn(target.turn.id);
    for (const credential of [token, otherToken]) {
      expect(f.store.getAccessToken(credential.id)?.revokedAt).toBeTruthy();
      expect(await f.store.verifyAccessToken(credential.token)).toBeNull();
    }
    const openApp = createMultiremiApp({ store: f.store, authToken: null });
    const rejectedHeaders = [
      `Bearer ${token.token}`, `Bearer  ${token.token}`, `bearer ${token.token}`,
      "Bearer unknown", "Basic unknown", "Bearer", "",
    ];
    const rejectedSnapshot = f.snapshot(), rejectedHead = f.store.getConversationLogHead(sessionId)!.headSeq;
    for (const app of [f.app, openApp]) for (const authorization of rejectedHeaders) for (const method of ["GET", "POST"]) {
      const response = await app.request(`/api/sessions/${sessionId}/messages`, {
        method, headers: { Authorization: authorization, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ body_md: "Forbidden" }) } : {}),
      });
      expect(response.status, `${method} rejected Authorization`).toBe(401);
      expect(f.snapshot()).toEqual(rejectedSnapshot);
      expect(f.store.getConversationLogHead(sessionId)?.headSeq).toBe(rejectedHead);
    }
    // A stale row accidentally left unrevoked must still fail the current-attempt check.
    f.db.run("UPDATE multiremi_access_tokens SET revoked_at=NULL WHERE id=?", [token.id]);
    expect(await f.store.verifyAccessToken(token.token)).toBeNull();
    const before = f.snapshot(), head = f.store.getConversationLogHead(sessionId)!.headSeq;
    for (const [path, method, body] of [
      [`/api/sessions/${sessionId}/messages`, "GET"], [`/api/sessions/${sessionId}/messages?from=0&to=${head}`, "GET"],
      [`/api/sessions/${sessionId}/messages`, "POST", { body_md: "Forbidden" }],
      [`/api/sessions/${sessionId}/log`, "GET"], [`/api/sessions/${sessionId}/log/entry?id=${message.id}`, "GET"], [`/api/sessions/${sessionId}/log/locate?id=${message.id}`, "GET"],
      [`/api/messages/${message.id}`, "GET"], [`/api/messages/${message.id}`, "PATCH", { body_md: "Changed" }], [`/api/messages/${message.id}`, "DELETE"],
      [`/api/messages/${message.id}/resolve`, "POST", {}], [`/api/messages/${message.id}/resolve`, "POST", { resolved: false }],
      [`/api/messages/${message.id}/reactions`, "POST", { emoji: "+1" }], [`/api/messages/${message.id}/reactions`, "POST", { emoji: "+1", remove: true }],
      ["/api/inbox", "GET"], ["/api/inbox/read", "POST", { all: true }], ["/api/inbox/read", "POST", { session_id: sessionId }],
      ["/api/turns", "GET"], [`/api/turns/${target.turn.id}?input=true&attempts=true`, "GET"],
      [`/api/turns/${target.turn.id}/trace`, "GET"], [`/api/turns/${target.turn.id}/cancel`, "POST", {}], [`/api/turns/${target.turn.id}/wrap-up`, "POST", {}], [`/api/turns/${target.turn.id}/retry`, "POST", {}],
      [`/api/attachments/${attachment.id}`, "GET"], [`/api/attachments/${attachment.id}/download`, "GET"], [`/api/attachments/${attachment.id}/content`, "GET"],
    ] as const) expect((await f.request(path, method, body, token.token)).status, `${method} ${path}`).toBe(401);
    expect((await f.app.request(`/api/attachments/${attachment.id}/content`, { method: "HEAD", headers: { Authorization: `Bearer ${token.token}` } })).status).toBe(401);
    const form = new FormData(); form.set("message", JSON.stringify({ body_md: "Forbidden" })); form.append("file", new File(["bytes"], "forbidden.txt"));
    expect((await f.app.request(`/api/sessions/${sessionId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${token.token}` }, body: form })).status).toBe(401);
    expect((await createMultiremiApp({ store: f.store, authToken: null }).request(`/api/messages/${message.id}`, { headers: { Authorization: `Bearer ${token.token}` } })).status).toBe(401);
    expect(f.snapshot()).toEqual(before); expect(f.store.getConversationLogHead(sessionId)?.headSeq).toBe(head);
    expect(f.store.getMessage(message.id)?.body_md).toBe("Editable"); expect(f.store.getMessage(message.id)?.resolved_at).toBeNull();
    expect(f.store.listCommentReactionsForComments([message.id]).get(message.id) ?? []).toEqual([]);
    const fresh = await f.store.createTaskAccessToken(f.store.getTask(replacement.current_attempt_id!)!, "local");
    for (const app of [f.app, openApp]) for (const authorization of [`Bearer  ${fresh.token}`, `bearer ${fresh.token}`, `bEaReR\t ${fresh.token}`]) {
      expect((await app.request(`/api/sessions/${sessionId}/messages`, { headers: { Authorization: authorization } })).status).toBe(200);
    }
    expect((await f.request(`/api/messages/${message.id}`, "GET", undefined, fresh.token)).status).toBe(200);
    expect((await f.request(`/api/attachments/${attachment.id}`, "GET", undefined, fresh.token)).status).toBe(200);
    for (const field of ["agent_id", "workspace_id"] as const) {
      f.db.run(`UPDATE multiremi_access_tokens SET ${field}=? WHERE id=?`, ["mismatched", fresh.id]);
      expect(await f.store.verifyAccessToken(fresh.token)).toBeNull();
      f.db.run(`UPDATE multiremi_access_tokens SET ${field}=? WHERE id=?`, [field === "agent_id" ? f.agent.id : "local", fresh.id]);
    }
  });

  it("B3 guardrail: HTTP, WS facts, projector, attachments and inbox counts/cursors agree on the same Chat", async () => {
    const f = await scaffold(), s = await stream(f);
    const chat = f.store.createChatSession({ agentId: f.agent.id, creatorId: f.user.id });
    const message = f.send("Chat body", { type: "member", ref: f.member.id }, chat.id);
    const attachment = f.store.createAttachment({ workspaceId: "local", chatSessionId: chat.id, chatMessageId: message.id,
      filename: "chat.txt", contentType: "text/plain", sizeBytes: 4, url: "https://example.invalid/chat.txt" });
    try {
      for (const visible of [true, false, true]) {
        f.store.updateAgent(f.agent.id, { visibility: visible ? "workspace" : "private", ownerId: "local" });
        f.db.run("UPDATE multiremi_session_lanes SET cursor_seq=0 WHERE session_id=? AND reader_type='member'", [chat.id]);
        expect((await f.request(`/api/sessions/${chat.id}/messages`)).status).toBe(visible ? 200 : 403);
        expect((await f.request(`/api/sessions/${chat.id}/log`)).status).toBe(visible ? 200 : 403);
        expect(await s.allowed(chat.id, f.user.id)).toBe(visible);
        expect(await s.allowed(chat.id, "local")).toBe(false);
        const frames = await s.project(chat.id, message.id, f.user.id);
        expect(JSON.stringify(frames).includes("Chat body")).toBe(visible);
        for (const suffix of ["", "/download", "/content"]) {
          const response = await f.app.request(`/api/attachments/${attachment.id}${suffix}`, { headers: { Authorization: `Bearer ${f.pat.token}` } });
          expect(response.status).toBe(visible ? suffix ? 302 : 200 : 403);
        }
        const page = await f.request("/api/inbox?limit=1");
        expect(page.data.items.map((m: any) => m.id)).toEqual(visible ? [message.id] : []);
        expect(page.data.unread_count).toBe(visible ? 1 : 0); expect(page.data.next_cursor).toBeNull();
        expect((await f.request("/api/inbox/read", "POST", { all: true })).data.conversations_read).toBe(visible ? 1 : 0);
        expect(f.lane(chat.id)).toBe(visible ? message.seq : 0);
      }
      // Owning the private agent cannot replace active membership.
      f.store.updateAgent(f.agent.id, { visibility: "private", ownerId: f.user.id });
      f.db.run("UPDATE multiremi_workspace_members SET archived_at=? WHERE id=?", [new Date().toISOString(), f.member.id]);
      expect((await f.request(`/api/sessions/${chat.id}/messages`)).status).toBe(404);
      expect(await s.allowed(chat.id, f.user.id)).toBe(false);
      expect(await s.project(chat.id, message.id, f.user.id)).toEqual([]);
    } finally { await s.pool.close(); }
  });

  it("B5: foreign or missing parent_owner rejects JSON and multipart without any rows, heads, events or files", async () => {
    const f = await scaffold();
    const foreign = f.store.createWorkspace({ name: "Foreign" });
    const parent = f.store.createIssue({ workspaceId: foreign.id, title: "Foreign unassigned parent" });
    const parentSessions = f.store.listIssueSessions(parent.id);
    const directory = mkdtempSync(join(tmpdir(), "mul508-role-")), previous = process.env.MULTIREMI_UPLOAD_DIR;
    process.env.MULTIREMI_UPLOAD_DIR = directory;
    let events = 0;
    const unsubscribe = f.store.onTaskEnqueued(() => { events++; });
    try {
      for (const parentId of [parent.id, "iss_missing"]) {
        f.db.run("UPDATE multiremi_issues SET parent_issue_id=? WHERE id=?", [parentId, f.issue.id]);
        const before = f.snapshot();
        const body = { body_md: "Foreign write", to: { type: "role", ref: "parent_owner" } };
        expect((await f.request(`/api/sessions/${f.session.id}/messages`, "POST", body)).status).toBe(400);
        const form = new FormData(); form.set("message", JSON.stringify(body)); form.append("file", new File(["bytes"], "role.txt"));
        expect((await f.app.request(`/api/sessions/${f.session.id}/messages`, { method: "POST", headers: { Authorization: `Bearer ${f.pat.token}` }, body: form })).status).toBe(400);
        expect(f.snapshot()).toEqual(before); expect(events).toBe(0);
        expect(f.store.listIssueSessions(parent.id)).toEqual(parentSessions);
        expect(readdirSync(directory, { recursive: true }).filter(p => String(p).endsWith(".txt"))).toEqual([]);
      }
      const localParent = f.store.createIssue({ title: "Local unassigned parent" });
      f.db.run("UPDATE multiremi_issues SET parent_issue_id=? WHERE id=?", [localParent.id, f.issue.id]);
      const result = await f.request(`/api/sessions/${f.session.id}/messages`, "POST", { body_md: "Local write", to: { type: "role", ref: "parent_owner" } });
      expect(result.status).toBe(200);
      expect(result.data.message.session_id).toBe(f.store.getOrCreateDefaultIssueSession(localParent.id).id);
      const localSession = f.store.getOrCreateDefaultIssueSession(localParent.id);
      f.db.run("UPDATE multiremi_issue_sessions SET workspace_id=? WHERE id=?", [foreign.id, localSession.id]);
      const before = f.snapshot();
      expect((await f.request(`/api/sessions/${f.session.id}/messages`, "POST", { body_md: "Misplaced parent session", to: { type: "role", ref: "parent_owner" } })).status).toBe(400);
      expect(f.snapshot()).toEqual(before);
    } finally {
      unsubscribe(); if (previous === undefined) delete process.env.MULTIREMI_UPLOAD_DIR; else process.env.MULTIREMI_UPLOAD_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("B6 guardrail: moved-source decision, reply and marker stay hidden across HTTP, projector, attachments, counts and read cursors", async () => {
    const f = await scaffold(), s = await stream(f);
    const parent = f.store.createIssue({ title: "Parent" }), parentSession = f.store.getOrCreateDefaultIssueSession(parent.id);
    const child = f.store.createIssue({ title: "Child", parentIssueId: parent.id });
    const decision = f.store.createIssueDecision(child.id, { kind: "production_change", title: "Moved source decision" }, { type: "member", id: f.member.id, taskId: null });
    const q = f.store.getMessage(decision.id)!;
    f.db.run("UPDATE multiremi_conversation_log SET to_member_id=? WHERE id=?", [f.member.id, q.id]);
    const attachment = f.store.createAttachment({ workspaceId: "local", issueId: parent.id, commentId: q.id, filename: "decision.txt", contentType: "text/plain", sizeBytes: 4, url: "https://example.invalid/decision.txt" });
    const reply = f.store.sendMessage({ session_id: parentSession.id, sender: { type: "member", id: f.member.id }, to: { type: "member", ref: f.member.id },
      message_kind: "reply", wake_requested: "inbox_only", body_md: "Moved source reply", reply_to_id: q.id, metadata: { human_response: { answer: "Yes" } } }).message;
    f.store.editMessage(q.id, { body_md: "Moved source edited decision" });
    const marker = f.store.listConversationLogEntries(parentSession.id).find(e => e.kind === "message_edited")!;
    const foreign = f.store.createWorkspace({ name: "Target" });
    f.store.updateIssue(child.id, { parentIssueId: null }); f.store.updateIssue(child.id, { workspaceId: foreign.id });
    try {
      expect(await s.allowed(parentSession.id, f.user.id)).toBe(true);
      for (const row of [q, reply, marker]) {
        expect((await f.request(`/api/sessions/${parentSession.id}/log/entry?id=${row.id}`)).status).toBe(404);
        const projected = await s.project(parentSession.id, row.id, f.user.id);
        expect(projected[0]?.payload).toMatchObject({ visibility: "hidden" });
        expect(JSON.stringify(projected)).not.toContain("Moved source");
      }
      expect((await f.request(`/api/messages/${q.id}`)).status).toBe(404);
      expect((await f.request(`/api/messages/${reply.id}`)).status).toBe(404);
      expect((await f.request(`/api/sessions/${parentSession.id}/messages`)).data.messages).toEqual([]);
      expect((await f.request(`/api/sessions/${parentSession.id}/log/locate?id=${q.id}`)).status).toBe(404);
      expect((await f.request(`/api/sessions/${parentSession.id}/messages`, "POST", { reply_to_id: q.id, body_md: "Forbidden answer" })).status).toBe(404);
      for (const suffix of ["", "/download", "/content"]) expect((await f.request(`/api/attachments/${attachment.id}${suffix}`)).status).toBe(404);
      const hidden = await f.request("/api/inbox?limit=1");
      expect(hidden.data).toMatchObject({ items: [], unread_count: 0, attention_count: 0, next_cursor: null });
      expect((await f.request("/api/inbox/read", "POST", { all: true })).data.conversations_read).toBe(0);
      expect((await f.request("/api/inbox/read", "POST", { session_id: parentSession.id, to_seq: reply.seq })).data.cursor_seq).toBe(0);
      expect(f.lane(parentSession.id)).toBe(0);
      const visible = f.send("Visible inbox row", { type: "member", ref: f.member.id }, parentSession.id);
      const second = f.send("Second visible row", { type: "member", ref: f.member.id }, parentSession.id);
      const page = await f.request("/api/inbox?limit=1");
      expect(page.data.unread_count).toBe(2); expect(page.data.items[0].id).toBe(second.id);
      const next = await f.request(`/api/inbox?limit=1&cursor=${page.data.next_cursor}`);
      expect(next.data.items.map((m: any) => m.id)).toEqual([visible.id]); expect(next.data.next_cursor).toBeNull(); expect(next.data.unread_count).toBe(2);
      expect((await f.request("/api/inbox/read", "POST", { session_id: parentSession.id, to_seq: visible.seq })).data.cursor_seq).toBe(visible.seq);
      expect((await f.request("/api/inbox")).data.unread_count).toBe(1);
      expect((await f.request("/api/inbox/read", "POST", { all: true })).data.conversations_read).toBe(1);
      expect(f.lane(parentSession.id)).toBe(second.seq); expect((await f.request("/api/inbox")).data.unread_count).toBe(0);
    } finally { await s.pool.close(); }
  });

  it("B6: agent counts and per-scope read-all use the same private human-request visibility as the list", async () => {
    const f = await scaffold(), caller = f.running();
    const token = await f.store.createTaskAccessToken(caller.task, f.user.id);
    const visible = f.send("Visible agent inbox row", { type: "agent", ref: f.agent.id });
    const before = (await f.request("/api/inbox", "GET", undefined, token.token)).data.unread_count;
    const privateAgent = f.store.createAgent({ name: "Private source", provider: "codex", visibility: "private", ownerId: "local" });
    const task = f.store.createTask({ agentId: privateAgent.id, issueId: f.issue.id, prompt: "Private source" });
    f.db.run("UPDATE multiremi_turns SET status='running' WHERE current_attempt_id=?", [task.id]);
    f.db.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?", [task.id]);
    const request = f.store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { questions: [{ question: "Private?" }] } });
    const metadata = { ...f.store.getMessage(request.id)!.metadata, execution_scope: "private_scope" };
    f.db.run("UPDATE multiremi_conversation_log SET to_member_id=NULL,to_agent_id=?,metadata=? WHERE id=?", [f.agent.id, JSON.stringify(metadata), request.id]);
    expect((await f.request(`/api/messages/${request.id}`, "GET", undefined, token.token)).status).toBe(404);
    const inbox = await f.request("/api/inbox?limit=1", "GET", undefined, token.token);
    expect(inbox.data.unread_count).toBe(before); expect(inbox.data.items[0].id).toBe(visible.id);
    expect((await f.request("/api/inbox/read", "POST", { all: true }, token.token)).data.conversations_read).toBe(1);
    expect(f.lane(f.session.id, "agent", f.agent.id)).toBe(visible.seq);
    expect(f.lane(f.session.id, "agent", f.agent.id, "private_scope")).toBe(0);
    expect((await f.request("/api/inbox", "GET", undefined, token.token)).data.unread_count).toBe(0);
    expect((await f.request("/api/inbox/read", "POST", { session_id: f.session.id }, token.token)).status).toBe(200);
    expect(f.lane(f.session.id, "agent", f.agent.id, "private_scope")).toBe(0);
  });

  for (const kind of ["decision", "question", "permission"] as const) it(`B7: ${kind} cannot resolve or reopen and remains answerable through its state machine`, async () => {
    const f = await scaffold(), running = kind === "decision" ? null : f.running();
    const message = running ? f.store.getMessage(f.store.createTaskHumanRequest({ taskId: running.task.id, kind: kind as "question" | "permission",
      payload: kind === "question" ? { questions: [{ question: "Continue?" }] } : { options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow" }] },
    }).id)! : f.store.sendMessage({ session_id: f.session.id, sender: { type: "agent", id: f.agent.id }, to: { type: "member", ref: f.member.id },
      message_kind: "decision", wake_requested: "now", body_md: "Choose", options: [{ label: "Yes", value: "yes" }] }).message;
    const before = f.store.getConversationLogHead(f.session.id)!.headSeq;
    for (const resolved of [true, false]) {
      expect((await f.request(`/api/messages/${message.id}/resolve`, "POST", { resolved })).status).toBe(409);
      expect(() => f.store.resolveMessage(message.id, { type: "member", id: f.member.id }, resolved)).toThrow("response state machine");
    }
    expect(f.store.getMessage(message.id)?.resolved_at).toBeNull(); expect(f.store.getConversationLogHead(f.session.id)?.headSeq).toBe(before);
    if (running) { expect(f.store.getTaskHumanRequest(message.id)?.status).toBe("pending"); expect(f.store.getTurn(running.turn.id)?.status).toBe("awaiting_human"); }
    const response = kind === "decision" ? { metadata: { selected_options: ["yes"] } }
      : { response: kind === "question" ? { answers: { "Continue?": "Yes" } } : { option_id: "allow_once" } };
    const answered = await f.request(`/api/sessions/${f.session.id}/messages`, "POST", { reply_to_id: message.id, ...response });
    expect(answered.status).toBe(200); expect(f.store.getMessage(message.id)?.resolved_at).toBeTruthy();
    expect((await f.request(`/api/messages/${message.id}/resolve`, "POST", { resolved: false })).status).toBe(409);
    expect((await f.request(`/api/sessions/${f.session.id}/messages`, "POST", { reply_to_id: message.id, ...response })).status).toBe(409);
    if (running) { expect(f.store.getTaskHumanRequest(message.id)?.status).toBe("responded"); expect(f.store.getTurn(running.turn.id)?.status).toBe("running"); }
  });

  it("B3/R4: real WS subscriptions share HTTP Chat agent and auto conversation authorization", async () => {
    const f = await scaffold(), s = await stream(f);
    const chat = f.store.createChatSession({ agentId: f.agent.id, creatorId: f.user.id });
    f.send("WS chat body", { type: "member", ref: f.member.id }, chat.id);
    const auto = f.store.createAutopilot({ title: "Auto", assigneeId: f.agent.id, executionMode: "run_only" });
    f.store.runAutopilot(auto.id);
    const orphan = "auto_orphan_inbox_local";
    f.store.ensureConversationLogHead(orphan, { bodyMd: "Orphan" });
    const hub = createHub({ transport: createLocalHubTransport(), fill: createConversationLogFillReader(f.store, s.pool) });
    const server = startMultiremiServer({ store: f.store, liveHub: hub, readPool: s.pool, authToken: "access-master", scheduler: null, port: 0, hostname: "127.0.0.1" });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=local`), events: any[] = [];
    socket.addEventListener("message", e => events.push(JSON.parse(String(e.data))));
    const wait = async (check: () => boolean) => { const end = Date.now() + 2500; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true); };
    try {
      await authenticateBrowserWebSocket(socket, f.pat.token);
      const subscribe = async (id: string, allowed: boolean) => {
        const before = events.length;
        socket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "log", id, from_seq: 0 } }));
        await wait(() => events.slice(before).some(e => e.type === (allowed ? "stream.ack" : "stream.error")));
        if (!allowed) expect(events.slice(before).find(e => e.type === "stream.error").payload.code).toBe("forbidden");
      };
      await subscribe(chat.id, true);
      await wait(() => events.some(e => JSON.stringify(e).includes("WS chat body")));
      f.store.updateAgent(f.agent.id, { visibility: "private", ownerId: "local" });
      expect((await f.request(`/api/sessions/${chat.id}/messages`)).status).toBe(403);
      await subscribe(chat.id, false);
      for (const id of [`auto_${auto.id}`, orphan]) {
        expect((await f.request(`/api/sessions/${id}/messages`)).status).toBe(200);
        expect(await s.allowed(id, f.user.id)).toBe(true); expect(await s.allowed(id, "outside")).toBe(false);
        expect(await s.allowed(id, f.user.id, "other_workspace")).toBe(false);
        await subscribe(id, true);
      }
      for (const id of ["auto_missing", "auto_orphan_inbox_missing"]) {
        expect((await f.request(`/api/sessions/${id}/messages`)).status).toBe(404);
        expect(await s.allowed(id, f.user.id)).toBe(false); await subscribe(id, false);
      }
    } finally { socket.close(); server.stop(true); hub.shutdown(); await s.pool.close(); }
  });
});

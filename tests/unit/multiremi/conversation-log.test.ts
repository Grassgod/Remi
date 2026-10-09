import { createResponsibleTestIssue } from './helpers.js';
import { requestMessageBody } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import type { ConversationLogEntry, ConversationLogPatch } from "@multiremi/contracts/conversation-log";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

afterEach(resetMultiremiTestEnv);

describe("conversation log (MUL-426)", () => {
  it("locates comments and pages by seq while hiding lifecycle markers", () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "Window", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const comments = Array.from({ length: 5 }, (_, index) =>
      store.createIssueComment(issue.id, { issueSessionId: session.id, body: `message ${index}` }));

    const located = store.locateConversationLogEntry(session.id, comments[2]!.id);
    expect(located?.id).toBe(comments[2]!.id);
    const window = store.conversationLogWindow(session.id, { before: 2 });
    expect(window.entries.map((entry) => entry.id)).toEqual(comments.slice(-2).map((comment) => comment.id));
    expect(window.entries.every((entry) => entry.visibility === "shown")).toBe(true);
    expect(window.has_more_before).toBe(true);
    expect(window.has_more_after).toBe(false);
    expect(window.before_visible_count).toBe(3);
    expect(window.before_visible_count_capped).toBe(false);
    expect(window.head_seq).toBe(located!.head_seq);
    expect(store.conversationLogWindow(session.id, { anchor: located!.seq, before: 1, after: 1 })
      .entries.map((entry) => entry.id)).toEqual([comments[2]!.id, comments[3]!.id]);
  });

  it("returns the same 404 for hidden, deleted and missing locate ids", async () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "Locate visibility", workspaceId: "local" });
    const comment = store.createIssueComment(issue.id, { body: "remove me" });
    const sessionId = comment.issueSessionId!;
    store.editMessage(comment.id, { body_md: "edited" });
    const hidden = store.listConversationLogEntries(sessionId).find((entry) => entry.kind === "message_edited")!;
    store.deleteMessage(comment.id);
    const app = createMultiremiApp({ store });
    const bodies = [];
    for (const id of [hidden.id, comment.id, "clog_missing"]) {
      const response = await app.request(`/api/sessions/${sessionId}/log/locate?id=${id}`);
      expect(response.status).toBe(404);
      bodies.push(await response.json());
      expect(store.locateConversationLogEntry(sessionId, id)).toBeNull();
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });

  it("updates comments in place, emits resolved patches, and appends hidden resolve markers", () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "Patches", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const emitted: Array<ConversationLogEntry | ConversationLogPatch> = [];
    store.setConversationLogListener({ onEntry: (_sessionId, entry) => emitted.push(entry) });
    const comment = store.createIssueComment(issue.id, { issueSessionId: session.id, body: "first" });
    const original = store.getConversationLogEntryById(comment.id)!;
    store.resolveIssueComment(comment.id, { actorType: "member", actorId: "local" });
    store.unresolveIssueComment(comment.id);
    const patches = emitted.filter((entry): entry is ConversationLogPatch => "target_seq" in entry && (entry.fields.resolved_at !== undefined));
    expect(patches.map((patch) => patch.revision)).toEqual([original.revision + 1, original.revision + 2]);
    expect(patches[0]!.fields).toMatchObject({
      resolved_at: expect.any(String), resolved_by_type: "member", resolved_by_id: "local",
    });
    expect(patches[1]!.fields).toMatchObject({
      resolved_at: null, resolved_by_type: null, resolved_by_id: null,
    });
    expect("session_id" in patches[0]!).toBe(false);
    expect(store.getConversationLogEntryById(comment.id)?.revision).toBe(original.revision + 2);
    expect(store.conversationLogWindow(session.id, { before: 30 }).entries.some((entry) => entry.kind.startsWith("thread_"))).toBe(false);
    // Ruling (m), cmt_s8kpg7mhyd7g: mirror hidden resolve markers per Senior ruling ③.
    expect(store.listConversationLogEntries(session.id).filter((entry) => entry.kind.includes("resolved"))
      .map((entry) => ({ kind: entry.kind, visibility: entry.visibility, seq: entry.seq, target_seq: entry.metadata.target_seq })))
      .toEqual([
        { kind: "thread_resolved", visibility: "hidden", seq: 2, target_seq: 1 },
        { kind: "thread_unresolved", visibility: "hidden", seq: 3, target_seq: 1 },
      ]);

    store.updateIssueComment(comment.id, { body: "second" });
    const edited = store.getConversationLogEntryById(comment.id)!;
    expect(edited.body_md).toBe("second");
    expect(edited.revision).toBe(original.revision + 3);
    expect(store.listConversationLogEntries(session.id).find((entry) => entry.kind === "message_edited")?.metadata)
      .toMatchObject({ target_seq: original.seq, body: "second", previous_body: "first" });
    store.deleteIssueComment(comment.id);
    const deleted = store.getConversationLogEntryById(comment.id)!;
    expect(deleted.body_md).toBe("");
    expect(deleted.deleted_at).toBeString();
    expect(deleted.metadata.deleted_body).toBe("second");
    expect(store.listConversationLogEntries(session.id).find((entry) => entry.kind === "message_deleted")?.metadata.target_seq)
      .toBe(original.seq);
  });

  it("clears a resolved root in place when a reply reopens its thread", () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "Thread", workspaceId: "local" });
    const root = store.createIssueComment(issue.id, { body: "root" });
    const sessionId = root.issueSessionId!;
    store.resolveIssueComment(root.id);
    const before = store.getConversationLogEntryById(root.id)!;
    const patches: ConversationLogPatch[] = [];
    store.setConversationLogListener({ onEntry: (_sessionId, entry) => {
      if ("target_seq" in entry) patches.push(entry);
    } });
    store.createIssueComment(issue.id, { body: "reply", parentId: root.id });
    expect(store.getConversationLogEntryById(root.id)).toMatchObject({
      revision: before.revision + 1, resolved_at: null, resolved_by_type: null, resolved_by_id: null,
    });
    expect(patches[0]?.fields).toMatchObject({
      resolved_at: null, resolved_by_type: null, resolved_by_id: null,
    });
    expect(store.conversationLogWindow(sessionId, { before: 30 }).entries.some((entry) => entry.kind.startsWith("thread_"))).toBe(false);
    // Ruling (m), cmt_s8kpg7mhyd7g: mirror hidden resolve markers per Senior ruling ③.
    expect(store.listConversationLogEntries(sessionId).filter((entry) => entry.kind.includes("resolved"))
      .map((entry) => ({ kind: entry.kind, visibility: entry.visibility, seq: entry.seq, target_seq: entry.metadata.target_seq })))
      .toEqual([{ kind: "thread_resolved", visibility: "hidden", seq: 2, target_seq: 1 }]);
  });

  it("rolls back a log append together with its allocated seq", () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, {title:"Rollback",workspaceId:"local"});
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const before = store.getConversationLogHead(session.id);
    expect(() => db!.transaction(() => {
      store.appendConversationLogWithinTransaction({ sessionId: session.id, kind: "message", authorType: "system", bodyMd: "discard" });
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(store.getConversationLogHead(session.id)).toEqual(before);
    expect(store.listConversationLogEntries(session.id)).toEqual([]);
  });

  it("rolls back a comment when its log mirror fails", () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "Atomic", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    db!.exec(`CREATE TRIGGER reject_comment_log BEFORE INSERT ON multiremi_conversation_log
      WHEN NEW.kind = 'message' BEGIN SELECT RAISE(ABORT, 'log rejected'); END`);
    expect(() => store.createIssueComment(issue.id, { issueSessionId: session.id, body: "discard" }))
      .toThrow("log rejected");
    expect(store.listIssueComments(issue.id)).toEqual([]);
    expect(store.listConversationLogEntries(session.id).filter((entry) => entry.kind === "message")).toEqual([]);
  });

  it("caps the visible count and validates the HTTP window and locate requests", async () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "HTTP window", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    for (let index = 0; index < 1002; index++) {
      store.appendConversationLog({ sessionId: session.id, kind: "message", authorType: "system", bodyMd: `${index}` });
    }
    const window = store.conversationLogWindow(session.id, { before: 1 });
    expect(window.before_visible_count).toBe(1000);
    expect(window.before_visible_count_capped).toBe(true);

    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/sessions/${session.id}/log?before=2`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries.map((entry: ConversationLogEntry) => entry.body_md)).toEqual(["1000", "1001"]);
    const located = await app.request(`/api/sessions/${session.id}/log/locate?id=${body.entries[0].id}`);
    expect((await located.json()).seq).toBe(body.entries[0].seq);
    expect((await app.request(`/api/sessions/${session.id}/log?before=100&after=1`)).status).toBe(400);
    expect((await app.request(`/api/sessions/${session.id}/log/locate`)).status).toBe(400);
    const expanded = await app.request(`/api/sessions/${session.id}/log/entry?seq=${body.entries[0].seq}`);
    expect(expanded.status).toBe(200); expect((await expanded.json()).id).toBe(body.entries[0].id);
    expect((await app.request(`/api/sessions/${session.id}/log/entry`)).status).toBe(400);
  });

  it("syncs Issue and Chat heads and keeps the canonical chat dedupe key", async () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "Initial issue", description: "Initial body", workspaceId: "local" });
    const first = store.getOrCreateDefaultIssueSession(issue.id);
    const second = store.createIssueSession(issue.id, { title: "Review" });
    expect(store.getConversationLogEntry(first.id, 0)?.body_md).toBe("Initial issue\n\nInitial body");
    expect(store.getConversationLogEntry(first.id, 0)?.metadata.title).toBe("Initial issue");
    expect(store.listConversationLogEntries(second.id).some((entry) => entry.kind === "session_created")).toBe(true);
    store.updateIssue(issue.id, { title: "Renamed issue", description: "Changed body" });
    for (const session of [first, second]) {
      expect(store.getConversationLogEntry(session.id, 0)).toMatchObject({
        body_md: "Renamed issue\n\nChanged body", revision: 2, metadata: { title: "Renamed issue" },
      });
    }

    const literalTitle = "# *[x]* `title`";
    store.updateIssue(issue.id, { title: literalTitle, description: literalTitle });
    expect(store.getConversationLogEntry(first.id, 0)).toMatchObject({
      body_md: `${literalTitle}\n\n${literalTitle}`, metadata: { title: literalTitle },
    });

    const agent = store.createAgent({ name: "Chat agent", provider: "codex", visibility: "workspace" });
    const chat = store.createChatSession({ agentId: agent.id, title: "Initial chat" });
    store.updateChatSession(chat.id, { title: "Renamed chat" });
    expect(store.getConversationLogEntry(chat.id, 0)).toMatchObject({ body_md: "Renamed chat", revision: 2 });
    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/sessions/${chat.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestMessageBody(store, { body_md: "hello", dedupe_key: "client-42" }, { type: "agent", ref: store.getChatSession(chat.id)!.agentId })),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(store.getMessage(body.message.id)?.dedupe_key).toBe("client-42");
  });

  it("hydrates Chat user, push and final attachments from current message links", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Attachment agent", provider: "codex", visibility: "workspace" });
    const chat = store.createChatSession({ agentId: agent.id, title: "Attachments" });
    const attachment = (filename: string) => store.createAttachment({
      chatSessionId: chat.id, workspaceId: "local", filename,
      url: `/api/attachments/${filename}/content`, contentType: "text/plain", sizeBytes: 12,
    });
    const userFile = attachment("user.txt");
    const sent = store.sendChatMessage(chat.id, { content: "user upload", attachmentIds: [userFile.id] });
    const push = store.sendMessage({session_id:chat.id,sender:{type:"agent",id:agent.id},source_turn_id:store.getTurnForAttempt(sent.task.id)!.id,to:{type:"none"},message_kind:"report",wake_requested:"inbox_only",body_md:"push upload",metadata:{elapsed_ms:null}}).message;
    const pushFile = attachment("push.txt");
    store.linkAttachmentsToChatMessage(chat.id, push.id, [pushFile.id]);
    const final = db!.transaction(() => store.appendChatMessageWithinTransaction({
      chatSessionId: chat.id, taskId: sent.task.id, role: "assistant", body: "final reply", elapsedMs: 10,
    }))();
    const finalFile = attachment("final.txt");
    store.linkAttachmentsToChatMessage(chat.id, final.id, [finalFile.id]);

    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/sessions/${chat.id}/log?before=30`);
    expect(response.status).toBe(200);
    const rows = (await response.json()).entries as Array<{ id: string; metadata: {
      attachments: Array<{ id: string; filename: string }>; reactions?: unknown[]; elapsed_ms?: number | null;
    } }>;
    for (const [id, file] of [[sent.message.id, userFile], [push.id, pushFile], [final.id, finalFile]] as const) {
      expect(rows.find(row => row.id === id)?.metadata.attachments).toMatchObject([{ id: file.id, filename: file.filename }]);
      expect(rows.find(row => row.id === id)?.metadata).not.toHaveProperty("reactions");
    }
    expect(rows.find(row => row.id === push.id)?.metadata.elapsed_ms).toBeNull();
    expect(rows.find(row => row.id === final.id)?.metadata.elapsed_ms).toBe(10);
    const seq = store.getConversationLogEntryById(push.id)!.seq;
    const one = await app.request(`/api/sessions/${chat.id}/log?anchor=${seq}&before=1&after=0`);
    expect((await one.json()).entries[0].metadata.attachments).toMatchObject([{ id: pushFile.id }]);

    db!.run("UPDATE multiremi_attachments SET chat_message_id = NULL WHERE id = ?", [pushFile.id]);
    const updated = await app.request(`/api/sessions/${chat.id}/log?anchor=${seq}&before=1&after=0`);
    expect((await updated.json()).entries[0].metadata.attachments).toEqual([]);
  });

  it("reads historical Chat rows from the canonical log after cutover", async () => {
    const store = createStore();
    const agent = store.createAgent({name:"History agent",provider:"codex",visibility:"workspace"});
    const chat = store.createChatSession({agentId:agent.id,title:"History"});
    const historical = db!.transaction(() => store.appendChatMessageWithinTransaction({chatSessionId:chat.id,role:"system",body:"old message",createdAt:"2026-01-01T00:00:00.000Z"}))();
    const sent = store.sendChatMessage(chat.id,{content:"new message"});
    expect(store.getConversationLogEntryById(historical.id)?.seq).toBe(1);
    expect(store.getConversationLogEntryById(sent.message.id)?.seq).toBeGreaterThan(1);
    const app = createMultiremiApp({store});
    const window = await (await app.request(`/api/sessions/${chat.id}/log?before=10`)).json();
    expect(window.entries.filter((entry:{kind:string})=>entry.kind==="message").map((entry:{body_md:string})=>entry.body_md)).toEqual(["old message","new message"]);
    expect(store.listChatMessagesFromLog(chat.id).map(message=>message.body)).toEqual(["old message","new message"]);
    expect((await app.request(`/api/sessions/${chat.id}/messages`)).status).toBe(200);
    expect((await app.request(`/api/chat/sessions/${chat.id}/messages/page?limit=1`)).status).toBe(404);
  });
});

pendingTurnBackendTests("read-only display log", fixture => {
  for (const kind of ["Issue", "Chat"] as const) it(`${kind}: task capability display reads leave every agent lane field unchanged`, async () => {
    const { store, db } = fixture();
    const agent = store.createAgent({ name: "Display reader", provider: "codex", visibility: "workspace" });
    const issue = kind === "Issue" ? createResponsibleTestIssue(store, { title: "Display Issue", assigneeType: "agent", assigneeId: agent.id }) : null;
    const sessionId = issue ? store.getOrCreateDefaultIssueSession(issue.id).id : store.createChatSession({ agentId: agent.id, creatorId: "local" }).id;
    const sent = store.sendMessage({ session_id: sessionId, sender: { type: "member", id: "mem_local_local" }, to: { type: "agent", ref: agent.id }, message_kind: "request", body_md: "Display input", wake_requested: "now" });
    const turn = store.getTurn(sent.turn_id!)!;
    const token = await store.createAccessToken({ type: "task", name: "Display reader", taskId: turn.current_attempt_id!, agentId: agent.id, userId: "local", workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "display-master" }), headers = { Authorization: `Bearer ${token.token}` };
    const lanes = () => db.query("SELECT * FROM multiremi_session_lanes WHERE session_id=? ORDER BY reader_type,reader_id,execution_scope").all(sessionId);
    const before = lanes(), path = `/api/sessions/${sessionId}/log`;
    for (const suffix of ["", `/locate?id=${sent.message.id}`, `/entry?id=${sent.message.id}`, `/entry?seq=${sent.message.seq}`]) {
      const response = await app.request(path + suffix, { headers }); expect(response.status, suffix).toBe(200);
      expect(lanes()).toEqual(before);
    }
    const card = await app.request(`${path}/entry?seq=${turn.seq}`, { headers });
    expect(card.status).toBe(kind === "Issue" ? 200 : 404); expect(lanes()).toEqual(before);
    for (const query of ["from=0", `to=${sent.message.seq}`, `from=0&to=${sent.message.seq}`]) {
      const response = await app.request(`${path}?${query}`, { headers }); expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("remi message list"); expect(lanes()).toEqual(before);
    }
    const range = await app.request(`/api/sessions/${sessionId}/messages?from=0&to=${sent.message.seq}`, { headers });
    expect(range.status).toBe(200); expect(store.getSessionAgentReadProgress(sessionId, agent.id).seq).toBe(sent.message.seq);
  });
});

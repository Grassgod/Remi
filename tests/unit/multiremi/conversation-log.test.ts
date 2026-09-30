import { afterEach, describe, expect, it } from "bun:test";
import type { ConversationLogEntry, ConversationLogPatch } from "@multiremi/contracts/conversation-log";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("conversation log (MUL-426)", () => {
  it("locates comments and pages by seq while hiding lifecycle markers", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Window", workspaceId: "local" });
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
    const issue = store.createIssue({ title: "Locate visibility", workspaceId: "local" });
    const comment = store.createIssueComment(issue.id, { body: "remove me" });
    const sessionId = comment.issueSessionId!;
    store.updateIssueComment(comment.id, { body: "edited" });
    const hidden = store.listConversationLogEntries(sessionId).find((entry) => entry.kind === "message_edited")!;
    store.deleteIssueComment(comment.id);
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

  it("updates comments in place, emits resolved patches, and keeps thread markers hidden", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Patches", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const emitted: Array<ConversationLogEntry | ConversationLogPatch> = [];
    store.setConversationLogListener({ onEntry: (_sessionId, entry) => emitted.push(entry) });
    const comment = store.createIssueComment(issue.id, { issueSessionId: session.id, body: "first" });
    const original = store.getConversationLogEntryById(comment.id)!;
    store.resolveIssueComment(comment.id, { actorType: "member", actorId: "local" });
    store.unresolveIssueComment(comment.id);
    const patches = emitted.filter((entry): entry is ConversationLogPatch => "target_seq" in entry);
    expect(patches.map((patch) => patch.revision)).toEqual([original.revision + 1, original.revision + 2]);
    expect(patches[0]!.fields).toMatchObject({
      resolved_at: expect.any(String), resolved_by_type: "member", resolved_by_id: "local",
    });
    expect(patches[1]!.fields).toMatchObject({
      resolved_at: null, resolved_by_type: null, resolved_by_id: null,
    });
    expect("session_id" in patches[0]!).toBe(false);
    expect(store.getConversationLogEntryById(comment.id)?.revision).toBe(original.revision + 2);
    expect(store.listConversationLogEntries(session.id).filter((entry) => entry.kind.startsWith("thread_"))
      .map((entry) => [entry.kind, entry.visibility, entry.metadata.target_seq]))
      .toEqual([["thread_resolved", "hidden", original.seq], ["thread_unresolved", "hidden", original.seq]]);
    expect(store.conversationLogWindow(session.id, { before: 30 }).entries.some((entry) => entry.kind.startsWith("thread_"))).toBe(false);

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
    const issue = store.createIssue({ title: "Thread", workspaceId: "local" });
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
    expect(store.listConversationLogEntries(sessionId).filter((entry) => entry.kind.startsWith("thread_"))
      .map((entry) => [entry.kind, entry.visibility, entry.metadata.target_seq]))
      .toEqual([["thread_resolved", "hidden", before.seq]]);
    expect(store.conversationLogWindow(sessionId, { before: 30 }).entries.some((entry) => entry.kind.startsWith("thread_"))).toBe(false);
  });

  it("rolls back a log append together with its allocated seq", () => {
    const store = createStore();
    expect(() => db!.transaction(() => {
      store.appendConversationLogWithinTransaction({ sessionId: "ises_rollback", kind: "message", authorType: "system", bodyMd: "discard" });
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(store.getConversationLogHead("ises_rollback")).toBeNull();
    expect(store.listConversationLogEntries("ises_rollback")).toEqual([]);
  });

  it("rolls back a comment when its log mirror fails", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Atomic", workspaceId: "local" });
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
    const issue = store.createIssue({ title: "HTTP window", workspaceId: "local" });
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
  });

  it("syncs Issue and Chat heads and keeps a supplied chat client_id", async () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Initial issue", description: "Initial body", workspaceId: "local" });
    const first = store.getOrCreateDefaultIssueSession(issue.id);
    const second = store.createIssueSession(issue.id, { title: "Review" });
    expect(store.getConversationLogEntry(first.id, 0)?.body_md).toBe("Initial issue\n\nInitial body");
    expect(store.listConversationLogEntries(second.id).some((entry) => entry.kind === "session_created")).toBe(true);
    store.updateIssue(issue.id, { title: "Renamed issue", description: "Changed body" });
    for (const session of [first, second]) {
      expect(store.getConversationLogEntry(session.id, 0)).toMatchObject({
        body_md: "Renamed issue\n\nChanged body", revision: 2,
      });
    }

    const agent = store.createAgent({ name: "Chat agent", provider: "codex", visibility: "workspace" });
    const chat = store.createChatSession({ agentId: agent.id, title: "Initial chat" });
    store.updateChatSession(chat.id, { title: "Renamed chat" });
    expect(store.getConversationLogEntry(chat.id, 0)).toMatchObject({ body_md: "Renamed chat", revision: 2 });
    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/chat/sessions/${chat.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", client_id: "client-42" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(store.getConversationLogEntryById(body.message_id)?.metadata.client_id).toBe("client-42");
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
    const push = store.appendChatMessageWithinTransaction({
      chatSessionId: chat.id, taskId: sent.task.id, role: "assistant", body: "push upload",
    });
    const pushFile = attachment("push.txt");
    store.linkAttachmentsToChatMessage(chat.id, push.id, [pushFile.id]);
    const final = store.appendChatMessageWithinTransaction({
      chatSessionId: chat.id, taskId: sent.task.id, role: "assistant", body: "final reply", elapsedMs: 10,
    });
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

  it("retains an unbackfilled legacy row while new reads use the session log", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "History agent", provider: "codex", visibility: "workspace" });
    const chat = store.createChatSession({ agentId: agent.id, title: "History" });
    const createdAt = "2026-01-01T00:00:00.000Z";
    db!.run(
      `INSERT INTO multiremi_chat_messages (id, chat_session_id, role, body, sequence, created_at)
       VALUES (?, ?, 'system', 'old message', 1, ?)`,
      ["msg_old_history", chat.id, createdAt],
    );
    db!.run("UPDATE multiremi_chat_sessions SET message_sequence = 1 WHERE id = ?", [chat.id]);
    const sent = store.sendChatMessage(chat.id, { content: "new message" });
    expect(store.getConversationLogEntryById(sent.message.id)?.seq).toBe(2);

    const app = createMultiremiApp({ store });
    const window = await (await app.request(`/api/sessions/${chat.id}/log?before=10`)).json();
    expect(window.entries.filter((entry: { kind: string }) => entry.kind === "message")
      .map((entry: { body_md: string }) => entry.body_md)).toEqual(["new message"]);
    expect(store.listChatMessagesFromLog(chat.id).map(message => message.body)).toEqual(["old message", "new message"]);
    expect((await app.request(`/api/chat/sessions/${chat.id}/messages`)).status).toBe(404);
    expect((await app.request(`/api/chat/sessions/${chat.id}/messages/page?limit=1`)).status).toBe(404);
  });
});

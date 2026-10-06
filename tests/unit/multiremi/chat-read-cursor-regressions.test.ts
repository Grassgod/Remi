import { afterEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("MUL-509 Chat member read cursors", fixture => {
  afterEach(() => fixture().store.stopNotificationDeliverySweeper());

  function setup() {
    const { store, db } = fixture();
    const agent = store.createAgent({ name: "Chat agent", provider: "codex", visibility: "workspace" });
    const chat = store.createChatSession({ agentId: agent.id });
    const send = (body: string, memberId = "mem_local_local") => store.sendMessage({
      session_id: chat.id, sender: { type: "agent", id: agent.id }, to: { type: "member", ref: memberId },
      message_kind: "reply", wake_requested: "inbox_only", body_md: body,
    }).message;
    return { store, db, agent, chat, send };
  }

  it("GET list and detail stay read after inbox/read, despite a retained legacy unread_since", async () => {
    const { store, db, chat, send } = setup();
    send("Agent reply");
    db.run("UPDATE multiremi_chat_sessions SET unread_since=? WHERE id=?", ["2026-01-01", chat.id]);
    const app = createMultiremiApp({ store });
    const list = async () => {
      const response = await app.request("/api/chat/sessions?status=all");
      expect(response.status).toBe(200);
      return (await response.json() as Array<{ id: string; has_unread: boolean; unread_count: number }>).find(s => s.id === chat.id)!;
    };
    expect(await list()).toMatchObject({ has_unread: true, unread_count: 1 });
    const read = await app.request("/api/inbox/read", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: chat.id }) });
    expect(read.status).toBe(200);
    for (let index = 0; index < 3; index++) {
      expect(await list()).toMatchObject({ has_unread: false, unread_count: 0 });
      const detail = await app.request(`/api/chat/sessions/${chat.id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ has_unread: false, unread_count: 0 });
    }
    expect(db.query("SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='member' AND reader_id='mem_local_local'").get(chat.id)?.cursor_seq).toBe(1);
    send("New reply");
    expect(await list()).toMatchObject({ has_unread: true, unread_count: 1 });
  });

  it("partial and stale reads, read-all and later replies agree with the inbox lane", () => {
    const { store, chat, send } = setup();
    const first = send("first"), second = send("second");
    store.readMessageInbox("mem_local_local", chat.id, first.seq);
    const state = () => store.listChatSessions("local").find(s => s.id === chat.id)!;
    expect(state()).toMatchObject({ hasUnread: true, unreadCount: 1, unreadSince: second.created_at });
    expect(store.listMessageInbox("mem_local_local", "local").unread_count).toBe(state().unreadCount);
    store.readMessageInbox("mem_local_local", chat.id, 0);
    expect(state().unreadCount).toBe(1);
    store.readAllMessageInbox("mem_local_local", "local");
    expect(state()).toMatchObject({ hasUnread: false, unreadCount: 0, unreadSince: null });
    send("third");
    expect(state()).toMatchObject({ hasUnread: true, unreadCount: 1 });
    store.markChatSessionRead(chat.id);
    expect(state().unreadCount).toBe(0);
    expect(store.listMessageInbox("mem_local_local", "local").unread_count).toBe(0);
  });

  it("resolves the creator's member ID and isolates another member and workspace", () => {
    const { store, agent } = setup();
    const user = store.getOrCreateUser({ externalId: "chat-cursor-peer", name: "Peer" });
    const peer = store.createWorkspaceMember({ userId: user.id, name: "Peer", role: "member" });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: user.id });
    const otherWorkspace = store.createWorkspace({ name: "Other", slug: "chat-cursor-other" });
    const elsewhere = store.createWorkspaceMember({ workspaceId: otherWorkspace.id, userId: user.id, name: "Peer elsewhere", role: "member" });
    const send = (member: string) => store.sendMessage({ session_id: chat.id, sender: { type: "agent", id: agent.id },
      to: { type: "member", ref: member }, message_kind: "reply", wake_requested: "inbox_only", body_md: "reply" });
    send(peer.id); send("mem_local_local");
    expect(store.getChatSession(chat.id)?.unreadCount).toBe(1);
    expect(() => store.readMessageInbox(elsewhere.id, chat.id)).toThrow("another workspace");
    store.readMessageInbox("mem_local_local", chat.id);
    expect(store.getChatSession(chat.id)?.unreadCount).toBe(1);
    store.readMessageInbox(peer.id, chat.id);
    expect(store.getChatSession(chat.id)).toMatchObject({ hasUnread: false, unreadCount: 0 });
  });

  it("excludes hidden, deleted and outgoing messages from the creator's unread badge", () => {
    const { store, db, agent, chat, send } = setup();
    const hidden = send("hidden"), deleted = send("deleted"), visible = send("visible");
    db.run("UPDATE multiremi_conversation_log SET visibility='hidden' WHERE id=?", [hidden.id]);
    store.deleteMessage(deleted.id);
    store.sendMessage({ session_id: chat.id, sender: { type: "member", id: "mem_local_local" },
      to: { type: "agent", ref: agent.id }, message_kind: "request", wake_requested: "inbox_only", body_md: "outgoing" });
    expect(store.getChatSession(chat.id)).toMatchObject({ hasUnread: true, unreadCount: 1, unreadSince: visible.created_at });
    expect(store.listMessageInbox("mem_local_local", "local").unread_count).toBe(1);
    store.readMessageInbox("mem_local_local", chat.id);
    expect(store.getChatSession(chat.id)).toMatchObject({ hasUnread: false, unreadCount: 0 });
  });
});

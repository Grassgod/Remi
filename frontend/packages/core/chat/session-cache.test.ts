import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ChatSession } from "../types";
import { chatKeys } from "./queries";
import { updateChatSessionInCache } from "./session-cache";

function chat(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "chat-1", workspace_id: "ws-1", creator_id: "user-1", agent_id: "agent-1",
    title: "Chat", status: "active", pinned: false, origin: null, has_unread: false, unread_count: 0,
    last_message: null, created_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:00:00Z",
    ...overrides,
  };
}

const automationChat = chat({ id: "chat-auto", origin: { autopilot_id: "ap-1", run_id: "run-1" } });

describe("updateChatSessionInCache", () => {
  it("keeps automation chats out of the user's list and user chats out of the automation list", () => {
    const qc = new QueryClient();
    qc.setQueryData(chatKeys.sessionList("ws-1"), []);
    qc.setQueryData(chatKeys.sessionList("ws-1", "all", "automation"), []);
    qc.setQueryData(chatKeys.sessionList("ws-1", "all", "all"), []);

    updateChatSessionInCache(qc, "ws-1", automationChat);
    updateChatSessionInCache(qc, "ws-1", chat());

    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessionList("ws-1"))?.map((s) => s.id)).toEqual(["chat-1"]);
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessionList("ws-1", "all", "automation"))?.map((s) => s.id)).toEqual(["chat-auto"]);
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessionList("ws-1", "all", "all"))?.map((s) => s.id).sort()).toEqual(["chat-1", "chat-auto"]);
  });

  it("moves a chat between status lists inside the same origin", () => {
    const qc = new QueryClient();
    qc.setQueryData(chatKeys.sessionList("ws-1", "active", "automation"), [automationChat]);
    qc.setQueryData(chatKeys.sessionList("ws-1", "archived", "automation"), []);

    updateChatSessionInCache(qc, "ws-1", { ...automationChat, status: "archived" });

    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessionList("ws-1", "active", "automation"))).toEqual([]);
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessionList("ws-1", "archived", "automation"))?.map((s) => s.id)).toEqual(["chat-auto"]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { ChatEndpoints } from "./chat";

const session = {
  id: "chat-1", workspace_id: "ws-1", agent_id: "agent-1", creator_id: "user-1",
  title: "Chat", status: "active", has_unread: true, pinned: false, unread_count: 2,
  last_message: { content: "reply", role: "assistant", created_at: "2026-09-11T00:00:00Z" },
  created_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:00:00Z",
};
const queuedTask = {
  task_id: "task-2", content: "follow up", attachment_ids: ["attachment-1"], created_at: session.created_at,
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function endpointsWithResponse(body: unknown): ChatEndpoints {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
  return new ChatEndpoints(new HttpClient("https://api.example.test"));
}

afterEach(() => vi.unstubAllGlobals());

describe("ChatEndpoints contracts", () => {
  it("creates sessions through the upstream agent/title contract and validates the acknowledgement", async () => {
    const api = endpointsWithResponse(session);
    await expect(api.createChatSession({ agent_id: "agent-1", title: "Chat" })).resolves.toEqual(session);
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/chat/sessions", expect.objectContaining({
      method: "POST", body: JSON.stringify({ agent_id: "agent-1", title: "Chat" }),
    }));
    await expect(endpointsWithResponse({ created: true }).createChatSession({ agent_id: "agent-1" })).rejects.toBeInstanceOf(ApiContractError);
  });

  it("reads summaries while preserving unknown display enums", async () => {
    const api = endpointsWithResponse([{ ...session, status: "future-status", last_message: { ...session.last_message, role: "future-role" } }]);
    const sessions = await api.listChatSessions({ status: "all" });
    expect(sessions[0]).toMatchObject({ status: "future-status", unread_count: 2, last_message: { role: "future-role" } });
  });

  it("rejects wrong summary field types", async () => {
    await expect(endpointsWithResponse([{ ...session, unread_count: "2" }]).listChatSessions()).rejects.toBeInstanceOf(ApiContractError);
  });

  it("patches pin/archive together and reads back the accepted session", async () => {
    const api = endpointsWithResponse({ ...session, pinned: true, status: "archived" });
    await expect(api.updateChatSession("chat-1", { pinned: true, status: "archived" })).resolves.toMatchObject({ pinned: true, status: "archived" });
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/chat/sessions/chat-1", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ pinned: true, status: "archived" }),
    }));
  });

  it("does not report success for a malformed or ignored session update", async () => {
    await expect(endpointsWithResponse({ saved: true }).updateChatSession("chat-1", { title: "new" })).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpointsWithResponse(session).updateChatSession("chat-1", { pinned: true })).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpointsWithResponse({ ...session, pinned: undefined }).updateChatSession("chat-1", { pinned: false })).rejects.toBeInstanceOf(ApiContractError);
  });

  it("distinguishes an accepted follow-up from a new head", async () => {
    const api = endpointsWithResponse({ message_id: "message-2", task_id: "task-2", created_at: session.created_at, supports_queue: true, queued: true });
    await expect(api.sendChatMessage("chat-1", "follow up", ["attachment-1"])).resolves.toMatchObject({ queued: true, supports_queue: true });
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      body: JSON.stringify({ content: "follow up", attachment_ids: ["attachment-1"] }),
    }));
  });

  it.each([
    { task_id: "task-2", created_at: session.created_at, supports_queue: true, queued: true },
    { message_id: "message-2", task_id: "task-2", created_at: session.created_at, supports_queue: true, queued: "true" },
  ])("rejects malformed send acknowledgements", async body => {
    await expect(endpointsWithResponse(body).sendChatMessage("chat-1", "hello")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("loads the head separately from follow-ups and rejects corrupt queues", async () => {
    const pending = { task_id: "task-1", status: "future-phase", created_at: session.created_at, supports_queue: true, queued_tasks: [queuedTask] };
    await expect(endpointsWithResponse(pending).getPendingChatTask("chat-1")).resolves.toEqual(pending);
    await expect(endpointsWithResponse({ ...pending, queued_tasks: [{ ...queuedTask, attachment_ids: null }] }).getPendingChatTask("chat-1")).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpointsWithResponse({ ...pending, created_at: undefined }).getPendingChatTask("chat-1")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("edits a queue item and validates its response", async () => {
    await expect(endpointsWithResponse(queuedTask).editQueuedChatMessage("chat-1", "task-2", "follow up")).resolves.toEqual(queuedTask);
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/chat/sessions/chat-1/queue/task-2", expect.objectContaining({ method: "PATCH" }));
    await expect(endpointsWithResponse({ task_id: "task-2" }).editQueuedChatMessage("chat-1", "task-2", "follow up")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("requires explicit prioritize acknowledgement including the active task", async () => {
    await expect(endpointsWithResponse({ task_id: "task-2", active_task_id: "task-1" }).prioritizeQueuedChatMessage("chat-1", "task-2")).resolves.toEqual({ task_id: "task-2", active_task_id: "task-1" });
    await expect(endpointsWithResponse({ task_id: "task-2" }).prioritizeQueuedChatMessage("chat-1", "task-2")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("accepts 204 deletions and rejects unexpected success bodies", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ChatEndpoints(new HttpClient("https://api.example.test"));
    await expect(api.removeQueuedChatMessage("chat-1", "task-2")).resolves.toBeUndefined();
    await expect(api.clearChatQueue("chat-1")).resolves.toBeUndefined();
    await expect(api.deleteChatSession("chat-1")).resolves.toBeUndefined();
    await expect(api.markChatSessionRead("chat-1")).resolves.toBeUndefined();
    await expect(endpointsWithResponse({ error: "still running" }).deleteChatSession("chat-1")).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpointsWithResponse({ error: "still running" }).removeQueuedChatMessage("chat-1", "task-2")).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpointsWithResponse({ error: "still running" }).clearChatQueue("chat-1")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("does not unlock the composer after a malformed stop acknowledgement", async () => {
    await expect(endpointsWithResponse({ id: "task-1", status: "cancelled" }).cancelTaskById("task-1")).resolves.toBeUndefined();
    await expect(endpointsWithResponse({ id: "task-1", status: "running" }).cancelTaskById("task-1")).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpointsWithResponse({ success: true }).cancelTaskById("task-1")).rejects.toBeInstanceOf(ApiContractError);
  });
});

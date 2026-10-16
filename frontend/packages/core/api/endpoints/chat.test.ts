import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { ChatEndpoints } from "./chat";
import { messageFixture, turnFixture } from "../unified.fixture";

const session = {
  id: "chat-1", workspace_id: "ws-1", agent_id: "agent-1", creator_id: "user-1",
  title: "Chat", status: "active", has_unread: true, pinned: false, origin: null, unread_count: 2,
  last_message: { content: "reply", role: "assistant", created_at: "2026-09-11T00:00:00Z" },
  created_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:00:00Z",
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

  it("sends an optional project only when creating the session", async () => {
    const linked = { ...session, project_id: "project-a" };
    await expect(endpointsWithResponse(linked).createChatSession({ agent_id: "agent-1", project_id: "project-a" })).resolves.toEqual(linked);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      body: JSON.stringify({ agent_id: "agent-1", project_id: "project-a" }),
    }));
  });

  it("retains runtime workspace selection and rejects an unacknowledged or malformed binding", async () => {
    const linked = { ...session, runtime_workspace_id: "rws-a" };
    await expect(endpointsWithResponse(linked).createChatSession({ agent_id: "agent-1", runtime_workspace_id: "rws-a" })).resolves.toEqual(linked);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      body: JSON.stringify({ agent_id: "agent-1", runtime_workspace_id: "rws-a" }),
    }));
    await expect(endpointsWithResponse(session).createChatSession({ agent_id: "agent-1", runtime_workspace_id: "rws-a" })).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpointsWithResponse({ ...session, runtime_workspace_id: 123 }).getChatSession("chat-1")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("rejects malformed project data and unacknowledged project selection on create", async () => {
    await expect(endpointsWithResponse(session).createChatSession({ agent_id: "agent-1", project_id: "project-a" })).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpointsWithResponse({ ...session, project_id: 123 }).getChatSession("chat-1")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("reads summaries while preserving unknown display enums", async () => {
    const api = endpointsWithResponse([{ ...session, status: "future-status", last_message: { ...session.last_message, role: "future-role" } }]);
    const sessions = await api.listChatSessions({ status: "all" });
    expect(sessions[0]).toMatchObject({ status: "future-status", unread_count: 2, last_message: { role: "future-role" } });
  });

  it("asks for a chat origin and reads which automation run opened a chat", async () => {
    const origin = { autopilot_id: "ap-1", run_id: "run-1" };
    const api = endpointsWithResponse([{ ...session, origin }]);
    const sessions = await api.listChatSessions({ status: "all", origin: "automation" });
    expect(sessions[0]?.origin).toEqual(origin);
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/chat/sessions?status=all&origin=automation", expect.anything());
    await expect(endpointsWithResponse([{ ...session, origin: { autopilot_id: 1 } }]).listChatSessions()).rejects.toBeInstanceOf(ApiContractError);
  });

  it("treats a chat without an origin as the user's own", async () => {
    const { origin: _origin, ...withoutOrigin } = session;
    const sessions = await endpointsWithResponse([withoutOrigin]).listChatSessions();
    expect(sessions[0]?.origin).toBeNull();
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/chat/sessions", expect.anything());
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

  it("keeps an accepted message successful when the supplemental turn read fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ message: messageFixture({ dedupe_key: "send-1" }), wake_applied: "next_turn", wake_reason: "agent_pair_not_privileged", turn_id: "turn_1" }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ChatEndpoints(new HttpClient("https://api.example.test"));
    await expect(api.sendChatMessage("chat_1", "Follow up", undefined, "send-1")).resolves.toMatchObject({ message_id: "msg_1", turn_id: "turn_1", created_at: "2026-10-04T00:00:00Z" });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body).dedupe_key).toBe("send-1");
  });
  it("sends a canonical message, preserving dedupe and the active attempt identity", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ message: messageFixture(), wake_applied: "next_turn", wake_reason: "agent_pair_not_privileged", turn_id: "turn_1" }))
      .mockResolvedValueOnce(response({ turn: turnFixture() }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ChatEndpoints(new HttpClient("https://api.example.test"));
    await expect(api.sendChatMessage("chat_1", "Follow up", undefined, "send-1")).resolves.toMatchObject({ message_id: "msg_1", task_id: "attempt_2", turn_id: "turn_1" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/api/sessions/chat_1/messages", expect.objectContaining({
      method: "POST", body: JSON.stringify({ body_md: "Follow up", message_kind: "request", to: { type: "agent", ref: "agent-1" }, wake_requested: "now", dedupe_key: "send-1" }),
    }));
  });
  it("reads the active turn through status-filtered pages, without a legacy queue", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const params = new URL(url).searchParams;
      return response({ turns: params.get("status") === "running" ? [turnFixture()] : [], next_cursor: null });
    }));
    const api = new ChatEndpoints(new HttpClient("https://api.example.test"));
    await expect(api.getPendingChatTask("chat_1")).resolves.toMatchObject({ task_id: "attempt_2", turn_id: "turn_1", status: "running" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("pending-task"), expect.anything());
  });
  it("reads a running turn whose attempt waits for its local folder as waiting, with the reason (PR 6 §2.8)", async () => {
    const reason = "local_directory /Users/me/repo (held by background tasks of chat chat_2)";
    for (const [field, expected] of [
      [reason, { status: "waiting_local_directory", wait_reason: reason }],
      ["", { status: "waiting_local_directory", wait_reason: null }],
      [null, { status: "running" }],
      [7, { status: "running" }],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        const params = new URL(url).searchParams;
        return response({ turns: params.get("status") === "running" ? [turnFixture({ local_directory_wait_reason: field })] : [], next_cursor: null });
      }));
      const api = new ChatEndpoints(new HttpClient("https://api.example.test"));
      const pending = await api.getPendingChatTask("chat_1");
      expect(pending, String(field)).toMatchObject({ task_id: "attempt_2", ...expected });
      if (expected.status === "running") expect(pending.wait_reason, String(field)).toBeUndefined();
    }
  });
  it("lists in-flight chat turns with both the attempt and the turn the cancel command addresses", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const params = new URL(url).searchParams;
      return response({ turns: params.get("status") === "awaiting_human" ? [turnFixture({ status: "awaiting_human" })] : [], next_cursor: null });
    }));
    const api = new ChatEndpoints(new HttpClient("https://api.example.test"));
    await expect(api.listPendingChatTasks()).resolves.toEqual({ tasks: [
      { task_id: "attempt_2", turn_id: "turn_1", status: "awaiting_human", chat_session_id: "chat_1" },
    ] });
  });
  it("carries the running subagent count when the server reports it, and degrades a malformed one (PR 5 §6.7)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const params = new URL(url).searchParams;
      return response({ turns: params.get("status") === "running" ? [
        turnFixture({ running_subagents: 2 }),
        turnFixture({ id: "turn_3", current_attempt_id: "attempt_3", session_id: "chat_3", running_subagents: null }),
        turnFixture({ id: "turn_4", current_attempt_id: "attempt_4", session_id: "chat_4", running_subagents: -1 }),
        turnFixture({ id: "turn_5", current_attempt_id: "attempt_5", session_id: "chat_5" }),
      ] : [], next_cursor: null });
    }));
    const api = new ChatEndpoints(new HttpClient("https://api.example.test"));
    const { tasks } = await api.listPendingChatTasks();
    expect(tasks.map((task) => [task.chat_session_id, task.running_subagents])).toEqual([
      ["chat_1", 2], ["chat_3", undefined], ["chat_4", undefined], ["chat_5", undefined],
    ]);
    expect("running_subagents" in tasks[3]!).toBe(false);
  });
  it("reads the session list's background-task count, degrading a malformed one (PR 6)", async () => {
    const list = await endpointsWithResponse([{ ...session, running_background_tasks: 2 }, { ...session, id: "chat-2", running_background_tasks: "x" }, { ...session, id: "chat-3" }])
      .listChatSessions();
    expect(list.map((item) => item.running_background_tasks)).toEqual([2, undefined, undefined]);
  });
  it("carries the attempt's background-task count into the pending list when the turn reports it (PR 6)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response({ turns: new URL(url).searchParams.get("status") === "running"
      ? [turnFixture({ running_background_tasks: 1 }), turnFixture({ id: "turn_2", current_attempt_id: "attempt_2", session_id: "chat_2", running_background_tasks: -3 })]
      : [], next_cursor: null })));
    const { tasks } = await new ChatEndpoints(new HttpClient("https://api.example.test")).listPendingChatTasks();
    expect(tasks.map((task) => task.running_background_tasks)).toEqual([1, undefined]);
  });
  it("reads a chat's background tasks from the session registry, dropping a malformed row and degrading unknown values (PR 6)", async () => {
    const row = { id: "row-1", session_id: "chat-1", task_id: "t1", task_type: "shell", name: "npm run dev", command: "npm run dev",
      origin_attempt_id: "attempt_1", status: "running", can_stop: true, started_at: "2026-10-16T00:00:00Z", lane_state: "parked",
      parked_until: "2026-10-16T02:00:00Z", stop_reason: "a_new_reason", origin_turn_seq: 4 };
    const snapshot = await endpointsWithResponse({ session_id: "chat-1", rows: [row, { ...row, id: "row-2", status: "teleported", lane_state: "orbit" }, { id: "row-3" }] })
      .listChatBackgroundTasks("chat-1");
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/chat/sessions/chat-1/background-tasks", expect.anything());
    expect(snapshot.rows.map((r) => [r.id, r.status, r.lane_state, r.stop_reason])).toEqual([
      ["row-1", "running", "parked", null], ["row-2", "unknown", "closed", null],
    ]);
    expect(snapshot.rows[0]).toMatchObject({ origin_turn_seq: 4, stop_outcome: null, output_tail: null, usage: null });
    // `running` is the server's, else the running rows.
    expect(snapshot.running).toBe(1);
    await expect(endpointsWithResponse({ session_id: "chat-9", rows: [] }).listChatBackgroundTasks("chat-1")).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpointsWithResponse({ tasks: [] }).listChatBackgroundTasks("chat-1")).rejects.toBeInstanceOf(ApiContractError);
  });
  it("asks to stop one background task or all of them (PR 6 §6.1)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 202 })));
    const api = new ChatEndpoints(new HttpClient("https://api.example.test"));
    await expect(api.stopChatBackgroundTasks("chat-1", { task_id: "t1" })).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/chat/sessions/chat-1/background-tasks/stop", expect.objectContaining({
      method: "POST", body: JSON.stringify({ task_id: "t1" }),
    }));
    await api.stopChatBackgroundTasks("chat-1", { all: true });
    expect(fetch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ all: true }) }));
    // The rows the server marked come back, well-formed ones of this chat only.
    const marked = { id: "row-1", session_id: "chat-1", task_id: "t1", started_at: "2026-10-16T00:00:00Z", status: "running",
      stop_requested_at: "2026-10-16T00:01:00Z", stop_requested_by: "member-1", stop_outcome: "pending" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ requested_at: "2026-10-16T00:01:00Z",
      rows: [marked, { ...marked, id: "row-x", session_id: "chat-2" }, { id: "bad" }] }), { status: 202 })));
    await expect(new ChatEndpoints(new HttpClient("https://api.example.test")).stopChatBackgroundTasks("chat-1", { task_id: "t1" }))
      .resolves.toMatchObject([{ id: "row-1", stop_requested_by: "member-1", stop_outcome: "pending" }]);
    // A refusal keeps its code for the caller.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline", code: "runtime_offline" }), { status: 409 })));
    await expect(new ChatEndpoints(new HttpClient("https://api.example.test")).stopChatBackgroundTasks("chat-1", { all: true }))
      .rejects.toMatchObject({ status: 409, body: { code: "runtime_offline" } });
  });
  it("marks the conversation read through the cursor command and rejects an invalid acknowledgement", async () => {
    await expect(endpointsWithResponse({ session_id: "chat_1", cursor_seq: 5 }).markChatSessionRead("chat_1")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/inbox/read", expect.objectContaining({ body: JSON.stringify({ session_id: "chat_1" }) }));
    await expect(endpointsWithResponse({ success: true }).markChatSessionRead("chat_1")).rejects.toBeInstanceOf(ApiContractError);
  });
  it("cancels by turn ID and rejects an acknowledgement for another turn", async () => {
    await expect(endpointsWithResponse({ turn: turnFixture({ status: "cancelled" }) }).cancelTaskById("turn_1")).resolves.toBeUndefined();
    await expect(endpointsWithResponse({ turn: turnFixture() }).cancelTaskById("other")).rejects.toBeInstanceOf(ApiContractError);
    await expect(endpointsWithResponse({ success: true }).cancelTaskById("turn_1")).rejects.toBeInstanceOf(ApiContractError);
  });
});

/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../types";
import { chatKeys } from "./queries";
import { useDeleteChatSession, useMarkChatSessionRead, useUpdateChatSession, usePrioritizeChatQueuedTask } from "./mutations";

const mock = vi.hoisted(() => ({
  wsId: "ws-1", deleteChatSession: vi.fn(), updateChatSession: vi.fn(), markChatSessionRead: vi.fn(),
  prioritizeQueuedChatMessage: vi.fn(), setActiveSession: vi.fn(), clearInputDraft: vi.fn(),
}));
vi.mock("../api", () => ({ api: mock }));
vi.mock("../hooks", () => ({ useWorkspaceId: () => mock.wsId }));
vi.mock("../platform/workspace-storage", () => ({ getCurrentWsId: () => mock.wsId }));
vi.mock("./index", () => ({ useChatStore: { getState: () => ({
  activeSessionId: "chat-1", inputDrafts: { "chat-1": "unsent draft" },
  setActiveSession: mock.setActiveSession, clearInputDraft: mock.clearInputDraft,
}) } }));

const session: ChatSession = {
  id: "chat-1", workspace_id: "ws-1", creator_id: "user-1", agent_id: "agent-1",
  title: "Chat", status: "active", pinned: false, has_unread: true, unread_count: 2,
  last_message: null, created_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:00:00Z",
};
let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.wsId = "ws-1";
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(chatKeys.sessions("ws-1"), [session]);
  qc.setQueryData(chatKeys.sessionList("ws-1", "active"), [session]);
  qc.setQueryData(chatKeys.sessionList("ws-1", "archived"), []);
  qc.setQueryData(chatKeys.session("ws-1", "chat-1"), session);
  qc.setQueryData(chatKeys.messagesPage("chat-1"), { pages: [], pageParams: [] });
  qc.setQueryData(chatKeys.sessions("ws-2"), [{ ...session, id: "chat-2", workspace_id: "ws-2" }]);
});
afterEach(() => qc.clear());

describe("chat session mutations", () => {
  it("moves a confirmed archive across all list variants and retains the open conversation", async () => {
    const archived = { ...session, status: "archived", pinned: true };
    mock.updateChatSession.mockResolvedValue(archived);
    const { result } = renderHook(() => useUpdateChatSession(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ sessionId: "chat-1", status: "archived", pinned: true }); });
    expect(qc.getQueryData(chatKeys.sessionList("ws-1", "active"))).toEqual([]);
    expect(qc.getQueryData(chatKeys.sessionList("ws-1", "archived"))).toEqual([archived]);
    expect(qc.getQueryData(chatKeys.sessions("ws-1"))).toEqual([archived]);
    expect(qc.getQueryData(chatKeys.session("ws-1", "chat-1"))).toEqual(archived);
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessions("ws-2"))?.[0]?.id).toBe("chat-2");
    expect(mock.setActiveSession).not.toHaveBeenCalled();
    expect(mock.clearInputDraft).not.toHaveBeenCalled();
  });

  it("does not remove selection, messages or drafts while delete is pending or rejected", async () => {
    let reject!: (error: Error) => void;
    mock.deleteChatSession.mockReturnValue(new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const { result } = renderHook(() => useDeleteChatSession(), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => { pending = result.current.mutateAsync("chat-1"); });
    expect(qc.getQueryData(chatKeys.sessions("ws-1"))).toEqual([session]);
    expect(mock.setActiveSession).not.toHaveBeenCalled();
    await act(async () => {
      reject(new Error("delete failed"));
      await expect(pending).rejects.toThrow("delete failed");
    });
    expect(qc.getQueryData(chatKeys.session("ws-1", "chat-1"))).toEqual(session);
    expect(qc.getQueryData(chatKeys.messagesPage("chat-1"))).toBeDefined();
    expect(mock.setActiveSession).not.toHaveBeenCalled();
    expect(mock.clearInputDraft).not.toHaveBeenCalled();
  });

  it("removes all caches and draft only after deletion succeeds", async () => {
    mock.deleteChatSession.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDeleteChatSession(), { wrapper });
    await act(async () => { await result.current.mutateAsync("chat-1"); });
    expect(qc.getQueryData(chatKeys.sessions("ws-1"))).toEqual([]);
    expect(qc.getQueryData(chatKeys.sessionList("ws-1", "active"))).toEqual([]);
    expect(qc.getQueryData(chatKeys.session("ws-1", "chat-1"))).toBeUndefined();
    expect(qc.getQueryData(chatKeys.messagesPage("chat-1"))).toBeUndefined();
    expect(mock.setActiveSession).toHaveBeenCalledWith(null);
    expect(mock.clearInputDraft).toHaveBeenCalledWith("chat-1");
  });

  it("keeps the originating workspace when navigation occurs during an update", async () => {
    let resolve!: (session: ChatSession) => void;
    mock.updateChatSession.mockReturnValue(new Promise<ChatSession>(resolvePromise => { resolve = resolvePromise; }));
    const { result, rerender } = renderHook(() => useUpdateChatSession(), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => { pending = result.current.mutateAsync({ sessionId: "chat-1", title: "new" }); });
    mock.wsId = "ws-2";
    rerender();
    await act(async () => { resolve({ ...session, title: "new" }); await pending; });
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessions("ws-1"))?.[0]?.title).toBe("new");
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessions("ws-2"))?.[0]?.title).toBe("Chat");
    expect(qc.getQueryData(chatKeys.session("ws-2", "chat-1"))).toBeUndefined();
  });

  it("does not clear the new workspace selection after a pending delete finishes", async () => {
    let resolve!: () => void;
    mock.deleteChatSession.mockReturnValue(new Promise<void>(resolvePromise => { resolve = resolvePromise; }));
    const { result, rerender } = renderHook(() => useDeleteChatSession(), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => { pending = result.current.mutateAsync("chat-1"); });
    mock.wsId = "ws-2";
    rerender();
    await act(async () => { resolve(); await pending; });
    expect(qc.getQueryData(chatKeys.sessions("ws-1"))).toEqual([]);
    expect(mock.setActiveSession).not.toHaveBeenCalled();
    expect(mock.clearInputDraft).not.toHaveBeenCalled();
  });

  it("clears both unread indicators in each cached list and detail", async () => {
    mock.markChatSessionRead.mockResolvedValue(undefined);
    const { result } = renderHook(() => useMarkChatSessionRead(), { wrapper });
    await act(async () => { await result.current.mutateAsync("chat-1"); });
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessionList("ws-1", "active"))?.[0]).toMatchObject({ has_unread: false, unread_count: 0 });
    expect(qc.getQueryData(chatKeys.session("ws-1", "chat-1"))).toMatchObject({ has_unread: false, unread_count: 0 });
  });

  it("refreshes queue and transcript after prioritizing without issuing an extra cancel", async () => {
    mock.prioritizeQueuedChatMessage.mockResolvedValue({ task_id: "task-2", active_task_id: "task-1" });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => usePrioritizeChatQueuedTask(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ sessionId: "chat-1", taskId: "task-2" }); });
    expect(mock.prioritizeQueuedChatMessage).toHaveBeenCalledWith("chat-1", "task-2");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.pendingTask("chat-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.messagesPage("chat-1") });
  });
});

/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../types";
import { chatKeys } from "./queries";
import { ApiError } from "../api/http";
import type { ChatQueue, QueuedChatMessage } from "../api/schemas/chat-queue";
import {
  useDeleteChatSession, useDeleteQueuedChatMessage, useEnqueueChatMessage, useMarkChatSessionRead,
  useResumeChatQueue, useSteerQueuedChatMessage, useUpdateChatSession, useUpdateQueuedChatMessage,
} from "./mutations";

const mock = vi.hoisted(() => ({
  wsId: "ws-1", deleteChatSession: vi.fn(), updateChatSession: vi.fn(), markChatSessionRead: vi.fn(),
  setActiveSession: vi.fn(), clearInputDraft: vi.fn(), clearQueueState: vi.fn(), slug: "acme" as string | null,
  enqueueChatMessage: vi.fn(), updateQueuedChatMessage: vi.fn(), deleteQueuedChatMessage: vi.fn(),
  steerQueuedChatMessage: vi.fn(), resumeChatQueue: vi.fn(),
  putQueueOutboxItem: vi.fn(), removeQueueOutboxItem: vi.fn(),
}));
vi.mock("../api", () => ({ api: mock }));
vi.mock("../hooks", () => ({ useWorkspaceId: () => mock.wsId }));
vi.mock("../platform/workspace-storage", () => ({ getCurrentWsId: () => mock.wsId, getCurrentSlug: () => mock.slug }));
vi.mock("./index", () => ({ useChatStore: { getState: () => ({
  activeSessionId: "chat-1", inputDrafts: { "chat-1": "unsent draft" },
  setActiveSession: mock.setActiveSession, clearInputDraft: mock.clearInputDraft, clearQueueState: mock.clearQueueState,
  putQueueOutboxItem: mock.putQueueOutboxItem, removeQueueOutboxItem: mock.removeQueueOutboxItem,
}) } }));

const session: ChatSession = {
  id: "chat-1", workspace_id: "ws-1", creator_id: "user-1", agent_id: "agent-1",
  title: "Chat", status: "active", pinned: false, origin: null, has_unread: true, unread_count: 2,
  last_message: null, created_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:00:00Z",
};
let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.wsId = "ws-1";
  mock.slug = "acme";
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(chatKeys.sessions("ws-1"), [session]);
  qc.setQueryData(chatKeys.sessionList("ws-1", "active"), [session]);
  qc.setQueryData(chatKeys.sessionList("ws-1", "archived"), []);
  qc.setQueryData(chatKeys.session("ws-1", "chat-1"), session);
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

  it("does not remove selection or drafts while delete is pending or rejected", async () => {
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
    expect(mock.setActiveSession).toHaveBeenCalledWith(null);
    expect(mock.clearInputDraft).toHaveBeenCalledWith("chat-1");
    expect(mock.clearQueueState).toHaveBeenCalledWith("chat-1");
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

});

const queued = (fields: Partial<QueuedChatMessage> = {}): QueuedChatMessage => ({
  id: "qmsg_1", session_id: "chat-1", body_md: "Next", attachments: [], client_id: "client-1", status: "queued",
  error: null, revision: 1, released_message_id: null, released_via: null, released_at: null,
  created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z", ...fields,
});
const enqueueVars = {
  sessionId: "chat-1", body_md: "Next", attachments: [], client_id: "client-1", created_at: "2026-10-15T00:00:00Z",
};

describe("chat follow-up queue mutations", () => {
  beforeEach(() => qc.setQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"), { items: [], paused: null }));

  it("shows the enqueue as a local row, then writes the server row and drops the local one", async () => {
    let resolve!: (value: unknown) => void;
    mock.enqueueChatMessage.mockReturnValue(new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useEnqueueChatMessage(), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => { pending = result.current.mutateAsync(enqueueVars); });
    expect(mock.putQueueOutboxItem).toHaveBeenCalledWith("chat-1", expect.objectContaining({ client_id: "client-1", state: "sending" }));
    expect(mock.enqueueChatMessage).toHaveBeenCalledWith("chat-1", { body_md: "Next", attachment_ids: undefined, client_id: "client-1" });
    await act(async () => { resolve({ item: queued(), released: null }); await pending; });
    expect(qc.getQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"))?.items).toEqual([queued()]);
    expect(mock.removeQueueOutboxItem).toHaveBeenCalledWith("chat-1", "client-1", "acme");
  });

  it("refreshes the running state when an idle lane releases the row at once", async () => {
    mock.enqueueChatMessage.mockResolvedValue({ item: queued({ status: "released" }), released: { message: { id: "msg_1" }, turn_id: "turn_1" } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useEnqueueChatMessage(), { wrapper });
    await act(async () => { await result.current.mutateAsync(enqueueVars); });
    expect(qc.getQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"))?.items).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.pendingTask("chat-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.queue("ws-1", "chat-1") });
  });

  it("removes the local row on a refusal but keeps it unconfirmed without an HTTP answer", async () => {
    mock.enqueueChatMessage.mockRejectedValueOnce(new ApiError("full", 400, "Bad Request", { error: "full", code: "queue_full" }));
    const { result } = renderHook(() => useEnqueueChatMessage(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync(enqueueVars)).rejects.toBeInstanceOf(ApiError); });
    expect(mock.removeQueueOutboxItem).toHaveBeenCalledWith("chat-1", "client-1", "acme");
    mock.removeQueueOutboxItem.mockClear();
    mock.enqueueChatMessage.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => { await expect(result.current.mutateAsync(enqueueVars)).rejects.toThrow("Failed to fetch"); });
    expect(mock.removeQueueOutboxItem).not.toHaveBeenCalled();
    expect(mock.putQueueOutboxItem).toHaveBeenLastCalledWith("chat-1", expect.objectContaining({ client_id: "client-1", state: "unconfirmed" }));
    expect(mock.enqueueChatMessage).toHaveBeenCalledTimes(2);
  });

  it("does not write an unconfirmed row into the workspace the user switched to", async () => {
    let reject!: (error: Error) => void;
    mock.enqueueChatMessage.mockReturnValue(new Promise((_done, fail) => { reject = fail; }));
    const { result, rerender } = renderHook(() => useEnqueueChatMessage(), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => { pending = result.current.mutateAsync(enqueueVars).catch(() => {}); });
    mock.putQueueOutboxItem.mockClear();
    mock.wsId = "ws-2";
    mock.slug = "other";
    rerender();
    await act(async () => { reject(new TypeError("offline")); await pending; });
    expect(mock.putQueueOutboxItem).not.toHaveBeenCalled();
    expect(mock.removeQueueOutboxItem).not.toHaveBeenCalled();
  });

  it.each([
    ["answered", (resolve: (value: unknown) => void) => resolve({ item: queued(), released: null })],
    ["refused", (_resolve: unknown, reject: (error: Error) => void) => reject(new ApiError("full", 400, "Bad Request", { error: "full", code: "queue_full" }))],
  ])("drops an %s enqueue from the workspace it started in after a switch", async (_label, settle) => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    mock.enqueueChatMessage.mockReturnValue(new Promise((done, fail) => { resolve = done; reject = fail; }));
    const { result, rerender } = renderHook(() => useEnqueueChatMessage(), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => { pending = result.current.mutateAsync(enqueueVars).catch(() => {}); });
    mock.wsId = "ws-2";
    mock.slug = "other";
    rerender();
    await act(async () => { settle(resolve, reject); await pending; });
    expect(mock.removeQueueOutboxItem).toHaveBeenCalledWith("chat-1", "client-1", "acme");
  });

  it.each([502, 503, 504, 408])("keeps a gateway answer %s unconfirmed", async (status) => {
    mock.enqueueChatMessage.mockRejectedValueOnce(new ApiError("gateway", status, "Gateway"));
    const { result } = renderHook(() => useEnqueueChatMessage(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync(enqueueVars)).rejects.toBeInstanceOf(ApiError); });
    expect(mock.removeQueueOutboxItem).not.toHaveBeenCalled();
    expect(mock.putQueueOutboxItem).toHaveBeenLastCalledWith("chat-1", expect.objectContaining({ state: "unconfirmed" }));
  });

  it("sends queue commands even while the browser reports offline", async () => {
    const { onlineManager } = await import("@tanstack/react-query");
    onlineManager.setOnline(false);
    try {
      mock.enqueueChatMessage.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      mock.resumeChatQueue.mockResolvedValueOnce({ items: [], paused: null, released: [] });
      const enqueue = renderHook(() => useEnqueueChatMessage(), { wrapper }).result;
      const resume = renderHook(() => useResumeChatQueue(), { wrapper }).result;
      await act(async () => { await expect(enqueue.current.mutateAsync(enqueueVars)).rejects.toThrow("Failed to fetch"); });
      await act(async () => { await resume.current.mutateAsync({ sessionId: "chat-1" }); });
      expect(mock.resumeChatQueue).toHaveBeenCalledOnce();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("saves an edit with its revision and writes the answered row", async () => {
    qc.setQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"), { items: [queued()], paused: null });
    mock.updateQueuedChatMessage.mockResolvedValue(queued({ body_md: "Edited", revision: 2 }));
    const { result } = renderHook(() => useUpdateQueuedChatMessage(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ sessionId: "chat-1", itemId: "qmsg_1", body_md: "Edited", attachment_ids: [], expected_revision: 1 });
    });
    expect(mock.updateQueuedChatMessage).toHaveBeenCalledWith("chat-1", "qmsg_1", { body_md: "Edited", attachment_ids: [], expected_revision: 1 });
    expect(qc.getQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"))?.items[0]).toMatchObject({ body_md: "Edited", revision: 2 });
  });

  it("drops a deleted row from the cache", async () => {
    qc.setQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"), { items: [queued()], paused: null });
    mock.deleteQueuedChatMessage.mockResolvedValue(queued({ status: "deleted" }));
    const { result } = renderHook(() => useDeleteQueuedChatMessage(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ sessionId: "chat-1", itemId: "qmsg_1" }); });
    expect(qc.getQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"))?.items).toEqual([]);
  });

  it("steers a row out of the queue and keeps a failed release visible with its error", async () => {
    qc.setQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"), { items: [queued()], paused: null });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    mock.steerQueuedChatMessage.mockRejectedValueOnce(new ApiError("send failed", 409, "Conflict", {
      error: "send failed", code: "queued_message_send_failed", item: queued({ status: "failed", error: "agent archived" }),
    }));
    const { result } = renderHook(() => useSteerQueuedChatMessage(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync({ sessionId: "chat-1", itemId: "qmsg_1" })).rejects.toBeInstanceOf(ApiError); });
    expect(qc.getQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"))?.items[0]).toMatchObject({ status: "failed", error: "agent archived" });
    mock.steerQueuedChatMessage.mockResolvedValueOnce({ item: queued({ status: "released", released_via: "steer" }), message: { id: "msg_2" } });
    await act(async () => { await result.current.mutateAsync({ sessionId: "chat-1", itemId: "qmsg_1" }); });
    expect(qc.getQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"))?.items).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.pendingTask("chat-1") });
  });

  it("writes the resumed queue and refreshes the running state when rows were released", async () => {
    qc.setQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"), { items: [queued()], paused: { reason: "interrupted", at: "2026-10-15T00:00:00Z" } });
    mock.resumeChatQueue.mockResolvedValue({ items: [], paused: null, released: [{ message: { id: "msg_3" } }] });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useResumeChatQueue(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ sessionId: "chat-1" }); });
    expect(qc.getQueryData<ChatQueue>(chatKeys.queue("ws-1", "chat-1"))).toEqual({ items: [], paused: null });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.pendingTask("chat-1") });
  });
});

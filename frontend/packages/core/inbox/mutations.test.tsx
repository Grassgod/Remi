/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMarkAllInboxRead, useMarkInboxRead } from "./mutations";
import { inboxKeys } from "./queries";
const mock = vi.hoisted(() => ({ wsId: "ws-1", markInboxRead: vi.fn(), markAllInboxRead: vi.fn() }));
vi.mock("../api", () => ({ api: mock }));
vi.mock("../hooks", () => ({ useWorkspaceId: () => mock.wsId }));
let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
beforeEach(() => { vi.clearAllMocks(); mock.wsId = "ws-1"; qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); });
describe("inbox cursor mutations", () => {
  it("waits for the server cursor and leaves unread data intact on failure", async () => {
    const cached = { unread_count: 8 }; qc.setQueryData(inboxKeys.summary("ws-1"), cached);
    mock.markInboxRead.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useMarkInboxRead(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync({ session_id: "sess-1", to_seq: 4 })).rejects.toThrow("offline"); });
    expect(mock.markInboxRead).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(inboxKeys.summary("ws-1"))).toEqual(cached);
  });
  it("returns the authoritative monotonic cursor and invalidates the originating workspace", async () => {
    let resolve!: (data: { session_id: string; cursor_seq: number }) => void;
    mock.markInboxRead.mockReturnValue(new Promise(r => { resolve = r; }));
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result, rerender } = renderHook(() => useMarkInboxRead(), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => { pending = result.current.mutateAsync({ session_id: "sess-1", to_seq: 4 }); });
    mock.wsId = "ws-2"; rerender();
    await act(async () => { resolve({ session_id: "sess-1", cursor_seq: 9 }); await pending; });
    await waitFor(() => expect(result.current.data).toEqual({ session_id: "sess-1", cursor_seq: 9 }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.all("ws-1") });
  });
  it("uses one all-read command instead of enumerating loaded pages", async () => {
    mock.markAllInboxRead.mockResolvedValue({ conversations_read: 10 });
    const { result } = renderHook(() => useMarkAllInboxRead(), { wrapper });
    await act(async () => { await result.current.mutateAsync(); });
    expect(mock.markAllInboxRead).toHaveBeenCalledTimes(1);
    expect(mock.markInboxRead).not.toHaveBeenCalled();
  });
});

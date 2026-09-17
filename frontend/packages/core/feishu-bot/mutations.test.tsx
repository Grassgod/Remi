/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { feishuBotKeys } from "./queries";
import { useUpdateFeishuBotSender } from "./mutations";

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("Feishu bot sender allowlist mutations", () => {
  let queryClient: QueryClient;
  const updateFeishuBotSender = vi.fn();
  const original = { senders: [{ id: "sender-1", allowed: true }] };

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    queryClient.setQueryData(feishuBotKeys.senders("ws-a"), original);
    queryClient.setQueryData(feishuBotKeys.senders("ws-b"), original);
    queryClient.setQueryData(feishuBotKeys.config("ws-a"), { configured: true });
    setApiInstance({ updateFeishuBotSender } as unknown as ApiClient);
  });

  afterEach(() => {
    queryClient.clear();
    vi.resetAllMocks();
  });

  it.each([true, false])("waits for allowed=%s to be confirmed and invalidates only this workspace's sender query", async (allowed) => {
    let resolveUpdate!: (response: unknown) => void;
    updateFeishuBotSender.mockImplementation(() => new Promise((resolve) => {
      resolveUpdate = resolve;
    }));
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useUpdateFeishuBotSender("ws-a"), {
      wrapper: createWrapper(queryClient),
    });
    let request!: Promise<unknown>;
    await act(async () => {
      request = result.current.mutateAsync({ senderId: "sender-1", allowed });
      await Promise.resolve();
    });
    expect(updateFeishuBotSender).toHaveBeenCalledWith("ws-a", "sender-1", { allowed });
    expect(queryClient.getQueryData(feishuBotKeys.senders("ws-a"))).toEqual(original);
    expect(invalidateQueries).not.toHaveBeenCalled();

    await act(async () => {
      resolveUpdate({ id: "sender-1", allowed });
      await request;
    });

    expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({
      queryKey: feishuBotKeys.senders("ws-a"),
    });
    expect(queryClient.getQueryState(feishuBotKeys.senders("ws-a"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(feishuBotKeys.senders("ws-b"))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(feishuBotKeys.config("ws-a"))?.isInvalidated).toBe(false);
  });

  it("preserves the confirmed allowlist when the server rejects a decision", async () => {
    updateFeishuBotSender.mockRejectedValue(new Error("permission denied"));
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useUpdateFeishuBotSender("ws-a"), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await expect(result.current.mutateAsync({ senderId: "sender-1", allowed: false }))
        .rejects.toThrow("permission denied");
    });
    expect(queryClient.getQueryData(feishuBotKeys.senders("ws-a"))).toEqual(original);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("finishes an in-flight decision against its original workspace after navigation", async () => {
    let resolveUpdate!: (response: unknown) => void;
    updateFeishuBotSender.mockImplementation(() => new Promise((resolve) => {
      resolveUpdate = resolve;
    }));
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result, rerender } = renderHook(
      ({ workspaceId }) => useUpdateFeishuBotSender(workspaceId),
      { initialProps: { workspaceId: "ws-a" }, wrapper: createWrapper(queryClient) },
    );
    let request!: Promise<unknown>;
    await act(async () => {
      request = result.current.mutateAsync({ senderId: "sender-1", allowed: false });
      await Promise.resolve();
    });
    rerender({ workspaceId: "ws-b" });

    await act(async () => {
      resolveUpdate({ id: "sender-1", allowed: false });
      await request;
    });

    expect(updateFeishuBotSender).toHaveBeenCalledWith("ws-a", "sender-1", { allowed: false });
    expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({
      queryKey: feishuBotKeys.senders("ws-a"),
    });
    expect(queryClient.getQueryState(feishuBotKeys.senders("ws-b"))?.isInvalidated).toBe(false);
  });
});

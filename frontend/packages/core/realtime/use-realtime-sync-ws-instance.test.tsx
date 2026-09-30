/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { WSClient } from "../api/ws-client";
import { useRealtimeSync, type RealtimeSyncStores } from "./use-realtime-sync";

vi.mock("../platform/workspace-storage", () => ({
  getCurrentWsId: () => "ws-1",
  getCurrentSlug: () => "test-ws",
}));

vi.mock("../paths", () => ({
  useHasOnboarded: () => true,
  resolvePostAuthDestination: () => "/",
}));

function createMockWs(): WSClient {
  return {
    on: vi.fn(() => () => {}),
    onAny: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    onResync: vi.fn(() => () => {}),
  } as unknown as WSClient;
}

function createStores(): RealtimeSyncStores {
  return {
    authStore: Object.assign(() => ({}), {
      getState: () => ({ user: { id: "u1" } }),
      subscribe: () => () => {},
      setState: () => {},
      destroy: () => {},
    }),
  } as unknown as RealtimeSyncStores;
}

function createWrapper(qc: QueryClient) {
  // Named function (not arrow) so react/display-name lint rule passes —
  // anonymous render-fn components break that rule even in test files.
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useRealtimeSync — ws instance change", () => {
  let qc: QueryClient;
  let stores: RealtimeSyncStores;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stores = createStores();
    invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  });

  it("re-runs the reconnect invalidation when the server broadcasts resync (MUL-438)", () => {
    const ws = createMockWs();
    const resyncCallbacks = new Set<() => void>();
    (ws.onResync as unknown as ReturnType<typeof vi.fn>).mockImplementation((cb: () => void) => {
      resyncCallbacks.add(cb);
      return () => resyncCallbacks.delete(cb);
    });
    renderHook(() => useRealtimeSync(ws, stores), { wrapper: createWrapper(qc) });

    expect(resyncCallbacks.size).toBe(1);
    invalidateSpy.mockClear();
    for (const cb of resyncCallbacks) cb();

    // The same workspace-scoped invalidation a reconnect runs — the two paths
    // share one implementation, so a `resync` cannot recover less than a drop.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["issues", "ws-1"] });
  });

  it("keeps Chat's cursor-backed rows during a same-instance reconnect", () => {
    const ws = createMockWs();
    let reconnect: (() => void) | undefined;
    (ws.onReconnect as unknown as ReturnType<typeof vi.fn>).mockImplementation((cb: () => void) => {
      reconnect = cb;
      return () => { reconnect = undefined; };
    });
    renderHook(() => useRealtimeSync(ws, stores), { wrapper: createWrapper(qc) });
    invalidateSpy.mockClear();
    reconnect?.();
    const keys = invalidateSpy.mock.calls.map((call: [{ queryKey?: unknown }, ...unknown[]]) => call[0].queryKey);
    expect(keys).toContainEqual(["issues", "ws-1"]);
    expect(keys).not.toContainEqual(["chat", "ws-1"]);
  });

  it("skips invalidation on first non-null ws instance", () => {
    const ws = createMockWs();
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: createWrapper(qc),
    });

    // The main effect calls invalidateQueries for its own setup, but the
    // ws-instance-change effect should NOT have fired invalidation.
    // The only invalidateQueries calls should come from the main effect's
    // event handlers, not from the instance-change effect.
    // We verify by checking that no call was made with workspaceKeys.list()
    // pattern from the instance-change path (it logs a specific message).
    // Simpler: count calls — first mount with a ws should not trigger the
    // workspace-scoped bulk invalidation.
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does not invalidate when ws goes from instance to null", () => {
    const ws1 = createMockWs();
    const { rerender } = renderHook(
      ({ ws }) => useRealtimeSync(ws, stores),
      { initialProps: { ws: ws1 as WSClient | null }, wrapper: createWrapper(qc) },
    );

    invalidateSpy.mockClear();
    rerender({ ws: null });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates exactly once when a new ws instance appears after null gap", () => {
    const ws1 = createMockWs();
    const { rerender } = renderHook(
      ({ ws }) => useRealtimeSync(ws, stores),
      { initialProps: { ws: ws1 as WSClient | null }, wrapper: createWrapper(qc) },
    );

    // Simulate workspace switch: ws -> null -> new ws
    invalidateSpy.mockClear();
    rerender({ ws: null });
    expect(invalidateSpy).not.toHaveBeenCalled();

    const ws2 = createMockWs();
    rerender({ ws: ws2 });

    // Should have called invalidateQueries for all workspace-scoped keys,
    // including task and Product Session caches affected by daemon retirement.
    expect(invalidateSpy).toHaveBeenCalledTimes(24);
  });

  it("does not re-invalidate when rerendered with the same ws instance", () => {
    const ws1 = createMockWs();
    const { rerender } = renderHook(
      ({ ws }) => useRealtimeSync(ws, stores),
      { initialProps: { ws: ws1 as WSClient | null }, wrapper: createWrapper(qc) },
    );

    invalidateSpy.mockClear();
    // Rerender with same instance
    rerender({ ws: ws1 });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates chat, plugins, pins, labels, and invitations queries on ws instance change", () => {
    const ws1 = createMockWs();
    const { rerender } = renderHook(
      ({ ws }) => useRealtimeSync(ws, stores),
      { initialProps: { ws: ws1 as WSClient | null }, wrapper: createWrapper(qc) },
    );

    invalidateSpy.mockClear();
    rerender({ ws: null });

    const ws2 = createMockWs();
    rerender({ ws: ws2 });

    const calls = invalidateSpy.mock.calls.map((call: [{ queryKey?: unknown }, ...unknown[]]) => call[0].queryKey);
    expect(calls).toContainEqual(["chat", "ws-1"]);
    expect(calls).toContainEqual(["labels", "ws-1"]);
    expect(calls).toContainEqual(["workspaces", "ws-1", "invitations"]);
    expect(calls).toContainEqual(["workspaces", "ws-1", "agent-plugins"]);
    expect(calls).toContainEqual(["workspaces", "ws-1", "agent-tasks"]);
    expect(calls).toContainEqual(["runtimes", "models", "fleet", "ws-1"]);
    expect(calls).toContainEqual(["runtimes", "daemons", "inventory", "ws-1"]);
    expect(calls).toContainEqual(["issues", "workspace"]);
    expect(calls).toContainEqual(["issues", "tasks"]);
    expect(calls).toContainEqual(["issues", "sessions"]);
  });
});

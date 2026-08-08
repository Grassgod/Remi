/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { WSClient } from "../api/ws-client";
import type { WSEventType, WSMessage } from "../types/events";
import { useRealtimeSync, type RealtimeSyncStores } from "./use-realtime-sync";

vi.mock("../platform/workspace-storage", () => ({
  getCurrentWsId: () => "ws-1",
  getCurrentSlug: () => "test-ws",
}));

vi.mock("../paths", () => ({
  useHasOnboarded: () => true,
  resolvePostAuthDestination: () => "/",
}));

/**
 * The exact event set the pre-split single-useEffect implementation
 * subscribed to (40 `ws.on` calls, verbatim order). Pinning it here is what
 * makes "the refactor kept identical subscribe semantics" a checked claim
 * rather than a review assertion.
 */
const EXPECTED_EVENTS: readonly string[] = [
  "issue:updated",
  "issue:created",
  "issue:deleted",
  "issue_labels:changed",
  "issue_metadata:changed",
  "inbox:new",
  "comment:created",
  "comment:updated",
  "comment:deleted",
  "comment:resolved",
  "comment:unresolved",
  "activity:created",
  "reaction:added",
  "reaction:removed",
  "issue_reaction:added",
  "issue_reaction:removed",
  "subscriber:added",
  "subscriber:removed",
  "workspace:updated",
  "workspace:deleted",
  "member:removed",
  "member:added",
  "invitation:created",
  "invitation:accepted",
  "invitation:declined",
  "invitation:revoked",
  "task:message",
  "chat:message",
  "chat:done",
  "task:queued",
  "task:dispatch",
  "task:running",
  "task:waiting_local_directory",
  "task:awaiting_human",
  "task:cancelled",
  "task:completed",
  "task:failed",
  "chat:session_read",
  "chat:session_updated",
  "chat:session_deleted",
];

interface RecordingWs {
  ws: WSClient;
  /** Event names in registration order (duplicates preserved). */
  registered: string[];
  /** Event names whose unsubscribe has been called. */
  removed: string[];
  /** Live listeners, mirroring WSClient's own handler registry. */
  live: Map<string, Set<(payload: unknown) => void>>;
  anyHandlers: Set<(msg: WSMessage) => void>;
  emit: (type: string, payload?: unknown) => void;
}

function createRecordingWs(): RecordingWs {
  const registered: string[] = [];
  const removed: string[] = [];
  const live = new Map<string, Set<(payload: unknown) => void>>();
  const anyHandlers = new Set<(msg: WSMessage) => void>();

  const ws = {
    on: (event: WSEventType, handler: (payload: unknown) => void) => {
      registered.push(event);
      if (!live.has(event)) live.set(event, new Set());
      live.get(event)!.add(handler);
      return () => {
        removed.push(event);
        live.get(event)?.delete(handler);
      };
    },
    onAny: (handler: (msg: WSMessage) => void) => {
      registered.push("*");
      anyHandlers.add(handler);
      return () => {
        removed.push("*");
        anyHandlers.delete(handler);
      };
    },
    onReconnect: () => () => {},
  } as unknown as WSClient;

  return {
    ws,
    registered,
    removed,
    live,
    anyHandlers,
    emit: (type, payload) => {
      for (const handler of live.get(type) ?? []) handler(payload);
      for (const handler of anyHandlers) {
        handler({ type: type as WSEventType, payload } as WSMessage);
      }
    },
  };
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
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useRealtimeSync — registration / teardown parity", () => {
  let qc: QueryClient;
  let stores: RealtimeSyncStores;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stores = createStores();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes to exactly the pre-split event set, in the same order", () => {
    const mock = createRecordingWs();
    renderHook(() => useRealtimeSync(mock.ws, stores), { wrapper: createWrapper(qc) });

    expect(mock.registered).toEqual(["*", ...EXPECTED_EVENTS]);
  });

  it("registers each event exactly once", () => {
    const mock = createRecordingWs();
    renderHook(() => useRealtimeSync(mock.ws, stores), { wrapper: createWrapper(qc) });

    expect(new Set(mock.registered).size).toBe(mock.registered.length);
  });

  it("removes every listener it registered on unmount", () => {
    const mock = createRecordingWs();
    const { unmount } = renderHook(() => useRealtimeSync(mock.ws, stores), {
      wrapper: createWrapper(qc),
    });

    const registeredCount = mock.registered.length;
    expect(registeredCount).toBe(EXPECTED_EVENTS.length + 1);

    unmount();

    expect(mock.removed.length).toBe(registeredCount);
    expect([...mock.removed].sort()).toEqual([...mock.registered].sort());
    // Nothing left behind in the client's registry — a leaked handler would
    // keep firing across workspace switches.
    expect([...mock.live.values()].every((set) => set.size === 0)).toBe(true);
    expect(mock.anyHandlers.size).toBe(0);
  });

  it("leaves nothing subscribed after repeated mount/unmount cycles", () => {
    const mock = createRecordingWs();
    for (let i = 0; i < 3; i += 1) {
      const { unmount } = renderHook(() => useRealtimeSync(mock.ws, stores), {
        wrapper: createWrapper(qc),
      });
      unmount();
    }

    expect(mock.removed.length).toBe(mock.registered.length);
    expect([...mock.live.values()].every((set) => set.size === 0)).toBe(true);
    expect(mock.anyHandlers.size).toBe(0);
  });

  it("clears pending prefix-debounce timers on unmount", () => {
    vi.useFakeTimers();
    const mock = createRecordingWs();
    const { unmount } = renderHook(() => useRealtimeSync(mock.ws, stores), {
      wrapper: createWrapper(qc),
    });

    // `agent:status` has no specific handler, so it goes through the debounced
    // prefix path (100ms).
    mock.emit("agent:status", {});
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    unmount();
    vi.advanceTimersByTime(500);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("flushes buffered task:message frames on unmount", () => {
    vi.useFakeTimers();
    const mock = createRecordingWs();
    const { unmount } = renderHook(() => useRealtimeSync(mock.ws, stores), {
      wrapper: createWrapper(qc),
    });

    mock.emit("task:message", {
      task_id: "task-1",
      seq: 1,
      type: "text",
      content: "hello",
    });
    // Still buffered — the 80ms coalescing window has not elapsed.
    expect(qc.getQueryData(["task-messages", "task-1"])).toBeUndefined();

    unmount();

    expect(qc.getQueryData(["task-messages", "task-1"])).toHaveLength(1);
  });
});

/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  resetAfterFirstScreenForTest,
  useAfterFirstScreen,
  useRouteContentReady,
} from "./use-after-first-screen";

// QA's two remount probes from cmt_jkz280f232y0, with controlled frames and idle.
const frames = new Map<number, FrameRequestCallback>();
const idle = new Map<number, () => void>();
let id = 0;

function flushFrames(): void {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}

function flushIdle(): void {
  const callbacks = [...idle.values()];
  idle.clear();
  for (const callback of callbacks) callback();
}

beforeEach(() => {
  resetAfterFirstScreenForTest();
  frames.clear();
  idle.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => frames.delete(handle));
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    idle.set(++id, () => callback({ didTimeout: false, timeRemaining: () => 50 }));
    return id;
  });
  vi.stubGlobal("cancelIdleCallback", (handle: number) => idle.delete(handle));
});

afterEach(() => {
  resetAfterFirstScreenForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function usePageGate(ready: boolean): boolean {
  useRouteContentReady("/local/issues", ready);
  return useAfterFirstScreen({ routeKey: "/local/issues" });
}

it("unmount then remount starts a pending publisher closed", () => {
  const first = renderHook(() => usePageGate(true));
  act(() => { flushFrames(); flushIdle(); });
  expect(first.result.current).toBe(true);
  first.unmount();
  const renders: boolean[] = [];
  const second = renderHook(() => {
    const open = usePageGate(false);
    renders.push(open);
    return open;
  });
  expect(renders[0]).toBe(false);
  expect(second.result.current).toBe(false);
});

it("a remounted pending page does not send a new deferred request", async () => {
  const first = renderHook(() => usePageGate(true));
  act(() => { flushFrames(); flushIdle(); });
  first.unmount();
  const requests = vi.fn(async () => []);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const second = renderHook(() => {
    const open = usePageGate(false);
    useQuery({ queryKey: ["new-page-auxiliary"], queryFn: requests, enabled: open });
  }, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await act(async () => { await Promise.resolve(); });
  expect(requests).not.toHaveBeenCalled();
  second.unmount();
  client.clear();
});

it("cancels the pending idle callback when the page unmounts", () => {
  const first = renderHook(() => usePageGate(true));
  act(flushFrames);
  expect(idle.size).toBe(1);
  const staleCallbacks = [...idle.values()];
  first.unmount();
  expect(idle.size).toBe(0);
  const second = renderHook(() => usePageGate(false));
  // Even an already-dispatched callback cannot open a later visit of this path.
  act(() => { for (const callback of staleCallbacks) callback(); });
  expect(second.result.current).toBe(false);
});

it("cancels queued frames and publisherless fallback timers on unmount", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = renderHook(() => usePageGate(true));
  expect(frames.size).toBe(1);
  first.unmount();
  expect(frames.size).toBe(0);
  const fallback = renderHook(() => useAfterFirstScreen({ routeKey: "/local/settings" }));
  act(() => { vi.advanceTimersByTime(1); });
  fallback.unmount();
  act(() => { vi.runAllTimers(); flushIdle(); });
  expect(idle.size).toBe(0);
  const second = renderHook(() => useAfterFirstScreen({ routeKey: "/local/settings" }));
  expect(second.result.current).toBe(false);
  vi.useRealTimers();
});

it("keeps the gate while another publisher still owns the same page", () => {
  const first = renderHook(() => usePageGate(true));
  const second = renderHook(() => usePageGate(true));
  act(() => { flushFrames(); flushIdle(); });
  first.unmount();
  expect(second.result.current).toBe(true);
  second.unmount();
  const third = renderHook(() => usePageGate(false));
  expect(third.result.current).toBe(false);
});

it("reopens cached content on the next frame and idle without closing the shell", () => {
  const shell = renderHook(() => useAfterFirstScreen({ routeKey: "/local/issues", scope: "shell" }));
  const first = renderHook(() => usePageGate(true));
  act(() => { flushFrames(); flushIdle(); });
  first.unmount();
  expect(shell.result.current).toBe(true);
  const second = renderHook(() => usePageGate(true));
  expect(second.result.current).toBe(false);
  act(flushFrames);
  expect(second.result.current).toBe(false);
  act(flushIdle);
  expect(second.result.current).toBe(true);
  expect(shell.result.current).toBe(true);
});

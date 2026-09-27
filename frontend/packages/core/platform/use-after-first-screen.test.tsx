/**
 * @vitest-environment jsdom
 */
import { act, renderHook, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AFTER_FIRST_SCREEN_TIMEOUT_MS,
  scheduleAfterFirstIdle,
  useAfterFirstScreen,
} from "./use-after-first-screen";
import { useNavigationStore } from "../navigation";

type IdleWindow = Window & {
  requestIdleCallback?: (handler: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const originalIdle = (window as IdleWindow).requestIdleCallback;

beforeEach(() => {
  useNavigationStore.setState({ lastPath: "/test/issues" });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalIdle) (window as IdleWindow).requestIdleCallback = originalIdle;
  else Reflect.deleteProperty(window, "requestIdleCallback");
});

describe("useAfterFirstScreen (MUL-472 b)", () => {
  it("is false during the first commit and true within the 1 s timeout", async () => {
    vi.useFakeTimers();
    // No requestIdleCallback in jsdom, so the hook falls back to a timer; either
    // way the contract is "not before the commit, by the timeout at the latest".
    const { result } = renderHook(() => useAfterFirstScreen({ routeKey: "/test/issues" }));

    expect(result.current).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(AFTER_FIRST_SCREEN_TIMEOUT_MS);
    });
    expect(result.current).toBe(true);
  });

  it("publishes the timeout contract the acceptance rule pins down", () => {
    expect(AFTER_FIRST_SCREEN_TIMEOUT_MS).toBe(1000);
  });

  it("restarts the wait when the route changes", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ routeKey }: { routeKey: string }) => useAfterFirstScreen({ routeKey }),
      { initialProps: { routeKey: "/test/issues" } },
    );
    await act(async () => {
      vi.advanceTimersByTime(AFTER_FIRST_SCREEN_TIMEOUT_MS);
    });
    expect(result.current).toBe(true);

    rerender({ routeKey: "/test/inbox" });
    expect(result.current).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(AFTER_FIRST_SCREEN_TIMEOUT_MS);
    });
    expect(result.current).toBe(true);
  });

  it("cancels the pending callback on unmount", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const idleWindow = window as IdleWindow;
    idleWindow.requestIdleCallback = () => 42;
    idleWindow.cancelIdleCallback = cancelled;

    const { unmount } = renderHook(() => useAfterFirstScreen({ routeKey: "/test/issues" }));
    unmount();

    expect(cancelled).toHaveBeenCalledWith(42);
  });

  it("does not fire the gated query before the gate opens, and does after", async () => {
    vi.useFakeTimers();
    const queryFn = vi.fn(async () => "payload");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function Probe() {
      const afterFirstScreen = useAfterFirstScreen({ routeKey: "/test/issues" });
      useQuery({ queryKey: ["gated"], queryFn, enabled: afterFirstScreen });
      return null;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );

    expect(queryFn).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(AFTER_FIRST_SCREEN_TIMEOUT_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleAfterFirstIdle", () => {
  it("uses requestIdleCallback with the timeout when the engine has it", () => {
    const requestIdleCallback = vi.fn((_cb: () => void, options?: { timeout?: number }) => {
      void options;
      return 7;
    });
    const cancelIdleCallback = vi.fn();
    const idleWindow = window as IdleWindow;
    idleWindow.requestIdleCallback = requestIdleCallback;
    idleWindow.cancelIdleCallback = cancelIdleCallback;

    const cancel = scheduleAfterFirstIdle(() => {}, 1000);
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000 });
    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });
});

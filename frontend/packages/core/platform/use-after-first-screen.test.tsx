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

describe("gated query factories (MUL-472 b)", () => {
  it("every deferred shell query carries an enable switch the sidebar can hold closed", async () => {
    const { pinListOptions } = await import("../pins/queries");
    const { agentListOptions, myInvitationListOptions, squadListOptions } = await import("../workspace/queries");
    const { latestCliVersionOptions } = await import("../runtimes/queries");
    const { agentTaskSnapshotOptions } = await import("../agents/queries");
    const { childIssueProgressOptions } = await import("../issues/queries");
    const { workbenchPendingCountOptions } = await import("../issues/workbench");

    const gated = {
      pins: pinListOptions("ws-1", "user-1", { enabled: false }),
      agents: agentListOptions("ws-1", { enabled: false }),
      squads: squadListOptions("ws-1", { enabled: false }),
      myInvitations: myInvitationListOptions({ enabled: false }),
      latestCliVersion: latestCliVersionOptions({ enabled: false }),
      agentTaskSnapshot: agentTaskSnapshotOptions("ws-1", { enabled: false }),
      childProgress: childIssueProgressOptions("ws-1", { enabled: false }),
      workbenchPendingCount: workbenchPendingCountOptions("ws-1", { enabled: false }),
    };

    for (const [name, options] of Object.entries(gated)) {
      // `enabled` may be an option or a value; TanStack resolves both before it
      // fetches, so asserting on the option object is the same gate the app uses.
      const enabled = typeof options.enabled === "function" ? options.enabled({} as never) : options.enabled;
      expect(enabled, `${name} must be gated`).toBe(false);
    }

    // And the default stays open: these factories are shared with callers that
    // are already on screen (the runtimes page, the workbench page itself).
    expect(pinListOptions("ws-1", "user-1").enabled).toBe(true);
    expect(agentListOptions("ws-1").enabled).toBe(true);
    expect(latestCliVersionOptions().enabled).toBe(true);
    expect(agentTaskSnapshotOptions("ws-1").enabled).toBe(true);
    expect(childIssueProgressOptions("ws-1").enabled).toBe(true);
  });
});

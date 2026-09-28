/**
 * @vitest-environment jsdom
 *
 * MUL-472 b rework (`cmt_r0euas6zfxff`): the gate opens after the route's main
 * content settled, not after the gate consumer's own mount, and a new route's
 * first render must already be `false`.
 */
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS,
  AFTER_FIRST_SCREEN_IDLE_TIMEOUT_MS,
  configureAfterFirstScreenForTest,
  FirstScreenRouteProvider,
  markRouteContentReady,
  resetAfterFirstScreenForTest,
  useAfterFirstScreen,
  useRouteContentReady,
} from "./use-after-first-screen";
import { useNavigationStore } from "../navigation";

type IdleWindow = Window & {
  requestIdleCallback?: (handler: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const originalIdle = (window as IdleWindow).requestIdleCallback;

/** Pending idle callbacks, so a test decides when "the browser went idle". */
let idleQueue: Array<{ callback: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
let frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

function flushIdle(): void {
  const frames = [...frameQueue.values()];
  frameQueue.clear();
  for (const callback of frames) callback(performance.now());
  const queued = idleQueue;
  idleQueue = [];
  for (const handle of queued) handle.callback();
}

beforeEach(() => {
  idleQueue = [];
  frameQueue = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    frameQueue.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frameQueue.delete(id);
  });
  resetAfterFirstScreenForTest();
  configureAfterFirstScreenForTest({ idleTimeoutMs: 1000, contentFallbackMs: 2000 });
  useNavigationStore.setState({ lastPath: "/test/issues" });
  (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (
    callback: () => void,
  ) => {
    idleQueue.push({ callback, cancel: vi.fn() });
    return idleQueue.length;
  };
  (window as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetAfterFirstScreenForTest();
  if (originalIdle) (window as IdleWindow).requestIdleCallback = originalIdle;
  else Reflect.deleteProperty(window, "requestIdleCallback");
  Reflect.deleteProperty(window, "cancelIdleCallback");
});

describe("useAfterFirstScreen timing (MUL-472 b)", () => {
  it("stays closed while the route's content is not ready, however idle the browser is", async () => {
    // The real shape: a page mounts its readiness publisher with `ready: false`
    // (its request is in flight) and the gate waits. The old implementation
    // opened here — mount effect -> idle callback — because the browser is idle
    // while the page's own request is outstanding, which is QA's 660 ms finding.
    const { result } = renderHook(
      ({ routeKey, ready }: { routeKey: string; ready: boolean }) => {
        useRouteContentReady(routeKey, ready);
        return useAfterFirstScreen({ routeKey });
      },
      { initialProps: { routeKey: "/test/issues", ready: false } },
    );

    await act(async () => {
      flushIdle();
    });
    expect(result.current).toBe(false);
    expect(idleQueue).toHaveLength(0);

    // Still nothing on the fallback's eve.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current).toBe(false);
  });

  it("opens within the idle window once the route publishes content readiness", async () => {
    const { result } = renderHook(() => useAfterFirstScreen({ routeKey: "/test/issues" }));

    act(() => {
      markRouteContentReady("/test/issues");
    });
    expect(result.current).toBe(false);
    expect(idleQueue).toHaveLength(1);

    await act(async () => {
      flushIdle();
    });
    expect(result.current).toBe(true);
  });

  it("publishes the timers the ruling names", () => {
    expect(AFTER_FIRST_SCREEN_IDLE_TIMEOUT_MS).toBe(1000);
    expect(AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS).toBe(2000);
  });

  it("passes the 1 s deadline to requestIdleCallback as its timeout", async () => {
    const spy = vi.fn((_callback: () => void) => 1);
    (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = spy;

    renderHook(() => useAfterFirstScreen({ routeKey: "/test/issues" }));
    act(() => {
      markRouteContentReady("/test/issues");
    });

    expect(spy).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000 });
  });

  it("opens on the fallback timer for a route that never publishes readiness", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAfterFirstScreen({ routeKey: "/test/orphan" }));

    await act(async () => {
      vi.advanceTimersByTime(AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS - 1);
    });
    expect(result.current).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    // Fallback reached content-ready; the idle step is a macrotask in jsdom.
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("opens for a failed or empty route too, because readiness is not success", async () => {
    const { result } = renderHook(() => useAfterFirstScreen({ routeKey: "/test/issues" }));

    // A page publishes "settled" for error and empty states as well; from the
    // gate's point of view they are identical.
    act(() => {
      markRouteContentReady("/test/issues");
    });
    await act(async () => {
      flushIdle();
    });
    expect(result.current).toBe(true);
  });
});

describe("useAfterFirstScreen route identity (MUL-472 b)", () => {
  it("uses the render's pathname even while persisted navigation still points at the old route", async () => {
    const requests: string[] = [];
    const renders: Array<{ route: string; open: boolean }> = [];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Probe({ route, ready }: { route: string; ready: boolean }) {
      const open = useAfterFirstScreen();
      renders.push({ route, open });
      useRouteContentReady(route, ready);
      useQuery({ queryKey: ["route", route], enabled: open, queryFn: async () => {
        requests.push(route);
        return route;
      } });
      return null;
    }
    const tree = (route: string, ready: boolean) => (
      <QueryClientProvider client={client}>
        <FirstScreenRouteProvider routeKey={route}>
          <Probe route={route} ready={ready} />
        </FirstScreenRouteProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree("/test/issues", true));
    await act(async () => { flushIdle(); });
    await waitFor(() => expect(requests).toEqual(["/test/issues"]));
    renders.length = 0;
    rerender(tree("/test/inbox", false));
    expect(renders[0]).toEqual({ route: "/test/inbox", open: false });
    await act(async () => { flushIdle(); });
    expect(requests).toEqual(["/test/issues"]);
    rerender(tree("/test/inbox", true));
    await act(async () => { flushIdle(); });
    await waitFor(() => expect(requests).toEqual(["/test/issues", "/test/inbox"]));
  });

  it("does not let a lagging consumer evict a new page's publisher", async () => {
    function LaggingConsumer() {
      return <span>{String(useAfterFirstScreen({ routeKey: "/test/issues" }))}</span>;
    }
    function Page() {
      useRouteContentReady("/test/inbox", false);
      return null;
    }
    render(
      <FirstScreenRouteProvider routeKey="/test/inbox">
        <Page />
        <LaggingConsumer />
      </FirstScreenRouteProvider>,
    );
    const { result } = renderHook(() => useAfterFirstScreen({ routeKey: "/test/inbox" }));
    act(() => { markRouteContentReady("/test/inbox"); });
    await act(async () => { flushIdle(); });
    expect(result.current).toBe(true);
  });

  it("returns false on the first render of a new route, without waiting for an effect", async () => {
    // Record what the hook returned *during each render*, because the defect QA
    // found was visible only there: the old implementation returned the previous
    // route's `true` for one render and flipped it inside a later effect, so a
    // query keyed to the new route could fire in that window. An assertion after
    // `act()` (which flushes effects) cannot see it.
    const seen: Array<{ routeKey: string; value: boolean }> = [];
    function Probe({ routeKey }: { routeKey: string }) {
      const value = useAfterFirstScreen({ routeKey });
      seen.push({ routeKey, value });
      return null;
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <Probe routeKey="/test/issues" />
      </QueryClientProvider>,
    );
    act(() => {
      markRouteContentReady("/test/issues");
    });
    await act(async () => {
      flushIdle();
    });
    expect(seen.at(-1)).toEqual({ routeKey: "/test/issues", value: true });

    seen.length = 0;
    rerender(
      <QueryClientProvider client={queryClient}>
        <Probe routeKey="/test/inbox" />
      </QueryClientProvider>,
    );

    // Every render pass for the new route must have read `false`; the very first
    // one is the one that gates the new page's queries.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.value === false)).toBe(true);
    expect(seen[0]).toEqual({ routeKey: "/test/inbox", value: false });
  });

  it("keeps a route closed until that route's own content is ready", async () => {
    const { result, rerender } = renderHook(
      ({ routeKey }: { routeKey: string }) => useAfterFirstScreen({ routeKey }),
      { initialProps: { routeKey: "/test/issues" } },
    );
    act(() => {
      markRouteContentReady("/test/issues");
    });
    await act(async () => {
      flushIdle();
    });

    rerender({ routeKey: "/test/inbox" });
    // The first route's readiness must not leak into the second.
    await act(async () => {
      flushIdle();
    });
    expect(result.current).toBe(false);

    act(() => {
      markRouteContentReady("/test/inbox");
    });
    await act(async () => {
      flushIdle();
    });
    expect(result.current).toBe(true);
  });

  it("starts a revisited path closed again", async () => {
    const { result, rerender } = renderHook(
      ({ routeKey }: { routeKey: string }) => useAfterFirstScreen({ routeKey }),
      { initialProps: { routeKey: "/test/issues" } },
    );
    act(() => {
      markRouteContentReady("/test/issues");
    });
    await act(async () => {
      flushIdle();
    });
    expect(result.current).toBe(true);

    rerender({ routeKey: "/test/inbox" });
    expect(result.current).toBe(false);
    rerender({ routeKey: "/test/issues" });
    expect(result.current).toBe(false);
  });
});

describe("useAfterFirstScreen shell scope (MUL-472 b)", () => {
  it("matches an always-enabled shell's request count on hot navigation, even when stale", async () => {
    const baselineFn = vi.fn(async () => "payload");
    const gatedFn = vi.fn(async () => "payload");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    function Shell({ routeKey }: { routeKey: string }) {
      const enabled = useAfterFirstScreen({ routeKey, scope: "shell" });
      useQuery({ queryKey: ["baseline-shell"], queryFn: baselineFn });
      useQuery({ queryKey: ["gated-shell"], queryFn: gatedFn, enabled });
      return null;
    }
    const tree = (routeKey: string) => <QueryClientProvider client={client}><Shell routeKey={routeKey} /></QueryClientProvider>;
    const { rerender } = render(tree("/test/issues"));
    expect(baselineFn).toHaveBeenCalledTimes(1);
    expect(gatedFn).toHaveBeenCalledTimes(0);
    act(() => { markRouteContentReady("/test/issues"); });
    await act(async () => { flushIdle(); });
    rerender(tree("/test/inbox"));
    rerender(tree("/test/detail"));
    await act(async () => { flushIdle(); });
    expect(gatedFn).toHaveBeenCalledTimes(1);
    expect(baselineFn).toHaveBeenCalledTimes(1);
  });

  it("opens once and stays open across navigations", async () => {
    const { result, rerender } = renderHook(
      ({ routeKey }: { routeKey: string }) => useAfterFirstScreen({ scope: "shell", routeKey }),
      { initialProps: { routeKey: "/test/issues" } },
    );
    act(() => {
      markRouteContentReady("/test/issues");
    });
    await act(async () => {
      flushIdle();
    });
    expect(result.current).toBe(true);

    // Shell chrome never unmounts, so closing and reopening here would re-issue
    // expired requests on every navigation.
    rerender({ routeKey: "/test/inbox" });
    expect(result.current).toBe(true);
    rerender({ routeKey: "/test/detail/1" });
    expect(result.current).toBe(true);
  });

  it("does not open the page scope as a side effect of the shell scope", async () => {
    const shell = renderHook(
      ({ routeKey }: { routeKey: string }) =>
        useAfterFirstScreen({ scope: "shell", routeKey }),
      { initialProps: { routeKey: "/test/issues" } },
    );
    act(() => {
      markRouteContentReady("/test/issues");
    });
    await act(async () => {
      flushIdle();
    });
    expect(shell.result.current).toBe(true);

    const page = renderHook(
      ({ routeKey }: { routeKey: string }) => useAfterFirstScreen({ routeKey }),
      { initialProps: { routeKey: "/test/inbox" } },
    );
    expect(page.result.current).toBe(false);
  });
});

describe("gated query factories (MUL-472 b)", () => {
  it("every deferred query carries an enable switch a caller can hold closed", async () => {
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
      const enabled = typeof options.enabled === "function" ? options.enabled({} as never) : options.enabled;
      expect(enabled, `${name} must be gatable`).toBe(false);
    }

    // Defaults stay open: the same factories serve callers already on screen.
    expect(pinListOptions("ws-1", "user-1").enabled).toBe(true);
    expect(agentListOptions("ws-1").enabled).toBe(true);
    expect(latestCliVersionOptions().enabled).toBe(true);
    expect(agentTaskSnapshotOptions("ws-1").enabled).toBe(true);
    expect(childIssueProgressOptions("ws-1").enabled).toBe(true);
  });

  it("a gated query stays quiet until the gate opens, then runs once", async () => {
    const queryFn = vi.fn(async () => "payload");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function Probe({ routeKey, ready }: { routeKey: string; ready: boolean }) {
      const open = useAfterFirstScreen({ routeKey });
      const { pathname } = { pathname: routeKey };
      useRouteContentReady(pathname, ready);
      useQuery({ queryKey: ["gated", routeKey], queryFn, enabled: open });
      return null;
    }

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <Probe routeKey="/test/issues" ready={false} />
      </QueryClientProvider>,
    );
    await act(async () => {
      flushIdle();
    });
    expect(queryFn).not.toHaveBeenCalled();

    rerender(
      <QueryClientProvider client={queryClient}>
        <Probe routeKey="/test/issues" ready />
      </QueryClientProvider>,
    );
    await act(async () => {
      flushIdle();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

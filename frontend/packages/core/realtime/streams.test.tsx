/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamSubscriptionHandlers } from "../api/ws-client";
import { resetStreamSubscriptionCountsForTesting, useLogStreamSubscription, useTraceStreamSubscription } from "./streams";

const provider = vi.hoisted(() => ({ subscribeStream: vi.fn(), subscribeTrace: vi.fn() }));
vi.mock("./provider", () => ({ useWS: () => provider }));

function handlers() {
  return { onAck: vi.fn(), onFrames: vi.fn(), onGap: vi.fn(), onError: vi.fn(), onClosed: vi.fn() };
}

describe.each(["log", "trace"] as const)("shared %s stream consumers", (stream) => {
  let wireHandlers: StreamSubscriptionHandlers;
  const unsubscribe = vi.fn();
  const useSubscription = stream === "log" ? useLogStreamSubscription : useTraceStreamSubscription;
  const subscribe = stream === "log" ? provider.subscribeStream : provider.subscribeTrace;

  beforeEach(() => {
    vi.clearAllMocks();
    const subscription = { stream, id: "shared", head: () => 0, unsubscribe };
    provider.subscribeStream.mockImplementation((_stream, _id, callbacks) => {
      wireHandlers = callbacks;
      return subscription;
    });
    provider.subscribeTrace.mockImplementation((_id, callbacks) => {
      wireHandlers = callbacks;
      return subscription;
    });
  });

  afterEach(() => {
    cleanup();
    resetStreamSubscriptionCountsForTesting();
  });

  function push() {
    act(() => {
      wireHandlers.onAck?.({ stream, id: "shared", first_seq: 1, head_seq: 2, log_version: null, gap: null });
      wireHandlers.onFrames?.([{ seq: 2, kind: stream === "log" ? "entry" : "trace", payload: {} }]);
      wireHandlers.onGap?.({ stream, id: "shared", from: 1, to: 1 });
      wireHandlers.onError?.({ stream, id: "shared", code: "unavailable" });
      wireHandlers.onClosed?.({ stream, id: "shared", head_seq: 2 });
    });
  }

  it("fans out ack, frames, gap and errors to both mounted hooks", () => {
    const first = handlers();
    const second = handlers();
    renderHook(() => useSubscription("shared", first));
    renderHook(() => useSubscription("shared", second));
    expect(subscribe).toHaveBeenCalledTimes(1);
    push();
    for (const callback of Object.values(first)) expect(callback).toHaveBeenCalledTimes(1);
    for (const callback of Object.values(second)) expect(callback).toHaveBeenCalledTimes(1);
  });

  it("removes only the unmounted consumer and unsubscribes after the last one", () => {
    const first = handlers();
    const second = handlers();
    const firstHook = renderHook(() => useSubscription("shared", first));
    const secondHook = renderHook(() => useSubscription("shared", second));
    firstHook.unmount();
    expect(unsubscribe).not.toHaveBeenCalled();
    push();
    for (const callback of Object.values(first)) expect(callback).not.toHaveBeenCalled();
    for (const callback of Object.values(second)) expect(callback).toHaveBeenCalledTimes(1);
    secondHook.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reads each consumer's current handlers without replacing the wire subscription", () => {
    const first = handlers();
    const second = handlers();
    const updated = handlers();
    const firstHook = renderHook(({ callbacks }) => useSubscription("shared", callbacks), { initialProps: { callbacks: first } });
    renderHook(() => useSubscription("shared", second));
    firstHook.rerender({ callbacks: updated });
    push();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(first.onFrames).not.toHaveBeenCalled();
    expect(updated.onFrames).toHaveBeenCalledTimes(1);
    expect(second.onFrames).toHaveBeenCalledTimes(1);
  });
});

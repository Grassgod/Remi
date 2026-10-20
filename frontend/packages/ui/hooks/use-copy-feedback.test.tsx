// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCopyFeedback } from "./use-copy-feedback";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCopyFeedback", () => {
  it("shows Copied for the feedback window", () => {
    const { result } = renderHook(() => useCopyFeedback(2000));
    expect(result.current[0]).toBe(false);

    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    act(() => vi.advanceTimersByTime(1999));
    expect(result.current[0]).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBe(false);
  });

  it("restarts the window when copied again", () => {
    const { result } = renderHook(() => useCopyFeedback(2000));
    act(() => result.current[1]());
    act(() => vi.advanceTimersByTime(1500));
    act(() => result.current[1]());
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(1500));
    expect(result.current[0]).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current[0]).toBe(false);
  });

  it("hides at once on reset", () => {
    const { result } = renderHook(() => useCopyFeedback(2000));
    act(() => result.current[1]());
    act(() => result.current[2]());
    expect(result.current[0]).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer when unmounted within the window", () => {
    const { result, unmount } = renderHook(() => useCopyFeedback(2000));
    act(() => result.current[1]());
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useResolvedThreads } from "./use-resolved-threads";

describe("useResolvedThreads", () => {
  it("starts with every resolved thread folded", () => {
    const { result } = renderHook(() => useResolvedThreads());
    expect(result.current.expanded.size).toBe(0);
  });

  it("expands and folds a single thread", () => {
    const { result } = renderHook(() => useResolvedThreads());

    act(() => result.current.toggle("c1", true));
    expect(result.current.expanded.has("c1")).toBe(true);

    act(() => result.current.toggle("c1", false));
    expect(result.current.expanded.has("c1")).toBe(false);
  });

  it("clear() folds a thread so re-resolving it never re-opens expanded", () => {
    const { result } = renderHook(() => useResolvedThreads());

    act(() => result.current.toggle("c1", true));
    act(() => result.current.clear("c1"));
    expect(result.current.expanded.has("c1")).toBe(false);
  });

  it("clear() on an already-folded thread keeps the set identity", () => {
    const { result } = renderHook(() => useResolvedThreads());
    const before = result.current.expanded;

    act(() => result.current.clear("never-expanded"));
    expect(result.current.expanded).toBe(before);
  });
});

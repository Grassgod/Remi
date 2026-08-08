import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useActivityExpansion } from "./use-activity-expansion";

describe("useActivityExpansion", () => {
  it("expands only the trailing block until the user says otherwise", () => {
    const { result } = renderHook(() => useActivityExpansion());

    expect(result.current.isExpanded("a1", false)).toBe(false);
    expect(result.current.isExpanded("a2", true)).toBe(true);
  });

  it("keeps a manually collapsed block collapsed after it stops trailing", () => {
    const { result } = renderHook(() => useActivityExpansion());

    act(() => result.current.toggle("a1", true));
    expect(result.current.isExpanded("a1", true)).toBe(false);
    expect(result.current.isExpanded("a1", false)).toBe(false);
  });

  it("keeps a manually expanded block expanded once a newer block trails", () => {
    const { result } = renderHook(() => useActivityExpansion());

    act(() => result.current.toggle("a1", false));
    expect(result.current.isExpanded("a1", false)).toBe(true);
  });

  it("lets a block flip back to the opposite override", () => {
    const { result } = renderHook(() => useActivityExpansion());

    act(() => result.current.toggle("a1", false));
    act(() => result.current.toggle("a1", true));
    expect(result.current.isExpanded("a1", true)).toBe(false);

    act(() => result.current.toggle("a1", false));
    expect(result.current.isExpanded("a1", false)).toBe(true);
  });

  it("remembers 'show older' independently of the fold state", () => {
    const { result } = renderHook(() => useActivityExpansion());

    expect(result.current.isShowingOlder("a1")).toBe(false);
    act(() => result.current.showOlder("a1"));
    expect(result.current.isShowingOlder("a1")).toBe(true);

    act(() => result.current.toggle("a1", true));
    act(() => result.current.toggle("a1", false));
    expect(result.current.isShowingOlder("a1")).toBe(true);
  });

  it("tracks each block separately", () => {
    const { result } = renderHook(() => useActivityExpansion());

    act(() => result.current.showOlder("a1"));
    expect(result.current.isShowingOlder("a2")).toBe(false);
  });
});

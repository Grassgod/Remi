import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSidebarSections } from "./use-sidebar-sections";

describe("useSidebarSections", () => {
  it("opens every inline fold and leaves the metadata dialog closed", () => {
    const { result } = renderHook(() => useSidebarSections());

    expect(result.current.isOpen("properties")).toBe(true);
    expect(result.current.isOpen("parentIssue")).toBe(true);
    expect(result.current.isOpen("pullRequests")).toBe(true);
    expect(result.current.isOpen("details")).toBe(true);
    expect(result.current.isOpen("tokenUsage")).toBe(true);
    expect(result.current.isOpen("metadata")).toBe(false);
  });

  it("toggles one section without touching its neighbours", () => {
    const { result } = renderHook(() => useSidebarSections());

    act(() => result.current.toggle("properties"));
    expect(result.current.isOpen("properties")).toBe(false);
    expect(result.current.isOpen("details")).toBe(true);

    act(() => result.current.toggle("properties"));
    expect(result.current.isOpen("properties")).toBe(true);
  });

  it("setOpen drives the metadata dialog both ways", () => {
    const { result } = renderHook(() => useSidebarSections());

    act(() => result.current.setOpen("metadata", true));
    expect(result.current.isOpen("metadata")).toBe(true);

    act(() => result.current.setOpen("metadata", false));
    expect(result.current.isOpen("metadata")).toBe(false);
  });

  it("setOpen to the current value is a no-op", () => {
    const { result } = renderHook(() => useSidebarSections());
    const before = result.current.isOpen;

    act(() => result.current.setOpen("details", true));
    expect(result.current.isOpen).toBe(before);
  });
});

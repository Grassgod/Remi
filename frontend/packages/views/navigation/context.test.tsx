// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { NavigationProvider } from "./context";
import type { NavigationAdapter } from "./types";

function makeAdapter(overrides: Partial<NavigationAdapter> = {}): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/",
    searchParams: new URLSearchParams(),
    getShareableUrl: (p) => p,
    ...overrides,
  };
}

function dispatchNavigate(detail: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent("multimira:navigate", { detail }));
  });
}

describe("NavigationProvider multimira:navigate listener", () => {
  it("pushes the path dispatched by openLink (editor/utils/link-handler.ts)", () => {
    const push = vi.fn();
    render(
      <NavigationProvider value={makeAdapter({ push })}>
        <div />
      </NavigationProvider>,
    );

    dispatchNavigate({ path: "/acme/projects/p1/wiki/deploy" });
    expect(push).toHaveBeenCalledWith("/acme/projects/p1/wiki/deploy");
  });

  it("ignores events with a missing or non-string path", () => {
    const push = vi.fn();
    render(
      <NavigationProvider value={makeAdapter({ push })}>
        <div />
      </NavigationProvider>,
    );

    dispatchNavigate({});
    dispatchNavigate({ path: 42 });
    dispatchNavigate({ path: "" });
    dispatchNavigate(undefined);
    expect(push).not.toHaveBeenCalled();
  });

  it("removes the listener on unmount", () => {
    const push = vi.fn();
    const { unmount } = render(
      <NavigationProvider value={makeAdapter({ push })}>
        <div />
      </NavigationProvider>,
    );
    unmount();

    dispatchNavigate({ path: "/acme/issues" });
    expect(push).not.toHaveBeenCalled();
  });
});

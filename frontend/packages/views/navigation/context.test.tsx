// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NavigationProvider, useIsNavigating, useNavigation } from "./context";
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

describe("NavigationProvider replaceUrl", () => {
  function Consumer() {
    const navigation = useNavigation();
    const pending = useIsNavigating();
    return (
      <button onClick={() => navigation.replaceUrl?.("/acme/chat?session=s2")}>
        {pending ? "pending" : "idle"}
      </button>
    );
  }

  it("forwards the URL-only replacement outside the route transition", () => {
    const replaceUrl = vi.fn();
    const replace = vi.fn();
    render(
      <NavigationProvider value={makeAdapter({ replaceUrl, replace })}>
        <Consumer />
      </NavigationProvider>,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(replaceUrl).toHaveBeenCalledWith("/acme/chat?session=s2");
    expect(replace).not.toHaveBeenCalled();
    // No route commit follows, so the navigation progress never starts.
    expect(screen.getByRole("button")).toHaveTextContent("idle");
  });

  it("leaves replaceUrl undefined when the platform has none", () => {
    const seen: { navigation?: NavigationAdapter } = {};
    function Probe() {
      seen.navigation = useNavigation();
      return null;
    }
    render(
      <NavigationProvider value={makeAdapter()}>
        <Probe />
      </NavigationProvider>,
    );
    expect(seen.navigation).toBeDefined();
    expect(seen.navigation?.replaceUrl).toBeUndefined();
  });
});

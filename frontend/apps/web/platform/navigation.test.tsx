import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useNavigation } from "@multiremi/views/navigation";

const router = vi.hoisted(() => ({
  push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/acme/chat",
  useSearchParams: () => new URLSearchParams("session=s1"),
}));

import { WebNavigationProvider } from "./navigation";

function ReplaceUrlButton({ path }: { path: string }) {
  const navigation = useNavigation();
  return <button onClick={() => navigation.replaceUrl?.(path)}>replace url</button>;
}

afterEach(() => {
  vi.restoreAllMocks();
  router.replace.mockReset();
});

describe("WebNavigationProvider replaceUrl", () => {
  it("replaces the history entry without a router navigation", () => {
    window.history.replaceState({ __NA: true }, "", "/acme/chat?session=s1");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const length = window.history.length;
    render(
      <WebNavigationProvider>
        <ReplaceUrlButton path="/acme/chat?session=s2" />
      </WebNavigationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "replace url" }));

    // Null state: the App Router's patched replaceState only syncs
    // usePathname/useSearchParams for entries without its own marker.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/acme/chat?session=s2");
    expect(window.location.search).toBe("?session=s2");
    expect(window.history.length).toBe(length);
    expect(router.replace).not.toHaveBeenCalled();
  });
});

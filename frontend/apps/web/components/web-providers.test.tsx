import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { CoreProviderProps } from "@multiremi/core/platform";
import { ApiClient, setApiInstance } from "@multiremi/core/api";
import { createAuthStore } from "@multiremi/core/auth";
import type { StorageAdapter } from "@multiremi/core/types";
import { WebProviders } from "./web-providers";

const captured = vi.hoisted(() => ({ props: null as CoreProviderProps | null }));

vi.mock("@multiremi/core/platform", () => ({
  CoreProvider: (props: CoreProviderProps) => {
    captured.props = props;
    return props.children;
  },
}));
vi.mock("@/platform/navigation", () => ({
  WebNavigationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pageview-tracker", () => ({ PageviewTracker: () => null }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function browserStore() {
  render(<WebProviders locale="en" resources={{}}><div>Application</div></WebProviders>);
  const props = captured.props!;
  const client = new ApiClient("");
  setApiInstance(client);
  const data = new Map<string, string>();
  const storage: StorageAdapter = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
  return {
    client, data,
    store: createAuthStore({
      api: client, storage,
      cookieAuth: props.cookieAuth,
      onLogin: props.onLogin,
      onLogout: props.onLogout,
    }),
  };
}

beforeEach(() => {
  captured.props = null;
  document.cookie = "multimira_logged_in=; path=/; max-age=0";
});
afterEach(() => vi.unstubAllGlobals());

describe("WebProviders logout", () => {
  it("posts browser cookies to /auth/logout even though the Web store uses bearer tokens", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ token: "browser-session-fixture", user: { id: "reader", email: "reader@example.test" } }))
      .mockResolvedValueOnce(json({ message: "logged out" }));
    vi.stubGlobal("fetch", fetchMock);
    const { store, data } = browserStore();
    expect(captured.props?.cookieAuth).toBe(false);
    await store.getState().loginWithPassword("reader@example.test", "fixture-password-42");
    expect(document.cookie).toContain("multimira_logged_in=1");
    expect(data.get("multimira_token")).toBe("browser-session-fixture");

    store.getState().logout();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/auth/logout", expect.objectContaining({
      method: "POST", credentials: "include",
    })));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.cookie).not.toContain("multimira_logged_in");
    expect(data.has("multimira_token")).toBe(false);
    expect(store.getState().user).toBeNull();
  });

  it("also clears a browser session when password login fails before establishing client auth", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: "Invalid credentials" }, 401))
      .mockResolvedValueOnce(json({ message: "logged out" }));
    vi.stubGlobal("fetch", fetchMock);
    const { store, data } = browserStore();
    data.set("multimira_token", "stale-session-fixture");
    document.cookie = "multimira_logged_in=1; path=/";

    await expect(store.getState().loginWithPassword("reader@example.test", "incorrect-fixture"))
      .rejects.toThrow("Invalid credentials");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/auth/logout", expect.objectContaining({
      method: "POST", credentials: "include",
    })));
    expect(document.cookie).not.toContain("multimira_logged_in");
    expect(data.has("multimira_token")).toBe(false);
    expect(store.getState().user).toBeNull();
    expect(store.getState().isLoading).toBe(false);
  });

  it("still clears local auth if the server cannot be reached during logout", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Network unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const { store, data } = browserStore();
    data.set("multimira_token", "stale-session-fixture");
    document.cookie = "multimira_logged_in=1; path=/";

    expect(() => store.getState().logout()).not.toThrow();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(document.cookie).not.toContain("multimira_logged_in");
    expect(data.has("multimira_token")).toBe(false);
    expect(store.getState().user).toBeNull();
  });

  it("does not add browser session revocation to a token-only store without the Web hook", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("");
    const storage: StorageAdapter = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
    const store = createAuthStore({ api: client, storage, cookieAuth: false });

    store.getState().logout();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.removeItem).toHaveBeenCalledWith("multimira_token");
  });
});

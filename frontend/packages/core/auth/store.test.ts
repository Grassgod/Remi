import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import { ApiError } from "../api/client";
import type { StorageAdapter, User } from "../types";
import { createAuthStore } from "./store";

const fakeUser: User = {
  id: "u1",
  name: "Alice",
  email: "alice@example.com",
  avatar_url: null,
} as User;

function makeStorage(initial: Record<string, string> = {}): StorageAdapter & {
  snapshot: () => Record<string, string>;
} {
  const data = { ...initial };
  return {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
    snapshot: () => ({ ...data }),
  };
}

function makeApi(getMe: () => Promise<User>): ApiClient {
  return {
    setToken: vi.fn(),
    getMe,
    // Only the methods touched by store.initialize are needed. Cast to
    // ApiClient for type compatibility — the store treats it opaquely.
  } as unknown as ApiClient;
}

describe("authStore.initialize — token mode", () => {
  it("keeps the stored token when getMe fails with a non-401 ApiError (e.g. 500)", async () => {
    const storage = makeStorage({ multimira_token: "t" });
    const api = makeApi(() =>
      Promise.reject(new ApiError("server error", 500, "Internal Server Error")),
    );
    const store = createAuthStore({ api, storage });

    await store.getState().initialize();

    expect(store.getState().user).toBeNull();
    expect(store.getState().isLoading).toBe(false);
    expect(storage.snapshot().multimira_token).toBe("t");
  });

  it("keeps the stored token on a network failure (non-ApiError throw)", async () => {
    const storage = makeStorage({ multimira_token: "t" });
    const api = makeApi(() => Promise.reject(new TypeError("fetch failed")));
    const store = createAuthStore({ api, storage });

    await store.getState().initialize();

    expect(store.getState().user).toBeNull();
    expect(storage.snapshot().multimira_token).toBe("t");
  });

  it("on 401, leaves storage cleanup to ApiClient.onUnauthorized and resets state", async () => {
    // Simulate the real path: ApiClient fires onUnauthorized on 401, which
    // removes the token from storage. The store's catch block must not
    // duplicate or short-circuit this — it should only reset in-memory
    // auth state.
    const storage = makeStorage({ multimira_token: "t" });
    const api = makeApi(() => {
      storage.removeItem("multimira_token"); // stand-in for onUnauthorized
      return Promise.reject(new ApiError("unauthorized", 401, "Unauthorized"));
    });
    const store = createAuthStore({ api, storage });

    await store.getState().initialize();

    expect(store.getState().user).toBeNull();
    expect(storage.snapshot().multimira_token).toBeUndefined();
  });

  it("populates user when getMe succeeds", async () => {
    const storage = makeStorage({ multimira_token: "t" });
    const api = makeApi(() => Promise.resolve(fakeUser));
    const store = createAuthStore({ api, storage });

    await store.getState().initialize();

    expect(store.getState().user).toEqual(fakeUser);
    expect(storage.snapshot().multimira_token).toBe("t");
  });
});

describe("authStore.loginWithPassword", () => {
  function passwordApi() {
    return {
      ...makeApi(() => Promise.resolve(fakeUser)),
      passwordLogin: vi.fn().mockResolvedValue({ token: "password-session", user: fakeUser }),
      logout: vi.fn().mockResolvedValue(undefined),
    } as unknown as ApiClient;
  }

  it("stores only the session token and authenticated user, and returns the same token for CLI handoff", async () => {
    const storage = makeStorage();
    const api = passwordApi();
    const onLogin = vi.fn();
    const store = createAuthStore({ api, storage, onLogin });

    await expect(store.getState().loginWithPassword("reader@localhost", "fixture-password-42"))
      .resolves.toEqual({ token: "password-session", user: fakeUser });

    expect(api.passwordLogin).toHaveBeenCalledWith("reader@localhost", "fixture-password-42");
    expect(storage.snapshot()).toEqual({ multimira_token: "password-session" });
    expect(api.setToken).toHaveBeenCalledWith("password-session");
    expect(store.getState().user).toEqual(fakeUser);
    expect(store.getState().isLoading).toBe(false);
    expect(onLogin).toHaveBeenCalledOnce();
    expect(store.getState()).not.toHaveProperty("password");
  });

  it("keeps password sessions out of adapter storage when cookie auth is configured", async () => {
    const storage = makeStorage();
    const api = passwordApi();
    const store = createAuthStore({ api, storage, cookieAuth: true });
    await store.getState().loginWithPassword("reader@example.test", "fixture-password-42");
    expect(storage.snapshot()).toEqual({});
    expect(api.setToken).not.toHaveBeenCalled();
    expect(store.getState().user).toEqual(fakeUser);
  });

  it("clears a stale authenticated state when credentials or response validation fail", async () => {
    const storage = makeStorage({ multimira_token: "stale-session" });
    const api = passwordApi();
    vi.mocked(api.passwordLogin).mockRejectedValue(new Error("Login rejected"));
    const onLogin = vi.fn();
    const store = createAuthStore({ api, storage, onLogin });
    store.setState({ user: fakeUser });

    await expect(store.getState().loginWithPassword("reader@example.test", "incorrect-fixture"))
      .rejects.toThrow("Login rejected");

    expect(store.getState().user).toBeNull();
    expect(store.getState().isLoading).toBe(false);
    expect(storage.snapshot()).toEqual({});
    expect(api.setToken).toHaveBeenLastCalledWith(null);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("cleans up a partial session when persistence fails after the server authenticates", async () => {
    const storage = makeStorage();
    storage.setItem = () => { throw new Error("Storage unavailable"); };
    const api = passwordApi();
    const store = createAuthStore({ api, storage });
    await expect(store.getState().loginWithPassword("reader@example.test", "fixture-password-42"))
      .rejects.toThrow("Storage unavailable");
    expect(store.getState().user).toBeNull();
    expect(api.setToken).toHaveBeenLastCalledWith(null);
  });
});

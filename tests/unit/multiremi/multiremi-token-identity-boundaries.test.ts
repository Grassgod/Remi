import { afterEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { localAuthResponse } from "@multiremi/api/helpers/login.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

it("binds native credentials to the requester across identity aliases and token types", async () => {
  const store = createLocalStore();
  const alice = store.getOrCreateUser({ email: "alice@example.invalid", name: "Alice" });
  const bob = store.getOrCreateUser({ email: "bob@example.invalid", name: "Bob" });
  const a = store.createWorkspace({ name: "A", slug: "a" }, alice.id);
  const b = store.createWorkspace({ name: "B", slug: "b" }, bob.id);
  const login = await store.createAccessToken({ workspaceId: "local", userId: alice.id, name: "Alice", type: "pat", purpose: "session" });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  for (const input of [
    { userId: bob.id }, { user_id: bob.id }, { userId: null, user_id: bob.id },
    { userId: "local" }, { user_id: null }, { userId: "", user_id: bob.id }, {}, { type: "daemon", user_id: bob.id }, { type: null, user_id: bob.id },
  ]) {
    const response = await app.request("/api/multiremi/tokens", {
      method: "POST", headers: { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: a.id, name: "Requested", ...input }),
    });
    expect(response.status).toBe(201);
    const { token } = await response.json();
    expect(token.userId).toBe(alice.id);
    if (token.type === "pat") {
      expect((await app.request(`/api/workspaces/${b.id}`, { headers: { Authorization: `Bearer ${token.token}` } })).status).toBe(404);
    }
  }
});

it("lets a historical local login session access only workspaces it belongs to", async () => {
  const store = createLocalStore();
  const mine = store.createWorkspace({ name: "Mine", slug: "mine" }, "local");
  const other = store.getOrCreateUser({ email: "other@example.invalid", name: "Other" });
  const theirs = store.createWorkspace({ name: "Theirs", slug: "theirs" }, other.id);
  store.registerRuntime({ id: "rt_mine", name: "Mine", provider: "codex", workspaceId: mine.id, ownerId: "local", visibility: "public" });
  store.registerRuntime({ id: "rt_theirs", name: "Theirs", provider: "codex", workspaceId: theirs.id, ownerId: other.id, visibility: "public" });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  for (const purpose of ["session", "personal", "cli"] as const) {
    const token = purpose === "session"
      ? await localAuthResponse(store, { email: store.getCurrentUser("local").email, name: "Local owner" })
      : await store.createAccessToken({ workspaceId: "local", userId: "local", name: purpose, type: "pat", purpose });
    const headers = { Authorization: `Bearer ${token.token}` };
    expect((await app.request(`/api/workspaces/${mine.id}`, { headers })).status).toBe(purpose === "session" ? 200 : 404);
    expect((await app.request(`/api/workspaces/${theirs.id}`, { headers })).status).toBe(404);
    expect((await app.request("/api/multiremi/runtimes/rt_mine", { headers })).status).toBe(purpose === "session" ? 200 : 404);
    expect((await app.request("/api/multiremi/runtimes/rt_theirs", { headers })).status).toBe(404);
  }
});

it("prevents legacy workspace credentials from minting login sessions", async () => {
  const store = createLocalStore();
  const token = await store.createAccessToken({ name: "Legacy", type: "pat" });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const response = await app.request("/api/multiremi/tokens", {
    method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Promoted", purpose: " SESSION " }),
  });
  expect(response.status).toBe(400);
});

it("preserves explicit ownership for master-token and open-mode provisioning", async () => {
  for (const authToken of ["root-secret", ""]) {
    const store = createLocalStore();
    const app = createMultiremiApp({ store, authToken });
    const response = await app.request("/api/multiremi/tokens", {
      method: "POST", headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Provisioned", user_id: "provisioned-user", type: "daemon" }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).token.userId).toBe("provisioned-user");
  }
});

it("keeps legacy workspace credentials scoped when provisioning native tokens", async () => {
  const store = createLocalStore();
  const workspace = store.createWorkspace({ name: "Legacy", slug: "legacy" }, "local");
  const token = await store.createAccessToken({ workspaceId: workspace.id, name: "Legacy", type: "pat" });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const response = await app.request("/api/multiremi/tokens", {
    method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: "local", name: "Escaped" }),
  });
  expect(response.status).toBe(404);
});

it("scopes native token listing and revocation for legacy credentials", async () => {
  const store = createLocalStore();
  const workspace = store.createWorkspace({ name: "Scoped", slug: "scoped" }, "local");
  const caller = await store.createAccessToken({ workspaceId: workspace.id, name: "Caller", type: "pat" });
  const victim = await store.createAccessToken({ workspaceId: "local", name: "Victim", type: "pat" });
  const owned = await store.createAccessToken({ workspaceId: workspace.id, name: "Owned", type: "pat" });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = { Authorization: `Bearer ${caller.token}` };
  const listed = await app.request("/api/multiremi/tokens?workspaceId=local", { headers });
  const revoked = await app.request(`/api/multiremi/tokens/${victim.id}`, { method: "DELETE", headers });
  expect([listed.status, revoked.status]).toEqual([404, 404]);
  expect(store.getAccessToken(victim.id)?.revokedAt).toBeNull();
  expect((await app.request(`/api/multiremi/tokens?workspaceId=${workspace.id}`, { headers })).status).toBe(200);
  expect((await app.request(`/api/multiremi/tokens/${owned.id}`, { method: "DELETE", headers })).status).toBe(200);
  expect(store.getAccessToken(owned.id)?.revokedAt).not.toBeNull();
});

it("retains native token listing and revocation for master-token and open mode", async () => {
  for (const authToken of ["root-secret", ""]) {
    const store = createLocalStore();
    const token = await store.createAccessToken({ name: "Managed", type: "pat" });
    const app = createMultiremiApp({ store, authToken });
    const headers = { Authorization: `Bearer ${authToken}` };
    expect((await app.request("/api/multiremi/tokens?workspaceId=local", { headers })).status).toBe(200);
    expect((await app.request(`/api/multiremi/tokens/${token.id}`, { method: "DELETE", headers })).status).toBe(200);
  }
});

it("preserves human local identity and legacy workspace scope during CLI exchange", async () => {
  const store = createLocalStore();
  const workspace = store.createWorkspace({ name: "CLI", slug: "cli" }, "local");
  const login = await localAuthResponse(store, { email: store.getCurrentUser("local").email });
  const legacy = await store.createAccessToken({ workspaceId: workspace.id, name: "Machine", type: "pat" });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const results: number[] = [];
  for (const source of [login, legacy]) {
    const response = await app.request("/api/cli-token", { method: "POST", headers: { Authorization: `Bearer ${source.token}` } });
    expect(response.status).toBe(200);
    const { token } = await response.json();
    const headers = { Authorization: `Bearer ${token}` };
    results.push((await app.request(`/api/workspaces/${workspace.id}`, { headers })).status);
    if (source === legacy) results.push((await app.request("/api/workspaces/local", { headers })).status);
  }
  expect(results).toEqual([200, 200, 404]);
});

it("cannot promote or impersonate through native and compatibility purpose/type inputs", async () => {
  const store = createLocalStore();
  const alice = store.getOrCreateUser({ email: "mint-alice@example.invalid", name: "Alice" });
  const workspace = store.createWorkspace({ name: "Mint", slug: "mint" }, alice.id);
  const login = await store.createAccessToken({ workspaceId: "local", userId: alice.id, name: "Login", type: "pat", purpose: "session" });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  for (const path of ["/api/multiremi/tokens", "/api/tokens"]) {
    for (const purpose of ["session", " SESSION ", ["session"]]) {
      const response = await app.request(path, {
        method: "POST", headers: { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspace.id, name: "Spoof", userId: null, user_id: "local", purpose, type: ["pat"] }),
      });
      if (path === "/api/multiremi/tokens") {
        expect(response.status).toBe(400);
      } else {
        expect(response.status).toBe(201);
        const credential = await response.json();
        const stored = store.getAccessToken(credential.id);
        expect(stored?.userId).toBe(alice.id);
        expect(stored?.purpose).toBe("personal");
        expect(stored?.type).toBe("pat");
      }
    }
  }
});

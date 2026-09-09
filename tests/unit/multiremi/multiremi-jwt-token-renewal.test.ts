import { afterEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

it("keeps a renewed local JWT a human session and preserves master and open-mode renewal", async () => {
  const store = createLocalStore();
  const mine = store.createWorkspace({ name: "Local owner", slug: "renew-local" }, "local");
  const bob = store.getOrCreateUser({ email: "renew-other@example.test", name: "Other" });
  const theirs = store.createWorkspace({ name: "Other", slug: "renew-other" }, bob.id);
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = {
    Authorization: `Bearer ${signTestJwt({ sub: "local", exp: Math.floor(Date.now() / 1000) + 60 })}`,
    "Content-Type": "application/json",
  };
  const denied = await app.request("/api/tokens/current/renew", {
    method: "POST", headers, body: JSON.stringify({ workspace_id: theirs.id }),
  });
  expect(denied.status).toBe(404);
  const response = await app.request("/api/tokens/current/renew", { method: "POST", headers });
  expect(response.status).toBe(201);
  const credential = await response.json();
  expect(credential).toMatchObject({ userId: "local", type: "pat", purpose: "session" });
  const renewedHeaders = { Authorization: `Bearer ${credential.access_token}` };
  expect((await app.request(`/api/workspaces/${mine.id}`, { headers: renewedHeaders })).status).toBe(200);
  expect((await app.request(`/api/workspaces/${theirs.id}`, { headers: renewedHeaders })).status).toBe(404);
  for (const authToken of ["root-secret", null]) {
    const trustedApp = createMultiremiApp({ store, authToken });
    const trustedHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) trustedHeaders.Authorization = `Bearer ${authToken}`;
    const trusted = await trustedApp.request("/api/tokens/current/renew", {
      method: "POST", headers: trustedHeaders,
      body: JSON.stringify({ workspaceId: theirs.id, name: "Provisioned", type: "pat", expiresInDays: 7 }),
    });
    expect(trusted.status).toBe(201);
    expect(await trusted.json()).toMatchObject({ userId: "local", workspaceId: theirs.id, name: "Provisioned", type: "pat", purpose: "personal" });
  }
});

it("binds JWT renewal to the user and workspace without accepting privileged token types", async () => {
  const store = createLocalStore();
  const alice = store.getOrCreateUser({ email: "renew-alice@example.test", name: "Alice" });
  const bob = store.getOrCreateUser({ email: "renew-bob@example.test", name: "Bob" });
  const mine = store.createWorkspace({ name: "Mine", slug: "renew-mine" }, alice.id);
  const theirs = store.createWorkspace({ name: "Theirs", slug: "renew-theirs" }, bob.id);
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = {
    Authorization: `Bearer ${signTestJwt({ sub: alice.id, exp: Math.floor(Date.now() / 1000) + 60 })}`,
    "Content-Type": "application/json",
  };
  for (const [slug, expected] of [[mine.slug, 201], [theirs.slug, 404], ["missing", 404]] as const) {
    const selected = await app.request("/api/tokens/current/renew", {
      method: "POST", headers: { ...headers, "X-Workspace-Slug": slug },
    });
    expect(selected.status).toBe(expected);
    if (expected === 201) expect(await selected.json()).toMatchObject({ workspaceId: mine.id, userId: alice.id });
  }
  for (const workspaceKey of ["workspaceId", "workspace_id"]) {
    const denied = await app.request("/api/tokens/current/renew", {
      method: "POST", headers, body: JSON.stringify({ [workspaceKey]: theirs.id }),
    });
    expect(denied.status).toBe(404);
    for (const type of ["pat", "daemon", "task", ["daemon"]]) {
      const response = await app.request("/api/tokens/current/renew", {
        method: "POST", headers,
        body: JSON.stringify({ [workspaceKey]: mine.id, userId: "local", user_id: bob.id, type, purpose: "session" }),
      });
      expect(response.status).toBe(201);
      const credential = await response.json();
      expect(credential).toMatchObject({ workspaceId: mine.id, userId: alice.id, type: "pat", purpose: "personal", token_type: "bearer" });
      const renewedHeaders = { Authorization: `Bearer ${credential.access_token}` };
      expect((await app.request(`/api/workspaces/${mine.id}`, { headers: renewedHeaders })).status).toBe(200);
      expect((await app.request(`/api/workspaces/${theirs.id}`, { headers: renewedHeaders })).status).toBe(404);
    }
  }
});

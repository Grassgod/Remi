import { describe, expect, it } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api.js";

async function setup() {
  const store = new MultiremiStore(openSqliteDatabase(":memory:"));
  store.ensureLocalWorkspace();
  store.upsertRelayConfig("local", "claude", {
    fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } }),
    tokenOp: "set",
    authToken: "TOPSECRET",
  });
  // Real agents authenticate as the workspace owner (a PAT for the "local" owner).
  const owner = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "agent", userId: "local" });
  // A non-admin member of the same workspace must never receive the fleet secret.
  store.createWorkspaceMember({ id: "mem_local_bob", workspaceId: "local", userId: "bob", name: "Bob", email: "bob@example.com", role: "member" });
  const member = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "bob", userId: "bob" });
  const app = createMultiremiApp({ store, authToken: "MASTER" });
  return { store, app, ownerToken: owner.token, memberToken: member.token };
}

function register(
  app: ReturnType<typeof createMultiremiApp>,
  token: string,
  daemonId = "d1",
) {
  return app.request("/api/daemon/register", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ daemon_id: daemonId, workspace_id: "local", runtimes: [{ type: "claude" }] }),
  });
}

describe("relay config API — security", () => {
  it("gives the plaintext relay token to an owner/admin daemon but not a non-admin member", async () => {
    const { app, ownerToken, memberToken } = await setup();

    // The agent (owner PAT) legitimately needs the token to configure its CLIs.
    const asOwner = await (await register(app, ownerToken)).json();
    expect(asOwner.relay?.claude?.auth_token).toBe("TOPSECRET");

    // A non-admin member's token must NOT leak the fleet secret.
    const asMember = await (await register(app, memberToken, "d2")).json();
    expect(JSON.stringify(asMember.relay)).not.toContain("TOPSECRET");
    expect(asMember.relay?.claude ?? null).toBeNull();
  });

  it("the discovery toggle route is reachable (not shadowed by /:engine)", async () => {
    const { app } = await setup();
    const res = await app.request("/api/workspaces/local/relay-config/discovery", {
      method: "PUT",
      headers: { Authorization: "Bearer MASTER", "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).model_discovery).toBe(true);
  });

  it("rejects saving a token without a gateway base_url in the fragment", async () => {
    const { app } = await setup();
    // claude fragment with no ANTHROPIC_BASE_URL but a token set → 400
    const res = await app.request("/api/workspaces/local/relay-config/claude", {
      method: "PUT",
      headers: { Authorization: "Bearer MASTER", "content-type": "application/json" },
      body: JSON.stringify({ fragment: "{}", token_op: "set", auth_token: "sk-new" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("relay config API — Antigravity engine", () => {
  const AGY_FRAGMENT = JSON.stringify({ base_url: "https://ai.openremi.fun/antigravity", default_model: "gemini-3.7-flash" });
  const admin = { Authorization: "Bearer MASTER", "content-type": "application/json" };
  const put = (app: ReturnType<typeof createMultiremiApp>, body: unknown) =>
    app.request("/api/workspaces/local/relay-config/antigravity", { method: "PUT", headers: admin, body: JSON.stringify(body) });

  it("saves the engine, masks its key for the browser and reveals it to an administrator", async () => {
    const { app } = await setup();
    const saved = await put(app, { fragment: AGY_FRAGMENT, token_op: "set", auth_token: "AGY-SECRET" });
    expect(saved.status).toBe(200);
    const browser = await saved.json();
    expect(browser.antigravity).toEqual({ fragment: AGY_FRAGMENT, hasToken: true, revision: 1 });
    expect(JSON.stringify(browser)).not.toContain("AGY-SECRET");

    const read = await (await app.request("/api/workspaces/local/relay-config", { headers: admin })).json();
    expect(read.antigravity.hasToken).toBe(true);
    expect(JSON.stringify(read)).not.toContain("AGY-SECRET");

    const reveal = await app.request("/api/workspaces/local/relay-config/antigravity/reveal", { method: "POST", headers: admin });
    expect(reveal.status).toBe(200);
    expect(reveal.headers.get("Cache-Control")).toBe("no-store");
    expect((await reveal.json()).token).toBe("AGY-SECRET");
  });

  it("delivers the engine on the daemon wire to an administrator only", async () => {
    const { store, app, ownerToken, memberToken } = await setup();
    store.upsertRelayConfig("local", "antigravity", { fragment: AGY_FRAGMENT, tokenOp: "set", authToken: "AGY-SECRET" });

    const asOwner = await (await register(app, ownerToken)).json();
    expect(asOwner.relay.antigravity).toEqual({ fragment: AGY_FRAGMENT, auth_token: "AGY-SECRET", revision: 1 });
    // The 1M context list is a Claude-only declaration and stays off the other engines.
    expect(asOwner.relay.antigravity.one_million_models).toBeUndefined();

    const asMember = await (await register(app, memberToken, "d2")).json();
    expect(JSON.stringify(asMember.relay)).not.toContain("AGY-SECRET");
    expect(asMember.relay?.antigravity ?? null).toBeNull();
  });

  it("answers null for an unconfigured engine on the daemon wire", async () => {
    const { app, ownerToken } = await setup();
    const asOwner = await (await register(app, ownerToken)).json();
    expect(asOwner.relay.antigravity).toBeNull();
  });

  it("rejects an invalid fragment and a key without a gateway base_url", async () => {
    const { store, app } = await setup();
    const versioned = await put(app, {
      fragment: JSON.stringify({ base_url: "https://ai.openremi.fun/v1beta" }), token_op: "set", auth_token: "AGY-SECRET",
    });
    expect(versioned.status).toBe(400);
    expect((await versioned.json()).error).toContain("without /v1beta or /v1");

    const extraKey = await put(app, { fragment: JSON.stringify({ base_url: "https://ai.openremi.fun", api_key: "x" }), token_op: "keep" });
    expect(extraKey.status).toBe(400);

    const noBase = await put(app, { fragment: JSON.stringify({ default_model: "gemini-3.7-flash" }), token_op: "set", auth_token: "AGY-SECRET" });
    expect(noBase.status).toBe(400);
    expect((await noBase.json()).error).toBe("fragment must define the gateway base_url when a token is set");
    expect(store.getRelayConfigForDaemon("local").antigravity).toBeNull();

    // Without a key the fragment alone may be stored (e.g. drafted before the key exists).
    expect((await put(app, { fragment: JSON.stringify({ default_model: "gemini-3.7-flash" }), token_op: "keep" })).status).toBe(200);
  });

  it("keeps the reasoning-level and 1M context routes closed for the engine", async () => {
    const { app } = await setup();
    const base = "/api/workspaces/local/relay-config/antigravity";
    const getLevels = await app.request(`${base}/reasoning-levels`, { headers: admin });
    expect(getLevels.status).toBe(400);
    expect((await getLevels.json()).error).toBe("reasoning levels are not supported for antigravity");
    const putLevels = await app.request(`${base}/reasoning-levels`, {
      method: "PUT", headers: admin, body: JSON.stringify({ model: "gemini-3.7-flash", levels: ["high"] }),
    });
    expect(putLevels.status).toBe(400);
    const context = await app.request(`${base}/context-window`, {
      method: "PUT", headers: admin, body: JSON.stringify({ model: "gemini-3.7-flash", one_million: true }),
    });
    expect(context.status).toBe(400);
  });
});

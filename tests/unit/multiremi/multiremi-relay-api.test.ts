import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api.js";

async function setup() {
  const store = new MultiremiStore(new Database(":memory:"));
  store.ensureLocalWorkspace();
  store.upsertRelayConfig("local", "claude", {
    fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } }),
    tokenOp: "set",
    authToken: "TOPSECRET",
  });
  const daemon = await store.createAccessToken({ workspaceId: "local", type: "daemon", name: "d" });
  const human = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "h" });
  const app = createMultiremiApp({ store, authToken: "MASTER" });
  return { store, app, daemonToken: daemon.token, humanToken: human.token };
}

function register(app: ReturnType<typeof createMultiremiApp>, token: string) {
  return app.request("/api/daemon/register", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ daemon_id: "d1", workspace_id: "local", runtimes: [{ type: "claude" }] }),
  });
}

describe("relay config API — security", () => {
  it("only a daemon token receives the plaintext relay token on register", async () => {
    const { app, daemonToken, humanToken } = await setup();

    const asDaemon = await (await register(app, daemonToken)).json();
    expect(asDaemon.relay?.claude?.auth_token).toBe("TOPSECRET");

    // A human PAT (workspace member, not necessarily admin) must NOT get the token.
    const asHuman = await (await register(app, humanToken)).json();
    expect(JSON.stringify(asHuman.relay)).not.toContain("TOPSECRET");
    expect(asHuman.relay?.claude ?? null).toBeNull();
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

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
  // Real agents authenticate as the workspace owner (a PAT for the "local" owner).
  const owner = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "agent", userId: "local" });
  // A non-admin member of the same workspace must never receive the fleet secret.
  store.createWorkspaceMember({ id: "mem_local_bob", workspaceId: "local", userId: "bob", name: "Bob", email: "bob@example.com", role: "member" });
  const member = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "bob", userId: "bob" });
  const app = createMultiremiApp({ store, authToken: "MASTER" });
  return { store, app, ownerToken: owner.token, memberToken: member.token };
}

function register(app: ReturnType<typeof createMultiremiApp>, token: string) {
  return app.request("/api/daemon/register", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ daemon_id: "d1", workspace_id: "local", runtimes: [{ type: "claude" }] }),
  });
}

describe("relay config API — security", () => {
  it("gives the plaintext relay token to an owner/admin daemon but not a non-admin member", async () => {
    const { app, ownerToken, memberToken } = await setup();

    // The agent (owner PAT) legitimately needs the token to configure its CLIs.
    const asOwner = await (await register(app, ownerToken)).json();
    expect(asOwner.relay?.claude?.auth_token).toBe("TOPSECRET");

    // A non-admin member's token must NOT leak the fleet secret.
    const asMember = await (await register(app, memberToken)).json();
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

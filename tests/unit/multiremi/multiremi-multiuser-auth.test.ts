import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";

// The deployment owner's stable Feishu open_id (see DEFAULT_OWNER_OPEN_ID in the store).
const OWNER_OPEN_ID = "ou_e6b7ffc662b392317275b817295c0b44";

let db: Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
  delete process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN;
  delete process.env.MULTIREMI_OWNER_OPEN_ID;
});

function freshStore(): MultiremiStore {
  db = new Database(":memory:");
  return new MultiremiStore(db);
}

// Reproduce the existing single-user deployment: the seed `local` user owns the
// local workspace, then the multi-user migration tags it with the owner open_id
// (backfillOwnerExternalId runs in migrate()).
function seedDeployment(): MultiremiStore {
  const store = freshStore();
  store.ensureLocalWorkspace(); // local workspace + owner member (user id "local")
  store.migrate(); // re-run migration on the now-populated db to tag the owner
  return store;
}

// Mirror the server's localAuthResponse: resolve/create the distinct user for a
// login identity and mint a token that carries that user's real id.
async function login(
  store: MultiremiStore,
  identity: { externalId?: string; email: string; name?: string },
): Promise<{ userId: string; token: string }> {
  const user = store.getOrCreateUser(identity);
  const created = await store.createAccessToken({
    workspaceId: "local",
    userId: user.id,
    name: `Login ${user.id}`,
    type: "pat",
    expiresInDays: 30,
  });
  return { userId: user.id, token: created.token };
}

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const jsonAuth = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

describe("Multiremi multi-user auth", () => {
  it("AC1/AC7: preserves the existing owner and creates a distinct user for a second login", async () => {
    const store = freshStore();
    store.getCurrentUser(); // seed the legacy single-user "local" record
    store.ensureLocalWorkspace(); // local workspace + owner member (user "local")
    // Reproduce the production bug where the owner's record got overwritten.
    store.updateCurrentUser({ name: "朱欣文", email: "zhuxinwen@corp.com" });

    // "Deploy" the multi-user migration onto the existing database.
    store.migrate();
    expect(store.getUser("local")?.externalId).toBe(OWNER_OPEN_ID);

    // A (hehuajie) logs in via Feishu -> matched to the existing owner by open_id.
    const a = store.getOrCreateUser({ externalId: OWNER_OPEN_ID, email: "hehuajie@corp.com", name: "贺华杰" });
    expect(a.id).toBe("local");
    expect(a.name).toBe("贺华杰");

    // B (zhuxinwen) logs in with a different open_id -> a distinct new user.
    const b = store.getOrCreateUser({ externalId: "ou_zhuxinwen", email: "z@feishu.local", name: "朱欣文" });
    expect(b.id).not.toBe("local");
    expect(b.id).not.toBe(a.id);

    // B does not overwrite A: two distinct records, A still named 贺华杰.
    expect(store.getUser("local")?.name).toBe("贺华杰");
    expect(store.getUserByExternalId("ou_zhuxinwen")?.id).toBe(b.id);
    expect(store.getUserRoleInWorkspace("local", "local")).toBe("owner");
    expect(store.getUserRoleInWorkspace(b.id, "local")).toBeNull();
  });

  it("AC2: a non-member cannot see the workspace or its runtimes", async () => {
    const store = seedDeployment();
    store.registerRuntime({
      id: "rt_pub", name: "Public", provider: "codex",
      workspaceId: "local", ownerId: "local", visibility: "public",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const b = await login(store, { externalId: "ou_b", email: "b@feishu.local", name: "B" });

    const ws = await app.request("/api/workspaces", bearer(b.token));
    expect(ws.status).toBe(200);
    expect(await ws.json()).toEqual([]);

    expect((await app.request("/api/workspaces/local", bearer(b.token))).status).toBe(404);
    expect((await app.request("/api/multiremi/runtimes", bearer(b.token))).status).toBe(404);
    expect((await app.request("/api/multiremi/runtimes/rt_pub", bearer(b.token))).status).toBe(404);
  });

  it("AC3: the owner sees the workspace and all runtimes", async () => {
    const store = seedDeployment();
    store.registerRuntime({ id: "rt_pub", name: "Public", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "public" });
    store.registerRuntime({ id: "rt_priv", name: "Private", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "private" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const a = await login(store, { externalId: OWNER_OPEN_ID, email: "hehuajie@feishu.local", name: "贺华杰" });
    expect(a.userId).toBe("local");

    const ws = await app.request("/api/workspaces", bearer(a.token));
    expect((await ws.json()).map((w: { id: string }) => w.id)).toContain("local");

    const runtimes = await app.request("/api/multiremi/runtimes", bearer(a.token));
    expect(runtimes.status).toBe(200);
    const ids = (await runtimes.json()).runtimes.map((r: { id: string }) => r.id).sort();
    expect(ids).toEqual(["rt_priv", "rt_pub"]);
  });

  it("AC4: an invited member sees the workspace; public runtime usable, private blocked", async () => {
    const store = seedDeployment();
    store.registerRuntime({ id: "rt_pub", name: "Public", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "public" });
    store.registerRuntime({ id: "rt_priv", name: "Private", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "private" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const owner = await login(store, { externalId: OWNER_OPEN_ID, email: "hehuajie@feishu.local", name: "贺华杰" });
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });

    // Before invite: B is a non-member and sees nothing.
    expect((await (await app.request("/api/workspaces", bearer(b.token))).json())).toEqual([]);

    // Owner invites B by email.
    const invite = await app.request("/api/workspaces/local/members", {
      method: "POST",
      headers: jsonAuth(owner.token),
      body: JSON.stringify({ email: "b@corp.com", role: "member" }),
    });
    expect(invite.status).toBe(201);
    const invitation = await invite.json();

    // B accepts the invitation as themselves.
    const accept = await app.request(`/api/invitations/${invitation.id}/accept`, { method: "POST", ...bearer(b.token) });
    expect(accept.status).toBe(200);

    // B now sees the workspace.
    const ws = await app.request("/api/workspaces", bearer(b.token));
    expect((await ws.json()).map((w: { id: string }) => w.id)).toContain("local");
    expect(store.getUserRoleInWorkspace(b.userId, "local")).toBe("member");

    // B can use the public runtime.
    const usePublic = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ runtimeId: "rt_pub", workspaceId: "local", provider: "codex" }),
    });
    expect([200, 201]).toContain(usePublic.status);

    // B is blocked from the private runtime.
    const usePrivate = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ runtimeId: "rt_priv", workspaceId: "local", provider: "codex" }),
    });
    expect(usePrivate.status).toBe(403);
    expect((await usePrivate.json()).error).toContain("private");
  });

  it("FR4: a new user creates a workspace, becomes its owner, and can open it with their login token", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const b = await login(store, { externalId: "ou_b", email: "b@feishu.local", name: "B" });

    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ name: "B Team" }),
    });
    expect(created.status).toBe(201);
    const workspace = await created.json();

    // The creator — not the legacy "local" owner — owns the new workspace.
    expect(store.getUserRoleInWorkspace(b.userId, workspace.id)).toBe("owner");
    expect(store.getUserRoleInWorkspace("local", workspace.id)).toBeNull();

    // The workspace shows up in their list and opens with the login token
    // (which was minted under the "local" workspace before this one existed).
    const list = await app.request("/api/workspaces", bearer(b.token));
    expect((await list.json()).map((w: { id: string }) => w.id)).toEqual([workspace.id]);
    expect((await app.request(`/api/workspaces/${workspace.id}`, bearer(b.token))).status).toBe(200);

    // Membership stays the authority: the legacy local workspace is still hidden.
    expect((await app.request("/api/workspaces/local", bearer(b.token))).status).toBe(404);
  });

  it("add computer: a new user mints a real setup token for their own workspace", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const b = await login(store, { externalId: "ou_b", email: "b@feishu.local", name: "B" });
    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ name: "B Team" }),
    });
    const workspace = await created.json();

    // Mimic the dashboard dialog exactly: no workspace in the body, the current
    // workspace only present as the X-Workspace-Slug header.
    const minted = await app.request("/api/tokens", {
      method: "POST",
      headers: { ...jsonAuth(b.token), "X-Workspace-Slug": workspace.slug },
      body: JSON.stringify({ name: "Remi daemon 2026-07-06", expires_in_days: 365 }),
    });
    expect(minted.status).toBe(201);
    const token = await minted.json();
    expect(token.token).toStartWith("mul_");
    // Bound to the requester and their workspace — never a user-less admin token,
    // even if the body tries to spoof another identity.
    expect(token.userId).toBe(b.userId);
    expect(token.workspaceId).toBe(workspace.id);
    const spoofed = await app.request("/api/tokens", {
      method: "POST",
      headers: { ...jsonAuth(b.token), "X-Workspace-Slug": workspace.slug },
      body: JSON.stringify({ name: "spoof", userId: "local" }),
    });
    expect((await spoofed.json()).userId).toBe(b.userId);

    // Without any workspace context the default is still the local workspace,
    // which stays members-only.
    const noContext = await app.request("/api/tokens", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ name: "no context" }),
    });
    expect(noContext.status).toBe(404);
  });

  it("AC6: email-code login is disabled by default and enabled by flag; Feishu SSO stays reachable", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const disabled = await app.request("/auth/send-code", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "anyone@example.com" }),
    });
    expect(disabled.status).toBe(403);

    // The Feishu SSO url endpoint stays public (reachable without auth); it is
    // just unconfigured in tests, so it answers 503 rather than 401/403.
    const larkUrl = await app.request("/auth/lark/url?redirect_uri=https%3A%2F%2Fx");
    expect(larkUrl.status).toBe(503);

    process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN = "1";
    const enabled = await app.request("/auth/send-code", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "anyone@example.com" }),
    });
    expect(enabled.status).toBe(200);
  });

  it("FR8: a daemon token owns the runtimes it registers, and re-registration never hijacks the owner", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    // A daemon token minted for a specific user (as `remi setup` would).
    const daemonToken = await store.createAccessToken({
      workspaceId: "local",
      userId: "usr_setup_user",
      daemonId: "daemon-1",
      name: "Daemon 1",
      type: "daemon",
    });

    const first = await app.request("/api/daemon/register", {
      method: "POST",
      headers: jsonAuth(daemonToken.token),
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-1", runtimes: [{ type: "codex", version: "1.0.0" }] }),
    });
    expect(first.status).toBe(200);
    const runtimeId = (await first.json()).runtimes[0].id;
    expect(store.getRuntime(runtimeId)?.ownerId).toBe("usr_setup_user");

    // A different daemon token (owned by someone else) re-registers the same
    // runtime; ownership must not change.
    const otherDaemon = await store.createAccessToken({
      workspaceId: "local", userId: "usr_other", daemonId: "daemon-1", name: "Daemon other", type: "daemon",
    });
    const second = await app.request("/api/daemon/register", {
      method: "POST",
      headers: jsonAuth(otherDaemon.token),
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-1", runtimes: [{ type: "codex", version: "1.0.1" }] }),
    });
    expect(second.status).toBe(200);
    expect(store.getRuntime(runtimeId)?.ownerId).toBe("usr_setup_user");
  });
});

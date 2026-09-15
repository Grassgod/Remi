import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(() => {
  mock.restore();
  resetMultiremiTestEnv();
});

const root = "/api/cloud-runtime/nodes";

async function sessionHeaders(store: MultiremiStore, userId: string) {
  const created = await store.createAccessToken({
    workspaceId: "local",
    userId,
    name: `Session for ${userId}`,
    type: "pat",
    purpose: "session",
  });
  return { Authorization: `Bearer ${created.token}`, "Content-Type": "application/json" };
}

async function postNode(app: ReturnType<typeof createMultiremiApp>, headers: HeadersInit, body: Record<string, unknown>) {
  const response = await app.request(root, { method: "POST", headers, body: JSON.stringify(body) });
  expect(response.status).toBe(201);
  return await response.json() as { id: string; ownerId: string; owner_id: string; status: string };
}

describe("MUL-290 independent adversarial QA", () => {
  it.each(["personal", "cli", "session"])("keeps a demoted authenticated local user scoped when using a %s PAT", async (purpose) => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const replacementOwner = store.getOrCreateUser({ name: "Replacement owner", email: `replacement-${purpose}@example.test` });
    store.createWorkspaceMember({ workspaceId: "local", userId: replacementOwner.id, name: replacementOwner.name, role: "owner" });
    store.updateWorkspaceMember("mem_local_local", { role: "member" });
    const foreignOwner = store.getOrCreateUser({ name: "Foreign owner", email: `foreign-${purpose}@example.test` });
    store.createWorkspaceMember({ workspaceId: "local", userId: foreignOwner.id, name: foreignOwner.name, role: "member" });
    const app = createMultiremiApp({ store, authToken: "qa-master" });
    const localSession = await sessionHeaders(store, "local");
    const foreignSession = await sessionHeaders(store, foreignOwner.id);
    const foreignNode = await postNode(app, foreignSession, { instance_type: "qa.foreign" });

    // POST /api/tokens normalizes session to personal. Use the actual session
    // credential minted by sessionHeaders so this case exercises that purpose.
    const minted = purpose === "session" ? null : await app.request("/api/tokens", {
      method: "POST",
      headers: localSession,
      body: JSON.stringify({ name: `QA ${purpose}`, purpose, workspaceId: "local" }),
    });
    const mintedBody = minted ? await minted.json() as { token: string } : null;
    const patHeaders = mintedBody
      ? { Authorization: `Bearer ${mintedBody.token}`, "Content-Type": "application/json" }
      : localSession;
    const verified = await store.verifyAccessToken(patHeaders.Authorization.slice("Bearer ".length));
    expect({ userId: verified?.userId, purpose: verified?.purpose, workspaceId: verified?.workspaceId })
      .toEqual({ userId: "local", purpose, workspaceId: "local" });
    const listed = await app.request(root, { headers: patHeaders });
    const listedBody = await listed.json() as Array<{ id: string }>;
    const before = store.getCloudRuntimeNode(foreignNode.id);
    const deleteNode = spyOn(store, "deleteCloudRuntimeNode");
    const setStatus = spyOn(store, "setCloudRuntimeNodeStatus");
    const execNode = spyOn(store, "execCloudRuntimeNode");
    const changed = await app.request(`${root}/status`, {
      method: "POST",
      headers: patHeaders,
      body: JSON.stringify({ node_id: foreignNode.id, status: "maintenance" }),
    });
    const stored = store.getCloudRuntimeNode(foreignNode.id);

    console.log(
      `QA_LOCAL_PAT purpose=${purpose} mint=${minted?.status ?? "session-fixture"} list=${listed.status}`
      + ` listed_foreign=${listedBody.some((node) => node.id === foreignNode.id)}`
      + ` status=${changed.status} stored_status=${stored?.status}`,
    );

    if (minted) expect(minted.status).toBe(201);
    expect(listed.status).toBe(200);
    expect(listedBody).toEqual([]);
    expect(changed.status).toBe(404);
    expect(stored).toMatchObject(foreignNode);
    expect(stored).toEqual(before);
    expect(await changed.json()).toEqual({ error: "cloud runtime node not found" });

    for (const [method, path] of [
      ["DELETE", ""],
      ["POST", "/start"],
      ["POST", "/stop"],
      ["POST", "/reboot"],
      ["POST", "/exec"],
    ]) {
      const denied = await app.request(`${root}${path}`, {
        method,
        headers: patHeaders,
        body: JSON.stringify({ id: foreignNode.id, command: "echo forbidden" }),
      });
      expect(denied.status, `${purpose} ${method} ${path}`).toBe(404);
      expect(await denied.json()).toEqual({ error: "cloud runtime node not found" });
      expect(store.getCloudRuntimeNode(foreignNode.id)).toEqual(before);
    }
    expect(deleteNode).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(execNode).not.toHaveBeenCalled();
  });

  it("normalizes a logged-in member's requested session purpose to personal when minting a PAT", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const replacementOwner = store.getOrCreateUser({ name: "Replacement owner", email: "session-mint-owner@example.test" });
    store.createWorkspaceMember({ workspaceId: "local", userId: replacementOwner.id, name: replacementOwner.name, role: "owner" });
    store.updateWorkspaceMember("mem_local_local", { role: "member" });
    expect(store.getWorkspaceMember("mem_local_local")?.role).toBe("member");
    const app = createMultiremiApp({ store, authToken: "qa-master" });
    const headers = await sessionHeaders(store, "local");
    const minted = await app.request("/api/tokens", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Requested session PAT", purpose: "session", workspaceId: "local" }),
    });
    expect(minted.status).toBe(201);
    const mintedBody = await minted.json() as { token: string };
    const verified = await store.verifyAccessToken(mintedBody.token);
    expect({ userId: verified?.userId, purpose: verified?.purpose, workspaceId: verified?.workspaceId })
      .toEqual({ userId: "local", purpose: "personal", workspaceId: "local" });
  });

  it("keeps a legacy workspace PAT with omitted userId administrative while local is the deployment owner", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    expect(store.getWorkspaceMember("mem_local_local")?.role).toBe("owner");
    const foreignOwner = store.getOrCreateUser({ name: "Foreign owner", email: "legacy-pat-foreign@example.test" });
    store.createWorkspaceMember({ workspaceId: "local", userId: foreignOwner.id, name: foreignOwner.name, role: "member" });
    const app = createMultiremiApp({ store, authToken: "qa-master" });
    const foreignSession = await sessionHeaders(store, foreignOwner.id);
    const foreignNode = await postNode(app, foreignSession, { instance_type: "qa.legacy-pat-foreign" });
    // Legacy callers omit userId; persistence and request auth resolve it to
    // local, whose explicit deployment-owner role grants administrative access.
    const legacy = await store.createAccessToken({ name: "Legacy ownerless PAT", type: "pat", workspaceId: "local" });
    const verified = await store.verifyAccessToken(legacy.token);
    expect({ userId: verified?.userId, purpose: verified?.purpose, workspaceId: verified?.workspaceId })
      .toEqual({ userId: "local", purpose: "personal", workspaceId: "local" });
    const headers = { Authorization: `Bearer ${legacy.token}`, "Content-Type": "application/json" };
    const listed = await app.request(root, { headers });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([foreignNode]);

    for (const [action, status] of [
      ["start", "running"],
      ["stop", "stopped"],
      ["reboot", "running"],
      ["status", "maintenance"],
    ]) {
      const changed = await app.request(`${root}/${action}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ node_id: foreignNode.id, status }),
      });
      expect(changed.status, action).toBe(200);
      expect(store.getCloudRuntimeNode(foreignNode.id)?.status, action).toBe(status);
    }
    const executed = await app.request(`${root}/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ nodeId: foreignNode.id, command: "echo allowed" }),
    });
    expect(executed.status).toBe(200);
    expect(await executed.json()).toMatchObject({
      node: { id: foreignNode.id, status: "maintenance" },
      exit_code: 0,
      stdout: `local cloud runtime node ${foreignNode.id}: echo allowed`,
    });
    const deleted = await app.request(root, { method: "DELETE", headers, body: JSON.stringify({ id: foreignNode.id }) });
    expect(deleted.status).toBe(204);
    expect(store.getCloudRuntimeNode(foreignNode.id)).toBeNull();
    console.log("QA_LEGACY_PAT stored_user_id=local deployment_role=owner list=200 managed_foreign=true");
  });

  it("keeps owner filtering ahead of malformed pagination and ignores forged ownership fields", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const alice = store.getOrCreateUser({ name: "Alice", email: "qa-alice@example.test" });
    const bob = store.getOrCreateUser({ name: "Bob", email: "qa-bob@example.test" });
    store.createWorkspaceMember({ workspaceId: "local", userId: alice.id, name: alice.name, role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: bob.id, name: bob.name, role: "member" });
    const app = createMultiremiApp({ store, authToken: "qa-master" });
    const aliceHeaders = await sessionHeaders(store, alice.id);
    const bobHeaders = await sessionHeaders(store, bob.id);
    const forged = await postNode(app, aliceHeaders, {
      instance_type: "qa.owner-spoof",
      ownerId: bob.id,
      owner_id: bob.id,
      metadata: { ownerId: bob.id, owner_id: bob.id },
    });
    await postNode(app, aliceHeaders, { instance_type: "qa.alice-second" });
    await postNode(app, bobHeaders, { instance_type: "qa.bob" });

    expect(forged.ownerId).toBe(alice.id);
    expect(forged.owner_id).toBe(alice.id);
    expect(store.getCloudRuntimeNode(forged.id)?.ownerId).toBe(alice.id);

    const queries = [
      "",
      "?limit=-1&offset=-1",
      "?limit=999999999999&offset=0",
      "?limit=NaN&offset=NaN",
      "?limit=1e309&offset=0",
      "?limit=0x10&offset=0",
      "?limit=1.9&offset=0",
      "?limit=1%20OR%201%3D1&offset=0%20OR%201%3D1",
      "?limit=100&offset=999999999999",
    ];
    for (const query of queries) {
      const response = await app.request(`${root}${query}`, { headers: aliceHeaders });
      expect(response.status, query).toBe(200);
      const nodes = await response.json() as Array<{ ownerId: string }>;
      expect(nodes.every((node) => node.ownerId === alice.id), query).toBe(true);
    }
    console.log(`QA_INPUTS variants=${queries.length} forged_owner_ignored=true cross_owner_rows=0`);
  });

  it("uses explicit local-workspace user links for administrator detection", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const owner = store.getOrCreateUser({ name: "Node owner", email: "qa-node-owner@example.test" });
    const caller = store.getOrCreateUser({ name: "Caller", email: "qa-caller@example.test" });
    const unrelated = store.getOrCreateUser({ name: "Unrelated", email: "qa-unrelated@example.test" });
    store.createWorkspaceMember({ workspaceId: "local", userId: owner.id, name: owner.name, role: "member" });
    store.createWorkspace({ name: "Caller-owned remote", slug: "qa-caller-remote" }, caller.id);
    store.createWorkspaceMember({ id: caller.id, workspaceId: "local", userId: unrelated.id, name: unrelated.name, role: "owner" });
    const app = createMultiremiApp({ store, authToken: "qa-master" });
    const ownerHeaders = await sessionHeaders(store, owner.id);
    const callerHeaders = await sessionHeaders(store, caller.id);
    const node = await postNode(app, ownerHeaders, { instance_type: "qa.identity" });

    const deniedList = await app.request(root, { headers: callerHeaders });
    const deniedAction = await app.request(`${root}/start`, {
      method: "POST",
      headers: callerHeaders,
      body: JSON.stringify({ nodeId: node.id }),
    });
    expect(deniedList.status).toBe(200);
    expect(await deniedList.json()).toEqual([]);
    expect(deniedAction.status).toBe(404);
    expect(store.getCloudRuntimeNode(node.id)).toMatchObject(node);

    store.createWorkspaceMember({ workspaceId: "local", userId: caller.id, name: caller.name, role: "admin" });
    const allowedList = await app.request(root, { headers: callerHeaders });
    const allowedAction = await app.request(`${root}/start`, {
      method: "POST",
      headers: callerHeaders,
      body: JSON.stringify({ nodeId: node.id }),
    });
    expect(allowedList.status).toBe(200);
    expect((await allowedList.json() as Array<{ id: string }>).some((item) => item.id === node.id)).toBe(true);
    expect(allowedAction.status).toBe(200);
    expect(store.getCloudRuntimeNode(node.id)?.status).toBe("running");
    console.log("QA_MEMBER_LINK forged_member_id_denied=true explicit_admin_user_link_allowed=true");
  });
});

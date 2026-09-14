import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiCloudRuntimeNode } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

afterEach(() => {
  mock.restore();
  resetMultiremiTestEnv();
});

const root = "/api/cloud-runtime/nodes";
const masterToken = "cloud-runtime-test-master";
const operations = [
  { method: "DELETE", path: "", name: "delete" },
  { method: "POST", path: "/start", name: "start" },
  { method: "POST", path: "/stop", name: "stop" },
  { method: "POST", path: "/reboot", name: "reboot" },
  { method: "POST", path: "/status", name: "status" },
  { method: "POST", path: "/exec", name: "exec" },
] as const;

async function callerHeaders(store: MultiremiStore, userId: string, credential: "pat" | "jwt") {
  const token = credential === "jwt"
    ? signTestJwt({ sub: userId, exp: Math.floor(Date.now() / 1000) + 60 })
    : (await store.createAccessToken({
      name: "Cloud runtime session",
      type: "pat",
      purpose: "session",
      workspaceId: "local",
      userId,
    })).token;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function createFixture(credential: "pat" | "jwt" = "pat") {
  const store = createStore();
  store.ensureLocalWorkspace();
  const owner = store.getOrCreateUser({ name: "Node owner", email: "node-owner@example.test" });
  const other = store.getOrCreateUser({ name: "Other user", email: "other-user@example.test" });
  store.createWorkspaceMember({ workspaceId: "local", userId: owner.id, name: owner.name, role: "member" });
  store.createWorkspace({ name: "Other workspace", slug: "other-workspace" }, other.id);
  const app = createMultiremiApp({ store, authToken: masterToken });
  return {
    store,
    app,
    owner,
    other,
    ownerHeaders: await callerHeaders(store, owner.id, credential),
    otherHeaders: await callerHeaders(store, other.id, credential),
  };
}

async function createNode(app: ReturnType<typeof createMultiremiApp>, headers: HeadersInit): Promise<MultiremiCloudRuntimeNode> {
  const response = await app.request(root, {
    method: "POST",
    headers,
    body: JSON.stringify({ instance_type: "g5.xlarge", name: "Owned node", ownerId: "forged-owner", owner_id: "forged-owner" }),
  });
  expect(response.status).toBe(201);
  return await response.json();
}

async function expectNodeManagement(
  app: ReturnType<typeof createMultiremiApp>,
  store: MultiremiStore,
  headers: HeadersInit,
  node: MultiremiCloudRuntimeNode,
) {
  for (const [action, status, idKey] of [
    ["start", "running", "id"],
    ["stop", "stopped", "node_id"],
    ["reboot", "running", "nodeId"],
    ["status", "maintenance", "id"],
  ] as const) {
    const response = await app.request(`${root}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ [idKey]: node.id, status }),
    });
    expect(response.status, action).toBe(200);
    expect(await response.json()).toMatchObject({ id: node.id, owner_id: node.ownerId, status });
    expect(store.getCloudRuntimeNode(node.id)?.status, action).toBe(status);
  }
  const executed = await app.request(`${root}/exec`, {
    method: "POST",
    headers,
    body: JSON.stringify({ node_id: node.id, cmd: "echo allowed" }),
  });
  expect(executed.status).toBe(200);
  expect(await executed.json()).toMatchObject({
    node: { id: node.id, status: "maintenance" },
    exit_code: 0,
    stdout: `local cloud runtime node ${node.id}: echo allowed`,
    stderr: "",
  });
  const deleted = await app.request(root, { method: "DELETE", headers, body: JSON.stringify({ nodeId: node.id }) });
  expect(deleted.status).toBe(204);
  expect(store.getCloudRuntimeNode(node.id)).toBeNull();
}

for (const credential of ["pat", "jwt"] as const) {
  describe(`cloud runtime node authorization (${credential})`, () => {
    it("persists the real creator and filters each user's list before pagination", async () => {
      const { store, app, owner, other, ownerHeaders, otherHeaders } = await createFixture(credential);
      const ownedNode = await createNode(app, ownerHeaders);
      const otherNode = await createNode(app, otherHeaders);
      store.createCloudRuntimeNode({ instance_type: "legacy" });
      expect(ownedNode).toMatchObject({ ownerId: owner.id, owner_id: owner.id });
      expect(otherNode).toMatchObject({ ownerId: other.id, owner_id: other.id });
      expect(db!.query("SELECT owner_id FROM multiremi_cloud_runtime_nodes WHERE id = ?").get(ownedNode.id))
        .toEqual({ owner_id: owner.id });
      expect(owner.id).not.toBe("local");
      const ownedList = await app.request(`${root}?limit=1&offset=0`, { headers: ownerHeaders });
      expect(ownedList.status).toBe(200);
      expect(await ownedList.json()).toEqual([ownedNode]);
      const otherList = await app.request(root, { headers: otherHeaders });
      expect(otherList.status).toBe(200);
      expect(await otherList.json()).toEqual([otherNode]);
      const nextPage = await app.request(`${root}?limit=1&offset=1`, { headers: ownerHeaders });
      expect(nextPage.status).toBe(200);
      expect(await nextPage.json()).toEqual([]);
    });

    for (const operation of operations) {
      it(`denies cross-owner ${operation.name} without deleting, changing or executing the node`, async () => {
        const { store, app, ownerHeaders, otherHeaders } = await createFixture(credential);
        const node = await createNode(app, ownerHeaders);
        const deleteNode = spyOn(store, "deleteCloudRuntimeNode");
        const setStatus = spyOn(store, "setCloudRuntimeNodeStatus");
        const execNode = spyOn(store, "execCloudRuntimeNode");
        for (const idKey of ["id", "node_id", "nodeId"]) {
          for (const nodeId of [node.id, "crn_missing", ""]) {
            const response = await app.request(`${root}${operation.path}`, {
              method: operation.method,
              headers: otherHeaders,
              body: JSON.stringify({ [idKey]: nodeId, status: "maintenance", command: "echo forbidden" }),
            });
            expect(response.status, `${operation.name} ${idKey} ${nodeId}`).toBe(404);
            expect(await response.json()).toEqual({ error: "cloud runtime node not found" });
            expect(store.getCloudRuntimeNode(node.id)).toEqual(node);
          }
        }
        expect(deleteNode).not.toHaveBeenCalled();
        expect(setStatus).not.toHaveBeenCalled();
        expect(execNode).not.toHaveBeenCalled();
      });
    }

    it("allows an ordinary owner to manage their own node", async () => {
      const { store, app, ownerHeaders } = await createFixture(credential);
      const node = await createNode(app, ownerHeaders);
      await expectNodeManagement(app, store, ownerHeaders, node);
    });

    for (const role of ["owner", "admin"]) {
      it(`allows a local workspace ${role} to list and manage another user's node`, async () => {
        const { store, app, ownerHeaders, otherHeaders, other } = await createFixture(credential);
        store.createWorkspaceMember({ workspaceId: "local", userId: other.id, name: other.name, role });
        const node = await createNode(app, ownerHeaders);
        const legacy = store.createCloudRuntimeNode({ instance_type: "legacy" });
        const listed = await app.request(root, { headers: otherHeaders });
        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual(expect.arrayContaining([node, legacy]));
        const adminNode = await createNode(app, otherHeaders);
        expect(adminNode.owner_id).toBe(other.id);
        await expectNodeManagement(app, store, otherHeaders, node);
      });
    }

    it("does not treat a migrated local user's login as master mode after demotion", async () => {
      const { store, app, other, ownerHeaders } = await createFixture(credential);
      store.createWorkspaceMember({ workspaceId: "local", userId: other.id, name: other.name, role: "owner" });
      store.updateWorkspaceMember("mem_local_local", { role: "member" });
      const headers = await callerHeaders(store, "local", credential);
      const node = await createNode(app, ownerHeaders);
      const listed = await app.request(root, { headers });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual([]);
      for (const operation of operations) {
        const denied = await app.request(`${root}${operation.path}`, {
          method: operation.method,
          headers,
          body: JSON.stringify({ id: node.id, status: "maintenance", command: "echo forbidden" }),
        });
        expect(denied.status, operation.name).toBe(404);
        expect(await denied.json()).toEqual({ error: "cloud runtime node not found" });
        expect(store.getCloudRuntimeNode(node.id)).toEqual(node);
      }
    });
  });
}

describe("cloud runtime administrative compatibility", () => {
  for (const mode of ["master", "open", "synthetic local PAT"]) {
    it(`preserves full access in ${mode} mode`, async () => {
      const fixture = await createFixture();
      const { store, ownerHeaders, other } = fixture;
      store.createWorkspaceMember({ workspaceId: "local", userId: other.id, name: other.name, role: "owner" });
      store.updateWorkspaceMember("mem_local_local", { role: "member" });
      const node = await createNode(fixture.app, ownerHeaders);
      const app = mode === "open" ? createMultiremiApp({ store, authToken: "" }) : fixture.app;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (mode === "master") headers.Authorization = `Bearer ${masterToken}`;
      if (mode === "synthetic local PAT") {
        const token = await store.createAccessToken({ name: "Legacy ownerless PAT", type: "pat", workspaceId: "local" });
        headers.Authorization = `Bearer ${token.token}`;
      }
      const listed = await app.request(root, { headers });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual([node]);
      const created = await createNode(app, headers);
      expect(created).toMatchObject({ ownerId: "local", owner_id: "local" });
      await expectNodeManagement(app, store, headers, node);
      for (const operation of operations) {
        const missing = await app.request(`${root}${operation.path}`, {
          method: operation.method,
          headers,
          body: JSON.stringify({ id: "crn_missing", status: "maintenance", command: "echo missing" }),
        });
        expect(missing.status, operation.name).toBe(404);
        expect(await missing.json()).toEqual({ error: "cloud runtime node not found" });
      }
    });
  }
});

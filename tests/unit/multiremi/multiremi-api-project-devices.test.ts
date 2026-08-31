import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const JSON_HEADERS = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };

describe("Multiremi API — project device routing", () => {
  it("creates, lists, and removes project device bindings with live device metadata", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Independent project" });
    store.registerRuntime({
      id: "rt_personal_codex",
      name: "codex",
      provider: "codex",
      daemonId: "personal-device",
      deviceInfo: "Personal Mac · darwin",
      status: "online",
    });
    store.registerRuntime({
      id: "rt_personal_claude",
      name: "claude",
      provider: "claude",
      daemonId: "personal-device",
      deviceInfo: "Personal Mac · darwin",
      status: "online",
    });
    store.updateDaemonDisplayName("local", "personal-device", "Personal Mac", "local");
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const created = await app.request(`/api/projects/${project.id}/devices`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ daemon_id: "personal-device" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      device: {
        project_id: project.id,
        daemon_id: "personal-device",
        display_name: "Personal Mac",
        online: true,
        providers: ["claude", "codex"],
      },
      warning: null,
    });

    const listed = await app.request(`/api/projects/${project.id}/devices`, { headers: JSON_HEADERS });
    expect(await listed.json()).toMatchObject({ total: 1, warning: null });
    expect((await (await app.request(`/api/multiremi/projects/${project.id}/devices`, { headers: JSON_HEADERS })).json()).devices[0])
      .toMatchObject({ daemonId: "personal-device", online: true });

    expect((await app.request(`/api/projects/${project.id}/devices`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ daemon_id: "personal-device" }),
    })).status).toBe(409);

    expect((await app.request(`/api/projects/${project.id}/devices/personal-device`, {
      method: "DELETE",
      headers: JSON_HEADERS,
    })).status).toBe(204);
    expect((await (await app.request(`/api/projects/${project.id}/devices`, { headers: JSON_HEADERS })).json()).devices).toEqual([]);
  });

  it("allows an offline device binding and returns a warning", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Laptop project" });
    store.registerRuntime({
      id: "rt_offline_laptop",
      name: "codex",
      provider: "codex",
      daemonId: "offline-laptop",
      status: "offline",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request(`/api/projects/${project.id}/devices`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ daemon_id: "offline-laptop" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      device: { daemon_id: "offline-laptop", online: false },
      warning: expect.stringContaining("offline"),
    });
  });

  it("atomically replaces the full device set and preserves it on validation failure", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Atomic routing" });
    for (const daemonId of ["device-a", "device-b"]) {
      store.registerRuntime({
        id: `rt_${daemonId}`,
        name: daemonId,
        provider: "codex",
        daemonId,
      });
    }
    store.createProjectDevice(project.id, { daemonId: "device-a" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const replaced = await app.request(`/api/projects/${project.id}/devices`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ daemon_ids: ["device-b"] }),
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({
      devices: [{ daemon_id: "device-b" }],
      total: 1,
    });

    const rejected = await app.request(`/api/projects/${project.id}/devices`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ daemon_ids: ["device-a", "missing-device"] }),
    });
    expect(rejected.status).toBe(404);
    expect(store.listProjectDevices(project.id).map((device) => device.daemonId)).toEqual(["device-b"]);

    const cleared = await app.request(`/api/multiremi/projects/${project.id}/devices`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ daemonIds: [] }),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ devices: [], total: 0, warning: null });
  });

  it("canonicalizes project routing and dedicated profile during legacy daemon registration", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const legacy = await app.request("/api/daemon/register", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "legacy-personal",
        device_name: "Legacy default",
        runtimes: [{ type: "codex", version: "1.0.0" }],
      }),
    });
    expect(legacy.status).toBe(200);
    const legacyRuntimeId = (await legacy.json()).runtimes[0].id as string;
    const project = store.createProject({ title: "Personal project" });
    store.createProjectDevice(project.id, { daemonId: "legacy-personal" });
    store.updateDaemonDisplayName("local", "legacy-personal", "My Personal Mac", "local");
    store.updateDaemonDedicated("local", "legacy-personal", true, "local");

    const migrated = await app.request("/api/daemon/register", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "canonical-personal",
        device_name: "New default",
        legacy_daemon_ids: ["legacy-personal"],
        runtimes: [{ type: "codex", version: "1.1.0" }],
      }),
    });
    expect(migrated.status).toBe(200);
    const canonicalRuntimeId = (await migrated.json()).runtimes[0].id as string;
    expect(store.getRuntime(legacyRuntimeId)).toBeNull();
    expect(store.listProjectDevices(project.id).map((device) => device.daemonId)).toEqual(["canonical-personal"]);
    expect(store.getDaemonProfile("local", "legacy-personal")).toBeNull();
    expect(store.getDaemonProfile("local", "canonical-personal")).toMatchObject({
      displayName: "My Personal Mac",
      displayNameCustomized: true,
      dedicated: true,
    });

    const agent = store.createAgent({ name: "Migrated routing", provider: "codex" });
    const issue = store.createIssue({ title: "Bound work", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "run" });
    expect(store.claimTask(canonicalRuntimeId)?.id).toBe(task.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "done" });

    const ordinary = store.createProject({ title: "Ordinary" });
    const ordinaryIssue = store.createIssue({ title: "Ordinary work", projectId: ordinary.id });
    store.createTask({ agentId: agent.id, issueId: ordinaryIssue.id, prompt: "reject" });
    expect(store.claimTask(canonicalRuntimeId)).toBeNull();
  });

  it("reads and updates dedicated device routing without requiring an existing profile", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Device-owned project" });
    store.registerRuntime({
      id: "rt_dedicated_api",
      name: "codex",
      provider: "codex",
      daemonId: "dedicated-device",
    });
    store.createProjectDevice(project.id, { daemonId: "dedicated-device" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const initial = await app.request("/api/daemons/dedicated-device?workspace_id=local", { headers: JSON_HEADERS });
    expect(await initial.json()).toMatchObject({
      daemon_id: "dedicated-device",
      dedicated: false,
      projects: [{ id: project.id, title: "Device-owned project" }],
    });

    const updated = await app.request("/api/daemons/dedicated-device?workspace_id=local", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ dedicated: true }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ dedicated: true });
    expect(store.getDaemonProfile("local", "dedicated-device")?.dedicated).toBe(true);

    const invalid = await app.request("/api/daemons/dedicated-device?workspace_id=local", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ dedicated: "yes" }),
    });
    expect(invalid.status).toBe(400);
  });
});

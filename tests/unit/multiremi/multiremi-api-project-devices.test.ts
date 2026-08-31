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

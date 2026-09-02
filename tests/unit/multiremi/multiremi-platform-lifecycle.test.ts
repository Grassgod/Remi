import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { PlatformOperationConflictError } from "@multiremi/store/repos/platform-operations-repo.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(() => {
  setSystemTime();
  resetMultiremiTestEnv();
});

describe("platform lifecycle", () => {
  it("serializes operations and resumes a claimed operation", () => {
    const store = createLocalStore();
    const created = store.createPlatformOperation({ kind: "restart" }, "local");
    expect(created.status).toBe("queued");
    expect(() => store.createPlatformOperation({ kind: "check_updates" }, "local"))
      .toThrow(PlatformOperationConflictError);

    expect(store.claimPlatformOperation()?.status).toBe("preparing");
    expect(store.claimPlatformOperation()?.id).toBe(created.id);
    const completed = store.reportPlatformOperation(created.id, {
      status: "succeeded",
      progress: { message: "done" },
    });
    expect(completed?.finishedAt).not.toBeNull();
    expect(store.getActivePlatformOperation()).toBeNull();
    expect(store.createPlatformOperation({ kind: "check_updates" }, "local").kind).toBe("check_updates");
  });

  it("separates administrator and updater credentials", async () => {
    const store = createLocalStore();
    const app = createMultiremiApp({
      store,
      authToken: "master-secret",
      platformUpdaterToken: "updater-secret",
    });
    const adminHeaders = { Authorization: "Bearer master-secret", "Content-Type": "application/json" };

    const status = await app.request("/api/multiremi/platform/status", { headers: adminHeaders });
    expect(status.status).toBe(200);
    expect((await status.json()).canManage).toBe(true);

    const created = await app.request("/api/multiremi/platform/operations", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ kind: "restart" }),
    });
    expect(created.status).toBe(202);

    const missingUpdaterSecret = await app.request("/api/platform-updater/operations/claim", {
      method: "POST",
      headers: adminHeaders,
      body: "{}",
    });
    expect(missingUpdaterSecret.status).toBe(401);

    const updaterHeaders = { ...adminHeaders, "X-Multiremi-Updater-Token": "updater-secret" };
    const claimed = await app.request("/api/platform-updater/operations/claim", {
      method: "POST",
      headers: updaterHeaders,
      body: "{}",
    });
    expect(claimed.status).toBe(200);
    expect((await claimed.json()).operation.status).toBe("preparing");
  });

  it("runs an automatic update only when the configured daily window is due", async () => {
    setSystemTime(new Date("2026-08-27T20:00:00.000Z"));
    const store = createLocalStore();
    const settings = store.setPlatformAutoUpdateSettings({
      enabled: true,
      time: "05:00",
      timezone: "Asia/Shanghai",
    });
    expect(settings.autoUpdateNextCheckAt).toBe("2026-08-27T21:00:00.000Z");

    const app = createMultiremiApp({ store, platformUpdaterToken: "updater-secret" });
    const heartbeat = () => app.request("/api/platform-updater/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Multiremi-Updater-Token": "updater-secret" },
      body: JSON.stringify({
        driver: "docker_compose",
        currentRelease: release("0.2.42"),
        latestRelease: release("0.2.43"),
      }),
    });

    expect((await heartbeat()).status).toBe(200);
    expect(store.getActivePlatformOperation()).toBeNull();

    setSystemTime(new Date("2026-08-27T21:00:00.000Z"));
    expect((await heartbeat()).status).toBe(200);
    expect(store.getActivePlatformOperation()?.targetVersion).toBe("0.2.43");
    expect(store.getPlatformState()).toMatchObject({
      autoUpdateLastCheckedAt: "2026-08-27T21:00:00.000Z",
      autoUpdateLastResult: "update_queued",
      autoUpdateNextCheckAt: "2026-08-28T21:00:00.000Z",
    });

    expect((await heartbeat()).status).toBe(200);
    expect(store.listPlatformOperations(20)).toHaveLength(1);
  });

  it("does not retry the same failed automatic update in the next due decision", async () => {
    setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    const store = createLocalStore();
    store.setPlatformAutoUpdateSettings({ enabled: true, time: "01:00", timezone: "UTC" });
    const failed = store.createPlatformOperation({
      kind: "update",
      targetVersion: "0.2.43",
      targetRef: "https://github.com/example/remi/releases/download/v0.2.43/platform-release.json",
    }, "system:auto-update");
    store.reportPlatformOperation(failed.id, { status: "failed", error: "health check failed" });

    setSystemTime(new Date("2026-08-27T01:00:00.000Z"));
    const app = createMultiremiApp({ store, platformUpdaterToken: "updater-secret" });
    const heartbeat = await app.request("/api/platform-updater/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Multiremi-Updater-Token": "updater-secret" },
      body: JSON.stringify({
        driver: "docker_compose",
        currentRelease: release("0.2.42"),
        latestRelease: release("0.2.43"),
      }),
    });

    expect(heartbeat.status).toBe(200);
    expect(store.getActivePlatformOperation()).toBeNull();
    expect(store.listPlatformOperations(20)).toHaveLength(1);
    expect(store.getPlatformState().autoUpdateLastResult).toBe("blocked");
  });

  it("queues one CLI update per eligible daemon after the platform release is live", async () => {
    const store = createLocalStore();
    for (const [id, provider] of [["rt_old_claude", "claude"], ["rt_old_codex", "codex"]] as const) {
      store.registerRuntime({
        id,
        name: id,
        provider,
        daemonId: "dmn_old",
        workspaceId: "local",
        metadata: { cli_version: "v0.2.56", launched_by: "cli" },
      });
    }
    store.registerRuntime({
      id: "rt_current",
      name: "current",
      provider: "claude",
      daemonId: "dmn_current",
      workspaceId: "local",
      metadata: { cli_version: "v0.2.58", launched_by: "cli" },
    });
    store.registerRuntime({
      id: "rt_desktop",
      name: "desktop",
      provider: "claude",
      daemonId: "dmn_desktop",
      workspaceId: "local",
      metadata: { cli_version: "v0.2.56", launched_by: "desktop" },
    });
    store.registerRuntime({
      id: "rt_cloud",
      name: "cloud",
      provider: "claude",
      daemonId: "dmn_cloud",
      runtimeMode: "cloud",
      workspaceId: "local",
      metadata: { cli_version: "v0.2.56", launched_by: "cli" },
    });

    const app = createMultiremiApp({ store, platformUpdaterToken: "updater-secret" });
    const heartbeat = () => app.request("/api/platform-updater/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Multiremi-Updater-Token": "updater-secret" },
      body: JSON.stringify({
        driver: "docker_compose",
        currentRelease: release("0.2.58"),
        latestRelease: release("0.2.58"),
      }),
    });

    expect((await heartbeat()).status).toBe(200);
    expect(db!.query(
      "SELECT runtime_id, target_version, status FROM multiremi_runtime_update_requests ORDER BY runtime_id",
    ).all()).toEqual([{
      runtime_id: "rt_old_claude",
      target_version: "0.2.58",
      status: "pending",
    }]);

    // Updater heartbeats are frequent; release history keeps reconciliation idempotent.
    expect((await heartbeat()).status).toBe(200);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_runtime_update_requests").get()).toEqual({ count: 1 });
  });

  it("defers daemon CLI updates while a platform operation is active", async () => {
    const store = createLocalStore();
    store.registerRuntime({
      id: "rt_deferred",
      name: "deferred",
      provider: "claude",
      daemonId: "dmn_deferred",
      workspaceId: "local",
      metadata: { cli_version: "v0.2.56", launched_by: "cli" },
    });
    const operation = store.createPlatformOperation({ kind: "restart" }, "local");
    const app = createMultiremiApp({ store, platformUpdaterToken: "updater-secret" });
    const heartbeat = () => app.request("/api/platform-updater/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Multiremi-Updater-Token": "updater-secret" },
      body: JSON.stringify({ driver: "systemd_release", currentRelease: release("0.2.58") }),
    });

    expect((await heartbeat()).status).toBe(200);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_runtime_update_requests").get()).toEqual({ count: 0 });

    store.reportPlatformOperation(operation.id, { status: "succeeded" });
    expect((await heartbeat()).status).toBe(200);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_runtime_update_requests").get()).toEqual({ count: 1 });
  });

  it("validates and returns the complete automatic update schedule", async () => {
    setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    const store = createLocalStore();
    const app = createMultiremiApp({ store, authToken: "master-secret" });
    const headers = { Authorization: "Bearer master-secret", "Content-Type": "application/json" };

    const invalid = await app.request("/api/multiremi/platform/settings", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ autoUpdate: { enabled: true, time: "25:00", timezone: "Asia/Shanghai" } }),
    });
    expect(invalid.status).toBe(400);

    const updated = await app.request("/api/multiremi/platform/settings", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ autoUpdate: { enabled: true, time: "04:30", timezone: "Asia/Shanghai" } }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).state.autoUpdate).toEqual({
      enabled: true,
      time: "04:30",
      timezone: "Asia/Shanghai",
      nextCheckAt: "2026-08-27T20:30:00.000Z",
      lastCheckedAt: null,
      lastResult: null,
    });
  });
});

function release(version: string) {
  return {
    version,
    ref: `ref-${version}`,
    publishedAt: null,
    releaseUrl: null,
    manifestUrl: `https://github.com/example/remi/releases/download/v${version}/platform-release.json`,
    apiImage: null,
    webImage: null,
  };
}

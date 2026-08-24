import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { PlatformOperationConflictError } from "@multiremi/store/repos/platform-operations-repo.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

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

  it("does not continuously retry the same failed automatic update", async () => {
    const store = createLocalStore();
    store.setPlatformAutoUpdateStable(true);
    const failed = store.createPlatformOperation({
      kind: "update",
      targetVersion: "0.2.43",
      targetRef: "https://github.com/example/remi/releases/download/v0.2.43/platform-release.json",
    }, "system:auto-update");
    store.reportPlatformOperation(failed.id, { status: "failed", error: "health check failed" });

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

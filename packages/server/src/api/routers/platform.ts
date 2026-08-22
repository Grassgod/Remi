import type { Context, Hono } from "hono";
import type {
  CreatePlatformOperationInput,
  MultiremiPlatformDeploymentDriver,
  MultiremiPlatformOperationKind,
  MultiremiPlatformOperationStatus,
  MultiremiPlatformRelease,
  MultiremiPlatformService,
  ReportPlatformOperationInput,
} from "@multiremi/contracts/types.js";
import { loadCurrentWorkspaceRole, readJson } from "../helpers.js";
import { currentRequestUserId } from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

const OPERATION_KINDS = new Set<MultiremiPlatformOperationKind>([
  "check_updates", "restart", "update", "rollback",
]);
const OPERATION_STATUSES = new Set<MultiremiPlatformOperationStatus>([
  "queued", "preparing", "pulling", "switching", "restarting", "verifying",
  "succeeded", "failed", "rolling_back", "rolled_back",
]);
const DRIVERS = new Set<MultiremiPlatformDeploymentDriver>(["systemd_release", "docker_compose"]);

export function registerPlatformRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/platform/status", (c) => {
    const requester = loadCurrentWorkspaceRole(c, store, "local", ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    const state = store.getPlatformState();
    const heartbeatAge = state.updaterHeartbeatAt
      ? Date.now() - new Date(state.updaterHeartbeatAt).getTime()
      : Number.POSITIVE_INFINITY;
    return c.json({
      canManage: true,
      driver: state.driver,
      currentRelease: state.currentRelease,
      latestRelease: state.latestRelease,
      updateAvailable: isReleaseNewer(state.latestRelease, state.currentRelease),
      autoUpdateStable: state.autoUpdateStable,
      updaterStatus: heartbeatAge <= 90_000 ? "ready" : heartbeatAge <= 300_000 ? "stale" : "offline",
      updaterHeartbeatAt: state.updaterHeartbeatAt,
      services: state.services,
      activeOperation: store.getActivePlatformOperation(),
      recentReleases: state.recentReleases,
    });
  });

  app.get("/api/multiremi/platform/operations", (c) => {
    const requester = loadCurrentWorkspaceRole(c, store, "local", ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    return c.json({ operations: store.listPlatformOperations(Number(c.req.query("limit") ?? 20)) });
  });

  app.post("/api/multiremi/platform/operations", async (c) => {
    const requester = loadCurrentWorkspaceRole(c, store, "local", ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    const body = await readJson<CreatePlatformOperationInput>(c);
    if (!OPERATION_KINDS.has(body.kind)) return c.json({ error: "invalid platform operation kind" }, 400);
    if ((body.kind === "update" || body.kind === "rollback") && !clean(body.targetRef) && !clean(body.targetVersion)) {
      return c.json({ error: "targetVersion or targetRef is required" }, 400);
    }
    const operation = store.createPlatformOperation({
      kind: body.kind,
      targetVersion: clean(body.targetVersion),
      targetRef: clean(body.targetRef),
      targetManifest: body.targetManifest ?? {},
    }, currentRequestUserId(c));
    return c.json({ operation }, 202);
  });

  app.patch("/api/multiremi/platform/settings", async (c) => {
    const requester = loadCurrentWorkspaceRole(c, store, "local", ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    const body = await readJson<{ autoUpdateStable?: boolean }>(c);
    if (typeof body.autoUpdateStable !== "boolean") return c.json({ error: "autoUpdateStable is required" }, 400);
    return c.json({ state: store.setPlatformAutoUpdateStable(body.autoUpdateStable) });
  });

  app.post("/api/platform-updater/heartbeat", async (c) => {
    const denied = denyUpdater(c, deps);
    if (denied) return denied;
    const body = await readJson<{
      driver?: MultiremiPlatformDeploymentDriver;
      currentRelease?: MultiremiPlatformRelease | null;
      latestRelease?: MultiremiPlatformRelease | null;
      recentReleases?: MultiremiPlatformRelease[];
      services?: MultiremiPlatformService[];
    }>(c);
    if (!body.driver || !DRIVERS.has(body.driver)) return c.json({ error: "valid driver is required" }, 400);
    const state = store.heartbeatPlatformUpdater({
      driver: body.driver,
      currentRelease: body.currentRelease,
      latestRelease: body.latestRelease,
      recentReleases: body.recentReleases,
      services: body.services,
    });
    if (
      state.autoUpdateStable
      && isReleaseNewer(state.latestRelease, state.currentRelease)
      && state.latestRelease?.manifestUrl
      && !store.getActivePlatformOperation()
      && !hasRecentFailedAutoUpdate(store.listPlatformOperations(100), state.latestRelease.version)
    ) {
      store.createPlatformOperation({
        kind: "update",
        targetVersion: state.latestRelease.version,
        targetRef: state.latestRelease.manifestUrl,
      }, "system:auto-update");
    }
    return c.json({ state });
  });

  app.post("/api/platform-updater/operations/claim", (c) => {
    const denied = denyUpdater(c, deps);
    if (denied) return denied;
    return c.json({ operation: store.claimPlatformOperation() });
  });

  app.post("/api/platform-updater/operations/:id/report", async (c) => {
    const denied = denyUpdater(c, deps);
    if (denied) return denied;
    const body = await readJson<ReportPlatformOperationInput>(c);
    if (!OPERATION_STATUSES.has(body.status)) return c.json({ error: "invalid platform operation status" }, 400);
    const operation = store.reportPlatformOperation(c.req.param("id"), body);
    if (!operation) return c.json({ error: "platform operation not found" }, 404);
    return c.json({ operation });
  });
}

function hasRecentFailedAutoUpdate(
  operations: Array<{ kind: string; status: string; targetVersion: string | null; finishedAt: string | null }>,
  targetVersion: string,
): boolean {
  const retryAfter = Date.now() - 6 * 60 * 60 * 1_000;
  return operations.some((operation) =>
    operation.kind === "update"
    && operation.status === "failed"
    && operation.targetVersion === targetVersion
    && operation.finishedAt !== null
    && new Date(operation.finishedAt).getTime() > retryAfter
  );
}

function denyUpdater(c: Context, deps: RouterDeps): Response | null {
  const supplied = c.req.header("X-Multiremi-Updater-Token") ?? "";
  if (!deps.platformUpdaterToken || supplied !== deps.platformUpdaterToken) {
    return c.json({ error: "unauthorized updater" }, 401);
  }
  return null;
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isReleaseNewer(latest: MultiremiPlatformRelease | null, current: MultiremiPlatformRelease | null): boolean {
  if (!latest?.version || !current?.version) return false;
  const left = latest.version.replace(/^v/, "").split(".").map(Number);
  const right = current.version.replace(/^v/, "").split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

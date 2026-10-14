import type { Hono } from "hono";
import {
  resolveStorageSettings,
  validateStorageSettingsPatch,
  type CreateGcRunInput,
  type StorageSettings,
  type StorageSettingsPatch,
  type WorkspaceStorageDaemon,
  type WorkspaceStorageDaemonsResponse,
  type WorkspaceStorageResponse,
} from "@multiremi/contracts/storage.js";
import { isRuntimeEffectivelyOnline } from "@multiremi/store/repos/runtimes-repo.js";
import {
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  loadRuntimeForCurrentUser,
  publishWorkspaceEvent,
  readJsonStrict,
  requireHumanWorkspaceAdmin,
} from "../helpers.js";
import { currentRequestUserId, runtimeWorkspaceId } from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

/** The keys a workspace sets itself, i.e. `settings.storage` minus anything invalid. */
function storageOverrides(raw: unknown): Partial<StorageSettings> {
  const overrides: Partial<StorageSettings> = {};
  for (const [key, value] of Object.entries(validateStorageSettingsPatch(raw).patch)) {
    if (typeof value === "number") overrides[key as keyof StorageSettings] = value;
  }
  return overrides;
}

function storageResponse(settings: Record<string, unknown>): WorkspaceStorageResponse {
  return { settings: resolveStorageSettings(settings.storage), overrides: storageOverrides(settings.storage) };
}

export function registerStorageRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;
  const loadWorkspace = (workspaceId: string) =>
    workspaceId === "local" ? store.ensureLocalWorkspace() : store.getWorkspace(workspaceId);

  app.get("/api/workspaces/:id/storage", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const workspace = loadWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    return c.json(storageResponse(workspace.settings));
  });

  app.put("/api/workspaces/:id/storage", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<StorageSettingsPatch>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const { patch, errors } = validateStorageSettingsPatch(body);
    if (errors.length) return c.json({ error: "invalid storage settings", details: errors }, 400);
    const workspace = loadWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    if (!Object.keys(patch).length) return c.json(storageResponse(workspace.settings));
    const storage: Partial<StorageSettings> = storageOverrides(workspace.settings.storage);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete storage[key as keyof StorageSettings];
      else storage[key as keyof StorageSettings] = value;
    }
    const { storage: _previous, ...settings } = workspace.settings;
    const updated = store.updateWorkspace(workspaceId, {
      settings: Object.keys(storage).length ? { ...settings, storage } : settings,
    });
    publishWorkspaceEvent(c, store, "workspace:updated", workspaceId, { workspace: updated });
    return c.json(storageResponse(updated.settings));
  });

  app.get("/api/workspaces/:id/storage/daemons", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (!loadWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    const byDaemon = new Map<string, WorkspaceStorageDaemon>();
    for (const runtime of store.listRuntimesForWorkspace(workspaceId)) {
      if (!runtime.daemonId) continue;
      const daemon = byDaemon.get(runtime.daemonId) ?? {
        daemon_id: runtime.daemonId,
        name: runtime.daemonDisplayName || runtime.deviceInfo || runtime.daemonId,
        runtime_ids: [],
        online: false,
        report: null,
        reported_at: null,
      };
      daemon.runtime_ids.push(runtime.id);
      daemon.online ||= isRuntimeEffectivelyOnline(runtime);
      byDaemon.set(runtime.daemonId, daemon);
    }
    for (const record of store.listDaemonStorageReports(workspaceId, [...byDaemon.keys()])) {
      const daemon = byDaemon.get(record.daemonId)!;
      daemon.report = record.report;
      daemon.reported_at = record.reportedAt;
    }
    const response: WorkspaceStorageDaemonsResponse = { daemons: [...byDaemon.values()] };
    return c.json(response);
  });

  app.post("/api/runtimes/:id/gc-runs", async (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const denied = requireHumanWorkspaceAdmin(c, store, runtimeWorkspaceId(loaded.runtime));
    if (denied) return denied;
    if (loaded.runtime.status !== "online") return c.json({ error: "runtime is offline" }, 503);
    const body = await readJsonStrict<CreateGcRunInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (body?.mode !== "dry_run" && body?.mode !== "run") {
      return c.json({ error: "mode must be dry_run or run" }, 400);
    }
    const request = store.createRuntimeGcRunRequest(loaded.runtime.id, {
      mode: body.mode,
      requestedBy: currentRequestUserId(c),
    });
    return c.json({ request }, 201);
  });

  app.get("/api/runtimes/:id/gc-runs/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeGcRunRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json({ request });
  });
}

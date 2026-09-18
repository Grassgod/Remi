import type { Hono } from "hono";
import type { CreateRuntimeWorkspaceInput } from "@multiremi/contracts/types.js";
import { RuntimeWorkspaceError } from "@multiremi/store/repos/runtime-workspaces-repo.js";
import { currentAccessToken, currentRequestUserId } from "../wire/index.js";
import { readJson } from "../helpers/request.js";
import { denyCurrentUserWorkspaceAccess } from "../helpers/auth-guards.js";
import { loadRuntimeForCurrentOwner, loadRuntimeForCurrentUser, requestedRuntimeWorkspaceId } from "../helpers/runtimes.js";
import { canUseRuntimeWorkspace, runtimeWorkspaceResponse } from "../helpers/runtime-workspaces.js";
import type { RouterDeps } from "./deps.js";

export function registerRuntimeWorkspaceRoutes(app: Hono, { store }: RouterDeps): void {
  app.get("/api/runtime-workspaces", c => {
    const workspaceId = requestedRuntimeWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json({ workspaces: store.runtimeWorkspaces.list(workspaceId, c.req.query("archived") === "true")
      .filter(w => canUseRuntimeWorkspace(c, store, w)).map(w => runtimeWorkspaceResponse(store, w)) });
  });
  app.get("/api/runtimes/:id/workspaces", c => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json({ workspaces: store.runtimeWorkspaces.list(loaded.runtime.workspaceId ?? "local")
      .filter(w => w.daemonId === loaded.runtime.daemonId && canUseRuntimeWorkspace(c, store, w))
      .map(w => runtimeWorkspaceResponse(store, w)) });
  });
  app.post("/api/runtimes/:id/workspaces", async c => {
    if (currentAccessToken(c)?.type === "task") return c.json({ error: "task tokens cannot register local directories" }, 403);
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"), "runtime workspaces");
    if (loaded instanceof Response) return loaded;
    const input = await readJson<CreateRuntimeWorkspaceInput>(c);
    const item = store.runtimeWorkspaces.create(loaded.runtime.id, input);
    return c.json(runtimeWorkspaceResponse(store, item), 201);
  });
  app.get("/api/runtime-workspaces/:id", c => {
    const item = load(c, false);
    return item instanceof Response ? item : c.json(runtimeWorkspaceResponse(store, item));
  });
  app.patch("/api/runtime-workspaces/:id", async c => {
    const item = load(c, true);
    if (item instanceof Response) return item;
    const input = await readJson<{ name: string }>(c);
    if (Object.keys(input).some(k => k !== "name")) throw new RuntimeWorkspaceError("Only name can change; register a new workspace for a different environment");
    return c.json(runtimeWorkspaceResponse(store, store.runtimeWorkspaces.rename(item.id, input.name)));
  });
  app.delete("/api/runtime-workspaces/:id", c => {
    const item = load(c, true);
    if (item instanceof Response) return item;
    return c.json(runtimeWorkspaceResponse(store, store.runtimeWorkspaces.archive(item.id)));
  });

  function load(c: import("hono").Context, edit: boolean) {
    const item = store.runtimeWorkspaces.get(c.req.param("id") ?? "");
    if (!item) return c.json({ error: "runtime workspace not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, item.workspaceId);
    if (denied) return denied;
    if (!canUseRuntimeWorkspace(c, store, item)
      || (edit && (currentAccessToken(c)?.type === "task" || currentRequestUserId(c) !== item.ownerId))) {
      return c.json({ error: "runtime workspace access denied" }, 403);
    }
    return item;
  }
}

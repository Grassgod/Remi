import type { Context, Hono } from "hono";
import type {
  CreateScmConnectionInput,
  MultiremiScmCanonicalEventType,
  UpdateScmConnectionInput,
} from "@multiremi/contracts/types.js";
import { ScmCredentialEncryptionError } from "@multiremi/scm/credentials.js";
import {
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  publishWorkspaceEvent,
  readJsonStrict,
  readJsonStrictAllowEmpty,
  requireWorkspaceAdmin,
} from "../helpers.js";
import { listWorkspaceRepositories } from "../helpers/repositories.js";
import type { RouterDeps } from "./deps.js";

export function registerScmRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/workspaces/:workspaceId/scm/connections", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const connections = store.listScmConnectionsWithRepositories({ workspaceId });
    return c.json({ connections, total: connections.length });
  });

  app.post("/api/workspaces/:workspaceId/scm/connections", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateScmConnectionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      if (workspaceId === "local") store.ensureLocalWorkspace();
      const connection = store.createScmConnection({ ...body, workspaceId });
      publishWorkspaceEvent(c, store, "scm:connection_created", workspaceId, { connection });
      return c.json({ connection }, 201);
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.get("/api/workspaces/:workspaceId/scm/connections/:connectionId", (c) => {
    const loaded = loadConnection(c, deps);
    if (loaded instanceof Response) return loaded;
    return c.json({ connection: loaded.connection });
  });

  app.patch("/api/workspaces/:workspaceId/scm/connections/:connectionId", async (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrictAllowEmpty<UpdateScmConnectionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const connection = store.updateScmConnection(loaded.connection.id, body);
      publishWorkspaceEvent(c, store, "scm:connection_updated", loaded.connection.workspaceId, { connection });
      return c.json({ connection });
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.delete("/api/workspaces/:workspaceId/scm/connections/:connectionId", (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    try {
      if (!store.deleteScmConnection(loaded.connection.id)) return c.json({ error: "SCM connection not found" }, 404);
      publishWorkspaceEvent(c, store, "scm:connection_deleted", loaded.connection.workspaceId, {
        connectionId: loaded.connection.id,
      });
      return c.body(null, 204);
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.put("/api/workspaces/:workspaceId/scm/connections/:connectionId/repositories/:repositoryId", async (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrictAllowEmpty<{
      externalId?: string | null;
      external_id?: string | null;
      owner?: string | null;
      enabled?: boolean;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const repository = listWorkspaceRepositories(store, loaded.connection.workspaceId)
        .find((candidate) => candidate.id === c.req.param("repositoryId"));
      if (!repository) return c.json({ error: "repository not found" }, 404);
      const binding = store.upsertScmRepositoryBinding({
        workspaceId: loaded.connection.workspaceId,
        connectionId: loaded.connection.id,
        repositoryId: repository.id,
        repositoryUrl: repository.url,
        repositorySource: repository.source,
        name: repository.name,
        defaultBranch: repository.default_branch,
        externalId: body.externalId ?? body.external_id,
        owner: body.owner,
        enabled: body.enabled,
      });
      publishWorkspaceEvent(c, store, "scm:repository_bound", loaded.connection.workspaceId, { binding });
      return c.json({ connection: store.getScmConnectionWithRepositories(loaded.connection.id) });
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.delete("/api/workspaces/:workspaceId/scm/connections/:connectionId/repositories/:repositoryId", (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const deleted = store.deleteScmRepositoryBinding(loaded.connection.id, c.req.param("repositoryId"));
    if (!deleted) return c.json({ error: "repository binding not found" }, 404);
    publishWorkspaceEvent(c, store, "scm:repository_unbound", loaded.connection.workspaceId, {
      connectionId: loaded.connection.id,
      repositoryId: c.req.param("repositoryId"),
    });
    return c.body(null, 204);
  });

  app.get("/api/workspaces/:workspaceId/scm/events", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const type = cleanQuery(c.req.query("type")) as MultiremiScmCanonicalEventType | null;
    const limit = eventPageLimit(c.req.query("limit"));
    try {
      const rows = store.listScmCanonicalEvents({
        workspaceId,
        connectionId: cleanQuery(c.req.query("connectionId") ?? c.req.query("connection_id")),
        repositoryId: cleanQuery(c.req.query("repositoryId") ?? c.req.query("repository_id")),
        type,
        after: cleanQuery(c.req.query("after")),
        limit: limit + 1,
      });
      const hasMore = rows.length > limit;
      const events = hasMore ? rows.slice(0, limit) : rows;
      return c.json({
        events,
        total: events.length,
        nextAfter: hasMore ? events.at(-1)?.id ?? null : null,
      });
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.get("/api/workspaces/:workspaceId/scm/events/:eventId", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const event = store.getScmCanonicalEvent(c.req.param("eventId"));
    if (!event || event.workspaceId !== workspaceId) return c.json({ error: "SCM event not found" }, 404);
    return c.json({ event, evidence: store.listScmEventEvidence(event.id) });
  });
}

function loadConnection(c: Context, deps: RouterDeps, requireAdmin = false): {
  connection: NonNullable<ReturnType<RouterDeps["store"]["getScmConnectionWithRepositories"]>>;
} | Response {
  const workspaceId = c.req.param("workspaceId") ?? "";
  const denied = denyCurrentUserWorkspaceAccess(c, deps.store, workspaceId)
    ?? (requireAdmin ? requireWorkspaceAdmin(c, deps.store, workspaceId) : null);
  if (denied) return denied;
  const connection = deps.store.getScmConnectionWithRepositories(c.req.param("connectionId") ?? "");
  if (!connection || connection.workspaceId !== workspaceId) return c.json({ error: "SCM connection not found" }, 404);
  return { connection };
}

function cleanQuery(value: string | undefined): string | null {
  return value?.trim() || null;
}

function eventPageLimit(value: string | undefined): number {
  const parsed = Number(value ?? 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function scmErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ScmCredentialEncryptionError) {
    return c.json({ error: message, code: error.code }, 503);
  }
  if (/already exists|UNIQUE constraint|duplicate key/iu.test(message)) return c.json({ error: message }, 409);
  if (/not found/iu.test(message)) return c.json({ error: message }, 404);
  if (/event history/iu.test(message)) return c.json({ error: message }, 409);
  return c.json({ error: message }, 400);
}

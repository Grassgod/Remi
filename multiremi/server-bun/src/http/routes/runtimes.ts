/**
 * Agent-runtime routes — port of the Go runtime handler. Read path
 * (GET /api/runtimes list, GET /api/runtimes/:id get) plus the member-facing
 * write path (POST register, PUT :id update, DELETE :id). Behind the /api/*
 * JWT gate; scoped to a workspace via the X-Workspace-ID header + a membership
 * check (multi-tenancy). The daemon claim/heartbeat writes live in
 * routes/daemontasks.ts and are NOT duplicated here.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import {
  createAgentRuntime,
  deleteAgentRuntime,
  getAgentRuntimeInWorkspace,
  listAgentRuntimes,
  updateAgentRuntime,
  type AgentRuntime,
  type NewAgentRuntime,
} from "../../db/queries/runtimes.js";
import { listRuntimeUsageDaily, listRuntimeUsageByAgent } from "../../db/queries/runtimeUsage.js";
import { modelListStore } from "../../runtime/modelStore.js";
import { bus } from "../../realtime/bus.js";

/** Parse ?days=N (default `def`, clamped 1..365) into a UTC `since` instant. */
function sinceFromDays(c: { req: { query: (k: string) => string | undefined } }, def: number): Date {
  const raw = Number.parseInt(c.req.query("days") ?? "", 10);
  const days = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 365) : def;
  return new Date(Date.now() - days * 86_400_000);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-provider user-visible launch skeleton (port of Go agent.launchHeaders /
 * LaunchHeader). Unknown providers yield "" — matches the Go map lookup.
 */
const LAUNCH_HEADERS: Record<string, string> = {
  antigravity: "agy -p (print mode)",
  claude: "claude (stream-json)",
  codex: "codex app-server",
  copilot: "copilot (json)",
  cursor: "cursor-agent (stream-json)",
  gemini: "gemini (stream-json)",
  hermes: "hermes acp",
  kimi: "kimi acp",
  kiro: "kiro-cli acp",
  openclaw: "openclaw agent (json)",
  opencode: "opencode run (json)",
  pi: "pi (json mode)",
};

function launchHeader(provider: string): string {
  return LAUNCH_HEADERS[provider] ?? "";
}

/**
 * Mirrors the Go AgentRuntimeResponse struct (snake_case JSON). metadata
 * defaults to {} when null (matches the Go json.Unmarshal-into-any fallback).
 */
function runtimeToResponse(rt: AgentRuntime) {
  return {
    id: rt.id,
    workspace_id: rt.workspaceId,
    daemon_id: rt.daemonId,
    name: rt.name,
    runtime_mode: rt.runtimeMode,
    provider: rt.provider,
    launch_header: launchHeader(rt.provider),
    status: rt.status,
    device_info: rt.deviceInfo,
    metadata: rt.metadata ?? {},
    owner_id: rt.ownerId,
    visibility: rt.visibility,
    last_seen_at: rt.lastSeenAt,
    created_at: rt.createdAt,
    updated_at: rt.updatedAt,
  };
}

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID, or a Response to short-circuit with (400 missing/malformed
 * header, 404 not-a-member — mirrors the Go workspace-member gate).
 */
async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

export function runtimeRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    // `?owner=me` narrows to the caller's own runtimes (mirrors Go
    // ListAgentRuntimesByOwner). Any other value lists the whole workspace.
    const ownerId = c.req.query("owner") === "me" ? c.get("user").sub : undefined;
    const runtimes = await listAgentRuntimes(db, ws, ownerId);

    return c.json(runtimes.map(runtimeToResponse));
  });

  // POST /api/runtimes — register a runtime for the caller's workspace. Owner is
  // the authenticated member (mirrors the Go register handler's OwnerID =
  // member.UserID). A freshly-registered runtime starts `offline` (schema
  // default) until a heartbeat marks it online.
  r.post("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);

    const runtimeMode = typeof body.runtime_mode === "string" ? body.runtime_mode : "";
    if (runtimeMode !== "local" && runtimeMode !== "cloud") {
      return c.json({ error: "runtime_mode must be 'local' or 'cloud'" }, 400);
    }

    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    if (!provider) return c.json({ error: "provider is required" }, 400);

    const deviceInfo = typeof body.device_info === "string" ? body.device_info : "";

    const input: NewAgentRuntime = {
      workspaceId: ws,
      name,
      runtimeMode,
      provider,
      deviceInfo,
      ownerId: c.get("user").sub,
    };
    const created = await createAgentRuntime(db, input);

    bus.publish({
      type: "runtime.created",
      workspaceId: ws,
      payload: { id: created.id },
    });

    return c.json(runtimeToResponse(created), 201);
  });

  r.get("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);

    const found = await getAgentRuntimeInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);

    return c.json(runtimeToResponse(found));
  });

  // PUT /api/runtimes/:id — partial update of a workspace runtime. Only fields
  // present in the body are touched (mirrors the Go UpdateAgentRuntimeRequest
  // pointer fields). Editable here: name, visibility, status.
  r.put("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);

    const found = await getAgentRuntimeInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const fields: Partial<NewAgentRuntime> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) return c.json({ error: "name cannot be empty" }, 400);
      fields.name = name;
    }
    if ("visibility" in body) {
      const v = body.visibility;
      if (v !== "private" && v !== "public") {
        return c.json({ error: "visibility must be 'private' or 'public'" }, 400);
      }
      fields.visibility = v;
    }
    if ("status" in body) {
      const s = body.status;
      if (s !== "online" && s !== "offline") {
        return c.json({ error: "status must be 'online' or 'offline'" }, 400);
      }
      fields.status = s;
    }

    const updated = (await updateAgentRuntime(db, found.id, fields)) ?? found;

    bus.publish({
      type: "runtime.updated",
      workspaceId: ws,
      payload: { id: found.id },
    });

    return c.json(runtimeToResponse(updated));
  });

  // DELETE /api/runtimes/:id — remove a workspace runtime. 204 on success.
  r.delete("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);

    const found = await getAgentRuntimeInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);

    await deleteAgentRuntime(db, found.id);

    bus.publish({
      type: "runtime.deleted",
      workspaceId: ws,
      payload: { id: found.id },
    });

    return c.body(null, 204);
  });

  // POST /api/runtimes/:id/models — ask the runtime to enumerate its models.
  // Returns a request id the client polls; the daemon claims + reports it.
  r.post("/:id/models", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);
    const found = await getAgentRuntimeInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);
    const req = modelListStore.create(found.id);
    return c.json({ request_id: req.id, status: req.status }, 202);
  });

  // GET /api/runtimes/:id/models/:requestId — poll a model-list request.
  r.get("/:id/models/:requestId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);
    const found = await getAgentRuntimeInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);
    const req = modelListStore.get(c.req.param("requestId"));
    if (!req || req.runtimeId !== found.id) return c.json({ error: "request not found" }, 404);
    return c.json({ request_id: req.id, status: req.status, models: req.models, error: req.error, updated_at: req.updatedAt });
  });

  // POST /api/runtimes/:id/models/:requestId/result — daemon reports the result.
  r.post("/:id/models/:requestId/result", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);
    const found = await getAgentRuntimeInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const requestId = c.req.param("requestId");
    const existing = modelListStore.get(requestId);
    if (!existing || existing.runtimeId !== found.id) return c.json({ error: "request not found" }, 404);
    const updated = modelListStore.report(requestId, {
      models: Array.isArray(body.models) ? body.models : undefined,
      error: typeof body.error === "string" && body.error ? body.error : undefined,
    });
    return c.json({ status: updated!.status });
  });

  // GET /api/runtimes/:id/usage?days=N — per-(date,provider,model) token totals.
  r.get("/:id/usage", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);
    const found = await getAgentRuntimeInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);

    const rows = await listRuntimeUsageDaily(db, found.id, "UTC", sinceFromDays(c, 90));
    return c.json(
      rows.map((u) => ({
        runtime_id: found.id,
        date: u.date,
        provider: u.provider,
        model: u.model,
        input_tokens: Number(u.inputTokens),
        output_tokens: Number(u.outputTokens),
        cache_read_tokens: Number(u.cacheReadTokens),
        cache_write_tokens: Number(u.cacheWriteTokens),
        task_count: Number(u.taskCount),
      })),
    );
  });

  // GET /api/runtimes/:id/usage/by-agent?days=N — per-(agent,model) token totals.
  r.get("/:id/usage/by-agent", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);
    const found = await getAgentRuntimeInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);

    const rows = await listRuntimeUsageByAgent(db, found.id, sinceFromDays(c, 30));
    return c.json(
      rows.map((u) => ({
        agent_id: u.agentId,
        model: u.model,
        input_tokens: Number(u.inputTokens),
        output_tokens: Number(u.outputTokens),
        cache_read_tokens: Number(u.cacheReadTokens),
        cache_write_tokens: Number(u.cacheWriteTokens),
        task_count: Number(u.taskCount),
      })),
    );
  });

  return r;
}

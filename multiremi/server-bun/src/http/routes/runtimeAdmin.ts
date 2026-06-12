/**
 * Runtime admin routes — port of the Go runtime-detail endpoints that are not
 * in routes/runtimes.ts:
 *
 *   PATCH /api/runtimes/:id                          (UpdateAgentRuntime — visibility)
 *   GET   /api/runtimes/:id/activity                 (GetRuntimeTaskActivity)
 *   GET   /api/runtimes/:id/usage/by-hour            (GetRuntimeUsageByHour)
 *   POST  /api/runtimes/:id/archive-agents-and-delete (ArchiveAgentsAndDeleteRuntime)
 *
 * Declares absolute /api/* paths — mount at the app root, behind the /api/*
 * JWT gate, exactly like the other standalone factories.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Member } from "../../db/schema.js";
import { getMembership } from "../../db/queries/issues.js";
import {
  getAgentRuntimeInWorkspace,
  updateAgentRuntime,
  type AgentRuntime,
} from "../../db/queries/runtimes.js";
import {
  archiveAgentsAndDeleteRuntime,
  getRuntimeTaskHourlyActivity,
  listRuntimeUsageByHour,
  type Agent,
} from "../../db/queries/runtimeAdmin.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-provider launch skeleton — keep in sync with routes/runtimes.ts (the Go
 * source of both is agent.launchHeaders; unknown providers yield "").
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

/** Mirrors the Go AgentRuntimeResponse struct (same shape as routes/runtimes.ts). */
function runtimeToResponse(rt: AgentRuntime) {
  return {
    id: rt.id,
    workspace_id: rt.workspaceId,
    daemon_id: rt.daemonId,
    name: rt.name,
    runtime_mode: rt.runtimeMode,
    provider: rt.provider,
    launch_header: LAUNCH_HEADERS[rt.provider] ?? "",
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
 * Mirrors the Go agentToResponse for the cascade 409 body's `active_agents`.
 * Like Go, skills is always [] here (the dialog only needs identity fields);
 * custom_env stays server-side — only coarse key-count metadata crosses.
 */
function agentToResponse(a: Agent) {
  const runtimeConfig = a.runtimeConfig && typeof a.runtimeConfig === "object" ? a.runtimeConfig : {};
  const customArgs = Array.isArray(a.customArgs) ? (a.customArgs as string[]) : [];
  const envKeyCount =
    a.customEnv && typeof a.customEnv === "object" && !Array.isArray(a.customEnv)
      ? Object.keys(a.customEnv as Record<string, unknown>).length
      : 0;

  return {
    id: a.id,
    workspace_id: a.workspaceId,
    runtime_id: a.runtimeId,
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    avatar_url: a.avatarUrl,
    runtime_mode: a.runtimeMode,
    runtime_config: runtimeConfig,
    custom_args: customArgs,
    mcp_config: a.mcpConfig ?? null,
    has_custom_env: envKeyCount > 0,
    custom_env_key_count: envKeyCount,
    mcp_config_redacted: false,
    visibility: a.visibility,
    status: a.status,
    max_concurrent_tasks: a.maxConcurrentTasks,
    model: a.model ?? "",
    thinking_level: a.thinkingLevel ?? "",
    owner_id: a.ownerId,
    skills: [],
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    archived_at: a.archivedAt,
    archived_by: a.archivedBy,
  };
}

interface WorkspaceCtx {
  wsId: string;
  member: Member;
}

/**
 * Resolve + authorize the workspace for this request (same gate as
 * routes/runtimes.ts, but also returns the member row — the write endpoints
 * need its role/userId for the owner-only check).
 */
async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<WorkspaceCtx | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return { wsId, member: m };
}

/**
 * Port of Go canEditRuntime: workspace owners/admins can edit/delete any
 * runtime; plain members only their own.
 */
function canEditRuntime(member: Member, rt: AgentRuntime): boolean {
  if (member.role === "owner" || member.role === "admin") return true;
  return rt.ownerId !== null && rt.ownerId === member.userId;
}

/**
 * Viewer tz for hour bucketing: validated `?tz=` else UTC (port of Go
 * resolveViewingTZ; invalid values fall through — tz is a display concern).
 * The browser always sends `?tz=`, so the Go-side user.timezone cold fallback
 * is intentionally not replicated here.
 */
function resolveViewingTZ(c: Context<AppEnv>): string {
  const tz = (c.req.query("tz") ?? "").trim();
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      /* fall through to UTC */
    }
  }
  return "UTC";
}

/** Port of Go parseSinceParamInTZ's days handling: out-of-range → default. */
function parseDays(c: Context<AppEnv>, def: number): number {
  const raw = c.req.query("days");
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 365) return parsed;
  }
  return def;
}

/**
 * Shared 409 body for the cascade endpoint (Go runtimeHasActiveAgentsResponse
 * with the plan-changed code/error the cascade path overrides onto it).
 */
function planChangedResponse(activeAgents: Agent[]) {
  return {
    error: "the active agent set changed; please review and confirm again.",
    code: "runtime_delete_plan_changed",
    active_agents: activeAgents.map(agentToResponse),
  };
}

export function runtimeAdminRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // PATCH /api/runtimes/:id — port of Go UpdateAgentRuntime. Currently only
  // `visibility` is editable (private ⇄ public); the body shape is open-ended
  // so future fields can land without a route change. Owner/admin or runtime
  // owner only.
  r.patch("/api/runtimes/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);

    const found = await getAgentRuntimeInWorkspace(db, ws.wsId, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);
    if (!canEditRuntime(ws.member, found)) {
      return c.json({ error: "you can only edit your own runtimes" }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    let newVisibility: "private" | "public" | undefined;
    if (body.visibility !== undefined && body.visibility !== null) {
      const v = body.visibility;
      if (v !== "private" && v !== "public") {
        return c.json({ error: "visibility must be 'private' or 'public'" }, 400);
      }
      if (v !== found.visibility) newVisibility = v;
    }

    let rt = found;
    if (newVisibility) {
      rt = (await updateAgentRuntime(db, found.id, { visibility: newVisibility })) ?? found;
      // Notify connected clients that runtime metadata changed so list/detail
      // pages refresh (Go publishes daemon:register{action:update}; the Bun
      // realtime vocabulary for the same signal is runtime.updated).
      bus.publish({ type: "runtime.updated", workspaceId: ws.wsId, payload: { id: found.id } });
    }

    return c.json(runtimeToResponse(rt));
  });

  // GET /api/runtimes/:id/activity?tz= — hour-of-day task-start distribution
  // (port of Go GetRuntimeTaskActivity; rows are {hour, count}).
  r.get("/api/runtimes/:id/activity", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);
    const found = await getAgentRuntimeInWorkspace(db, ws.wsId, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);

    const rows = await getRuntimeTaskHourlyActivity(db, found.id, resolveViewingTZ(c));
    return c.json(rows.map((row) => ({ hour: Number(row.hour), count: Number(row.count) })));
  });

  // GET /api/runtimes/:id/usage/by-hour?days=&tz= — per-(hour, model) token
  // aggregates since the cutoff (port of Go GetRuntimeUsageByHour). Hours with
  // zero activity are omitted; the client fills the 0..23 axis.
  r.get("/api/runtimes/:id/usage/by-hour", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);
    const found = await getAgentRuntimeInWorkspace(db, ws.wsId, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);

    const rows = await listRuntimeUsageByHour(db, found.id, resolveViewingTZ(c), parseDays(c, 30));
    return c.json(
      rows.map((u) => ({
        hour: Number(u.hour),
        model: u.model,
        input_tokens: Number(u.inputTokens),
        output_tokens: Number(u.outputTokens),
        cache_read_tokens: Number(u.cacheReadTokens),
        cache_write_tokens: Number(u.cacheWriteTokens),
        task_count: Number(u.taskCount),
      })),
    );
  });

  // POST /api/runtimes/:id/archive-agents-and-delete — cascade teardown (port
  // of Go ArchiveAgentsAndDeleteRuntime): archive every active agent, cancel
  // their tasks, pause autopilots targeting them, hard-delete the archived
  // rows, delete the runtime — one transaction. The body's
  // expected_active_agent_ids is the snapshot the user confirmed; a mismatch
  // with the live set refuses with 409 runtime_delete_plan_changed.
  r.post("/api/runtimes/:id/archive-agents-and-delete", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    // nil/empty is a valid plan ("I confirmed there are no active agents");
    // any malformed entry → 400 so a typo can never match a different set.
    const rawIds = body.expected_active_agent_ids ?? [];
    if (!Array.isArray(rawIds)) return c.json({ error: "invalid request body" }, 400);
    const expected = new Set<string>();
    for (const s of rawIds) {
      if (typeof s !== "string" || !UUID_RE.test(s)) {
        return c.json({ error: "expected_active_agent_ids must be a list of valid UUIDs" }, 400);
      }
      expected.add(s.toLowerCase());
    }

    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const found = await getAgentRuntimeInWorkspace(db, ws.wsId, id);
    if (!found) return c.json({ error: "runtime not found" }, 404);
    if (!canEditRuntime(ws.member, found)) {
      return c.json({ error: "you can only delete your own runtimes" }, 403);
    }

    const result = await archiveAgentsAndDeleteRuntime(db, found.id, expected, ws.member.userId);
    if (result.status === "plan_changed") {
      return c.json(planChangedResponse(result.activeAgents), 409);
    }
    if (result.status === "lock_failed") {
      return c.json({ error: "failed to lock runtime" }, 500);
    }

    // Post-commit fan-out, same ordering as the Go cascade so subscribers
    // observe task:cancelled → agent archived → runtime-list refresh.
    for (const t of result.cancelledTasks) {
      const payload: Record<string, unknown> = {
        task_id: t.id,
        agent_id: t.agentId,
        issue_id: t.issueId ?? "",
        status: t.status,
      };
      if (t.chatSessionId) payload.chat_session_id = t.chatSessionId;
      bus.publish({ type: "task:cancelled", workspaceId: ws.wsId, payload });
    }
    for (const a of result.archivedAgents) {
      // Go publishes agent:archived; the Bun archive path's vocabulary for the
      // same signal is agent.updated (see routes/agents.ts POST :id/archive).
      bus.publish({ type: "agent.updated", workspaceId: ws.wsId, payload: { id: a.id } });
    }
    bus.publish({ type: "runtime.deleted", workspaceId: ws.wsId, payload: { id: found.id } });

    return c.json({
      status: "ok",
      agents_archived: result.archivedAgents.length,
      tasks_cancelled: result.cancelledTasks.length,
    });
  });

  return r;
}

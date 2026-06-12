/**
 * Agent task history + autopilot run history routes — ports of the Go handlers
 * ListAgentTasks (server/internal/handler/agent.go), ListAutopilotRuns and
 * GetAutopilotRun (server/internal/handler/autopilot.go):
 *
 *   GET /api/agents/:id/tasks            — an agent's full task history (newest first)
 *   GET /api/autopilots/:id/runs         — paginated run list (trigger_payload omitted)
 *   GET /api/autopilots/:id/runs/:runId  — single run incl. full trigger_payload
 *
 * Declares absolute /api/* paths → mount at the app root, behind the /api/*
 * JWT gate. Workspace scoping via X-Workspace-ID header (or the resolved wsId
 * context var) + a membership check (multi-tenancy).
 *
 * Private-agent gate (mirrors Go canAccessPrivateAgent): task history is one of
 * the protected surfaces for `visibility = 'private'` agents — only the agent's
 * owner and workspace owner/admin members may read it; a plain member gets 403.
 * The Bun port has no agent-actor resolution (every /api JWT request resolves
 * to a member, matching Go's resolveActor fallback when no X-Agent-ID header is
 * trusted), so the agent-to-agent allowance is intentionally not ported.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Agent, Member } from "../../db/schema.js";
import { getAgentInWorkspace, getMembership } from "../../db/queries/agents.js";
import { getAutopilotInWorkspace } from "../../db/queries/autopilots.js";
import {
  getAutopilotRun,
  listAgentTasks,
  listAutopilotRuns,
  type AgentTaskRow,
  type AutopilotRunRow,
} from "../../db/queries/agentTaskLists.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve + authorize the workspace for this request, returning the membership
 * row as well (the private-agent gate needs the member's role). Returns a
 * Response to short-circuit with: 400 missing/malformed header, 404
 * not-a-member — mirrors the Go workspace-member gate.
 */
async function requireWorkspaceMember(
  c: Context<AppEnv>,
  db: Db,
): Promise<{ wsId: string; membership: Member } | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return { wsId, membership: m };
}

/**
 * Mirrors Go canAccessPrivateAgent for member actors: public agents are
 * unrestricted; a private agent is visible to its owner and to workspace
 * owner/admin members only.
 */
function canAccessPrivateAgent(agent: Agent, userId: string, role: string): boolean {
  if (agent.visibility !== "private") return true;
  if (agent.ownerId === userId) return true;
  return role === "owner" || role === "admin";
}

/**
 * Mirrors Go shortTaskID / execenv.shortID: first 8 hex chars of the UUID with
 * dashes stripped.
 */
function shortTaskId(uuid: string): string {
  const s = uuid.replaceAll("-", "");
  return s.length > 8 ? s.slice(0, 8) : s;
}

/**
 * Matches the well-known per-user home layouts after backslash normalization
 * (`/Users/<name>[/<rest>]`, `/home/<name>[/<rest>]`,
 * `<drive>:/Users/<name>[/<rest>]`), case-insensitive. Capture group 1 is the
 * optional remainder after the username segment. Mirrors Go homeDirPattern.
 */
const HOME_DIR_RE = /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+(?:\/(.*))?$/i;

/**
 * Privacy-safe display form of the daemon-reported absolute work_dir — port of
 * Go relativeWorkDir (agent.go). The returned string never contains the user's
 * home directory prefix or account name:
 *   - standard tasks: strip everything up to `<wsUUID>/<taskShort>` (the
 *     execenv layout), returning `<wsUUID>/<taskShort>/workdir`;
 *   - local_directory tasks: strip a recognised home prefix, else fall back to
 *     the basename. Empty when work_dir is empty or stripping leaves nothing.
 */
function relativeWorkDir(workDir: string, workspaceId: string, taskId: string): string {
  if (!workDir) return "";
  const normalized = workDir.replaceAll("\\", "/");

  if (workspaceId && taskId) {
    const envRootSuffix = `${workspaceId}/${shortTaskId(taskId)}`;
    const idx = normalized.indexOf(envRootSuffix);
    if (idx >= 0) return normalized.slice(idx);
  }

  const m = HOME_DIR_RE.exec(normalized);
  // A matched home prefix with no remainder means work_dir was exactly the
  // home directory — render nothing rather than the username.
  if (m) return m[1] ?? "";

  const trimmed = normalized.replace(/\/+$/, "");
  if (!trimmed) return "";
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/**
 * Source discriminator for the activity row — port of Go computeTaskKind.
 * Derived from the row's FK shape, no extra lookup needed.
 */
function computeTaskKind(t: AgentTaskRow): string {
  if (t.chatSessionId) return "chat";
  if (t.autopilotRunId) return "autopilot";
  if (!t.issueId) return "quick_create";
  if (t.triggerCommentId) return "comment";
  return "direct";
}

/**
 * Mirrors the Go taskToResponse wire shape (snake_case JSON) for the fields the
 * list path populates. `undefined` values reproduce Go's `omitempty` (the key
 * is dropped from the JSON); explicit nulls match Go's always-present pointer
 * fields. issue_id serializes as "" when NULL (Go uuidToString of a zero UUID).
 */
function taskToResponse(t: AgentTaskRow, workspaceId: string) {
  const workDir = t.workDir ?? "";
  const relWorkDir = relativeWorkDir(workDir, workspaceId, t.id);
  return {
    id: t.id,
    agent_id: t.agentId,
    runtime_id: t.runtimeId,
    issue_id: t.issueId ?? "",
    workspace_id: workspaceId,
    status: t.status,
    priority: t.priority,
    dispatched_at: t.dispatchedAt,
    started_at: t.startedAt,
    completed_at: t.completedAt,
    result: t.result ?? null,
    error: t.error,
    failure_reason: t.failureReason || undefined,
    attempt: t.attempt,
    max_attempts: t.maxAttempts,
    parent_task_id: t.parentTaskId ?? undefined,
    created_at: t.createdAt,
    trigger_comment_id: t.triggerCommentId ?? undefined,
    trigger_summary: t.triggerSummary ?? undefined,
    work_dir: workDir || undefined,
    relative_work_dir: relWorkDir || undefined,
    chat_session_id: t.chatSessionId ?? undefined,
    autopilot_run_id: t.autopilotRunId ?? undefined,
    kind: computeTaskKind(t),
  };
}

/**
 * Mirrors the Go AutopilotRunResponse struct (snake_case JSON). Every field is
 * always present; nullable columns serialize as null (no omitempty in Go).
 */
function runToResponse(r: AutopilotRunRow) {
  return {
    id: r.id,
    autopilot_id: r.autopilotId,
    trigger_id: r.triggerId,
    source: r.source,
    status: r.status,
    issue_id: r.issueId,
    task_id: r.taskId,
    triggered_at: r.triggeredAt,
    completed_at: r.completedAt,
    failure_reason: r.failureReason,
    trigger_payload: r.triggerPayload ?? null,
    result: r.result ?? null,
    created_at: r.createdAt,
  };
}

/**
 * Mirrors Go runToResponseSlim: the list response nulls trigger_payload — a
 * webhook envelope can be up to 256 KiB and the default page is 20 rows, so
 * the full list would be a ~5 MB worst case. The detail endpoint returns it.
 */
function runToResponseSlim(r: AutopilotRunRow) {
  return { ...runToResponse(r), trigger_payload: null };
}

export function agentTaskListsRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/agents/:id/tasks — full task history for one agent, newest first.
  // Run history is part of the private-agent gate; same 403 semantics as Go's
  // GetAgent / ListAgentTasks.
  r.get("/api/agents/:id/tasks", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspaceMember(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    // Agent ids are always UUIDs; 400 on malformed input (Go
    // parseUUIDOrBadRequest inside loadAgentForUser).
    if (!UUID_RE.test(id)) return c.json({ error: "invalid agent id" }, 400);

    const agent = await getAgentInWorkspace(db, ws.wsId, id);
    if (!agent) return c.json({ error: "agent not found" }, 404);

    if (!canAccessPrivateAgent(agent, c.get("user").sub, ws.membership.role)) {
      return c.json({ error: "you do not have access to this agent" }, 403);
    }

    const tasks = await listAgentTasks(db, agent.id);
    return c.json(tasks.map((t) => taskToResponse(t, ws.wsId)));
  });

  // GET /api/autopilots/:id/runs — paginated run list (limit default 20, max
  // 100; offset default 0 — invalid values fall back, mirroring Go's Atoi
  // guards). trigger_payload is omitted from list rows.
  r.get("/api/autopilots/:id/runs", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspaceMember(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid autopilot id" }, 400);
    const autopilot = await getAutopilotInWorkspace(db, ws.wsId, id);
    if (!autopilot) return c.json({ error: "autopilot not found" }, 404);

    let limit = 20;
    const lRaw = c.req.query("limit");
    if (lRaw) {
      const v = Number(lRaw);
      if (Number.isInteger(v) && v > 0) limit = v;
    }
    if (limit > 100) limit = 100;

    let offset = 0;
    const oRaw = c.req.query("offset");
    if (oRaw) {
      const v = Number(oRaw);
      if (Number.isInteger(v) && v >= 0) offset = v;
    }

    const runs = await listAutopilotRuns(db, autopilot.id, limit, offset);
    const resp = runs.map(runToResponseSlim);
    // Matches Go: total is the returned page length, not a global count.
    return c.json({ runs: resp, total: resp.length });
  });

  // GET /api/autopilots/:id/runs/:runId — single run incl. full
  // trigger_payload. The run is re-checked to belong to the URL's autopilot so
  // a guessed runId from another autopilot/workspace 404s (no info leak).
  r.get("/api/autopilots/:id/runs/:runId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspaceMember(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid autopilot id" }, 400);
    const autopilot = await getAutopilotInWorkspace(db, ws.wsId, id);
    if (!autopilot) return c.json({ error: "autopilot not found" }, 404);

    const runId = c.req.param("runId");
    if (!UUID_RE.test(runId)) return c.json({ error: "invalid run id" }, 400);

    const run = await getAutopilotRun(db, runId);
    if (!run || run.autopilotId !== autopilot.id) {
      return c.json({ error: "run not found" }, 404);
    }

    return c.json(runToResponse(run));
  });

  return r;
}

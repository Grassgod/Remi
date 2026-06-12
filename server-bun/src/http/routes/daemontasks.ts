/**
 * Daemon write-path routes — the SERVER side of the daemon HTTP API a remote
 * daemon calls. Port of the Go daemon handler (server/internal/handler/daemon.go),
 * narrowed to the three write endpoints the Bun rewrite needs:
 *
 *   POST /api/runtimes/:id/heartbeat   — mark a runtime alive (last_seen_at/status)
 *   POST /api/daemon/claim             — claim the next queued task for a runtime
 *   POST /api/daemon/tasks/:id/report  — write a task result (completed/failed)
 *
 * The runtime read path (GET /api/runtimes, GET /api/runtimes/:id) lives in
 * routes/runtimes.ts and is NOT duplicated here.
 *
 * Auth gate: behind the /api/* JWT gate, scoped to a workspace via the
 * X-Workspace-ID header + a membership check (multi-tenancy). The Go handler
 * additionally accepts a runtime-bound daemon token (mdt_); the simpler member
 * gate is used here, and the resolved entity's workspace MUST equal the header
 * workspace (defense-in-depth against cross-workspace routing).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import { claimNextTask } from "../../agent/daemon.js";
import {
  completeAgentTask,
  failAgentTask,
  getAgentById,
  getAgentRuntime,
  getAgentTask,
  touchRuntimeHeartbeat,
  type AgentTask,
} from "../../db/queries/daemontasks.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Mirrors the Go AgentTaskResponse struct (snake_case JSON), narrowed to the
 * fields the claim/report paths populate. result defaults to null (matches the
 * Go `any` field when the row's jsonb is NULL).
 */
function taskToResponse(t: AgentTask, workspaceId: string) {
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
    failure_reason: t.failureReason ?? undefined,
    attempt: t.attempt,
    max_attempts: t.maxAttempts,
    created_at: t.createdAt,
    chat_session_id: t.chatSessionId ?? "",
    autopilot_run_id: t.autopilotRunId ?? "",
  };
}

export function daemonTaskRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // POST /api/runtimes/:id/heartbeat — mark the runtime alive. The read path
  // (GET) is owned by routes/runtimes.ts; this route is mounted at the same
  // /api/runtimes base but only declares the heartbeat sub-path.
  r.post("/runtimes/:id/heartbeat", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid runtime id" }, 400);

    const rt = await getAgentRuntime(db, id);
    // Only a genuinely-missing runtime is a 404 — the daemon reads this as a
    // signal to drop the stale runtime locally and re-register.
    if (!rt) return c.json({ error: "runtime not found" }, 404);
    // Defense-in-depth: the runtime must belong to the header workspace.
    if (rt.workspaceId !== ws) return c.json({ error: "runtime not found" }, 404);

    const updated = await touchRuntimeHeartbeat(db, id);
    if (!updated) return c.json({ error: "runtime not found" }, 404);

    return c.json({ status: "ok" });
  });

  // POST /api/daemon/claim — atomically claim the next queued task for a
  // runtime and return it with the agent context the daemon needs to execute.
  // Body: { runtime_id: string }. Returns { task: null } when the queue is empty.
  r.post("/daemon/claim", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const runtimeId = typeof body.runtime_id === "string" ? body.runtime_id : "";
    if (!UUID_RE.test(runtimeId)) return c.json({ error: "runtime_id is required" }, 400);

    // Verify the caller owns this runtime's workspace before claiming.
    const runtime = await getAgentRuntime(db, runtimeId);
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    if (runtime.workspaceId !== ws) return c.json({ error: "runtime not found" }, 404);

    // FOR UPDATE SKIP LOCKED — concurrency-safe across daemons. Sets the row to
    // status='dispatched' (reused from the daemon claim loop).
    const task = await claimNextTask(db, runtimeId);
    if (!task) return c.json({ task: null });

    const resp = taskToResponse(task, runtime.workspaceId);

    // Attach fresh agent context (name + instructions + custom env/args), so
    // the daemon can set up the execution environment. Best-effort: a missing
    // agent row leaves the claim usable without the context section.
    const ag = await getAgentById(db, task.agentId);
    const agentData = ag
      ? {
          id: ag.id,
          name: ag.name,
          instructions: ag.instructions,
          custom_env: ag.customEnv ?? {},
          custom_args: ag.customArgs ?? [],
          mcp_config: ag.mcpConfig ?? undefined,
          model: ag.model ?? undefined,
          thinking_level: ag.thinkingLevel ?? undefined,
        }
      : undefined;

    return c.json({ task: { ...resp, agent: agentData } });
  });

  // POST /api/daemon/tasks/:id/report — write a task result. Body carries a
  // status discriminator: "completed" | "failed". Mirrors the Go Complete/Fail
  // task endpoints, collapsed into one report endpoint.
  r.post("/daemon/tasks/:id/report", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid task id" }, 400);

    // Load + authorize: the task's runtime must live in the header workspace.
    const task = await getAgentTask(db, id);
    if (!task) return c.json({ error: "task not found" }, 404);
    const runtime = await getAgentRuntime(db, task.runtimeId);
    if (!runtime || runtime.workspaceId !== ws) {
      return c.json({ error: "task not found" }, 404);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const status = typeof body.status === "string" ? body.status : "";
    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    const workDir = typeof body.work_dir === "string" ? body.work_dir : undefined;

    if (status === "completed") {
      // result is whatever the daemon reports (pr_url / output / etc.); persist
      // the whole body as the result jsonb (mirrors Go json.Marshal(req)).
      const updated = await completeAgentTask(db, id, body, sessionId, workDir);
      // Idempotent: a task already finalized by a racing report has no matching
      // row — return the current row instead of 404 (mirrors Go's already-
      // finalized success path).
      const final = updated ?? (await getAgentTask(db, id));
      if (!final) return c.json({ error: "task not found" }, 404);
      return c.json(taskToResponse(final, runtime.workspaceId));
    }

    if (status === "failed") {
      const errorMsg = typeof body.error === "string" ? body.error : "";
      const failureReason = typeof body.failure_reason === "string" ? body.failure_reason : undefined;
      const updated = await failAgentTask(db, id, errorMsg, failureReason, sessionId, workDir);
      const final = updated ?? (await getAgentTask(db, id));
      if (!final) return c.json({ error: "task not found" }, 404);
      return c.json(taskToResponse(final, runtime.workspaceId));
    }

    return c.json({ error: "status must be 'completed' or 'failed'" }, 400);
  });

  return r;
}

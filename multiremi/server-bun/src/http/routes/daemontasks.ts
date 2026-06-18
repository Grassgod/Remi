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
import { upsertAgentRuntime } from "../../db/queries/runtimes.js";
import { bus } from "../../realtime/bus.js";
import {
  completeAgentTask,
  failAgentTask,
  getAgentById,
  getAgentRuntime,
  getAgentTask,
  insertTaskMessages,
  pinAgentTaskSession,
  recoverOrphanTasks,
  startAgentTask,
  touchRuntimeHeartbeat,
  upsertTaskUsage,
  type AgentTask,
  type TaskMessageInput,
} from "../../db/queries/daemontasks.js";
import { createChatMessage, touchChatSessionUnread } from "../../db/queries/chat.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_MESSAGE_TYPES = new Set(["text", "thinking", "tool_use", "tool_result", "error"]);

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

/** One runtime the daemon advertises on register. `type` is the ACP provider. */
interface RegisterRuntimeInput {
  name?: string;
  type?: string;
}

async function readJsonBody(c: Context<AppEnv>): Promise<Record<string, unknown> | Response> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid request body" }, 400);
  }
}

async function requireRuntime(
  c: Context<AppEnv>,
  db: Db,
  runtimeId: string,
): Promise<{ ws: string; runtime: Awaited<ReturnType<typeof getAgentRuntime>> } | Response> {
  const ws = await requireWorkspace(c, db);
  if (ws instanceof Response) return ws;
  if (!UUID_RE.test(runtimeId)) return c.json({ error: "invalid runtime id" }, 400);
  const runtime = await getAgentRuntime(db, runtimeId);
  if (!runtime || runtime.workspaceId !== ws) return c.json({ error: "runtime not found" }, 404);
  return { ws, runtime };
}

async function requireTask(
  c: Context<AppEnv>,
  db: Db,
  taskId: string,
): Promise<{ ws: string; task: AgentTask; runtime: NonNullable<Awaited<ReturnType<typeof getAgentRuntime>>> } | Response> {
  const ws = await requireWorkspace(c, db);
  if (ws instanceof Response) return ws;
  if (!UUID_RE.test(taskId)) return c.json({ error: "invalid task id" }, 400);
  const task = await getAgentTask(db, taskId);
  if (!task) return c.json({ error: "task not found" }, 404);
  const runtime = await getAgentRuntime(db, task.runtimeId);
  if (!runtime || runtime.workspaceId !== ws) return c.json({ error: "task not found" }, 404);
  return { ws, task, runtime };
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function taskLifecyclePayload(task: AgentTask) {
  return {
    task_id: task.id,
    agent_id: task.agentId,
    issue_id: task.issueId ?? "",
    chat_session_id: task.chatSessionId ?? undefined,
    status: task.status,
  };
}

function taskDispatchPayload(task: AgentTask) {
  return {
    task_id: task.id,
    agent_id: task.agentId,
    issue_id: task.issueId ?? "",
    runtime_id: task.runtimeId,
    chat_session_id: task.chatSessionId ?? undefined,
  };
}

export function daemonTaskRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // POST /api/daemon/register — a remote daemon announces itself + its agent
  // providers and gets back the runtime rows it should drive. Upserts on the
  // natural key (workspace_id, daemon_id, provider) so a restart reuses rows.
  // Emits daemon:register {runtime_id} so the "Add Computer" dialog advances.
  r.post("/daemon/register", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const body = await readJsonBody(c);
    if (body instanceof Response) return body;

    const daemonId = typeof body.daemon_id === "string" ? body.daemon_id.trim() : "";
    if (!daemonId) return c.json({ error: "daemon_id is required" }, 400);
    const deviceName = typeof body.device_name === "string" ? body.device_name.trim() : "";
    const cliVersion = typeof body.cli_version === "string" ? body.cli_version : "";
    const launchedBy = typeof body.launched_by === "string" ? body.launched_by : "remi";

    const entries = Array.isArray(body.runtimes) ? (body.runtimes as RegisterRuntimeInput[]) : [];
    const providers = entries
      .map((e) => ({ provider: (e?.type ?? "").trim(), name: (e?.name ?? "").trim() }))
      .filter((e) => e.provider.length > 0);
    if (providers.length === 0) {
      return c.json({ error: "at least one runtime with a provider is required" }, 400);
    }

    const ownerId = c.get("user").sub;
    const metadata = { cli_version: cliVersion, daemon: "remi", launched_by: launchedBy };

    const registered = [];
    for (const p of providers) {
      const name = p.name || (deviceName ? `${p.provider} (${deviceName})` : p.provider);
      const rt = await upsertAgentRuntime(db, {
        workspaceId: ws,
        daemonId,
        provider: p.provider,
        name,
        deviceInfo: deviceName,
        metadata,
        ownerId,
      });
      registered.push(rt);
      bus.publish({ type: "daemon:register", workspaceId: ws, payload: { runtime_id: rt.id } });
    }

    return c.json({
      runtimes: registered.map((rt) => ({
        id: rt.id,
        provider: rt.provider,
        name: rt.name,
        status: rt.status,
      })),
    });
  });

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

    const body = await readJsonBody(c);
    if (body instanceof Response) return body;
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
    bus.publish({ type: "task:dispatch", workspaceId: ws, payload: taskDispatchPayload(task) });

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

  r.post("/daemon/runtimes/:runtimeId/tasks/claim", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireRuntime(c, db, c.req.param("runtimeId"));
    if (gate instanceof Response) return gate;
    const task = await claimNextTask(db, gate.runtime!.id);
    if (!task) return c.json({ task: null });
    const resp = taskToResponse(task, gate.runtime!.workspaceId);
    bus.publish({ type: "task:dispatch", workspaceId: gate.ws, payload: taskDispatchPayload(task) });
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

  r.post("/daemon/runtimes/:runtimeId/recover-orphans", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireRuntime(c, db, c.req.param("runtimeId"));
    if (gate instanceof Response) return gate;
    const recovered = await recoverOrphanTasks(db, gate.runtime!.id);
    return c.json({ recovered });
  });

  r.post("/daemon/tasks/:id/start", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireTask(c, db, c.req.param("id"));
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(c);
    if (body instanceof Response) return body;
    const updated = await startAgentTask(db, gate.task.id, stringField(body, "session_id"), stringField(body, "work_dir"));
    const task = updated ?? (await getAgentTask(db, gate.task.id));
    if (!task) return c.json({ error: "task not found" }, 404);
    bus.publish({ type: "task:running", workspaceId: gate.ws, payload: taskLifecyclePayload(task) });
    return c.json(taskToResponse(task, gate.ws));
  });

  r.post("/daemon/tasks/:id/progress", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireTask(c, db, c.req.param("id"));
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(c);
    if (body instanceof Response) return body;
    bus.publish({
      type: "task:progress",
      workspaceId: gate.ws,
      payload: {
        task_id: gate.task.id,
        message: stringField(body, "message") ?? "",
        current: numberField(body, "current"),
        total: numberField(body, "total"),
      },
    });
    return c.json({ status: "ok" });
  });

  r.post("/daemon/tasks/:id/messages", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireTask(c, db, c.req.param("id"));
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(c);
    if (body instanceof Response) return body;
    const input = Array.isArray(body.messages) ? body.messages : [];
    const rows: TaskMessageInput[] = [];
    for (const raw of input) {
      if (!raw || typeof raw !== "object") continue;
      const msg = raw as Record<string, unknown>;
      const type = typeof msg.type === "string" && TASK_MESSAGE_TYPES.has(msg.type) ? msg.type : "";
      const seq = numberField(msg, "seq");
      if (!type || !seq || seq < 1) continue;
      const tool = stringField(msg, "tool");
      const content = typeof msg.content === "string" && msg.content.trim() ? msg.content : undefined;
      const output = typeof msg.output === "string" && msg.output.trim() ? msg.output : undefined;
      const value = { seq, type, tool, content, input: msg.input, output };
      if (!value.content && !value.tool && value.input === undefined && !value.output) continue;
      rows.push(value);
    }
    const persisted = await insertTaskMessages(db, gate.task.id, rows);
    for (const m of persisted) {
      bus.publish({
        type: "task:message",
        workspaceId: gate.ws,
        payload: {
          task_id: m.taskId,
          issue_id: gate.task.issueId ?? "",
          chat_session_id: gate.task.chatSessionId ?? undefined,
          seq: m.seq,
          type: m.type,
          tool: m.tool ?? undefined,
          content: m.content ?? undefined,
          input: m.input ?? undefined,
          output: m.output ?? undefined,
        },
      });
    }
    return c.json({ status: "ok", persisted: persisted.length });
  });

  r.post("/daemon/tasks/:id/session", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireTask(c, db, c.req.param("id"));
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(c);
    if (body instanceof Response) return body;
    const updated = await pinAgentTaskSession(db, gate.task.id, stringField(body, "session_id"), stringField(body, "work_dir"));
    const task = updated ?? (await getAgentTask(db, gate.task.id));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json(taskToResponse(task, gate.ws));
  });

  r.post("/daemon/tasks/:id/usage", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireTask(c, db, c.req.param("id"));
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(c);
    if (body instanceof Response) return body;
    const rows = Array.isArray(body.usage)
      ? body.usage
          .map((raw) => (raw && typeof raw === "object" ? raw as Record<string, unknown> : null))
          .filter((raw): raw is Record<string, unknown> => raw != null)
          .map((raw) => ({
            provider: stringField(raw, "provider") ?? gate.runtime.provider,
            model: stringField(raw, "model") ?? "unknown",
            inputTokens: numberField(raw, "inputTokens") ?? numberField(raw, "input_tokens"),
            outputTokens: numberField(raw, "outputTokens") ?? numberField(raw, "output_tokens"),
            cacheReadTokens: numberField(raw, "cacheReadTokens") ?? numberField(raw, "cache_read_tokens"),
            cacheWriteTokens: numberField(raw, "cacheWriteTokens") ?? numberField(raw, "cache_write_tokens"),
          }))
      : [];
    await upsertTaskUsage(db, gate.task.id, rows);
    return c.json({ status: "ok", count: rows.length });
  });

  r.post("/daemon/tasks/:id/complete", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireTask(c, db, c.req.param("id"));
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(c);
    if (body instanceof Response) return body;
    const sessionId = stringField(body, "session_id");
    const workDir = stringField(body, "work_dir");
    const updated = await completeAgentTask(db, gate.task.id, body, sessionId, workDir);
    const final = updated ?? (await getAgentTask(db, gate.task.id));
    if (!final) return c.json({ error: "task not found" }, 404);
    const finalText = stringField(body, "text") ?? stringField(body, "output");
    if (final.chatSessionId) {
      const payload: Record<string, unknown> = { chat_session_id: final.chatSessionId, task_id: final.id };
      if (finalText) {
        const m = await createChatMessage(db, {
          chatSessionId: final.chatSessionId,
          role: "assistant",
          content: finalText,
          taskId: final.id,
        });
        await touchChatSessionUnread(db, final.chatSessionId);
        payload.message_id = m.id;
        payload.content = m.content;
        payload.created_at = m.createdAt;
      }
      bus.publish({ type: "chat:done", workspaceId: gate.ws, payload });
    }
    bus.publish({ type: "task:completed", workspaceId: gate.ws, payload: taskLifecyclePayload(final) });
    return c.json(taskToResponse(final, gate.ws));
  });

  r.post("/daemon/tasks/:id/fail", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireTask(c, db, c.req.param("id"));
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(c);
    if (body instanceof Response) return body;
    const errorMsg = stringField(body, "error") ?? "";
    const failureReason = stringField(body, "failure_reason");
    const updated = await failAgentTask(db, gate.task.id, errorMsg, failureReason, stringField(body, "session_id"), stringField(body, "work_dir"));
    const final = updated ?? (await getAgentTask(db, gate.task.id));
    if (!final) return c.json({ error: "task not found" }, 404);
    if (final.chatSessionId) {
      const content = errorMsg ? `Task failed: ${errorMsg}` : "Task failed.";
      const m = await createChatMessage(db, {
        chatSessionId: final.chatSessionId,
        role: "assistant",
        content,
        taskId: final.id,
      });
      await touchChatSessionUnread(db, final.chatSessionId);
      bus.publish({
        type: "chat:done",
        workspaceId: gate.ws,
        payload: { chat_session_id: final.chatSessionId, task_id: final.id, message_id: m.id, content: m.content, created_at: m.createdAt },
      });
    }
    bus.publish({ type: "task:failed", workspaceId: gate.ws, payload: taskLifecyclePayload(final) });
    return c.json(taskToResponse(final, gate.ws));
  });

  r.get("/daemon/tasks/:id/status", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireTask(c, db, c.req.param("id"));
    if (gate instanceof Response) return gate;
    const latest = await getAgentTask(db, gate.task.id);
    if (!latest) return c.json({ error: "task not found" }, 404);
    return c.json({ status: latest.status });
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

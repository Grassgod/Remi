import type { Hono } from "hono";
import {
  canCurrentUserAccessAgent,
  canUserViewTaskMessages,
  denyCurrentUserWorkspaceAccess,
  denyTaskTokenTaskAccess,
  loadChatSessionForCurrentUser,
  parseOptionalTaskMessageSince,
  readJson,
  taskFromParam,
} from "../helpers.js";
import {
  authenticatedRequestUserId,
  cleanString,
  currentTaskAccessToken,
  taskCompatibilityResponse,
  taskPublicResponse,
} from "../wire/index.js";
import type { CreateTaskInput } from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerTaskRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/tasks", (c) => {
    const status = c.req.query("status") as any;
    const taskToken = currentTaskAccessToken(c);
    if (taskToken?.taskId) {
      const task = store.getTask(taskToken.taskId);
      return c.json({ tasks: task && (!status || task.status === status) ? [taskPublicResponse(task)] : [] });
    }
    return c.json({ tasks: store.listTasks(status).map(taskPublicResponse) });
  });
  app.post("/api/multiremi/tasks", async (c) => {
    if (currentTaskAccessToken(c)) {
      return c.json({ error: "task agents must delegate through their current product Session" }, 403);
    }
    const body = await readJson<CreateTaskInput>(c);
    // Gate on the target agent: without this, any member could create a task
    // for another workspace's (private) agent and drive its machine +
    // credentials. The task always runs in the agent's workspace, so that's
    // the workspace whose membership must be checked.
    const agentId = cleanString(body.agentId);
    const agent = agentId ? store.getAgent(agentId) : null;
    if (!agent) return c.json({ error: "agent not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, agent.workspaceId);
    if (denied) return denied;
    if (!canCurrentUserAccessAgent(c, store, agent)) {
      return c.json({ error: "you do not have access to this agent" }, 403);
    }
    // Injecting into another user's chat session (same workspace) would pollute
    // and potentially resume their provider session — gate on the session's
    // creator, the same rule the chat read/send routes enforce.
    const sessionId = cleanString(body.chatSessionId);
    if (sessionId) {
      const loaded = loadChatSessionForCurrentUser(c, store, sessionId);
      if (loaded instanceof Response) return loaded;
    }
    // Execution snapshots are minted only by the server's claim/retry path.
    // Never trust these internal fields from a dashboard or PAT request: a
    // forged empty/ready snapshot would bypass the Agent's real Plugin gate.
    const {
      provider: _provider,
      pluginSnapshot: _pluginSnapshot,
      plugin_snapshot: _pluginSnapshotSnake,
      executionFingerprint: _executionFingerprint,
      execution_fingerprint: _executionFingerprintSnake,
      issueSessionGeneration: _issueSessionGeneration,
      issue_session_generation: _issueSessionGenerationSnake,
      delegationId: _delegationId,
      delegation_id: _delegationIdSnake,
      delegatedByAgentId: _delegatedByAgentId,
      delegated_by_agent_id: _delegatedByAgentIdSnake,
      assignmentSourceEventId: _assignmentSourceEventId,
      assignment_source_event_id: _assignmentSourceEventIdSnake,
      ...publicInput
    } = body;
    return c.json({ task: taskPublicResponse(store.createTask(publicInput)) }, 201);
  });
  app.get("/api/multiremi/tasks/:id", (c) => {
    const task = store.getTaskWithAgent(c.req.param("id"));
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyTaskTokenTaskAccess(c, task);
    if (taskDenied) return taskDenied;
    return c.json({ task: taskPublicResponse(task) });
  });
  app.post("/api/multiremi/tasks/:id/cancel", (c) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyTaskTokenTaskAccess(c, task);
    if (taskDenied) return taskDenied;
    return c.json({ task: taskPublicResponse(store.cancelTask(task.id)) });
  });
  app.post("/api/tasks/:id/cancel", (c) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyTaskTokenTaskAccess(c, task);
    if (taskDenied) return taskDenied;
    return c.json(taskCompatibilityResponse(store.cancelTask(task.id)));
  });
  // Mid-run steering: record a directive the daemon injects into the live
  // provider session. Unlike cancel, the run keeps going (and still ends
  // `completed`); `force_answer` asks the agent to wrap up with its best
  // conclusion now.
  const steerTaskRoute = async (c: any) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyTaskTokenTaskAccess(c, task);
    if (taskDenied) return taskDenied;
    const body = await readJson<{ content?: string; kind?: string; force_answer?: boolean; forceAnswer?: boolean }>(c);
    const forceAnswer = body?.kind === "force_answer" || body?.force_answer === true || body?.forceAnswer === true;
    const content = cleanString(body?.content)
      ?? (forceAnswer ? "Please stop exploring and deliver your best conclusion based on the work so far." : null);
    if (!content) return c.json({ error: "content is required" }, 400);
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      return c.json({ error: `task is already ${task.status}: steer messages can only target a live task` }, 409);
    }
    const message = store.createTaskSteerMessage({
      taskId: task.id,
      kind: forceAnswer ? "force_answer" : "steer",
      content,
      authorType: currentTaskAccessToken(c) ? "agent" : "user",
      authorId: authenticatedRequestUserId(c) ?? null,
    });
    return c.json({ message }, 201);
  };
  const listTaskSteerRoute = (c: any) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyTaskTokenTaskAccess(c, task);
    if (taskDenied) return taskDenied;
    return c.json({ messages: store.listTaskSteerMessages(task.id) });
  };
  app.post("/api/multiremi/tasks/:id/steer", steerTaskRoute);
  app.post("/api/tasks/:id/steer", steerTaskRoute);
  app.get("/api/multiremi/tasks/:id/steer", listTaskSteerRoute);
  app.get("/api/tasks/:id/steer", listTaskSteerRoute);
  app.get("/api/multiremi/tasks/:id/messages", (c) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyTaskTokenTaskAccess(c, task);
    if (taskDenied) return taskDenied;
    if (!canUserViewTaskMessages(store, authenticatedRequestUserId(c), task)) {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json({ messages: store.listTaskMessages(task.id) });
  });
  const listTaskHumanRequestsRoute = (c: any) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyTaskTokenTaskAccess(c, task);
    if (taskDenied) return taskDenied;
    if (!canUserViewTaskMessages(store, authenticatedRequestUserId(c), task)) {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json({ requests: store.listTaskHumanRequests(task.id) });
  };
  const respondTaskHumanRequestRoute = async (c: any) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyTaskTokenTaskAccess(c, task);
    if (taskDenied) return taskDenied;
    if (!canUserViewTaskMessages(store, authenticatedRequestUserId(c), task)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const requestId = c.req.param("requestId");
    const request = store.getTaskHumanRequest(requestId);
    if (!request || request.taskId !== task.id) return c.json({ error: "request not found" }, 404);
    const body = await readJson<{ response?: Record<string, unknown> }>(c);
    const responded = store.respondTaskHumanRequest(request.id, {
      response: body?.response ?? {},
      respondedBy: authenticatedRequestUserId(c) ?? store.getCurrentUser()?.id ?? null,
    });
    if (!responded) {
      return c.json({ error: "request already resolved", request: store.getTaskHumanRequest(request.id) }, 409);
    }
    return c.json({ request: responded });
  };
  app.get("/api/multiremi/tasks/:id/human-requests", listTaskHumanRequestsRoute);
  app.get("/api/tasks/:id/human-requests", listTaskHumanRequestsRoute);
  app.post("/api/multiremi/tasks/:id/human-requests/:requestId/respond", respondTaskHumanRequestRoute);
  app.post("/api/tasks/:id/human-requests/:requestId/respond", respondTaskHumanRequestRoute);
  app.get("/api/tasks/:taskId/messages", (c) => {
    const task = taskFromParam(store, c, "taskId");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyTaskTokenTaskAccess(c, task);
    if (taskDenied) return taskDenied;
    if (!canUserViewTaskMessages(store, authenticatedRequestUserId(c), task)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const since = parseOptionalTaskMessageSince(c.req.query("since_seq") ?? c.req.query("sinceSeq") ?? c.req.query("since"));
    if (typeof since === "object" && since && "error" in since) return c.json({ error: since.error }, 400);
    return c.json(store.listTaskMessages(task.id, since));
  });
  app.get("/api/tasks/:taskId/prompt", (c) => {
    const task = taskFromParam(store, c, "taskId");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyTaskTokenTaskAccess(c, task);
    if (taskDenied) return taskDenied;
    if (!canUserViewTaskMessages(store, authenticatedRequestUserId(c), task)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const artifact = store.getTaskPrompt(task.id);
    if (!artifact) return c.json({ error: "prompt not recorded" }, 404);
    return c.json({
      task_id: artifact.taskId,
      mode: artifact.mode,
      prompt: artifact.prompt,
      sha256: artifact.sha256,
      assembled_at: artifact.assembledAt,
    });
  });
}

import type { Context, Hono } from "hono";
import { assertRuntimeWorkspaceAccess } from "../helpers/runtime-workspaces.js";
import {
  canCurrentUserAccessAgent,
  canCurrentUserAccessChatTask,
  canUserViewTaskMessages,
  currentTaskParentId,
  denyCurrentUserWorkspaceAccess,
  loadChatSessionForCurrentUser,
  organizerTaskInspection,
  parseOptionalTaskMessageSince,
  readJson,
  taskFromParam,
  supervisorTaskIdentity,
} from "../helpers.js";
import {
  authenticatedRequestUserId,
  cleanString,
  currentTaskAccessToken,
  taskCompatibilityResponse,
  taskPublicResponse,
} from "../wire/index.js";
import type { CreateTaskInput } from "@multiremi/contracts/types.js";
import { createId } from "@multiremi/ids.js";
import { ChatIssueTaskConflictError, TaskSteerConflictError } from "@multiremi/store/repos/tasks-repo.js";
import { OrganizerActionError } from "../../organizer/settings.js";
import type { RouterDeps } from "./deps.js";

export function registerTaskRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;
  const denySideSessionDispatch = (c: Context): Response | null => {
    const sourceTaskId = currentTaskAccessToken(c)?.taskId;
    const sourceTask = sourceTaskId ? store.getTask(sourceTaskId) : null;
    const sourceSession = sourceTask?.issueSessionId ? store.getIssueSession(sourceTask.issueSessionId) : null;
    // The source credential governs both ordinary dispatch and supervisor
    // redispatch, regardless of the caller-selected target or delegation fields.
    return sourceSession && sourceSession.inheritMode !== "none"
      ? c.json({ error: "Agent delegation is not allowed from side sessions" }, 403)
      : null;
  };

  app.get("/api/multiremi/tasks", (c) => {
    const status = c.req.query("status") as any;
    const taskToken = currentTaskAccessToken(c);
    const workspaceAccess = new Map<string, boolean>();
    const tasks = store.listTasks(status).filter((task) => {
      let allowed = taskToken
        ? taskToken.workspaceId == null || task.workspaceId === taskToken.workspaceId
        : workspaceAccess.get(task.workspaceId);
      if (allowed === undefined) {
        allowed = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId) == null;
        workspaceAccess.set(task.workspaceId, allowed);
      }
      return allowed && canCurrentUserAccessChatTask(c, store, task);
    });
    return c.json({ tasks: tasks.map(taskPublicResponse) });
  });
  app.post("/api/multiremi/tasks", async (c) => {
    const sideDenied = denySideSessionDispatch(c);
    if (sideDenied) return sideDenied;
    const body = await readJson<CreateTaskInput>(c);
    const continueTaskId = cleanString(body.continueTaskId ?? body.continue_task_id);
    const taskToken = currentTaskAccessToken(c);
    const sourceTask = taskToken?.taskId ? store.getTaskWithAgent(taskToken.taskId) : null;
    const continuedTask = continueTaskId ? store.getTask(continueTaskId) : null;
    if (continueTaskId && (!taskToken || !sourceTask)) {
      return c.json({ error: "continuing a delegation requires a task credential" }, 403);
    }
    if (continueTaskId && !continuedTask) {
      return c.json({ error: `continued task not found: ${continueTaskId}` }, 404);
    }
    if (continuedTask && continuedTask.workspaceId !== taskToken!.workspaceId) {
      return c.json({ error: "continued task belongs to another workspace" }, 403);
    }
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
      codexProfile: _codexProfile,
      claudeProfile: _claudeProfile,
      pluginSnapshot: _pluginSnapshot,
      plugin_snapshot: _pluginSnapshotSnake,
      executionFingerprint: _executionFingerprint,
      execution_fingerprint: _executionFingerprintSnake,
      issueSessionGeneration: _issueSessionGeneration,
      issue_session_generation: _issueSessionGenerationSnake,
      holdsWorkspace: _holdsWorkspace,
      holds_workspace: _holdsWorkspaceSnake,
      parentTaskId: _parentTaskId,
      parent_task_id: _parentTaskIdSnake,
      continuedFromTaskId: _continuedFromTaskId,
      continued_from_task_id: _continuedFromTaskIdSnake,
      issueCreationRestricted: _issueCreationRestricted,
      issue_creation_restricted: _issueCreationRestrictedSnake,
      delegationId: _delegationId,
      delegation_id: _delegationIdSnake,
      delegatedByAgentId: _delegatedByAgentId,
      delegated_by_agent_id: _delegatedByAgentIdSnake,
      continueTaskId: _continueTaskId,
      continue_task_id: _continueTaskIdSnake,
      assignmentSourceEventId: _assignmentSourceEventId,
      assignment_source_event_id: _assignmentSourceEventIdSnake,
      ...publicInput
    } = body;
    const issueId = cleanString(publicInput.issueId);
    const issue = issueId ? store.getIssue(issueId) : null;
    const requestedIssueSessionId = cleanString(publicInput.issueSessionId ?? publicInput.issue_session_id);
    const inheritedIssueSessionId = requestedIssueSessionId ?? sourceTask?.issueSessionId ?? null;
    if (continuedTask) {
      if (!continuedTask.delegationId || !continuedTask.delegatedByAgentId
        || continuedTask.agentId === continuedTask.delegatedByAgentId) {
        return c.json({ error: "continued task is not a delegated task" }, 400);
      }
      if (agent.id !== continuedTask.agentId) {
        return c.json({ error: "target agent does not match the continued task" }, 400);
      }
      if (continuedTask.delegatedByAgentId !== taskToken!.agentId) {
        return c.json({ error: "continued task was delegated by another agent" }, 403);
      }
      if (!continuedTask.issueId || !continuedTask.issueSessionId) {
        return c.json({ error: "continued task does not belong to an Issue Session" }, 400);
      }
      if (sourceTask!.issueSessionId !== continuedTask.issueSessionId) {
        return c.json({ error: "continued task belongs to another Issue Session" }, 400);
      }
      if (issueId && issueId !== continuedTask.issueId) {
        return c.json({ error: "requested issue does not match the continued task" }, 400);
      }
      if (requestedIssueSessionId && requestedIssueSessionId !== continuedTask.issueSessionId) {
        return c.json({ error: "requested Issue Session does not match the continued task" }, 400);
      }
    }
    const leaderDelegation = Boolean(
      !continuedTask
      && taskToken
      && sourceTask
      && issue
      && store.isSquadLeaderDelegation({
        issue,
        sourceTask,
        authorAgentId: taskToken.agentId,
        targetAgentId: agent.id,
        issueSessionId: inheritedIssueSessionId,
      })
    );
    // Keep continuation ancestry on the current Leader turn. A same-agent,
    // same-delegation successor of the previous child is reserved for retry /
    // self-continuation and intentionally suppresses that child's return in
    // drainDelegationReturnsWithinWorkspaceLock. This is a new requested round,
    // so every completed child Task must remain independently returnable.
    const createInput: CreateTaskInput = {
      ...publicInput,
      parentTaskId: currentTaskParentId(c),
      ...(continuedTask
        ? {
          issueId: continuedTask.issueId,
          issueSessionId: continuedTask.issueSessionId,
          continuedFromTaskId: continuedTask.id,
          delegationId: continuedTask.delegationId,
          delegatedByAgentId: continuedTask.delegatedByAgentId,
        }
        : leaderDelegation
        ? {
          issueSessionId: inheritedIssueSessionId,
          delegationId: createId("dlg"),
          delegatedByAgentId: sourceTask!.agentId,
        }
        : {}),
    };
    assertRuntimeWorkspaceAccess(c, store, createInput.runtimeWorkspaceId ?? createInput.runtime_workspace_id, agent.workspaceId);
    try {
      const task = store.createTask(createInput);
      return c.json({ task: taskPublicResponse(task) }, 201);
    } catch (error) {
      if (error instanceof ChatIssueTaskConflictError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });
  app.get("/api/multiremi/tasks/:id", (c) => {
    const task = store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    try {
      return c.json({ task: taskPublicResponse(store.getTaskWithAgent(task.id)!) });
    } catch (error) {
      if (!(error instanceof ChatIssueTaskConflictError)) throw error;
      // Owners can still inspect their cancelled/stale task history. Execution
      // eligibility must not turn that read into a 500 or load another Issue.
      return c.json({ task: taskPublicResponse({ ...task,
        issueId: null, issueSessionId: null, issueSessionGeneration: null, sessionId: null,
        agent: store.getAgent(task.agentId), issue: null, project: null,
        projectResources: [], projectDocs: null, projectContexts: [], repos: [],
      }) });
    }
  });
  const cancelTaskRoute = async (c: any, compatibility: boolean) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    const cancelled = store.cancelTask(task.id);
    return compatibility
      ? c.json(taskCompatibilityResponse(cancelled))
      : c.json({ task: taskPublicResponse(cancelled) });
  };
  app.post("/api/multiremi/tasks/:id/cancel", (c) => cancelTaskRoute(c, false));
  app.post("/api/tasks/:id/cancel", (c) => cancelTaskRoute(c, true));
  // Mid-run steering: record a directive the daemon injects into the live
  // provider session. Unlike cancel, the run keeps going (and still ends
  // `completed`); `force_answer` asks the agent to wrap up with its best
  // conclusion now.
  const steerTaskRoute = async (c: any) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    const body = await readJson<{ content?: string; kind?: string; force_answer?: boolean; forceAnswer?: boolean; reason?: string }>(c);
    const forceAnswer = body?.kind === "force_answer" || body?.force_answer === true || body?.forceAnswer === true;
    const content = cleanString(body?.content)
      ?? (forceAnswer ? "Please stop exploring and deliver your best conclusion based on the work so far." : null);
    if (!content) return c.json({ error: "content is required" }, 400);
    // Re-read after body parsing: the task may have finished while the body
    // streamed in, and the pre-parse snapshot would let a doomed insert reach
    // the store. The store's own terminal check backstops the remaining race.
    const current = store.getTask(task.id);
    if (!current || ["completed", "failed", "cancelled"].includes(current.status)) {
      return c.json({ error: `task is already ${current?.status ?? "gone"}: steer messages can only target a live task` }, 409);
    }
    try {
      const message = store.createTaskSteerMessage({
        taskId: task.id,
        kind: forceAnswer ? "force_answer" : "steer",
        content,
        authorType: currentTaskAccessToken(c) ? "agent" : "user",
        authorId: authenticatedRequestUserId(c) ?? null,
      });
      return c.json({ message }, 201);
    } catch (err) {
      if (err instanceof TaskSteerConflictError) return c.json({ error: err.message }, 409);
      throw err;
    }
  };
  const listTaskSteerRoute = (c: any) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    return c.json({ messages: store.listTaskSteerMessages(task.id) });
  };
  app.post("/api/multiremi/tasks/:id/steer", steerTaskRoute);
  app.post("/api/tasks/:id/steer", steerTaskRoute);
  app.get("/api/multiremi/tasks/:id/steer", listTaskSteerRoute);
  app.get("/api/tasks/:id/steer", listTaskSteerRoute);
  const inspectTaskRoute = (c: any) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    return c.json({ inspection: organizerTaskInspection(store, task) });
  };
  app.get("/api/multiremi/tasks/:id/inspection", inspectTaskRoute);
  app.get("/api/tasks/:id/inspection", inspectTaskRoute);
  const redispatchTaskRoute = async (c: any) => {
    const sideDenied = denySideSessionDispatch(c);
    if (sideDenied) return sideDenied;
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    const supervisor = supervisorTaskIdentity(c, store);
    if (!supervisor) {
      return c.json({ error: "supervisor task credential required", code: "organizer_supervisor_required" }, 403);
    }
    const body = await readJson<{ reason?: string }>(c);
    try {
      const result = store.performOrganizerAction({
        supervisorTaskId: supervisor.task.id,
        supervisorAgentId: supervisor.agentId,
        targetTaskId: task.id,
        action: "redispatch",
        reason: cleanString(body.reason) ?? "",
      });
      return c.json({
        cancelled_task: taskPublicResponse(result.task),
        replacement_task: result.replacementTask ? taskPublicResponse(result.replacementTask) : null,
        organizer_action: result.audit,
        comment_id: result.comment.id,
      }, 202);
    } catch (error) {
      if (error instanceof OrganizerActionError) return c.json({ error: error.message, code: error.code }, error.status);
      if (error instanceof Error && error.message.startsWith("Task not found or terminal:")) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  };
  app.post("/api/multiremi/tasks/:id/redispatch", redispatchTaskRoute);
  app.post("/api/tasks/:id/redispatch", redispatchTaskRoute);
  app.get("/api/multiremi/tasks/:id/messages", (c) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    if (!task.chatSessionId && !canUserViewTaskMessages(store, authenticatedRequestUserId(c), task)) {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json({ messages: store.listTaskMessages(task.id) });
  });
  const listTaskHumanRequestsRoute = (c: any) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    if (!task.chatSessionId && !canUserViewTaskMessages(store, authenticatedRequestUserId(c), task)) {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json({ requests: store.listTaskHumanRequests(task.id) });
  };
  const respondTaskHumanRequestRoute = async (c: any) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    if (!task.chatSessionId && !canUserViewTaskMessages(store, authenticatedRequestUserId(c), task)) {
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
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    if (!task.chatSessionId && !canUserViewTaskMessages(store, authenticatedRequestUserId(c), task)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const since = parseOptionalTaskMessageSince(c.req.query("since_seq") ?? c.req.query("sinceSeq") ?? c.req.query("since"));
    if (typeof since === "object" && since && "error" in since) return c.json({ error: since.error }, 400);
    return c.json(store.listTaskMessages(task.id, since));
  });
  app.get("/api/tasks/:taskId/prompt", (c) => {
    const task = taskFromParam(store, c, "taskId");
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    if (!task.chatSessionId && !canUserViewTaskMessages(store, authenticatedRequestUserId(c), task)) {
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

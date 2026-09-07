// The bridge between routers and MultiremiStore. Two shapes live here:
//   `safe*` — call a store mutation and translate its throw into a `{ error, status }` object, so
//             routers never have to reason about store exception text; and
//   `publish*` / `record*` — perform a store write and fan the resulting event out to realtime
//             subscribers and the analytics recorders in one place.
import type { Context } from "hono";
import { MultiremiStore } from "@multiremi/store/store.js";
import {
  agentBroadcastCompatibilityResponse,
  cleanString,
  currentRequestUserId,
  hasRequestField,
  issueCompatibilityResponse,
  projectCompatibilityResponse,
  projectDocCompatibilityResponse,
  projectResourceCompatibilityResponse,
  skillSummaryCompatibilityResponse,
} from "../wire/index.js";
import type {
  CreateFeedbackInput,
  CreateRuntimeUpdateInput,
  MultiremiAgent,
  MultiremiIssue,
  MultiremiProject,
  MultiremiProjectDoc,
  MultiremiProjectResource,
  MultiremiRuntime,
  MultiremiSkill,
  MultiremiTask,
  QuickCreateIssueInput,
  UpdateIssueInput,
  UpdateWorkspaceMemberInput,
} from "@multiremi/contracts/types.js";
import { agentAnalyticsProvider, isFirstAgentInWorkspace } from "./agents.js";
import { MultiremiApiError, log } from "./common.js";

export function publishIssueCreated(
  c: Context,
  store: MultiremiStore,
  issue: MultiremiIssue,
  response: Record<string, unknown> = issueCompatibilityResponse(issue),
): void {
  publishWorkspaceEvent(c, store, "issue:created", issue.workspaceId, { issue: response });
}

// go-compat (maybeEnqueueOnAssign): changing an issue's assignee, or moving an
// assigned issue out of backlog, dispatches a task — the update-path twin of
// the assign-on-create block in POST /api/issues. Done/cancelled targets are
// excluded so bulk-closing backlog items doesn't wake agents. If no runnable
// agent is available the assignment stands without a task, matching the Go
// server's "not ready → skip" behavior.
export function maybeDispatchOnIssueUpdate(
  store: MultiremiStore,
  previous: MultiremiIssue,
  issue: MultiremiIssue,
  input: UpdateIssueInput,
): MultiremiIssue {
  if (!issue.assigneeType || !issue.assigneeId) return issue;
  if (issue.status === "backlog" || issue.status === "done" || issue.status === "cancelled") return issue;
  const assigneeChanged = hasRequestField(input, "assigneeType", "assignee_type", "assigneeId", "assignee_id") &&
    (previous.assigneeType !== issue.assigneeType || previous.assigneeId !== issue.assigneeId);
  const leftBacklog = hasRequestField(input, "status") && previous.status === "backlog";
  if (!assigneeChanged && !leftBacklog) return issue;
  try {
    return store.assignIssue(issue.id, {
      assigneeType: issue.assigneeType,
      assigneeId: issue.assigneeId,
      parentTaskId: input.parentTaskId ?? input.parent_task_id ?? null,
    }).issue;
  } catch (err) {
    log.warn(`assign-on-update dispatch skipped for ${issue.id}: ${err instanceof Error ? err.message : String(err)}`);
    return issue;
  }
}

export function publishIssueUpdated(
  c: Context,
  store: MultiremiStore,
  previous: MultiremiIssue,
  issue: MultiremiIssue,
  input: UpdateIssueInput,
  response: Record<string, unknown> = issueCompatibilityResponse(issue),
): void {
  const assigneeChanged = hasRequestField(input, "assigneeType", "assignee_type", "assigneeId", "assignee_id") &&
    (previous.assigneeType !== issue.assigneeType || previous.assigneeId !== issue.assigneeId);
  const statusChanged = hasRequestField(input, "status") && previous.status !== issue.status;
  const priorityChanged = hasRequestField(input, "priority") && previous.priority !== issue.priority;
  const startDateChanged = previous.startDate !== issue.startDate;
  const dueDateChanged = previous.dueDate !== issue.dueDate;
  const descriptionChanged = hasRequestField(input, "description") && previous.description !== issue.description;
  const titleChanged = hasRequestField(input, "title") && previous.title !== issue.title;
  publishWorkspaceEvent(c, store, "issue:updated", issue.workspaceId, {
    issue: response,
    assignee_changed: assigneeChanged,
    status_changed: statusChanged,
    priority_changed: priorityChanged,
    start_date_changed: startDateChanged,
    due_date_changed: dueDateChanged,
    description_changed: descriptionChanged,
    title_changed: titleChanged,
    prev_title: previous.title,
    prev_assignee_type: previous.assigneeType,
    prev_assignee_id: previous.assigneeId,
    prev_status: previous.status,
    prev_priority: previous.priority,
    prev_start_date: previous.startDate,
    prev_due_date: previous.dueDate,
    prev_description: previous.description,
    creator_type: "member",
    creator_id: previous.createdBy ?? "local",
  });
}

export function publishProjectCreated(
  c: Context,
  store: MultiremiStore,
  project: MultiremiProject,
  response: Record<string, unknown> = projectCompatibilityResponse(project),
): void {
  publishWorkspaceEvent(c, store, "project:created", project.workspaceId, { project: response });
}

export function publishProjectUpdated(
  c: Context,
  store: MultiremiStore,
  project: MultiremiProject,
  response: Record<string, unknown> = projectCompatibilityResponse(project),
): void {
  publishWorkspaceEvent(c, store, "project:updated", project.workspaceId, { project: response });
}

export function publishProjectDeleted(c: Context, store: MultiremiStore, project: MultiremiProject): void {
  publishWorkspaceEvent(c, store, "project:deleted", project.workspaceId, { project_id: project.id });
}

export function publishProjectResourceCreated(
  c: Context,
  store: MultiremiStore,
  resource: MultiremiProjectResource,
  response: Record<string, unknown> = projectResourceCompatibilityResponse(resource),
): void {
  publishWorkspaceEvent(c, store, "project_resource:created", resource.workspaceId, {
    resource: response,
    project_id: resource.projectId,
  });
}

export function publishProjectResourceUpdated(
  c: Context,
  store: MultiremiStore,
  resource: MultiremiProjectResource,
  response: Record<string, unknown> = projectResourceCompatibilityResponse(resource),
): void {
  publishWorkspaceEvent(c, store, "project_resource:updated", resource.workspaceId, {
    resource: response,
    project_id: resource.projectId,
  });
}

export function publishProjectResourceDeleted(
  c: Context,
  store: MultiremiStore,
  resource: MultiremiProjectResource,
): void {
  publishWorkspaceEvent(c, store, "project_resource:deleted", resource.workspaceId, {
    project_id: resource.projectId,
    resource_id: resource.id,
  });
}

export function publishProjectDocCreated(
  c: Context,
  store: MultiremiStore,
  doc: MultiremiProjectDoc,
  response: Record<string, unknown> = projectDocCompatibilityResponse(doc),
): void {
  publishWorkspaceEvent(c, store, "project_doc:created", doc.workspaceId, {
    doc: response,
    project_id: doc.projectId,
  });
}

export function publishProjectDocUpdated(
  c: Context,
  store: MultiremiStore,
  doc: MultiremiProjectDoc,
  response: Record<string, unknown> = projectDocCompatibilityResponse(doc),
): void {
  publishWorkspaceEvent(c, store, "project_doc:updated", doc.workspaceId, {
    doc: response,
    project_id: doc.projectId,
  });
}

export function publishProjectDocDeleted(c: Context, store: MultiremiStore, doc: MultiremiProjectDoc): void {
  publishWorkspaceEvent(c, store, "project_doc:deleted", doc.workspaceId, {
    project_id: doc.projectId,
    doc_id: doc.id,
  });
}

export function publishAgentSkillsEvent(
  c: Context,
  store: MultiremiStore,
  agent: MultiremiAgent,
  skills: MultiremiSkill[],
): void {
  publishWorkspaceEvent(c, store, "agent:status", agent.workspaceId, {
    agent_id: agent.id,
    skills: skills.map(skillSummaryCompatibilityResponse),
  });
}

export function publishAgentLifecycleEvent(
  c: Context,
  store: MultiremiStore,
  type: "agent:created" | "agent:status" | "agent:archived" | "agent:restored",
  agent: MultiremiAgent,
): void {
  publishWorkspaceEvent(c, store, type, agent.workspaceId, {
    agent: agentBroadcastCompatibilityResponse(store, agent),
  });
}

export function recordAgentCreatedAnalytics(
  c: Context,
  store: MultiremiStore,
  agent: MultiremiAgent,
  runtime: MultiremiRuntime | null,
  input: { template?: string | null; isFirstAgentInWorkspace: boolean },
): void {
  store.recordAgentCreated({
    actorId: currentRequestUserId(c),
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    provider: agentAnalyticsProvider(agent, runtime),
    runtimeMode: runtime?.runtimeMode ?? "unknown",
    template: cleanString(input.template ?? null) ?? "",
    isFirstAgentInWorkspace: input.isFirstAgentInWorkspace,
  });
}

export function recordSystemAgentCreatedAnalytics(
  store: MultiremiStore,
  agent: MultiremiAgent,
  runtime: MultiremiRuntime,
  input: { actorId: string; template?: string | null; isFirstAgentInWorkspace: boolean },
): void {
  store.recordAgentCreated({
    actorId: input.actorId,
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    provider: agentAnalyticsProvider(agent, runtime),
    runtimeMode: runtime.runtimeMode,
    template: cleanString(input.template ?? null) ?? "",
    isFirstAgentInWorkspace: input.isFirstAgentInWorkspace,
  });
}

export function withFeedbackRequestMetadata(
  input: CreateFeedbackInput,
  c: { req: { header: (name: string) => string | undefined } },
): CreateFeedbackInput {
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    platform: c.req.header("x-multiremi-platform") ?? c.req.header("x-remi-platform") ?? null,
    version: c.req.header("x-multiremi-version") ?? c.req.header("x-remi-version") ?? null,
    os: c.req.header("x-multiremi-os") ?? c.req.header("x-remi-os") ?? null,
    user_agent: c.req.header("user-agent") ?? null,
  };
  return { ...input, metadata };
}

export function createFeedbackOrApiError(store: MultiremiStore, input: CreateFeedbackInput): ReturnType<MultiremiStore["createFeedback"]> {
  try {
    return store.createFeedback(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "message is required" || message === "message too long" || message === "metadata exceeds the 8KB size limit") {
      throw new MultiremiApiError(message, 400);
    }
    if (message === "too many feedback submissions, please try again later") {
      throw new MultiremiApiError(message, 429);
    }
    throw error;
  }
}

export function safeUpdateCurrentUser(
  store: MultiremiStore,
  input: any,
  userId?: string | null,
): ReturnType<MultiremiStore["updateCurrentUser"]> | { error: string; status: 400 } {
  try {
    return store.updateCurrentUser(input, userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message === "name is required"
      || message === "unsupported language"
      || message === "invalid timezone"
      || message.startsWith("profile_description exceeds")
    ) {
      return { error: message, status: 400 };
    }
    throw error;
  }
}

export function safeCreateWorkspace(
  store: MultiremiStore,
  input: any,
  actingUserId: string | null,
): ReturnType<MultiremiStore["createWorkspace"]> | { error: string; status: 400 | 409 } {
  try {
    return store.createWorkspace({
      name: String(input.name ?? ""),
      slug: input.slug,
      description: input.description ?? null,
      context: input.context ?? null,
      settings: input.settings,
      repos: input.repos,
      issuePrefix: input.issuePrefix ?? input.issue_prefix,
    }, actingUserId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "name and slug are required" || message.startsWith("slug must contain")) {
      return { error: message, status: 400 };
    }
    if (message.includes("UNIQUE constraint failed")) {
      return { error: "workspace slug already exists", status: 409 };
    }
    throw error;
  }
}

export function normalizeGoWorkspaceMemberRole(value: unknown): { role: "owner" | "admin" | "member" } | { error: string } {
  const role = String(value ?? "").trim().toLowerCase();
  if (!role) return { error: "role is required" };
  if (role === "owner" || role === "admin" || role === "member") return { role };
  return { error: "invalid member role" };
}

export function publishWorkspaceEvent(
  c: Context,
  store: MultiremiStore,
  type: string,
  workspaceId: string,
  payload: Record<string, unknown>,
): void {
  store.emitWorkspaceEvent({
    type,
    workspaceId,
    payload,
    actorType: "member",
    actorId: currentRequestUserId(c),
  });
}

export function safeUpdateWorkspaceMember(
  store: MultiremiStore,
  memberId: string,
  input: UpdateWorkspaceMemberInput,
): ReturnType<MultiremiStore["updateWorkspaceMember"]> | { error: string; status: 400 | 404 | 409 } {
  try {
    return store.updateWorkspaceMember(memberId, input);
  } catch (error) {
    return workspaceMemberMutationError(error, "member not found");
  }
}

export function safeArchiveWorkspaceMember(
  store: MultiremiStore,
  memberId: string,
): ReturnType<MultiremiStore["archiveWorkspaceMember"]> | { error: string; status: 400 | 404 | 409 } {
  try {
    return store.archiveWorkspaceMember(memberId);
  } catch (error) {
    return workspaceMemberMutationError(error, "member not found");
  }
}

export function safeLeaveWorkspace(
  store: MultiremiStore,
  workspaceId: string,
  memberId?: string,
): { ok: true } | { error: string; status: 400 | 404 | 409 } {
  try {
    const left = store.leaveWorkspace(workspaceId, memberId);
    if (!left) return { error: "member not found", status: 404 };
    return { ok: true };
  } catch (error) {
    return workspaceMemberMutationError(error, "member not found");
  }
}

export function workspaceMemberMutationError(
  error: unknown,
  missingMessage: string,
): { error: string; status: 400 | 404 | 409 } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Member not found") || message === missingMessage) return { error: missingMessage, status: 404 };
  if (message === "workspace must have at least one owner") return { error: message, status: 400 };
  if (message.startsWith("member owns active daemons:")) return { error: message, status: 409 };
  return { error: message, status: 400 };
}

export function safeCreateInvitation(
  store: MultiremiStore,
  workspaceId: string,
  input: any,
  inviterUserId?: string | null,
): NonNullable<ReturnType<MultiremiStore["createWorkspaceInvitation"]>> | { error: string; status: 400 | 404 | 409 } {
  try {
    return store.createWorkspaceInvitation(workspaceId, input, inviterUserId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Workspace not found")) return { error: "workspace not found", status: 404 };
    if (message === "email is required" || message === "invalid member role" || message === "cannot invite as owner") {
      return { error: message, status: 400 };
    }
    if (message === "user is already a member" || message === "invitation already pending for this email") {
      return { error: message, status: 409 };
    }
    throw error;
  }
}

export function safeAcceptInvitation(
  store: MultiremiStore,
  invitationId: string,
  actingUserId?: string | null,
): NonNullable<ReturnType<MultiremiStore["acceptInvitation"]>> | { error: string; status: 400 | 403 | 404 | 409 | 410 } {
  try {
    const invitation = store.acceptInvitation(invitationId, actingUserId);
    if (!invitation) return { error: "invitation not found", status: 404 };
    return invitation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invitation does not belong to you") return { error: message, status: 403 };
    if (message === "invitation has expired") return { error: message, status: 410 };
    if (message === "you are already a member of this workspace") return { error: message, status: 409 };
    return { error: message, status: 400 };
  }
}

export function safeDeclineInvitation(
  store: MultiremiStore,
  invitationId: string,
  actingUserId?: string | null,
): NonNullable<ReturnType<MultiremiStore["declineInvitation"]>> | { error: string; status: 400 | 403 | 404 } {
  try {
    const invitation = store.declineInvitation(invitationId, actingUserId);
    if (!invitation) return { error: "invitation not found", status: 404 };
    return invitation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invitation does not belong to you") return { error: message, status: 403 };
    return { error: message, status: 400 };
  }
}

export function safeJoinCloudWaitlist(
  body: { email?: string; reason?: string },
  store: MultiremiStore,
  userId?: string | null,
): ReturnType<MultiremiStore["updateCurrentUser"]> | { error: string; status: 400 } {
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) return { error: "email is required", status: 400 };
  if (email.length > 254) return { error: "email is too long", status: 400 };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "email is invalid", status: 400 };
  const reason = String(body.reason ?? "").trim();
  if (reason.length > 1000) return { error: "reason is too long", status: 400 };
  const user = store.getCurrentUser(userId);
  return store.updateCurrentUser({
    onboardingQuestionnaire: {
      ...user.onboardingQuestionnaire,
      cloud_waitlist_email: email,
      cloud_waitlist_reason: reason,
    },
  }, userId);
}

export function safeRuntimeOnboardingBootstrap(
  store: MultiremiStore,
  body: { workspace_id?: string; workspaceId?: string; runtime_id?: string; runtimeId?: string },
  bootstrapUserId: string,
): { workspace_id: string; agent_id: string; issue_id: string } | { error: string; status: 400 | 404 } {
  const workspaceId = body.workspace_id ?? body.workspaceId ?? "";
  const runtimeId = body.runtime_id ?? body.runtimeId ?? "";
  if (!workspaceId) return { error: "workspace_id is required", status: 400 };
  if (!runtimeId) return { error: "runtime_id is required", status: 400 };
  const runtime = store.getRuntime(runtimeId);
  // COALESCE(...,'local') so a workspace-less runtime is treated as local,
  // matching how the claim predicate (and the rest of the system) reads it.
  if (!runtime || (runtime.workspaceId ?? "local") !== workspaceId) return { error: "invalid runtime_id", status: 400 };
  const provider = runtime.provider === "claude" || runtime.provider === "codex" ? runtime.provider : "codex";
  const before = store.getDefaultAgent(workspaceId, provider, bootstrapUserId);
  const isFirstAgent = isFirstAgentInWorkspace(store, workspaceId);
  const agent = store.ensureDefaultAgent(provider, {
    workspaceId,
    ownerId: bootstrapUserId,
  });
  if (!before) {
    recordSystemAgentCreatedAnalytics(store, agent, runtime, {
      actorId: bootstrapUserId,
      template: "multiremi_helper",
      isFirstAgentInWorkspace: isFirstAgent,
    });
  }
  const issue = createOnboardingIssue(store, workspaceId, "Connect your local runtime", `Use ${runtime.name} to run your first task.`, bootstrapUserId);
  store.createTask({
    agentId: agent.id,
    issueId: issue.id,
    workspaceId,
    prompt: "Help complete onboarding and verify the local runtime is ready.",
  });
  store.markCurrentUserOnboarded(bootstrapUserId);
  return { workspace_id: workspaceId, agent_id: agent.id, issue_id: issue.id };
}

export function safeNoRuntimeOnboardingBootstrap(
  store: MultiremiStore,
  body: { workspace_id?: string; workspaceId?: string },
  bootstrapUserId: string,
): { workspace_id: string; issue_id: string } | { error: string; status: 400 | 404 } {
  const workspaceId = body.workspace_id ?? body.workspaceId ?? "";
  if (!workspaceId) return { error: "workspace_id is required", status: 400 };
  if (!store.getWorkspace(workspaceId)) return { error: "workspace not found", status: 404 };
  const issue = createOnboardingIssue(
    store,
    workspaceId,
    "Install a local runtime",
    "Install and register a local Claude or Codex runtime to start running tasks.",
    bootstrapUserId,
  );
  store.markCurrentUserOnboarded(bootstrapUserId);
  return { workspace_id: workspaceId, issue_id: issue.id };
}

export function createOnboardingIssue(
  store: MultiremiStore,
  workspaceId: string,
  title: string,
  description: string,
  createdBy = "local",
): ReturnType<MultiremiStore["createIssue"]> {
  const existing = store.listIssues({ workspaceId }).find((issue) => issue.title === title);
  if (existing) return existing;
  return store.createIssue({
    title,
    description,
    workspaceId,
    createdBy,
    priority: "medium",
    contextRefs: [{ type: "onboarding" }],
  });
}

export function safeRerunIssue(
  store: MultiremiStore,
  issueId: string,
  body: { agent_id?: string; agentId?: string; prompt?: string; parentTaskId?: string | null },
): { task: MultiremiTask } | { error: string; status: 400 | 404 } {
  const issue = store.getIssue(issueId);
  if (!issue) return { error: "issue not found", status: 404 };
  const agentId = body.agent_id ?? body.agentId ?? issue.assigneeId;
  if (!agentId) return { error: "issue has no agent assignee", status: 400 };
  const agent = store.getAgent(agentId);
  if (!agent) return { error: "agent not found", status: 404 };
  // The rerun agent must live in the issue's workspace — a caller with issue
  // access can't redirect the run to another workspace's agent (createTask
  // would reject the cross-workspace link, but fail loudly here first).
  if (agent.workspaceId !== issue.workspaceId) return { error: "agent not found", status: 404 };
  const task = store.createTask({
    agentId,
    issueId: issue.id,
    workspaceId: issue.workspaceId,
    prompt: body.prompt ?? issue.title,
    parentTaskId: body.parentTaskId ?? null,
  });
  return { task };
}

export function safeCreateRuntimeUpdateRequest(
  store: MultiremiStore,
  runtimeId: string,
  input: CreateRuntimeUpdateInput,
): ReturnType<MultiremiStore["createRuntimeUpdateRequest"]> | { apiError: string; statusCode: 400 | 404 | 409 | 503 } {
  try {
    return store.createRuntimeUpdateRequest(runtimeId, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "target_version is required") return { apiError: message, statusCode: 400 };
    if (message.startsWith("Runtime not found")) return { apiError: "runtime not found", statusCode: 404 };
    if (message === "runtime is offline") return { apiError: message, statusCode: 503 };
    if (message === "an update is already in progress for this runtime") return { apiError: message, statusCode: 409 };
    throw error;
  }
}

export function safeQuickCreateIssue(store: MultiremiStore, input: QuickCreateIssueInput): ReturnType<MultiremiStore["quickCreateIssue"]> | { error: string } {
  try {
    return store.quickCreateIssue(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message === "prompt is required"
      || message === "exactly one of agent_id or squad_id is required"
      || message.startsWith("No runnable agent")
      || message.startsWith("Project not found")
      || message === "Project belongs to another workspace"
      || message.startsWith("Agent not found")
      || message.startsWith("Squad not found")
      || message.startsWith("Member not found")
    ) {
      return { error: message };
    }
    throw error;
  }
}

// Issue, comment and subscriber request plumbing: list-query parsing, create-input builders that
// fold in the caller, and the cursor headers the comment pagination returns.
import type { Context } from "hono";
import { MultiremiStore } from "@multiremi/store/store.js";
import {
  cleanString,
  currentAccessToken,
  currentRequestUserId,
  currentTaskAccessToken,
  hasRequestField,
  parseOptionalInt,
} from "../wire/index.js";
import type { CompatibilityQueryMode } from "../wire/index.js";
import type {
  CreateIssueCommentInput,
  CreateIssueWithTaskInput,
  CreateMultiremiReactionInput,
  ListIssueCommentsInput,
  ListIssuesInput,
  MultiremiIssue,
  MultiremiAgent,
  MultiremiSubscriptionReason,
} from "@multiremi/contracts/types.js";
import { currentJwtUserId } from "./auth-guards.js";
import { splitQueryList } from "./common.js";
import { parseBooleanQuery, parseIntegerQuery } from "./request.js";

export const SUBSCRIPTION_REASONS: MultiremiSubscriptionReason[] = ["created", "assigned", "commented", "mentioned", "manual"];

export const ISSUE_CREATION_REQUIRES_PROPOSAL_CODE = "issue_creation_requires_proposal";

export function restrictedTaskIssueCreationAgent(c: Context, store: MultiremiStore): MultiremiAgent | null {
  const token = currentTaskAccessToken(c);
  if (!token?.agentId) return null;
  const agent = store.getAgent(token.agentId);
  const task = token.taskId ? store.getTask(token.taskId) : null;
  if (!task?.issueCreationRestricted && !agent?.issueCreationRequiresProposal) return null;
  return agent;
}

export function currentTaskIssueCreationRestricted(c: Context, store: MultiremiStore): boolean {
  const token = currentTaskAccessToken(c);
  if (!token?.agentId) return false;
  return Boolean(
    (token.taskId ? store.getTask(token.taskId)?.issueCreationRestricted : false)
    || store.getAgent(token.agentId)?.issueCreationRequiresProposal,
  );
}

/** Trusted parent lineage for server-created descendants. Request bodies must
 * never supply this value directly. */
export function currentTaskParentId(c: Context): string | null {
  return currentTaskAccessToken(c)?.taskId ?? null;
}

export function denyRestrictedTaskIssueCreation(c: Context, store: MultiremiStore): Response | null {
  if (!restrictedTaskIssueCreationAgent(c, store)) return null;
  return c.json({
    error: "This agent must use `remi feishu messages propose-issue`; a human must approve before an Issue is created.",
    code: ISSUE_CREATION_REQUIRES_PROPOSAL_CODE,
  }, 403);
}

export function issueSubscriberCaller(c: Context): { actorType: "member" | "agent"; actorId: string } {
  const taskToken = currentTaskAccessToken(c);
  if (taskToken?.agentId) return { actorType: "agent", actorId: taskToken.agentId };
  const agentId = cleanString(c.req.header("X-Agent-ID"));
  if (agentId) return { actorType: "agent", actorId: agentId };
  return { actorType: "member", actorId: currentRequestUserId(c) };
}

export function issueCommentCreateInput(
  c: Context,
  input: CreateIssueCommentInput,
  store?: MultiremiStore,
  targetIssueId?: string,
): CreateIssueCommentInput {
  const taskToken = currentTaskAccessToken(c);
  if (taskToken?.agentId) {
    const task = taskToken.taskId && store ? store.getTask(taskToken.taskId) : null;
    return {
      ...input,
      authorType: "agent",
      authorId: taskToken.agentId,
      issueSessionId: task && task.issueId === targetIssueId
        ? task.issueSessionId ?? input.issueSessionId ?? input.issue_session_id ?? null
        : input.issueSessionId ?? input.issue_session_id ?? null,
      // A comment posted under a task token was written by that run — record the
      // linkage so the reply carries its transcript entry (the auto-reply path
      // in tasks-repo already does this; the in-run tool path landed here).
      // The token is authoritative: accepting a body-supplied task id would
      // let one run borrow another task's delegation lineage.
      taskId: taskToken.taskId ?? null,
    };
  }
  if (cleanString(input.authorType) || cleanString(input.authorId)) return input;
  const agentId = cleanString(c.req.header("X-Agent-ID"));
  if (agentId) return { ...input, authorType: "agent", authorId: agentId };
  if (!currentAccessToken(c) && !currentJwtUserId(c)) return input;
  return { ...input, authorType: "member", authorId: currentRequestUserId(c) };
}

export function issueSubscriberTarget(
  c: Context,
  body: { member_id?: string; user_id?: string; user_type?: string },
): { userType: "member" | "agent"; userId: string } | { error: string; status: 403 } {
  const caller = issueSubscriberCaller(c);
  const requestedUserType = cleanString(body.user_type);
  const requestedUserId = cleanString(body.user_id) ??
    cleanString(body.member_id);
  const userType = (requestedUserType ?? (body.member_id ? "member" : caller.actorType)).toLowerCase();
  const userId = requestedUserId ?? (userType === "agent" ? caller.actorId : currentRequestUserId(c));
  if (userType !== "member" && userType !== "agent") {
    return { error: "target user is not a member of this workspace", status: 403 };
  }
  return { userType, userId };
}

export function withIssueCreateRequestContext(
  c: Context,
  input: CreateIssueWithTaskInput,
  store?: MultiremiStore,
): CreateIssueWithTaskInput {
  const workspaceId = cleanString(input.workspace_id) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
  const userId = currentRequestUserId(c);
  const out: CreateIssueWithTaskInput = {
    title: input.title,
    workspace_id: workspaceId,
    created_by: userId,
  };
  if (hasRequestField(input, "description")) out.description = input.description ?? null;
  if (hasRequestField(input, "status")) out.status = input.status;
  if (hasRequestField(input, "priority")) out.priority = input.priority;
  if (hasRequestField(input, "project_id")) out.project_id = input.project_id ?? null;
  if (hasRequestField(input, "parent_issue_id")) out.parent_issue_id = input.parent_issue_id ?? null;
  if (hasRequestField(input, "assignee_type")) out.assignee_type = input.assignee_type ?? null;
  if (hasRequestField(input, "assignee_id")) out.assignee_id = input.assignee_id ?? null;
  if (hasRequestField(input, "position")) out.position = input.position;
  if (hasRequestField(input, "start_date")) out.start_date = input.start_date ?? null;
  if (hasRequestField(input, "due_date")) out.due_date = input.due_date ?? null;
  if (hasRequestField(input, "acceptance_criteria")) out.acceptance_criteria = input.acceptance_criteria ?? [];
  if (hasRequestField(input, "context_refs")) out.context_refs = input.context_refs ?? [];

  const taskToken = currentTaskAccessToken(c);
  const task = taskToken?.taskId && store ? store.getTask(taskToken.taskId) : null;
  const sourceIssue = task?.issueId && store ? store.getIssue(task.issueId) : null;
  const isIntake = sourceIssue?.issueKind === "intake";
  if (sourceIssue) {
    // Any task-run creation (intake or follow-up) stays in the source issue's
    // workspace and project scope; a projectless request inherits the source
    // issue's project instead of dropping to an orphan.
    out.workspace_id = sourceIssue.workspaceId;
    const requestedProjectId = cleanString(input.project_id);
    const inheritedProjectId = sourceIssue.projectId;
    if (isIntake && inheritedProjectId && requestedProjectId && requestedProjectId !== inheritedProjectId) {
      throw new Error("Generated issues must stay in the intake project's scope");
    }
    const projectId = (isIntake ? inheritedProjectId ?? requestedProjectId : requestedProjectId ?? inheritedProjectId) ?? null;
    if (projectId) {
      const project = store!.getProject(projectId);
      if (!project || project.workspaceId !== sourceIssue.workspaceId || project.archivedAt) {
        throw new Error(`Project is not active in this workspace: ${projectId}`);
      }
      out.project_id = projectId;
    } else if (store!.listProjects(sourceIssue.workspaceId).some((project) => !project.archivedAt)) {
      throw new Error("project_id is required when active projects are available");
    }
    if (isIntake) {
      out.status = "todo";
      out.issue_kind = "execution";
      out.source_issue_id = sourceIssue.id;
      out.context_refs = [
        ...(out.context_refs ?? []),
        { type: "generated_from", issueId: sourceIssue.id, taskId: task!.id },
      ];
    }
  }
  applyProjectDefaultAssignee(input, out, store);
  return out;
}

export interface IssueCreateChatBindingResponse {
  chat_issue_binding: {
    status: "bound" | "preserved";
    chat_session_id: string;
    issue_id: string;
    existing_issue_id: string | null;
  };
  chat_issue_binding_hint?: string;
}

export function bindCreatedIssueToRequestChat(
  c: Context,
  store: MultiremiStore,
  issue: MultiremiIssue,
): IssueCreateChatBindingResponse | null {
  const taskId = currentTaskAccessToken(c)?.taskId;
  const sourceTask = taskId ? store.getTask(taskId) : null;
  if (!sourceTask?.chatSessionId) return null;
  const outcome = store.bindChatSessionIssueIfUnbound(sourceTask.chatSessionId, issue.id);
  if (outcome.bound || outcome.session.issueId === issue.id) {
    return {
      chat_issue_binding: {
        status: "bound",
        chat_session_id: outcome.session.id,
        issue_id: issue.id,
        existing_issue_id: null,
      },
    };
  }
  const existingIssue = outcome.session.issueId ? store.getIssue(outcome.session.issueId) : null;
  const existingRef = existingIssue?.key ?? outcome.session.issueId ?? "another Issue";
  return {
    chat_issue_binding: {
      status: "preserved",
      chat_session_id: outcome.session.id,
      issue_id: issue.id,
      existing_issue_id: outcome.session.issueId,
    },
    chat_issue_binding_hint: `Chat ${outcome.session.id} remains bound to ${existingRef}; ${issue.key} was not auto-bound. Use remi chat issue bind ${outcome.session.id} ${issue.key} to switch.`,
  };
}

// A request that carries no assignee fields at all inherits the project's
// default executor — assign-on-create is what dispatches the first task, so
// dropping the default here would strand the issue. Explicitly sending
// assignee_type/assignee_id (even as null) opts out.
function applyProjectDefaultAssignee(
  input: CreateIssueWithTaskInput,
  out: CreateIssueWithTaskInput,
  store?: MultiremiStore,
): void {
  if (!store) return;
  if (hasRequestField(input, "assignee_type") || hasRequestField(input, "assignee_id")) return;
  const projectId = cleanString(out.project_id);
  const project = projectId ? store.getProject(projectId) : null;
  if (!project || project.archivedAt) return;
  if (project.defaultAssigneeType && project.defaultAssigneeId) {
    out.assignee_type = project.defaultAssigneeType;
    out.assignee_id = project.defaultAssigneeId;
  }
}

export function normalizeSubscriptionReason(value: unknown): MultiremiSubscriptionReason {
  const reason = String(value ?? "manual") as MultiremiSubscriptionReason;
  return SUBSCRIPTION_REASONS.includes(reason) ? reason : "manual";
}

export function issueFromParam(
  store: MultiremiStore,
  c: Context,
  param = "id",
  mode: CompatibilityQueryMode = "native",
): MultiremiIssue | null {
  return store.getIssueByRef(
    c.req.param(param) ?? "",
    mode === "compat"
      ? c.req.query("workspace_id") ?? null
      : c.req.query("workspace_id") ?? c.req.query("workspaceId") ?? null,
  );
}

export function issueListQuery(
  store: MultiremiStore,
  c: { req: { query: (name: string) => string | undefined } },
  mode: CompatibilityQueryMode = "native",
): ListIssuesInput {
  const compat = mode === "compat";
  const workspaceId = (compat ? c.req.query("workspace_id") : c.req.query("workspaceId") ?? c.req.query("workspace_id")) ?? "local";
  const assigneeTypes = splitQueryList(compat ? c.req.query("assignee_types") : c.req.query("assigneeTypes") ?? c.req.query("assignee_types")) as ListIssuesInput["assigneeTypes"];
  const assigneeId = resolveAssigneeFilterId(
    store,
    workspaceId,
    (compat ? c.req.query("assignee_id") : c.req.query("assigneeId") ?? c.req.query("assignee_id")) ?? null,
    assigneeTypes,
  );
  return {
    workspaceId,
    statuses: splitQueryList(c.req.query("statuses") ?? c.req.query("status")),
    priorities: splitQueryList(c.req.query("priorities") ?? c.req.query("priority")),
    assigneeTypes,
    assigneeId,
    assigneeIds: splitQueryList(compat ? c.req.query("assignee_ids") : c.req.query("assigneeIds") ?? c.req.query("assignee_ids"))
      .map((ref) => resolveAssigneeFilterId(store, workspaceId, ref, assigneeTypes) ?? ref),
    projectId: (compat ? c.req.query("project_id") : c.req.query("projectId") ?? c.req.query("project_id")) ?? null,
    projectIds: splitQueryList(compat ? c.req.query("project_ids") : c.req.query("projectIds") ?? c.req.query("project_ids")),
    metadata: parseIssueMetadataFilter(c.req.query("metadata")),
    includeNoAssignee: compat
      ? c.req.query("include_no_assignee") === "true"
      : c.req.query("includeNoAssignee") === "true" || c.req.query("include_no_assignee") === "true",
    includeNoProject: compat
      ? c.req.query("include_no_project") === "true"
      : c.req.query("includeNoProject") === "true" || c.req.query("include_no_project") === "true",
    includeArchived: compat
      ? c.req.query("include_archived") === "true"
      : c.req.query("includeArchived") === "true" || c.req.query("include_archived") === "true",
    archivedOnly: compat
      ? c.req.query("archived_only") === "true"
      : c.req.query("archivedOnly") === "true" || c.req.query("archived_only") === "true",
    limit: parseOptionalInt(c.req.query("limit")),
    offset: parseOptionalInt(c.req.query("offset")),
  };
}

export function resolveAssigneeFilterId(
  store: MultiremiStore,
  workspaceId: string | null,
  ref: string | null,
  assigneeTypes: ListIssuesInput["assigneeTypes"] = [],
): string | null {
  const value = ref?.trim();
  if (!value) return null;
  const type = assigneeTypes?.length === 1 ? assigneeTypes[0] ?? null : null;
  try {
    return store.resolveAssigneeRef(type, value, workspaceId)?.assigneeId ?? value;
  } catch {
    return value;
  }
}

export function parseIssueMetadataFilter(value: string | undefined): Record<string, string | number | boolean> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string | number | boolean> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") out[key] = item;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export function parseIssueCommentListQuery(c: { req: { query: (name: string) => string | undefined } }): ListIssueCommentsInput | { error: string; status: 400 } {
  const rootsOnly = parseBooleanQuery(c.req.query("roots_only") ?? c.req.query("roots-only"), "roots_only");
  if (typeof rootsOnly === "object") return rootsOnly;
  const summary = parseBooleanQuery(c.req.query("summary"), "summary");
  if (typeof summary === "object") return summary;
  const recent = parseIntegerQuery(c.req.query("recent"), "recent");
  if (recent && typeof recent === "object") return recent;
  const tail = parseIntegerQuery(c.req.query("tail"), "tail");
  if (tail && typeof tail === "object") return tail;
  return {
    issueSessionId: c.req.query("issue_session_id") ?? c.req.query("issue-session-id") ?? null,
    issue_session_id: c.req.query("issue_session_id") ?? c.req.query("issue-session-id") ?? null,
    since: c.req.query("since") ?? null,
    thread: c.req.query("thread") ?? null,
    recent,
    ...(c.req.query("tail") === undefined ? {} : { tail }),
    rootsOnly,
    roots_only: rootsOnly,
    summary,
    before: c.req.query("before") ?? null,
    beforeId: c.req.query("before_id") ?? c.req.query("before-id") ?? null,
  };
}

export function setIssueCommentCursorHeaders(c: Context, result: { nextBefore?: string | null; nextBeforeId?: string | null }): void {
  if (result.nextBefore && result.nextBeforeId) {
    c.header("X-Multiremi-Next-Before", result.nextBefore);
    c.header("X-Multiremi-Next-Before-Id", result.nextBeforeId);
  }
}

export function assigneeFrequencyQuery(c: { req: { query: (name: string) => string | undefined } }): {
  workspaceId?: string | null;
  actorId?: string | null;
  memberId?: string | null;
  userId?: string | null;
} {
  return {
    workspaceId: c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local",
    actorId: c.req.query("actorId") ?? c.req.query("actor_id") ?? null,
    memberId: c.req.query("memberId") ?? c.req.query("member_id") ?? null,
    userId: c.req.query("userId") ?? c.req.query("user_id") ?? null,
  };
}

export function normalizeReactionInput(input: CreateMultiremiReactionInput): { actorType?: string; actorId?: string | null; emoji: string } {
  return {
    actorType: input.actorType ?? input.actor_type ?? "member",
    actorId: input.actorId ?? input.actor_id ?? "local",
    emoji: input.emoji,
  };
}

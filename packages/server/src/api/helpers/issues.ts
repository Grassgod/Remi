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
  MultiremiSubscriptionReason,
} from "@multiremi/contracts/types.js";
import { currentJwtUserId } from "./auth-guards.js";
import { splitQueryList } from "./common.js";
import { parseBooleanQuery, parseIntegerQuery } from "./request.js";

export const SUBSCRIPTION_REASONS: MultiremiSubscriptionReason[] = ["created", "assigned", "commented", "mentioned", "manual"];

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

export function taskScopedIssueCommentListInput(
  c: Context,
  store: MultiremiStore,
  issueId: string,
  input: ListIssueCommentsInput,
): { input: ListIssueCommentsInput } | { response: Response } {
  const token = currentTaskAccessToken(c);
  if (!token?.taskId) return { input };
  const task = store.getTask(token.taskId);
  if (!task || task.issueId !== issueId) {
    return { response: c.json({ error: "forbidden" }, 403) };
  }
  if (!task.issueSessionId) return { input };
  const requested = cleanString(input.issueSessionId ?? input.issue_session_id);
  if (requested && requested !== task.issueSessionId) {
    return { response: c.json({ error: "forbidden" }, 403) };
  }
  return {
    input: {
      ...input,
      issueSessionId: task.issueSessionId,
      issue_session_id: task.issueSessionId,
    },
  };
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
  const intakeIssue = task?.issueId && store ? store.getIssue(task.issueId) : null;
  if (intakeIssue?.issueKind === "intake") {
    out.workspace_id = intakeIssue.workspaceId;
    const requestedProjectId = cleanString(input.project_id);
    const selectedProjectId = intakeIssue.projectId;
    const projectId = selectedProjectId ?? requestedProjectId ?? null;
    if (selectedProjectId && requestedProjectId && requestedProjectId !== selectedProjectId) {
      throw new Error("Generated issues must stay in the intake project's scope");
    }
    if (projectId) {
      const project = store!.getProject(projectId);
      if (!project || project.workspaceId !== intakeIssue.workspaceId || project.archivedAt) {
        throw new Error(`Project is not active in this workspace: ${projectId}`);
      }
      out.project_id = projectId;
      if (!hasRequestField(input, "assignee_type") && project.defaultAssigneeType && project.defaultAssigneeId) {
        out.assignee_type = project.defaultAssigneeType;
        out.assignee_id = project.defaultAssigneeId;
      }
    } else if (store!.listProjects(intakeIssue.workspaceId).some((project) => !project.archivedAt)) {
      throw new Error("project_id is required when active projects are available");
    }
    out.status = "todo";
    out.issue_kind = "execution";
    out.source_issue_id = intakeIssue.id;
    out.context_refs = [
      ...(out.context_refs ?? []),
      { type: "generated_from", issueId: intakeIssue.id, taskId: task!.id },
    ];
  }
  return out;
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

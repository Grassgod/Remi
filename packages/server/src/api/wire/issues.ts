// Wire serializers for the issues domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import type {
  BatchDeleteIssuesInput,
  BatchUpdateIssuesInput,
  MultiremiCommentReaction,
  MultiremiIssue,
  MultiremiIssueComment,
  MultiremiIssueDependency,
  MultiremiIssueReaction,
  MultiremiIssueSearchResult,
  MultiremiIssueSession,
  MultiremiIssueSubscriber,
  MultiremiSessionEvent,
  MultiremiSessionParticipant,
  MultiremiSessionResult,
  MultiremiTimelineEntry,
  MultiremiTimelinePage,
  QuickCreateIssueInput,
  UpdateIssueInput,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { Context } from "hono";
import { issueDetailAttachmentCompatibilityResponse } from "./attachments.js";
import { cleanString, hasRequestField } from "./context.js";
import { labelCompatibilityResponse } from "./projects.js";

export function issueCompatibilityResponse(
  issue: MultiremiIssue,
  options: { includeLabels?: boolean } = {},
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: issue.id,
    workspace_id: issue.workspaceId,
    number: issue.number,
    identifier: issue.key,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    assignee_type: issue.assigneeType,
    assignee_id: issue.assigneeId,
    creator_type: "member",
    creator_id: issue.createdBy ?? "local",
    parent_issue_id: issue.parentIssueId,
    issue_kind: issue.issueKind,
    source_issue_id: issue.sourceIssueId,
    project_id: issue.projectId,
    position: issue.position,
    start_date: issue.startDate,
    due_date: issue.dueDate,
    completed_at: issue.completedAt,
    archived_at: issue.archivedAt,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    metadata: issue.metadata,
  };
  if (options.includeLabels) response.labels = issue.labels.map(labelCompatibilityResponse);
  return response;
}

export function issueReactionCompatibilityResponse(reaction: MultiremiIssueReaction): Record<string, unknown> {
  return {
    id: reaction.id,
    issue_id: reaction.issueId,
    actor_type: reaction.actorType,
    actor_id: reaction.actorId,
    emoji: reaction.emoji,
    created_at: reaction.createdAt,
  };
}

export function commentReactionCompatibilityResponse(reaction: MultiremiCommentReaction): Record<string, unknown> {
  return {
    id: reaction.id,
    comment_id: reaction.commentId,
    actor_type: reaction.actorType,
    actor_id: reaction.actorId,
    emoji: reaction.emoji,
    created_at: reaction.createdAt,
  };
}

export function sessionParticipantCompatibilityResponse(participant: MultiremiSessionParticipant): Record<string, unknown> {
  return {
    id: participant.id,
    session_id: participant.sessionId,
    participant_type: participant.participantType,
    participant_id: participant.participantId,
    role: participant.role,
    status: participant.status,
    joined_at: participant.joinedAt,
    updated_at: participant.updatedAt,
  };
}

export function issueSessionCompatibilityResponse(
  session: MultiremiIssueSession,
  participants: MultiremiSessionParticipant[],
): Record<string, unknown> {
  return {
    id: session.id,
    issue_id: session.issueId,
    workspace_id: session.workspaceId,
    title: session.title,
    status: session.status,
    is_default: session.isDefault,
    holds_workspace: session.holdsWorkspace,
    summary: session.summary,
    created_by_type: session.createdByType,
    created_by_id: session.createdById,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    participants: participants.map(sessionParticipantCompatibilityResponse),
  };
}

export function sessionEventCompatibilityResponse(event: MultiremiSessionEvent): Record<string, unknown> {
  return {
    id: event.id,
    session_id: event.sessionId,
    seq: event.seq,
    author_type: event.authorType,
    author_id: event.authorId,
    kind: event.kind,
    body: event.body,
    task_id: event.taskId,
    source_comment_id: event.sourceCommentId,
    metadata: event.metadata,
    created_at: event.createdAt,
  };
}

export function sessionResultCompatibilityResponse(result: MultiremiSessionResult): Record<string, unknown> {
  return {
    id: result.id,
    issue_id: result.issueId,
    source_session_id: result.sourceSessionId,
    title: result.title,
    body: result.body,
    metadata: result.metadata,
    published_by_type: result.publishedByType,
    published_by_id: result.publishedById,
    created_at: result.createdAt,
  };
}

export function commentCompatibilityResponse(comment: MultiremiIssueComment): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: comment.id,
    issue_id: comment.issueId,
    issue_session_id: comment.issueSessionId,
    author_type: comment.authorType,
    author_id: comment.authorId,
    task_id: comment.taskId ?? null,
    content: comment.body,
    type: comment.type ?? "comment",
    parent_id: comment.parentId,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    resolved_at: comment.resolvedAt,
    resolved_by_type: comment.resolvedByType,
    resolved_by_id: comment.resolvedById,
    reactions: comment.reactions.map(commentReactionCompatibilityResponse),
    attachments: comment.attachments.map(issueDetailAttachmentCompatibilityResponse),
  };
  if (comment.replyCount !== undefined) response.reply_count = comment.replyCount;
  if (comment.lastActivityAt !== undefined) response.last_activity_at = comment.lastActivityAt;
  if (comment.contentTruncated !== undefined) response.content_truncated = comment.contentTruncated;
  return response;
}

export function issueCommentMutationErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Comment not found:")) return c.json({ error: "comment not found" }, 404);
  if (message.startsWith("Parent comment not found:")) return c.json({ error: "invalid parent comment" }, 400);
  if (message === "Comment body is required") return c.json({ error: "content is required" }, 400);
  if (message === "Only root comments can be resolved") return c.json({ error: "only root comments can be resolved" }, 400);
  return c.json({ error: message }, 400);
}

export function issueSearchCompatibilityResponse(issue: MultiremiIssueSearchResult): Record<string, unknown> {
  const response: Record<string, unknown> = {
    ...issueCompatibilityResponse(issue),
    match_source: issue.matchSource,
  };
  if (issue.matchedSnippet !== undefined) response.matched_snippet = issue.matchedSnippet;
  if (issue.matchedDescriptionSnippet !== undefined) response.matched_description_snippet = issue.matchedDescriptionSnippet;
  if (issue.matchedCommentSnippet !== undefined) response.matched_comment_snippet = issue.matchedCommentSnippet;
  return response;
}

export function issueSubscriberCompatibilityResponse(subscriber: MultiremiIssueSubscriber): Record<string, unknown> {
  return {
    issue_id: subscriber.issueId,
    user_type: subscriber.userType,
    user_id: subscriber.userId,
    reason: subscriber.reason,
    created_at: subscriber.createdAt,
  };
}

export function issueSubscriberTargetErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "target user is not a member of this workspace") {
    return c.json({ error: message }, 403);
  }
  if (message.startsWith("Issue not found")) return c.json({ error: "issue not found" }, 404);
  return c.json({ error: message }, 400);
}

export function issueDependencyCompatibilityResponse(dependency: MultiremiIssueDependency): Record<string, unknown> {
  return {
    id: dependency.id,
    workspace_id: dependency.workspaceId,
    issue_id: dependency.issueId,
    depends_on_issue_id: dependency.dependsOnIssueId,
    type: dependency.type,
    issue: dependency.issue ? issueCompatibilityResponse(dependency.issue) : null,
    depends_on_issue: dependency.dependsOnIssue ? issueCompatibilityResponse(dependency.dependsOnIssue) : null,
    created_at: dependency.createdAt,
  };
}

export function issueSearchErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  if (err.message === "q parameter is required") return c.json({ error: "q parameter is required" }, 400);
  return null;
}

export function issueErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  if (err.message === "auto_title is reserved for system metadata") {
    return c.json({ error: err.message }, 400);
  }
  if (err.message.startsWith("Issue not found:")) return c.json({ error: "issue not found" }, 404);
  if (err.message.startsWith("Parent issue not found:")) return c.json({ error: "parent issue not found in this workspace" }, 400);
  if (err.message === "Parent issue belongs to another workspace") return c.json({ error: "parent issue not found in this workspace" }, 400);
  if (err.message === "An issue cannot be its own parent") return c.json({ error: "an issue cannot be its own parent" }, 400);
  if (err.message === "Circular issue parent relationship detected") return c.json({ error: "circular parent relationship detected" }, 400);
  if (err.message.startsWith("Project not found:")) return c.json({ error: "project not found in this workspace" }, 400);
  if (err.message === "Project belongs to another workspace") return c.json({ error: "project not found in this workspace" }, 400);
  if (
    err.message === "Project is archived" ||
    err.message.startsWith("Project is not active in this workspace:") ||
    err.message === "Generated issues must stay in the intake project's scope" ||
    err.message === "project_id is required when active projects are available" ||
    err.message === "Source issue must be an intake issue" ||
    err.message === "Source issue belongs to another workspace"
  ) {
    return c.json({ error: err.message }, 400);
  }
  if (
    err.message.includes("must be a valid date") ||
    err.message.includes("priority must be one of") ||
    err.message.includes("Assignee") ||
    err.message.includes("assignee")
  ) {
    return c.json({ error: err.message }, 400);
  }
  return null;
}

export function issueDependencyErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  if (err.message.startsWith("Issue not found:")) return c.json({ error: "issue not found" }, 404);
  if (err.message.startsWith("Dependent issue not found:")) return c.json({ error: "dependent issue not found" }, 400);
  if (err.message === "An issue cannot depend on itself") return c.json({ error: "an issue cannot depend on itself" }, 400);
  if (err.message === "Issue dependency must stay within a workspace") return c.json({ error: "issue dependency must stay within a workspace" }, 400);
  if (err.message.includes("dependency type must be one of")) return c.json({ error: err.message }, 400);
  if (err.message.startsWith("Dependency not found for issue:")) return c.json({ error: "dependency not found" }, 404);
  return null;
}

export function issueUpdateCompatibilityInput(input: UpdateIssueInput = {}): UpdateIssueInput {
  const out: UpdateIssueInput = {};
  if (hasRequestField(input, "title")) out.title = input.title;
  if (hasRequestField(input, "description")) out.description = input.description ?? null;
  if (hasRequestField(input, "status")) out.status = input.status;
  if (hasRequestField(input, "priority")) out.priority = input.priority;
  if (hasRequestField(input, "project_id")) out.project_id = input.project_id ?? null;
  if (hasRequestField(input, "workspace_id")) out.workspace_id = input.workspace_id ?? null;
  if (hasRequestField(input, "parent_issue_id")) out.parent_issue_id = input.parent_issue_id ?? null;
  if (hasRequestField(input, "assignee_type")) out.assignee_type = input.assignee_type ?? null;
  if (hasRequestField(input, "assignee_id")) out.assignee_id = input.assignee_id ?? null;
  if (hasRequestField(input, "position")) out.position = input.position;
  if (hasRequestField(input, "start_date")) out.start_date = input.start_date ?? null;
  if (hasRequestField(input, "due_date")) out.due_date = input.due_date ?? null;
  if (hasRequestField(input, "acceptance_criteria")) out.acceptance_criteria = input.acceptance_criteria ?? [];
  if (hasRequestField(input, "context_refs")) out.context_refs = input.context_refs ?? [];
  return out;
}

export function issueQuickCreateCompatibilityInput(input: QuickCreateIssueInput): QuickCreateIssueInput {
  const out: QuickCreateIssueInput = { prompt: input.prompt };
  if (hasRequestField(input, "agent_id")) out.agent_id = input.agent_id ?? null;
  if (hasRequestField(input, "squad_id")) out.squad_id = input.squad_id ?? null;
  if (hasRequestField(input, "project_id")) out.project_id = input.project_id ?? null;
  if (hasRequestField(input, "workspace_id")) out.workspace_id = input.workspace_id ?? null;
  if (hasRequestField(input, "requester_id")) out.requester_id = input.requester_id ?? null;
  return out;
}

export function issueBatchUpdateCompatibilityInput(input: BatchUpdateIssuesInput): BatchUpdateIssuesInput {
  return {
    issue_ids: input.issue_ids ?? [],
    updates: issueUpdateCompatibilityInput(input.updates ?? {}),
  };
}

export function issueBatchDeleteCompatibilityInput(input: BatchDeleteIssuesInput): BatchDeleteIssuesInput {
  return { issue_ids: input.issue_ids ?? [] };
}

export type CompatibilityQueryMode = "native" | "compat";

export function issueCommentListErrorResponse(c: Context, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "thread anchor not found in this issue") {
    return c.json({ error: message }, 404);
  }
  if (
    message.includes("mutually exclusive")
    || message.includes("requires")
    || message.includes("invalid")
    || message.includes("must be set together")
    || message.includes("does not support")
  ) {
    return c.json({ error: message }, 400);
  }
  return c.json({ error: "failed to list comments" }, 500);
}


export function issueTimelineResponse(
  store: MultiremiStore,
  issueId: string,
  c: { req: { query: (name: string) => string | undefined } },
): MultiremiTimelineEntry[] | MultiremiTimelinePage | null {
  if (!store.getIssue(issueId)) return null;
  const rawIssueSessionId = cleanString(c.req.query("issue_session_id")) || null;
  const paged = c.req.query("limit") != null || c.req.query("before") != null;
  let issueSessionId = rawIssueSessionId;
  if (paged && rawIssueSessionId === "@default") {
    const sessions = store.listIssueSessions(issueId);
    issueSessionId = sessions.find((session) => session.isDefault)?.id ?? sessions[0]?.id ?? null;
  }
  if (issueSessionId) {
    const session = store.getIssueSession(issueSessionId);
    if (!session || session.issueId !== issueId) return null;
  }
  const wrapped = ["limit", "before", "after", "around"].some((name) => c.req.query(name) != null);
  if (!wrapped) return store.listIssueTimeline(issueId, { ascending: true, issueSessionId });
  if (paged) {
    const limit = parseTimelineLimit(c.req.query("limit"));
    const before = parseTimelineCursor(c.req.query("before"));
    const page = store.listIssueTimelinePage(issueId, { issueSessionId, before, limit });
    const oldest = page.entries[0];
    const response: MultiremiTimelinePage = {
      entries: page.entries,
      next_cursor: page.hasMore && oldest ? encodeTimelineCursor(oldest) : null,
      prev_cursor: null,
      has_more: page.hasMore,
      has_more_before: page.hasMore,
      has_more_after: false,
      issue_session_id: issueSessionId,
    };
    const anchor = c.req.query("around");
    if (anchor) {
      const index = page.entries.findIndex((entry) => entry.id === anchor);
      if (index >= 0) response.target_index = index;
    }
    return response;
  }
  const entries = store.listIssueTimeline(issueId, { ascending: false, issueSessionId });
  const response: MultiremiTimelinePage = {
    entries,
    next_cursor: null,
    prev_cursor: null,
    has_more: false,
    has_more_before: false,
    has_more_after: false,
    issue_session_id: issueSessionId,
  };
  const anchor = c.req.query("around");
  if (anchor) {
    const index = entries.findIndex((entry) => entry.id === anchor);
    if (index >= 0) response.target_index = index;
  }
  return response;
}

export class IssueTimelineRequestError extends Error {}

function parseTimelineLimit(raw: string | undefined): number {
  if (raw == null || raw === "") return 40;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new IssueTimelineRequestError("invalid limit");
  }
  return limit;
}

function parseTimelineCursor(raw: string | undefined): { createdAt: string; id: string } | null {
  if (raw == null) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(value)
      || value.length !== 2
      || typeof value[0] !== "string"
      || typeof value[1] !== "string"
      || !value[1]
      || !Number.isFinite(Date.parse(value[0]))
    ) {
      throw new Error("invalid payload");
    }
    return { createdAt: value[0], id: value[1] };
  } catch {
    throw new IssueTimelineRequestError("invalid cursor");
  }
}

function encodeTimelineCursor(entry: MultiremiTimelineEntry): string {
  return Buffer.from(JSON.stringify([entry.createdAt, entry.id]), "utf8").toString("base64url");
}

function timelineEntryCompatibilityResponse(entry: MultiremiTimelineEntry): Record<string, unknown> {
  const response: Record<string, unknown> = {
    type: entry.type,
    id: entry.id,
    issue_session_id: entry.issue_session_id ?? entry.issueSessionId ?? null,
    actor_type: entry.actor_type ?? entry.actorType,
    actor_id: entry.actor_id ?? entry.actorId,
    created_at: entry.created_at ?? entry.createdAt,
  };
  if (entry.type === "activity") {
    response.action = entry.action ?? null;
    response.details = entry.details ?? null;
    return response;
  }

  response.content = entry.content ?? null;
  // Present only on agent auto-reply comments; the stream uses it to offer the
  // run's transcript. Older comments have no task and stay null.
  response.task_id = entry.task_id ?? entry.taskId ?? null;
  response.parent_id = entry.parent_id ?? entry.parentId ?? null;
  response.updated_at = entry.updated_at ?? entry.updatedAt ?? null;
  response.comment_type = entry.comment_type ?? entry.commentType ?? null;
  response.reactions = (entry.reactions ?? []).map(commentReactionCompatibilityResponse);
  response.attachments = (entry.attachments ?? []).map(issueDetailAttachmentCompatibilityResponse);
  response.resolved_at = entry.resolved_at ?? entry.resolvedAt ?? null;
  response.resolved_by_type = entry.resolved_by_type ?? entry.resolvedByType ?? null;
  response.resolved_by_id = entry.resolved_by_id ?? entry.resolvedById ?? null;
  return response;
}

export function issueTimelineCompatibilityResponse(
  store: MultiremiStore,
  issueId: string,
  c: { req: { query: (name: string) => string | undefined } },
): Record<string, unknown>[] | {
  entries: Record<string, unknown>[];
  next_cursor: string | null;
  prev_cursor: null;
  has_more: boolean;
  has_more_before: boolean;
  has_more_after: false;
  issue_session_id: string | null;
  target_index?: number;
} | null {
  const response = issueTimelineResponse(store, issueId, c);
  if (!response) return null;
  if (Array.isArray(response)) return response.map(timelineEntryCompatibilityResponse);
  return {
    ...response,
    entries: response.entries.map(timelineEntryCompatibilityResponse),
  };
}

export function issueUsageResponse(store: MultiremiStore, issue: MultiremiIssue): {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_tokens: number;
  task_count: number;
} {
  const taskIds = new Set(store.listTasksForIssue(issue.id).map((task) => task.id));
  const totals = {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_tokens: 0,
    task_count: taskIds.size,
  };
  for (const task of store.listTasksForIssue(issue.id)) {
    for (const entry of task.usage) {
      totals.total_input_tokens += entry.inputTokens ?? 0;
      totals.total_output_tokens += entry.outputTokens ?? 0;
      totals.total_cache_read_tokens += entry.cacheReadTokens ?? 0;
      totals.total_cache_write_tokens += entry.cacheWriteTokens ?? 0;
      totals.total_tokens += entry.totalTokens ?? 0;
    }
  }
  return totals;
}

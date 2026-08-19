import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import type {
  MultiremiIssue,
  MultiremiIssueShare,
  MultiremiTimelineEntry,
} from "@multiremi/contracts/types.js";
import { localAttachmentFileResponse } from "../helpers.js";
import {
  authenticatedRequestUserId,
  currentWorkspaceMember,
  currentWorkspaceRoleStrict,
  issueCompatibilityResponse,
  issueDependencyCompatibilityResponse,
  issueSessionCompatibilityResponse,
  issueUsageResponse,
  projectCompatibilitySummaryResponse,
  sessionEventCompatibilityResponse,
  sessionResultCompatibilityResponse,
} from "../wire/index.js";
import { taskCompatibilityResponse } from "../wire/tasks.js";
import type { RouterDeps } from "./deps.js";

const SHARE_DURATION_DAYS = 60;

export function registerIssueShareRoutes(app: Hono, deps: RouterDeps): void {
  const { store, shareSecret } = deps;

  app.get("/api/issues/:id/share", (c) => {
    const issue = store.getIssueByRef(c.req.param("id"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyIssueShareManagement(c, deps, issue);
    if (denied) return denied;
    const share = store.getActiveIssueShare(issue.id);
    return c.json({ share: share ? managedShareResponse(share, shareSecret) : null });
  });

  app.post("/api/issues/:id/share", (c) => {
    const issue = store.getIssueByRef(c.req.param("id"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyIssueShareManagement(c, deps, issue);
    if (denied) return denied;
    const share = store.ensureIssueShare(
      issue.id,
      issue.workspaceId,
      authenticatedRequestUserId(c) ?? "local",
      SHARE_DURATION_DAYS,
    );
    return c.json({ share: managedShareResponse(share, shareSecret) }, 201);
  });

  app.post("/api/issues/:id/share/extend", (c) => {
    const issue = store.getIssueByRef(c.req.param("id"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyIssueShareManagement(c, deps, issue);
    if (denied) return denied;
    const current = store.getActiveIssueShare(issue.id);
    if (!current) return c.json({ error: "share not found" }, 404);
    const share = store.extendIssueShare(current.id, SHARE_DURATION_DAYS);
    if (!share) return c.json({ error: "share not found" }, 404);
    return c.json({ share: managedShareResponse(share, shareSecret) });
  });

  app.delete("/api/issues/:id/share", (c) => {
    const issue = store.getIssueByRef(c.req.param("id"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyIssueShareManagement(c, deps, issue);
    if (denied) return denied;
    const current = store.getActiveIssueShare(issue.id);
    if (current) store.revokeIssueShare(current.id);
    return c.body(null, 204);
  });

  app.get("/api/shares/:token", (c) => {
    if (!authenticatedRequestUserId(c)) return c.json({ error: "login required" }, 401);
    const share = resolveActiveShare(c.req.param("token"), deps);
    if (!share) return c.json({ error: "share not found" }, 404);
    const issue = store.getIssueWithTasks(share.issueId);
    if (!issue || issue.workspaceId !== share.workspaceId) {
      return c.json({ error: "share not found" }, 404);
    }
    store.recordIssueShareView(share.id);
    const viewedShare = store.getIssueShare(share.id) ?? share;
    return c.json(buildSharedIssueBundle(c.req.param("token"), viewedShare, issue, deps));
  });

  app.get("/api/shares/:token/attachments/:attachmentId/content", async (c) => {
    if (!authenticatedRequestUserId(c)) return c.json({ error: "login required" }, 401);
    const share = resolveActiveShare(c.req.param("token"), deps);
    if (!share) return c.json({ error: "attachment not found" }, 404);
    const attachment = store.getAttachment(c.req.param("attachmentId"));
    if (!attachment || !attachmentBelongsToIssue(attachment.issueId, attachment.commentId, share.issueId, deps)) {
      return c.json({ error: "attachment not found" }, 404);
    }
    if (!attachment.url.startsWith("/api/attachments/")) return c.redirect(attachment.url);
    return localAttachmentFileResponse(attachment);
  });
}

function denyIssueShareManagement(
  c: Context,
  deps: RouterDeps,
  issue: MultiremiIssue,
): Response | null {
  const { store } = deps;
  const role = currentWorkspaceRoleStrict(c, store, issue.workspaceId);
  if (!role) return c.json({ error: "issue not found" }, 404);
  if (role === "owner" || role === "admin") return null;
  const userId = authenticatedRequestUserId(c);
  const member = currentWorkspaceMember(c, store, issue.workspaceId);
  if (issue.createdBy && (issue.createdBy === userId || issue.createdBy === member?.id)) return null;
  return c.json({ error: "only the issue creator or a workspace admin can manage sharing" }, 403);
}

function managedShareResponse(share: MultiremiIssueShare, secret: string) {
  return {
    token: signShareId(share.id, secret),
    expires_at: share.expiresAt,
    view_count: share.viewCount,
    last_viewed_at: share.lastViewedAt,
    created_at: share.createdAt,
  };
}

function publicShareResponse(share: MultiremiIssueShare) {
  return {
    expires_at: share.expiresAt,
    view_count: share.viewCount,
    last_viewed_at: share.lastViewedAt,
  };
}

function signShareId(id: string, secret: string): string {
  return `${id}.${createHmac("sha256", secret).update(id).digest("base64url")}`;
}

function resolveActiveShare(token: string, deps: RouterDeps): MultiremiIssueShare | null {
  const separator = token.indexOf(".");
  if (separator <= 0 || token.indexOf(".", separator + 1) !== -1) return null;
  const id = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  const expectedSignature = createHmac("sha256", deps.shareSecret).update(id).digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const share = deps.store.getIssueShare(id);
  if (!share || share.revokedAt || Date.parse(share.expiresAt) <= Date.now()) return null;
  return share;
}

function buildSharedIssueBundle(
  token: string,
  share: MultiremiIssueShare,
  issue: NonNullable<ReturnType<RouterDeps["store"]["getIssueWithTasks"]>>,
  deps: RouterDeps,
) {
  const { store } = deps;
  const issueResponse = issueCompatibilityResponse(issue, { includeLabels: true });
  issueResponse.reactions = issue.reactions.map((reaction) => ({
    id: reaction.id,
    actor_type: reaction.actorType,
    actor_id: reaction.actorId,
    emoji: reaction.emoji,
    created_at: reaction.createdAt,
  }));
  issueResponse.attachments = issue.attachments.map((attachment) => sharedAttachmentResponse(token, attachment));

  const timeline = store.listIssueTimeline(issue.id, { ascending: true })
    .map((entry) => sharedTimelineEntry(token, entry));
  const sessions = store.listIssueSessions(issue.id, true).map((session) => ({
    ...issueSessionCompatibilityResponse(session, store.listSessionParticipants(session.id)),
    events: store.listSessionEvents(session.id).map(sessionEventCompatibilityResponse),
    tasks: store.listTasksForIssue(issue.id)
      .filter((task) => task.issueSessionId === session.id)
      .map((task) => ({
        ...taskCompatibilityResponse(task),
        messages: store.listTaskMessages(task.id),
      })),
  }));
  const unscopedTasks = store.listTasksForIssue(issue.id)
    .filter((task) => !task.issueSessionId)
    .map((task) => ({
      ...taskCompatibilityResponse(task),
      messages: store.listTaskMessages(task.id),
    }));
  const issueWorkspace = store.getIssueWorkspace(issue.id);
  const project = issue.projectId ? store.getProject(issue.projectId) : null;
  const parentIssue = issue.parentIssueId ? store.getIssue(issue.parentIssueId) : null;

  return {
    share: publicShareResponse(share),
    issue: issueResponse,
    project: project ? projectCompatibilitySummaryResponse(project) : null,
    parent_issue: parentIssue ? issueCompatibilityResponse(parentIssue) : null,
    children: issue.children.map((child) => issueCompatibilityResponse(child)),
    child_progress: {
      total: issue.childProgress.total,
      done: issue.childProgress.done,
    },
    dependencies: issue.dependencies.map(issueDependencyCompatibilityResponse),
    timeline,
    sessions,
    session_results: store.listIssueSessionResults(issue.id).map(sessionResultCompatibilityResponse),
    tasks: unscopedTasks,
    issue_workspace: issueWorkspace ? {
      issue_id: issueWorkspace.issueId,
      workspace_id: issueWorkspace.workspaceId,
      issue_key: issueWorkspace.issueKey,
      runtime_id: issueWorkspace.runtimeId,
      runtime_name: issueWorkspace.runtimeName,
      runtime_status: issueWorkspace.runtimeStatus,
      root_path: issueWorkspace.rootPath,
      branch_name: issueWorkspace.branchName,
      status: issueWorkspace.status,
      repos: issueWorkspace.repos.map((repo) => ({
        repo_url: repo.repoUrl,
        repo_name: repo.repoName,
        worktree_path: repo.worktreePath,
        branch_name: repo.branchName,
        base_ref: repo.baseRef,
        status: repo.status,
        dirty: repo.dirty,
        error: repo.error,
      })),
      last_task_id: issueWorkspace.lastTaskId,
      cleaned_at: issueWorkspace.cleanedAt,
      created_at: issueWorkspace.createdAt,
      updated_at: issueWorkspace.updatedAt,
    } : null,
    usage: issueUsageResponse(store, issue),
    actors: referencedActors(issue, timeline, sessions, deps),
  };
}

function sharedTimelineEntry(token: string, entry: MultiremiTimelineEntry) {
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
  response.task_id = entry.task_id ?? entry.taskId ?? null;
  response.parent_id = entry.parent_id ?? entry.parentId ?? null;
  response.updated_at = entry.updated_at ?? entry.updatedAt ?? null;
  response.comment_type = entry.comment_type ?? entry.commentType ?? null;
  response.reactions = entry.reactions ?? [];
  response.attachments = (entry.attachments ?? []).map((attachment) => sharedAttachmentResponse(token, attachment));
  response.resolved_at = entry.resolved_at ?? entry.resolvedAt ?? null;
  response.resolved_by_type = entry.resolved_by_type ?? entry.resolvedByType ?? null;
  response.resolved_by_id = entry.resolved_by_id ?? entry.resolvedById ?? null;
  return response;
}

function sharedAttachmentResponse(
  token: string,
  attachment: NonNullable<ReturnType<RouterDeps["store"]["getAttachment"]>>,
) {
  const contentUrl = `/api/shares/${encodeURIComponent(token)}/attachments/${encodeURIComponent(attachment.id)}/content`;
  return {
    id: attachment.id,
    filename: attachment.filename,
    content_type: attachment.contentType,
    size_bytes: attachment.sizeBytes,
    created_at: attachment.createdAt,
    url: contentUrl,
    download_url: contentUrl,
  };
}

function attachmentBelongsToIssue(
  issueId: string | null,
  commentId: string | null,
  sharedIssueId: string,
  deps: RouterDeps,
): boolean {
  if (issueId === sharedIssueId) return true;
  if (!commentId) return false;
  return deps.store.getIssueComment(commentId)?.issueId === sharedIssueId;
}

function referencedActors(
  issue: MultiremiIssue,
  timeline: Array<Record<string, unknown>>,
  sessions: Array<Record<string, unknown>>,
  deps: RouterDeps,
) {
  const refs = new Map<string, string>();
  if (issue.createdBy) refs.set(`member:${issue.createdBy}`, issue.createdBy);
  if (issue.assigneeType && issue.assigneeId) refs.set(`${issue.assigneeType}:${issue.assigneeId}`, issue.assigneeId);
  for (const item of [...timeline, ...sessions]) collectActorRefs(item, refs);
  return [...refs].flatMap(([typedId, id]) => {
    const [type] = typedId.split(":");
    if (type === "agent") {
      const actor = deps.store.getAgent(id);
      return actor ? [{ type, id: actor.id, name: actor.name, avatar_url: actor.avatarUrl }] : [];
    }
    if (type === "member") {
      const actor = deps.store.getWorkspaceMemberByRef(id, issue.workspaceId)
        ?? deps.store.listWorkspaceMembers(issue.workspaceId).find((member) => member.userId === id);
      return actor ? [{ type, id: actor.id, name: actor.name, avatar_url: null }] : [];
    }
    return [];
  });
}

function collectActorRefs(value: unknown, refs: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectActorRefs(item, refs);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  const type = typeof object.actor_type === "string"
    ? object.actor_type
    : typeof object.author_type === "string"
      ? object.author_type
      : typeof object.participant_type === "string"
        ? object.participant_type
        : null;
  const id = typeof object.actor_id === "string"
    ? object.actor_id
    : typeof object.author_id === "string"
      ? object.author_id
      : typeof object.participant_id === "string"
        ? object.participant_id
        : null;
  if (type && id) refs.set(`${type}:${id}`, id);
  for (const nested of Object.values(object)) collectActorRefs(nested, refs);
}

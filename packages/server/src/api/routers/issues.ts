import { resolveRequestWorkspaceId } from "../helpers/workspace-context.js";
import type { Context, Hono } from "hono";
import { assertRuntimeWorkspaceAccess } from "../helpers/runtime-workspaces.js";
import {
  assigneeFrequencyQuery,
  canCurrentUserAccessAgent,
  canCurrentUserAccessChatTask,
  currentTaskParentId,
  denyCurrentUserWorkspaceAccess,
  denyRestrictedTaskIssueCreation,
  isActiveTaskStatus,
  isJsonApiError,
  issueCommentCreateInput,
  issueFromParam,
  humanRequestActor,
  issueListQuery,
  loadChatSessionForCurrentUser,
  issueMutationActor,
  denyAttachmentCreationAccess,
  issueSubscriberCaller,
  issueSubscriberTarget,
  log,
  maybeDispatchOnIssueUpdate,
  normalizeReactionInput,
  normalizeSubscriptionReason,
  parseIssueCommentListQuery,
  publishIssueCreated,
  publishIssueUpdated,
  readJson,
  readJsonStrict,
  requireWorkspaceAdmin,
  safeAssignIssue,
  safeQuickCreateIssue,
  safeRerunIssue,
  setIssueCommentCursorHeaders,
  splitQueryList,
  withIssueCreateRequestContext,
} from "../helpers.js";
import {
  attachmentCompatibilityResponse,
  cleanString,
  commentCompatibilityResponse,
  currentTaskAccessToken,
  authenticatedRequestUserId,
  currentRequestUserId,
  currentAccessToken,
  currentWorkspaceMember,
  hasRequestField,
  isAnonymousCompatibilityRequest,
  issueBatchDeleteCompatibilityInput,
  issueBatchUpdateCompatibilityInput,
  issueCommentListErrorResponse,
  issueCommentMutationErrorResponse,
  issueCompatibilityResponse,
  issueDependencyCompatibilityResponse,
  issueDependencyErrorResponse,
  denyTaskIdentityIssueForce,
  issueDetailCompatibilityResponse,
  issueErrorResponse,
  issueQuickCreateCompatibilityInput,
  issueReactionCompatibilityResponse,
  issueSearchCompatibilityResponse,
  issueSearchErrorResponse,
  issueSessionCompatibilityResponse,
  issueSessionsCompatibilityResponse,
  issueSubscriberCompatibilityResponse,
  issueSubscriberTargetErrorResponse,
  issueTimelineCompatibilityResponse,
  IssueTimelineRequestError,
  issueTimelineResponse,
  issueUpdateCompatibilityInput,
  stripServerOwnedAssignFields,
  stripServerOwnedIssueCreateFields,
  stripServerOwnedIssueSourceFields,
  stripServerOwnedQuickCreateFields,
  stripServerOwnedIssueUpdateFields,
  stripServerOwnedSessionTaskFields,
  issueUsageResponse,
  labelCompatibilityErrorResponse,
  labelCompatibilityResponse,
  parseOptionalInt,
  sessionEventCompatibilityResponse,
  sessionParticipantCompatibilityResponse,
  sessionResultCompatibilityResponse,
  taskCompatibilityResponse,
  taskPublicResponse,
} from "../wire/index.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { ParentDoneGrantOwnerError } from "@multiremi/store/repos/issues-repo.js";
import type {
  AddSessionParticipantInput,
  AssignIssueInput,
  BatchDeleteIssuesInput,
  BatchUpdateIssuesInput,
  CreateAttachmentInput,
  CreateIssueCommentInput,
  CreateIssueDependencyInput,
  CreateIssueSessionInput,
  CreateIssueWithTaskInput,
  CreateIssueDecisionInput,
  IssueDecisionActor,
  CreateMultiremiReactionInput,
  CreateSessionTaskInput,
  ListIssuesInput,
  MultiremiIssue,
  MultiremiAssigneeType,
  MultiremiIssueWorkspaceArchiveBinding,
  PublishSessionResultInput,
  QuickCreateIssueInput,
  UpdateIssueInput,
  UpdateIssueSessionInput,
} from "@multiremi/contracts/types.js";
import {
  MULTIREMI_ISSUE_ARCHIVE_MAX_TTL_MS,
  MULTIREMI_ISSUE_ARCHIVE_MIN_SWEEP_INTERVAL_MS,
  MULTIREMI_ISSUE_ARCHIVE_MIN_TTL_MS,
} from "@multiremi/contracts/types.js";
import { resolveIssueArchiveSettings } from "@multiremi/store/issue-archive.js";
import { resolveOptionalStringField } from "@multiremi/store/helpers.js";
import type { RouterDeps } from "./deps.js";
import { IssueDecisionError } from "@multiremi/store/repos/issues-repo.js";

function decisionActor(c: Context, store: MultiremiStore, workspaceId: string): IssueDecisionActor | null {
  const token = currentTaskAccessToken(c);
  if (token) return token.agentId && token.taskId
    ? { type: "agent", id: token.agentId, taskId: token.taskId } : null;
  const member = currentWorkspaceMember(c, store, workspaceId);
  return member ? { type: "member", id: member.id, taskId: null } : null;
}

function decisionError(c: Context, error: unknown): Response {
  if (error instanceof IssueDecisionError) return c.json({ error: error.message }, error.status);
  throw error;
}

// Check trusted caller lineage before an Issue mutation can cancel existing
// work, change assignment, or create a new Issue and then dispatch an agent.
function denySideSessionAgentDispatch(c: Context, store: MultiremiStore): Response | null {
  const sourceTaskId = currentTaskAccessToken(c)?.taskId;
  const sourceTask = sourceTaskId ? store.getTask(sourceTaskId) : null;
  const sourceSession = sourceTask?.issueSessionId ? store.getIssueSession(sourceTask.issueSessionId) : null;
  return sourceSession && sourceSession.inheritMode !== "none"
    ? c.json({ error: "Agent delegation is not allowed from side sessions" }, 403)
    : null;
}

function denySideSessionAssigneeDispatch(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
  assigneeType: MultiremiAssigneeType | null | undefined,
  assigneeId: string | null | undefined,
): Response | null {
  if (!assigneeId || assigneeType === "member") return null;
  const denied = denySideSessionAgentDispatch(c, store);
  if (!denied) return null;
  // An untyped reference may still resolve to a human member. Keep that
  // non-agent assignment available; unresolved references cannot authorize it.
  if (!assigneeType) {
    try {
      if (store.resolveAssigneeRef(assigneeType, assigneeId, workspaceId)?.assigneeType === "member") return null;
    } catch { /* Deny a side agent's unresolved dispatch request before mutation. */ }
  }
  return denied;
}

function denySideSessionIssueUpdate(
  c: Context,
  store: MultiremiStore,
  issue: MultiremiIssue,
  input: UpdateIssueInput,
): Response | null {
  const changesAssignee = hasRequestField(input, "assigneeType", "assignee_type", "assigneeId", "assignee_id");
  const leavesBacklog = issue.status === "backlog" && hasRequestField(input, "status");
  if (!changesAssignee && !leavesBacklog) return null;
  const status = hasRequestField(input, "status") ? String(input.status ?? "todo").trim() : issue.status;
  if (status === "backlog" || status === "done" || status === "cancelled") return null;
  const denied = denySideSessionAgentDispatch(c, store);
  if (!denied) return null;
  const type = hasRequestField(input, "assigneeType", "assignee_type")
    ? resolveOptionalStringField(input, "assigneeType", "assignee_type", issue.assigneeType)
    : hasRequestField(input, "assigneeId", "assignee_id") ? null : issue.assigneeType;
  const id = resolveOptionalStringField(input, "assigneeId", "assignee_id", issue.assigneeId);
  try {
    const workspaceId = resolveOptionalStringField(input, "workspaceId", "workspace_id", issue.workspaceId) ?? "local";
    const assignee = store.resolveAssigneeRef(type as MultiremiAssigneeType | null, id, workspaceId);
    if (!assignee || assignee.assigneeType === "member") return null;
    if (!leavesBacklog && assignee.assigneeType === issue.assigneeType && assignee.assigneeId === issue.assigneeId) return null;
  } catch { /* Invalid side dispatch input cannot authorize a mutation. */ }
  return denied;
}

// The idempotent generated-issue replay (source_issue_id + same title, 200)
// must satisfy the same dispatch-outcome contract as a fresh create: a
// retrying agent otherwise reads a response with no dispatch fields and stays
// blind to an issue nobody is executing. This request dispatched nothing
// itself, so the outcome is derived from the existing issue's CURRENT state —
// assignment classification first (unassigning cancels the issue's tasks, so a
// stale cancelled task must not resurface as "dispatched"), then the newest
// still-standing task, and with no task left the recorded dispatch_skipped
// activity supplies the original failure reason instead of a guess.
/**
 * MUL-400 E3: `blocked_by` is the compatibility spelling of the unmet
 * prerequisite keys, so a child row can explain its hold without another call.
 */
function withBlockedBy(store: MultiremiStore) {
  return (child: MultiremiIssue): MultiremiIssue & { blocked_by: string[] } => ({
    ...child,
    blocked_by: store.listUnmetPrerequisites(child.id).map((row) => row.key),
  });
}

function existingIssueDispatchResponse(store: MultiremiStore, issue: MultiremiIssue): Record<string, unknown> {
  const response = issueCompatibilityResponse(issue);
  const skipped = (reason: string, error?: string | null): Record<string, unknown> => ({
    ...response,
    task_id: null,
    dispatch_status: "skipped",
    dispatch_skipped_reason: reason,
    ...(error ? { dispatch_error: error } : {}),
  });
  if (!issue.assigneeType || !issue.assigneeId) return skipped("no_assignee");
  if (issue.status === "backlog") return skipped("backlog_status");
  if (issue.assigneeType === "member") return skipped("member_assignee");
  const standingTask = store.listTasksForIssue(issue.id).find((task) => task.status !== "cancelled") ?? null;
  if (standingTask) {
    return {
      ...response,
      task_id: standingTask.id,
      dispatch_status: "dispatched",
      dispatch_skipped_reason: null,
    };
  }
  const skipActivity = store.listIssueActivity(issue.id).findLast((activity) => activity.type === "dispatch_skipped");
  const data = (skipActivity?.data ?? null) as { reason?: unknown; error?: unknown } | null;
  const reason = typeof data?.reason === "string" ? data.reason : "no_runnable_agent";
  const error = typeof data?.error === "string" ? data.error : skipActivity?.body ?? null;
  return skipped(reason, error);
}

export function registerIssueRoutes(app: Hono, deps: RouterDeps): void {
  const { store, sessionArchives } = deps;

  const lockAutoTitleAfterHumanEdit = (c: Context, issue: MultiremiIssue, input: UpdateIssueInput): void => {
    if (!Object.prototype.hasOwnProperty.call(input, "title")) return;
    const token = currentAccessToken(c);
    if (token?.type === "task" || token?.type === "daemon") return;
    store.setIssueAutoTitleMetadata(issue.id, {
      ...store.getIssueAutoTitleMetadata(issue.id),
      locked: true,
    });
  };

  const issueDeleteAccess = (c: Context, workspaceId: string): Response | null =>
    denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);

  const listAccessibleChildIssues = (c: Context, parentRefs: string[], explicitWorkspaceId: string | null): MultiremiIssue[] => {
    // Full IDs resolve globally; explicit selectors only scope keys, numbers and
    // prefixes. Keep unscoped refs on the store's resolver; do not infer token/member defaults.
    let workspaceId = cleanString(explicitWorkspaceId) ?? cleanString(c.req.header("X-Workspace-ID"));
    let unknownSlug = false;
    if (!workspaceId) {
      const slug = cleanString(c.req.header("X-Workspace-Slug"));
      if (slug) {
        workspaceId = store.listWorkspaces().find((candidate) => candidate.slug === slug)?.id ?? null;
        unknownSlug = !workspaceId;
      }
    }
    const workspaceAccess = new Map<string, boolean>();
    const canAccessWorkspace = (workspaceId: string): boolean => {
      let allowed = workspaceAccess.get(workspaceId);
      if (allowed === undefined) {
        allowed = denyCurrentUserWorkspaceAccess(c, store, workspaceId) == null;
        workspaceAccess.set(workspaceId, allowed);
      }
      return allowed;
    };
    const seenParentIds = new Set<string>();
    return parentRefs.flatMap((ref) => {
      const parent = store.getIssue(ref.trim()) ?? (unknownSlug ? null : store.getIssueByRef(ref, workspaceId));
      if (!parent || !canAccessWorkspace(parent.workspaceId)) return [];
      if (seenParentIds.has(parent.id)) return [];
      seenParentIds.add(parent.id);
      return store.listChildIssues(parent.id).filter((child) => canAccessWorkspace(child.workspaceId));
    });
  };

  const issueBatchUpdateAccess = (c: Context, input: BatchUpdateIssuesInput): Response | null => {
    const issueIds = new Set(input.issueIds ?? input.issue_ids ?? []);
    for (const issueId of issueIds) {
      const issue = store.getIssue(issueId);
      if (!issue) continue;
      const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
      if (denied) return denied;
    }
    return null;
  };

  const beginIssueDeletion = (issueId: string): boolean => {
    const begun = store.beginIssueDeletion(issueId);
    if (begun.ok) return true;
    if (begun.code === "issue_not_found") return false;
    throw Object.assign(new Error(begun.error), { code: begun.code, issueId });
  };

  const isIssueDeletionConflict = (error: unknown): error is Error & { code: string } =>
    error instanceof Error
    && "code" in error
    && (
      error.code === "issue_workspace_not_cleaned"
      || error.code === "issue_workspace_archive_invalid"
      || error.code === "issue_has_active_tasks"
      || error.code === "issue_deletion_conflict"
    );

  const deleteIssueWithArchives = async (
    issueId: string,
    options: { deletionBegun?: boolean } = {},
  ): Promise<boolean> => {
    if (!options.deletionBegun && !beginIssueDeletion(issueId)) return false;
    let purgeReceipt: string | null = null;
    try {
      const workspace = store.getIssueWorkspace(issueId);
      if (workspace) {
        const binding = issueWorkspaceArchiveBinding(workspace);
        await sessionArchives.verifyIssueDeletionArchive(issueId, binding);
      }
      purgeReceipt = await sessionArchives.prepareIssueArchivePurge(issueId);
      const deleted = store.deleteIssuesAtomically([issueId]).deleted === 1;
      if (!deleted) {
        await sessionArchives.abortIssueArchivePurge(purgeReceipt);
        store.abortIssueDeletion(issueId);
        return false;
      }
      await sessionArchives.completeIssueArchivePurge(purgeReceipt).catch((error) => {
        log.warn(
          `Issue ${issueId} was deleted but archive purge will retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return true;
    } catch (error) {
      // A failed DB transaction must leave the archive bytes intact. Once the
      // Issue is gone the receipt is intentionally retained for recovery.
      if (store.getIssue(issueId)) {
        if (purgeReceipt) {
          await sessionArchives.abortIssueArchivePurge(purgeReceipt).catch(() => undefined);
        }
        store.abortIssueDeletion(issueId);
      }
      throw error;
    }
  };

  const deleteIssueBatch = async (
    c: Context,
    input: BatchDeleteIssuesInput,
  ): Promise<{ deleted: number } | Response> => {
    const issueIds = input.issueIds ?? input.issue_ids ?? [];
    if (issueIds.length === 0) throw new Error("issue_ids is required");
    // Complete every authorization and lifecycle check before deleting the
    // first row. A scoped credential must not smuggle another workspace's ID
    // into a batch which also performs physical archive cleanup.
    const existingIssueIds: string[] = [];
    const seenIssueIds = new Set<string>();
    for (const issueId of issueIds) {
      if (seenIssueIds.has(issueId)) continue;
      seenIssueIds.add(issueId);
      const issue = store.getIssue(issueId);
      if (!issue) continue;
      const denied = issueDeleteAccess(c, issue.workspaceId);
      if (denied) return denied;
      existingIssueIds.push(issueId);
    }
    const fenced: string[] = [];
    const receipts: Array<{ issueId: string; receiptId: string }> = [];
    let databaseCommitted = false;
    try {
      // Fence the complete batch before deleting its first row. This keeps a
      // late workspace/task transition from turning a validation failure into
      // a partially applied batch.
      for (const issueId of existingIssueIds) {
        if (!beginIssueDeletion(issueId)) continue;
        fenced.push(issueId);
      }
      for (const issueId of fenced) {
        const workspace = store.getIssueWorkspace(issueId);
        if (workspace) {
          await sessionArchives.verifyIssueDeletionArchive(
            issueId,
            issueWorkspaceArchiveBinding(workspace),
          );
        }
        receipts.push({
          issueId,
          receiptId: await sessionArchives.prepareIssueArchivePurge(issueId),
        });
      }
      const result = store.deleteIssuesAtomically(fenced);
      databaseCommitted = true;
      for (const receipt of receipts) {
        await sessionArchives.completeIssueArchivePurge(receipt.receiptId).catch((error) => {
          log.warn(
            `Issue ${receipt.issueId} was deleted but archive purge will retry: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return result;
    } catch (error) {
      if (!databaseCommitted) {
        for (const receipt of receipts) {
          await sessionArchives.abortIssueArchivePurge(receipt.receiptId).catch(() => undefined);
        }
        for (const issueId of fenced) store.abortIssueDeletion(issueId);
      }
      throw error;
    }
  };

  const issueWorkspaceArchiveBinding = (workspace: {
    cleanedArchiveId: string | null;
    cleanedArchiveSourceRevision: string | null;
    cleanedArchiveSha256: string | null;
  }): MultiremiIssueWorkspaceArchiveBinding => {
    if (
      !workspace.cleanedArchiveId
      || !workspace.cleanedArchiveSourceRevision
      || !workspace.cleanedArchiveSha256
    ) {
      throw Object.assign(
        new Error("cleaned Issue workspace is missing its exact archive binding"),
        { code: "issue_workspace_archive_invalid" },
      );
    }
    return {
      archiveId: workspace.cleanedArchiveId,
      sourceRevision: workspace.cleanedArchiveSourceRevision,
      sha256: workspace.cleanedArchiveSha256,
    };
  };

  const listIssuesResponse = (query: ListIssuesInput = {}) => {
    const issues = store.listIssues(query).map((issue) => {
      const tasks = store.listTasksForIssue(issue.id);
      return {
        ...issue,
        taskCount: tasks.length,
        latestTaskStatus: tasks[0]?.status ?? null,
        latestTaskId: tasks[0]?.id ?? null,
      };
    });
    return { issues, total: store.countIssues(query) };
  };

  const issueArchiveSettingsResponse = (workspaceId: string) => {
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return null;
    const settings = resolveIssueArchiveSettings(workspace.settings);
    return {
      ttl_ms: settings.ttlMs,
      sweep_interval_ms: settings.sweepIntervalMs,
    };
  };

  app.get("/api/workspaces/:id/issue-archive", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const config = issueArchiveSettingsResponse(workspaceId);
    return config ? c.json({ config }) : c.json({ error: "workspace not found" }, 404);
  });

  app.put("/api/workspaces/:id/issue-archive", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ ttl_ms?: number; sweep_interval_ms?: number }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const fields = Object.keys(body);
    if (fields.some((key) => key !== "ttl_ms" && key !== "sweep_interval_ms")) {
      return c.json({ error: "only ttl_ms and sweep_interval_ms are allowed" }, 400);
    }
    const ttlMs = body.ttl_ms;
    const sweepIntervalMs = body.sweep_interval_ms;
    if (
      !Number.isSafeInteger(ttlMs)
      || Number(ttlMs) < MULTIREMI_ISSUE_ARCHIVE_MIN_TTL_MS
      || Number(ttlMs) > MULTIREMI_ISSUE_ARCHIVE_MAX_TTL_MS
    ) {
      return c.json({
        error: `ttl_ms must be between ${MULTIREMI_ISSUE_ARCHIVE_MIN_TTL_MS} and ${MULTIREMI_ISSUE_ARCHIVE_MAX_TTL_MS}`,
      }, 400);
    }
    if (
      !Number.isSafeInteger(sweepIntervalMs)
      || Number(sweepIntervalMs) < MULTIREMI_ISSUE_ARCHIVE_MIN_SWEEP_INTERVAL_MS
      || Number(sweepIntervalMs) > Number(ttlMs)
    ) {
      return c.json({ error: "sweep_interval_ms must be at least 60000 and no greater than ttl_ms" }, 400);
    }
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    const settings = { ...(workspace.settings ?? {}) } as Record<string, unknown>;
    const currentArchive = settings.issue_archive;
    settings.issue_archive = {
      ...(currentArchive && typeof currentArchive === "object" && !Array.isArray(currentArchive)
        ? currentArchive as Record<string, unknown>
        : {}),
      ttl_ms: Number(ttlMs),
      sweep_interval_ms: Number(sweepIntervalMs),
    };
    store.updateWorkspace(workspaceId, { settings });
    return c.json({ config: issueArchiveSettingsResponse(workspaceId) });
  });

  app.get("/api/multiremi/issues", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspaceId") ?? c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const query = issueListQuery(store, c, "native", workspaceId);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(listIssuesResponse(query));
  });
  app.get("/api/issues", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const query = issueListQuery(store, c, "compat", workspaceId);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    const issues = store.listIssues(query).map((issue) => issueCompatibilityResponse(issue, { includeLabels: true }));
    return c.json({ issues, total: store.countIssues(query) });
  });
  app.get("/api/issues/status-pages", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const query = issueListQuery(store, c, "compat", workspaceId);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    if (query.offset !== undefined && query.offset !== 0) {
      return c.json({ error: "status-pages only supports offset=0; use /api/issues for subsequent pages" }, 400);
    }
    const result = store.listIssueStatusPages(query, c.req.query("include_archived_total") === "true");
    return c.json({
      ...result,
      groups: Object.fromEntries(Object.entries(result.groups).map(([status, group]) => [status, {
        issues: group.issues.map((issue) => issueCompatibilityResponse(issue, { includeLabels: true })),
        total: group.total,
        has_more: group.has_more,
      }])),
    });
  });
  app.get("/api/multiremi/issues/grouped", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspaceId") ?? c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const query = issueListQuery(store, c, "native", workspaceId);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listGroupedIssues(query));
  });
  app.get("/api/issues/grouped", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const query = issueListQuery(store, c, "compat", workspaceId);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listGroupedIssues(query));
  });
  app.get("/api/assignee-frequency", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspaceId") ?? c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const query = { ...assigneeFrequencyQuery(c), workspaceId };
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listAssigneeFrequency(query));
  });
  app.get("/api/multiremi/assignee-frequency", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspaceId") ?? c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const query = { ...assigneeFrequencyQuery(c), workspaceId };
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listAssigneeFrequency(query));
  });
  app.get("/api/multiremi/issues/search", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspaceId"));
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const result = store.searchIssues({
      q: c.req.query("q") ?? "",
      workspaceId,
      includeClosed: c.req.query("include_closed") === "true" || c.req.query("includeClosed") === "true",
      includeCommentBodies: true,
      limit: parseOptionalInt(c.req.query("limit")),
      offset: parseOptionalInt(c.req.query("offset")),
    });
    return c.json(result);
  });
  app.get("/api/issues/search", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const result = store.searchIssues({
        q: c.req.query("q") ?? "",
        workspaceId,
        includeClosed: c.req.query("include_closed") === "true",
        includeCommentBodies: true,
        limit: parseOptionalInt(c.req.query("limit")),
        offset: parseOptionalInt(c.req.query("offset")),
      });
      c.header("X-Total-Count", String(result.total));
      return c.json({
        issues: result.issues.map(issueSearchCompatibilityResponse),
        total: result.total,
      });
    } catch (err) {
      const response = issueSearchErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.get("/api/multiremi/issues/child-progress", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspaceId"));
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const progress = store.listChildIssueProgress(workspaceId);
    return c.json({ progress, total: progress.length });
  });
  app.get("/api/issues/child-progress", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const progress = store.listChildIssueProgress(workspaceId);
    return c.json({ progress, total: progress.length });
  });
  app.get("/api/issues/children", (c) => {
    const parentIds = splitQueryList(c.req.query("parent_ids"));
    const issues = listAccessibleChildIssues(c, parentIds, c.req.query("workspace_id") ?? null)
      .map((child) => ({
        ...issueCompatibilityResponse(child),
        blocked_by: store.listUnmetPrerequisites(child.id).map((row) => row.key),
      }));
    return c.json({ issues, total: issues.length });
  });
  app.get("/api/multiremi/issues/children", (c) => {
    const parentIds = splitQueryList(c.req.query("parent_ids") ?? c.req.query("parentIds"));
    const issues = listAccessibleChildIssues(c, parentIds, c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? null).map(withBlockedBy(store));
    return c.json({ issues, total: issues.length });
  });
  function validateBatchWorkspaceBinding(c: Context, input: BatchUpdateIssuesInput): Response | null {
    const updates = input.updates;
    if (!updates || !("runtimeWorkspaceId" in updates || "runtime_workspace_id" in updates)) return null;
    for (const id of input.issueIds ?? input.issue_ids ?? []) {
      const issue = store.getIssue(id);
      if (!issue) continue;
      const workspaceId = updates.workspaceId ?? updates.workspace_id ?? issue.workspaceId;
      const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId)
        ?? denyCurrentUserWorkspaceAccess(c, store, workspaceId);
      if (denied) return denied;
      assertRuntimeWorkspaceAccess(c, store, updates.runtimeWorkspaceId ?? updates.runtime_workspace_id, workspaceId);
    }
    return null;
  }

  app.post("/api/multiremi/issues/batch-update", async (c) => {
    const body = await readJson<BatchUpdateIssuesInput>(c);
    // MUL-400 E1: batch update is the third status writer, so it takes the same
    // member-only rule for `force` as the two PATCH routes.
    const forceDenied = denyTaskIdentityIssueForce(c, body.updates ?? {});
    if (forceDenied) return forceDenied;
    const denied = issueBatchUpdateAccess(c, body) ?? validateBatchWorkspaceBinding(c, body);
    if (denied) return denied;
    // The batch writer needs the same attribution the PATCH routes stamp, or
    // guards that branch on `actorType` (A4) silently do not apply.
    const { actorType, actorId } = issueMutationActor(c);
    const result = store.batchUpdateIssues({
      ...body,
      updates: body.updates
        ? {
          ...stripServerOwnedIssueUpdateFields(body.updates),
          actorType,
          actorId,
          parentTaskId: currentTaskParentId(c),
        }
        : body.updates,
    });
    return c.json(result);
  });
  app.post("/api/issues/batch-update", async (c) => {
    const body = await readJson<BatchUpdateIssuesInput>(c);
    try {
      const input = issueBatchUpdateCompatibilityInput(body);
      const forceDenied = denyTaskIdentityIssueForce(c, body.updates ?? {});
      if (forceDenied) return forceDenied;
      const denied = issueBatchUpdateAccess(c, input) ?? validateBatchWorkspaceBinding(c, input);
      if (denied) return denied;
      const { actorType, actorId } = issueMutationActor(c);
      const result = store.batchUpdateIssues({
        ...input,
        updates: input.updates
          ? {
            ...stripServerOwnedIssueUpdateFields(input.updates),
            actorType,
            actorId,
            parentTaskId: currentTaskParentId(c),
          }
          : input.updates,
      });
      // The compat body stays `{ updated }` unless a row was actually held, so
      // existing callers that assert the exact shape keep working.
      return result.skipped.length
        ? c.json({ updated: result.updated, skipped: result.skipped })
        : c.json({ updated: result.updated });
    } catch (err) {
      if (err instanceof Error && err.message === "issue_ids is required") return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.post("/api/multiremi/issues/batch-delete", async (c) => {
    const body = await readJson<BatchDeleteIssuesInput>(c);
    try {
      const result = await deleteIssueBatch(c, body);
      if (result instanceof Response) return result;
      return c.json(result);
    } catch (error) {
      if (isIssueDeletionConflict(error)) {
        return c.json({ error: error.message, code: error.code }, 409);
      }
      throw error;
    }
  });
  app.post("/api/issues/batch-delete", async (c) => {
    const body = await readJson<BatchDeleteIssuesInput>(c);
    try {
      const result = await deleteIssueBatch(c, issueBatchDeleteCompatibilityInput(body));
      if (result instanceof Response) return result;
      return c.json(result);
    } catch (err) {
      if (err instanceof Error && err.message === "issue_ids is required") return c.json({ error: err.message }, 400);
      if (isIssueDeletionConflict(err)) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
  });
  app.post("/api/multiremi/issues", async (c) => {
    const policyDenied = denyRestrictedTaskIssueCreation(c, store);
    if (policyDenied) return policyDenied;
    const body = await readJson<CreateIssueWithTaskInput>(c);
    const workspaceId = resolveRequestWorkspaceId(c, store, body.workspaceId ?? body.workspace_id);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const assigneeType = body.assigneeType ?? body.assignee_type ?? (body.agentId ? "agent" : null);
    assertRuntimeWorkspaceAccess(c, store, body.runtimeWorkspaceId ?? body.runtime_workspace_id, workspaceId);
    const assigneeId = body.assigneeId ?? body.assignee_id ?? body.agentId ?? null;
    const dispatchDenied = denySideSessionAssigneeDispatch(c, store, workspaceId, assigneeType, assigneeId);
    if (dispatchDenied) return dispatchDenied;
    // MUL-448 B3: a credentialed request cannot pick the lineage that decides
    // whether this create is served from the generated-issue cache. Anonymous
    // compatibility mode keeps the historical body pass-through.
    const sourceStripped = isAnonymousCompatibilityRequest(c)
      ? body
      : stripServerOwnedIssueSourceFields(body);
    // MUL-448 B4: the body's `created_by` is dropped, but this route does not
    // stamp the caller either - main records no creator here, and creator
    // ownership feeds share management and automatic subscription.
    let issue: MultiremiIssue;
    try {
      issue = store.createIssue({
        ...stripServerOwnedIssueCreateFields(sourceStripped),
        blockedBy: body.blockedBy ?? body.blocked_by,
        workspaceId,
        assigneeType: null,
        assignee_type: null,
        assigneeId: null,
        assignee_id: null,
      });
    } catch (err) {
      // MUL-400 E3 (QA round 2, blocker 4): the three `blocked_by` rejections
      // answer with the dependency error contract, matching the dependency
      // routes. Without this the native route surfaced them as 500.
      const dependencyResponse = issueDependencyErrorResponse(c, err);
      if (dependencyResponse) return dependencyResponse;
      throw err;
    }
    let task = null;
    if (assigneeId) {
      const assigned = store.assignIssue(issue.id, {
        assigneeType,
        assigneeId,
        prompt: body.prompt ?? body.title,
      });
      return c.json({
        issue: assigned.issue,
        task: assigned.task ? taskPublicResponse(assigned.task) : null,
      }, 201);
    }
    return c.json({ issue, task }, 201);
  });
  app.post("/api/issues", async (c) => {
    const policyDenied = denyRestrictedTaskIssueCreation(c, store);
    if (policyDenied) return policyDenied;
    const body = await readJsonStrict<CreateIssueWithTaskInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (!String(body.title ?? "").trim()) return c.json({ error: "title is required" }, 400);
    const workspaceId = resolveRequestWorkspaceId(c, store, body.workspace_id ?? c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    try {
      const issueInput = withIssueCreateRequestContext(c, { ...body, workspace_id: workspaceId }, store);
      assertRuntimeWorkspaceAccess(c, store, issueInput.runtime_workspace_id, workspaceId);
      const denied = denyCurrentUserWorkspaceAccess(c, store, issueInput.workspace_id ?? "local");
      if (denied) return denied;
      const dispatchDenied = String(issueInput.status ?? "todo").trim() === "backlog" ? null
        : denySideSessionAssigneeDispatch(c, store, issueInput.workspace_id ?? "local", issueInput.assignee_type, issueInput.assignee_id);
      if (dispatchDenied) return dispatchDenied;
      const sourceIssueId = issueInput.source_issue_id ?? null;
      if (sourceIssueId) {
        const existing = store.findGeneratedIssueByTitle(sourceIssueId, issueInput.title);
        if (existing) {
          try {
            store.prepareFeishuIssueTopicWithinTransaction(existing);
          } catch (error) {
            log.warn(
              `Feishu issue topic creation skipped for ${existing.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return c.json(existingIssueDispatchResponse(store, existing), 200);
        }
      }
      const issue = store.createIssue(issueInput);
      try {
        store.prepareFeishuIssueTopicWithinTransaction(issue);
      } catch (error) {
        log.warn(
          `Feishu issue topic creation skipped for ${issue.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      publishIssueCreated(c, store, issue, issueCompatibilityResponse(issue));
      // go-compat (maybeEnqueueOnAssign): creating an issue assigned to an agent/squad
      // dispatches a task, unless it's in backlog (a parking lot for pre-assignment).
      // If no runnable agent is available the assignment stands without a task, matching
      // the Go server's "not ready → skip" behavior — but the outcome is never silent:
      // the response always says whether a task was dispatched and why not, and a
      // dispatch failure leaves a dispatch_skipped activity on the issue.
      let finalIssue = issue;
      let task: { id: string } | null = null;
      let dispatchSkippedReason: string | null = null;
      let dispatchError: string | null = null;
      const pendingPrerequisites = store.listUnmetPrerequisites(issue.id);
      if (pendingPrerequisites.length > 0) {
        // MUL-400 E3 gate 3: the issue parked itself in backlog. Say why, rather
        // than reporting the generic backlog_status.
        dispatchSkippedReason = "dependencies_unmet";
      } else if (!issue.assigneeType || !issue.assigneeId) {
        dispatchSkippedReason = "no_assignee";
      } else if (issue.status === "backlog") {
        dispatchSkippedReason = "backlog_status";
      } else {
        try {
          const assigned = store.assignIssue(issue.id, {
            assigneeType: issue.assigneeType,
            assigneeId: issue.assigneeId,
          });
          finalIssue = assigned.issue;
          task = assigned.task;
          // A member assignee gets an inbox notification instead of a task.
          if (!task) dispatchSkippedReason = "member_assignee";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          dispatchSkippedReason = message.startsWith("No runnable agent") ? "no_runnable_agent" : "assign_failed";
          dispatchError = message;
          log.warn(`assign-on-create dispatch skipped for ${issue.id}: ${message}`);
          store.recordIssueDispatchSkipped(issue.id, {
            reason: dispatchSkippedReason,
            error: message,
            assigneeType: issue.assigneeType,
            assigneeId: issue.assigneeId,
          });
        }
      }
      const response: Record<string, unknown> = {
        ...issueCompatibilityResponse(finalIssue),
        task_id: task?.id ?? null,
        dispatch_status: task ? "dispatched" : "skipped",
        dispatch_skipped_reason: task ? null : dispatchSkippedReason,
      };
      if (dispatchError) response.dispatch_error = dispatchError;
      return c.json(response, 201);
    } catch (err) {
      // MUL-400 E3 (QA round 2, blocker 4): a rejected `blocked_by` is a
      // dependency error, not an issue error — "prerequisite not found" and
      // "prerequisite in another workspace" have no issue-shaped mapping and
      // used to fall through as 500. Try the dependency mapping first so the
      // three rejections answer the same codes the dependency routes use.
      const dependencyResponse = issueDependencyErrorResponse(c, err);
      if (dependencyResponse) return dependencyResponse;
      const response = issueErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.post("/api/multiremi/issues/quick-create", async (c) => {
    const dispatchDenied = denySideSessionAgentDispatch(c, store);
    if (dispatchDenied) return dispatchDenied;
    const policyDenied = denyRestrictedTaskIssueCreation(c, store);
    if (policyDenied) return policyDenied;
    const body = await readJson<QuickCreateIssueInput>(c);
    const workspaceId = resolveRequestWorkspaceId(c, store, body.workspaceId ?? body.workspace_id);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    assertRuntimeWorkspaceAccess(c, store, body.runtimeWorkspaceId ?? body.runtime_workspace_id, workspaceId);
    // MUL-448 B4: the body's requester is dropped and no credentialed requester
    // is stamped on, so this route records no creator exactly as main does.
    const result = safeQuickCreateIssue(store, {
      ...stripServerOwnedQuickCreateFields(body),
      workspaceId,
    });
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json({
      taskId: result.task.id,
      task_id: result.task.id,
      issue: result.issue,
      task: taskPublicResponse(result.task),
    }, 202);
  });
  app.post("/api/issues/quick-create", async (c) => {
    const dispatchDenied = denySideSessionAgentDispatch(c, store);
    if (dispatchDenied) return dispatchDenied;
    const policyDenied = denyRestrictedTaskIssueCreation(c, store);
    if (policyDenied) return policyDenied;
    const body = await readJson<QuickCreateIssueInput>(c);
    const workspaceId = resolveRequestWorkspaceId(c, store, body.workspace_id ?? c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const input = {
      ...stripServerOwnedQuickCreateFields(issueQuickCreateCompatibilityInput(body)),
      workspaceId,
    };
    const denied = denyCurrentUserWorkspaceAccess(c, store, input.workspaceId ?? input.workspace_id ?? "local");
    if (denied) return denied;
    assertRuntimeWorkspaceAccess(c, store, input.runtimeWorkspaceId ?? input.runtime_workspace_id, input.workspaceId ?? input.workspace_id ?? "local");
    const result = safeQuickCreateIssue(store, input);
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json({
      task_id: result.task.id,
      issue: issueCompatibilityResponse(result.issue),
    }, 202);
  });
  app.get("/api/issues/:id/generated-issues", (c) => {
    const source = issueFromParam(store, c, "id", "compat");
    if (!source) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, source.workspaceId);
    if (denied) return denied;
    const issues = store.listGeneratedIssues(source.id).map((issue) => issueCompatibilityResponse(issue));
    return c.json({ issues, total: issues.length });
  });
  app.get("/api/multiremi/issues/:id", (c) => {
    const issueRef = issueFromParam(store, c);
    const issue = issueRef ? store.getIssueWithTasks(issueRef.id) : null;
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const tasks = issue.tasks.filter((task) => canCurrentUserAccessChatTask(c, store, task)).map(taskPublicResponse);
    const comments = store.listIssueComments(issue.id);
    const waitingOn = store.getIssueWaitingOn(issue.id);
    return c.json({
      // MUL-400 E1: `child_count` is a plain COUNT (no child bodies), so the
      // detail surfaces can show "N sub-issues" without the MUL-385 cost.
      issue: {
        ...issue,
        tasks,
        child_count: issue.childProgress.total,
        parent_done_grant: store.issueParentDoneGrantView(issue),
        pending_decision_count: store.countPendingIssueDecisions(issue.id),
        // MUL-400 E3: unmet prerequisites stop dispatch, so the detail surface
        // needs them in the same payload.
        waiting_on: waitingOn.unmet.map((row) => row.key),
      },
      children: issue.children.map(withBlockedBy(store)),
      childProgress: issue.childProgress,
      dependencies: issue.dependencies,
      waitingOn,
      waiting_on: waitingOn,
      comments,
      activity: store.listIssueActivity(issue.id),
    });
  });
  app.get("/api/issues/:id", (c) => {
    // MUL-385: `issueFromParam` already returns the hydrated issue. The compat
    // body only needs labels, reactions and attachments, so loading tasks,
    // children, child progress and dependencies here was pure overhead — the
    // native `/api/multiremi/issues/:id` route keeps using `getIssueWithTasks`.
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    // `issueFromParam` returns a hydrated issue: its labels are already loaded.
    return c.json({
      ...issueDetailCompatibilityResponse(store, issue, { labelsAlreadyHydrated: true }),
      pending_decision_count: store.countPendingIssueDecisions(issue.id),
    });
  });
  app.get("/api/issues/:id/workspace", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const workspace = store.getIssueWorkspace(issue.id);
    if (!workspace) return c.json({ workspace: null });
    return c.json({
      workspace: {
        issue_id: workspace.issueId,
        workspace_id: workspace.workspaceId,
        issue_key: workspace.issueKey,
        runtime_id: workspace.runtimeId,
        runtime_name: workspace.runtimeName,
        runtime_status: workspace.runtimeStatus,
        runtime_provider: workspace.runtimeProvider,
        runtime_mode: workspace.runtimeMode,
        runtime_device_info: workspace.runtimeDeviceInfo,
        runtime_daemon_id: workspace.runtimeDaemonId,
        runtime_machine_name: workspace.runtimeMachineName,
        root_path: workspace.rootPath,
        branch_name: workspace.branchName,
        status: workspace.runtimeStatus === "offline" && workspace.status !== "cleaned" ? "runtime_offline" : workspace.status,
        repos: workspace.repos.map((repo) => ({
          repo_url: repo.repoUrl,
          repo_name: repo.repoName,
          worktree_path: repo.worktreePath,
          branch_name: repo.branchName,
          base_ref: repo.baseRef,
          base_commit: repo.baseCommit ?? null,
          status: repo.status,
          dirty: repo.dirty,
          error: repo.error,
        })),
        last_task_id: workspace.lastTaskId,
        cleaned_at: workspace.cleanedAt,
        created_at: workspace.createdAt,
        updated_at: workspace.updatedAt,
      },
    });
  });
  app.post("/api/issues/:id/workspace/abandon", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const result = store.abandonIssueWorkspace(issue.id, issue.workspaceId);
    if (result.status === "not_found") return c.json({ error: "issue workspace not found" }, 404);
    if (result.status === "runtime_attached") {
      return c.json({
        error: "issue workspace still belongs to a Runtime; use runtime deletion or daemon retirement to abandon it",
        code: "issue_workspace_runtime_attached",
        runtime_id: result.runtimeId,
      }, 409);
    }
    return c.json({
      status: "ok",
      issue_workspaces_abandoned: result.issueWorkspacesAbandoned,
      workspace: {
        issue_id: result.workspace.issueId,
        runtime_id: result.workspace.runtimeId,
        status: result.workspace.status,
        cleaned_at: result.workspace.cleanedAt,
      },
    });
  });
  app.get("/api/multiremi/issues/:id/timeline", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    let response;
    try {
      response = issueTimelineResponse(store, issue.id, c);
    } catch (error) {
      if (error instanceof IssueTimelineRequestError) return c.json({ error: error.message }, 400);
      throw error;
    }
    if (!response) return c.json({ error: "issue not found" }, 404);
    return c.json(response);
  });
  app.get("/api/issues/:id/timeline", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    let response;
    try {
      response = issueTimelineCompatibilityResponse(store, issue.id, c, { skipIssueExistenceCheck: true });
    } catch (error) {
      if (error instanceof IssueTimelineRequestError) return c.json({ error: error.message }, 400);
      throw error;
    }
    if (!response) return c.json({ error: "issue not found" }, 404);
    return c.json(response);
  });
  app.get("/api/issues/:id/active-task", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const tasks = store.listTasksForIssue(issue.id)
      .filter((task) => canCurrentUserAccessChatTask(c, store, task))
      .filter((task) => isActiveTaskStatus(task.status))
      .map((task) => taskCompatibilityResponse(
        task,
        null,
        task.status === "queued" || task.status === "dispatched"
          ? store.getTaskQueueBlocker(task.id)
          : null,
      ));
    return c.json({ tasks });
  });
  app.get("/api/issues/:id/task-runs", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listTasksForIssue(issue.id)
      .filter((task) => canCurrentUserAccessChatTask(c, store, task))
      .map((task) => taskCompatibilityResponse(
        task,
        null,
        task.status === "queued" || task.status === "dispatched"
          ? store.getTaskQueueBlocker(task.id)
          : null,
      )));
  });
  app.get("/api/issues/:id/usage", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(issueUsageResponse(store, issue));
  });
  app.post("/api/issues/:id/rerun", async (c) => {
    const dispatchDenied = denySideSessionAgentDispatch(c, store);
    if (dispatchDenied) return dispatchDenied;
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ agent_id?: string; agentId?: string; prompt?: string }>(c);
    const human = humanRequestActor(c);
    const result = safeRerunIssue(store, issue.id, {
      ...body,
      parentTaskId: currentTaskParentId(c),
      dependencyForce: human
        ? { source: "rerun", actorMemberId: human.memberId }
        : undefined,
    });
    if ("error" in result) {
      // MUL-400 E3: the task-creation gate reports the same 409 code as the
      // status gate, so a client handles both with one branch.
      return result.code
        ? c.json({ error: result.error, code: result.code, unmet: result.unmet ?? [] }, result.status)
        : c.json({ error: result.error }, result.status);
    }
    return c.json(taskCompatibilityResponse(result.task), 202);
  });
  app.post("/api/issues/:id/tasks/:taskId/cancel", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const task = issue ? store.getTaskByRef(c.req.param("taskId"), { issueId: issue.id }) : null;
    if (!issue || !task || task.issueId !== issue.id) return c.json({ error: "task not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const taskDenied = denyCurrentUserWorkspaceAccess(c, store, task.workspaceId);
    if (taskDenied) return taskDenied;
    if (!canCurrentUserAccessChatTask(c, store, task)) return c.json({ error: "forbidden" }, 403);
    return c.json(taskCompatibilityResponse(store.cancelTask(task.id)));
  });
  app.post("/api/issues/:id/squad-evaluated", async (c) => {
    const body = await readJson<{
      outcome?: string;
      reason?: string | null;
      task_id?: string | null;
      taskId?: string | null;
      actor_id?: string | null;
      actorId?: string | null;
    }>(c);
    try {
      const issue = issueFromParam(store, c, "id", "compat");
      if (!issue) return c.json({ error: "issue not found" }, 404);
      const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
      if (denied) return denied;
      // MUL-448 B2: the evaluator is the credential, never the request body.
      //
      // `recordSquadLeaderEvaluation` falls back to the squad's leader agent when
      // no actor is given, so a member PAT posting `actor_id=<leader>` (or
      // nothing at all) was recorded as `agent/leader` with a 201. Only a task
      // token may name the evaluating agent; a credentialed non-task request has
      // no agent identity at all and is rejected here, before any write. The
      // header/body fallbacks remain for the anonymous compatibility mode, where
      // they are the historical behaviour.
      const taskToken = currentTaskAccessToken(c);
      const anonymousCompat = isAnonymousCompatibilityRequest(c);
      // Anonymous compatibility mode keeps main's behaviour exactly, including
      // the store's "no actor given -> the squad leader" default. A credentialed
      // request that is not a task token has no agent identity to evaluate with.
      if (!taskToken?.agentId && !anonymousCompat) {
        return c.json({ error: "only the squad leader agent can record evaluations" }, 403);
      }
      const activity = store.recordSquadLeaderEvaluation(issue.id, {
        outcome: body.outcome ?? "",
        reason: body.reason ?? null,
        taskId: taskToken?.taskId
          ?? (anonymousCompat ? c.req.header("X-Task-ID") ?? body.task_id ?? body.taskId ?? null : null),
        actorId: taskToken?.agentId
          ?? (anonymousCompat ? c.req.header("X-Agent-ID") ?? body.actor_id ?? body.actorId ?? null : null),
      });
      return c.json({
        ...activity,
        issue_id: activity.issueId,
        actor_type: activity.actorType,
        actor_id: activity.actorId,
        created_at: activity.createdAt,
      }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Issue not found")) return c.json({ error: "issue not found" }, 404);
      if (message === "squad not found") return c.json({ error: message }, 404);
      if (message === "only the squad leader agent can record evaluations") return c.json({ error: message }, 403);
      return c.json({ error: message }, 400);
    }
  });
  app.get("/api/multiremi/issues/:id/children", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const children = store.listChildIssues(issue.id);
    return c.json({ issues: children.map(withBlockedBy(store)), total: children.length });
  });
  app.get("/api/issues/:id/children", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    // MUL-400 E3: every child row says what it is still waiting on, so the
    // sidebar can render the hold without a second round trip per child.
    const children = store.listChildIssues(issue.id);
    return c.json({
      issues: children.map((child) => ({
        ...issueCompatibilityResponse(child),
        blocked_by: store.listUnmetPrerequisites(child.id).map((row) => row.key),
      })),
      total: children.length,
    });
  });
  app.get("/api/issues/:id/decisions", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listIssueDecisions(issue.id));
  });
  app.post("/api/issues/:id/decisions", async (c) => {
    const source = issueFromParam(store, c, "id", "compat");
    if (!source) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, source.workspaceId);
    if (denied) return denied;
    const actor = decisionActor(c, store, source.workspaceId);
    if (!actor) return c.json({ error: "member or issue task credential required" }, 403);
    const body = await readJsonStrict<CreateIssueDecisionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const input: CreateIssueDecisionInput = {
        kind: body.kind, title: body.title, body: body.body,
        options: body.options,
      };
      return c.json({ decision: store.createIssueDecision(source.id, input, actor) }, 201);
    } catch (error) { return decisionError(c, error); }
  });
  app.post("/api/issues/:id/decisions/:decisionId/answer", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const actor = decisionActor(c, store, issue.workspaceId);
    if (!actor) return c.json({ error: "member or parent owner task credential required" }, 403);
    const body = await readJsonStrict<Record<string, unknown>>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json({ decision: store.answerIssueDecision(issue.id, c.req.param("decisionId"), {
        answer: String(body.answer ?? body.text ?? ""),
        reason: String(body.reason ?? ""),
        overturn: String(body.overturn ?? body.how_to_overturn ?? ""),
      }, actor) });
    } catch (error) { return decisionError(c, error); }
  });
  app.post("/api/issues/:id/decisions/:decisionId/escalate", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const actor = decisionActor(c, store, issue.workspaceId);
    if (!actor) return c.json({ error: "member or parent owner task credential required" }, 403);
    try {
      return c.json({ decision: store.escalateIssueDecision(issue.id, c.req.param("decisionId"), actor) });
    } catch (error) { return decisionError(c, error); }
  });
  app.post("/api/issues/:id/decisions/:decisionId/withdraw", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const actor = decisionActor(c, store, issue.workspaceId);
    if (!actor) return c.json({ error: "member or requesting task credential required" }, 403);
    try {
      return c.json({ decision: store.withdrawIssueDecision(issue.id, c.req.param("decisionId"), actor) });
    } catch (error) { return decisionError(c, error); }
  });
  app.get("/api/multiremi/issues/:id/dependencies", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const dependencies = store.listIssueDependencies(issue.id);
    return c.json({ dependencies, total: dependencies.length });
  });
  app.get("/api/issues/:id/dependencies", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const dependencies = store.listIssueDependencies(issue.id).map(issueDependencyCompatibilityResponse);
    return c.json({ dependencies, total: dependencies.length });
  });
  app.post("/api/multiremi/issues/:id/dependencies", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateIssueDependencyInput>(c);
    try {
      const dependency = store.createIssueDependency(issue.id, body, issueMutationActivity(c));
      // MUL-400 E3: answer with the row as seen from this issue, so the caller
      // can render the direction without recomputing it.
      const view = store.listIssueDependencies(issue.id).find((row) => row.id === dependency.id);
      return c.json({ dependency: view ?? dependency }, 201);
    } catch (err) {
      const response = issueDependencyErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.post("/api/issues/:id/dependencies", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateIssueDependencyInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json({
        dependency: issueDependencyCompatibilityResponse(
          store.createIssueDependency(issue.id, body, issueMutationActivity(c)),
        ),
      }, 201);
    } catch (err) {
      const response = issueDependencyErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.delete("/api/multiremi/issues/:id/dependencies/:dependencyId", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    store.deleteIssueDependency(issue.id, c.req.param("dependencyId"), issueMutationActivity(c));
    return c.json({ ok: true });
  });
  app.delete("/api/issues/:id/dependencies/:dependencyId", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    try {
      store.deleteIssueDependency(issue.id, c.req.param("dependencyId"), issueMutationActivity(c));
      return c.json({ status: "ok" });
    } catch (err) {
      const response = issueDependencyErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  for (const prefix of ["/api/issues/:id", "/api/multiremi/issues/:id"]) {
    app.post(`${prefix}/parent-done-grant`, (c) => {
      const issue = issueFromParam(store, c, "id", prefix.startsWith("/api/multiremi") ? undefined : "compat");
      if (!issue) return c.json({ error: "issue not found" }, 404);
      const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
      if (denied) return denied;
      if (issueMutationActivity(c).actorType !== "member" || currentTaskAccessToken(c)) {
        return c.json({ error: "Only a member can authorize parent closure", code: "parent_done_grant_requires_member" }, 403);
      }
      try {
        const updated = store.grantParentDone(issue.id, authenticatedRequestUserId(c) ?? currentRequestUserId(c));
        return c.json({ issue: updated, parent_done_grant: store.issueParentDoneGrantView(updated) });
      } catch (error) {
        if (error instanceof ParentDoneGrantOwnerError) return c.json({ error: error.message, code: error.code }, 409);
        throw error;
      }
    });
    app.delete(`${prefix}/parent-done-grant`, (c) => {
      const issue = issueFromParam(store, c, "id", prefix.startsWith("/api/multiremi") ? undefined : "compat");
      if (!issue) return c.json({ error: "issue not found" }, 404);
      const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
      if (denied) return denied;
      if (issueMutationActivity(c).actorType !== "member" || currentTaskAccessToken(c)) {
        return c.json({ error: "Only a member can revoke parent closure", code: "parent_done_grant_requires_member" }, 403);
      }
      const updated = store.revokeParentDone(issue.id, authenticatedRequestUserId(c) ?? currentRequestUserId(c));
      return c.json({ issue: updated, parent_done_grant: store.issueParentDoneGrantView(updated) });
    });
  }
  app.patch("/api/multiremi/issues/:id", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<UpdateIssueInput>(c);
    // MUL-400 E1: `force` is member-only; a run that sends it is rejected before
    // any other validation so the guard cannot be bypassed by an agent.
    const forceDenied = denyTaskIdentityIssueForce(c, body);
    if (forceDenied) return forceDenied;
    const { actorType, actorId } = issueMutationActivity(c);
    // S1: drop both spellings of the fields the server owns before stamping, so
    // a body cannot smuggle `parent_task_id` / `actor_type` past the `??` reads.
    const input = {
      ...stripServerOwnedIssueUpdateFields(body),
      actorType,
      actorId,
      parentTaskId: currentTaskParentId(c),
    };
    assertRuntimeWorkspaceAccess(c, store, body.runtimeWorkspaceId ?? body.runtime_workspace_id, issue.workspaceId);
    const dispatchDenied = denySideSessionIssueUpdate(c, store, issue, input);
    if (dispatchDenied) return dispatchDenied;
    try {
      const outcome = store.updateIssueWithOutcome(issue.id, input);
      const { issue: updated, cancelledTasks, handledForcedStart } = outcome;
      lockAutoTitleAfterHumanEdit(c, updated, input);
      // MUL-400 E3 (QA round 2, blocker 2): a forced start already dispatched
      // inside the store. Dispatch here as well would cancel that fresh round and
      // queue a second one, so the route defers to the store in that case.
      const dispatched = handledForcedStart
        ? { issue: updated, task: null, cancelledTasks: 0 }
        // QA round 4: the decision uses the PRE-WRITE snapshot the store took
        // inside its row lock, never the route's earlier read. A concurrent
        // automatic start can commit between the route's read and this call, and
        // the stale `backlog -> todo` answer made this path dispatch a second
        // round, cancelling the one the automatic start had just queued.
        : maybeDispatchOnIssueUpdate(store, outcome.previous, updated, input);
      return c.json({ issue: dispatched.issue, cancelled_tasks: cancelledTasks + dispatched.cancelledTasks });
    } catch (err) {
      // MUL-400 E3 (QA round 3, blocker 3): the store refuses a transition that
      // leaves `backlog` with unmet prerequisites by throwing
      // `IssueDependencyError`. The compatibility PATCH already answers 409
      // `dependencies_unmet`; the native route used to let it escape and become
      // a bare 500 with no code, so a client could not tell a hold from a fault.
      // Nothing was written: the store throws before its UPDATE.
      const dependencyResponse = issueDependencyErrorResponse(c, err);
      if (dependencyResponse) return dependencyResponse;
      const response = issueErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  const updateIssueCompatibilityRoute = async (c: Context) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<UpdateIssueInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const forceDenied = denyTaskIdentityIssueForce(c, body);
    if (forceDenied) return forceDenied;
    const { actorType, actorId } = issueMutationActivity(c);
    const input = {
      ...stripServerOwnedIssueUpdateFields(issueUpdateCompatibilityInput(body)),
      actorType,
      actorId,
      parentTaskId: currentTaskParentId(c),
    };
    const dispatchDenied = denySideSessionIssueUpdate(c, store, issue, input);
    if (dispatchDenied) return dispatchDenied;
    try {
      assertRuntimeWorkspaceAccess(c, store, input.runtimeWorkspaceId ?? input.runtime_workspace_id, issue.workspaceId);
      const outcome = store.updateIssueWithOutcome(issue.id, input);
      const { issue: updated, cancelledTasks, handledForcedStart } = outcome;
      lockAutoTitleAfterHumanEdit(c, updated, input);
      // See the native PATCH route: the store already dispatched a forced start,
      // and the pre-write snapshot only the store can see decides the rest.
      const dispatched = handledForcedStart
        ? { issue: updated, task: null, cancelledTasks: 0 }
        : maybeDispatchOnIssueUpdate(store, outcome.previous, updated, input);
      const response = {
        ...issueCompatibilityResponse(dispatched.issue),
        task_id: dispatched.task?.id ?? null,
        cancelled_tasks: cancelledTasks + dispatched.cancelledTasks,
      };
      publishIssueUpdated(c, store, issue, dispatched.issue, input, response);
      return c.json(response);
    } catch (err) {
      const response = issueErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  };
  app.patch("/api/issues/:id", updateIssueCompatibilityRoute);
  app.put("/api/issues/:id", updateIssueCompatibilityRoute);
  app.post("/api/multiremi/issues/:id/retitle", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ apply?: unknown }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (body.apply !== undefined && typeof body.apply !== "boolean") {
      return c.json({ error: "apply must be a boolean" }, 400);
    }
    const result = await deps.issueRetitle(store, issue.id, {
      source: "manual",
      apply: body.apply !== false,
    });
    const response = {
      title: result.title,
      previous_title: result.previousTitle,
      applied: result.applied,
      reason: result.reason,
    };
    if (result.reason === "gateway_unconfigured") return c.json(response, 422);
    return c.json(response);
  });
  app.post("/api/multiremi/issues/:id/restore", (c) => {
    const previous = issueFromParam(store, c);
    if (!previous) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, previous.workspaceId);
    if (denied) return denied;
    const issue = store.restoreIssue(previous.id);
    publishIssueUpdated(c, store, previous, issue, {}, issueCompatibilityResponse(issue));
    return c.json({ issue });
  });
  app.post("/api/issues/:id/restore", (c) => {
    const previous = issueFromParam(store, c, "id", "compat");
    if (!previous) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, previous.workspaceId);
    if (denied) return denied;
    const issue = store.restoreIssue(previous.id);
    const response = issueCompatibilityResponse(issue);
    publishIssueUpdated(c, store, previous, issue, {}, response);
    return c.json(response);
  });
  app.delete("/api/multiremi/issues/:id", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = issueDeleteAccess(c, issue.workspaceId);
    if (denied) return denied;
    try {
      if (!(await deleteIssueWithArchives(issue.id))) return c.json({ error: "issue not found" }, 404);
      return c.json({ ok: true });
    } catch (error) {
      if (isIssueDeletionConflict(error)) {
        return c.json({ error: error.message, code: error.code }, 409);
      }
      throw error;
    }
  });
  app.delete("/api/issues/:id", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = issueDeleteAccess(c, issue.workspaceId);
    if (denied) return denied;
    try {
      if (!(await deleteIssueWithArchives(issue.id))) return c.json({ error: "issue not found" }, 404);
      return c.body(null, 204);
    } catch (error) {
      if (isIssueDeletionConflict(error)) {
        return c.json({ error: error.message, code: error.code }, 409);
      }
      throw error;
    }
  });
  app.post("/api/multiremi/issues/:id/assign", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<AssignIssueInput & { force?: unknown }>(c);
    // MUL-400 E3: assignment never overrides the dependency gate. `force` is a
    // server-internal dispatch option (see AssignIssueOptions) that only the
    // audited member status write sets, so a request body carrying it is ignored
    // rather than honored: the caller changes nothing and gets the hold behavior
    // of a plain assign.
    delete body.force;
    const dispatchDenied = denySideSessionAssigneeDispatch(c, store, issue.workspaceId,
      body.assigneeType ?? body.assignee_type, body.assigneeId ?? body.assignee_id);
    if (dispatchDenied) return dispatchDenied;
    const { actorType, actorId } = issueMutationActivity(c);
    // MUL-448: strip both lineage spellings before stamping, so a member body
    // cannot supply the parent task that the credential did not.
    const result = safeAssignIssue(store, issue.id, {
      ...stripServerOwnedAssignFields(body),
      actorType,
      actorId,
      parentTaskId: currentTaskParentId(c),
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({
      issue: result.issue,
      cancelled_tasks: result.cancelledTasks,
      task: result.task ? taskPublicResponse(result.task) : null,
    });
  });
  app.get("/api/sessions/:sessionId", (c) => {
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, session.workspaceId);
    if (denied) return denied;
    return c.json(issueSessionCompatibilityResponse(
      session,
      store.listSessionParticipants(session.id),
    ));
  });
  const logSessionAccess = (c: Context): string | Response => {
    const sessionId = c.req.param("sessionId") ?? "";
    const issueSession = store.getIssueSession(sessionId);
    if (issueSession) {
      return denyCurrentUserWorkspaceAccess(c, store, issueSession.workspaceId) ?? sessionId;
    }
    const chat = loadChatSessionForCurrentUser(c, store, sessionId);
    return chat instanceof Response ? chat : chat.session.id;
  };
  app.get("/api/sessions/:sessionId/log/locate", (c) => {
    const sessionId = logSessionAccess(c);
    if (sessionId instanceof Response) return sessionId;
    const id = c.req.query("id");
    if (!id) return c.json({ error: "id is required" }, 400);
    const location = store.locateConversationLogEntry(sessionId, id);
    return location ? c.json(location) : c.json({ error: "entry not found" }, 404);
  });
  app.get("/api/sessions/:sessionId/log/entry", (c) => {
    const sessionId = logSessionAccess(c);
    if (sessionId instanceof Response) return sessionId;
    const rawSeq = c.req.query("seq");
    const id = c.req.query("id");
    if ((rawSeq == null) === (id == null)) return c.json({ error: "exactly one of seq or id is required" }, 400);
    const seq = rawSeq == null ? store.locateConversationLogEntry(sessionId, id!)?.seq
      : /^(0|[1-9]\d*)$/.test(rawSeq) ? Number(rawSeq) : NaN;
    if (rawSeq != null && (!Number.isSafeInteger(seq) || seq! < 0)) return c.json({ error: "invalid seq" }, 400);
    if (seq == null) return c.json({ error: "entry not found" }, 404);
    const entry = store.getConversationLogEntry(sessionId, seq);
    if (!entry || entry.visibility !== "shown" || entry.deleted_at !== null) return c.json({ error: "entry not found" }, 404);
    const envelope = entry.metadata.envelope;
    const recipient = envelope?.to;
    const agentId = envelope?.recipient_agent_id
      ?? (recipient?.role === "agent" && recipient.issueSessionId === sessionId
        ? recipient.agentId
        : recipient?.role === "chat" && recipient.chatSessionId === sessionId ? recipient.agentId : null);
    const delivered: boolean | null = agentId === null ? null : (
      store.getSessionAgentMaxCursorSeq(sessionId, agentId) >= entry.seq
      || store.listConversationLogShown(sessionId, { sinceSeq: entry.seq }).some((turn) => {
        if (turn.kind !== "turn" || turn.author_id !== agentId) return false;
        const receipt = turn.metadata.inbox;
        return receipt !== null && typeof receipt === "object"
          && Number((receipt as Record<string, unknown>).delivered_to_seq) >= entry.seq;
      })
    );
    return c.json({ ...entry, delivered });
  });
  app.get("/api/sessions/:sessionId/log", (c) => {
    const sessionId = logSessionAccess(c);
    if (sessionId instanceof Response) return sessionId;
    const readNumber = (name: string): number | null | undefined => {
      const raw = c.req.query(name);
      if (raw == null) return undefined;
      const value = Number(raw);
      return raw !== "" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    const anchor = readNumber("anchor");
    const before = readNumber("before");
    const after = readNumber("after");
    if (anchor === null || before === null || after === null || (before ?? 0) + (after ?? 0) > 100) {
      return c.json({ error: "invalid log window" }, 400);
    }
    return c.json(store.conversationLogWindow(sessionId, { anchor, before, after }));
  });
  app.get("/api/sessions/:sessionId/inherited-context", (c) => {
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, session.workspaceId);
    if (denied) return denied;
    return c.json(store.getSessionInheritedContext(session.id));
  });
  app.get("/api/issues/:id/sessions", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(issueSessionsCompatibilityResponse(
      store,
      issue.id,
      c.req.query("include_archived") === "true",
      { skipIssueExistenceCheck: true },
    ));
  });
  app.post("/api/issues/:id/sessions", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateIssueSessionInput & { inheritMode?: unknown; inherit_mode?: unknown }>(c);
    const creator = issueSubscriberCaller(c);
    try {
      // Validate both spellings so contradictory inheritance requests are not ignored.
      const parentSessionId = body.parentSessionId ?? body.parent_session_id;
      const hasParent = typeof parentSessionId === "string" && Boolean(parentSessionId.trim());
      const inheritMode = body.inheritMode ?? body.inherit_mode ?? (hasParent ? "snapshot" : "none");
      for (const requestedMode of [body.inheritMode, body.inherit_mode]) {
        if (requestedMode !== undefined && (requestedMode !== inheritMode
          || (hasParent ? requestedMode !== "snapshot" && requestedMode !== "follow" : requestedMode !== "none"))) {
          throw new Error(`inherit_mode must be ${hasParent ? "snapshot or follow" : "none"} for this parent_session_id; inheritMode and inherit_mode must agree`);
        }
      }
      const session = store.createIssueSession(issue.id, {
        ...body,
        createdByType: creator.actorType,
        createdById: creator.actorId,
      });
      return c.json(issueSessionCompatibilityResponse(
        session,
        store.listSessionParticipants(session.id),
      ), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get("/api/issues/:id/sessions/:sessionId", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!issue || !session || session.issueId !== issue.id) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(issueSessionCompatibilityResponse(
      session,
      store.listSessionParticipants(session.id),
    ));
  });
  app.patch("/api/issues/:id/sessions/:sessionId", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!issue || !session || session.issueId !== issue.id) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<UpdateIssueSessionInput>(c);
    try {
      return c.json(issueSessionCompatibilityResponse(
        store.updateIssueSession(session.id, body),
        store.listSessionParticipants(session.id),
      ));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get("/api/issues/:id/sessions/:sessionId/participants", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!issue || !session || session.issueId !== issue.id) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listSessionParticipants(session.id).map(sessionParticipantCompatibilityResponse));
  });
  app.post("/api/issues/:id/sessions/:sessionId/participants", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!issue || !session || session.issueId !== issue.id) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<AddSessionParticipantInput>(c);
    const participantType = body.participantType ?? body.participant_type;
    const participantId = body.participantId ?? body.participant_id;
    if (participantType === "agent" && participantId) {
      const agent = store.getAgent(participantId);
      if (!agent || !canCurrentUserAccessAgent(c, store, agent)) {
        return c.json({ error: "you do not have access to this agent" }, 403);
      }
    }
    try {
      return c.json(sessionParticipantCompatibilityResponse(store.addSessionParticipant(session.id, body)), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.delete("/api/issues/:id/sessions/:sessionId/participants/:participantType/:participantId", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!issue || !session || session.issueId !== issue.id) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    store.removeSessionParticipant(session.id, c.req.param("participantType"), c.req.param("participantId"));
    return c.body(null, 204);
  });
  app.get("/api/issues/:id/sessions/:sessionId/events", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!issue || !session || session.issueId !== issue.id) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    // Task-scoped agents may read their current Session, but cannot use this
    // endpoint to pull sibling transcripts. Cross-session agent access is via
    // the explicit published-results endpoint below.
    const sinceSeq = Number(c.req.query("since_seq") ?? 0);
    const rawToSeq = c.req.query("to_seq");
    const toSeq = rawToSeq == null ? null : Number(rawToSeq);
    return c.json(store.listSessionEvents(session.id, { sinceSeq, toSeq }).map(sessionEventCompatibilityResponse));
  });
  app.post("/api/issues/:id/sessions/:sessionId/messages", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!issue || !session || session.issueId !== issue.id) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateIssueCommentInput>(c);
    try {
      return c.json(commentCompatibilityResponse(store.createIssueComment(issue.id, {
        ...issueCommentCreateInput(c, body, store, issue.id),
        issueSessionId: session.id,
      })), 201);
    } catch (error) {
      return issueCommentMutationErrorResponse(c, error);
    }
  });
  app.get("/api/issues/:id/sessions/:sessionId/tasks", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!issue || !session || session.issueId !== issue.id) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listTasksForIssue(issue.id)
      .filter((task) => task.issueSessionId === session.id && canCurrentUserAccessChatTask(c, store, task))
      .map((task) => taskCompatibilityResponse(
        task,
        null,
        task.status === "queued" || task.status === "dispatched"
          ? store.getTaskQueueBlocker(task.id)
          : null,
      )));
  });
  app.post("/api/issues/:id/sessions/:sessionId/tasks", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!issue || !session || session.issueId !== issue.id) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const dispatchDenied = denySideSessionAgentDispatch(c, store);
    if (dispatchDenied) return dispatchDenied;
    const body = await readJson<CreateSessionTaskInput>(c);
    const agentId = cleanString(body.agentId ?? body.agent_id);
    const agent = agentId ? store.getAgent(agentId) : null;
    if (!agent) return c.json({ error: "agent not found" }, 404);
    if (!canCurrentUserAccessAgent(c, store, agent)) {
      return c.json({ error: "you do not have access to this agent" }, 403);
    }
    const creator = issueSubscriberCaller(c);
    try {
      const task = store.createSessionTask(session.id, {
        ...stripServerOwnedSessionTaskFields(body),
        // Non-null past the `if (!agent) return 404` guard above; cleanString's
        // null just has to become the `agentId?: string` field's undefined.
        agentId: agentId ?? undefined,
        createdByType: creator.actorType,
        createdById: creator.actorId,
        parentTaskId: currentTaskParentId(c),
      });
      return c.json(taskCompatibilityResponse(task), 201);
    } catch (error) {
      const dependencyResponse = issueDependencyErrorResponse(c, error);
      if (dependencyResponse) return dependencyResponse;
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get("/api/issues/:id/session-results", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listIssueSessionResults(issue.id).map(sessionResultCompatibilityResponse));
  });
  app.post("/api/issues/:id/sessions/:sessionId/results", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!issue || !session || session.issueId !== issue.id) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<PublishSessionResultInput>(c);
    const publisher = issueSubscriberCaller(c);
    try {
      return c.json(sessionResultCompatibilityResponse(store.publishSessionResult(session.id, {
        ...body,
        publishedByType: publisher.actorType,
        publishedById: publisher.actorId,
        sourceTaskId: currentTaskParentId(c),
      })), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get("/api/multiremi/issues/:id/comments", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const parsedInput = parseIssueCommentListQuery(c);
    if ("error" in parsedInput) return c.json({ error: parsedInput.error }, parsedInput.status);
    try {
      const result = store.listIssueCommentsForGoCli(issue.id, parsedInput);
      setIssueCommentCursorHeaders(c, result);
      return c.json({ comments: result.comments });
    } catch (err) {
      return issueCommentListErrorResponse(c, err);
    }
  });
  app.get("/api/issues/:id/comments", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const parsedInput = parseIssueCommentListQuery(c);
    if ("error" in parsedInput) return c.json({ error: parsedInput.error }, parsedInput.status);
    try {
      const result = store.listIssueCommentsForGoCli(issue.id, parsedInput);
      setIssueCommentCursorHeaders(c, result);
      return c.json(result.comments.map(commentCompatibilityResponse));
    } catch (err) {
      return issueCommentListErrorResponse(c, err);
    }
  });
  app.post("/api/multiremi/issues/:id/comments", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateIssueCommentInput>(c);
    return c.json({ comment: store.createIssueComment(issue.id, issueCommentCreateInput(c, body, store, issue.id)) }, 201);
  });
  app.post("/api/issues/:id/comments", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateIssueCommentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(commentCompatibilityResponse(store.createIssueComment(issue.id, issueCommentCreateInput(c, body, store, issue.id))), 201);
    } catch (error) {
      return issueCommentMutationErrorResponse(c, error);
    }
  });
  app.get("/api/multiremi/issues/:id/reactions", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json({ reactions: store.listIssueReactions(issue.id) });
  });
  app.get("/api/issues/:id/reactions", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listIssueReactions(issue.id).map(issueReactionCompatibilityResponse));
  });
  app.post("/api/multiremi/issues/:id/reactions", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateMultiremiReactionInput>(c);
    return c.json({ reaction: store.addIssueReaction(issue.id, normalizeReactionInput(c, body)) }, 201);
  });
  app.post("/api/issues/:id/reactions", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateMultiremiReactionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = normalizeReactionInput(c, body);
    if (!input.emoji) return c.json({ error: "emoji is required" }, 400);
    return c.json(issueReactionCompatibilityResponse(store.addIssueReaction(issue.id, input)), 201);
  });
  app.delete("/api/multiremi/issues/:id/reactions", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateMultiremiReactionInput>(c);
    store.removeIssueReaction(issue.id, normalizeReactionInput(c, body));
    return c.json({ ok: true });
  });
  app.delete("/api/issues/:id/reactions", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateMultiremiReactionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = normalizeReactionInput(c, body);
    if (!input.emoji) return c.json({ error: "emoji is required" }, 400);
    store.removeIssueReaction(issue.id, input);
    return c.body(null, 204);
  });
  app.get("/api/multiremi/issues/:id/attachments", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json({ attachments: store.listAttachmentsForIssue(issue.id) });
  });
  app.get("/api/issues/:id/attachments", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listAttachmentsForIssue(issue.id).map(attachmentCompatibilityResponse));
  });
  app.post("/api/multiremi/issues/:id/attachments", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateAttachmentInput>(c);
    const { actorType: uploaderType, actorId: uploaderId } = issueMutationActor(c, {
      actorType: body.uploaderType ?? body.uploader_type,
      actorId: body.uploaderId ?? body.uploader_id,
    });
    const input = { ...body, workspaceId: issue.workspaceId, issueId: issue.id, uploaderType, uploaderId };
    const attachmentDenied = denyAttachmentCreationAccess(c, store, issue.workspaceId, input);
    if (attachmentDenied) return attachmentDenied;
    const attachment = store.createAttachment(input);
    return c.json({ attachment }, 201);
  });
  app.get("/api/multiremi/issues/:id/labels", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const labels = store.listLabelsForIssue(issue.id);
    return c.json({ labels, total: labels.length });
  });
  app.post("/api/multiremi/issues/:id/labels", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ labelId?: string; label_id?: string }>(c);
    const labels = store.attachLabelToIssue(
      issue.id,
      body.labelId ?? body.label_id ?? "",
      issueMutationActivity(c),
    );
    return c.json({ labels, total: labels.length }, 201);
  });
  app.delete("/api/multiremi/issues/:id/labels/:labelId", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const labels = store.detachLabelFromIssue(issue.id, c.req.param("labelId"), issueMutationActivity(c));
    return c.json({ labels, total: labels.length });
  });
  app.get("/api/issues/:id/labels", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const labels = store.listLabelsForIssue(issue.id);
    return c.json({ labels: labels.map(labelCompatibilityResponse) });
  });
  app.post("/api/issues/:id/labels", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ label_id?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const labelId = body.label_id ?? "";
    if (!labelId) return c.json({ error: "label_id is required" }, 400);
    try {
      const labels = store.attachLabelToIssue(issue.id, labelId, issueMutationActivity(c));
      return c.json({ labels: labels.map(labelCompatibilityResponse) });
    } catch (error) {
      return labelCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/issues/:id/labels/:labelId", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    try {
      const labels = store.detachLabelFromIssue(issue.id, c.req.param("labelId"), issueMutationActivity(c));
      return c.json({ labels: labels.map(labelCompatibilityResponse) });
    } catch (error) {
      return labelCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/multiremi/issues/:id/subscribers", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json({ subscribers: store.listIssueSubscribers(issue.id) });
  });
  app.get("/api/issues/:id/subscribers", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listIssueSubscribers(issue.id).map(issueSubscriberCompatibilityResponse));
  });
  app.post("/api/multiremi/issues/:id/subscribers", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ memberId?: string; reason?: unknown }>(c);
    return c.json({
      subscriber: store.addIssueSubscriber(issue.id, body.memberId ?? "", normalizeSubscriptionReason(body.reason)),
    }, 201);
  });
  app.post("/api/issues/:id/subscribe", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ member_id?: string; user_id?: string; user_type?: string; reason?: unknown }>(c);
    const target = issueSubscriberTarget(c, body);
    if ("error" in target) return c.json({ error: target.error }, target.status);
    try {
      store.addTypedIssueSubscriber(issue.id, target.userType, target.userId, normalizeSubscriptionReason(body.reason));
    } catch (error) {
      return issueSubscriberTargetErrorResponse(c, error);
    }
    store.emitWorkspaceEvent({
      type: "subscriber:added",
      workspaceId: issue.workspaceId,
      actorType: issueSubscriberCaller(c).actorType,
      actorId: issueSubscriberCaller(c).actorId,
      payload: {
        issue_id: issue.id,
        user_type: target.userType,
        user_id: target.userId,
        reason: "manual",
      },
    });
    return c.json({ subscribed: true });
  });
  app.post("/api/issues/:id/unsubscribe", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ member_id?: string; user_id?: string; user_type?: string }>(c);
    const target = issueSubscriberTarget(c, body);
    if ("error" in target) return c.json({ error: target.error }, target.status);
    try {
      store.removeTypedIssueSubscriber(issue.id, target.userType, target.userId);
    } catch (error) {
      return issueSubscriberTargetErrorResponse(c, error);
    }
    const caller = issueSubscriberCaller(c);
    store.emitWorkspaceEvent({
      type: "subscriber:removed",
      workspaceId: issue.workspaceId,
      actorType: caller.actorType,
      actorId: caller.actorId,
      payload: {
        issue_id: issue.id,
        user_type: target.userType,
        user_id: target.userId,
      },
    });
    return c.json({ subscribed: false });
  });
  app.delete("/api/multiremi/issues/:id/subscribers/:memberId", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    store.removeIssueSubscriber(issue.id, c.req.param("memberId"));
    return c.json({ ok: true });
  });
  app.get("/api/multiremi/issues/:id/metadata", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json({ metadata: store.listIssueMetadata(issue.id) });
  });
  app.get("/api/issues/:id/metadata", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listIssueMetadata(issue.id));
  });
  app.put("/api/multiremi/issues/:id/metadata/:key", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ value?: unknown }>(c);
    try {
      return c.json({
        metadata: store.setIssueMetadataKey(
          issue.id,
          c.req.param("key"),
          body.value,
          issueMutationActivity(c),
        ),
      });
    } catch (err) {
      const response = issueErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.put("/api/issues/:id/metadata/:key", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ value?: unknown }>(c);
    try {
      return c.json(store.setIssueMetadataKey(
        issue.id,
        c.req.param("key"),
        body.value,
        issueMutationActivity(c),
      ));
    } catch (err) {
      const response = issueErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.delete("/api/multiremi/issues/:id/metadata/:key", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    try {
      return c.json({
        metadata: store.deleteIssueMetadataKey(issue.id, c.req.param("key"), issueMutationActivity(c)),
      });
    } catch (err) {
      const response = issueErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.delete("/api/issues/:id/metadata/:key", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    try {
      return c.json(store.deleteIssueMetadataKey(issue.id, c.req.param("key"), issueMutationActivity(c)));
    } catch (err) {
      const response = issueErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
}

function issueMutationActivity(c: Context): {
  actorType: string;
  actorId: string;
  sourceTaskId: string | null;
} {
  const caller = issueSubscriberCaller(c);
  return {
    actorType: caller.actorType,
    actorId: caller.actorId,
    sourceTaskId: currentTaskParentId(c),
  };
}

import type { Context, Hono } from "hono";
import {
  assigneeFrequencyQuery,
  bindCreatedIssueToRequestChat,
  canCurrentUserAccessAgent,
  currentTaskParentId,
  denyCurrentUserWorkspaceAccess,
  denyRestrictedTaskIssueCreation,
  isActiveTaskStatus,
  isJsonApiError,
  issueCommentCreateInput,
  issueFromParam,
  issueListQuery,
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
  safeQuickCreateIssue,
  safeRerunIssue,
  setIssueCommentCursorHeaders,
  splitQueryList,
  supervisorTaskIdentity,
  withIssueCreateRequestContext,
} from "../helpers.js";
import {
  attachmentCompatibilityResponse,
  cleanString,
  commentCompatibilityResponse,
  currentTaskAccessToken,
  currentAccessToken,
  issueBatchDeleteCompatibilityInput,
  issueBatchUpdateCompatibilityInput,
  issueCommentListErrorResponse,
  issueCommentMutationErrorResponse,
  issueCompatibilityResponse,
  issueDependencyCompatibilityResponse,
  issueDependencyErrorResponse,
  issueDetailAttachmentCompatibilityResponse,
  issueErrorResponse,
  issueQuickCreateCompatibilityInput,
  issueReactionCompatibilityResponse,
  issueSearchCompatibilityResponse,
  issueSearchErrorResponse,
  issueSessionCompatibilityResponse,
  issueSubscriberCompatibilityResponse,
  issueSubscriberTargetErrorResponse,
  issueTimelineCompatibilityResponse,
  issueTimelineResponse,
  issueUpdateCompatibilityInput,
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
  CreateMultiremiReactionInput,
  CreateSessionTaskInput,
  ListIssuesInput,
  MultiremiIssue,
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
import { OrganizerActionError } from "../../organizer/settings.js";
import type { RouterDeps } from "./deps.js";

// The idempotent generated-issue replay (source_issue_id + same title, 200)
// must satisfy the same dispatch-outcome contract as a fresh create: a
// retrying agent otherwise reads a response with no dispatch fields and stays
// blind to an issue nobody is executing. This request dispatched nothing
// itself, so the outcome is derived from the existing issue's CURRENT state —
// assignment classification first (unassigning cancels the issue's tasks, so a
// stale cancelled task must not resurface as "dispatched"), then the newest
// still-standing task, and with no task left the recorded dispatch_skipped
// activity supplies the original failure reason instead of a guess.
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
    const query = issueListQuery(store, c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(listIssuesResponse(query));
  });
  app.get("/api/issues", (c) => {
    const query = issueListQuery(store, c, "compat");
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    const issues = store.listIssues(query).map((issue) => issueCompatibilityResponse(issue, { includeLabels: true }));
    return c.json({ issues, total: store.countIssues(query) });
  });
  app.get("/api/multiremi/issues/grouped", (c) => {
    const query = issueListQuery(store, c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listGroupedIssues(query));
  });
  app.get("/api/issues/grouped", (c) => {
    const query = issueListQuery(store, c, "compat");
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listGroupedIssues(query));
  });
  app.get("/api/assignee-frequency", (c) => {
    const query = assigneeFrequencyQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listAssigneeFrequency(query));
  });
  app.get("/api/multiremi/assignee-frequency", (c) => {
    const query = assigneeFrequencyQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listAssigneeFrequency(query));
  });
  app.get("/api/multiremi/issues/search", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
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
    const workspaceId = c.req.query("workspace_id") ?? "local";
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
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const progress = store.listChildIssueProgress(workspaceId);
    return c.json({ progress, total: progress.length });
  });
  app.get("/api/issues/child-progress", (c) => {
    const workspaceId = c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const progress = store.listChildIssueProgress(workspaceId);
    return c.json({ progress, total: progress.length });
  });
  app.get("/api/issues/children", (c) => {
    const parentIds = splitQueryList(c.req.query("parent_ids"));
    const issues = parentIds
      .flatMap((parentId) => store.listChildIssues(parentId))
      .map((child) => issueCompatibilityResponse(child));
    return c.json({ issues, total: issues.length });
  });
  app.get("/api/multiremi/issues/children", (c) => {
    const parentIds = splitQueryList(c.req.query("parent_ids") ?? c.req.query("parentIds"));
    const issues = parentIds.flatMap((parentId) => store.listChildIssues(parentId));
    return c.json({ issues, total: issues.length });
  });
  app.post("/api/multiremi/issues/batch-update", async (c) => {
    const body = await readJson<BatchUpdateIssuesInput>(c);
    return c.json(store.batchUpdateIssues({
      ...body,
      updates: body.updates ? { ...body.updates, parentTaskId: currentTaskParentId(c) } : body.updates,
    }));
  });
  app.post("/api/issues/batch-update", async (c) => {
    const body = await readJson<BatchUpdateIssuesInput>(c);
    try {
      const input = issueBatchUpdateCompatibilityInput(body);
      const result = store.batchUpdateIssues({
        ...input,
        updates: input.updates ? { ...input.updates, parentTaskId: currentTaskParentId(c) } : input.updates,
      });
      return c.json({ updated: result.updated });
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
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
    const assigneeType = body.assigneeType ?? body.assignee_type ?? (body.agentId ? "agent" : null);
    const assigneeId = body.assigneeId ?? body.assignee_id ?? body.agentId ?? null;
    const issue = store.createIssue({
      ...body,
      assigneeType: null,
      assignee_type: null,
      assigneeId: null,
      assignee_id: null,
    });
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
    try {
      const issueInput = withIssueCreateRequestContext(c, body, store);
      const denied = denyCurrentUserWorkspaceAccess(c, store, issueInput.workspace_id ?? "local");
      if (denied) return denied;
      const sourceIssueId = issueInput.source_issue_id ?? null;
      if (sourceIssueId) {
        const existing = store.findGeneratedIssueByTitle(sourceIssueId, issueInput.title);
        if (existing) {
          const chatBinding = bindCreatedIssueToRequestChat(c, store, existing);
          return c.json({
            ...existingIssueDispatchResponse(store, existing),
            ...(chatBinding ?? {}),
          }, 200);
        }
      }
      const issue = store.createIssue(issueInput);
      const chatBinding = bindCreatedIssueToRequestChat(c, store, issue);
      if (!chatBinding) {
        try {
          store.prepareFeishuIssueTopicWithinTransaction(issue);
        } catch (error) {
          log.warn(
            `Feishu issue topic creation skipped for ${issue.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
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
      if (!issue.assigneeType || !issue.assigneeId) {
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
        ...(chatBinding ?? {}),
        task_id: task?.id ?? null,
        dispatch_status: task ? "dispatched" : "skipped",
        dispatch_skipped_reason: task ? null : dispatchSkippedReason,
      };
      if (dispatchError) response.dispatch_error = dispatchError;
      return c.json(response, 201);
    } catch (err) {
      const response = issueErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.post("/api/multiremi/issues/quick-create", async (c) => {
    const policyDenied = denyRestrictedTaskIssueCreation(c, store);
    if (policyDenied) return policyDenied;
    const body = await readJson<QuickCreateIssueInput>(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
    const result = safeQuickCreateIssue(store, body);
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json({
      taskId: result.task.id,
      task_id: result.task.id,
      issue: result.issue,
      task: taskPublicResponse(result.task),
    }, 202);
  });
  app.post("/api/issues/quick-create", async (c) => {
    const policyDenied = denyRestrictedTaskIssueCreation(c, store);
    if (policyDenied) return policyDenied;
    const body = await readJson<QuickCreateIssueInput>(c);
    const input = issueQuickCreateCompatibilityInput(body);
    const denied = denyCurrentUserWorkspaceAccess(c, store, input.workspaceId ?? input.workspace_id ?? "local");
    if (denied) return denied;
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
    const tasks = issue.tasks.map(taskPublicResponse);
    const comments = store.listIssueComments(issue.id);
    return c.json({
      issue: { ...issue, tasks },
      children: issue.children,
      childProgress: issue.childProgress,
      dependencies: issue.dependencies,
      comments,
      activity: store.listIssueActivity(issue.id),
    });
  });
  app.get("/api/issues/:id", (c) => {
    const issueRef = issueFromParam(store, c, "id", "compat");
    const issue = issueRef ? store.getIssueWithTasks(issueRef.id) : null;
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const response = issueCompatibilityResponse(issue, { includeLabels: true });
    if (issue.reactions.length) response.reactions = issue.reactions.map(issueReactionCompatibilityResponse);
    if (issue.attachments.length) response.attachments = issue.attachments.map(issueDetailAttachmentCompatibilityResponse);
    return c.json(response);
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
  app.get("/api/multiremi/issues/:id/timeline", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const response = issueTimelineResponse(store, issue.id, c);
    if (!response) return c.json({ error: "issue not found" }, 404);
    return c.json(response);
  });
  app.get("/api/issues/:id/timeline", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const response = issueTimelineCompatibilityResponse(store, issue.id, c);
    if (!response) return c.json({ error: "issue not found" }, 404);
    return c.json(response);
  });
  app.get("/api/issues/:id/active-task", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const tasks = store.listTasksForIssue(issue.id)
      .filter((task) => isActiveTaskStatus(task.status))
      .map((task) => taskCompatibilityResponse(
        task,
        null,
        task.status === "queued" ? store.getTaskQueueBlocker(task.id) : null,
      ));
    return c.json({ tasks });
  });
  app.get("/api/issues/:id/task-runs", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listTasksForIssue(issue.id)
      .map((task) => taskCompatibilityResponse(
        task,
        null,
        task.status === "queued" ? store.getTaskQueueBlocker(task.id) : null,
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
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ agent_id?: string; agentId?: string; prompt?: string }>(c);
    const result = safeRerunIssue(store, issue.id, {
      ...body,
      parentTaskId: currentTaskParentId(c),
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
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
    const taskToken = currentTaskAccessToken(c);
    const supervisor = supervisorTaskIdentity(c, store);
    if (supervisor && task.id === supervisor.task.id) {
      return c.json({ error: "a supervisor cannot act on its own task", code: "organizer_self_action_forbidden" }, 403);
    }
    if (supervisor && taskToken?.taskId && task.id !== taskToken.taskId) {
      const body = await readJson<{ reason?: string }>(c);
      try {
        const result = store.performOrganizerAction({
          supervisorTaskId: supervisor.task.id,
          supervisorAgentId: supervisor.agentId,
          targetTaskId: task.id,
          action: "cancel",
          reason: cleanString(body.reason) ?? "",
        });
        return c.json({
          ...taskCompatibilityResponse(result.task),
          organizer_action: result.audit,
          comment_id: result.comment.id,
        });
      } catch (error) {
        if (error instanceof OrganizerActionError) return c.json({ error: error.message, code: error.code }, error.status);
        throw error;
      }
    }
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
      const taskToken = currentTaskAccessToken(c);
      const activity = store.recordSquadLeaderEvaluation(issue.id, {
        outcome: body.outcome ?? "",
        reason: body.reason ?? null,
        taskId: taskToken?.taskId ?? c.req.header("X-Task-ID") ?? body.task_id ?? body.taskId ?? null,
        actorId: taskToken?.agentId ?? c.req.header("X-Agent-ID") ?? body.actor_id ?? body.actorId ?? null,
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
    return c.json({ issues: children, total: children.length });
  });
  app.get("/api/issues/:id/children", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const children = store.listChildIssues(issue.id);
    return c.json({
      issues: children.map((child) => issueCompatibilityResponse(child)),
      total: children.length,
    });
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
    return c.json({ dependency: store.createIssueDependency(issue.id, body, issueMutationActivity(c)) }, 201);
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
  app.patch("/api/multiremi/issues/:id", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<UpdateIssueInput>(c);
    const input = { ...body, parentTaskId: currentTaskParentId(c) };
    const updated = store.updateIssue(issue.id, input);
    lockAutoTitleAfterHumanEdit(c, updated, input);
    return c.json({ issue: maybeDispatchOnIssueUpdate(store, issue, updated, input) });
  });
  const updateIssueCompatibilityRoute = async (c: Context) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<UpdateIssueInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = {
      ...issueUpdateCompatibilityInput(body),
      parentTaskId: currentTaskParentId(c),
    };
    try {
      const updated = store.updateIssue(issue.id, input);
      lockAutoTitleAfterHumanEdit(c, updated, input);
      const dispatched = maybeDispatchOnIssueUpdate(store, issue, updated, input);
      const response = issueCompatibilityResponse(dispatched);
      publishIssueUpdated(c, store, issue, dispatched, input, response);
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
    const body = await readJson<AssignIssueInput>(c);
    const result = store.assignIssue(issue.id, {
      ...body,
      parentTaskId: currentTaskParentId(c),
    });
    return c.json({
      ...result,
      task: result.task ? taskPublicResponse(result.task) : null,
    });
  });
  app.get("/api/issues/:id/sessions", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const sessions = store.listIssueSessions(issue.id, c.req.query("include_archived") === "true");
    return c.json(sessions.map((session) => issueSessionCompatibilityResponse(
      session,
      store.listSessionParticipants(session.id),
    )));
  });
  app.post("/api/issues/:id/sessions", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateIssueSessionInput>(c);
    const creator = issueSubscriberCaller(c);
    try {
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
      .filter((task) => task.issueSessionId === session.id)
      .map((task) => taskCompatibilityResponse(
        task,
        null,
        task.status === "queued" ? store.getTaskQueueBlocker(task.id) : null,
      )));
  });
  app.post("/api/issues/:id/sessions/:sessionId/tasks", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!issue || !session || session.issueId !== issue.id) return c.json({ error: "session not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
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
        ...body,
        // Non-null past the `if (!agent) return 404` guard above; cleanString's
        // null just has to become the `agentId?: string` field's undefined.
        agentId: agentId ?? undefined,
        createdByType: creator.actorType,
        createdById: creator.actorId,
        parentTaskId: currentTaskParentId(c),
      });
      return c.json(taskCompatibilityResponse(task), 201);
    } catch (error) {
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
    return c.json({ reaction: store.addIssueReaction(issue.id, normalizeReactionInput(body)) }, 201);
  });
  app.post("/api/issues/:id/reactions", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateMultiremiReactionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = normalizeReactionInput(body);
    if (!input.emoji) return c.json({ error: "emoji is required" }, 400);
    return c.json(issueReactionCompatibilityResponse(store.addIssueReaction(issue.id, input)), 201);
  });
  app.delete("/api/multiremi/issues/:id/reactions", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateMultiremiReactionInput>(c);
    store.removeIssueReaction(issue.id, normalizeReactionInput(body));
    return c.json({ ok: true });
  });
  app.delete("/api/issues/:id/reactions", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateMultiremiReactionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = normalizeReactionInput(body);
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
    const attachment = store.createAttachment({ ...body, issueId: issue.id });
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

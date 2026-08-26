import type { Context, Hono } from "hono";
import type {
  InitSessionArchiveInput,
  MultiremiSessionArchive,
  ReportSessionArchiveFailureInput,
} from "@multiremi/contracts/types.js";
import {
  MULTIREMI_SESSION_ARCHIVE_MAX_TTL_MS,
  MULTIREMI_SESSION_ARCHIVE_MIN_GC_INTERVAL_MS,
  MULTIREMI_SESSION_ARCHIVE_MIN_TTL_MS,
} from "@multiremi/contracts/types.js";
import {
  denyCurrentUserWorkspaceAccess,
  denyDaemonRuntimeObservedStateAccess,
  denyDaemonTokenRuntimeIdentity,
  denyDaemonTokenIssueWorkspace,
  isJsonApiError,
  readJsonStrict,
  readJsonStrictAllowEmpty,
  requireWorkspaceAdmin,
} from "../helpers.js";
import { SessionArchiveError } from "@multiremi/session-archive/service.js";
import { createId } from "@multiremi/ids.js";
import type { RouterDeps } from "./deps.js";

const DEFAULT_WORKSPACE_TTL_MS = 72 * 60 * 60 * 1_000;
const DEFAULT_GC_INTERVAL_MS = 15 * 60 * 1_000;

type InitBody = {
  source_revision?: unknown;
  sha256?: unknown;
  size_bytes?: unknown;
  file_count?: unknown;
  metadata?: unknown;
};

type ArchiveSettingsBody = {
  workspace_ttl_ms?: unknown;
  gc_interval_ms?: unknown;
};

type FailureBody = {
  stage?: unknown;
  error?: unknown;
};

function archiveWire(archive: MultiremiSessionArchive | null): Record<string, unknown> | null {
  if (!archive) return null;
  return {
    id: archive.id,
    workspace_id: archive.workspaceId,
    issue_id: archive.issueId,
    runtime_id: archive.runtimeId,
    daemon_id: archive.daemonId,
    source_revision: archive.sourceRevision,
    sha256: archive.sha256,
    size_bytes: archive.sizeBytes,
    uploaded_size_bytes: archive.uploadedSizeBytes,
    file_count: archive.fileCount,
    status: archive.status,
    relative_path: archive.relativePath,
    metadata: archive.metadata,
    attempt_count: archive.attemptCount,
    last_error: archive.lastError,
    next_retry_at: archive.nextRetryAt,
    retry_exhausted_at: archive.retryExhaustedAt,
    retry_state: archive.retryExhaustedAt
      ? "exhausted"
      : archive.nextRetryAt && archive.nextRetryAt > new Date().toISOString()
        ? "backoff"
        : "eligible",
    created_at: archive.createdAt,
    updated_at: archive.updatedAt,
    completed_at: archive.completedAt,
  };
}

function archiveError(c: Context, error: unknown): Response {
  if (error instanceof SessionArchiveError) {
    return c.json({ error: error.message, code: error.code }, error.status as 400);
  }
  if (
    error instanceof Error
    && "code" in error
    && error.code === "issue_archive_lifecycle_closed"
  ) {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  throw error;
}

function requiredUploadAttempt(c: Context): number {
  const raw = c.req.query("attempt") ?? "";
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new SessionArchiveError(
      "attempt must be a positive integer",
      400,
      "session_archive_invalid_attempt",
    );
  }
  const attempt = Number(raw);
  if (!Number.isSafeInteger(attempt)) {
    throw new SessionArchiveError(
      "attempt must be a positive safe integer",
      400,
      "session_archive_invalid_attempt",
    );
  }
  return attempt;
}

function workspaceArchiveSettings(settings: Record<string, unknown> | null | undefined): {
  workspaceTtlMs: number;
  gcIntervalMs: number;
} {
  const raw = settings?.session_archive;
  const archive = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const workspaceTtlMs = Number(archive.workspace_ttl_ms);
  const gcIntervalMs = Number(archive.gc_interval_ms);
  return {
    workspaceTtlMs: Number.isSafeInteger(workspaceTtlMs)
      && workspaceTtlMs >= MULTIREMI_SESSION_ARCHIVE_MIN_TTL_MS
      && workspaceTtlMs <= MULTIREMI_SESSION_ARCHIVE_MAX_TTL_MS
      ? workspaceTtlMs
      : DEFAULT_WORKSPACE_TTL_MS,
    gcIntervalMs: Number.isSafeInteger(gcIntervalMs)
      && gcIntervalMs >= MULTIREMI_SESSION_ARCHIVE_MIN_GC_INTERVAL_MS
      && gcIntervalMs <= workspaceTtlMs
      ? gcIntervalMs
      : DEFAULT_GC_INTERVAL_MS,
  };
}

function workspaceStatus(deps: RouterDeps, workspaceId: string): Record<string, unknown> {
  const workspace = deps.store.getWorkspace(workspaceId);
  if (!workspace) throw new SessionArchiveError("workspace not found", 404, "workspace_not_found");
  const desired = workspaceArchiveSettings(workspace.settings);
  const usage = deps.store.getSessionArchiveWorkspaceUsage(workspaceId);
  const lastFailureIssueKey = usage.lastFailure
    ? deps.store.getIssue(usage.lastFailure.issueId)?.key ?? null
    : null;
  return {
    config: {
      backend: "local",
      root_hint: deps.sessionArchives.rootHint(),
      require_archive: true,
      max_bytes: deps.sessionArchives.config.maxBytes,
      min_free_bytes: deps.sessionArchives.config.minFreeBytes,
      workspace_ttl_ms: desired.workspaceTtlMs,
      gc_interval_ms: desired.gcIntervalMs,
    },
    usage: {
      total_archives: usage.totalArchives,
      ready_archives: usage.readyArchives,
      failed_archives: usage.failedArchives,
      pending_archives: usage.pendingArchives,
      exhausted_archives: usage.exhaustedArchives,
      total_bytes: usage.totalBytes,
    },
    last_failure: usage.lastFailure
      ? {
        archive_id: usage.lastFailure.archiveId,
        issue_id: usage.lastFailure.issueId,
        issue_key: lastFailureIssueKey,
        error: usage.lastFailure.error,
        updated_at: usage.lastFailure.updatedAt,
      }
      : null,
  };
}

function requireIssueAdmin(c: Context, deps: RouterDeps, issueId: string): {
  id: string;
  workspaceId: string;
} | Response {
  const issue = deps.store.getIssueByRef(issueId);
  if (!issue) return c.json({ error: "issue not found" }, 404);
  const denied = denyCurrentUserWorkspaceAccess(c, deps.store, issue.workspaceId)
    ?? requireWorkspaceAdmin(c, deps.store, issue.workspaceId);
  if (denied) return denied;
  return { id: issue.id, workspaceId: issue.workspaceId };
}

function requireDaemonArchiveScope(c: Context, deps: RouterDeps): {
  runtimeId: string;
  issueId: string;
} | Response {
  const runtimeId = String(c.req.param("runtimeId") ?? "");
  const issueId = String(c.req.param("issueId") ?? "");
  const denied = denyDaemonRuntimeObservedStateAccess(c, deps.store, runtimeId, deps.authToken)
    ?? denyDaemonTokenRuntimeIdentity(c, deps.store, runtimeId)
    ?? denyDaemonTokenIssueWorkspace(c, deps.store, issueId);
  if (denied) return denied;
  const runtime = deps.store.getRuntime(runtimeId);
  const issue = deps.store.getIssue(issueId);
  if (!runtime || !issue || (runtime.workspaceId ?? "local") !== issue.workspaceId) {
    return c.json({ error: "issue archive scope not found" }, 404);
  }
  const issueWorkspace = deps.store.getIssueWorkspace(issueId);
  if (!issueWorkspace || issueWorkspace.runtimeId !== runtimeId) {
    return c.json({ error: "issue archive scope not found" }, 404);
  }
  if (issueWorkspace.status === "cleaned") {
    return c.json({
      error: "Issue workspace has already been cleaned",
      code: "issue_archive_lifecycle_closed",
    }, 409);
  }
  return { runtimeId, issueId };
}

export function registerSessionArchiveRoutes(app: Hono, deps: RouterDeps): void {
  const { store, sessionArchives } = deps;
  const daemonBase = "/api/daemon/runtimes/:runtimeId/issues/:issueId/session-archives";

  app.get(`${daemonBase}/status`, async (c) => {
    const scope = requireDaemonArchiveScope(c, deps);
    if (scope instanceof Response) return scope;
    const sourceRevision = c.req.query("source_revision");
    const sha256 = c.req.query("sha256")?.toLowerCase();
    let snapshot = store.getSessionArchiveStatus(
      scope.issueId,
      sourceRevision,
      sha256,
    );
    await sessionArchives.cleanupExhaustedPartials(snapshot.latest);
    let physicallyVerifiedAttempt: number | null = null;
    if (c.req.query("verify_ready") === "1") {
      // A retry may supersede the row while its bytes are being hashed. Verify
      // the exact attempt returned to the daemon and fail closed under churn.
      for (let pass = 0; pass < 3 && snapshot.requestedReady; pass++) {
        const candidate = snapshot.requestedReady;
        try {
          const verified = await sessionArchives.verify(candidate.id);
          snapshot = store.getSessionArchiveStatus(scope.issueId, sourceRevision, sha256);
          if (
            verified.valid
            && snapshot.requestedReady?.id === candidate.id
            && snapshot.requestedReady.attemptCount === candidate.attemptCount
          ) {
            physicallyVerifiedAttempt = candidate.attemptCount;
            break;
          }
        } catch (error) {
          if (!(error instanceof SessionArchiveError)
            || (error.code !== "session_archive_invalid_state"
              && error.code !== "session_archive_not_found")) {
            throw error;
          }
          snapshot = store.getSessionArchiveStatus(scope.issueId, sourceRevision, sha256);
        }
      }
    }
    const requestedAttempt = snapshot.requestedReady?.attemptCount ?? null;
    return c.json({
      latest: archiveWire(snapshot.latest),
      latest_ready: archiveWire(snapshot.latestReady),
      requested_ready: archiveWire(snapshot.requestedReady),
      gc_ready: c.req.query("verify_ready") === "1"
        ? snapshot.gcReady && physicallyVerifiedAttempt === requestedAttempt
        : snapshot.gcReady,
    });
  });

  app.post(`${daemonBase}/init`, async (c) => {
    const scope = requireDaemonArchiveScope(c, deps);
    if (scope instanceof Response) return scope;
    const runtime = store.getRuntime(scope.runtimeId)!;
    const issue = store.getIssue(scope.issueId)!;
    const body = await readJsonStrict<InitBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "invalid request body" }, 400);
    }
    if (body.metadata != null && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
      return c.json({ error: "metadata must be an object" }, 400);
    }
    const input: InitSessionArchiveInput = {
      workspaceId: issue.workspaceId,
      issueId: scope.issueId,
      runtimeId: scope.runtimeId,
      daemonId: runtime.daemonId?.trim() || "unbound",
      sourceRevision: typeof body.source_revision === "string" ? body.source_revision : "",
      sha256: typeof body.sha256 === "string" ? body.sha256 : "",
      sizeBytes: typeof body.size_bytes === "number" ? body.size_bytes : Number.NaN,
      fileCount: body.file_count == null
        ? null
        : typeof body.file_count === "number" ? body.file_count : Number.NaN,
      metadata: body.metadata as Record<string, unknown> | undefined,
    };
    try {
      const initialized = sessionArchives.initialize(input);
      const claimed = await sessionArchives.claimUploadAttempt(
        scope.runtimeId,
        scope.issueId,
        initialized.archive.id,
      );
      const uploadUrl = claimed.uploadAttempt == null
        ? null
        : `${daemonBase
          .replace(":runtimeId", encodeURIComponent(scope.runtimeId))
          .replace(":issueId", encodeURIComponent(scope.issueId))}/${encodeURIComponent(initialized.archive.id)}/content?attempt=${claimed.uploadAttempt}`;
      return c.json({
        archive: archiveWire(claimed.archive),
        upload_attempt: claimed.uploadAttempt,
        upload_url: uploadUrl,
      }, initialized.created ? 201 : 200);
    } catch (error) {
      return archiveError(c, error);
    }
  });

  app.post(`${daemonBase}/failure`, async (c) => {
    const scope = requireDaemonArchiveScope(c, deps);
    if (scope instanceof Response) return scope;
    const runtime = store.getRuntime(scope.runtimeId)!;
    const issue = store.getIssue(scope.issueId)!;
    const body = await readJsonStrict<FailureBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "invalid request body" }, 400);
    }
    if (Object.keys(body).some((key) => key !== "stage" && key !== "error")) {
      return c.json({ error: "only stage and error are allowed" }, 400);
    }
    const error = typeof body.error === "string" ? body.error.trim() : "";
    if (body.stage !== "prepare") {
      return c.json({ error: "stage must be prepare" }, 400);
    }
    if (!error || error.length > 2_000) {
      return c.json({ error: "error must be between 1 and 2000 characters" }, 400);
    }
    const id = createId("sar");
    const input: ReportSessionArchiveFailureInput = {
      workspaceId: issue.workspaceId,
      issueId: scope.issueId,
      runtimeId: scope.runtimeId,
      daemonId: runtime.daemonId?.trim() || "unbound",
      stage: "prepare",
      error,
    };
    try {
      const reported = store.reportSessionArchiveFailure(
        input,
        id,
        `failures/${id}/sessions.tar.gz`,
      );
      return c.json(
        { archive: archiveWire(reported.archive) },
        reported.created ? 201 : 200,
      );
    } catch (error) {
      return archiveError(c, error);
    }
  });

  app.put(`${daemonBase}/:archiveId/content`, async (c) => {
    const scope = requireDaemonArchiveScope(c, deps);
    if (scope instanceof Response) return scope;
    try {
      const archive = await sessionArchives.upload(
        scope.runtimeId,
        scope.issueId,
        c.req.param("archiveId"),
        requiredUploadAttempt(c),
        c.req.raw.body,
      );
      return c.json({ archive: archiveWire(archive) });
    } catch (error) {
      return archiveError(c, error);
    }
  });

  app.post(`${daemonBase}/:archiveId/complete`, async (c) => {
    const scope = requireDaemonArchiveScope(c, deps);
    if (scope instanceof Response) return scope;
    try {
      const archive = await sessionArchives.complete(
        scope.runtimeId,
        scope.issueId,
        c.req.param("archiveId"),
        requiredUploadAttempt(c),
      );
      return c.json({ archive: archiveWire(archive) });
    } catch (error) {
      return archiveError(c, error);
    }
  });

  app.get("/api/workspaces/:id/session-archive", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    try {
      return c.json(workspaceStatus(deps, workspaceId));
    } catch (error) {
      return archiveError(c, error);
    }
  });

  app.put("/api/workspaces/:id/session-archive", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<ArchiveSettingsBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "invalid request body" }, 400);
    }
    const fields = Object.keys(body);
    if (fields.some((key) => key !== "workspace_ttl_ms" && key !== "gc_interval_ms")) {
      return c.json({ error: "only workspace_ttl_ms and gc_interval_ms are allowed" }, 400);
    }
    const workspaceTtlMs = body.workspace_ttl_ms;
    const gcIntervalMs = body.gc_interval_ms;
    if (
      !Number.isSafeInteger(workspaceTtlMs)
      || Number(workspaceTtlMs) < MULTIREMI_SESSION_ARCHIVE_MIN_TTL_MS
      || Number(workspaceTtlMs) > MULTIREMI_SESSION_ARCHIVE_MAX_TTL_MS
    ) {
      return c.json({
        error: `workspace_ttl_ms must be between ${MULTIREMI_SESSION_ARCHIVE_MIN_TTL_MS} and ${MULTIREMI_SESSION_ARCHIVE_MAX_TTL_MS}`,
      }, 400);
    }
    if (
      !Number.isSafeInteger(gcIntervalMs)
      || Number(gcIntervalMs) < MULTIREMI_SESSION_ARCHIVE_MIN_GC_INTERVAL_MS
      || Number(gcIntervalMs) > Number(workspaceTtlMs)
    ) {
      return c.json({ error: "gc_interval_ms must be at least 60000 and no greater than workspace_ttl_ms" }, 400);
    }
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    const settings = { ...(workspace.settings ?? {}) } as Record<string, unknown>;
    const currentArchive = settings.session_archive;
    settings.session_archive = {
      ...(currentArchive && typeof currentArchive === "object" && !Array.isArray(currentArchive)
        ? currentArchive as Record<string, unknown>
        : {}),
      workspace_ttl_ms: Number(workspaceTtlMs),
      gc_interval_ms: Number(gcIntervalMs),
    };
    store.updateWorkspace(workspaceId, { settings });
    return c.json(workspaceStatus(deps, workspaceId));
  });

  app.get("/api/issues/:issueId/session-archives", (c) => {
    const allowed = requireIssueAdmin(c, deps, c.req.param("issueId"));
    if (allowed instanceof Response) return allowed;
    const issueId = allowed.id;
    const archives = store.listSessionArchives(issueId);
    const status = store.getSessionArchiveStatus(issueId);
    return c.json({
      archives: archives.map(archiveWire),
      latest: archiveWire(status.latest),
      latest_ready: archiveWire(status.latestReady),
    });
  });

  app.post("/api/issues/:issueId/session-archives/:archiveId/verify", async (c) => {
    const allowed = requireIssueAdmin(c, deps, c.req.param("issueId"));
    if (allowed instanceof Response) return allowed;
    const issueId = allowed.id;
    const archive = store.getSessionArchive(c.req.param("archiveId"));
    if (!archive || archive.issueId !== issueId) return c.json({ error: "session archive not found" }, 404);
    try {
      const result = await sessionArchives.verify(archive.id);
      return c.json({
        archive: archiveWire(result.archive),
        valid: result.valid,
        actual_sha256: result.actualSha256,
        actual_size_bytes: result.actualSizeBytes,
        error: result.error,
      });
    } catch (error) {
      return archiveError(c, error);
    }
  });

  app.post("/api/issues/:issueId/session-archives/:archiveId/retry", async (c) => {
    const allowed = requireIssueAdmin(c, deps, c.req.param("issueId"));
    if (allowed instanceof Response) return allowed;
    const issueId = allowed.id;
    const body = await readJsonStrictAllowEmpty<Record<string, never>>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (Object.keys(body).length) return c.json({ error: "request body must be empty" }, 400);
    const archive = store.getSessionArchive(c.req.param("archiveId"));
    if (!archive || archive.issueId !== issueId) return c.json({ error: "session archive not found" }, 404);
    try {
      return c.json({ archive: archiveWire(await sessionArchives.retry(archive.id)) });
    } catch (error) {
      return archiveError(c, error);
    }
  });
}

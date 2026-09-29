import { Hono } from "hono";
import type { MultiremiStore } from "@multiremi/store.js";
import { SessionArchiveError, type SessionArchiveService } from "@multiremi/session-archive/service.js";

/** Frozen pre-A-5 cleaned-route business logic, used only as the HTTP parity oracle. */
export function legacyGcHttp(store: MultiremiStore, archives: SessionArchiveService): Hono {
  const app = new Hono();
  app.post("/api/daemon/issues/:issueId/workspace/cleaned", async c => {
    const body = await c.req.json<{ runtime_id: string; archive_id: string; source_revision: string; sha256: string }>();
    const runtimeId = body.runtime_id?.trim() ?? "";
    if (!runtimeId) return c.json({ error: "runtime_id is required" }, 400);
    const archiveId = body.archive_id?.trim() ?? "";
    const sourceRevision = body.source_revision?.trim() ?? "";
    const sha256 = body.sha256?.trim().toLowerCase() ?? "";
    if (!archiveId || !sourceRevision || !/^[a-f0-9]{64}$/.test(sha256)) {
      return c.json({ error: "archive_id, source_revision and a 64-character sha256 are required" }, 400);
    }
    const issueId = c.req.param("issueId");
    if (!store.getIssue(issueId)) return c.json({ error: "issue not found", code: "issue_not_found" }, 404);
    const current = store.getIssueWorkspace(issueId);
    if (!current) return c.json({ error: "issue workspace not found", code: "issue_workspace_not_found" }, 404);
    if (current.runtimeId !== runtimeId) {
      return c.json({ error: "runtime does not own issue workspace", code: "issue_workspace_runtime_mismatch" }, 404);
    }
    try {
      const verified = await archives.verify(archiveId);
      if (!verified.valid || verified.archive.issueId !== issueId || verified.archive.sourceRevision !== sourceRevision || verified.archive.sha256 !== sha256) {
        return c.json({ error: "workspace cleanup archive is missing, corrupt, or does not match the exact snapshot",
          code: "issue_workspace_archive_invalid" }, 409);
      }
      const workspace = store.markIssueWorkspaceCleaned({ issueId, runtimeId, archiveId, sourceRevision, sha256 });
      return c.json({ issue_id: workspace.issueId, status: workspace.status, cleaned_at: workspace.cleanedAt,
        archive_id: workspace.cleanedArchiveId, source_revision: workspace.cleanedArchiveSourceRevision, sha256: workspace.cleanedArchiveSha256 });
    } catch (error) {
      if (error instanceof SessionArchiveError) return c.json({ error: error.message, code: error.code }, error.status as 400);
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, message.includes("exact ready") ? 409 : 400);
    }
  });
  return app;
}

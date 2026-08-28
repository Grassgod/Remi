import { nowIso } from "@multiremi/ids.js";
import { nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { runtimesShareDaemon } from "@multiremi/store/runtime-affinity.js";
import type {
  MarkIssueWorkspaceCleanedInput,
  MultiremiIssueWorkspace,
  MultiremiIssueWorkspaceRepo,
  ReportIssueWorkspaceInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export class IssueWorkspacesRepo {
  constructor(private readonly ctx: StoreContext) {}

  get(issueId: string): MultiremiIssueWorkspace | null {
    const row = this.ctx.db.query(
      `SELECT iw.*, r.name AS runtime_name, r.status AS runtime_status,
              r.provider AS runtime_provider, r.runtime_mode AS runtime_mode,
              r.device_info AS runtime_device_info, r.daemon_id AS runtime_daemon_id,
              p.display_name AS runtime_machine_name
       FROM multiremi_issue_workspaces iw
       LEFT JOIN multiremi_runtimes r ON r.id = iw.runtime_id
       LEFT JOIN multiremi_daemon_profiles p
         ON p.workspace_id = iw.workspace_id AND p.daemon_id = r.daemon_id
       WHERE iw.issue_id = ?`,
    ).get(issueId) as Row | null;
    return row ? toIssueWorkspace(row) : null;
  }

  report(input: ReportIssueWorkspaceInput): MultiremiIssueWorkspace {
    const initialIssue = this.ctx.db.query(
      "SELECT workspace_id FROM multiremi_issues WHERE id = ?",
    ).get(input.issueId) as Row | null;
    if (!initialIssue) throw new Error(`Issue not found: ${input.issueId}`);
    const workspaceId = String(initialIssue.workspace_id ?? "local");
    const tx = this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      this.ctx.lockIssueArchiveLifecycle(input.issueId);
      return this.reportWithinLifecycleLock(input, workspaceId);
    });
    return tx();
  }

  /** Caller holds the issue workspace's Runtime lifecycle lock. */
  private reportWithinLifecycleLock(
    input: ReportIssueWorkspaceInput,
    workspaceId: string,
  ): MultiremiIssueWorkspace {
    const issue = this.ctx.db.query(
      "SELECT issue_key, issue_kind, workspace_id FROM multiremi_issues WHERE id = ?",
    ).get(input.issueId) as Row | null;
    if (!issue || String(issue.workspace_id ?? "local") !== workspaceId) {
      throw new Error(`Issue not found: ${input.issueId}`);
    }
    const lifecycle = this.ctx.db.query(
      "SELECT lifecycle_state FROM multiremi_issues WHERE id = ?",
    ).get(input.issueId) as Row | null;
    if (String(lifecycle?.lifecycle_state ?? "active") !== "active") {
      throw new Error("issue workspace lifecycle is not writable");
    }
    const runtime = this.ctx.runtimes().getRuntime(input.runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${input.runtimeId}`);
    if ((runtime.workspaceId ?? "local") !== workspaceId) {
      throw new Error("runtime belongs to another workspace");
    }
    const issueKey = String(issue.issue_key ?? input.issueId);
    const expectedBranch = issue.issue_kind === "intake" ? "" : `agent/${issueKey}`;
    if (input.branchName !== expectedBranch) {
      throw new Error(`issue workspace branch must be ${expectedBranch}`);
    }
    if (!input.rootPath.trim()) throw new Error("issue workspace root path is required");
    if (!["preparing", "ready", "in_use", "dirty", "error"].includes(input.status)) {
      throw new Error(`invalid issue workspace report status: ${input.status}`);
    }
    for (const repo of input.repos ?? []) {
      if (!repo.repoUrl.trim() || !repo.repoName.trim() || !repo.worktreePath.trim()) {
        throw new Error("issue workspace repo url, name and worktree path are required");
      }
      if (repo.branchName !== expectedBranch) {
        throw new Error(`issue workspace repo branch must be ${expectedBranch}`);
      }
    }
    const current = this.get(input.issueId);
    if (
      current?.runtimeId
      && current.runtimeId !== input.runtimeId
      && current.status !== "cleaned"
      && !this.runtimesShareDaemon(current.runtimeId, input.runtimeId)
    ) {
      throw new Error("runtime does not own active issue workspace");
    }
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_workspaces (
         issue_id, workspace_id, issue_key, runtime_id, root_path, branch_name,
         status, repos, last_task_id, cleaned_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET
         runtime_id = excluded.runtime_id,
         root_path = excluded.root_path,
         branch_name = excluded.branch_name,
         status = excluded.status,
         repos = excluded.repos,
         last_task_id = excluded.last_task_id,
         cleaned_at = excluded.cleaned_at,
         cleaned_archive_id = NULL,
         cleaned_archive_source_revision = NULL,
         cleaned_archive_sha256 = NULL,
         updated_at = excluded.updated_at`,
      [
        input.issueId,
        workspaceId,
        issueKey,
        input.runtimeId,
        input.rootPath,
        input.branchName,
        input.status,
        toJson(input.repos ?? []),
        input.lastTaskId ?? null,
        input.cleanedAt ?? null,
        now,
        now,
      ],
    );
    return this.get(input.issueId)!;
  }

  markCleaned(input: MarkIssueWorkspaceCleanedInput): MultiremiIssueWorkspace {
    const initial = this.get(input.issueId);
    if (!initial) throw new Error(`Issue workspace not found: ${input.issueId}`);
    const tx = this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
      this.ctx.lockIssueArchiveLifecycle(input.issueId);
      return this.markCleanedWithinLifecycleLock(input, initial.workspaceId);
    });
    return tx();
  }

  /** Caller holds the issue workspace's Runtime lifecycle lock. */
  private markCleanedWithinLifecycleLock(
    input: MarkIssueWorkspaceCleanedInput,
    workspaceId: string,
  ): MultiremiIssueWorkspace {
    const current = this.get(input.issueId);
    if (!current || current.workspaceId !== workspaceId) {
      throw new Error(`Issue workspace not found: ${input.issueId}`);
    }
    if (!current.runtimeId || current.runtimeId !== input.runtimeId) {
      throw new Error("runtime does not own issue workspace");
    }
    const lifecycle = this.ctx.db.query(
      "SELECT lifecycle_state FROM multiremi_issues WHERE id = ?",
    ).get(input.issueId) as Row | null;
    if (String(lifecycle?.lifecycle_state ?? "active") !== "active") {
      throw new Error("issue workspace lifecycle is not writable");
    }
    const exactReady = this.ctx.db.query(
      `SELECT id FROM multiremi_session_archives
       WHERE id = ? AND issue_id = ? AND source_revision = ? AND sha256 = ?
         AND status = 'ready'`,
    ).get(
      input.archiveId,
      input.issueId,
      input.sourceRevision,
      input.sha256.toLowerCase(),
    ) as Row | null;
    if (!exactReady) {
      throw new Error("cleaned workspace requires the exact ready session archive");
    }
    const now = nowIso();
    this.ctx.db.run(
      `UPDATE multiremi_issue_workspaces
       SET status = 'cleaned', repos = '[]', cleaned_at = ?,
           cleaned_archive_id = ?, cleaned_archive_source_revision = ?,
           cleaned_archive_sha256 = ?, updated_at = ?
       WHERE issue_id = ?`,
      [
        now,
        input.archiveId,
        input.sourceRevision,
        input.sha256.toLowerCase(),
        now,
        input.issueId,
      ],
    );
    return this.get(input.issueId)!;
  }

  private runtimesShareDaemon(firstRuntimeId: string, secondRuntimeId: string): boolean {
    const first = this.ctx.runtimes().getRuntime(firstRuntimeId);
    const second = this.ctx.runtimes().getRuntime(secondRuntimeId);
    return Boolean(first && second && runtimesShareDaemon(first, second));
  }
}

function toIssueWorkspace(row: Row): MultiremiIssueWorkspace {
  return {
    issueId: String(row.issue_id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueKey: String(row.issue_key),
    runtimeId: nullableString(row.runtime_id),
    runtimeName: nullableString(row.runtime_name),
    runtimeStatus: row.runtime_status === "online" || row.runtime_status === "offline" ? row.runtime_status : null,
    runtimeProvider: nullableString(row.runtime_provider),
    runtimeMode: nullableString(row.runtime_mode),
    runtimeDeviceInfo: nullableString(row.runtime_device_info),
    runtimeDaemonId: nullableString(row.runtime_daemon_id),
    runtimeMachineName: nullableString(row.runtime_machine_name),
    rootPath: String(row.root_path),
    branchName: String(row.branch_name),
    status: String(row.status) as MultiremiIssueWorkspace["status"],
    repos: parseJson<MultiremiIssueWorkspaceRepo[]>(row.repos, []),
    lastTaskId: nullableString(row.last_task_id),
    cleanedAt: nullableString(row.cleaned_at),
    cleanedArchiveId: nullableString(row.cleaned_archive_id),
    cleanedArchiveSourceRevision: nullableString(row.cleaned_archive_source_revision),
    cleanedArchiveSha256: nullableString(row.cleaned_archive_sha256),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

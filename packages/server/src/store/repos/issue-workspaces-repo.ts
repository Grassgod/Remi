import { nowIso } from "@multiremi/ids.js";
import { nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import type { StoreContext } from "@multiremi/store/context.js";
import type {
  MultiremiIssueWorkspace,
  MultiremiIssueWorkspaceRepo,
  ReportIssueWorkspaceInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export class IssueWorkspacesRepo {
  constructor(private readonly ctx: StoreContext) {}

  get(issueId: string): MultiremiIssueWorkspace | null {
    const row = this.ctx.db.query(
      `SELECT iw.*, r.name AS runtime_name, r.status AS runtime_status
       FROM multiremi_issue_workspaces iw
       LEFT JOIN multiremi_runtimes r ON r.id = iw.runtime_id
       WHERE iw.issue_id = ?`,
    ).get(issueId) as Row | null;
    return row ? toIssueWorkspace(row) : null;
  }

  report(input: ReportIssueWorkspaceInput): MultiremiIssueWorkspace {
    const issue = this.ctx.db.query(
      "SELECT issue_key, workspace_id FROM multiremi_issues WHERE id = ?",
    ).get(input.issueId) as Row | null;
    if (!issue) throw new Error(`Issue not found: ${input.issueId}`);
    const issueKey = String(issue.issue_key ?? input.issueId);
    const expectedBranch = `agent/${issueKey}`;
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
    if (current?.runtimeId && current.runtimeId !== input.runtimeId && current.status !== "cleaned") {
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
         updated_at = excluded.updated_at`,
      [
        input.issueId,
        String(issue.workspace_id ?? "local"),
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

  markCleaned(issueId: string, runtimeId: string): MultiremiIssueWorkspace {
    const current = this.get(issueId);
    if (!current) throw new Error(`Issue workspace not found: ${issueId}`);
    if (current.runtimeId !== runtimeId) throw new Error("runtime does not own issue workspace");
    const now = nowIso();
    this.ctx.db.run(
      `UPDATE multiremi_issue_workspaces
       SET status = 'cleaned', repos = '[]', cleaned_at = ?, updated_at = ?
       WHERE issue_id = ? AND runtime_id = ?`,
      [now, now, issueId, runtimeId],
    );
    return this.get(issueId)!;
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
    rootPath: String(row.root_path),
    branchName: String(row.branch_name),
    status: String(row.status) as MultiremiIssueWorkspace["status"],
    repos: parseJson<MultiremiIssueWorkspaceRepo[]>(row.repos, []),
    lastTaskId: nullableString(row.last_task_id),
    cleanedAt: nullableString(row.cleaned_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

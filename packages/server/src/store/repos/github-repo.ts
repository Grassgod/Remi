// GitHub settings + pull-request mirror domain, extracted verbatim from MultiremiStore
// (the facade delegates every public method here).
import { createId, nowIso } from "@multiremi/ids.js";
import { nullableString } from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import type {
  MultiremiGitHubChecksConclusion,
  MultiremiGitHubPullRequest,
  MultiremiGitHubPullRequestState,
  MultiremiGitHubSettings,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export class GitHubRepo {
  constructor(private ctx: StoreContext) {}

  getGitHubSettings(workspaceId = "local"): MultiremiGitHubSettings {
    const row = this.ctx.db.query("SELECT * FROM multiremi_github_settings WHERE workspace_id = ?").get(workspaceId) as Row | null;
    return row ? toGitHubSettings(row) : {
      workspaceId,
      enabled: true,
      prSidebar: true,
      coAuthor: true,
      autoLinkPRs: true,
      updatedAt: null,
    };
  }

  updateGitHubSettings(input: {
    workspaceId?: string | null;
    enabled?: boolean;
    prSidebar?: boolean;
    coAuthor?: boolean;
    autoLinkPRs?: boolean;
  }): MultiremiGitHubSettings {
    const workspaceId = input.workspaceId ?? "local";
    const current = this.getGitHubSettings(workspaceId);
    const enabled = input.enabled ?? current.enabled;
    const prSidebar = input.prSidebar ?? current.prSidebar;
    const coAuthor = input.coAuthor ?? current.coAuthor;
    const autoLinkPRs = input.autoLinkPRs ?? current.autoLinkPRs;
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_github_settings (
        workspace_id, enabled, pr_sidebar, co_author, auto_link_prs, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        enabled = excluded.enabled,
        pr_sidebar = excluded.pr_sidebar,
        co_author = excluded.co_author,
        auto_link_prs = excluded.auto_link_prs,
        updated_at = excluded.updated_at`,
      [
        workspaceId,
        enabled ? 1 : 0,
        prSidebar ? 1 : 0,
        coAuthor ? 1 : 0,
        autoLinkPRs ? 1 : 0,
        now,
      ],
    );
    return this.getGitHubSettings(workspaceId);
  }

  listGitHubPullRequests(input: { workspaceId?: string | null; issueId?: string | null } = {}): MultiremiGitHubPullRequest[] {
    const workspaceId = input.workspaceId ?? "local";
    const rows = input.issueId
      ? this.ctx.db.query("SELECT * FROM multiremi_github_pull_requests WHERE workspace_id = ? AND issue_id = ? ORDER BY pr_updated_at DESC").all(workspaceId, input.issueId) as Row[]
      : this.ctx.db.query("SELECT * FROM multiremi_github_pull_requests WHERE workspace_id = ? ORDER BY pr_updated_at DESC").all(workspaceId) as Row[];
    return rows.map(toGitHubPullRequest);
  }

  listGitHubPullRequestsForIssue(issueId: string): MultiremiGitHubPullRequest[] | null {
    const issue = this.ctx.issues().getIssue(issueId);
    if (!issue) return null;
    return this.listGitHubPullRequests({ workspaceId: issue.workspaceId, issueId });
  }

  upsertGitHubPullRequest(input: {
    id?: string;
    workspaceId?: string | null;
    issueId?: string | null;
    repoOwner: string;
    repoName: string;
    number: number;
    title: string;
    state?: MultiremiGitHubPullRequestState | string;
    htmlUrl?: string | null;
    branch?: string | null;
    authorLogin?: string | null;
    authorAvatarUrl?: string | null;
    mergedAt?: string | null;
    closedAt?: string | null;
    prCreatedAt?: string | null;
    prUpdatedAt?: string | null;
    mergeableState?: string | null;
    checksConclusion?: string | null;
    checksPassed?: number;
    checksFailed?: number;
    checksPending?: number;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
  }): MultiremiGitHubPullRequest {
    const workspaceId = input.workspaceId ?? "local";
    if (!input.repoOwner?.trim()) throw new Error("GitHub repo owner is required");
    if (!input.repoName?.trim()) throw new Error("GitHub repo name is required");
    if (!Number.isFinite(Number(input.number)) || Number(input.number) < 1) throw new Error("GitHub PR number is required");
    const issueId = input.issueId ?? this.findIssueIdForGitHubPullRequest(workspaceId, input);
    if (issueId && !this.ctx.issues().getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const now = nowIso();
    const state = normalizeGitHubPullRequestState(input.state);
    const htmlUrl = input.htmlUrl || `https://github.com/${input.repoOwner}/${input.repoName}/pull/${input.number}`;
    const id = input.id ?? createId("ghp");
    this.ctx.db.run(
      `INSERT INTO multiremi_github_pull_requests (
        id, workspace_id, issue_id, repo_owner, repo_name, number, title, state, html_url, branch,
        author_login, author_avatar_url, merged_at, closed_at, pr_created_at, pr_updated_at,
        mergeable_state, checks_conclusion, checks_passed, checks_failed, checks_pending,
        additions, deletions, changed_files, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, repo_owner, repo_name, number) DO UPDATE SET
        issue_id = excluded.issue_id,
        title = excluded.title,
        state = excluded.state,
        html_url = excluded.html_url,
        branch = excluded.branch,
        author_login = excluded.author_login,
        author_avatar_url = excluded.author_avatar_url,
        merged_at = excluded.merged_at,
        closed_at = excluded.closed_at,
        pr_created_at = excluded.pr_created_at,
        pr_updated_at = excluded.pr_updated_at,
        mergeable_state = excluded.mergeable_state,
        checks_conclusion = excluded.checks_conclusion,
        checks_passed = excluded.checks_passed,
        checks_failed = excluded.checks_failed,
        checks_pending = excluded.checks_pending,
        additions = excluded.additions,
        deletions = excluded.deletions,
        changed_files = excluded.changed_files,
        updated_at = excluded.updated_at`,
      [
        id,
        workspaceId,
        issueId,
        input.repoOwner,
        input.repoName,
        input.number,
        input.title,
        state,
        htmlUrl,
        input.branch ?? null,
        input.authorLogin ?? null,
        input.authorAvatarUrl ?? null,
        input.mergedAt ?? null,
        input.closedAt ?? null,
        input.prCreatedAt ?? now,
        input.prUpdatedAt ?? now,
        input.mergeableState ?? null,
        normalizeGitHubChecksConclusion(input.checksConclusion),
        Math.max(0, Number(input.checksPassed ?? 0)),
        Math.max(0, Number(input.checksFailed ?? 0)),
        Math.max(0, Number(input.checksPending ?? 0)),
        Math.max(0, Number(input.additions ?? 0)),
        Math.max(0, Number(input.deletions ?? 0)),
        Math.max(0, Number(input.changedFiles ?? 0)),
        now,
        now,
      ],
    );
    const pr = this.ctx.db.query(
      "SELECT * FROM multiremi_github_pull_requests WHERE workspace_id = ? AND repo_owner = ? AND repo_name = ? AND number = ?",
    ).get(workspaceId, input.repoOwner, input.repoName, input.number) as Row;
    const result = toGitHubPullRequest(pr);
    if (result.issueId && state === "merged" && this.getGitHubSettings(workspaceId).autoLinkPRs) {
      const issue = this.ctx.issues().getIssue(result.issueId);
      if (issue && issue.status !== "done") this.ctx.issues().updateIssue(issue.id, { status: "done" });
    }
    return result;
  }

  private findIssueIdForGitHubPullRequest(workspaceId: string, input: { title: string; branch?: string | null }): string | null {
    const settings = this.getGitHubSettings(workspaceId);
    if (!settings.enabled || !settings.autoLinkPRs) return null;
    const haystack = [input.title, input.branch ?? ""].join(" ");
    const issues = this.ctx.issues().listIssues().filter((issue) => issue.workspaceId === workspaceId);
    const match = issues.find((issue) => issue.key && new RegExp("\\b" + escapeRegExp(issue.key) + "\\b", "i").test(haystack));
    return match?.id ?? null;
  }
}

function normalizeGitHubPullRequestState(value: unknown): MultiremiGitHubPullRequestState {
  if (value === "closed" || value === "merged" || value === "draft") return value;
  return "open";
}

function normalizeGitHubChecksConclusion(value: unknown): MultiremiGitHubChecksConclusion {
  if (value === "passed" || value === "failed" || value === "pending") return value;
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toGitHubSettings(row: Row): MultiremiGitHubSettings {
  const enabled = Boolean(Number(row.enabled ?? 1));
  return {
    workspaceId: String(row.workspace_id ?? "local"),
    enabled,
    prSidebar: Boolean(Number(row.pr_sidebar ?? 1)),
    coAuthor: Boolean(Number(row.co_author ?? 1)),
    autoLinkPRs: Boolean(Number(row.auto_link_prs ?? 1)),
    updatedAt: nullableString(row.updated_at),
  };
}

function toGitHubPullRequest(row: Row): MultiremiGitHubPullRequest {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: nullableString(row.issue_id),
    repoOwner: String(row.repo_owner ?? ""),
    repoName: String(row.repo_name ?? ""),
    number: Number(row.number ?? 0),
    title: String(row.title ?? ""),
    state: normalizeGitHubPullRequestState(row.state),
    htmlUrl: String(row.html_url ?? ""),
    branch: nullableString(row.branch),
    authorLogin: nullableString(row.author_login),
    authorAvatarUrl: nullableString(row.author_avatar_url),
    mergedAt: nullableString(row.merged_at),
    closedAt: nullableString(row.closed_at),
    prCreatedAt: String(row.pr_created_at),
    prUpdatedAt: String(row.pr_updated_at),
    mergeableState: nullableString(row.mergeable_state),
    checksConclusion: normalizeGitHubChecksConclusion(row.checks_conclusion),
    checksPassed: Number(row.checks_passed ?? 0),
    checksFailed: Number(row.checks_failed ?? 0),
    checksPending: Number(row.checks_pending ?? 0),
    additions: Number(row.additions ?? 0),
    deletions: Number(row.deletions ?? 0),
    changedFiles: Number(row.changed_files ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

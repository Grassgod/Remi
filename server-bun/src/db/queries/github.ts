/**
 * GitHub queries — port of the Go github handler's READ path only
 * (ListGitHubInstallationsByWorkspace + ListPullRequestsByIssue). The
 * GitHub App OAuth / webhook / connect-disconnect writes are intentionally
 * NOT ported here.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import {
  githubInstallation,
  githubPullRequest,
  githubPullRequestCheckSuite,
  issuePullRequest,
} from "../schema.js";

/** schema.ts does not pre-export this type, so derive it from the table. */
export type GithubInstallation = typeof githubInstallation.$inferSelect;

/** Upsert an installation keyed on its numeric GitHub installation_id. */
export async function upsertGithubInstallation(
  db: Db,
  row: { installationId: number; workspaceId: string; accountLogin: string; accountType: string; accountAvatarUrl: string | null; connectedById: string | null },
): Promise<GithubInstallation> {
  const [stored] = await db
    .insert(githubInstallation)
    .values(row)
    .onConflictDoUpdate({
      target: githubInstallation.installationId,
      set: {
        workspaceId: row.workspaceId,
        accountLogin: row.accountLogin,
        accountType: row.accountType,
        accountAvatarUrl: row.accountAvatarUrl,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return stored!;
}

/** Remove a workspace's installation by row id. Returns true if a row was deleted. */
export async function deleteGithubInstallation(db: Db, id: string, wsId: string): Promise<boolean> {
  const rows = await db
    .delete(githubInstallation)
    .where(and(eq(githubInstallation.id, id), eq(githubInstallation.workspaceId, wsId)))
    .returning({ id: githubInstallation.id });
  return rows.length > 0;
}

/** Insertable PR row shape (camelCase JS fields → snake_case columns). */
export type NewGithubPullRequest = typeof githubPullRequest.$inferInsert;
export type GithubPullRequest = typeof githubPullRequest.$inferSelect;

/**
 * A pull-request row joined with the aggregated check-suite counts for the
 * PR's CURRENT head SHA (mirrors Go's ListPullRequestsByIssueRow). The
 * `checks*` fields default to 0 when the PR has no observed suite.
 */
export interface IssuePullRequestRow {
  id: string;
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  title: string;
  state: string;
  htmlUrl: string;
  branch: string | null;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  prCreatedAt: string;
  prUpdatedAt: string;
  mergeableState: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checksTotal: number;
  checksPassed: number;
  checksFailed: number;
  checksPending: number;
}

/**
 * List a workspace's connected GitHub installations, oldest first (mirrors Go
 * ListGitHubInstallationsByWorkspace: ORDER BY created_at ASC).
 */
export async function listGitHubInstallationsByWorkspace(
  db: Db,
  wsId: string,
): Promise<GithubInstallation[]> {
  return db
    .select()
    .from(githubInstallation)
    .where(eq(githubInstallation.workspaceId, wsId))
    .orderBy(asc(githubInstallation.createdAt));
}

/**
 * Look up the installation row by GitHub's numeric installation_id (mirrors Go
 * GetGitHubInstallationByInstallationID). The webhook handler uses this to map
 * an inbound event to a workspace. Returns null when no row matches — the
 * webhook from an installation we never wired up is dropped silently.
 */
export async function getInstallationByInstallationId(
  db: Db,
  installationId: number,
): Promise<GithubInstallation | null> {
  const [row] = await db
    .select()
    .from(githubInstallation)
    .where(eq(githubInstallation.installationId, installationId));
  return row ?? null;
}

/**
 * Upsert a pull-request mirror row keyed on the
 * (workspace_id, repo_owner, repo_name, pr_number) uniqueness tuple — the real
 * identity of a PR within a workspace (mirrors Go UpsertGitHubPullRequest's
 * ON CONFLICT). On conflict we refresh the mutable fields GitHub re-sends on
 * every event; the immutable identity columns are left intact. Returns the
 * stored row.
 */
export async function upsertPullRequest(
  db: Db,
  row: NewGithubPullRequest,
): Promise<GithubPullRequest> {
  const [stored] = await db
    .insert(githubPullRequest)
    .values(row)
    .onConflictDoUpdate({
      // Matches unique constraint
      // github_pull_request_workspace_id_repo_owner_repo_name_pr_nu_key.
      target: [
        githubPullRequest.workspaceId,
        githubPullRequest.repoOwner,
        githubPullRequest.repoName,
        githubPullRequest.prNumber,
      ],
      set: {
        installationId: row.installationId,
        title: row.title,
        state: row.state,
        htmlUrl: row.htmlUrl,
        branch: row.branch ?? null,
        authorLogin: row.authorLogin ?? null,
        authorAvatarUrl: row.authorAvatarUrl ?? null,
        mergedAt: row.mergedAt ?? null,
        closedAt: row.closedAt ?? null,
        prCreatedAt: row.prCreatedAt,
        prUpdatedAt: row.prUpdatedAt,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return stored!;
}

/**
 * List the issue's linked PRs with the aggregated check-suite counts for each
 * PR's CURRENT head SHA (mirrors Go ListPullRequestsByIssue). The per-app
 * latest suite is selected so a single app firing multiple suites on the same
 * head doesn't get counted N times; late-arriving suites for an OLD head are
 * stored but excluded by the head_sha filter. ORDER BY pr_created_at DESC.
 */
export async function listPullRequestsByIssue(
  db: Db,
  issueId: string,
): Promise<IssuePullRequestRow[]> {
  // per-app latest suite for each of this issue's PRs, scoped to the PR's
  // current head SHA (DISTINCT ON (pr_id, app_id) ORDER BY updated_at DESC).
  const perAppLatest = db.$with("per_app_latest").as(
    db
      .selectDistinctOn([githubPullRequestCheckSuite.prId, githubPullRequestCheckSuite.appId], {
        prId: githubPullRequestCheckSuite.prId,
        appId: githubPullRequestCheckSuite.appId,
        conclusion: githubPullRequestCheckSuite.conclusion,
        status: githubPullRequestCheckSuite.status,
      })
      .from(githubPullRequestCheckSuite)
      .innerJoin(githubPullRequest, eq(githubPullRequest.id, githubPullRequestCheckSuite.prId))
      .innerJoin(issuePullRequest, eq(issuePullRequest.pullRequestId, githubPullRequest.id))
      .where(
        and(
          eq(issuePullRequest.issueId, issueId),
          eq(githubPullRequestCheckSuite.headSha, githubPullRequest.headSha),
          sql`${githubPullRequest.headSha} <> ''`,
        ),
      )
      .orderBy(
        asc(githubPullRequestCheckSuite.prId),
        asc(githubPullRequestCheckSuite.appId),
        desc(githubPullRequestCheckSuite.updatedAt),
      ),
  );

  const checks = db.$with("checks").as(
    db
      .with(perAppLatest)
      .select({
        prId: perAppLatest.prId,
        total: sql<number>`count(*)::int`.as("total"),
        failed:
          sql<number>`sum(case when ${perAppLatest.status} = 'completed' and ${perAppLatest.conclusion} in ('failure','cancelled','timed_out','action_required','startup_failure','stale') then 1 else 0 end)::int`.as(
            "failed",
          ),
        passed:
          sql<number>`sum(case when ${perAppLatest.status} = 'completed' and ${perAppLatest.conclusion} in ('success','neutral','skipped') then 1 else 0 end)::int`.as(
            "passed",
          ),
        pending:
          sql<number>`sum(case when ${perAppLatest.status} <> 'completed' or ${perAppLatest.conclusion} is null then 1 else 0 end)::int`.as(
            "pending",
          ),
      })
      .from(perAppLatest)
      .groupBy(perAppLatest.prId),
  );

  const rows = await db
    .with(checks)
    .select({
      id: githubPullRequest.id,
      workspaceId: githubPullRequest.workspaceId,
      repoOwner: githubPullRequest.repoOwner,
      repoName: githubPullRequest.repoName,
      prNumber: githubPullRequest.prNumber,
      title: githubPullRequest.title,
      state: githubPullRequest.state,
      htmlUrl: githubPullRequest.htmlUrl,
      branch: githubPullRequest.branch,
      authorLogin: githubPullRequest.authorLogin,
      authorAvatarUrl: githubPullRequest.authorAvatarUrl,
      mergedAt: githubPullRequest.mergedAt,
      closedAt: githubPullRequest.closedAt,
      prCreatedAt: githubPullRequest.prCreatedAt,
      prUpdatedAt: githubPullRequest.prUpdatedAt,
      mergeableState: githubPullRequest.mergeableState,
      additions: githubPullRequest.additions,
      deletions: githubPullRequest.deletions,
      changedFiles: githubPullRequest.changedFiles,
      checksTotal: sql<number>`coalesce(${checks.total}, 0)::int`,
      checksPassed: sql<number>`coalesce(${checks.passed}, 0)::int`,
      checksFailed: sql<number>`coalesce(${checks.failed}, 0)::int`,
      checksPending: sql<number>`coalesce(${checks.pending}, 0)::int`,
    })
    .from(githubPullRequest)
    .innerJoin(issuePullRequest, eq(issuePullRequest.pullRequestId, githubPullRequest.id))
    .leftJoin(checks, eq(checks.prId, githubPullRequest.id))
    .where(eq(issuePullRequest.issueId, issueId))
    .orderBy(desc(githubPullRequest.prCreatedAt));

  return rows;
}

/**
 * GitHub routes (READ path only) — port of the Go github handler's
 *   GET /api/workspaces/{id}/github/installations  (h.ListGitHubInstallations)
 *   GET /api/issues/{id}/pull-requests             (h.ListPullRequestsForIssue)
 *
 * The GitHub App OAuth / webhook / connect-disconnect writes are intentionally
 * NOT ported.
 *
 * Both routes declare absolute paths (like memberRoutes), so this router is
 * mounted at "/". Behind the /api/* JWT gate. Both require the caller to be a
 * member of the target workspace (multi-tenancy).
 *
 *   - installations: workspace comes from the URL param; member-level access.
 *     The numeric `installation_id` is a management handle, so it is stripped
 *     for non-admin callers and a `can_manage` hint is added so the UI can
 *     gate connect/disconnect (mirrors the Go per-role response).
 *   - pull-requests: the issue in the path is resolved within the workspace
 *     (X-Workspace-ID header), then its linked PRs are listed.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Issue } from "../../db/schema.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getIssueByIdentifier, getMembership } from "../../db/queries/issues.js";
import {
  deleteGithubInstallation,
  listGitHubInstallationsByWorkspace,
  listPullRequestsByIssue,
  upsertGithubInstallation,
  type GithubInstallation,
  type IssuePullRequestRow,
} from "../../db/queries/github.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The GitHub account behind an installation. Fetched from the GitHub API in
 *  production (needs the App's JWT); injected as a fake in tests. */
export interface GithubAppClient {
  fetchInstallationAccount(installationId: number): Promise<{ login: string; accountType: string; avatarUrl: string | null }>;
}

/** Default client — without App credentials it returns a placeholder account so
 *  the connection still records (the real client fetches login/avatar). */
const placeholderAppClient: GithubAppClient = {
  async fetchInstallationAccount(installationId) {
    return { login: `installation-${installationId}`, accountType: "User", avatarUrl: null };
  },
};

/** State token `wsId.nonce.hmac` (HMAC-SHA256 keyed on the webhook secret) —
 *  port of Go signState/verifyState. */
function signState(workspaceId: string, secret: string): string {
  const nonce = randomBytes(12).toString("hex");
  const sig = createHmac("sha256", secret).update(`${workspaceId}.${nonce}`).digest("hex");
  return `${workspaceId}.${nonce}.${sig}`;
}

function verifyState(token: string, secret: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [workspaceId, nonce, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${workspaceId}.${nonce}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return workspaceId;
}

/**
 * isGitHubConfigured returns true only when BOTH the install slug and the
 * webhook secret are set (mirrors the Go isGitHubConfigured). The Connect
 * button uses this single flag, so the frontend never offers a flow the
 * backend would reject.
 */
function isGitHubConfigured(): boolean {
  const slug = (process.env.GITHUB_APP_SLUG ?? "").trim();
  const secret = (process.env.GITHUB_WEBHOOK_SECRET ?? "").trim();
  return slug !== "" && secret !== "";
}

/** Mirrors the Go roleAllowed gate for the can_manage hint. */
function canManageRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Mirrors the Go GitHubInstallationResponse (snake_case JSON). `installationId`
 * is the numeric management handle: admin-only, so the caller passes
 * includeInstallationId=false for non-admins to omit it.
 */
function installationToResponse(i: GithubInstallation, includeInstallationId: boolean) {
  return {
    id: i.id,
    workspace_id: i.workspaceId,
    // Go marks this field `omitempty` and emits the numeric installation_id
    // only for admins; non-admins get the field omitted entirely.
    ...(includeInstallationId ? { installation_id: i.installationId } : {}),
    account_login: i.accountLogin,
    account_type: i.accountType,
    account_avatar_url: i.accountAvatarUrl,
    created_at: i.createdAt,
  };
}

/**
 * Collapse the per-PR check_suite counts into a single status surfaced to the
 * UI (mirrors Go aggregateChecksConclusion): any failed-class suite wins;
 * else any not-yet-completed suite makes it "pending"; else "passed"; no
 * observed suite at all is null (rendered as "no checks" / hidden).
 */
function aggregateChecksConclusion(
  failed: number,
  passed: number,
  pending: number,
  total: number,
): string | null {
  if (total === 0) return null;
  if (failed > 0) return "failed";
  if (pending > 0) return "pending";
  if (passed > 0) return "passed";
  return null;
}

/** Mirrors the Go GitHubPullRequestResponse (snake_case JSON) for issue rows. */
function issuePullRequestToResponse(p: IssuePullRequestRow) {
  return {
    id: p.id,
    workspace_id: p.workspaceId,
    repo_owner: p.repoOwner,
    repo_name: p.repoName,
    number: p.prNumber,
    title: p.title,
    state: p.state,
    html_url: p.htmlUrl,
    branch: p.branch,
    author_login: p.authorLogin,
    author_avatar_url: p.authorAvatarUrl,
    merged_at: p.mergedAt,
    closed_at: p.closedAt,
    pr_created_at: p.prCreatedAt,
    pr_updated_at: p.prUpdatedAt,
    mergeable_state: p.mergeableState,
    checks_conclusion: aggregateChecksConclusion(
      p.checksFailed,
      p.checksPassed,
      p.checksPending,
      p.checksTotal,
    ),
    checks_passed: p.checksPassed,
    checks_failed: p.checksFailed,
    checks_pending: p.checksPending,
    additions: p.additions,
    deletions: p.deletions,
    changed_files: p.changedFiles,
  };
}

/**
 * Resolve + authorize the workspace by a candidate id. Returns the member row
 * (so callers can read the role for can_manage) or a Response to short-circuit
 * with (400 missing/malformed, 404 not-a-member — mirrors the Go
 * workspace-member gate).
 */
async function requireMembership(c: Context<AppEnv>, db: Db, candidate: string | undefined, missingMsg: string) {
  if (!candidate || !UUID_RE.test(candidate)) {
    return c.json({ error: missingMsg }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, candidate);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return m;
}

/**
 * Resolve the issue in the path within the workspace (loadIssueForUser
 * equivalent). Returns the issue or a 404 Response.
 */
async function requireIssue(c: Context<AppEnv>, db: Db, wsId: string): Promise<Issue | Response> {
  const found = await getIssueByIdentifier(db, wsId, c.req.param("id") ?? "");
  if (!found) return c.json({ error: "issue not found" }, 404);
  return found;
}

export function githubRoutes(db?: Db, appClient: GithubAppClient = placeholderAppClient): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // List a workspace's connected GitHub installations. Workspace from the URL
  // param; member-level access. Strips installation_id for non-admins and adds
  // a can_manage hint (mirrors Go ListGitHubInstallations).
  r.get("/api/workspaces/:id/github/installations", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const m = await requireMembership(c, db, c.req.param("id"), "workspace id is required");
    if (m instanceof Response) return m;

    const canManage = canManageRole(m.role);
    const rows = await listGitHubInstallationsByWorkspace(db, m.workspaceId);
    return c.json({
      installations: rows.map((row) => installationToResponse(row, canManage)),
      configured: isGitHubConfigured(),
      can_manage: canManage,
    });
  });

  // List an issue's linked pull requests with aggregated check counts.
  r.get("/api/issues/:id/pull-requests", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const m = await requireMembership(
      c,
      db,
      c.req.header("X-Workspace-ID") ?? c.get("wsId"),
      "X-Workspace-ID header required",
    );
    if (m instanceof Response) return m;
    const issue = await requireIssue(c, db, m.workspaceId);
    if (issue instanceof Response) return issue;

    const rows = await listPullRequestsByIssue(db, issue.id);
    return c.json({ pull_requests: rows.map(issuePullRequestToResponse) });
  });

  // GET /api/workspaces/:id/github/connect — the App install URL (owner/admin).
  // When unconfigured, { configured: false } so the UI hides the flow. The
  // OAuth setup callback that creates the installation row is not ported.
  r.get("/api/workspaces/:id/github/connect", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const m = await requireMembership(c, db, c.req.param("id"), "workspace id is required");
    if (m instanceof Response) return m;
    if (!canManageRole(m.role)) return c.json({ error: "insufficient permissions" }, 403);
    if (!isGitHubConfigured()) return c.json({ configured: false });

    const slug = (process.env.GITHUB_APP_SLUG ?? "").trim();
    // HMAC-signed state carrying the target workspace; the setup callback
    // verifies it (port of Go signState/verifyState, keyed on the webhook secret).
    const state = signState(m.workspaceId, (process.env.GITHUB_WEBHOOK_SECRET ?? "").trim());
    const installUrl = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
    return c.json({ configured: true, install_url: installUrl });
  });

  // GET /api/github/setup?installation_id=&state= — the App install callback.
  // GitHub redirects the user's browser here after install (so the session
  // cookie authenticates them). Verify the signed state → workspace, confirm
  // the caller may manage it, fetch the account, upsert the installation,
  // then redirect back to settings.
  r.get("/api/github/setup", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const frontend = (process.env.FRONTEND_ORIGIN ?? "").trim();
    const settings = (q: string) => c.redirect(`${frontend}/settings/integrations?${q}`, 302);

    const installationIdStr = c.req.query("installation_id") ?? "";
    const state = c.req.query("state") ?? "";
    if (!installationIdStr || !state) return settings("github_error=missing_params");

    const secret = (process.env.GITHUB_WEBHOOK_SECRET ?? "").trim();
    const workspaceId = secret ? verifyState(state, secret) : null;
    if (!workspaceId || !UUID_RE.test(workspaceId)) return settings("github_error=invalid_state");

    const installationId = Number.parseInt(installationIdStr, 10);
    if (!Number.isFinite(installationId) || installationId <= 0) return settings("github_error=bad_installation_id");

    // The signed-in caller must be a member who can manage this workspace.
    const m = await getMembership(db, c.get("user").sub, workspaceId);
    if (!m || !canManageRole(m.role)) return settings("github_error=forbidden");

    const account = await appClient.fetchInstallationAccount(installationId);
    await upsertGithubInstallation(db, {
      installationId,
      workspaceId,
      accountLogin: account.login,
      accountType: account.accountType,
      accountAvatarUrl: account.avatarUrl,
      connectedById: c.get("user").sub,
    });
    bus.publish({ type: "github.installation_created", workspaceId, payload: { installation_id: installationId } });
    return settings("github_connected=1");
  });

  // DELETE /api/workspaces/:id/github/installations/:installationId — disconnect.
  r.delete("/api/workspaces/:id/github/installations/:installationId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const m = await requireMembership(c, db, c.req.param("id"), "workspace id is required");
    if (m instanceof Response) return m;
    if (!canManageRole(m.role)) return c.json({ error: "insufficient permissions" }, 403);

    const installationId = c.req.param("installationId");
    if (!installationId || !UUID_RE.test(installationId)) return c.json({ error: "installation id is required" }, 400);
    const removed = await deleteGithubInstallation(db, installationId, m.workspaceId);
    if (!removed) return c.json({ error: "installation not found" }, 404);
    bus.publish({ type: "github.installation_deleted", workspaceId: m.workspaceId, payload: { id: installationId } });
    return c.body(null, 204);
  });

  return r;
}

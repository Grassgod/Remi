import type { Hono } from "hono";
import {
  denyCurrentUserWorkspaceAccess,
  githubSetupResponse,
  handleGitHubWebhook,
  normalizeGitHubPullRequestBody,
  readJson,
} from "../helpers.js";
import {
  issuePullRequestsResponse,
} from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

export function registerGithubRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/github/setup", (c) => c.json(githubSetupResponse(c.req.query("installation_id"), c.req.query("state"))));

  app.get("/api/multiremi/github/settings", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json({ settings: store.getGitHubSettings(workspaceId) });
  });
  app.put("/api/multiremi/github/settings", async (c) => {
    const body = await readJson<{ workspaceId?: string | null; workspace_id?: string | null; enabled?: boolean; prSidebar?: boolean; pr_sidebar?: boolean; coAuthor?: boolean; co_author?: boolean; autoLinkPRs?: boolean; auto_link_prs?: boolean }>(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
    return c.json({
      settings: store.updateGitHubSettings({
        workspaceId: body.workspaceId ?? body.workspace_id,
        enabled: body.enabled,
        prSidebar: body.prSidebar ?? body.pr_sidebar,
        coAuthor: body.coAuthor ?? body.co_author,
        autoLinkPRs: body.autoLinkPRs ?? body.auto_link_prs,
      }),
    });
  });
  app.get("/api/multiremi/github/pull-requests", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const pullRequests = store.listGitHubPullRequests({
      workspaceId,
      issueId: c.req.query("issueId") ?? c.req.query("issue_id"),
    });
    return c.json({ pullRequests, total: pullRequests.length });
  });
  app.get("/api/issues/:id/pull-requests", (c) => {
    const pullRequests = store.listGitHubPullRequestsForIssue(c.req.param("id"));
    if (!pullRequests) return c.json({ error: "issue not found" }, 404);
    return c.json(issuePullRequestsResponse(pullRequests));
  });
  app.get("/api/multiremi/issues/:id/pull-requests", (c) => {
    const pullRequests = store.listGitHubPullRequestsForIssue(c.req.param("id"));
    if (!pullRequests) return c.json({ error: "issue not found" }, 404);
    return c.json(issuePullRequestsResponse(pullRequests));
  });
  app.post("/api/multiremi/github/pull-requests", async (c) => {
    const body = await readJson<any>(c);
    const normalized = normalizeGitHubPullRequestBody(body);
    const denied = denyCurrentUserWorkspaceAccess(c, store, normalized.workspaceId ?? "local");
    if (denied) return denied;
    return c.json({ pullRequest: store.upsertGitHubPullRequest(normalized) }, 201);
  });
  app.post("/api/multiremi/github/webhook", async (c) => {
    const body = await readJson<any>(c);
    return c.json(handleGitHubWebhook(store, body), 202);
  });
}

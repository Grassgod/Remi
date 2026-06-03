import { Hono } from "hono";
import { cors } from "hono/cors";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { createLogger } from "../logger.js";
import { renderMulticaDashboardHtml } from "./dashboard.js";
import { MulticaScheduler } from "./scheduler.js";
import { buildImportedSkillInput, SkillImportError } from "./skill-import.js";
import { MulticaStore } from "./store.js";
import type {
  AddSquadMemberInput,
  AssignIssueInput,
  CreateAccessTokenInput,
  CreateAttachmentInput,
  CreateAgentInput,
  CreateAutopilotInput,
  CreateChatSessionInput,
  CreateIssueDependencyInput,
  CreateIssueCommentInput,
  CreateIssueInput,
  CreateIssueWithTaskInput,
  CreateLabelInput,
  CreatePinnedItemInput,
  CreateProjectInput,
  CreateProjectResourceInput,
  CreateSkillInput,
  CreateSquadInput,
  CreateTaskInput,
  CreateWorkspaceMemberInput,
  ImportSkillInput,
  RegisterRuntimeInput,
  ReorderPinnedItemInput,
  RemoveSquadMemberInput,
  RunAutopilotInput,
  SendChatMessageInput,
  CreateMulticaReactionInput,
  MulticaNotificationPreferences,
  MulticaSkill,
  MulticaSubscriptionReason,
  MulticaGitHubPullRequestState,
  MulticaWebhookDeliveryResult,
  MulticaWebhookProvider,
  MulticaWebhookSignatureStatus,
  SetAgentSkillsInput,
  UpdateAgentInput,
  UpdateAutopilotInput,
  UpdateChatSessionInput,
  UpdateIssueInput,
  UpdateIssueCommentInput,
  UpdateLabelInput,
  UpdateProjectInput,
  UpdateRuntimeInput,
  UpdateSkillInput,
  UpdateSquadInput,
  UpdateWorkspaceMemberInput,
} from "./types.js";

const log = createLogger("multica-api");
const SUBSCRIPTION_REASONS: MulticaSubscriptionReason[] = ["created", "assigned", "commented", "mentioned", "manual"];
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

type NormalizedGitHubPullRequestBody = {
  workspaceId: string | null;
  issueId: string | null;
  repoOwner: string;
  repoName: string;
  number: number;
  title: string;
  state?: MulticaGitHubPullRequestState | string;
  htmlUrl: string | null;
  branch: string | null;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  prCreatedAt: string | null;
  prUpdatedAt: string | null;
  mergeableState: string | null;
  checksConclusion: string | null;
  checksPassed: number;
  checksFailed: number;
  checksPending: number;
  additions: number;
  deletions: number;
  changedFiles: number;
};

export interface MulticaApiOptions {
  store?: MulticaStore;
  scheduler?: MulticaScheduler | null;
  authToken?: string | null;
  hostname?: string;
}

export function createMulticaApp(options: MulticaApiOptions = {}): Hono {
  const store = options.store ?? new MulticaStore();
  const scheduler = options.scheduler ?? null;
  const authToken = options.authToken ?? process.env.MULTICA_TOKEN ?? "";
  const app = new Hono();

  app.use("*", cors());
  app.get("/", (c) => c.html(renderMulticaDashboardHtml()));

  if (authToken) {
    app.use("*", async (c, next) => {
      const header = c.req.header("Authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (token !== authToken && !await store.verifyAccessToken(token)) return c.json({ error: "unauthorized" }, 401);
      await next();
    });
  }

  app.onError((err, c) => {
    log.error(err.message);
    if (err instanceof SkillImportError) {
      return c.json({ error: err.message }, err.status as 400 | 502);
    }
    return c.json({ error: err.message }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/multica/health", (c) => c.json({ ok: true }));

  app.get("/api/multica/agents", (c) => c.json({ agents: store.listAgents() }));
  app.post("/api/multica/agents", async (c) => {
    const body = await readJson<CreateAgentInput>(c);
    return c.json({ agent: store.createAgent(body) }, 201);
  });
  app.post("/api/multica/agents/default", async (c) => {
    const body = await readJson<{ provider?: string }>(c);
    return c.json({ agent: store.ensureDefaultAgent(body.provider ?? "claude") }, 201);
  });
  app.get("/api/multica/agents/:id", (c) => {
    const agent = store.getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);
    return c.json({ agent });
  });
  app.patch("/api/multica/agents/:id", async (c) => {
    const body = await readJson<UpdateAgentInput>(c);
    return c.json({ agent: store.updateAgent(c.req.param("id"), body) });
  });
  app.delete("/api/multica/agents/:id", (c) => {
    return c.json({ agent: store.archiveAgent(c.req.param("id")) });
  });
  app.get("/api/multica/agents/:id/skills", (c) => {
    const skills = store.listAgentSkills(c.req.param("id"));
    return c.json({ skills, total: skills.length });
  });
  app.put("/api/multica/agents/:id/skills", async (c) => {
    const body = await readJson<SetAgentSkillsInput>(c);
    const skills = store.setAgentSkills(c.req.param("id"), body);
    return c.json({ skills, total: skills.length });
  });
  app.get("/api/agents/:id/skills", (c) => c.json(store.listAgentSkills(c.req.param("id"), { includeFiles: false })));
  app.put("/api/agents/:id/skills", async (c) => {
    const body = await readJson<SetAgentSkillsInput>(c);
    return c.json(store.setAgentSkills(c.req.param("id"), body).map(skillSummary));
  });

  app.get("/api/multica/skills", (c) => {
    const includeFiles = c.req.query("includeFiles") === "true";
    const skills = store.listSkills(c.req.query("workspaceId") ?? c.req.query("workspace_id"), { includeFiles });
    return c.json({ skills: includeFiles ? skills : skills.map(skillSummary), total: skills.length });
  });
  app.post("/api/multica/skills", async (c) => {
    const body = await readJson<CreateSkillInput>(c);
    return c.json({ skill: store.createSkill(body) }, 201);
  });
  app.post("/api/multica/skills/import", async (c) => {
    const body = await readJson<ImportSkillInput>(c);
    const imported = await buildImportedSkillInput(body);
    const skill = store.createSkill(imported.skillInput);
    return c.json({ skill, source: imported.source, sourceUrl: imported.sourceUrl }, 201);
  });
  app.get("/api/multica/skills/:id", (c) => {
    const skill = store.getSkill(c.req.param("id"));
    if (!skill) return c.json({ error: "skill not found" }, 404);
    return c.json({ skill });
  });
  app.patch("/api/multica/skills/:id", async (c) => {
    const body = await readJson<UpdateSkillInput>(c);
    return c.json({ skill: store.updateSkill(c.req.param("id"), body) });
  });
  app.delete("/api/multica/skills/:id", (c) => {
    return c.json({ skill: store.archiveSkill(c.req.param("id")) });
  });
  app.get("/api/skills", (c) => c.json(store.listSkills(c.req.query("workspaceId") ?? c.req.query("workspace_id"), { includeFiles: false }).map(skillSummary)));
  app.post("/api/skills", async (c) => {
    const body = await readJson<CreateSkillInput>(c);
    return c.json(store.createSkill(body), 201);
  });
  app.post("/api/skills/import", async (c) => {
    const body = await readJson<ImportSkillInput>(c);
    const imported = await buildImportedSkillInput(body);
    return c.json(store.createSkill(imported.skillInput), 201);
  });
  app.get("/api/skills/:id", (c) => {
    const skill = store.getSkill(c.req.param("id"));
    if (!skill) return c.json({ error: "skill not found" }, 404);
    return c.json(skill);
  });
  app.patch("/api/skills/:id", async (c) => {
    const body = await readJson<UpdateSkillInput>(c);
    return c.json(store.updateSkill(c.req.param("id"), body));
  });
  app.delete("/api/skills/:id", (c) => {
    store.archiveSkill(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/multica/members", (c) => {
    const members = store.listWorkspaceMembers(c.req.query("workspaceId"));
    return c.json({ members, total: members.length });
  });
  app.post("/api/multica/members", async (c) => {
    const body = await readJson<CreateWorkspaceMemberInput>(c);
    return c.json({ member: store.createWorkspaceMember(body) }, 201);
  });
  app.get("/api/multica/members/:id", (c) => {
    const member = store.getWorkspaceMember(c.req.param("id"));
    if (!member) return c.json({ error: "member not found" }, 404);
    return c.json({ member });
  });
  app.patch("/api/multica/members/:id", async (c) => {
    const body = await readJson<UpdateWorkspaceMemberInput>(c);
    return c.json({ member: store.updateWorkspaceMember(c.req.param("id"), body) });
  });
  app.delete("/api/multica/members/:id", (c) => {
    return c.json({ member: store.archiveWorkspaceMember(c.req.param("id")) });
  });

  app.get("/api/multica/tokens", (c) => {
    const tokens = store.listAccessTokens(c.req.query("workspaceId") ?? c.req.query("workspace_id"));
    return c.json({ tokens, total: tokens.length });
  });
  app.post("/api/multica/tokens", async (c) => {
    const body = await readJson<CreateAccessTokenInput>(c);
    return c.json({ token: await store.createAccessToken(body) }, 201);
  });
  app.delete("/api/multica/tokens/:id", (c) => {
    const token = store.revokeAccessToken(c.req.param("id"));
    return c.json({ token, ok: true });
  });
  app.get("/api/multica/notification-preferences", (c) => {
    return c.json(store.getNotificationPreferences({
      workspaceId: c.req.query("workspaceId") ?? c.req.query("workspace_id"),
      memberId: c.req.query("memberId") ?? c.req.query("member_id"),
    }));
  });
  app.put("/api/multica/notification-preferences", async (c) => {
    const body = await readJson<{ workspaceId?: string | null; workspace_id?: string | null; memberId?: string | null; member_id?: string | null; preferences?: MulticaNotificationPreferences }>(c);
    return c.json(store.updateNotificationPreferences({
      workspaceId: body.workspaceId ?? body.workspace_id,
      memberId: body.memberId ?? body.member_id,
      preferences: body.preferences ?? {},
    }));
  });
  app.get("/api/notification-preferences", (c) => {
    return c.json(store.getNotificationPreferences({
      workspaceId: c.req.query("workspaceId") ?? c.req.query("workspace_id"),
      memberId: c.req.query("memberId") ?? c.req.query("member_id"),
    }));
  });
  app.put("/api/notification-preferences", async (c) => {
    const body = await readJson<MulticaNotificationPreferences & { workspaceId?: string | null; workspace_id?: string | null; memberId?: string | null; member_id?: string | null; preferences?: MulticaNotificationPreferences }>(c);
    return c.json(store.updateNotificationPreferences({
      workspaceId: body.workspaceId ?? body.workspace_id,
      memberId: body.memberId ?? body.member_id,
      preferences: body.preferences ?? body,
    }));
  });
  app.get("/api/multica/github/settings", (c) => {
    return c.json({ settings: store.getGitHubSettings(c.req.query("workspaceId") ?? "local") });
  });
  app.put("/api/multica/github/settings", async (c) => {
    const body = await readJson<{ workspaceId?: string | null; workspace_id?: string | null; enabled?: boolean; prSidebar?: boolean; pr_sidebar?: boolean; coAuthor?: boolean; co_author?: boolean; autoLinkPRs?: boolean; auto_link_prs?: boolean }>(c);
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
  app.get("/api/multica/github/pull-requests", (c) => {
    const pullRequests = store.listGitHubPullRequests({
      workspaceId: c.req.query("workspaceId") ?? c.req.query("workspace_id"),
      issueId: c.req.query("issueId") ?? c.req.query("issue_id"),
    });
    return c.json({ pullRequests, total: pullRequests.length });
  });
  app.post("/api/multica/github/pull-requests", async (c) => {
    const body = await readJson<any>(c);
    return c.json({ pullRequest: store.upsertGitHubPullRequest(normalizeGitHubPullRequestBody(body)) }, 201);
  });
  app.post("/api/multica/github/webhook", async (c) => {
    const body = await readJson<any>(c);
    if (body.zen) return c.json({ ok: "pong" });
    const pr = body.pull_request;
    const repo = body.repository;
    if (!pr || !repo) return c.json({ ok: true, ignored: true });
    const pullRequest = store.upsertGitHubPullRequest(normalizeGitHubPullRequestBody({
      workspaceId: body.workspaceId ?? body.workspace_id ?? "local",
      repoOwner: repo.owner?.login,
      repoName: repo.name,
      number: pr.number,
      title: pr.title,
      state: pr.merged ? "merged" : pr.draft ? "draft" : pr.state,
      htmlUrl: pr.html_url,
      branch: pr.head?.ref,
      authorLogin: pr.user?.login,
      authorAvatarUrl: pr.user?.avatar_url,
      mergedAt: pr.merged_at,
      closedAt: pr.closed_at,
      prCreatedAt: pr.created_at,
      prUpdatedAt: pr.updated_at,
      mergeableState: pr.mergeable_state,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
    }));
    return c.json({ pullRequest }, 202);
  });
  app.get("/api/tokens", (c) => {
    const tokens = store.listAccessTokens(c.req.query("workspaceId") ?? c.req.query("workspace_id"));
    return c.json(tokens);
  });
  app.post("/api/tokens", async (c) => {
    const body = await readJson<CreateAccessTokenInput>(c);
    return c.json(await store.createAccessToken(body), 201);
  });
  app.delete("/api/tokens/:id", (c) => {
    store.revokeAccessToken(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/multica/runtimes", (c) => c.json({ runtimes: store.listRuntimes() }));
  app.post("/api/multica/runtimes", async (c) => {
    const body = await readJson<RegisterRuntimeInput>(c);
    return c.json({ runtime: store.registerRuntime(body) }, 201);
  });
  app.get("/api/multica/runtimes/:id", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json({ runtime, usage: store.listRuntimeUsage(runtime.id) });
  });
  app.patch("/api/multica/runtimes/:id", async (c) => {
    const body = await readJson<UpdateRuntimeInput>(c);
    return c.json({ runtime: store.updateRuntime(c.req.param("id"), body) });
  });
  app.get("/api/multica/runtimes/:id/models", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json({ runtimeId: runtime.id, supported: true, models: store.listRuntimeModels(runtime.id) });
  });
  app.put("/api/multica/runtimes/:id/models", async (c) => {
    const body = await readJson<{ models?: any[]; supported?: boolean }>(c);
    return c.json({ runtimeId: c.req.param("id"), supported: body.supported !== false, models: store.updateRuntimeModels(c.req.param("id"), body.models ?? []) });
  });
  app.get("/api/runtimes/:id/models", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json({ runtime_id: runtime.id, supported: true, models: store.listRuntimeModels(runtime.id) });
  });
  app.put("/api/runtimes/:id/models", async (c) => {
    const body = await readJson<{ models?: any[]; supported?: boolean }>(c);
    return c.json({ runtime_id: c.req.param("id"), supported: body.supported !== false, models: store.updateRuntimeModels(c.req.param("id"), body.models ?? []) });
  });
  app.get("/api/multica/runtimes/:id/usage", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json({ runtimeId: runtime.id, usage: store.listRuntimeUsage(runtime.id) });
  });
  app.get("/api/multica/runtimes/:id/usage/by-agent", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json({ usage: store.listUsageByAgent(usageQuery(c, { runtimeId: runtime.id })) });
  });
  app.get("/api/multica/runtimes/:id/usage/by-hour", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json({ usage: store.listUsageByHour(usageQuery(c, { runtimeId: runtime.id })) });
  });
  app.get("/api/multica/runtimes/:id/task-activity", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json({ activity: store.listTaskActivityByHour(usageQuery(c, { runtimeId: runtime.id })) });
  });
  app.get("/api/runtimes", (c) => c.json({ runtimes: store.listRuntimes() }));
  app.get("/api/runtimes/:id", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json({ runtime, usage: store.listRuntimeUsage(runtime.id) });
  });
  app.patch("/api/runtimes/:id", async (c) => {
    const body = await readJson<UpdateRuntimeInput>(c);
    return c.json({ runtime: store.updateRuntime(c.req.param("id"), body) });
  });
  app.get("/api/runtimes/:id/usage", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json(store.listUsageDaily(usageQuery(c, { runtimeId: runtime.id })));
  });
  app.get("/api/runtimes/:id/usage/by-agent", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json(store.listUsageByAgent(usageQuery(c, { runtimeId: runtime.id })));
  });
  app.get("/api/runtimes/:id/usage/by-hour", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json(store.listUsageByHour(usageQuery(c, { runtimeId: runtime.id })));
  });
  app.get("/api/runtimes/:id/task-activity", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json(store.listTaskActivityByHour(usageQuery(c, { runtimeId: runtime.id })));
  });
  app.post("/api/multica/runtimes/:id/heartbeat", (c) => {
    store.heartbeatRuntime(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/dashboard/usage/daily", (c) => c.json(store.listUsageDaily(usageQuery(c))));
  app.get("/api/dashboard/usage/by-agent", (c) => c.json(store.listUsageByAgent(usageQuery(c))));
  app.get("/api/dashboard/agent-runtime", (c) => c.json(store.listRuntimeDaily(usageQuery(c))));
  app.get("/api/dashboard/runtime/daily", (c) => c.json(store.listRuntimeDaily(usageQuery(c))));

  app.get("/api/multica/projects", (c) => {
    const projects = store.listProjects(c.req.query("workspaceId"));
    return c.json({ projects, total: projects.length });
  });
  app.get("/api/multica/projects/search", (c) => {
    const result = store.searchProjects({
      q: c.req.query("q") ?? "",
      workspaceId: c.req.query("workspaceId"),
      includeClosed: c.req.query("include_closed") === "true" || c.req.query("includeClosed") === "true",
      limit: parseOptionalInt(c.req.query("limit")),
      offset: parseOptionalInt(c.req.query("offset")),
    });
    return c.json(result);
  });
  app.get("/api/projects/search", (c) => {
    const result = store.searchProjects({
      q: c.req.query("q") ?? "",
      workspaceId: c.req.query("workspaceId"),
      includeClosed: c.req.query("include_closed") === "true" || c.req.query("includeClosed") === "true",
      limit: parseOptionalInt(c.req.query("limit")),
      offset: parseOptionalInt(c.req.query("offset")),
    });
    return c.json(result);
  });
  app.post("/api/multica/projects", async (c) => {
    const body = await readJson<CreateProjectInput>(c);
    return c.json({ project: store.createProject(body) }, 201);
  });
  app.get("/api/multica/projects/:id", (c) => {
    const project = store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json({ project, resources: store.listProjectResources(project.id) });
  });
  app.patch("/api/multica/projects/:id", async (c) => {
    const body = await readJson<UpdateProjectInput>(c);
    return c.json({ project: store.updateProject(c.req.param("id"), body) });
  });
  app.delete("/api/multica/projects/:id", (c) => {
    return c.json({ project: store.archiveProject(c.req.param("id")) });
  });
  app.get("/api/multica/projects/:id/resources", (c) => {
    const resources = store.listProjectResources(c.req.param("id"));
    return c.json({ resources, total: resources.length });
  });
  app.post("/api/multica/projects/:id/resources", async (c) => {
    const body = await readJson<CreateProjectResourceInput>(c);
    return c.json({ resource: store.createProjectResource(c.req.param("id"), body) }, 201);
  });
  app.delete("/api/multica/projects/:id/resources/:resourceId", (c) => {
    store.deleteProjectResource(c.req.param("id"), c.req.param("resourceId"));
    return c.json({ ok: true });
  });

  app.get("/api/multica/squads", (c) => {
    const squads = store.listSquads(c.req.query("workspaceId"));
    return c.json({ squads, total: squads.length });
  });
  app.post("/api/multica/squads", async (c) => {
    const body = await readJson<CreateSquadInput>(c);
    return c.json({ squad: store.createSquad(body) }, 201);
  });
  app.get("/api/multica/squads/:id", (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad) return c.json({ error: "squad not found" }, 404);
    return c.json({ squad, members: store.listSquadMembers(squad.id) });
  });
  app.patch("/api/multica/squads/:id", async (c) => {
    const body = await readJson<UpdateSquadInput>(c);
    return c.json({ squad: store.updateSquad(c.req.param("id"), body) });
  });
  app.delete("/api/multica/squads/:id", (c) => {
    return c.json({ squad: store.archiveSquad(c.req.param("id")) });
  });
  app.get("/api/multica/squads/:id/members", (c) => {
    return c.json({ members: store.listSquadMembers(c.req.param("id")) });
  });
  app.post("/api/multica/squads/:id/members", async (c) => {
    const body = await readJson<AddSquadMemberInput>(c);
    return c.json({ member: store.addSquadMember(c.req.param("id"), body) }, 201);
  });
  app.patch("/api/multica/squads/:id/members", async (c) => {
    const body = await readJson<AddSquadMemberInput>(c);
    return c.json({ member: store.addSquadMember(c.req.param("id"), body) });
  });
  app.delete("/api/multica/squads/:id/members", async (c) => {
    const body = await readJson<RemoveSquadMemberInput>(c);
    store.removeSquadMember(c.req.param("id"), body);
    return c.json({ ok: true });
  });

  app.get("/api/multica/autopilots", (c) => {
    const autopilots = store.listAutopilots(c.req.query("workspaceId"));
    return c.json({ autopilots, total: autopilots.length });
  });
  app.post("/api/multica/autopilots", async (c) => {
    const body = await readJson<CreateAutopilotInput>(c);
    const autopilot = store.createAutopilot(body);
    scheduler?.sync();
    return c.json({ autopilot }, 201);
  });
  app.get("/api/multica/autopilots/:id", (c) => {
    const autopilot = store.getAutopilot(c.req.param("id"));
    if (!autopilot) return c.json({ error: "autopilot not found" }, 404);
    return c.json({
      autopilot,
      runs: store.listAutopilotRuns(autopilot.id),
      deliveries: store.listWebhookDeliveries(autopilot.id),
    });
  });
  app.patch("/api/multica/autopilots/:id", async (c) => {
    const body = await readJson<UpdateAutopilotInput>(c);
    const autopilot = store.updateAutopilot(c.req.param("id"), body);
    scheduler?.sync();
    return c.json({ autopilot });
  });
  app.delete("/api/multica/autopilots/:id", (c) => {
    const autopilot = store.archiveAutopilot(c.req.param("id"));
    scheduler?.sync();
    return c.json({ autopilot });
  });
  app.get("/api/multica/autopilots/:id/runs", (c) => {
    return c.json({ runs: store.listAutopilotRuns(c.req.param("id")) });
  });
  app.get("/api/multica/autopilots/:id/deliveries", (c) => {
    const deliveries = store.listWebhookDeliveries(c.req.param("id"));
    return c.json({ deliveries, total: deliveries.length });
  });
  app.get("/api/multica/autopilots/:id/deliveries/:deliveryId", (c) => {
    const delivery = store.getWebhookDelivery(c.req.param("deliveryId"));
    if (!delivery || delivery.autopilotId !== c.req.param("id")) return c.json({ error: "delivery not found" }, 404);
    return c.json({ delivery });
  });
  app.post("/api/multica/autopilots/:id/deliveries/:deliveryId/replay", (c) => {
    const result = store.replayWebhookDelivery(c.req.param("id"), c.req.param("deliveryId"));
    return c.json({ ...webhookDeliveryResponse(result) }, 201);
  });
  app.post("/api/multica/autopilots/:id/run", async (c) => {
    const body = await readJson<RunAutopilotInput>(c);
    return c.json({ run: store.runAutopilot(c.req.param("id"), body) }, 201);
  });
  app.post("/api/multica/autopilots/:id/run-scheduled", (c) => {
    const run = scheduler?.trigger(c.req.param("id")) ?? store.runAutopilot(c.req.param("id"), { source: "schedule" });
    return c.json({ run }, 201);
  });
  app.get("/api/multica/scheduler", (c) => {
    return c.json({
      enabled: Boolean(scheduler),
      scheduledIds: scheduler?.scheduledIds() ?? [],
      total: scheduler?.scheduledCount() ?? 0,
    });
  });
  app.post("/api/multica/autopilots/:id/trigger", async (c) => {
    const body = await readJson<RunAutopilotInput>(c);
    return c.json({
      run: store.runAutopilot(c.req.param("id"), { ...body, source: body.source ?? "api" }),
    }, 201);
  });
  app.post("/api/multica/autopilots/:id/webhook", async (c) => {
    const rawBody = await c.req.raw.text();
    let body: RunAutopilotInput & { payload?: unknown };
    try {
      body = parseJsonBody<RunAutopilotInput & { payload?: unknown }>(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const headers = headersToRecord(c.req.raw.headers);
    const provider = headers["x-github-event"] ? "github" : "generic";
    const signatureStatus = webhookSignatureStatus(provider, headers, rawBody);
    const result = store.handleAutopilotWebhook(c.req.param("id"), {
      prompt: body.prompt ?? null,
      payload: body.payload ?? body,
      rawBody,
      headers,
      provider,
      signatureStatus,
    });
    const statusCode = result.status === "rejected" ? 401 : result.status === "accepted" ? 201 : result.status === "failed" ? 500 : 200;
    return c.json(webhookDeliveryResponse(result), statusCode);
  });

  app.get("/api/multica/labels", (c) => {
    const labels = store.listLabels(c.req.query("workspaceId"));
    return c.json({ labels, total: labels.length });
  });
  app.post("/api/multica/labels", async (c) => {
    const body = await readJson<CreateLabelInput>(c);
    return c.json({ label: store.createLabel(body) }, 201);
  });
  app.get("/api/multica/labels/:id", (c) => {
    const label = store.getLabel(c.req.param("id"));
    if (!label) return c.json({ error: "label not found" }, 404);
    return c.json({ label });
  });
  app.patch("/api/multica/labels/:id", async (c) => {
    const body = await readJson<UpdateLabelInput>(c);
    return c.json({ label: store.updateLabel(c.req.param("id"), body) });
  });
  app.put("/api/multica/labels/:id", async (c) => {
    const body = await readJson<UpdateLabelInput>(c);
    return c.json({ label: store.updateLabel(c.req.param("id"), body) });
  });
  app.delete("/api/multica/labels/:id", (c) => {
    return c.json({ label: store.deleteLabel(c.req.param("id")) });
  });

  app.get("/api/labels", (c) => {
    const labels = store.listLabels(c.req.query("workspaceId"));
    return c.json({ labels, total: labels.length });
  });
  app.post("/api/labels", async (c) => {
    const body = await readJson<CreateLabelInput>(c);
    return c.json({ label: store.createLabel(body) }, 201);
  });
  app.get("/api/labels/:id", (c) => {
    const label = store.getLabel(c.req.param("id"));
    if (!label) return c.json({ error: "label not found" }, 404);
    return c.json({ label });
  });
  app.put("/api/labels/:id", async (c) => {
    const body = await readJson<UpdateLabelInput>(c);
    return c.json({ label: store.updateLabel(c.req.param("id"), body) });
  });
  app.delete("/api/labels/:id", (c) => {
    return c.json({ label: store.deleteLabel(c.req.param("id")) });
  });

  app.get("/api/multica/pins", (c) => {
    const pins = store.listPinnedItems(c.req.query("workspaceId"), c.req.query("userId"));
    return c.json({ pins, total: pins.length });
  });
  app.post("/api/multica/pins", async (c) => {
    const body = await readJson<CreatePinnedItemInput>(c);
    return c.json({ pin: store.createPinnedItem(body) }, 201);
  });
  app.put("/api/multica/pins/reorder", async (c) => {
    const body = await readJson<{ workspaceId?: string; workspace_id?: string; userId?: string; user_id?: string; items?: ReorderPinnedItemInput[] }>(c);
    const pins = store.reorderPinnedItems(body.workspaceId ?? body.workspace_id, body.userId ?? body.user_id, body.items ?? []);
    return c.json({ pins, total: pins.length });
  });
  app.delete("/api/multica/pins/:itemType/:itemId", (c) => {
    store.deletePinnedItem(c.req.query("workspaceId"), c.req.query("userId"), c.req.param("itemType"), c.req.param("itemId"));
    return c.json({ ok: true });
  });

  app.get("/api/pins", (c) => {
    const pins = store.listPinnedItems(c.req.query("workspaceId"), c.req.query("userId"));
    return c.json({ pins, total: pins.length });
  });
  app.post("/api/pins", async (c) => {
    const body = await readJson<CreatePinnedItemInput>(c);
    return c.json({ pin: store.createPinnedItem(body) }, 201);
  });
  app.put("/api/pins/reorder", async (c) => {
    const body = await readJson<{ workspaceId?: string; workspace_id?: string; userId?: string; user_id?: string; items?: ReorderPinnedItemInput[] }>(c);
    const pins = store.reorderPinnedItems(body.workspaceId ?? body.workspace_id, body.userId ?? body.user_id, body.items ?? []);
    return c.json({ pins, total: pins.length });
  });
  app.delete("/api/pins/:itemType/:itemId", (c) => {
    store.deletePinnedItem(c.req.query("workspaceId"), c.req.query("userId"), c.req.param("itemType"), c.req.param("itemId"));
    return c.json({ ok: true });
  });

  app.get("/api/multica/issues", (c) => {
    const issues = store.listIssues().map((issue) => {
      const tasks = store.listTasksForIssue(issue.id);
      return {
        ...issue,
        taskCount: tasks.length,
        latestTaskStatus: tasks[0]?.status ?? null,
        latestTaskId: tasks[0]?.id ?? null,
      };
    });
    return c.json({ issues });
  });
  app.get("/api/multica/issues/search", (c) => {
    const result = store.searchIssues({
      q: c.req.query("q") ?? "",
      workspaceId: c.req.query("workspaceId"),
      includeClosed: c.req.query("include_closed") === "true" || c.req.query("includeClosed") === "true",
      limit: parseOptionalInt(c.req.query("limit")),
      offset: parseOptionalInt(c.req.query("offset")),
    });
    return c.json(result);
  });
  app.get("/api/issues/search", (c) => {
    const result = store.searchIssues({
      q: c.req.query("q") ?? "",
      workspaceId: c.req.query("workspaceId"),
      includeClosed: c.req.query("include_closed") === "true" || c.req.query("includeClosed") === "true",
      limit: parseOptionalInt(c.req.query("limit")),
      offset: parseOptionalInt(c.req.query("offset")),
    });
    return c.json(result);
  });
  app.get("/api/multica/issues/child-progress", (c) => {
    const progress = store.listChildIssueProgress(c.req.query("workspaceId") ?? "local");
    return c.json({ progress, total: progress.length });
  });
  app.get("/api/issues/child-progress", (c) => {
    const progress = store.listChildIssueProgress(c.req.query("workspaceId") ?? "local");
    return c.json({ progress, total: progress.length });
  });
  app.post("/api/multica/issues", async (c) => {
    const body = await readJson<CreateIssueWithTaskInput>(c);
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
    if (assigneeType && assigneeId) {
      const assigned = store.assignIssue(issue.id, {
        assigneeType,
        assigneeId,
        prompt: body.prompt ?? body.title,
      });
      return c.json({ issue: assigned.issue, task: assigned.task }, 201);
    }
    return c.json({ issue, task }, 201);
  });
  app.get("/api/multica/issues/:id", (c) => {
    const issue = store.getIssueWithTasks(c.req.param("id"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    return c.json({
      issue,
      children: issue.children,
      childProgress: issue.childProgress,
      dependencies: issue.dependencies,
      comments: store.listIssueComments(issue.id),
      activity: store.listIssueActivity(issue.id),
    });
  });
  app.get("/api/multica/issues/:id/children", (c) => {
    const children = store.listChildIssues(c.req.param("id"));
    return c.json({ issues: children, total: children.length });
  });
  app.get("/api/issues/:id/children", (c) => {
    const children = store.listChildIssues(c.req.param("id"));
    return c.json({ issues: children, total: children.length });
  });
  app.get("/api/multica/issues/:id/dependencies", (c) => {
    const dependencies = store.listIssueDependencies(c.req.param("id"));
    return c.json({ dependencies, total: dependencies.length });
  });
  app.get("/api/issues/:id/dependencies", (c) => {
    const dependencies = store.listIssueDependencies(c.req.param("id"));
    return c.json({ dependencies, total: dependencies.length });
  });
  app.post("/api/multica/issues/:id/dependencies", async (c) => {
    const body = await readJson<CreateIssueDependencyInput>(c);
    return c.json({ dependency: store.createIssueDependency(c.req.param("id"), body) }, 201);
  });
  app.post("/api/issues/:id/dependencies", async (c) => {
    const body = await readJson<CreateIssueDependencyInput>(c);
    return c.json({ dependency: store.createIssueDependency(c.req.param("id"), body) }, 201);
  });
  app.delete("/api/multica/issues/:id/dependencies/:dependencyId", (c) => {
    store.deleteIssueDependency(c.req.param("id"), c.req.param("dependencyId"));
    return c.json({ ok: true });
  });
  app.delete("/api/issues/:id/dependencies/:dependencyId", (c) => {
    store.deleteIssueDependency(c.req.param("id"), c.req.param("dependencyId"));
    return c.json({ ok: true });
  });
  app.patch("/api/multica/issues/:id", async (c) => {
    const body = await readJson<UpdateIssueInput>(c);
    return c.json({ issue: store.updateIssue(c.req.param("id"), body) });
  });
  app.post("/api/multica/issues/:id/assign", async (c) => {
    const body = await readJson<AssignIssueInput>(c);
    return c.json(store.assignIssue(c.req.param("id"), body));
  });
  app.get("/api/multica/issues/:id/comments", (c) => {
    return c.json({ comments: store.listIssueComments(c.req.param("id")) });
  });
  app.post("/api/multica/issues/:id/comments", async (c) => {
    const body = await readJson<CreateIssueCommentInput>(c);
    return c.json({ comment: store.createIssueComment(c.req.param("id"), body) }, 201);
  });
  app.get("/api/multica/issues/:id/reactions", (c) => {
    return c.json({ reactions: store.listIssueReactions(c.req.param("id")) });
  });
  app.post("/api/multica/issues/:id/reactions", async (c) => {
    const body = await readJson<CreateMulticaReactionInput>(c);
    return c.json({ reaction: store.addIssueReaction(c.req.param("id"), normalizeReactionInput(body)) }, 201);
  });
  app.delete("/api/multica/issues/:id/reactions", async (c) => {
    const body = await readJson<CreateMulticaReactionInput>(c);
    store.removeIssueReaction(c.req.param("id"), normalizeReactionInput(body));
    return c.json({ ok: true });
  });
  app.get("/api/multica/issues/:id/attachments", (c) => {
    return c.json({ attachments: store.listAttachmentsForIssue(c.req.param("id")) });
  });
  app.post("/api/multica/issues/:id/attachments", async (c) => {
    const body = await readJson<CreateAttachmentInput>(c);
    const attachment = store.createAttachment({ ...body, issueId: c.req.param("id") });
    return c.json({ attachment }, 201);
  });
  app.get("/api/multica/issues/:id/labels", (c) => {
    const labels = store.listLabelsForIssue(c.req.param("id"));
    return c.json({ labels, total: labels.length });
  });
  app.post("/api/multica/issues/:id/labels", async (c) => {
    const body = await readJson<{ labelId?: string; label_id?: string }>(c);
    const labels = store.attachLabelToIssue(c.req.param("id"), body.labelId ?? body.label_id ?? "");
    return c.json({ labels, total: labels.length }, 201);
  });
  app.delete("/api/multica/issues/:id/labels/:labelId", (c) => {
    const labels = store.detachLabelFromIssue(c.req.param("id"), c.req.param("labelId"));
    return c.json({ labels, total: labels.length });
  });
  app.get("/api/issues/:id/labels", (c) => {
    const labels = store.listLabelsForIssue(c.req.param("id"));
    return c.json({ labels, total: labels.length });
  });
  app.post("/api/issues/:id/labels", async (c) => {
    const body = await readJson<{ labelId?: string; label_id?: string }>(c);
    const labels = store.attachLabelToIssue(c.req.param("id"), body.labelId ?? body.label_id ?? "");
    return c.json({ labels, total: labels.length }, 201);
  });
  app.delete("/api/issues/:id/labels/:labelId", (c) => {
    const labels = store.detachLabelFromIssue(c.req.param("id"), c.req.param("labelId"));
    return c.json({ labels, total: labels.length });
  });
  app.get("/api/multica/issues/:id/subscribers", (c) => {
    return c.json({ subscribers: store.listIssueSubscribers(c.req.param("id")) });
  });
  app.post("/api/multica/issues/:id/subscribers", async (c) => {
    const body = await readJson<{ memberId?: string; reason?: unknown }>(c);
    return c.json({
      subscriber: store.addIssueSubscriber(c.req.param("id"), body.memberId ?? "", normalizeSubscriptionReason(body.reason)),
    }, 201);
  });
  app.delete("/api/multica/issues/:id/subscribers/:memberId", (c) => {
    store.removeIssueSubscriber(c.req.param("id"), c.req.param("memberId"));
    return c.json({ ok: true });
  });
  app.get("/api/multica/issues/:id/metadata", (c) => {
    return c.json({ metadata: store.listIssueMetadata(c.req.param("id")) });
  });
  app.put("/api/multica/issues/:id/metadata/:key", async (c) => {
    const body = await readJson<{ value?: unknown }>(c);
    return c.json({ metadata: store.setIssueMetadataKey(c.req.param("id"), c.req.param("key"), body.value) });
  });
  app.delete("/api/multica/issues/:id/metadata/:key", (c) => {
    return c.json({ metadata: store.deleteIssueMetadataKey(c.req.param("id"), c.req.param("key")) });
  });

  app.get("/api/multica/inbox", (c) => {
    const items = store.listInboxItems(c.req.query("memberId"));
    return c.json({ items, total: items.length, unread: items.filter((item) => !item.read).length });
  });
  app.post("/api/multica/inbox/:id/read", (c) => {
    return c.json({ item: store.markInboxItemRead(c.req.param("id")) });
  });
  app.post("/api/multica/inbox/:id/archive", (c) => {
    return c.json({ item: store.archiveInboxItem(c.req.param("id")) });
  });

  app.put("/api/multica/comments/:id", async (c) => {
    const body = await readJson<UpdateIssueCommentInput>(c);
    return c.json({ comment: store.updateIssueComment(c.req.param("id"), body) });
  });
  app.patch("/api/multica/comments/:id", async (c) => {
    const body = await readJson<UpdateIssueCommentInput>(c);
    return c.json({ comment: store.updateIssueComment(c.req.param("id"), body) });
  });
  app.delete("/api/multica/comments/:id", (c) => {
    store.deleteIssueComment(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/multica/comments/:id/resolve", async (c) => {
    const body = await readJson<{ actorType?: string; actor_type?: string; actorId?: string | null; actor_id?: string | null }>(c);
    return c.json({
      comment: store.resolveIssueComment(c.req.param("id"), {
        actorType: body.actorType ?? body.actor_type,
        actorId: body.actorId ?? body.actor_id,
      }),
    });
  });
  app.delete("/api/multica/comments/:id/resolve", (c) => {
    return c.json({ comment: store.unresolveIssueComment(c.req.param("id")) });
  });
  app.put("/api/comments/:id", async (c) => {
    const body = await readJson<UpdateIssueCommentInput>(c);
    return c.json({ comment: store.updateIssueComment(c.req.param("id"), body) });
  });
  app.delete("/api/comments/:id", (c) => {
    store.deleteIssueComment(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/comments/:id/resolve", async (c) => {
    const body = await readJson<{ actorType?: string; actor_type?: string; actorId?: string | null; actor_id?: string | null }>(c);
    return c.json({
      comment: store.resolveIssueComment(c.req.param("id"), {
        actorType: body.actorType ?? body.actor_type,
        actorId: body.actorId ?? body.actor_id,
      }),
    });
  });
  app.delete("/api/comments/:id/resolve", (c) => {
    return c.json({ comment: store.unresolveIssueComment(c.req.param("id")) });
  });

  app.get("/api/multica/comments/:id/reactions", (c) => {
    return c.json({ reactions: store.listCommentReactions(c.req.param("id")) });
  });
  app.post("/api/multica/comments/:id/reactions", async (c) => {
    const body = await readJson<CreateMulticaReactionInput>(c);
    return c.json({ reaction: store.addCommentReaction(c.req.param("id"), normalizeReactionInput(body)) }, 201);
  });
  app.delete("/api/multica/comments/:id/reactions", async (c) => {
    const body = await readJson<CreateMulticaReactionInput>(c);
    store.removeCommentReaction(c.req.param("id"), normalizeReactionInput(body));
    return c.json({ ok: true });
  });
  app.get("/api/multica/comments/:id/attachments", (c) => {
    return c.json({ attachments: store.listAttachmentsForComment(c.req.param("id")) });
  });
  app.get("/api/multica/attachments/:id", (c) => {
    const attachment = store.getAttachment(c.req.param("id"));
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    return c.json({ attachment });
  });
  app.post("/api/multica/attachments", async (c) => {
    const body = await readJson<CreateAttachmentInput>(c);
    return c.json({ attachment: store.createAttachment(body) }, 201);
  });

  app.post("/api/upload-file", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "missing file field" }, 400);
    if (file.size > MAX_UPLOAD_SIZE) return c.json({ error: "file too large" }, 413);
    const workspaceId = stringFormValue(form.get("workspaceId") ?? form.get("workspace_id")) ?? c.req.header("X-Workspace-ID") ?? "local";
    const issueId = stringFormValue(form.get("issueId") ?? form.get("issue_id"));
    const commentId = stringFormValue(form.get("commentId") ?? form.get("comment_id"));
    const uploaderType = stringFormValue(form.get("uploaderType") ?? form.get("uploader_type")) ?? "member";
    const uploaderId = stringFormValue(form.get("uploaderId") ?? form.get("uploader_id")) ?? "local";
    const attachmentId = createUploadAttachmentId();
    const safeName = safeFilename(file.name || "upload.bin");
    const relativePath = uploadRelativePath(workspaceId, attachmentId, safeName);
    const absolutePath = uploadAbsolutePath(relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, new Uint8Array(await file.arrayBuffer()));
    const attachment = store.createAttachment({
      id: attachmentId,
      workspaceId,
      issueId,
      commentId,
      uploaderType,
      uploaderId,
      filename: safeName,
      url: `/api/attachments/${attachmentId}/content`,
      contentType: file.type || detectContentTypeFromFilename(safeName),
      sizeBytes: file.size,
    });
    return c.json({ attachment, ...attachment, downloadUrl: `/api/attachments/${attachment.id}/content` });
  });

  app.get("/api/attachments/:id", (c) => {
    const attachment = store.getAttachment(c.req.param("id"));
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    return c.json({ attachment, downloadUrl: `/api/attachments/${attachment.id}/content` });
  });

  app.get("/api/attachments/:id/content", async (c) => {
    const attachment = store.getAttachment(c.req.param("id"));
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    if (!attachment.url.startsWith("/api/attachments/")) {
      return c.redirect(attachment.url);
    }
    const filePath = uploadedAttachmentPath(attachment);
    if (!filePath || !existsSync(filePath)) return c.json({ error: "attachment file not found" }, 404);
    const info = await stat(filePath);
    const bytes = await readFile(filePath);
    return new Response(bytes, {
      headers: {
        "Content-Type": attachment.contentType || detectContentTypeFromFilename(attachment.filename),
        "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename="${attachment.filename.replace(/"/g, "")}"`,
      },
    });
  });

  app.delete("/api/attachments/:id", async (c) => {
    const attachment = store.deleteAttachment(c.req.param("id"));
    if (!attachment) return c.json({ ok: true });
    if (attachment.url.startsWith("/api/attachments/")) {
      const filePath = uploadedAttachmentPath(attachment);
      if (filePath) await unlink(filePath).catch(() => undefined);
    }
    return c.json({ ok: true, attachment });
  });

  app.get("/api/multica/chats", (c) => {
    const sessions = store.listChatSessions(c.req.query("workspaceId"));
    return c.json({ sessions, total: sessions.length });
  });
  app.post("/api/multica/chats", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    return c.json({ session: store.createChatSession(body) }, 201);
  });
  app.get("/api/multica/chats/:id", (c) => {
    const session = store.getChatSession(c.req.param("id"));
    if (!session) return c.json({ error: "chat session not found" }, 404);
    return c.json({ session, messages: store.listChatMessages(session.id) });
  });
  app.patch("/api/multica/chats/:id", async (c) => {
    const body = await readJson<UpdateChatSessionInput>(c);
    return c.json({ session: store.updateChatSession(c.req.param("id"), body) });
  });
  app.get("/api/multica/chats/:id/messages", (c) => {
    return c.json({ messages: store.listChatMessages(c.req.param("id")) });
  });
  app.post("/api/multica/chats/:id/messages", async (c) => {
    const body = await readJson<SendChatMessageInput>(c);
    return c.json(store.sendChatMessage(c.req.param("id"), body), 201);
  });

  app.get("/api/multica/tasks", (c) => {
    const status = c.req.query("status") as any;
    return c.json({ tasks: store.listTasks(status) });
  });
  app.post("/api/multica/tasks", async (c) => {
    const body = await readJson<CreateTaskInput>(c);
    return c.json({ task: store.createTask(body) }, 201);
  });
  app.get("/api/multica/tasks/:id", (c) => {
    const task = store.getTaskWithAgent(c.req.param("id"));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ task });
  });
  app.post("/api/multica/tasks/:id/cancel", (c) => {
    return c.json({ task: store.cancelTask(c.req.param("id")) });
  });
  app.get("/api/multica/tasks/:id/messages", (c) => {
    return c.json({ messages: store.listTaskMessages(c.req.param("id")) });
  });

  // Multica daemon-compatible endpoints.
  app.post("/api/daemon/runtimes/:runtimeId/tasks/claim", (c) => {
    const task = store.claimTask(c.req.param("runtimeId"));
    return c.json({ task });
  });
  app.post("/api/daemon/runtimes/:runtimeId/recover-orphans", (c) => {
    const recovered = store.recoverOrphans(c.req.param("runtimeId"));
    return c.json({ recovered });
  });
  app.post("/api/daemon/tasks/:taskId/start", (c) => {
    return c.json({ task: store.startTask(c.req.param("taskId")) });
  });
  app.post("/api/daemon/tasks/:taskId/progress", async (c) => {
    const body = await readJson<{ summary?: string; step?: number; total?: number }>(c);
    store.reportProgress(c.req.param("taskId"), body.summary ?? "", body.step, body.total);
    return c.json({ ok: true });
  });
  app.post("/api/daemon/tasks/:taskId/messages", async (c) => {
    const body = await readJson<{ messages?: any[] }>(c);
    const messages = store.appendTaskMessages(c.req.param("taskId"), body.messages ?? []);
    return c.json({ messages });
  });
  app.post("/api/daemon/tasks/:taskId/session", async (c) => {
    const body = await readJson<{ session_id?: string; sessionId?: string; work_dir?: string; workDir?: string }>(c);
    store.pinTaskSession(
      c.req.param("taskId"),
      body.session_id ?? body.sessionId ?? null,
      body.work_dir ?? body.workDir ?? null,
    );
    return c.json({ ok: true });
  });
  app.post("/api/daemon/tasks/:taskId/complete", async (c) => {
    const body = await readJson<{ output?: string; branch_name?: string; session_id?: string; work_dir?: string }>(c);
    const task = store.completeTask(c.req.param("taskId"), {
      output: body.output ?? "",
      branchName: body.branch_name ?? null,
      sessionId: body.session_id ?? null,
      workDir: body.work_dir ?? null,
    });
    return c.json({ task });
  });
  app.post("/api/daemon/tasks/:taskId/fail", async (c) => {
    const body = await readJson<{ error?: string; session_id?: string; work_dir?: string }>(c);
    const task = store.failTask(c.req.param("taskId"), {
      error: body.error ?? "Task failed",
      sessionId: body.session_id ?? null,
      workDir: body.work_dir ?? null,
    });
    return c.json({ task });
  });
  app.post("/api/daemon/tasks/:taskId/usage", async (c) => {
    const body = await readJson<{ usage?: any[] }>(c);
    store.reportTaskUsage(c.req.param("taskId"), body.usage ?? []);
    return c.json({ ok: true });
  });
  app.get("/api/daemon/tasks/:taskId/status", (c) => {
    return c.json({ status: store.getTaskStatus(c.req.param("taskId")) });
  });

  return app;
}

export function startMulticaServer(options: MulticaApiOptions & { port?: number } = {}): ReturnType<typeof Bun.serve> {
  const store = options.store ?? new MulticaStore();
  const scheduler = options.scheduler === undefined ? new MulticaScheduler({ store }) : options.scheduler;
  scheduler?.start();
  const app = createMulticaApp({ ...options, store, scheduler });
  const port = options.port ?? parseInt(process.env.MULTICA_PORT ?? "6130", 10);
  const hostname = options.hostname ?? process.env.MULTICA_HOST ?? "0.0.0.0";
  const server = Bun.serve({ port, hostname, fetch: app.fetch });
  const stopServer = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    scheduler?.stop();
    return stopServer(closeActiveConnections);
  };
  return server;
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return await c.req.json() as T;
  } catch {
    return {} as T;
  }
}

function normalizeSubscriptionReason(value: unknown): MulticaSubscriptionReason {
  const reason = String(value ?? "manual") as MulticaSubscriptionReason;
  return SUBSCRIPTION_REASONS.includes(reason) ? reason : "manual";
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function usageQuery(c: { req: { query: (name: string) => string | undefined } }, extra: { runtimeId?: string | null } = {}): {
  workspaceId?: string | null;
  projectId?: string | null;
  runtimeId?: string | null;
  days?: number;
} {
  return {
    workspaceId: c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local",
    projectId: c.req.query("projectId") ?? c.req.query("project_id") ?? null,
    runtimeId: extra.runtimeId,
    days: parseOptionalInt(c.req.query("days")),
  };
}

function normalizeReactionInput(input: CreateMulticaReactionInput): { actorType?: string; actorId?: string | null; emoji: string } {
  return {
    actorType: input.actorType ?? input.actor_type ?? "member",
    actorId: input.actorId ?? input.actor_id ?? "local",
    emoji: input.emoji,
  };
}

function normalizeGitHubPullRequestBody(body: any): NormalizedGitHubPullRequestBody {
  return {
    workspaceId: stringOrDefault(body.workspaceId ?? body.workspace_id, "local"),
    issueId: body.issueId ?? body.issue_id ?? null,
    repoOwner: stringOrDefault(body.repoOwner ?? body.repo_owner ?? body.owner, ""),
    repoName: stringOrDefault(body.repoName ?? body.repo_name ?? body.repository, ""),
    number: Number(body.number),
    title: String(body.title ?? ""),
    state: body.state,
    htmlUrl: body.htmlUrl ?? body.html_url ?? null,
    branch: body.branch ?? null,
    authorLogin: body.authorLogin ?? body.author_login ?? null,
    authorAvatarUrl: body.authorAvatarUrl ?? body.author_avatar_url ?? null,
    mergedAt: body.mergedAt ?? body.merged_at ?? null,
    closedAt: body.closedAt ?? body.closed_at ?? null,
    prCreatedAt: body.prCreatedAt ?? body.pr_created_at ?? null,
    prUpdatedAt: body.prUpdatedAt ?? body.pr_updated_at ?? null,
    mergeableState: body.mergeableState ?? body.mergeable_state ?? null,
    checksConclusion: body.checksConclusion ?? body.checks_conclusion ?? null,
    checksPassed: Number(body.checksPassed ?? body.checks_passed ?? 0),
    checksFailed: Number(body.checksFailed ?? body.checks_failed ?? 0),
    checksPending: Number(body.checksPending ?? body.checks_pending ?? 0),
    additions: Number(body.additions ?? 0),
    deletions: Number(body.deletions ?? 0),
    changedFiles: Number(body.changedFiles ?? body.changed_files ?? 0),
  };
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function parseJsonBody<T>(rawBody: string): T {
  if (!rawBody.trim()) return {} as T;
  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function webhookSignatureStatus(provider: MulticaWebhookProvider, headers: Record<string, string>, rawBody: string): MulticaWebhookSignatureStatus {
  const secret = process.env.MULTICA_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";
  if (!secret) return "not_required";
  const signature = headers["x-hub-signature-256"] ?? "";
  if (!signature) return "missing";
  return verifyWebhookSignature(secret, signature, rawBody) ? "valid" : "invalid";
}

function verifyWebhookSignature(secret: string, signature: string, rawBody: string): boolean {
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;
  const actualHex = signature.slice(prefix.length);
  if (!/^[0-9a-fA-F]+$/.test(actualHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(actualHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function webhookDeliveryResponse(result: MulticaWebhookDeliveryResult) {
  return {
    status: result.status,
    duplicate: result.duplicate,
    delivery: result.delivery,
    deliveryId: result.delivery.id,
    delivery_id: result.delivery.id,
    run: result.run,
    runId: result.run?.id ?? null,
    run_id: result.run?.id ?? null,
  };
}

function uploadRoot(): string {
  return process.env.MULTICA_UPLOAD_DIR ?? join(homedir(), ".remi", "multica", "uploads");
}

function createUploadAttachmentId(): string {
  return `att_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function stringFormValue(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeFilename(value: string): string {
  const filename = basename(value).replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  return filename || "upload.bin";
}

function uploadRelativePath(workspaceId: string, attachmentId: string, filename: string): string {
  return join(safePathSegment(workspaceId || "local"), `${attachmentId}${extname(filename) || ".bin"}`);
}

function uploadAbsolutePath(relativePath: string): string {
  return join(uploadRoot(), relativePath);
}

function uploadedAttachmentPath(attachment: { workspaceId: string; id: string; filename: string }): string {
  return uploadAbsolutePath(uploadRelativePath(attachment.workspaceId, attachment.id, attachment.filename));
}

function safePathSegment(value: string): string {
  return String(value || "local").replace(/[^A-Za-z0-9_-]/g, "_") || "local";
}

function detectContentTypeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".json") return "application/json";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".md" || ext === ".txt" || ext === ".log") return "text/plain";
  return "application/octet-stream";
}

function skillSummary(skill: MulticaSkill): Omit<MulticaSkill, "content" | "files"> {
  const { content: _content, files: _files, ...summary } = skill;
  return summary;
}

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { createLogger } from "../logger.js";
import { AgentTemplateError, createAgentFromTemplate, getAgentTemplate, listAgentTemplates } from "./agent-templates.js";
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
  CreateAutopilotTriggerInput,
  BatchDeleteIssuesInput,
  BatchUpdateIssuesInput,
  CreateAgentFromTemplateInput,
  CreateChatSessionInput,
  CreateFeedbackInput,
  CreateRuntimeUpdateInput,
  CreateIssueDependencyInput,
  CreateIssueCommentInput,
  CreateIssueInput,
  CreateIssueWithTaskInput,
  CreateLabelInput,
  CreatePinnedItemInput,
  CreateProjectInput,
  CreateProjectResourceInput,
  CreateRuntimeLocalSkillImportInput,
  CreateSkillInput,
  CreateSquadInput,
  CreateTaskInput,
  CreateWorkspaceInput,
  CreateWorkspaceMemberInput,
  ImportSkillInput,
  ListIssuesInput,
  QuickCreateIssueInput,
  RegisterRuntimeInput,
  ReportRuntimeLocalSkillImportInput,
  ReportRuntimeLocalSkillListInput,
  ReportRuntimeModelListInput,
  ReportRuntimeUpdateInput,
  ReorderPinnedItemInput,
  RemoveSquadMemberInput,
  RunAutopilotInput,
  SendChatMessageInput,
  CreateMulticaReactionInput,
  MulticaAutopilotTrigger,
  MulticaNotificationPreferences,
  MulticaGitHubPullRequest,
  MulticaChatMessage,
  MulticaChatSession,
  MulticaInboxItem,
  MulticaIssue,
  MulticaTask,
  MulticaRuntime,
  MulticaSkill,
  MulticaSkillFile,
  MulticaSubscriptionReason,
  MulticaGitHubPullRequestState,
  MulticaTimelineEntry,
  MulticaWebhookDeliveryResult,
  MulticaWebhookProvider,
  MulticaWebhookSignatureStatus,
  SendChatMessageResult,
  SetAgentSkillsInput,
  UpdateAgentInput,
  UpdateAutopilotInput,
  UpdateAutopilotTriggerInput,
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

type DaemonRegisterRequestBody = {
  workspace_id?: string;
  workspaceId?: string;
  daemon_id?: string;
  daemonId?: string;
  legacy_daemon_ids?: string[];
  device_name?: string;
  deviceName?: string;
  cli_version?: string;
  cliVersion?: string;
  launched_by?: string;
  launchedBy?: string;
  runtimes?: Array<{
    name?: string;
    type?: string;
    provider?: string;
    version?: string;
    status?: string;
  }>;
};

class MulticaApiError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 429) {
    super(message);
  }
}

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
    if (err instanceof SkillImportError) {
      return c.json({ error: err.message }, err.status as 400 | 502);
    }
    if (err instanceof AgentTemplateError) {
      return c.json({ error: err.message, failed_urls: err.failedUrls }, err.status);
    }
    if (err instanceof MulticaApiError) {
      return c.json({ error: err.message }, err.status);
    }
    log.error(err.message);
    return c.json({ error: err.message }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/readyz", (c) => c.json({ ok: true }));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/api/config", (c) => c.json({
    cdn_domain: "",
    allow_signup: true,
    google_client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    posthog_key: process.env.ANALYTICS_DISABLED === "true" || process.env.ANALYTICS_DISABLED === "1" ? "" : process.env.POSTHOG_API_KEY ?? "",
    posthog_host: process.env.POSTHOG_HOST ?? "",
    analytics_environment: process.env.NODE_ENV ?? "development",
  }));
  app.post("/api/cli-token", async (c) => {
    const token = await store.createAccessToken({
      workspaceId: "local",
      name: "CLI token",
      type: "pat",
    });
    return c.json({ token: token.token });
  });
  app.post("/auth/logout", (c) => c.json({ message: "logged out" }));
  app.post("/auth/send-code", (c) => c.json({ error: "email auth is not configured in local Bun Multica" }, 501));
  app.post("/auth/verify-code", (c) => c.json({ error: "email auth is not configured in local Bun Multica" }, 501));
  app.post("/auth/google", (c) => c.json({ error: "google auth is not configured in local Bun Multica" }, 501));
  app.get("/health/realtime", (c) => c.json({ connections: 0, enabled: false }));
  app.get("/api/github/setup", (c) => c.json(githubSetupResponse(c.req.query("installation_id"), c.req.query("state"))));
  app.post("/api/webhooks/github", (c) => c.json({ configured: false }, 202));
  app.post("/api/webhooks/autopilots/:token", async (c) => {
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
    const result = store.handleAutopilotWebhookByToken(c.req.param("token"), {
      prompt: body.prompt ?? null,
      payload: body.payload ?? body,
      rawBody,
      headers,
      provider,
      signatureStatus,
    });
    if (!result) return c.json({ error: "autopilot webhook token not found" }, 404);
    const statusCode = result.status === "rejected" ? 401 : result.status === "accepted" ? 201 : result.status === "failed" ? 500 : 200;
    return c.json(webhookDeliveryResponse(result), statusCode);
  });
  app.get("/api/multica/health", (c) => c.json({ ok: true }));
  app.post("/api/daemon/register", async (c) => {
    const body = await readJson<DaemonRegisterRequestBody>(c);
    const result = registerDaemonRuntimes(store, body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.post("/api/daemon/deregister", async (c) => {
    const body = await readJson<{ runtime_ids?: string[]; runtimeIds?: string[] }>(c);
    const runtimeIds = body.runtime_ids ?? body.runtimeIds ?? [];
    if (!runtimeIds.length) return c.json({ error: "runtime_ids is required" }, 400);
    for (const runtimeId of runtimeIds) store.setRuntimeOffline(runtimeId);
    return c.json({ status: "ok" });
  });
  app.post("/api/daemon/heartbeat", async (c) => {
    const body = await readJson<{ runtime_id?: string; runtimeId?: string; supports_batch_import?: boolean; supportsBatchImport?: boolean }>(c);
    const runtimeId = body.runtime_id ?? body.runtimeId ?? "";
    if (!runtimeId) return c.json({ error: "runtime_id is required" }, 400);
    const ack = store.heartbeatRuntime(runtimeId, {
      supportsBatchImport: body.supports_batch_import ?? body.supportsBatchImport ?? false,
    });
    if (ack.status === "runtime_gone") return c.json({ error: "runtime not found" }, 404);
    return c.json(ack);
  });
  app.get("/api/daemon/workspaces/:workspaceId/repos", (c) => {
    return c.json(workspaceReposResponse(c.req.param("workspaceId")));
  });
  app.get("/api/daemon/ws", (c) => c.json({ error: "daemon websocket is not implemented in local Bun Multica" }, 501));
  app.get("/api/cloud-runtime", (c) => c.json(cloudRuntimeUnavailableResponse(), 503));
  app.get("/api/cloud-runtime/healthz", (c) => c.json(cloudRuntimeUnavailableResponse(), 503));
  app.get("/api/cloud-runtime/readyz", (c) => c.json(cloudRuntimeUnavailableResponse(), 503));
  app.get("/api/cloud-runtime/nodes", (c) => c.json(cloudRuntimeUnavailableResponse(), 503));
  app.post("/api/cloud-runtime/nodes", (c) => c.json(cloudRuntimeUnavailableResponse(), 503));
  app.delete("/api/cloud-runtime/nodes", (c) => c.json(cloudRuntimeUnavailableResponse(), 503));
  app.post("/api/cloud-runtime/nodes/start", (c) => c.json(cloudRuntimeUnavailableResponse(), 503));
  app.post("/api/cloud-runtime/nodes/stop", (c) => c.json(cloudRuntimeUnavailableResponse(), 503));
  app.post("/api/cloud-runtime/nodes/reboot", (c) => c.json(cloudRuntimeUnavailableResponse(), 503));
  app.post("/api/cloud-runtime/nodes/status", (c) => c.json(cloudRuntimeUnavailableResponse(), 503));
  app.post("/api/cloud-runtime/nodes/exec", (c) => c.json(cloudRuntimeUnavailableResponse(), 503));
  app.get("/api/me", (c) => c.json(store.getCurrentUser()));
  app.patch("/api/me", async (c) => {
    const body = await readJson<any>(c);
    const result = safeUpdateCurrentUser(store, body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.patch("/api/me/onboarding", async (c) => {
    const body = await readJson<{ questionnaire?: Record<string, unknown>; onboarding_questionnaire?: Record<string, unknown> }>(c);
    return c.json(store.patchCurrentUserOnboarding(body.questionnaire ?? body.onboarding_questionnaire ?? {}));
  });
  app.post("/api/me/onboarding/complete", (c) => c.json(store.markCurrentUserOnboarded()));
  app.post("/api/me/onboarding/cloud-waitlist", async (c) => {
    const body = await readJson<{ email?: string; reason?: string }>(c);
    const result = safeJoinCloudWaitlist(body, store);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.post("/api/me/onboarding/runtime-bootstrap", async (c) => {
    const body = await readJson<{ workspace_id?: string; workspaceId?: string; runtime_id?: string; runtimeId?: string }>(c);
    const result = safeRuntimeOnboardingBootstrap(store, body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.post("/api/me/onboarding/no-runtime-bootstrap", async (c) => {
    const body = await readJson<{ workspace_id?: string; workspaceId?: string }>(c);
    const result = safeNoRuntimeOnboardingBootstrap(store, body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.get("/api/workspaces", (c) => c.json(store.listWorkspaces()));
  app.post("/api/workspaces", async (c) => {
    const body = await readJson<any>(c);
    const result = safeCreateWorkspace(store, body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result, 201);
  });
  app.get("/api/workspaces/:id", (c) => {
    const workspace = store.getWorkspace(c.req.param("id"));
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    return c.json(workspace);
  });
  app.put("/api/workspaces/:id", async (c) => {
    const body = await readJson<Partial<CreateWorkspaceInput>>(c);
    return c.json(store.updateWorkspace(c.req.param("id"), body));
  });
  app.patch("/api/workspaces/:id", async (c) => {
    const body = await readJson<Partial<CreateWorkspaceInput>>(c);
    return c.json(store.updateWorkspace(c.req.param("id"), body));
  });
  app.delete("/api/workspaces/:id", (c) => {
    const deleted = store.deleteWorkspace(c.req.param("id"));
    if (!deleted) return c.json({ error: "workspace not found" }, 404);
    return c.body(null, 204);
  });
  app.post("/api/workspaces/:id/leave", async (c) => {
    const body = await readJson<{ memberId?: string; member_id?: string }>(c);
    const left = store.leaveWorkspace(c.req.param("id"), body.memberId ?? body.member_id ?? undefined);
    if (!left) return c.json({ error: "member not found" }, 404);
    return c.body(null, 204);
  });
  app.get("/api/workspaces/:id/members", (c) => c.json(store.listWorkspaceMembers(c.req.param("id"))));
  app.patch("/api/workspaces/:id/members/:memberId", async (c) => {
    const member = store.getWorkspaceMember(c.req.param("memberId"));
    if (!member || member.workspaceId !== c.req.param("id")) return c.json({ error: "member not found" }, 404);
    const body = await readJson<UpdateWorkspaceMemberInput>(c);
    return c.json(store.updateWorkspaceMember(c.req.param("memberId"), body));
  });
  app.delete("/api/workspaces/:id/members/:memberId", (c) => {
    const member = store.getWorkspaceMember(c.req.param("memberId"));
    if (!member || member.workspaceId !== c.req.param("id")) return c.json({ error: "member not found" }, 404);
    store.archiveWorkspaceMember(c.req.param("memberId"));
    return c.body(null, 204);
  });
  app.post("/api/workspaces/:id/members", async (c) => {
    const body = await readJson<any>(c);
    const result = safeCreateInvitation(store, c.req.param("id"), body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result, 201);
  });
  app.get("/api/workspaces/:id/invitations", (c) => c.json(store.listWorkspaceInvitations(c.req.param("id"))));
  app.get("/api/workspaces/:id/github/connect", (c) => c.json(githubConnectResponse(c.req.param("id"))));
  app.get("/api/workspaces/:id/github/installations", (c) => c.json({
    installations: [],
    configured: isGitHubAppConfigured(),
    can_manage: true,
  }));
  app.delete("/api/workspaces/:id/github/installations/:installationId", (c) => c.body(null, 204));
  app.delete("/api/workspaces/:id/invitations/:invitationId", (c) => {
    const revoked = store.revokeWorkspaceInvitation(c.req.param("id"), c.req.param("invitationId"));
    if (!revoked) return c.json({ error: "invitation not found" }, 404);
    return c.body(null, 204);
  });
  app.get("/api/invitations", (c) => c.json(store.listCurrentUserInvitations()));
  app.get("/api/invitations/:id", (c) => {
    const invitation = store.getInvitation(c.req.param("id"));
    if (!invitation) return c.json({ error: "invitation not found" }, 404);
    return c.json(invitation);
  });
  app.post("/api/invitations/:id/accept", (c) => {
    const result = safeAcceptInvitation(store, c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.post("/api/invitations/:id/decline", (c) => {
    const result = safeDeclineInvitation(store, c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.body(null, 204);
  });

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
  app.get("/api/multica/agents/:id/tasks", (c) => {
    const tasks = store.listAgentTasks(c.req.param("id"));
    return c.json({ tasks, total: tasks.length });
  });
  app.put("/api/multica/agents/:id/skills", async (c) => {
    const body = await readJson<SetAgentSkillsInput>(c);
    const skills = store.setAgentSkills(c.req.param("id"), body);
    return c.json({ skills, total: skills.length });
  });
  app.get("/api/agents/:id/tasks", (c) => c.json(store.listAgentTasks(c.req.param("id"))));
  app.get("/api/agents/:id/skills", (c) => c.json(store.listAgentSkills(c.req.param("id"), { includeFiles: false })));
  app.put("/api/agents/:id/skills", async (c) => {
    const body = await readJson<SetAgentSkillsInput>(c);
    return c.json(store.setAgentSkills(c.req.param("id"), body).map(skillSummary));
  });
  app.get("/api/agents", (c) => c.json(store.listAgents()));
  app.post("/api/agents", async (c) => {
    const body = await readJson<CreateAgentInput>(c);
    return c.json(store.createAgent(body), 201);
  });
  app.post("/api/agents/from-template", async (c) => {
    const body = await readJson<CreateAgentFromTemplateInput>(c);
    const result = await createAgentFromTemplate(store, body);
    return c.json({
      agent: result.agent,
      imported_skill_ids: result.imported_skill_ids,
      reused_skill_ids: result.reused_skill_ids,
    }, 201);
  });
  app.get("/api/agents/:id", (c) => {
    const agent = store.getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);
    return c.json(agent);
  });
  app.put("/api/agents/:id", async (c) => {
    const body = await readJson<UpdateAgentInput>(c);
    return c.json(store.updateAgent(c.req.param("id"), body));
  });
  app.post("/api/agents/:id/archive", (c) => c.json(store.archiveAgent(c.req.param("id"))));
  app.post("/api/agents/:id/restore", (c) => c.json(store.restoreAgent(c.req.param("id"))));
  app.post("/api/agents/:id/cancel-tasks", (c) => c.json({ cancelled: store.cancelAgentTasks(c.req.param("id")) }));
  app.post("/api/multica/agents/from-template", async (c) => {
    const body = await readJson<CreateAgentFromTemplateInput>(c);
    const result = await createAgentFromTemplate(store, body);
    return c.json(result, 201);
  });
  app.get("/api/multica/agent-task-snapshot", (c) => {
    const tasks = store.listWorkspaceAgentTaskSnapshot(c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local");
    return c.json({ tasks, total: tasks.length });
  });
  app.get("/api/agent-task-snapshot", (c) => {
    return c.json(store.listWorkspaceAgentTaskSnapshot(c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local"));
  });
  app.get("/api/multica/agent-run-counts", (c) => {
    const counts = store.listWorkspaceAgentRunCounts(c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local");
    return c.json({ counts, total: counts.length });
  });
  app.get("/api/agent-run-counts", (c) => {
    return c.json(store.listWorkspaceAgentRunCounts(c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local"));
  });
  app.get("/api/multica/agent-activity-30d", (c) => {
    const activity = store.listWorkspaceAgentActivity30d(c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local");
    return c.json({ activity, total: activity.length });
  });
  app.get("/api/agent-activity-30d", (c) => {
    return c.json(store.listWorkspaceAgentActivity30d(c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local"));
  });
  app.get("/api/multica/agent-templates", (c) => {
    const templates = listAgentTemplates();
    return c.json({ templates, total: templates.length });
  });
  app.get("/api/multica/agent-templates/:slug", (c) => {
    const template = getAgentTemplate(c.req.param("slug"));
    if (!template) return c.json({ error: "template not found" }, 404);
    return c.json({ template });
  });
  app.get("/api/agent-templates", (c) => c.json(listAgentTemplates()));
  app.get("/api/agent-templates/:slug", (c) => {
    const template = getAgentTemplate(c.req.param("slug"));
    if (!template) return c.json({ error: "template not found" }, 404);
    return c.json(template);
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
  app.put("/api/multica/skills/:id", async (c) => {
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
  app.put("/api/skills/:id", async (c) => {
    const body = await readJson<UpdateSkillInput>(c);
    return c.json(store.updateSkill(c.req.param("id"), body));
  });
  app.delete("/api/skills/:id", (c) => {
    store.archiveSkill(c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/api/skills/:id/files", (c) => c.json(store.listSkillFiles(c.req.param("id"))));
  app.put("/api/skills/:id/files", async (c) => {
    const body = await readJson<MulticaSkillFile>(c);
    return c.json(store.upsertSkillFile(c.req.param("id"), body));
  });
  app.delete("/api/skills/:id/files/:fileId", (c) => {
    const deleted = store.deleteSkillFile(c.req.param("id"), c.req.param("fileId"));
    if (!deleted) return c.json({ error: "skill file not found" }, 404);
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
  app.post("/api/multica/feedback", async (c) => {
    const body = await readJson<CreateFeedbackInput>(c);
    const feedback = createFeedbackOrApiError(store, withFeedbackRequestMetadata(body, c));
    return c.json({ feedback }, 201);
  });
  app.get("/api/multica/feedback", (c) => {
    const feedback = store.listFeedback(c.req.query("workspaceId") ?? c.req.query("workspace_id"));
    return c.json({ feedback, total: feedback.length });
  });
  app.post("/api/feedback", async (c) => {
    const body = await readJson<CreateFeedbackInput>(c);
    const feedback = createFeedbackOrApiError(store, withFeedbackRequestMetadata(body, c));
    return c.json({ id: feedback.id, created_at: feedback.createdAt }, 201);
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
  app.get("/api/issues/:id/pull-requests", (c) => {
    const pullRequests = store.listGitHubPullRequestsForIssue(c.req.param("id"));
    if (!pullRequests) return c.json({ error: "issue not found" }, 404);
    return c.json(issuePullRequestsResponse(pullRequests));
  });
  app.get("/api/multica/issues/:id/pull-requests", (c) => {
    const pullRequests = store.listGitHubPullRequestsForIssue(c.req.param("id"));
    if (!pullRequests) return c.json({ error: "issue not found" }, 404);
    return c.json(issuePullRequestsResponse(pullRequests));
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
  app.post("/api/multica/runtimes/:id/models", (c) => {
    return c.json(store.createRuntimeModelListRequest(c.req.param("id")));
  });
  app.get("/api/multica/runtimes/:id/models/:requestId", (c) => {
    const request = store.getRuntimeModelListRequest(c.req.param("id"), c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
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
  app.post("/api/runtimes/:id/models", (c) => {
    return c.json(store.createRuntimeModelListRequest(c.req.param("id")));
  });
  app.get("/api/runtimes/:id/models/:requestId", (c) => {
    const request = store.getRuntimeModelListRequest(c.req.param("id"), c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.post("/api/daemon/runtimes/:runtimeId/models/claim", (c) => {
    return c.json({ request: store.claimRuntimeModelListRequest(c.req.param("runtimeId")) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/models/:requestId/result", async (c) => {
    const body = await readJson<ReportRuntimeModelListInput>(c);
    store.reportRuntimeModelListResult(c.req.param("runtimeId"), c.req.param("requestId"), body);
    return c.json({ status: "ok" });
  });
  app.post("/api/multica/runtimes/:id/update", async (c) => {
    const body = await readJson<CreateRuntimeUpdateInput>(c);
    const result = safeCreateRuntimeUpdateRequest(store, c.req.param("id"), body);
    if ("apiError" in result) return c.json({ error: result.apiError }, result.statusCode);
    return c.json(result);
  });
  app.get("/api/multica/runtimes/:id/update/:updateId", (c) => {
    const request = store.getRuntimeUpdateRequest(c.req.param("id"), c.req.param("updateId"));
    if (!request) return c.json({ error: "update not found" }, 404);
    return c.json(request);
  });
  app.post("/api/runtimes/:id/update", async (c) => {
    const body = await readJson<CreateRuntimeUpdateInput>(c);
    const result = safeCreateRuntimeUpdateRequest(store, c.req.param("id"), body);
    if ("apiError" in result) return c.json({ error: result.apiError }, result.statusCode);
    return c.json(result);
  });
  app.get("/api/runtimes/:id/update/:updateId", (c) => {
    const request = store.getRuntimeUpdateRequest(c.req.param("id"), c.req.param("updateId"));
    if (!request) return c.json({ error: "update not found" }, 404);
    return c.json(request);
  });
  app.post("/api/daemon/runtimes/:runtimeId/update/claim", (c) => {
    return c.json({ request: store.claimRuntimeUpdateRequest(c.req.param("runtimeId")) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/update/:updateId/result", async (c) => {
    const body = await readJson<ReportRuntimeUpdateInput>(c);
    store.reportRuntimeUpdateResult(c.req.param("runtimeId"), c.req.param("updateId"), body);
    return c.json({ status: "ok" });
  });
  app.post("/api/multica/runtimes/:id/local-skills", (c) => {
    return c.json(store.createRuntimeLocalSkillListRequest(c.req.param("id")));
  });
  app.post("/api/runtimes/:id/local-skills", (c) => {
    return c.json(store.createRuntimeLocalSkillListRequest(c.req.param("id")));
  });
  app.get("/api/multica/runtimes/:id/local-skills/:requestId", (c) => {
    const request = store.getRuntimeLocalSkillListRequest(c.req.param("id"), c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.get("/api/runtimes/:id/local-skills/:requestId", (c) => {
    const request = store.getRuntimeLocalSkillListRequest(c.req.param("id"), c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.post("/api/multica/runtimes/:id/local-skills/import", async (c) => {
    const body = await readJson<CreateRuntimeLocalSkillImportInput>(c);
    return c.json(store.createRuntimeLocalSkillImportRequest(c.req.param("id"), body));
  });
  app.post("/api/runtimes/:id/local-skills/import", async (c) => {
    const body = await readJson<CreateRuntimeLocalSkillImportInput>(c);
    return c.json(store.createRuntimeLocalSkillImportRequest(c.req.param("id"), body));
  });
  app.get("/api/multica/runtimes/:id/local-skills/import/:requestId", (c) => {
    const request = store.getRuntimeLocalSkillImportRequest(c.req.param("id"), c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.get("/api/runtimes/:id/local-skills/import/:requestId", (c) => {
    const request = store.getRuntimeLocalSkillImportRequest(c.req.param("id"), c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/claim", (c) => {
    return c.json({ request: store.claimRuntimeLocalSkillListRequest(c.req.param("runtimeId")) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/:requestId/result", async (c) => {
    const body = await readJson<ReportRuntimeLocalSkillListInput>(c);
    store.reportRuntimeLocalSkillListResult(c.req.param("runtimeId"), c.req.param("requestId"), body);
    return c.json({ status: "ok" });
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/import/claim", (c) => {
    const limit = parseOptionalInt(c.req.query("limit")) ?? 10;
    return c.json({ requests: store.claimRuntimeLocalSkillImportRequests(c.req.param("runtimeId"), limit) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/import/:requestId/result", async (c) => {
    const body = await readJson<ReportRuntimeLocalSkillImportInput>(c);
    store.reportRuntimeLocalSkillImportResult(c.req.param("runtimeId"), c.req.param("requestId"), body);
    return c.json({ status: "ok" });
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
  app.get("/api/runtimes/:id/activity", (c) => {
    const runtime = store.getRuntime(c.req.param("id"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    return c.json(store.listTaskActivityByHour(usageQuery(c, { runtimeId: runtime.id })));
  });
  app.delete("/api/runtimes/:id", (c) => {
    const deleted = store.deleteRuntime(c.req.param("id"));
    if (!deleted) return c.json({ error: "runtime not found" }, 404);
    return c.body(null, 204);
  });
  app.post("/api/multica/runtimes/:id/heartbeat", (c) => {
    const ack = store.heartbeatRuntime(c.req.param("id"), {
      supportsBatchImport: c.req.query("supports_batch_import") === "true" || c.req.query("supportsBatchImport") === "true",
    });
    if (ack.status === "runtime_gone") return c.json({ error: "runtime not found" }, 404);
    return c.json(ack);
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
  app.get("/api/projects", (c) => c.json(store.listProjects(c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local")));
  app.post("/api/projects", async (c) => {
    const body = await readJson<CreateProjectInput>(c);
    return c.json(store.createProject(body), 201);
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
  app.get("/api/projects/:id", (c) => {
    const project = store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json(project);
  });
  app.put("/api/projects/:id", async (c) => {
    const body = await readJson<UpdateProjectInput>(c);
    return c.json(store.updateProject(c.req.param("id"), body));
  });
  app.delete("/api/projects/:id", (c) => {
    store.archiveProject(c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/api/projects/:id/resources", (c) => c.json(store.listProjectResources(c.req.param("id"))));
  app.post("/api/projects/:id/resources", async (c) => {
    const body = await readJson<CreateProjectResourceInput>(c);
    return c.json(store.createProjectResource(c.req.param("id"), body), 201);
  });
  app.delete("/api/projects/:id/resources/:resourceId", (c) => {
    store.deleteProjectResource(c.req.param("id"), c.req.param("resourceId"));
    return c.body(null, 204);
  });

  app.get("/api/multica/squads", (c) => {
    const squads = store.listSquads(c.req.query("workspaceId"));
    return c.json({ squads, total: squads.length });
  });
  app.get("/api/squads", (c) => c.json(store.listSquads(c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local")));
  app.post("/api/squads", async (c) => {
    const body = await readJson<CreateSquadInput>(c);
    return c.json(store.createSquad(body), 201);
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
  app.get("/api/squads/:id", (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad) return c.json({ error: "squad not found" }, 404);
    return c.json(squad);
  });
  app.put("/api/squads/:id", async (c) => {
    const body = await readJson<UpdateSquadInput>(c);
    return c.json(store.updateSquad(c.req.param("id"), body));
  });
  app.delete("/api/squads/:id", (c) => {
    store.archiveSquad(c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/api/squads/:id/members", (c) => c.json(store.listSquadMembers(c.req.param("id"))));
  app.get("/api/squads/:id/members/status", (c) => c.json(squadMemberStatusResponse(store, c.req.param("id"))));
  app.post("/api/squads/:id/members", async (c) => {
    const body = await readJson<AddSquadMemberInput>(c);
    return c.json(store.addSquadMember(c.req.param("id"), body), 201);
  });
  app.patch("/api/squads/:id/members/role", async (c) => {
    const body = await readJson<AddSquadMemberInput>(c);
    return c.json(store.addSquadMember(c.req.param("id"), body));
  });
  app.delete("/api/squads/:id/members", async (c) => {
    const body = await readJson<RemoveSquadMemberInput>(c);
    store.removeSquadMember(c.req.param("id"), body);
    return c.body(null, 204);
  });

  app.get("/api/multica/autopilots", (c) => {
    const autopilots = store.listAutopilots(c.req.query("workspaceId"));
    return c.json({ autopilots, total: autopilots.length });
  });
  app.get("/api/autopilots", (c) => c.json(store.listAutopilots(c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local")));
  app.post("/api/autopilots", async (c) => {
    const body = await readJson<CreateAutopilotInput>(c);
    const autopilot = store.createAutopilot(body);
    scheduler?.sync();
    return c.json(autopilot, 201);
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
      triggers: store.listAutopilotTriggers(autopilot.id).map(autopilotTriggerResponse),
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
  app.get("/api/autopilots/:id", (c) => {
    const autopilot = store.getAutopilot(c.req.param("id"));
    if (!autopilot) return c.json({ error: "autopilot not found" }, 404);
    return c.json({
      autopilot,
      triggers: store.listAutopilotTriggers(autopilot.id).map(autopilotTriggerResponse),
    });
  });
  app.patch("/api/autopilots/:id", async (c) => {
    const body = await readJson<UpdateAutopilotInput>(c);
    const autopilot = store.updateAutopilot(c.req.param("id"), body);
    scheduler?.sync();
    return c.json(autopilot);
  });
  app.delete("/api/autopilots/:id", (c) => {
    store.archiveAutopilot(c.req.param("id"));
    scheduler?.sync();
    return c.body(null, 204);
  });
  app.post("/api/autopilots/:id/trigger", async (c) => {
    const body = await readJson<RunAutopilotInput>(c);
    return c.json(store.runAutopilot(c.req.param("id"), { ...body, source: body.source ?? "api" }), 201);
  });
  app.get("/api/autopilots/:id/runs", (c) => c.json(store.listAutopilotRuns(c.req.param("id"))));
  app.get("/api/autopilots/:id/runs/:runId", (c) => {
    const run = store.getAutopilotRun(c.req.param("runId"));
    if (!run || run.autopilotId !== c.req.param("id")) return c.json({ error: "autopilot run not found" }, 404);
    return c.json(run);
  });
  app.get("/api/autopilots/:id/deliveries", (c) => c.json(store.listWebhookDeliveries(c.req.param("id"))));
  app.get("/api/autopilots/:id/deliveries/:deliveryId", (c) => {
    const delivery = store.getWebhookDelivery(c.req.param("deliveryId"));
    if (!delivery || delivery.autopilotId !== c.req.param("id")) return c.json({ error: "delivery not found" }, 404);
    return c.json(delivery);
  });
  app.post("/api/autopilots/:id/deliveries/:deliveryId/replay", (c) => {
    const result = store.replayWebhookDelivery(c.req.param("id"), c.req.param("deliveryId"));
    return c.json(webhookDeliveryResponse(result), 201);
  });
  app.post("/api/autopilots/:id/triggers", async (c) => {
    const body = await readJson<CreateAutopilotTriggerInput>(c);
    const trigger = store.createAutopilotTrigger(c.req.param("id"), body);
    scheduler?.sync();
    return c.json(autopilotTriggerResponse(trigger), 201);
  });
  app.patch("/api/autopilots/:id/triggers/:triggerId", async (c) => {
    const body = await readJson<UpdateAutopilotTriggerInput>(c);
    const trigger = store.updateAutopilotTrigger(c.req.param("id"), c.req.param("triggerId"), body);
    scheduler?.sync();
    return c.json(autopilotTriggerResponse(trigger));
  });
  app.delete("/api/autopilots/:id/triggers/:triggerId", (c) => {
    const deleted = store.deleteAutopilotTrigger(c.req.param("id"), c.req.param("triggerId"));
    if (!deleted) return c.json({ error: "autopilot trigger not found" }, 404);
    scheduler?.sync();
    return c.body(null, 204);
  });
  app.post("/api/autopilots/:id/triggers/:triggerId/rotate-webhook-token", (c) => {
    return c.json(autopilotTriggerResponse(store.rotateAutopilotTriggerWebhookToken(c.req.param("id"), c.req.param("triggerId"))));
  });
  app.put("/api/autopilots/:id/triggers/:triggerId/signing-secret", async (c) => {
    const body = await readJson<{ secret?: string | null; signing_secret?: string | null }>(c);
    return c.json(autopilotTriggerResponse(store.setAutopilotTriggerSigningSecret(
      c.req.param("id"),
      c.req.param("triggerId"),
      body.secret ?? body.signing_secret ?? null,
    )));
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
    return { issues, total: issues.length };
  };

  app.get("/api/multica/issues", (c) => {
    const { issues } = listIssuesResponse(issueListQuery(c));
    return c.json({ issues });
  });
  app.get("/api/issues", (c) => c.json(listIssuesResponse(issueListQuery(c))));
  app.get("/api/multica/issues/grouped", (c) => c.json(store.listGroupedIssues(issueListQuery(c))));
  app.get("/api/issues/grouped", (c) => c.json(store.listGroupedIssues(issueListQuery(c))));
  app.get("/api/assignee-frequency", (c) => c.json(store.listAssigneeFrequency(assigneeFrequencyQuery(c))));
  app.get("/api/multica/assignee-frequency", (c) => c.json(store.listAssigneeFrequency(assigneeFrequencyQuery(c))));
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
  app.post("/api/multica/issues/batch-update", async (c) => {
    const body = await readJson<BatchUpdateIssuesInput>(c);
    return c.json(store.batchUpdateIssues(body));
  });
  app.post("/api/issues/batch-update", async (c) => {
    const body = await readJson<BatchUpdateIssuesInput>(c);
    const result = store.batchUpdateIssues(body);
    return c.json({ updated: result.updated });
  });
  app.post("/api/multica/issues/batch-delete", async (c) => {
    const body = await readJson<BatchDeleteIssuesInput>(c);
    return c.json(store.batchDeleteIssues(body));
  });
  app.post("/api/issues/batch-delete", async (c) => {
    const body = await readJson<BatchDeleteIssuesInput>(c);
    return c.json(store.batchDeleteIssues(body));
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
  app.post("/api/issues", async (c) => {
    const body = await readJson<CreateIssueWithTaskInput>(c);
    return c.json(store.createIssue(body), 201);
  });
  app.post("/api/multica/issues/quick-create", async (c) => {
    const body = await readJson<QuickCreateIssueInput>(c);
    const result = safeQuickCreateIssue(store, body);
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json({
      taskId: result.task.id,
      task_id: result.task.id,
      issue: result.issue,
      task: result.task,
    }, 202);
  });
  app.post("/api/issues/quick-create", async (c) => {
    const body = await readJson<QuickCreateIssueInput>(c);
    const result = safeQuickCreateIssue(store, body);
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json({ task_id: result.task.id }, 202);
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
  app.get("/api/issues/:id", (c) => {
    const issue = store.getIssueWithTasks(c.req.param("id"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    return c.json(issue);
  });
  app.get("/api/multica/issues/:id/timeline", (c) => {
    const response = issueTimelineResponse(store, c.req.param("id"), c);
    if (!response) return c.json({ error: "issue not found" }, 404);
    return c.json(response);
  });
  app.get("/api/issues/:id/timeline", (c) => {
    const response = issueTimelineResponse(store, c.req.param("id"), c);
    if (!response) return c.json({ error: "issue not found" }, 404);
    return c.json(response);
  });
  app.get("/api/issues/:id/active-task", (c) => {
    const issue = store.getIssue(c.req.param("id"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const tasks = store.listTasksForIssue(issue.id)
      .filter((task) => task.status === "queued" || task.status === "dispatched" || task.status === "running")
      .map(taskCompatibilityResponse);
    return c.json({ tasks });
  });
  app.get("/api/issues/:id/task-runs", (c) => {
    const issue = store.getIssue(c.req.param("id"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    return c.json(store.listTasksForIssue(issue.id).map(taskCompatibilityResponse));
  });
  app.get("/api/issues/:id/usage", (c) => {
    const issue = store.getIssue(c.req.param("id"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    return c.json(issueUsageResponse(store, issue));
  });
  app.post("/api/issues/:id/rerun", async (c) => {
    const body = await readJson<{ agent_id?: string; agentId?: string; prompt?: string }>(c);
    const result = safeRerunIssue(store, c.req.param("id"), body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(taskCompatibilityResponse(result.task), 202);
  });
  app.post("/api/issues/:id/tasks/:taskId/cancel", (c) => {
    const issue = store.getIssue(c.req.param("id"));
    const task = store.getTask(c.req.param("taskId"));
    if (!issue || !task || task.issueId !== issue.id) return c.json({ error: "task not found" }, 404);
    return c.json(taskCompatibilityResponse(store.cancelTask(task.id)));
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
  app.patch("/api/issues/:id", async (c) => {
    const body = await readJson<UpdateIssueInput>(c);
    return c.json(store.updateIssue(c.req.param("id"), body));
  });
  app.put("/api/issues/:id", async (c) => {
    const body = await readJson<UpdateIssueInput>(c);
    return c.json(store.updateIssue(c.req.param("id"), body));
  });
  app.delete("/api/multica/issues/:id", (c) => {
    const deleted = store.deleteIssue(c.req.param("id"));
    if (!deleted) return c.json({ error: "issue not found" }, 404);
    return c.json({ ok: true });
  });
  app.delete("/api/issues/:id", (c) => {
    const deleted = store.deleteIssue(c.req.param("id"));
    if (!deleted) return c.json({ error: "issue not found" }, 404);
    return c.body(null, 204);
  });
  app.post("/api/multica/issues/:id/assign", async (c) => {
    const body = await readJson<AssignIssueInput>(c);
    return c.json(store.assignIssue(c.req.param("id"), body));
  });
  app.get("/api/multica/issues/:id/comments", (c) => {
    return c.json({ comments: store.listIssueComments(c.req.param("id")) });
  });
  app.get("/api/issues/:id/comments", (c) => {
    return c.json(store.listIssueComments(c.req.param("id")));
  });
  app.post("/api/multica/issues/:id/comments", async (c) => {
    const body = await readJson<CreateIssueCommentInput>(c);
    return c.json({ comment: store.createIssueComment(c.req.param("id"), body) }, 201);
  });
  app.post("/api/issues/:id/comments", async (c) => {
    const body = await readJson<CreateIssueCommentInput>(c);
    return c.json(store.createIssueComment(c.req.param("id"), body), 201);
  });
  app.get("/api/multica/issues/:id/reactions", (c) => {
    return c.json({ reactions: store.listIssueReactions(c.req.param("id")) });
  });
  app.get("/api/issues/:id/reactions", (c) => {
    return c.json(store.listIssueReactions(c.req.param("id")));
  });
  app.post("/api/multica/issues/:id/reactions", async (c) => {
    const body = await readJson<CreateMulticaReactionInput>(c);
    return c.json({ reaction: store.addIssueReaction(c.req.param("id"), normalizeReactionInput(body)) }, 201);
  });
  app.post("/api/issues/:id/reactions", async (c) => {
    const body = await readJson<CreateMulticaReactionInput>(c);
    return c.json(store.addIssueReaction(c.req.param("id"), normalizeReactionInput(body)), 201);
  });
  app.delete("/api/multica/issues/:id/reactions", async (c) => {
    const body = await readJson<CreateMulticaReactionInput>(c);
    store.removeIssueReaction(c.req.param("id"), normalizeReactionInput(body));
    return c.json({ ok: true });
  });
  app.delete("/api/issues/:id/reactions", async (c) => {
    const body = await readJson<CreateMulticaReactionInput>(c);
    store.removeIssueReaction(c.req.param("id"), normalizeReactionInput(body));
    return c.body(null, 204);
  });
  app.get("/api/multica/issues/:id/attachments", (c) => {
    return c.json({ attachments: store.listAttachmentsForIssue(c.req.param("id")) });
  });
  app.get("/api/issues/:id/attachments", (c) => {
    return c.json(store.listAttachmentsForIssue(c.req.param("id")));
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
  app.get("/api/issues/:id/subscribers", (c) => {
    return c.json(store.listIssueSubscribers(c.req.param("id")));
  });
  app.post("/api/multica/issues/:id/subscribers", async (c) => {
    const body = await readJson<{ memberId?: string; reason?: unknown }>(c);
    return c.json({
      subscriber: store.addIssueSubscriber(c.req.param("id"), body.memberId ?? "", normalizeSubscriptionReason(body.reason)),
    }, 201);
  });
  app.post("/api/issues/:id/subscribe", async (c) => {
    const body = await readJson<{ memberId?: string; member_id?: string; user_id?: string; reason?: unknown }>(c);
    store.addIssueSubscriber(
      c.req.param("id"),
      body.memberId ?? body.member_id ?? body.user_id ?? "local",
      normalizeSubscriptionReason(body.reason),
    );
    return c.json({ subscribed: true });
  });
  app.post("/api/issues/:id/unsubscribe", async (c) => {
    const body = await readJson<{ memberId?: string; member_id?: string; user_id?: string }>(c);
    store.removeIssueSubscriber(c.req.param("id"), body.memberId ?? body.member_id ?? body.user_id ?? "local");
    return c.json({ subscribed: false });
  });
  app.delete("/api/multica/issues/:id/subscribers/:memberId", (c) => {
    store.removeIssueSubscriber(c.req.param("id"), c.req.param("memberId"));
    return c.json({ ok: true });
  });
  app.get("/api/multica/issues/:id/metadata", (c) => {
    return c.json({ metadata: store.listIssueMetadata(c.req.param("id")) });
  });
  app.get("/api/issues/:id/metadata", (c) => {
    return c.json(store.listIssueMetadata(c.req.param("id")));
  });
  app.put("/api/multica/issues/:id/metadata/:key", async (c) => {
    const body = await readJson<{ value?: unknown }>(c);
    return c.json({ metadata: store.setIssueMetadataKey(c.req.param("id"), c.req.param("key"), body.value) });
  });
  app.put("/api/issues/:id/metadata/:key", async (c) => {
    const body = await readJson<{ value?: unknown }>(c);
    return c.json(store.setIssueMetadataKey(c.req.param("id"), c.req.param("key"), body.value));
  });
  app.delete("/api/multica/issues/:id/metadata/:key", (c) => {
    return c.json({ metadata: store.deleteIssueMetadataKey(c.req.param("id"), c.req.param("key")) });
  });
  app.delete("/api/issues/:id/metadata/:key", (c) => {
    return c.json(store.deleteIssueMetadataKey(c.req.param("id"), c.req.param("key")));
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
  app.get("/api/inbox", (c) => c.json(store.listInboxItems(c.req.query("memberId") ?? c.req.query("member_id")).map(inboxCompatibilityResponse)));
  app.get("/api/inbox/unread-count", (c) => c.json({ count: store.countUnreadInboxItems(c.req.query("memberId") ?? c.req.query("member_id")) }));
  app.post("/api/inbox/mark-all-read", (c) => c.json({ count: store.markAllInboxItemsRead(c.req.query("memberId") ?? c.req.query("member_id")) }));
  app.post("/api/inbox/archive-all", (c) => c.json({ count: store.archiveAllInboxItems(c.req.query("memberId") ?? c.req.query("member_id"), "all") }));
  app.post("/api/inbox/archive-all-read", (c) => c.json({ count: store.archiveAllInboxItems(c.req.query("memberId") ?? c.req.query("member_id"), "read") }));
  app.post("/api/inbox/archive-completed", (c) => c.json({ count: store.archiveAllInboxItems(c.req.query("memberId") ?? c.req.query("member_id"), "completed") }));
  app.post("/api/inbox/:id/read", (c) => c.json(inboxCompatibilityResponse(store.markInboxItemRead(c.req.param("id")))));
  app.post("/api/inbox/:id/archive", (c) => c.json(inboxCompatibilityResponse(store.archiveInboxItem(c.req.param("id")))));

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
  app.post("/api/comments/:id/reactions", async (c) => {
    const body = await readJson<CreateMulticaReactionInput>(c);
    return c.json(store.addCommentReaction(c.req.param("id"), normalizeReactionInput(body)), 201);
  });
  app.delete("/api/comments/:id/reactions", async (c) => {
    const body = await readJson<CreateMulticaReactionInput>(c);
    store.removeCommentReaction(c.req.param("id"), normalizeReactionInput(body));
    return c.body(null, 204);
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
  app.get("/api/chat/sessions", (c) => c.json(store.listChatSessions(c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local").map(chatSessionCompatibilityResponse)));
  app.post("/api/chat/sessions", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    return c.json(chatSessionCompatibilityResponse(store.createChatSession(body)), 201);
  });
  app.get("/api/chat/sessions/:sessionId", (c) => {
    const session = store.getChatSession(c.req.param("sessionId"));
    if (!session) return c.json({ error: "chat session not found" }, 404);
    return c.json(chatSessionCompatibilityResponse(session));
  });
  app.patch("/api/chat/sessions/:sessionId", async (c) => {
    const body = await readJson<UpdateChatSessionInput>(c);
    return c.json(chatSessionCompatibilityResponse(store.updateChatSession(c.req.param("sessionId"), body)));
  });
  app.delete("/api/chat/sessions/:sessionId", (c) => {
    const deleted = store.deleteChatSession(c.req.param("sessionId"));
    if (!deleted) return c.json({ error: "chat session not found" }, 404);
    return c.body(null, 204);
  });
  app.get("/api/chat/sessions/:sessionId/messages", (c) => {
    return c.json(store.listChatMessages(c.req.param("sessionId")).map(chatMessageCompatibilityResponse));
  });
  app.post("/api/chat/sessions/:sessionId/messages", async (c) => {
    const body = await readJson<SendChatMessageInput>(c);
    return c.json(sendChatMessageCompatibilityResponse(store.sendChatMessage(c.req.param("sessionId"), body)), 201);
  });
  app.get("/api/chat/sessions/:sessionId/pending-task", (c) => {
    const task = store.getPendingChatTask(c.req.param("sessionId"));
    return c.json(task ? { task_id: task.id, status: task.status, created_at: task.createdAt } : {});
  });
  app.post("/api/chat/sessions/:sessionId/read", (c) => {
    store.markChatSessionRead(c.req.param("sessionId"));
    return c.body(null, 204);
  });
  app.get("/api/chat/pending-tasks", (c) => {
    const tasks = store.listPendingChatTasks(c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local")
      .map((task) => ({ task_id: task.id, status: task.status, chat_session_id: task.chatSessionId }));
    return c.json({ tasks });
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
  app.post("/api/tasks/:id/cancel", (c) => {
    return c.json(taskCompatibilityResponse(store.cancelTask(c.req.param("id"))));
  });
  app.get("/api/multica/tasks/:id/messages", (c) => {
    return c.json({ messages: store.listTaskMessages(c.req.param("id")) });
  });

  // Multica daemon-compatible endpoints.
  app.post("/api/daemon/runtimes/:runtimeId/tasks/claim", (c) => {
    const task = store.claimTask(c.req.param("runtimeId"));
    return c.json({ task: task ? taskCompatibilityResponse(task) : null });
  });
  app.get("/api/daemon/runtimes/:runtimeId/tasks/pending", (c) => {
    const runtime = store.getRuntime(c.req.param("runtimeId"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    const tasks = store.listTasks()
      .filter((task) => isPendingForRuntime(store, runtime, task))
      .map(taskCompatibilityResponse);
    return c.json(tasks);
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
  app.get("/api/daemon/tasks/:taskId/messages", (c) => {
    return c.json(store.listTaskMessages(c.req.param("taskId")));
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
  app.get("/api/tasks/:taskId/messages", (c) => {
    return c.json(store.listTaskMessages(c.req.param("taskId")));
  });
  app.get("/api/daemon/issues/:issueId/gc-check", (c) => {
    const issue = store.getIssue(c.req.param("issueId"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    return c.json({ status: issue.status, updated_at: issue.updatedAt });
  });
  app.get("/api/daemon/chat-sessions/:sessionId/gc-check", (c) => {
    const session = store.getChatSession(c.req.param("sessionId"));
    if (!session) return c.json({ error: "chat session not found" }, 404);
    return c.json({ status: session.status, updated_at: session.updatedAt });
  });
  app.get("/api/daemon/autopilot-runs/:runId/gc-check", (c) => {
    const run = store.getAutopilotRun(c.req.param("runId"));
    if (!run) return c.json({ error: "autopilot run not found" }, 404);
    return c.json({ status: run.status, completed_at: run.completedAt });
  });
  app.get("/api/daemon/tasks/:taskId/gc-check", (c) => {
    const task = store.getTask(c.req.param("taskId"));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ status: task.status, completed_at: task.completedAt });
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

function issueListQuery(c: { req: { query: (name: string) => string | undefined } }): ListIssuesInput {
  return {
    workspaceId: c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local",
    statuses: splitQueryList(c.req.query("statuses") ?? c.req.query("status")),
    priorities: splitQueryList(c.req.query("priorities") ?? c.req.query("priority")),
    assigneeTypes: splitQueryList(c.req.query("assigneeTypes") ?? c.req.query("assignee_types")) as ListIssuesInput["assigneeTypes"],
    assigneeId: c.req.query("assigneeId") ?? c.req.query("assignee_id") ?? null,
    assigneeIds: splitQueryList(c.req.query("assigneeIds") ?? c.req.query("assignee_ids")),
    projectId: c.req.query("projectId") ?? c.req.query("project_id") ?? null,
    projectIds: splitQueryList(c.req.query("projectIds") ?? c.req.query("project_ids")),
    includeNoAssignee: c.req.query("includeNoAssignee") === "true" || c.req.query("include_no_assignee") === "true",
    includeNoProject: c.req.query("includeNoProject") === "true" || c.req.query("include_no_project") === "true",
    limit: parseOptionalInt(c.req.query("limit")),
    offset: parseOptionalInt(c.req.query("offset")),
  };
}

function assigneeFrequencyQuery(c: { req: { query: (name: string) => string | undefined } }): {
  workspaceId?: string | null;
  actorId?: string | null;
  memberId?: string | null;
  userId?: string | null;
} {
  return {
    workspaceId: c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local",
    actorId: c.req.query("actorId") ?? c.req.query("actor_id") ?? null,
    memberId: c.req.query("memberId") ?? c.req.query("member_id") ?? null,
    userId: c.req.query("userId") ?? c.req.query("user_id") ?? null,
  };
}

function splitQueryList(value: string | undefined): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function issuePullRequestsResponse(pullRequests: MulticaGitHubPullRequest[]): {
  pull_requests: Array<MulticaGitHubPullRequest & {
    workspace_id: string;
    issue_id: string | null;
    repo_owner: string;
    repo_name: string;
    html_url: string;
    author_login: string | null;
    author_avatar_url: string | null;
    merged_at: string | null;
    closed_at: string | null;
    pr_created_at: string;
    pr_updated_at: string;
    mergeable_state: string | null;
    checks_conclusion: string | null;
    checks_passed: number;
    checks_failed: number;
    checks_pending: number;
    changed_files: number;
  }>;
} {
  return {
    pull_requests: pullRequests.map((pr) => ({
      ...pr,
      workspace_id: pr.workspaceId,
      issue_id: pr.issueId,
      repo_owner: pr.repoOwner,
      repo_name: pr.repoName,
      html_url: pr.htmlUrl,
      author_login: pr.authorLogin,
      author_avatar_url: pr.authorAvatarUrl,
      merged_at: pr.mergedAt,
      closed_at: pr.closedAt,
      pr_created_at: pr.prCreatedAt,
      pr_updated_at: pr.prUpdatedAt,
      mergeable_state: pr.mergeableState,
      checks_conclusion: pr.checksConclusion,
      checks_passed: pr.checksPassed,
      checks_failed: pr.checksFailed,
      checks_pending: pr.checksPending,
      changed_files: pr.changedFiles,
    })),
  };
}

function issueTimelineResponse(
  store: MulticaStore,
  issueId: string,
  c: { req: { query: (name: string) => string | undefined } },
): MulticaTimelineEntry[] | {
  entries: MulticaTimelineEntry[];
  next_cursor: null;
  prev_cursor: null;
  has_more_before: false;
  has_more_after: false;
  target_index?: number;
} | null {
  if (!store.getIssue(issueId)) return null;
  const wrapped = ["limit", "before", "after", "around"].some((name) => c.req.query(name) != null);
  if (!wrapped) return store.listIssueTimeline(issueId, { ascending: true });
  const entries = store.listIssueTimeline(issueId, { ascending: false });
  const response: {
    entries: MulticaTimelineEntry[];
    next_cursor: null;
    prev_cursor: null;
    has_more_before: false;
    has_more_after: false;
    target_index?: number;
  } = {
    entries,
    next_cursor: null,
    prev_cursor: null,
    has_more_before: false,
    has_more_after: false,
  };
  const anchor = c.req.query("around");
  if (anchor) {
    const index = entries.findIndex((entry) => entry.id === anchor);
    if (index >= 0) response.target_index = index;
  }
  return response;
}

function withFeedbackRequestMetadata(
  input: CreateFeedbackInput,
  c: { req: { header: (name: string) => string | undefined } },
): CreateFeedbackInput {
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    platform: c.req.header("x-multica-platform") ?? c.req.header("x-remi-platform") ?? null,
    version: c.req.header("x-multica-version") ?? c.req.header("x-remi-version") ?? null,
    os: c.req.header("x-multica-os") ?? c.req.header("x-remi-os") ?? null,
    user_agent: c.req.header("user-agent") ?? null,
  };
  return { ...input, metadata };
}

function createFeedbackOrApiError(store: MulticaStore, input: CreateFeedbackInput): ReturnType<MulticaStore["createFeedback"]> {
  try {
    return store.createFeedback(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "message is required" || message === "message too long" || message === "metadata exceeds the 8KB size limit") {
      throw new MulticaApiError(message, 400);
    }
    if (message === "too many feedback submissions, please try again later") {
      throw new MulticaApiError(message, 429);
    }
    throw error;
  }
}

function safeUpdateCurrentUser(
  store: MulticaStore,
  input: any,
): ReturnType<MulticaStore["updateCurrentUser"]> | { error: string; status: 400 } {
  try {
    return store.updateCurrentUser(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message === "name is required"
      || message === "unsupported language"
      || message === "invalid timezone"
      || message.startsWith("profile_description exceeds")
    ) {
      return { error: message, status: 400 };
    }
    throw error;
  }
}

function safeCreateWorkspace(
  store: MulticaStore,
  input: any,
): ReturnType<MulticaStore["createWorkspace"]> | { error: string; status: 400 | 409 } {
  try {
    return store.createWorkspace({
      name: String(input.name ?? ""),
      slug: input.slug,
      description: input.description ?? null,
      context: input.context ?? null,
      settings: input.settings,
      repos: input.repos,
      issuePrefix: input.issuePrefix ?? input.issue_prefix,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "name and slug are required" || message.startsWith("slug must contain")) {
      return { error: message, status: 400 };
    }
    if (message.includes("UNIQUE constraint failed")) {
      return { error: "workspace slug already exists", status: 409 };
    }
    throw error;
  }
}

function safeCreateInvitation(
  store: MulticaStore,
  workspaceId: string,
  input: any,
): NonNullable<ReturnType<MulticaStore["createWorkspaceInvitation"]>> | { error: string; status: 400 | 404 | 409 } {
  try {
    return store.createWorkspaceInvitation(workspaceId, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Workspace not found")) return { error: "workspace not found", status: 404 };
    if (message === "email is required" || message === "invalid member role" || message === "cannot invite as owner") {
      return { error: message, status: 400 };
    }
    if (message === "user is already a member" || message === "invitation already pending for this email") {
      return { error: message, status: 409 };
    }
    throw error;
  }
}

function safeAcceptInvitation(
  store: MulticaStore,
  invitationId: string,
): NonNullable<ReturnType<MulticaStore["acceptInvitation"]>> | { error: string; status: 400 | 403 | 404 } {
  try {
    const invitation = store.acceptInvitation(invitationId);
    if (!invitation) return { error: "invitation not found", status: 404 };
    return invitation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invitation does not belong to you") return { error: message, status: 403 };
    return { error: message, status: 400 };
  }
}

function safeDeclineInvitation(
  store: MulticaStore,
  invitationId: string,
): NonNullable<ReturnType<MulticaStore["declineInvitation"]>> | { error: string; status: 400 | 403 | 404 } {
  try {
    const invitation = store.declineInvitation(invitationId);
    if (!invitation) return { error: "invitation not found", status: 404 };
    return invitation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invitation does not belong to you") return { error: message, status: 403 };
    return { error: message, status: 400 };
  }
}

function safeJoinCloudWaitlist(
  body: { email?: string; reason?: string },
  store: MulticaStore,
): ReturnType<MulticaStore["updateCurrentUser"]> | { error: string; status: 400 } {
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) return { error: "email is required", status: 400 };
  if (email.length > 254) return { error: "email is too long", status: 400 };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "email is invalid", status: 400 };
  const reason = String(body.reason ?? "").trim();
  if (reason.length > 1000) return { error: "reason is too long", status: 400 };
  const user = store.getCurrentUser();
  return store.updateCurrentUser({
    onboardingQuestionnaire: {
      ...user.onboardingQuestionnaire,
      cloud_waitlist_email: email,
      cloud_waitlist_reason: reason,
    },
  });
}

function safeRuntimeOnboardingBootstrap(
  store: MulticaStore,
  body: { workspace_id?: string; workspaceId?: string; runtime_id?: string; runtimeId?: string },
): { workspace_id: string; agent_id: string; issue_id: string } | { error: string; status: 400 | 404 } {
  const workspaceId = body.workspace_id ?? body.workspaceId ?? "";
  const runtimeId = body.runtime_id ?? body.runtimeId ?? "";
  if (!workspaceId) return { error: "workspace_id is required", status: 400 };
  if (!runtimeId) return { error: "runtime_id is required", status: 400 };
  const runtime = store.getRuntime(runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) return { error: "invalid runtime_id", status: 400 };
  const provider = runtime.provider === "claude" || runtime.provider === "codex" ? runtime.provider : "codex";
  const agent = store.ensureDefaultAgent(provider);
  const issue = createOnboardingIssue(store, workspaceId, "Connect your local runtime", `Use ${runtime.name} to run your first task.`);
  store.createTask({
    agentId: agent.id,
    issueId: issue.id,
    workspaceId,
    prompt: "Help complete onboarding and verify the local runtime is ready.",
  });
  store.markCurrentUserOnboarded();
  return { workspace_id: workspaceId, agent_id: agent.id, issue_id: issue.id };
}

function safeNoRuntimeOnboardingBootstrap(
  store: MulticaStore,
  body: { workspace_id?: string; workspaceId?: string },
): { workspace_id: string; issue_id: string } | { error: string; status: 400 | 404 } {
  const workspaceId = body.workspace_id ?? body.workspaceId ?? "";
  if (!workspaceId) return { error: "workspace_id is required", status: 400 };
  if (!store.getWorkspace(workspaceId)) return { error: "workspace not found", status: 404 };
  const issue = createOnboardingIssue(
    store,
    workspaceId,
    "Install a local runtime",
    "Install and register a local Claude or Codex runtime to start running tasks.",
  );
  store.markCurrentUserOnboarded();
  return { workspace_id: workspaceId, issue_id: issue.id };
}

function createOnboardingIssue(
  store: MulticaStore,
  workspaceId: string,
  title: string,
  description: string,
): ReturnType<MulticaStore["createIssue"]> {
  const existing = store.listIssues({ workspaceId }).find((issue) => issue.title === title);
  if (existing) return existing;
  return store.createIssue({
    title,
    description,
    workspaceId,
    createdBy: "local",
    priority: "medium",
    contextRefs: [{ type: "onboarding" }],
  });
}

function registerDaemonRuntimes(store: MulticaStore, body: DaemonRegisterRequestBody):
  | {
    runtimes: ReturnType<typeof daemonRuntimeResponse>[];
    repos: unknown[];
    repos_version: string;
    settings: Record<string, unknown>;
  }
  | { error: string; status: 400 } {
  const workspaceId = String(body.workspace_id ?? body.workspaceId ?? "").trim();
  const daemonId = String(body.daemon_id ?? body.daemonId ?? "").trim();
  const runtimes = body.runtimes ?? [];
  if (!daemonId) return { error: "daemon_id is required", status: 400 };
  if (!workspaceId) return { error: "workspace_id is required", status: 400 };
  if (runtimes.length === 0) return { error: "at least one runtime is required", status: 400 };

  const deviceName = String(body.device_name ?? body.deviceName ?? "").trim();
  const cliVersion = String(body.cli_version ?? body.cliVersion ?? "").trim();
  const launchedBy = String(body.launched_by ?? body.launchedBy ?? "").trim();
  const registered = runtimes.map((runtime) => {
    const provider = String(runtime.type ?? runtime.provider ?? "unknown").trim() || "unknown";
    const version = String(runtime.version ?? "").trim();
    const name = String(runtime.name ?? "").trim() || (deviceName ? `${provider} (${deviceName})` : provider);
    const id = daemonRuntimeId(daemonId, provider);
    const saved = store.registerRuntime({
      id,
      name,
      provider,
      workspaceId,
      maxConcurrency: 1,
    });
    if (runtime.status === "offline") store.setRuntimeOffline(saved.id);
    const current = store.getRuntime(saved.id) ?? saved;
    return daemonRuntimeResponse(current, {
      daemonId,
      runtimeMode: "local",
      version,
      cliVersion,
      launchedBy,
      deviceName,
    });
  });
  const repos = workspaceReposResponse(workspaceId);
  return {
    runtimes: registered,
    repos: repos.repos,
    repos_version: repos.repos_version,
    settings: repos.settings,
  };
}

function workspaceReposResponse(workspaceId: string): {
  workspace_id: string;
  repos: unknown[];
  repos_version: string;
  settings: Record<string, unknown>;
} {
  return {
    workspace_id: workspaceId,
    repos: [],
    repos_version: emptyReposVersion(),
    settings: {},
  };
}

function cloudRuntimeUnavailableResponse(): { error: string; configured: false } {
  return { error: "cloud runtime service is not configured", configured: false };
}

function githubAppSlug(): string {
  return (process.env.GITHUB_APP_SLUG ?? "").trim();
}

function githubWebhookSecret(): string {
  return (process.env.GITHUB_WEBHOOK_SECRET ?? process.env.MULTICA_WEBHOOK_SECRET ?? "").trim();
}

function isGitHubAppConfigured(): boolean {
  return Boolean(githubAppSlug() && githubWebhookSecret());
}

function signGitHubState(workspaceId: string): string {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const payload = `${workspaceId}.${nonce}`;
  const sig = createHmac("sha256", githubWebhookSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function githubConnectResponse(workspaceId: string): { configured: boolean; url?: string } {
  if (!isGitHubAppConfigured()) return { configured: false };
  const state = signGitHubState(workspaceId);
  return {
    configured: true,
    url: `https://github.com/apps/${encodeURIComponent(githubAppSlug())}/installations/new?state=${encodeURIComponent(state)}`,
  };
}

function githubSetupResponse(installationId?: string, state?: string): {
  configured: boolean;
  installation_id?: string;
  state?: string;
  error?: string;
} {
  if (!isGitHubAppConfigured()) return { configured: false, error: "github app is not configured" };
  if (!installationId || !state) return { configured: true, error: "missing_params" };
  return { configured: true, installation_id: installationId, state };
}

function taskCompatibilityResponse(task: MulticaTask): MulticaTask & {
  agent_id: string;
  runtime_id: string | null;
  issue_id: string | null;
  chat_session_id: string | null;
  workspace_id: string;
  branch_name: string | null;
  session_id: string | null;
  work_dir: string | null;
  progress_summary: string | null;
  progress_step: number | null;
  progress_total: number | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
} {
  return {
    ...task,
    agent_id: task.agentId,
    runtime_id: task.runtimeId,
    issue_id: task.issueId,
    chat_session_id: task.chatSessionId,
    workspace_id: task.workspaceId,
    branch_name: task.branchName,
    session_id: task.sessionId,
    work_dir: task.workDir,
    progress_summary: task.progressSummary,
    progress_step: task.progressStep,
    progress_total: task.progressTotal,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    dispatched_at: task.dispatchedAt,
    started_at: task.startedAt,
    completed_at: task.completedAt,
    failed_at: task.failedAt,
    cancelled_at: task.cancelledAt,
  };
}

function chatSessionCompatibilityResponse(session: MulticaChatSession): MulticaChatSession & {
  workspace_id: string;
  agent_id: string;
  session_id: string | null;
  work_dir: string | null;
  latest_task_id: string | null;
  created_at: string;
  updated_at: string;
} {
  return {
    ...session,
    workspace_id: session.workspaceId,
    agent_id: session.agentId,
    session_id: session.sessionId,
    work_dir: session.workDir,
    latest_task_id: session.latestTaskId,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

function chatMessageCompatibilityResponse(message: MulticaChatMessage): MulticaChatMessage & {
  chat_session_id: string;
  task_id: string | null;
  created_at: string;
} {
  return {
    ...message,
    chat_session_id: message.chatSessionId,
    task_id: message.taskId,
    created_at: message.createdAt,
  };
}

function sendChatMessageCompatibilityResponse(result: SendChatMessageResult): SendChatMessageResult & {
  session: ReturnType<typeof chatSessionCompatibilityResponse>;
  message: ReturnType<typeof chatMessageCompatibilityResponse>;
  task: ReturnType<typeof taskCompatibilityResponse>;
} {
  return {
    ...result,
    session: chatSessionCompatibilityResponse(result.session),
    message: chatMessageCompatibilityResponse(result.message),
    task: taskCompatibilityResponse(result.task),
  };
}

function inboxCompatibilityResponse(item: MulticaInboxItem): MulticaInboxItem & {
  workspace_id: string;
  issue_id: string;
  member_id: string;
  actor_type: string;
  actor_id: string | null;
  created_at: string;
} {
  return {
    ...item,
    workspace_id: item.workspaceId,
    issue_id: item.issueId,
    member_id: item.memberId,
    actor_type: item.actorType,
    actor_id: item.actorId,
    created_at: item.createdAt,
  };
}

function squadMemberStatusResponse(store: MulticaStore, squadId: string): Array<{
  member_type: string;
  member_id: string;
  status: string;
}> {
  return store.listSquadMembers(squadId).map((member) => {
    if (member.memberType === "agent") {
      const agent = store.getAgent(member.memberId);
      return {
        member_type: member.memberType,
        member_id: member.memberId,
        status: agent?.archivedAt ? "archived" : agent ? "available" : "missing",
      };
    }
    const workspaceMember = store.getWorkspaceMember(member.memberId);
    return {
      member_type: member.memberType,
      member_id: member.memberId,
      status: workspaceMember?.archivedAt ? "archived" : workspaceMember ? "available" : "missing",
    };
  });
}

function autopilotTriggerResponse(trigger: MulticaAutopilotTrigger): MulticaAutopilotTrigger & {
  autopilot_id: string;
  cron_expression: string | null;
  next_run_at: string | null;
  webhook_token: string | null;
  webhook_path: string | null;
  webhook_url: string | null;
  signing_secret_set: boolean;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
} {
  return {
    ...trigger,
    autopilot_id: trigger.autopilotId,
    cron_expression: trigger.cronExpression,
    next_run_at: trigger.nextRunAt,
    webhook_token: trigger.webhookToken,
    webhook_path: trigger.webhookPath,
    webhook_url: trigger.webhookUrl,
    signing_secret_set: trigger.signingSecretSet,
    last_fired_at: trigger.lastFiredAt,
    created_at: trigger.createdAt,
    updated_at: trigger.updatedAt,
  };
}

function issueUsageResponse(store: MulticaStore, issue: MulticaIssue): {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  task_count: number;
} {
  const taskIds = new Set(store.listTasksForIssue(issue.id).map((task) => task.id));
  const totals = {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    task_count: taskIds.size,
  };
  for (const task of store.listTasksForIssue(issue.id)) {
    for (const entry of task.usage) {
      totals.total_input_tokens += entry.inputTokens ?? 0;
      totals.total_output_tokens += entry.outputTokens ?? 0;
      totals.total_cache_read_tokens += entry.cacheReadTokens ?? 0;
      totals.total_cache_write_tokens += entry.cacheWriteTokens ?? 0;
    }
  }
  return totals;
}

function safeRerunIssue(
  store: MulticaStore,
  issueId: string,
  body: { agent_id?: string; agentId?: string; prompt?: string },
): { task: MulticaTask } | { error: string; status: 400 | 404 } {
  const issue = store.getIssue(issueId);
  if (!issue) return { error: "issue not found", status: 404 };
  const agentId = body.agent_id ?? body.agentId ?? issue.assigneeId;
  if (!agentId) return { error: "issue has no agent assignee", status: 400 };
  if (!store.getAgent(agentId)) return { error: "agent not found", status: 404 };
  const task = store.createTask({
    agentId,
    issueId: issue.id,
    workspaceId: issue.workspaceId,
    prompt: body.prompt ?? issue.title,
  });
  return { task };
}

function isPendingForRuntime(store: MulticaStore, runtime: MulticaRuntime, task: MulticaTask): boolean {
  if (runtime.workspaceId && task.workspaceId !== runtime.workspaceId) return false;
  if (task.status === "dispatched" || task.status === "running") return task.runtimeId === runtime.id;
  if (task.status !== "queued") return false;
  const agent = store.getAgent(task.agentId);
  if (!agent || agent.archivedAt) return false;
  return runtime.provider === "any" || agent.provider === runtime.provider;
}

function daemonRuntimeId(daemonId: string, provider: string): string {
  const key = `${daemonId}:${provider}`.toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `rt_${(hash >>> 0).toString(36)}`;
}

function emptyReposVersion(): string {
  return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
}

function launchHeader(provider: string): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  return provider ? provider[0].toUpperCase() + provider.slice(1) : "Runtime";
}

function daemonRuntimeResponse(
  runtime: MulticaRuntime,
  metadata: {
    daemonId: string;
    runtimeMode: string;
    version: string;
    cliVersion: string;
    launchedBy: string;
    deviceName: string;
  },
): {
  id: string;
  workspace_id: string | null;
  daemon_id: string;
  name: string;
  runtime_mode: string;
  provider: string;
  launch_header: string;
  status: string;
  device_info: string;
  metadata: Record<string, unknown>;
  owner_id: string | null;
  visibility: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
} {
  const deviceInfo = [metadata.deviceName, metadata.version].filter(Boolean).join(" · ");
  return {
    id: runtime.id,
    workspace_id: runtime.workspaceId,
    daemon_id: metadata.daemonId,
    name: runtime.name,
    runtime_mode: metadata.runtimeMode,
    provider: runtime.provider,
    launch_header: launchHeader(String(runtime.provider)),
    status: runtime.status,
    device_info: deviceInfo,
    metadata: {
      version: metadata.version,
      cli_version: metadata.cliVersion,
      launched_by: metadata.launchedBy,
    },
    owner_id: runtime.ownerId,
    visibility: runtime.visibility,
    last_seen_at: runtime.lastHeartbeatAt,
    created_at: runtime.createdAt,
    updated_at: runtime.updatedAt,
  };
}

function safeCreateRuntimeUpdateRequest(
  store: MulticaStore,
  runtimeId: string,
  input: CreateRuntimeUpdateInput,
): ReturnType<MulticaStore["createRuntimeUpdateRequest"]> | { apiError: string; statusCode: 400 | 404 | 409 | 503 } {
  try {
    return store.createRuntimeUpdateRequest(runtimeId, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "target_version is required") return { apiError: message, statusCode: 400 };
    if (message.startsWith("Runtime not found")) return { apiError: "runtime not found", statusCode: 404 };
    if (message === "runtime is offline") return { apiError: message, statusCode: 503 };
    if (message === "an update is already in progress for this runtime") return { apiError: message, statusCode: 409 };
    throw error;
  }
}

function safeQuickCreateIssue(store: MulticaStore, input: QuickCreateIssueInput): ReturnType<MulticaStore["quickCreateIssue"]> | { error: string } {
  try {
    return store.quickCreateIssue(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message === "prompt is required"
      || message === "exactly one of agent_id or squad_id is required"
      || message.startsWith("No runnable agent")
      || message.startsWith("Project not found")
      || message === "Project belongs to another workspace"
      || message.startsWith("Agent not found")
      || message.startsWith("Squad not found")
      || message.startsWith("Member not found")
    ) {
      return { error: message };
    }
    throw error;
  }
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

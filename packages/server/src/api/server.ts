import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import { AgentTemplateError } from "./agent-templates.js";
import { MultiremiScheduler } from "@multiremi/scheduler.js";
import { SkillImportError } from "@daemon/agent-runtime/skills/skill-import.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import { AgentPluginStoreError } from "@multiremi/store/repos/agent-plugins-repo.js";
import {
  DaemonIdentityOwnerConflictError,
  DaemonRetiredError,
} from "@multiremi/store/repos/daemon-retirement-repo.js";
import { RuntimeRegistrationIdentityConflictError } from "@multiremi/store/repos/runtimes-repo.js";
import { PlatformOperationConflictError } from "@multiremi/store/repos/platform-operations-repo.js";
// Domain routers, listed in the order createMultiremiApp registers them.
import { registerAuthRoutes } from "./routers/auth.js";
import { registerWebhookRoutes } from "./routers/webhooks.js";
import { registerScmWebhookRoutes } from "@multiremi/scm/router.js";
import { registerRemiReleaseRoutes } from "./routers/remi-releases.js";
import { registerDaemonRoutes } from "./routers/daemon.js";
import { registerSessionArchiveRoutes } from "./routers/session-archives.js";
import { registerCloudRuntimeRoutes } from "./routers/cloud-runtime.js";
import { registerCloudBillingRoutes } from "./routers/cloud-billing.js";
import { registerMeRoutes } from "./routers/me.js";
import { registerWorkspaceRoutes } from "./routers/workspaces.js";
import { registerScmRoutes } from "./routers/scm.js";
import { registerFeishuCompatRoutes } from "./routers/feishu-compat.js";
import { registerMessagingRoutes } from "./routers/messaging.js";
import { registerFeishuBotRoutes } from "./routers/feishu-bot.js";
import {
  FeishuBotRegistrationService,
  type FeishuBotRegistrationOptions,
} from "@multiremi/feishu-bot/registration.js";
import { registerMemberRoutes } from "./routers/members.js";
import { registerInvitationRoutes } from "./routers/invitations.js";
import { registerAgentRoutes } from "./routers/agents.js";
import { registerAgentPluginRoutes } from "./routers/agent-plugins.js";
import { registerAgentTemplateRoutes } from "./routers/agent-templates.js";
import { registerSkillRoutes } from "./routers/skills.js";
import { registerTokenRoutes } from "./routers/tokens.js";
import { registerNotificationPreferenceRoutes } from "./routers/notification-preferences.js";
import { registerNotificationChannelRoutes } from "./routers/notification-channels.js";
import { registerRuntimeRoutes } from "./routers/runtimes.js";
import { registerDaemonRetirementRoutes } from "./routers/daemon-retirement.js";
import { registerDashboardRoutes } from "./routers/dashboard.js";
import { registerProjectRoutes } from "./routers/projects.js";
import { registerKnowledgeRoutes } from "./routers/knowledge.js";
import { registerSquadRoutes } from "./routers/squads.js";
import { registerAutopilotRoutes } from "./routers/autopilots.js";
import { registerLabelRoutes } from "./routers/labels.js";
import { registerPinRoutes } from "./routers/pins.js";
import { registerIssueRoutes } from "./routers/issues.js";
import { registerIssueShareRoutes } from "./routers/issue-shares.js";
import { registerInboxRoutes } from "./routers/inbox.js";
import { registerCommentRoutes } from "./routers/comments.js";
import { registerAttachmentRoutes } from "./routers/attachments.js";
import { registerChatRoutes } from "./routers/chat.js";
import { registerTaskRoutes } from "./routers/tasks.js";
import { registerPlatformRoutes } from "./routers/platform.js";
import {
  evaluateStartupEnv,
  normalizeDaemonDirectBaseUrl,
} from "../config/startup-env.js";
import { CLI_SHARE_HEADER, registerCliRoutes } from "./routers/cli.js";
import { registerCliLatestVersionRoutes } from "./routers/cli-latest-version.js";
import type { RouterDeps } from "./routers/deps.js";
import {
  createProjectKnowledgeServiceFromEnv,
  type ProjectKnowledgeServiceContract,
} from "@multiremi/project-knowledge/service.js";
import {
  createRepositoryWikiServiceFromEnv,
  type RepositoryWikiServiceContract,
} from "@multiremi/repository-wiki/service.js";
import {
  inspectGitRemoteRepository,
  type GitRemoteInspector,
} from "./helpers/repositories.js";
import type {
  CreateFeedbackInput,
  MultiremiAccessToken,
} from "@multiremi/contracts/types.js";
import {
  resolveAgentPluginGitSource,
  type AgentPluginGitSourceResolver,
} from "@multiremi/agent-plugins/git-import.js";
import { createScmAuthenticatedAgentPluginGitSourceResolver } from "@multiremi/agent-plugins/scm-git-auth.js";
import {
  createControlPlaneSshMeshFromEnv,
  type ControlPlaneSshMeshLifecycle,
} from "@multiremi/ssh-mesh/control-plane.js";
import {
  AUTH_COOKIE_NAME,
  DEFAULT_WEBHOOK_IP_RATE_LIMIT,
  DEFAULT_WEBHOOK_RATE_LIMIT,
  MultiremiApiError,
  buildRequestAuth,
  createFeedbackOrApiError,
  createWebhookRateLimiter,
  denyCurrentUserWorkspaceAccess,
  isDaemonOwnerWorkspaceMember,
  denyDaemonTokenAutopilotRunWorkspace,
  denyDaemonTokenChatSessionWorkspace,
  denyDaemonTokenIssueWorkspace,
  denyNonDaemonOperationalAccess,
  denyDaemonTokenRuntimeIdentity,
  denyDaemonTokenTaskRuntimeIdentity,
  isDaemonGcCheckRequest,
  isFeishuBotOutboundAttachmentRequest,
  isDaemonTokenAllowedRequest,
  taskTokenHardDenyCategory,
  log,
  readJson,
  resolveWebhookClientIpAddress,
  setWebhookClientIpAddress,
  verifyJwtToken,
  withFeedbackRequestMetadata,
} from "./helpers.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import { ScmPollingScheduler } from "@multiremi/scm/poller.js";
import { IssueTitleScheduler } from "@multiremi/issue-title/poller.js";
import { retitleIssue } from "@multiremi/issue-title/service.js";
import {
  createScmConnectionVerifier,
  type ScmConnectionVerifier,
} from "@multiremi/scm/verification.js";
import { scmIngestionStore } from "@multiremi/scm/store.js";
import {
  createMessageProviderRegistry,
  MessagingScheduler,
  type MessageProviderRegistry,
} from "@multiremi/messaging/index.js";
import {
  authorizeBrowserWebSocketAuthFrame,
  authorizeBrowserWebSocketUpgrade,
  authorizeDaemonWebSocketRequest,
  handleBrowserScopeSubscribe,
  handleBrowserScopeUnsubscribe,
  isWebSocketUpgrade,
  notifyBrowserTaskEvent,
  notifyBrowserTaskMessages,
  notifyBrowserWorkspaceEvent,
  notifyDaemonTaskAvailable,
  notifyDaemonTaskEvent,
  parseDaemonWebSocketHeartbeat,
  parseDaemonWebSocketMessage,
  parseDaemonWebSocketRuntimeIds,
  registerBrowserUserWebSocketClient,
  registerBrowserWebSocketClient,
  registerDaemonWebSocketClient,
  resolveBrowserWebSocketWorkspaceId,
  unregisterBrowserScopeWebSocketClient,
  unregisterBrowserUserWebSocketClient,
  unregisterBrowserWebSocketClient,
  unregisterDaemonWebSocketClient,
} from "./realtime.js";
import type {
  BrowserScopeWebSocketRegistry,
  BrowserUserWebSocketRegistry,
  BrowserWebSocketRegistry,
  DaemonWebSocketRegistry,
  MultiremiRealtimeState,
  MultiremiWebSocketData,
  WebhookRateLimitConfig,
} from "./helpers.js";

let authDisabledWarningEmitted = false;

function recordTaskTokenWrite(
  request: Request,
  token: MultiremiAccessToken,
  statusCode: number,
  denyCategory?: string,
): void {
  const method = request.method.toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") return;
  log.info("task token write request", {
    event: "task_token_write",
    task_id: token.taskId ?? null,
    workspace_id: token.workspaceId ?? null,
    method,
    path: new URL(request.url).pathname,
    status_code: statusCode,
    ...(denyCategory ? { deny_category: denyCategory } : {}),
  });
}

function envEnabled(value: string | undefined, fallback = true): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export interface MultiremiApiOptions {
  store?: MultiremiStore;
  scheduler?: MultiremiScheduler | null;
  /** Undefined reads the opt-in env config; null explicitly disables it. */
  controlPlaneSshMesh?: ControlPlaneSshMeshLifecycle | null;
  authToken?: string | null;
  platformUpdaterToken?: string | null;
  shareSecret?: string | null;
  hostname?: string;
  realtimeState?: MultiremiRealtimeState;
  webhookRateLimit?: Partial<WebhookRateLimitConfig> | false;
  webhookIpRateLimit?: Partial<WebhookRateLimitConfig> | false;
  inspectGitRemoteRepository?: GitRemoteInspector;
  resolveAgentPluginGitSource?: AgentPluginGitSourceResolver;
  projectKnowledge?: ProjectKnowledgeServiceContract;
  repositoryWiki?: RepositoryWikiServiceContract;
  sessionArchives?: SessionArchiveService;
  /** Absolute API origin advertised to daemons for direct archive uploads. */
  daemonDirectBaseUrl?: string | null;
  /** Undefined enables server-owned API polling; null explicitly disables it. */
  scmPolling?: ScmPollingScheduler | null;
  /** Undefined enables server-owned message ingestion; null explicitly disables it. */
  messaging?: MessagingScheduler | null;
  /** Providers this server can reach. Defaults to everything this build ships. */
  messagingProviders?: MessageProviderRegistry;
  /** Injectable Feishu app registration (device flow) dependencies for tests. */
  feishuBotRegistrations?: FeishuBotRegistrationOptions;
  /** Undefined enables server-owned Issue title scanning; null explicitly disables it. */
  issueTitleScheduler?: IssueTitleScheduler | null;
  issueRetitle?: typeof retitleIssue;
  /** Disable every server-owned background job for a read-only blue/green candidate. */
  backgroundJobs?: boolean;
  verifyScmConnection?: ScmConnectionVerifier;
}

export function createMultiremiApp(options: MultiremiApiOptions = {}): Hono {
  const store = options.store ?? new MultiremiStore();
  const scheduler = options.scheduler ?? null;
  const authToken = options.authToken ?? process.env.MULTIREMI_TOKEN ?? "";
  const platformUpdaterToken = options.platformUpdaterToken
    ?? process.env.MULTIREMI_PLATFORM_UPDATER_TOKEN
    ?? "";
  const shareSecret = options.shareSecret?.trim()
    || process.env.MULTIREMI_SHARE_SECRET?.trim()
    || authToken
    || crypto.randomUUID();
  const realtimeState = options.realtimeState ?? { enabled: true, connections: 0 };
  const webhookRateLimiter = createWebhookRateLimiter(options.webhookRateLimit, DEFAULT_WEBHOOK_RATE_LIMIT);
  const webhookIpRateLimiter = createWebhookRateLimiter(options.webhookIpRateLimit, DEFAULT_WEBHOOK_IP_RATE_LIMIT);
  const app = new Hono();
  const projectKnowledge = options.projectKnowledge ?? createProjectKnowledgeServiceFromEnv(store);
  const repositoryWiki = options.repositoryWiki ?? createRepositoryWikiServiceFromEnv(store);
  const sessionArchives = options.sessionArchives ?? new SessionArchiveService(store);
  const messagingProviders = options.messagingProviders ?? createMessageProviderRegistry();
  const daemonDirectBaseUrl = normalizeDaemonDirectBaseUrl(
    options.daemonDirectBaseUrl === undefined
      ? process.env.MULTIREMI_DAEMON_DIRECT_BASE_URL
      : options.daemonDirectBaseUrl,
  );
  // What the route handlers used to close over; domain routers take it explicitly.
  const deps: RouterDeps = {
    store,
    scheduler,
    authToken,
    platformUpdaterToken,
    shareSecret,
    webhookRateLimiter,
    webhookIpRateLimiter,
    inspectGitRemoteRepository:
      options.inspectGitRemoteRepository ?? inspectGitRemoteRepository,
    resolveAgentPluginGitSource:
      options.resolveAgentPluginGitSource
        ?? createScmAuthenticatedAgentPluginGitSourceResolver(store, resolveAgentPluginGitSource),
    projectKnowledge,
    repositoryWiki,
    sessionArchives,
    messagingProviders,
    daemonDirectBaseUrl,
    verifyScmConnection: options.verifyScmConnection ?? createScmConnectionVerifier(),
    issueRetitle: options.issueRetitle ?? retitleIssue,
  };

  app.use("*", cors());
  // Server-rendered dashboard removed in D11 — the UI is now the Next.js app in frontend/.
  app.get("/", (c) => c.json({ service: "multiremi-api", ui: "frontend/apps/web" }));
  app.get("/favicon.ico", (c) => c.body(null, 204));

  if (authToken) {
    app.use("*", async (c, next) => {
      // Public routes that must work WITHOUT auth, otherwise enabling
      // MULTIREMI_TOKEN locks everyone out: login (chicken-and-egg), health
      // checks, self-host release downloads (install-remi.sh runs unauthed),
      // and external webhooks (authed by their own path token).
      const path = c.req.path;
      const shareCredential = c.req.header(CLI_SHARE_HEADER)?.trim() ?? "";
      const sharePathMatch = path.match(/^\/api\/shares\/([^/]+)(?:\/attachments\/[^/]+\/content)?$/);
      let matchingSharePath = false;
      if (sharePathMatch) {
        try {
          matchingSharePath = decodeURIComponent(sharePathMatch[1]!) === shareCredential;
        } catch {
          matchingSharePath = false;
        }
      }
      const hasCliShare = Boolean(shareCredential)
        && ((path === "/api/cli/context" || path === "/api/cli/capabilities") || matchingSharePath)
        && c.req.method === "GET";
      if (
        path === "/" ||
        path === "/favicon.ico" ||
        path === "/api/config" ||
        path === "/readyz" ||
        path.startsWith("/auth/") ||
        path.startsWith("/health") ||
        path.startsWith("/api/remi/releases/") ||
        path.startsWith("/api/webhooks/") ||
        hasCliShare
      ) {
        await next();
        return;
      }
      const header = c.req.header("Authorization") ?? "";
      let token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      // Native browser loads (<img src="/api/attachments/…/content">, file
      // downloads) can't attach an Authorization header. Accept the HttpOnly
      // auth cookie set at login — mirroring the Go server's multimira_auth —
      // but only for safe methods, so cookie auth can never mutate state and
      // no CSRF machinery is needed. Only when the header is entirely absent:
      // a malformed or non-Bearer Authorization must fail, not fall back.
      if (!header && (c.req.method === "GET" || c.req.method === "HEAD")) {
        token = getCookie(c, AUTH_COOKIE_NAME) ?? "";
      }
      if (token === authToken) {
        await next();
        return;
      }
      const accessToken = await store.verifyAccessToken(token);
      if (!accessToken) {
        const jwt = verifyJwtToken(token);
        if (!jwt) return c.json({ error: "unauthorized" }, 401);
        c.set("multiremiAuth", buildRequestAuth(null, jwt.userId));
        await next();
        return;
      }
      if (accessToken.type === "daemon" && !isDaemonTokenAllowedRequest(c.req.raw)) {
        return c.json({ error: "forbidden for daemon token" }, 403);
      }
      if (accessToken.type === "task") {
        const denyCategory = taskTokenHardDenyCategory(c.req.raw);
        if (denyCategory) {
          recordTaskTokenWrite(c.req.raw, accessToken, 403, denyCategory);
          return c.json({ error: "forbidden for task token", code: "task_token_hard_denied" }, 403);
        }
        c.set("multiremiAuth", buildRequestAuth(accessToken, null));
        try {
          await next();
          recordTaskTokenWrite(c.req.raw, accessToken, c.res.status);
        } catch (error) {
          recordTaskTokenWrite(c.req.raw, accessToken, 500);
          throw error;
        }
        return;
      }
      c.set("multiremiAuth", buildRequestAuth(accessToken, null));
      await next();
    });
  } else {
    if (!authDisabledWarningEmitted) {
      authDisabledWarningEmitted = true;
      log.warn(
        "dashboard auth is DISABLED (MULTIREMI_TOKEN is unset): all requests are unauthenticated and act as the local admin with full access",
      );
    }
    // Open dashboard mode still needs to recognize an explicitly supplied
    // daemon/task token. Runtime-observed Plugin state has a strict daemon
    // identity boundary, and treating every request as anonymous would make a
    // locally hosted daemon unable to report its own state. Missing or unknown
    // credentials retain the historical anonymous-admin behavior.
    app.use("*", async (c, next) => {
      const header = c.req.header("Authorization") ?? "";
      const rawToken = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      const accessToken = rawToken ? await store.verifyAccessToken(rawToken) : null;
      if (accessToken) {
        if (accessToken.type === "daemon" && !isDaemonTokenAllowedRequest(c.req.raw)) {
          return c.json({ error: "forbidden for daemon token" }, 403);
        }
        if (accessToken.type === "task") {
          const denyCategory = taskTokenHardDenyCategory(c.req.raw);
          if (denyCategory) {
            recordTaskTokenWrite(c.req.raw, accessToken, 403, denyCategory);
            return c.json({ error: "forbidden for task token", code: "task_token_hard_denied" }, 403);
          }
          c.set("multiremiAuth", buildRequestAuth(accessToken, null));
          try {
            await next();
            recordTaskTokenWrite(c.req.raw, accessToken, c.res.status);
          } catch (error) {
            recordTaskTokenWrite(c.req.raw, accessToken, 500);
            throw error;
          }
          return;
        }
        c.set("multiremiAuth", buildRequestAuth(accessToken, null));
      }
      await next();
    });
  }

  app.onError((err, c) => {
    if (err instanceof RuntimeRegistrationIdentityConflictError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    if (err instanceof PlatformOperationConflictError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    if (err instanceof DaemonIdentityOwnerConflictError) {
      return c.json({ error: "daemon is owned by another user", code: err.code }, 403);
    }
    if (err instanceof DaemonRetiredError) {
      return c.json({ error: "daemon has been retired", code: err.code }, 410);
    }
    if (err instanceof AgentPluginStoreError) {
      const body = { error: err.message, code: err.code };
      if (err.status === 404) return c.json(body, 404);
      if (err.status === 409) return c.json(body, 409);
      if (err.status === 403) return c.json(body, 403);
      return c.json(body, 400);
    }
    if (err instanceof SkillImportError) {
      return c.json({ error: err.message }, err.status as 400 | 502);
    }
    if (err instanceof AgentTemplateError) {
      return c.json({ error: err.message, failed_urls: err.failedUrls }, err.status);
    }
    if (err instanceof MultiremiApiError) {
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
  registerCliRoutes(app, deps);
  registerCliLatestVersionRoutes(app, deps);
  registerAuthRoutes(app, deps);
  app.get("/health/realtime", (c) => c.json({
    connections: realtimeState.connections,
    enabled: realtimeState.enabled,
    transport: "websocket",
  }));
  registerWebhookRoutes(app, deps);
  registerScmWebhookRoutes(app, deps);
  app.get("/api/multiremi/health", (c) => c.json({ ok: true }));
  registerRemiReleaseRoutes(app, deps);
  // The `/api/daemon/*` prefix guards stay in the skeleton and MUST stay above
  // registerDaemonRoutes: Hono only wraps handlers registered after a
  // middleware, so moving them below would silently drop the workspace checks.
  app.use("/api/daemon/*", async (c, next) => {
    const denied = denyNonDaemonOperationalAccess(c, authToken, store);
    if (denied) return denied;
    await next();
  });
  app.use("/api/daemon/runtimes/:runtimeId/*", async (c, next) => {
    const hideFeishuAttachment = isFeishuBotOutboundAttachmentRequest(c);
    const denied = denyDaemonTokenRuntimeIdentity(c, store, c.req.param("runtimeId"), {
      hideForbiddenAsNotFound: isDaemonGcCheckRequest(c) || hideFeishuAttachment,
    });
    if (denied) {
      return hideFeishuAttachment && denied.status === 404
        ? c.json({ error: "attachment not available" }, 404)
        : denied;
    }
    await next();
  });
  app.use("/api/daemon/tasks/:taskId/*", async (c, next) => {
    const denied = denyDaemonTokenTaskRuntimeIdentity(c, store, c.req.param("taskId"), {
      hideForbiddenAsNotFound: isDaemonGcCheckRequest(c),
    });
    if (denied) return denied;
    await next();
  });
  app.use("/api/daemon/issues/:issueId/*", async (c, next) => {
    const denied = denyDaemonTokenIssueWorkspace(c, store, c.req.param("issueId"), {
      hideForbiddenAsNotFound: isDaemonGcCheckRequest(c),
    });
    if (denied) return denied;
    await next();
  });
  app.use("/api/daemon/chat-sessions/:sessionId/*", async (c, next) => {
    const denied = denyDaemonTokenChatSessionWorkspace(c, store, c.req.param("sessionId"), {
      hideForbiddenAsNotFound: isDaemonGcCheckRequest(c),
    });
    if (denied) return denied;
    await next();
  });
  app.use("/api/daemon/autopilot-runs/:runId/*", async (c, next) => {
    const denied = denyDaemonTokenAutopilotRunWorkspace(c, store, c.req.param("runId"), {
      hideForbiddenAsNotFound: isDaemonGcCheckRequest(c),
    });
    if (denied) return denied;
    await next();
  });
  registerDaemonRoutes(app, deps);
  registerSessionArchiveRoutes(app, deps);
  app.get("/api/daemon/ws", (c) => c.json({
    error: "websocket upgrade required",
    enabled: realtimeState.enabled,
    upgrade_required: true,
  }, 426));
  app.get("/ws", (c) => c.json({
    error: "websocket upgrade required",
    enabled: realtimeState.enabled,
    upgrade_required: true,
  }, 426));
  app.get("/api/realtime/ws", (c) => c.json({
    error: "websocket upgrade required",
    enabled: realtimeState.enabled,
    upgrade_required: true,
  }, 426));
  registerCloudRuntimeRoutes(app, deps);
  registerCloudBillingRoutes(app, deps);
  app.post("/api/contact-sales", async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    return c.json({
      id: `local-contact-${Date.now()}`,
      status: "received",
      mode: "local",
      request: body,
    }, 201);
  });
  registerMeRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerScmRoutes(app, deps);
  registerMessagingRoutes(app, deps);
  registerFeishuCompatRoutes(app, deps);
  registerFeishuBotRoutes(app, deps, new FeishuBotRegistrationService(options.feishuBotRegistrations));
  registerMemberRoutes(app, deps);
  registerInvitationRoutes(app, deps);
  app.post("/api/lark/binding/redeem", async (c) => {
    const body = await readJson<{ token?: string }>(c);
    return c.json({
      error: "lark integration is not configured in local Bun Multiremi",
      code: "not_configured",
      token: body.token ?? "",
    }, 409);
  });

  registerAgentRoutes(app, deps);
  registerAgentPluginRoutes(app, deps);
  registerAgentTemplateRoutes(app, deps);

  registerSkillRoutes(app, deps);

  registerTokenRoutes(app, deps);
  registerNotificationPreferenceRoutes(app, deps);
  registerNotificationChannelRoutes(app, deps);
  app.post("/api/multiremi/feedback", async (c) => {
    const body = await readJson<CreateFeedbackInput>(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
    const feedback = createFeedbackOrApiError(store, withFeedbackRequestMetadata(body, c));
    return c.json({ feedback }, 201);
  });
  app.get("/api/multiremi/feedback", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const feedback = store.listFeedback(workspaceId);
    return c.json({ feedback, total: feedback.length });
  });
  app.post("/api/feedback", async (c) => {
    const body = await readJson<CreateFeedbackInput>(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
    const feedback = createFeedbackOrApiError(store, withFeedbackRequestMetadata(body, c));
    return c.json({ id: feedback.id, created_at: feedback.createdAt }, 201);
  });

  registerRuntimeRoutes(app, deps);
  registerDaemonRetirementRoutes(app, deps);
  registerPlatformRoutes(app, deps);

  registerDashboardRoutes(app, deps);

  registerKnowledgeRoutes(app, deps);

  registerProjectRoutes(app, deps);

  registerSquadRoutes(app, deps);

  registerAutopilotRoutes(app, deps);
  registerLabelRoutes(app, deps);

  registerPinRoutes(app, deps);

  registerIssueRoutes(app, deps);
  registerIssueShareRoutes(app, deps);


  registerInboxRoutes(app, deps);

  registerCommentRoutes(app, deps);
  registerAttachmentRoutes(app, deps);

  registerChatRoutes(app, deps);

  registerTaskRoutes(app, deps);

  return app;
}

export function startMultiremiServer(options: MultiremiApiOptions & { port?: number } = {}): ReturnType<typeof Bun.serve> {
  const startupEnv = {
    ...process.env,
    ...(options.authToken !== undefined
      ? { MULTIREMI_TOKEN: options.authToken ?? undefined }
      : {}),
    ...(options.daemonDirectBaseUrl !== undefined
      ? { MULTIREMI_DAEMON_DIRECT_BASE_URL: options.daemonDirectBaseUrl ?? undefined }
      : {}),
  };
  const startupConfig = evaluateStartupEnv(startupEnv);
  if (startupConfig.missingRequired.length > 0) {
    const message = `Missing required production environment variables: ${startupConfig.missingRequired.join(", ")}`;
    log.error(`[startup-env] ${message}`);
    throw new Error(message);
  }
  log.info(`[effective-config] ${JSON.stringify(startupConfig.effective)}`);
  for (const degradation of startupConfig.degradations) {
    log.warn(`[configuration-degradation] ${degradation.message}`);
  }

  const store = options.store ?? new MultiremiStore();
  const backgroundJobs = options.backgroundJobs
    ?? envEnabled(process.env.MULTIREMI_BACKGROUND_JOBS);
  const scheduler = backgroundJobs
    ? (options.scheduler === undefined ? new MultiremiScheduler({ store }) : options.scheduler)
    : null;
  const scmPolling = backgroundJobs
    ? (options.scmPolling === undefined
      ? new ScmPollingScheduler({ store: scmIngestionStore(store) })
      : options.scmPolling)
    : null;
  const messagingProviders = options.messagingProviders ?? createMessageProviderRegistry();
  const messaging = backgroundJobs
    ? (options.messaging === undefined
      ? new MessagingScheduler({
        store: store.messaging,
        registry: messagingProviders,
        onSourceFailure: (sourceId, errorCode, failedAt) =>
          void store.messagingOutcomes.alertOnSourceFailure(sourceId, errorCode, failedAt),
      })
      : options.messaging)
    : null;
  const issueTitleScheduler = backgroundJobs
    ? (options.issueTitleScheduler === undefined
      ? new IssueTitleScheduler({ store })
      : options.issueTitleScheduler)
    : null;
  const controlPlaneSshMesh = backgroundJobs
    ? (options.controlPlaneSshMesh === undefined
      ? createControlPlaneSshMeshFromEnv(store)
      : options.controlPlaneSshMesh)
    : null;
  scheduler?.start();
  scmPolling?.start();
  messaging?.start();
  issueTitleScheduler?.start();
  if (backgroundJobs) store.startNotificationDeliverySweeper();
  const realtimeState = options.realtimeState ?? { enabled: true, connections: 0 };
  const authToken = options.authToken ?? process.env.MULTIREMI_TOKEN ?? "";
  const sessionArchives = options.sessionArchives ?? new SessionArchiveService(store);
  if (backgroundJobs) sessionArchives.startIssueArchivePurgeRecovery();
  const app = createMultiremiApp({
    ...options,
    store,
    scheduler,
    realtimeState,
    sessionArchives,
    messagingProviders,
  });
  const port = options.port ?? parseInt(process.env.MULTIREMI_PORT ?? "6120", 10);
  const hostname = options.hostname ?? process.env.MULTIREMI_HOST ?? "0.0.0.0";
  const daemonWebSockets: DaemonWebSocketRegistry = new Map();
  const browserWebSockets: BrowserWebSocketRegistry = new Map();
  const browserUserWebSockets: BrowserUserWebSocketRegistry = new Map();
  const browserScopeWebSockets: BrowserScopeWebSocketRegistry = new Map();
  const unsubscribeTaskEnqueued = store.onTaskEnqueued((task) => {
    notifyDaemonTaskAvailable(daemonWebSockets, store, task);
    notifyBrowserTaskEvent(browserWebSockets, browserScopeWebSockets, "task:queued", task);
  });
  const unsubscribeTaskEvent = store.onTaskEvent((event) => {
    if (event.type === "task:waiting_local_directory") {
      notifyDaemonTaskEvent(daemonWebSockets, event.type, event.task);
    }
    notifyBrowserTaskEvent(browserWebSockets, browserScopeWebSockets, event.type, event.task);
  });
  const unsubscribeTaskMessages = store.onTaskMessages(({ task, messages }) => {
    notifyBrowserTaskMessages(store, browserWebSockets, browserScopeWebSockets, task, messages);
  });
  const unsubscribeWorkspaceEvent = store.onWorkspaceEvent((event) => {
    notifyBrowserWorkspaceEvent(browserWebSockets, browserUserWebSockets, browserScopeWebSockets, event);
  });
  const server = Bun.serve<MultiremiWebSocketData>({
    port,
    hostname,
    idleTimeout: 120,
    async fetch(req, server) {
      const socketAddress = server.requestIP(req)?.address;
      setWebhookClientIpAddress(req, resolveWebhookClientIpAddress(req, socketAddress));
      const url = new URL(req.url);
      if (url.pathname === "/api/daemon/ws") {
        const runtimeIds = parseDaemonWebSocketRuntimeIds(url);
        if (isWebSocketUpgrade(req)) {
          if (runtimeIds.length === 0) {
            return Response.json({ error: "runtime_ids required" }, { status: 400 });
          }
          const authorization = await authorizeDaemonWebSocketRequest(req, store, authToken, runtimeIds);
          if ("response" in authorization) return authorization.response;
          const upgraded = server.upgrade(req, {
            data: {
              connectedAt: new Date().toISOString(),
              kind: "daemon",
              runtimeId: runtimeIds[0] ?? null,
              runtimeIds,
              accessToken: authorization.accessToken,
              canReportAgentPluginProtocol:
                authorization.canReportAgentPluginProtocol,
            },
          });
          if (upgraded) return undefined;
        }
        return app.fetch(req);
      }
      if (url.pathname === "/ws" || url.pathname === "/api/realtime/ws") {
        if (isWebSocketUpgrade(req)) {
          const workspaceId = resolveBrowserWebSocketWorkspaceId(store, url);
          if ("response" in workspaceId) return workspaceId.response;
          const authorization = await authorizeBrowserWebSocketUpgrade(req, store, authToken, workspaceId.workspaceId);
          if ("response" in authorization) return authorization.response;
          const upgraded = server.upgrade(req, {
            data: {
              connectedAt: new Date().toISOString(),
              kind: "browser",
              workspaceId: workspaceId.workspaceId,
              authenticated: authorization.authenticated,
              userId: authorization.userId,
              accessToken: authorization.accessToken,
              scopeSubscriptions: [],
            },
          });
          if (upgraded) return undefined;
        }
        return app.fetch(req);
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        realtimeState.connections += 1;
        if (ws.data.kind === "daemon") {
          registerDaemonWebSocketClient(daemonWebSockets, ws);
          ws.sendText(JSON.stringify({
            type: "ready",
            transport: "websocket",
            runtime_id: ws.data.runtimeId,
            runtime_ids: ws.data.runtimeIds,
            connected_at: ws.data.connectedAt,
          }));
          return;
        }
        if (ws.data.authenticated) {
          registerBrowserWebSocketClient(browserWebSockets, ws);
          registerBrowserUserWebSocketClient(browserUserWebSockets, ws);
          ws.sendText(JSON.stringify({ type: "auth_ack" }));
        }
      },
      async message(ws, message) {
        if (ws.data.kind === "browser") {
          const event = parseDaemonWebSocketMessage(message);
          if (!ws.data.authenticated) {
            const authorization = await authorizeBrowserWebSocketAuthFrame(event, store, authToken, ws.data.workspaceId);
            if ("error" in authorization) {
              ws.sendText(JSON.stringify({ error: authorization.error }));
              ws.close();
              return;
            }
            ws.data.authenticated = true;
            ws.data.userId = authorization.userId;
            ws.data.accessToken = authorization.accessToken;
            registerBrowserWebSocketClient(browserWebSockets, ws);
            registerBrowserUserWebSocketClient(browserUserWebSockets, ws);
            ws.sendText(JSON.stringify({ type: "auth_ack" }));
            return;
          }
          if (event.type === "subscribe") {
            handleBrowserScopeSubscribe(browserScopeWebSockets, store, ws, event);
            return;
          }
          if (event.type === "unsubscribe") {
            handleBrowserScopeUnsubscribe(browserScopeWebSockets, ws, event);
            return;
          }
          if (event.type === "ping") ws.sendText(JSON.stringify({ type: "pong" }));
          return;
        }
        if (!isDaemonOwnerWorkspaceMember(store, ws.data.accessToken)) {
          ws.sendText(JSON.stringify({
            type: "error",
            error: "daemon owner is no longer a workspace member",
            code: "daemon_owner_membership_required",
          }));
          ws.close();
          return;
        }
        const event = parseDaemonWebSocketMessage(message);
        if (event.type === "daemon:heartbeat") {
          const heartbeat = parseDaemonWebSocketHeartbeat(event);
          if (!heartbeat.runtimeId) return;
          if (!ws.data.runtimeIds.includes(heartbeat.runtimeId)) return;
          if (
            (heartbeat.agentPluginProtocol !== undefined || heartbeat.sshMeshProtocol !== undefined) &&
            !ws.data.canReportAgentPluginProtocol
          ) {
            ws.sendText(JSON.stringify({
              type: "error",
              error: "daemon token required",
              code: "daemon_token_required",
            }));
            return;
          }
          ws.data.runtimeId = heartbeat.runtimeId;
          const ack = store.heartbeatRuntime(heartbeat.runtimeId, {
            supportsBatchImport: heartbeat.supportsBatchImport,
            supportsDirectoryScan: heartbeat.supportsDirectoryScan,
            agentPluginProtocol: heartbeat.agentPluginProtocol,
          });
          if (heartbeat.sshMeshProtocol !== undefined) {
            const meshAck = store.recordSshMeshHeartbeat(
              heartbeat.runtimeId,
              heartbeat.sshMeshProtocol,
              heartbeat.sshMeshStatus,
            );
            if (meshAck) ack.ssh_mesh = meshAck;
          } else {
            store.recordSshMeshHeartbeat(heartbeat.runtimeId, 0);
          }
          ws.sendText(JSON.stringify({
            type: "daemon:heartbeat_ack",
            payload: ack,
          }));
          return;
        }
        if (event.runtime_id) {
          ws.data.runtimeId = String(event.runtime_id);
        }
        ws.sendText(JSON.stringify({
          type: event.type === "ping" ? "pong" : "ack",
          received_type: event.type ?? null,
          runtime_id: ws.data.runtimeId,
          ok: true,
          ts: new Date().toISOString(),
        }));
      },
      close(ws) {
        realtimeState.connections = Math.max(0, realtimeState.connections - 1);
        if (ws.data.kind === "daemon") unregisterDaemonWebSocketClient(daemonWebSockets, ws);
        else {
          unregisterBrowserWebSocketClient(browserWebSockets, ws);
          unregisterBrowserUserWebSocketClient(browserUserWebSockets, ws);
          unregisterBrowserScopeWebSocketClient(browserScopeWebSockets, ws);
        }
      },
    },
  });
  const stopServer = server.stop.bind(server);
  controlPlaneSshMesh?.start();
  server.stop = (closeActiveConnections?: boolean) => {
    if (backgroundJobs) sessionArchives.stopIssueArchivePurgeRecovery();
    controlPlaneSshMesh?.stop();
    unsubscribeTaskEnqueued();
    unsubscribeTaskEvent();
    unsubscribeTaskMessages();
    unsubscribeWorkspaceEvent();
    scheduler?.stop();
    scmPolling?.stop();
    messaging?.stop();
    issueTitleScheduler?.stop();
    store.stopNotificationDeliverySweeper();
    return stopServer(closeActiveConnections);
  };
  return server;
}

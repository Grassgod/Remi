import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import { AgentTemplateError } from "./agent-templates.js";
import { MultiremiScheduler } from "@multiremi/scheduler.js";
import { SkillImportError } from "@daemon/agent-runtime/skills/skill-import.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import { AgentPluginStoreError } from "@multiremi/store/repos/agent-plugins-repo.js";
// Domain routers, listed in the order createMultiremiApp registers them.
import { registerAuthRoutes } from "./routers/auth.js";
import { registerGithubRoutes } from "./routers/github.js";
import { registerWebhookRoutes } from "./routers/webhooks.js";
import { registerRemiReleaseRoutes } from "./routers/remi-releases.js";
import { registerDaemonRoutes } from "./routers/daemon.js";
import { registerCloudRuntimeRoutes } from "./routers/cloud-runtime.js";
import { registerCloudBillingRoutes } from "./routers/cloud-billing.js";
import { registerMeRoutes } from "./routers/me.js";
import { registerWorkspaceRoutes } from "./routers/workspaces.js";
import { registerMemberRoutes } from "./routers/members.js";
import { registerInvitationRoutes } from "./routers/invitations.js";
import { registerAgentRoutes } from "./routers/agents.js";
import { registerAgentPluginRoutes } from "./routers/agent-plugins.js";
import { registerAgentTemplateRoutes } from "./routers/agent-templates.js";
import { registerSkillRoutes } from "./routers/skills.js";
import { registerTokenRoutes } from "./routers/tokens.js";
import { registerNotificationPreferenceRoutes } from "./routers/notification-preferences.js";
import { registerRuntimeRoutes } from "./routers/runtimes.js";
import { registerDashboardRoutes } from "./routers/dashboard.js";
import { registerProjectRoutes } from "./routers/projects.js";
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
import type { RouterDeps } from "./routers/deps.js";
import {
  inspectGitRemoteRepository,
  type GitRemoteInspector,
} from "./helpers/repositories.js";
import type {
  CreateFeedbackInput,
} from "@multiremi/contracts/types.js";
import {
  resolveAgentPluginGitSource,
  type AgentPluginGitSourceResolver,
} from "@multiremi/agent-plugins/git-import.js";
import {
  AUTH_COOKIE_NAME,
  DEFAULT_WEBHOOK_IP_RATE_LIMIT,
  DEFAULT_WEBHOOK_RATE_LIMIT,
  MultiremiApiError,
  buildRequestAuth,
  createFeedbackOrApiError,
  createWebhookRateLimiter,
  denyCurrentUserWorkspaceAccess,
  denyDaemonTokenAutopilotRunWorkspace,
  denyDaemonTokenChatSessionWorkspace,
  denyDaemonTokenIssueWorkspace,
  denyDaemonTokenRuntimeWorkspace,
  denyDaemonTokenTaskWorkspace,
  isDaemonGcCheckRequest,
  isDaemonTokenAllowedRequest,
  isTaskTokenForbiddenRequest,
  log,
  readJson,
  verifyJwtToken,
  withFeedbackRequestMetadata,
} from "./helpers.js";
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

export interface MultiremiApiOptions {
  store?: MultiremiStore;
  scheduler?: MultiremiScheduler | null;
  authToken?: string | null;
  shareSecret?: string | null;
  hostname?: string;
  realtimeState?: MultiremiRealtimeState;
  webhookRateLimit?: Partial<WebhookRateLimitConfig> | false;
  webhookIpRateLimit?: Partial<WebhookRateLimitConfig> | false;
  inspectGitRemoteRepository?: GitRemoteInspector;
  resolveAgentPluginGitSource?: AgentPluginGitSourceResolver;
}

export function createMultiremiApp(options: MultiremiApiOptions = {}): Hono {
  const store = options.store ?? new MultiremiStore();
  const scheduler = options.scheduler ?? null;
  const authToken = options.authToken ?? process.env.MULTIREMI_TOKEN ?? "";
  const shareSecret = options.shareSecret?.trim()
    || process.env.MULTIREMI_SHARE_SECRET?.trim()
    || authToken
    || crypto.randomUUID();
  const realtimeState = options.realtimeState ?? { enabled: true, connections: 0 };
  const webhookRateLimiter = createWebhookRateLimiter(options.webhookRateLimit, DEFAULT_WEBHOOK_RATE_LIMIT);
  const webhookIpRateLimiter = createWebhookRateLimiter(options.webhookIpRateLimit, DEFAULT_WEBHOOK_IP_RATE_LIMIT);
  const app = new Hono();
  // What the route handlers used to close over; domain routers take it explicitly.
  const deps: RouterDeps = {
    store,
    scheduler,
    authToken,
    shareSecret,
    webhookRateLimiter,
    webhookIpRateLimiter,
    inspectGitRemoteRepository:
      options.inspectGitRemoteRepository ?? inspectGitRemoteRepository,
    resolveAgentPluginGitSource:
      options.resolveAgentPluginGitSource ?? resolveAgentPluginGitSource,
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
      if (
        path === "/" ||
        path === "/favicon.ico" ||
        path === "/api/config" ||
        path === "/readyz" ||
        path.startsWith("/auth/") ||
        path.startsWith("/health") ||
        path.startsWith("/api/remi/releases/") ||
        path.startsWith("/api/webhooks/")
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
      if (accessToken.type === "task" && isTaskTokenForbiddenRequest(c.req.raw)) {
        return c.json({ error: "forbidden for task token" }, 403);
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
        if (accessToken.type === "task" && isTaskTokenForbiddenRequest(c.req.raw)) {
          return c.json({ error: "forbidden for task token" }, 403);
        }
        c.set("multiremiAuth", buildRequestAuth(accessToken, null));
      }
      await next();
    });
  }

  app.onError((err, c) => {
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
  registerAuthRoutes(app, deps);
  app.get("/health/realtime", (c) => c.json({
    connections: realtimeState.connections,
    enabled: realtimeState.enabled,
    transport: "websocket",
  }));
  registerGithubRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  app.get("/api/multiremi/health", (c) => c.json({ ok: true }));
  registerRemiReleaseRoutes(app, deps);
  // The `/api/daemon/*` prefix guards stay in the skeleton and MUST stay above
  // registerDaemonRoutes: Hono only wraps handlers registered after a
  // middleware, so moving them below would silently drop the workspace checks.
  app.use("/api/daemon/runtimes/:runtimeId/*", async (c, next) => {
    const denied = denyDaemonTokenRuntimeWorkspace(c, store, c.req.param("runtimeId"), {
      hideForbiddenAsNotFound: isDaemonGcCheckRequest(c),
    });
    if (denied) return denied;
    await next();
  });
  app.use("/api/daemon/tasks/:taskId/*", async (c, next) => {
    const denied = denyDaemonTokenTaskWorkspace(c, store, c.req.param("taskId"), {
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

  registerDashboardRoutes(app, deps);

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
  const store = options.store ?? new MultiremiStore();
  const scheduler = options.scheduler === undefined ? new MultiremiScheduler({ store }) : options.scheduler;
  scheduler?.start();
  const realtimeState = options.realtimeState ?? { enabled: true, connections: 0 };
  const authToken = options.authToken ?? process.env.MULTIREMI_TOKEN ?? "";
  const app = createMultiremiApp({ ...options, store, scheduler, realtimeState });
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
    async fetch(req, server) {
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
        const event = parseDaemonWebSocketMessage(message);
        if (event.type === "daemon:heartbeat") {
          const heartbeat = parseDaemonWebSocketHeartbeat(event);
          if (!heartbeat.runtimeId) return;
          if (!ws.data.runtimeIds.includes(heartbeat.runtimeId)) return;
          ws.data.runtimeId = heartbeat.runtimeId;
          const ack = store.heartbeatRuntime(heartbeat.runtimeId, {
            supportsBatchImport: heartbeat.supportsBatchImport,
            supportsDirectoryScan: heartbeat.supportsDirectoryScan,
          });
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
  server.stop = (closeActiveConnections?: boolean) => {
    unsubscribeTaskEnqueued();
    unsubscribeTaskEvent();
    unsubscribeTaskMessages();
    unsubscribeWorkspaceEvent();
    scheduler?.stop();
    return stopServer(closeActiveConnections);
  };
  return server;
}

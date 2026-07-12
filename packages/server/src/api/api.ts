import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createLogger } from "@shared/logger.js";
import { AgentTemplateError, createAgentFromTemplate, getAgentTemplate, listAgentTemplates } from "./agent-templates.js";
import { MultiremiScheduler } from "@multiremi/scheduler.js";
import { buildImportedSkillInput, SkillImportError } from "@daemon/agent-runtime/skills/skill-import.js";
import { daemonRuntimeId, MultiremiStore } from "@multiremi/store/store.js";
import {
  agentSkillCompatibilitySummary,
  skillCompatibilityResponse,
  skillFileCompatibilityResponse,
  skillSummaryCompatibilityResponse,
  skillWithFilesCompatibilityResponse,
} from "./serializers/skills.js";
import type {
  AddSquadMemberInput,
  AssignIssueInput,
  CreateAccessTokenInput,
  CreateAttachmentInput,
  CreateAgentInput,
  CreateAutopilotInput,
  CreateAutopilotTriggerInput,
  CreateCloudRuntimeNodeInput,
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
  CreateRuntimeDirectoryScanInput,
  CreateRuntimeLocalSkillImportInput,
  CreateSkillInput,
  CreateSquadInput,
  CreateTaskInput,
  CreateWorkspaceInput,
  CreateWorkspaceMemberInput,
  ImportSkillInput,
  ListIssueCommentsInput,
  ListIssuesInput,
  QuickCreateIssueInput,
  RegisterRuntimeInput,
  ReportRuntimeDirectoryScanInput,
  ReportRuntimeLocalSkillImportInput,
  ReportRuntimeLocalSkillListInput,
  ReportRuntimeModelListInput,
  ReportRuntimeUpdateInput,
  ReorderPinnedItemInput,
  RemoveSquadMemberInput,
  RunAutopilotInput,
  SendChatMessageInput,
  CreateMultiremiReactionInput,
  MultiremiAccessToken,
  MultiremiAgent,
  MultiremiAttachment,
  MultiremiAutopilot,
  MultiremiAutopilotRun,
  MultiremiAutopilotTrigger,
  MultiremiNotificationPreferences,
  MultiremiGitHubPullRequest,
  MultiremiChatMessage,
  MultiremiChatSession,
  MultiremiCommentReaction,
  MultiremiDaemonHeartbeatAck,
  MultiremiInboxItem,
  MultiremiIssue,
  MultiremiIssueComment,
  MultiremiIssueDependency,
  MultiremiIssueReaction,
  MultiremiIssueSearchResult,
  MultiremiIssueSubscriber,
  MultiremiLabel,
  MultiremiProject,
  MultiremiProjectResource,
  MultiremiProjectSearchResult,
  MultiremiPinnedItem,
  MultiremiSquad,
  MultiremiSquadMember,
  MultiremiTask,
  MultiremiTaskMessage,
  MultiremiTaskStatus,
  MultiremiTaskWithAgent,
  MultiremiTaskTriggerMetadata,
  TaskUsageEntry,
  MultiremiRuntime,
  MultiremiRuntimeDirectoryCandidate,
  MultiremiRuntimeDirectoryScanRequest,
  MultiremiRuntimeLocalSkillImportRequest,
  MultiremiRuntimeLocalSkillListRequest,
  MultiremiRuntimeLocalSkillSummary,
  MultiremiRuntimeModel,
  MultiremiRuntimeModelListRequest,
  MultiremiRuntimeUpdateRequest,
  MultiremiSkill,
  MultiremiSkillFile,
  MultiremiSubscriptionReason,
  MultiremiGitHubPullRequestState,
  MultiremiTimelineEntry,
  MultiremiWorkspaceMember,
  MultiremiWebhookDeliveryResult,
  MultiremiWebhookProvider,
  MultiremiWebhookSignatureStatus,
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
  UpdateProjectResourceInput,
  UpdateRuntimeInput,
  UpdateSkillInput,
  UpdateSquadInput,
  UpdateWorkspaceMemberInput,
} from "@multiremi/contracts/types.js";

// Request-scoped authentication identity, resolved ONCE by the auth middleware
// (see createMultiremiApp) and read by every gating helper via currentAuth(c).
// Workspace + role are intentionally NOT part of this object: each route addresses
// its own workspace (header/query/body/param/resource), so they remain per-resource
// helpers (currentWorkspaceRole(c, store, workspaceId)) that read this identity.
interface MultiremiRequestAuth {
  /** Verified access token (pat/task/daemon); null for JWT, master-token, or open mode. */
  readonly accessToken: MultiremiAccessToken | null;
  /** Verified JWT subject; null otherwise. */
  readonly jwtUserId: string | null;
  /** Authenticated identity (access-token user or JWT user); null in master-token / open mode. */
  readonly userId: string | null;
  /** Authenticated identity with the synthetic "local" admin fallback. */
  readonly requestUserId: string;
}

// Declare the request-scoped context variables set via c.set()/read via c.get()
// so Hono's typed context accepts these keys.
declare module "hono" {
  interface ContextVariableMap {
    multiremiAuth: MultiremiRequestAuth;
  }
}

// Anonymous identity: no verified token and no JWT. Used for the master token and
// open (auth-disabled) mode, both of which act as the synthetic "local" admin.
const ANON_REQUEST_AUTH: MultiremiRequestAuth = { accessToken: null, jwtUserId: null, userId: null, requestUserId: "local" };

// Resolve the request identity into a single typed object. Mirrors the historical
// currentJwtUserId (cleanString) / currentRequestUserId / authenticatedRequestUserId logic.
function buildRequestAuth(accessToken: MultiremiAccessToken | null, jwtUserId: string | null): MultiremiRequestAuth {
  const cleanJwt = cleanString(jwtUserId);
  const userId = accessToken?.userId ?? cleanJwt ?? null;
  return { accessToken, jwtUserId: cleanJwt, userId, requestUserId: userId ?? "local" };
}

const log = createLogger("multiremi-api");
let authDisabledWarningEmitted = false;
const SUBSCRIPTION_REASONS: MultiremiSubscriptionReason[] = ["created", "assigned", "commented", "mentioned", "manual"];
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;
const LOCAL_AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_JWT_SECRET = "multiremi-dev-secret-change-in-production";
const MULTIREMI_RELEASE_REPO = process.env.MULTIREMI_RELEASE_REPO ?? "Grassgod/remi";
const MULTIREMI_INSTALL_SCRIPT = "install-remi.sh";

// Self-host release mirror. Intranet machines that can't reach GitHub's asset
// CDN install via MULTIREMI_BASE_URL=<this server>; install-remi.sh then pulls
// the version + tarball from /api/remi/releases/* below. Tarballs come from
// MULTIREMI_RELEASE_DIR (default <repo>/dist), scripts from <repo>/scripts.
const MULTIREMI_REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const MULTIREMI_RELEASE_TARBALL_RE = /^(?:multiremi|remi)-(\d+\.\d+\.\d+)-(?:linux|darwin)-(?:x64|arm64)\.tar\.gz$/;
function multiremiReleaseDir(): string {
  return process.env.MULTIREMI_RELEASE_DIR ?? join(MULTIREMI_REPO_ROOT, "dist");
}
function multiremiScriptsDir(): string {
  return process.env.MULTIREMI_SCRIPTS_DIR ?? join(MULTIREMI_REPO_ROOT, "scripts");
}
function compareMultiremiVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}
function latestMirrorReleaseVersion(): string | null {
  let entries: string[];
  try {
    entries = readdirSync(multiremiReleaseDir());
  } catch {
    return null;
  }
  const versions = entries
    .map((f) => f.match(MULTIREMI_RELEASE_TARBALL_RE)?.[1])
    .filter((v): v is string => Boolean(v));
  if (versions.length === 0) return null;
  return versions.sort(compareMultiremiVersions)[versions.length - 1];
}
function resolveMirrorReleaseFile(filename: string | undefined): string | null {
  if (!filename || filename.includes("/") || filename.includes("..") || filename.includes("\\")) return null;
  if (/^(multiremi|remi)-v?\d[\w.\-]*\.tar\.gz$/.test(filename)) {
    const p = join(multiremiReleaseDir(), filename);
    return existsSync(p) ? p : null;
  }
  if (/^install[\w.\-]*\.sh$/.test(filename)) {
    const p = join(multiremiScriptsDir(), filename);
    return existsSync(p) ? p : null;
  }
  return null;
}
const MULTIREMI_DAEMON_PROVIDERS = new Set(["claude", "codex"]);
const MAX_AGENT_DESCRIPTION_LENGTH = 255;
const PROVIDER_THINKING_LEVELS: Record<string, Set<string>> = {
  claude: new Set(["low", "medium", "high", "xhigh", "max"]),
  codex: new Set(["none", "minimal", "low", "medium", "high", "xhigh"]),
};
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const DEFAULT_WEBHOOK_RATE_LIMIT: WebhookRateLimitConfig = { limit: 60, windowMs: 60 * 1000 };
const DEFAULT_WEBHOOK_IP_RATE_LIMIT: WebhookRateLimitConfig = { limit: 30, windowMs: 60 * 1000 };
const localAuthCodes = new Map<string, { code: string; expiresAt: number }>();

// Email verification-code + Google fallback logins let anyone in with just an
// email; production keeps only Feishu SSO. Off unless explicitly enabled (FR9).
function isEmailCodeLoginEnabled(): boolean {
  const value = (process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
const JWT_HMAC_ALGORITHMS: Record<string, string> = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
};

type NormalizedGitHubPullRequestBody = {
  workspaceId: string | null;
  issueId: string | null;
  repoOwner: string;
  repoName: string;
  number: number;
  title: string;
  state?: MultiremiGitHubPullRequestState | string;
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
  daemon_id?: string;
  legacy_daemon_ids?: string[];
  device_name?: string;
  cli_version?: string;
  launched_by?: string;
  runtimes?: Array<{
    name?: string;
    type?: string;
    version?: string;
    status?: string;
    maxConcurrency?: number;
    acpVersion?: string | null;
    agentVersion?: string | null;
  }>;
};

class MultiremiApiError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 429) {
    super(message);
  }
}

export interface MultiremiApiOptions {
  store?: MultiremiStore;
  scheduler?: MultiremiScheduler | null;
  authToken?: string | null;
  hostname?: string;
  realtimeState?: MultiremiRealtimeState;
  webhookRateLimit?: Partial<WebhookRateLimitConfig> | false;
  webhookIpRateLimit?: Partial<WebhookRateLimitConfig> | false;
}

interface WebhookRateLimitConfig {
  limit: number;
  windowMs: number;
}

interface MultiremiRealtimeState {
  enabled: boolean;
  connections: number;
}

type DaemonWebSocketData = {
  kind: "daemon";
  connectedAt: string;
  runtimeId: string | null;
  runtimeIds: string[];
  accessToken: MultiremiAccessToken | null;
}

type BrowserWebSocketData = {
  kind: "browser";
  connectedAt: string;
  workspaceId: string;
  authenticated: boolean;
  userId: string | null;
  accessToken: MultiremiAccessToken | null;
  scopeSubscriptions: string[];
}

type MultiremiWebSocketData = DaemonWebSocketData | BrowserWebSocketData;

type MultiremiWebSocketClient = {
  data: MultiremiWebSocketData;
  sendText(message: string): void;
  close(code?: number, reason?: string): void;
}

type DaemonWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;
type BrowserWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;
type BrowserUserWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;
type BrowserScopeWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;

export function createMultiremiApp(options: MultiremiApiOptions = {}): Hono {
  const store = options.store ?? new MultiremiStore();
  const scheduler = options.scheduler ?? null;
  const authToken = options.authToken ?? process.env.MULTIREMI_TOKEN ?? "";
  const realtimeState = options.realtimeState ?? { enabled: true, connections: 0 };
  const webhookRateLimiter = createWebhookRateLimiter(options.webhookRateLimit, DEFAULT_WEBHOOK_RATE_LIMIT);
  const webhookIpRateLimiter = createWebhookRateLimiter(options.webhookIpRateLimit, DEFAULT_WEBHOOK_IP_RATE_LIMIT);
  const app = new Hono();

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
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
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
  } else if (!authDisabledWarningEmitted) {
    authDisabledWarningEmitted = true;
    log.warn(
      "dashboard auth is DISABLED (MULTIREMI_TOKEN is unset): all requests are unauthenticated and act as the local admin with full access",
    );
  }

  app.onError((err, c) => {
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
  app.post("/api/cli-token", async (c) => {
    const token = await store.createAccessToken({
      workspaceId: "local",
      name: "CLI token",
      type: "pat",
    });
    return c.json({ token: token.token });
  });
  app.post("/auth/logout", (c) => c.json({ message: "logged out" }));
  app.post("/auth/send-code", async (c) => {
    if (!isEmailCodeLoginEnabled()) return c.json({ error: "email code login is disabled" }, 403);
    const result = sendLocalAuthCode(store, await readJson(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.post("/auth/verify-code", async (c) => {
    if (!isEmailCodeLoginEnabled()) return c.json({ error: "email code login is disabled" }, 403);
    const result = await verifyLocalAuthCode(store, await readJson(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.post("/auth/google", async (c) => {
    if (!isEmailCodeLoginEnabled()) return c.json({ error: "email login is disabled" }, 403);
    const result = await localGoogleAuthFallback(store, await readJson(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.get("/auth/lark/url", (c) => {
    const cfg = loadLarkSsoConfig();
    if (!cfg) return c.json({ error: "Feishu SSO is not configured" }, 503);
    const redirectUri = c.req.query("redirect_uri");
    if (!redirectUri) return c.json({ error: "redirect_uri is required" }, 400);
    const state = c.req.query("state") ?? "login";
    return c.json({ url: buildLarkAuthorizeUrl(cfg, redirectUri, state) });
  });
  app.post("/auth/lark/callback", async (c) => {
    const cfg = loadLarkSsoConfig();
    if (!cfg) return c.json({ error: "Feishu SSO is not configured" }, 503);
    const body = await readJson<{ code?: string; redirect_uri?: string }>(c);
    const code = String(body.code ?? "").trim();
    const redirectUri = String(body.redirect_uri ?? "").trim();
    if (!code) return c.json({ error: "code is required" }, 400);
    if (!redirectUri) return c.json({ error: "redirect_uri is required" }, 400);
    try {
      const userAccessToken = await larkExchangeCode(cfg, code, redirectUri);
      const profile = await larkFetchUserInfo(cfg, userAccessToken);
      // open_id is the stable per-user identity; Feishu often returns no email,
      // so synthesize one from open_id purely for display/uniqueness.
      const email = profile.email ?? `${profile.openId ?? "feishu-user"}@feishu.local`;
      return c.json(await localAuthResponse(store, { externalId: profile.openId, email, name: profile.name }));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Feishu login failed" }, 401);
    }
  });
  app.get("/health/realtime", (c) => c.json({
    connections: realtimeState.connections,
    enabled: realtimeState.enabled,
    transport: "websocket",
  }));
  app.get("/api/github/setup", (c) => c.json(githubSetupResponse(c.req.query("installation_id"), c.req.query("state"))));
  app.post("/api/webhooks/github", async (c) => c.json(handleGitHubWebhook(store, await readJson(c)), 202));
  app.post("/api/webhooks/autopilots/:token", async (c) => {
    if (!webhookIpRateLimiter.allow(webhookClientIpKey(c.req.raw))) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    const trigger = store.getAutopilotTriggerByWebhookToken(c.req.param("token"));
    if (!trigger) return c.json({ error: "webhook not found" }, 404);
    if (!webhookRateLimiter.allow(c.req.param("token"))) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    const parsedBody = await readPublicWebhookBody(c);
    if ("apiError" in parsedBody) return c.json({ error: parsedBody.apiError }, parsedBody.statusCode);
    const { rawBody, body } = parsedBody;
    const headers = headersToRecord(c.req.raw.headers);
    const provider = trigger.provider ?? "generic";
    const signatureStatus = webhookSignatureStatus(provider, headers, rawBody, store.getAutopilotTriggerSigningSecret(trigger.id));
    const bodyObject = isObjectRecord(body) ? body as RunAutopilotInput & { payload?: unknown } : {};
    const result = store.handleAutopilotWebhookByToken(trigger.webhookToken ?? c.req.param("token"), {
      prompt: bodyObject.prompt ?? null,
      payload: Object.prototype.hasOwnProperty.call(bodyObject, "payload") ? bodyObject.payload : body,
      rawBody,
      headers,
      provider,
      signatureStatus,
    });
    if (!result) return c.json({ error: "webhook not found" }, 404);
    const response = publicWebhookDeliveryResponse(result);
    return c.json(response.body, response.statusCode);
  });
  app.get("/api/multiremi/health", (c) => c.json({ ok: true }));
  // Self-host release mirror (install-remi.sh reads these when MULTIREMI_BASE_URL is set).
  app.get("/api/remi/releases/latest/version", (c) => {
    const version = latestMirrorReleaseVersion();
    if (!version) return c.json({ error: "no releases available on this server" }, 404);
    return c.text(version);
  });
  app.get("/api/remi/releases/latest/:filename", (c) => {
    const file = resolveMirrorReleaseFile(c.req.param("filename"));
    if (!file) return c.json({ error: "not found" }, 404);
    return new Response(Bun.file(file));
  });
  app.get("/api/remi/releases/download/:tag/:filename", (c) => {
    const file = resolveMirrorReleaseFile(c.req.param("filename"));
    if (!file) return c.json({ error: "not found" }, 404);
    return new Response(Bun.file(file));
  });
  app.get("/api/multiremi/install/daemon", (c) => {
    return c.json(buildDaemonInstallInstructions({
      requestUrl: c.req.url,
      serverUrl: c.req.query("serverUrl") ?? c.req.query("server_url"),
      workspaceId: c.req.query("workspaceId") ?? c.req.query("workspace_id"),
      token: c.req.query("token"),
      provider: c.req.query("provider"),
      version: c.req.query("version"),
    }));
  });
  app.post("/api/multiremi/install/daemon", async (c) => {
    const body = await readJson<{
      serverUrl?: string;
      server_url?: string;
      workspaceId?: string;
      workspace_id?: string;
      token?: string;
      provider?: string;
      version?: string;
      tokenName?: string;
      token_name?: string;
      expiresInDays?: number | null;
      expires_in_days?: number | null;
      createToken?: boolean;
      create_token?: boolean;
      daemonId?: string | null;
      daemon_id?: string | null;
    }>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    let token = body.token ?? c.req.query("token");
    let tokenId: string | null = null;
    const shouldCreateToken = (body.createToken ?? body.create_token ?? true) !== false;
    if (!token && shouldCreateToken) {
      const created = await store.createAccessToken({
        workspaceId,
        // Own the daemon token by the user provisioning it, so runtimes it later
        // registers are attributed to that person (FR6/FR8).
        userId: currentRequestUserId(c),
        daemonId: body.daemonId ?? body.daemon_id ?? c.req.query("daemonId") ?? c.req.query("daemon_id") ?? null,
        name: body.tokenName ?? body.token_name ?? "Multiremi daemon",
        type: "daemon",
        expiresInDays: body.expiresInDays ?? body.expires_in_days ?? 90,
      });
      token = created.token;
      tokenId = created.id;
    }
    const instructions = buildDaemonInstallInstructions({
      requestUrl: c.req.url,
      serverUrl: body.serverUrl ?? body.server_url ?? c.req.query("serverUrl") ?? c.req.query("server_url"),
      workspaceId,
      token,
      tokenId,
      provider: body.provider ?? c.req.query("provider"),
      version: body.version ?? c.req.query("version"),
    });
    return tokenId ? c.json(instructions, 201) : c.json(instructions);
  });
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
  app.post("/api/daemon/register", async (c) => {
    const body = await readJsonStrict<DaemonRegisterRequestBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const denied = denyDaemonTokenWorkspace(c, body.workspace_id);
    if (denied) return denied;
    const owner = daemonRegisterOwnerContext(c, store, body.workspace_id);
    if ("error" in owner) return c.json({ error: owner.error }, owner.status);
    const result = registerDaemonRuntimes(store, body, owner);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.post("/api/daemon/deregister", async (c) => {
    const body = await readJsonStrict<{ runtime_ids?: string[] }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const runtimeIds = normalizeRuntimeIds(body.runtime_ids);
    if ("error" in runtimeIds) return c.json({ error: runtimeIds.error }, runtimeIds.status);
    deregisterDaemonRuntimes(c, store, runtimeIds.runtimeIds);
    return c.json({ status: "ok" });
  });
  app.post("/api/daemon/heartbeat", async (c) => {
    const body = await readJsonStrict<{ runtime_id?: string; supports_batch_import?: boolean; supports_directory_scan?: boolean }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const runtimeId = body.runtime_id ?? "";
    if (!runtimeId) return c.json({ error: "runtime_id is required" }, 400);
    const denied = denyDaemonTokenRuntimeWorkspace(c, store, runtimeId);
    if (denied) return denied;
    const ack = store.heartbeatRuntime(runtimeId, {
      supportsBatchImport: body.supports_batch_import ?? false,
      supportsDirectoryScan: body.supports_directory_scan ?? false,
    });
    if (ack.status === "runtime_gone") return c.json({ error: "runtime not found" }, 404);
    return c.json(daemonHeartbeatHttpResponse(ack));
  });
  app.get("/api/daemon/workspaces/:workspaceId/repos", (c) => {
    const denied = denyDaemonTokenWorkspace(c, c.req.param("workspaceId"));
    if (denied) return denied;
    const response = workspaceReposResponse(store, c.req.param("workspaceId"));
    if (!response) return c.json({ error: "workspace not found" }, 404);
    return c.json(response);
  });
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
  app.get("/api/cloud-runtime", (c) => c.json({ configured: true, mode: "local" }));
  app.get("/api/cloud-runtime/healthz", (c) => c.json({ ok: true, configured: true, mode: "local" }));
  app.get("/api/cloud-runtime/readyz", (c) => c.json({ ok: true, configured: true, mode: "local" }));
  app.get("/api/cloud-runtime/nodes", (c) => c.json(store.listCloudRuntimeNodes({
    limit: parseOptionalInt(c.req.query("limit")),
    offset: parseOptionalInt(c.req.query("offset")),
  })));
  app.post("/api/cloud-runtime/nodes", async (c) => {
    const body = await readJson<CreateCloudRuntimeNodeInput>(c);
    return c.json(store.createCloudRuntimeNode(body), 201);
  });
  app.delete("/api/cloud-runtime/nodes", async (c) => {
    const body = await readJson<{ id?: string; node_id?: string; nodeId?: string }>(c);
    const id = body.id ?? body.node_id ?? body.nodeId ?? "";
    const deleted = id ? store.deleteCloudRuntimeNode(id) : false;
    if (!deleted) return c.json({ error: "cloud runtime node not found" }, 404);
    return c.body(null, 204);
  });
  app.post("/api/cloud-runtime/nodes/start", async (c) => cloudRuntimeStatusResponse(c, store, await readJson(c), "running"));
  app.post("/api/cloud-runtime/nodes/stop", async (c) => cloudRuntimeStatusResponse(c, store, await readJson(c), "stopped"));
  app.post("/api/cloud-runtime/nodes/reboot", async (c) => cloudRuntimeStatusResponse(c, store, await readJson(c), "running"));
  app.post("/api/cloud-runtime/nodes/status", async (c) => {
    const body = await readJson<{ id?: string; node_id?: string; nodeId?: string; status?: string }>(c);
    return cloudRuntimeStatusResponse(c, store, body, body.status ?? "running");
  });
  app.post("/api/cloud-runtime/nodes/exec", async (c) => {
    const body = await readJson<{ id?: string; node_id?: string; nodeId?: string; command?: string; cmd?: string }>(c);
    const id = body.id ?? body.node_id ?? body.nodeId ?? "";
    const result = store.execCloudRuntimeNode(id, body.command ?? body.cmd ?? "");
    if (!result) return c.json({ error: "cloud runtime node not found" }, 404);
    return c.json(result);
  });
  app.get("/api/cloud-billing/balance", () => cJsonCloudBillingBalance());
  app.get("/api/cloud-billing/transactions", (c) => c.json(emptyBillingPage(c)));
  app.get("/api/cloud-billing/batches", (c) => c.json(emptyBillingPage(c)));
  app.get("/api/cloud-billing/topups", (c) => c.json(emptyBillingPage(c)));
  app.get("/api/cloud-billing/price-tiers", (c) => c.json([
    {
      id: "local-disabled",
      display_name: "Local Bun Multiremi",
      amount_cents: 0,
      credits: 0,
      bonus_credits: 0,
      disabled: true,
      configured: false,
    },
  ]));
  app.post("/api/cloud-billing/checkout-sessions", async (c) => {
    const body = await readJson<{ tier_id?: string; customer_email?: string }>(c);
    return c.json({
      order_id: `local-${Date.now()}`,
      session_id: "local-disabled",
      url: "",
      tier_id: body.tier_id ?? "local-disabled",
      configured: false,
      disabled: true,
      error: "cloud billing is not configured in local Bun Multiremi",
    }, 201);
  });
  app.get("/api/cloud-billing/checkout-sessions/:sessionId", (c) => c.json({
    order_id: `local-${c.req.param("sessionId")}`,
    status: "disabled",
    amount_cents: 0,
    credits: 0,
    bonus_credits: 0,
    currency: "usd",
    tier_id: "local-disabled",
    configured: false,
  }));
  app.post("/api/cloud-billing/portal-sessions", () => cJsonCloudBillingPortal());
  app.post("/api/webhooks/stripe", (c) => c.json({
    received: true,
    configured: false,
    mode: "local",
  }, 202));
  app.post("/api/contact-sales", async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    return c.json({
      id: `local-contact-${Date.now()}`,
      status: "received",
      mode: "local",
      request: body,
    }, 201);
  });
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
  app.get("/api/workspaces", (c) => {
    const userId = authenticatedRequestUserId(c);
    const all = store.listWorkspaces();
    // Master token / open mode (no identity) is admin and sees everything;
    // a logged-in user sees only the workspaces they are a member of.
    if (!userId) return c.json(all);
    return c.json(all.filter((ws) => store.getUserRoleInWorkspace(userId, ws.id) !== null));
  });
  app.post("/api/workspaces", async (c) => {
    const body = await readJson<any>(c);
    const result = safeCreateWorkspace(store, body, authenticatedRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result, 201);
  });
  app.get("/api/workspaces/:id", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    return c.json(workspace);
  });
  app.put("/api/workspaces/:id", async (c) => {
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJson<Partial<CreateWorkspaceInput>>(c);
    return c.json(store.updateWorkspace(c.req.param("id"), body));
  });
  app.patch("/api/workspaces/:id", async (c) => {
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJson<Partial<CreateWorkspaceInput>>(c);
    return c.json(store.updateWorkspace(c.req.param("id"), body));
  });
  app.delete("/api/workspaces/:id", (c) => {
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const deleted = store.deleteWorkspace(c.req.param("id"));
    if (!deleted) return c.json({ error: "workspace not found" }, 404);
    return c.body(null, 204);
  });
  app.post("/api/workspaces/:id/leave", async (c) => {
    const workspaceId = c.req.param("id");
    const requester = loadCurrentWorkspaceMember(c, store, workspaceId);
    if (requester instanceof Response) return requester;
    const left = safeLeaveWorkspace(store, workspaceId, requester.member.id);
    if ("error" in left) return c.json({ error: left.error }, left.status);
    publishWorkspaceEvent(c, store, "member:removed", workspaceId, memberRemovedPayload(requester.member));
    return c.body(null, 204);
  });
  app.get("/api/workspaces/:id/members", (c) => {
    const workspaceId = c.req.param("id");
    const requester = loadCurrentWorkspaceMember(c, store, workspaceId);
    if (requester instanceof Response) return requester;
    return c.json(store.listWorkspaceMembers(workspaceId).map((member) => workspaceMemberToGoResponse(member, { includeName: true })));
  });
  app.patch("/api/workspaces/:id/members/:memberId", async (c) => {
    const workspaceId = c.req.param("id");
    const requester = loadCurrentWorkspaceRole(c, store, workspaceId, ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    const member = store.getWorkspaceMember(c.req.param("memberId"));
    if (!member || member.workspaceId !== workspaceId) return c.json({ error: "member not found" }, 404);
    const body = await readJson<UpdateWorkspaceMemberInput>(c);
    const role = normalizeGoWorkspaceMemberRole(body.role);
    if ("error" in role) return c.json({ error: role.error }, 400);
    if ((member.role === "owner" || role.role === "owner") && requester.member.role !== "owner") {
      return c.json({ error: "insufficient permissions" }, 403);
    }
    const updated = safeUpdateWorkspaceMember(store, c.req.param("memberId"), { ...body, role: role.role });
    if ("error" in updated) return c.json({ error: updated.error }, updated.status);
    const response = workspaceMemberToGoResponse(updated, { includeUser: true });
    publishWorkspaceEvent(c, store, "member:updated", workspaceId, { member: response });
    return c.json(response);
  });
  app.delete("/api/workspaces/:id/members/:memberId", (c) => {
    const workspaceId = c.req.param("id");
    const requester = loadCurrentWorkspaceRole(c, store, workspaceId, ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    const member = store.getWorkspaceMember(c.req.param("memberId"));
    if (!member || member.workspaceId !== workspaceId) return c.json({ error: "member not found" }, 404);
    if (member.role === "owner" && requester.member.role !== "owner") {
      return c.json({ error: "insufficient permissions" }, 403);
    }
    const archived = safeArchiveWorkspaceMember(store, c.req.param("memberId"));
    if ("error" in archived) return c.json({ error: archived.error }, archived.status);
    publishWorkspaceEvent(c, store, "member:removed", workspaceId, memberRemovedPayload(member));
    return c.body(null, 204);
  });
  app.post("/api/workspaces/:id/members", async (c) => {
    const requester = loadCurrentWorkspaceRole(c, store, c.req.param("id"), ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    const body = await readJson<any>(c);
    const result = safeCreateInvitation(store, c.req.param("id"), body, currentRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    publishWorkspaceEvent(c, store, "invitation:created", c.req.param("id"), {
      invitation: result,
      ...workspaceNamePayload(store, c.req.param("id")),
    });
    return c.json(result, 201);
  });
  app.get("/api/workspaces/:id/invitations", (c) => {
    const requester = loadCurrentWorkspaceMember(c, store, c.req.param("id"));
    if (requester instanceof Response) return requester;
    return c.json(store.listWorkspaceInvitations(c.req.param("id")));
  });
  app.get("/api/workspaces/:id/github/connect", (c) => c.json(githubConnectResponse(c.req.param("id"))));
  app.get("/api/workspaces/:id/github/installations", (c) => c.json({
    installations: [],
    configured: isGitHubAppConfigured(),
    can_manage: true,
  }));
  app.delete("/api/workspaces/:id/github/installations/:installationId", (c) => c.body(null, 204));
  app.get("/api/workspaces/:id/lark/installations", (c) => c.json({
    installations: [],
    configured: false,
    install_supported: false,
    workspace_id: c.req.param("id"),
  }));
  app.post("/api/workspaces/:id/lark/install/begin", (c) => c.json({
    session_id: `local-lark-${Date.now()}`,
    qr_code_url: "",
    expires_in_seconds: 0,
    poll_interval_seconds: 5,
    configured: false,
    status: "error",
    error_reason: "not_configured",
    error_message: "Lark integration is not configured in local Bun Multiremi",
  }, 202));
  app.get("/api/workspaces/:id/lark/install/:sessionId/status", (c) => c.json({
    status: "error",
    error_reason: "not_configured",
    error_message: "Lark integration is not configured in local Bun Multiremi",
    session_id: c.req.param("sessionId"),
  }));
  app.delete("/api/workspaces/:id/lark/installations/:installationId", (c) => c.body(null, 204));
  app.delete("/api/workspaces/:id/invitations/:invitationId", (c) => {
    const requester = loadCurrentWorkspaceRole(c, store, c.req.param("id"), ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    const invitation = store.getInvitation(c.req.param("invitationId"));
    const revoked = store.revokeWorkspaceInvitation(c.req.param("id"), c.req.param("invitationId"));
    if (!revoked) return c.json({ error: "invitation not found" }, 404);
    publishWorkspaceEvent(c, store, "invitation:revoked", c.req.param("id"), {
      invitation_id: c.req.param("invitationId"),
      invitee_email: invitation?.inviteeEmail ?? null,
      invitee_user_id: invitation?.inviteeUserId ?? null,
    });
    return c.body(null, 204);
  });
  app.get("/api/invitations", (c) => c.json(store.listCurrentUserInvitations(currentRequestUserId(c))));
  app.get("/api/invitations/:id", (c) => {
    const invitation = store.getInvitation(c.req.param("id"));
    if (!invitation) return c.json({ error: "invitation not found" }, 404);
    return c.json(invitation);
  });
  app.post("/api/invitations/:id/accept", (c) => {
    const result = safeAcceptInvitation(store, c.req.param("id"), currentRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    const member = acceptedInvitationMemberToGoResponse(store, result);
    if (isMemberResponseError(member)) return c.json({ error: member.error }, member.status);
    publishWorkspaceEvent(c, store, "member:added", result.workspaceId, {
      member,
      ...workspaceNamePayload(store, result.workspaceId),
    });
    publishWorkspaceEvent(c, store, "invitation:accepted", result.workspaceId, {
      invitation_id: result.id,
      member,
    });
    return c.json(member);
  });
  app.post("/api/invitations/:id/decline", (c) => {
    const result = safeDeclineInvitation(store, c.req.param("id"), currentRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    publishWorkspaceEvent(c, store, "invitation:declined", result.workspaceId, {
      invitation_id: result.id,
      invitee_email: result.inviteeEmail,
    });
    return c.body(null, 204);
  });
  app.post("/api/lark/binding/redeem", async (c) => {
    const body = await readJson<{ token?: string }>(c);
    return c.json({
      error: "lark integration is not configured in local Bun Multiremi",
      code: "not_configured",
      token: body.token ?? "",
    }, 409);
  });

  app.get("/api/multiremi/agents", (c) => {
    const workspaceId = requestedAgentWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const agents = store.listAgents().filter((agent) =>
      agent.workspaceId === workspaceId && canCurrentUserAccessAgent(c, store, agent)
    );
    return c.json({ agents });
  });
  app.post("/api/multiremi/agents", async (c) => {
    const body = await readJsonStrict<CreateAgentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentRequestContext(c, store, body);
    if (input instanceof Response) return input;
    const isFirstAgent = isFirstAgentInWorkspace(store, input.workspaceId ?? input.workspace_id ?? "local");
    const agent = store.createAgent(input);
    recordAgentCreatedAnalytics(c, store, agent, runtimeForAgentInput(store, body), {
      template: input.template,
      isFirstAgentInWorkspace: isFirstAgent,
    });
    publishAgentLifecycleEvent(c, store, "agent:created", agent);
    return c.json({ agent }, 201);
  });
  app.post("/api/multiremi/agents/default", async (c) => {
    const body = await readJsonStrict<{ provider?: string; runtimeId?: string | null; runtime_id?: string | null; workspaceId?: string | null; workspace_id?: string | null }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = requestedAgentWorkspaceId(c, body);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const provider = resolveAgentRequestProvider(c, store, workspaceId, body);
    if (provider instanceof Response) return provider;
    const actingUserId = currentRequestUserId(c);
    const before = store.getDefaultAgent(workspaceId, provider, { visibleTo: actingUserId });
    const isFirstAgent = isFirstAgentInWorkspace(store, workspaceId);
    const agent = store.ensureDefaultAgent(provider, {
      workspaceId,
      ownerId: actingUserId,
    });
    if (!before) {
      recordAgentCreatedAnalytics(c, store, agent, runtimeForAgentInput(store, body), {
        template: "default",
        isFirstAgentInWorkspace: isFirstAgent,
      });
      publishAgentLifecycleEvent(c, store, "agent:created", agent);
    }
    return c.json({ agent }, before ? 200 : 201);
  });
  app.get("/api/multiremi/agents/:id", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json({ agent: loaded.agent });
  });
  app.patch("/api/multiremi/agents/:id", async (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateAgentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentUpdateRequestContext(c, store, loaded.agent, body);
    if (input instanceof Response) return input;
    const agent = store.updateAgent(loaded.agent.id, input);
    publishAgentLifecycleEvent(c, store, "agent:status", agent);
    return c.json({ agent });
  });
  app.delete("/api/multiremi/agents/:id", (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const agent = store.archiveAgent(loaded.agent.id);
    publishAgentLifecycleEvent(c, store, "agent:archived", agent);
    return c.json({ agent });
  });
  app.get("/api/multiremi/agents/:id/skills", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const skills = store.listAgentSkills(loaded.agent.id);
    return c.json({ skills, total: skills.length });
  });
  app.get("/api/multiremi/agents/:id/tasks", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const tasks = store.listAgentTasks(loaded.agent.id);
    return c.json({ tasks, total: tasks.length });
  });
  app.put("/api/multiremi/agents/:id/skills", async (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<SetAgentSkillsInput>(c);
    const skills = store.setAgentSkills(loaded.agent.id, body);
    return c.json({ skills, total: skills.length });
  });
  app.get("/api/agents/:id/tasks", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(store.listAgentTasks(loaded.agent.id));
  });
  app.get("/api/agents/:id/skills", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(store.listAgentSkills(loaded.agent.id, { includeFiles: false }).map(skillSummaryCompatibilityResponse));
  });
  app.put("/api/agents/:id/skills", async (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<SetAgentSkillsInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const skills = store.setAgentSkills(loaded.agent.id, body);
      publishAgentSkillsEvent(c, store, loaded.agent, skills);
      return c.json(skills.map(skillSummaryCompatibilityResponse));
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.post("/api/agents/:id/skills/add", async (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<SetAgentSkillsInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const currentSkillIds = store.listAgentSkills(loaded.agent.id, { includeFiles: false })
      .map((skill) => skill.id)
      .filter((id): id is string => Boolean(id));
    const nextSkillIds = Array.from(new Set([...currentSkillIds, ...(body.skillIds ?? body.skill_ids ?? [])]));
    try {
      const skills = store.setAgentSkills(loaded.agent.id, { skillIds: nextSkillIds });
      publishAgentSkillsEvent(c, store, loaded.agent, skills);
      return c.json(skills.map(skillSummaryCompatibilityResponse));
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/agents/:id/env", (c) => {
    const loaded = loadAgentEnvForCurrentAdmin(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { agent } = loaded;
    return c.json(agentEnvResponse(agent.id, agent.customEnv));
  });
  app.put("/api/agents/:id/env", async (c) => {
    const loaded = loadAgentEnvForCurrentAdmin(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { agent } = loaded;
    const body = await readJsonStrict<{ custom_env?: Record<string, string>; customEnv?: Record<string, string>; env?: Record<string, string> }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const nextEnv = mergeAgentEnv(agent.customEnv, body.custom_env ?? body.customEnv ?? body.env ?? {});
    const updated = store.updateAgent(agent.id, { customEnv: nextEnv });
    return c.json(agentEnvResponse(updated.id, updated.customEnv));
  });
  app.get("/api/agents", (c) => {
    const workspaceId = requestedAgentWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listAgents().filter((agent) =>
      agent.workspaceId === workspaceId && canCurrentUserAccessAgent(c, store, agent)
    ).map((agent) => agentCompatibilityResponse(store, agent, c)));
  });
  app.post("/api/agents", async (c) => {
    const body = await readJsonStrict<CreateAgentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentRequestContext(c, store, body);
    if (input instanceof Response) return input;
    const isFirstAgent = isFirstAgentInWorkspace(store, input.workspaceId ?? input.workspace_id ?? "local");
    const agent = store.createAgent(input);
    recordAgentCreatedAnalytics(c, store, agent, runtimeForAgentInput(store, body), {
      template: input.template,
      isFirstAgentInWorkspace: isFirstAgent,
    });
    publishAgentLifecycleEvent(c, store, "agent:created", agent);
    return c.json(agentCompatibilityResponse(store, agent, c), 201);
  });
  app.post("/api/agents/from-template", async (c) => {
    const body = await readJsonStrict<CreateAgentFromTemplateInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentTemplateRequestContext(c, store, body);
    if (input instanceof Response) return input;
    const isFirstAgent = isFirstAgentInWorkspace(store, input.workspaceId ?? input.workspace_id ?? "local");
    const result = await createAgentFromTemplate(store, input);
    recordAgentCreatedAnalytics(c, store, result.agent, runtimeForAgentInput(store, body), {
      template: input.templateSlug ?? input.template_slug,
      isFirstAgentInWorkspace: isFirstAgent,
    });
    publishAgentLifecycleEvent(c, store, "agent:created", result.agent);
    return c.json({
      agent: agentCompatibilityResponse(store, result.agent, c),
      imported_skill_ids: result.imported_skill_ids,
      reused_skill_ids: result.reused_skill_ids,
    }, 201);
  });
  app.get("/api/agents/:id", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(agentCompatibilityResponse(store, loaded.agent, c));
  });
  app.put("/api/agents/:id", async (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateAgentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentUpdateRequestContext(c, store, loaded.agent, body);
    if (input instanceof Response) return input;
    const agent = store.updateAgent(loaded.agent.id, input);
    publishAgentLifecycleEvent(c, store, "agent:status", agent);
    return c.json(agentCompatibilityResponse(store, agent, c));
  });
  app.post("/api/agents/:id/archive", (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const agent = store.archiveAgent(loaded.agent.id);
    publishAgentLifecycleEvent(c, store, "agent:archived", agent);
    return c.json(agentCompatibilityResponse(store, agent, c));
  });
  app.post("/api/agents/:id/restore", (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const agent = store.restoreAgent(loaded.agent.id);
    publishAgentLifecycleEvent(c, store, "agent:restored", agent);
    return c.json(agentCompatibilityResponse(store, agent, c));
  });
  app.post("/api/agents/:id/cancel-tasks", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json({ cancelled: store.cancelAgentTasks(loaded.agent.id) });
  });
  app.post("/api/multiremi/agents/from-template", async (c) => {
    const body = await readJsonStrict<CreateAgentFromTemplateInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentTemplateRequestContext(c, store, body);
    if (input instanceof Response) return input;
    const isFirstAgent = isFirstAgentInWorkspace(store, input.workspaceId ?? input.workspace_id ?? "local");
    const result = await createAgentFromTemplate(store, input);
    recordAgentCreatedAnalytics(c, store, result.agent, runtimeForAgentInput(store, body), {
      template: input.templateSlug ?? input.template_slug,
      isFirstAgentInWorkspace: isFirstAgent,
    });
    publishAgentLifecycleEvent(c, store, "agent:created", result.agent);
    return c.json(result, 201);
  });
  app.get("/api/multiremi/agent-task-snapshot", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const tasks = store.listWorkspaceAgentTaskSnapshot(workspaceId);
    return c.json({ tasks, total: tasks.length });
  });
  app.get("/api/agent-task-snapshot", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listWorkspaceAgentTaskSnapshot(workspaceId));
  });
  app.get("/api/multiremi/agent-run-counts", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const counts = store.listWorkspaceAgentRunCounts(workspaceId);
    return c.json({ counts, total: counts.length });
  });
  app.get("/api/agent-run-counts", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listWorkspaceAgentRunCounts(workspaceId));
  });
  app.get("/api/multiremi/agent-activity-30d", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const activity = store.listWorkspaceAgentActivity30d(workspaceId);
    return c.json({ activity, total: activity.length });
  });
  app.get("/api/agent-activity-30d", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listWorkspaceAgentActivity30d(workspaceId));
  });
  app.get("/api/multiremi/agent-templates", (c) => {
    const templates = listAgentTemplates();
    return c.json({ templates, total: templates.length });
  });
  app.get("/api/multiremi/agent-templates/:slug", (c) => {
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

  app.get("/api/multiremi/skills", (c) => {
    const workspaceId = requestedSkillWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const includeFiles = c.req.query("includeFiles") === "true";
    const skills = store.listSkills(workspaceId, { includeFiles });
    return c.json({ skills: includeFiles ? skills : skills.map(skillSummary), total: skills.length });
  });
  app.post("/api/multiremi/skills", async (c) => {
    const body = await readJsonStrict<CreateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withSkillCreateRequestContext(c, store, body);
    if (input instanceof Response) return input;
    try {
      const skill = store.createSkill(sanitizeSkillFilesForCompatibility(input));
      publishWorkspaceEvent(c, store, "skill:created", skillWorkspaceId(skill), { skill: skillWithFilesCompatibilityResponse(skill) });
      return c.json({ skill }, 201);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.post("/api/multiremi/skills/import", async (c) => {
    const body = await readJsonStrict<ImportSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const request = withSkillImportRequestContext(c, store, body);
    if (request instanceof Response) return request;
    const imported = await buildImportedSkillInput(request);
    const input = withSkillCreateRequestContext(c, store, imported.skillInput);
    if (input instanceof Response) return input;
    try {
      const skill = store.createSkill(sanitizeSkillFilesForCompatibility(input));
      publishWorkspaceEvent(c, store, "skill:created", skillWorkspaceId(skill), { skill: skillWithFilesCompatibilityResponse(skill) });
      return c.json({ skill, source: imported.source, sourceUrl: imported.sourceUrl }, 201);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { duplicateImportInput: input, store });
    }
  });
  app.get("/api/multiremi/skills/search", (c) => {
    const workspaceId = requestedSkillWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const result = searchSkillsResponse(store, c);
    return c.json({ ...result, total: result.skills.length });
  });
  app.get("/api/multiremi/skills/:id", (c) => {
    const loaded = loadSkillForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json({ skill: loaded.skill });
  });
  app.patch("/api/multiremi/skills/:id", async (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const skill = store.updateSkill(loaded.skill.id!, sanitizeSkillFilesForCompatibility(withSkillUpdateRequestContext(loaded.skill, body)));
      publishWorkspaceEvent(c, store, "skill:updated", skillWorkspaceId(skill), { skill: skillWithFilesCompatibilityResponse(skill) });
      return c.json({ skill });
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.put("/api/multiremi/skills/:id", async (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const skill = store.updateSkill(loaded.skill.id!, sanitizeSkillFilesForCompatibility(withSkillUpdateRequestContext(loaded.skill, body)));
      publishWorkspaceEvent(c, store, "skill:updated", skillWorkspaceId(skill), { skill: skillWithFilesCompatibilityResponse(skill) });
      return c.json({ skill });
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.delete("/api/multiremi/skills/:id", (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    try {
      const skill = store.archiveSkill(loaded.skill.id!);
      publishWorkspaceEvent(c, store, "skill:deleted", skillWorkspaceId(loaded.skill), { skill_id: loaded.skill.id ?? c.req.param("id") });
      return c.json({ skill });
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/skills", (c) => {
    const workspaceId = requestedSkillWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listSkills(workspaceId, { includeFiles: false }).map(skillSummaryCompatibilityResponse));
  });
  app.get("/api/skills/search", (c) => {
    if (!String(c.req.query("q") ?? "").trim()) return c.json({ error: "query is required" }, 400);
    return c.json(searchSkillsResponse(store, c).skills);
  });
  app.post("/api/skills", async (c) => {
    const body = await readJsonStrict<CreateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withSkillCreateRequestContext(c, store, body);
    if (input instanceof Response) return input;
    try {
      const skill = store.createSkill(sanitizeSkillFilesForCompatibility(input));
      const response = skillWithFilesCompatibilityResponse(skill);
      publishWorkspaceEvent(c, store, "skill:created", skillWorkspaceId(skill), { skill: response });
      return c.json(response, 201);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.post("/api/skills/import", async (c) => {
    const body = await readJsonStrict<ImportSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const request = withSkillImportRequestContext(c, store, body);
    if (request instanceof Response) return request;
    const imported = await buildImportedSkillInput(request);
    const input = withSkillCreateRequestContext(c, store, imported.skillInput);
    if (input instanceof Response) return input;
    try {
      const skill = store.createSkill(sanitizeSkillFilesForCompatibility(input));
      const response = skillWithFilesCompatibilityResponse(skill);
      publishWorkspaceEvent(c, store, "skill:created", skillWorkspaceId(skill), { skill: response });
      return c.json(response, 201);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { duplicateImportInput: input, store });
    }
  });
  app.get("/api/skills/:id", (c) => {
    const loaded = loadSkillForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(skillWithFilesCompatibilityResponse(loaded.skill));
  });
  app.patch("/api/skills/:id", async (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const skill = store.updateSkill(loaded.skill.id!, sanitizeSkillFilesForCompatibility(withSkillUpdateRequestContext(loaded.skill, body)));
      const response = skillWithFilesCompatibilityResponse(skill);
      publishWorkspaceEvent(c, store, "skill:updated", skillWorkspaceId(skill), { skill: response });
      return c.json(response);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.put("/api/skills/:id", async (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const skill = store.updateSkill(loaded.skill.id!, sanitizeSkillFilesForCompatibility(withSkillUpdateRequestContext(loaded.skill, body)));
      const response = skillWithFilesCompatibilityResponse(skill);
      publishWorkspaceEvent(c, store, "skill:updated", skillWorkspaceId(skill), { skill: response });
      return c.json(response);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.delete("/api/skills/:id", (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    try {
      store.archiveSkill(loaded.skill.id!);
      publishWorkspaceEvent(c, store, "skill:deleted", skillWorkspaceId(loaded.skill), { skill_id: loaded.skill.id ?? c.req.param("id") });
      return c.body(null, 204);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/skills/:id/files", (c) => {
    try {
      const loaded = loadSkillForCurrentUser(c, store, c.req.param("id"));
      if (loaded instanceof Response) return loaded;
      return c.json(store.listSkillFiles(loaded.skill.id!).map(skillFileCompatibilityResponse));
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.put("/api/skills/:id/files", async (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<MultiremiSkillFile>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(skillFileCompatibilityResponse(store.upsertSkillFile(loaded.skill.id!, body)));
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/skills/:id/files/:fileId", (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    try {
      const deleted = store.deleteSkillFile(loaded.skill.id!, c.req.param("fileId"));
      if (!deleted) return c.json({ error: "skill file not found" }, 404);
      return c.body(null, 204);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });

  app.get("/api/multiremi/members", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const members = store.listWorkspaceMembers(workspaceId);
    return c.json({ members, total: members.length });
  });
  app.post("/api/multiremi/members", async (c) => {
    const body = await readJson<CreateWorkspaceMemberInput>(c);
    const workspaceId = body.workspaceId ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json({ member: store.createWorkspaceMember(body) }, 201);
  });
  app.get("/api/multiremi/members/:id", (c) => {
    const member = store.getWorkspaceMember(c.req.param("id"));
    if (!member) return c.json({ error: "member not found" }, 404);
    return c.json({ member });
  });
  app.patch("/api/multiremi/members/:id", async (c) => {
    const body = await readJson<UpdateWorkspaceMemberInput>(c);
    const member = safeUpdateWorkspaceMember(store, c.req.param("id"), body);
    if ("error" in member) return c.json({ error: member.error }, member.status);
    return c.json({ member });
  });
  app.delete("/api/multiremi/members/:id", (c) => {
    const member = safeArchiveWorkspaceMember(store, c.req.param("id"));
    if ("error" in member) return c.json({ error: member.error }, member.status);
    return c.json({ member });
  });

  app.get("/api/multiremi/tokens", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const tokens = store.listAccessTokens(workspaceId);
    return c.json({ tokens, total: tokens.length });
  });
  app.post("/api/multiremi/tokens", async (c) => {
    const body = await readJson<CreateAccessTokenInput>(c);
    if (isTaskTokenCreateInput(body)) return c.json({ error: "task tokens are minted by daemon task claim" }, 400);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json({ token: await store.createAccessToken(body) }, 201);
  });
  app.delete("/api/multiremi/tokens/:id", (c) => {
    const token = store.revokeAccessToken(c.req.param("id"));
    return c.json({ token, ok: true });
  });
  app.get("/api/multiremi/notification-preferences", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.getNotificationPreferences({
      workspaceId,
      memberId: c.req.query("memberId") ?? c.req.query("member_id"),
    }));
  });
  app.put("/api/multiremi/notification-preferences", async (c) => {
    const body = await readJson<{ workspaceId?: string | null; workspace_id?: string | null; memberId?: string | null; member_id?: string | null; preferences?: MultiremiNotificationPreferences }>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.updateNotificationPreferences({
      workspaceId,
      memberId: body.memberId ?? body.member_id,
      preferences: body.preferences ?? {},
    }));
  });
  app.get("/api/notification-preferences", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.getNotificationPreferences({
      workspaceId,
      memberId: c.req.query("memberId") ?? c.req.query("member_id"),
    }));
  });
  app.put("/api/notification-preferences", async (c) => {
    const body = await readJson<MultiremiNotificationPreferences & { workspaceId?: string | null; workspace_id?: string | null; memberId?: string | null; member_id?: string | null; preferences?: MultiremiNotificationPreferences }>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.updateNotificationPreferences({
      workspaceId,
      memberId: body.memberId ?? body.member_id,
      preferences: body.preferences ?? body,
    }));
  });
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
  app.get("/api/tokens", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const tokens = store.listAccessTokens(workspaceId);
    return c.json(tokens);
  });
  app.post("/api/tokens", async (c) => {
    const body = await readJson<CreateAccessTokenInput>(c);
    if (isTaskTokenCreateInput(body)) return c.json({ error: "task tokens are minted by daemon task claim" }, 400);
    // The dashboard "add computer" dialog posts no workspace in the body; fall
    // back to the X-Workspace-Slug header the web client sends on every request,
    // so the token is minted (and access-checked) for the workspace the user is
    // actually in — not the "local" default they may not be a member of.
    const workspaceId = body.workspaceId ?? body.workspace_id ?? workspaceIdFromSlugHeader(c, store) ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    // A human requester always mints for themselves: bind the token to the
    // resolved workspace and their own user id, so they can't mint a user-less
    // "local" admin credential. Master token / open mode keeps body semantics.
    const userId = authenticatedRequestUserId(c);
    const input = userId && userId !== "local" ? { ...body, workspaceId, userId } : body;
    return c.json(await store.createAccessToken(input), 201);
  });
  app.post("/api/tokens/current/renew", async (c) => {
    const current = currentAccessToken(c);
    if (current) {
      const authHeader = c.req.header("Authorization") ?? "";
      const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
      if (current.type !== "pat" || !rawToken.startsWith("mul_")) {
        return c.json({ error: "only personal access tokens can be renewed" }, 400);
      }
      const renewal = await store.renewAccessTokenExpiry(current.id, { thresholdDays: 7, extensionDays: 90 });
      if (!renewal) return c.json({ error: "token is no longer valid" }, 401);
      return c.json({
        ...(renewal.rawToken ? { access_token: renewal.rawToken, token_type: "bearer" } : {}),
        expires_at: renewal.token.expiresAt ?? "",
        renewed: renewal.renewed,
      });
    }

    const body = await readJson<Partial<CreateAccessTokenInput>>(c);
    const token = await store.createAccessToken({
      workspaceId: body.workspaceId ?? body.workspace_id ?? "local",
      name: body.name ?? "Renewed local token",
      type: body.type ?? "pat",
      expiresInDays: body.expiresInDays ?? body.expires_in_days ?? 30,
    });
    return c.json({
      ...token,
      access_token: token.token,
      token_type: "bearer",
    }, 201);
  });
  app.delete("/api/tokens/:id", (c) => {
    store.revokeAccessToken(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/multiremi/runtimes", (c) => {
    const loaded = listRuntimesForCurrentUser(c, store);
    if (loaded instanceof Response) return loaded;
    return c.json({ runtimes: loaded.runtimes });
  });
  app.post("/api/multiremi/runtimes", async (c) => {
    const body = await readJson<RegisterRuntimeInput>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = denyDaemonTokenWorkspace(c, workspaceId) ??
      (currentAccessToken(c)?.type === "daemon" ? null : denyCurrentUserWorkspaceAccess(c, store, workspaceId));
    if (denied) return denied;
    const provider = validateMultiremiRuntimeProvider(body.provider);
    if ("error" in provider) return c.json({ error: provider.error }, provider.status);
    return c.json({ runtime: store.registerRuntime(body) }, 201);
  });
  app.get("/api/multiremi/runtimes/:id", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ runtime, usage: store.listRuntimeUsage(runtime.id) });
  });
  app.patch("/api/multiremi/runtimes/:id", async (c) => {
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "edit");
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateRuntimeInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json({ runtime: store.updateRuntime(loaded.runtime.id, body) });
  });
  app.get("/api/multiremi/runtimes/:id/models", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ runtimeId: runtime.id, supported: true, models: store.listRuntimeModels(runtime.id) });
  });
  app.put("/api/multiremi/runtimes/:id/models", async (c) => {
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "edit");
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<{ models?: any[]; supported?: boolean }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json({ runtimeId: loaded.runtime.id, supported: body.supported !== false, models: store.updateRuntimeModels(loaded.runtime.id, body.models ?? []) });
  });
  app.post("/api/multiremi/runtimes/:id/models", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    if (loaded.runtime.status !== "online") return c.json({ error: "runtime is offline" }, 503);
    return c.json(store.createRuntimeModelListRequest(loaded.runtime.id));
  });
  app.get("/api/multiremi/runtimes/:id/models/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeModelListRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.get("/api/runtimes/:id/models", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ runtime_id: runtime.id, supported: true, models: store.listRuntimeModels(runtime.id).map(runtimeModelCompatibilityResponse) });
  });
  app.put("/api/runtimes/:id/models", async (c) => {
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "edit");
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<{ models?: any[]; supported?: boolean }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json({
      runtime_id: loaded.runtime.id,
      supported: body.supported !== false,
      models: store.updateRuntimeModels(loaded.runtime.id, body.models ?? []).map(runtimeModelCompatibilityResponse),
    });
  });
  app.post("/api/runtimes/:id/models", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    if (loaded.runtime.status !== "online") return c.json({ error: "runtime is offline" }, 503);
    return c.json(runtimeModelListRequestCompatibilityResponse(store.createRuntimeModelListRequest(loaded.runtime.id)));
  });
  app.get("/api/runtimes/:id/models/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeModelListRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(runtimeModelListRequestCompatibilityResponse(request));
  });
  app.post("/api/daemon/runtimes/:runtimeId/models/claim", (c) => {
    return c.json({ request: store.claimRuntimeModelListRequest(c.req.param("runtimeId")) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/models/:requestId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const requestId = c.req.param("requestId");
    const request = store.getRuntimeModelListRequest(runtimeId, requestId);
    if (!request) return c.json({ error: "request not found" }, 404);
    if (isTerminalRuntimeRequestForDaemon(request.status)) return c.json({ status: "ok" });
    const body = await readJsonStrict<ReportRuntimeModelListInput>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    store.reportRuntimeModelListResult(runtimeId, requestId, body);
    return c.json({ status: "ok" });
  });
  app.post("/api/multiremi/runtimes/:id/update", async (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<CreateRuntimeUpdateInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const result = safeCreateRuntimeUpdateRequest(store, loaded.runtime.id, body);
    if ("apiError" in result) return c.json({ error: result.apiError }, result.statusCode);
    return c.json(result);
  });
  app.get("/api/multiremi/runtimes/:id/update/:updateId", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeUpdateRequest(loaded.runtime.id, c.req.param("updateId"));
    if (!request) return c.json({ error: "update not found" }, 404);
    return c.json(request);
  });
  app.post("/api/runtimes/:id/update", async (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<CreateRuntimeUpdateInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const result = safeCreateRuntimeUpdateRequest(store, loaded.runtime.id, { target_version: body.target_version, scope: body.scope });
    if ("apiError" in result) return c.json({ error: result.apiError }, result.statusCode);
    return c.json(runtimeUpdateRequestCompatibilityResponse(result));
  });
  app.get("/api/runtimes/:id/update/:updateId", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeUpdateRequest(loaded.runtime.id, c.req.param("updateId"));
    if (!request) return c.json({ error: "update not found" }, 404);
    return c.json(runtimeUpdateRequestCompatibilityResponse(request));
  });
  app.post("/api/daemon/runtimes/:runtimeId/update/claim", (c) => {
    return c.json({ request: store.claimRuntimeUpdateRequest(c.req.param("runtimeId")) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/update/:updateId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const updateId = c.req.param("updateId");
    const request = store.getRuntimeUpdateRequest(runtimeId, updateId);
    if (!request) return c.json({ error: "update not found" }, 404);
    if (isTerminalRuntimeRequestForDaemon(request.status)) return c.json({ status: "ok" });
    const body = await readJsonStrict<ReportRuntimeUpdateInput>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    if (!isValidRuntimeUpdateReportStatus(body.status)) {
      return c.json({ error: `invalid status: ${String(body.status ?? "")}` }, 400);
    }
    store.reportRuntimeUpdateResult(runtimeId, updateId, body);
    return c.json({ status: "ok" });
  });
  app.post("/api/multiremi/runtimes/:id/local-skills", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(store.createRuntimeLocalSkillListRequest(loaded.runtime.id));
  });
  app.post("/api/runtimes/:id/local-skills", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(runtimeLocalSkillListRequestCompatibilityResponse(store.createRuntimeLocalSkillListRequest(loaded.runtime.id)));
  });
  app.get("/api/multiremi/runtimes/:id/local-skills/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeLocalSkillListRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.get("/api/runtimes/:id/local-skills/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeLocalSkillListRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(runtimeLocalSkillListRequestCompatibilityResponse(request));
  });
  app.post("/api/multiremi/runtimes/:id/local-skills/import", async (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<CreateRuntimeLocalSkillImportInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json(store.createRuntimeLocalSkillImportRequest(loaded.runtime.id, body));
  });
  app.post("/api/runtimes/:id/local-skills/import", async (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<CreateRuntimeLocalSkillImportInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json(runtimeLocalSkillImportRequestCompatibilityResponse(store.createRuntimeLocalSkillImportRequest(loaded.runtime.id, body)));
  });
  app.get("/api/multiremi/runtimes/:id/local-skills/import/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeLocalSkillImportRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.get("/api/runtimes/:id/local-skills/import/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeLocalSkillImportRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(runtimeLocalSkillImportRequestCompatibilityResponse(request));
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/claim", (c) => {
    return c.json({ request: store.claimRuntimeLocalSkillListRequest(c.req.param("runtimeId")) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/:requestId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const requestId = c.req.param("requestId");
    const request = store.getRuntimeLocalSkillListRequest(runtimeId, requestId);
    if (!request) return c.json({ error: "request not found" }, 404);
    if (isTerminalRuntimeRequestForDaemon(request.status)) return c.json({ status: "ok" });
    const body = await readJsonStrict<ReportRuntimeLocalSkillListInput>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    store.reportRuntimeLocalSkillListResult(runtimeId, requestId, daemonLocalSkillListReportBody(body));
    return c.json({ status: "ok" });
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/import/claim", (c) => {
    const limit = parseOptionalInt(c.req.query("limit")) ?? 10;
    return c.json({ requests: store.claimRuntimeLocalSkillImportRequests(c.req.param("runtimeId"), limit) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/import/:requestId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const requestId = c.req.param("requestId");
    const request = store.getRuntimeLocalSkillImportRequest(runtimeId, requestId);
    if (!request) return c.json({ error: "request not found" }, 404);
    if (isTerminalRuntimeRequestForDaemon(request.status)) return c.json({ status: "ok" });
    const body = await readJsonStrict<ReportRuntimeLocalSkillImportInput>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    store.reportRuntimeLocalSkillImportResult(runtimeId, requestId, daemonLocalSkillImportReportBody(body));
    return c.json({ status: "ok" });
  });
  app.post("/api/multiremi/runtimes/:id/directory-scans", async (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"), "directory scans");
    if (loaded instanceof Response) return loaded;
    if (loaded.runtime.status !== "online") return c.json({ error: "runtime is offline" }, 503);
    const body = await readJsonStrict<CreateRuntimeDirectoryScanInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(store.createRuntimeDirectoryScanRequest(loaded.runtime.id, { root: body.root, maxDepth: body.maxDepth ?? body.max_depth, mode: body.mode }));
    } catch (err) {
      const response = directoryScanErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.post("/api/runtimes/:id/directory-scans", async (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"), "directory scans");
    if (loaded instanceof Response) return loaded;
    if (loaded.runtime.status !== "online") return c.json({ error: "runtime is offline" }, 503);
    const body = await readJsonStrict<CreateRuntimeDirectoryScanInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(runtimeDirectoryScanRequestCompatibilityResponse(store.createRuntimeDirectoryScanRequest(loaded.runtime.id, { root: body.root, maxDepth: body.maxDepth ?? body.max_depth, mode: body.mode })));
    } catch (err) {
      const response = directoryScanErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.get("/api/multiremi/runtimes/:id/directory-scans/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"), "directory scans");
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeDirectoryScanRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.get("/api/runtimes/:id/directory-scans/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"), "directory scans");
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeDirectoryScanRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(runtimeDirectoryScanRequestCompatibilityResponse(request));
  });
  app.post("/api/daemon/runtimes/:runtimeId/directory-scans/claim", (c) => {
    return c.json({ request: store.claimRuntimeDirectoryScanRequest(c.req.param("runtimeId")) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/directory-scans/:requestId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const requestId = c.req.param("requestId");
    const request = store.getRuntimeDirectoryScanRequest(runtimeId, requestId);
    if (!request) return c.json({ error: "request not found" }, 404);
    if (isTerminalRuntimeRequestForDaemon(request.status)) return c.json({ status: "ok" });
    const body = await readJsonStrict<ReportRuntimeDirectoryScanInput>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    store.reportRuntimeDirectoryScanResult(runtimeId, requestId, body);
    return c.json({ status: "ok" });
  });
  app.get("/api/multiremi/runtimes/:id/usage", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ runtimeId: runtime.id, usage: store.listRuntimeUsage(runtime.id) });
  });
  app.get("/api/multiremi/runtimes/:id/usage/by-agent", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ usage: store.listUsageByAgent(usageQuery(c, { runtimeId: runtime.id })) });
  });
  app.get("/api/multiremi/runtimes/:id/usage/by-hour", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ usage: store.listUsageByHour(usageQuery(c, { runtimeId: runtime.id })) });
  });
  app.get("/api/multiremi/runtimes/:id/task-activity", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ activity: store.listTaskActivityByHour(usageQuery(c, { runtimeId: runtime.id })) });
  });
  app.get("/api/runtimes", (c) => {
    const loaded = listRuntimesForCurrentUser(c, store);
    if (loaded instanceof Response) return loaded;
    return c.json(loaded.runtimes.map(runtimeCompatibilityResponse));
  });
  const fleetModelsHandler = (c: Context) => {
    const loaded = listRuntimesForCurrentUser(c, store);
    if (loaded instanceof Response) return loaded;
    return c.json({ providers: fleetModelsResponse(loaded.runtimes) });
  };
  app.get("/api/models", fleetModelsHandler);
  app.get("/api/multiremi/models", fleetModelsHandler);
  app.get("/api/runtimes/:id", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ runtime, usage: store.listRuntimeUsage(runtime.id) });
  });
  app.patch("/api/runtimes/:id", async (c) => {
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "edit");
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateRuntimeInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (hasRequestField(body, "name")) {
      const name = cleanString(typeof body.name === "string" ? body.name : null);
      if (!name) return c.json({ error: "name must be a non-empty string" }, 400);
      if (name.length > 100) return c.json({ error: "name must be at most 100 characters" }, 400);
      return c.json(runtimeCompatibilityResponse(store.updateRuntime(loaded.runtime.id, { name })));
    }
    if (hasRequestField(body, "visibility")) {
      const visibility = cleanString(typeof body.visibility === "string" ? body.visibility : null);
      if (visibility !== "private" && visibility !== "public") {
        return c.json({ error: "visibility must be 'private' or 'public'" }, 400);
      }
      return c.json(runtimeCompatibilityResponse(store.updateRuntime(loaded.runtime.id, { visibility })));
    }
    return c.json(runtimeCompatibilityResponse(loaded.runtime));
  });
  app.get("/api/runtimes/:id/usage", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json(store.listUsageDaily(usageQuery(c, { runtimeId: runtime.id }))
      .map(runtimeUsageDailyCompatibilityResponse)
      .sort(compareRuntimeUsageDailyCompatibilityRows));
  });
  app.get("/api/runtimes/:id/usage/by-agent", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json(store.listUsageByAgent(usageQuery(c, { runtimeId: runtime.id })).map(runtimeUsageByAgentCompatibilityResponse));
  });
  app.get("/api/runtimes/:id/usage/by-hour", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json(store.listUsageByHour(usageQuery(c, { runtimeId: runtime.id })).map(runtimeUsageByHourCompatibilityResponse));
  });
  app.get("/api/runtimes/:id/task-activity", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json(store.listTaskActivityByHour(usageQuery(c, { runtimeId: runtime.id })).map(runtimeTaskActivityCompatibilityResponse));
  });
  app.get("/api/runtimes/:id/activity", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json(store.listTaskActivityByHour(usageQuery(c, { runtimeId: runtime.id })).map(runtimeTaskActivityCompatibilityResponse));
  });
  app.delete("/api/runtimes/:id", (c) => {
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "delete");
    if (loaded instanceof Response) return loaded;
    const activeAgents = store.listActiveAgentsByRuntime(loaded.runtime.id);
    if (activeAgents.length) return c.json(runtimeHasActiveAgentsResponse(activeAgents), 409);
    const deleted = store.deleteRuntimeWithArchivedAgentCleanup(loaded.runtime.id);
    if (!deleted) return c.json({ error: "runtime not found" }, 404);
    return c.json({ status: "ok" });
  });
  app.post("/api/runtimes/:id/archive-agents-and-delete", async (c) => {
    const body = await readJsonStrict<{ expected_active_agent_ids?: string[] }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "delete");
    if (loaded instanceof Response) return loaded;
    const expectedIds = parseExpectedActiveAgentIds(c, body.expected_active_agent_ids ?? []);
    if (expectedIds instanceof Response) return expectedIds;
    const result = store.archiveAgentsAndDeleteRuntime(loaded.runtime.id, expectedIds);
    if (result.status === "plan_changed") {
      return c.json(runtimeHasActiveAgentsResponse(
        result.activeAgents,
        "runtime_delete_plan_changed",
        "the active agent set changed; please review and confirm again.",
      ), 409);
    }
    return c.json({
      status: "ok",
      agents_archived: result.agentsArchived,
      tasks_cancelled: result.tasksCancelled,
    });
  });
  app.post("/api/multiremi/runtimes/:id/heartbeat", (c) => {
    const denied = denyDaemonTokenRuntimeWorkspace(c, store, c.req.param("id"));
    if (denied) return denied;
    const ack = store.heartbeatRuntime(c.req.param("id"), {
      supportsBatchImport: c.req.query("supports_batch_import") === "true" || c.req.query("supportsBatchImport") === "true",
      supportsDirectoryScan: c.req.query("supports_directory_scan") === "true" || c.req.query("supportsDirectoryScan") === "true",
    });
    if (ack.status === "runtime_gone") return c.json({ error: "runtime not found" }, 404);
    return c.json(ack);
  });

  app.get("/api/dashboard/usage/daily", (c) => {
    const query = usageQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listUsageDaily(query));
  });
  app.get("/api/dashboard/usage/by-agent", (c) => {
    const query = usageQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listUsageByAgent(query));
  });
  app.get("/api/dashboard/agent-runtime", (c) => {
    const query = usageQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listRuntimeDaily(query));
  });
  app.get("/api/dashboard/runtime/daily", (c) => {
    const query = usageQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listRuntimeDaily(query));
  });

  app.get("/api/multiremi/projects", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const projects = store.listProjects(workspaceId);
    return c.json({ projects, total: projects.length });
  });
  app.get("/api/multiremi/projects/search", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const result = store.searchProjects({
      q: c.req.query("q") ?? "",
      workspaceId,
      includeClosed: c.req.query("include_closed") === "true" || c.req.query("includeClosed") === "true",
      limit: parseOptionalInt(c.req.query("limit")),
      offset: parseOptionalInt(c.req.query("offset")),
    });
    return c.json(result);
  });
  app.get("/api/projects/search", (c) => {
    const workspaceId = c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const result = store.searchProjects({
        q: c.req.query("q") ?? "",
        workspaceId,
        includeClosed: c.req.query("include_closed") === "true",
        limit: parseOptionalInt(c.req.query("limit")),
        offset: parseOptionalInt(c.req.query("offset")),
      });
      c.header("X-Total-Count", String(result.total));
      return c.json({
        projects: result.projects.map(projectSearchCompatibilityResponse),
        total: result.total,
      });
    } catch (err) {
      const response = projectSearchErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.get("/api/projects", (c) => {
    const workspaceId = c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const projects = store
      .listProjects(workspaceId)
      .map(projectCompatibilityResponse);
    return c.json({ projects, total: projects.length });
  });
  app.post("/api/projects", async (c) => {
    const body = await readJsonStrict<CreateProjectInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const projectInput = projectCreateCompatibilityInput(c, body);
    const denied = denyCurrentUserWorkspaceAccess(c, store, projectInput.workspaceId ?? "local");
    if (denied) return denied;
    try {
      const project = store.createProject(projectInput);
      const response = projectCompatibilityResponse(project);
      publishProjectCreated(c, store, project, response);
      return c.json(response, 201);
    } catch (err) {
      const response = projectErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.post("/api/multiremi/projects", async (c) => {
    const body = await readJsonStrict<CreateProjectInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
    return c.json({ project: store.createProject(body) }, 201);
  });
  app.get("/api/multiremi/projects/:id", (c) => {
    const project = store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json({ project, resources: store.listProjectResources(project.id) });
  });
  app.patch("/api/multiremi/projects/:id", async (c) => {
    const body = await readJsonStrict<UpdateProjectInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json({ project: store.updateProject(c.req.param("id"), body) });
  });
  app.delete("/api/multiremi/projects/:id", (c) => {
    return c.json({ project: store.archiveProject(c.req.param("id")) });
  });
  app.get("/api/multiremi/projects/:id/resources", (c) => {
    const resources = store.listProjectResources(c.req.param("id"));
    return c.json({ resources, total: resources.length });
  });
  app.post("/api/multiremi/projects/:id/resources", async (c) => {
    const body = await readJsonStrict<CreateProjectResourceInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const resource = store.createProjectResource(c.req.param("id"), body);
      publishProjectResourceCreated(c, store, resource);
      return c.json({ resource }, 201);
    } catch (err) {
      const response = projectResourceErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.patch("/api/multiremi/projects/:id/resources/:resourceId", async (c) => {
    const body = await readJsonStrict<UpdateProjectResourceInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const resource = store.updateProjectResource(c.req.param("id"), c.req.param("resourceId"), body);
      publishProjectResourceUpdated(c, store, resource);
      return c.json({ resource });
    } catch (err) {
      const response = projectResourceErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.delete("/api/multiremi/projects/:id/resources/:resourceId", (c) => {
    const resource = loadProjectResourceForMutation(c, store, c.req.param("id"), c.req.param("resourceId"));
    if (resource instanceof Response) return resource;
    store.deleteProjectResource(c.req.param("id"), c.req.param("resourceId"));
    publishProjectResourceDeleted(c, store, resource);
    return c.json({ ok: true });
  });
  app.get("/api/projects/:id", (c) => {
    const project = store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json(projectCompatibilityResponse(project));
  });
  app.put("/api/projects/:id", async (c) => {
    const body = await readJsonStrict<UpdateProjectInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const project = store.updateProject(c.req.param("id"), projectUpdateCompatibilityInput(body));
      const response = projectCompatibilityResponse(project);
      publishProjectUpdated(c, store, project, response);
      return c.json(response);
    } catch (err) {
      const response = projectErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.delete("/api/projects/:id", (c) => {
    const project = store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    store.archiveProject(project.id);
    publishProjectDeleted(c, store, project);
    return c.body(null, 204);
  });
  app.get("/api/projects/:id/resources", (c) => {
    const resources = store.listProjectResources(c.req.param("id")).map(projectResourceCompatibilityResponse);
    return c.json({ resources, total: resources.length });
  });
  app.post("/api/projects/:id/resources", async (c) => {
    const body = await readJsonStrict<CreateProjectResourceInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const resource = store.createProjectResource(c.req.param("id"), body);
      const response = projectResourceCompatibilityResponse(resource);
      publishProjectResourceCreated(c, store, resource, response);
      return c.json(response, 201);
    } catch (err) {
      const response = projectResourceErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.put("/api/projects/:id/resources/:resourceId", async (c) => {
    const body = await readJsonStrict<UpdateProjectResourceInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const resource = store.updateProjectResource(c.req.param("id"), c.req.param("resourceId"), body);
      const response = projectResourceCompatibilityResponse(resource);
      publishProjectResourceUpdated(c, store, resource, response);
      return c.json(response);
    } catch (err) {
      const response = projectResourceErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.delete("/api/projects/:id/resources/:resourceId", (c) => {
    const resource = loadProjectResourceForMutation(c, store, c.req.param("id"), c.req.param("resourceId"));
    if (resource instanceof Response) return resource;
    store.deleteProjectResource(c.req.param("id"), c.req.param("resourceId"));
    publishProjectResourceDeleted(c, store, resource);
    return c.body(null, 204);
  });

  app.get("/api/multiremi/squads", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const squads = store.listSquads(workspaceId);
    return c.json({ squads, total: squads.length });
  });
  app.get("/api/squads", (c) => {
    const workspaceId = compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listSquads(workspaceId).map((squad) => squadCompatibilityResponse(store, squad)));
  });
  app.post("/api/squads", async (c) => {
    const body = await readJsonStrict<{
      id?: string;
      name?: string;
      description?: string | null;
      instructions?: string | null;
      workspace_id?: string | null;
      leader_id?: string | null;
      creator_id?: string | null;
      member_ids?: string[];
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = cleanString(body.workspace_id) ?? compatibilityWorkspaceId(c);
    const squadCreateDenied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (squadCreateDenied) return squadCreateDenied;
    const leaderId = cleanString(body.leader_id);
    const name = cleanString(body.name);
    if (!name) return c.json({ error: "name is required" }, 400);
    if (!leaderId) return c.json({ error: "leader_id is required" }, 400);
    const leader = store.getAgent(leaderId);
    if (!leader || leader.workspaceId !== workspaceId) return c.json({ error: "leader must be a valid agent in this workspace" }, 400);
    try {
      const squad = store.createSquad({
        id: body.id,
        name,
        description: body.description,
        instructions: body.instructions,
        workspaceId,
        leaderId,
        creatorId: cleanString(body.creator_id) ?? compatibilityUserId(c),
        memberIds: body.member_ids,
      });
      return c.json(squadCompatibilityResponse(store, squad), 201);
    } catch (error) {
      return squadCompatibilityErrorResponse(c, error);
    }
  });
  app.post("/api/multiremi/squads", async (c) => {
    const body = await readJson<CreateSquadInput>(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? "local");
    if (denied) return denied;
    return c.json({ squad: store.createSquad(body) }, 201);
  });
  app.get("/api/multiremi/squads/:id", (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad) return c.json({ error: "squad not found" }, 404);
    return c.json({ squad, members: store.listSquadMembers(squad.id) });
  });
  app.patch("/api/multiremi/squads/:id", async (c) => {
    const body = await readJson<UpdateSquadInput>(c);
    return c.json({ squad: store.updateSquad(c.req.param("id"), body) });
  });
  app.delete("/api/multiremi/squads/:id", (c) => {
    return c.json({ squad: store.archiveSquad(c.req.param("id")) });
  });
  app.get("/api/multiremi/squads/:id/members", (c) => {
    return c.json({ members: store.listSquadMembers(c.req.param("id")) });
  });
  app.post("/api/multiremi/squads/:id/members", async (c) => {
    const body = await readJson<AddSquadMemberInput>(c);
    return c.json({ member: store.addSquadMember(c.req.param("id"), body) }, 201);
  });
  app.patch("/api/multiremi/squads/:id/members", async (c) => {
    const body = await readJson<AddSquadMemberInput>(c);
    return c.json({ member: store.addSquadMember(c.req.param("id"), body) });
  });
  app.delete("/api/multiremi/squads/:id/members", async (c) => {
    const body = await readJson<RemoveSquadMemberInput>(c);
    store.removeSquadMember(c.req.param("id"), body);
    return c.json({ ok: true });
  });
  app.get("/api/squads/:id", (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad) return c.json({ error: "squad not found" }, 404);
    const workspaceId = compatibilityWorkspaceId(c);
    if (squad.workspaceId !== workspaceId) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    return c.json(squadCompatibilityResponse(store, squad));
  });
  app.put("/api/squads/:id", async (c) => {
    const existing = store.getSquad(c.req.param("id"));
    if (!existing || existing.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, existing.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{
      name?: string;
      description?: string | null;
      instructions?: string | null;
      leader_id?: string | null;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const leaderId = body.leader_id === undefined ? undefined : cleanString(body.leader_id) ?? null;
    if (leaderId) {
      const leader = store.getAgent(leaderId);
      if (!leader || leader.workspaceId !== existing.workspaceId) return c.json({ error: "leader must be a valid agent in this workspace" }, 400);
    }
    try {
      const squad = store.updateSquad(c.req.param("id"), {
        name: body.name,
        description: body.description,
        instructions: body.instructions,
        leaderId,
      });
      return c.json(squadCompatibilityResponse(store, squad));
    } catch (error) {
      return squadCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/squads/:id", (c) => {
    const existing = store.getSquad(c.req.param("id"));
    if (!existing || existing.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, existing.workspaceId);
    if (denied) return denied;
    store.archiveSquad(c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/api/squads/:id/members", (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad || squad.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    return c.json(store.listSquadMembers(c.req.param("id")).map(squadMemberCompatibilityResponse));
  });
  app.get("/api/squads/:id/members/status", (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad || squad.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    return c.json(squadMemberStatusResponse(store, c.req.param("id")));
  });
  app.post("/api/squads/:id/members", async (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad || squad.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ member_type?: string; member_id?: string; role?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const memberType = cleanString(body.member_type);
    const memberId = cleanString(body.member_id);
    if (memberType !== "agent" && memberType !== "member") return c.json({ error: "member_type must be 'agent' or 'member'" }, 400);
    if (!memberId) return c.json({ error: "member_id is required" }, 400);
    try {
      const member = store.addSquadMember(c.req.param("id"), {
        memberType,
        memberId,
        role: body.role,
      });
      return c.json(squadMemberCompatibilityResponse(member), 201);
    } catch (error) {
      return squadCompatibilityErrorResponse(c, error);
    }
  });
  app.patch("/api/squads/:id/members/role", async (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad || squad.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ member_type?: string; member_id?: string; role?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const memberType = cleanString(body.member_type);
    const memberId = cleanString(body.member_id);
    if (memberType !== "agent" && memberType !== "member") return c.json({ error: "member_type must be 'agent' or 'member'" }, 400);
    if (!memberId) return c.json({ error: "member_id is required" }, 400);
    try {
      const member = store.addSquadMember(c.req.param("id"), {
        memberType,
        memberId,
        role: body.role,
      });
      return c.json(squadMemberCompatibilityResponse(member));
    } catch (error) {
      return squadCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/squads/:id/members", async (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad || squad.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ member_type?: string; member_id?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const memberType = cleanString(body.member_type);
    const memberId = cleanString(body.member_id);
    if (memberType !== "agent" && memberType !== "member") return c.json({ error: "member_type must be 'agent' or 'member'" }, 400);
    if (!memberId) return c.json({ error: "member_id is required" }, 400);
    store.removeSquadMember(c.req.param("id"), {
      memberType,
      memberId,
    });
    return c.body(null, 204);
  });

  app.get("/api/multiremi/autopilots", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const autopilots = store.listAutopilots(workspaceId);
    return c.json({ autopilots, total: autopilots.length });
  });
  app.get("/api/autopilots", (c) => {
    const workspaceId = c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const status = cleanString(c.req.query("status"));
    let autopilots = store.listAutopilots(workspaceId);
    if (status) autopilots = autopilots.filter((autopilot) => autopilot.status === status);
    const response = autopilots.map(autopilotCompatibilityResponse);
    return c.json({ autopilots: response, total: response.length });
  });
  app.post("/api/autopilots", async (c) => {
    const body = await readJsonStrict<CreateAutopilotInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = autopilotCreateCompatibilityInput(c, body);
    if (isJsonApiError(input)) return c.json({ error: input.apiError }, input.statusCode);
    const denied = denyCurrentUserWorkspaceAccess(c, store, input.workspaceId ?? "local");
    if (denied) return denied;
    try {
      const autopilot = store.createAutopilot(input);
      scheduler?.sync();
      const response = autopilotCompatibilityResponse(autopilot);
      publishWorkspaceEvent(c, store, "autopilot:created", autopilot.workspaceId, { autopilot: response });
      return c.json(response, 201);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.post("/api/multiremi/autopilots", async (c) => {
    const body = await readJson<CreateAutopilotInput>(c);
    const input = autopilotCreateInput(c, body);
    const denied = denyCurrentUserWorkspaceAccess(c, store, input.workspaceId ?? "local");
    if (denied) return denied;
    const autopilot = store.createAutopilot(input);
    scheduler?.sync();
    return c.json({ autopilot }, 201);
  });
  app.get("/api/multiremi/autopilots/:id", (c) => {
    const autopilot = store.getAutopilot(c.req.param("id"));
    if (!autopilot) return c.json({ error: "autopilot not found" }, 404);
    return c.json({
      autopilot,
      triggers: store.listAutopilotTriggers(autopilot.id).map(autopilotTriggerResponse),
      runs: store.listAutopilotRuns(autopilot.id),
      deliveries: store.listWebhookDeliveries(autopilot.id),
    });
  });
  app.patch("/api/multiremi/autopilots/:id", async (c) => {
    const body = await readJson<UpdateAutopilotInput>(c);
    const autopilot = store.updateAutopilot(c.req.param("id"), body);
    scheduler?.sync();
    return c.json({ autopilot });
  });
  app.delete("/api/multiremi/autopilots/:id", (c) => {
    const autopilot = store.archiveAutopilot(c.req.param("id"));
    scheduler?.sync();
    return c.json({ autopilot });
  });
  app.get("/api/multiremi/autopilots/:id/runs", (c) => {
    return c.json({ runs: store.listAutopilotRuns(c.req.param("id")) });
  });
  app.get("/api/multiremi/autopilots/:id/deliveries", (c) => {
    const deliveries = store.listWebhookDeliveries(c.req.param("id"));
    return c.json({ deliveries, total: deliveries.length });
  });
  app.get("/api/multiremi/autopilots/:id/deliveries/:deliveryId", (c) => {
    const delivery = store.getWebhookDelivery(c.req.param("deliveryId"));
    if (!delivery || delivery.autopilotId !== c.req.param("id")) return c.json({ error: "delivery not found" }, 404);
    return c.json({ delivery });
  });
  app.post("/api/multiremi/autopilots/:id/deliveries/:deliveryId/replay", (c) => {
    const result = store.replayWebhookDelivery(c.req.param("id"), c.req.param("deliveryId"));
    return c.json({ ...webhookDeliveryResponse(result) }, 201);
  });
  app.post("/api/multiremi/autopilots/:id/run", async (c) => {
    const body = await readJson<RunAutopilotInput>(c);
    return c.json({ run: store.runAutopilot(c.req.param("id"), body) }, 201);
  });
  app.post("/api/multiremi/autopilots/:id/run-scheduled", (c) => {
    const run = scheduler?.trigger(c.req.param("id")) ?? store.runAutopilot(c.req.param("id"), { source: "schedule" });
    return c.json({ run }, 201);
  });
  app.get("/api/multiremi/scheduler", (c) => {
    return c.json({
      enabled: Boolean(scheduler),
      scheduledIds: scheduler?.scheduledIds() ?? [],
      total: scheduler?.scheduledCount() ?? 0,
    });
  });
  app.post("/api/multiremi/autopilots/:id/trigger", async (c) => {
    const body = await readJson<RunAutopilotInput>(c);
    return c.json({
      run: store.runAutopilot(c.req.param("id"), { ...body, source: body.source ?? "api" }),
    }, 201);
  });
  app.post("/api/multiremi/autopilots/:id/webhook", async (c) => {
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
      autopilot: autopilotCompatibilityResponse(autopilot),
      triggers: store.listAutopilotTriggers(autopilot.id).map(autopilotTriggerCompatibilityResponse),
    });
  });
  app.patch("/api/autopilots/:id", async (c) => {
    const body = await readJsonStrict<UpdateAutopilotInput & AutopilotCompatibilityUpdateInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = autopilotUpdateCompatibilityInput(body);
    if (isJsonApiError(input)) return c.json({ error: input.apiError }, input.statusCode);
    try {
      const autopilot = store.updateAutopilot(c.req.param("id"), input);
      scheduler?.sync();
      const response = autopilotCompatibilityResponse(autopilot);
      publishWorkspaceEvent(c, store, "autopilot:updated", autopilot.workspaceId, { autopilot: response });
      return c.json(response);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/autopilots/:id", (c) => {
    try {
      const autopilot = store.archiveAutopilot(c.req.param("id"));
      scheduler?.sync();
      publishWorkspaceEvent(c, store, "autopilot:deleted", autopilot.workspaceId, { autopilot_id: autopilot.id });
      return c.body(null, 204);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.post("/api/autopilots/:id/trigger", async (c) => {
    const body = await readJsonStrictAllowEmpty<RunAutopilotInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const autopilot = store.getAutopilot(c.req.param("id"));
    if (!autopilot) return c.json({ error: "autopilot not found" }, 404);
    if (autopilot.status !== "active") return c.json({ error: "autopilot is not active" }, 400);
    try {
      return c.json(autopilotRunCompatibilityResponse(store.runAutopilot(autopilot.id, { ...body, source: body.source ?? "manual" })));
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/autopilots/:id/runs", (c) => {
    const autopilot = store.getAutopilot(c.req.param("id"));
    if (!autopilot) return c.json({ error: "autopilot not found" }, 404);
    const limit = boundedQueryInt(c.req.query("limit"), 20, 100);
    const offset = Math.max(0, queryInt(c.req.query("offset"), 0));
    const runs = store.listAutopilotRuns(autopilot.id).slice(offset, offset + limit).map((run) => autopilotRunCompatibilityResponse(run, { slim: true }));
    return c.json({ runs, total: runs.length });
  });
  app.get("/api/autopilots/:id/runs/:runId", (c) => {
    const autopilot = store.getAutopilot(c.req.param("id"));
    if (!autopilot) return c.json({ error: "autopilot not found" }, 404);
    const run = store.getAutopilotRun(c.req.param("runId"));
    if (!run || run.autopilotId !== autopilot.id) return c.json({ error: "run not found" }, 404);
    return c.json(autopilotRunCompatibilityResponse(run));
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
    const body = await readJsonStrict<CreateAutopilotTriggerInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const invalid = validateAutopilotTriggerCompatibilityInput(body);
    if (invalid) return c.json({ error: invalid }, 400);
    try {
      const trigger = store.createAutopilotTrigger(c.req.param("id"), autopilotTriggerCreateCompatibilityInput(body));
      scheduler?.sync();
      const response = autopilotTriggerCompatibilityResponse(trigger);
      const autopilot = store.getAutopilot(trigger.autopilotId);
      if (autopilot) publishWorkspaceEvent(c, store, "autopilot:updated", autopilot.workspaceId, { autopilot_id: autopilot.id, trigger: response });
      return c.json(response, 201);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.patch("/api/autopilots/:id/triggers/:triggerId", async (c) => {
    const body = await readJsonStrict<UpdateAutopilotTriggerInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const current = store.getAutopilotTrigger(c.req.param("triggerId"));
    if (!current || current.autopilotId !== c.req.param("id")) return c.json({ error: "trigger not found" }, 404);
    const invalid = validateAutopilotTriggerUpdateCompatibilityInput(current, body);
    if (invalid) return c.json({ error: invalid }, 400);
    const input = autopilotTriggerUpdateCompatibilityInput(body);
    try {
      const trigger = store.updateAutopilotTrigger(c.req.param("id"), c.req.param("triggerId"), input);
      scheduler?.sync();
      const response = autopilotTriggerCompatibilityResponse(trigger);
      const autopilot = store.getAutopilot(trigger.autopilotId);
      if (autopilot) publishWorkspaceEvent(c, store, "autopilot:updated", autopilot.workspaceId, { autopilot_id: autopilot.id, trigger: response });
      return c.json(response);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/autopilots/:id/triggers/:triggerId", (c) => {
    const deleted = store.deleteAutopilotTrigger(c.req.param("id"), c.req.param("triggerId"));
    if (!deleted) return c.json({ error: "trigger not found" }, 404);
    scheduler?.sync();
    return c.body(null, 204);
  });
  app.post("/api/autopilots/:id/triggers/:triggerId/rotate-webhook-token", (c) => {
    const current = store.getAutopilotTrigger(c.req.param("triggerId"));
    if (!current || current.autopilotId !== c.req.param("id")) return c.json({ error: "trigger not found" }, 404);
    if (current.kind !== "webhook") return c.json({ error: "trigger is not a webhook trigger" }, 400);
    try {
      return c.json(autopilotTriggerCompatibilityResponse(store.rotateAutopilotTriggerWebhookToken(c.req.param("id"), c.req.param("triggerId"))));
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.put("/api/autopilots/:id/triggers/:triggerId/signing-secret", async (c) => {
    const body = await readJsonStrict<{ signing_secret?: string | null }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const current = store.getAutopilotTrigger(c.req.param("triggerId"));
    if (!current || current.autopilotId !== c.req.param("id")) return c.json({ error: "trigger not found" }, 404);
    if (current.kind !== "webhook") return c.json({ error: "trigger is not a webhook trigger" }, 400);
    const signingSecret = String(body.signing_secret ?? "").trim();
    if (signingSecret && signingSecret.length < 16) return c.json({ error: "signing_secret must be at least 16 characters" }, 400);
    try {
      const trigger = store.setAutopilotTriggerSigningSecret(
        c.req.param("id"),
        c.req.param("triggerId"),
        signingSecret,
      );
      const response = autopilotTriggerCompatibilityResponse(trigger);
      const autopilot = store.getAutopilot(trigger.autopilotId);
      if (autopilot) publishWorkspaceEvent(c, store, "autopilot:updated", autopilot.workspaceId, { autopilot_id: autopilot.id, trigger: response });
      return c.json(response);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });

  app.get("/api/multiremi/labels", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const labels = store.listLabels(workspaceId);
    return c.json({ labels, total: labels.length });
  });
  app.post("/api/multiremi/labels", async (c) => {
    const body = await readJson<CreateLabelInput>(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
    return c.json({ label: store.createLabel(body) }, 201);
  });
  app.get("/api/multiremi/labels/:id", (c) => {
    const label = store.getLabel(c.req.param("id"));
    if (!label) return c.json({ error: "label not found" }, 404);
    return c.json({ label });
  });
  app.patch("/api/multiremi/labels/:id", async (c) => {
    const body = await readJson<UpdateLabelInput>(c);
    return c.json({ label: store.updateLabel(c.req.param("id"), body) });
  });
  app.put("/api/multiremi/labels/:id", async (c) => {
    const body = await readJson<UpdateLabelInput>(c);
    return c.json({ label: store.updateLabel(c.req.param("id"), body) });
  });
  app.delete("/api/multiremi/labels/:id", (c) => {
    return c.json({ label: store.deleteLabel(c.req.param("id")) });
  });

  app.get("/api/labels", (c) => {
    const workspaceId = c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const labels = store.listLabels(workspaceId);
    return c.json({ labels: labels.map(labelCompatibilityResponse), total: labels.length });
  });
  app.post("/api/labels", async (c) => {
    const body = await readJsonStrict<CreateLabelInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspace_id ?? body.workspaceId ?? "local");
    if (denied) return denied;
    try {
      return c.json(labelCompatibilityResponse(store.createLabel(labelCreateCompatibilityInput(body))), 201);
    } catch (error) {
      return labelCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/labels/:id", (c) => {
    const label = store.getLabel(c.req.param("id"));
    if (!label) return c.json({ error: "label not found" }, 404);
    return c.json(labelCompatibilityResponse(label));
  });
  app.put("/api/labels/:id", async (c) => {
    const body = await readJsonStrict<UpdateLabelInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(labelCompatibilityResponse(store.updateLabel(c.req.param("id"), body)));
    } catch (error) {
      return labelCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/labels/:id", (c) => {
    try {
      store.deleteLabel(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return labelCompatibilityErrorResponse(c, error);
    }
  });

  app.get("/api/multiremi/pins", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = c.req.query("userId") ?? currentRequestUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    const pins = store.listPinnedItems(workspaceId, userId);
    return c.json({ pins, total: pins.length });
  });
  app.post("/api/multiremi/pins", async (c) => {
    const body = await readJson<CreatePinnedItemInput>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = body.userId ?? body.user_id ?? currentRequestUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    return c.json({ pin: store.createPinnedItem({ ...body, workspaceId, userId }) }, 201);
  });
  app.put("/api/multiremi/pins/reorder", async (c) => {
    const body = await readJson<{ workspaceId?: string; workspace_id?: string; userId?: string; user_id?: string; items?: ReorderPinnedItemInput[] }>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = body.userId ?? body.user_id ?? currentRequestUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    const pins = store.reorderPinnedItems(workspaceId, userId, body.items ?? []);
    return c.json({ pins, total: pins.length });
  });
  app.delete("/api/multiremi/pins/:itemType/:itemId", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = c.req.query("userId") ?? currentRequestUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    store.deletePinnedItem(workspaceId, userId, c.req.param("itemType"), c.req.param("itemId"));
    return c.json({ ok: true });
  });

  app.get("/api/pins", (c) => {
    const workspaceId = compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = compatibilityUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    return c.json(store.listPinnedItems(workspaceId, userId).map(pinCompatibilityResponse));
  });
  app.post("/api/pins", async (c) => {
    const body = await readJsonStrict<{ id?: string; workspace_id?: string | null; user_id?: string | null; item_type?: string; item_id?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = cleanString(body.workspace_id) ?? compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = cleanString(body.user_id) ?? compatibilityUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    try {
      const pin = store.createPinnedItem({
        id: body.id,
        workspace_id: workspaceId,
        user_id: userId,
        item_type: body.item_type,
        item_id: body.item_id,
      });
      return c.json(pinCompatibilityResponse(pin), 201);
    } catch (error) {
      return pinCompatibilityErrorResponse(c, error);
    }
  });
  app.put("/api/pins/reorder", async (c) => {
    const body = await readJsonStrict<{ workspace_id?: string; user_id?: string; items?: ReorderPinnedItemInput[] }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = body.workspace_id ?? compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = body.user_id ?? compatibilityUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    const pins = store.reorderPinnedItems(workspaceId, userId, body.items ?? []);
    return c.json(pins.map(pinCompatibilityResponse));
  });
  app.delete("/api/pins/:itemType/:itemId", (c) => {
    const workspaceId = compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = compatibilityUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    store.deletePinnedItem(workspaceId, userId, c.req.param("itemType"), c.req.param("itemId"));
    return c.body(null, 204);
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

  app.get("/api/multiremi/issues", (c) => {
    const query = issueListQuery(store, c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    const { issues } = listIssuesResponse(query);
    return c.json({ issues });
  });
  app.get("/api/issues", (c) => {
    const query = issueListQuery(store, c, "compat");
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    const issues = store.listIssues(query).map((issue) => issueCompatibilityResponse(issue, { includeLabels: true }));
    return c.json({ issues, total: issues.length });
  });
  app.get("/api/multiremi/issues/grouped", (c) => {
    const query = issueListQuery(store, c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listGroupedIssues(query));
  });
  app.get("/api/issues/grouped", (c) => {
    const query = issueListQuery(store, c, "compat");
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listGroupedIssues(query));
  });
  app.get("/api/assignee-frequency", (c) => {
    const query = assigneeFrequencyQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listAssigneeFrequency(query));
  });
  app.get("/api/multiremi/assignee-frequency", (c) => {
    const query = assigneeFrequencyQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listAssigneeFrequency(query));
  });
  app.get("/api/multiremi/issues/search", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const result = store.searchIssues({
      q: c.req.query("q") ?? "",
      workspaceId,
      includeClosed: c.req.query("include_closed") === "true" || c.req.query("includeClosed") === "true",
      limit: parseOptionalInt(c.req.query("limit")),
      offset: parseOptionalInt(c.req.query("offset")),
    });
    return c.json(result);
  });
  app.get("/api/issues/search", (c) => {
    const workspaceId = c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const result = store.searchIssues({
        q: c.req.query("q") ?? "",
        workspaceId,
        includeClosed: c.req.query("include_closed") === "true",
        limit: parseOptionalInt(c.req.query("limit")),
        offset: parseOptionalInt(c.req.query("offset")),
      });
      c.header("X-Total-Count", String(result.total));
      return c.json({
        issues: result.issues.map(issueSearchCompatibilityResponse),
        total: result.total,
      });
    } catch (err) {
      const response = issueSearchErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.get("/api/multiremi/issues/child-progress", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const progress = store.listChildIssueProgress(workspaceId);
    return c.json({ progress, total: progress.length });
  });
  app.get("/api/issues/child-progress", (c) => {
    const workspaceId = c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const progress = store.listChildIssueProgress(workspaceId);
    return c.json({ progress, total: progress.length });
  });
  app.get("/api/issues/children", (c) => {
    const parentIds = splitQueryList(c.req.query("parent_ids"));
    const issues = parentIds.flatMap((parentId) => store.listChildIssues(parentId));
    return c.json({ issues, total: issues.length });
  });
  app.get("/api/multiremi/issues/children", (c) => {
    const parentIds = splitQueryList(c.req.query("parent_ids") ?? c.req.query("parentIds"));
    const issues = parentIds.flatMap((parentId) => store.listChildIssues(parentId));
    return c.json({ issues, total: issues.length });
  });
  app.post("/api/multiremi/issues/batch-update", async (c) => {
    const body = await readJson<BatchUpdateIssuesInput>(c);
    return c.json(store.batchUpdateIssues(body));
  });
  app.post("/api/issues/batch-update", async (c) => {
    const body = await readJson<BatchUpdateIssuesInput>(c);
    try {
      const result = store.batchUpdateIssues(issueBatchUpdateCompatibilityInput(body));
      return c.json({ updated: result.updated });
    } catch (err) {
      if (err instanceof Error && err.message === "issue_ids is required") return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.post("/api/multiremi/issues/batch-delete", async (c) => {
    const body = await readJson<BatchDeleteIssuesInput>(c);
    return c.json(store.batchDeleteIssues(body));
  });
  app.post("/api/issues/batch-delete", async (c) => {
    const body = await readJson<BatchDeleteIssuesInput>(c);
    try {
      return c.json(store.batchDeleteIssues(issueBatchDeleteCompatibilityInput(body)));
    } catch (err) {
      if (err instanceof Error && err.message === "issue_ids is required") return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.post("/api/multiremi/issues", async (c) => {
    const body = await readJson<CreateIssueWithTaskInput>(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
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
    if (assigneeId) {
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
    const body = await readJsonStrict<CreateIssueWithTaskInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (!String(body.title ?? "").trim()) return c.json({ error: "title is required" }, 400);
    const issueInput = withIssueCreateRequestContext(c, body);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issueInput.workspace_id ?? "local");
    if (denied) return denied;
    try {
      const issue = store.createIssue(issueInput);
      let response = issueCompatibilityResponse(issue);
      publishIssueCreated(c, store, issue, response);
      // go-compat (maybeEnqueueOnAssign): creating an issue assigned to an agent/squad
      // dispatches a task, unless it's in backlog (a parking lot for pre-assignment).
      // If no runnable agent is available the assignment stands without a task, matching
      // the Go server's "not ready → skip" behavior.
      if (issue.assigneeType && issue.assigneeId && issue.status !== "backlog") {
        try {
          const assigned = store.assignIssue(issue.id, {
            assigneeType: issue.assigneeType,
            assigneeId: issue.assigneeId,
          });
          response = issueCompatibilityResponse(assigned.issue);
        } catch (err) {
          log.warn(`assign-on-create dispatch skipped for ${issue.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return c.json(response, 201);
    } catch (err) {
      const response = issueErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.post("/api/multiremi/issues/quick-create", async (c) => {
    const body = await readJson<QuickCreateIssueInput>(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
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
    const input = issueQuickCreateCompatibilityInput(body);
    const denied = denyCurrentUserWorkspaceAccess(c, store, input.workspaceId ?? input.workspace_id ?? "local");
    if (denied) return denied;
    const result = safeQuickCreateIssue(store, input);
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json({ task_id: result.task.id }, 202);
  });
  app.get("/api/multiremi/issues/:id", (c) => {
    const issueRef = issueFromParam(store, c);
    const issue = issueRef ? store.getIssueWithTasks(issueRef.id) : null;
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
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
    const issueRef = issueFromParam(store, c, "id", "compat");
    const issue = issueRef ? store.getIssueWithTasks(issueRef.id) : null;
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const response = issueCompatibilityResponse(issue, { includeLabels: true });
    if (issue.reactions.length) response.reactions = issue.reactions.map(issueReactionCompatibilityResponse);
    if (issue.attachments.length) response.attachments = issue.attachments.map(issueDetailAttachmentCompatibilityResponse);
    return c.json(response);
  });
  app.get("/api/multiremi/issues/:id/timeline", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const response = issueTimelineResponse(store, issue.id, c);
    if (!response) return c.json({ error: "issue not found" }, 404);
    return c.json(response);
  });
  app.get("/api/issues/:id/timeline", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const response = issueTimelineCompatibilityResponse(store, issue.id, c);
    if (!response) return c.json({ error: "issue not found" }, 404);
    return c.json(response);
  });
  app.get("/api/issues/:id/active-task", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const tasks = store.listTasksForIssue(issue.id)
      .filter((task) => isActiveTaskStatus(task.status))
      .map((task) => taskCompatibilityResponse(task));
    return c.json({ tasks });
  });
  app.get("/api/issues/:id/task-runs", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listTasksForIssue(issue.id).map((task) => taskCompatibilityResponse(task)));
  });
  app.get("/api/issues/:id/usage", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(issueUsageResponse(store, issue));
  });
  app.post("/api/issues/:id/rerun", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ agent_id?: string; agentId?: string; prompt?: string }>(c);
    const result = safeRerunIssue(store, issue.id, body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(taskCompatibilityResponse(result.task), 202);
  });
  app.post("/api/issues/:id/tasks/:taskId/cancel", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    const task = issue ? store.getTaskByRef(c.req.param("taskId"), { issueId: issue.id }) : null;
    if (!issue || !task || task.issueId !== issue.id) return c.json({ error: "task not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(taskCompatibilityResponse(store.cancelTask(task.id)));
  });
  app.post("/api/issues/:id/squad-evaluated", async (c) => {
    const body = await readJson<{
      outcome?: string;
      reason?: string | null;
      task_id?: string | null;
      taskId?: string | null;
      actor_id?: string | null;
      actorId?: string | null;
    }>(c);
    try {
      const issue = issueFromParam(store, c, "id", "compat");
      if (!issue) return c.json({ error: "issue not found" }, 404);
      const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
      if (denied) return denied;
      const taskToken = currentTaskAccessToken(c);
      const activity = store.recordSquadLeaderEvaluation(issue.id, {
        outcome: body.outcome ?? "",
        reason: body.reason ?? null,
        taskId: taskToken?.taskId ?? c.req.header("X-Task-ID") ?? body.task_id ?? body.taskId ?? null,
        actorId: taskToken?.agentId ?? c.req.header("X-Agent-ID") ?? body.actor_id ?? body.actorId ?? null,
      });
      return c.json({
        ...activity,
        issue_id: activity.issueId,
        actor_type: activity.actorType,
        actor_id: activity.actorId,
        created_at: activity.createdAt,
      }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Issue not found")) return c.json({ error: "issue not found" }, 404);
      if (message === "squad not found") return c.json({ error: message }, 404);
      if (message === "only the squad leader agent can record evaluations") return c.json({ error: message }, 403);
      return c.json({ error: message }, 400);
    }
  });
  app.get("/api/multiremi/issues/:id/children", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const children = store.listChildIssues(issue.id);
    return c.json({ issues: children, total: children.length });
  });
  app.get("/api/issues/:id/children", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const children = store.listChildIssues(issue.id);
    return c.json({ issues: children, total: children.length });
  });
  app.get("/api/multiremi/issues/:id/dependencies", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const dependencies = store.listIssueDependencies(issue.id);
    return c.json({ dependencies, total: dependencies.length });
  });
  app.get("/api/issues/:id/dependencies", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const dependencies = store.listIssueDependencies(issue.id).map(issueDependencyCompatibilityResponse);
    return c.json({ dependencies, total: dependencies.length });
  });
  app.post("/api/multiremi/issues/:id/dependencies", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateIssueDependencyInput>(c);
    return c.json({ dependency: store.createIssueDependency(issue.id, body) }, 201);
  });
  app.post("/api/issues/:id/dependencies", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateIssueDependencyInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json({ dependency: issueDependencyCompatibilityResponse(store.createIssueDependency(issue.id, body)) }, 201);
    } catch (err) {
      const response = issueDependencyErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.delete("/api/multiremi/issues/:id/dependencies/:dependencyId", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    store.deleteIssueDependency(issue.id, c.req.param("dependencyId"));
    return c.json({ ok: true });
  });
  app.delete("/api/issues/:id/dependencies/:dependencyId", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    try {
      store.deleteIssueDependency(issue.id, c.req.param("dependencyId"));
      return c.json({ status: "ok" });
    } catch (err) {
      const response = issueDependencyErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.patch("/api/multiremi/issues/:id", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<UpdateIssueInput>(c);
    const updated = store.updateIssue(issue.id, body);
    return c.json({ issue: maybeDispatchOnIssueUpdate(store, issue, updated, body) });
  });
  const updateIssueCompatibilityRoute = async (c: Context) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<UpdateIssueInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = issueUpdateCompatibilityInput(body);
    try {
      const updated = store.updateIssue(issue.id, input);
      const dispatched = maybeDispatchOnIssueUpdate(store, issue, updated, input);
      const response = issueCompatibilityResponse(dispatched);
      publishIssueUpdated(c, store, issue, dispatched, input, response);
      return c.json(response);
    } catch (err) {
      const response = issueErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  };
  app.patch("/api/issues/:id", updateIssueCompatibilityRoute);
  app.put("/api/issues/:id", updateIssueCompatibilityRoute);
  app.delete("/api/multiremi/issues/:id", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    if (!store.deleteIssue(issue.id)) return c.json({ error: "issue not found" }, 404);
    return c.json({ ok: true });
  });
  app.delete("/api/issues/:id", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    if (!store.deleteIssue(issue.id)) return c.json({ error: "issue not found" }, 404);
    return c.body(null, 204);
  });
  app.post("/api/multiremi/issues/:id/assign", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<AssignIssueInput>(c);
    return c.json(store.assignIssue(issue.id, body));
  });
  app.get("/api/multiremi/issues/:id/comments", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const input = parseIssueCommentListQuery(c);
    if ("error" in input) return c.json({ error: input.error }, input.status);
    try {
      const result = store.listIssueCommentsForGoCli(issue.id, input);
      setIssueCommentCursorHeaders(c, result);
      return c.json({ comments: result.comments });
    } catch (err) {
      return issueCommentListErrorResponse(c, err);
    }
  });
  app.get("/api/issues/:id/comments", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const input = parseIssueCommentListQuery(c);
    if ("error" in input) return c.json({ error: input.error }, input.status);
    try {
      const result = store.listIssueCommentsForGoCli(issue.id, input);
      setIssueCommentCursorHeaders(c, result);
      return c.json(result.comments.map(commentCompatibilityResponse));
    } catch (err) {
      return issueCommentListErrorResponse(c, err);
    }
  });
  app.post("/api/multiremi/issues/:id/comments", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateIssueCommentInput>(c);
    return c.json({ comment: store.createIssueComment(issue.id, issueCommentCreateInput(c, body)) }, 201);
  });
  app.post("/api/issues/:id/comments", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateIssueCommentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(commentCompatibilityResponse(store.createIssueComment(issue.id, issueCommentCreateInput(c, body))), 201);
    } catch (error) {
      return issueCommentMutationErrorResponse(c, error);
    }
  });
  app.get("/api/multiremi/issues/:id/reactions", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json({ reactions: store.listIssueReactions(issue.id) });
  });
  app.get("/api/issues/:id/reactions", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listIssueReactions(issue.id).map(issueReactionCompatibilityResponse));
  });
  app.post("/api/multiremi/issues/:id/reactions", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateMultiremiReactionInput>(c);
    return c.json({ reaction: store.addIssueReaction(issue.id, normalizeReactionInput(body)) }, 201);
  });
  app.post("/api/issues/:id/reactions", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateMultiremiReactionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = normalizeReactionInput(body);
    if (!input.emoji) return c.json({ error: "emoji is required" }, 400);
    return c.json(issueReactionCompatibilityResponse(store.addIssueReaction(issue.id, input)), 201);
  });
  app.delete("/api/multiremi/issues/:id/reactions", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateMultiremiReactionInput>(c);
    store.removeIssueReaction(issue.id, normalizeReactionInput(body));
    return c.json({ ok: true });
  });
  app.delete("/api/issues/:id/reactions", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateMultiremiReactionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = normalizeReactionInput(body);
    if (!input.emoji) return c.json({ error: "emoji is required" }, 400);
    store.removeIssueReaction(issue.id, input);
    return c.body(null, 204);
  });
  app.get("/api/multiremi/issues/:id/attachments", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json({ attachments: store.listAttachmentsForIssue(issue.id) });
  });
  app.get("/api/issues/:id/attachments", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listAttachmentsForIssue(issue.id).map(attachmentCompatibilityResponse));
  });
  app.post("/api/multiremi/issues/:id/attachments", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<CreateAttachmentInput>(c);
    const attachment = store.createAttachment({ ...body, issueId: issue.id });
    return c.json({ attachment }, 201);
  });
  app.get("/api/multiremi/issues/:id/labels", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const labels = store.listLabelsForIssue(issue.id);
    return c.json({ labels, total: labels.length });
  });
  app.post("/api/multiremi/issues/:id/labels", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ labelId?: string; label_id?: string }>(c);
    const labels = store.attachLabelToIssue(issue.id, body.labelId ?? body.label_id ?? "");
    return c.json({ labels, total: labels.length }, 201);
  });
  app.delete("/api/multiremi/issues/:id/labels/:labelId", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const labels = store.detachLabelFromIssue(issue.id, c.req.param("labelId"));
    return c.json({ labels, total: labels.length });
  });
  app.get("/api/issues/:id/labels", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const labels = store.listLabelsForIssue(issue.id);
    return c.json({ labels: labels.map(labelCompatibilityResponse) });
  });
  app.post("/api/issues/:id/labels", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ label_id?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const labelId = body.label_id ?? "";
    if (!labelId) return c.json({ error: "label_id is required" }, 400);
    try {
      const labels = store.attachLabelToIssue(issue.id, labelId);
      return c.json({ labels: labels.map(labelCompatibilityResponse) });
    } catch (error) {
      return labelCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/issues/:id/labels/:labelId", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    try {
      const labels = store.detachLabelFromIssue(issue.id, c.req.param("labelId"));
      return c.json({ labels: labels.map(labelCompatibilityResponse) });
    } catch (error) {
      return labelCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/multiremi/issues/:id/subscribers", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json({ subscribers: store.listIssueSubscribers(issue.id) });
  });
  app.get("/api/issues/:id/subscribers", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listIssueSubscribers(issue.id).map(issueSubscriberCompatibilityResponse));
  });
  app.post("/api/multiremi/issues/:id/subscribers", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ memberId?: string; reason?: unknown }>(c);
    return c.json({
      subscriber: store.addIssueSubscriber(issue.id, body.memberId ?? "", normalizeSubscriptionReason(body.reason)),
    }, 201);
  });
  app.post("/api/issues/:id/subscribe", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ member_id?: string; user_id?: string; user_type?: string; reason?: unknown }>(c);
    const target = issueSubscriberTarget(c, body);
    if ("error" in target) return c.json({ error: target.error }, target.status);
    try {
      store.addTypedIssueSubscriber(issue.id, target.userType, target.userId, normalizeSubscriptionReason(body.reason));
    } catch (error) {
      return issueSubscriberTargetErrorResponse(c, error);
    }
    store.emitWorkspaceEvent({
      type: "subscriber:added",
      workspaceId: issue.workspaceId,
      actorType: issueSubscriberCaller(c).actorType,
      actorId: issueSubscriberCaller(c).actorId,
      payload: {
        issue_id: issue.id,
        user_type: target.userType,
        user_id: target.userId,
        reason: "manual",
      },
    });
    return c.json({ subscribed: true });
  });
  app.post("/api/issues/:id/unsubscribe", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ member_id?: string; user_id?: string; user_type?: string }>(c);
    const target = issueSubscriberTarget(c, body);
    if ("error" in target) return c.json({ error: target.error }, target.status);
    try {
      store.removeTypedIssueSubscriber(issue.id, target.userType, target.userId);
    } catch (error) {
      return issueSubscriberTargetErrorResponse(c, error);
    }
    const caller = issueSubscriberCaller(c);
    store.emitWorkspaceEvent({
      type: "subscriber:removed",
      workspaceId: issue.workspaceId,
      actorType: caller.actorType,
      actorId: caller.actorId,
      payload: {
        issue_id: issue.id,
        user_type: target.userType,
        user_id: target.userId,
      },
    });
    return c.json({ subscribed: false });
  });
  app.delete("/api/multiremi/issues/:id/subscribers/:memberId", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    store.removeIssueSubscriber(issue.id, c.req.param("memberId"));
    return c.json({ ok: true });
  });
  app.get("/api/multiremi/issues/:id/metadata", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json({ metadata: store.listIssueMetadata(issue.id) });
  });
  app.get("/api/issues/:id/metadata", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.listIssueMetadata(issue.id));
  });
  app.put("/api/multiremi/issues/:id/metadata/:key", async (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ value?: unknown }>(c);
    return c.json({ metadata: store.setIssueMetadataKey(issue.id, c.req.param("key"), body.value) });
  });
  app.put("/api/issues/:id/metadata/:key", async (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const body = await readJson<{ value?: unknown }>(c);
    return c.json(store.setIssueMetadataKey(issue.id, c.req.param("key"), body.value));
  });
  app.delete("/api/multiremi/issues/:id/metadata/:key", (c) => {
    const issue = issueFromParam(store, c);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json({ metadata: store.deleteIssueMetadataKey(issue.id, c.req.param("key")) });
  });
  app.delete("/api/issues/:id/metadata/:key", (c) => {
    const issue = issueFromParam(store, c, "id", "compat");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    return c.json(store.deleteIssueMetadataKey(issue.id, c.req.param("key")));
  });

  app.get("/api/multiremi/inbox", (c) => {
    const items = store.listInboxItems(c.req.query("memberId"));
    return c.json({ items, total: items.length, unread: items.filter((item) => !item.read).length });
  });
  app.post("/api/multiremi/inbox/:id/read", (c) => {
    return c.json({ item: store.markInboxItemRead(c.req.param("id")) });
  });
  app.post("/api/multiremi/inbox/:id/archive", (c) => {
    return c.json({ item: store.archiveInboxItem(c.req.param("id")) });
  });
  app.get("/api/inbox", (c) => c.json(store.listInboxItems(compatibilityInboxMemberId(c)).map(inboxCompatibilityResponse)));
  app.get("/api/inbox/unread-count", (c) => c.json({ count: store.countUnreadInboxItems(compatibilityInboxMemberId(c)) }));
  app.post("/api/inbox/mark-all-read", (c) => c.json({ count: store.markAllInboxItemsRead(compatibilityInboxMemberId(c)) }));
  app.post("/api/inbox/archive-all", (c) => c.json({ count: store.archiveAllInboxItems(compatibilityInboxMemberId(c), "all") }));
  app.post("/api/inbox/archive-all-read", (c) => c.json({ count: store.archiveAllInboxItems(compatibilityInboxMemberId(c), "read") }));
  app.post("/api/inbox/archive-completed", (c) => c.json({ count: store.archiveAllInboxItems(compatibilityInboxMemberId(c), "completed") }));
  app.post("/api/inbox/:id/read", (c) => c.json(inboxCompatibilityResponse(store.markInboxItemRead(c.req.param("id")))));
  app.post("/api/inbox/:id/archive", (c) => c.json(inboxCompatibilityResponse(store.archiveInboxItem(c.req.param("id")))));

  app.put("/api/multiremi/comments/:id", async (c) => {
    const body = await readJson<UpdateIssueCommentInput>(c);
    return c.json({ comment: store.updateIssueComment(c.req.param("id"), body) });
  });
  app.patch("/api/multiremi/comments/:id", async (c) => {
    const body = await readJson<UpdateIssueCommentInput>(c);
    return c.json({ comment: store.updateIssueComment(c.req.param("id"), body) });
  });
  app.delete("/api/multiremi/comments/:id", (c) => {
    store.deleteIssueComment(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/multiremi/comments/:id/resolve", async (c) => {
    const body = await readJson<{ actorType?: string; actor_type?: string; actorId?: string | null; actor_id?: string | null }>(c);
    return c.json({
      comment: store.resolveIssueComment(c.req.param("id"), {
        actorType: body.actorType ?? body.actor_type,
        actorId: body.actorId ?? body.actor_id,
      }),
    });
  });
  app.delete("/api/multiremi/comments/:id/resolve", (c) => {
    return c.json({ comment: store.unresolveIssueComment(c.req.param("id")) });
  });
  app.put("/api/comments/:id", async (c) => {
    const body = await readJsonStrict<UpdateIssueCommentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(commentCompatibilityResponse(store.updateIssueComment(c.req.param("id"), body)));
    } catch (error) {
      return issueCommentMutationErrorResponse(c, error);
    }
  });
  app.delete("/api/comments/:id", (c) => {
    try {
      store.deleteIssueComment(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return issueCommentMutationErrorResponse(c, error);
    }
  });
  app.post("/api/comments/:id/resolve", async (c) => {
    const body = await readJsonStrictAllowEmpty<{ actorType?: string; actor_type?: string; actorId?: string | null; actor_id?: string | null }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(commentCompatibilityResponse(store.resolveIssueComment(c.req.param("id"), {
        actorType: body.actorType ?? body.actor_type,
        actorId: body.actorId ?? body.actor_id,
      })));
    } catch (error) {
      return issueCommentMutationErrorResponse(c, error);
    }
  });
  app.delete("/api/comments/:id/resolve", (c) => {
    try {
      return c.json(commentCompatibilityResponse(store.unresolveIssueComment(c.req.param("id"))));
    } catch (error) {
      return issueCommentMutationErrorResponse(c, error);
    }
  });
  app.post("/api/comments/:id/reactions", async (c) => {
    const body = await readJsonStrict<CreateMultiremiReactionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = normalizeReactionInput(body);
    if (!input.emoji) return c.json({ error: "emoji is required" }, 400);
    return c.json(commentReactionCompatibilityResponse(store.addCommentReaction(c.req.param("id"), input)), 201);
  });
  app.delete("/api/comments/:id/reactions", async (c) => {
    const body = await readJsonStrict<CreateMultiremiReactionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = normalizeReactionInput(body);
    if (!input.emoji) return c.json({ error: "emoji is required" }, 400);
    store.removeCommentReaction(c.req.param("id"), input);
    return c.body(null, 204);
  });

  app.get("/api/multiremi/comments/:id/reactions", (c) => {
    return c.json({ reactions: store.listCommentReactions(c.req.param("id")) });
  });
  app.post("/api/multiremi/comments/:id/reactions", async (c) => {
    const body = await readJson<CreateMultiremiReactionInput>(c);
    return c.json({ reaction: store.addCommentReaction(c.req.param("id"), normalizeReactionInput(body)) }, 201);
  });
  app.delete("/api/multiremi/comments/:id/reactions", async (c) => {
    const body = await readJson<CreateMultiremiReactionInput>(c);
    store.removeCommentReaction(c.req.param("id"), normalizeReactionInput(body));
    return c.json({ ok: true });
  });
  app.get("/api/multiremi/comments/:id/attachments", (c) => {
    const comment = store.getIssueComment(c.req.param("id"));
    if (!comment) return c.json({ attachments: [] });
    const issue = store.getIssue(comment.issueId);
    if (issue) {
      const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
      if (denied) return denied;
    }
    return c.json({ attachments: store.listAttachmentsForComment(comment.id) });
  });
  app.get("/api/multiremi/attachments/:id", (c) => {
    const attachment = store.getAttachment(c.req.param("id"));
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    const denied = denyAttachmentAccess(c, store, attachment);
    if (denied) return denied;
    return c.json({ attachment });
  });
  app.post("/api/multiremi/attachments", async (c) => {
    const body = await readJson<CreateAttachmentInput>(c);
    const workspaceId = cleanString(body.workspaceId) ?? cleanString(body.workspace_id) ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json({ attachment: store.createAttachment(body) }, 201);
  });

  app.post("/api/upload-file", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "missing file field" }, 400);
    if (file.size > MAX_UPLOAD_SIZE) return c.json({ error: "file too large" }, 413);
    const issueRef = stringFormValue(form.get("issueId") ?? form.get("issue_id"));
    const issue = issueRef ? store.getIssueByRef(issueRef) : null;
    if (issueRef && !issue) return c.json({ error: "invalid issue_id" }, 403);
    const commentId = stringFormValue(form.get("commentId") ?? form.get("comment_id"));
    const comment = commentId ? store.getIssueComment(commentId) : null;
    if (commentId && !comment) return c.json({ error: "invalid comment_id" }, 403);
    if (issue && comment && comment.issueId !== issue.id) return c.json({ error: "invalid comment_id" }, 403);
    const chatSessionId = stringFormValue(form.get("chatSessionId") ?? form.get("chat_session_id"));
    const chatSession = chatSessionId ? loadChatSessionForCurrentUser(c, store, chatSessionId) : null;
    if (chatSession instanceof Response) return chatSession;
    const workspaceId = issue?.workspaceId
      ?? (comment ? store.getIssue(comment.issueId)?.workspaceId : null)
      ?? (chatSession ? chatSession.session.workspaceId : null)
      ?? stringFormValue(form.get("workspaceId") ?? form.get("workspace_id"))
      ?? c.req.header("X-Workspace-ID")
      ?? "local";
    // Go file.go UploadFile validates workspace membership before writing. The chat
    // path is already gated by loadChatSessionForCurrentUser; gate every other path
    // so a token scoped to another workspace cannot create rows/files in this one.
    const uploadDenied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (uploadDenied) return uploadDenied;
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
      issueId: issue?.id ?? comment?.issueId ?? null,
      commentId,
      chatSessionId: chatSession?.session.id ?? null,
      uploaderType,
      uploaderId,
      filename: safeName,
      url: `/api/attachments/${attachmentId}/content`,
      contentType: file.type || detectContentTypeFromFilename(safeName),
      sizeBytes: file.size,
    });
    return c.json({ attachment, ...attachmentCompatibilityResponse(attachment) });
  });

  app.get("/api/attachments/:id", (c) => {
    const attachment = store.getAttachment(c.req.param("id"));
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    const denied = denyAttachmentAccess(c, store, attachment);
    if (denied) return denied;
    return c.json({ attachment, ...attachmentCompatibilityResponse(attachment) });
  });

  app.get("/api/attachments/:id/download", async (c) => {
    const attachment = store.getAttachment(c.req.param("id"));
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    const denied = denyAttachmentAccess(c, store, attachment);
    if (denied) return denied;
    if (!attachment.url.startsWith("/api/attachments/")) {
      return c.redirect(attachment.url);
    }
    return localAttachmentFileResponse(attachment);
  });

  app.get("/api/attachments/:id/content", async (c) => {
    const attachment = store.getAttachment(c.req.param("id"));
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    const denied = denyAttachmentAccess(c, store, attachment);
    if (denied) return denied;
    if (!attachment.url.startsWith("/api/attachments/")) {
      return c.redirect(attachment.url);
    }
    return localAttachmentFileResponse(attachment);
  });

  app.delete("/api/attachments/:id", async (c) => {
    const existing = store.getAttachment(c.req.param("id"));
    if (!existing) return c.json({ ok: true });
    const denied = denyAttachmentAccess(c, store, existing);
    if (denied) return denied;
    // Go file.go DeleteAttachment: only the uploader or a workspace admin/owner may
    // delete a non-chat attachment. Chat attachments are already creator-gated by
    // denyAttachmentAccess above (the creator is the uploader).
    if (!existing.chatSessionId) {
      const role = currentWorkspaceRole(c, store, existing.workspaceId);
      const isUploader = existing.uploaderType === "member" && existing.uploaderId === currentRequestUserId(c);
      const isAdmin = role === "owner" || role === "admin";
      if (!isUploader && !isAdmin) {
        return c.json({ error: "not authorized to delete this attachment" }, 403);
      }
    }
    const attachment = store.deleteAttachment(c.req.param("id"));
    if (!attachment) return c.json({ ok: true });
    if (attachment.url.startsWith("/api/attachments/")) {
      const filePath = uploadedAttachmentPath(attachment);
      if (filePath) await unlink(filePath).catch(() => undefined);
    }
    return c.json({ ok: true, attachment });
  });

  app.get("/api/multiremi/chats", (c) => {
    const workspaceId = requestedChatWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const sessions = store.listChatSessions(workspaceId, {
      creatorId: currentRequestUserId(c),
      includeArchived: c.req.query("status") === "all",
    }).filter((session) => canCurrentUserAccessChatSessionAgent(c, store, session));
    return c.json({ sessions, total: sessions.length });
  });
  app.post("/api/multiremi/chats", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    const input = withChatSessionRequestContext(c, store, body);
    if (input instanceof Response) return input;
    return c.json({ session: store.createChatSession(input) }, 201);
  });
  app.get("/api/multiremi/chats/:id", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { session } = loaded;
    return c.json({ session, messages: store.listChatMessages(session.id) });
  });
  app.patch("/api/multiremi/chats/:id", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<UpdateChatSessionInput>(c);
    return c.json({ session: store.updateChatSession(loaded.session.id, body) });
  });
  app.get("/api/multiremi/chats/:id/messages", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json({ messages: store.listChatMessages(loaded.session.id) });
  });
  app.post("/api/multiremi/chats/:id/messages", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<SendChatMessageInput>(c);
    const message = normalizeSendChatMessageInput(c, body);
    if (message instanceof Response) return message;
    return c.json(store.sendChatMessage(loaded.session.id, message), 201);
  });
  app.get("/api/chat/sessions", (c) => {
    const workspaceId = requestedChatWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listChatSessions(workspaceId, {
      creatorId: currentRequestUserId(c),
      includeArchived: c.req.query("status") === "all",
    }).filter((session) => canCurrentUserAccessChatSessionAgent(c, store, session)).map(chatSessionCompatibilityResponse));
  });
  app.post("/api/chat/sessions", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    const input = withChatSessionRequestContext(c, store, body);
    if (input instanceof Response) return input;
    return c.json(chatSessionCompatibilityResponse(store.createChatSession(input)), 201);
  });
  app.get("/api/chat/sessions/:sessionId", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return c.json(chatSessionCompatibilityResponse(loaded.session));
  });
  app.patch("/api/chat/sessions/:sessionId", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<UpdateChatSessionInput>(c);
    return c.json(chatSessionCompatibilityResponse(store.updateChatSession(loaded.session.id, body)));
  });
  app.delete("/api/chat/sessions/:sessionId", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"), { requireAgentAccess: false });
    if (loaded instanceof Response) return loaded;
    const deleted = store.deleteChatSession(loaded.session.id);
    if (!deleted) return c.json({ error: "chat session not found" }, 404);
    return c.body(null, 204);
  });
  app.get("/api/chat/sessions/:sessionId/messages", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const messages = store.listChatMessages(loaded.session.id);
    const attachments = store.listAttachmentsForChatMessages(messages.map((message) => message.id));
    return c.json(messages.map((message) => chatMessageCompatibilityResponse(message, attachments.get(message.id) ?? [])));
  });
  app.get("/api/chat/sessions/:sessionId/messages/page", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const rawLimit = c.req.query("limit");
    let limit = 50;
    if (rawLimit != null && rawLimit !== "") {
      const parsedLimit = Number(rawLimit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        return c.json({ error: "invalid limit" }, 400);
      }
      limit = parsedLimit;
    }
    const beforeCreatedAt = c.req.query("before_created_at");
    const beforeId = c.req.query("before_id");
    if ((!beforeCreatedAt && beforeId) || (beforeCreatedAt && !beforeId)) {
      return c.json({ error: "invalid cursor" }, 400);
    }
    if (beforeCreatedAt && Number.isNaN(Date.parse(beforeCreatedAt))) {
      return c.json({ error: "invalid cursor" }, 400);
    }
    const sessionMessages = store.listChatMessages(loaded.session.id);
    const attachments = store.listAttachmentsForChatMessages(sessionMessages.map((message) => message.id));
    const messages = sessionMessages.map((message) => chatMessageCompatibilityResponse(message, attachments.get(message.id) ?? []));
    const filtered = beforeCreatedAt
      ? messages.filter((message) =>
        message.created_at < beforeCreatedAt ||
        (message.created_at === beforeCreatedAt && beforeId ? message.id < beforeId : false)
      )
      : messages;
    const pageMessages = filtered.slice(Math.max(0, filtered.length - limit));
    const hasMore = filtered.length > pageMessages.length;
    const nextCursor = hasMore && pageMessages[0]
      ? { created_at: pageMessages[0].created_at, id: pageMessages[0].id }
      : null;
    return c.json({
      messages: pageMessages,
      limit,
      has_more: hasMore,
      next_cursor: nextCursor,
    });
  });
  app.post("/api/chat/sessions/:sessionId/messages", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<SendChatMessageInput>(c);
    const message = normalizeSendChatMessageInput(c, body);
    if (message instanceof Response) return message;
    return c.json(sendChatMessageCompatibilityResponse(store.sendChatMessage(loaded.session.id, message)), 201);
  });
  app.get("/api/chat/sessions/:sessionId/pending-task", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const task = store.getPendingChatTask(loaded.session.id);
    return c.json(task ? { task_id: task.id, status: task.status, created_at: task.createdAt } : {});
  });
  app.post("/api/chat/sessions/:sessionId/read", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    store.markChatSessionRead(loaded.session.id);
    return c.body(null, 204);
  });
  app.get("/api/chat/pending-tasks", (c) => {
    const workspaceId = requestedChatWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const tasks = store.listPendingChatTasks(workspaceId, { creatorId: currentRequestUserId(c) })
      .filter((task) => {
        const session = task.chatSessionId ? store.getChatSession(task.chatSessionId) : null;
        return session ? canCurrentUserAccessChatSessionAgent(c, store, session) : false;
      })
      .map((task) => ({ task_id: task.id, status: task.status, chat_session_id: task.chatSessionId }));
    return c.json({ tasks });
  });

  app.get("/api/multiremi/tasks", (c) => {
    const status = c.req.query("status") as any;
    return c.json({ tasks: store.listTasks(status) });
  });
  app.post("/api/multiremi/tasks", async (c) => {
    const body = await readJson<CreateTaskInput>(c);
    return c.json({ task: store.createTask(body) }, 201);
  });
  app.get("/api/multiremi/tasks/:id", (c) => {
    const task = store.getTaskWithAgent(c.req.param("id"));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ task });
  });
  app.post("/api/multiremi/tasks/:id/cancel", (c) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ task: store.cancelTask(task.id) });
  });
  app.post("/api/tasks/:id/cancel", (c) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json(taskCompatibilityResponse(store.cancelTask(task.id)));
  });
  app.get("/api/multiremi/tasks/:id/messages", (c) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ messages: store.listTaskMessages(task.id) });
  });
  const listTaskHumanRequestsRoute = (c: any) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ requests: store.listTaskHumanRequests(task.id) });
  };
  const respondTaskHumanRequestRoute = async (c: any) => {
    const task = taskFromParam(store, c, "id");
    if (!task) return c.json({ error: "task not found" }, 404);
    const requestId = c.req.param("requestId");
    const request = store.getTaskHumanRequest(requestId);
    if (!request || request.taskId !== task.id) return c.json({ error: "request not found" }, 404);
    const body = await readJson<{ response?: Record<string, unknown> }>(c);
    const responded = store.respondTaskHumanRequest(request.id, {
      response: body?.response ?? {},
      respondedBy: store.getCurrentUser()?.id ?? null,
    });
    if (!responded) {
      return c.json({ error: "request already resolved", request: store.getTaskHumanRequest(request.id) }, 409);
    }
    return c.json({ request: responded });
  };
  app.get("/api/multiremi/tasks/:id/human-requests", listTaskHumanRequestsRoute);
  app.get("/api/tasks/:id/human-requests", listTaskHumanRequestsRoute);
  app.post("/api/multiremi/tasks/:id/human-requests/:requestId/respond", respondTaskHumanRequestRoute);
  app.post("/api/tasks/:id/human-requests/:requestId/respond", respondTaskHumanRequestRoute);

  // Multiremi daemon-compatible endpoints.
  app.post("/api/daemon/runtimes/:runtimeId/tasks/claim", async (c) => {
    const task = store.claimTask(c.req.param("runtimeId"));
    if (!task) return c.json({ task: null });
    const response = daemonTaskClaimResponse(store, task, store.getTaskTriggerMetadata(task));
    const runtime = task.runtimeId ? store.getRuntime(task.runtimeId) : null;
    const ownerId = cleanString(runtime?.ownerId);
    if (ownerId) {
      const token = await store.createTaskAccessToken(task, ownerId);
      response.auth_token = token.token;
    }
    return c.json({ task: response });
  });
  app.get("/api/daemon/runtimes/:runtimeId/tasks/pending", (c) => {
    const runtime = store.getRuntime(c.req.param("runtimeId"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    const tasks = store.listTasks()
      .filter((task) => isDaemonPendingTaskForRuntime(task, runtime.id))
      .sort(compareDaemonPendingTasks)
      .map((task) => daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
    return c.json(tasks);
  });
  app.post("/api/daemon/runtimes/:runtimeId/recover-orphans", (c) => {
    const runtimeId = c.req.param("runtimeId");
    if (!store.getRuntime(runtimeId)) return c.json({ error: "runtime not found" }, 404);
    return c.json(store.recoverOrphans(runtimeId));
  });
  app.post("/api/daemon/tasks/:taskId/start", (c) => {
    const taskId = c.req.param("taskId");
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    if (existing.status !== "dispatched" && existing.status !== "waiting_local_directory") {
      return c.json({ error: "start task: no rows in result set" }, 400);
    }
    const task = store.startTask(taskId);
    return c.json(daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
  });
  app.post("/api/daemon/tasks/:taskId/wait-local-directory", async (c) => {
    const taskId = c.req.param("taskId");
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    const body = await readJsonStrictAllowEmpty<{ reason?: string }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    if (existing.status !== "dispatched") {
      return c.json({ error: "mark task waiting_local_directory: no rows in result set" }, 400);
    }
    let task: MultiremiTask;
    try {
      task = store.markTaskWaitingLocalDirectory(taskId, body.reason);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json(daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
  });
  app.post("/api/daemon/tasks/:taskId/human-requests", async (c) => {
    const taskId = c.req.param("taskId");
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    if (isTerminalTaskStatus(existing.status)) return c.json({ error: "task is terminal" }, 400);
    const body = await readJsonStrict<{ kind?: string; payload?: Record<string, unknown> }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const kind = body.kind === "question" ? "question" : "permission";
    const request = store.createTaskHumanRequest({ taskId, kind, payload: body.payload ?? {} });
    return c.json({ request }, 201);
  });
  app.get("/api/daemon/tasks/:taskId/human-requests/:requestId", (c) => {
    const request = store.getTaskHumanRequest(c.req.param("requestId"));
    if (!request || request.taskId !== c.req.param("taskId")) return c.json({ error: "request not found" }, 404);
    return c.json({ request });
  });
  app.post("/api/daemon/tasks/:taskId/human-requests/:requestId/expire", async (c) => {
    const request = store.getTaskHumanRequest(c.req.param("requestId"));
    if (!request || request.taskId !== c.req.param("taskId")) return c.json({ error: "request not found" }, 404);
    const body = await readJsonStrict<{ status?: string }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const status = body.status === "cancelled" ? "cancelled" : "timeout";
    const expired = store.expireTaskHumanRequest(request.id, status);
    // Lost the race to a human response: return the current row so the worker honors it.
    return c.json({ request: expired ?? store.getTaskHumanRequest(request.id) });
  });
  app.post("/api/daemon/tasks/:taskId/progress", async (c) => {
    const body = await readJsonStrict<{ summary?: string; step?: number; total?: number }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const taskId = c.req.param("taskId");
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    if (!isTerminalTaskStatus(existing.status)) store.reportProgress(taskId, body.summary ?? "", body.step, body.total);
    return c.json({ status: "ok" });
  });
  app.post("/api/daemon/tasks/:taskId/messages", async (c) => {
    const body = await readJsonStrict<{ messages?: any[] }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const messages = body.messages ?? [];
    if (!messages.length) return c.json({ status: "ok" });
    const taskId = c.req.param("taskId");
    if (!store.getTask(taskId)) return c.json({ error: "task not found" }, 404);
    store.appendTaskMessages(taskId, messages);
    return c.json({ status: "ok" });
  });
  app.get("/api/daemon/tasks/:taskId/messages", (c) => {
    const taskId = c.req.param("taskId");
    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    const since = parseOptionalTaskMessageSince(c.req.query("since_seq") ?? c.req.query("sinceSeq") ?? c.req.query("since"));
    if (typeof since === "object" && since && "error" in since) return c.json({ error: since.error }, 400);
    return c.json(store.listTaskMessages(taskId, since).map((message) => daemonTaskMessageWireResponse(message, task)));
  });
  app.post("/api/daemon/tasks/:taskId/session", async (c) => {
    const taskId = c.req.param("taskId");
    if (!store.getTask(taskId)) return c.json({ error: "task not found" }, 404);
    const body = await readJsonStrict<{ session_id?: string; work_dir?: string }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const sessionId = body.session_id ?? null;
    const workDir = body.work_dir ?? null;
    if (!sessionId && !workDir) return c.json({ error: "session_id or work_dir required" }, 400);
    store.pinTaskSession(
      taskId,
      sessionId,
      workDir,
    );
    return c.body(null, 204);
  });
  app.post("/api/daemon/tasks/:taskId/complete", async (c) => {
    const taskId = c.req.param("taskId");
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    const body = await readJsonStrict<{ output?: string; pr_url?: string; session_id?: string; work_dir?: string }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    if (existing.status !== "running") {
      return c.json(daemonTaskWireResponse(existing, store.getTaskTriggerMetadata(existing)));
    }
    const task = store.completeTask(taskId, {
      output: body.output ?? "",
      branchName: body.pr_url ?? null,
      sessionId: body.session_id ?? null,
      workDir: body.work_dir ?? null,
    });
    return c.json(daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
  });
  app.post("/api/daemon/tasks/:taskId/fail", async (c) => {
    const taskId = c.req.param("taskId");
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    const body = await readJsonStrict<{ error?: string; session_id?: string; work_dir?: string; failure_reason?: string }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    if (existing.status !== "dispatched" && existing.status !== "running" && existing.status !== "waiting_local_directory") {
      return c.json(daemonTaskWireResponse(existing, store.getTaskTriggerMetadata(existing)));
    }
    const task = store.failTask(taskId, {
      error: body.error ?? "Task failed",
      sessionId: body.session_id ?? null,
      workDir: body.work_dir ?? null,
      failureReason: body.failure_reason ?? null,
    });
    return c.json(daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
  });
  app.post("/api/daemon/tasks/:taskId/usage", async (c) => {
    const taskId = c.req.param("taskId");
    if (!store.getTask(taskId)) return c.json({ error: "task not found" }, 404);
    const body = await readJsonStrict<{ usage?: any[] }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    store.reportTaskUsage(taskId, daemonTaskUsageEntries(body.usage));
    return c.json({ status: "ok" });
  });
  app.get("/api/daemon/tasks/:taskId/status", (c) => {
    const task = store.getTask(c.req.param("taskId"));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ status: task.status });
  });
  app.get("/api/tasks/:taskId/messages", (c) => {
    const task = taskFromParam(store, c, "taskId");
    if (!task) return c.json({ error: "task not found" }, 404);
    const since = parseOptionalTaskMessageSince(c.req.query("since_seq") ?? c.req.query("sinceSeq") ?? c.req.query("since"));
    if (typeof since === "object" && since && "error" in since) return c.json({ error: since.error }, 400);
    return c.json(store.listTaskMessages(task.id, since));
  });
  app.get("/api/daemon/issues/:issueId/gc-check", (c) => {
    const issue = issueFromParam(store, c, "issueId");
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
    unsubscribeWorkspaceEvent();
    scheduler?.stop();
    return stopServer(closeActiveConnections);
  };
  return server;
}

function buildDaemonInstallInstructions(input: {
  requestUrl: string;
  serverUrl?: string | null;
  workspaceId?: string | null;
  token?: string | null;
  tokenId?: string | null;
  provider?: string | null;
  version?: string | null;
}) {
  const workspaceId = cleanString(input.workspaceId) ?? "local";
  const serverUrl = cleanString(input.serverUrl)
    ?? cleanString(process.env.MULTIREMI_PUBLIC_URL)
    ?? requestOrigin(input.requestUrl);
  const provider = cleanString(input.provider);
  if (provider && !MULTIREMI_DAEMON_PROVIDERS.has(provider)) {
    throw new MultiremiApiError(`Unsupported Multiremi runtime provider: ${provider}`, 400);
  }
  const version = cleanString(input.version);
  const releasePath = version ? `download/${version}` : "latest/download";
  const installScriptUrl = `https://github.com/${MULTIREMI_RELEASE_REPO}/releases/${releasePath}/${MULTIREMI_INSTALL_SCRIPT}`;
  const installCommand = `curl -fsSL ${shellArg(installScriptUrl)} | bash`;
  const setupParts = [
    "multiremi",
    "setup",
    "--server",
    shellArg(serverUrl),
    "--workspace",
    shellArg(workspaceId),
    "--token",
    input.token ? shellArg(input.token) : "<YOUR_TOKEN>",
  ];
  if (provider) setupParts.push("--provider", provider);
  const setupCommand = setupParts.join(" ");
  const daemonCommand = "multiremi daemon";
  const daemonStartCommand = "multiremi daemon start";
  return {
    product: "multiremi",
    title: "Add computer",
    serverUrl,
    workspaceId,
    provider: provider ?? "auto",
    token: input.token ?? null,
    tokenId: input.tokenId ?? null,
    installScriptUrl,
    releaseArtifactPattern: "multiremi-${version}-${os}-${arch}.tar.gz",
    installCommand,
    setupCommand,
    daemonCommand,
    daemonStartCommand,
    commands: [
      { key: "install", label: "Install Multiremi CLI", command: installCommand },
      { key: "setup", label: "Configure this computer", command: setupCommand },
      { key: "daemon", label: "Start daemon", command: daemonCommand },
    ],
  };
}

function cleanString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeMultiremiRuntimeProvider(value: unknown): string {
  return String(value ?? "").trim() || "unknown";
}

function validateMultiremiRuntimeProvider(value: unknown): { provider: string } | { error: string; status: 400 } {
  const provider = normalizeMultiremiRuntimeProvider(value);
  if (MULTIREMI_DAEMON_PROVIDERS.has(provider)) return { provider };
  return { error: `Unsupported Multiremi runtime provider: ${provider}`, status: 400 };
}

function requestOrigin(requestUrl: string): string {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return "http://127.0.0.1:6120";
  }
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isDaemonTokenAllowedRequest(request: Request): boolean {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (path === "/health" || path === "/healthz" || path === "/readyz" || path === "/api/multiremi/health") {
    return true;
  }
  if (path === "/api/daemon/ws" || path.startsWith("/api/daemon/")) return true;
  if (path === "/api/multiremi/runtimes" && method === "POST") return true;
  if (/^\/api\/multiremi\/runtimes\/[^/]+\/heartbeat$/.test(path) && method === "POST") return true;
  return false;
}

function isTaskTokenForbiddenRequest(request: Request): boolean {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (path === "/api/daemon/ws" || path.startsWith("/api/daemon/")) return true;
  if (path === "/api/multiremi/runtimes" && method === "POST") return true;
  if (/^\/api\/multiremi\/runtimes\/[^/]+\/heartbeat$/.test(path) && method === "POST") return true;
  return false;
}

function isTaskTokenCreateInput(input: Pick<CreateAccessTokenInput, "type">): boolean {
  return String(input.type ?? "pat").trim().toLowerCase() === "task";
}

// The request identity resolved once by the auth middleware. Falls back to the
// anonymous "local" admin when unset (open mode, or routes registered before the
// auth middleware) — identical to the historical "no context key set" behaviour.
function currentAuth(c: Context): MultiremiRequestAuth {
  return c.get("multiremiAuth") ?? ANON_REQUEST_AUTH;
}

function currentAccessToken(c: Context): MultiremiAccessToken | null {
  return currentAuth(c).accessToken;
}

function currentTaskAccessToken(c: Context): MultiremiAccessToken | null {
  const token = currentAccessToken(c);
  return token?.type === "task" ? token : null;
}

function currentJwtUserId(c: Context): string | null {
  return currentAuth(c).jwtUserId;
}

function currentRequestUserId(c: Context): string {
  return currentAuth(c).requestUserId;
}

function authenticatedRequestUserId(c: Context): string | null {
  return currentAuth(c).userId;
}

function compatibilityWorkspaceId(c: Context): string {
  return cleanString(c.req.header("X-Workspace-ID")) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
}

// The web client tags every request with the slug of the workspace the user is
// viewing (client.ts authHeaders). Null when absent or not a known workspace.
function workspaceIdFromSlugHeader(c: Context, store: MultiremiStore): string | null {
  const slug = cleanString(c.req.header("X-Workspace-Slug"));
  if (!slug) return null;
  return store.listWorkspaces().find((workspace) => workspace.slug === slug)?.id ?? null;
}

function compatibilityUserId(c: Context): string {
  return authenticatedRequestUserId(c) ??
    cleanString(c.req.query("user_id")) ??
    "local";
}

function compatibilityInboxMemberId(c: Context): string {
  return authenticatedRequestUserId(c) ??
    cleanString(c.req.query("member_id")) ??
    "local";
}

function requestedAgentWorkspaceId(c: Context, input?: Pick<CreateAgentInput, "workspaceId" | "workspace_id">): string {
  return cleanString(input?.workspaceId) ??
    cleanString(input?.workspace_id) ??
    cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
}

function requestedRuntimeWorkspaceId(c: Context): string {
  return cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
}

function autopilotCreateInput(c: Context, input: CreateAutopilotInput): CreateAutopilotInput {
  const workspaceId = cleanString(input.workspaceId) ??
    cleanString(input.workspace_id) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
  return {
    ...input,
    workspaceId,
    createdByType: input.createdByType ?? input.created_by_type ?? "member",
    createdById: input.createdById ?? input.created_by_id ?? currentRequestUserId(c),
  };
}

function runtimeWorkspaceId(runtime: MultiremiRuntime): string {
  return runtime.workspaceId ?? "local";
}

function runtimeOwnerId(runtime: MultiremiRuntime): string {
  return runtime.ownerId ?? "local";
}

function listRuntimesForCurrentUser(c: Context, store: MultiremiStore): { runtimes: MultiremiRuntime[] } | Response {
  const workspaceId = requestedRuntimeWorkspaceId(c);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const ownerFilter = c.req.query("owner") === "me" ? currentRequestUserId(c) : null;
  const runtimes = store.listRuntimes().filter((runtime) => {
    if (runtimeWorkspaceId(runtime) !== workspaceId) return false;
    return ownerFilter ? runtimeOwnerId(runtime) === ownerFilter : true;
  });
  return { runtimes };
}

function loadRuntimeForCurrentUser(c: Context, store: MultiremiStore, runtimeId: string): { runtime: MultiremiRuntime } | Response {
  const runtime = store.getRuntime(runtimeId);
  if (!runtime) return c.json({ error: "runtime not found" }, 404);
  const denied = denyCurrentUserRuntimeWorkspaceAccess(c, store, runtime);
  if (denied) return denied;
  return { runtime };
}

function loadRuntimeForCurrentEditor(
  c: Context,
  store: MultiremiStore,
  runtimeId: string,
  action: "edit" | "delete",
): { runtime: MultiremiRuntime } | Response {
  const loaded = loadRuntimeForCurrentUser(c, store, runtimeId);
  if (loaded instanceof Response) return loaded;
  if (!canCurrentUserEditRuntime(c, store, loaded.runtime)) {
    const verb = action === "delete" ? "delete" : "edit";
    return c.json({ error: `you can only ${verb} your own runtimes` }, 403);
  }
  return loaded;
}

function loadRuntimeForCurrentOwner(c: Context, store: MultiremiStore, runtimeId: string, feature = "local skills"): { runtime: MultiremiRuntime } | Response {
  const loaded = loadRuntimeForCurrentUser(c, store, runtimeId);
  if (loaded instanceof Response) return loaded;
  if (runtimeOwnerId(loaded.runtime) !== currentRequestUserId(c)) {
    return c.json({ error: `you can only access ${feature} from your own runtimes` }, 403);
  }
  return loaded;
}

function canCurrentUserEditRuntime(c: Context, store: MultiremiStore, runtime: MultiremiRuntime): boolean {
  const role = currentWorkspaceRole(c, store, runtimeWorkspaceId(runtime));
  if (role === "owner" || role === "admin") return true;
  return runtimeOwnerId(runtime) === currentRequestUserId(c);
}

function runtimeHasActiveAgentsResponse(
  agents: MultiremiAgent[],
  code = "runtime_has_active_agents",
  error = "cannot delete runtime: it has active agents bound to it. Archive or reassign the agents first.",
): { error: string; code: string; active_agents: MultiremiAgent[] } {
  return { error, code, active_agents: agents };
}

function agentCompatibilityResponse(store: MultiremiStore, agent: MultiremiAgent, c?: any): Record<string, unknown> {
  const customEnvKeyCount = Object.keys(agent.customEnv ?? {}).length;
  const mcpConfig = agentMcpConfigForRequest(store, agent, c);
  return {
    id: agent.id,
    workspace_id: agent.workspaceId,
    runtime_id: agent.runtimeId ?? "",
    provider: agent.provider,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    avatar_url: agent.avatarUrl,
    runtime_mode: "local",
    runtime_config: {},
    custom_args: agent.customArgs ?? [],
    mcp_config: mcpConfig.value,
    has_custom_env: customEnvKeyCount > 0,
    custom_env_key_count: customEnvKeyCount,
    mcp_config_redacted: mcpConfig.redacted,
    visibility: agent.visibility,
    status: agent.archivedAt ? "archived" : "active",
    max_concurrent_tasks: agent.maxConcurrentTasks,
    model: agent.model ?? "",
    thinking_level: agent.thinkingLevel ?? "",
    owner_id: agent.ownerId,
    skills: store.listAgentSkills(agent.id, { includeFiles: false }).map(agentSkillCompatibilitySummary),
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
    archived_at: agent.archivedAt,
    archived_by: null,
  };
}

function agentBroadcastCompatibilityResponse(store: MultiremiStore, agent: MultiremiAgent): Record<string, unknown> {
  const response = agentCompatibilityResponse(store, agent);
  if (response.mcp_config != null) {
    response.mcp_config = null;
    response.mcp_config_redacted = true;
  }
  return response;
}

function agentMcpConfigForRequest(
  store: MultiremiStore,
  agent: MultiremiAgent,
  c?: any,
): { value: unknown | null; redacted: boolean } {
  if (agent.mcpConfig == null) return { value: null, redacted: false };
  if (!c) return { value: agent.mcpConfig, redacted: false };
  if (currentTaskAccessToken(c) || cleanString(c.req?.header?.("X-Agent-ID"))) return { value: null, redacted: true };
  if (workspaceAlwaysRedactSecrets(store.getWorkspace(agent.workspaceId)?.settings)) return { value: null, redacted: true };
  const role = currentWorkspaceRoleStrict(c, store, agent.workspaceId);
  if (role === "owner" || role === "admin" || agent.ownerId === currentRequestUserId(c)) {
    return { value: agent.mcpConfig, redacted: false };
  }
  return { value: null, redacted: true };
}

function workspaceAlwaysRedactSecrets(settings: Record<string, unknown> | null | undefined): boolean {
  const value = settings?.always_redact_env;
  return value === true || value === 1 || value === "1" || value === "true";
}

function projectCompatibilityResponse(project: MultiremiProject): Record<string, unknown> {
  return {
    id: project.id,
    workspace_id: project.workspaceId,
    title: project.title,
    description: project.description,
    icon: project.icon,
    status: project.status,
    priority: project.priority,
    lead_type: project.leadType,
    lead_id: project.leadId,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    issue_count: project.issueCount,
    done_count: project.doneCount,
    resource_count: project.resourceCount,
  };
}

function projectCreateCompatibilityInput(c: Context, input: CreateProjectInput): CreateProjectInput {
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    icon: input.icon,
    workspaceId: input.workspace_id ?? c.req.query("workspace_id") ?? "local",
    status: input.status,
    priority: input.priority,
    leadType: input.lead_type,
    leadId: input.lead_id,
    resources: input.resources,
  };
}

function projectUpdateCompatibilityInput(input: UpdateProjectInput): UpdateProjectInput {
  return {
    title: input.title,
    description: input.description,
    icon: input.icon,
    status: input.status,
    priority: input.priority,
    leadType: input.lead_type,
    leadId: input.lead_id,
  };
}

function labelCreateCompatibilityInput(input: CreateLabelInput): CreateLabelInput {
  return {
    id: input.id,
    name: input.name,
    color: input.color,
    workspaceId: input.workspace_id ?? "local",
  };
}

function projectSearchCompatibilityResponse(project: MultiremiProjectSearchResult): Record<string, unknown> {
  const response = {
    ...projectCompatibilityResponse(project),
    match_source: project.matchSource,
  };
  if (project.matchedSnippet !== undefined) {
    return { ...response, matched_snippet: project.matchedSnippet };
  }
  return response;
}

function pinCompatibilityResponse(pin: MultiremiPinnedItem): Record<string, unknown> {
  return {
    id: pin.id,
    workspace_id: pin.workspaceId,
    user_id: pin.userId,
    item_type: pin.itemType,
    item_id: pin.itemId,
    position: pin.position,
    created_at: pin.createdAt,
  };
}

function pinCompatibilityErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Item already pinned") return c.json({ error: "item already pinned" }, 409);
  if (message.startsWith("Issue not found")) return c.json({ error: "issue not found" }, 404);
  if (message.startsWith("Project not found")) return c.json({ error: "project not found" }, 404);
  if (message === "item_id is required" || message === "item_type must be 'issue' or 'project'") {
    return c.json({ error: message }, 400);
  }
  return c.json({ error: message }, 400);
}

function squadCompatibilityResponse(store: MultiremiStore, squad: MultiremiSquad): Record<string, unknown> {
  const members = store.listSquadMembers(squad.id);
  return {
    id: squad.id,
    workspace_id: squad.workspaceId,
    name: squad.name,
    description: squad.description,
    instructions: squad.instructions,
    avatar_url: null,
    leader_id: squad.leaderId,
    creator_id: squad.creatorId,
    created_at: squad.createdAt,
    updated_at: squad.updatedAt,
    archived_at: squad.archivedAt,
    archived_by: null,
    member_count: members.length,
    member_preview: members.slice(0, 3).map(squadMemberCompatibilityResponse),
  };
}

function squadMemberCompatibilityResponse(member: MultiremiSquadMember): Record<string, unknown> {
  return {
    id: member.id,
    squad_id: member.squadId,
    member_type: member.memberType,
    member_id: member.memberId,
    role: member.role,
    created_at: member.createdAt,
  };
}

function squadCompatibilityErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Squad not found")) return c.json({ error: "squad not found" }, 404);
  if (message.startsWith("Agent not found")) return c.json({ error: "agent not found in this workspace" }, 400);
  if (message.startsWith("Member not found")) return c.json({ error: "member not found in this workspace" }, 400);
  if (message === "Squad name is required") return c.json({ error: "name is required" }, 400);
  if (!message || message === "undefined") return c.json({ error: "invalid request body" }, 400);
  return c.json({ error: message }, 400);
}

type AutopilotCompatibilityUpdateInput = {
  project_id?: string | null;
  assignee_type?: UpdateAutopilotInput["assigneeType"] | null;
  assignee_id?: string | null;
  execution_mode?: UpdateAutopilotInput["executionMode"] | null;
  issue_title_template?: string | null;
  trigger_kind?: string | null;
  trigger_label?: string | null;
  cron_expression?: string | null;
};

function autopilotCompatibilityResponse(autopilot: MultiremiAutopilot): Record<string, unknown> {
  return {
    id: autopilot.id,
    workspace_id: autopilot.workspaceId,
    title: autopilot.title,
    description: autopilot.description,
    project_id: autopilot.projectId,
    assignee_type: autopilot.assigneeType,
    assignee_id: autopilot.assigneeId,
    status: autopilot.status,
    execution_mode: autopilot.executionMode,
    issue_title_template: autopilot.issueTitleTemplate,
    created_by_type: autopilot.createdByType,
    created_by_id: autopilot.createdById,
    last_run_at: autopilot.lastRunAt,
    created_at: autopilot.createdAt,
    updated_at: autopilot.updatedAt,
  };
}

function autopilotCreateCompatibilityInput(
  c: Context,
  input: CreateAutopilotInput,
): CreateAutopilotInput | { apiError: string; statusCode: 400 } {
  if (!cleanString(input.title)) return { apiError: "title is required", statusCode: 400 };
  const assigneeId = cleanString(input.assignee_id);
  if (!assigneeId) return { apiError: "assignee_id is required", statusCode: 400 };
  const executionMode = cleanString(input.execution_mode);
  if (!executionMode) return { apiError: "execution_mode is required", statusCode: 400 };
  if (!isAutopilotExecutionMode(executionMode)) {
    return { apiError: "execution_mode must be create_issue or run_only", statusCode: 400 };
  }
  const assigneeType = cleanString(input.assignee_type) ?? "agent";
  if (!isAutopilotAssigneeType(assigneeType)) return { apiError: "assignee_type must be agent or squad", statusCode: 400 };
  const issueTitleTemplate = input.issue_title_template ?? null;
  const templateError = validateIssueTitleTemplateCompatibility(issueTitleTemplate);
  if (templateError) return { apiError: templateError, statusCode: 400 };
  const projectId = cleanString(input.project_id) ?? null;
  return autopilotCreateInput(c, {
    id: input.id,
    title: input.title,
    description: input.description,
    workspace_id: input.workspace_id,
    status: input.status,
    projectId,
    project_id: projectId,
    assigneeType,
    assignee_type: assigneeType,
    assigneeId,
    assignee_id: assigneeId,
    executionMode,
    execution_mode: executionMode,
    issueTitleTemplate,
    issue_title_template: issueTitleTemplate,
    triggerKind: input.trigger_kind,
    trigger_kind: input.trigger_kind,
    triggerLabel: input.trigger_label ?? null,
    trigger_label: input.trigger_label ?? null,
    cronExpression: input.cron_expression ?? null,
    cron_expression: input.cron_expression ?? null,
    created_by_type: input.created_by_type,
    created_by_id: input.created_by_id,
  });
}

function autopilotUpdateCompatibilityInput(
  input: UpdateAutopilotInput & AutopilotCompatibilityUpdateInput,
): UpdateAutopilotInput | { apiError: string; statusCode: 400 } {
  const output: UpdateAutopilotInput = {};
  if (hasOwn(input, "title")) output.title = input.title;
  if (hasOwn(input, "description")) output.description = input.description ?? null;
  if (hasOwn(input, "project_id")) output.projectId = cleanString(input.project_id ?? undefined) ?? null;

  const assigneeTypeSent = hasOwn(input, "assignee_type");
  const assigneeIdSent = hasOwn(input, "assignee_id");
  if (assigneeTypeSent) {
    const assigneeType = cleanString(input.assignee_type);
    if (assigneeType && !isAutopilotAssigneeType(assigneeType)) return { apiError: "assignee_type must be agent or squad", statusCode: 400 };
    if (!assigneeIdSent) return { apiError: "assignee_id is required when changing assignee_type", statusCode: 400 };
    if (assigneeType && isAutopilotAssigneeType(assigneeType)) output.assigneeType = assigneeType;
  }
  if (assigneeIdSent) {
    const assigneeId = cleanString(input.assignee_id);
    if (!assigneeId) return { apiError: "assignee_id cannot be null", statusCode: 400 };
    output.assigneeId = assigneeId;
  }
  if (hasOwn(input, "status")) {
    if (input.status && !isAutopilotStatus(input.status)) return { apiError: "status must be active, paused, or archived", statusCode: 400 };
    output.status = input.status;
  }
  if (hasOwn(input, "execution_mode")) {
    const executionMode = cleanString(input.execution_mode);
    if (executionMode && !isAutopilotExecutionMode(executionMode)) {
      return { apiError: "execution_mode must be create_issue or run_only", statusCode: 400 };
    }
    if (executionMode && isAutopilotExecutionMode(executionMode)) output.executionMode = executionMode;
  }
  if (hasOwn(input, "issue_title_template")) {
    const issueTitleTemplate = input.issue_title_template ?? null;
    const templateError = validateIssueTitleTemplateCompatibility(issueTitleTemplate);
    if (templateError) return { apiError: templateError, statusCode: 400 };
    output.issueTitleTemplate = issueTitleTemplate;
  }
  if (hasOwn(input, "trigger_kind")) output.triggerKind = input.trigger_kind ?? undefined;
  if (hasOwn(input, "trigger_label")) output.triggerLabel = input.trigger_label ?? null;
  if (hasOwn(input, "cron_expression")) output.cronExpression = input.cron_expression ?? null;
  return output;
}

function autopilotTriggerCompatibilityResponse(trigger: MultiremiAutopilotTrigger): Record<string, unknown> {
  const isWebhook = trigger.kind === "webhook";
  const response: Record<string, unknown> = {
    id: trigger.id,
    autopilot_id: trigger.autopilotId,
    kind: trigger.kind,
    enabled: trigger.enabled,
    cron_expression: trigger.cronExpression,
    timezone: trigger.timezone,
    next_run_at: trigger.nextRunAt,
    webhook_token: trigger.webhookToken,
    webhook_path: trigger.webhookPath,
    webhook_url: trigger.webhookUrl,
    provider: isWebhook ? trigger.provider ?? "generic" : null,
    has_signing_secret: isWebhook ? trigger.signingSecretSet : false,
    signing_secret_hint: isWebhook ? trigger.signingSecretHint : null,
    label: trigger.label,
    last_fired_at: trigger.lastFiredAt,
    created_at: trigger.createdAt,
    updated_at: trigger.updatedAt,
  };
  if (isWebhook && trigger.eventFilters?.length) response.event_filters = trigger.eventFilters;
  return response;
}

function autopilotRunCompatibilityResponse(
  run: MultiremiAutopilotRun,
  options: { slim?: boolean } = {},
): Record<string, unknown> {
  return {
    id: run.id,
    autopilot_id: run.autopilotId,
    trigger_id: null,
    source: run.source,
    status: run.status,
    issue_id: run.issueId,
    task_id: run.taskId,
    triggered_at: run.triggeredAt,
    completed_at: run.completedAt,
    failure_reason: run.failureReason,
    trigger_payload: options.slim ? null : run.payload,
    result: run.result,
    created_at: run.createdAt,
  };
}

function validateAutopilotTriggerCompatibilityInput(input: CreateAutopilotTriggerInput): string | null {
  if (!input.kind) return "kind is required";
  if (input.kind !== "schedule" && input.kind !== "webhook") return "kind must be schedule or webhook";
  const cronExpression = cleanString(input.cron_expression);
  if (input.kind === "schedule" && !cronExpression) return "cron_expression is required for schedule triggers";
  if (input.kind === "webhook" && cleanString(input.timezone)) return "timezone is not valid for webhook triggers";
  const provider = cleanString(input.provider);
  if (provider) {
    if (input.kind !== "webhook") return "provider is only valid for webhook triggers";
    if (!isAllowedWebhookProvider(provider)) return "provider must be generic or github";
  }
  const eventFilters = input.event_filters;
  if (input.kind !== "webhook" && Array.isArray(eventFilters) && eventFilters.length > 0) {
    return "event_filters is only valid for webhook triggers";
  }
  return null;
}

function validateAutopilotTriggerUpdateCompatibilityInput(trigger: MultiremiAutopilotTrigger, input: UpdateAutopilotTriggerInput): string | null {
  const cronExpression = input.cron_expression;
  if (trigger.kind !== "schedule") {
    if (cronExpression != null) return "cron_expression is only valid for schedule triggers";
    if (input.timezone != null) return "timezone is only valid for schedule triggers";
  }
  const eventFilters = input.event_filters;
  if (trigger.kind !== "webhook" && eventFilters != null) return "event_filters is only valid for webhook triggers";
  return null;
}

function autopilotTriggerCreateCompatibilityInput(input: CreateAutopilotTriggerInput): CreateAutopilotTriggerInput {
  const cronExpression = input.cron_expression ?? null;
  const eventFilters = input.event_filters ?? null;
  return {
    kind: input.kind,
    cronExpression,
    cron_expression: cronExpression,
    timezone: input.timezone,
    label: input.label,
    provider: input.provider,
    enabled: input.enabled,
    eventFilters,
    event_filters: eventFilters,
  };
}

function autopilotTriggerUpdateCompatibilityInput(input: UpdateAutopilotTriggerInput): UpdateAutopilotTriggerInput {
  const output: UpdateAutopilotTriggerInput = {};
  if (typeof input.enabled === "boolean") output.enabled = input.enabled;
  const cronExpression = input.cron_expression;
  if (cronExpression != null) {
    output.cronExpression = cronExpression;
    output.cron_expression = cronExpression;
  }
  if (input.timezone != null) output.timezone = input.timezone;
  if (input.label != null) output.label = input.label;
  const eventFilters = input.event_filters;
  if (eventFilters != null) {
    output.eventFilters = eventFilters;
    output.event_filters = eventFilters;
  }
  return output;
}

function autopilotCompatibilityErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Autopilot not found")) return c.json({ error: "autopilot not found" }, 404);
  if (message.startsWith("Autopilot trigger not found")) return c.json({ error: "trigger not found" }, 404);
  if (message.startsWith("Autopilot trigger is not a webhook")) return c.json({ error: "trigger is not a webhook trigger" }, 400);
  if (message.startsWith("Project not found")) return c.json({ error: "project_id must reference a project in this workspace" }, 400);
  if (message.startsWith("Agent not found")) return c.json({ error: "assignee must be a valid agent in this workspace" }, 400);
  if (message.startsWith("Squad not found")) return c.json({ error: "assignee must be a valid squad in this workspace" }, 400);
  if (message === "Autopilot title is required") return c.json({ error: "title is required" }, 400);
  if (message === "Autopilot assignee is required") return c.json({ error: "assignee_id is required" }, 400);
  if (message.includes("event_filters") || message.includes("cron_expression") || message.includes("timezone")) {
    return c.json({ error: message }, 400);
  }
  return c.json({ error: message }, 500);
}

function isAutopilotExecutionMode(value: string): value is NonNullable<UpdateAutopilotInput["executionMode"]> {
  return value === "create_issue" || value === "run_only";
}

function isAutopilotAssigneeType(value: string): value is NonNullable<UpdateAutopilotInput["assigneeType"]> {
  return value === "agent" || value === "squad";
}

function isAutopilotStatus(value: string): value is NonNullable<UpdateAutopilotInput["status"]> {
  return value === "active" || value === "paused" || value === "archived";
}

function isAllowedWebhookProvider(value: string): value is MultiremiWebhookProvider {
  return value === "generic" || value === "github";
}

function validateIssueTitleTemplateCompatibility(template: string | null | undefined): string | null {
  if (!template) return null;
  const tokenPattern = /\{\{\s*([^{}]*?)\s*\}\}/g;
  for (const match of template.matchAll(tokenPattern)) {
    const name = match[1] ?? "";
    if (name !== "date") return `unknown template variable "${name}"; supported: {{date}}`;
  }
  return null;
}

function queryInt(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedQueryInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = queryInt(value, fallback);
  if (parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function labelCompatibilityResponse(label: MultiremiLabel): Record<string, unknown> {
  return {
    id: label.id,
    workspace_id: label.workspaceId,
    name: label.name,
    color: label.color,
    created_at: label.createdAt,
    updated_at: label.updatedAt,
  };
}

function labelCompatibilityErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Label not found") || message === "Label belongs to another workspace") {
    return c.json({ error: "label not found" }, 404);
  }
  if (message.startsWith("Label already exists")) {
    return c.json({ error: "a label with that name already exists" }, 409);
  }
  if (message === "Label name is required") {
    return c.json({ error: "name is required" }, 400);
  }
  if (message === "Label name cannot exceed 32 characters") {
    return c.json({ error: "name must be 32 characters or fewer" }, 400);
  }
  if (message === "Label color must be a 6-digit hex color") {
    return c.json({ error: "color must be a 6-digit hex value like #3b82f6" }, 400);
  }
  return c.json({ error: message }, 400);
}

function issueCompatibilityResponse(
  issue: MultiremiIssue,
  options: { includeLabels?: boolean } = {},
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: issue.id,
    workspace_id: issue.workspaceId,
    number: issue.number,
    identifier: issue.key,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    assignee_type: issue.assigneeType,
    assignee_id: issue.assigneeId,
    creator_type: "member",
    creator_id: issue.createdBy ?? "local",
    parent_issue_id: issue.parentIssueId,
    project_id: issue.projectId,
    position: issue.position,
    start_date: issue.startDate,
    due_date: issue.dueDate,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    metadata: issue.metadata,
  };
  if (options.includeLabels) response.labels = issue.labels.map(labelCompatibilityResponse);
  return response;
}

function issueReactionCompatibilityResponse(reaction: MultiremiIssueReaction): Record<string, unknown> {
  return {
    id: reaction.id,
    issue_id: reaction.issueId,
    actor_type: reaction.actorType,
    actor_id: reaction.actorId,
    emoji: reaction.emoji,
    created_at: reaction.createdAt,
  };
}

function commentReactionCompatibilityResponse(reaction: MultiremiCommentReaction): Record<string, unknown> {
  return {
    id: reaction.id,
    comment_id: reaction.commentId,
    actor_type: reaction.actorType,
    actor_id: reaction.actorId,
    emoji: reaction.emoji,
    created_at: reaction.createdAt,
  };
}

function commentCompatibilityResponse(comment: MultiremiIssueComment): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: comment.id,
    issue_id: comment.issueId,
    author_type: comment.authorType,
    author_id: comment.authorId,
    content: comment.body,
    type: comment.type ?? "comment",
    parent_id: comment.parentId,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    resolved_at: comment.resolvedAt,
    resolved_by_type: comment.resolvedByType,
    resolved_by_id: comment.resolvedById,
    reactions: comment.reactions.map(commentReactionCompatibilityResponse),
    attachments: comment.attachments.map(issueDetailAttachmentCompatibilityResponse),
  };
  if (comment.replyCount !== undefined) response.reply_count = comment.replyCount;
  if (comment.lastActivityAt !== undefined) response.last_activity_at = comment.lastActivityAt;
  if (comment.contentTruncated !== undefined) response.content_truncated = comment.contentTruncated;
  return response;
}

function issueCommentMutationErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Comment not found:")) return c.json({ error: "comment not found" }, 404);
  if (message.startsWith("Parent comment not found:")) return c.json({ error: "invalid parent comment" }, 400);
  if (message === "Comment body is required") return c.json({ error: "content is required" }, 400);
  if (message === "Only root comments can be resolved") return c.json({ error: "only root comments can be resolved" }, 400);
  return c.json({ error: message }, 400);
}

function issueDetailAttachmentCompatibilityResponse(attachment: MultiremiAttachment): Record<string, unknown> {
  return {
    id: attachment.id,
    workspace_id: attachment.workspaceId,
    issue_id: attachment.issueId,
    comment_id: attachment.commentId,
    chat_session_id: attachment.chatSessionId,
    chat_message_id: attachment.chatMessageId,
    uploader_type: attachment.uploaderType,
    uploader_id: attachment.uploaderId,
    filename: attachment.filename,
    url: attachment.url,
    download_url: `/api/attachments/${attachment.id}/download`,
    content_type: attachment.contentType,
    size_bytes: attachment.sizeBytes,
    created_at: attachment.createdAt,
  };
}

function issueSearchCompatibilityResponse(issue: MultiremiIssueSearchResult): Record<string, unknown> {
  const response: Record<string, unknown> = {
    ...issueCompatibilityResponse(issue),
    match_source: issue.matchSource,
  };
  if (issue.matchedSnippet !== undefined) response.matched_snippet = issue.matchedSnippet;
  if (issue.matchedDescriptionSnippet !== undefined) response.matched_description_snippet = issue.matchedDescriptionSnippet;
  if (issue.matchedCommentSnippet !== undefined) response.matched_comment_snippet = issue.matchedCommentSnippet;
  return response;
}

function issueSubscriberCompatibilityResponse(subscriber: MultiremiIssueSubscriber): Record<string, unknown> {
  return {
    issue_id: subscriber.issueId,
    user_type: subscriber.userType,
    user_id: subscriber.userId,
    reason: subscriber.reason,
    created_at: subscriber.createdAt,
  };
}

function issueSubscriberCaller(c: Context): { actorType: "member" | "agent"; actorId: string } {
  const taskToken = currentTaskAccessToken(c);
  if (taskToken?.agentId) return { actorType: "agent", actorId: taskToken.agentId };
  const agentId = cleanString(c.req.header("X-Agent-ID"));
  if (agentId) return { actorType: "agent", actorId: agentId };
  return { actorType: "member", actorId: currentRequestUserId(c) };
}

function issueCommentCreateInput(c: Context, input: CreateIssueCommentInput): CreateIssueCommentInput {
  const taskToken = currentTaskAccessToken(c);
  if (taskToken?.agentId) {
    return { ...input, authorType: "agent", authorId: taskToken.agentId };
  }
  if (cleanString(input.authorType) || cleanString(input.authorId)) return input;
  const agentId = cleanString(c.req.header("X-Agent-ID"));
  if (agentId) return { ...input, authorType: "agent", authorId: agentId };
  if (!currentAccessToken(c) && !currentJwtUserId(c)) return input;
  return { ...input, authorType: "member", authorId: currentRequestUserId(c) };
}

function issueSubscriberTarget(
  c: Context,
  body: { member_id?: string; user_id?: string; user_type?: string },
): { userType: "member" | "agent"; userId: string } | { error: string; status: 403 } {
  const caller = issueSubscriberCaller(c);
  const requestedUserType = cleanString(body.user_type);
  const requestedUserId = cleanString(body.user_id) ??
    cleanString(body.member_id);
  const userType = (requestedUserType ?? (body.member_id ? "member" : caller.actorType)).toLowerCase();
  const userId = requestedUserId ?? (userType === "agent" ? caller.actorId : currentRequestUserId(c));
  if (userType !== "member" && userType !== "agent") {
    return { error: "target user is not a member of this workspace", status: 403 };
  }
  return { userType, userId };
}

function issueSubscriberTargetErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "target user is not a member of this workspace") {
    return c.json({ error: message }, 403);
  }
  if (message.startsWith("Issue not found")) return c.json({ error: "issue not found" }, 404);
  return c.json({ error: message }, 400);
}

function issueDependencyCompatibilityResponse(dependency: MultiremiIssueDependency): Record<string, unknown> {
  return {
    id: dependency.id,
    workspace_id: dependency.workspaceId,
    issue_id: dependency.issueId,
    depends_on_issue_id: dependency.dependsOnIssueId,
    type: dependency.type,
    issue: dependency.issue ? issueCompatibilityResponse(dependency.issue) : null,
    depends_on_issue: dependency.dependsOnIssue ? issueCompatibilityResponse(dependency.dependsOnIssue) : null,
    created_at: dependency.createdAt,
  };
}

function issueSearchErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  if (err.message === "q parameter is required") return c.json({ error: "q parameter is required" }, 400);
  return null;
}

function issueErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  if (err.message.startsWith("Issue not found:")) return c.json({ error: "issue not found" }, 404);
  if (err.message.startsWith("Parent issue not found:")) return c.json({ error: "parent issue not found in this workspace" }, 400);
  if (err.message === "Parent issue belongs to another workspace") return c.json({ error: "parent issue not found in this workspace" }, 400);
  if (err.message === "An issue cannot be its own parent") return c.json({ error: "an issue cannot be its own parent" }, 400);
  if (err.message === "Circular issue parent relationship detected") return c.json({ error: "circular parent relationship detected" }, 400);
  if (err.message.startsWith("Project not found:")) return c.json({ error: "project not found in this workspace" }, 400);
  if (err.message === "Project belongs to another workspace") return c.json({ error: "project not found in this workspace" }, 400);
  if (
    err.message.includes("must be a valid date") ||
    err.message.includes("priority must be one of") ||
    err.message.includes("Assignee") ||
    err.message.includes("assignee")
  ) {
    return c.json({ error: err.message }, 400);
  }
  return null;
}

function issueDependencyErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  if (err.message.startsWith("Issue not found:")) return c.json({ error: "issue not found" }, 404);
  if (err.message.startsWith("Dependent issue not found:")) return c.json({ error: "dependent issue not found" }, 400);
  if (err.message === "An issue cannot depend on itself") return c.json({ error: "an issue cannot depend on itself" }, 400);
  if (err.message === "Issue dependency must stay within a workspace") return c.json({ error: "issue dependency must stay within a workspace" }, 400);
  if (err.message.includes("dependency type must be one of")) return c.json({ error: err.message }, 400);
  if (err.message.startsWith("Dependency not found for issue:")) return c.json({ error: "dependency not found" }, 404);
  return null;
}

function withIssueCreateRequestContext(c: Context, input: CreateIssueWithTaskInput): CreateIssueWithTaskInput {
  const workspaceId = cleanString(input.workspace_id) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
  const userId = currentRequestUserId(c);
  const out: CreateIssueWithTaskInput = {
    title: input.title,
    workspace_id: workspaceId,
    created_by: userId,
  };
  if (hasRequestField(input, "description")) out.description = input.description ?? null;
  if (hasRequestField(input, "status")) out.status = input.status;
  if (hasRequestField(input, "priority")) out.priority = input.priority;
  if (hasRequestField(input, "project_id")) out.project_id = input.project_id ?? null;
  if (hasRequestField(input, "parent_issue_id")) out.parent_issue_id = input.parent_issue_id ?? null;
  if (hasRequestField(input, "assignee_type")) out.assignee_type = input.assignee_type ?? null;
  if (hasRequestField(input, "assignee_id")) out.assignee_id = input.assignee_id ?? null;
  if (hasRequestField(input, "position")) out.position = input.position;
  if (hasRequestField(input, "start_date")) out.start_date = input.start_date ?? null;
  if (hasRequestField(input, "due_date")) out.due_date = input.due_date ?? null;
  if (hasRequestField(input, "acceptance_criteria")) out.acceptance_criteria = input.acceptance_criteria ?? [];
  if (hasRequestField(input, "context_refs")) out.context_refs = input.context_refs ?? [];
  return out;
}

function issueUpdateCompatibilityInput(input: UpdateIssueInput = {}): UpdateIssueInput {
  const out: UpdateIssueInput = {};
  if (hasRequestField(input, "title")) out.title = input.title;
  if (hasRequestField(input, "description")) out.description = input.description ?? null;
  if (hasRequestField(input, "status")) out.status = input.status;
  if (hasRequestField(input, "priority")) out.priority = input.priority;
  if (hasRequestField(input, "project_id")) out.project_id = input.project_id ?? null;
  if (hasRequestField(input, "workspace_id")) out.workspace_id = input.workspace_id ?? null;
  if (hasRequestField(input, "parent_issue_id")) out.parent_issue_id = input.parent_issue_id ?? null;
  if (hasRequestField(input, "assignee_type")) out.assignee_type = input.assignee_type ?? null;
  if (hasRequestField(input, "assignee_id")) out.assignee_id = input.assignee_id ?? null;
  if (hasRequestField(input, "position")) out.position = input.position;
  if (hasRequestField(input, "start_date")) out.start_date = input.start_date ?? null;
  if (hasRequestField(input, "due_date")) out.due_date = input.due_date ?? null;
  if (hasRequestField(input, "acceptance_criteria")) out.acceptance_criteria = input.acceptance_criteria ?? [];
  if (hasRequestField(input, "context_refs")) out.context_refs = input.context_refs ?? [];
  return out;
}

function issueQuickCreateCompatibilityInput(input: QuickCreateIssueInput): QuickCreateIssueInput {
  const out: QuickCreateIssueInput = { prompt: input.prompt };
  if (hasRequestField(input, "agent_id")) out.agent_id = input.agent_id ?? null;
  if (hasRequestField(input, "squad_id")) out.squad_id = input.squad_id ?? null;
  if (hasRequestField(input, "project_id")) out.project_id = input.project_id ?? null;
  if (hasRequestField(input, "workspace_id")) out.workspace_id = input.workspace_id ?? null;
  if (hasRequestField(input, "requester_id")) out.requester_id = input.requester_id ?? null;
  return out;
}

function issueBatchUpdateCompatibilityInput(input: BatchUpdateIssuesInput): BatchUpdateIssuesInput {
  return {
    issue_ids: input.issue_ids ?? [],
    updates: issueUpdateCompatibilityInput(input.updates ?? {}),
  };
}

function issueBatchDeleteCompatibilityInput(input: BatchDeleteIssuesInput): BatchDeleteIssuesInput {
  return { issue_ids: input.issue_ids ?? [] };
}

function publishIssueCreated(
  c: Context,
  store: MultiremiStore,
  issue: MultiremiIssue,
  response: Record<string, unknown> = issueCompatibilityResponse(issue),
): void {
  publishWorkspaceEvent(c, store, "issue:created", issue.workspaceId, { issue: response });
}

// go-compat (maybeEnqueueOnAssign): changing an issue's assignee, or moving an
// assigned issue out of backlog, dispatches a task — the update-path twin of
// the assign-on-create block in POST /api/issues. Done/cancelled targets are
// excluded so bulk-closing backlog items doesn't wake agents. If no runnable
// agent is available the assignment stands without a task, matching the Go
// server's "not ready → skip" behavior.
function maybeDispatchOnIssueUpdate(
  store: MultiremiStore,
  previous: MultiremiIssue,
  issue: MultiremiIssue,
  input: UpdateIssueInput,
): MultiremiIssue {
  if (!issue.assigneeType || !issue.assigneeId) return issue;
  if (issue.status === "backlog" || issue.status === "done" || issue.status === "cancelled") return issue;
  const assigneeChanged = hasRequestField(input, "assigneeType", "assignee_type", "assigneeId", "assignee_id") &&
    (previous.assigneeType !== issue.assigneeType || previous.assigneeId !== issue.assigneeId);
  const leftBacklog = hasRequestField(input, "status") && previous.status === "backlog";
  if (!assigneeChanged && !leftBacklog) return issue;
  try {
    return store.assignIssue(issue.id, {
      assigneeType: issue.assigneeType,
      assigneeId: issue.assigneeId,
    }).issue;
  } catch (err) {
    log.warn(`assign-on-update dispatch skipped for ${issue.id}: ${err instanceof Error ? err.message : String(err)}`);
    return issue;
  }
}

function publishIssueUpdated(
  c: Context,
  store: MultiremiStore,
  previous: MultiremiIssue,
  issue: MultiremiIssue,
  input: UpdateIssueInput,
  response: Record<string, unknown> = issueCompatibilityResponse(issue),
): void {
  const assigneeChanged = hasRequestField(input, "assigneeType", "assignee_type", "assigneeId", "assignee_id") &&
    (previous.assigneeType !== issue.assigneeType || previous.assigneeId !== issue.assigneeId);
  const statusChanged = hasRequestField(input, "status") && previous.status !== issue.status;
  const priorityChanged = hasRequestField(input, "priority") && previous.priority !== issue.priority;
  const startDateChanged = previous.startDate !== issue.startDate;
  const dueDateChanged = previous.dueDate !== issue.dueDate;
  const descriptionChanged = hasRequestField(input, "description") && previous.description !== issue.description;
  const titleChanged = hasRequestField(input, "title") && previous.title !== issue.title;
  publishWorkspaceEvent(c, store, "issue:updated", issue.workspaceId, {
    issue: response,
    assignee_changed: assigneeChanged,
    status_changed: statusChanged,
    priority_changed: priorityChanged,
    start_date_changed: startDateChanged,
    due_date_changed: dueDateChanged,
    description_changed: descriptionChanged,
    title_changed: titleChanged,
    prev_title: previous.title,
    prev_assignee_type: previous.assigneeType,
    prev_assignee_id: previous.assigneeId,
    prev_status: previous.status,
    prev_priority: previous.priority,
    prev_start_date: previous.startDate,
    prev_due_date: previous.dueDate,
    prev_description: previous.description,
    creator_type: "member",
    creator_id: previous.createdBy ?? "local",
  });
}

function publishProjectCreated(
  c: Context,
  store: MultiremiStore,
  project: MultiremiProject,
  response: Record<string, unknown> = projectCompatibilityResponse(project),
): void {
  publishWorkspaceEvent(c, store, "project:created", project.workspaceId, { project: response });
}

function publishProjectUpdated(
  c: Context,
  store: MultiremiStore,
  project: MultiremiProject,
  response: Record<string, unknown> = projectCompatibilityResponse(project),
): void {
  publishWorkspaceEvent(c, store, "project:updated", project.workspaceId, { project: response });
}

function publishProjectDeleted(c: Context, store: MultiremiStore, project: MultiremiProject): void {
  publishWorkspaceEvent(c, store, "project:deleted", project.workspaceId, { project_id: project.id });
}

function projectErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  if (err.message === "Project title is required") return c.json({ error: "title is required" }, 400);
  if (err.message.startsWith("Project not found:")) return c.json({ error: "project not found" }, 404);
  return null;
}

function projectSearchErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  if (err.message === "q parameter is required") return c.json({ error: "q parameter is required" }, 400);
  return null;
}

function projectResourceCompatibilityResponse(resource: MultiremiProjectResource): Record<string, unknown> {
  return {
    id: resource.id,
    project_id: resource.projectId,
    workspace_id: resource.workspaceId,
    resource_type: resource.resourceType,
    resource_ref: projectResourceRefCompatibilityResponse(resource),
    label: resource.label,
    position: resource.position,
    created_at: resource.createdAt,
    created_by: resource.createdBy,
  };
}

function projectResourceRefCompatibilityResponse(resource: MultiremiProjectResource): Record<string, unknown> {
  if (resource.resourceType === "github_repo") {
    const url = String(resource.resourceRef.url ?? "");
    const defaultBranchHint = String(resource.resourceRef.default_branch_hint ?? resource.resourceRef.defaultBranchHint ?? "").trim();
    return defaultBranchHint ? { url, default_branch_hint: defaultBranchHint } : { url };
  }
  if (resource.resourceType === "local_directory") {
    const localPath = String(resource.resourceRef.local_path ?? resource.resourceRef.localPath ?? "");
    const daemonId = String(resource.resourceRef.daemon_id ?? resource.resourceRef.daemonId ?? "");
    const label = String(resource.resourceRef.label ?? "").trim();
    return label
      ? { local_path: localPath, daemon_id: daemonId, label }
      : { local_path: localPath, daemon_id: daemonId };
  }
  if (resource.resourceType === "project_ref") {
    return { project_id: String(resource.resourceRef.projectId ?? resource.resourceRef.project_id ?? "") };
  }
  return resource.resourceRef;
}

function loadProjectResourceForMutation(
  c: Context,
  store: MultiremiStore,
  projectId: string,
  resourceId: string,
): MultiremiProjectResource | Response {
  if (!store.getProject(projectId)) return c.json({ error: "project not found" }, 404);
  const resource = store.getProjectResource(resourceId);
  if (!resource || resource.projectId !== projectId) return c.json({ error: "project resource not found" }, 404);
  return resource;
}

function publishProjectResourceCreated(
  c: Context,
  store: MultiremiStore,
  resource: MultiremiProjectResource,
  response: Record<string, unknown> = projectResourceCompatibilityResponse(resource),
): void {
  publishWorkspaceEvent(c, store, "project_resource:created", resource.workspaceId, {
    resource: response,
    project_id: resource.projectId,
  });
}

function publishProjectResourceUpdated(
  c: Context,
  store: MultiremiStore,
  resource: MultiremiProjectResource,
  response: Record<string, unknown> = projectResourceCompatibilityResponse(resource),
): void {
  publishWorkspaceEvent(c, store, "project_resource:updated", resource.workspaceId, {
    resource: response,
    project_id: resource.projectId,
  });
}

function publishProjectResourceDeleted(
  c: Context,
  store: MultiremiStore,
  resource: MultiremiProjectResource,
): void {
  publishWorkspaceEvent(c, store, "project_resource:deleted", resource.workspaceId, {
    project_id: resource.projectId,
    resource_id: resource.id,
  });
}

function projectResourceErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  const message = err.message;
  if (message.startsWith("Project not found")) return c.json({ error: "project not found" }, 404);
  if (message.startsWith("Project resource not found")) return c.json({ error: "project resource not found" }, 404);
  if (message.includes("UNIQUE constraint failed") || message.includes("duplicate key value violates unique constraint")) {
    return c.json({ error: "this resource is already attached to the project" }, 409);
  }
  if (
    message === "this daemon already has a local_directory attached to the project; remove it before adding another"
    || message === "another local_directory on this daemon is already attached to the project"
  ) {
    return c.json({ error: message }, 409);
  }
  if (
    message.includes("resource_type is required")
    || message.includes("unknown resource_type")
    || message.includes("github_repo")
    || message.includes("local_directory")
    || message.includes("project_ref")
    || message === "position must be an integer"
  ) {
    return c.json({ error: message }, 400);
  }
  return null;
}

function runtimeCompatibilityResponse(runtime: MultiremiRuntime): Record<string, unknown> {
  return {
    id: runtime.id,
    workspace_id: runtimeWorkspaceId(runtime),
    daemon_id: runtime.daemonId,
    name: runtime.name,
    runtime_mode: runtime.runtimeMode,
    provider: runtime.provider,
    launch_header: runtimeLaunchHeader(runtime.provider),
    status: runtime.status,
    device_info: runtime.deviceInfo,
    metadata: runtime.metadata,
    owner_id: runtime.ownerId,
    visibility: runtime.visibility,
    last_seen_at: runtime.lastHeartbeatAt,
    created_at: runtime.createdAt,
    updated_at: runtime.updatedAt,
  };
}

/**
 * Union of the online runtimes' model catalogs, grouped by provider — the
 * fleet-level catalog behind machine-less agent creation. A bucket exists for
 * every provider that has a runtime at all (even offline, count 0) so the UI
 * can still offer the engine with a capacity hint.
 */
function fleetModelsResponse(runtimes: MultiremiRuntime[]): Array<Record<string, unknown>> {
  const buckets = new Map<string, { online: number; models: Map<string, MultiremiRuntimeModel> }>();
  const bucket = (provider: string) => {
    let entry = buckets.get(provider);
    if (!entry) {
      entry = { online: 0, models: new Map() };
      buckets.set(provider, entry);
    }
    return entry;
  };
  for (const runtime of runtimes) {
    if (runtime.provider && runtime.provider !== "any") bucket(runtime.provider);
    // An "any" runtime can execute every known engine — surface those engines
    // (with its capacity counted below) even when no dedicated runtime exists.
    if (runtime.provider === "any") for (const provider of MULTIREMI_DAEMON_PROVIDERS) bucket(provider);
    if (runtime.status !== "online") continue;
    for (const model of runtime.models ?? []) {
      const provider = model.provider || (runtime.provider !== "any" ? runtime.provider : "");
      if (!provider) continue;
      const entry = bucket(provider);
      const existing = entry.models.get(model.id);
      if (!existing || (model.default && !existing.default)) entry.models.set(model.id, model);
    }
  }
  for (const runtime of runtimes) {
    if (runtime.status !== "online") continue;
    for (const [provider, entry] of buckets) {
      if (runtime.provider === provider || runtime.provider === "any") entry.online += 1;
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, entry]) => ({
      provider,
      online_runtime_count: entry.online,
      models: [...entry.models.values()].map(runtimeModelCompatibilityResponse),
    }));
}

function runtimeModelCompatibilityResponse(model: MultiremiRuntimeModel): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: model.id,
    label: model.label,
  };
  if (model.provider) response.provider = model.provider;
  if (model.default) response.default = true;
  if (model.thinking) {
    response.thinking = {
      supported_levels: (model.thinking.supportedLevels ?? model.thinking.supported_levels ?? []).map((level) => ({
        value: level.value,
        label: level.label,
        ...(level.description ? { description: level.description } : {}),
      })),
      ...(model.thinking.defaultLevel ?? model.thinking.default_level
        ? { default_level: model.thinking.defaultLevel ?? model.thinking.default_level }
        : {}),
    };
  }
  return response;
}

function runtimeModelListRequestCompatibilityResponse(request: MultiremiRuntimeModelListRequest): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: request.id,
    runtime_id: request.runtimeId,
    status: request.status,
    supported: request.supported,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
  if (request.models.length) response.models = request.models.map(runtimeModelCompatibilityResponse);
  if (request.error) response.error = request.error;
  return response;
}

function runtimeUpdateRequestCompatibilityResponse(request: MultiremiRuntimeUpdateRequest): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: request.id,
    runtime_id: request.runtimeId,
    status: request.status,
    scope: request.scope,
    target_version: request.targetVersion,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
  if (request.output) response.output = request.output;
  if (request.error) response.error = request.error;
  return response;
}

function runtimeLocalSkillSummaryCompatibilityResponse(skill: MultiremiRuntimeLocalSkillSummary): Record<string, unknown> {
  const response: Record<string, unknown> = {
    key: skill.key,
    name: skill.name,
    source_path: skill.sourcePath,
    provider: skill.provider,
    file_count: skill.fileCount,
  };
  if (skill.description) response.description = skill.description;
  return response;
}

function runtimeLocalSkillListRequestCompatibilityResponse(request: MultiremiRuntimeLocalSkillListRequest): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: request.id,
    runtime_id: request.runtimeId,
    status: request.status,
    supported: request.supported,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
  if (request.skills.length) response.skills = request.skills.map(runtimeLocalSkillSummaryCompatibilityResponse);
  if (request.error) response.error = request.error;
  return response;
}

function directoryScanErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  if (err.message === 'directory scan mode must be "scan" or "browse"') return c.json({ error: err.message }, 400);
  return null;
}

function runtimeDirectoryCandidateCompatibilityResponse(candidate: MultiremiRuntimeDirectoryCandidate): Record<string, unknown> {
  return {
    path: candidate.path,
    name: candidate.name,
    remote_url: candidate.remoteUrl,
    current_branch: candidate.currentBranch,
    is_dirty: candidate.isDirty,
    is_git_repo: candidate.isGitRepo ?? null,
  };
}

function runtimeDirectoryScanRequestCompatibilityResponse(request: MultiremiRuntimeDirectoryScanRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (request.params.root !== undefined) params.root = request.params.root;
  if (request.params.maxDepth !== undefined) params.max_depth = request.params.maxDepth;
  if (request.params.mode !== undefined) params.mode = request.params.mode;
  if (request.params.resolvedRoot !== undefined) params.resolved_root = request.params.resolvedRoot;
  return {
    id: request.id,
    runtime_id: request.runtimeId,
    status: request.status,
    params,
    candidates: request.candidates.map(runtimeDirectoryCandidateCompatibilityResponse),
    supported: request.supported,
    error: request.error,
    run_started_at: request.runStartedAt,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
}

function runtimeLocalSkillImportRequestCompatibilityResponse(request: MultiremiRuntimeLocalSkillImportRequest): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: request.id,
    runtime_id: request.runtimeId,
    skill_key: request.skillKey,
    status: request.status,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
  if (request.name) response.name = request.name;
  if (request.description) response.description = request.description;
  if (request.skill) response.skill = skillWithFilesCompatibilityResponse(request.skill);
  if (request.error) response.error = request.error;
  return response;
}

function requestedSkillWorkspaceId(
  c: Context,
  input?: Pick<CreateSkillInput | ImportSkillInput | UpdateSkillInput, "workspaceId" | "workspace_id">,
): string {
  return cleanString(input?.workspaceId) ??
    cleanString(input?.workspace_id) ??
    cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
}

function skillWorkspaceId(skill: MultiremiSkill): string {
  return skill.workspaceId ?? "local";
}

function withSkillCreateRequestContext(
  c: Context,
  store: MultiremiStore,
  input: CreateSkillInput,
): CreateSkillInput | Response {
  const workspaceId = requestedSkillWorkspaceId(c, input);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const userId = currentRequestUserId(c);
  return {
    ...input,
    workspaceId,
    workspace_id: workspaceId,
    createdBy: userId,
    created_by: userId,
  };
}

function withSkillImportRequestContext(
  c: Context,
  store: MultiremiStore,
  input: ImportSkillInput,
): ImportSkillInput | Response {
  const workspaceId = requestedSkillWorkspaceId(c, input);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const userId = currentRequestUserId(c);
  return {
    ...input,
    workspaceId,
    workspace_id: workspaceId,
    createdBy: userId,
    created_by: userId,
  };
}

function withSkillUpdateRequestContext(current: MultiremiSkill, input: UpdateSkillInput): UpdateSkillInput {
  const workspaceId = skillWorkspaceId(current);
  return {
    ...input,
    workspaceId,
    workspace_id: workspaceId,
    createdBy: current.createdBy ?? null,
    created_by: current.createdBy ?? null,
  };
}

function loadSkillForCurrentUser(
  c: Context,
  store: MultiremiStore,
  skillId: string,
): { skill: MultiremiSkill } | Response {
  const skill = store.getSkill(skillId);
  if (!skill) return c.json({ error: "skill not found" }, 404);
  const workspaceId = skillWorkspaceId(skill);
  if (requestedSkillWorkspaceId(c) !== workspaceId) return c.json({ error: "skill not found" }, 404);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return c.json({ error: "skill not found" }, 404);
  return { skill };
}

function loadSkillForCurrentManager(
  c: Context,
  store: MultiremiStore,
  skillId: string,
): { skill: MultiremiSkill } | Response {
  const loaded = loadSkillForCurrentUser(c, store, skillId);
  if (loaded instanceof Response) return loaded;
  const role = currentWorkspaceRoleStrict(c, store, skillWorkspaceId(loaded.skill));
  if (!role) return c.json({ error: "skill not found" }, 404);
  if (role === "owner" || role === "admin" || loaded.skill.createdBy === currentRequestUserId(c)) {
    return loaded;
  }
  return c.json({ error: "only the skill creator can manage this skill" }, 403);
}

function loadAgentForCurrentManager(
  c: Context,
  store: MultiremiStore,
  agentId: string,
): { agent: MultiremiAgent } | Response {
  if (currentTaskAccessToken(c)) return c.json({ error: "this endpoint is only available to human actors" }, 403);
  const loaded = loadAgentForCurrentUser(c, store, agentId);
  if (loaded instanceof Response) return loaded;
  const role = currentWorkspaceRoleStrict(c, store, loaded.agent.workspaceId);
  if (!role) return c.json({ error: "agent not found" }, 404);
  if (role === "owner" || role === "admin" || loaded.agent.ownerId === currentRequestUserId(c)) {
    return loaded;
  }
  return c.json({ error: "only the agent owner can manage this agent" }, 403);
}

function loadAgentEnvForCurrentAdmin(
  c: Context,
  store: MultiremiStore,
  agentId: string,
): { agent: MultiremiAgent } | Response {
  if (currentTaskAccessToken(c)) return c.json({ error: "this endpoint is only available to human actors" }, 403);
  const loaded = loadAgentForCurrentUser(c, store, agentId);
  if (loaded instanceof Response) return loaded;
  const role = currentWorkspaceRoleStrict(c, store, loaded.agent.workspaceId);
  if (!role) return c.json({ error: "agent not found" }, 404);
  if (role === "owner" || role === "admin") return loaded;
  return c.json({ error: "insufficient permissions" }, 403);
}

function publishAgentSkillsEvent(
  c: Context,
  store: MultiremiStore,
  agent: MultiremiAgent,
  skills: MultiremiSkill[],
): void {
  publishWorkspaceEvent(c, store, "agent:status", agent.workspaceId, {
    agent_id: agent.id,
    skills: skills.map(skillSummaryCompatibilityResponse),
  });
}

function publishAgentLifecycleEvent(
  c: Context,
  store: MultiremiStore,
  type: "agent:created" | "agent:status" | "agent:archived" | "agent:restored",
  agent: MultiremiAgent,
): void {
  publishWorkspaceEvent(c, store, type, agent.workspaceId, {
    agent: agentBroadcastCompatibilityResponse(store, agent),
  });
}

function recordAgentCreatedAnalytics(
  c: Context,
  store: MultiremiStore,
  agent: MultiremiAgent,
  runtime: MultiremiRuntime | null,
  input: { template?: string | null; isFirstAgentInWorkspace: boolean },
): void {
  store.recordAgentCreated({
    actorId: currentRequestUserId(c),
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    provider: agentAnalyticsProvider(agent, runtime),
    runtimeMode: runtime?.runtimeMode ?? "unknown",
    template: cleanString(input.template ?? null) ?? "",
    isFirstAgentInWorkspace: input.isFirstAgentInWorkspace,
  });
}

function recordSystemAgentCreatedAnalytics(
  store: MultiremiStore,
  agent: MultiremiAgent,
  runtime: MultiremiRuntime,
  input: { actorId: string; template?: string | null; isFirstAgentInWorkspace: boolean },
): void {
  store.recordAgentCreated({
    actorId: input.actorId,
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    provider: agentAnalyticsProvider(agent, runtime),
    runtimeMode: runtime.runtimeMode,
    template: cleanString(input.template ?? null) ?? "",
    isFirstAgentInWorkspace: input.isFirstAgentInWorkspace,
  });
}

function runtimeForAgentInput(
  store: MultiremiStore,
  input: { runtimeId?: string | null; runtime_id?: string | null },
): MultiremiRuntime | null {
  const runtimeId = cleanString(input.runtimeId ?? input.runtime_id);
  return runtimeId ? store.getRuntime(runtimeId) : null;
}

function agentAnalyticsProvider(agent: MultiremiAgent, runtime: MultiremiRuntime | null): string {
  if (runtime?.provider && runtime.provider !== "any") return runtime.provider;
  return agent.provider;
}

function isFirstAgentInWorkspace(store: MultiremiStore, workspaceId: string): boolean {
  return store.listAgents().every((agent) => agent.workspaceId !== workspaceId);
}

function sanitizeSkillFilesForCompatibility<T extends { files?: MultiremiSkillFile[] }>(input: T): T {
  if (!Array.isArray(input.files)) return input;
  return {
    ...input,
    files: input.files.filter((file) => !isReservedSkillContentPath(file.path)),
  };
}

function isReservedSkillContentPath(path: unknown): boolean {
  const rawPath = String(path ?? "").replace(/\\/g, "/");
  if (rawPath.startsWith("/")) return false;
  const cleaned = cleanRelativeSkillPath(rawPath);
  return !cleaned.startsWith("..") && cleaned.toLowerCase() === "skill.md";
}

function cleanRelativeSkillPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else {
        parts.push("..");
      }
      continue;
    }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : ".";
}

function skillCompatibilityErrorResponse(
  c: Context,
  error: unknown,
  options: {
    invalidPathIncludesPath?: boolean;
    duplicateImportInput?: CreateSkillInput;
    store?: MultiremiStore;
  } = {},
): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Skill not found")) return c.json({ error: "skill not found" }, 404);
  if (message.startsWith("Agent not found")) return c.json({ error: "agent not found" }, 404);
  if (message === "Skill name is required") return c.json({ error: "name is required" }, 400);
  if (message.startsWith("Invalid skill file path:")) {
    const path = message.slice("Invalid skill file path:".length).trim();
    return c.json({ error: options.invalidPathIncludesPath && path ? `invalid file path: ${path}` : "invalid file path" }, 400);
  }
  if (message === "Skill files should not include SKILL.md") {
    return c.json({ error: "SKILL.md is reserved for the primary skill content" }, 400);
  }
  if (isUniqueSkillNameError(message)) {
    if (options.duplicateImportInput && options.store) {
      const existing = existingSkillIdentityForInput(options.store, options.duplicateImportInput);
      if (existing) {
        return c.json({
          error: "a skill with this name already exists",
          existing_skill: existing,
        }, 409);
      }
    }
    return c.json({ error: "a skill with this name already exists" }, 409);
  }
  return c.json({ error: message }, 500);
}

function isUniqueSkillNameError(message: string): boolean {
  return message.includes("UNIQUE constraint failed: multiremi_skills.workspace_id, multiremi_skills.name")
    || message.includes("constraint failed") && message.includes("multiremi_skills.workspace_id") && message.includes("multiremi_skills.name");
}

function existingSkillIdentityForInput(store: MultiremiStore, input: CreateSkillInput): { id: string; name: string } | null {
  const name = input.name?.trim();
  if (!name) return null;
  const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
  const existing = store.listSkills(workspaceId, { includeFiles: false }).find((skill) => skill.name === name);
  if (!existing?.id) return null;
  return { id: existing.id, name: existing.name };
}

function runtimeUsageDailyCompatibilityResponse(row: {
  date: string;
  runtimeId?: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): Record<string, unknown> {
  return {
    runtime_id: row.runtimeId ?? null,
    date: row.date,
    provider: row.provider,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
  };
}

function compareRuntimeUsageDailyCompatibilityRows(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return String(right.date ?? "").localeCompare(String(left.date ?? "")) ||
    String(left.provider ?? "").localeCompare(String(right.provider ?? "")) ||
    String(left.model ?? "").localeCompare(String(right.model ?? ""));
}

function runtimeUsageByAgentCompatibilityResponse(row: {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}): Record<string, unknown> {
  return {
    agent_id: row.agentId,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
    task_count: row.taskCount,
  };
}

function runtimeUsageByHourCompatibilityResponse(row: {
  hour: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}): Record<string, unknown> {
  return {
    hour: row.hour,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
    task_count: row.taskCount,
  };
}

function runtimeTaskActivityCompatibilityResponse(row: { hour: number; count: number }): Record<string, unknown> {
  return {
    hour: row.hour,
    count: row.count,
  };
}

function runtimeLaunchHeader(provider: string): string {
  if (provider === "claude") return "claude (stream-json)";
  if (provider === "codex") return "codex app-server";
  return "";
}

function parseExpectedActiveAgentIds(c: Context, value: unknown): string[] | Response {
  if (!Array.isArray(value)) {
    return c.json({ error: "expected_active_agent_ids must be a list of valid UUIDs" }, 400);
  }
  const ids = new Set<string>();
  for (const item of value) {
    const id = cleanString(typeof item === "string" ? item : null);
    if (!id) return c.json({ error: "expected_active_agent_ids must be a list of valid UUIDs" }, 400);
    ids.add(id);
  }
  return [...ids];
}

function denyCurrentUserRuntimeWorkspaceAccess(c: Context, store: MultiremiStore, runtime: MultiremiRuntime): Response | null {
  const workspaceId = runtimeWorkspaceId(runtime);
  const token = currentAccessToken(c);
  if (token?.type === "daemon") return c.json({ error: "forbidden for daemon token" }, 403);
  const userId = authenticatedRequestUserId(c);
  // Same rule as denyCurrentUserWorkspaceAccess: a human's login PAT is not
  // workspace-scoped — membership decides which runtimes they can see.
  const humanPat = token?.type === "pat" && userId && userId !== "local";
  if (!humanPat && token?.workspaceId && token.workspaceId !== workspaceId) {
    return c.json({ error: "runtime not found" }, 404);
  }
  if (token?.type === "task") return null;
  // A logged-in human who is not a member of the runtime's workspace can't see it.
  if (userId && !store.getUserRoleInWorkspace(userId, workspaceId)) {
    return c.json({ error: "runtime not found" }, 404);
  }
  return null;
}

function withAgentRequestContext(c: Context, store: MultiremiStore, input: CreateAgentInput): CreateAgentInput | Response {
  const workspaceId = requestedAgentWorkspaceId(c, input);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const name = cleanString(typeof input.name === "string" ? input.name : null);
  if (!name) return c.json({ error: "name is required" }, 400);
  const provider = resolveAgentRequestProvider(c, store, workspaceId, input);
  if (provider instanceof Response) return provider;
  const conflict = store.getAgentByWorkspaceAndName(workspaceId, name);
  if (conflict) return agentNameConflict(c, name);
  const maxConcurrentTasks = normalizeAgentRequestMaxConcurrentTasks(c, input.maxConcurrentTasks ?? input.max_concurrent_tasks);
  if (maxConcurrentTasks instanceof Response) return maxConcurrentTasks;
  const description = normalizeAgentRequestDescription(c, input.description);
  if (description instanceof Response) return description;
  const thinkingLevel = agentRequestThinkingLevel(input);
  if (!isKnownThinkingValue(provider, thinkingLevel)) {
    return agentThinkingLevelError(c, thinkingLevel, provider);
  }
  const ownerId = currentRequestUserId(c);
  return {
    ...input,
    name,
    description,
    provider,
    workspaceId,
    workspace_id: workspaceId,
    ownerId,
    owner_id: ownerId,
    runtimeId: null,
    runtime_id: null,
    maxConcurrentTasks,
    max_concurrent_tasks: maxConcurrentTasks,
  };
}

function withAgentUpdateRequestContext(
  c: Context,
  store: MultiremiStore,
  current: MultiremiAgent,
  input: UpdateAgentInput,
): UpdateAgentInput | Response {
  const next: UpdateAgentInput = { ...input };
  if (hasRequestField(input, "custom_env", "customEnv", "env")) {
    return c.json({
      error: "custom_env is no longer accepted on this endpoint; use PUT /api/agents/{id}/env (or `multiremi agent env set`)",
    }, 400);
  }
  if (hasRequestField(input, "name")) {
    const name = cleanString(typeof input.name === "string" ? input.name : null);
    if (!name) return c.json({ error: "name is required" }, 400);
    const conflict = store.getAgentByWorkspaceAndName(current.workspaceId, name);
    if (conflict && conflict.id !== current.id) return agentNameConflict(c, name);
    next.name = name;
  }
  if (hasRequestField(input, "description")) {
    const description = normalizeAgentRequestDescription(c, input.description);
    if (description instanceof Response) return description;
    next.description = description;
  }
  let targetProvider = current.provider;
  let providerChanged = false;
  const applyProvider = (provider: string) => {
    targetProvider = provider;
    providerChanged = provider !== current.provider;
    next.provider = provider;
  };
  if (hasRequestField(input, "provider")) {
    const provider = cleanString(typeof input.provider === "string" ? input.provider : null);
    if (!provider || !MULTIREMI_DAEMON_PROVIDERS.has(provider)) {
      return c.json({ error: `unknown provider "${provider ?? ""}"` }, 400);
    }
    applyProvider(provider);
  }
  // Agents are pool workers now — machine binding is gone. A legacy "move to
  // runtime" request keeps its one observable effect, switching the agent's
  // engine, with full legacy validation (existence, workspace, the
  // private-runtime gate). The binding itself is dropped.
  if (hasRequestField(input, "runtimeId", "runtime_id")) {
    const legacyRuntimeId = cleanString(input.runtimeId ?? input.runtime_id);
    delete next.runtimeId;
    delete next.runtime_id;
    if (legacyRuntimeId) {
      const provider = resolveAgentRequestProvider(c, store, current.workspaceId, {
        runtime_id: legacyRuntimeId,
        provider: input.provider,
      });
      if (provider instanceof Response) return provider;
      applyProvider(provider);
    }
  }
  if (hasRequestField(input, "thinkingLevel", "thinking_level")) {
    const thinkingLevel = agentRequestThinkingLevel(input);
    if (!isKnownThinkingValue(targetProvider, thinkingLevel)) {
      return agentThinkingLevelError(c, thinkingLevel, targetProvider);
    }
  } else if (providerChanged && current.thinkingLevel && !isKnownThinkingValue(targetProvider, current.thinkingLevel)) {
    return c.json({
      error: `existing thinking_level "${current.thinkingLevel}" is not valid for provider "${targetProvider}"; pass thinking_level="" to clear or set a value valid for the new provider`,
    }, 400);
  }
  // A model id is engine-specific — carrying e.g. a claude model onto codex
  // would hand the codex CLI an unknown model. Unless the request also picks
  // a model, an engine switch resets it to the engine default.
  if (providerChanged && !hasRequestField(input, "model")) {
    next.model = "";
  }
  if (hasRequestField(input, "maxConcurrentTasks", "max_concurrent_tasks")) {
    const maxConcurrentTasks = normalizeAgentRequestMaxConcurrentTasks(c, input.maxConcurrentTasks ?? input.max_concurrent_tasks);
    if (maxConcurrentTasks instanceof Response) return maxConcurrentTasks;
    next.maxConcurrentTasks = maxConcurrentTasks;
    next.max_concurrent_tasks = maxConcurrentTasks;
  }
  return next;
}

function withAgentTemplateRequestContext(
  c: Context,
  store: MultiremiStore,
  input: CreateAgentFromTemplateInput,
): CreateAgentFromTemplateInput | Response {
  const workspaceId = requestedAgentWorkspaceId(c, input);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const name = cleanString(typeof input.name === "string" ? input.name : null);
  if (!name) return c.json({ error: "name is required" }, 400);
  const templateSlug = cleanString(input.templateSlug ?? input.template_slug);
  if (!templateSlug) return c.json({ error: "template_slug is required" }, 400);
  const template = getAgentTemplate(templateSlug);
  if (!template) return c.json({ error: `template not found: ${templateSlug}` }, 400);
  const conflict = store.getAgentByWorkspaceAndName(workspaceId, name);
  if (conflict) return agentNameConflict(c, name);
  const provider = resolveAgentRequestProvider(c, store, workspaceId, input);
  if (provider instanceof Response) return provider;
  const maxConcurrentTasks = normalizeAgentRequestMaxConcurrentTasks(c, input.maxConcurrentTasks ?? input.max_concurrent_tasks);
  if (maxConcurrentTasks instanceof Response) return maxConcurrentTasks;
  const description = normalizeAgentRequestDescription(c, input.description ?? template.description);
  if (description instanceof Response) return description;
  const ownerId = currentRequestUserId(c);
  return {
    ...input,
    name,
    description,
    provider,
    workspaceId,
    workspace_id: workspaceId,
    ownerId,
    owner_id: ownerId,
    runtimeId: null,
    runtime_id: null,
    maxConcurrentTasks,
    max_concurrent_tasks: maxConcurrentTasks,
  };
}

/**
 * Resolve the provider for an agent create request. Agents are pool workers —
 * they never bind to a runtime — but legacy clients still send runtime_id, so
 * a supplied one keeps its full validation (existence, workspace, visibility)
 * and contributes only its provider.
 */
function resolveAgentRequestProvider(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
  input: { runtimeId?: string | null; runtime_id?: string | null; provider?: unknown },
): string | Response {
  const runtimeId = cleanString(input.runtimeId ?? input.runtime_id);
  if (runtimeId) {
    const runtime = store.getRuntime(runtimeId);
    if (!runtime || (runtime.workspaceId ?? "local") !== workspaceId) {
      return c.json({ error: "invalid runtime_id" }, 400);
    }
    if (!canCurrentUserUseRuntime(c, store, runtime)) {
      return c.json({ error: "this runtime is private; only its owner or a workspace admin can create agents on it" }, 403);
    }
    // An "any" runtime contributes no provider of its own — the requested one
    // falls through and must still pass the whitelist.
    const derived = agentProviderForRuntime(input.provider, runtime);
    if (!MULTIREMI_DAEMON_PROVIDERS.has(derived)) {
      return c.json({ error: `unknown provider "${derived}"` }, 400);
    }
    return derived;
  }
  const provider = cleanString(typeof input.provider === "string" ? input.provider : null) ?? "claude";
  if (!MULTIREMI_DAEMON_PROVIDERS.has(provider)) {
    return c.json({ error: `unknown provider "${provider}"` }, 400);
  }
  return provider;
}

function canCurrentUserUseRuntime(c: Context, store: MultiremiStore, runtime: MultiremiRuntime): boolean {
  const workspaceId = runtime.workspaceId ?? "local";
  const role = currentWorkspaceRole(c, store, workspaceId);
  if (role === "owner" || role === "admin") return true;
  if (runtime.visibility === "public") return true;
  return runtime.ownerId === currentRequestUserId(c);
}

function agentProviderForRuntime(provider: unknown, runtime: MultiremiRuntime): CreateAgentInput["provider"] {
  if (runtime.provider && runtime.provider !== "any") return runtime.provider;
  return cleanString(typeof provider === "string" ? provider : null) ?? "claude";
}

function normalizeAgentRequestDescription(c: Context, value: unknown): string | Response {
  const description = String(value ?? "");
  if (Array.from(description).length > MAX_AGENT_DESCRIPTION_LENGTH) {
    return c.json({ error: `description must be ${MAX_AGENT_DESCRIPTION_LENGTH} characters or fewer` }, 400);
  }
  return description;
}

function agentRequestThinkingLevel(input: CreateAgentInput | UpdateAgentInput): string {
  return String(input.thinkingLevel ?? input.thinking_level ?? "");
}

function isKnownThinkingValue(provider: string, value: string): boolean {
  if (!value) return true;
  return PROVIDER_THINKING_LEVELS[provider]?.has(value) ?? false;
}

function agentThinkingLevelError(c: Context, value: string, provider: string): Response {
  return c.json({ error: `thinking_level "${value}" is not a recognised value for runtime "${provider}"` }, 400);
}

function normalizeAgentRequestMaxConcurrentTasks(c: Context, value: unknown): number | Response {
  const concurrency = Number(value ?? 0);
  if (!concurrency) return 6;
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    return c.json({ error: "max_concurrent_tasks must be at least 1" }, 400);
  }
  return Math.trunc(concurrency);
}

function agentNameConflict(c: Context, name: string): Response {
  return c.json({ error: `an agent named "${name}" already exists in this workspace` }, 409);
}

function hasRequestField(input: object, ...fields: string[]): boolean {
  return fields.some((field) => Object.prototype.hasOwnProperty.call(input, field));
}

function loadAgentForCurrentUser(
  c: Context,
  store: MultiremiStore,
  agentId: string,
): { agent: MultiremiAgent } | Response {
  const agent = store.getAgent(agentId);
  if (!agent) return c.json({ error: "agent not found" }, 404);
  const denied = denyCurrentUserWorkspaceAccess(c, store, agent.workspaceId);
  if (denied) return denied;
  if (!canCurrentUserAccessAgent(c, store, agent)) {
    return c.json({ error: "you do not have access to this agent" }, 403);
  }
  return { agent };
}

function canCurrentUserAccessAgent(c: Context, store: MultiremiStore, agent: MultiremiAgent): boolean {
  if (agent.visibility !== "private") return true;
  const userId = currentRequestUserId(c);
  if (agent.ownerId === userId) return true;
  const role = currentWorkspaceRole(c, store, agent.workspaceId);
  return role === "owner" || role === "admin";
}

function currentWorkspaceRole(c: Context, store: MultiremiStore, workspaceId: string): string {
  const member = currentWorkspaceMember(c, store, workspaceId);
  if (member) return member.role;
  // No real member: only the no-identity admin path (master token / open mode)
  // is treated as local owner. A logged-in non-member is NOT auto-"member".
  if (workspaceId === "local" && authenticatedRequestUserId(c) === null) return "owner";
  return "member";
}

function currentWorkspaceRoleStrict(c: Context, store: MultiremiStore, workspaceId: string): string | null {
  const member = currentWorkspaceMember(c, store, workspaceId);
  if (member) return member.role;
  if (workspaceId === "local" && authenticatedRequestUserId(c) === null) return "owner";
  return null;
}

function currentWorkspaceMember(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
): MultiremiWorkspaceMember | null {
  const userId = currentRequestUserId(c);
  return store.listWorkspaceMembers(workspaceId).find((item) =>
    item.userId === userId || item.id === userId || item.id === `mem_${workspaceId}_${userId}`
  ) ?? null;
}

function loadCurrentWorkspaceMember(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
): { member: MultiremiWorkspaceMember } | Response {
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const workspace = workspaceId === "local" ? store.ensureLocalWorkspace() : store.getWorkspace(workspaceId);
  if (!workspace) return c.json({ error: "workspace not found" }, 404);
  const member = currentWorkspaceMember(c, store, workspaceId);
  if (!member) return c.json({ error: "workspace not found" }, 404);
  return { member };
}

function loadCurrentWorkspaceRole(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
  roles: Array<"owner" | "admin" | "member">,
): { member: MultiremiWorkspaceMember } | Response {
  const loaded = loadCurrentWorkspaceMember(c, store, workspaceId);
  if (loaded instanceof Response) return loaded;
  if (!roles.includes(loaded.member.role as "owner" | "admin" | "member")) {
    return c.json({ error: "insufficient permissions" }, 403);
  }
  return loaded;
}

function withChatSessionCreator(
  c: Context,
  input: CreateChatSessionInput,
): CreateChatSessionInput {
  const creatorId = currentRequestUserId(c);
  return { ...input, creatorId, creator_id: creatorId };
}

function requestedChatWorkspaceId(c: Context, input?: Pick<CreateChatSessionInput, "workspaceId" | "workspace_id">): string {
  return cleanString(input?.workspaceId) ??
    cleanString(input?.workspace_id) ??
    cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id")) ??
    "local";
}

function denyCurrentUserWorkspaceAccess(c: Context, store: MultiremiStore, workspaceId: string): Response | null {
  const token = currentAccessToken(c);
  if (token?.type === "daemon") return c.json({ error: "forbidden for daemon token" }, 403);
  const userId = authenticatedRequestUserId(c);
  // Tokens bound to one workspace (task tokens, user-less workspace PATs) can't
  // reach others. A human's login PAT is minted under "local" but is a session
  // credential, not a scope — the membership check below is the authority for
  // real users, otherwise they could never open a workspace created after login.
  const humanPat = token?.type === "pat" && userId && userId !== "local";
  if (!humanPat && token?.workspaceId && token.workspaceId !== workspaceId) {
    return c.json({ error: "workspace not found" }, 404);
  }
  // Task tokens are scoped by the check above and act on behalf of a task within
  // their workspace — no separate membership row required.
  if (token?.type === "task") return null;
  // Any authenticated human (login PAT or JWT) must be a member of the workspace;
  // non-members get 404 (existence hidden). No user id (or the synthetic "local"
  // admin identity carried by user-less workspace access tokens) => master token /
  // open mode => full admin access.
  if (userId && userId !== "local" && !store.getUserRoleInWorkspace(userId, workspaceId)) {
    return c.json({ error: "workspace not found" }, 404);
  }
  return null;
}

// Pins are private to their owner. When the request is authenticated as a real
// user, the pin's user id must equal that user — nobody can read or mutate
// another person's pins. Master-token / open mode (no authenticated user id)
// keeps full access.
function denyPinOwnerAccess(c: Context, userId: string): Response | null {
  const authUser = authenticatedRequestUserId(c);
  if (authUser && userId !== authUser) return c.json({ error: "forbidden" }, 403);
  return null;
}

function withChatSessionRequestContext(c: Context, store: MultiremiStore, input: CreateChatSessionInput): CreateChatSessionInput | Response {
  const workspaceId = requestedChatWorkspaceId(c, input);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const agentId = cleanString(input.agentId ?? input.agent_id);
  if (!agentId) return c.json({ error: "agent_id is required" }, 400);
  const agent = store.getAgent(agentId);
  if (!agent || agent.workspaceId !== workspaceId) return c.json({ error: "agent not found" }, 404);
  if (!canCurrentUserAccessAgent(c, store, agent)) {
    return c.json({ error: "you do not have access to this agent" }, 403);
  }
  return withChatSessionCreator(c, { ...input, workspaceId, workspace_id: workspaceId });
}

function loadChatSessionForCurrentUser(
  c: Context,
  store: MultiremiStore,
  sessionId: string,
  options: { requireAgentAccess?: boolean } = {},
): { session: MultiremiChatSession } | Response {
  const session = store.getChatSession(sessionId);
  if (!session) return c.json({ error: "chat session not found" }, 404);
  const denied = denyCurrentUserWorkspaceAccess(c, store, session.workspaceId);
  if (denied) return denied;
  if ((session.creatorId ?? "local") !== currentRequestUserId(c)) {
    return c.json({ error: "not your chat session" }, 403);
  }
  if (options.requireAgentAccess !== false && !canCurrentUserAccessChatSessionAgent(c, store, session)) {
    return c.json({ error: "you do not have access to this agent" }, 403);
  }
  return { session };
}

function canCurrentUserAccessChatSessionAgent(
  c: Context,
  store: MultiremiStore,
  session: MultiremiChatSession,
): boolean {
  const agent = store.getAgent(session.agentId);
  return Boolean(agent && agent.workspaceId === session.workspaceId && canCurrentUserAccessAgent(c, store, agent));
}

// Go-style access boundary for reading/serving/deleting an attachment file. Chat
// attachments are private to the chat creator like the chat session itself; issue,
// comment, and free-standing attachments are scoped to the attachment workspace.
// Returns a denial Response when access is forbidden, or null when allowed.
function denyAttachmentAccess(c: Context, store: MultiremiStore, attachment: MultiremiAttachment): Response | null {
  if (attachment.chatSessionId) {
    const loaded = loadChatSessionForCurrentUser(c, store, attachment.chatSessionId, { requireAgentAccess: false });
    return loaded instanceof Response ? loaded : null;
  }
  return denyCurrentUserWorkspaceAccess(c, store, attachment.workspaceId);
}

function normalizeSendChatMessageInput(c: Context, input: SendChatMessageInput): SendChatMessageInput | Response {
  const body = cleanString(input.body ?? input.content);
  if (!body) return c.json({ error: "content is required" }, 400);
  const rawAttachmentIds = input.attachmentIds ?? input.attachment_ids;
  if (rawAttachmentIds != null && !Array.isArray(rawAttachmentIds)) {
    return c.json({ error: "invalid attachment_ids" }, 400);
  }
  const attachmentIds = rawAttachmentIds ? uniqueStrings(rawAttachmentIds) : [];
  return { ...input, body, attachmentIds, attachment_ids: attachmentIds };
}

function hasJwtWorkspaceAccess(store: MultiremiStore, userId: string, workspaceId: string): boolean {
  return store.getUserRoleInWorkspace(userId, workspaceId) !== null;
}

type DaemonWorkspaceDenyOptions = {
  hideForbiddenAsNotFound?: boolean;
};

function isDaemonGcCheckRequest(c: Context): boolean {
  return new URL(c.req.url).pathname.endsWith("/gc-check");
}

function denyDaemonTokenWorkspace(c: Context, workspaceId?: string | null, options: DaemonWorkspaceDenyOptions = {}): Response | null {
  const token = currentAccessToken(c);
  if (token?.type !== "daemon") return null;
  const targetWorkspaceId = cleanString(workspaceId) ?? "local";
  if (token.workspaceId === targetWorkspaceId) return null;
  if (options.hideForbiddenAsNotFound) return c.json({ error: "not found" }, 404);
  return c.json({ error: "forbidden for daemon token workspace" }, 403);
}

function denyDaemonTokenRuntimeWorkspace(
  c: Context,
  store: MultiremiStore,
  runtimeId: string,
  options: DaemonWorkspaceDenyOptions = {},
): Response | null {
  if (currentAccessToken(c)?.type !== "daemon") return null;
  const runtime = store.getRuntime(runtimeId);
  if (!runtime) return c.json({ error: "runtime not found" }, 404);
  return denyDaemonTokenWorkspace(c, runtime.workspaceId ?? "local", options);
}

function normalizeRuntimeIds(value: unknown): { runtimeIds: string[] } | { error: string; status: 400 } {
  if (!Array.isArray(value)) return { error: "runtime_ids is required", status: 400 };
  const runtimeIds = uniqueStrings(value);
  if (!runtimeIds.length) return { error: "runtime_ids is required", status: 400 };
  return { runtimeIds };
}

function deregisterDaemonRuntimes(c: Context, store: MultiremiStore, runtimeIds: string[]): void {
  const token = currentAccessToken(c);
  for (const runtimeId of runtimeIds) {
    const runtime = store.getRuntime(runtimeId);
    if (!runtime) continue;
    if (token?.type === "daemon" && (runtime.workspaceId ?? "local") !== token.workspaceId) continue;
    const updated = store.setRuntimeOffline(runtimeId);
    if (!updated || runtime.status === updated.status) continue;
    store.emitWorkspaceEvent({
      type: "runtime:updated",
      workspaceId: runtimeWorkspaceId(updated),
      actorType: token?.type === "daemon" ? "daemon" : "member",
      actorId: token?.type === "daemon" ? token.daemonId ?? token.id : currentRequestUserId(c),
      payload: { runtime: runtimeCompatibilityResponse(updated), reason: "daemon_deregistered" },
    });
  }
}

function denyDaemonTokenTaskWorkspace(
  c: Context,
  store: MultiremiStore,
  taskId: string,
  options: DaemonWorkspaceDenyOptions = {},
): Response | null {
  if (currentAccessToken(c)?.type !== "daemon") return null;
  const task = store.getTask(taskId);
  if (!task) return c.json({ error: "task not found" }, 404);
  return denyDaemonTokenWorkspace(c, task.workspaceId, options);
}

function denyDaemonTokenIssueWorkspace(
  c: Context,
  store: MultiremiStore,
  issueId: string,
  options: DaemonWorkspaceDenyOptions = {},
): Response | null {
  if (currentAccessToken(c)?.type !== "daemon") return null;
  const issue = store.getIssue(issueId);
  if (!issue) return c.json({ error: "issue not found" }, 404);
  return denyDaemonTokenWorkspace(c, issue.workspaceId, options);
}

function denyDaemonTokenChatSessionWorkspace(
  c: Context,
  store: MultiremiStore,
  sessionId: string,
  options: DaemonWorkspaceDenyOptions = {},
): Response | null {
  if (currentAccessToken(c)?.type !== "daemon") return null;
  const session = store.getChatSession(sessionId);
  if (!session) return c.json({ error: "chat session not found" }, 404);
  return denyDaemonTokenWorkspace(c, session.workspaceId, options);
}

function denyDaemonTokenAutopilotRunWorkspace(
  c: Context,
  store: MultiremiStore,
  runId: string,
  options: DaemonWorkspaceDenyOptions = {},
): Response | null {
  if (currentAccessToken(c)?.type !== "daemon") return null;
  const run = store.getAutopilotRun(runId);
  if (!run) return c.json({ error: "autopilot run not found" }, 404);
  const task = run.taskId ? store.getTask(run.taskId) : null;
  if (task) return denyDaemonTokenWorkspace(c, task.workspaceId, options);
  const issue = run.issueId ? store.getIssue(run.issueId) : null;
  if (issue) return denyDaemonTokenWorkspace(c, issue.workspaceId, options);
  const autopilot = store.getAutopilot(run.autopilotId);
  if (!autopilot) return c.json({ error: "autopilot not found" }, 404);
  return denyDaemonTokenWorkspace(c, autopilot.workspaceId, options);
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return await c.req.json() as T;
  } catch {
    return {} as T;
  }
}

async function readJsonStrict<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T | { apiError: string; statusCode: 400 }> {
  try {
    return await c.req.json() as T;
  } catch {
    return { apiError: "invalid request body", statusCode: 400 };
  }
}

function isJsonApiError(value: unknown): value is { apiError: string; statusCode: 400 } {
  return typeof value === "object" && value !== null && "apiError" in value && "statusCode" in value;
}

async function readJsonStrictAllowEmpty<T>(c: {
  req: {
    json: () => Promise<unknown>;
    header?: (name: string) => string | undefined;
  };
}): Promise<T | { apiError: string; statusCode: 400 }> {
  const contentLength = c.req.header?.("content-length");
  const contentType = c.req.header?.("content-type");
  if ((contentLength == null || contentLength === "0") && !contentType) return {} as T;
  return readJsonStrict<T>(c);
}

async function readPublicWebhookBody(c: {
  req: {
    raw: Request;
  };
}): Promise<{
  rawBody: string;
  body: (RunAutopilotInput & { payload?: unknown }) | unknown[];
} | { apiError: string; statusCode: 400 | 413 }> {
  let bytes: ArrayBuffer;
  try {
    bytes = await c.req.raw.arrayBuffer();
  } catch {
    return { apiError: "failed to read request body", statusCode: 400 };
  }
  if (bytes.byteLength > MAX_WEBHOOK_BODY_BYTES) return { apiError: "payload too large", statusCode: 413 };
  const rawBody = Buffer.from(bytes).toString("utf8");
  const bodyText = stripUtf8Bom(rawBody);
  if (!bodyText.trim()) return { apiError: "empty body", statusCode: 400 };
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { apiError: `invalid json: ${message}`, statusCode: 400 };
  }
  if (!isObjectRecord(body) && !Array.isArray(body)) {
    return { apiError: "body must be a JSON object or array", statusCode: 400 };
  }
  return {
    rawBody,
    body: body as (RunAutopilotInput & { payload?: unknown }) | unknown[],
  };
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function createWebhookRateLimiter(
  override: Partial<WebhookRateLimitConfig> | false | undefined,
  defaults: WebhookRateLimitConfig,
): MemoryWebhookRateLimiter {
  const config = override === false ? { limit: 0, windowMs: defaults.windowMs } : { ...defaults, ...(override ?? {}) };
  return new MemoryWebhookRateLimiter(config);
}

class MemoryWebhookRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly config: WebhookRateLimitConfig) {}

  allow(key: string): boolean {
    if (this.config.limit <= 0) return true;
    const now = Date.now();
    const cutoff = now - Math.max(1, this.config.windowMs);
    const kept = (this.hits.get(key) ?? []).filter((hit) => hit > cutoff);
    if (kept.length >= this.config.limit) {
      this.hits.set(key, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(key, kept);
    return true;
  }
}

function webhookClientIpKey(request: Request): string {
  const remote = requestRemoteAddress(request);
  return remoteAddrHost(remote) || "unknown";
}

function requestRemoteAddress(request: Request): string {
  const candidate = request as Request & {
    ip?: unknown;
    remoteAddress?: unknown;
    remoteAddr?: unknown;
    socket?: { remoteAddress?: unknown };
  };
  for (const value of [candidate.remoteAddress, candidate.remoteAddr, candidate.ip, candidate.socket?.remoteAddress]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function remoteAddrHost(remote: string): string {
  if (!remote) return "";
  if (remote.startsWith("[")) {
    const end = remote.indexOf("]");
    if (end > 0) return remote.slice(1, end);
  }
  const lastColon = remote.lastIndexOf(":");
  if (lastColon >= 0 && !remote.includes("]") && remote.split(":").length === 2) return remote.slice(0, lastColon);
  return remote;
}

function isTerminalRuntimeRequestForDaemon(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timeout";
}

function isValidRuntimeUpdateReportStatus(status: unknown): status is "completed" | "failed" | "running" {
  return status === "completed" || status === "failed" || status === "running";
}

function daemonLocalSkillListReportBody(input: ReportRuntimeLocalSkillListInput): ReportRuntimeLocalSkillListInput {
  const skills = Array.isArray(input.skills)
    ? input.skills.map((skill) => {
      const record = skill as unknown as Record<string, unknown>;
      const sourcePath = String(record.source_path ?? "");
      const fileCount = Number(record.file_count ?? 0);
      return {
        key: String(record.key ?? ""),
        name: String(record.name ?? ""),
        description: String(record.description ?? ""),
        sourcePath,
        source_path: sourcePath,
        provider: String(record.provider ?? ""),
        fileCount: Number.isFinite(fileCount) ? fileCount : 0,
        file_count: Number.isFinite(fileCount) ? fileCount : 0,
      };
    })
    : input.skills;
  return {
    status: input.status,
    skills,
    supported: input.supported,
    error: input.error,
  };
}

function daemonLocalSkillImportReportBody(input: ReportRuntimeLocalSkillImportInput): ReportRuntimeLocalSkillImportInput {
  const record = input.skill && typeof input.skill === "object"
    ? input.skill as Record<string, unknown>
    : null;
  return {
    status: input.status,
    skill: record ? {
      name: typeof record.name === "string" ? record.name : undefined,
      description: typeof record.description === "string" ? record.description : undefined,
      content: typeof record.content === "string" ? record.content : undefined,
      source_path: typeof record.source_path === "string" ? record.source_path : undefined,
      provider: typeof record.provider === "string" ? record.provider : undefined,
      files: Array.isArray(record.files) ? record.files as any[] : undefined,
    } : input.skill,
    error: input.error,
  };
}

function daemonHeartbeatHttpResponse(ack: MultiremiDaemonHeartbeatAck): Record<string, unknown> {
  const response: Record<string, unknown> = { status: ack.status };
  if (ack.pending_update) response.pending_update = ack.pending_update;
  if (ack.pending_model_list) response.pending_model_list = ack.pending_model_list;
  if (ack.pending_local_skills) response.pending_local_skills = ack.pending_local_skills;
  if (ack.pending_directory_scan) response.pending_directory_scan = ack.pending_directory_scan;
  if (ack.pending_local_skill_import) response.pending_local_skill_import = ack.pending_local_skill_import;
  if (ack.pending_local_skill_imports?.length) response.pending_local_skill_imports = ack.pending_local_skill_imports;
  return response;
}

function registerDaemonWebSocketClient(registry: DaemonWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "daemon") return;
  for (const runtimeId of client.data.runtimeIds) {
    let clients = registry.get(runtimeId);
    if (!clients) {
      clients = new Set();
      registry.set(runtimeId, clients);
    }
    clients.add(client);
  }
}

function unregisterDaemonWebSocketClient(registry: DaemonWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "daemon") return;
  for (const runtimeId of client.data.runtimeIds) {
    const clients = registry.get(runtimeId);
    if (!clients) continue;
    clients.delete(client);
    if (clients.size === 0) registry.delete(runtimeId);
  }
}

function registerBrowserWebSocketClient(registry: BrowserWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "browser" || !client.data.authenticated) return;
  let clients = registry.get(client.data.workspaceId);
  if (!clients) {
    clients = new Set();
    registry.set(client.data.workspaceId, clients);
  }
  clients.add(client);
}

function registerBrowserUserWebSocketClient(registry: BrowserUserWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "browser" || !client.data.authenticated || !client.data.userId) return;
  let clients = registry.get(client.data.userId);
  if (!clients) {
    clients = new Set();
    registry.set(client.data.userId, clients);
  }
  clients.add(client);
}

function unregisterBrowserWebSocketClient(registry: BrowserWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "browser") return;
  const clients = registry.get(client.data.workspaceId);
  if (!clients) return;
  clients.delete(client);
  if (clients.size === 0) registry.delete(client.data.workspaceId);
}

function unregisterBrowserUserWebSocketClient(registry: BrowserUserWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "browser" || !client.data.userId) return;
  const clients = registry.get(client.data.userId);
  if (!clients) return;
  clients.delete(client);
  if (clients.size === 0) registry.delete(client.data.userId);
}

function handleBrowserScopeSubscribe(
  registry: BrowserScopeWebSocketRegistry,
  store: MultiremiStore,
  client: MultiremiWebSocketClient,
  event: Record<string, any>,
): void {
  const payload = parseBrowserScopePayload(event);
  if (!payload) {
    sendBrowserScopeFrame(client, "subscribe_error", "", "", "invalid payload");
    return;
  }
  const authorized = authorizeBrowserScope(store, client, payload.scope, payload.id);
  if (!authorized.ok) {
    sendBrowserScopeFrame(client, "subscribe_error", payload.scope, payload.id, authorized.error);
    return;
  }
  if (payload.scope === "task" || payload.scope === "chat") {
    registerBrowserScopeWebSocketClient(registry, client, payload.scope, payload.id);
  }
  sendBrowserScopeFrame(client, "subscribe_ack", payload.scope, payload.id);
}

function handleBrowserScopeUnsubscribe(
  registry: BrowserScopeWebSocketRegistry,
  client: MultiremiWebSocketClient,
  event: Record<string, any>,
): void {
  const payload = parseBrowserScopePayload(event);
  if (payload) unregisterBrowserScopeWebSocketClient(registry, client, payload.scope, payload.id);
  sendBrowserScopeFrame(client, "unsubscribe_ack", payload?.scope ?? "", payload?.id ?? "");
}

function parseBrowserScopePayload(event: Record<string, any>): { scope: string; id: string } | null {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, any> : {};
  const scope = cleanString(payload.scope);
  const id = cleanString(payload.id);
  return scope && id ? { scope, id } : null;
}

function authorizeBrowserScope(
  store: MultiremiStore,
  client: MultiremiWebSocketClient,
  scope: string,
  id: string,
): { ok: true } | { ok: false; error: string } {
  if (client.data.kind !== "browser" || !client.data.authenticated) return { ok: false, error: "forbidden" };
  if (scope === "workspace") return id === client.data.workspaceId ? { ok: true } : { ok: false, error: "forbidden" };
  if (scope === "user") return id === client.data.userId ? { ok: true } : { ok: false, error: "forbidden" };
  if (scope === "task") {
    const task = store.getTask(id);
    if (!task || task.workspaceId !== client.data.workspaceId) return { ok: false, error: "forbidden" };
    if (!task.chatSessionId) return { ok: true };
    const session = store.getChatSession(task.chatSessionId);
    if (!session || session.workspaceId !== client.data.workspaceId) return { ok: false, error: "forbidden" };
    return session.creatorId === client.data.userId ? { ok: true } : { ok: false, error: "forbidden" };
  }
  if (scope === "chat") {
    const session = store.getChatSession(id);
    if (!session || session.workspaceId !== client.data.workspaceId) return { ok: false, error: "forbidden" };
    return session.creatorId === client.data.userId ? { ok: true } : { ok: false, error: "forbidden" };
  }
  return { ok: false, error: "unknown_scope" };
}

function registerBrowserScopeWebSocketClient(
  registry: BrowserScopeWebSocketRegistry,
  client: MultiremiWebSocketClient,
  scope: string,
  id: string,
): void {
  if (client.data.kind !== "browser" || !client.data.authenticated) return;
  const key = browserScopeKey(scope, id);
  let clients = registry.get(key);
  if (!clients) {
    clients = new Set();
    registry.set(key, clients);
  }
  clients.add(client);
  if (!client.data.scopeSubscriptions.includes(key)) client.data.scopeSubscriptions.push(key);
}

function unregisterBrowserScopeWebSocketClient(
  registry: BrowserScopeWebSocketRegistry,
  client: MultiremiWebSocketClient,
  scope?: string,
  id?: string,
): void {
  if (client.data.kind !== "browser") return;
  const keys = scope && id ? [browserScopeKey(scope, id)] : [...client.data.scopeSubscriptions];
  for (const key of keys) {
    const clients = registry.get(key);
    if (!clients) continue;
    clients.delete(client);
    if (clients.size === 0) registry.delete(key);
  }
  client.data.scopeSubscriptions = client.data.scopeSubscriptions.filter((key) => !keys.includes(key));
}

function browserScopeKey(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

function sendBrowserScopeFrame(
  client: MultiremiWebSocketClient,
  type: "subscribe_ack" | "subscribe_error" | "unsubscribe_ack",
  scope: string,
  id: string,
  error?: string,
): void {
  const payload: Record<string, string> = { scope, id };
  if (error) payload.error = error;
  client.sendText(JSON.stringify({ type, payload }));
}

function notifyDaemonTaskAvailable(registry: DaemonWebSocketRegistry, store: MultiremiStore, task: MultiremiTask): void {
  if (task.status !== "queued") return;
  const runtimeIds = task.runtimeId ? [task.runtimeId] : [...registry.keys()];
  const seen = new Set<string>();
  for (const runtimeId of runtimeIds) {
    if (seen.has(runtimeId)) continue;
    seen.add(runtimeId);
    const clients = registry.get(runtimeId);
    if (!clients?.size) continue;
    const runtime = store.getRuntime(runtimeId);
    if (!runtime || !isPendingForRuntime(store, runtime, task)) continue;
    const frame = JSON.stringify({
      type: "daemon:task_available",
      payload: {
        runtime_id: runtimeId,
        task_id: task.id,
      },
    });
    for (const client of [...clients]) {
      try {
        client.sendText(frame);
      } catch {
        unregisterDaemonWebSocketClient(registry, client);
        try {
          client.close();
        } catch {
          // Already closed.
        }
      }
    }
  }
}

function notifyBrowserTaskEvent(
  workspaceRegistry: BrowserWebSocketRegistry,
  scopeRegistry: BrowserScopeWebSocketRegistry,
  type: string,
  task: MultiremiTask,
): void {
  const frame = JSON.stringify({
    type,
    payload: taskRealtimePayload(task),
    actor_id: task.agentId,
    actor_type: "agent",
  });
  if (task.chatSessionId) {
    // Chat-linked task state carries private chat content (assistant result text,
    // chat_session_id). Like the chat:* events, route it to the chat creator's
    // chat/task subscriptions instead of broadcasting to every workspace client.
    sendFrameToBrowserScopes(scopeRegistry, frame, [["chat", task.chatSessionId], ["task", task.id]]);
    return;
  }
  notifyBrowserWorkspaceClients(workspaceRegistry, task.workspaceId, frame);
}

function notifyBrowserWorkspaceEvent(
  workspaceRegistry: BrowserWebSocketRegistry,
  userRegistry: BrowserUserWebSocketRegistry,
  scopeRegistry: BrowserScopeWebSocketRegistry,
  event: {
    type: string;
    workspaceId: string;
    chatSessionId?: string;
    payload: Record<string, unknown>;
    actorType?: string;
    actorId?: string | null;
  },
): void {
  const frame = JSON.stringify({
    type: event.type,
    payload: event.payload,
    actor_id: event.actorId ?? null,
    actor_type: event.actorType ?? "member",
  });
  if (isChatRealtimeEvent(event.type)) {
    const chatSessionId = chatEventSessionId(event);
    if (chatSessionId) notifyBrowserScopeClients(scopeRegistry, "chat", chatSessionId, frame);
    return;
  }
  if (event.type === "invitation:created" || event.type === "invitation:revoked") {
    const inviteeUserId = invitationEventInviteeUserId(event.payload);
    if (inviteeUserId) notifyBrowserUserEvent(userRegistry, inviteeUserId, frame);
    return;
  }
  notifyBrowserWorkspaceClients(workspaceRegistry, event.workspaceId, frame);
  if (event.type === "member:added") {
    const userId = memberAddedEventUserId(event.payload);
    if (userId) notifyBrowserUserEvent(userRegistry, userId, frame, event.workspaceId);
  }
}

function isChatRealtimeEvent(type: string): boolean {
  return type === "chat:message"
    || type === "chat:done"
    || type === "chat:session_read"
    || type === "chat:session_deleted"
    || type === "chat:session_updated";
}

function chatEventSessionId(event: {
  chatSessionId?: string;
  payload: Record<string, unknown>;
}): string | null {
  if (event.chatSessionId) return event.chatSessionId;
  const raw = event.payload.chat_session_id;
  return typeof raw === "string" && raw ? raw : null;
}

function notifyBrowserScopeClients(
  registry: BrowserScopeWebSocketRegistry,
  scope: string,
  id: string,
  frame: string,
): void {
  const clients = registry.get(browserScopeKey(scope, id));
  if (!clients?.size) return;
  for (const client of [...clients]) {
    try {
      client.sendText(frame);
    } catch {
      unregisterBrowserScopeWebSocketClient(registry, client, scope, id);
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

// Deliver one frame across several scope subscriptions without double-sending to a
// client subscribed to more than one of them (e.g. both the chat and its task scope).
function sendFrameToBrowserScopes(
  registry: BrowserScopeWebSocketRegistry,
  frame: string,
  keys: Array<[scope: string, id: string]>,
): void {
  const delivered = new Set<MultiremiWebSocketClient>();
  for (const [scope, id] of keys) {
    const clients = registry.get(browserScopeKey(scope, id));
    if (!clients?.size) continue;
    for (const client of [...clients]) {
      if (delivered.has(client)) continue;
      delivered.add(client);
      try {
        client.sendText(frame);
      } catch {
        unregisterBrowserScopeWebSocketClient(registry, client, scope, id);
        try {
          client.close();
        } catch {
          // Already closed.
        }
      }
    }
  }
}

function notifyBrowserWorkspaceClients(
  registry: BrowserWebSocketRegistry,
  workspaceId: string,
  frame: string,
): void {
  const clients = registry.get(workspaceId);
  if (!clients?.size) return;
  for (const client of [...clients]) {
    try {
      client.sendText(frame);
    } catch {
      unregisterBrowserWebSocketClient(registry, client);
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

function notifyBrowserUserEvent(
  registry: BrowserUserWebSocketRegistry,
  userId: string,
  frame: string,
  excludeWorkspaceId?: string,
): void {
  const clients = registry.get(userId);
  if (!clients?.size) return;
  for (const client of [...clients]) {
    if (client.data.kind === "browser" && excludeWorkspaceId && client.data.workspaceId === excludeWorkspaceId) continue;
    try {
      client.sendText(frame);
    } catch {
      unregisterBrowserUserWebSocketClient(registry, client);
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

function invitationEventInviteeUserId(payload: Record<string, unknown>): string | null {
  if (typeof payload.invitee_user_id === "string" && payload.invitee_user_id) return payload.invitee_user_id;
  const invitation = payload.invitation;
  if (invitation && typeof invitation === "object" && "invitee_user_id" in invitation) {
    const inviteeUserId = (invitation as Record<string, unknown>).invitee_user_id;
    return typeof inviteeUserId === "string" && inviteeUserId ? inviteeUserId : null;
  }
  return null;
}

function memberAddedEventUserId(payload: Record<string, unknown>): string | null {
  const member = payload.member;
  if (!member || typeof member !== "object" || !("user_id" in member)) return null;
  const userId = (member as Record<string, unknown>).user_id;
  return typeof userId === "string" && userId ? userId : null;
}

function taskRealtimePayload(task: MultiremiTask): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    task_id: task.id,
    agent_id: task.agentId,
    issue_id: task.issueId,
    runtime_id: task.runtimeId,
    workspace_id: task.workspaceId,
    status: task.status,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
  if (task.chatSessionId) payload.chat_session_id = task.chatSessionId;
  if (task.autopilotRunId) payload.autopilot_run_id = task.autopilotRunId;
  if (task.waitReason) payload.wait_reason = task.waitReason;
  if (task.sessionId) payload.session_id = task.sessionId;
  if (task.workDir) payload.work_dir = task.workDir;
  if (task.error) payload.error = task.error;
  if (task.failureReason) payload.failure_reason = task.failureReason;
  if (task.result) payload.result = task.result;
  return payload;
}

function notifyDaemonTaskEvent(registry: DaemonWebSocketRegistry, type: string, task: MultiremiTask): void {
  if (!task.runtimeId) return;
  const clients = registry.get(task.runtimeId);
  if (!clients?.size) return;
  const payload: Record<string, unknown> = {
    task_id: task.id,
    agent_id: task.agentId,
    issue_id: task.issueId,
    runtime_id: task.runtimeId,
    workspace_id: task.workspaceId,
    status: task.status,
  };
  if (task.chatSessionId) payload.chat_session_id = task.chatSessionId;
  if (task.autopilotRunId) payload.autopilot_run_id = task.autopilotRunId;
  if (task.waitReason) payload.wait_reason = task.waitReason;
  const frame = JSON.stringify({ type, payload });
  for (const client of [...clients]) {
    try {
      client.sendText(frame);
    } catch {
      unregisterDaemonWebSocketClient(registry, client);
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function bearerToken(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

async function authorizeDaemonWebSocketRequest(
  req: Request,
  store: MultiremiStore,
  authToken: string,
  runtimeIds: string[],
): Promise<{ accessToken: MultiremiAccessToken | null } | { response: Response }> {
  let accessToken: MultiremiAccessToken | null = null;
  const token = bearerToken(req);
  if (authToken && token !== authToken) {
    accessToken = await store.verifyAccessToken(token);
    if (!accessToken) return { response: Response.json({ error: "unauthorized" }, { status: 401 }) };
    if (accessToken.type === "daemon" && !isDaemonTokenAllowedRequest(req)) {
      return { response: Response.json({ error: "forbidden for daemon token" }, { status: 403 }) };
    }
    if (accessToken.type === "task") {
      return { response: Response.json({ error: "forbidden for task token" }, { status: 403 }) };
    }
  }

  for (const runtimeId of runtimeIds) {
    const runtime = store.getRuntime(runtimeId);
    if (!runtime) return { response: Response.json({ error: "runtime not found" }, { status: 404 }) };
    if (accessToken?.type === "daemon" && (runtime.workspaceId ?? "local") !== accessToken.workspaceId) {
      return { response: Response.json({ error: "forbidden for daemon token workspace" }, { status: 403 }) };
    }
    if (accessToken?.type === "daemon" && accessToken.daemonId && runtime.daemonId && runtime.daemonId !== accessToken.daemonId) {
      return { response: Response.json({ error: "runtime not found" }, { status: 404 }) };
    }
  }
  return { accessToken };
}

function resolveBrowserWebSocketWorkspaceId(
  store: MultiremiStore,
  url: URL,
): { workspaceId: string } | { response: Response } {
  const byId = cleanString(
    url.searchParams.get("workspace_id")
      ?? url.searchParams.get("workspaceId"),
  );
  if (byId) {
    if (byId === "local") store.ensureLocalWorkspace();
    else if (!store.getWorkspace(byId)) return { response: Response.json({ error: "workspace not found" }, { status: 404 }) };
    return { workspaceId: byId };
  }
  const slug = cleanString(
    url.searchParams.get("workspace_slug")
      ?? url.searchParams.get("workspaceSlug"),
  );
  if (!slug) {
    return { response: Response.json({ error: "workspace_id or workspace_slug required" }, { status: 400 }) };
  }
  if (slug === "local") return { workspaceId: store.ensureLocalWorkspace().id };
  const workspace = store.listWorkspaces().find((candidate) => candidate.slug === slug);
  if (!workspace) return { response: Response.json({ error: "workspace not found" }, { status: 404 }) };
  return { workspaceId: workspace.id };
}

async function authorizeBrowserWebSocketUpgrade(
  req: Request,
  store: MultiremiStore,
  authToken: string,
  workspaceId: string,
): Promise<
  | { authenticated: boolean; userId: string | null; accessToken: MultiremiAccessToken | null }
  | { response: Response }
> {
  const token = bearerToken(req);
  if (!token) return { authenticated: false, userId: null, accessToken: null };
  const authorized = await authorizeBrowserWebSocketToken(token, store, authToken, workspaceId);
  if ("error" in authorized) {
    return { response: Response.json({ error: authorized.error }, { status: authorized.status }) };
  }
  return { authenticated: true, userId: authorized.userId, accessToken: authorized.accessToken };
}

async function authorizeBrowserWebSocketAuthFrame(
  event: Record<string, any>,
  store: MultiremiStore,
  authToken: string,
  workspaceId: string,
): Promise<{ userId: string; accessToken: MultiremiAccessToken | null } | { error: string }> {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, any> : {};
  const token = cleanString(payload.token);
  if (event.type !== "auth" || !token) return { error: "expected auth message as first frame" };
  const authorized = await authorizeBrowserWebSocketToken(token, store, authToken, workspaceId);
  if ("error" in authorized) return { error: authorized.error };
  return authorized;
}

async function authorizeBrowserWebSocketToken(
  token: string,
  store: MultiremiStore,
  authToken: string,
  workspaceId: string,
): Promise<
  | { userId: string; accessToken: MultiremiAccessToken | null }
  | { error: string; status: 401 | 403 }
> {
  if (authToken && token === authToken) return { userId: "root", accessToken: null };
  const accessToken = await store.verifyAccessToken(token);
  if (accessToken) {
    if (accessToken.type === "daemon") return { error: "forbidden for daemon token", status: 403 };
    if (accessToken.type === "task") return { error: "forbidden for task token", status: 403 };
    const userId = accessToken.userId || "local";
    // Membership is the sole authority — a token being bound to this workspace
    // does not by itself make its user a member.
    if (!hasJwtWorkspaceAccess(store, userId, workspaceId)) {
      return { error: "not a member of this workspace", status: 403 };
    }
    return { userId, accessToken };
  }
  const jwt = verifyJwtToken(token);
  if (!jwt) return { error: "invalid token", status: 401 };
  if (!hasJwtWorkspaceAccess(store, jwt.userId, workspaceId)) {
    return { error: "not a member of this workspace", status: 403 };
  }
  return { userId: jwt.userId, accessToken: null };
}

function parseDaemonWebSocketRuntimeIds(url: URL): string[] {
  const runtimeIds: string[] = [];
  const add = (raw: string | null): void => {
    if (raw == null) return;
    for (const part of raw.split(",")) {
      const runtimeId = part.trim();
      if (!runtimeId || runtimeIds.includes(runtimeId)) continue;
      runtimeIds.push(runtimeId);
    }
  };
  for (const raw of url.searchParams.getAll("runtime_id")) add(raw);
  for (const raw of url.searchParams.getAll("runtime_ids")) add(raw);
  return runtimeIds;
}

function parseDaemonWebSocketMessage(message: string | BufferSource): Record<string, any> {
  const text = typeof message === "string" ? message : decodeWebSocketMessage(message);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, any> : { type: "message", payload: text };
  } catch {
    return { type: text || "message" };
  }
}

function parseDaemonWebSocketHeartbeat(event: Record<string, any>): { runtimeId: string | null; supportsBatchImport: boolean; supportsDirectoryScan: boolean } {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, any> : {};
  const runtimeId = cleanString(payload.runtime_id ?? event.runtime_id);
  return {
    runtimeId,
    supportsBatchImport: Boolean(payload.supports_batch_import ?? event.supports_batch_import),
    supportsDirectoryScan: Boolean(payload.supports_directory_scan ?? event.supports_directory_scan),
  };
}

function decodeWebSocketMessage(message: BufferSource): string {
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  return new TextDecoder().decode(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
}

function normalizeSubscriptionReason(value: unknown): MultiremiSubscriptionReason {
  const reason = String(value ?? "manual") as MultiremiSubscriptionReason;
  return SUBSCRIPTION_REASONS.includes(reason) ? reason : "manual";
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function parseOptionalTaskMessageSince(value: string | undefined): number | undefined | { error: string } {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return { error: "invalid since parameter" };
  return parsed;
}

function daemonTaskUsageEntries(raw: unknown): TaskUsageEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: TaskUsageEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    entries.push({
      provider: String(record.provider ?? "unknown"),
      model: String(record.model ?? "unknown"),
      inputTokens: normalizeDaemonUsageNumber(record.input_tokens),
      outputTokens: normalizeDaemonUsageNumber(record.output_tokens),
      cacheReadTokens: normalizeDaemonUsageNumber(record.cache_read_tokens),
      cacheWriteTokens: normalizeDaemonUsageNumber(record.cache_write_tokens),
      totalTokens: normalizeDaemonUsageNumber(record.total_tokens),
    });
  }
  return entries;
}

function normalizeDaemonUsageNumber(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function emptyBillingPage(c: { req: { query: (name: string) => string | undefined } }): {
  items: [];
  total: 0;
  page: number;
  page_size: number;
} {
  return {
    items: [],
    total: 0,
    page: Math.max(1, parseOptionalInt(c.req.query("page")) ?? 1),
    page_size: Math.max(1, parseOptionalInt(c.req.query("page_size") ?? c.req.query("pageSize")) ?? 20),
  };
}

function cJsonCloudBillingBalance(): Response {
  return Response.json({
    owner_id: "local",
    balance_micro: 0,
    balance_credit: 0,
    updated_at: new Date(0).toISOString(),
    configured: false,
  });
}

function cJsonCloudBillingPortal(): Response {
  return Response.json({
    url: "",
    configured: false,
    disabled: true,
    error: "cloud billing is not configured in local Bun Multiremi",
  }, { status: 201 });
}

function agentEnvResponse(agentId: string, env: Record<string, string>): {
  agent_id: string;
  custom_env: Record<string, string>;
} {
  return {
    agent_id: agentId,
    custom_env: { ...env },
  };
}

function mergeAgentEnv(current: Record<string, string>, input: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(input)) {
    const cleanKey = key.trim();
    if (!cleanKey) continue;
    const value = String(rawValue ?? "");
    next[cleanKey] = value === "****" && current[cleanKey] !== undefined ? current[cleanKey] : value;
  }
  return next;
}

function searchSkillsResponse(store: MultiremiStore, c: Context): {
  skills: Array<{
    name: string;
    description: string;
    url: string;
    source: string;
    repo: string | null;
    github_stars: number | null;
    install_count: number | null;
  }>;
} {
  const query = String(c.req.query("q") ?? "").trim().toLowerCase();
  const workspaceId = requestedSkillWorkspaceId(c);
  const limit = Math.max(1, Math.min(parseOptionalInt(c.req.query("limit")) ?? 50, 200));
  const offset = Math.max(0, parseOptionalInt(c.req.query("offset")) ?? 0);
  const skills = store.listSkills(workspaceId, { includeFiles: false })
    .filter((skill) => {
      if (!query) return true;
      return [
        skill.name,
        skill.description ?? "",
        skill.content ?? "",
      ].some((value) => value.toLowerCase().includes(query));
    })
    .slice(offset, offset + limit)
    .map((skill) => ({
      name: skill.name,
      description: skill.description ?? "",
      url: skill.id ? `local://skills/${skill.id}` : "local://skills",
      source: "local",
      repo: null,
      github_stars: null,
      install_count: null,
    }));
  return { skills };
}

type CompatibilityQueryMode = "native" | "compat";

function issueFromParam(
  store: MultiremiStore,
  c: Context,
  param = "id",
  mode: CompatibilityQueryMode = "native",
): MultiremiIssue | null {
  return store.getIssueByRef(
    c.req.param(param) ?? "",
    mode === "compat"
      ? c.req.query("workspace_id") ?? null
      : c.req.query("workspace_id") ?? c.req.query("workspaceId") ?? null,
  );
}

function taskFromParam(
  store: MultiremiStore,
  c: Context,
  param: string,
): MultiremiTask | null {
  return store.getTaskByRef(c.req.param(param) ?? "");
}

function issueListQuery(
  store: MultiremiStore,
  c: { req: { query: (name: string) => string | undefined } },
  mode: CompatibilityQueryMode = "native",
): ListIssuesInput {
  const compat = mode === "compat";
  const workspaceId = (compat ? c.req.query("workspace_id") : c.req.query("workspaceId") ?? c.req.query("workspace_id")) ?? "local";
  const assigneeTypes = splitQueryList(compat ? c.req.query("assignee_types") : c.req.query("assigneeTypes") ?? c.req.query("assignee_types")) as ListIssuesInput["assigneeTypes"];
  const assigneeId = resolveAssigneeFilterId(
    store,
    workspaceId,
    (compat ? c.req.query("assignee_id") : c.req.query("assigneeId") ?? c.req.query("assignee_id")) ?? null,
    assigneeTypes,
  );
  return {
    workspaceId,
    statuses: splitQueryList(c.req.query("statuses") ?? c.req.query("status")),
    priorities: splitQueryList(c.req.query("priorities") ?? c.req.query("priority")),
    assigneeTypes,
    assigneeId,
    assigneeIds: splitQueryList(compat ? c.req.query("assignee_ids") : c.req.query("assigneeIds") ?? c.req.query("assignee_ids"))
      .map((ref) => resolveAssigneeFilterId(store, workspaceId, ref, assigneeTypes) ?? ref),
    projectId: (compat ? c.req.query("project_id") : c.req.query("projectId") ?? c.req.query("project_id")) ?? null,
    projectIds: splitQueryList(compat ? c.req.query("project_ids") : c.req.query("projectIds") ?? c.req.query("project_ids")),
    metadata: parseIssueMetadataFilter(c.req.query("metadata")),
    includeNoAssignee: compat
      ? c.req.query("include_no_assignee") === "true"
      : c.req.query("includeNoAssignee") === "true" || c.req.query("include_no_assignee") === "true",
    includeNoProject: compat
      ? c.req.query("include_no_project") === "true"
      : c.req.query("includeNoProject") === "true" || c.req.query("include_no_project") === "true",
    limit: parseOptionalInt(c.req.query("limit")),
    offset: parseOptionalInt(c.req.query("offset")),
  };
}

function resolveAssigneeFilterId(
  store: MultiremiStore,
  workspaceId: string | null,
  ref: string | null,
  assigneeTypes: ListIssuesInput["assigneeTypes"] = [],
): string | null {
  const value = ref?.trim();
  if (!value) return null;
  const type = assigneeTypes?.length === 1 ? assigneeTypes[0] ?? null : null;
  try {
    return store.resolveAssigneeRef(type, value, workspaceId)?.assigneeId ?? value;
  } catch {
    return value;
  }
}

function parseIssueMetadataFilter(value: string | undefined): Record<string, string | number | boolean> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string | number | boolean> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") out[key] = item;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

function parseIssueCommentListQuery(c: { req: { query: (name: string) => string | undefined } }): ListIssueCommentsInput | { error: string; status: 400 } {
  const rootsOnly = parseBooleanQuery(c.req.query("roots_only") ?? c.req.query("roots-only"), "roots_only");
  if (typeof rootsOnly === "object") return rootsOnly;
  const summary = parseBooleanQuery(c.req.query("summary"), "summary");
  if (typeof summary === "object") return summary;
  const recent = parseIntegerQuery(c.req.query("recent"), "recent");
  if (recent && typeof recent === "object") return recent;
  const tail = parseIntegerQuery(c.req.query("tail"), "tail");
  if (tail && typeof tail === "object") return tail;
  return {
    since: c.req.query("since") ?? null,
    thread: c.req.query("thread") ?? null,
    recent,
    ...(c.req.query("tail") === undefined ? {} : { tail }),
    rootsOnly,
    roots_only: rootsOnly,
    summary,
    before: c.req.query("before") ?? null,
    beforeId: c.req.query("before_id") ?? c.req.query("before-id") ?? null,
  };
}

function parseBooleanQuery(value: string | undefined, name: string): boolean | { error: string; status: 400 } {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  return { error: `invalid ${name} parameter; expected boolean`, status: 400 };
}

function parseIntegerQuery(value: string | undefined, name: string): number | null | { error: string; status: 400 } {
  if (value === undefined || value === "") return null;
  if (!/^-?\d+$/.test(value)) return { error: `invalid ${name} parameter; expected integer`, status: 400 };
  return Number.parseInt(value, 10);
}

function setIssueCommentCursorHeaders(c: Context, result: { nextBefore?: string | null; nextBeforeId?: string | null }): void {
  if (result.nextBefore && result.nextBeforeId) {
    c.header("X-Multiremi-Next-Before", result.nextBefore);
    c.header("X-Multiremi-Next-Before-Id", result.nextBeforeId);
  }
}

function issueCommentListErrorResponse(c: Context, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "thread anchor not found in this issue") {
    return c.json({ error: message }, 404);
  }
  if (
    message.includes("mutually exclusive")
    || message.includes("requires")
    || message.includes("invalid")
    || message.includes("must be set together")
    || message.includes("does not support")
  ) {
    return c.json({ error: message }, 400);
  }
  return c.json({ error: "failed to list comments" }, 500);
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

function issuePullRequestsResponse(pullRequests: MultiremiGitHubPullRequest[]): {
  pull_requests: Array<MultiremiGitHubPullRequest & {
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
  store: MultiremiStore,
  issueId: string,
  c: { req: { query: (name: string) => string | undefined } },
): MultiremiTimelineEntry[] | {
  entries: MultiremiTimelineEntry[];
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
    entries: MultiremiTimelineEntry[];
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

function timelineEntryCompatibilityResponse(entry: MultiremiTimelineEntry): Record<string, unknown> {
  const response: Record<string, unknown> = {
    type: entry.type,
    id: entry.id,
    actor_type: entry.actor_type ?? entry.actorType,
    actor_id: entry.actor_id ?? entry.actorId,
    created_at: entry.created_at ?? entry.createdAt,
  };
  if (entry.type === "activity") {
    response.action = entry.action ?? null;
    response.details = entry.details ?? null;
    return response;
  }

  response.content = entry.content ?? null;
  response.parent_id = entry.parent_id ?? entry.parentId ?? null;
  response.updated_at = entry.updated_at ?? entry.updatedAt ?? null;
  response.comment_type = entry.comment_type ?? entry.commentType ?? null;
  response.reactions = (entry.reactions ?? []).map(commentReactionCompatibilityResponse);
  response.attachments = (entry.attachments ?? []).map(issueDetailAttachmentCompatibilityResponse);
  response.resolved_at = entry.resolved_at ?? entry.resolvedAt ?? null;
  response.resolved_by_type = entry.resolved_by_type ?? entry.resolvedByType ?? null;
  response.resolved_by_id = entry.resolved_by_id ?? entry.resolvedById ?? null;
  return response;
}

function issueTimelineCompatibilityResponse(
  store: MultiremiStore,
  issueId: string,
  c: { req: { query: (name: string) => string | undefined } },
): Record<string, unknown>[] | {
  entries: Record<string, unknown>[];
  next_cursor: null;
  prev_cursor: null;
  has_more_before: false;
  has_more_after: false;
  target_index?: number;
} | null {
  const response = issueTimelineResponse(store, issueId, c);
  if (!response) return null;
  if (Array.isArray(response)) return response.map(timelineEntryCompatibilityResponse);
  return {
    ...response,
    entries: response.entries.map(timelineEntryCompatibilityResponse),
  };
}

function withFeedbackRequestMetadata(
  input: CreateFeedbackInput,
  c: { req: { header: (name: string) => string | undefined } },
): CreateFeedbackInput {
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    platform: c.req.header("x-multiremi-platform") ?? c.req.header("x-remi-platform") ?? null,
    version: c.req.header("x-multiremi-version") ?? c.req.header("x-remi-version") ?? null,
    os: c.req.header("x-multiremi-os") ?? c.req.header("x-remi-os") ?? null,
    user_agent: c.req.header("user-agent") ?? null,
  };
  return { ...input, metadata };
}

function createFeedbackOrApiError(store: MultiremiStore, input: CreateFeedbackInput): ReturnType<MultiremiStore["createFeedback"]> {
  try {
    return store.createFeedback(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "message is required" || message === "message too long" || message === "metadata exceeds the 8KB size limit") {
      throw new MultiremiApiError(message, 400);
    }
    if (message === "too many feedback submissions, please try again later") {
      throw new MultiremiApiError(message, 429);
    }
    throw error;
  }
}

function safeUpdateCurrentUser(
  store: MultiremiStore,
  input: any,
): ReturnType<MultiremiStore["updateCurrentUser"]> | { error: string; status: 400 } {
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
  store: MultiremiStore,
  input: any,
  actingUserId: string | null,
): ReturnType<MultiremiStore["createWorkspace"]> | { error: string; status: 400 | 409 } {
  try {
    return store.createWorkspace({
      name: String(input.name ?? ""),
      slug: input.slug,
      description: input.description ?? null,
      context: input.context ?? null,
      settings: input.settings,
      repos: input.repos,
      issuePrefix: input.issuePrefix ?? input.issue_prefix,
    }, actingUserId);
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

function normalizeGoWorkspaceMemberRole(value: unknown): { role: "owner" | "admin" | "member" } | { error: string } {
  const role = String(value ?? "").trim().toLowerCase();
  if (!role) return { error: "role is required" };
  if (role === "owner" || role === "admin" || role === "member") return { role };
  return { error: "invalid member role" };
}

function workspaceMemberToGoResponse(member: MultiremiWorkspaceMember, options: { includeUser?: boolean; includeName?: boolean } = {}): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: member.id,
    workspace_id: member.workspaceId,
    user_id: workspaceMemberUserId(member),
    role: member.role,
    created_at: member.createdAt,
  };
  // List responses include the display name (the web member/assignee filters call
  // member.name.toLowerCase()) but NOT email — the Go-compat list omits email.
  // Full user fields (incl. email) are only returned on the single-member update path.
  if (options.includeUser || options.includeName) {
    response.name = member.name;
    response.avatar_url = null;
  }
  if (options.includeUser) {
    response.email = member.email ?? "";
  }
  return response;
}

function workspaceMemberUserId(member: MultiremiWorkspaceMember): string {
  const prefix = `mem_${member.workspaceId}_`;
  return member.id.startsWith(prefix) ? member.id.slice(prefix.length) || member.id : member.id;
}

function acceptedInvitationMemberToGoResponse(
  store: MultiremiStore,
  invitation: { workspaceId: string },
): Record<string, unknown> | { error: string; status: 500 } {
  const user = store.getCurrentUser();
  const member = store.getWorkspaceMember(`mem_${invitation.workspaceId}_${user.id}`);
  if (!member) return { error: "failed to accept invitation", status: 500 };
  return workspaceMemberToGoResponse(member, { includeUser: true });
}

// The success arm is a Record<string, unknown> (index signature), so `"error" in x`
// cannot discriminate the error sentinel; check the literal status instead.
function isMemberResponseError(
  value: Record<string, unknown> | { error: string; status: 500 },
): value is { error: string; status: 500 } {
  return typeof value.error === "string" && value.status === 500;
}

function memberRemovedPayload(member: MultiremiWorkspaceMember): Record<string, unknown> {
  return {
    member_id: member.id,
    workspace_id: member.workspaceId,
    user_id: workspaceMemberUserId(member),
  };
}

function workspaceNamePayload(store: MultiremiStore, workspaceId: string): Record<string, unknown> {
  const workspace = store.getWorkspace(workspaceId);
  return workspace ? { workspace_name: workspace.name } : {};
}

function publishWorkspaceEvent(
  c: Context,
  store: MultiremiStore,
  type: string,
  workspaceId: string,
  payload: Record<string, unknown>,
): void {
  store.emitWorkspaceEvent({
    type,
    workspaceId,
    payload,
    actorType: "member",
    actorId: currentRequestUserId(c),
  });
}

function safeUpdateWorkspaceMember(
  store: MultiremiStore,
  memberId: string,
  input: UpdateWorkspaceMemberInput,
): ReturnType<MultiremiStore["updateWorkspaceMember"]> | { error: string; status: 400 | 404 } {
  try {
    return store.updateWorkspaceMember(memberId, input);
  } catch (error) {
    return workspaceMemberMutationError(error, "member not found");
  }
}

function safeArchiveWorkspaceMember(
  store: MultiremiStore,
  memberId: string,
): ReturnType<MultiremiStore["archiveWorkspaceMember"]> | { error: string; status: 400 | 404 } {
  try {
    return store.archiveWorkspaceMember(memberId);
  } catch (error) {
    return workspaceMemberMutationError(error, "member not found");
  }
}

function safeLeaveWorkspace(
  store: MultiremiStore,
  workspaceId: string,
  memberId?: string,
): { ok: true } | { error: string; status: 400 | 404 } {
  try {
    const left = store.leaveWorkspace(workspaceId, memberId);
    if (!left) return { error: "member not found", status: 404 };
    return { ok: true };
  } catch (error) {
    return workspaceMemberMutationError(error, "member not found");
  }
}

function workspaceMemberMutationError(error: unknown, missingMessage: string): { error: string; status: 400 | 404 } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Member not found") || message === missingMessage) return { error: missingMessage, status: 404 };
  if (message === "workspace must have at least one owner") return { error: message, status: 400 };
  return { error: message, status: 400 };
}

function safeCreateInvitation(
  store: MultiremiStore,
  workspaceId: string,
  input: any,
  inviterUserId?: string | null,
): NonNullable<ReturnType<MultiremiStore["createWorkspaceInvitation"]>> | { error: string; status: 400 | 404 | 409 } {
  try {
    return store.createWorkspaceInvitation(workspaceId, input, inviterUserId);
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
  store: MultiremiStore,
  invitationId: string,
  actingUserId?: string | null,
): NonNullable<ReturnType<MultiremiStore["acceptInvitation"]>> | { error: string; status: 400 | 403 | 404 | 409 | 410 } {
  try {
    const invitation = store.acceptInvitation(invitationId, actingUserId);
    if (!invitation) return { error: "invitation not found", status: 404 };
    return invitation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invitation does not belong to you") return { error: message, status: 403 };
    if (message === "invitation has expired") return { error: message, status: 410 };
    if (message === "you are already a member of this workspace") return { error: message, status: 409 };
    return { error: message, status: 400 };
  }
}

function safeDeclineInvitation(
  store: MultiremiStore,
  invitationId: string,
  actingUserId?: string | null,
): NonNullable<ReturnType<MultiremiStore["declineInvitation"]>> | { error: string; status: 400 | 403 | 404 } {
  try {
    const invitation = store.declineInvitation(invitationId, actingUserId);
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
  store: MultiremiStore,
): ReturnType<MultiremiStore["updateCurrentUser"]> | { error: string; status: 400 } {
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
  store: MultiremiStore,
  body: { workspace_id?: string; workspaceId?: string; runtime_id?: string; runtimeId?: string },
): { workspace_id: string; agent_id: string; issue_id: string } | { error: string; status: 400 | 404 } {
  const workspaceId = body.workspace_id ?? body.workspaceId ?? "";
  const runtimeId = body.runtime_id ?? body.runtimeId ?? "";
  if (!workspaceId) return { error: "workspace_id is required", status: 400 };
  if (!runtimeId) return { error: "runtime_id is required", status: 400 };
  const runtime = store.getRuntime(runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) return { error: "invalid runtime_id", status: 400 };
  const provider = runtime.provider === "claude" || runtime.provider === "codex" ? runtime.provider : "codex";
  const bootstrapUserId = store.getCurrentUser().id;
  const before = store.getDefaultAgent(workspaceId, provider, { visibleTo: bootstrapUserId });
  const isFirstAgent = isFirstAgentInWorkspace(store, workspaceId);
  const agent = store.ensureDefaultAgent(provider, {
    workspaceId,
    ownerId: bootstrapUserId,
  });
  if (!before) {
    recordSystemAgentCreatedAnalytics(store, agent, runtime, {
      actorId: store.getCurrentUser().id,
      template: "multiremi_helper",
      isFirstAgentInWorkspace: isFirstAgent,
    });
  }
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
  store: MultiremiStore,
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
  store: MultiremiStore,
  workspaceId: string,
  title: string,
  description: string,
): ReturnType<MultiremiStore["createIssue"]> {
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

function registerDaemonRuntimes(
  store: MultiremiStore,
  body: DaemonRegisterRequestBody,
  auth: { ownerId: string | null } = { ownerId: null },
):
  | {
    runtimes: ReturnType<typeof daemonRuntimeResponse>[];
    repos: WorkspaceRepoData[];
    repos_version: string;
    settings: Record<string, unknown>;
  }
  | { error: string; status: 400 | 404 | 500 } {
  // Older self-host clients (e.g. the v0.2.0 `remi` release) omit workspace_id
  // in the register body and relied on the server deriving it. This is a
  // single-workspace local deployment, so default to "local" — matching the
  // `?? "local"` fallback used throughout the rest of the daemon path
  // (daemonRegisterOwnerContext, heartbeat, denyDaemonTokenWorkspace).
  const workspaceId = String(body.workspace_id ?? "").trim() || "local";
  const daemonId = String(body.daemon_id ?? "").trim();
  const runtimes = body.runtimes ?? [];
  if (!daemonId) return { error: "daemon_id is required", status: 400 };
  if (runtimes.length === 0) return { error: "at least one runtime is required", status: 400 };

  const deviceName = String(body.device_name ?? "").trim();
  const cliVersion = String(body.cli_version ?? "").trim();
  const launchedBy = String(body.launched_by ?? "").trim();
  const legacyDaemonIds = uniqueStrings(body.legacy_daemon_ids ?? []);
  const repos = workspaceReposResponse(store, workspaceId);
  if (!repos) return { error: "workspace not found", status: 404 };
  const registered: ReturnType<typeof daemonRuntimeResponse>[] = [];
  for (const runtime of runtimes) {
    const providerResult = validateMultiremiRuntimeProvider(runtime.type);
    if ("error" in providerResult) return providerResult;
    const provider = providerResult.provider;
    const version = String(runtime.version ?? "").trim();
    const name = String(runtime.name ?? "").trim() || (deviceName ? `${provider} (${deviceName})` : provider);
    const id = daemonRuntimeId(daemonId, provider);
    const deviceInfo = [deviceName, version].filter(Boolean).join(" · ");
    // Ownership is set once, on first registration (owner = the registering
    // token's user). Re-registration (daemon restart/heartbeat) must never
    // hijack an already-owned runtime.
    const ownerId = store.getRuntime(id)?.ownerId ?? auth.ownerId;
    let saved: ReturnType<MultiremiStore["registerRuntime"]>;
    try {
      saved = store.registerRuntime({
        id,
        name,
        provider,
        daemonId,
        runtimeMode: "local",
        deviceInfo,
        metadata: {
          version,
          cli_version: cliVersion,
          launched_by: launchedBy,
          ...(typeof runtime.acpVersion === "string" && runtime.acpVersion ? { acp_version: runtime.acpVersion } : {}),
          ...(typeof runtime.agentVersion === "string" && runtime.agentVersion ? { agent_version: runtime.agentVersion } : {}),
        },
        workspaceId,
        ownerId,
        status: runtime.status === "offline" ? "offline" : "online",
        maxConcurrency: Number.isFinite(Number(runtime.maxConcurrency)) && Number(runtime.maxConcurrency) >= 1
          ? Math.floor(Number(runtime.maxConcurrency))
          : 1,
      });
    } catch (error) {
      store.recordRuntimeFailure({
        ownerId: auth.ownerId,
        workspaceId,
        daemonId,
        provider,
        failureReason: "registration_failed",
        errorType: "db_error",
        recoverable: true,
      });
      const message = error instanceof Error ? error.message : String(error);
      return { error: `failed to register runtime: ${message}`, status: 500 };
    }
    if (runtime.status === "offline") store.setRuntimeOffline(saved.id);
    mergeLegacyDaemonRuntimes(store, saved, provider, legacyDaemonIds);
    const current = store.getRuntime(saved.id) ?? saved;
    registered.push(daemonRuntimeResponse(current, {
      daemonId,
      version,
      cliVersion,
      launchedBy,
    }));
  }
  if (registered.length > 0) {
    // Let browsers (e.g. the "Add computer" dialog) auto-detect a daemon coming
    // online and jump to the new runtime. `runtime_id` targets the primary card.
    store.emitWorkspaceEvent({
      type: "daemon:register",
      workspaceId,
      actorType: "daemon",
      actorId: daemonId,
      payload: {
        daemon_id: daemonId,
        device_name: deviceName,
        runtime_id: registered[0].id,
        runtime_ids: registered.map((runtime) => runtime.id),
      },
    });
  }
  return {
    runtimes: registered,
    repos: repos.repos,
    repos_version: repos.repos_version,
    settings: repos.settings,
  };
}

function daemonRegisterOwnerContext(
  c: Context,
  store: MultiremiStore,
  workspaceId: string | null | undefined,
): { ownerId: string | null } | { error: string; status: 403 } {
  const token = currentAccessToken(c);
  const targetWorkspaceId = cleanString(workspaceId) ?? "local";
  if (!token) {
    const jwtUserId = currentJwtUserId(c);
    if (!jwtUserId) return { ownerId: null };
    if (!hasJwtWorkspaceAccess(store, jwtUserId, targetWorkspaceId)) {
      return { error: "forbidden for token workspace", status: 403 };
    }
    return { ownerId: jwtUserId };
  }
  // Daemon tokens are machine identities: runtimes they register are owned by the
  // user who created the token (during `remi setup`), not left ownerless.
  if (token.type === "daemon") return { ownerId: cleanString(token.userId) ?? null };
  if (token.workspaceId !== targetWorkspaceId) {
    return { error: "forbidden for token workspace", status: 403 };
  }
  return { ownerId: cleanString(token.userId) ?? "local" };
}

function uniqueStrings(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function mergeLegacyDaemonRuntimes(
  store: MultiremiStore,
  newRuntime: MultiremiRuntime,
  provider: string,
  legacyDaemonIds: string[],
): void {
  const mergedRuntimeIds = new Set<string>();
  for (const legacyDaemonId of legacyDaemonIds) {
    const key = legacyDaemonId.toLowerCase();
    const oldRuntimeId = daemonRuntimeId(legacyDaemonId, provider);
    const candidates = store.listRuntimes().filter((runtime) =>
      runtime.id !== newRuntime.id &&
      runtime.provider === provider &&
      runtime.workspaceId === newRuntime.workspaceId &&
      (runtime.id === oldRuntimeId || runtime.daemonId?.toLowerCase() === key)
    );
    for (const candidate of candidates) {
      if (mergedRuntimeIds.has(candidate.id)) continue;
      mergedRuntimeIds.add(candidate.id);
      const merged = store.mergeRuntimeInto(candidate.id, newRuntime.id);
      if (merged.deleted) {
        store.recordRuntimeLegacyDaemonId(newRuntime.id, legacyDaemonId, {
          oldRuntimeId: candidate.id,
          newRuntimeId: newRuntime.id,
          provider,
          agentsReassigned: merged.agentsReassigned,
          tasksReassigned: merged.tasksReassigned,
        });
      }
    }
  }
}

type WorkspaceRepoData = {
  url: string;
  description?: string;
};

function workspaceReposResponse(store: MultiremiStore, workspaceId: string): {
  workspace_id: string;
  repos: WorkspaceRepoData[];
  repos_version: string;
  settings: Record<string, unknown>;
} | null {
  const workspace = workspaceId === "local" ? store.ensureLocalWorkspace() : store.getWorkspace(workspaceId);
  if (!workspace) return null;
  const repos = normalizeWorkspaceRepos(workspace.repos);
  return {
    workspace_id: workspace.id,
    repos,
    repos_version: workspaceReposVersion(repos),
    settings: workspace.settings,
  };
}

function normalizeWorkspaceRepos(rawRepos: unknown[]): WorkspaceRepoData[] {
  const repos: WorkspaceRepoData[] = [];
  const seen = new Set<string>();
  for (const raw of rawRepos) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const description = typeof record.description === "string" ? record.description : "";
    repos.push(description ? { url, description } : { url });
  }
  return repos;
}

function workspaceReposVersion(repos: WorkspaceRepoData[]): string {
  const urls = repos.map((repo) => repo.url).filter(Boolean).sort();
  return createHash("sha256").update(urls.join("\n")).digest("hex");
}

function githubAppSlug(): string {
  return (process.env.GITHUB_APP_SLUG ?? "").trim();
}

function githubWebhookSecret(): string {
  return (process.env.GITHUB_WEBHOOK_SECRET ?? process.env.MULTIREMI_WEBHOOK_SECRET ?? "").trim();
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

function sendLocalAuthCode(
  store: MultiremiStore,
  body: { email?: string; name?: string },
): { ok: true; sent: true; email: string; code: string; expires_at: string } | { error: string; status: 400 } {
  const email = normalizeAuthEmail(body.email);
  if (typeof email !== "string") return email;
  const code = createLocalAuthCode(email);
  const expiresAt = Date.now() + LOCAL_AUTH_CODE_TTL_MS;
  localAuthCodes.set(email, { code, expiresAt });
  if (body.name || email !== store.getCurrentUser().email) {
    store.updateCurrentUser({
      name: String(body.name ?? store.getCurrentUser().name).trim() || "Local User",
      email,
    });
  }
  return {
    ok: true,
    sent: true,
    email,
    code,
    expires_at: new Date(expiresAt).toISOString(),
  };
}

async function verifyLocalAuthCode(
  store: MultiremiStore,
  body: { email?: string; code?: string; name?: string },
): Promise<Awaited<ReturnType<typeof localAuthResponse>> | { error: string; status: 400 | 401 }> {
  const email = normalizeAuthEmail(body.email);
  if (typeof email !== "string") return email;
  const code = String(body.code ?? "").trim();
  if (!code) return { error: "code is required", status: 400 };
  const expected = localAuthCodes.get(email);
  if (!expected || expected.expiresAt < Date.now() || expected.code !== code) {
    return { error: "invalid code", status: 401 };
  }
  localAuthCodes.delete(email);
  return localAuthResponse(store, { email, name: body.name });
}

async function localGoogleAuthFallback(
  store: MultiremiStore,
  body: { email?: string; name?: string; credential?: string; token?: string },
): Promise<Awaited<ReturnType<typeof localAuthResponse>> | { error: string; status: 400 }> {
  const email = normalizeAuthEmail(body.email ?? store.getCurrentUser().email);
  if (typeof email !== "string") return email;
  return localAuthResponse(store, { email, name: body.name });
}

async function localAuthResponse(
  store: MultiremiStore,
  identity: { externalId?: string | null; email: string; name?: string | null },
): Promise<{
  ok: true;
  token: string;
  access_token: string;
  token_type: "bearer";
  user: ReturnType<MultiremiStore["getCurrentUser"]>;
}> {
  // Provision/resolve the distinct user for this identity, then sign a token that
  // carries that user's real id — never the "local" catch-all. Multiple people
  // logging in each get their own record and their own token.
  const user = store.getOrCreateUser({
    externalId: identity.externalId ?? null,
    email: identity.email,
    name: identity.name ?? null,
  });
  const token = await store.createAccessToken({
    workspaceId: "local",
    userId: user.id,
    name: `Login for ${user.email}`,
    type: "pat",
    expiresInDays: 30,
  });
  return {
    ok: true,
    token: token.token,
    access_token: token.token,
    token_type: "bearer",
    user,
  };
}

// ── Feishu (Lark) SSO ──────────────────────────────────────────────
// Credentials come from env (MULTIREMI_LARK_APP_ID / _APP_SECRET / _DOMAIN).
// Reuses the same authen/v1 + authen/v2 OAuth flow as src/auth/oauth-cli.ts.
interface LarkSsoConfig {
  appId: string;
  appSecret: string;
  apiBase: string;
}

function loadLarkSsoConfig(): LarkSsoConfig | null {
  const appId = process.env.MULTIREMI_LARK_APP_ID?.trim();
  const appSecret = process.env.MULTIREMI_LARK_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;
  const domain = process.env.MULTIREMI_LARK_DOMAIN?.trim();
  const apiBase =
    domain === "lark" || domain === "larksuite"
      ? "https://open.larksuite.com/open-apis"
      : domain && domain.startsWith("http")
        ? `${domain.replace(/\/+$/, "")}/open-apis`
        : "https://open.feishu.cn/open-apis";
  return { appId, appSecret, apiBase };
}

function buildLarkAuthorizeUrl(cfg: LarkSsoConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  return `${cfg.apiBase}/authen/v1/authorize?${params.toString()}`;
}

async function larkExchangeCode(cfg: LarkSsoConfig, code: string, redirectUri: string): Promise<string> {
  const resp = await fetch(`${cfg.apiBase}/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      redirect_uri: redirectUri,
    }),
  });
  const result = (await resp.json()) as {
    code?: number;
    error?: string;
    error_description?: string;
    access_token?: string;
  };
  if (result.error) throw new Error(`Feishu token exchange failed: ${result.error_description ?? result.error}`);
  if (result.code && result.code !== 0) throw new Error(`Feishu token exchange failed: code ${result.code}`);
  if (!result.access_token) throw new Error("Feishu token exchange failed: no access_token returned");
  return result.access_token;
}

async function larkFetchUserInfo(cfg: LarkSsoConfig, userAccessToken: string): Promise<{ name: string; email: string | null; openId: string | null }> {
  const resp = await fetch(`${cfg.apiBase}/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${userAccessToken}` },
  });
  const result = (await resp.json()) as {
    code?: number;
    msg?: string;
    data?: { name?: string; email?: string; enterprise_email?: string; open_id?: string };
  };
  if (result.code && result.code !== 0) throw new Error(`Feishu user_info failed: ${result.msg ?? result.code}`);
  const data = result.data ?? {};
  return {
    name: data.name?.trim() || "Feishu User",
    email: (data.enterprise_email || data.email || "").trim() || null,
    openId: data.open_id ?? null,
  };
}

function normalizeAuthEmail(value: unknown): string | { error: string; status: 400 } {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return { error: "email is required", status: 400 };
  if (email.length > 254) return { error: "email is too long", status: 400 };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "email is invalid", status: 400 };
  return email;
}

function createLocalAuthCode(email: string): string {
  if (process.env.MULTIREMI_LOCAL_AUTH_CODE) return process.env.MULTIREMI_LOCAL_AUTH_CODE.trim();
  const digest = createHmac("sha256", process.env.MULTIREMI_TOKEN || "local-bun-multiremi")
    .update(email)
    .update(String(Math.floor(Date.now() / LOCAL_AUTH_CODE_TTL_MS)))
    .digest("hex");
  return String(parseInt(digest.slice(0, 8), 16) % 1_000_000).padStart(6, "0");
}

function handleGitHubWebhook(store: MultiremiStore, body: any): { ok: string } | { ok: true; ignored: true } | { pullRequest: MultiremiGitHubPullRequest } {
  if (body.zen) return { ok: "pong" };
  const pr = body.pull_request;
  const repo = body.repository;
  if (!pr || !repo) return { ok: true, ignored: true };
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
  return { pullRequest };
}

function cloudRuntimeStatusResponse(c: Context, store: MultiremiStore, body: any, status: string) {
  const id = body.id ?? body.node_id ?? body.nodeId ?? "";
  const node = id ? store.setCloudRuntimeNodeStatus(id, status) : null;
  if (!node) return c.json({ error: "cloud runtime node not found" }, 404);
  return c.json(node);
}

function taskCompatibilityResponse(task: MultiremiTask, triggerMetadata: MultiremiTaskTriggerMetadata | null = null): Omit<MultiremiTask, "result"> & {
  result: unknown | null;
  agent_id: string;
  runtime_id: string | null;
  issue_id: string | null;
  chat_session_id: string | null;
  autopilot_run_id: string | null;
  trigger_comment_id: string | null;
  trigger_summary: string | null;
  trigger_thread_id?: string;
  trigger_comment_content?: string;
  trigger_author_type?: string;
  trigger_author_name?: string;
  new_comment_count?: number;
  new_comments_since?: string;
  workspace_id: string;
  max_attempts: number;
  parent_task_id: string | null;
  failure_reason: string | null;
  branch_name: string | null;
  session_id: string | null;
  work_dir: string | null;
  progress_summary: string | null;
  progress_step: number | null;
  progress_total: number | null;
  wait_reason: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
} {
  const response: Omit<MultiremiTask, "result"> & {
    result: unknown | null;
    agent_id: string;
    runtime_id: string | null;
    issue_id: string | null;
    chat_session_id: string | null;
    autopilot_run_id: string | null;
    trigger_comment_id: string | null;
    trigger_summary: string | null;
    trigger_thread_id?: string;
    trigger_comment_content?: string;
    trigger_author_type?: string;
    trigger_author_name?: string;
    new_comment_count?: number;
    new_comments_since?: string;
    workspace_id: string;
    max_attempts: number;
    parent_task_id: string | null;
    failure_reason: string | null;
    branch_name: string | null;
    session_id: string | null;
    work_dir: string | null;
    progress_summary: string | null;
    progress_step: number | null;
    progress_total: number | null;
    wait_reason: string | null;
    created_at: string;
    updated_at: string;
    dispatched_at: string | null;
    started_at: string | null;
    completed_at: string | null;
    failed_at: string | null;
    cancelled_at: string | null;
  } = {
    // These trigger compat snake-fields are typed `string | null` on MultiremiTask
    // but are never set on stored tasks; they are assigned below from triggerMetadata
    // as `string`. Omit them from the spread's type so the strict response type holds.
    ...(task as Omit<MultiremiTask, "trigger_thread_id" | "trigger_comment_content" | "trigger_author_type" | "trigger_author_name" | "new_comment_count" | "new_comments_since">),
    result: taskResultWireValue(task),
    agent_id: task.agentId,
    runtime_id: task.runtimeId,
    issue_id: task.issueId,
    chat_session_id: task.chatSessionId,
    autopilot_run_id: task.autopilotRunId,
    trigger_comment_id: task.triggerCommentId,
    trigger_summary: task.triggerSummary,
    workspace_id: task.workspaceId,
    max_attempts: task.maxAttempts,
    parent_task_id: task.parentTaskId,
    failure_reason: task.failureReason,
    branch_name: task.branchName,
    session_id: task.sessionId,
    work_dir: task.workDir,
    progress_summary: task.progressSummary,
    progress_step: task.progressStep,
    progress_total: task.progressTotal,
    wait_reason: task.waitReason,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    dispatched_at: task.dispatchedAt,
    started_at: task.startedAt,
    completed_at: task.completedAt,
    failed_at: task.failedAt,
    cancelled_at: task.cancelledAt,
  };
  if (triggerMetadata?.triggerThreadId) response.trigger_thread_id = triggerMetadata.triggerThreadId;
  if (triggerMetadata?.triggerCommentContent) response.trigger_comment_content = triggerMetadata.triggerCommentContent;
  if (triggerMetadata?.triggerAuthorType) response.trigger_author_type = triggerMetadata.triggerAuthorType;
  if (triggerMetadata?.triggerAuthorName) response.trigger_author_name = triggerMetadata.triggerAuthorName;
  if (triggerMetadata?.newCommentCount) {
    response.new_comment_count = triggerMetadata.newCommentCount;
    if (triggerMetadata.newCommentsSince) response.new_comments_since = triggerMetadata.newCommentsSince;
  }
  return response;
}

function daemonTaskWireResponse(task: MultiremiTask, triggerMetadata: MultiremiTaskTriggerMetadata | null = null): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: task.id,
    agent_id: task.agentId,
    runtime_id: task.runtimeId ?? "",
    issue_id: task.issueId ?? "",
    workspace_id: task.workspaceId,
    status: task.status,
    priority: task.priority,
    dispatched_at: task.dispatchedAt,
    started_at: task.startedAt,
    completed_at: task.completedAt,
    result: taskResultWireValue(task),
    error: task.error,
    attempt: task.attempt,
    max_attempts: task.maxAttempts,
    created_at: task.createdAt,
    kind: daemonTaskKind(task),
  };
  if (task.failureReason) response.failure_reason = task.failureReason;
  if (task.parentTaskId) response.parent_task_id = task.parentTaskId;
  if (task.waitReason) response.wait_reason = task.waitReason;
  if (task.progressSummary) response.progress_summary = task.progressSummary;
  if (task.progressStep != null) response.progress_step = task.progressStep;
  if (task.progressTotal != null) response.progress_total = task.progressTotal;
  if (task.chatSessionId) response.chat_session_id = task.chatSessionId;
  if (task.autopilotRunId) response.autopilot_run_id = task.autopilotRunId;
  if (task.triggerCommentId) response.trigger_comment_id = task.triggerCommentId;
  if (task.triggerSummary) response.trigger_summary = task.triggerSummary;
  if (triggerMetadata?.triggerThreadId) response.trigger_thread_id = triggerMetadata.triggerThreadId;
  if (triggerMetadata?.triggerCommentContent) response.trigger_comment_content = triggerMetadata.triggerCommentContent;
  if (triggerMetadata?.triggerAuthorType) response.trigger_author_type = triggerMetadata.triggerAuthorType;
  if (triggerMetadata?.triggerAuthorName) response.trigger_author_name = triggerMetadata.triggerAuthorName;
  if (triggerMetadata?.newCommentCount) {
    response.new_comment_count = triggerMetadata.newCommentCount;
    if (triggerMetadata.newCommentsSince) response.new_comments_since = triggerMetadata.newCommentsSince;
  }
  if (task.workDir) {
    response.work_dir = task.workDir;
    const relative = daemonRelativeWorkDir(task.workDir, task.workspaceId, task.id);
    if (relative) response.relative_work_dir = relative;
  }
  return response;
}

function daemonTaskClaimResponse(
  store: MultiremiStore,
  task: MultiremiTaskWithAgent,
  triggerMetadata: MultiremiTaskTriggerMetadata | null = null,
): Record<string, unknown> {
  const response = daemonTaskWireResponse(task, triggerMetadata);
  response.prompt = task.prompt;
  if (task.sessionId) {
    response.session_id = task.sessionId;
    response.prior_session_id = task.sessionId;
  }
  if (task.branchName) response.branch_name = task.branchName;
  if (task.workDir) response.prior_work_dir = task.workDir;
  if (task.agent) response.agent = daemonClaimAgentResponse(task.agent);
  if (task.issue) response.issue = issueCompatibilityResponse(task.issue, { includeLabels: true });
  if (task.project) {
    response.project_id = task.project.id;
    response.project_title = task.project.title;
    response.project = projectCompatibilityResponse(task.project);
  }
  if (task.projectResources.length) {
    response.project_resources = task.projectResources.map(projectResourceCompatibilityResponse);
  }
  if (task.repos.length) {
    response.repos = task.repos.map((repo) => ({
      url: repo.url,
      ...(repo.description ? { description: repo.description } : {}),
    }));
  }
  appendDaemonClaimExecutionContext(store, task, response);
  return response;
}

function appendDaemonClaimExecutionContext(
  store: MultiremiStore,
  task: MultiremiTaskWithAgent,
  response: Record<string, unknown>,
): void {
  appendDaemonClaimWorkspaceContext(store, task, response);
  appendDaemonClaimChatContext(store, task, response);
  appendDaemonClaimAutopilotContext(store, task, response);

  const quickCreatePrompt = daemonQuickCreatePrompt(task);
  if (quickCreatePrompt) response.quick_create_prompt = quickCreatePrompt;
}

function appendDaemonClaimWorkspaceContext(store: MultiremiStore, task: MultiremiTaskWithAgent, response: Record<string, unknown>): void {
  const workspace = store.getWorkspace(task.workspaceId);
  if (workspace?.context?.trim()) response.workspace_context = workspace.context.trim();

  const runtime = task.runtimeId ? store.getRuntime(task.runtimeId) : null;
  const owner = runtime?.ownerId ? store.getUser(runtime.ownerId) : null;
  if (owner?.name?.trim()) response.requesting_user_name = owner.name.trim();
  if (owner?.profileDescription?.trim()) response.requesting_user_profile_description = owner.profileDescription.trim();
}

function appendDaemonClaimChatContext(store: MultiremiStore, task: MultiremiTaskWithAgent, response: Record<string, unknown>): void {
  if (!task.chatSessionId) return;
  try {
    const messages = trailingDaemonUserMessages(store.listChatMessages(task.chatSessionId));
    const chatMessage = messages.map((message) => message.body.trim()).filter(Boolean).join("\n\n");
    if (chatMessage) response.chat_message = chatMessage;
  } catch (error) {
    log.debug(`Failed to load chat context for claimed task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function appendDaemonClaimAutopilotContext(store: MultiremiStore, task: MultiremiTaskWithAgent, response: Record<string, unknown>): void {
  if (!task.autopilotRunId) return;
  const run = store.getAutopilotRun(task.autopilotRunId);
  if (!run) return;
  response.autopilot_id = run.autopilotId;
  response.autopilot_source = run.source;
  if (run.payload != null) response.autopilot_trigger_payload = run.payload;

  const autopilot = store.getAutopilot(run.autopilotId);
  if (!autopilot) return;
  response.autopilot_title = autopilot.title;
  if (autopilot.description) response.autopilot_description = autopilot.description;
}

function trailingDaemonUserMessages(messages: MultiremiChatMessage[]): MultiremiChatMessage[] {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== "user") {
      start = index + 1;
      break;
    }
  }
  return messages.slice(start).filter((message) => message.role === "user");
}

function daemonQuickCreatePrompt(task: MultiremiTaskWithAgent): string | null {
  for (const ref of task.issue?.contextRefs ?? []) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
    const data = ref as { type?: unknown; prompt?: unknown };
    if (data.type === "quick_create" && typeof data.prompt === "string" && data.prompt.trim()) {
      return data.prompt.trim();
    }
  }
  if (!task.issueId && !task.chatSessionId && !task.autopilotRunId && task.prompt.trim()) return task.prompt.trim();
  return null;
}

function daemonClaimAgentResponse(agent: MultiremiAgent): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    instructions: agent.instructions,
    skills: agent.skills.map(daemonClaimSkillResponse),
    custom_env: agent.customEnv ?? {},
    custom_args: agent.customArgs ?? [],
    mcp_config: agent.mcpConfig,
    model: agent.model ?? "",
    thinking_level: agent.thinkingLevel ?? "",
    cwd: agent.cwd ?? "",
    executable: agent.executable ?? "",
    allowed_tools: agent.allowedTools ?? [],
    max_concurrent_tasks: agent.maxConcurrentTasks,
  };
}

function daemonClaimSkillResponse(skill: MultiremiSkill): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description ?? "",
    content: skill.content,
    files: (skill.files ?? []).map((file) => ({
      path: file.path,
      content: file.content,
    })),
  };
}

function taskResultWireValue(task: MultiremiTask): unknown | null {
  if (task.result == null) return null;
  if (task.status !== "completed") return task.result;
  return {
    pr_url: task.branchName ?? "",
    output: task.result,
    session_id: task.sessionId ?? "",
    work_dir: task.workDir ?? "",
  };
}

function daemonTaskMessageWireResponse(message: MultiremiTaskMessage, task: MultiremiTask): Record<string, unknown> {
  const response: Record<string, unknown> = {
    task_id: message.taskId,
    seq: message.seq,
    type: message.type,
  };
  if (task.issueId) response.issue_id = task.issueId;
  if (message.tool) response.tool = message.tool;
  if (message.content) response.content = message.content;
  if (message.input) response.input = message.input;
  if (message.output) response.output = message.output;
  return response;
}

function daemonTaskKind(task: MultiremiTask): "chat" | "autopilot" | "quick_create" | "comment" | "direct" {
  if (task.chatSessionId) return "chat";
  if (task.autopilotRunId) return "autopilot";
  if (!task.issueId) return "quick_create";
  if (task.triggerCommentId) return "comment";
  return "direct";
}

function daemonRelativeWorkDir(workDir: string, workspaceId: string, taskId: string): string {
  const normalized = workDir.replaceAll("\\", "/");
  const envRootSuffix = `${workspaceId}/${shortDaemonTaskId(taskId)}`;
  const suffixIndex = normalized.indexOf(envRootSuffix);
  if (suffixIndex >= 0) return normalized.slice(suffixIndex);

  const homeMatch = /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+(?:\/(.*))?$/i.exec(normalized);
  if (homeMatch) return homeMatch[1] ?? "";

  return daemonBasename(normalized);
}

function shortDaemonTaskId(taskId: string): string {
  return taskId.replaceAll("-", "").slice(0, 8);
}

function daemonBasename(path: string): string {
  const trimmed = path.replace(/\/+$/g, "");
  if (!trimmed) return "";
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function chatSessionCompatibilityResponse(session: MultiremiChatSession): {
  id: string;
  workspace_id: string;
  creator_id: string;
  agent_id: string;
  title: string;
  status: string;
  has_unread: boolean;
  created_at: string;
  updated_at: string;
} {
  return {
    id: session.id,
    workspace_id: session.workspaceId,
    agent_id: session.agentId,
    creator_id: session.creatorId ?? "local",
    title: session.title,
    status: session.status,
    has_unread: session.hasUnread,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

function chatMessageCompatibilityResponse(message: MultiremiChatMessage, attachments: MultiremiAttachment[] = []): {
  id: string;
  chat_session_id: string;
  role: string;
  content: string;
  task_id: string | null;
  created_at: string;
  failure_reason: string | null;
  elapsed_ms: number | null;
  attachments?: Record<string, unknown>[];
} {
  const response: {
    id: string;
    chat_session_id: string;
    role: string;
    content: string;
    task_id: string | null;
    created_at: string;
    failure_reason: string | null;
    elapsed_ms: number | null;
    attachments?: Record<string, unknown>[];
  } = {
    id: message.id,
    chat_session_id: message.chatSessionId,
    role: message.role,
    content: message.body,
    task_id: message.taskId,
    created_at: message.createdAt,
    failure_reason: message.failureReason,
    elapsed_ms: message.elapsedMs,
  };
  if (attachments.length) response.attachments = attachments.map(chatAttachmentCompatibilityResponse);
  return response;
}

function sendChatMessageCompatibilityResponse(result: SendChatMessageResult): {
  message_id: string;
  task_id: string;
  created_at: string;
} {
  return {
    message_id: result.message.id,
    task_id: result.task.id,
    created_at: result.task.createdAt,
  };
}

function inboxCompatibilityResponse(item: MultiremiInboxItem): MultiremiInboxItem & {
  workspace_id: string;
  issue_id: string | null;
  member_id: string;
  recipient_type: string;
  recipient_id: string;
  actor_type: string;
  actor_id: string | null;
  severity: string;
  details: unknown | null;
  created_at: string;
} {
  return {
    ...item,
    workspace_id: item.workspaceId,
    issue_id: item.issueId,
    member_id: item.memberId,
    recipient_type: item.recipientType,
    recipient_id: item.recipientId,
    actor_type: item.actorType,
    actor_id: item.actorId,
    severity: item.severity,
    details: item.details,
    created_at: item.createdAt,
  };
}

function squadMemberStatusResponse(store: MultiremiStore, squadId: string): Array<{
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

function autopilotTriggerResponse(trigger: MultiremiAutopilotTrigger): MultiremiAutopilotTrigger & {
  autopilot_id: string;
  cron_expression: string | null;
  next_run_at: string | null;
  webhook_token: string | null;
  webhook_path: string | null;
  webhook_url: string | null;
  event_filters: MultiremiAutopilotTrigger["eventFilters"];
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
    event_filters: trigger.eventFilters,
    signing_secret_set: trigger.signingSecretSet,
    last_fired_at: trigger.lastFiredAt,
    created_at: trigger.createdAt,
    updated_at: trigger.updatedAt,
  };
}

function issueUsageResponse(store: MultiremiStore, issue: MultiremiIssue): {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_tokens: number;
  task_count: number;
} {
  const taskIds = new Set(store.listTasksForIssue(issue.id).map((task) => task.id));
  const totals = {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_tokens: 0,
    task_count: taskIds.size,
  };
  for (const task of store.listTasksForIssue(issue.id)) {
    for (const entry of task.usage) {
      totals.total_input_tokens += entry.inputTokens ?? 0;
      totals.total_output_tokens += entry.outputTokens ?? 0;
      totals.total_cache_read_tokens += entry.cacheReadTokens ?? 0;
      totals.total_cache_write_tokens += entry.cacheWriteTokens ?? 0;
      totals.total_tokens += entry.totalTokens ?? 0;
    }
  }
  return totals;
}

function safeRerunIssue(
  store: MultiremiStore,
  issueId: string,
  body: { agent_id?: string; agentId?: string; prompt?: string },
): { task: MultiremiTask } | { error: string; status: 400 | 404 } {
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

function isPendingForRuntime(store: MultiremiStore, runtime: MultiremiRuntime, task: MultiremiTask): boolean {
  if (runtime.workspaceId && task.workspaceId !== runtime.workspaceId) return false;
  if (isInFlightTaskStatus(task.status)) return task.runtimeId === runtime.id;
  if (task.status !== "queued") return false;
  const agent = store.getAgent(task.agentId);
  if (!agent || agent.archivedAt) return false;
  if (task.runtimeId && task.runtimeId !== runtime.id) return false;
  if (agent.runtimeId && agent.runtimeId !== runtime.id) return false;
  if (runtime.provider !== "any" && agent.provider !== runtime.provider) return false;
  // Mirrors the claim SQL's ownership predicate: a private runtime only runs
  // its owner's agents unless the task is explicitly stamped to it.
  if (
    runtime.visibility !== "public" &&
    runtime.ownerId != null &&
    agent.ownerId !== runtime.ownerId &&
    task.runtimeId !== runtime.id
  ) {
    return false;
  }
  return true;
}

function isDaemonPendingTaskForRuntime(task: MultiremiTask, runtimeId: string): boolean {
  return task.runtimeId === runtimeId && (task.status === "queued" || task.status === "dispatched");
}

function compareDaemonPendingTasks(left: MultiremiTask, right: MultiremiTask): number {
  return right.priority - left.priority || Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function isTerminalTaskStatus(status: MultiremiTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isActiveTaskStatus(status: MultiremiTaskStatus): boolean {
  return status === "queued"
    || status === "dispatched"
    || status === "running"
    || status === "waiting_local_directory"
    || status === "awaiting_human";
}

function isInFlightTaskStatus(status: MultiremiTaskStatus): boolean {
  return status === "dispatched"
    || status === "running"
    || status === "waiting_local_directory"
    || status === "awaiting_human";
}

function launchHeader(provider: string): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  return provider ? provider[0].toUpperCase() + provider.slice(1) : "Runtime";
}

function daemonRuntimeResponse(
  runtime: MultiremiRuntime,
  metadata: {
    daemonId: string;
    version: string;
    cliVersion: string;
    launchedBy: string;
  },
): {
  id: string;
  workspace_id: string | null;
  daemon_id: string | null;
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
  return {
    id: runtime.id,
    workspace_id: runtime.workspaceId,
    daemon_id: runtime.daemonId ?? metadata.daemonId,
    name: runtime.name,
    runtime_mode: runtime.runtimeMode,
    provider: runtime.provider,
    launch_header: launchHeader(String(runtime.provider)),
    status: runtime.status,
    device_info: runtime.deviceInfo,
    metadata: Object.keys(runtime.metadata).length ? runtime.metadata : {
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
  store: MultiremiStore,
  runtimeId: string,
  input: CreateRuntimeUpdateInput,
): ReturnType<MultiremiStore["createRuntimeUpdateRequest"]> | { apiError: string; statusCode: 400 | 404 | 409 | 503 } {
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

function safeQuickCreateIssue(store: MultiremiStore, input: QuickCreateIssueInput): ReturnType<MultiremiStore["quickCreateIssue"]> | { error: string } {
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

function normalizeReactionInput(input: CreateMultiremiReactionInput): { actorType?: string; actorId?: string | null; emoji: string } {
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

function verifyJwtToken(token: string): { userId: string } | null {
  // No real secret configured (outside development) => reject every JWT rather
  // than validating against a publicly-known hardcoded default.
  const secret = jwtSecret();
  if (!secret) return null;
  const [encodedHeader, encodedClaims, signature, extra] = token.split(".");
  if (!encodedHeader || !encodedClaims || !signature || extra !== undefined) return null;
  const header = decodeBase64UrlJson(encodedHeader);
  const claims = decodeBase64UrlJson(encodedClaims);
  if (!isObjectRecord(header) || !isObjectRecord(claims)) return null;
  const digest = JWT_HMAC_ALGORITHMS[String(header.alg ?? "")];
  if (!digest) return null;
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const expected = base64UrlEncode(createHmac(digest, secret).update(signingInput).digest());
  if (!safeEqualText(signature, expected)) return null;
  const userId = cleanString(typeof claims.sub === "string" ? claims.sub : null);
  if (!userId || !jwtTimeClaimsAreValid(claims)) return null;
  return { userId };
}

// Returns the configured JWT signing secret, or null when none is set. The
// hardcoded dev default is only allowed in non-production dev/test environments;
// in production a missing JWT_SECRET means JWTs are rejected outright rather
// than validated against a publicly-known key.
function jwtSecret(): string | null {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") return DEFAULT_JWT_SECRET;
  return null;
}

function jwtTimeClaimsAreValid(claims: Record<string, unknown>, nowSeconds = Date.now() / 1000): boolean {
  const exp = numericDateClaim(claims.exp);
  if (exp !== null && nowSeconds >= exp) return false;
  const nbf = numericDateClaim(claims.nbf);
  if (nbf !== null && nowSeconds < nbf) return false;
  const iat = numericDateClaim(claims.iat);
  if (iat !== null && nowSeconds + 60 < iat) return false;
  return true;
}

function numericDateClaim(value: unknown): number | null {
  if (value == null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function decodeBase64UrlJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url");
}

function safeEqualText(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function webhookSignatureStatus(
  provider: MultiremiWebhookProvider,
  headers: Record<string, string>,
  rawBody: string,
  signingSecret?: string | null,
): MultiremiWebhookSignatureStatus {
  const secret = signingSecret === undefined ? process.env.MULTIREMI_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET ?? "" : signingSecret ?? "";
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

function publicWebhookDeliveryResponse(result: MultiremiWebhookDeliveryResult): {
  statusCode: 200 | 401 | 500;
  body: Record<string, unknown>;
} {
  const deliveryId = result.delivery.id;
  const runId = result.run?.id ?? result.delivery.autopilotRunId ?? null;
  if (result.duplicate) {
    const body: Record<string, unknown> = { status: "duplicate", delivery_id: deliveryId };
    if (runId) body.run_id = runId;
    return { statusCode: 200, body };
  }
  if (result.status === "rejected") {
    return {
      statusCode: 401,
      body: {
        status: "rejected",
        delivery_id: deliveryId,
        reason: result.delivery.error ?? "invalid_signature",
      },
    };
  }
  if (result.status === "ignored") {
    const responseBody = parseWebhookResponseBody(result.delivery.responseBody);
    const body: Record<string, unknown> = {
      status: "ignored",
      delivery_id: deliveryId,
      reason: result.delivery.error ?? responseBody.reason ?? "ignored",
    };
    if (responseBody.event) body.event = responseBody.event;
    return { statusCode: 200, body };
  }
  if (result.status === "skipped") {
    const body: Record<string, unknown> = {
      status: "skipped",
      delivery_id: deliveryId,
    };
    if (runId) body.run_id = runId;
    const reason = result.run?.failureReason ?? result.delivery.error;
    if (reason) body.reason = reason;
    return { statusCode: 200, body };
  }
  if (result.status === "failed") {
    return { statusCode: 500, body: { error: "failed to dispatch autopilot" } };
  }
  return {
    statusCode: 200,
    body: {
      status: "accepted",
      delivery_id: deliveryId,
      run_id: runId,
      autopilot_id: result.delivery.autopilotId,
      trigger_id: result.delivery.triggerId,
    },
  };
}

function parseWebhookResponseBody(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function webhookDeliveryResponse(result: MultiremiWebhookDeliveryResult) {
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
  return process.env.MULTIREMI_UPLOAD_DIR ?? join(homedir(), ".remi", "multiremi", "uploads");
}

function createUploadAttachmentId(): string {
  return `att_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function stringFormValue(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function attachmentCompatibilityResponse(attachment: MultiremiAttachment): Record<string, unknown> {
  const downloadUrl = `/api/attachments/${attachment.id}/download`;
  return {
    id: attachment.id,
    workspace_id: attachment.workspaceId,
    workspaceId: attachment.workspaceId,
    issue_id: attachment.issueId,
    issueId: attachment.issueId,
    comment_id: attachment.commentId,
    commentId: attachment.commentId,
    chat_session_id: attachment.chatSessionId,
    chatSessionId: attachment.chatSessionId,
    chat_message_id: attachment.chatMessageId,
    chatMessageId: attachment.chatMessageId,
    uploader_type: attachment.uploaderType,
    uploaderType: attachment.uploaderType,
    uploader_id: attachment.uploaderId,
    uploaderId: attachment.uploaderId,
    filename: attachment.filename,
    url: attachment.url,
    download_url: downloadUrl,
    downloadUrl,
    content_type: attachment.contentType,
    contentType: attachment.contentType,
    size_bytes: attachment.sizeBytes,
    sizeBytes: attachment.sizeBytes,
    created_at: attachment.createdAt,
    createdAt: attachment.createdAt,
  };
}

function chatAttachmentCompatibilityResponse(attachment: MultiremiAttachment): Record<string, unknown> {
  return {
    id: attachment.id,
    workspace_id: attachment.workspaceId,
    issue_id: attachment.issueId,
    comment_id: attachment.commentId,
    chat_session_id: attachment.chatSessionId,
    chat_message_id: attachment.chatMessageId,
    uploader_type: attachment.uploaderType,
    uploader_id: attachment.uploaderId,
    filename: attachment.filename,
    url: attachment.url,
    download_url: `/api/attachments/${attachment.id}/download`,
    content_type: attachment.contentType,
    size_bytes: attachment.sizeBytes,
    created_at: attachment.createdAt,
  };
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

async function localAttachmentFileResponse(attachment: MultiremiAttachment): Promise<Response> {
  const filePath = uploadedAttachmentPath(attachment);
  if (!filePath || !existsSync(filePath)) return Response.json({ error: "attachment file not found" }, { status: 404 });
  const info = await stat(filePath);
  const bytes = await readFile(filePath);
  return new Response(bytes, {
    headers: {
      "Content-Type": attachment.contentType || detectContentTypeFromFilename(attachment.filename),
      "Content-Length": String(info.size),
      "Content-Disposition": `attachment; filename="${attachment.filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
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

function skillSummary(skill: MultiremiSkill): Omit<MultiremiSkill, "content" | "files"> {
  const { content: _content, files: _files, ...summary } = skill;
  return summary;
}

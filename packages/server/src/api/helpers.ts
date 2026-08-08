// Shared helpers for the Multiremi HTTP API: request-scoped guards, input
// normalizers, WebSocket registries and the module-level constants used by
// api/server.ts and api/routers/*.ts. Extracted verbatim from api.ts by the
// D3 split so the skeleton and its routers import one copy (no import cycle).
import { type Context } from "hono";
import { setCookie } from "hono/cookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createLogger } from "@shared/logger.js";
import { getAgentTemplate } from "./agent-templates.js";
import { daemonRuntimeId, MultiremiStore } from "@multiremi/store/store.js";
import {
  MULTIREMI_DAEMON_PROVIDERS,
  agentBroadcastCompatibilityResponse,
  authenticatedRequestUserId,
  cleanString,
  currentAccessToken,
  currentAuth,
  currentRequestUserId,
  currentTaskAccessToken,
  currentWorkspaceMember,
  currentWorkspaceRoleStrict,
  daemonRuntimeResponse,
  hasRequestField,
  isObjectRecord,
  issueCompatibilityResponse,
  parseOptionalInt,
  projectCompatibilityResponse,
  projectDocCompatibilityResponse,
  projectResourceCompatibilityResponse,
  requestedSkillWorkspaceId,
  runtimeCompatibilityResponse,
  runtimeWorkspaceId,
  skillSummaryCompatibilityResponse,
  workspaceReposResponse,
} from "./wire/index.js";
import type { CompatibilityQueryMode, MultiremiRequestAuth, WorkspaceRepoData } from "./wire/index.js";
import type {
  CreateAccessTokenInput,
  CreateAgentInput,
  CreateAgentFromTemplateInput,
  CreateChatSessionInput,
  CreateFeedbackInput,
  CreateRuntimeUpdateInput,
  CreateIssueCommentInput,
  CreateIssueWithTaskInput,
  CreateProjectDocInput,
  CreateSkillInput,
  ImportSkillInput,
  ListIssueCommentsInput,
  ListIssuesInput,
  QuickCreateIssueInput,
  ReportRuntimeLocalSkillImportInput,
  ReportRuntimeLocalSkillListInput,
  RunAutopilotInput,
  SendChatMessageInput,
  CreateMultiremiReactionInput,
  MultiremiAccessToken,
  MultiremiAgent,
  MultiremiAttachment,
  MultiremiGitHubPullRequest,
  MultiremiChatSession,
  MultiremiIssue,
  MultiremiIssueComment,
  MultiremiProject,
  MultiremiProjectDoc,
  MultiremiProjectResource,
  MultiremiTask,
  TaskMessageInput,
  MultiremiTaskStatus,
  TaskUsageEntry,
  MultiremiRuntime,
  MultiremiSkill,
  MultiremiSubscriptionReason,
  MultiremiGitHubPullRequestState,
  MultiremiWorkspaceMember,
  MultiremiWebhookProvider,
  MultiremiWebhookSignatureStatus,
  UpdateAgentInput,
  UpdateIssueInput,
  UpdateProjectDocInput,
  UpdateSkillInput,
  UpdateWorkspaceMemberInput,
} from "@multiremi/contracts/types.js";

// Resolve the request identity into a single typed object. Mirrors the historical
// currentJwtUserId (cleanString) / currentRequestUserId / authenticatedRequestUserId logic.
export function buildRequestAuth(accessToken: MultiremiAccessToken | null, jwtUserId: string | null): MultiremiRequestAuth {
  const cleanJwt = cleanString(jwtUserId);
  const userId = accessToken?.userId ?? cleanJwt ?? null;
  return { accessToken, jwtUserId: cleanJwt, userId, requestUserId: userId ?? "local" };
}

export const log = createLogger("multiremi-api");
export const SUBSCRIPTION_REASONS: MultiremiSubscriptionReason[] = ["created", "assigned", "commented", "mentioned", "manual"];
export const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;
export const LOCAL_AUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_JWT_SECRET = "multiremi-dev-secret-change-in-production";
export const MULTIREMI_RELEASE_REPO = process.env.MULTIREMI_RELEASE_REPO ?? "Grassgod/remi";
export const MULTIREMI_INSTALL_SCRIPT = "install-remi.sh";

// Self-host release mirror. Intranet machines that can't reach GitHub's asset
// CDN install via MULTIREMI_BASE_URL=<this server>; install-remi.sh then pulls
// the version + tarball from /api/remi/releases/* below. Tarballs come from
// MULTIREMI_RELEASE_DIR (default <repo>/dist), scripts from <repo>/scripts.
export const MULTIREMI_REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
export const MULTIREMI_RELEASE_TARBALL_RE = /^(?:multiremi|remi)-(\d+\.\d+\.\d+)-(?:linux|darwin)-(?:x64|arm64)\.tar\.gz$/;
export function multiremiReleaseDir(): string {
  return process.env.MULTIREMI_RELEASE_DIR ?? join(MULTIREMI_REPO_ROOT, "dist");
}
export function multiremiScriptsDir(): string {
  return process.env.MULTIREMI_SCRIPTS_DIR ?? join(MULTIREMI_REPO_ROOT, "scripts");
}
export function compareMultiremiVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}
export function latestMirrorReleaseVersion(): string | null {
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
export function resolveMirrorReleaseFile(filename: string | undefined): string | null {
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
export const MAX_AGENT_DESCRIPTION_LENGTH = 255;
export const PROVIDER_THINKING_LEVELS: Record<string, Set<string>> = {
  claude: new Set(["low", "medium", "high", "xhigh", "max"]),
  codex: new Set(["none", "minimal", "low", "medium", "high", "xhigh"]),
};
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
export const DEFAULT_WEBHOOK_RATE_LIMIT: WebhookRateLimitConfig = { limit: 60, windowMs: 60 * 1000 };
export const DEFAULT_WEBHOOK_IP_RATE_LIMIT: WebhookRateLimitConfig = { limit: 30, windowMs: 60 * 1000 };
export const localAuthCodes = new Map<string, { code: string; expiresAt: number }>();

// Email verification-code + Google fallback logins let anyone in with just an
// email; production keeps only Feishu SSO. Off unless explicitly enabled (FR9).
export function isEmailCodeLoginEnabled(): boolean {
  const value = (process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
export const JWT_HMAC_ALGORITHMS: Record<string, string> = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
};

export type NormalizedGitHubPullRequestBody = {
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

export type DaemonRegisterRequestBody = {
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

export class MultiremiApiError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 429) {
    super(message);
  }
}

export interface WebhookRateLimitConfig {
  limit: number;
  windowMs: number;
}

export interface MultiremiRealtimeState {
  enabled: boolean;
  connections: number;
}

export type DaemonWebSocketData = {
  kind: "daemon";
  connectedAt: string;
  runtimeId: string | null;
  runtimeIds: string[];
  accessToken: MultiremiAccessToken | null;
}

export type BrowserWebSocketData = {
  kind: "browser";
  connectedAt: string;
  workspaceId: string;
  authenticated: boolean;
  userId: string | null;
  accessToken: MultiremiAccessToken | null;
  scopeSubscriptions: string[];
}

export type MultiremiWebSocketData = DaemonWebSocketData | BrowserWebSocketData;

export type MultiremiWebSocketClient = {
  data: MultiremiWebSocketData;
  sendText(message: string): void;
  close(code?: number, reason?: string): void;
}

export type DaemonWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;
export type BrowserWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;
export type BrowserUserWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;
export type BrowserScopeWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;

export function buildDaemonInstallInstructions(input: {
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

export function normalizeMultiremiRuntimeProvider(value: unknown): string {
  return String(value ?? "").trim() || "unknown";
}

export function validateMultiremiRuntimeProvider(value: unknown): { provider: string } | { error: string; status: 400 } {
  const provider = normalizeMultiremiRuntimeProvider(value);
  if (MULTIREMI_DAEMON_PROVIDERS.has(provider)) return { provider };
  return { error: `Unsupported Multiremi runtime provider: ${provider}`, status: 400 };
}

export function requestOrigin(requestUrl: string): string {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return "http://127.0.0.1:6120";
  }
}

export function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function isDaemonTokenAllowedRequest(request: Request): boolean {
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

export function isTaskTokenForbiddenRequest(request: Request): boolean {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (path === "/api/daemon/ws" || path.startsWith("/api/daemon/")) return true;
  if (path === "/api/multiremi/runtimes" && method === "POST") return true;
  if (/^\/api\/multiremi\/runtimes\/[^/]+\/heartbeat$/.test(path) && method === "POST") return true;
  return false;
}

export function isTaskTokenCreateInput(input: Pick<CreateAccessTokenInput, "type">): boolean {
  return String(input.type ?? "pat").trim().toLowerCase() === "task";
}

export function denyTaskTokenSessionAccess(
  c: Context,
  store: MultiremiStore,
  issueId: string,
  requestedSessionId: string | null,
): Response | null {
  const token = currentTaskAccessToken(c);
  if (!token?.taskId) return null;
  const task = store.getTask(token.taskId);
  if (!task || task.issueId !== issueId) return c.json({ error: "forbidden" }, 403);
  // Legacy tasks predate product Sessions and retain their issue-wide access.
  if (!task.issueSessionId) return null;
  if (requestedSessionId !== task.issueSessionId) return c.json({ error: "forbidden" }, 403);
  return null;
}

/**
 * A task token is scoped to the one project its issue belongs to. Project
 * knowledge (wiki + memory) of any other project — including one in a workspace
 * the token's agent can otherwise reach — is not its to read or write. A task
 * with no issue, or an issue with no project, has no project scope at all.
 */
export function denyTaskTokenProjectAccess(
  c: Context,
  store: MultiremiStore,
  projectId: string,
): Response | null {
  const token = currentTaskAccessToken(c);
  if (!token?.taskId) return null;
  const task = store.getTask(token.taskId);
  const issue = task?.issueId ? store.getIssue(task.issueId) : null;
  if (!issue?.projectId || issue.projectId !== projectId) return c.json({ error: "project not found" }, 404);
  return null;
}

export function denyTaskTokenCommentAccess(
  c: Context,
  store: MultiremiStore,
  commentId: string,
): Response | null {
  const token = currentTaskAccessToken(c);
  if (!token?.taskId) return null;
  const task = store.getTask(token.taskId);
  const comment = store.getIssueComment(commentId);
  if (
    !task
    || !comment
    || task.issueId !== comment.issueId
    || (task.issueSessionId && task.issueSessionId !== comment.issueSessionId)
  ) {
    return c.json({ error: "forbidden" }, 403);
  }
  return null;
}

export function denyTaskTokenTaskAccess(
  c: Context,
  requestedTask: MultiremiTask,
): Response | null {
  const token = currentTaskAccessToken(c);
  if (!token?.taskId) return null;
  // Task execution messages contain raw provider/tool transcripts. They are
  // private to the running task and are deliberately not part of the shared
  // product Session event log.
  if (token.taskId !== requestedTask.id) return c.json({ error: "forbidden" }, 403);
  return null;
}

export function taskScopedIssueTasks(
  c: Context,
  store: MultiremiStore,
  issueId: string,
  tasks: MultiremiTask[],
): MultiremiTask[] {
  const issueSessionId = taskTokenProductSessionId(c, store, issueId);
  if (!issueSessionId) return tasks;
  return tasks.filter((task) => task.issueSessionId === issueSessionId);
}

export function taskScopedIssueComments(
  c: Context,
  store: MultiremiStore,
  issueId: string,
  comments: MultiremiIssueComment[],
): MultiremiIssueComment[] {
  const issueSessionId = taskTokenProductSessionId(c, store, issueId);
  if (!issueSessionId) return comments;
  return comments.filter((comment) => comment.issueSessionId === issueSessionId);
}

export function taskTokenProductSessionId(
  c: Context,
  store: MultiremiStore,
  issueId: string,
): string | null {
  const token = currentTaskAccessToken(c);
  if (!token?.taskId) return null;
  const currentTask = store.getTask(token.taskId);
  if (!currentTask || currentTask.issueId !== issueId) return null;
  return currentTask.issueSessionId;
}

export function currentJwtUserId(c: Context): string | null {
  return currentAuth(c).jwtUserId;
}

export function compatibilityWorkspaceId(c: Context): string {
  return cleanString(c.req.header("X-Workspace-ID")) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
}

// The web client tags every request with the slug of the workspace the user is
// viewing (client.ts authHeaders). Null when absent or not a known workspace.
export function workspaceIdFromSlugHeader(c: Context, store: MultiremiStore): string | null {
  const slug = cleanString(c.req.header("X-Workspace-Slug"));
  if (!slug) return null;
  return store.listWorkspaces().find((workspace) => workspace.slug === slug)?.id ?? null;
}

export function compatibilityUserId(c: Context): string {
  return authenticatedRequestUserId(c) ??
    cleanString(c.req.query("user_id")) ??
    "local";
}

export function compatibilityInboxMemberId(c: Context): string {
  return authenticatedRequestUserId(c) ??
    cleanString(c.req.query("member_id")) ??
    "local";
}

export function requestedAgentWorkspaceId(c: Context, input?: Pick<CreateAgentInput, "workspaceId" | "workspace_id">): string {
  return cleanString(input?.workspaceId) ??
    cleanString(input?.workspace_id) ??
    cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
}

export function requestedRuntimeWorkspaceId(c: Context): string {
  return cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
}

export function runtimeOwnerId(runtime: MultiremiRuntime): string {
  return runtime.ownerId ?? "local";
}

export function listRuntimesForCurrentUser(c: Context, store: MultiremiStore): { runtimes: MultiremiRuntime[] } | Response {
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

export function loadRuntimeForCurrentUser(c: Context, store: MultiremiStore, runtimeId: string): { runtime: MultiremiRuntime } | Response {
  const runtime = store.getRuntime(runtimeId);
  if (!runtime) return c.json({ error: "runtime not found" }, 404);
  const denied = denyCurrentUserRuntimeWorkspaceAccess(c, store, runtime);
  if (denied) return denied;
  return { runtime };
}

export function loadRuntimeForCurrentEditor(
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

export function loadRuntimeForCurrentOwner(c: Context, store: MultiremiStore, runtimeId: string, feature = "local skills"): { runtime: MultiremiRuntime } | Response {
  const loaded = loadRuntimeForCurrentUser(c, store, runtimeId);
  if (loaded instanceof Response) return loaded;
  if (runtimeOwnerId(loaded.runtime) !== currentRequestUserId(c)) {
    return c.json({ error: `you can only access ${feature} from your own runtimes` }, 403);
  }
  return loaded;
}

export function canCurrentUserEditRuntime(c: Context, store: MultiremiStore, runtime: MultiremiRuntime): boolean {
  const role = currentWorkspaceRole(c, store, runtimeWorkspaceId(runtime));
  if (role === "owner" || role === "admin") return true;
  return runtimeOwnerId(runtime) === currentRequestUserId(c);
}

export function queryInt(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function boundedQueryInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = queryInt(value, fallback);
  if (parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function issueSubscriberCaller(c: Context): { actorType: "member" | "agent"; actorId: string } {
  const taskToken = currentTaskAccessToken(c);
  if (taskToken?.agentId) return { actorType: "agent", actorId: taskToken.agentId };
  const agentId = cleanString(c.req.header("X-Agent-ID"));
  if (agentId) return { actorType: "agent", actorId: agentId };
  return { actorType: "member", actorId: currentRequestUserId(c) };
}

export function issueCommentCreateInput(
  c: Context,
  input: CreateIssueCommentInput,
  store?: MultiremiStore,
): CreateIssueCommentInput {
  const taskToken = currentTaskAccessToken(c);
  if (taskToken?.agentId) {
    const task = taskToken.taskId && store ? store.getTask(taskToken.taskId) : null;
    return {
      ...input,
      authorType: "agent",
      authorId: taskToken.agentId,
      issueSessionId: task?.issueSessionId ?? input.issueSessionId ?? input.issue_session_id ?? null,
    };
  }
  if (cleanString(input.authorType) || cleanString(input.authorId)) return input;
  const agentId = cleanString(c.req.header("X-Agent-ID"));
  if (agentId) return { ...input, authorType: "agent", authorId: agentId };
  if (!currentAccessToken(c) && !currentJwtUserId(c)) return input;
  return { ...input, authorType: "member", authorId: currentRequestUserId(c) };
}

export function taskScopedIssueCommentListInput(
  c: Context,
  store: MultiremiStore,
  issueId: string,
  input: ListIssueCommentsInput,
): { input: ListIssueCommentsInput } | { response: Response } {
  const token = currentTaskAccessToken(c);
  if (!token?.taskId) return { input };
  const task = store.getTask(token.taskId);
  if (!task || task.issueId !== issueId) {
    return { response: c.json({ error: "forbidden" }, 403) };
  }
  if (!task.issueSessionId) return { input };
  const requested = cleanString(input.issueSessionId ?? input.issue_session_id);
  if (requested && requested !== task.issueSessionId) {
    return { response: c.json({ error: "forbidden" }, 403) };
  }
  return {
    input: {
      ...input,
      issueSessionId: task.issueSessionId,
      issue_session_id: task.issueSessionId,
    },
  };
}

export function issueSubscriberTarget(
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

export function withIssueCreateRequestContext(c: Context, input: CreateIssueWithTaskInput): CreateIssueWithTaskInput {
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

export function publishIssueCreated(
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
export function maybeDispatchOnIssueUpdate(
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

export function publishIssueUpdated(
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

export function publishProjectCreated(
  c: Context,
  store: MultiremiStore,
  project: MultiremiProject,
  response: Record<string, unknown> = projectCompatibilityResponse(project),
): void {
  publishWorkspaceEvent(c, store, "project:created", project.workspaceId, { project: response });
}

export function publishProjectUpdated(
  c: Context,
  store: MultiremiStore,
  project: MultiremiProject,
  response: Record<string, unknown> = projectCompatibilityResponse(project),
): void {
  publishWorkspaceEvent(c, store, "project:updated", project.workspaceId, { project: response });
}

export function publishProjectDeleted(c: Context, store: MultiremiStore, project: MultiremiProject): void {
  publishWorkspaceEvent(c, store, "project:deleted", project.workspaceId, { project_id: project.id });
}

export function loadProjectResourceForMutation(
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

export function publishProjectResourceCreated(
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

export function publishProjectResourceUpdated(
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

export function publishProjectResourceDeleted(
  c: Context,
  store: MultiremiStore,
  resource: MultiremiProjectResource,
): void {
  publishWorkspaceEvent(c, store, "project_resource:deleted", resource.workspaceId, {
    project_id: resource.projectId,
    resource_id: resource.id,
  });
}

export function loadProjectForDocs(c: Context, store: MultiremiStore, projectId: string): MultiremiProject | Response {
  const project = store.getProject(projectId);
  if (!project) return c.json({ error: "project not found" }, 404);
  const denied = denyCurrentUserWorkspaceAccess(c, store, project.workspaceId);
  if (denied) return denied;
  const taskDenied = denyTaskTokenProjectAccess(c, store, project.id);
  if (taskDenied) return taskDenied;
  return project;
}

/**
 * Stamps a doc write with who made it: a task token writes as its agent,
 * everyone else as the requesting member. Provenance is never taken from the
 * body — the task id comes from the caller's own task token and the issue
 * behind it is resolved server-side, so a caller can neither claim someone
 * else's task nor smuggle a foreign issue id onto the doc. A member has no
 * task, so member writes carry no provenance at all. `id` is dropped for the
 * same reason: the primary key is the server's to mint. Both spellings are
 * written because the store falls back camel → snake.
 */
export function projectDocCreateInput(c: Context, store: MultiremiStore, input: CreateProjectDocInput): CreateProjectDocInput {
  const caller = issueSubscriberCaller(c);
  const sourceTaskId = currentTaskAccessToken(c)?.taskId ?? null;
  const task = sourceTaskId ? store.getTask(sourceTaskId) : null;
  const sourceIssueId = task?.issueId ?? null;
  return {
    ...input,
    id: undefined,
    authorType: caller.actorType,
    author_type: caller.actorType,
    authorId: caller.actorId,
    author_id: caller.actorId,
    sourceTaskId,
    source_task_id: sourceTaskId,
    sourceIssueId,
    source_issue_id: sourceIssueId,
  };
}

export function projectDocUpdateInput(c: Context, input: UpdateProjectDocInput): UpdateProjectDocInput {
  const caller = issueSubscriberCaller(c);
  return {
    ...input,
    updatedByType: caller.actorType,
    updated_by_type: caller.actorType,
    updatedById: caller.actorId,
    updated_by_id: caller.actorId,
  };
}

export function publishProjectDocCreated(
  c: Context,
  store: MultiremiStore,
  doc: MultiremiProjectDoc,
  response: Record<string, unknown> = projectDocCompatibilityResponse(doc),
): void {
  publishWorkspaceEvent(c, store, "project_doc:created", doc.workspaceId, {
    doc: response,
    project_id: doc.projectId,
  });
}

export function publishProjectDocUpdated(
  c: Context,
  store: MultiremiStore,
  doc: MultiremiProjectDoc,
  response: Record<string, unknown> = projectDocCompatibilityResponse(doc),
): void {
  publishWorkspaceEvent(c, store, "project_doc:updated", doc.workspaceId, {
    doc: response,
    project_id: doc.projectId,
  });
}

export function publishProjectDocDeleted(c: Context, store: MultiremiStore, doc: MultiremiProjectDoc): void {
  publishWorkspaceEvent(c, store, "project_doc:deleted", doc.workspaceId, {
    project_id: doc.projectId,
    doc_id: doc.id,
  });
}

/**
 * Prefer server-discovered gateway models per engine when a snapshot exists (so the
 * dropdown reflects the real gateway even with zero online runtimes); otherwise keep
 * the per-runtime union. online_runtime_count still comes from the runtime buckets.
 */
export function overlayGatewayModels(
  store: MultiremiStore,
  workspaceId: string,
  providers: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  // Discovery off → never surface a (possibly stale) gateway snapshot; fall back
  // to the per-runtime union so turning the toggle off actually hides the models.
  if (!store.getRelayModelDiscovery(workspaceId)) return providers;
  const config = store.getRelayConfigForDaemon(workspaceId);
  const byEngine = new Map<string, Record<string, unknown>>();
  for (const provider of providers) byEngine.set(String(provider.provider), provider);
  for (const engine of ["claude", "codex"] as const) {
    const engineConfig = config[engine];
    // No live gateway credential → don't surface any (possibly stale) snapshot.
    if (!engineConfig || !engineConfig.authToken) continue;
    const snapshot = store.getGatewayModels(workspaceId, engine);
    if (!snapshot || snapshot.models.length === 0) continue;
    // Only show a snapshot discovered for the CURRENT config revision — a changed
    // gateway/token invalidates the old catalog until rediscovery catches up.
    if (snapshot.sourceRevision !== engineConfig.revision) continue;
    const models = snapshot.models.map((model) => ({ id: model.id, label: model.label, provider: engine }));
    const existing = byEngine.get(engine);
    if (existing) existing.models = models;
    else byEngine.set(engine, { provider: engine, online_runtime_count: 0, models });
  }
  return [...byEngine.values()].sort((a, b) => String(a.provider).localeCompare(String(b.provider)));
}

export function skillWorkspaceId(skill: MultiremiSkill): string {
  return skill.workspaceId ?? "local";
}

export function withSkillCreateRequestContext(
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

export function withSkillImportRequestContext(
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

export function withSkillUpdateRequestContext(current: MultiremiSkill, input: UpdateSkillInput): UpdateSkillInput {
  const workspaceId = skillWorkspaceId(current);
  return {
    ...input,
    workspaceId,
    workspace_id: workspaceId,
    createdBy: current.createdBy ?? null,
    created_by: current.createdBy ?? null,
  };
}

export function loadSkillForCurrentUser(
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

export function loadSkillForCurrentManager(
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

export function loadAgentForCurrentManager(
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

export function loadAgentEnvForCurrentAdmin(
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

export function publishAgentSkillsEvent(
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

export function publishAgentLifecycleEvent(
  c: Context,
  store: MultiremiStore,
  type: "agent:created" | "agent:status" | "agent:archived" | "agent:restored",
  agent: MultiremiAgent,
): void {
  publishWorkspaceEvent(c, store, type, agent.workspaceId, {
    agent: agentBroadcastCompatibilityResponse(store, agent),
  });
}

export function recordAgentCreatedAnalytics(
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

export function recordSystemAgentCreatedAnalytics(
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

export function runtimeForAgentInput(
  store: MultiremiStore,
  input: { runtimeId?: string | null; runtime_id?: string | null },
): MultiremiRuntime | null {
  const runtimeId = cleanString(input.runtimeId ?? input.runtime_id);
  return runtimeId ? store.getRuntime(runtimeId) : null;
}

export function agentAnalyticsProvider(agent: MultiremiAgent, runtime: MultiremiRuntime | null): string {
  if (runtime?.provider && runtime.provider !== "any") return runtime.provider;
  return agent.provider;
}

export function isFirstAgentInWorkspace(store: MultiremiStore, workspaceId: string): boolean {
  return store.listAgents().every((agent) => agent.workspaceId !== workspaceId);
}

export function parseExpectedActiveAgentIds(c: Context, value: unknown): string[] | Response {
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

export function denyCurrentUserRuntimeWorkspaceAccess(c: Context, store: MultiremiStore, runtime: MultiremiRuntime): Response | null {
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

export function withAgentRequestContext(c: Context, store: MultiremiStore, input: CreateAgentInput): CreateAgentInput | Response {
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

export function withAgentUpdateRequestContext(
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
        // On an "any" runtime the request's provider falls through; default it
        // to the agent's CURRENT provider (not "claude") so a legacy move to an
        // any-runtime doesn't silently flip a Codex agent to Claude.
        provider: input.provider ?? current.provider,
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

export function withAgentTemplateRequestContext(
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
export function resolveAgentRequestProvider(
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

export function canCurrentUserUseRuntime(c: Context, store: MultiremiStore, runtime: MultiremiRuntime): boolean {
  const workspaceId = runtime.workspaceId ?? "local";
  const role = currentWorkspaceRole(c, store, workspaceId);
  if (role === "owner" || role === "admin") return true;
  if (runtime.visibility === "public") return true;
  return runtime.ownerId === currentRequestUserId(c);
}

export function agentProviderForRuntime(provider: unknown, runtime: MultiremiRuntime): CreateAgentInput["provider"] {
  if (runtime.provider && runtime.provider !== "any") return runtime.provider;
  return cleanString(typeof provider === "string" ? provider : null) ?? "claude";
}

export function normalizeAgentRequestDescription(c: Context, value: unknown): string | Response {
  const description = String(value ?? "");
  if (Array.from(description).length > MAX_AGENT_DESCRIPTION_LENGTH) {
    return c.json({ error: `description must be ${MAX_AGENT_DESCRIPTION_LENGTH} characters or fewer` }, 400);
  }
  return description;
}

export function agentRequestThinkingLevel(input: CreateAgentInput | UpdateAgentInput): string {
  return String(input.thinkingLevel ?? input.thinking_level ?? "");
}

export function isKnownThinkingValue(provider: string, value: string): boolean {
  if (!value) return true;
  return PROVIDER_THINKING_LEVELS[provider]?.has(value) ?? false;
}

export function agentThinkingLevelError(c: Context, value: string, provider: string): Response {
  return c.json({ error: `thinking_level "${value}" is not a recognised value for runtime "${provider}"` }, 400);
}

export function normalizeAgentRequestMaxConcurrentTasks(c: Context, value: unknown): number | Response {
  const concurrency = Number(value ?? 0);
  if (!concurrency) return 6;
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    return c.json({ error: "max_concurrent_tasks must be at least 1" }, 400);
  }
  return Math.trunc(concurrency);
}

export function agentNameConflict(c: Context, name: string): Response {
  return c.json({ error: `an agent named "${name}" already exists in this workspace` }, 409);
}

export function loadAgentForCurrentUser(
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

export function canCurrentUserAccessAgent(c: Context, store: MultiremiStore, agent: MultiremiAgent): boolean {
  if (agent.visibility !== "private") return true;
  const userId = currentRequestUserId(c);
  if (agent.ownerId === userId) return true;
  const role = currentWorkspaceRole(c, store, agent.workspaceId);
  return role === "owner" || role === "admin";
}

// Store-only twin of canCurrentUserAccessAgent — no request Context, so it can
// gate WS recipients (client.data.userId) as well as HTTP callers.
export function canUserAccessAgentByUserId(store: MultiremiStore, userId: string | null, agent: MultiremiAgent): boolean {
  if (agent.visibility !== "private") return true;
  if (userId && agent.ownerId === userId) return true;
  // No verified identity (master token / open mode) acts as admin.
  if (userId == null) return true;
  const role = store.getUserRoleInWorkspace(userId, agent.workspaceId);
  return role === "owner" || role === "admin";
}

// Whether a user may read a task's transcript messages. Transcript rows carry
// raw tool input/diffs/output, so they inherit the task's visibility: chat
// tasks are creator-only, and a private agent's task is owner/admin-only.
// Workspace membership itself is enforced by the caller (registry keying /
// route guard). userId null = no-identity admin path.
export function canUserViewTaskMessages(store: MultiremiStore, userId: string | null, task: MultiremiTask): boolean {
  if (task.chatSessionId) {
    const session = store.getChatSession(task.chatSessionId);
    if (!session) return false;
    if (userId == null) return true;
    return session.creatorId === userId;
  }
  const agent = task.agentId ? store.getAgent(task.agentId) : null;
  if (!agent) return true;
  return canUserAccessAgentByUserId(store, userId, agent);
}

export function currentWorkspaceRole(c: Context, store: MultiremiStore, workspaceId: string): string {
  const member = currentWorkspaceMember(c, store, workspaceId);
  if (member) return member.role;
  // No real member: only the no-identity admin path (master token / open mode)
  // is treated as local owner. A logged-in non-member is NOT auto-"member".
  if (workspaceId === "local" && authenticatedRequestUserId(c) === null) return "owner";
  return "member";
}

/**
 * A caller may receive the PLAINTEXT relay token on the daemon register/repos
 * response only if their token maps to a workspace owner/admin. This covers both
 * daemon tokens and the owner/admin PAT that real agents authenticate with, while
 * still withholding the secret from a non-admin member's token.
 */
export function callerCanReceiveRelay(c: Context, store: MultiremiStore, workspaceId: string): boolean {
  const role = currentWorkspaceRoleStrict(c, store, workspaceId);
  return role === "owner" || role === "admin";
}

/** owner/admin human actor gate for workspace-scoped config (relay config). */
export function requireWorkspaceAdmin(c: Context, store: MultiremiStore, workspaceId: string): Response | null {
  if (currentTaskAccessToken(c)) return c.json({ error: "this endpoint is only available to human actors" }, 403);
  if (currentAccessToken(c)?.type === "daemon") return c.json({ error: "forbidden for daemon token" }, 403);
  const role = currentWorkspaceRoleStrict(c, store, workspaceId);
  if (role === "owner" || role === "admin") return null;
  return c.json({ error: "insufficient permissions" }, 403);
}

export function loadCurrentWorkspaceMember(
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

export function loadCurrentWorkspaceRole(
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

export function withChatSessionCreator(
  c: Context,
  input: CreateChatSessionInput,
): CreateChatSessionInput {
  const creatorId = currentRequestUserId(c);
  return { ...input, creatorId, creator_id: creatorId };
}

export function requestedChatWorkspaceId(c: Context, input?: Pick<CreateChatSessionInput, "workspaceId" | "workspace_id">): string {
  return cleanString(input?.workspaceId) ??
    cleanString(input?.workspace_id) ??
    cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id")) ??
    "local";
}

export function denyCurrentUserWorkspaceAccess(c: Context, store: MultiremiStore, workspaceId: string): Response | null {
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
export function denyPinOwnerAccess(c: Context, userId: string): Response | null {
  const authUser = authenticatedRequestUserId(c);
  if (authUser && userId !== authUser) return c.json({ error: "forbidden" }, 403);
  return null;
}

export function withChatSessionRequestContext(c: Context, store: MultiremiStore, input: CreateChatSessionInput): CreateChatSessionInput | Response {
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

export function loadChatSessionForCurrentUser(
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

export function canCurrentUserAccessChatSessionAgent(
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
export function denyAttachmentAccess(c: Context, store: MultiremiStore, attachment: MultiremiAttachment): Response | null {
  if (attachment.chatSessionId) {
    const loaded = loadChatSessionForCurrentUser(c, store, attachment.chatSessionId, { requireAgentAccess: false });
    return loaded instanceof Response ? loaded : null;
  }
  if (attachment.commentId) {
    const denied = denyTaskTokenCommentAccess(c, store, attachment.commentId);
    if (denied) return denied;
  }
  return denyCurrentUserWorkspaceAccess(c, store, attachment.workspaceId);
}

export function normalizeSendChatMessageInput(c: Context, input: SendChatMessageInput): SendChatMessageInput | Response {
  const body = cleanString(input.body ?? input.content);
  if (!body) return c.json({ error: "content is required" }, 400);
  const rawAttachmentIds = input.attachmentIds ?? input.attachment_ids;
  if (rawAttachmentIds != null && !Array.isArray(rawAttachmentIds)) {
    return c.json({ error: "invalid attachment_ids" }, 400);
  }
  const attachmentIds = rawAttachmentIds ? uniqueStrings(rawAttachmentIds) : [];
  return { ...input, body, attachmentIds, attachment_ids: attachmentIds };
}

export function hasJwtWorkspaceAccess(store: MultiremiStore, userId: string, workspaceId: string): boolean {
  return store.getUserRoleInWorkspace(userId, workspaceId) !== null;
}

export type DaemonWorkspaceDenyOptions = {
  hideForbiddenAsNotFound?: boolean;
};

export function isDaemonGcCheckRequest(c: Context): boolean {
  return new URL(c.req.url).pathname.endsWith("/gc-check");
}

export function denyDaemonTokenWorkspace(c: Context, workspaceId?: string | null, options: DaemonWorkspaceDenyOptions = {}): Response | null {
  const token = currentAccessToken(c);
  if (token?.type !== "daemon") return null;
  const targetWorkspaceId = cleanString(workspaceId) ?? "local";
  if (token.workspaceId === targetWorkspaceId) return null;
  if (options.hideForbiddenAsNotFound) return c.json({ error: "not found" }, 404);
  return c.json({ error: "forbidden for daemon token workspace" }, 403);
}

export function denyDaemonTokenRuntimeWorkspace(
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

export function normalizeRuntimeIds(value: unknown): { runtimeIds: string[] } | { error: string; status: 400 } {
  if (!Array.isArray(value)) return { error: "runtime_ids is required", status: 400 };
  const runtimeIds = uniqueStrings(value);
  if (!runtimeIds.length) return { error: "runtime_ids is required", status: 400 };
  return { runtimeIds };
}

export function deregisterDaemonRuntimes(c: Context, store: MultiremiStore, runtimeIds: string[]): void {
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

export function denyDaemonTokenTaskWorkspace(
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

export function denyDaemonTokenIssueWorkspace(
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

export function denyDaemonTokenChatSessionWorkspace(
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

export function denyDaemonTokenAutopilotRunWorkspace(
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

export async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return await c.req.json() as T;
  } catch {
    return {} as T;
  }
}

export async function readJsonStrict<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T | { apiError: string; statusCode: 400 }> {
  try {
    return await c.req.json() as T;
  } catch {
    return { apiError: "invalid request body", statusCode: 400 };
  }
}

export function isJsonApiError(value: unknown): value is { apiError: string; statusCode: 400 } {
  return typeof value === "object" && value !== null && "apiError" in value && "statusCode" in value;
}

export async function readJsonStrictAllowEmpty<T>(c: {
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

export async function readPublicWebhookBody(c: {
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

export function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

export function createWebhookRateLimiter(
  override: Partial<WebhookRateLimitConfig> | false | undefined,
  defaults: WebhookRateLimitConfig,
): MemoryWebhookRateLimiter {
  const config = override === false ? { limit: 0, windowMs: defaults.windowMs } : { ...defaults, ...(override ?? {}) };
  return new MemoryWebhookRateLimiter(config);
}

export class MemoryWebhookRateLimiter {
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

export function webhookClientIpKey(request: Request): string {
  const remote = requestRemoteAddress(request);
  return remoteAddrHost(remote) || "unknown";
}

export function requestRemoteAddress(request: Request): string {
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

export function remoteAddrHost(remote: string): string {
  if (!remote) return "";
  if (remote.startsWith("[")) {
    const end = remote.indexOf("]");
    if (end > 0) return remote.slice(1, end);
  }
  const lastColon = remote.lastIndexOf(":");
  if (lastColon >= 0 && !remote.includes("]") && remote.split(":").length === 2) return remote.slice(0, lastColon);
  return remote;
}

export function isTerminalRuntimeRequestForDaemon(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timeout";
}

export function isValidRuntimeUpdateReportStatus(status: unknown): status is "completed" | "failed" | "running" {
  return status === "completed" || status === "failed" || status === "running";
}

export function daemonLocalSkillListReportBody(input: ReportRuntimeLocalSkillListInput): ReportRuntimeLocalSkillListInput {
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

export function daemonLocalSkillImportReportBody(input: ReportRuntimeLocalSkillImportInput): ReportRuntimeLocalSkillImportInput {
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

export function normalizeSubscriptionReason(value: unknown): MultiremiSubscriptionReason {
  const reason = String(value ?? "manual") as MultiremiSubscriptionReason;
  return SUBSCRIPTION_REASONS.includes(reason) ? reason : "manual";
}

export function parseOptionalTaskMessageSince(value: string | undefined): number | undefined | { error: string } {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return { error: "invalid since parameter" };
  return parsed;
}

export function daemonTaskUsageEntries(raw: unknown): TaskUsageEntry[] {
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

export function normalizeDaemonUsageNumber(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

export function mergeAgentEnv(current: Record<string, string>, input: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(input)) {
    const cleanKey = key.trim();
    if (!cleanKey) continue;
    const value = String(rawValue ?? "");
    next[cleanKey] = value === "****" && current[cleanKey] !== undefined ? current[cleanKey] : value;
  }
  return next;
}

export function issueFromParam(
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

export function taskFromParam(
  store: MultiremiStore,
  c: Context,
  param: string,
): MultiremiTask | null {
  return store.getTaskByRef(c.req.param(param) ?? "");
}

export function issueListQuery(
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

export function resolveAssigneeFilterId(
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

export function parseIssueMetadataFilter(value: string | undefined): Record<string, string | number | boolean> | null {
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

export function parseIssueCommentListQuery(c: { req: { query: (name: string) => string | undefined } }): ListIssueCommentsInput | { error: string; status: 400 } {
  const rootsOnly = parseBooleanQuery(c.req.query("roots_only") ?? c.req.query("roots-only"), "roots_only");
  if (typeof rootsOnly === "object") return rootsOnly;
  const summary = parseBooleanQuery(c.req.query("summary"), "summary");
  if (typeof summary === "object") return summary;
  const recent = parseIntegerQuery(c.req.query("recent"), "recent");
  if (recent && typeof recent === "object") return recent;
  const tail = parseIntegerQuery(c.req.query("tail"), "tail");
  if (tail && typeof tail === "object") return tail;
  return {
    issueSessionId: c.req.query("issue_session_id") ?? c.req.query("issue-session-id") ?? null,
    issue_session_id: c.req.query("issue_session_id") ?? c.req.query("issue-session-id") ?? null,
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

export function parseBooleanQuery(value: string | undefined, name: string): boolean | { error: string; status: 400 } {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  return { error: `invalid ${name} parameter; expected boolean`, status: 400 };
}

export function parseIntegerQuery(value: string | undefined, name: string): number | null | { error: string; status: 400 } {
  if (value === undefined || value === "") return null;
  if (!/^-?\d+$/.test(value)) return { error: `invalid ${name} parameter; expected integer`, status: 400 };
  return Number.parseInt(value, 10);
}

export function setIssueCommentCursorHeaders(c: Context, result: { nextBefore?: string | null; nextBeforeId?: string | null }): void {
  if (result.nextBefore && result.nextBeforeId) {
    c.header("X-Multiremi-Next-Before", result.nextBefore);
    c.header("X-Multiremi-Next-Before-Id", result.nextBeforeId);
  }
}

export function assigneeFrequencyQuery(c: { req: { query: (name: string) => string | undefined } }): {
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

export function splitQueryList(value: string | undefined): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function withFeedbackRequestMetadata(
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

export function createFeedbackOrApiError(store: MultiremiStore, input: CreateFeedbackInput): ReturnType<MultiremiStore["createFeedback"]> {
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

export function safeUpdateCurrentUser(
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

export function safeCreateWorkspace(
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

export function normalizeGoWorkspaceMemberRole(value: unknown): { role: "owner" | "admin" | "member" } | { error: string } {
  const role = String(value ?? "").trim().toLowerCase();
  if (!role) return { error: "role is required" };
  if (role === "owner" || role === "admin" || role === "member") return { role };
  return { error: "invalid member role" };
}

export function publishWorkspaceEvent(
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

export function safeUpdateWorkspaceMember(
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

export function safeArchiveWorkspaceMember(
  store: MultiremiStore,
  memberId: string,
): ReturnType<MultiremiStore["archiveWorkspaceMember"]> | { error: string; status: 400 | 404 } {
  try {
    return store.archiveWorkspaceMember(memberId);
  } catch (error) {
    return workspaceMemberMutationError(error, "member not found");
  }
}

export function safeLeaveWorkspace(
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

export function workspaceMemberMutationError(error: unknown, missingMessage: string): { error: string; status: 400 | 404 } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Member not found") || message === missingMessage) return { error: missingMessage, status: 404 };
  if (message === "workspace must have at least one owner") return { error: message, status: 400 };
  return { error: message, status: 400 };
}

export function safeCreateInvitation(
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

export function safeAcceptInvitation(
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

export function safeDeclineInvitation(
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

export function safeJoinCloudWaitlist(
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

export function safeRuntimeOnboardingBootstrap(
  store: MultiremiStore,
  body: { workspace_id?: string; workspaceId?: string; runtime_id?: string; runtimeId?: string },
  bootstrapUserId: string,
): { workspace_id: string; agent_id: string; issue_id: string } | { error: string; status: 400 | 404 } {
  const workspaceId = body.workspace_id ?? body.workspaceId ?? "";
  const runtimeId = body.runtime_id ?? body.runtimeId ?? "";
  if (!workspaceId) return { error: "workspace_id is required", status: 400 };
  if (!runtimeId) return { error: "runtime_id is required", status: 400 };
  const runtime = store.getRuntime(runtimeId);
  // COALESCE(...,'local') so a workspace-less runtime is treated as local,
  // matching how the claim predicate (and the rest of the system) reads it.
  if (!runtime || (runtime.workspaceId ?? "local") !== workspaceId) return { error: "invalid runtime_id", status: 400 };
  const provider = runtime.provider === "claude" || runtime.provider === "codex" ? runtime.provider : "codex";
  const before = store.getDefaultAgent(workspaceId, provider, bootstrapUserId);
  const isFirstAgent = isFirstAgentInWorkspace(store, workspaceId);
  const agent = store.ensureDefaultAgent(provider, {
    workspaceId,
    ownerId: bootstrapUserId,
  });
  if (!before) {
    recordSystemAgentCreatedAnalytics(store, agent, runtime, {
      actorId: bootstrapUserId,
      template: "multiremi_helper",
      isFirstAgentInWorkspace: isFirstAgent,
    });
  }
  const issue = createOnboardingIssue(store, workspaceId, "Connect your local runtime", `Use ${runtime.name} to run your first task.`, bootstrapUserId);
  store.createTask({
    agentId: agent.id,
    issueId: issue.id,
    workspaceId,
    prompt: "Help complete onboarding and verify the local runtime is ready.",
  });
  store.markCurrentUserOnboarded(bootstrapUserId);
  return { workspace_id: workspaceId, agent_id: agent.id, issue_id: issue.id };
}

export function safeNoRuntimeOnboardingBootstrap(
  store: MultiremiStore,
  body: { workspace_id?: string; workspaceId?: string },
  bootstrapUserId: string,
): { workspace_id: string; issue_id: string } | { error: string; status: 400 | 404 } {
  const workspaceId = body.workspace_id ?? body.workspaceId ?? "";
  if (!workspaceId) return { error: "workspace_id is required", status: 400 };
  if (!store.getWorkspace(workspaceId)) return { error: "workspace not found", status: 404 };
  const issue = createOnboardingIssue(
    store,
    workspaceId,
    "Install a local runtime",
    "Install and register a local Claude or Codex runtime to start running tasks.",
    bootstrapUserId,
  );
  store.markCurrentUserOnboarded(bootstrapUserId);
  return { workspace_id: workspaceId, issue_id: issue.id };
}

export function createOnboardingIssue(
  store: MultiremiStore,
  workspaceId: string,
  title: string,
  description: string,
  createdBy = "local",
): ReturnType<MultiremiStore["createIssue"]> {
  const existing = store.listIssues({ workspaceId }).find((issue) => issue.title === title);
  if (existing) return existing;
  return store.createIssue({
    title,
    description,
    workspaceId,
    createdBy,
    priority: "medium",
    contextRefs: [{ type: "onboarding" }],
  });
}

export function registerDaemonRuntimes(
  store: MultiremiStore,
  body: DaemonRegisterRequestBody,
  auth: { ownerId: string | null } = { ownerId: null },
  includeRelay = false,
):
  | {
    runtimes: ReturnType<typeof daemonRuntimeResponse>[];
    repos: WorkspaceRepoData[];
    repos_version: string;
    settings: Record<string, unknown>;
    relay: Record<string, unknown>;
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
  const repos = workspaceReposResponse(store, workspaceId, includeRelay);
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
    relay: repos.relay,
  };
}

export function daemonRegisterOwnerContext(
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

export function uniqueStrings(values: unknown[]): string[] {
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

export function mergeLegacyDaemonRuntimes(
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

export function githubAppSlug(): string {
  return (process.env.GITHUB_APP_SLUG ?? "").trim();
}

export function githubWebhookSecret(): string {
  return (process.env.GITHUB_WEBHOOK_SECRET ?? process.env.MULTIREMI_WEBHOOK_SECRET ?? "").trim();
}

export function isGitHubAppConfigured(): boolean {
  return Boolean(githubAppSlug() && githubWebhookSecret());
}

export function signGitHubState(workspaceId: string): string {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const payload = `${workspaceId}.${nonce}`;
  const sig = createHmac("sha256", githubWebhookSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function githubConnectResponse(workspaceId: string): { configured: boolean; url?: string } {
  if (!isGitHubAppConfigured()) return { configured: false };
  const state = signGitHubState(workspaceId);
  return {
    configured: true,
    url: `https://github.com/apps/${encodeURIComponent(githubAppSlug())}/installations/new?state=${encodeURIComponent(state)}`,
  };
}

export function githubSetupResponse(installationId?: string, state?: string): {
  configured: boolean;
  installation_id?: string;
  state?: string;
  error?: string;
} {
  if (!isGitHubAppConfigured()) return { configured: false, error: "github app is not configured" };
  if (!installationId || !state) return { configured: true, error: "missing_params" };
  return { configured: true, installation_id: installationId, state };
}

export function sendLocalAuthCode(
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

export async function verifyLocalAuthCode(
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

export async function localGoogleAuthFallback(
  store: MultiremiStore,
  body: { email?: string; name?: string; credential?: string; token?: string },
): Promise<Awaited<ReturnType<typeof localAuthResponse>> | { error: string; status: 400 }> {
  const email = normalizeAuthEmail(body.email ?? store.getCurrentUser().email);
  if (typeof email !== "string") return email;
  return localAuthResponse(store, { email, name: body.name });
}

// HttpOnly login cookie (same name as the Go server's) so native browser
// loads — <img> tags, downloads — carry a credential; the auth middleware
// accepts it for GET/HEAD only. Not marked Secure: the deployment fronts
// plain HTTP, and browsers drop Secure cookies set over http.
export const AUTH_COOKIE_NAME = "multimira_auth";
export const AUTH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // matches the 30-day login PAT

export function setAuthCookie(c: Context, token: string): void {
  setCookie(c, AUTH_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
  });
}

export async function localAuthResponse(
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
export interface LarkSsoConfig {
  appId: string;
  appSecret: string;
  apiBase: string;
}

export function loadLarkSsoConfig(): LarkSsoConfig | null {
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

export function buildLarkAuthorizeUrl(cfg: LarkSsoConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  return `${cfg.apiBase}/authen/v1/authorize?${params.toString()}`;
}

export async function larkExchangeCode(cfg: LarkSsoConfig, code: string, redirectUri: string): Promise<string> {
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

export async function larkFetchUserInfo(cfg: LarkSsoConfig, userAccessToken: string): Promise<{ name: string; email: string | null; openId: string | null }> {
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

export function normalizeAuthEmail(value: unknown): string | { error: string; status: 400 } {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return { error: "email is required", status: 400 };
  if (email.length > 254) return { error: "email is too long", status: 400 };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "email is invalid", status: 400 };
  return email;
}

export function createLocalAuthCode(email: string): string {
  if (process.env.MULTIREMI_LOCAL_AUTH_CODE) return process.env.MULTIREMI_LOCAL_AUTH_CODE.trim();
  const digest = createHmac("sha256", process.env.MULTIREMI_TOKEN || "local-bun-multiremi")
    .update(email)
    .update(String(Math.floor(Date.now() / LOCAL_AUTH_CODE_TTL_MS)))
    .digest("hex");
  return String(parseInt(digest.slice(0, 8), 16) % 1_000_000).padStart(6, "0");
}

export function handleGitHubWebhook(store: MultiremiStore, body: any): { ok: string } | { ok: true; ignored: true } | { pullRequest: MultiremiGitHubPullRequest } {
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

export function cloudRuntimeStatusResponse(c: Context, store: MultiremiStore, body: any, status: string) {
  const id = body.id ?? body.node_id ?? body.nodeId ?? "";
  const node = id ? store.setCloudRuntimeNodeStatus(id, status) : null;
  if (!node) return c.json({ error: "cloud runtime node not found" }, 404);
  return c.json(node);
}

export const MAX_TASK_MESSAGES_PER_REQUEST = 256;

// Whitelist an untrusted daemon message body to TaskMessageInput, tolerating
// both camelCase (the daemon client serializes TaskMessageInput directly) and
// snake_case field names.
export function daemonTaskMessageInput(raw: unknown): TaskMessageInput {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) if (typeof m[k] === "string") return m[k] as string;
    return undefined;
  };
  const obj = (...keys: string[]): Record<string, unknown> | undefined => {
    for (const k of keys) if (m[k] && typeof m[k] === "object" && !Array.isArray(m[k])) return m[k] as Record<string, unknown>;
    return undefined;
  };
  return {
    seq: typeof m.seq === "number" ? m.seq : undefined,
    type: str("type") ?? "text",
    tool: str("tool") ?? null,
    content: str("content") ?? null,
    input: obj("input") ?? null,
    output: str("output") ?? null,
    toolCallId: str("toolCallId", "tool_call_id") ?? null,
    status: str("status") ?? null,
    meta: obj("meta") ?? null,
  };
}

export function safeRerunIssue(
  store: MultiremiStore,
  issueId: string,
  body: { agent_id?: string; agentId?: string; prompt?: string },
): { task: MultiremiTask } | { error: string; status: 400 | 404 } {
  const issue = store.getIssue(issueId);
  if (!issue) return { error: "issue not found", status: 404 };
  const agentId = body.agent_id ?? body.agentId ?? issue.assigneeId;
  if (!agentId) return { error: "issue has no agent assignee", status: 400 };
  const agent = store.getAgent(agentId);
  if (!agent) return { error: "agent not found", status: 404 };
  // The rerun agent must live in the issue's workspace — a caller with issue
  // access can't redirect the run to another workspace's agent (createTask
  // would reject the cross-workspace link, but fail loudly here first).
  if (agent.workspaceId !== issue.workspaceId) return { error: "agent not found", status: 404 };
  const task = store.createTask({
    agentId,
    issueId: issue.id,
    workspaceId: issue.workspaceId,
    prompt: body.prompt ?? issue.title,
  });
  return { task };
}

export function isPendingForRuntime(store: MultiremiStore, runtime: MultiremiRuntime, task: MultiremiTask): boolean {
  if ((runtime.workspaceId ?? "local") !== (task.workspaceId ?? "local")) return false;
  if (isInFlightTaskStatus(task.status)) return task.runtimeId === runtime.id;
  if (task.status !== "queued") return false;
  const agent = store.getAgent(task.agentId);
  if (!agent || agent.archivedAt) return false;
  if (task.runtimeId && task.runtimeId !== runtime.id) return false;
  if (agent.runtimeId && agent.runtimeId !== runtime.id) return false;
  if (runtime.provider !== "any" && agent.provider !== runtime.provider) return false;
  // Mirrors the claim SQL's ownership predicate: a private runtime only runs
  // its owner's agents (COALESCE(...,'local') so single-machine NULL owners
  // still pair). A task stamp is deliberately NOT an escape hatch — the /tasks
  // API lets any member stamp an arbitrary agent+runtime.
  if (
    runtime.visibility !== "public" &&
    (runtime.ownerId ?? "local") !== (agent.ownerId ?? "local")
  ) {
    return false;
  }
  return true;
}

export function isDaemonPendingTaskForRuntime(task: MultiremiTask, runtimeId: string): boolean {
  return task.runtimeId === runtimeId && (task.status === "queued" || task.status === "dispatched");
}

export function compareDaemonPendingTasks(left: MultiremiTask, right: MultiremiTask): number {
  return right.priority - left.priority || Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

export function isTerminalTaskStatus(status: MultiremiTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isActiveTaskStatus(status: MultiremiTaskStatus): boolean {
  return status === "queued"
    || status === "dispatched"
    || status === "running"
    || status === "waiting_local_directory"
    || status === "awaiting_human";
}

export function isInFlightTaskStatus(status: MultiremiTaskStatus): boolean {
  return status === "dispatched"
    || status === "running"
    || status === "waiting_local_directory"
    || status === "awaiting_human";
}

export function safeCreateRuntimeUpdateRequest(
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

export function safeQuickCreateIssue(store: MultiremiStore, input: QuickCreateIssueInput): ReturnType<MultiremiStore["quickCreateIssue"]> | { error: string } {
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

export function usageQuery(c: { req: { query: (name: string) => string | undefined } }, extra: { runtimeId?: string | null } = {}): {
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

export function normalizeReactionInput(input: CreateMultiremiReactionInput): { actorType?: string; actorId?: string | null; emoji: string } {
  return {
    actorType: input.actorType ?? input.actor_type ?? "member",
    actorId: input.actorId ?? input.actor_id ?? "local",
    emoji: input.emoji,
  };
}

export function normalizeGitHubPullRequestBody(body: any): NormalizedGitHubPullRequestBody {
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

export function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function parseJsonBody<T>(rawBody: string): T {
  if (!rawBody.trim()) return {} as T;
  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function verifyJwtToken(token: string): { userId: string } | null {
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
export function jwtSecret(): string | null {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") return DEFAULT_JWT_SECRET;
  return null;
}

export function jwtTimeClaimsAreValid(claims: Record<string, unknown>, nowSeconds = Date.now() / 1000): boolean {
  const exp = numericDateClaim(claims.exp);
  if (exp !== null && nowSeconds >= exp) return false;
  const nbf = numericDateClaim(claims.nbf);
  if (nbf !== null && nowSeconds < nbf) return false;
  const iat = numericDateClaim(claims.iat);
  if (iat !== null && nowSeconds + 60 < iat) return false;
  return true;
}

export function numericDateClaim(value: unknown): number | null {
  if (value == null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function decodeBase64UrlJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url");
}

export function safeEqualText(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function webhookSignatureStatus(
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

export function verifyWebhookSignature(secret: string, signature: string, rawBody: string): boolean {
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;
  const actualHex = signature.slice(prefix.length);
  if (!/^[0-9a-fA-F]+$/.test(actualHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(actualHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function uploadRoot(): string {
  return process.env.MULTIREMI_UPLOAD_DIR ?? join(homedir(), ".remi", "multiremi", "uploads");
}

export function createUploadAttachmentId(): string {
  return `att_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function stringFormValue(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function safeFilename(value: string): string {
  const filename = basename(value).replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  return filename || "upload.bin";
}

export function uploadRelativePath(workspaceId: string, attachmentId: string, filename: string): string {
  return join(safePathSegment(workspaceId || "local"), `${attachmentId}${extname(filename) || ".bin"}`);
}

export function uploadAbsolutePath(relativePath: string): string {
  return join(uploadRoot(), relativePath);
}

export function uploadedAttachmentPath(attachment: { workspaceId: string; id: string; filename: string }): string {
  return uploadAbsolutePath(uploadRelativePath(attachment.workspaceId, attachment.id, attachment.filename));
}

export async function localAttachmentFileResponse(attachment: MultiremiAttachment): Promise<Response> {
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

export function safePathSegment(value: string): string {
  return String(value || "local").replace(/[^A-Za-z0-9_-]/g, "_") || "local";
}

export function detectContentTypeFromFilename(filename: string): string {
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


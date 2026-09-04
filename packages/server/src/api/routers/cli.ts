import type { Context, Hono } from "hono";
import { multiremiVersion } from "@multiremi/version.js";
import { CLI_CAPABILITIES_RUNTIME } from "../cli-capabilities-generated.js";
import {
  canonicalGitRemoteKey,
  listWorkspaceRepositories,
  safeWorkspaceRepositoryData,
  type WorkspaceRepositoryData,
} from "../helpers/repositories.js";
import { resolveActiveIssueShareToken } from "../helpers/issue-share-tokens.js";
import {
  authenticatedRequestUserId,
  currentAccessToken,
  currentWorkspaceMember,
} from "../wire/index.js";
import { compatibilityWorkspaceId, denyCurrentUserWorkspaceAccess } from "../helpers.js";
import { restrictedTaskIssueCreationAgent } from "../helpers.js";
import type { RouterDeps } from "./deps.js";

export const CLI_SHARE_HEADER = "X-Remi-Share";
export const CLI_PROTOCOL_VERSION = 1;

type CliIdentity = "human" | "task" | "daemon" | "share";

interface ResolvedCliIdentity {
  type: CliIdentity;
  workspaceId: string;
  shareIssueId: string | null;
}

export function registerCliRoutes(app: Hono, deps: RouterDeps): void {
  app.get("/api/cli/context", (c) => {
    const resolved = resolveCliIdentity(c, deps);
    if (resolved instanceof Response) return resolved;
    const denied = denyCliWorkspaceAccess(c, deps, resolved);
    if (denied) return denied;
    if (!deps.store.getWorkspace(resolved.workspaceId) && resolved.workspaceId !== "local") {
      return c.json({ error: "workspace not found" }, 404);
    }
    return c.json(buildCliContext(c, deps, resolved));
  });

  app.get("/api/cli/capabilities", (c) => {
    const resolved = resolveCliIdentity(c, deps);
    if (resolved instanceof Response) return resolved;
    const denied = denyCliWorkspaceAccess(c, deps, resolved);
    if (denied) return denied;
    if (!deps.store.getWorkspace(resolved.workspaceId) && resolved.workspaceId !== "local") {
      return c.json({ error: "workspace not found" }, 404);
    }
    const issueCreationRestricted = Boolean(restrictedTaskIssueCreationAgent(c, deps.store));
    return c.json({
      protocol_version: CLI_PROTOCOL_VERSION,
      manifest_version: String(CLI_CAPABILITIES_RUNTIME.schema_version),
      server_version: multiremiVersion,
      identity: resolved.type,
      features: {
        async_operations: true,
        capability_negotiation: true,
        jsonl_output: true,
        local_cwd_merge: true,
        resource_resolution: ["full_id", "unique_short_id", "unique_name"],
      },
      commands: Object.entries(CLI_CAPABILITIES_RUNTIME.commands)
        .map(([id, command]) => ({
          id,
          command: command.command,
          capability: command.capability,
          outputs: command.output,
          allowed: (command.auth as readonly string[]).includes(resolved.type)
            && !(issueCreationRestricted && (id === "issue.create" || id === "issue.quick-create")),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    });
  });
}

function resolveCliIdentity(c: Context, deps: RouterDeps): ResolvedCliIdentity | Response {
  const shareValue = c.req.header(CLI_SHARE_HEADER)?.trim() ?? "";
  if (shareValue) {
    const share = resolveActiveIssueShareToken(shareValue, deps.store, deps.shareSecret);
    if (!share) return c.json({ error: "unauthorized" }, 401);
    return { type: "share", workspaceId: share.workspaceId, shareIssueId: share.issueId };
  }
  const access = currentAccessToken(c);
  const type: CliIdentity = access?.type === "task"
    ? "task"
    : access?.type === "daemon"
      ? "daemon"
      : "human";
  return {
    type,
    workspaceId: access?.type === "task" || access?.type === "daemon"
      ? access.workspaceId
      : compatibilityWorkspaceId(c),
    shareIssueId: null,
  };
}

function denyCliWorkspaceAccess(
  c: Context,
  deps: RouterDeps,
  identity: ResolvedCliIdentity,
): Response | null {
  const explicitlyRequested = c.req.header("X-Workspace-ID")?.trim()
    || c.req.query("workspace_id")?.trim()
    || "";
  if (explicitlyRequested && explicitlyRequested !== identity.workspaceId
    && (identity.type === "task" || identity.type === "daemon" || identity.type === "share")) {
    return c.json({ error: "workspace not found" }, 404);
  }
  if (identity.type === "daemon" || identity.type === "share") return null;
  return denyCurrentUserWorkspaceAccess(c, deps.store, identity.workspaceId);
}

function buildCliContext(c: Context, deps: RouterDeps, identity: ResolvedCliIdentity) {
  const { store } = deps;
  const workspace = identity.workspaceId === "local"
    ? store.ensureLocalWorkspace()
    : store.getWorkspace(identity.workspaceId);
  if (!workspace) throw new Error(`Workspace disappeared while building CLI context: ${identity.workspaceId}`);

  if (identity.type === "share") {
    const issue = identity.shareIssueId ? store.getIssue(identity.shareIssueId) : null;
    return {
      protocol_version: CLI_PROTOCOL_VERSION,
      identity: { type: identity.type },
      workspace: { id: workspace.id },
      current: { issue: issue ? safeIssue(issue) : null },
      catalog: { projects: [], repositories: [], next_cursor: null },
      allowed_operations: ["context.read", "share.read"],
    };
  }

  const access = currentAccessToken(c);
  const task = identity.type === "task" && access?.taskId ? store.getTask(access.taskId) : null;
  const issue = task?.issueId ? store.getIssue(task.issueId) : null;
  const project = issue?.projectId ? store.getProject(issue.projectId) : null;
  const agent = task?.agentId
    ? store.getAgent(task.agentId)
    : identity.type === "task" && access?.agentId
      ? store.getAgent(access.agentId)
      : null;
  const session = task?.issueSessionId ? store.getIssueSession(task.issueSessionId) : null;
  const chat = task?.chatSessionId ? store.getChatSession(task.chatSessionId) : null;
  const boundIssue = !issue && chat?.issueId ? store.getIssue(chat.issueId) : null;
  const runtime = task?.runtimeId
    ? store.getRuntime(task.runtimeId)
    : agent?.runtimeId
      ? store.getRuntime(agent.runtimeId)
      : null;
  const daemonRuntimes = identity.type === "daemon" && access?.daemonId
    ? store.listRuntimes().filter((candidate) => candidate.daemonId === access.daemonId)
    : [];
  const userId = authenticatedRequestUserId(c);
  const user = userId ? store.getUser(userId) : null;
  const member = currentWorkspaceMember(c, store, identity.workspaceId);
  const catalog = identity.type === "daemon"
    ? { projects: [], repositories: [], next_cursor: null }
    : safeCatalog(c, deps, identity.workspaceId);

  return {
    protocol_version: CLI_PROTOCOL_VERSION,
    identity: {
      type: identity.type,
      ...(user ? { user: { id: user.id, name: user.name } } : {}),
      ...(member ? { member: { id: member.id, name: member.name, role: member.role } } : {}),
    },
    workspace: safeWorkspace(workspace),
    current: {
      agent: agent ? safeAgent(agent) : null,
      task: task ? safeTask(task) : null,
      chat: chat ? safeChat(chat) : null,
      issue: issue ? safeIssue(issue) : null,
      bound_issue: boundIssue ? safeIssue(boundIssue) : null,
      session: session ? safeSession(session) : null,
      project: project ? safeProject(project, repositoryIdsForProject(store, project.id, identity.workspaceId)) : null,
      runtime: runtime ? safeRuntime(runtime) : null,
      runtimes: daemonRuntimes.map(safeRuntime),
    },
    catalog,
    allowed_operations: allowedOperations(identity.type),
  };
}

function safeCatalog(c: Context, deps: RouterDeps, workspaceId: string) {
  const { store } = deps;
  const query = c.req.query("query")?.trim().toLocaleLowerCase() ?? "";
  const parsedLimit = Number.parseInt(c.req.query("limit") ?? "200", 10);
  const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 200;
  const parsedCursor = Number.parseInt(c.req.query("cursor") ?? "0", 10);
  const offset = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  const repositories = listWorkspaceRepositories(store, workspaceId);
  const projectRows = store.listProjects(workspaceId).map((project) =>
    safeProject(project, repositoryIdsForProject(store, project.id, workspaceId, repositories))
  );
  const repositoryRows = repositories.map(safeRepository);
  const matches = (value: Record<string, unknown>) => !query
    || Object.values(value).some((field) => typeof field === "string" && field.toLocaleLowerCase().includes(query));
  const combined = [
    ...projectRows.filter(matches).map((value) => ({ kind: "project" as const, value })),
    ...repositoryRows.filter(matches).map((value) => ({ kind: "repository" as const, value })),
  ];
  const page = combined.slice(offset, offset + limit);
  return {
    projects: page.filter((entry) => entry.kind === "project").map((entry) => entry.value),
    repositories: page.filter((entry) => entry.kind === "repository").map((entry) => entry.value),
    next_cursor: offset + page.length < combined.length ? String(offset + page.length) : null,
  };
}

function safeWorkspace(workspace: { id: string; name: string; description: string | null }) {
  return { id: workspace.id, name: workspace.name, description: workspace.description };
}

function safeAgent(agent: { id: string; name: string; provider: string; runtimeId: string | null }) {
  return { id: agent.id, name: agent.name, provider: agent.provider, runtime_id: agent.runtimeId };
}

function safeTask(task: {
  id: string;
  taskKind: string;
  status: string;
  agentId: string;
  runtimeId: string | null;
  issueId: string | null;
  issueSessionId: string | null;
  chatSessionId: string | null;
}) {
  return {
    id: task.id,
    kind: task.taskKind,
    status: task.status,
    agent_id: task.agentId,
    runtime_id: task.runtimeId,
    issue_id: task.issueId,
    session_id: task.issueSessionId,
    chat_id: task.chatSessionId,
  };
}

function safeIssue(issue: {
  id: string;
  key: string;
  title: string;
  status: string;
  projectId: string | null;
  parentIssueId: string | null;
}) {
  return {
    id: issue.id,
    key: issue.key,
    title: issue.title,
    status: issue.status,
    project_id: issue.projectId,
    parent_id: issue.parentIssueId,
  };
}

function safeSession(session: { id: string; title: string; status: string; issueId: string }) {
  return { id: session.id, title: session.title, status: session.status, issue_id: session.issueId };
}

function safeChat(chat: { id: string; title: string; status: string; agentId: string; issueId: string | null }) {
  return {
    id: chat.id,
    title: chat.title,
    status: chat.status,
    agent_id: chat.agentId,
    issue_id: chat.issueId,
  };
}

function safeRuntime(runtime: { id: string; name: string; provider: string; status: string }) {
  return { id: runtime.id, name: runtime.name, provider: runtime.provider, status: runtime.status };
}

function safeProject(
  project: { id: string; title: string; description: string | null; status: string },
  repositoryIds: string[],
) {
  return {
    id: project.id,
    name: project.title,
    description: project.description,
    status: project.status,
    repository_ids: repositoryIds,
  };
}

function safeRepository(repository: WorkspaceRepositoryData) {
  const safe = safeWorkspaceRepositoryData(repository);
  return {
    id: safe.id,
    name: safe.name,
    url: safe.url,
    description: safe.description,
    default_branch: safe.default_branch,
  };
}

function repositoryIdsForProject(
  store: RouterDeps["store"],
  projectId: string,
  workspaceId: string,
  repositories = listWorkspaceRepositories(store, workspaceId),
): string[] {
  const idsByUrl = new Map(repositories.map((repository) => [canonicalGitRemoteKey(repository.url), repository.id]));
  return [...new Set(store.listProjectResources(projectId)
    .filter((resource) => resource.resourceType === "github_repo")
    .map((resource) => String(resource.resourceRef.url ?? "").trim())
    .filter(Boolean)
    .map((url) => idsByUrl.get(canonicalGitRemoteKey(url)))
    .filter((id): id is string => Boolean(id)))];
}

function allowedOperations(identity: CliIdentity): string[] {
  if (identity === "daemon") return ["context.read", "runtime.own.manage", "daemon.control"];
  if (identity === "share") return ["context.read", "share.read"];
  return ["context.read", "workspace.manage", "project.manage", "repo.manage", "collaboration.manage", "runtime.manage"];
}

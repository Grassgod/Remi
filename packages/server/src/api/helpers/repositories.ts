import { createHash } from "node:crypto";
import { createId, nowIso } from "@multiremi/ids.js";
import type {
  CreateProjectResourceInput,
  MultiremiWorkspace,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";

export type WorkspaceRepositorySource = "github" | "codebase";

export interface WorkspaceRepositoryData {
  id: string;
  name: string;
  url: string;
  source: WorkspaceRepositorySource;
  description: string | null;
  default_branch: string | null;
  imported_at: string | null;
  updated_at: string | null;
}

export interface ImportWorkspaceRepositoryInput {
  url?: string;
  source?: string;
  name?: string;
  description?: string | null;
  default_branch?: string | null;
}

export class WorkspaceRepositoryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export function listWorkspaceRepositories(
  store: MultiremiStore,
  workspaceId: string,
): WorkspaceRepositoryData[] {
  const workspace = workspaceId === "local"
    ? store.ensureLocalWorkspace()
    : store.getWorkspace(workspaceId);
  if (!workspace) throw new WorkspaceRepositoryError("workspace not found", 404);
  return normalizeWorkspaceRepositories(workspace.repos);
}

export function importWorkspaceRepository(
  store: MultiremiStore,
  workspaceId: string,
  input: ImportWorkspaceRepositoryInput,
): { repository: WorkspaceRepositoryData; workspace: MultiremiWorkspace } {
  const workspace = workspaceId === "local"
    ? store.ensureLocalWorkspace()
    : store.getWorkspace(workspaceId);
  if (!workspace) throw new WorkspaceRepositoryError("workspace not found", 404);

  const url = normalizeGitRemoteUrl(input.url);
  if (!url) throw new WorkspaceRepositoryError("invalid git repository URL", 400);
  const source = normalizeRepositorySource(input.source);
  const repositories = normalizeWorkspaceRepositories(workspace.repos);
  const key = canonicalGitRemoteKey(url);
  if (repositories.some((repo) => canonicalGitRemoteKey(repo.url) === key)) {
    throw new WorkspaceRepositoryError("repository is already imported", 409);
  }

  const now = nowIso();
  const repository: WorkspaceRepositoryData = {
    id: createId("repo"),
    name: cleanRepositoryName(input.name) ?? repositoryNameFromUrl(url),
    url,
    source,
    description: cleanOptionalString(input.description),
    default_branch: cleanOptionalString(input.default_branch),
    imported_at: now,
    updated_at: now,
  };
  const updated = store.updateWorkspace(workspaceId, {
    repos: [...repositories, repository],
  });
  return { repository, workspace: updated };
}

export function removeWorkspaceRepository(
  store: MultiremiStore,
  workspaceId: string,
  repositoryId: string,
): { repository: WorkspaceRepositoryData; workspace: MultiremiWorkspace } {
  const workspace = workspaceId === "local"
    ? store.ensureLocalWorkspace()
    : store.getWorkspace(workspaceId);
  if (!workspace) throw new WorkspaceRepositoryError("workspace not found", 404);
  const repositories = normalizeWorkspaceRepositories(workspace.repos);
  const repository = repositories.find((repo) => repo.id === repositoryId);
  if (!repository) throw new WorkspaceRepositoryError("repository not found", 404);

  const projectsUsingRepository = store.listProjects(workspaceId).filter((project) =>
    store.listProjectResources(project.id).some((resource) => {
      if (resource.resourceType !== "github_repo") return false;
      const url = resource.resourceRef.url;
      return typeof url === "string"
        && canonicalGitRemoteKey(url) === canonicalGitRemoteKey(repository.url);
    })
  );
  if (projectsUsingRepository.length > 0) {
    const suffix = projectsUsingRepository.length === 1 ? "project" : "projects";
    throw new WorkspaceRepositoryError(
      `repository is used by ${projectsUsingRepository.length} ${suffix}`,
      409,
    );
  }

  const updated = store.updateWorkspace(workspaceId, {
    repos: repositories.filter((repo) => repo.id !== repositoryId),
  });
  return { repository, workspace: updated };
}

export function validateImportedProjectResources(
  store: MultiremiStore,
  workspaceId: string,
  resources: CreateProjectResourceInput[] | null | undefined,
): string | null {
  if (!resources?.length) return null;
  const imported = new Set(
    listWorkspaceRepositories(store, workspaceId).map((repo) =>
      canonicalGitRemoteKey(repo.url)
    ),
  );
  for (const resource of resources) {
    const resourceType = resource.resourceType ?? resource.resource_type;
    if (resourceType !== "github_repo") {
      return "projects can only use imported git repositories";
    }
    const ref = resource.resourceRef ?? resource.resource_ref;
    const url = ref && typeof ref.url === "string" ? ref.url : "";
    if (!url || !imported.has(canonicalGitRemoteKey(url))) {
      return "repository must be imported before it can be added to a project";
    }
  }
  return null;
}

export function normalizeWorkspaceRepositories(
  rawRepositories: unknown[],
): WorkspaceRepositoryData[] {
  const result: WorkspaceRepositoryData[] = [];
  const seen = new Set<string>();
  for (const raw of rawRepositories) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const url = normalizeGitRemoteUrl(record.url);
    if (!url) continue;
    const key = canonicalGitRemoteKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: cleanOptionalString(record.id) ?? stableRepositoryId(key),
      name: cleanRepositoryName(record.name) ?? repositoryNameFromUrl(url),
      url,
      source: normalizeRepositorySource(record.source, url),
      description: cleanOptionalString(record.description),
      default_branch: cleanOptionalString(record.default_branch ?? record.defaultBranch),
      imported_at: cleanOptionalString(record.imported_at ?? record.importedAt),
      updated_at: cleanOptionalString(record.updated_at ?? record.updatedAt),
    });
  }
  return result;
}

export function canonicalGitRemoteKey(value: string): string {
  const url = value.trim();
  const scp = url.match(/^([^@\s]+)@([^:\s]+):(.+)$/);
  if (scp) {
    return `ssh://${scp[1]}@${scp[2]!.toLowerCase()}/${normalizeRepositoryPath(scp[3]!)}`;
  }
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${parsed.username.toLowerCase()}@` : "";
    return `${parsed.protocol.toLowerCase()}//${user}${parsed.hostname.toLowerCase()}${
      parsed.port ? `:${parsed.port}` : ""
    }/${normalizeRepositoryPath(parsed.pathname)}`;
  } catch {
    return url.toLowerCase().replace(/\/+$/, "").replace(/\.git$/i, "");
  }
}

function normalizeGitRemoteUrl(value: unknown): string | null {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url || /\s/.test(url)) return null;
  if (/^[^@\s]+@[^:\s]+:.+/.test(url)) return url.replace(/\/+$/, "");
  try {
    const parsed = new URL(url);
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    if (!parsed.hostname || normalizeRepositoryPath(parsed.pathname).length === 0) return null;
    if (parsed.password) return null;
    return url.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function normalizeRepositorySource(
  value: unknown,
  url = "",
): WorkspaceRepositorySource {
  const source = String(value ?? "").trim().toLowerCase();
  if (source === "github" || source === "codebase") return source;
  return /(^|[.@/:])github\.com(?:[/:]|$)/i.test(url) ? "github" : "codebase";
}

function repositoryNameFromUrl(url: string): string {
  const scpPath = url.match(/^[^@\s]+@[^:\s]+:(.+)$/)?.[1];
  let path = scpPath ?? url;
  try {
    path = new URL(url).pathname;
  } catch {
    // SCP-style remotes are handled above.
  }
  const normalized = normalizeRepositoryPath(path);
  const name = normalized.split("/").filter(Boolean).at(-1) ?? "repository";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function normalizeRepositoryPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
}

function stableRepositoryId(key: string): string {
  return `repo_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function cleanRepositoryName(value: unknown): string | null {
  const name = cleanOptionalString(value);
  return name ? name.slice(0, 120) : null;
}

function cleanOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

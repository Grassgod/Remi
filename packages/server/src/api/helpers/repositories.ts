import { createHash } from "node:crypto";
import { createId, nowIso } from "@multiremi/ids.js";
import type {
  CreateProjectResourceInput,
  MultiremiWorkspace,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";

export type WorkspaceRepositorySource = "github" | "codebase" | "unknown";

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

export function safeWorkspaceRepositoryData(repository: WorkspaceRepositoryData): WorkspaceRepositoryData {
  return { ...repository, url: redactRepositoryCredentials(repository.url) };
}

export interface ImportWorkspaceRepositoryInput {
  url?: string;
  name?: string;
  description?: string | null;
  default_branch?: string | null;
}

export interface InspectWorkspaceRepositoryInput {
  url?: string;
}

export interface UpdateWorkspaceRepositoryInput {
  default_branch?: string | null;
  description?: string | null;
}

export interface GitRemoteMetadata {
  default_branch: string;
  branches: string[];
}

export type GitRemoteInspector = (url: string) => Promise<GitRemoteMetadata>;

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

export async function importWorkspaceRepository(
  store: MultiremiStore,
  workspaceId: string,
  input: ImportWorkspaceRepositoryInput,
  inspectRemote: GitRemoteInspector,
): Promise<{ repository: WorkspaceRepositoryData; workspace: MultiremiWorkspace }> {
  const workspace = workspaceId === "local"
    ? store.ensureLocalWorkspace()
    : store.getWorkspace(workspaceId);
  if (!workspace) throw new WorkspaceRepositoryError("workspace not found", 404);

  const url = normalizeGitRemoteUrl(input.url);
  if (!url) throw new WorkspaceRepositoryError("invalid git repository URL", 400);
  const source = normalizeRepositorySource(undefined, url);
  const repositories = normalizeWorkspaceRepositories(workspace.repos);
  const key = canonicalGitRemoteKey(url);
  if (repositories.some((repo) => canonicalGitRemoteKey(repo.url) === key)) {
    throw new WorkspaceRepositoryError("repository is already imported", 409);
  }
  const metadata = await inspectRemote(url);
  const defaultBranch = cleanOptionalString(input.default_branch)
    ?? metadata.default_branch;
  if (!metadata.branches.includes(defaultBranch)) {
    throw new WorkspaceRepositoryError("default branch does not exist in repository", 400);
  }

  const now = nowIso();
  const repository: WorkspaceRepositoryData = {
    id: createId("repo"),
    name: cleanRepositoryName(input.name) ?? repositoryNameFromUrl(url),
    url,
    source,
    description: cleanOptionalString(input.description),
    default_branch: defaultBranch,
    imported_at: now,
    updated_at: now,
  };
  const updated = store.mutateWorkspaceRepositories(workspaceId, (currentRaw) => {
    const current = normalizeWorkspaceRepositories(currentRaw);
    if (current.some((repo) => canonicalGitRemoteKey(repo.url) === key)) {
      throw new WorkspaceRepositoryError("repository is already imported", 409);
    }
    return {
      repositories: [...current, repository],
      result: repository,
    };
  });
  return { repository: updated.result, workspace: updated.workspace };
}

export async function inspectWorkspaceRepository(
  input: InspectWorkspaceRepositoryInput,
  inspectRemote: GitRemoteInspector,
): Promise<{ metadata: GitRemoteMetadata & { name: string; url: string } }> {
  const url = normalizeGitRemoteUrl(input.url);
  if (!url) throw new WorkspaceRepositoryError("invalid git repository URL", 400);
  const metadata = await inspectRemote(url);
  return {
    metadata: {
      ...metadata,
      name: repositoryNameFromUrl(url),
      url,
    },
  };
}

export async function backfillWorkspaceRepositoryDefaultBranches(
  store: MultiremiStore,
  workspaceId: string,
  inspectRemote: GitRemoteInspector,
): Promise<WorkspaceRepositoryData[]> {
  const repositories = listWorkspaceRepositories(store, workspaceId);
  const missing = repositories.filter((repository) => !repository.default_branch);
  if (missing.length === 0) {
    store.reconcileScmRepositoryBindings(workspaceId);
    return repositories;
  }

  const resolved = await Promise.all(missing.map(async (repository) => {
    try {
      const metadata = await inspectRemote(repository.url);
      return [repository.id, {
        repositoryUrl: repository.url,
        defaultBranch: metadata.default_branch,
      }] as const;
    } catch {
      return [repository.id, null] as const;
    }
  }));
  const branches = new Map(resolved);
  if (![...branches.values()].some(Boolean)) {
    store.reconcileScmRepositoryBindings(workspaceId);
    return repositories;
  }

  const updated = store.mutateWorkspaceRepositories(workspaceId, (currentRaw) => {
    const now = nowIso();
    const updatedRepositories = normalizeWorkspaceRepositories(currentRaw).map((repository) => {
      const resolvedBranch = branches.get(repository.id);
      if (
        repository.default_branch
        || !resolvedBranch
        || canonicalGitRemoteKey(repository.url) !== canonicalGitRemoteKey(resolvedBranch.repositoryUrl)
      ) {
        return repository;
      }
      return {
        ...repository,
        default_branch: resolvedBranch.defaultBranch,
        updated_at: now,
      };
    });
    return { repositories: updatedRepositories, result: updatedRepositories };
  });
  return updated.result;
}

export async function updateWorkspaceRepository(
  store: MultiremiStore,
  workspaceId: string,
  repositoryId: string,
  input: UpdateWorkspaceRepositoryInput,
  inspectRemote: GitRemoteInspector,
): Promise<{ repository: WorkspaceRepositoryData; workspace: MultiremiWorkspace }> {
  const repositories = listWorkspaceRepositories(store, workspaceId);
  const repository = repositories.find((candidate) => candidate.id === repositoryId);
  if (!repository) throw new WorkspaceRepositoryError("repository not found", 404);

  const hasDefaultBranch = Object.prototype.hasOwnProperty.call(input, "default_branch");
  const hasDescription = Object.prototype.hasOwnProperty.call(input, "description");
  if (!hasDefaultBranch && !hasDescription) {
    throw new WorkspaceRepositoryError("repository update is empty", 400);
  }

  let defaultBranch: string | null | undefined;

  if (hasDefaultBranch) {
    defaultBranch = cleanOptionalString(input.default_branch);
    if (!defaultBranch) {
      throw new WorkspaceRepositoryError("default branch is required", 400);
    }
    const metadata = await inspectRemote(repository.url);
    if (!metadata.branches.includes(defaultBranch)) {
      throw new WorkspaceRepositoryError("default branch does not exist in repository", 400);
    }
  }

  let description: string | null | undefined;
  if (hasDescription) {
    description = cleanOptionalString(input.description);
    if (description && description.length > 200) {
      throw new WorkspaceRepositoryError(
        "repository description must be 200 characters or fewer",
        400,
      );
    }
  }

  const inspectedRepositoryUrl = repository.url;
  const updated = store.mutateWorkspaceRepositories(workspaceId, (currentRaw) => {
    const current = normalizeWorkspaceRepositories(currentRaw);
    const latest = current.find((candidate) => candidate.id === repositoryId);
    if (!latest) throw new WorkspaceRepositoryError("repository not found", 404);
    if (
      hasDefaultBranch
      && canonicalGitRemoteKey(latest.url) !== canonicalGitRemoteKey(inspectedRepositoryUrl)
    ) {
      throw new WorkspaceRepositoryError(
        "repository changed while its default branch was being inspected; retry the update",
        409,
      );
    }
    const updatedRepository: WorkspaceRepositoryData = {
      ...latest,
      ...(hasDefaultBranch ? { default_branch: defaultBranch! } : {}),
      ...(hasDescription ? { description: description ?? null } : {}),
      updated_at: nowIso(),
    };
    return {
      repositories: current.map((candidate) =>
        candidate.id === repositoryId ? updatedRepository : candidate
      ),
      result: updatedRepository,
    };
  });
  return { repository: updated.result, workspace: updated.workspace };
}

export async function inspectGitRemoteRepository(
  url: string,
): Promise<GitRemoteMetadata> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND
      ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
  };
  const proc = Bun.spawn(
    ["git", "ls-remote", "--symref", url, "HEAD", "refs/heads/*"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, 15_000);

  try {
    const exitCode = await proc.exited;
    const [stdout] = await Promise.all([stdoutPromise, stderrPromise]);
    if (timedOut) {
      throw new WorkspaceRepositoryError("repository inspection timed out", 400);
    }
    if (exitCode !== 0) {
      throw new WorkspaceRepositoryError(
        "unable to read repository metadata; check the clone URL and server credentials",
        400,
      );
    }
    return parseGitRemoteMetadata(stdout);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseGitRemoteMetadata(output: string): GitRemoteMetadata {
  const branches = new Set<string>();
  let defaultBranch = "";
  for (const line of output.split(/\r?\n/)) {
    const symbolicHead = line.match(/^ref:\s+refs\/heads\/(.+)\tHEAD$/);
    if (symbolicHead?.[1]) {
      defaultBranch = symbolicHead[1];
      branches.add(defaultBranch);
      continue;
    }
    const branch = line.match(/^[0-9a-f]+\trefs\/heads\/(.+)$/i)?.[1];
    if (branch) branches.add(branch);
  }
  const sortedBranches = [...branches].sort((left, right) => left.localeCompare(right));
  if (!defaultBranch && sortedBranches.length === 1) defaultBranch = sortedBranches[0]!;
  if (!defaultBranch) {
    throw new WorkspaceRepositoryError("repository does not advertise a default branch", 400);
  }
  return { default_branch: defaultBranch, branches: sortedBranches };
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
  const updated = store.mutateWorkspaceRepositories(workspaceId, (currentRaw) => {
    const repositories = normalizeWorkspaceRepositories(currentRaw);
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

    return {
      repositories: repositories.filter((repo) => repo.id !== repositoryId),
      result: repository,
    };
  });
  return { repository: updated.result, workspace: updated.workspace };
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

function redactRepositoryCredentials(value: string): string {
  const scp = value.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) return `ssh://${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeRepositorySource(
  value: unknown,
  url = "",
): WorkspaceRepositorySource {
  const source = String(value ?? "").trim().toLowerCase();
  if (source === "github" || source === "codebase" || source === "unknown") return source;
  const host = repositoryHostFromUrl(url);
  if (host === "github.com") return "github";
  if (host === "code.byted.org") return "codebase";
  return "unknown";
}

function repositoryHostFromUrl(url: string): string {
  const scpHost = url.match(/^[^@\s]+@([^:\s]+):/)?.[1];
  if (scpHost) return scpHost.toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
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

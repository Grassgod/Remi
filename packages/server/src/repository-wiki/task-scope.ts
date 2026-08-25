import type {
  MultiremiTaskRepositoryWikiContext,
  MultiremiTaskWithAgent,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";

type RepositoryWikiRepository = MultiremiTaskRepositoryWikiContext["repository"];

/** Resolve the repository Wikis that the server materializes for one task. */
export function resolveTaskRepositoryWikiRepositories(
  store: MultiremiStore,
  task: MultiremiTaskWithAgent,
): RepositoryWikiRepository[] {
  const workspace = store.getWorkspace(task.workspaceId);
  if (!workspace) return [];
  const repositories = workspace.repos.flatMap(normalizeWorkspaceRepository);
  const selectedIds = new Set<string>();
  const resourceKeys = new Set(task.projectResources.flatMap((resource) => {
    if (resource.resourceType !== "github_repo") return [];
    const url = resource.resourceRef.url;
    return typeof url === "string" && url.trim() ? [canonicalRepositoryRemote(url)] : [];
  }));
  for (const repository of repositories) {
    if (resourceKeys.has(canonicalRepositoryRemote(repository.url))) selectedIds.add(repository.id);
  }

  // SCM automations run without an Issue or Project. Their server-owned event
  // is the authority for the one repository they may materialize and update.
  if (task.assignmentSourceEventId) {
    const event = store.getScmCanonicalEvent(task.assignmentSourceEventId);
    if (event?.workspaceId === task.workspaceId) selectedIds.add(event.repositoryId);
  }

  // Atlas bootstrap runs are also server-authored. Validate both the owning
  // workspace and the dedicated autopilot before trusting the payload target.
  if (task.autopilotRunId) {
    const run = store.getAutopilotRun(task.autopilotRunId);
    const payload = asRecord(run?.payload);
    const repositoryId = clean(payload?.atlas_repository_id);
    if (run && repositoryId) {
      const autopilot = store.getAutopilot(run.autopilotId);
      if (autopilot?.workspaceId === task.workspaceId && autopilot.title === "Atlas · Repository Wiki") {
        selectedIds.add(repositoryId);
      }
    }
  }

  return repositories.filter((repository) => selectedIds.has(repository.id));
}

export function canonicalRepositoryRemote(value: string): string {
  const trimmed = value.trim();
  const scp = trimmed.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase().replace(/\.git$/i, "").replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    return `${url.hostname}${url.pathname}`.toLowerCase().replace(/\.git$/i, "").replace(/\/+$/, "");
  } catch {
    return trimmed.toLowerCase().replace(/\.git$/i, "").replace(/\/+$/, "");
  }
}

function normalizeWorkspaceRepository(value: unknown): RepositoryWikiRepository[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  const id = clean(row.id);
  const name = clean(row.name);
  const url = clean(row.url);
  if (!id || !name || !url) return [];
  return [{ id, name, url, defaultBranch: clean(row.default_branch ?? row.defaultBranch) }];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clean(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

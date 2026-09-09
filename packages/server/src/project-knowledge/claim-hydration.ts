import type { MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";
import type { ProjectKnowledgeServiceContract } from "./service.js";
import type { RepositoryWikiServiceContract } from "@multiremi/repository-wiki/service.js";

/** One budget covers both stores. Failures are explicit prompt warnings, never fabricated knowledge. */
export async function hydrateClaimKnowledge(
  task: MultiremiTaskWithAgent,
  project: ProjectKnowledgeServiceContract,
  repository: RepositoryWikiServiceContract,
  budgetMs = 5_000,
): Promise<MultiremiTaskWithAgent> {
  const abort = new AbortController();
  let expire!: () => void;
  const expired = new Promise<null>(resolve => { expire = () => { abort.abort(); resolve(null); }; });
  const timer = setTimeout(expire, budgetMs);
  let result = task;
  const warnings: string[] = [];
  try {
    const projectResult = await Promise.race([
      project.hydrateTaskKnowledge(result, abort.signal).catch(() => null), expired,
    ]);
    if (projectResult) result = projectResult;
    else {
      warnings.push("Project Wiki loading failed or exceeded the startup budget. Project Wiki content was not loaded; retrieve it with remi wiki commands when needed.");
      result = { ...result, projectDocs: null, projectWikiDocs: [],
        projectContexts: result.projectContexts.map(context => ({ ...context, docs: [] })) };
    }
    const repositoryResult = abort.signal.aborted ? null : await Promise.race([
      repository.hydrateTaskWiki(result, abort.signal).catch(() => null), expired,
    ]);
    if (repositoryResult) result = repositoryResult;
    else {
      warnings.push("Repository Wiki loading failed or exceeded the startup budget. Repository Wiki content was not loaded; use remi wiki repository commands to retrieve it when needed. Do not claim to have read unavailable pages.");
      result = { ...result, repositoryWikiContexts: [] };
    }
    return { ...result, knowledgeWarnings: [...(task.knowledgeWarnings ?? []), ...warnings] };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

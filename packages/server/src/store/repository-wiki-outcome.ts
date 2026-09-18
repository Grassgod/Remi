import type { StoreContext } from "./context.js";
import { parseJson } from "./helpers.js";

export type RepositoryWikiOutcomeStatus = "published" | "published_with_warnings" | "noop" | "blocked";
export interface RepositoryWikiOutcome {
  status: RepositoryWikiOutcomeStatus;
  reason: string;
  compilation_run_id: string;
}
export const REPOSITORY_WIKI_BLOCKED_ALERT_THRESHOLD = 3;

export function repositoryWikiOutcomeKey(taskId: string, repositoryId: string): string {
  return `repository-wiki-outcome:${taskId}:${repositoryId}`;
}

interface CompilationRow {
  id: string; repository_id: string; task_id: string | null; status: string;
  autopilot_run_id: string | null;
  result_summary: string | null; dedupe_key: string | null; completed_at: string | null;
  publication_at: string | null;
}

// Outputs, not agent claims or a matching source revision, prove an actual write.
// Restore audits have no outputs and must never advance the publication clock.
function compilations(ctx: StoreContext, workspaceId: string, taskId?: string): CompilationRow[] {
  return ctx.db.query(`SELECT r.*, MAX(o.created_at) AS publication_at
    FROM multiremi_knowledge_compilation_runs r
    LEFT JOIN multiremi_knowledge_compilation_outputs o ON o.run_id = r.id
      AND o.artifact_scope = 'repository_wiki' AND o.action NOT IN ('noop', 'reject')
      AND o.doc_id IS NOT NULL
    WHERE r.workspace_id = ? AND r.repository_id IS NOT NULL ${taskId ? "AND r.task_id = ?" : ""}
    GROUP BY r.id ORDER BY r.created_at DESC, r.id DESC`)
    .all(...(taskId ? [workspaceId, taskId] : [workspaceId])) as CompilationRow[];
}

function taskOutcome(rows: CompilationRow[], taskId: string, repositoryId: string): RepositoryWikiOutcome | null {
  const report = rows.find(row => row.dedupe_key === repositoryWikiOutcomeKey(taskId, repositoryId));
  const publication = rows.find(row => row.task_id === taskId && row.repository_id === repositoryId && row.publication_at);
  // A premature noop/blocked report cannot conceal a subsequent real write.
  if (report && ["blocked", "noop", "published", "published_with_warnings"].includes(report.status)
    && (!publication || report.status === "published" || report.status === "published_with_warnings")) {
    return { status: report.status as RepositoryWikiOutcomeStatus, reason: report.result_summary ?? "", compilation_run_id: report.id };
  }
  return publication ? {
    status: publication.status === "published_with_warnings" || publication.status === "failed" ? "published_with_warnings" : "published",
    reason: publication.result_summary ?? "Published repository Wiki changes",
    compilation_run_id: publication.id,
  } : null;
}

export function repositoryWikiTaskOutcome(ctx: StoreContext, workspaceId: string, repositoryId: string, taskId: string) {
  return taskOutcome(compilations(ctx, workspaceId, taskId), taskId, repositoryId);
}

export function repositoryWikiTaskHasPublication(ctx: StoreContext, workspaceId: string, repositoryId: string, taskId: string): boolean {
  return compilations(ctx, workspaceId, taskId).some(row => row.repository_id === repositoryId && row.publication_at != null);
}

export interface RepositoryWikiObservability {
  last_published_at: string | null;
  builds_since_publish: number;
  consecutive_blocked: number;
  latest_completed_outcome: RepositoryWikiOutcome | null;
  alert: { code: "consecutive_blocked"; threshold: number; count: number; reason: string } | null;
}

export function repositoryWikiObservability(ctx: StoreContext, workspaceId: string): Record<string, RepositoryWikiObservability> {
  const knowledge = compilations(ctx, workspaceId);
  const byTask = new Map<string, CompilationRow[]>();
  const knowledgeAutopilotRuns = new Set<string>();
  for (const row of knowledge) {
    if (row.autopilot_run_id) knowledgeAutopilotRuns.add(row.autopilot_run_id);
    if (!row.task_id) continue;
    const group = byTask.get(row.task_id) ?? [];
    group.push(row);
    byTask.set(row.task_id, group);
  }
  const result: Record<string, RepositoryWikiObservability> = {};
  const get = (id: string) => result[id] ??= {
    last_published_at: null, builds_since_publish: 0, consecutive_blocked: 0,
    latest_completed_outcome: null, alert: null,
  };
  // Legacy pages can predate compilation provenance. Their latest persisted
  // revision time is still a publication fact, independent of hydration health.
  const docs = ctx.db.query(`SELECT repository_id, MAX(updated_at) AS published_at
    FROM multiremi_repository_wiki_docs WHERE workspace_id = ? GROUP BY repository_id`)
    .all(workspaceId) as Array<{ repository_id: string; published_at: string }>;
  for (const doc of docs) get(doc.repository_id).last_published_at = doc.published_at;
  for (const row of knowledge) {
    const metric = get(row.repository_id);
    if (row.publication_at && (!metric.last_published_at || row.publication_at > metric.last_published_at)) {
      metric.last_published_at = row.publication_at;
    }
  }
  const runs = ctx.db.query(`SELECT r.* FROM multiremi_autopilot_runs r
    JOIN multiremi_autopilots a ON a.id = r.autopilot_id
    WHERE a.workspace_id = ? AND (r.repository_id IS NOT NULL OR r.schedule_target IS NOT NULL)
      AND r.status IN ('completed', 'failed')
    ORDER BY r.completed_at DESC, r.created_at DESC, r.id DESC`).all(workspaceId) as Array<{
      id: string; repository_id: string | null; schedule_target: string | null; task_id: string | null;
      completed_at: string | null; created_at: string;
    }>;
  const streakEnded = new Set<string>();
  const seen = new Set<string>();
  for (const run of runs) {
    const target = parseJson<{ kind: string; id: string } | null>(run.schedule_target, null);
    if (!run.repository_id && !knowledgeAutopilotRuns.has(run.id)) continue;
    const repositoryId = run.repository_id ?? (target?.kind === "repository" ? target.id : null);
    if (!repositoryId) continue;
    const metric = get(repositoryId);
    const taskCompilations = run.task_id ? byTask.get(run.task_id) ?? [] : [];
    const outcome = run.task_id ? taskOutcome(taskCompilations, run.task_id, repositoryId) : null;
    if (!seen.has(repositoryId)) {
      metric.latest_completed_outcome = outcome;
      seen.add(repositoryId);
    }
    const publishedInRun = taskCompilations.some(row => row.repository_id === repositoryId && row.publication_at);
    if (!publishedInRun && (!metric.last_published_at || (run.completed_at ?? run.created_at) > metric.last_published_at)) {
      metric.builds_since_publish++;
    }
    if (!streakEnded.has(repositoryId) && outcome?.status === "blocked") metric.consecutive_blocked++;
    else streakEnded.add(repositoryId);
  }
  for (const metric of Object.values(result)) {
    if (metric.consecutive_blocked >= REPOSITORY_WIKI_BLOCKED_ALERT_THRESHOLD) {
      metric.alert = { code: "consecutive_blocked", threshold: REPOSITORY_WIKI_BLOCKED_ALERT_THRESHOLD,
        count: metric.consecutive_blocked, reason: metric.latest_completed_outcome?.reason ?? "" };
    }
  }
  return result;
}

import type { Hono } from "hono";
import type {
  CreateProjectDocInput,
  CreateRepositoryWikiDocInput,
  MultiremiKnowledgeCompilationAction,
  MultiremiKnowledgeScope,
  MultiremiKnowledgeSubmission,
  UpdateProjectDocInput,
  UpdateRepositoryWikiDocInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";
import {
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  readJsonStrict,
} from "../helpers.js";
import {
  assertProjectKnowledgeTarget,
  assertRepositoryKnowledgeTarget,
  KnowledgeWritePolicyError,
  linkSeededProjectSchema,
  knowledgePolicyErrorResponse,
  resolveKnowledgeWriteActor,
  resolveTaskSourceRevision,
} from "../helpers/knowledge.js";
import { currentAccessToken } from "../wire/index.js";
import { listWorkspaceRepositories } from "../helpers/repositories.js";
import { normalizeProjectWikiPath, projectDocSlug } from "@multiremi/store/repos/projects-repo.js";
import { normalizeRepositoryWikiPath } from "@multiremi/store/repos/repository-wiki-repo.js";
import { sha256Text } from "@multiremi/project-knowledge/codec.js";
import { resolveTaskRepositoryWikiRepositories } from "@multiremi/repository-wiki/task-scope.js";
import { agentKnowledgePublishPluginNames } from "@multiremi/knowledge/capability.js";

interface KnowledgeSubmitBody {
  workspace_id?: string;
  project_id?: string | null;
  repository_id?: string | null;
  scope?: string;
  proposed_path?: string | null;
  proposed_slug?: string | null;
  body?: string | null;
  patch?: string | null;
  base_revision?: string | null;
}

interface PublishOutputBody extends CreateProjectDocInput, CreateRepositoryWikiDocInput,
  UpdateProjectDocInput, UpdateRepositoryWikiDocInput {
  action?: MultiremiKnowledgeCompilationAction;
  ref?: string | null;
}

interface PublishBody {
  submission_ids?: string[];
  dedupe_key?: string | null;
  outputs?: PublishOutputBody[];
  output?: PublishOutputBody;
}

interface LegacyMigrationBody {
  workspace_id?: string;
  project_id?: string | null;
  repository_id?: string | null;
  batch_size?: number | null;
  dry_run?: boolean;
  execute?: boolean;
}

interface RepositoryMergedBody {
  workspace_id?: string;
  repository_id?: string;
  change_request_id?: string;
  before_sha?: string;
  after_sha?: string;
  changed_files?: string[];
  canonical_scm_event_id?: string;
}

export function registerKnowledgeRoutes(app: Hono, deps: RouterDeps): void {
  const { store, projectKnowledge, repositoryWiki } = deps;

  app.post("/api/knowledge/submissions", async (c) => {
    const body = await readJsonStrict<KnowledgeSubmitBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const workspaceId = knowledgeWorkspaceId(c, body.workspace_id);
      const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
      if (denied) return denied;
      const actor = resolveKnowledgeWriteActor(c, store);
      const scope = normalizeScope(body.scope);
      const projectId = clean(body.project_id);
      const repositoryId = clean(body.repository_id);
      if (scope === "repository_wiki") {
        if (!repositoryId || !hasRepository(store, workspaceId, repositoryId)) {
          return c.json({ error: "repository not found" }, 404);
        }
        assertRepositoryKnowledgeTarget(actor, store, repositoryId);
      } else if (projectId) {
        const project = store.getProject(projectId);
        if (!project || project.workspaceId !== workspaceId) return c.json({ error: "project not found" }, 404);
        assertProjectKnowledgeTarget(actor, projectId);
      } else if (scope === "project_wiki") {
        return c.json({ error: "project_id is required" }, 400);
      }
      const result = store.createKnowledgeSubmission({
        workspaceId,
        projectId,
        repositoryId,
        scope,
        sourceType: actor.kind === "agent" ? "agent" : "external",
        proposedPath: clean(body.proposed_path),
        proposedSlug: clean(body.proposed_slug),
        body: String(body.body ?? ""),
        patch: clean(body.patch),
        baseRevision: clean(body.base_revision),
        sourceTaskId: actor.task?.id,
        sourceIssueId: actor.issue?.id,
        sourceRevision: actor.sourceRevision,
        authorAgentId: actor.agent?.id,
      });
      return c.json({ submission: submissionResponse(store, result.submission), deduplicated: result.deduplicated }, result.deduplicated ? 200 : 201);
    } catch (error) {
      return knowledgeError(c, error);
    }
  });

  app.get("/api/knowledge/submissions", (c) => {
    const workspaceId = knowledgeWorkspaceId(c, c.req.query("workspace_id"));
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      return c.json({ submissions: store.listKnowledgeSubmissions({
        workspaceId,
        projectId: clean(c.req.query("project_id")),
        repositoryId: clean(c.req.query("repository_id")),
        scope: clean(c.req.query("scope")),
        status: clean(c.req.query("status")),
        limit: optionalInt(c.req.query("limit")),
      }).map((submission) => submissionResponse(store, submission)) });
    } catch (error) {
      return knowledgeError(c, error);
    }
  });

  app.get("/api/knowledge/submissions/:id", (c) => {
    const submission = store.getKnowledgeSubmission(c.req.param("id"));
    if (!submission) return c.json({ error: "knowledge submission not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, submission.workspaceId);
    if (denied) return denied;
    return c.json({ submission: submissionResponse(store, submission) });
  });

  app.get("/api/knowledge/runs", (c) => {
    const workspaceId = knowledgeWorkspaceId(c, c.req.query("workspace_id"));
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json({ runs: store.listKnowledgeCompilationRuns({
      workspaceId,
      projectId: clean(c.req.query("project_id")),
      repositoryId: clean(c.req.query("repository_id")),
      status: clean(c.req.query("status")),
      limit: optionalInt(c.req.query("limit")),
    }).map((run) => {
      const detail = runDetailResponse(store, run);
      return {
        ...runResponse(store, run),
        sources: detail.sources,
        outputs: detail.outputs,
      };
    }) });
  });

  app.get("/api/knowledge/runs/:id", (c) => {
    const run = store.getKnowledgeCompilationRun(c.req.param("id"));
    if (!run) return c.json({ error: "knowledge compilation run not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, run.workspaceId);
    if (denied) return denied;
    return c.json(runDetailResponse(store, run));
  });

  app.post("/api/projects/:id/knowledge/publish", async (c) => {
    const project = store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, project.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<PublishBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    let runId: string | null = null;
    try {
      const actor = requireAtlasActor(c, store);
      assertProjectKnowledgeTarget(actor, project.id);
      const outputs = publishOutputs(body);
      const schemaExisted = Boolean(store.getProjectDocByRef(project.id, "_schema"));
      const submissions = requirePublishSubmissions(store, body.submission_ids, {
        workspaceId: project.workspaceId,
        projectId: project.id,
        issueId: actor.issue?.id,
      });
      await preflightProjectOutputs(projectKnowledge, project.id, outputs);
      const runResult = store.createKnowledgeCompilationRun({
        workspaceId: project.workspaceId,
        projectId: project.id,
        taskId: actor.task!.id,
        agentId: actor.agent!.id,
        autopilotRunId: actor.task!.autopilotRunId,
        mode: outputs.every((output) => output.kind === "memory") ? "memory_curate" : "issue_ingest",
        status: "validating",
        dedupeKey: requireDedupeKey(body.dedupe_key),
      });
      if (runResult.deduplicated) throw new KnowledgeWritePolicyError("dedupe_key has already been processed", 409);
      runId = runResult.run.id;
      for (const submission of submissions) store.addKnowledgeRunSubmissionSource(runId, submission.id);
      const batchRefs = new Set(outputs.flatMap(projectOutputRefs));
      for (const output of outputs) await assertProjectLinks(projectKnowledge, project.id, String(output.body ?? ""), batchRefs);
      for (const output of outputs) {
        const action = normalizeAction(output.action);
        const scope: MultiremiKnowledgeScope = output.kind === "memory" ? "memory" : "project_wiki";
        if (action === "reject" || action === "noop") {
          store.recordKnowledgeCompilationOutput({ runId, artifactScope: scope, action });
          continue;
        }
        const stamped = {
          ...output,
          sourceTaskId: actor.task!.id,
          source_task_id: actor.task!.id,
          sourceIssueId: actor.issue?.id ?? null,
          source_issue_id: actor.issue?.id ?? null,
          authorType: "agent" as const,
          author_type: "agent" as const,
          authorId: actor.agent!.id,
          author_id: actor.agent!.id,
          updatedByType: "agent" as const,
          updated_by_type: "agent" as const,
          updatedById: actor.agent!.id,
          updated_by_id: actor.agent!.id,
        };
        const doc = action === "create" || action === "split"
          ? await projectKnowledge.createProjectDoc(project.id, stamped)
          : await projectKnowledge.updateProjectDoc(project.id, requireRef(output), stamped);
        store.linkKnowledgeFormalVersion({
          runId,
          artifactScope: doc.kind === "memory" ? "memory" : "project_wiki",
          docId: doc.id,
          version: doc.version,
          action,
          contentSha256: doc.contentSha256 ?? sha256Text(doc.body),
        });
      }
      linkSeededProjectSchema({ store, projectId: project.id, runId, schemaExisted });
      finalizePublishSources(store, submissions, outputs);
      const run = store.completeKnowledgeCompilationRun(runId, "published", `published ${outputs.length} output(s)`);
      return c.json({ run: runResponse(store, run), outputs: store.listKnowledgeRunOutputs(runId) });
    } catch (error) {
      if (runId) store.completeKnowledgeCompilationRun(runId, "failed", error instanceof Error ? error.message : "publish failed");
      return knowledgeError(c, error);
    }
  });

  app.post("/api/workspaces/:id/repos/:repositoryId/wiki/publish", async (c) => {
    const workspaceId = c.req.param("id");
    const repositoryId = c.req.param("repositoryId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (!hasRepository(store, workspaceId, repositoryId)) return c.json({ error: "repository not found" }, 404);
    const body = await readJsonStrict<PublishBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    let runId: string | null = null;
    try {
      const actor = requireAtlasActor(c, store);
      assertRepositoryKnowledgeTarget(actor, store, repositoryId);
      const outputs = publishOutputs(body);
      const submissions = requirePublishSubmissions(store, body.submission_ids, {
        workspaceId,
        repositoryId,
        issueId: actor.issue?.id,
      });
      await preflightRepositoryOutputs(repositoryWiki, workspaceId, repositoryId, outputs);
      const runResult = store.createKnowledgeCompilationRun({
        workspaceId,
        repositoryId,
        taskId: actor.task!.id,
        agentId: actor.agent!.id,
        autopilotRunId: actor.task!.autopilotRunId,
        mode: "repository_update",
        status: "validating",
        dedupeKey: requireDedupeKey(body.dedupe_key),
      });
      if (runResult.deduplicated) throw new KnowledgeWritePolicyError("dedupe_key has already been processed", 409);
      runId = runResult.run.id;
      for (const submission of submissions) store.addKnowledgeRunSubmissionSource(runId, submission.id);
      const batchRefs = new Set(outputs.flatMap(repositoryOutputRefs));
      for (const output of outputs) await assertRepositoryLinks(repositoryWiki, workspaceId, repositoryId, String(output.body ?? ""), batchRefs);
      const sourceRevision = compiledSourceRevision(actor.sourceRevision, submissions);
      for (const output of outputs) {
        const action = normalizeAction(output.action);
        if (action === "reject" || action === "noop") {
          store.recordKnowledgeCompilationOutput({ runId, artifactScope: "repository_wiki", action });
          continue;
        }
        const stamped = {
          ...output,
          sourceTaskId: actor.task!.id,
          source_task_id: actor.task!.id,
          sourceIssueId: actor.issue?.id ?? null,
          source_issue_id: actor.issue?.id ?? null,
          sourceRevision,
          source_revision: sourceRevision,
          authorType: "agent" as const,
          author_type: "agent" as const,
          authorId: actor.agent!.id,
          author_id: actor.agent!.id,
          updatedByType: "agent" as const,
          updated_by_type: "agent" as const,
          updatedById: actor.agent!.id,
          updated_by_id: actor.agent!.id,
        };
        const doc = action === "create" || action === "split"
          ? await repositoryWiki.create(workspaceId, repositoryId, stamped)
          : await repositoryWiki.update(workspaceId, repositoryId, requireRef(output), stamped);
        store.linkKnowledgeFormalVersion({
          runId,
          artifactScope: "repository_wiki",
          docId: doc.id,
          version: doc.version,
          action,
          contentSha256: doc.contentSha256 ?? sha256Text(doc.body),
        });
      }
      finalizePublishSources(store, submissions, outputs);
      const run = store.completeKnowledgeCompilationRun(runId, "published", `published ${outputs.length} output(s)`);
      return c.json({ run: runResponse(store, run), outputs: store.listKnowledgeRunOutputs(runId) });
    } catch (error) {
      if (runId) store.completeKnowledgeCompilationRun(runId, "failed", error instanceof Error ? error.message : "publish failed");
      return knowledgeError(c, error);
    }
  });

  app.post("/api/knowledge/events/repository-merged", async (c) => {
    const body = await readJsonStrict<RepositoryMergedBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const workspaceId = knowledgeWorkspaceId(c, body.workspace_id);
      const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
      if (denied) return denied;
      requirePublisherOrMember(c, store);
      const repositoryId = required(body.repository_id, "repository_id");
      if (!hasRepository(store, workspaceId, repositoryId)) return c.json({ error: "repository not found" }, 404);
      const beforeSha = requireCommitSha(body.before_sha, "before_sha");
      const afterSha = requireCommitSha(body.after_sha, "after_sha");
      const changedFiles = Array.isArray(body.changed_files)
        ? body.changed_files.map(String).map((value) => value.trim()).filter(Boolean)
        : [];
      const result = store.recordRepositoryMergeKnowledgeEvent({
        workspaceId,
        repositoryId,
        changeRequestId: required(body.change_request_id, "change_request_id"),
        beforeSha,
        afterSha,
        changedFiles,
        canonicalEventId: required(body.canonical_scm_event_id, "canonical_scm_event_id"),
      });
      return c.json({
        submission: submissionResponse(store, result.submission),
        run: runResponse(store, result.run),
        deduplicated: result.deduplicated,
      }, result.deduplicated ? 200 : 202);
    } catch (error) {
      return knowledgeError(c, error);
    }
  });

  app.post("/api/knowledge/migrate-legacy", async (c) => {
    const body = await readJsonStrict<LegacyMigrationBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const workspaceId = knowledgeWorkspaceId(c, body.workspace_id);
      const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
      if (denied) return denied;
      requirePublisherOrMember(c, store);
      if (Boolean(body.dry_run) === Boolean(body.execute)) {
        return c.json({ error: "exactly one of dry_run or execute is required" }, 400);
      }
      const batchSize = Math.max(1, Math.min(500, Math.floor(Number(body.batch_size ?? 100))));
      const projectId = clean(body.project_id);
      const repositoryId = clean(body.repository_id);
      const candidates: Array<{
        scope: MultiremiKnowledgeScope;
        sourceType: "legacy_wiki" | "legacy_memory";
        projectId: string | null;
        repositoryId: string | null;
        proposedPath: string | null;
        proposedSlug: string | null;
        body: string;
        sourceRevision: string;
      }> = [];
      const projects = projectId
        ? [store.getProject(projectId)].filter((project): project is NonNullable<typeof project> => Boolean(project && project.workspaceId === workspaceId))
        : store.listProjects(workspaceId);
      for (const project of projects) {
        for (const doc of await projectKnowledge.listProjectDocs(project.id)) {
          candidates.push({
            scope: doc.kind === "memory" ? "memory" : "project_wiki",
            sourceType: doc.kind === "memory" ? "legacy_memory" : "legacy_wiki",
            projectId: project.id,
            repositoryId: null,
            proposedPath: doc.path,
            proposedSlug: doc.slug,
            body: doc.body,
            sourceRevision: `${doc.id}:v${doc.version}`,
          });
        }
      }
      const repositories = repositoryId
        ? listWorkspaceRepositories(store, workspaceId).filter((repository) => repository.id === repositoryId)
        : listWorkspaceRepositories(store, workspaceId);
      for (const repository of repositories) {
        for (const doc of await repositoryWiki.list(workspaceId, repository.id)) {
          candidates.push({
            scope: "repository_wiki",
            sourceType: "legacy_wiki",
            projectId: null,
            repositoryId: repository.id,
            proposedPath: doc.path,
            proposedSlug: doc.slug,
            body: doc.body,
            sourceRevision: `${doc.id}:v${doc.version}`,
          });
        }
      }
      const selected = candidates.slice(0, batchSize);
      const stats = { total: selected.length, succeeded: 0, skipped: 0, errors: 0 };
      const errorDetails: Array<{ source_revision: string; error: string }> = [];
      if (body.execute) {
        for (const candidate of selected) {
          try {
            const result = store.createKnowledgeSubmission({
              workspaceId,
              projectId: candidate.projectId,
              repositoryId: candidate.repositoryId,
              scope: candidate.scope,
              sourceType: candidate.sourceType,
              proposedPath: candidate.proposedPath,
              proposedSlug: candidate.proposedSlug,
              body: candidate.body,
              sourceRevision: candidate.sourceRevision,
              dedupeAllStatuses: true,
            });
            if (result.deduplicated) stats.skipped += 1;
            else stats.succeeded += 1;
          } catch (error) {
            stats.errors += 1;
            errorDetails.push({
              source_revision: candidate.sourceRevision,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return c.json({ dry_run: Boolean(body.dry_run), ...stats, errors: stats.errors, error_details: errorDetails });
    } catch (error) {
      return knowledgeError(c, error);
    }
  });
}

function requireAtlasActor(c: Parameters<typeof resolveKnowledgeWriteActor>[0], store: RouterDeps["store"]) {
  const actor = resolveKnowledgeWriteActor(c, store);
  if (actor.kind !== "agent" || !actor.canPublish) {
    throw new KnowledgeWritePolicyError("knowledge publish capability is required");
  }
  return actor;
}

function requirePublisherOrMember(c: Parameters<typeof resolveKnowledgeWriteActor>[0], store: RouterDeps["store"]): void {
  const actor = resolveKnowledgeWriteActor(c, store);
  if (actor.kind === "agent" && !actor.canPublish) {
    throw new KnowledgeWritePolicyError("knowledge publish capability is required");
  }
}

function requirePublishSubmissions(
  store: RouterDeps["store"],
  ids: unknown,
  target: { workspaceId: string; projectId?: string; repositoryId?: string; issueId?: string },
): MultiremiKnowledgeSubmission[] {
  if (!Array.isArray(ids) || ids.length === 0) throw new KnowledgeWritePolicyError("submission_ids is required", 400);
  return [...new Set(ids.map(String))].map((id) => {
    const submission = store.getKnowledgeSubmission(id);
    if (!submission) throw new KnowledgeWritePolicyError(`knowledge submission not found: ${id}`, 404);
    if (submission.workspaceId !== target.workspaceId
      || (target.projectId && submission.projectId !== target.projectId)
      || (target.repositoryId && submission.repositoryId !== target.repositoryId)) {
      throw new KnowledgeWritePolicyError(`knowledge submission scope mismatch: ${id}`, 409);
    }
    if (target.issueId && submission.sourceIssueId && submission.sourceIssueId !== target.issueId) {
      throw new KnowledgeWritePolicyError(`knowledge submission issue mismatch: ${id}`, 409);
    }
    if (submission.status !== "pending" && submission.status !== "processing") {
      throw new KnowledgeWritePolicyError(`knowledge submission is already processed: ${id}`, 409);
    }
    if (submission.scope === "repository_wiki"
      && (submission.sourceType === "agent" || submission.sourceType === "external")
      && submission.sourceRevision) {
      requireCommitSha(submission.sourceRevision, "source_revision");
    }
    const sourceTask = submission.sourceTaskId ? store.getTask(submission.sourceTaskId) : null;
    if (submission.sourceTaskId && !sourceTask) {
      throw new KnowledgeWritePolicyError(`source task not found: ${submission.sourceTaskId}`, 409);
    }
    const sourceIssue = submission.sourceIssueId ? store.getIssue(submission.sourceIssueId) : null;
    if (submission.sourceIssueId && !sourceIssue) {
      throw new KnowledgeWritePolicyError(`source issue not found: ${submission.sourceIssueId}`, 409);
    }
    if (sourceTask && sourceTask.workspaceId !== target.workspaceId) {
      throw new KnowledgeWritePolicyError(`source task workspace mismatch: ${sourceTask.id}`, 409);
    }
    if (sourceTask?.issueId && submission.sourceIssueId && sourceTask.issueId !== submission.sourceIssueId) {
      throw new KnowledgeWritePolicyError(`source task and issue mismatch: ${sourceTask.id}`, 409);
    }
    if (target.issueId && sourceTask?.issueId && sourceTask.issueId !== target.issueId) {
      throw new KnowledgeWritePolicyError(`source task issue mismatch: ${sourceTask.id}`, 409);
    }
    if (target.projectId && sourceIssue && sourceIssue.projectId !== target.projectId) {
      throw new KnowledgeWritePolicyError(`source issue project mismatch: ${sourceIssue.id}`, 409);
    }
    if (target.repositoryId && sourceTask) {
      const task = store.getTaskWithAgent(sourceTask.id);
      if (!task || !resolveTaskRepositoryWikiRepositories(store, task).some((repository) => repository.id === target.repositoryId)) {
        throw new KnowledgeWritePolicyError(`source task repository mismatch: ${sourceTask.id}`, 409);
      }
    }
    const sourceTaskRevision = sourceTask ? resolveTaskSourceRevision(store, sourceTask) : null;
    if (submission.sourceRevision && sourceTaskRevision && submission.sourceRevision !== sourceTaskRevision) {
      throw new KnowledgeWritePolicyError(`source revision mismatch: ${submission.id}`, 409);
    }
    return submission;
  });
}

function compiledSourceRevision(actorRevision: string | null, submissions: MultiremiKnowledgeSubmission[]): string | null {
  if (actorRevision) return actorRevision;
  const revisions = [...new Set(submissions.map((submission) => clean(submission.sourceRevision)).filter((value): value is string => Boolean(value)))];
  return revisions.length === 1 ? revisions[0]! : null;
}

function publishOutputs(body: PublishBody): PublishOutputBody[] {
  const outputs = Array.isArray(body.outputs) ? body.outputs : body.output ? [body.output] : [];
  if (outputs.length === 0) throw new KnowledgeWritePolicyError("outputs is required", 400);
  if (outputs.length > 50) throw new KnowledgeWritePolicyError("outputs must contain 50 entries or fewer", 400);
  return outputs;
}

async function preflightProjectOutputs(
  service: RouterDeps["projectKnowledge"],
  projectId: string,
  outputs: PublishOutputBody[],
): Promise<void> {
  for (const output of outputs) {
    const action = normalizeAction(output.action);
    if (action === "reject" || action === "noop") continue;
    if (action === "create" || action === "split") {
      if (!String(output.title ?? "").trim()) throw new KnowledgeWritePolicyError("output title is required", 400);
      normalizeProjectWikiPath(output.path ?? `${String(output.slug ?? output.title)}.md`);
      continue;
    }
    const current = await service.getProjectDocByRef(projectId, requireRef(output));
    if (!current) throw new KnowledgeWritePolicyError(`project doc not found: ${requireRef(output)}`, 404);
    const expected = output.expectedVersion ?? output.expected_version;
    if (expected == null || Number(expected) !== current.version) {
      throw new KnowledgeWritePolicyError(`project doc version conflict: ${requireRef(output)}`, 409);
    }
    if (output.path != null) normalizeProjectWikiPath(output.path);
  }
}

async function preflightRepositoryOutputs(
  service: RouterDeps["repositoryWiki"],
  workspaceId: string,
  repositoryId: string,
  outputs: PublishOutputBody[],
): Promise<void> {
  for (const output of outputs) {
    const action = normalizeAction(output.action);
    if (action === "reject" || action === "noop") continue;
    if (action === "create" || action === "split") {
      if (!String(output.title ?? "").trim()) throw new KnowledgeWritePolicyError("output title is required", 400);
      normalizeRepositoryWikiPath(output.path ?? output.slug ?? `${String(output.title)}.md`);
      continue;
    }
    const current = await service.get(workspaceId, repositoryId, requireRef(output));
    if (!current) throw new KnowledgeWritePolicyError(`repository wiki doc not found: ${requireRef(output)}`, 404);
    const expected = output.expectedVersion ?? output.expected_version;
    if (expected == null || Number(expected) !== current.version) {
      throw new KnowledgeWritePolicyError(`repository wiki version conflict: ${requireRef(output)}`, 409);
    }
    if (output.path != null) normalizeRepositoryWikiPath(output.path);
  }
}

async function assertProjectLinks(
  service: RouterDeps["projectKnowledge"],
  projectId: string,
  body: string,
  batchRefs: Set<string>,
): Promise<void> {
  for (const ref of wikiLinks(body)) {
    if (batchRefs.has(ref)) continue;
    if (!await service.getProjectDocByRef(projectId, ref)) {
      throw new KnowledgeWritePolicyError(`unresolved wiki link: [[${ref}]]`, 409);
    }
  }
}

async function assertRepositoryLinks(
  service: RouterDeps["repositoryWiki"],
  workspaceId: string,
  repositoryId: string,
  body: string,
  batchRefs: Set<string>,
): Promise<void> {
  for (const ref of wikiLinks(body)) {
    if (batchRefs.has(ref)) continue;
    if (!await service.get(workspaceId, repositoryId, ref)) {
      throw new KnowledgeWritePolicyError(`unresolved wiki link: [[${ref}]]`, 409);
    }
  }
}

function finalizePublishSources(
  store: RouterDeps["store"],
  submissions: MultiremiKnowledgeSubmission[],
  outputs: PublishOutputBody[],
): void {
  const hasFormal = outputs.some((output) => {
    const action = normalizeAction(output.action);
    return action !== "reject" && action !== "noop";
  });
  const hasReject = outputs.some((output) => normalizeAction(output.action) === "reject");
  const status = hasFormal && hasReject ? "partial" : hasFormal ? "consumed" : hasReject ? "rejected" : "archived";
  for (const submission of submissions) store.updateKnowledgeSubmissionStatus(submission.id, status);
}

function projectOutputRefs(output: PublishOutputBody): string[] {
  const title = clean(output.title);
  const generatedSlug = title ? projectDocSlug(clean(output.slug), title, "") : null;
  const values = [clean(output.slug), generatedSlug, clean(output.path)?.replace(/\.md$/i, "")];
  return values.filter((value): value is string => Boolean(value));
}

function repositoryOutputRefs(output: PublishOutputBody): string[] {
  const path = clean(output.path ?? output.slug);
  return path ? [path, path.replace(/\.md$/i, "")] : [];
}

function wikiLinks(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]\n]+)\]\]/g)]
    .map((match) => match[1]!.trim())
    .filter(Boolean);
}

function normalizeAction(value: unknown): MultiremiKnowledgeCompilationAction {
  const action = String(value ?? "create");
  if (action === "create" || action === "update" || action === "merge" || action === "split"
    || action === "reject" || action === "noop") return action;
  throw new KnowledgeWritePolicyError(`unknown compilation action: ${action}`, 400);
}

function requireRef(output: PublishOutputBody): string {
  const ref = clean(output.ref);
  if (!ref) throw new KnowledgeWritePolicyError("output ref is required", 400);
  return ref;
}

function requireDedupeKey(value: unknown): string {
  const key = clean(value);
  if (!key) throw new KnowledgeWritePolicyError("dedupe_key is required", 400);
  return key;
}

function normalizeScope(value: unknown): MultiremiKnowledgeScope {
  const scope = String(value ?? "");
  if (scope === "project_wiki" || scope === "repository_wiki" || scope === "memory") return scope;
  throw new KnowledgeWritePolicyError("scope must be project_wiki, repository_wiki, or memory", 400);
}

function submissionResponse(
  store: RouterDeps["store"],
  submission: MultiremiKnowledgeSubmission,
): Record<string, unknown> {
  const issue = submission.sourceIssueId ? store.getIssue(submission.sourceIssueId) : null;
  const agent = submission.authorAgentId ? store.getAgent(submission.authorAgentId) : null;
  const task = submission.sourceTaskId ? store.getTask(submission.sourceTaskId) : null;
  return {
    id: submission.id,
    workspace_id: submission.workspaceId,
    project_id: submission.projectId,
    repository_id: submission.repositoryId,
    scope: submission.scope,
    source_type: submission.sourceType,
    proposed_path: submission.proposedPath,
    proposed_slug: submission.proposedSlug,
    body: submission.body,
    patch: submission.patch,
    base_revision: submission.baseRevision,
    source_task_id: submission.sourceTaskId,
    source_issue_id: submission.sourceIssueId,
    source_revision: submission.sourceRevision,
    author_agent_id: submission.authorAgentId,
    content_sha256: submission.contentSha256,
    status: submission.status,
    created_at: submission.createdAt,
    updated_at: submission.updatedAt,
    source_issue: issue ? { id: issue.id, key: issue.key, title: issue.title } : null,
    author_agent: agent ? { id: agent.id, name: agent.name } : null,
    source_task: task ? { id: task.id, status: task.status } : null,
  };
}

function runResponse(
  store: RouterDeps["store"],
  run: NonNullable<ReturnType<RouterDeps["store"]["getKnowledgeCompilationRun"]>>,
): Record<string, unknown> {
  const agent = run.agentId ? store.getAgent(run.agentId) : null;
  return {
    id: run.id,
    workspace_id: run.workspaceId,
    project_id: run.projectId,
    repository_id: run.repositoryId,
    task_id: run.taskId,
    agent_id: run.agentId,
    autopilot_run_id: run.autopilotRunId,
    mode: run.mode,
    status: run.status,
    result_summary: run.resultSummary,
    dedupe_key: run.dedupeKey,
    created_at: run.createdAt,
    completed_at: run.completedAt,
    agent: agent ? { id: agent.id, name: agent.name } : null,
    skill_names: agent ? agentKnowledgePublishPluginNames(store, agent) : [],
  };
}

function runDetailResponse(
  store: RouterDeps["store"],
  run: NonNullable<ReturnType<RouterDeps["store"]["getKnowledgeCompilationRun"]>>,
): Record<string, unknown> {
  const repositoryDocs = run.repositoryId
    ? store.listRepositoryWikiDocs(run.workspaceId, run.repositoryId)
    : [];
  return {
    run: runResponse(store, run),
    sources: store.listKnowledgeRunSources(run.id).map((source) => {
      const submission = source.submissionId
        ? store.getKnowledgeSubmission(source.submissionId)
        : null;
      return {
        id: source.id,
        run_id: source.runId,
        submission_id: source.submissionId,
        source_type: source.sourceType,
        source_ref: source.sourceRef,
        metadata: source.metadata,
        created_at: source.createdAt,
        submission: submission ? submissionResponse(store, submission) : null,
      };
    }),
    outputs: store.listKnowledgeRunOutputs(run.id).map((output) => {
      const doc = output.docId
        ? output.artifactScope === "repository_wiki"
          ? repositoryDocs.find((candidate) => candidate.id === output.docId)
          : store.getProjectDoc(output.docId)
        : null;
      return {
        id: output.id,
        run_id: output.runId,
        artifact_scope: output.artifactScope,
        doc_id: output.docId,
        revision_id: output.revisionId,
        version: output.version,
        action: output.action,
        content_sha256: output.contentSha256,
        created_at: output.createdAt,
        artifact: doc ? {
          id: doc.id,
          title: doc.title,
          path: doc.path,
        } : null,
      };
    }),
  };
}

function knowledgeWorkspaceId(c: Parameters<typeof currentAccessToken>[0], requested: unknown): string {
  return currentAccessToken(c)?.workspaceId ?? clean(requested) ?? "local";
}

function hasRepository(store: RouterDeps["store"], workspaceId: string, repositoryId: string): boolean {
  return listWorkspaceRepositories(store, workspaceId).some((repository) => repository.id === repositoryId);
}

function requireCommitSha(value: unknown, field: string): string {
  const sha = required(value, field);
  if (!/^[a-f0-9]{7,64}$/i.test(sha)) throw new KnowledgeWritePolicyError(`${field} is not a valid commit SHA`, 400);
  return sha;
}

function required(value: unknown, field: string): string {
  const text = clean(value);
  if (!text) throw new KnowledgeWritePolicyError(`${field} is required`, 400);
  return text;
}

function clean(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function optionalInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

function knowledgeError(c: Parameters<typeof knowledgePolicyErrorResponse>[0], error: unknown): Response {
  const policy = knowledgePolicyErrorResponse(c, error);
  if (policy) return policy;
  const message = error instanceof Error ? error.message : "knowledge request failed";
  if (/not found/i.test(message)) return c.json({ error: message }, 404);
  if (/conflict|duplicate|already/i.test(message)) return c.json({ error: message }, 409);
  return c.json({ error: message }, 400);
}

import { resolveRequestWorkspaceId } from "../helpers/workspace-context.js";
import type { Hono } from "hono";
import type {
  CreateProjectDocInput,
  CreateRepositoryWikiDocInput,
  MultiremiKnowledgeCompilationAction,
  MultiremiKnowledgeScope,
  MultiremiKnowledgeSubmission,
  RepositoryWikiBatchOperation,
  RepositoryWikiBatchResult,
  UpdateProjectDocInput,
  UpdateRepositoryWikiDocInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";
import {
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  readJsonStrict,
  requireWorkspaceAdmin,
} from "../helpers.js";
import {
  assertProjectKnowledgeTarget,
  assertRepositoryKnowledgeTarget,
  createFormalWriteRun,
  KnowledgeWritePolicyError,
  linkSeededProjectSchema,
  knowledgePolicyErrorResponse,
  resolveKnowledgeWriteActor,
  resolveTaskSourceRevision,
} from "../helpers/knowledge.js";
import { listWorkspaceRepositories } from "../helpers/repositories.js";
import { normalizeProjectWikiPath, projectDocSlug } from "@multiremi/store/repos/projects-repo.js";
import { normalizeRepositoryWikiPath } from "@multiremi/store/repos/repository-wiki-repo.js";
import { sha256Text } from "@multiremi/project-knowledge/codec.js";
import { resolveTaskRepositoryWikiRepositories } from "@multiremi/repository-wiki/task-scope.js";
import { autopilotRunTriggerSummary } from "../wire/autopilots.js";
import { createId } from "@multiremi/ids.js";
import { assertRepositoryWikiPathChangesReadable, REPOSITORY_WIKI_BATCH_LIMIT, RepositoryWikiLogHistoryError, RepositoryWikiLogRepairConflictError, RepositoryWikiLogRepairInputError, RepositoryWikiUnavailableError, RepositoryWikiRestoreConflictError, RepositoryWikiRestoreInputError, type RepositoryWikiRestoreTarget, type RepositoryWikiRestoreResult } from "@multiremi/repository-wiki/service.js";
import { authenticatedRequestUserId } from "../wire/index.js";
import { RepositoryWikiOutcomeConflictError } from "@multiremi/store/repos/knowledge-repo.js";
import type { RepositoryWikiOutcomeStatus } from "@multiremi/store/repository-wiki-outcome.js";
import { resolveProjectWikiRef, tokenizeWikiLinks } from "@multiremi/contracts/wiki-links";
import {
  assertNoIntroducedRepositoryWikiLinks,
  defaultRepositoryWikiPath,
  repositoryWikiGraphWithUpserts,
  RepositoryWikiLinkValidationError,
  type RepositoryWikiGraphDoc,
} from "@multiremi/repository-wiki/links.js";

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

  app.post("/api/workspaces/:id/repos/:repositoryId/wiki/outcome", async (c) => {
    const workspaceId = c.req.param("id");
    const repositoryId = c.req.param("repositoryId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (!hasRepository(store, workspaceId, repositoryId)) return c.json({ error: "repository not found" }, 404);
    const body = await readJsonStrict<{ outcome?: unknown; reason?: unknown }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const actor = requireAtlasActor(c, store);
      assertRepositoryKnowledgeTarget(actor, store, repositoryId);
      if (Object.keys(body).some(key => key !== "outcome" && key !== "reason")) {
        return c.json({ error: "outcome accepts only outcome and reason; task/run identity comes from the credential" }, 400);
      }
      if (typeof body.outcome !== "string" || !["published", "published_with_warnings", "noop", "blocked"].includes(body.outcome)) {
        return c.json({ error: "outcome must be published, published_with_warnings, noop, or blocked" }, 400);
      }
      if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 4000) {
        return c.json({ error: "reason must be non-empty and at most 4000 characters" }, 400);
      }
      const result = store.reportRepositoryWikiOutcome({
        workspaceId, repositoryId, taskId: actor.task!.id, agentId: actor.agent!.id,
        autopilotRunId: actor.task!.autopilotRunId, status: body.outcome as RepositoryWikiOutcomeStatus,
        reason: body.reason.trim(),
      });
      return c.json({ run: runResponse(store, result.run), deduplicated: result.deduplicated });
    } catch (error) {
      if (error instanceof RepositoryWikiOutcomeConflictError) return c.json({ error: error.message }, 409);
      return knowledgeError(c, error);
    }
  });

  const migrateRepository = async (c: Parameters<typeof resolveKnowledgeWriteActor>[0], kind: "move" | "merge") => {
    const workspaceId = c.req.param("id")!;
    const repositoryId = c.req.param("repositoryId")!;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (!hasRepository(store, workspaceId, repositoryId)) return c.json({ error: "repository not found" }, 404);
    const body = await readJsonStrict<{ ref?: string; path?: string; target?: string; sources?: string[]; expected_version?: number }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    let runId: string | null = null;
    try {
      const actor = resolveKnowledgeWriteActor(c, store);
      assertRepositoryKnowledgeTarget(actor, store, repositoryId);
      requirePublisherOrMember(c, store);
      const options = {
        expectedVersion: body.expected_version,
        updatedByType: actor.kind,
        updatedById: actor.agent?.id ?? authenticatedRequestUserId(c),
      };
      const ref = required(kind === "move" ? body.ref : body.target, kind === "move" ? "ref" : "target");
      if (kind === "merge" && (!Array.isArray(body.sources) || !body.sources.length || body.sources.some(ref => typeof ref !== "string" || !ref.trim()))) {
        throw new KnowledgeWritePolicyError("sources must contain document references", 400);
      }
      const path = kind === "move" ? normalizeRepositoryWikiPath(required(body.path, "path")) : "";
      runId = createFormalWriteRun({ store, actor, workspaceId, repositoryId, scope: "repository_wiki" }).id;
      const results: RepositoryWikiBatchResult[] = kind === "move"
        ? await repositoryWiki.move(workspaceId, repositoryId, ref, path, options)
        : await repositoryWiki.merge(workspaceId, repositoryId, ref, body.sources!, options);
      for (const result of results) {
        const output = { runId, artifactScope: "repository_wiki" as const, docId: result.doc.id,
          version: result.doc.version, contentSha256: result.doc.contentSha256 ?? sha256Text(result.doc.body) };
        if (result.kind === "delete") store.recordKnowledgeCompilationOutput({ ...output, action: "reject" });
        else store.linkKnowledgeFormalVersion({ ...output, action: kind === "merge" ? "merge" : "update" });
      }
      const run = store.completeKnowledgeCompilationRun(runId, "published", `${kind}: ${results.length} document(s)`);
      return c.json({ run: runResponse(store, run), results: results.map(({ kind, doc }) => ({ kind, doc: {
        id: doc.id, path: doc.path, title: doc.title, body: doc.body, version: doc.version, compilation_run_id: runId,
      } })) });
    } catch (error) {
      if (runId) store.completeKnowledgeCompilationRun(runId, "failed", error instanceof Error ? error.message : "migration failed");
      return knowledgeError(c, error);
    }
  };
  app.post("/api/workspaces/:id/repos/:repositoryId/wiki/move", c => migrateRepository(c, "move"));
  app.post("/api/workspaces/:id/repos/:repositoryId/wiki/merge", c => migrateRepository(c, "merge"));

  app.post("/api/workspaces/:id/repos/:repositoryId/wiki/restore", async c => {
    const workspaceId = c.req.param("id");
    const repositoryId = c.req.param("repositoryId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    let runId: string | null = null;
    let audit: Record<string, unknown> = {};
    try {
      const actor = resolveKnowledgeWriteActor(c, store);
      assertRepositoryKnowledgeTarget(actor, store, repositoryId);
      if (actor.task) requirePublisherOrMember(c, store);
      else {
        const adminDenied = requireWorkspaceAdmin(c, store, workspaceId);
        if (adminDenied) return adminDenied;
      }
      if (!hasRepository(store, workspaceId, repositoryId)) return c.json({ error: "repository not found" }, 404);
      const body = await readJsonStrict<{ targets: RepositoryWikiRestoreTarget[]; dry_run?: boolean }>(c);
      if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
      if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
        throw new KnowledgeWritePolicyError("dry_run must be a boolean", 400);
      }
      const dryRun = body.dry_run !== false;
      audit = { operation: "repository_wiki_restore", dry_run: dryRun, targets: body.targets,
        actor: { kind: actor.kind, user_id: authenticatedRequestUserId(c),
          task_id: actor.task?.id ?? null, agent_id: actor.agent?.id ?? null } };
      runId = createFormalWriteRun({ store, actor, workspaceId, repositoryId, scope: "repository_wiki" }).id;
      store.completeKnowledgeCompilationRun(runId, "validating", JSON.stringify(audit));
      const report = await repositoryWiki.restore(workspaceId, repositoryId, body.targets, {
        dryRun, auditId: runId,
        onProgress: (results: RepositoryWikiRestoreResult[]) => {
          audit = { ...audit, results };
          store.completeKnowledgeCompilationRun(runId!, "validating", JSON.stringify(audit));
        },
      });
      // Storage recovery is not a new publication. Do not relink the formal
      // version or count this maintenance operation as published content.
      const run = store.completeKnowledgeCompilationRun(runId, "noop", JSON.stringify({ ...audit, ...report }));
      return c.json({ ...report, run: runResponse(store, run) });
    } catch (error) {
      if (runId) store.completeKnowledgeCompilationRun(runId, "failed", JSON.stringify({
        ...audit, error: error instanceof Error ? error.message : "restore failed",
      }));
      return knowledgeError(c, error);
    }
  });

  app.post("/api/workspaces/:id/repos/:repositoryId/wiki/repair-log", async c => {
    const workspaceId = c.req.param("id");
    const repositoryId = c.req.param("repositoryId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    let runId: string | null = null;
    let audit: Record<string, unknown> = {};
    try {
      const actor = resolveKnowledgeWriteActor(c, store);
      assertRepositoryKnowledgeTarget(actor, store, repositoryId);
      if (actor.task) requirePublisherOrMember(c, store);
      else {
        const adminDenied = requireWorkspaceAdmin(c, store, workspaceId);
        if (adminDenied) return adminDenied;
      }
      if (!hasRepository(store, workspaceId, repositoryId)) return c.json({ error: "repository not found" }, 404);
      const body = await readJsonStrict<{
        body?: unknown;
        expected_version?: unknown;
        expected_body_sha256?: unknown;
        reason?: unknown;
      }>(c);
      if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
      if (typeof body.body !== "string") throw new RepositoryWikiLogRepairInputError("Log repair body must be a string");
      const expectedVersion = Number(body.expected_version);
      const expectedBodySha256 = String(body.expected_body_sha256 ?? "");
      const reason = String(body.reason ?? "").trim();
      audit = {
        operation: "repository_wiki_log_repair",
        reason,
        expected_version: expectedVersion,
        expected_body_sha256: expectedBodySha256,
        actor: {
          kind: actor.kind,
          user_id: authenticatedRequestUserId(c),
          task_id: actor.task?.id ?? null,
          agent_id: actor.agent?.id ?? null,
        },
      };
      runId = createFormalWriteRun({ store, actor, workspaceId, repositoryId, scope: "repository_wiki" }).id;
      store.completeKnowledgeCompilationRun(runId, "validating", JSON.stringify(audit));
      const report = await repositoryWiki.repairLog(workspaceId, repositoryId, {
        body: body.body,
        expectedVersion,
        expectedBodySha256,
        reason,
        updatedByType: actor.kind,
        updatedById: actor.agent?.id ?? authenticatedRequestUserId(c),
        sourceRevision: `repository_wiki_log_repair:${runId}`,
      });
      store.linkKnowledgeFormalVersion({
        runId,
        artifactScope: "repository_wiki",
        docId: report.doc.id,
        version: report.doc.version,
        action: "update",
        contentSha256: report.doc.contentSha256 ?? sha256Text(report.doc.body),
      });
      audit = { ...audit, ...report.audit, doc_id: report.doc.id, path: report.doc.path };
      const run = store.completeKnowledgeCompilationRun(runId, "published", JSON.stringify(audit));
      return c.json({
        doc: {
          id: report.doc.id,
          repository_id: report.doc.repositoryId,
          workspace_id: report.doc.workspaceId,
          path: report.doc.path,
          title: report.doc.title,
          body: report.doc.body,
          version: report.doc.version,
          content_sha256: report.doc.contentSha256,
          sync_status: report.doc.syncStatus,
          compilation_run_id: report.doc.compilationRunId ?? null,
        },
        audit: report.audit,
        run: runResponse(store, run),
      });
    } catch (error) {
      if (runId) store.completeKnowledgeCompilationRun(runId, "failed", JSON.stringify({
        ...audit,
        error: error instanceof Error ? error.message : "log repair failed",
      }));
      return knowledgeError(c, error);
    }
  });

  app.post("/api/knowledge/submissions", async (c) => {
    const body = await readJsonStrict<KnowledgeSubmitBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const workspaceId = resolveRequestWorkspaceId(c, store, body.workspace_id);
      if (workspaceId instanceof Response) return workspaceId;
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
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const page = store.listKnowledgeSubmissionsPage({
        workspaceId,
        projectId: clean(c.req.query("project_id")),
        repositoryId: clean(c.req.query("repository_id")),
        scope: clean(c.req.query("scope")),
        status: clean(c.req.query("status")),
        cursor: clean(c.req.query("cursor")),
        limit: optionalInt(c.req.query("limit")),
      });
      return c.json({
        submissions: page.items.map((submission) => submissionResponse(store, submission)),
        next_cursor: page.nextCursor,
        applied_filters: {
          workspace_id: workspaceId, project_id: clean(c.req.query("project_id")),
          repository_id: clean(c.req.query("repository_id")), scope: clean(c.req.query("scope")),
          status: clean(c.req.query("status")), combination: "intersection",
        },
      });
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
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const page = store.listKnowledgeCompilationRunsPage({
        workspaceId,
        projectId: clean(c.req.query("project_id")),
        repositoryId: clean(c.req.query("repository_id")),
        status: clean(c.req.query("status")),
        cursor: clean(c.req.query("cursor")),
        limit: optionalInt(c.req.query("limit")),
      });
      const repositories = new Map(
        listWorkspaceRepositories(store, workspaceId).map((repository) => [repository.id, repository]),
      );
      const repositoryDocs = new Map<string, ReturnType<typeof store.listRepositoryWikiDocs>>();
      return c.json({
        runs: page.items.map((run) => {
          const docs = run.repositoryId
            ? repositoryDocs.get(run.repositoryId)
              ?? store.listRepositoryWikiDocs(run.workspaceId, run.repositoryId)
            : [];
          if (run.repositoryId && !repositoryDocs.has(run.repositoryId)) repositoryDocs.set(run.repositoryId, docs);
          const detail = runRelationshipsResponse(store, run, { repositoryDocs: docs, includeSubmissions: false });
          return {
            ...runResponse(store, run, (repositoryId) => repositories.get(repositoryId)?.name ?? null),
            sources: detail.sources,
            outputs: detail.outputs,
          };
        }),
        next_cursor: page.nextCursor,
      });
    } catch (error) {
      return knowledgeError(c, error);
    }
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
      const projectDocs = await projectKnowledge.listProjectDocs(project.id);
      for (const output of outputs) {
        assertProjectLinks(projectDocs, clean(output.path) ?? "index.md", String(output.body ?? ""), batchRefs);
      }
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
      const outputs = publishOutputs(body, REPOSITORY_WIKI_BATCH_LIMIT);
      const submissions = requirePublishSubmissions(store, body.submission_ids, {
        workspaceId,
        repositoryId,
        issueId: actor.issue?.id,
      });
      const plannedOutputs = await preflightRepositoryOutputs(repositoryWiki, workspaceId, repositoryId, outputs);
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
      const sourceRevision = compiledSourceRevision(actor.sourceRevision, submissions);
      const active = plannedOutputs.filter(({ action }) => action !== "reject" && action !== "noop");
      const operations = active.map(({ output, action, document }): RepositoryWikiBatchOperation => {
        const stamped = {
          ...output,
          ...(document ? { id: document.id, path: document.path, body: document.body } : {}),
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
        return action === "create" || action === "split"
          ? { kind: "create", input: stamped }
          : { kind: "update", ref: document!.id, input: stamped };
      });
      const written = operations.length
        ? await repositoryWiki.applyBatch(workspaceId, repositoryId, operations)
        : [];
      let writtenIndex = 0;
      for (const planned of plannedOutputs) {
        const { action } = planned;
        if (action === "reject" || action === "noop") {
          store.recordKnowledgeCompilationOutput({ runId, artifactScope: "repository_wiki", action });
          continue;
        }
        const doc = written[writtenIndex++]!.doc;
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
      const workspaceId = resolveRequestWorkspaceId(c, store, body.workspace_id);
      if (workspaceId instanceof Response) return workspaceId;
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
      const workspaceId = resolveRequestWorkspaceId(c, store, body.workspace_id);
      if (workspaceId instanceof Response) return workspaceId;
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

function publishOutputs(body: PublishBody, limit = 50): PublishOutputBody[] {
  const outputs = Array.isArray(body.outputs) ? body.outputs : body.output ? [body.output] : [];
  if (outputs.length === 0) throw new KnowledgeWritePolicyError("outputs is required", 400);
  if (outputs.length > limit) throw new KnowledgeWritePolicyError(`outputs must contain ${limit} entries or fewer`, 400);
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
): Promise<PlannedRepositoryOutput[]> {
  const before = await service.list(workspaceId, repositoryId);
  const planned: PlannedRepositoryOutput[] = [];
  const mutatedIds = new Set<string>();
  for (const output of outputs) {
    const action = normalizeAction(output.action);
    if (action === "reject" || action === "noop") {
      planned.push({ output, action, document: null });
      continue;
    }
    if (action === "create" || action === "split") {
      if (!String(output.title ?? "").trim()) throw new KnowledgeWritePolicyError("output title is required", 400);
      const id = clean(output.id) ?? createId("rwdoc");
      const path = normalizeRepositoryWikiPath(output.path ?? output.slug ?? defaultRepositoryWikiPath(output.title, id));
      if (before.some((document) => document.id === id) || mutatedIds.has(id)) {
        throw new KnowledgeWritePolicyError(`repository wiki doc already exists: ${id}`, 409);
      }
      mutatedIds.add(id);
      planned.push({
        output,
        action,
        document: { id, path, body: String(output.body ?? "") },
      });
      continue;
    }
    const current = await service.get(workspaceId, repositoryId, requireRef(output));
    if (!current) throw new KnowledgeWritePolicyError(`repository wiki doc not found: ${requireRef(output)}`, 404);
    const beforeIndex = before.findIndex((document) => document.id === current.id);
    if (beforeIndex >= 0) before[beforeIndex] = current;
    const expected = output.expectedVersion ?? output.expected_version;
    if (expected == null || Number(expected) !== current.version) {
      throw new KnowledgeWritePolicyError(`repository wiki version conflict: ${requireRef(output)}`, 409);
    }
    if (mutatedIds.has(current.id)) {
      throw new KnowledgeWritePolicyError(`repository wiki doc appears more than once: ${current.id}`, 409);
    }
    if (output.title !== undefined && !String(output.title ?? "").trim()) {
      throw new KnowledgeWritePolicyError("output title is required", 400);
    }
    mutatedIds.add(current.id);
    const pathValue = output.path !== undefined
      ? output.path
      : output.slug !== undefined
        ? output.slug
        : current.path;
    planned.push({
      output,
      action,
      document: {
        id: current.id,
        path: normalizeRepositoryWikiPath(pathValue),
        body: output.body === undefined ? current.body : String(output.body ?? ""),
      },
    });
  }
  const after = repositoryWikiGraphWithUpserts(
    before,
    planned.flatMap((entry) => entry.document ? [entry.document] : []),
  );
  assertRepositoryWikiPathChangesReadable(before, after);
  assertUniqueRepositoryWikiPaths(after);
  try {
    assertNoIntroducedRepositoryWikiLinks(before, after);
  } catch (error) {
    if (error instanceof RepositoryWikiLinkValidationError) {
      throw new KnowledgeWritePolicyError(error.message, 409);
    }
    throw error;
  }
  return planned;
}

function assertProjectLinks(
  documents: Awaited<ReturnType<RouterDeps["projectKnowledge"]["listProjectDocs"]>>,
  sourcePath: string,
  body: string,
  batchRefs: Set<string>,
): void {
  for (const token of tokenizeWikiLinks(body)) {
    const ref = token.ref;
    if (ref === null) continue;
    if (batchRefs.has(ref)) continue;
    const resolution = resolveProjectWikiRef(ref, sourcePath, documents);
    if (resolution.status === "missing") {
      throw new KnowledgeWritePolicyError(`unresolved wiki link: [[${ref}]]`, 409);
    }
    if (resolution.status === "ambiguous") {
      throw new KnowledgeWritePolicyError(
        `ambiguous wiki link: [[${ref}]]; candidates: ${resolution.candidates.map((doc) => doc.path).join(", ")}`,
        409,
      );
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
  const path = clean(output.path);
  const values = [clean(output.id), clean(output.slug), generatedSlug, path, path?.replace(/\.md$/i, "")];
  return values.filter((value): value is string => Boolean(value));
}

interface PlannedRepositoryOutput {
  output: PublishOutputBody;
  action: MultiremiKnowledgeCompilationAction;
  document: RepositoryWikiGraphDoc | null;
}

function assertUniqueRepositoryWikiPaths(documents: readonly RepositoryWikiGraphDoc[]): void {
  const byPath = new Map<string, string>();
  for (const document of documents) {
    const existing = byPath.get(document.path);
    if (existing && existing !== document.id) {
      throw new KnowledgeWritePolicyError(`repository wiki path already exists: ${document.path}`, 409);
    }
    byPath.set(document.path, document.id);
  }
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
  resolveRepositoryName?: (repositoryId: string) => string | null,
): Record<string, unknown> {
  const agent = run.agentId ? store.getAgent(run.agentId) : null;
  const autopilotRun = run.autopilotRunId ? store.getAutopilotRun(run.autopilotRunId) : null;
  const autopilot = autopilotRun ? store.getAutopilot(autopilotRun.autopilotId) : null;
  const triggerSummary = autopilotRun
    ? autopilotRunTriggerSummary(autopilotRun, resolveRepositoryName)
    : null;
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
    provenance: autopilotRun ? {
      automation_id: autopilotRun.autopilotId,
      automation_title: autopilot?.title ?? null,
      automation_run_id: autopilotRun.id,
      automation_source: autopilotRun.source,
      event_type: triggerSummary?.event_type ?? null,
      repository_id: triggerSummary?.repository_id ?? run.repositoryId,
      repository_name: triggerSummary?.repository_name
        ?? (run.repositoryId ? resolveRepositoryName?.(run.repositoryId) ?? null : null),
      change_number: triggerSummary?.change_number ?? null,
      change_title: triggerSummary?.change_title ?? null,
      change_url: knowledgeChangeUrl(autopilotRun.payload),
      target_branch: triggerSummary?.target_branch ?? null,
      source_revision: triggerSummary?.source_revision ?? null,
      occurred_at: triggerSummary?.occurred_at ?? null,
    } : null,
  };
}

function runRelationshipsResponse(
  store: RouterDeps["store"],
  run: NonNullable<ReturnType<RouterDeps["store"]["getKnowledgeCompilationRun"]>>,
  options: {
    repositoryDocs?: ReturnType<RouterDeps["store"]["listRepositoryWikiDocs"]>;
    includeSubmissions?: boolean;
  } = {},
): { sources: Record<string, unknown>[]; outputs: Record<string, unknown>[] } {
  const repositoryDocs = options.repositoryDocs ?? (run.repositoryId
    ? store.listRepositoryWikiDocs(run.workspaceId, run.repositoryId)
    : []);
  return {
    sources: store.listKnowledgeRunSources(run.id).map((source) => {
      const submission = options.includeSubmissions !== false && source.submissionId
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

function runDetailResponse(
  store: RouterDeps["store"],
  run: NonNullable<ReturnType<RouterDeps["store"]["getKnowledgeCompilationRun"]>>,
): Record<string, unknown> {
  const repositories = new Map(
    listWorkspaceRepositories(store, run.workspaceId).map((repository) => [repository.id, repository]),
  );
  return {
    run: runResponse(store, run, (repositoryId) => repositories.get(repositoryId)?.name ?? null),
    ...runRelationshipsResponse(store, run),
  };
}

function knowledgeChangeUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const value = record.url ?? record.web_url ?? record.html_url ?? record.change_url;
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : null;
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
  if (error instanceof RepositoryWikiUnavailableError) return c.json({ error: message }, 503);
  if (error instanceof RepositoryWikiRestoreConflictError) return c.json({ error: message }, 409);
  if (error instanceof RepositoryWikiRestoreInputError) return c.json({ error: message }, 400);
  if (error instanceof RepositoryWikiLogRepairConflictError) return c.json({ error: message }, 409);
  if (error instanceof RepositoryWikiLogRepairInputError) return c.json({ error: message }, 400);
  if (error instanceof RepositoryWikiLogHistoryError) return c.json({ error: message }, 409);
  if (error instanceof RepositoryWikiLinkValidationError) return c.json({ error: message }, 409);
  if (/not found/i.test(message)) return c.json({ error: message }, 404);
  if (/conflict|duplicate|already/i.test(message)) return c.json({ error: message }, 409);
  return c.json({ error: message }, 400);
}

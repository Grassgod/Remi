import type { Hono } from "hono";
import {
  compatibilityWorkspaceId,
  denyCurrentUserWorkspaceAccess,
  denyTaskTokenProjectAccess,
  isJsonApiError,
  loadProjectForDocs,
  loadProjectForHumanMutation,
  loadProjectResourceForMutation,
  projectDocCreateInput,
  projectDocUpdateInput,
  publishProjectCreated,
  publishProjectDocCreated,
  publishProjectDocDeleted,
  publishProjectDocUpdated,
  publishProjectResourceCreated,
  publishProjectResourceDeleted,
  publishProjectResourceUpdated,
  publishProjectUpdated,
  readJsonStrict,
  validateProjectInstructions,
  validateProjectInstructionsUpdate,
  validateImportedProjectResources,
} from "../helpers.js";
import {
  cleanString,
  currentRequestUserId,
  currentTaskAccessToken,
  parseOptionalInt,
  projectCompatibilityResponse,
  projectCompatibilitySummaryResponse,
  projectCreateCompatibilityInput,
  projectCreateInputWithDefaultLead,
  projectDocCompatibilityResponse,
  projectDocErrorResponse,
  projectDocRevisionCompatibilityResponse,
  projectErrorResponse,
  projectNativeSummaryResponse,
  projectResourceCompatibilityResponse,
  projectResourceErrorResponse,
  projectSearchNativeResponse,
  projectSearchCompatibilityResponse,
  projectSearchErrorResponse,
  projectUpdateCompatibilityInput,
} from "../wire/index.js";
import type {
  CreateProjectDocInput,
  CreateProjectInput,
  CreateProjectResourceInput,
  UpdateProjectDocInput,
  UpdateProjectInput,
  UpdateProjectResourceInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";
import { ProjectKnowledgeUnavailableError } from "@multiremi/project-knowledge/service.js";
import { OpenVikingClientError } from "@multiremi/project-knowledge/openviking-client.js";

export function registerProjectRoutes(app: Hono, deps: RouterDeps): void {
  const { store, projectKnowledge } = deps;

  app.get("/api/multiremi/projects", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const projects = store.listProjects(workspaceId).map(projectNativeSummaryResponse);
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
    return c.json({
      projects: result.projects.map(projectSearchNativeResponse),
      total: result.total,
    });
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
      .map(projectCompatibilitySummaryResponse);
    return c.json({ projects, total: projects.length });
  });
  app.post("/api/projects", async (c) => {
    const body = await readJsonStrict<CreateProjectInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const invalidInstructions = validateProjectInstructions(c, body.instructions);
    if (invalidInstructions) return invalidInstructions;
    const invalidDeltaInstructions = validateProjectInstructions(
      c,
      body.deltaInstructions ?? body.delta_instructions,
      "delta_instructions",
    );
    if (invalidDeltaInstructions) return invalidDeltaInstructions;
    const projectInput = projectCreateCompatibilityInput(c, body);
    const denied = denyCurrentUserWorkspaceAccess(c, store, projectInput.workspaceId ?? "local");
    if (denied) return denied;
    const repositoryError = validateImportedProjectResources(
      store,
      projectInput.workspaceId ?? "local",
      projectInput.resources,
    );
    if (repositoryError) return c.json({ error: repositoryError }, 400);
    try {
      const project = store.createProject(projectInput, { instructionsUpdatedBy: currentRequestUserId(c) });
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
    const invalidInstructions = validateProjectInstructions(c, body.instructions);
    if (invalidInstructions) return invalidInstructions;
    const invalidDeltaInstructions = validateProjectInstructions(
      c,
      body.deltaInstructions ?? body.delta_instructions,
      "delta_instructions",
    );
    if (invalidDeltaInstructions) return invalidDeltaInstructions;
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
    const repositoryError = validateImportedProjectResources(
      store,
      body.workspaceId ?? body.workspace_id ?? "local",
      body.resources,
    );
    if (repositoryError) return c.json({ error: repositoryError }, 400);
    return c.json({
      project: store.createProject(projectCreateInputWithDefaultLead(c, body), {
        instructionsUpdatedBy: currentRequestUserId(c),
      }),
    }, 201);
  });
  app.get("/api/multiremi/projects/:id", (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    return c.json({ project, resources: store.listProjectResources(project.id) });
  });
  app.patch("/api/multiremi/projects/:id", async (c) => {
    const body = await readJsonStrict<UpdateProjectInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const project = loadProjectForHumanMutation(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    const invalidInstructions = validateProjectInstructionsUpdate(c, body);
    if (invalidInstructions) return invalidInstructions;
    try {
      return c.json({
        project: store.updateProject(project.id, body, {
          instructionsUpdatedBy: currentRequestUserId(c),
        }),
      });
    } catch (err) {
      const response = projectErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.delete("/api/multiremi/projects/:id", (c) => {
    return c.json({ project: store.archiveProject(c.req.param("id")) });
  });
  app.post("/api/multiremi/projects/:id/restore", (c) => {
    return c.json({ project: store.restoreProject(c.req.param("id")) });
  });
  app.get("/api/multiremi/projects/:id/resources", (c) => {
    const resources = store.listProjectResources(c.req.param("id"));
    return c.json({ resources, total: resources.length });
  });
  app.post("/api/multiremi/projects/:id/resources", async (c) => {
    const body = await readJsonStrict<CreateProjectResourceInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (isLocalDirectoryResourceInput(body)) return c.json({ error: localDirectoryRemovedError() }, 400);
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
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    return c.json(projectCompatibilityResponse(project));
  });
  app.put("/api/projects/:id", async (c) => {
    const body = await readJsonStrict<UpdateProjectInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const loadedProject = loadProjectForHumanMutation(c, store, c.req.param("id"));
    if (loadedProject instanceof Response) return loadedProject;
    const invalidInstructions = validateProjectInstructionsUpdate(c, body);
    if (invalidInstructions) return invalidInstructions;
    try {
      const project = store.updateProject(loadedProject.id, projectUpdateCompatibilityInput(body), {
        instructionsUpdatedBy: currentRequestUserId(c),
      });
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
    const archived = store.archiveProject(project.id);
    publishProjectUpdated(c, store, archived, projectCompatibilityResponse(archived));
    return c.body(null, 204);
  });
  app.post("/api/projects/:id/restore", (c) => {
    const project = store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    const restored = store.restoreProject(project.id);
    const response = projectCompatibilityResponse(restored);
    publishProjectUpdated(c, store, restored, response);
    return c.json(response);
  });
  app.get("/api/projects/:id/resources", (c) => {
    const resources = store.listProjectResources(c.req.param("id")).map(projectResourceCompatibilityResponse);
    return c.json({ resources, total: resources.length });
  });
  app.post("/api/projects/:id/resources", async (c) => {
    const body = await readJsonStrict<CreateProjectResourceInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (isLocalDirectoryResourceInput(body)) return c.json({ error: localDirectoryRemovedError() }, 400);
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
  app.get("/api/projects/:id/docs", async (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    const query = cleanString(c.req.query("q"));
    const kind = cleanString(c.req.query("kind"));
    try {
      const docs = query
        ? await projectKnowledge.searchProjectDocs(project.id, query, { kind, limit: parseOptionalInt(c.req.query("limit")) })
        : await projectKnowledge.listProjectDocs(project.id, { kind });
      return c.json({ docs: docs.map(projectDocCompatibilityResponse) });
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err) ?? projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.post("/api/projects/:id/docs", async (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    const body = await readJsonStrict<CreateProjectDocInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const doc = await projectKnowledge.createProjectDoc(project.id, projectDocCreateInput(c, store, body));
      const response = projectDocCompatibilityResponse(doc);
      publishProjectDocCreated(c, store, doc, response);
      return c.json({ doc: response }, 201);
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err) ?? projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.get("/api/projects/:id/docs/:ref", async (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    try {
      const doc = await projectKnowledge.getProjectDocByRef(project.id, c.req.param("ref"));
      if (!doc) return c.json({ error: "project doc not found" }, 404);
      return c.json({ doc: projectDocCompatibilityResponse(doc) });
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err) ?? projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.put("/api/projects/:id/docs/:ref", async (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    const body = await readJsonStrict<UpdateProjectDocInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const doc = await projectKnowledge.updateProjectDoc(project.id, c.req.param("ref"), projectDocUpdateInput(c, body));
      const response = projectDocCompatibilityResponse(doc);
      publishProjectDocUpdated(c, store, doc, response);
      return c.json({ doc: response });
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err) ?? projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.delete("/api/projects/:id/docs/:ref", async (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    try {
      // Read the doc before deleting it: the WS payload needs its id and workspace.
      const doc = await projectKnowledge.getProjectDocByRef(project.id, c.req.param("ref"));
      if (!doc) return c.json({ error: "project doc not found" }, 404);
      await projectKnowledge.deleteProjectDoc(project.id, c.req.param("ref"), {
        expectedVersion: parseOptionalInt(c.req.query("expected_version")),
      });
      publishProjectDocDeleted(c, store, doc);
      return c.json({ deleted: true });
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err) ?? projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.get("/api/projects/:id/docs/:ref/revisions", async (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    try {
      const revisions = await projectKnowledge.listProjectDocRevisions(project.id, c.req.param("ref"));
      return c.json({ revisions: revisions.map(projectDocRevisionCompatibilityResponse) });
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err) ?? projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.get("/api/projects/:id/docs/:ref/backlinks", async (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    try {
      const docs = await projectKnowledge.backlinks(project.id, c.req.param("ref"));
      return c.json({ docs: docs.map(projectDocCompatibilityResponse) });
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err) ?? projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.get("/api/projects/:id/knowledge/recall", async (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    const query = cleanString(c.req.query("q"));
    if (!query) return c.json({ error: "q is required" }, 400);
    try {
      const hits = await projectKnowledge.recallProjectDocs(project.id, query, {
        kind: cleanString(c.req.query("kind")),
        limit: parseOptionalInt(c.req.query("limit")),
      });
      return c.json({
        hits: hits.map((hit) => projectKnowledgeRecallResponse(hit)),
      });
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err) ?? projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.get("/api/project-docs", async (c) => {
    const workspaceId = compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    // A task token is project-scoped (denyTaskTokenProjectAccess); this flat
    // workspace-wide listing would silently widen it, so reject it outright.
    if (currentTaskAccessToken(c)?.taskId) return c.json({ error: "forbidden" }, 403);
    try {
      const docs = await projectKnowledge.listWorkspaceDocs(workspaceId, {
        kind: cleanString(c.req.query("kind")),
        q: cleanString(c.req.query("q")),
        limit: parseOptionalInt(c.req.query("limit")),
      });
      return c.json({
        docs: docs.map((doc) => ({ ...projectDocCompatibilityResponse(doc), project_title: doc.projectTitle })),
      });
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err) ?? projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });

  app.get("/api/project-knowledge/migration", async (c) => {
    const workspaceId = compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (currentTaskAccessToken(c)?.taskId) return c.json({ error: "forbidden" }, 403);
    return c.json(await projectKnowledge.migrationStatus(workspaceId));
  });
  app.post("/api/project-knowledge/migration/backfill", async (c) => {
    const body = await readJsonStrict<{ workspace_id?: string; project_id?: string | null; dry_run?: boolean; resume?: boolean }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = cleanString(body.workspace_id) ?? compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (currentTaskAccessToken(c)?.taskId) return c.json({ error: "forbidden" }, 403);
    try {
      return c.json(await projectKnowledge.backfill(workspaceId, {
        projectId: cleanString(body.project_id),
        dryRun: Boolean(body.dry_run),
        resume: Boolean(body.resume),
      }));
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.post("/api/project-knowledge/migration/verify", async (c) => {
    const body = await readJsonStrict<{ workspace_id?: string; project_id?: string | null }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = cleanString(body.workspace_id) ?? compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (currentTaskAccessToken(c)?.taskId) return c.json({ error: "forbidden" }, 403);
    try {
      return c.json(await projectKnowledge.verify(workspaceId, cleanString(body.project_id)));
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.post("/api/project-knowledge/migration/retry-failed", async (c) => {
    const body = await readJsonStrict<{ workspace_id?: string; project_id?: string | null }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = cleanString(body.workspace_id) ?? compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (currentTaskAccessToken(c)?.taskId) return c.json({ error: "forbidden" }, 403);
    try {
      return c.json(await projectKnowledge.backfill(workspaceId, {
        projectId: cleanString(body.project_id),
        statuses: ["failed"],
      }));
    } catch (err) {
      const response = projectKnowledgeErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
}

function projectKnowledgeRecallResponse(hit: {
  doc: Parameters<typeof projectDocCompatibilityResponse>[0];
  score: number | null;
  snippet: string | null;
  uri: string;
}): Record<string, unknown> {
  const response = projectDocCompatibilityResponse(hit.doc);
  delete response.body;
  return { ...response, score: hit.score, snippet: hit.snippet, uri: hit.uri };
}

function projectKnowledgeErrorResponse(c: any, err: unknown): Response | null {
  if (err instanceof ProjectKnowledgeUnavailableError) return c.json({ error: err.message }, 503);
  if (err instanceof OpenVikingClientError) {
    if (err.status === 409 || err.status === 412) return c.json({ error: "project doc version conflict" }, 409);
    return c.json({ error: "OpenViking is unavailable", code: err.code }, err.retryable ? 503 : 502);
  }
  if (err instanceof Error && err.message === "a doc with this slug already exists") {
    return c.json({ error: err.message }, 409);
  }
  return null;
}

function isLocalDirectoryResourceInput(input: CreateProjectResourceInput): boolean {
  return (input.resourceType ?? input.resource_type) === "local_directory";
}

function localDirectoryRemovedError(): string {
  return "local_directory resources are no longer supported; import a Git repository instead";
}

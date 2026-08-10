import type { Hono } from "hono";
import {
  compatibilityWorkspaceId,
  denyCurrentUserWorkspaceAccess,
  denyTaskTokenProjectAccess,
  isJsonApiError,
  loadProjectForDocs,
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
  validateImportedProjectResources,
} from "../helpers.js";
import {
  cleanString,
  currentTaskAccessToken,
  parseOptionalInt,
  projectCompatibilityResponse,
  projectCreateCompatibilityInput,
  projectCreateInputWithDefaultLead,
  projectDocCompatibilityResponse,
  projectDocErrorResponse,
  projectDocRevisionCompatibilityResponse,
  projectErrorResponse,
  projectResourceCompatibilityResponse,
  projectResourceErrorResponse,
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

export function registerProjectRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/projects", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const projects = store.listProjects(workspaceId);
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
    return c.json(result);
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
      .map(projectCompatibilityResponse);
    return c.json({ projects, total: projects.length });
  });
  app.post("/api/projects", async (c) => {
    const body = await readJsonStrict<CreateProjectInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
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
      const project = store.createProject(projectInput);
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
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
    const repositoryError = validateImportedProjectResources(
      store,
      body.workspaceId ?? body.workspace_id ?? "local",
      body.resources,
    );
    if (repositoryError) return c.json({ error: repositoryError }, 400);
    return c.json({ project: store.createProject(projectCreateInputWithDefaultLead(c, body)) }, 201);
  });
  app.get("/api/multiremi/projects/:id", (c) => {
    const project = store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json({ project, resources: store.listProjectResources(project.id) });
  });
  app.patch("/api/multiremi/projects/:id", async (c) => {
    const body = await readJsonStrict<UpdateProjectInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json({ project: store.updateProject(c.req.param("id"), body) });
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
    const project = store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json(projectCompatibilityResponse(project));
  });
  app.put("/api/projects/:id", async (c) => {
    const body = await readJsonStrict<UpdateProjectInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const project = store.updateProject(c.req.param("id"), projectUpdateCompatibilityInput(body));
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
  app.get("/api/projects/:id/docs", (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    const query = cleanString(c.req.query("q"));
    const kind = cleanString(c.req.query("kind"));
    try {
      const docs = query
        ? store.searchProjectDocs(project.id, query, { kind, limit: parseOptionalInt(c.req.query("limit")) })
        : store.listProjectDocs(project.id, { kind });
      return c.json({ docs: docs.map(projectDocCompatibilityResponse) });
    } catch (err) {
      const response = projectDocErrorResponse(c, err);
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
      const doc = store.createProjectDoc(project.id, projectDocCreateInput(c, store, body));
      const response = projectDocCompatibilityResponse(doc);
      publishProjectDocCreated(c, store, doc, response);
      return c.json({ doc: response }, 201);
    } catch (err) {
      const response = projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.get("/api/projects/:id/docs/:ref", (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    const doc = store.getProjectDocByRef(project.id, c.req.param("ref"));
    if (!doc) return c.json({ error: "project doc not found" }, 404);
    return c.json({ doc: projectDocCompatibilityResponse(doc) });
  });
  app.put("/api/projects/:id/docs/:ref", async (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    const body = await readJsonStrict<UpdateProjectDocInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const doc = store.updateProjectDoc(project.id, c.req.param("ref"), projectDocUpdateInput(c, body));
      const response = projectDocCompatibilityResponse(doc);
      publishProjectDocUpdated(c, store, doc, response);
      return c.json({ doc: response });
    } catch (err) {
      const response = projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.delete("/api/projects/:id/docs/:ref", (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    // Read the doc before deleting it: the WS payload needs its id and workspace.
    const doc = store.getProjectDocByRef(project.id, c.req.param("ref"));
    if (!doc) return c.json({ error: "project doc not found" }, 404);
    store.deleteProjectDoc(project.id, c.req.param("ref"));
    publishProjectDocDeleted(c, store, doc);
    return c.json({ deleted: true });
  });
  app.get("/api/projects/:id/docs/:ref/revisions", (c) => {
    const project = loadProjectForDocs(c, store, c.req.param("id"));
    if (project instanceof Response) return project;
    const doc = store.getProjectDocByRef(project.id, c.req.param("ref"));
    if (!doc) return c.json({ error: "project doc not found" }, 404);
    return c.json({ revisions: store.listProjectDocRevisions(doc.id).map(projectDocRevisionCompatibilityResponse) });
  });
  app.get("/api/project-docs", (c) => {
    const workspaceId = compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    // A task token is project-scoped (denyTaskTokenProjectAccess); this flat
    // workspace-wide listing would silently widen it, so reject it outright.
    if (currentTaskAccessToken(c)?.taskId) return c.json({ error: "forbidden" }, 403);
    try {
      const docs = store.listWorkspaceDocs(workspaceId, {
        kind: cleanString(c.req.query("kind")),
        q: cleanString(c.req.query("q")),
        limit: parseOptionalInt(c.req.query("limit")),
      });
      return c.json({
        docs: docs.map((doc) => ({ ...projectDocCompatibilityResponse(doc), project_title: doc.projectTitle })),
      });
    } catch (err) {
      const response = projectDocErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
}

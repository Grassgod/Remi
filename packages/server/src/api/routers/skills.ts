import type { Hono } from "hono";
import {
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  loadSkillForCurrentManager,
  loadSkillForCurrentUser,
  publishWorkspaceEvent,
  readJsonStrict,
  skillWorkspaceId,
  withSkillCreateRequestContext,
  withSkillImportRequestContext,
  withSkillUpdateRequestContext,
} from "../helpers.js";
import {
  requestedSkillWorkspaceId,
  sanitizeSkillFilesForCompatibility,
  searchSkillsResponse,
  skillCompatibilityErrorResponse,
  skillFileCompatibilityResponse,
  skillSummary,
  skillSummaryCompatibilityResponse,
  skillWithFilesCompatibilityResponse,
} from "../wire/index.js";
import {
  buildImportedSkillInput,
} from "@daemon/agent-runtime/skills/skill-import.js";
import type {
  CreateSkillInput,
  ImportSkillInput,
  MultiremiSkillFile,
  UpdateSkillInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerSkillRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/skills", (c) => {
    const workspaceId = requestedSkillWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const includeFiles = c.req.query("includeFiles") === "true";
    const skills = store.listSkills(workspaceId, { includeFiles });
    return c.json({ skills: includeFiles ? skills : skills.map(skillSummary), total: skills.length });
  });
  app.post("/api/multiremi/skills", async (c) => {
    const body = await readJsonStrict<CreateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withSkillCreateRequestContext(c, store, body);
    if (input instanceof Response) return input;
    try {
      const skill = store.createSkill(sanitizeSkillFilesForCompatibility(input));
      publishWorkspaceEvent(c, store, "skill:created", skillWorkspaceId(skill), { skill: skillWithFilesCompatibilityResponse(skill) });
      return c.json({ skill }, 201);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.post("/api/multiremi/skills/import", async (c) => {
    const body = await readJsonStrict<ImportSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const request = withSkillImportRequestContext(c, store, body);
    if (request instanceof Response) return request;
    const imported = await buildImportedSkillInput(request);
    const input = withSkillCreateRequestContext(c, store, imported.skillInput);
    if (input instanceof Response) return input;
    try {
      const skill = store.createSkill(sanitizeSkillFilesForCompatibility(input));
      publishWorkspaceEvent(c, store, "skill:created", skillWorkspaceId(skill), { skill: skillWithFilesCompatibilityResponse(skill) });
      return c.json({ skill, source: imported.source, sourceUrl: imported.sourceUrl }, 201);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { duplicateImportInput: input, store });
    }
  });
  app.get("/api/multiremi/skills/search", (c) => {
    const workspaceId = requestedSkillWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const result = searchSkillsResponse(store, c);
    return c.json({ ...result, total: result.skills.length });
  });
  app.get("/api/multiremi/skills/:id", (c) => {
    const loaded = loadSkillForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json({ skill: loaded.skill });
  });
  app.patch("/api/multiremi/skills/:id", async (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const skill = store.updateSkill(loaded.skill.id!, sanitizeSkillFilesForCompatibility(withSkillUpdateRequestContext(loaded.skill, body)));
      publishWorkspaceEvent(c, store, "skill:updated", skillWorkspaceId(skill), { skill: skillWithFilesCompatibilityResponse(skill) });
      return c.json({ skill });
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.put("/api/multiremi/skills/:id", async (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const skill = store.updateSkill(loaded.skill.id!, sanitizeSkillFilesForCompatibility(withSkillUpdateRequestContext(loaded.skill, body)));
      publishWorkspaceEvent(c, store, "skill:updated", skillWorkspaceId(skill), { skill: skillWithFilesCompatibilityResponse(skill) });
      return c.json({ skill });
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.delete("/api/multiremi/skills/:id", (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    try {
      const skill = store.archiveSkill(loaded.skill.id!);
      publishWorkspaceEvent(c, store, "skill:deleted", skillWorkspaceId(loaded.skill), { skill_id: loaded.skill.id ?? c.req.param("id") });
      return c.json({ skill });
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/skills", (c) => {
    const workspaceId = requestedSkillWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listSkills(workspaceId, { includeFiles: false }).map(skillSummaryCompatibilityResponse));
  });
  app.get("/api/skills/search", (c) => {
    if (!String(c.req.query("q") ?? "").trim()) return c.json({ error: "query is required" }, 400);
    return c.json(searchSkillsResponse(store, c).skills);
  });
  app.post("/api/skills", async (c) => {
    const body = await readJsonStrict<CreateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withSkillCreateRequestContext(c, store, body);
    if (input instanceof Response) return input;
    try {
      const skill = store.createSkill(sanitizeSkillFilesForCompatibility(input));
      const response = skillWithFilesCompatibilityResponse(skill);
      publishWorkspaceEvent(c, store, "skill:created", skillWorkspaceId(skill), { skill: response });
      return c.json(response, 201);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.post("/api/skills/import", async (c) => {
    const body = await readJsonStrict<ImportSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const request = withSkillImportRequestContext(c, store, body);
    if (request instanceof Response) return request;
    const imported = await buildImportedSkillInput(request);
    const input = withSkillCreateRequestContext(c, store, imported.skillInput);
    if (input instanceof Response) return input;
    try {
      const skill = store.createSkill(sanitizeSkillFilesForCompatibility(input));
      const response = skillWithFilesCompatibilityResponse(skill);
      publishWorkspaceEvent(c, store, "skill:created", skillWorkspaceId(skill), { skill: response });
      return c.json(response, 201);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { duplicateImportInput: input, store });
    }
  });
  app.get("/api/skills/:id", (c) => {
    const loaded = loadSkillForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(skillWithFilesCompatibilityResponse(loaded.skill));
  });
  app.patch("/api/skills/:id", async (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const skill = store.updateSkill(loaded.skill.id!, sanitizeSkillFilesForCompatibility(withSkillUpdateRequestContext(loaded.skill, body)));
      const response = skillWithFilesCompatibilityResponse(skill);
      publishWorkspaceEvent(c, store, "skill:updated", skillWorkspaceId(skill), { skill: response });
      return c.json(response);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.put("/api/skills/:id", async (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateSkillInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const skill = store.updateSkill(loaded.skill.id!, sanitizeSkillFilesForCompatibility(withSkillUpdateRequestContext(loaded.skill, body)));
      const response = skillWithFilesCompatibilityResponse(skill);
      publishWorkspaceEvent(c, store, "skill:updated", skillWorkspaceId(skill), { skill: response });
      return c.json(response);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error, { invalidPathIncludesPath: true });
    }
  });
  app.delete("/api/skills/:id", (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    try {
      store.archiveSkill(loaded.skill.id!);
      publishWorkspaceEvent(c, store, "skill:deleted", skillWorkspaceId(loaded.skill), { skill_id: loaded.skill.id ?? c.req.param("id") });
      return c.body(null, 204);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/skills/:id/files", (c) => {
    try {
      const loaded = loadSkillForCurrentUser(c, store, c.req.param("id"));
      if (loaded instanceof Response) return loaded;
      return c.json(store.listSkillFiles(loaded.skill.id!).map(skillFileCompatibilityResponse));
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.put("/api/skills/:id/files", async (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<MultiremiSkillFile>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(skillFileCompatibilityResponse(store.upsertSkillFile(loaded.skill.id!, body)));
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/skills/:id/files/:fileId", (c) => {
    const loaded = loadSkillForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    try {
      const deleted = store.deleteSkillFile(loaded.skill.id!, c.req.param("fileId"));
      if (!deleted) return c.json({ error: "skill file not found" }, 404);
      return c.body(null, 204);
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
}

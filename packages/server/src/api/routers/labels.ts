import type { Hono } from "hono";
import { denyCurrentUserWorkspaceAccess, isJsonApiError, readJson, readJsonStrict } from "../helpers.js";
import { labelCompatibilityErrorResponse, labelCompatibilityResponse, labelCreateCompatibilityInput } from "../wire/index.js";
import type { CreateLabelInput, UpdateLabelInput } from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerLabelRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/labels", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const labels = store.listLabels(workspaceId);
    return c.json({ labels, total: labels.length });
  });
  app.post("/api/multiremi/labels", async (c) => {
    const body = await readJson<CreateLabelInput>(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? body.workspace_id ?? "local");
    if (denied) return denied;
    return c.json({ label: store.createLabel(body) }, 201);
  });
  app.get("/api/multiremi/labels/:id", (c) => {
    const label = store.getLabel(c.req.param("id"));
    if (!label) return c.json({ error: "label not found" }, 404);
    return c.json({ label });
  });
  app.patch("/api/multiremi/labels/:id", async (c) => {
    const body = await readJson<UpdateLabelInput>(c);
    return c.json({ label: store.updateLabel(c.req.param("id"), body) });
  });
  app.put("/api/multiremi/labels/:id", async (c) => {
    const body = await readJson<UpdateLabelInput>(c);
    return c.json({ label: store.updateLabel(c.req.param("id"), body) });
  });
  app.delete("/api/multiremi/labels/:id", (c) => {
    return c.json({ label: store.deleteLabel(c.req.param("id")) });
  });

  app.get("/api/labels", (c) => {
    const workspaceId = c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const labels = store.listLabels(workspaceId);
    return c.json({ labels: labels.map(labelCompatibilityResponse), total: labels.length });
  });
  app.post("/api/labels", async (c) => {
    const body = await readJsonStrict<CreateLabelInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspace_id ?? body.workspaceId ?? "local");
    if (denied) return denied;
    try {
      return c.json(labelCompatibilityResponse(store.createLabel(labelCreateCompatibilityInput(body))), 201);
    } catch (error) {
      return labelCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/labels/:id", (c) => {
    const label = store.getLabel(c.req.param("id"));
    if (!label) return c.json({ error: "label not found" }, 404);
    return c.json(labelCompatibilityResponse(label));
  });
  app.put("/api/labels/:id", async (c) => {
    const body = await readJsonStrict<UpdateLabelInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(labelCompatibilityResponse(store.updateLabel(c.req.param("id"), body)));
    } catch (error) {
      return labelCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/labels/:id", (c) => {
    try {
      store.deleteLabel(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return labelCompatibilityErrorResponse(c, error);
    }
  });
}

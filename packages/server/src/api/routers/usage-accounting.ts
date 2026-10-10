import type { Hono, Context } from "hono";
import type { SetUsagePriceInput } from "@multiremi/contracts/usage-accounting.js";
import { resolveRequestWorkspaceId } from "../helpers/workspace-context.js";
import { denyCurrentUserWorkspaceAccess, requireWorkspaceAdmin, readJsonStrict } from "../helpers.js";
import type { RouterDeps } from "./deps.js";
import { UsageValidationError } from "@multiremi/store/usage-accounting.js";

export function registerUsageAccountingRoutes(app: Hono, { store }: RouterDeps): void {
  const workspace = (c: Context): string | Response => {
    const id = resolveRequestWorkspaceId(c, store, c.req.query("workspace_id"));
    if (id instanceof Response) return id;
    return denyCurrentUserWorkspaceAccess(c, store, id) ?? id;
  };
  app.get("/api/usage/report", (c) => {
    const workspaceId = workspace(c); if (workspaceId instanceof Response) return workspaceId;
    const runtimeId = c.req.query("runtime_id") ?? null;
    if (runtimeId) { const runtime = store.getRuntimeLite(runtimeId); if (!runtime || (runtime.workspaceId ?? "local") !== workspaceId) return c.json({ error: "Runtime not found" }, 404); }
    const projectId = c.req.query("project_id") ?? null;
    if (projectId) { const project = store.getProject(projectId); if (!project || project.workspaceId !== workspaceId) return c.json({ error: "Project not found" }, 404); }
    try {
      const days = c.req.query("days");
      const include = c.req.query("include"), detailLimit = c.req.query("detail_limit");
      if (include !== undefined && include !== "day_model") throw new UsageValidationError("Invalid report include");
      return c.json(store.getUsageReport({ workspaceId, projectId, runtimeId, tz: c.req.query("tz"),
        days: days === "all" ? null : days === undefined ? undefined : Number(days), since: c.req.query("since"), until: c.req.query("until"),
        include, detailLimit: detailLimit === undefined ? undefined : Number(detailLimit), detailCursor: c.req.query("detail_cursor") }));
    } catch (e) { if (e instanceof UsageValidationError) return c.json({ error: e.message }, 400); throw e; }
  });
  app.get("/api/usage/prices", (c) => {
    const id = workspace(c); if (id instanceof Response) return id;
    return c.json({ prices: store.listUsagePrices(id) });
  });
  app.post("/api/usage/prices", async (c) => {
    const id = workspace(c); if (id instanceof Response) return id;
    const denied = requireWorkspaceAdmin(c, store, id); if (denied) return denied;
    const body = await readJsonStrict(c); if (body instanceof Response) return body;
    try { return c.json(store.setUsagePrice(id, body as unknown as SetUsagePriceInput), 201); }
    catch (e) { if (e instanceof UsageValidationError) return c.json({ error: e.message }, 400); throw e; }
  });
  app.patch("/api/usage/prices/:id", async (c) => {
    const id = workspace(c); if (id instanceof Response) return id;
    const denied = requireWorkspaceAdmin(c, store, id); if (denied) return denied;
    const body = await readJsonStrict(c); if (body instanceof Response) return body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "effective_to") || !("effective_to" in body) || typeof body.effective_to !== "string") return c.json({ error: "Only effective_to may be changed; append a new price version to edit rates" }, 400);
    try { return c.json(store.closeUsagePrice(id, c.req.param("id"), body.effective_to)); }
    catch (e) { if (e instanceof UsageValidationError) return c.json({ error: e.message }, 400); throw e; }
  });
}

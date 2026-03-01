import type { RemiData } from "../remi-data.js";

export function registerProjectHandlers(router: any, data: RemiData) {
  router.get("/api/v1/projects", () => {
    return Response.json(data.readProjects());
  });

  router.post("/api/v1/projects", async (req: Request) => {
    const { alias, path } = await req.json() as { alias: string; path: string };
    if (!alias || !path) return Response.json({ error: "alias and path required" }, { status: 400 });
    const ok = data.saveProject(alias, path);
    if (!ok) return Response.json({ error: "failed to save" }, { status: 500 });
    return Response.json({ ok: true });
  });

  router.put("/api/v1/projects/:alias", async (req: Request, params: Record<string, string>) => {
    const { path } = await req.json() as { path: string };
    if (!path) return Response.json({ error: "path required" }, { status: 400 });
    const ok = data.saveProject(decodeURIComponent(params.alias), path);
    if (!ok) return Response.json({ error: "failed to update" }, { status: 500 });
    return Response.json({ ok: true });
  });

  router.delete("/api/v1/projects/:alias", (_req: Request, params: Record<string, string>) => {
    const ok = data.deleteProject(decodeURIComponent(params.alias));
    if (!ok) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ok: true });
  });
}

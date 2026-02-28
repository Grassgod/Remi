import type { RemiData } from "../remi-data.js";

export function registerMemoryHandlers(router: any, data: RemiData) {
  // Global memory
  router.get("/api/v1/memory/global", () => {
    return Response.json({ content: data.readGlobalMemory() });
  });

  router.put("/api/v1/memory/global", async (req: Request) => {
    const body = await req.json();
    if (!body.content || typeof body.content !== "string") {
      return Response.json({ error: "content required" }, { status: 400 });
    }
    data.writeGlobalMemory(body.content);
    return Response.json({ ok: true });
  });

  // Entities
  router.get("/api/v1/memory/entities", () => {
    return Response.json(data.listEntities());
  });

  router.get("/api/v1/memory/entities/:type/:name", (_req: Request, params: Record<string, string>) => {
    const entity = data.readEntity(params.type, decodeURIComponent(params.name));
    if (!entity) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(entity);
  });

  router.post("/api/v1/memory/entities", async (req: Request) => {
    const body = await req.json();
    if (!body.type || !body.name) {
      return Response.json({ error: "type and name required" }, { status: 400 });
    }
    data.createEntity(body);
    return Response.json({ ok: true }, { status: 201 });
  });

  router.put("/api/v1/memory/entities/:type/:name", async (req: Request, params: Record<string, string>) => {
    const body = await req.json();
    if (!body.content) {
      return Response.json({ error: "content required" }, { status: 400 });
    }
    const ok = data.updateEntity(params.type, decodeURIComponent(params.name), body.content);
    if (!ok) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ok: true });
  });

  router.delete("/api/v1/memory/entities/:type/:name", (_req: Request, params: Record<string, string>) => {
    const ok = data.deleteEntity(params.type, decodeURIComponent(params.name));
    if (!ok) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ok: true });
  });

  // Search
  router.get("/api/v1/memory/search", (req: Request) => {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    if (!q) return Response.json([]);
    return Response.json(data.searchMemory(q));
  });

  // Daily logs
  router.get("/api/v1/memory/daily", () => {
    return Response.json(data.listDailyDates());
  });

  router.get("/api/v1/memory/daily/:date", (_req: Request, params: Record<string, string>) => {
    const content = data.readDaily(params.date);
    if (!content) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ date: params.date, content });
  });
}

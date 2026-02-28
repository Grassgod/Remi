import type { RemiData } from "../remi-data.js";

export function registerSessionHandlers(router: any, data: RemiData) {
  router.get("/api/v1/sessions", () => {
    return Response.json(data.readSessions());
  });

  router.delete("/api/v1/sessions/:key", (_req: Request, params: Record<string, string>) => {
    const ok = data.clearSession(decodeURIComponent(params.key));
    if (!ok) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ok: true });
  });

  router.delete("/api/v1/sessions", () => {
    const count = data.clearAllSessions();
    return Response.json({ ok: true, cleared: count });
  });
}

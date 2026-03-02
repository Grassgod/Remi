import type { RemiData } from "../remi-data.js";

export function registerLogsHandlers(router: any, data: RemiData) {
  router.get("/api/v1/logs", (req: Request) => {
    const url = new URL(req.url);
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const level = url.searchParams.get("level") ?? null;
    const module = url.searchParams.get("module") ?? null;
    const traceId = url.searchParams.get("traceId") ?? null;
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10), 1000);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    return Response.json(data.getLogs({ date, level, module, traceId, limit, offset }));
  });

  router.get("/api/v1/logs/modules", (req: Request) => {
    const url = new URL(req.url);
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    return Response.json(data.getLogModules(date));
  });
}

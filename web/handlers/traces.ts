import type { RemiData } from "../remi-data.js";

export function registerTracesHandlers(router: any, data: RemiData) {
  router.get("/api/v1/traces", (req: Request) => {
    const url = new URL(req.url);
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
    return Response.json(data.getTraces(date, limit));
  });

  router.get("/api/v1/traces/:traceId", (req: Request, params: Record<string, string>) => {
    const trace = data.getTrace(params.traceId);
    if (!trace) return Response.json({ error: "Trace not found" }, { status: 404 });
    return Response.json(trace);
  });
}

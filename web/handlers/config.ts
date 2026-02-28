import type { RemiData } from "../remi-data.js";

export function registerConfigHandlers(router: any, data: RemiData) {
  router.get("/api/v1/config", () => {
    return Response.json(data.readConfig());
  });

  router.put("/api/v1/config", async (req: Request) => {
    const body = await req.json();
    const ok = data.updateConfig(body);
    if (!ok) return Response.json({ error: "failed to update config" }, { status: 500 });
    return Response.json({ ok: true });
  });
}

import type { Hono } from "hono";
import {
  cloudRuntimeStatusResponse,
  readJson,
} from "../helpers.js";
import {
  parseOptionalInt,
} from "../wire/index.js";
import type {
  CreateCloudRuntimeNodeInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerCloudRuntimeRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/cloud-runtime", (c) => c.json({ configured: true, mode: "local" }));
  app.get("/api/cloud-runtime/healthz", (c) => c.json({ ok: true, configured: true, mode: "local" }));
  app.get("/api/cloud-runtime/readyz", (c) => c.json({ ok: true, configured: true, mode: "local" }));
  app.get("/api/cloud-runtime/nodes", (c) => c.json(store.listCloudRuntimeNodes({
    limit: parseOptionalInt(c.req.query("limit")),
    offset: parseOptionalInt(c.req.query("offset")),
  })));
  app.post("/api/cloud-runtime/nodes", async (c) => {
    const body = await readJson<CreateCloudRuntimeNodeInput>(c);
    return c.json(store.createCloudRuntimeNode(body), 201);
  });
  app.delete("/api/cloud-runtime/nodes", async (c) => {
    const body = await readJson<{ id?: string; node_id?: string; nodeId?: string }>(c);
    const id = body.id ?? body.node_id ?? body.nodeId ?? "";
    const deleted = id ? store.deleteCloudRuntimeNode(id) : false;
    if (!deleted) return c.json({ error: "cloud runtime node not found" }, 404);
    return c.body(null, 204);
  });
  app.post("/api/cloud-runtime/nodes/start", async (c) => cloudRuntimeStatusResponse(c, store, await readJson(c), "running"));
  app.post("/api/cloud-runtime/nodes/stop", async (c) => cloudRuntimeStatusResponse(c, store, await readJson(c), "stopped"));
  app.post("/api/cloud-runtime/nodes/reboot", async (c) => cloudRuntimeStatusResponse(c, store, await readJson(c), "running"));
  app.post("/api/cloud-runtime/nodes/status", async (c) => {
    const body = await readJson<{ id?: string; node_id?: string; nodeId?: string; status?: string }>(c);
    return cloudRuntimeStatusResponse(c, store, body, body.status ?? "running");
  });
  app.post("/api/cloud-runtime/nodes/exec", async (c) => {
    const body = await readJson<{ id?: string; node_id?: string; nodeId?: string; command?: string; cmd?: string }>(c);
    const id = body.id ?? body.node_id ?? body.nodeId ?? "";
    const result = store.execCloudRuntimeNode(id, body.command ?? body.cmd ?? "");
    if (!result) return c.json({ error: "cloud runtime node not found" }, 404);
    return c.json(result);
  });
}

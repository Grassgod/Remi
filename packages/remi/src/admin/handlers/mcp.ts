import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerMcpHandlers(app: Hono, data: RemiData) {
  // List all scopes
  app.get("/api/v1/mcp/scopes", (c) => {
    return c.json(data.listMcpScopes());
  });

  // Get scope detail (servers + raw JSON)
  app.get("/api/v1/mcp/scopes/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const detail = data.getMcpScopeDetail(id);
    if (!detail) return c.json({ error: "scope not found" }, 404);
    return c.json(detail);
  });

  // Write full scope config (JSON editor save)
  app.put("/api/v1/mcp/scopes/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const { content } = await c.req.json();
    if (typeof content !== "string") return c.json({ error: "content required" }, 400);
    const result = data.writeMcpScope(id, content);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  // Delete a single server
  app.delete("/api/v1/mcp/scopes/:id/servers/:name", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const name = decodeURIComponent(c.req.param("name"));
    const result = data.deleteMcpServer(id, name);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  // Merge/paste servers into scope
  app.post("/api/v1/mcp/scopes/:id/merge", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const { content } = await c.req.json();
    if (typeof content !== "string") return c.json({ error: "content required" }, 400);
    const result = data.mergeMcpServers(id, content);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true, added: result.added });
  });
}

import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { symlinkManager } from "../../src/infra/symlink-manager.js";

export function registerSymlinkHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/symlinks/status", (c) => {
    return c.json(symlinkManager.getStatus());
  });

  app.post("/api/v1/symlinks/fix-all", (c) => {
    const result = symlinkManager.fixAll();
    return c.json(result);
  });

  app.post("/api/v1/symlinks/ensure/:cwd", (c) => {
    const cwd = decodeURIComponent(c.req.param("cwd"));
    symlinkManager.ensureForCwd(cwd);
    return c.json({ ok: true });
  });
}

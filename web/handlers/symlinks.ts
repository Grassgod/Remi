import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { symlinkManager } from "../../src/infra/symlink-manager.js";

let projectsInitialized = false;

export function registerSymlinkHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/symlinks/status", (c) => {
    // Lazy-init projects from remi.toml for hashToAlias
    if (!projectsInitialized) {
      try {
        const { loadConfig, findConfigPath } = require("../../src/config.js");
        const config = loadConfig(findConfigPath());
        if (config?.projects) {
          symlinkManager.setProjects(config.projects);
        }
        projectsInitialized = true;
      } catch { /* config not available, proceed without aliases */ }
    }
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

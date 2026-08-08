import type { Hono } from "hono";
import { latestMirrorReleaseVersion, resolveMirrorReleaseFile } from "../helpers.js";
import type { RouterDeps } from "./deps.js";

// Release files come off disk (MULTIREMI_RELEASE_DIR) — no deps, but keeps the
// uniform register<Domain>Routes(app, deps) signature.
export function registerRemiReleaseRoutes(app: Hono, _deps: RouterDeps): void {
  // Self-host release mirror (install-remi.sh reads these when MULTIREMI_BASE_URL is set).
  app.get("/api/remi/releases/latest/version", (c) => {
    const version = latestMirrorReleaseVersion();
    if (!version) return c.json({ error: "no releases available on this server" }, 404);
    return c.text(version);
  });
  app.get("/api/remi/releases/latest/:filename", (c) => {
    const file = resolveMirrorReleaseFile(c.req.param("filename"));
    if (!file) return c.json({ error: "not found" }, 404);
    return new Response(Bun.file(file));
  });
  app.get("/api/remi/releases/download/:tag/:filename", (c) => {
    const file = resolveMirrorReleaseFile(c.req.param("filename"));
    if (!file) return c.json({ error: "not found" }, 404);
    return new Response(Bun.file(file));
  });
}

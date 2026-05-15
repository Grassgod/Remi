import type { Hono } from "hono";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const CC_SWITCH_DB = process.env.CC_SWITCH_CONFIG_DIR
  ? join(process.env.CC_SWITCH_CONFIG_DIR, "cc-switch.db")
  : join(homedir(), ".remi", "cc-switch", "cc-switch.db");

const APP_TYPES = ["claude", "codex", "gemini", "opencode", "hermes"] as const;

function getDb(): Database | null {
  if (!existsSync(CC_SWITCH_DB)) return null;
  return new Database(CC_SWITCH_DB, { readonly: false });
}

function readonlyDb(): Database | null {
  if (!existsSync(CC_SWITCH_DB)) return null;
  return new Database(CC_SWITCH_DB, { readonly: true });
}

export function registerCCSwitchHandlers(app: Hono) {
  // ── MCP Servers ─────────────────────────────────────────────

  app.get("/api/v1/cc-switch/mcp", (c) => {
    const db = readonlyDb();
    if (!db) return c.json({ servers: [], available: false });
    try {
      const rows = db.query(
        "SELECT id, name, server_config, description, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode, enabled_hermes FROM mcp_servers"
      ).all() as any[];
      db.close();
      const servers = rows.map((r) => {
        const config = JSON.parse(r.server_config);
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          command: config.command,
          args: config.args,
          env: config.env,
          transport: config.type ?? "stdio",
          apps: {
            claude: !!r.enabled_claude,
            codex: !!r.enabled_codex,
            gemini: !!r.enabled_gemini,
            opencode: !!r.enabled_opencode,
            hermes: !!r.enabled_hermes,
          },
        };
      });
      return c.json({ servers, available: true });
    } catch (e: any) {
      db.close();
      return c.json({ servers: [], available: true, error: e.message });
    }
  });

  app.put("/api/v1/cc-switch/mcp/:id/toggle", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const { app: appType, enabled } = await c.req.json();
    if (!APP_TYPES.includes(appType)) return c.json({ error: "invalid app" }, 400);
    const db = getDb();
    if (!db) return c.json({ error: "cc-switch not available" }, 503);
    try {
      const col = `enabled_${appType}`;
      db.run(`UPDATE mcp_servers SET ${col} = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
      db.close();
      return c.json({ ok: true });
    } catch (e: any) {
      db.close();
      return c.json({ error: e.message }, 500);
    }
  });

  app.delete("/api/v1/cc-switch/mcp/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const db = getDb();
    if (!db) return c.json({ error: "cc-switch not available" }, 503);
    try {
      db.run("DELETE FROM mcp_servers WHERE id = ?", [id]);
      db.close();
      return c.json({ ok: true });
    } catch (e: any) {
      db.close();
      return c.json({ error: e.message }, 500);
    }
  });

  app.post("/api/v1/cc-switch/mcp", async (c) => {
    const { id, name, command, args, env, description, apps } = await c.req.json();
    if (!id || !name || !command) return c.json({ error: "id, name, command required" }, 400);
    const db = getDb();
    if (!db) return c.json({ error: "cc-switch not available" }, 503);
    try {
      const serverConfig = JSON.stringify({ type: "stdio", command, args: args ?? [], env: env ?? {} });
      db.run(
        `INSERT OR REPLACE INTO mcp_servers (id, name, server_config, description, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode, enabled_hermes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, name, serverConfig, description ?? "",
          apps?.claude ? 1 : 0, apps?.codex ? 1 : 0, apps?.gemini ? 1 : 0,
          apps?.opencode ? 1 : 0, apps?.hermes ? 1 : 0,
        ]
      );
      db.close();
      return c.json({ ok: true });
    } catch (e: any) {
      db.close();
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Skills ──────────────────────────────────────────────────

  app.get("/api/v1/cc-switch/skills", (c) => {
    const db = readonlyDb();
    if (!db) return c.json({ skills: [], available: false });
    try {
      const rows = db.query(
        "SELECT id, name, description, directory, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode, enabled_hermes FROM skills"
      ).all() as any[];
      db.close();
      const skills = rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        directory: r.directory,
        apps: {
          claude: !!r.enabled_claude,
          codex: !!r.enabled_codex,
          gemini: !!r.enabled_gemini,
          opencode: !!r.enabled_opencode,
          hermes: !!r.enabled_hermes,
        },
      }));
      return c.json({ skills, available: true });
    } catch (e: any) {
      db.close();
      return c.json({ skills: [], available: true, error: e.message });
    }
  });

  app.put("/api/v1/cc-switch/skills/:id/toggle", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const { app: appType, enabled } = await c.req.json();
    if (!APP_TYPES.includes(appType)) return c.json({ error: "invalid app" }, 400);
    const db = getDb();
    if (!db) return c.json({ error: "cc-switch not available" }, 503);
    try {
      const col = `enabled_${appType}`;
      db.run(`UPDATE skills SET ${col} = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
      db.close();
      return c.json({ ok: true });
    } catch (e: any) {
      db.close();
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Status ──────────────────────────────────────────────────

  app.get("/api/v1/cc-switch/status", (c) => {
    const available = existsSync(CC_SWITCH_DB);
    if (!available) return c.json({ available: false });
    const db = readonlyDb()!;
    try {
      const mcpCount = (db.query("SELECT COUNT(*) as c FROM mcp_servers").get() as any).c;
      const skillCount = (db.query("SELECT COUNT(*) as c FROM skills").get() as any).c;
      db.close();
      return c.json({ available: true, mcpCount, skillCount, dbPath: CC_SWITCH_DB });
    } catch (e: any) {
      db.close();
      return c.json({ available: true, error: e.message });
    }
  });
}

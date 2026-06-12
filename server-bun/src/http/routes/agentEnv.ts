/**
 * Agent env-management routes — port of the Go agent_env handler
 * (server/internal/handler/agent_env.go).
 *
 * There is no separate env table: an agent's environment lives in the
 * `agent.custom_env` jsonb column (a map of string -> string). These two
 * endpoints reveal and replace that map:
 *
 *   GET  /api/agents/:id/env  -> { custom_env: {...} }   (default {})
 *   PUT  /api/agents/:id/env  -> replaces custom_env, returns { custom_env }
 *
 * Both are behind the /api/* JWT gate and scoped to a workspace via the
 * X-Workspace-ID header + a membership check (multi-tenancy). The agent is
 * resolved by UUID and must belong to the requesting workspace.
 *
 * This is a standalone route factory declaring ABSOLUTE paths, so it composes
 * alongside the existing agents route without editing it.
 *
 * NOTE on parity scope: the Go handler restricts these endpoints to
 * owner/admin members and rejects agent actors, and it honours the "****"
 * sentinel + writes an `agent_env_updated` audit row inside a transaction on
 * PUT. This port keeps the data contract (custom_env round-trip) and the GET
 * `agent_env_revealed` audit row (keys only). The owner/admin role gate, the
 * agent-actor rejection, and the PUT-side sentinel/audit logic are not ported
 * here.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { agent, activityLog, type Agent } from "../../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { getAgentInWorkspace, getMembership } from "../../db/queries/agents.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID, or a Response to short-circuit with (400 missing/malformed
 * header, 404 not-a-member — mirrors the Go workspace-member gate).
 */
async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

/**
 * Decode an agent's stored custom_env into a plain map, returning an empty
 * (never null) map so callers can iterate safely. Mirrors Go
 * unmarshalCustomEnv. The column is jsonb, so drizzle hands us an object
 * already; we still guard against null / non-object shapes defensively.
 */
function customEnvOf(a: Agent): Record<string, string> {
  const raw = a.customEnv;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Sorted key list for the keys-only reveal audit row (deterministic). */
function sortedKeys(m: Record<string, string>): string[] {
  return Object.keys(m).sort();
}

export function agentEnvRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/agents/:id/env — reveal the agent's plaintext custom_env.
  r.get("/api/agents/:id/env", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const found = await getAgentInWorkspace(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "agent not found" }, 404);

    const customEnv = customEnvOf(found);

    // Append a keys-only reveal audit row (mirrors Go agent_env_revealed). The
    // activity_log shape (workspace_id, nullable issue_id, actor_type/id,
    // action, jsonb details) is clear, so we record it; values are never
    // written, only the revealed key names. Best-effort: a failed audit write
    // must not break the reveal in this port.
    const revealedKeys = sortedKeys(customEnv);
    try {
      await db.insert(activityLog).values({
        workspaceId: ws,
        actorType: "member",
        actorId: c.get("user").sub,
        action: "agent_env_revealed",
        details: {
          agent_id: found.id,
          agent_name: found.name,
          revealed_keys: revealedKeys,
          key_count: revealedKeys.length,
        },
      });
    } catch {
      /* audit best-effort in this port; do not fail the reveal */
    }

    return c.json({ custom_env: customEnv });
  });

  // PUT /api/agents/:id/env — replace the agent's custom_env wholesale.
  r.put("/api/agents/:id/env", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const found = await getAgentInWorkspace(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "agent not found" }, 404);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    // Accept only string->string entries; default to {} when absent (mirrors
    // Go's `if req.CustomEnv == nil { ... = map[string]string{} }`).
    const incoming = body.custom_env;
    const next: Record<string, string> = {};
    if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
      for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
        if (typeof v === "string") next[k] = v;
      }
    }

    const [updated] = await db
      .update(agent)
      .set({ customEnv: next, updatedAt: sql`now()` })
      .where(eq(agent.id, found.id))
      .returning();

    return c.json({ custom_env: customEnvOf(updated ?? found) });
  });

  return r;
}

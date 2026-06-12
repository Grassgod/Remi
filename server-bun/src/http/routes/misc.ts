/**
 * Small workspace-scoped read endpoints the web UI polls (ports of Go
 * GetAssigneeFrequency / ListPendingChatTasks / GetAgentTaskSnapshot). Declared
 * with absolute /api/* paths, mounted at "/" behind the JWT gate.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import { issue } from "../../db/schema.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) return c.json({ error: "X-Workspace-ID header required" }, 400);
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

export function miscRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/assignee-frequency — how often each assignee is used (orders the
  // assignee picker). [{ assignee_type, assignee_id, frequency }].
  r.get("/api/assignee-frequency", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const rows = await db
      .select({
        assignee_type: issue.assigneeType,
        assignee_id: issue.assigneeId,
        frequency: sql<number>`count(*)::int`,
      })
      .from(issue)
      .where(and(eq(issue.workspaceId, ws), isNotNull(issue.assigneeId)))
      .groupBy(issue.assigneeType, issue.assigneeId);
    return c.json(rows.map((r) => ({ assignee_type: r.assignee_type, assignee_id: r.assignee_id, frequency: Number(r.frequency) })));
  });

  // GET /api/chat/pending-tasks — chat turns awaiting an agent. Empty for now
  // (the queued-chat-task join is a follow-up; the shape is what the UI needs).
  r.get("/api/chat/pending-tasks", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    return c.json({ tasks: [] });
  });

  // GET /api/agent-task-snapshot — every active agent task in the workspace, as
  // a bare array (the frontend iterates it: for (const t of snapshot)). Empty
  // for now (the live active-task query is a follow-up).
  r.get("/api/agent-task-snapshot", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    return c.json([]);
  });

  // GET /api/agent-run-counts — per-agent task run counts (bare array, the
  // Agents page's run-count column). Empty for now (live aggregation follow-up).
  r.get("/api/agent-run-counts", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    return c.json([]);
  });

  // GET /api/agent-activity-30d — 30-day per-agent activity buckets (bare array).
  // Empty for now (live aggregation follow-up).
  r.get("/api/agent-activity-30d", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    return c.json([]);
  });

  // Cloud runtime nodes — a cloud-only feature. Self-hosted: empty list +
  // explicit refusal on create, so the "Add cloud runtime" dialog degrades
  // gracefully instead of erroring.
  r.get("/api/cloud-runtime/nodes", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    return c.json([]);
  });
  r.post("/api/cloud-runtime/nodes", (c) =>
    c.json({ error: "cloud runtime is not available in self-hosted mode" }, 501),
  );

  // GET /api/cli/latest-version — latest CLI release tag, proxied server-side
  // so the browser never calls api.github.com directly (rate limits showed up
  // as a console error on every page). CLI_RELEASES_REPO unset → null version.
  r.get("/api/cli/latest-version", async (c) => {
    const repo = process.env.CLI_RELEASES_REPO ?? "";
    if (!repo) return c.json({ version: null });
    const now = Date.now();
    if (cliVersionCache && now - cliVersionCache.at < CLI_VERSION_TTL_MS) {
      return c.json({ version: cliVersionCache.version });
    }
    let version: string | null = null;
    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { tag_name?: unknown };
        version = typeof data.tag_name === "string" ? data.tag_name : null;
      }
    } catch {
      version = null;
    }
    cliVersionCache = { version, at: now };
    return c.json({ version });
  });

  return r;
}

const CLI_VERSION_TTL_MS = 10 * 60 * 1000;
let cliVersionCache: { version: string | null; at: number } | undefined;

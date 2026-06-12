/**
 * Dashboard routes (read path) — port of the Go dashboard handler
 * (server/internal/handler/dashboard.go), mounted by Chi at /api/dashboard:
 *
 *   GET /usage/daily     per-(date, model) token rows
 *   GET /usage/by-agent  per-(agent, model) token rows
 *   GET /agent-runtime   per-agent run-time + task counts
 *   GET /runtime/daily   per-date run-time + task counts
 *
 * Behind the /api/* JWT gate; scoped to a workspace via the X-Workspace-ID
 * header + a membership check (multi-tenancy). All four accept ?days=N
 * (default 30, capped at 365) and an optional ?project_id=<uuid> to scope the
 * rollup to a single project. Cost is computed client-side from a per-model
 * pricing table — the model dimension is intentionally kept on the wire.
 *
 * Access control is workspace membership only: token spend / run time are
 * workspace-level operational metrics, not per-agent visibility gated.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { user as userTable } from "../../db/schema.js";
import { getMembership } from "../../db/queries/issues.js";
import {
  listDashboardAgentRunTime,
  listDashboardRunTimeDaily,
  listDashboardUsageByAgent,
  listDashboardUsageDaily,
} from "../../db/queries/dashboard.js";

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
 * Read ?project_id=<uuid> off the URL. Returns the project UUID, or null when
 * absent so the WHERE clause degrades to "no project filter", or a Response to
 * short-circuit with a 400 on a malformed UUID. Mirrors Go parseProjectIDParam.
 */
function parseProjectIdParam(c: Context<AppEnv>): string | null | Response {
  const raw = c.req.query("project_id");
  if (!raw) return null;
  if (!UUID_RE.test(raw)) {
    return c.json({ error: "invalid project_id" }, 400);
  }
  return raw;
}

/**
 * Pure core of the cutoff maths: local midnight `days` days before `now`'s
 * local calendar day in `tz`. Mirrors Go sinceFromDays — yields N+1 calendar
 * buckets (today-days … today inclusive); do NOT tighten to -(days-1).
 */
function sinceFromDays(now: Date, days: number, tz: string): Date {
  // Decompose `now` into its local Y/M/D under `tz` via Intl, then rebuild the
  // UTC instant of that local midnight. The offset between the local wall
  // clock and UTC at that instant gives the shift to apply.
  const parts = localDateParts(now, tz);
  // Build the UTC instant that prints as `parts` midnight in `tz`, then step
  // back `days` whole days. AddDate-by-day is calendar arithmetic; doing it on
  // the UTC ms is fine here because the cutoff only needs day granularity.
  const localMidnightUtcMs = wallClockToUtcMs(parts.year, parts.month, parts.day, tz);
  return new Date(localMidnightUtcMs - days * 86_400_000);
}

/** Local calendar Y/M/D of `now` under IANA `tz`. */
function localDateParts(now: Date, tz: string): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(now).split("-");
  return { year: Number(y), month: Number(m), day: Number(d) };
}

/**
 * The UTC epoch-ms of wall-clock midnight (Y-M-D 00:00:00) in IANA `tz`.
 * Computed by guessing the UTC instant from the naive wall time, then
 * correcting by that instant's actual tz offset (single correction is exact
 * for all real-world zones at midnight).
 */
function wallClockToUtcMs(year: number, month: number, day: number, tz: string): number {
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetMs = tzOffsetMs(new Date(naiveUtc), tz);
  return naiveUtc - offsetMs;
}

/** Offset (ms) of IANA `tz` from UTC at instant `at`. East of UTC is positive. */
function tzOffsetMs(at: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(at)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - at.getTime();
}

/** True if `tz` is a valid IANA zone (Intl throws RangeError otherwise). */
function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse ?days= into a cutoff Date, anchored to start-of-day-(N) in `tz` so
 * `days=N` returns N+1 calendar buckets in that zone. Defaults to 30, accepts
 * 1..365; anything else falls back to the default. Mirrors parseSinceParamInTZ.
 */
function parseSinceParam(c: Context<AppEnv>, defaultDays: number, tz: string): Date {
  let days = defaultDays;
  const raw = c.req.query("days");
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 365) days = parsed;
  }
  return sinceFromDays(new Date(), days, tz);
}

/**
 * Resolve the IANA tz to render in: ?tz= query param, else the authenticated
 * user's stored user.timezone, else "UTC". Invalid values fall through rather
 * than erroring — tz is a display concern. The browser always sends ?tz=, so
 * the DB lookup is a cold fallback for API clients / older builds only.
 * Mirrors resolveViewingTZ.
 */
async function resolveViewingTz(c: Context<AppEnv>, db: Db): Promise<string> {
  const q = c.req.query("tz")?.trim();
  if (q && isValidTz(q)) return q;

  const userId = c.get("user").sub;
  if (userId && UUID_RE.test(userId)) {
    const [u] = await db
      .select({ tz: userTable.timezone })
      .from(userTable)
      .where(eq(userTable.id, userId));
    const stored = u?.tz?.trim();
    if (stored && isValidTz(stored)) return stored;
  }
  return "UTC";
}

export function dashboardRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/usage/daily", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const pid = parseProjectIdParam(c);
    if (pid instanceof Response) return pid;
    const tz = await resolveViewingTz(c, db);
    const since = parseSinceParam(c, 30, tz);
    const rows = await listDashboardUsageDaily(db, ws, tz, since, pid);
    return c.json(
      rows.map((row) => ({
        date: row.date,
        model: row.model,
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        cache_read_tokens: row.cacheReadTokens,
        cache_write_tokens: row.cacheWriteTokens,
        task_count: row.taskCount,
      })),
    );
  });

  r.get("/usage/by-agent", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const pid = parseProjectIdParam(c);
    if (pid instanceof Response) return pid;
    // "By agent" has no date grouping — tz only determines the cutoff
    // boundary, not the bucket axis.
    const tz = await resolveViewingTz(c, db);
    const since = parseSinceParam(c, 30, tz);
    const rows = await listDashboardUsageByAgent(db, ws, since, pid);
    return c.json(
      rows.map((row) => ({
        agent_id: row.agentId,
        model: row.model,
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        cache_read_tokens: row.cacheReadTokens,
        cache_write_tokens: row.cacheWriteTokens,
        task_count: row.taskCount,
      })),
    );
  });

  r.get("/agent-runtime", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const pid = parseProjectIdParam(c);
    if (pid instanceof Response) return pid;
    const tz = await resolveViewingTz(c, db);
    const since = parseSinceParam(c, 30, tz);
    const rows = await listDashboardAgentRunTime(db, ws, since, pid);
    return c.json(
      rows.map((row) => ({
        agent_id: row.agentId,
        total_seconds: row.totalSeconds,
        task_count: row.taskCount,
        failed_count: row.failedCount,
      })),
    );
  });

  r.get("/runtime/daily", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const pid = parseProjectIdParam(c);
    if (pid instanceof Response) return pid;
    const tz = await resolveViewingTz(c, db);
    const since = parseSinceParam(c, 30, tz);
    const rows = await listDashboardRunTimeDaily(db, ws, tz, since, pid);
    return c.json(
      rows.map((row) => ({
        date: row.date,
        total_seconds: row.totalSeconds,
        task_count: row.taskCount,
        failed_count: row.failedCount,
      })),
    );
  });

  return r;
}

/**
 * Dashboard read-path test — port of server/internal/handler/dashboard_test.go
 * coverage. Drives the four /api/dashboard endpoints against real fixtures and
 * asserts the snake_case aggregates reflect them. DB-gated: skips if Postgres
 * is unreachable.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { dashboardRoutes } from "../src/http/routes/dashboard.js";
import type { AppEnv } from "../src/http/types.js";
import {
  user,
  member,
  workspace,
  agentRuntime,
  agent,
  issue,
  agentTaskQueue,
  taskUsageHourly,
} from "../src/db/schema.js";
import type { Config } from "../src/config.js";

const SECRET = "test-secret-0123456789";
const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = {
  port: 0,
  jwtSecret: SECRET,
  authTokenTtlSeconds: 3600,
  databaseUrl: DB_URL,
  allowedEmailDomains: [],
};

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

/** ISO string for `now` minus `hoursAgo` hours — kept inside the 30-day window. */
function hoursAgo(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
}

test.skipIf(!reachable)(
  "dashboard read path: usage + run-time rollups reflect fixtures, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-dash-${stamp}@bytedance.com`, cfg);

    // Mount only the dashboard route on a bare app, injecting the authed user
    // ourselves (the real /api/* JWT gate lives in app.ts and isn't this
    // domain's concern). The workspace gate (X-Workspace-ID + membership) is
    // exercised in full below.
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { sub: u.id, email: u.email, name: u.name });
      await next();
    });
    app.route("/api/dashboard", dashboardRoutes(db));

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Dash WS", slug: `bun-dash-${stamp}`, issuePrefix: "DSH" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "Dash Runtime",
        runtimeMode: "cloud",
        provider: "codex",
        status: "online",
        ownerId: u.id,
      })
      .returning();
    const [ag] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: `Dash Agent ${stamp}`,
        runtimeMode: "cloud",
        runtimeId: rt!.id,
        ownerId: u.id,
      })
      .returning();
    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Dash Issue",
        creatorType: "member",
        creatorId: u.id,
        number: 1,
      })
      .returning();

    // Two terminal tasks: one completed spanning 120s, one failed spanning 60s.
    // total_seconds = 180, task_count = 2, failed_count = 1.
    const completedAt = hoursAgo(1);
    await db.insert(agentTaskQueue).values({
      agentId: ag!.id,
      runtimeId: rt!.id,
      issueId: iss!.id,
      status: "completed",
      startedAt: new Date(Date.parse(completedAt) - 120_000).toISOString(),
      completedAt,
    });
    await db.insert(agentTaskQueue).values({
      agentId: ag!.id,
      runtimeId: rt!.id,
      issueId: iss!.id,
      status: "failed",
      startedAt: new Date(Date.parse(completedAt) - 60_000).toISOString(),
      completedAt,
    });
    // A non-terminal (running) task must NOT contribute to run-time rollups.
    await db.insert(agentTaskQueue).values({
      agentId: ag!.id,
      runtimeId: rt!.id,
      issueId: iss!.id,
      status: "running",
      startedAt: hoursAgo(1),
    });

    // Two token buckets in the same UTC hour, same model: summed to one row.
    const bucket = new Date(Date.now() - 3_600_000);
    bucket.setUTCMinutes(0, 0, 0);
    const bucketHour = bucket.toISOString();
    for (let i = 0; i < 2; i++) {
      await db.insert(taskUsageHourly).values({
        bucketHour,
        workspaceId: ws!.id,
        runtimeId: rt!.id,
        agentId: ag!.id,
        projectId: null,
        provider: "codex",
        model: "gpt-5",
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        taskCount: 1,
        eventCount: 1,
        // The unique key includes provider/model/bucket_hour, so vary provider
        // to land two distinct rows that still group under the same model.
        ...(i === 1 ? { provider: "codex2" } : {}),
      });
    }

    // tz=UTC pins the calendar-day slice so date assertions are deterministic.
    const auth = { "X-Workspace-ID": ws!.id };
    const expectedDate = bucketHour.slice(0, 10);

    try {
      // --- usage/daily: one (date, model) row, tokens summed across buckets ---
      const dailyRes = await app.request("/api/dashboard/usage/daily?tz=UTC", { headers: auth });
      expect(dailyRes.status).toBe(200);
      const daily = (await dailyRes.json()) as Array<{
        date: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        task_count: number;
      }>;
      expect(daily.length).toBe(1);
      expect(daily[0]!.date).toBe(expectedDate);
      expect(daily[0]!.model).toBe("gpt-5");
      expect(daily[0]!.input_tokens).toBe(200);
      expect(daily[0]!.output_tokens).toBe(400);
      expect(daily[0]!.cache_read_tokens).toBe(20);
      expect(daily[0]!.cache_write_tokens).toBe(10);
      expect(daily[0]!.task_count).toBe(2);

      // --- usage/by-agent: one (agent, model) row, summed ---
      const byAgentRes = await app.request("/api/dashboard/usage/by-agent?tz=UTC", {
        headers: auth,
      });
      expect(byAgentRes.status).toBe(200);
      const byAgent = (await byAgentRes.json()) as Array<{
        agent_id: string;
        model: string;
        input_tokens: number;
        task_count: number;
      }>;
      expect(byAgent.length).toBe(1);
      expect(byAgent[0]!.agent_id).toBe(ag!.id);
      expect(byAgent[0]!.model).toBe("gpt-5");
      expect(byAgent[0]!.input_tokens).toBe(200);
      expect(byAgent[0]!.task_count).toBe(2);

      // --- agent-runtime: per-agent run time, terminal tasks only ---
      const runtimeRes = await app.request("/api/dashboard/agent-runtime?tz=UTC", {
        headers: auth,
      });
      expect(runtimeRes.status).toBe(200);
      const runtimeRows = (await runtimeRes.json()) as Array<{
        agent_id: string;
        total_seconds: number;
        task_count: number;
        failed_count: number;
      }>;
      expect(runtimeRows.length).toBe(1);
      expect(runtimeRows[0]!.agent_id).toBe(ag!.id);
      expect(runtimeRows[0]!.total_seconds).toBe(180); // 120 + 60, running excluded
      expect(runtimeRows[0]!.task_count).toBe(2);
      expect(runtimeRows[0]!.failed_count).toBe(1);

      // --- runtime/daily: per-date run time, terminal tasks only ---
      const dailyRtRes = await app.request("/api/dashboard/runtime/daily?tz=UTC", {
        headers: auth,
      });
      expect(dailyRtRes.status).toBe(200);
      const dailyRt = (await dailyRtRes.json()) as Array<{
        date: string;
        total_seconds: number;
        task_count: number;
        failed_count: number;
      }>;
      expect(dailyRt.length).toBe(1);
      expect(dailyRt[0]!.date).toBe(completedAt.slice(0, 10));
      expect(dailyRt[0]!.total_seconds).toBe(180);
      expect(dailyRt[0]!.task_count).toBe(2);
      expect(dailyRt[0]!.failed_count).toBe(1);

      // --- project_id filter that matches no project → empty rollups ---
      const otherProject = "88888888-8888-4888-8888-888888888888";
      const filtered = await app.request(
        `/api/dashboard/usage/daily?tz=UTC&project_id=${otherProject}`,
        { headers: auth },
      );
      expect(filtered.status).toBe(200);
      expect((await filtered.json()) as unknown[]).toEqual([]);

      // --- malformed project_id → 400 ---
      const badProj = await app.request("/api/dashboard/agent-runtime?project_id=not-a-uuid", {
        headers: auth,
      });
      expect(badProj.status).toBe(400);

      // --- missing workspace header → 400 ---
      const noWs = await app.request("/api/dashboard/usage/daily");
      expect(noWs.status).toBe(400);

      // --- member of no/other workspace → 404 (multi-tenancy gate) ---
      const foreign = await app.request("/api/dashboard/usage/daily", {
        headers: { "X-Workspace-ID": "99999999-9999-4999-8999-999999999999" },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(taskUsageHourly).where(eq(taskUsageHourly.workspaceId, ws!.id));
      await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(agent).where(eq(agent.id, ag!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

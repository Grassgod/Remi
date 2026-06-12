/**
 * Per-runtime usage rollups: GET /api/runtimes/:id/usage (by date/provider/model)
 * and /usage/by-agent reflect task_usage_hourly rows scoped to the runtime.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { runtimeRoutes } from "../src/http/routes/runtimes.js";
import { user, member, workspace, agent, agentRuntime, taskUsageHourly } from "../src/db/schema.js";
import type { AppEnv } from "../src/http/types.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = { port: 0, jwtSecret: "x", authTokenTtlSeconds: 3600, databaseUrl: DB_URL, allowedEmailDomains: [] };

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

test.skipIf(!reachable)("runtime usage + by-agent reflect task_usage_hourly rows", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-ru-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "RU WS", slug: `bun-ru-${stamp}`, issuePrefix: "RU", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();
  const [ag] = await db.insert(agent).values({ workspaceId: ws!.id, name: "W", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id }).returning();

  // Two hourly buckets today for the same (provider, model, agent) → summed.
  const now = new Date();
  const earlier = new Date(now.getTime() - 3_600_000);
  await db.insert(taskUsageHourly).values([
    { bucketHour: now.toISOString(), workspaceId: ws!.id, runtimeId: rt!.id, agentId: ag!.id, provider: "codex", model: "gpt-5", inputTokens: 100, outputTokens: 50, taskCount: 2 },
    { bucketHour: earlier.toISOString(), workspaceId: ws!.id, runtimeId: rt!.id, agentId: ag!.id, provider: "codex", model: "gpt-5", inputTokens: 30, outputTokens: 10, taskCount: 1 },
  ]);

  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => { c.set("user", { sub: u.id } as never); await n(); });
  app.route("/api/runtimes", runtimeRoutes(db));
  const hdr = { "X-Workspace-ID": ws!.id };

  try {
    const usage = (await (await app.request(`/api/runtimes/${rt!.id}/usage`, { headers: hdr })).json()) as any[];
    // Both buckets are the same local day → one summed row.
    expect(usage.length).toBe(1);
    expect(usage[0].provider).toBe("codex");
    expect(usage[0].model).toBe("gpt-5");
    expect(usage[0].input_tokens).toBe(130);
    expect(usage[0].output_tokens).toBe(60);
    expect(usage[0].task_count).toBe(3);

    const byAgent = (await (await app.request(`/api/runtimes/${rt!.id}/usage/by-agent`, { headers: hdr })).json()) as any[];
    expect(byAgent.length).toBe(1);
    expect(byAgent[0].agent_id).toBe(ag!.id);
    expect(byAgent[0].input_tokens).toBe(130);
    expect(byAgent[0].task_count).toBe(3);
  } finally {
    await db.delete(taskUsageHourly).where(eq(taskUsageHourly.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

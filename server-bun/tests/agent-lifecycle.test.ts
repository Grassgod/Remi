/**
 * Agent lifecycle: archiving cancels in-flight tasks and sets archived_at;
 * restore clears it; the cancel-tasks endpoint cancels queued/running work.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { agentRoutes } from "../src/http/routes/agents.js";
import { user, member, workspace, agent, agentRuntime, agentTaskQueue } from "../src/db/schema.js";
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

test.skipIf(!reachable)("archive cancels tasks + sets archived_at; restore clears; cancel-tasks works", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-al-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "AL WS", slug: `bun-al-${stamp}`, issuePrefix: "AL", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();
  const [ag] = await db.insert(agent).values({ workspaceId: ws!.id, name: "Worker", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id }).returning();
  const mkTask = async () => (await db.insert(agentTaskQueue).values({ agentId: ag!.id, runtimeId: rt!.id, status: "queued" }).returning())[0]!;

  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => { c.set("user", { sub: u.id } as never); await n(); });
  app.route("/api/agents", agentRoutes(db));
  const hdr = { "Content-Type": "application/json", "X-Workspace-ID": ws!.id };

  try {
    const t1 = await mkTask();
    // Archive → 200, archived_at set, the queued task cancelled.
    const arch = await app.request(`/api/agents/${ag!.id}/archive`, { method: "POST", headers: hdr });
    expect(arch.status).toBe(200);
    expect((await arch.json()).archived_at).toBeTruthy();
    expect((await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, t1.id)))[0]!.status).toBe("cancelled");

    // Archiving again → 409.
    const arch2 = await app.request(`/api/agents/${ag!.id}/archive`, { method: "POST", headers: hdr });
    expect(arch2.status).toBe(409);

    // Restore → archived_at cleared.
    const rest = await app.request(`/api/agents/${ag!.id}/restore`, { method: "POST", headers: hdr });
    expect(rest.status).toBe(200);
    expect((await rest.json()).archived_at).toBeNull();
    // Restoring when not archived → 409.
    const rest2 = await app.request(`/api/agents/${ag!.id}/restore`, { method: "POST", headers: hdr });
    expect(rest2.status).toBe(409);

    // cancel-tasks cancels a fresh queued task and reports the count.
    const t2 = await mkTask();
    const cancel = await app.request(`/api/agents/${ag!.id}/cancel-tasks`, { method: "POST", headers: hdr });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).cancelled).toBe(1);
    expect((await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, t2.id)))[0]!.status).toBe("cancelled");
  } finally {
    await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

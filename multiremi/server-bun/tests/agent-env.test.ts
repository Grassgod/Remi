import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { user, member, workspace, agent, agentRuntime, activityLog } from "../src/db/schema.js";
import { agentEnvRoutes } from "../src/http/routes/agentEnv.js";
import type { AppEnv } from "../src/http/types.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = {
  port: 0,
  jwtSecret: "test-secret-0123456789",
  authTokenTtlSeconds: 3600,
  databaseUrl: DB_URL,
  allowedEmailDomains: [],
};

// Probe the DB once; skip the whole suite if it's unreachable.
let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

/**
 * Build the FK chain the agent-env endpoints need:
 *   workspace -> member(owner) -> agent_runtime(local/codex) -> agent.
 * Returns the ids + the X-Workspace-ID header value. The JWT gate is bypassed
 * by mounting agentEnvRoutes on a bare Hono app that injects the user directly.
 */
async function setup(db: ReturnType<typeof createDb>["db"]) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { user: u } = await findOrCreateUser(db, `bun-env-${stamp}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: `Env WS ${stamp}`, slug: `bun-env-${stamp}`, issuePrefix: "ENV" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({
      workspaceId: ws!.id,
      name: "Local Runtime",
      runtimeMode: "local", // CHECK: must be 'local' | 'cloud'
      provider: "codex",
      ownerId: u.id,
    })
    .returning();
  const [a] = await db
    .insert(agent)
    .values({
      workspaceId: ws!.id,
      name: `env-agent-${stamp}`,
      runtimeId: rt!.id,
      runtimeMode: "local",
      ownerId: u.id,
    })
    .returning();
  return { u, ws: ws!, rt: rt!, a: a! };
}

/** Mount only agentEnvRoutes, with a middleware that sets the authed user. */
function mountApp(db: ReturnType<typeof createDb>["db"], userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { sub: userId } as AppEnv["Variables"]["user"]);
    await next();
  });
  // agentEnvRoutes declares absolute paths, so mount it at the root.
  app.route("/", agentEnvRoutes(db));
  return app;
}

/** Tear down children before parents. */
async function cleanup(db: ReturnType<typeof createDb>["db"], wsId: string, userId: string) {
  await db.delete(activityLog).where(eq(activityLog.workspaceId, wsId));
  await db.delete(agent).where(eq(agent.workspaceId, wsId));
  await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, wsId));
  await db.delete(member).where(eq(member.workspaceId, wsId));
  await db.delete(workspace).where(eq(workspace.id, wsId));
  await db.delete(user).where(eq(user.id, userId));
}

test.skipIf(!reachable)(
  "PUT then GET /api/agents/:id/env round-trips custom_env and persists to agent.customEnv",
  async () => {
    const { db, close } = createDb(DB_URL);
    const { u, ws, a } = await setup(db);
    const app = mountApp(db, u.id);
    const headers = { "X-Workspace-ID": ws.id, "Content-Type": "application/json" };
    try {
      // PUT a custom_env map.
      const putRes = await app.request(`/api/agents/${a.id}/env`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ custom_env: { API_KEY: "sk-123", REGION: "us-east-1" } }),
      });
      expect(putRes.status).toBe(200);
      const putBody = (await putRes.json()) as { custom_env: Record<string, string> };
      expect(putBody.custom_env).toEqual({ API_KEY: "sk-123", REGION: "us-east-1" });

      // The row actually updated.
      const [row] = await db.select().from(agent).where(eq(agent.id, a.id));
      expect(row?.customEnv).toEqual({ API_KEY: "sk-123", REGION: "us-east-1" });

      // GET it back — round-trips.
      const getRes = await app.request(`/api/agents/${a.id}/env`, { headers });
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as { custom_env: Record<string, string> };
      expect(getBody.custom_env).toEqual({ API_KEY: "sk-123", REGION: "us-east-1" });

      // GET wrote a keys-only reveal audit row (values never recorded).
      const audits = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.workspaceId, ws.id));
      const reveal = audits.find((x) => x.action === "agent_env_revealed");
      expect(reveal).toBeDefined();
      const details = reveal!.details as { revealed_keys: string[]; key_count: number };
      expect(details.revealed_keys).toEqual(["API_KEY", "REGION"]);
      expect(details.key_count).toBe(2);
    } finally {
      await cleanup(db, ws.id, u.id);
      await close();
    }
  },
);

test.skipIf(!reachable)("GET /api/agents/:id/env defaults to {} and gates on workspace + agent existence", async () => {
  const { db, close } = createDb(DB_URL);
  const { u, ws, a } = await setup(db);
  const app = mountApp(db, u.id);
  const headers = { "X-Workspace-ID": ws.id, "Content-Type": "application/json" };
  try {
    // Fresh agent: custom_env defaults to {}.
    const getRes = await app.request(`/api/agents/${a.id}/env`, { headers });
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { custom_env: Record<string, string> };
    expect(body.custom_env).toEqual({});

    // Missing workspace header → 400.
    const noWs = await app.request(`/api/agents/${a.id}/env`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(noWs.status).toBe(400);

    // Foreign workspace → 404 (multi-tenancy gate).
    const foreign = await app.request(`/api/agents/${a.id}/env`, {
      headers: { "X-Workspace-ID": "99999999-9999-4999-8999-999999999999" },
    });
    expect(foreign.status).toBe(404);

    // Agent not in this workspace → 404.
    const gone = await app.request(`/api/agents/99999999-9999-4999-8999-999999999999/env`, { headers });
    expect(gone.status).toBe(404);
  } finally {
    await cleanup(db, ws.id, u.id);
    await close();
  }
});

/**
 * Runtime model-list round-trip (in-memory store): a client initiates a request,
 * the daemon claims it + reports the discovered models, and the client polls the
 * completed result. Mirrors the Go Redis round-trip without Redis.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { runtimeRoutes } from "../src/http/routes/runtimes.js";
import { modelListStore } from "../src/runtime/modelStore.js";
import { user, member, workspace, agentRuntime } from "../src/db/schema.js";
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

test.skipIf(!reachable)("initiate → daemon claims + reports → client polls completed models", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-rm-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "RM WS", slug: `bun-rm-${stamp}`, issuePrefix: "RM", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();

  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => { c.set("user", { sub: u.id } as never); await n(); });
  app.route("/api/runtimes", runtimeRoutes(db));
  const hdr = { "Content-Type": "application/json", "X-Workspace-ID": ws!.id };

  try {
    // Initiate → 202 + a pending request id.
    const init = await app.request(`/api/runtimes/${rt!.id}/models`, { method: "POST", headers: hdr });
    expect(init.status).toBe(202);
    const { request_id, status } = (await init.json()) as { request_id: string; status: string };
    expect(status).toBe("pending");

    // Poll → still pending.
    const poll1 = (await (await app.request(`/api/runtimes/${rt!.id}/models/${request_id}`, { headers: hdr })).json()) as { status: string };
    expect(poll1.status).toBe("pending");

    // Simulate the daemon: claim the pending request, then report results.
    const claimed = modelListStore.claimPending(rt!.id);
    expect(claimed!.id).toBe(request_id);
    const report = await app.request(`/api/runtimes/${rt!.id}/models/${request_id}/result`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ models: [{ id: "gpt-5" }, { id: "o4" }] }),
    });
    expect(report.status).toBe(200);
    expect(((await report.json()) as { status: string }).status).toBe("completed");

    // Poll → completed with the models.
    const poll2 = (await (await app.request(`/api/runtimes/${rt!.id}/models/${request_id}`, { headers: hdr })).json()) as { status: string; models: { id: string }[] };
    expect(poll2.status).toBe("completed");
    expect(poll2.models.map((m) => m.id)).toEqual(["gpt-5", "o4"]);

    // An unknown request id → 404.
    expect((await app.request(`/api/runtimes/${rt!.id}/models/11111111-1111-1111-1111-111111111111`, { headers: hdr })).status).toBe(404);
  } finally {
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

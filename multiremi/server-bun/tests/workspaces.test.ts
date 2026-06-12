import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace } from "../src/db/schema.js";
import type { Config } from "../src/config.js";

const SECRET = "test-secret-0123456789";
const DB_URL =
  process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
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

test.skipIf(!reachable)("POST then GET /api/workspaces (multi-tenancy, live DB)", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const email = `bun-ws-${Date.now()}@bytedance.com`;
  const slug = `bun-ws-${Date.now()}`;
  const { user: u } = await findOrCreateUser(db, email, cfg);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const authHeader = { Authorization: `Bearer ${token}` };

  try {
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test WS", slug }),
    });
    expect(createRes.status).toBe(201);
    const ws = (await createRes.json()) as { id: string; slug: string };
    expect(ws.slug).toBe(slug);

    const listRes = await app.request("/api/workspaces", { headers: authHeader });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ slug: string }>;
    expect(list.some((w) => w.slug === slug)).toBe(true);

    // reserved slug rejected
    const reserved = await app.request("/api/workspaces", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X", slug: "settings" }),
    });
    expect(reserved.status).toBe(400);

    // cleanup
    await db.delete(member).where(eq(member.workspaceId, ws.id));
    await db.delete(workspace).where(eq(workspace.id, ws.id));
  } finally {
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

test.skipIf(!reachable)("GET /api/workspaces without auth → 401", async () => {
  const { db, close } = createDb(DB_URL);
  try {
    const res = await createApp(cfg, db).request("/api/workspaces");
    expect(res.status).toBe(401);
  } finally {
    await close();
  }
});

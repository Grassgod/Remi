import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueMetadataRoutes } from "../src/http/routes/issueMetadata.js";
import { user, member, workspace, issue } from "../src/db/schema.js";
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

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

test.skipIf(!reachable)("issue metadata: PUT merges + persists, GET reads back, non-object -> 400", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-ismeta-${stamp}@bytedance.com`, cfg);

  const [ws] = await db
    .insert(workspace)
    .values({ name: "Metadata WS", slug: `bun-ismeta-${stamp}`, issuePrefix: "MTA" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [iss] = await db
    .insert(issue)
    .values({
      workspaceId: ws!.id,
      title: "Metadata issue",
      status: "backlog",
      priority: "none",
      creatorType: "member",
      creatorId: u.id,
      number: 7,
    })
    .returning();

  // Bare app: mount only the route factory and inject the authed user, so the
  // unit test exercises the handler without the real JWT gate.
  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => {
    c.set("user", { sub: u.id, email: u.email, name: u.name });
    await n();
  });
  app.route("/", issueMetadataRoutes(db));

  const headers = { "X-Workspace-ID": ws!.id, "Content-Type": "application/json" };

  try {
    // PUT { foo: "bar" } -> persisted, echoed back
    const put = await app.request(`/api/issues/${iss!.id}/metadata`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ metadata: { foo: "bar" } }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { metadata: Record<string, unknown> };
    expect(putBody.metadata.foo).toBe("bar");

    // Persisted in the DB
    const [row] = await db.select({ m: issue.metadata }).from(issue).where(eq(issue.id, iss!.id));
    expect((row!.m as Record<string, unknown>).foo).toBe("bar");

    // GET reads it back, resolvable by MUL-N identifier too
    const get = await app.request(`/api/issues/MTA-7/metadata`, { headers });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { metadata: Record<string, unknown> };
    expect(getBody.metadata.foo).toBe("bar");

    // Merge: a second PUT keeps the existing key
    const put2 = await app.request(`/api/issues/${iss!.id}/metadata`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ metadata: { baz: 1 } }),
    });
    expect(put2.status).toBe(200);
    const put2Body = (await put2.json()) as { metadata: Record<string, unknown> };
    expect(put2Body.metadata.foo).toBe("bar");
    expect(put2Body.metadata.baz).toBe(1);

    // Non-object metadata -> 400
    const bad = await app.request(`/api/issues/${iss!.id}/metadata`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ metadata: "not-an-object" }),
    });
    expect(bad.status).toBe(400);

    // Array is also not a plain object -> 400
    const badArr = await app.request(`/api/issues/${iss!.id}/metadata`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ metadata: [1, 2, 3] }),
    });
    expect(badArr.status).toBe(400);
  } finally {
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, issue } from "../src/db/schema.js";
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

test.skipIf(!reachable)("issues read path: list + get by MUL-N + get by UUID, workspace-scoped", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-iss-${stamp}@bytedance.com`, cfg);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

  const [ws] = await db
    .insert(workspace)
    .values({ name: "Issue WS", slug: `bun-iss-${stamp}`, issuePrefix: "TST" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [iss] = await db
    .insert(issue)
    .values({
      workspaceId: ws!.id,
      title: "First issue",
      status: "backlog",
      priority: "high",
      creatorType: "member",
      creatorId: u.id,
      number: 42,
    })
    .returning();

  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

  try {
    // list
    const listRes = await app.request("/api/issues", { headers: auth });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { issues: Array<{ id: string; identifier: string; title: string }>; total: number };
    const list = listed.issues;
    expect(listed.total).toBeGreaterThanOrEqual(1);
    expect(list.some((i) => i.id === iss!.id)).toBe(true);
    const mine = list.find((i) => i.id === iss!.id)!;
    expect(mine.identifier).toBe("TST-42");
    expect(mine.title).toBe("First issue");

    // get by human identifier (MUL-N style)
    const byNum = await app.request("/api/issues/TST-42", { headers: auth });
    expect(byNum.status).toBe(200);
    expect(((await byNum.json()) as { id: string }).id).toBe(iss!.id);

    // get by UUID
    const byId = await app.request(`/api/issues/${iss!.id}`, { headers: auth });
    expect(byId.status).toBe(200);
    expect(((await byId.json()) as { identifier: string }).identifier).toBe("TST-42");

    // missing workspace header → 400
    const noWs = await app.request("/api/issues", { headers: { Authorization: `Bearer ${token}` } });
    expect(noWs.status).toBe(400);

    // a member of no/other workspace → 404 (multi-tenancy gate)
    const otherWsId = "99999999-9999-4999-8999-999999999999";
    const foreign = await app.request("/api/issues", {
      headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
    });
    expect(foreign.status).toBe(404);
  } finally {
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

test.skipIf(!reachable)("POST /api/issues auto-assigns per-workspace numbers + sets creator", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-isc-${stamp}@bytedance.com`, cfg);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "Create WS", slug: `bun-isc-${stamp}`, issuePrefix: "ABC", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const auth = {
    Authorization: `Bearer ${token}`,
    "X-Workspace-ID": ws!.id,
    "Content-Type": "application/json",
  };
  try {
    const r1 = await app.request("/api/issues", { method: "POST", headers: auth, body: JSON.stringify({ title: "Hello", priority: "high" }) });
    expect(r1.status).toBe(201);
    const i1 = (await r1.json()) as { number: number; identifier: string; title: string; creator_id: string; status: string };
    expect(i1.number).toBe(1);
    expect(i1.identifier).toBe("ABC-1");
    expect(i1.title).toBe("Hello");
    expect(i1.creator_id).toBe(u.id);
    expect(i1.status).toBe("backlog");

    const r2 = await app.request("/api/issues", { method: "POST", headers: auth, body: JSON.stringify({ title: "World" }) });
    const i2 = (await r2.json()) as { number: number; identifier: string };
    expect(i2.number).toBe(2);
    expect(i2.identifier).toBe("ABC-2");

    const bad = await app.request("/api/issues", { method: "POST", headers: auth, body: JSON.stringify({ title: "  " }) });
    expect(bad.status).toBe(400);
  } finally {
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

test.skipIf(!reachable)("PUT updates an issue (partial) and DELETE removes it, workspace-scoped", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-isu-${stamp}@bytedance.com`, cfg);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "Upd WS", slug: `bun-isu-${stamp}`, issuePrefix: "UPD", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id, "Content-Type": "application/json" };
  try {
    const created = (await (await app.request("/api/issues", { method: "POST", headers: auth, body: JSON.stringify({ title: "orig", status: "backlog" }) })).json()) as { id: string; identifier: string };

    // partial update by human identifier
    const upd = await app.request(`/api/issues/${created.identifier}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ title: "updated", status: "done" }),
    });
    expect(upd.status).toBe(200);
    const after = (await upd.json()) as { title: string; status: string; priority: string };
    expect(after.title).toBe("updated");
    expect(after.status).toBe("done");
    expect(after.priority).toBe("none"); // untouched field preserved

    // delete by UUID
    const del = await app.request(`/api/issues/${created.id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(204);
    const gone = await app.request(`/api/issues/${created.id}`, { headers: auth });
    expect(gone.status).toBe(404);
  } finally {
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

import { bus } from "../src/realtime/bus.js";

test.skipIf(!reachable)("creating an issue over HTTP emits an issue.created event on the realtime bus", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-rt-${stamp}@bytedance.com`, cfg);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const [ws] = await db.insert(workspace).values({ name: "RT WS", slug: `bun-rt-${stamp}`, issuePrefix: "RTB", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id, "Content-Type": "application/json" };
  const events: string[] = [];
  const unsub = bus.subscribe(ws!.id, (e) => events.push(e.type));
  try {
    await app.request("/api/issues", { method: "POST", headers: auth, body: JSON.stringify({ title: "rt" }) });
    expect(events).toContain("issue.created");
  } finally {
    unsub();
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
